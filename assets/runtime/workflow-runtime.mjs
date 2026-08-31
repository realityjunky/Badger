// src/workflow-runtime/index.ts
import path12 from "node:path";

// src/engine/contained-atomic-write.ts
import { randomUUID } from "crypto";
import { constants as fsConstants, promises as fs } from "fs";
import path from "path";

// src/engine/file-identity.ts
function hasPlatformIdentity(value) {
  return value !== 0 && value !== 0n && value !== "0";
}
function hasComparableFileObject(left, right) {
  return hasPlatformIdentity(left.dev) && hasPlatformIdentity(right.dev) && hasPlatformIdentity(left.ino) && hasPlatformIdentity(right.ino);
}
function sameFileObject(left, right) {
  const comparableDevice = hasPlatformIdentity(left.dev) && hasPlatformIdentity(right.dev);
  if (comparableDevice && left.dev !== right.dev) return false;
  const comparableInode = hasPlatformIdentity(left.ino) && hasPlatformIdentity(right.ino);
  if (comparableInode && left.ino !== right.ino) return false;
  if (comparableDevice && comparableInode) return true;
  return left.birthtime === right.birthtime;
}

// src/engine/contained-atomic-write.ts
async function publishFileExclusively(source, destination) {
  try {
    await fs.link(source, destination);
    return { linked: true };
  } catch (error) {
    const code = error.code;
    if (code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
  }
  await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  return { linked: false };
}
function isInside(parent, target) {
  const relative = path.relative(parent, target);
  return relative === "" || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}
function statsIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    birthtime: stat.birthtimeMs
  };
}
function sameDirectoryIdentity(identity, stat) {
  return sameFileObject(identity, statsIdentity(stat));
}
function sameFileIdentity(left, right) {
  return sameFileObject(statsIdentity(left), statsIdentity(right));
}
function sameUnchangedFile(left, right) {
  return sameFileIdentity(left, right) && left.birthtimeMs === right.birthtimeMs && left.ctimeMs === right.ctimeMs && left.mtimeMs === right.mtimeMs && left.size === right.size;
}
async function captureDirectoryIdentity(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      `Contained atomic write parent must be a real directory: ${directory}`
    );
  }
  return {
    path: directory,
    realPath: await fs.realpath(directory),
    ...statsIdentity(stat)
  };
}
async function verifyDirectoryChain(chain) {
  for (const identity of chain) {
    const stat = await fs.lstat(identity.path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameDirectoryIdentity(identity, stat) || await fs.realpath(identity.path) !== identity.realPath) {
      throw new Error(
        `Contained atomic write parent changed before commit: ${identity.path}`
      );
    }
  }
}
async function prepareContainedDirectoryChain(root, directory) {
  const lexicalRoot = path.resolve(root);
  const lexicalDirectory = path.resolve(directory);
  if (!isInside(lexicalRoot, lexicalDirectory)) {
    throw new Error(
      `Contained atomic write parent is outside its managed root: ${directory}`
    );
  }
  const chain = [
    await captureDirectoryIdentity(lexicalRoot)
  ];
  const segments = path.relative(lexicalRoot, lexicalDirectory).split(path.sep).filter(Boolean);
  let cursor = lexicalRoot;
  for (const segment of segments) {
    await verifyDirectoryChain(chain);
    cursor = path.join(cursor, segment);
    try {
      await fs.mkdir(cursor);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const identity = await captureDirectoryIdentity(cursor);
    if (!isInside(chain[0].realPath, identity.realPath)) {
      throw new Error(
        `Contained atomic write parent resolves outside its managed root: ${cursor}`
      );
    }
    chain.push(identity);
  }
  await verifyDirectoryChain(chain);
  return chain;
}
async function captureExistingContainedDirectoryChain(root, directory) {
  const lexicalRoot = path.resolve(root);
  const lexicalDirectory = path.resolve(directory);
  if (!isInside(lexicalRoot, lexicalDirectory)) {
    throw new Error(
      `Contained file parent is outside its managed root: ${directory}`
    );
  }
  const chain = [
    await captureDirectoryIdentity(lexicalRoot)
  ];
  const segments = path.relative(lexicalRoot, lexicalDirectory).split(path.sep).filter(Boolean);
  let cursor = lexicalRoot;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    try {
      const identity = await captureDirectoryIdentity(cursor);
      if (!isInside(chain[0].realPath, identity.realPath)) {
        throw new Error(
          `Contained file parent resolves outside its managed root: ${cursor}`
        );
      }
      chain.push(identity);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  await verifyDirectoryChain(chain);
  return chain;
}
async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = error.code;
    if (!["EACCES", "EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(
      code ?? ""
    )) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}
async function atomicWriteContained(file, content, options) {
  const directory = path.dirname(file);
  const directoryChain = await prepareContainedDirectoryChain(
    options.containedRoot,
    directory
  );
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${randomUUID()}.tmp`
  );
  let handle;
  let temporaryIdentity;
  let writtenIdentity;
  try {
    await options.beforeTemporaryOpen?.();
    handle = await fs.open(temporary, "wx");
    temporaryIdentity = await handle.stat();
    const [temporaryPathStat, temporaryRealPath] = await Promise.all([
      fs.lstat(temporary),
      fs.realpath(temporary)
    ]);
    await verifyDirectoryChain(directoryChain);
    if (!temporaryPathStat.isFile() || temporaryPathStat.isSymbolicLink() || !sameFileIdentity(temporaryIdentity, temporaryPathStat) || !isInside(directoryChain[0].realPath, temporaryRealPath)) {
      throw new Error(
        "Contained atomic write temporary file opened outside its managed parent"
      );
    }
    if (typeof content === "string") await handle.writeFile(content, "utf8");
    else await handle.writeFile(content);
    await handle.sync();
    writtenIdentity = await handle.stat();
    if (!sameFileIdentity(temporaryIdentity, writtenIdentity)) {
      throw new Error(
        "Contained atomic write temporary file changed while writing"
      );
    }
    await handle.close();
    handle = void 0;
    await options.beforeCommit?.();
    await verifyDirectoryChain(directoryChain);
    const temporaryStat = await fs.lstat(temporary);
    if (!temporaryStat.isFile() || temporaryStat.isSymbolicLink() || !writtenIdentity || !sameUnchangedFile(temporaryStat, writtenIdentity)) {
      throw new Error(
        "Contained atomic write temporary file changed before commit"
      );
    }
    if (options.exclusive) {
      await publishFileExclusively(temporary, file);
      await fs.unlink(temporary);
    } else {
      await fs.rename(temporary, file);
    }
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close();
    try {
      await verifyDirectoryChain(directoryChain);
      await fs.rm(temporary, { force: true });
    } catch {
    }
    throw error;
  }
}
async function atomicWriteContainedText(file, content, options) {
  await atomicWriteContained(file, content, options);
}
async function removeContainedFile(file, options) {
  const directory = path.dirname(file);
  const directoryChain = await captureExistingContainedDirectoryChain(
    options.containedRoot,
    directory
  );
  if (!directoryChain) return false;
  let identity;
  let realPath;
  try {
    identity = await fs.lstat(file);
    realPath = await fs.realpath(file);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (!identity.isFile() || identity.isSymbolicLink() || !isInside(directoryChain[0].realPath, realPath)) {
    throw new Error(
      "Contained file removal target must be a regular file inside its managed root"
    );
  }
  await options.beforeRemove?.();
  await verifyDirectoryChain(directoryChain);
  const [current, currentRealPath] = await Promise.all([
    fs.lstat(file),
    fs.realpath(file)
  ]);
  if (!current.isFile() || current.isSymbolicLink() || !sameUnchangedFile(identity, current) || currentRealPath !== realPath) {
    throw new Error("Contained file removal target changed before removal");
  }
  await fs.unlink(file);
  await verifyDirectoryChain(directoryChain);
  await syncDirectory(directory);
  return true;
}

// src/engine/protected-project-path.ts
import { promises as fs3 } from "fs";
import path3 from "path";

// src/engine/race-safe-read.ts
import { constants as fsConstants2, promises as fs2 } from "fs";
var RaceSafeReadError = class extends Error {
  reason;
  constructor(reason, message, options) {
    super(message, options);
    this.name = "RaceSafeReadError";
    this.reason = reason;
  }
};
function birthtimeOf(stat) {
  return "birthtimeNs" in stat && typeof stat.birthtimeNs === "bigint" ? stat.birthtimeNs : stat.birthtimeMs;
}
function ctimeOf(stat) {
  return "ctimeNs" in stat && typeof stat.ctimeNs === "bigint" ? stat.ctimeNs : stat.ctimeMs;
}
function identityOf(stat) {
  return { dev: stat.dev, ino: stat.ino, birthtime: birthtimeOf(stat) };
}
function sameStatIdentity(left, right) {
  const leftObject = identityOf(left);
  const rightObject = identityOf(right);
  if (hasComparableFileObject(leftObject, rightObject)) {
    return sameFileObject(leftObject, rightObject);
  }
  return sameFileObject(leftObject, rightObject) && birthtimeOf(left) === birthtimeOf(right) && ctimeOf(left) === ctimeOf(right) && left.size === right.size;
}
async function readFileRaceSafe(file, maxBytes, options = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("race-safe read byte limit must be a positive integer");
  }
  const label = options.label ?? "file";
  const bigint = options.bigint === true;
  const before = await fs2.lstat(file, { bigint });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new RaceSafeReadError(
      "not-regular-file",
      `${label} must be a regular file`
    );
  }
  if (BigInt(before.size) > BigInt(maxBytes)) {
    throw new RaceSafeReadError(
      "too-large",
      `${label} exceeds ${maxBytes} bytes`
    );
  }
  const beforeRealPath = await fs2.realpath(file);
  await options.verify?.("pre-open", {
    realPath: beforeRealPath,
    identity: identityOf(before)
  });
  const flags = process.platform === "win32" ? fsConstants2.O_RDONLY : fsConstants2.O_RDONLY | fsConstants2.O_NOFOLLOW | fsConstants2.O_NONBLOCK;
  let handle;
  try {
    handle = await fs2.open(file, flags);
  } catch (error) {
    if (error.code === "ELOOP") {
      throw new RaceSafeReadError(
        "not-regular-file",
        `${label} must be a regular file`,
        {
          cause: error
        }
      );
    }
    throw error;
  }
  try {
    const [opened, pathAfterOpen, realPathAfterOpen] = await Promise.all([
      handle.stat({ bigint }),
      fs2.lstat(file, { bigint }),
      fs2.realpath(file)
    ]);
    if (!opened.isFile() || !pathAfterOpen.isFile() || pathAfterOpen.isSymbolicLink() || realPathAfterOpen !== beforeRealPath || !sameStatIdentity(before, opened) || !sameStatIdentity(before, pathAfterOpen)) {
      throw new RaceSafeReadError("changed", `${label} changed while opening`);
    }
    await options.verify?.("post-open", {
      realPath: realPathAfterOpen,
      identity: identityOf(opened)
    });
    await options.hooks?.afterOpen?.();
    const chunks = [];
    let total = 0;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
    for (; ; ) {
      const remaining = maxBytes + 1 - total;
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, remaining),
        null
      );
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw new RaceSafeReadError(
          "too-large",
          `${label} exceeds ${maxBytes} bytes`
        );
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    await options.hooks?.beforeFinalCheck?.();
    const [afterHandle, afterPath, afterRealPath] = await Promise.all([
      handle.stat({ bigint }),
      fs2.lstat(file, { bigint }),
      fs2.realpath(file)
    ]);
    if (!afterPath.isFile() || afterPath.isSymbolicLink() || afterRealPath !== beforeRealPath || !sameStatIdentity(before, afterHandle) || !sameStatIdentity(before, afterPath)) {
      throw new RaceSafeReadError("changed", `${label} changed while reading`);
    }
    await options.verify?.("post-read", {
      realPath: afterRealPath,
      identity: identityOf(afterHandle)
    });
    return {
      bytes: Buffer.concat(chunks, total),
      stat: afterHandle,
      realPath: afterRealPath
    };
  } finally {
    await handle.close();
  }
}

// src/engine/project-config.ts
import path2 from "node:path";
function normalizeWorkflowRelativePath(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const trimmed = value.trim().replaceAll("\\", "/");
  if (trimmed.length === 0 || path2.posix.isAbsolute(trimmed) || path2.win32.isAbsolute(trimmed) || /^(?:~|[\\/])/u.test(trimmed)) {
    throw new Error(`${label} must be relative to its declared path base`);
  }
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`${label} must stay inside its declared path base`);
  }
  if (segments.some((segment) => segment === "" || segment === ".")) {
    throw new Error(`${label} must not contain empty or dot path segments`);
  }
  if (/[*?]/u.test(trimmed)) {
    throw new Error(`${label} cannot contain wildcards`);
  }
  return segments.join("/");
}

// src/engine/protected-project-path.ts
function isMissingPath(error) {
  const code = error?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
function isInside2(root, target) {
  const relative = path3.relative(root, target);
  return relative === "" || !path3.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path3.sep}`);
}
async function assertRealProjectRoot(projectRoot, label) {
  const lexicalRoot = path3.resolve(projectRoot);
  const stat = await fs3.lstat(lexicalRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} project root must be a real directory`);
  }
  return fs3.realpath(lexicalRoot);
}
async function inspectExistingChain(lexicalRoot, realRoot, segments, options) {
  let cursor = lexicalRoot;
  for (let index = 0; index < segments.length; index++) {
    cursor = path3.join(cursor, segments[index]);
    let stat;
    try {
      stat = await fs3.lstat(cursor);
    } catch (error) {
      if (isMissingPath(error)) return { exists: false, kind: "missing" };
      throw error;
    }
    const display = path3.relative(lexicalRoot, cursor).replaceAll("\\", "/");
    if (stat.isSymbolicLink()) {
      throw new Error(
        `${options.label} crosses a symbolic link or junction at ${display}`
      );
    }
    const final = index === segments.length - 1;
    if (!final && !stat.isDirectory()) {
      throw new Error(
        `${options.label} ancestor ${display} must be a real directory`
      );
    }
    if (final && (options.expected === "file" && !stat.isFile() || options.expected === "directory" && !stat.isDirectory() || options.expected === "any" && !stat.isFile() && !stat.isDirectory())) {
      throw new Error(`${options.label} must be a real ${options.expected}`);
    }
    const realCursor = await fs3.realpath(cursor);
    if (!isInside2(realRoot, realCursor)) {
      throw new Error(`${options.label} resolves outside the project root`);
    }
    if (final) {
      return {
        exists: true,
        kind: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "missing"
      };
    }
  }
  return { exists: true, kind: "directory" };
}
async function inspectProtectedProjectPath(projectRoot, relativePath, options) {
  const relative = normalizeWorkflowRelativePath(relativePath, options.label);
  const lexicalRoot = path3.resolve(projectRoot);
  const realRoot = await assertRealProjectRoot(lexicalRoot, options.label);
  const segments = relative.split("/");
  const target = path3.resolve(lexicalRoot, ...segments);
  if (!isInside2(lexicalRoot, target)) {
    throw new Error(`${options.label} must stay inside the project root`);
  }
  const result = await inspectExistingChain(
    lexicalRoot,
    realRoot,
    segments,
    options
  );
  return {
    projectRoot: lexicalRoot,
    target,
    relative,
    exists: result.exists,
    kind: result.kind
  };
}
async function ensureProtectedProjectDirectory(projectRoot, relativePath, options) {
  const relative = normalizeWorkflowRelativePath(relativePath, options.label);
  const lexicalRoot = path3.resolve(projectRoot);
  const realRoot = await assertRealProjectRoot(lexicalRoot, options.label);
  const segments = relative.split("/");
  let cursor = lexicalRoot;
  for (const segment of segments) {
    cursor = path3.join(cursor, segment);
    let stat;
    try {
      stat = await fs3.lstat(cursor);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      try {
        await fs3.mkdir(cursor);
      } catch (mkdirError) {
        if (mkdirError.code !== "EEXIST")
          throw mkdirError;
      }
      stat = await fs3.lstat(cursor);
    }
    const display = path3.relative(lexicalRoot, cursor).replaceAll("\\", "/");
    if (stat.isSymbolicLink()) {
      throw new Error(
        `${options.label} crosses a symbolic link or junction at ${display}`
      );
    }
    if (!stat.isDirectory()) {
      throw new Error(
        `${options.label} directory ${display} must be a real directory`
      );
    }
    const realCursor = await fs3.realpath(cursor);
    if (!isInside2(realRoot, realCursor)) {
      throw new Error(`${options.label} resolves outside the project root`);
    }
  }
  await inspectExistingChain(lexicalRoot, realRoot, segments, {
    label: options.label,
    expected: "directory"
  });
  return cursor;
}
async function readProtectedProjectFile(projectRoot, relativePath, maxBytes, options) {
  const inspection = await inspectProtectedProjectPath(
    projectRoot,
    relativePath,
    {
      label: options.label,
      expected: "file"
    }
  );
  if (!inspection.exists) {
    const error = new Error(
      `${options.label} does not exist`
    );
    error.code = "ENOENT";
    throw error;
  }
  const realRoot = await assertRealProjectRoot(
    inspection.projectRoot,
    options.label
  );
  return readFileRaceSafe(inspection.target, maxBytes, {
    ...options,
    verify: async (_checkpoint, context) => {
      if (!isInside2(realRoot, context.realPath)) {
        throw new Error(`${options.label} resolves outside the project root`);
      }
      await inspectExistingChain(
        inspection.projectRoot,
        realRoot,
        inspection.relative.split("/"),
        {
          label: options.label,
          expected: "file"
        }
      );
    }
  });
}

// src/skill-runtime/snapshot.ts
import { createHash as createHash2, randomUUID as randomUUID2 } from "crypto";
import { promises as fs4 } from "fs";
import path6 from "path";

// src/skill-runtime/load.ts
import path4 from "path";
var ACTION_TYPES = [
  "invoke_skill",
  "call_tool",
  "handoff",
  "ask_user",
  "checkpoint"
];
var ORCHESTRATION_MODES = ["deterministic", "adaptive"];
var TOOL_KINDS = ["function", "mcp", "script", "agent"];
var TOOL_SIDE_EFFECTS = ["none", "read", "write", "external"];
var EVAL_SCOPES = ["progress", "step", "completion"];
var EVAL_TYPES = ["artifact_exists", "state_equals"];
function invalidDocument(filePath, fieldPath, message) {
  return new Error(`${filePath}: ${fieldPath} ${message}`);
}
function assertObject(value, filePath, fieldPath = "document") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidDocument(filePath, fieldPath, "must be an object");
  }
}
function assertArray(value, filePath, fieldPath) {
  if (!Array.isArray(value)) {
    throw invalidDocument(filePath, fieldPath, "must be an array");
  }
}
function assertString(value, filePath, fieldPath) {
  if (typeof value !== "string") {
    throw invalidDocument(filePath, fieldPath, "must be a string");
  }
}
function assertOptionalString(document, field, filePath, objectPath) {
  if (field in document) {
    assertString(document[field], filePath, `${objectPath}.${field}`);
  }
}
function assertOptionalBoolean(document, field, filePath, objectPath) {
  if (field in document && typeof document[field] !== "boolean") {
    throw invalidDocument(
      filePath,
      `${objectPath}.${field}`,
      "must be a boolean"
    );
  }
}
function assertEnum(value, values, filePath, fieldPath) {
  if (typeof value !== "string" || !values.includes(value)) {
    throw invalidDocument(
      filePath,
      fieldPath,
      `must be one of ${values.join(", ")}`
    );
  }
}
function assertStringArray(value, filePath, fieldPath) {
  assertArray(value, filePath, fieldPath);
  value.forEach((entry, index) => {
    assertString(entry, filePath, `${fieldPath}[${index}]`);
  });
}
function validateNamedContract(value, filePath, fieldPath) {
  assertObject(value, filePath, fieldPath);
  assertString(value.name, filePath, `${fieldPath}.name`);
  assertString(value.description, filePath, `${fieldPath}.description`);
  assertOptionalBoolean(value, "required", filePath, fieldPath);
}
function validateSkillReference(value, filePath, fieldPath) {
  assertObject(value, filePath, fieldPath);
  assertString(value.id, filePath, `${fieldPath}.id`);
  assertOptionalString(value, "source", filePath, fieldPath);
  assertOptionalString(value, "version", filePath, fieldPath);
}
function validateAgent(value, filePath, fieldPath) {
  assertObject(value, filePath, fieldPath);
  assertString(value.id, filePath, `${fieldPath}.id`);
  assertString(value.role, filePath, `${fieldPath}.role`);
  assertOptionalString(value, "instructions", filePath, fieldPath);
}
function validateTool(value, filePath, fieldPath) {
  assertObject(value, filePath, fieldPath);
  assertString(value.id, filePath, `${fieldPath}.id`);
  assertEnum(value.kind, TOOL_KINDS, filePath, `${fieldPath}.kind`);
  assertString(value.source, filePath, `${fieldPath}.source`);
  assertEnum(
    value.sideEffect,
    TOOL_SIDE_EFFECTS,
    filePath,
    `${fieldPath}.sideEffect`
  );
  assertOptionalBoolean(value, "requiresConfirmation", filePath, fieldPath);
}
function validateDecisionInputSchema(value, filePath, fieldPath) {
  assertObject(value, filePath, fieldPath);
  assertEnum(value.type, ["object"], filePath, `${fieldPath}.type`);
  assertArray(value.fields, filePath, `${fieldPath}.fields`);
  value.fields.forEach((entry, index) => {
    const entryPath = `${fieldPath}.fields[${index}]`;
    assertObject(entry, filePath, entryPath);
    assertString(entry.id, filePath, `${entryPath}.id`);
    assertEnum(
      entry.type,
      ["string", "number", "boolean"],
      filePath,
      `${entryPath}.type`
    );
    assertOptionalBoolean(entry, "required", filePath, entryPath);
    if ("values" in entry && "enum" in entry) {
      throw invalidDocument(
        filePath,
        entryPath,
        "must not contain both values and enum"
      );
    }
    for (const key of ["values", "enum"]) {
      if (!(key in entry)) continue;
      assertArray(entry[key], filePath, `${entryPath}.${key}`);
      entry[key].forEach((item, itemIndex) => {
        if (entry.type === "string" && typeof item !== "string" || entry.type === "number" && (typeof item !== "number" || !Number.isFinite(item)) || entry.type === "boolean" && typeof item !== "boolean") {
          throw invalidDocument(
            filePath,
            `${entryPath}.${key}[${itemIndex}]`,
            "has the wrong scalar type"
          );
        }
      });
    }
  });
}
function validateDecisionAction(value, filePath, fieldPath) {
  assertString(value.decisionId, filePath, `${fieldPath}.decisionId`);
  assertArray(value.choices, filePath, `${fieldPath}.choices`);
  value.choices.forEach((entry, index) => {
    const choicePath = `${fieldPath}.choices[${index}]`;
    assertObject(entry, filePath, choicePath);
    assertString(entry.id, filePath, `${choicePath}.id`);
    assertString(entry.label, filePath, `${choicePath}.label`);
    if ("requiredInputs" in entry) {
      validateDecisionInputSchema(
        entry.requiredInputs,
        filePath,
        `${choicePath}.requiredInputs`
      );
    }
  });
  if ("requiredInputs" in value) {
    validateDecisionInputSchema(
      value.requiredInputs,
      filePath,
      `${fieldPath}.requiredInputs`
    );
  }
  if ("rationale" in value) {
    assertObject(value.rationale, filePath, `${fieldPath}.rationale`);
    assertOptionalBoolean(
      value.rationale,
      "required",
      filePath,
      `${fieldPath}.rationale`
    );
  }
  if ("reviewer" in value) {
    assertObject(value.reviewer, filePath, `${fieldPath}.reviewer`);
    for (const key of ["subjects", "authorities"]) {
      if (key in value.reviewer) {
        assertStringArray(
          value.reviewer[key],
          filePath,
          `${fieldPath}.reviewer.${key}`
        );
      }
    }
  }
}
function validateAction(value, filePath, fieldPath) {
  assertObject(value, filePath, fieldPath);
  assertEnum(value.type, ACTION_TYPES, filePath, `${fieldPath}.type`);
  assertOptionalString(value, "ref", filePath, fieldPath);
  assertOptionalString(value, "prompt", filePath, fieldPath);
  assertOptionalString(value, "question", filePath, fieldPath);
  if ("options" in value) {
    assertStringArray(value.options, filePath, `${fieldPath}.options`);
  }
  if ("decisionId" in value) {
    validateDecisionAction(value, filePath, fieldPath);
  }
}
function validateStep(value, filePath, fieldPath) {
  assertObject(value, filePath, fieldPath);
  assertString(value.id, filePath, `${fieldPath}.id`);
  validateAction(value.action, filePath, `${fieldPath}.action`);
  assertOptionalString(value, "next", filePath, fieldPath);
  if ("completionEvals" in value) {
    assertStringArray(
      value.completionEvals,
      filePath,
      `${fieldPath}.completionEvals`
    );
  }
}
function validateGoal(value, filePath) {
  const fieldPath = "goal";
  assertObject(value, filePath, fieldPath);
  assertString(value.statement, filePath, `${fieldPath}.statement`);
  assertArray(value.inputs, filePath, `${fieldPath}.inputs`);
  value.inputs.forEach((entry, index) => {
    validateNamedContract(entry, filePath, `${fieldPath}.inputs[${index}]`);
  });
  assertArray(value.outputs, filePath, `${fieldPath}.outputs`);
  value.outputs.forEach((entry, index) => {
    validateNamedContract(entry, filePath, `${fieldPath}.outputs[${index}]`);
  });
  assertStringArray(value.success, filePath, `${fieldPath}.success`);
}
function validateOrchestration(value, filePath) {
  const fieldPath = "orchestration";
  assertObject(value, filePath, fieldPath);
  assertEnum(value.mode, ORCHESTRATION_MODES, filePath, `${fieldPath}.mode`);
  assertOptionalString(value, "entry", filePath, fieldPath);
  if ("steps" in value) {
    assertArray(value.steps, filePath, `${fieldPath}.steps`);
    value.steps.forEach((entry, index) => {
      validateStep(entry, filePath, `${fieldPath}.steps[${index}]`);
    });
  }
}
function narrowSkillDefinition(document, filePath) {
  assertObject(document, filePath);
  assertEnum(document.apiVersion, ["comet/v1alpha1"], filePath, "apiVersion");
  assertEnum(document.kind, ["Skill"], filePath, "kind");
  assertObject(document.metadata, filePath, "metadata");
  assertString(document.metadata.name, filePath, "metadata.name");
  assertString(document.metadata.version, filePath, "metadata.version");
  assertString(document.metadata.description, filePath, "metadata.description");
  validateGoal(document.goal, filePath);
  validateOrchestration(document.orchestration, filePath);
  assertArray(document.skills, filePath, "skills");
  document.skills.forEach((entry, index) => {
    validateSkillReference(entry, filePath, `skills[${index}]`);
  });
  assertArray(document.agents, filePath, "agents");
  document.agents.forEach((entry, index) => {
    validateAgent(entry, filePath, `agents[${index}]`);
  });
  assertArray(document.tools, filePath, "tools");
  document.tools.forEach((entry, index) => {
    validateTool(entry, filePath, `tools[${index}]`);
  });
  return document;
}
function narrowGuardrails(document, filePath) {
  assertObject(document, filePath);
  for (const field of [
    "allowedSkills",
    "allowedAgents",
    "allowedTools",
    "confirmationRequiredFor"
  ]) {
    if (field in document) {
      assertStringArray(document[field], filePath, field);
    }
  }
  for (const field of ["maxIterations", "maxRetriesPerAction"]) {
    if (field in document && (typeof document[field] !== "number" || !Number.isFinite(document[field]))) {
      throw invalidDocument(filePath, field, "must be a finite number");
    }
  }
  return document;
}
function narrowRuntimeMetadata(value, filePath) {
  if (value === void 0) return void 0;
  assertObject(value, filePath, "runtime");
  assertString(value.protocolHash, filePath, "runtime.protocolHash");
  if (!/^[a-f0-9]{64}$/u.test(value.protocolHash)) {
    throw invalidDocument(
      filePath,
      "runtime.protocolHash",
      "must be a SHA-256 hash"
    );
  }
  assertObject(value.protocol, filePath, "runtime.protocol");
  if (value.protocol.schemaVersion !== 1) {
    throw invalidDocument(
      filePath,
      "runtime.protocol.schemaVersion",
      "must be 1"
    );
  }
  assertObject(value.nodeToStep, filePath, "runtime.nodeToStep");
  for (const [nodeId, stepId2] of Object.entries(value.nodeToStep)) {
    assertString(stepId2, filePath, `runtime.nodeToStep.${nodeId}`);
  }
  if (value.capabilityVersion !== void 0 && value.capabilityVersion !== 3) {
    throw invalidDocument(
      filePath,
      "runtime.capabilityVersion",
      "must be 3 when present"
    );
  }
  if (value.resolverHash !== void 0) {
    assertString(value.resolverHash, filePath, "runtime.resolverHash");
    if (!/^[a-f0-9]{64}$/u.test(value.resolverHash)) {
      throw invalidDocument(
        filePath,
        "runtime.resolverHash",
        "must be a SHA-256 hash"
      );
    }
  }
  if (value.findingCatalogVersion !== void 0 && value.findingCatalogVersion !== 1) {
    throw invalidDocument(
      filePath,
      "runtime.findingCatalogVersion",
      "must be 1 when present"
    );
  }
  let completionPlans;
  if (value.completionPlans !== void 0) {
    assertObject(value.completionPlans, filePath, "runtime.completionPlans");
    completionPlans = {};
    for (const [nodeId, rawPlan] of Object.entries(value.completionPlans)) {
      assertObject(rawPlan, filePath, `runtime.completionPlans.${nodeId}`);
      assertString(
        rawPlan.nodeId,
        filePath,
        `runtime.completionPlans.${nodeId}.nodeId`
      );
      if (rawPlan.nodeId !== nodeId) {
        throw invalidDocument(
          filePath,
          `runtime.completionPlans.${nodeId}.nodeId`,
          "must match its map key"
        );
      }
      for (const field of [
        "outputSchemas",
        "requiredSkillCalls",
        "enforcedAugmentations",
        "guardrails"
      ]) {
        assertStringArray(
          rawPlan[field],
          filePath,
          `runtime.completionPlans.${nodeId}.${field}`
        );
      }
      completionPlans[nodeId] = rawPlan;
    }
  }
  return {
    protocolHash: value.protocolHash,
    protocol: value.protocol,
    nodeToStep: Object.fromEntries(
      Object.entries(value.nodeToStep).map(([nodeId, stepId2]) => [
        nodeId,
        stepId2
      ])
    ),
    ...value.capabilityVersion === 3 ? { capabilityVersion: 3 } : {},
    ...typeof value.resolverHash === "string" ? { resolverHash: value.resolverHash } : {},
    ...value.findingCatalogVersion === 1 ? { findingCatalogVersion: 1 } : {},
    ...completionPlans ? { completionPlans } : {}
  };
}
function narrowRuntimeEvals(value, filePath, fieldPath) {
  assertArray(value, filePath, fieldPath);
  value.forEach((entry, index) => {
    const itemPath = `${fieldPath}[${index}]`;
    assertObject(entry, filePath, itemPath);
    assertString(entry.id, filePath, `${itemPath}.id`);
    assertEnum(entry.scope, EVAL_SCOPES, filePath, `${itemPath}.scope`);
    assertEnum(entry.type, EVAL_TYPES, filePath, `${itemPath}.type`);
    assertOptionalString(entry, "artifact", filePath, itemPath);
    assertOptionalString(entry, "field", filePath, itemPath);
    assertOptionalString(entry, "equals", filePath, itemPath);
  });
  return value;
}
function loadSkillPackageDocument(document, root, filePath = path4.join(root, "package.json")) {
  assertObject(document, filePath);
  const packageKind = document.packageKind === "runtime" ? "runtime" : void 0;
  const runtime = narrowRuntimeMetadata(document.runtime, filePath);
  const definition = narrowSkillDefinition(document.definition, filePath);
  const guardrailDocument = narrowGuardrails(document.guardrails, filePath);
  const evals = narrowRuntimeEvals(document.evals, filePath, "evals");
  const defaultGuardrails = {
    allowedSkills: definition.skills.map((skill) => skill.id),
    allowedAgents: definition.agents.map((agent) => agent.id),
    allowedTools: definition.tools.map((tool) => tool.id),
    maxIterations: 50,
    maxRetriesPerAction: 3,
    confirmationRequiredFor: definition.tools.filter((tool) => tool.requiresConfirmation).map((tool) => tool.id)
  };
  return {
    root: path4.resolve(root),
    packageKind,
    runtime,
    definition,
    guardrails: {
      ...defaultGuardrails,
      ...guardrailDocument
    },
    evals
  };
}

// src/skill-runtime/validate.ts
import path5 from "path";
function validatesAction(action, pkg, errors, stepId2) {
  if (action.type === "invoke_skill" && !pkg.definition.skills.some((item) => item.id === action.ref)) {
    errors.push(
      `step ${stepId2} references undeclared skill: ${action.ref ?? "(missing)"}`
    );
  }
  if (action.type === "call_tool" && !pkg.definition.tools.some((item) => item.id === action.ref)) {
    errors.push(
      `step ${stepId2} references undeclared tool: ${action.ref ?? "(missing)"}`
    );
  }
  if (action.type === "handoff" && !pkg.definition.agents.some((item) => item.id === action.ref)) {
    errors.push(
      `step ${stepId2} references undeclared agent: ${action.ref ?? "(missing)"}`
    );
  }
  if (action.type === "ask_user" && !action.question) {
    errors.push(`step ${stepId2} ask_user action requires question`);
  }
  if (action.type === "ask_user" && pkg.runtime?.capabilityVersion === 3) {
    if (!action.decisionId) {
      errors.push(`step ${stepId2} decision action requires decisionId`);
    }
    if (!action.choices || action.choices.length === 0) {
      errors.push(`step ${stepId2} decision action requires choices`);
    }
    if (!action.requiredInputs) {
      errors.push(`step ${stepId2} decision action requires requiredInputs`);
    }
    if (!action.rationale) {
      errors.push(`step ${stepId2} decision action requires rationale policy`);
    }
    if (!action.reviewer) {
      errors.push(`step ${stepId2} decision action requires reviewer policy`);
    }
  }
  if (action.type !== "ask_user" && (action.decisionId !== void 0 || action.choices !== void 0 || action.requiredInputs !== void 0 || action.rationale !== void 0 || action.reviewer !== void 0)) {
    errors.push(`step ${stepId2} decision metadata requires ask_user action`);
  }
}
function validateSkillPackage(pkg) {
  const errors = [];
  const { definition, guardrails, evals } = pkg;
  if (definition.apiVersion !== "comet/v1alpha1")
    errors.push("unsupported apiVersion");
  if (definition.kind !== "Skill") errors.push("kind must be Skill");
  if (!definition.metadata.name) errors.push("metadata.name is required");
  if (!definition.goal.statement) errors.push("goal.statement is required");
  if (guardrails.maxIterations < 1)
    errors.push("maxIterations must be at least 1");
  if (guardrails.maxRetriesPerAction < 0)
    errors.push("maxRetriesPerAction must not be negative");
  const steps = definition.orchestration.steps ?? [];
  if (definition.orchestration.mode === "adaptive") {
    if (definition.orchestration.entry || steps.length > 0) {
      errors.push("adaptive orchestration must not define entry or steps");
    }
  } else {
    const ids = /* @__PURE__ */ new Set();
    for (const step of steps) {
      if (ids.has(step.id)) errors.push(`duplicate step id: ${step.id}`);
      ids.add(step.id);
      validatesAction(step.action, pkg, errors, step.id);
    }
    if (!definition.orchestration.entry || !ids.has(definition.orchestration.entry)) {
      errors.push(
        `orchestration.entry references unknown step: ${definition.orchestration.entry ?? "(missing)"}`
      );
    }
    for (const step of steps) {
      if (step.next && !ids.has(step.next))
        errors.push(`step ${step.id} has unknown next step: ${step.next}`);
      for (const evalId of step.completionEvals ?? []) {
        if (!evals.some((item) => item.id === evalId)) {
          errors.push(`step ${step.id} references unknown eval: ${evalId}`);
        }
      }
    }
  }
  for (const tool of definition.tools) {
    if (tool.kind !== "script") continue;
    const normalized = path5.posix.normalize(tool.source.replaceAll("\\", "/"));
    if (path5.isAbsolute(tool.source) || normalized === ".." || normalized.startsWith("../")) {
      errors.push(
        `script tool ${tool.id} must reference a relative path inside the Skill package`
      );
    }
  }
  for (const id of guardrails.allowedSkills) {
    if (!definition.skills.some((item) => item.id === id))
      errors.push(`guardrails allow undeclared skill: ${id}`);
  }
  for (const id of guardrails.allowedAgents) {
    if (!definition.agents.some((item) => item.id === id))
      errors.push(`guardrails allow undeclared agent: ${id}`);
  }
  for (const id of guardrails.allowedTools) {
    if (!definition.tools.some((item) => item.id === id))
      errors.push(`guardrails allow undeclared tool: ${id}`);
  }
  return errors;
}

// src/util.ts
import { createHash } from "node:crypto";
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)])
    );
  }
  return value;
}
function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
}

// src/skill-runtime/snapshot.ts
function packageDocument(pkg) {
  return stableValue({
    ...pkg.packageKind === "runtime" ? { packageKind: "runtime" } : {},
    ...pkg.runtime ? { runtime: pkg.runtime } : {},
    definition: pkg.definition,
    guardrails: pkg.guardrails,
    evals: pkg.evals
  });
}
function normalizedRelativePath(source) {
  return path6.posix.normalize(source.replaceAll("\\", "/"));
}
function assertInside(parent, target, label) {
  const relative = path6.relative(parent, target);
  if (relative === "" || !path6.isAbsolute(relative) && !relative.startsWith(`..${path6.sep}`)) {
    return;
  }
  throw new Error(`${label} resolves outside the Skill package`);
}
async function readPackageFile(root, relativePath, label) {
  const normalized = normalizedRelativePath(relativePath);
  if (path6.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} resolves outside the Skill package`);
  }
  const target = path6.resolve(root, ...normalized.split("/"));
  assertInside(root, target, label);
  let realTarget;
  try {
    realTarget = await fs4.realpath(target);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${label} does not exist: ${relativePath}`, {
        cause: error
      });
    }
    throw error;
  }
  assertInside(root, realTarget, label);
  if (!(await fs4.stat(realTarget)).isFile()) {
    throw new Error(`${label} is not a file: ${relativePath}`);
  }
  return { path: normalized, content: await fs4.readFile(realTarget) };
}
async function snapshotFiles(pkg) {
  const root = await fs4.realpath(pkg.root);
  const files = pkg.packageKind === "runtime" ? [] : [await readPackageFile(root, "SKILL.md", "SKILL.md")];
  for (const tool of pkg.definition.tools) {
    if (tool.kind !== "script") continue;
    files.push(
      await readPackageFile(root, tool.source, `Script tool ${tool.id}`)
    );
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
function hashSnapshot(document, files) {
  const fileDigests = files.map((file) => ({
    path: file.path,
    sha256: createHash2("sha256").update(file.content).digest("hex")
  }));
  return createHash2("sha256").update(
    JSON.stringify(stableValue({ package: document, files: fileDigests }))
  ).digest("hex");
}
function packageJson(document) {
  return JSON.stringify(document, null, 2) + "\n";
}
async function snapshotMaterial(pkg) {
  const document = packageDocument(pkg);
  const files = await snapshotFiles(pkg);
  return { document, files, hash: hashSnapshot(document, files) };
}
async function hashSkillPackage(pkg) {
  return (await snapshotMaterial(pkg)).hash;
}
async function pathExists(target) {
  try {
    await fs4.access(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function verifyPublishedSnapshot(snapshotDir, material) {
  try {
    const storedHash = (await fs4.readFile(path6.join(snapshotDir, "sha256"), "utf8")).trim();
    if (storedHash !== material.hash) throw new Error("hash mismatch");
    const storedPackage = await fs4.readFile(
      path6.join(snapshotDir, "package.json"),
      "utf8"
    );
    if (storedPackage !== packageJson(material.document))
      throw new Error("package mismatch");
    for (const file of material.files) {
      const stored = await fs4.readFile(
        path6.join(snapshotDir, ...file.path.split("/"))
      );
      if (!stored.equals(file.content))
        throw new Error(`file mismatch: ${file.path}`);
    }
  } catch (error) {
    throw new Error(`Existing Skill snapshot is invalid: ${material.hash}`, {
      cause: error
    });
  }
}
async function createSkillSnapshot(pkg, changeDir) {
  const material = await snapshotMaterial(pkg);
  const snapshotsRoot = path6.resolve(changeDir, ".comet", "skill-snapshots");
  const snapshotDir = path6.join(snapshotsRoot, material.hash);
  await fs4.mkdir(snapshotsRoot, { recursive: true });
  if (await pathExists(snapshotDir)) {
    await verifyPublishedSnapshot(snapshotDir, material);
    return { hash: material.hash, snapshotDir };
  }
  const temporaryDir = path6.join(snapshotsRoot, `.tmp-${randomUUID2()}`);
  assertInside(snapshotsRoot, temporaryDir, "Temporary snapshot");
  assertInside(snapshotsRoot, snapshotDir, "Published snapshot");
  try {
    await fs4.mkdir(temporaryDir);
    for (const file of material.files) {
      const destination = path6.join(temporaryDir, ...file.path.split("/"));
      assertInside(temporaryDir, destination, `Snapshot file ${file.path}`);
      await fs4.mkdir(path6.dirname(destination), { recursive: true });
      await fs4.writeFile(destination, file.content);
    }
    await fs4.writeFile(
      path6.join(temporaryDir, "package.json"),
      packageJson(material.document)
    );
    await fs4.writeFile(path6.join(temporaryDir, "sha256"), material.hash + "\n");
    await fs4.rename(temporaryDir, snapshotDir);
  } catch (error) {
    if (await pathExists(snapshotDir)) {
      try {
        await verifyPublishedSnapshot(snapshotDir, material);
      } finally {
        await fs4.rm(temporaryDir, { recursive: true, force: true });
      }
      return { hash: material.hash, snapshotDir };
    }
    await fs4.rm(temporaryDir, { recursive: true, force: true });
    throw error;
  }
  return { hash: material.hash, snapshotDir };
}
async function readSkillSnapshot(changeDir, hash) {
  if (!/^[a-f0-9]{64}$/u.test(hash)) {
    throw new Error(`Invalid Skill snapshot hash: ${hash}`);
  }
  const snapshotsRoot = path6.resolve(changeDir, ".comet", "skill-snapshots");
  const snapshotDir = path6.join(snapshotsRoot, hash);
  assertInside(snapshotsRoot, snapshotDir, "Skill snapshot");
  try {
    const storedHash = (await fs4.readFile(path6.join(snapshotDir, "sha256"), "utf8")).trim();
    if (storedHash !== hash) {
      throw new Error(`stored hash is ${storedHash || "(empty)"}`);
    }
    const packagePath = path6.join(snapshotDir, "package.json");
    const document = JSON.parse(
      await fs4.readFile(packagePath, "utf8")
    );
    const pkg = loadSkillPackageDocument(document, snapshotDir, packagePath);
    const errors = validateSkillPackage(pkg);
    if (errors.length > 0) {
      throw new Error(errors.map((error) => `  - ${error}`).join("\n"));
    }
    const calculated = await hashSkillPackage(pkg);
    if (calculated !== hash) {
      throw new Error(`calculated hash is ${calculated}`);
    }
    return pkg;
  } catch (error) {
    throw new Error(`Skill snapshot is invalid or missing: ${hash}`, {
      cause: error
    });
  }
}

// src/engine/run-store.ts
import path7 from "path";

// src/engine/protected-run-file.ts
import { TextDecoder } from "util";
function identityOf2(stat) {
  return { dev: stat.dev, ino: stat.ino, birthtime: stat.birthtimeMs };
}
function decodeRunText(result, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
}
async function readSnapshot(changeDir, relativePath, maxBytes, label, options = {}) {
  try {
    const result = await readProtectedProjectFile(
      changeDir,
      relativePath,
      maxBytes,
      {
        label,
        hooks: options.hooks
      }
    );
    return { result, text: decodeRunText(result, label) };
  } catch (error) {
    const code = error.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}
async function readOptionalEngineRunText(changeDir, relativePath, maxBytes, label, options = {}) {
  return (await readSnapshot(changeDir, relativePath, maxBytes, label, options))?.text ?? null;
}
async function writeEngineRunText(changeDir, relativePath, content, maxBytes, label, options = {}) {
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes`);
  }
  const expected = await readSnapshot(changeDir, relativePath, maxBytes, label);
  const inspection = await inspectProtectedProjectPath(
    changeDir,
    relativePath,
    {
      label,
      expected: "file"
    }
  );
  await atomicWriteContainedText(inspection.target, content, {
    containedRoot: inspection.projectRoot,
    beforeCommit: async () => {
      await options.beforeCommit?.();
      const current = await readSnapshot(
        changeDir,
        relativePath,
        maxBytes,
        label
      );
      if (!expected && !current) return;
      if (!expected || !current) {
        throw new Error(`${label} changed before commit`);
      }
      if (expected.result.realPath !== current.result.realPath || !sameFileObject(
        identityOf2(expected.result.stat),
        identityOf2(current.result.stat)
      ) || expected.text !== current.text) {
        throw new Error(`${label} changed before commit`);
      }
    }
  });
}
async function removeEngineRunFile(changeDir, relativePath, label, options = {}) {
  const inspection = await inspectProtectedProjectPath(
    changeDir,
    relativePath,
    {
      label,
      expected: "file"
    }
  );
  if (!inspection.exists) return false;
  return removeContainedFile(inspection.target, {
    containedRoot: inspection.projectRoot,
    beforeRemove: options.beforeRemove
  });
}

// src/engine/run-store.ts
var RUN_FILE_LIMITS = {
  trajectory: 8 * 1024 * 1024,
  artifacts: 1024 * 1024,
  context: 1024 * 1024,
  pendingAction: 256 * 1024,
  checkpoint: 256 * 1024
};
var ACTION_TYPES2 = /* @__PURE__ */ new Set([
  "invoke_skill",
  "call_tool",
  "handoff",
  "ask_user",
  "checkpoint"
]);
var TRAJECTORY_EVENT_TYPES = /* @__PURE__ */ new Set([
  "run_started",
  "action_proposed",
  "action_completed",
  "eval_completed",
  "checkpoint",
  "state_migrated",
  "state_transitioned",
  "command_check_recorded",
  "recovery_reconciled"
]);
var ACTION_KEYS = /* @__PURE__ */ new Set([
  "id",
  "stepId",
  "type",
  "ref",
  "prompt",
  "question",
  "options",
  "decisionId",
  "choices",
  "requiredInputs",
  "rationale",
  "reviewer",
  "scope",
  "attemptId",
  "cycleId",
  "visitOrdinal",
  "retryOrdinal"
]);
var appendLocks = /* @__PURE__ */ new Map();
function assertRunPath(changeDir, relativePath) {
  const normalized = typeof relativePath === "string" ? relativePath.replaceAll("\\", "/") : "";
  if (typeof relativePath !== "string" || normalized.length === 0 || path7.posix.isAbsolute(normalized) || path7.win32.isAbsolute(relativePath) || /^(?:[A-Za-z]:|[\\/]|~)/u.test(relativePath) || normalized.split("/").some(
    (segment) => segment.length === 0 || segment === "." || segment === ".."
  )) {
    throw new Error("Run path must stay inside the change directory");
  }
  const root = path7.resolve(changeDir);
  const target = path7.resolve(root, ...normalized.split("/"));
  if (target !== root && !target.startsWith(root + path7.sep)) {
    throw new Error("Run path must stay inside the change directory");
  }
  return normalized;
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function requiredText(value, key, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${label}: ${key} must be a non-empty string`);
  }
  return value;
}
function nullableText(value, key, label) {
  if (value === null) return null;
  return requiredText(value, key, label);
}
function assertKnownFields(value, keys, label) {
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) throw new Error(`Invalid ${label}: unknown field ${unknown}`);
}
function requiredFields(value, keys, label) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`Invalid ${label}: ${key} is required`);
    }
  }
}
function nonNegativeInteger(value, key, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}: ${key} must be a non-negative integer`);
  }
  return value;
}
function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}
function parseScopeProducer(value, label) {
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(
    value,
    /* @__PURE__ */ new Set([
      "runId",
      "nodeId",
      "cycleId",
      "attemptId",
      "actionId",
      "revision"
    ]),
    label
  );
  const cycleId = value.cycleId;
  if (cycleId !== null && (typeof cycleId !== "string" || cycleId.length === 0)) {
    throw new Error(`Invalid ${label}: cycleId must be a string or null`);
  }
  return {
    runId: requiredText(value.runId, "runId", label),
    nodeId: requiredText(value.nodeId, "nodeId", label),
    cycleId,
    attemptId: requiredText(value.attemptId, "attemptId", label),
    actionId: requiredText(value.actionId, "actionId", label),
    revision: nonNegativeInteger(value.revision, "revision", label)
  };
}
function parseScopeReference(value, label) {
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(
    value,
    /* @__PURE__ */ new Set(["id", "required", "versionId", "contentHash", "producer"]),
    label
  );
  const contentHash2 = requiredText(value.contentHash, "contentHash", label);
  if (!/^[a-f0-9]{64}$/u.test(contentHash2)) {
    throw new Error(`Invalid ${label}: contentHash must be a SHA-256 hash`);
  }
  if (typeof value.required !== "boolean") {
    throw new Error(`Invalid ${label}: required must be a boolean`);
  }
  return {
    id: requiredText(value.id, "id", label),
    required: value.required,
    versionId: requiredText(value.versionId, "versionId", label),
    contentHash: contentHash2,
    producer: parseScopeProducer(value.producer, `${label}.producer`)
  };
}
function parseDecisionScope(value, label) {
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(value, /* @__PURE__ */ new Set(["artifacts", "evidence"]), label);
  const parseEntries = (kind) => {
    const entries = value[kind];
    if (!Array.isArray(entries)) {
      throw new Error(`Invalid ${label}.${kind}: must be an array`);
    }
    if (entries.length > 64) {
      throw new Error(`Invalid ${label}.${kind}: too many entries`);
    }
    return entries.map(
      (entry, index) => parseScopeReference(entry, `${label}.${kind}[${index}]`)
    );
  };
  return {
    artifacts: parseEntries("artifacts"),
    evidence: parseEntries("evidence")
  };
}
function parseAction(value) {
  if (!isRecord(value)) {
    throw new Error(
      "Invalid Run pending action: stored value must be an object"
    );
  }
  assertKnownFields(value, ACTION_KEYS, "Run pending action");
  requiredFields(
    value,
    /* @__PURE__ */ new Set(["id", "stepId", "type"]),
    "Run pending action"
  );
  const id = requiredText(value.id, "id", "Run pending action");
  const stepId2 = nullableText(value.stepId, "stepId", "Run pending action");
  if (!ACTION_TYPES2.has(value.type)) {
    throw new Error("Invalid Run pending action: type is invalid");
  }
  const action = {
    id,
    stepId: stepId2,
    type: value.type
  };
  for (const key of ["ref", "prompt", "question"]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      if (typeof value[key] !== "string") {
        throw new Error(`Invalid Run pending action: ${key} must be a string`);
      }
      action[key] = value[key];
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, "options")) {
    if (!Array.isArray(value.options) || value.options.some((option) => typeof option !== "string")) {
      throw new Error(
        "Invalid Run pending action: options must be an array of strings"
      );
    }
    action.options = value.options;
  }
  if (Object.prototype.hasOwnProperty.call(value, "decisionId")) {
    action.decisionId = requiredText(
      value.decisionId,
      "decisionId",
      "Run pending action"
    );
  }
  if (Object.prototype.hasOwnProperty.call(value, "choices")) {
    if (!Array.isArray(value.choices)) {
      throw new Error("Invalid Run pending action: choices must be an array");
    }
    action.choices = value.choices.map(
      (choice, index) => parseDecisionChoiceSummary(
        choice,
        `Run pending action choices[${index}]`
      )
    );
  }
  if (Object.prototype.hasOwnProperty.call(value, "requiredInputs")) {
    action.requiredInputs = parseDecisionInputSchema(
      value.requiredInputs,
      "Run pending action requiredInputs"
    );
  }
  if (Object.prototype.hasOwnProperty.call(value, "rationale")) {
    action.rationale = parseRationalePolicy(
      value.rationale,
      "Run pending action rationale"
    );
  }
  if (Object.prototype.hasOwnProperty.call(value, "reviewer")) {
    action.reviewer = parseReviewerPolicy(
      value.reviewer,
      "Run pending action reviewer"
    );
  }
  if (Object.prototype.hasOwnProperty.call(value, "scope")) {
    if (action.type !== "ask_user") {
      throw new Error("Invalid Run pending action: scope requires ask_user");
    }
    action.scope = parseDecisionScope(value.scope, "Run pending action scope");
  }
  if (Object.prototype.hasOwnProperty.call(value, "attemptId")) {
    action.attemptId = requiredText(
      value.attemptId,
      "attemptId",
      "Run pending action"
    );
  }
  if (Object.prototype.hasOwnProperty.call(value, "cycleId")) {
    action.cycleId = nullableText(
      value.cycleId,
      "cycleId",
      "Run pending action"
    );
  }
  for (const key of ["visitOrdinal", "retryOrdinal"]) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const ordinal = value[key];
    const minimum = key === "visitOrdinal" ? 1 : 0;
    if (typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) || ordinal < minimum) {
      throw new Error(
        `Invalid Run pending action: ${key} must be an integer at least ${minimum}`
      );
    }
    action[key] = ordinal;
  }
  return action;
}
function parseDecisionScalarType(value, label) {
  if (value !== "string" && value !== "number" && value !== "boolean") {
    throw new Error(`Invalid ${label}: type is invalid`);
  }
  return value;
}
function parseDecisionInputSchema(value, label) {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${label}: must be an object`);
  }
  assertKnownFields(value, /* @__PURE__ */ new Set(["type", "fields"]), label);
  if (value.type !== "object") {
    throw new Error(`Invalid ${label}: type must be object`);
  }
  if (!Array.isArray(value.fields)) {
    throw new Error(`Invalid ${label}: fields must be an array`);
  }
  const ids = /* @__PURE__ */ new Set();
  const fields = value.fields.map((entry, index) => {
    const fieldLabel = `${label}.fields[${index}]`;
    if (!isRecord(entry)) {
      throw new Error(`Invalid ${fieldLabel}: must be an object`);
    }
    assertKnownFields(
      entry,
      /* @__PURE__ */ new Set(["id", "type", "required", "values", "enum"]),
      fieldLabel
    );
    const id = requiredText(entry.id, "id", fieldLabel);
    if (ids.has(id)) throw new Error(`Invalid ${label}: duplicate field ${id}`);
    ids.add(id);
    const type = parseDecisionScalarType(entry.type, `${fieldLabel}.type`);
    if (entry.required !== void 0 && typeof entry.required !== "boolean") {
      throw new Error(`Invalid ${fieldLabel}: required must be a boolean`);
    }
    if (entry.values !== void 0 && entry.enum !== void 0) {
      throw new Error(`Invalid ${fieldLabel}: values and enum are exclusive`);
    }
    const rawValues = entry.values ?? entry.enum;
    let values;
    if (rawValues !== void 0) {
      if (!Array.isArray(rawValues) || rawValues.length === 0) {
        throw new Error(`Invalid ${fieldLabel}: values must be non-empty`);
      }
      const seen = /* @__PURE__ */ new Set();
      values = rawValues.map((rawValue) => {
        const valid = type === "string" && typeof rawValue === "string" || type === "number" && typeof rawValue === "number" && Number.isFinite(rawValue) || type === "boolean" && typeof rawValue === "boolean";
        if (!valid) throw new Error(`Invalid ${fieldLabel}: enum value type`);
        const key = JSON.stringify(rawValue);
        if (seen.has(key))
          throw new Error(`Invalid ${fieldLabel}: duplicate enum value`);
        seen.add(key);
        return rawValue;
      });
    }
    return {
      id,
      type,
      ...entry.required !== void 0 ? { required: entry.required } : {},
      ...values ? entry.values !== void 0 ? { values } : { enum: values } : {}
    };
  });
  return { type: "object", fields };
}
function parseDecisionChoiceSummary(value, label) {
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(value, /* @__PURE__ */ new Set(["id", "label", "requiredInputs"]), label);
  const result = {
    id: requiredText(value.id, "id", label),
    label: requiredText(value.label, "label", label)
  };
  if (value.requiredInputs !== void 0) {
    result.requiredInputs = parseDecisionInputSchema(
      value.requiredInputs,
      `${label}.requiredInputs`
    );
  }
  return result;
}
function parseRationalePolicy(value, label) {
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(value, /* @__PURE__ */ new Set(["required"]), label);
  if (value.required !== void 0 && typeof value.required !== "boolean") {
    throw new Error(`Invalid ${label}: required must be a boolean`);
  }
  return { required: value.required === true };
}
function parseReviewerPolicy(value, label) {
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(value, /* @__PURE__ */ new Set(["subjects", "authorities"]), label);
  const result = {};
  for (const key of ["subjects", "authorities"]) {
    if (value[key] === void 0) continue;
    if (!Array.isArray(value[key]) || value[key].some(
      (entry) => typeof entry !== "string" || entry.length === 0
    )) {
      throw new Error(`Invalid ${label}: ${key} must be a string array`);
    }
    result[key] = [...value[key]];
  }
  return result;
}
function parseArtifacts(value) {
  if (!isRecord(value)) {
    throw new Error("Invalid Run artifacts: stored value must be an object");
  }
  for (const artifact of Object.values(value)) {
    if (typeof artifact !== "string") {
      throw new Error("Invalid Run artifacts: artifact values must be strings");
    }
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, artifact]) => [key, artifact])
  );
}
function parseTrajectoryEvent(value) {
  if (!isRecord(value)) {
    throw new Error("Invalid Run trajectory: stored value must be an object");
  }
  const keys = /* @__PURE__ */ new Set(["sequence", "timestamp", "type", "runId", "data"]);
  assertKnownFields(value, keys, "Run trajectory");
  requiredFields(value, keys, "Run trajectory");
  if (typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    throw new Error(
      "Invalid Run trajectory: sequence must be a positive integer"
    );
  }
  if (!TRAJECTORY_EVENT_TYPES.has(value.type)) {
    throw new Error("Invalid Run trajectory: type is invalid");
  }
  if (!isRecord(value.data)) {
    throw new Error("Invalid Run trajectory: data must be an object");
  }
  return {
    sequence: value.sequence,
    timestamp: requiredText(value.timestamp, "timestamp", "Run trajectory"),
    type: value.type,
    runId: requiredText(value.runId, "runId", "Run trajectory"),
    data: value.data
  };
}
function parseTrajectory(raw) {
  if (raw === null) return [];
  const events = [];
  let expectedSequence = 1;
  let runId;
  for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    if (line.length === 0) continue;
    let event;
    try {
      event = parseTrajectoryEvent(JSON.parse(line));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid Trajectory event at line ${index + 1}`, {
          cause: error
        });
      }
      throw new Error(
        `Invalid Trajectory event at line ${index + 1}: ${String(
          error instanceof Error ? error.message : error
        )}`,
        { cause: error }
      );
    }
    if (event.sequence !== expectedSequence) {
      throw new Error(
        `Invalid Trajectory event at line ${index + 1}: sequence must be ${expectedSequence}, got ${event.sequence}`
      );
    }
    if (runId !== void 0 && event.runId !== runId) {
      throw new Error(
        `Invalid Trajectory event at line ${index + 1}: runId must remain ${runId}`
      );
    }
    runId = event.runId;
    events.push(event);
    expectedSequence += 1;
  }
  return events;
}
function assertNextTrajectoryEvent(events, event) {
  const expectedSequence = events.length + 1;
  if (event.sequence !== expectedSequence) {
    throw new Error(
      `Run trajectory sequence must be ${expectedSequence}, got ${event.sequence}`
    );
  }
  const last = events.at(-1);
  if (last && last.runId !== event.runId) {
    throw new Error(`Run trajectory runId must remain ${last.runId}`);
  }
}
async function withAppendLock(key, operation2) {
  const previous = appendLocks.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  appendLocks.set(key, current);
  await previous;
  try {
    return await operation2();
  } finally {
    release();
    if (appendLocks.get(key) === current) appendLocks.delete(key);
  }
}
async function appendTrajectory(changeDir, relativePath, event, options = {}) {
  const normalized = assertRunPath(changeDir, relativePath);
  const key = `${path7.resolve(changeDir)}\0${normalized}`;
  await withAppendLock(key, async () => {
    const raw = await readOptionalEngineRunText(
      changeDir,
      normalized,
      RUN_FILE_LIMITS.trajectory,
      "Run trajectory"
    );
    const events = parseTrajectory(raw);
    const parsed = parseTrajectoryEvent(event);
    assertNextTrajectoryEvent(events, parsed);
    const prefix = raw === null || raw.length === 0 || raw.endsWith("\n") ? raw ?? "" : `${raw}
`;
    const content = `${prefix}${JSON.stringify(parsed)}
`;
    await writeEngineRunText(
      changeDir,
      normalized,
      content,
      RUN_FILE_LIMITS.trajectory,
      "Run trajectory",
      {
        beforeCommit: async () => {
          await options.beforeCommit?.();
          const latest = parseTrajectory(
            await readOptionalEngineRunText(
              changeDir,
              normalized,
              RUN_FILE_LIMITS.trajectory,
              "Run trajectory"
            )
          );
          assertNextTrajectoryEvent(latest, parsed);
        }
      }
    );
  });
}
async function readTrajectory(changeDir, relativePath, options = {}) {
  const normalized = assertRunPath(changeDir, relativePath);
  const raw = await readOptionalEngineRunText(
    changeDir,
    normalized,
    RUN_FILE_LIMITS.trajectory,
    "Run trajectory",
    options
  );
  return parseTrajectory(raw);
}
async function readArtifacts(changeDir, relativePath, options = {}) {
  const normalized = assertRunPath(changeDir, relativePath);
  const raw = await readOptionalEngineRunText(
    changeDir,
    normalized,
    RUN_FILE_LIMITS.artifacts,
    "Run artifacts",
    options
  );
  return raw === null ? {} : parseArtifacts(parseJson(raw, "Run artifacts"));
}
async function writeArtifacts(changeDir, relativePath, artifacts, options = {}) {
  const normalized = assertRunPath(changeDir, relativePath);
  const parsed = parseArtifacts(artifacts);
  await writeEngineRunText(
    changeDir,
    normalized,
    JSON.stringify(parsed, null, 2) + "\n",
    RUN_FILE_LIMITS.artifacts,
    "Run artifacts",
    options
  );
}
async function writePendingAction(changeDir, relativePath, action, options = {}) {
  const normalized = assertRunPath(changeDir, relativePath);
  const parsed = parseAction(action);
  await writeEngineRunText(
    changeDir,
    normalized,
    JSON.stringify(parsed, null, 2) + "\n",
    RUN_FILE_LIMITS.pendingAction,
    "Run pending action",
    options
  );
}
async function readPendingAction(changeDir, relativePath, options = {}) {
  const normalized = assertRunPath(changeDir, relativePath);
  const raw = await readOptionalEngineRunText(
    changeDir,
    normalized,
    RUN_FILE_LIMITS.pendingAction,
    "Run pending action",
    options
  );
  return raw === null ? null : parseAction(parseJson(raw, "Run pending action"));
}
async function clearPendingAction(changeDir, relativePath, options = {}) {
  const normalized = assertRunPath(changeDir, relativePath);
  await removeEngineRunFile(
    changeDir,
    normalized,
    "Run pending action",
    options
  );
}

// src/workflow-runtime/artifacts.ts
import { promises as fs5 } from "node:fs";
import path8 from "node:path";
var ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
var ARTIFACT_MAX_ENTRIES = 256;
var WorkflowArtifactValidationError = class extends Error {
  blockers;
  constructor(blockers) {
    super(blockers.join("\n"));
    this.name = "WorkflowArtifactValidationError";
    this.blockers = [...blockers];
  }
};
function fail(message) {
  throw new WorkflowArtifactValidationError([message]);
}
function versioningEnabled(protocol) {
  return Boolean(
    protocol.capabilities?.features.includes("versioned-artifacts")
  );
}
function declarations(protocol) {
  return protocol.outputSchemas.flatMap(
    (schema) => schema.artifacts.map((artifact) => ({
      artifactId: `${schema.id}.${artifact.id}`,
      schemaId: schema.id,
      artifact
    }))
  );
}
function declarationsForNode(protocol, nodeId) {
  const node = protocol.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) fail(`Workflow artifact producer Node is unknown: ${nodeId}`);
  const schemaIds = new Set(node.outputSchemas);
  return declarations(protocol).filter((item) => schemaIds.has(item.schemaId));
}
function declarationFor(key, candidates) {
  const exact = candidates.filter((candidate) => candidate.artifactId === key);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) fail(`Workflow artifact id is ambiguous: ${key}`);
  const short = candidates.filter((candidate) => candidate.artifact.id === key);
  if (short.length === 1) return short[0];
  if (short.length > 1) {
    fail(`Workflow artifact id requires a schema-qualified name: ${key}`);
  }
  fail(`Workflow artifact id is not declared: ${key}`);
}
function artifactPatternSegments(value, label) {
  const normalized = value.trim().replaceAll("\\", "/");
  if (normalized.length === 0 || path8.posix.isAbsolute(normalized) || path8.win32.isAbsolute(normalized) || /^(?:~|[\\/])/u.test(normalized)) {
    throw new Error(`${label} must be relative to the Run root`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`${label} must stay inside the Run root`);
  }
  if (segments.some((segment) => segment.length === 0 || segment === ".")) {
    throw new Error(`${label} must not contain empty or dot path segments`);
  }
  if (segments.some((segment) => segment.includes("?"))) {
    throw new Error(`${label} supports only * wildcards`);
  }
  return segments;
}
function patternMatcher(pattern) {
  return new RegExp(
    `^${pattern.split("*").map((part) => part.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&")).join(".*")}$`,
    "u"
  );
}
function artifactPathMatches(artifactPath, patterns) {
  const candidateSegments = artifactPatternSegments(
    artifactPath,
    "Workflow artifact path"
  );
  return patterns.some((pattern) => {
    const patternSegments = artifactPatternSegments(
      pattern,
      "Workflow artifact declaration"
    );
    return candidateSegments.length === patternSegments.length && candidateSegments.every(
      (segment, index) => patternMatcher(patternSegments[index]).test(segment)
    );
  });
}
function workflowArtifactExpectedKind(artifact) {
  return artifact.kind === "directory" ? "directory" : "file";
}
async function realRunRoot(runRoot, label) {
  const stat = await fs5.lstat(runRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} Run root must be a real directory`);
  }
  return path8.resolve(runRoot);
}
async function matchingWorkflowArtifactPaths(runRoot, artifactPath, expected, label, options = { maxMatches: ARTIFACT_MAX_ENTRIES }) {
  const segments = artifactPatternSegments(artifactPath, label);
  const root = await realRunRoot(runRoot, label);
  async function walk(relative, index) {
    if (index >= segments.length) {
      const inspection = await inspectProtectedProjectPath(runRoot, relative, {
        label,
        expected
      });
      return inspection.exists ? [inspection.relative] : [];
    }
    const current = relative.length === 0 ? root : path8.join(root, relative);
    if (relative.length > 0) {
      const inspection = await inspectProtectedProjectPath(runRoot, relative, {
        label,
        expected: "directory"
      });
      if (!inspection.exists) return [];
    }
    const segment = segments[index];
    if (!segment.includes("*")) {
      return walk(
        relative.length === 0 ? segment : path8.posix.join(relative, segment),
        index + 1
      );
    }
    let entries;
    try {
      entries = await fs5.readdir(current, { withFileTypes: true });
    } catch (error) {
      const code = error.code;
      if (code === "ENOENT" || code === "ENOTDIR") return [];
      throw error;
    }
    const matcher = patternMatcher(segment);
    const matches = [];
    for (const entry of entries.sort(
      (left, right) => left.name.localeCompare(right.name)
    )) {
      if (entry.isSymbolicLink()) {
        throw new Error(
          `${label} crosses a symbolic link or junction at ${path8.join(current, entry.name)}`
        );
      }
      if (!matcher.test(entry.name)) continue;
      const final = index === segments.length - 1;
      if (!final && !entry.isDirectory()) continue;
      if (final && (expected === "file" && !entry.isFile() || expected === "directory" && !entry.isDirectory())) {
        continue;
      }
      const next = relative.length === 0 ? entry.name : path8.posix.join(relative, entry.name);
      matches.push(...await walk(next, index + 1));
      if (options.maxMatches !== void 0 && matches.length > options.maxMatches) {
        throw new Error(
          `${label} exceeds ${options.maxMatches} matching paths`
        );
      }
    }
    return matches;
  }
  return walk("", 0);
}
async function resolveArtifactPath(runRoot, declaration, requestedPath) {
  const label = `Workflow artifact ${declaration.artifactId}`;
  if (!artifactPathMatches(requestedPath, declaration.artifact.paths)) {
    fail(`${label} path is outside its declaration: ${requestedPath}`);
  }
  const normalized = artifactPatternSegments(requestedPath, label).join("/");
  if (normalized.includes("*")) {
    fail(`${label} update path must identify one physical artifact`);
  }
  const inspection = await inspectProtectedProjectPath(runRoot, normalized, {
    label,
    expected: workflowArtifactExpectedKind(declaration.artifact)
  });
  return inspection.exists ? inspection.relative : null;
}
async function hashDirectoryArtifact(runRoot, relativePath, label) {
  const manifest = [];
  let totalBytes = 0;
  async function walk(directory) {
    const inspection = await inspectProtectedProjectPath(runRoot, directory, {
      label,
      expected: "directory"
    });
    if (!inspection.exists) throw new Error(`${label} does not exist`);
    const entries = (await fs5.readdir(inspection.target, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = path8.posix.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `${label} crosses a symbolic link or junction at ${relative}`
        );
      }
      if (entry.isDirectory()) {
        await walk(relative);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          `${label} contains an unsupported object at ${relative}`
        );
      }
      const result = await readProtectedProjectFile(
        runRoot,
        relative,
        ARTIFACT_MAX_BYTES,
        { label }
      );
      totalBytes += result.bytes.length;
      if (totalBytes > ARTIFACT_MAX_BYTES) {
        throw new Error(`${label} exceeds ${ARTIFACT_MAX_BYTES} bytes`);
      }
      manifest.push({ path: relative, contentHash: sha256(result.bytes) });
      if (manifest.length > ARTIFACT_MAX_ENTRIES) {
        throw new Error(`${label} exceeds ${ARTIFACT_MAX_ENTRIES} entries`);
      }
    }
  }
  await walk(relativePath);
  return sha256(JSON.stringify(stableValue({ kind: "directory", manifest })));
}
async function hashArtifactPath(runRoot, declaration, relativePath) {
  const label = `Workflow artifact ${declaration.artifactId}`;
  if (!artifactPathMatches(relativePath, declaration.artifact.paths)) {
    fail(`${label} path is outside its declaration: ${relativePath}`);
  }
  if (declaration.artifact.kind === "directory") {
    return hashDirectoryArtifact(runRoot, relativePath, label);
  }
  const result = await readProtectedProjectFile(
    runRoot,
    relativePath,
    ARTIFACT_MAX_BYTES,
    { label }
  );
  return sha256(result.bytes);
}
async function validateWorkflowArtifactVersion(runRoot, protocol, version) {
  const declaration = declarationFor(
    version.artifactId,
    declarations(protocol)
  );
  if (version.schemaId !== declaration.schemaId || version.lifetime !== artifactLifetime(declaration) || !artifactPathMatches(version.path, declaration.artifact.paths)) {
    fail(`Workflow artifact version identity is invalid: ${version.id}`);
  }
  const currentHash = await hashArtifactPath(
    runRoot,
    declaration,
    version.path
  );
  if (currentHash !== version.contentHash) {
    fail(`Workflow artifact content drift detected: ${version.id}`);
  }
}
function artifactLifetime(declaration) {
  return declaration.artifact.lifetime ?? "attempt";
}
function artifactScopeId(lifetime, state) {
  const attempt = state.workflowRuntime?.currentAttempt;
  if (!attempt) fail("Workflow artifact update requires a current Attempt");
  if (lifetime === "attempt") return attempt.id;
  if (lifetime === "cycle") {
    if (!attempt.cycleId) {
      fail("Cycle-persistent artifact update requires a current Cycle");
    }
    return attempt.cycleId;
  }
  return state.runId;
}
function selection(artifactId, versionId, state, nodeId, actionId2, timestamp) {
  const runtime = state.workflowRuntime;
  const attempt = runtime?.currentAttempt;
  if (!runtime || !attempt) {
    fail("Workflow artifact selection requires a current Attempt");
  }
  return {
    artifactId,
    versionId,
    runId: state.runId,
    nodeId,
    cycleId: attempt.cycleId,
    attemptId: attempt.id,
    actionId: actionId2,
    revision: runtime.revision,
    timestamp
  };
}
function artifactVersionId(artifactId, contentHash2, pathValue, producer, scopeId) {
  return `artifact-version-${sha256(
    JSON.stringify(
      stableValue({
        artifactId,
        contentHash: contentHash2,
        path: pathValue,
        producer,
        scopeId
      })
    )
  ).slice(0, 24)}`;
}
function assertSelectionScope(version, state) {
  const attempt = state.workflowRuntime?.currentAttempt;
  if (!attempt) fail("Workflow artifact selection requires a current Attempt");
  if (version.producer.runId !== state.runId) {
    fail(`Workflow artifact version belongs to another Run: ${version.id}`);
  }
  if (version.lifetime === "attempt" && version.scopeId !== attempt.id) {
    fail(`Attempt artifact version is stale for this Attempt: ${version.id}`);
  }
  if (version.lifetime === "cycle" && version.scopeId !== attempt.cycleId) {
    fail(`Cycle artifact version is stale for this Cycle: ${version.id}`);
  }
  if (version.lifetime === "run" && version.scopeId !== state.runId) {
    fail(`Run artifact version has an invalid scope: ${version.id}`);
  }
}
function requestedDeclarations(values, candidates, label) {
  const result = /* @__PURE__ */ new Map();
  for (const [key, value] of Object.entries(values)) {
    const declaration = declarationFor(key, candidates);
    if (result.has(declaration.artifactId)) {
      fail(`${label} repeats artifact ${declaration.artifactId}`);
    }
    result.set(declaration.artifactId, { declaration, value });
  }
  return result;
}
async function prepareWorkflowArtifactMutation(options) {
  const empty = {
    versions: [],
    selections: [],
    artifactPaths: {},
    selectedVersionIds: {}
  };
  if (!versioningEnabled(options.protocol)) {
    if (Object.keys(options.artifactVersions ?? {}).length > 0) {
      fail(
        "Workflow artifact selections require versioned-artifacts capability"
      );
    }
    return empty;
  }
  const runtime = options.state.workflowRuntime;
  const attempt = runtime?.currentAttempt;
  if (!runtime || !attempt) {
    fail("Versioned artifact submission requires revisioned Run state");
  }
  const allDeclarations = declarations(options.protocol);
  const outputDeclarations = declarationsForNode(
    options.protocol,
    options.nodeId
  );
  const requestedUpdates = requestedDeclarations(
    options.artifacts ?? {},
    outputDeclarations,
    "Workflow artifact updates"
  );
  const requestedSelections = requestedDeclarations(
    options.artifactVersions ?? {},
    allDeclarations,
    "Workflow artifact selections"
  );
  for (const artifactId of requestedSelections.keys()) {
    if (requestedUpdates.has(artifactId)) {
      fail(
        `Workflow artifact cannot be updated and carried forward: ${artifactId}`
      );
    }
  }
  for (const declaration of outputDeclarations) {
    if (declaration.artifact.required && !requestedUpdates.has(declaration.artifactId) && !requestedSelections.has(declaration.artifactId)) {
      fail(
        `Required Workflow artifact needs an explicit update or version: ${declaration.artifactId}`
      );
    }
  }
  const mutation = structuredClone(empty);
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  for (const { declaration, value: requested } of requestedUpdates.values()) {
    const artifactPath = await resolveArtifactPath(
      options.runRoot,
      declaration,
      requested
    );
    if (!artifactPath) {
      fail(
        `Workflow artifact update does not exist: ${declaration.artifactId}`
      );
    }
    const lifetime = artifactLifetime(declaration);
    if (lifetime === "attempt" && !artifactPath.split("/").includes(attempt.id)) {
      fail(
        `Attempt artifact path must include the current Attempt id: ${declaration.artifactId}`
      );
    }
    const contentHash2 = await hashArtifactPath(
      options.runRoot,
      declaration,
      artifactPath
    );
    const scopeId = artifactScopeId(lifetime, options.state);
    const producer = {
      runId: options.state.runId,
      nodeId: options.nodeId,
      cycleId: attempt.cycleId,
      attemptId: attempt.id,
      actionId: options.actionId,
      revision: runtime.revision
    };
    const id = artifactVersionId(
      declaration.artifactId,
      contentHash2,
      artifactPath,
      producer,
      scopeId
    );
    if (runtime.artifactVersions.some((version2) => version2.id === id)) {
      fail(`Workflow artifact version already exists: ${id}`);
    }
    const version = {
      id,
      artifactId: declaration.artifactId,
      schemaId: declaration.schemaId,
      lifetime,
      scopeId,
      contentHash: contentHash2,
      path: artifactPath,
      producer,
      timestamp
    };
    mutation.versions.push(version);
    mutation.selections.push(
      selection(
        declaration.artifactId,
        id,
        options.state,
        options.nodeId,
        options.actionId,
        timestamp
      )
    );
    mutation.artifactPaths[declaration.artifactId] = artifactPath;
    mutation.selectedVersionIds[declaration.artifactId] = id;
  }
  for (const {
    declaration,
    value: versionId
  } of requestedSelections.values()) {
    const version = runtime.artifactVersions.find(
      (candidate) => candidate.id === versionId
    );
    if (!version) fail(`Workflow artifact version is unknown: ${versionId}`);
    if (version.artifactId !== declaration.artifactId) {
      fail(
        `Workflow artifact version ${versionId} does not belong to ${declaration.artifactId}`
      );
    }
    if (version.lifetime !== artifactLifetime(declaration)) {
      fail(
        `Workflow artifact lifetime is incompatible: ${declaration.artifactId}`
      );
    }
    assertSelectionScope(version, options.state);
    const contentHash2 = await hashArtifactPath(
      options.runRoot,
      declaration,
      version.path
    );
    if (contentHash2 !== version.contentHash) {
      fail(`Workflow artifact content drift detected: ${version.id}`);
    }
    mutation.selections.push(
      selection(
        declaration.artifactId,
        version.id,
        options.state,
        options.nodeId,
        options.actionId,
        timestamp
      )
    );
    mutation.artifactPaths[declaration.artifactId] = version.path;
    mutation.selectedVersionIds[declaration.artifactId] = version.id;
  }
  return mutation;
}
function currentWorkflowArtifactVersions(runtime) {
  const current = {};
  for (const selection2 of runtime?.artifactSelections ?? []) {
    const version = runtime?.artifactVersions?.find(
      (candidate) => candidate.id === selection2.versionId
    );
    if (!version) continue;
    if (version.lifetime === "attempt" && version.scopeId !== runtime?.currentAttempt?.id || version.lifetime === "cycle" && version.scopeId !== runtime?.currentCycle?.id) {
      continue;
    }
    current[selection2.artifactId] = selection2.versionId;
  }
  return current;
}
function validateWorkflowArtifactState(protocol, runId, nodeToStep, runtime) {
  const versions = runtime.artifactVersions ?? [];
  const selections = runtime.artifactSelections ?? [];
  if (!versioningEnabled(protocol)) {
    if (versions.length > 0 || selections.length > 0) {
      throw new Error(
        "WorkflowRuntime artifact state requires versioned-artifacts capability"
      );
    }
    return;
  }
  const declared = declarations(protocol);
  const versionsById = new Map(
    versions.map((version) => [version.id, version])
  );
  for (const version of versions) {
    const declaration = declarationFor(version.artifactId, declared);
    if (version.schemaId !== declaration.schemaId || version.lifetime !== artifactLifetime(declaration) || !artifactPathMatches(version.path, declaration.artifact.paths) || version.producer.runId !== runId || version.producer.revision >= runtime.revision) {
      throw new Error(
        `WorkflowRuntime artifact version identity is invalid: ${version.id}`
      );
    }
    const stepId2 = nodeToStep[version.producer.nodeId];
    const visit = runtime.visits.find(
      (candidate) => candidate.attemptId === version.producer.attemptId
    );
    const outcome = visit?.outcomes.find(
      (candidate) => candidate.actionId === version.producer.actionId
    );
    if (!stepId2 || !visit || visit.stepId !== stepId2 || visit.cycleId !== version.producer.cycleId || !outcome || outcome.status !== "succeeded" || outcome.artifactVersions?.[version.artifactId] !== version.id) {
      throw new Error(
        `WorkflowRuntime artifact producer is invalid: ${version.id}`
      );
    }
    if (version.id !== artifactVersionId(
      version.artifactId,
      version.contentHash,
      version.path,
      version.producer,
      version.scopeId
    )) {
      throw new Error(
        `WorkflowRuntime artifact version identity is invalid: ${version.id}`
      );
    }
    if (!selections.some(
      (item) => item.artifactId === version.artifactId && item.versionId === version.id && item.attemptId === version.producer.attemptId && item.actionId === version.producer.actionId
    )) {
      throw new Error(
        `WorkflowRuntime artifact version has no accepted selection: ${version.id}`
      );
    }
  }
  for (const item of selections) {
    const version = versionsById.get(item.versionId);
    const stepId2 = nodeToStep[item.nodeId];
    const visit = runtime.visits.find(
      (candidate) => candidate.attemptId === item.attemptId
    );
    const outcome = visit?.outcomes.find(
      (candidate) => candidate.actionId === item.actionId
    );
    if (!version || version.artifactId !== item.artifactId || item.runId !== runId || item.revision >= runtime.revision || !stepId2 || !visit || visit.stepId !== stepId2 || visit.cycleId !== item.cycleId || !outcome || outcome.status !== "succeeded" || outcome.artifactVersions?.[item.artifactId] !== item.versionId || version.lifetime === "attempt" && version.scopeId !== item.attemptId || version.lifetime === "cycle" && version.scopeId !== item.cycleId || version.lifetime === "run" && version.scopeId !== runId) {
      throw new Error(
        `WorkflowRuntime artifact selection is invalid: ${item.versionId}`
      );
    }
  }
  for (const visit of runtime.visits) {
    for (const outcome of visit.outcomes) {
      for (const [artifactId, versionId] of Object.entries(
        outcome.artifactVersions ?? {}
      )) {
        if (!selections.some(
          (item) => item.artifactId === artifactId && item.versionId === versionId && item.attemptId === visit.attemptId && item.actionId === outcome.actionId
        )) {
          throw new Error(
            `WorkflowRuntime outcome has an unknown artifact selection: ${versionId}`
          );
        }
      }
    }
  }
}

// src/workflow-runtime/completion.ts
var ARTIFACT_MAX_BYTES2 = 2 * 1024 * 1024;
function unique(values) {
  return [...new Set(values)];
}
function createCompletionPlan(node) {
  return {
    nodeId: node.id,
    outputSchemas: [...node.outputSchemas],
    requiredSkillCalls: unique(
      node.requiredSkillCalls.map(
        (binding) => `required-skill:${node.id}.${binding.skill}`
      )
    ),
    enforcedAugmentations: unique(
      node.augmentations.filter((binding) => binding.enforcement !== "advisory").map((binding) => `augmentation:${node.id}.${binding.skill}`)
    ),
    guardrails: unique(
      node.guardrails.map(
        (guardrail) => `guardrail:${node.id}.${guardrail.id}`
      )
    )
  };
}
function isRecord2(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}
function includesEvidence(value, keys) {
  if (Array.isArray(value)) {
    return value.some(
      (item) => typeof item === "string" && keys.includes(item)
    );
  }
  if (!isRecord2(value)) return false;
  return keys.some((key) => hasOwn(value, key));
}
function hasEvidence(evidence, keys, containers = []) {
  if (keys.some((key) => hasOwn(evidence, key))) return true;
  for (const container of containers) {
    if (includesEvidence(evidence[container], keys)) return true;
  }
  return includesEvidence(evidence.completedChecks, keys);
}
function schemaFor(protocol, schemaId) {
  const schema = protocol.outputSchemas.find((item) => item.id === schemaId);
  if (!schema) {
    throw new Error(`WorkflowRuntime Output Schema is missing: ${schemaId}`);
  }
  return schema;
}
async function artifactExists(runRoot, schema, artifact) {
  let found = false;
  for (const artifactPath of artifact.paths) {
    const label = `Output Schema artifact ${schema.id}.${artifact.id}`;
    const matches = await matchingWorkflowArtifactPaths(
      runRoot,
      artifactPath,
      workflowArtifactExpectedKind(artifact),
      label
    );
    if (matches.length === 0) continue;
    found = true;
    if (artifact.kind !== "directory") {
      for (const match of matches) {
        try {
          await readProtectedProjectFile(runRoot, match, ARTIFACT_MAX_BYTES2, {
            label
          });
        } catch (error) {
          if (error instanceof RaceSafeReadError) {
            throw new RaceSafeReadError(
              error.reason,
              `${label}: ${error.message}`,
              { cause: error }
            );
          }
          throw error;
        }
      }
    }
  }
  return found;
}
function missingSchemaEvidence(schema, evidence) {
  return schema.evidence.filter((field) => field.required).filter(
    (field) => !hasEvidence(
      evidence,
      [field.id, `${schema.id}.${field.id}`],
      ["schemaEvidence"]
    )
  ).map((field) => `${schema.id}.${field.id}`);
}
function missingGuardrailEvidence(node, plan, evidence) {
  const guardrailByKey = new Map(
    node.guardrails.map((guardrail) => [
      `guardrail:${node.id}.${guardrail.id}`,
      guardrail
    ])
  );
  return plan.guardrails.filter(
    (key) => !hasEvidence(
      evidence,
      [key, guardrailByKey.get(key)?.id ?? key],
      ["guardrails"]
    )
  ).map((key) => key);
}
async function validateSuccessfulSubmission(runRoot, protocol, node, plan, submission) {
  if (submission.kind === "decision") return [];
  const evidence = submission.evidence ?? {};
  const blockers = [];
  for (const schemaId of plan.outputSchemas) {
    const schema = schemaFor(protocol, schemaId);
    for (const artifact of schema.artifacts) {
      if (!artifact.required) continue;
      let exists = false;
      try {
        exists = await artifactExists(runRoot, schema, artifact);
      } catch (error) {
        if (error instanceof RaceSafeReadError) {
          blockers.push(
            `Invalid Output Schema artifact ${schema.id}.${artifact.id}: ${error.message}`
          );
          continue;
        }
        throw error;
      }
      if (!exists) {
        blockers.push(
          `Missing Output Schema artifacts: ${schema.id}.${artifact.id}`
        );
      }
    }
    for (const field of missingSchemaEvidence(schema, evidence)) {
      blockers.push(`Missing Output Schema evidence: ${field}`);
    }
  }
  for (const key of plan.requiredSkillCalls) {
    if (!hasEvidence(evidence, [key], ["requiredSkillCalls"])) {
      blockers.push(`Missing required Skill evidence: ${key}`);
    }
  }
  for (const key of plan.enforcedAugmentations) {
    if (!hasEvidence(evidence, [key], ["augmentations"])) {
      blockers.push(`Missing augmentation evidence: ${key}`);
    }
  }
  for (const key of missingGuardrailEvidence(node, plan, evidence)) {
    blockers.push(`Missing guardrail evidence: ${key}`);
  }
  return blockers;
}

// src/workflow-runtime/routing.ts
var WorkflowRouteResolutionError = class extends Error {
  blockers;
  constructor(message) {
    super(message);
    this.name = "WorkflowRouteResolutionError";
    this.blockers = [message];
  }
};
var WorkflowCycleBudgetError = class extends WorkflowRouteResolutionError {
  constructor(key, maxInstances) {
    super(
      `Cycle budget exhausted for ${key}: maximum ${maxInstances} instances reached`
    );
    this.name = "WorkflowCycleBudgetError";
  }
};
function fieldId(field) {
  if (!field || typeof field !== "object") return void 0;
  return field.id ?? field.name;
}
function fieldValues(field) {
  if (!field || typeof field !== "object") return void 0;
  return field.values ?? field.allowedValues;
}
function decisionChoiceTarget(choice) {
  return choice.to !== void 0 ? choice.to : choice.target !== void 0 ? choice.target : choice.transition;
}
function decisionNode(protocol, nodeId) {
  return protocol.nodes.find(
    (node) => node.id === nodeId && node.kind === "decision"
  );
}
function routingFields(protocol) {
  const fields = protocol.routing?.fields ?? protocol.routing?.routingFields;
  const declared = !fields ? [] : Array.isArray(fields) ? fields.map((field) => ({
    id: fieldId(field) ?? "",
    values: [...fieldValues(field) ?? []]
  })) : Object.entries(fields).map(([id, values]) => {
    if (!Array.isArray(values)) {
      throw new Error(`Workflow routing field values are invalid: ${id}`);
    }
    return { id, values: [...values] };
  });
  const decisions = protocol.nodes.filter(
    (node) => !node.disabled && node.kind === "decision" && node.decision
  ).map((node) => ({
    id: node.decision.id,
    values: node.decision.choices.map((choice) => choice.id)
  }));
  return [...declared, ...decisions];
}
function predicate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.field !== "string" || typeof value.equals !== "string") {
    throw new Error(
      "Workflow route conditions must contain a field and exact scalar equals value"
    );
  }
  return {
    field: value.field,
    equals: value.equals
  };
}
function routingPredicates(condition, fields) {
  if (typeof condition === "string") {
    if (fields.length === 1) {
      return [{ field: fields[0].id, equals: condition }];
    }
    const separator = condition.indexOf("=");
    if (separator > 0 && separator < condition.length - 1) {
      return [
        {
          field: condition.slice(0, separator),
          equals: condition.slice(separator + 1)
        }
      ];
    }
    if (fields.length !== 1) {
      throw new Error(
        "Workflow route text conditions require exactly one declared routing field"
      );
    }
  }
  if (Array.isArray(condition)) {
    if (condition.length === 0) {
      throw new Error("Workflow route conjunction must not be empty");
    }
    return condition.map(predicate);
  }
  if (!condition || typeof condition !== "object") {
    throw new Error("Workflow route condition must be an object or string");
  }
  if ("all" in condition) {
    if (!Array.isArray(condition.all) || condition.all.length === 0) {
      throw new Error("Workflow route conjunction must not be empty");
    }
    return condition.all.map(predicate);
  }
  return [predicate(condition)];
}
function fieldMap(fields) {
  const result = /* @__PURE__ */ new Map();
  for (const field of fields) {
    if (!field.id || !Array.isArray(field.values) || field.values.length === 0 || field.values.some((value) => typeof value !== "string")) {
      throw new Error("Workflow routing fields require an id and values");
    }
    if (result.has(field.id)) {
      throw new Error(`Workflow routing field is duplicated: ${field.id}`);
    }
    const values = new Set(field.values);
    if (values.size !== field.values.length || [...values].some((value) => !value)) {
      throw new Error(`Workflow routing field has invalid values: ${field.id}`);
    }
    result.set(field.id, values);
  }
  return result;
}
function validatePredicates(transition, fields) {
  if (transition.when === void 0) return void 0;
  const predicates = routingPredicates(
    transition.when,
    [...fields].map(([id, values]) => ({
      id,
      values: [...values]
    }))
  );
  const seen = /* @__PURE__ */ new Map();
  for (const item of predicates) {
    const values = fields.get(item.field);
    if (!values) {
      throw new Error(
        `Workflow route condition references unknown routing field: ${item.field}`
      );
    }
    if (!values.has(item.equals)) {
      throw new Error(
        `Workflow route condition references unknown value for ${item.field}: ${item.equals}`
      );
    }
    const previous = seen.get(item.field);
    if (previous !== void 0 && previous !== item.equals) {
      throw new Error(
        `Workflow route conjunction has conflicting values for field: ${item.field}`
      );
    }
    seen.set(item.field, item.equals);
  }
  return predicates;
}
function predicatesOverlap(left, right) {
  const rightValues = new Map(right.map((item) => [item.field, item.equals]));
  return left.every(
    (item) => !rightValues.has(item.field) || rightValues.get(item.field) === item.equals
  );
}
function activeNodes(protocol) {
  return new Set(
    protocol.nodes.filter((node) => !node.disabled).map((node) => node.id)
  );
}
function transitionsFrom(protocol, nodeId) {
  const declared = protocol.edges.filter(
    (transition) => transition.from === nodeId && transition.condition === "success"
  );
  const node = decisionNode(protocol, nodeId);
  if (!node?.decision) return declared;
  const choices = node.decision.choices;
  if (declared.length > 0 && declared.length !== choices.length) {
    throw new Error(
      `Workflow Protocol decision Node ${nodeId} must have one transition per choice`
    );
  }
  return choices.map((choice) => {
    const target = decisionChoiceTarget(choice);
    if (target === void 0 || target === "") {
      throw new Error(
        `Workflow Protocol decision choice ${choice.id} has no transition target`
      );
    }
    const matches = declared.filter((transition) => transition.to === target);
    if (declared.length > 0 && matches.length !== 1) {
      throw new Error(
        `Workflow Protocol decision choice ${choice.id} does not map to exactly one transition`
      );
    }
    if (matches[0]?.when !== void 0) {
      throw new Error(
        `Workflow Protocol decision Node ${nodeId} must not use hidden conditional exits`
      );
    }
    return {
      ...matches[0] ?? {
        from: nodeId,
        to: target,
        condition: "success"
      },
      when: { field: node.decision.id, equals: choice.id }
    };
  });
}
function transitionKey(from, to) {
  return `${from}\0${to}`;
}
function activeSuccessGraph(protocol) {
  const active = activeNodes(protocol);
  const activeIds = new Set(active);
  return new Map(
    [...active].map((nodeId) => [
      nodeId,
      transitionsFrom(protocol, nodeId).filter(
        (transition) => transition.to !== null && activeIds.has(transition.to)
      )
    ])
  );
}
function stronglyConnectedComponents(graph) {
  let nextIndex = 0;
  const indices = /* @__PURE__ */ new Map();
  const lowLinks = /* @__PURE__ */ new Map();
  const stack = [];
  const onStack = /* @__PURE__ */ new Set();
  const components = [];
  const connect = (nodeId) => {
    indices.set(nodeId, nextIndex);
    lowLinks.set(nodeId, nextIndex);
    nextIndex += 1;
    stack.push(nodeId);
    onStack.add(nodeId);
    for (const transition of graph.get(nodeId) ?? []) {
      const target = transition.to;
      if (!indices.has(target)) {
        connect(target);
        lowLinks.set(
          nodeId,
          Math.min(lowLinks.get(nodeId), lowLinks.get(target))
        );
      } else if (onStack.has(target)) {
        lowLinks.set(
          nodeId,
          Math.min(lowLinks.get(nodeId), indices.get(target))
        );
      }
    }
    if (lowLinks.get(nodeId) !== indices.get(nodeId)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== nodeId);
    components.push(component);
  };
  for (const nodeId of graph.keys()) {
    if (!indices.has(nodeId)) connect(nodeId);
  }
  return components;
}
function cyclicComponents(graph) {
  const components = stronglyConnectedComponents(graph);
  const componentByNode = /* @__PURE__ */ new Map();
  for (const component of components) {
    const members = new Set(component);
    const cyclic = component.length > 1 || (graph.get(component[0]) ?? []).some(
      (transition) => transition.to === component[0]
    );
    if (!cyclic) continue;
    for (const nodeId of members) componentByNode.set(nodeId, component);
  }
  return componentByNode;
}
function componentKey(component) {
  return [...component].sort().join("\0");
}
function hasCycleWithoutRepeats(graph, component, repeatTransitions) {
  const reduced = new Map(
    [...component].map((nodeId) => [
      nodeId,
      (graph.get(nodeId) ?? []).filter(
        (transition) => !repeatTransitions.has(transitionKey(nodeId, transition.to))
      )
    ])
  );
  return cyclicComponents(reduced).size > 0;
}
function cycleDefinitionError(definition, message) {
  return new Error(`Workflow Protocol Cycle ${definition.key}: ${message}`);
}
function cycleAnalysis(protocol) {
  const graph = activeSuccessGraph(protocol);
  const activeIds = new Set(graph.keys());
  const cyclicByNode = cyclicComponents(graph);
  const componentDefinitions = /* @__PURE__ */ new Map();
  const plans = [];
  const planByKey = /* @__PURE__ */ new Map();
  for (const definition of protocol.cycles ?? []) {
    if (planByKey.has(definition.key)) {
      throw cycleDefinitionError(definition, "cycle key must be unique");
    }
    if (typeof definition.key !== "string" || definition.key.length === 0) {
      throw new Error("Workflow Protocol Cycle key must be a non-empty string");
    }
    if (!activeIds.has(definition.entry)) {
      throw cycleDefinitionError(
        definition,
        `entry Node is unknown or disabled: ${definition.entry}`
      );
    }
    if (!Number.isSafeInteger(definition.maxInstances) || definition.maxInstances < 1) {
      throw cycleDefinitionError(
        definition,
        "maxInstances must be a finite positive integer"
      );
    }
    if (!Array.isArray(definition.repeatTransitions) || definition.repeatTransitions.length === 0) {
      throw cycleDefinitionError(
        definition,
        "repeatTransitions must be a non-empty array"
      );
    }
    const component = cyclicByNode.get(definition.entry);
    if (!component) {
      throw cycleDefinitionError(
        definition,
        "entry Node does not belong to a graph cycle"
      );
    }
    const componentId = componentKey(component);
    const declarations2 = componentDefinitions.get(componentId) ?? [];
    declarations2.push(definition);
    componentDefinitions.set(componentId, declarations2);
    const members = new Set(component);
    const repeats = /* @__PURE__ */ new Set();
    for (const repeat of definition.repeatTransitions) {
      if (!activeIds.has(repeat.from) || !activeIds.has(repeat.to) || !members.has(repeat.from) || !members.has(repeat.to)) {
        throw cycleDefinitionError(
          definition,
          `repeat transition is outside its cycle: ${repeat.from} -> ${repeat.to}`
        );
      }
      const matches = (graph.get(repeat.from) ?? []).filter(
        (transition) => transition.to === repeat.to
      );
      if (matches.length === 0) {
        throw cycleDefinitionError(
          definition,
          `repeat transition is not a declared success edge: ${repeat.from} -> ${repeat.to}`
        );
      }
      if (matches.length > 1) {
        throw cycleDefinitionError(
          definition,
          `repeat transition is ambiguous: ${repeat.from} -> ${repeat.to}`
        );
      }
      const key = transitionKey(repeat.from, repeat.to);
      if (repeats.has(key)) {
        throw cycleDefinitionError(
          definition,
          `repeat transition is duplicated: ${repeat.from} -> ${repeat.to}`
        );
      }
      repeats.add(key);
    }
    if (hasCycleWithoutRepeats(graph, members, repeats)) {
      throw cycleDefinitionError(
        definition,
        "contains an unbounded path without a declared repeat transition"
      );
    }
    const plan = {
      definition,
      nodes: members,
      repeatTransitions: repeats
    };
    plans.push(plan);
    planByKey.set(definition.key, plan);
  }
  for (const [nodeId, component] of cyclicByNode) {
    const definitions = componentDefinitions.get(componentKey(component)) ?? [];
    if (definitions.length === 0) {
      throw new Error(
        "Workflow Protocol success route contains an undeclared cycle"
      );
    }
    if (definitions.length > 1) {
      throw new Error(
        `Workflow Protocol has overlapping ambiguous Cycle ownership: ${componentKey(component)}`
      );
    }
    const entry = definitions[0].entry;
    for (const incoming of graph) {
      if (component.includes(incoming[0])) continue;
      for (const transition of incoming[1]) {
        if (transition.to === nodeId && nodeId !== entry) {
          throw cycleDefinitionError(
            definitions[0],
            `cycle component must be entered through ${entry}`
          );
        }
      }
    }
  }
  const workflowEntry = [...graph.keys()][0];
  for (const plan of plans) {
    if (workflowEntry && plan.nodes.has(workflowEntry) && plan.definition.entry !== workflowEntry) {
      throw cycleDefinitionError(
        plan.definition,
        `workflow entry must be ${plan.definition.entry}`
      );
    }
  }
  const ownerByNode = /* @__PURE__ */ new Map();
  for (const plan of plans) {
    for (const nodeId of plan.nodes) {
      if (ownerByNode.has(nodeId)) {
        throw new Error(
          `Workflow Protocol has overlapping ambiguous Cycle ownership: ${nodeId}`
        );
      }
      ownerByNode.set(nodeId, plan);
    }
  }
  return { plans, ownerByNode, planByKey };
}
function validateWorkflowCycleState(protocol, runId, runtime) {
  const analysis = cycleAnalysis(protocol);
  const seenIds = /* @__PURE__ */ new Set();
  const counts = /* @__PURE__ */ new Map();
  for (const cycle of runtime.cycles) {
    const plan = analysis.planByKey.get(cycle.key);
    if (!plan) {
      throw new Error(
        `WorkflowRuntime persisted Cycle is not declared: ${cycle.key}`
      );
    }
    if (seenIds.has(cycle.id)) {
      throw new Error(
        `WorkflowRuntime persisted Cycle identity is duplicated: ${cycle.id}`
      );
    }
    seenIds.add(cycle.id);
    const expectedOrdinal = (counts.get(cycle.key) ?? 0) + 1;
    if (cycle.instanceOrdinal !== expectedOrdinal) {
      throw new Error(
        `WorkflowRuntime persisted Cycle ordinal is invalid for ${cycle.key}`
      );
    }
    if (cycle.instanceOrdinal > plan.definition.maxInstances) {
      throw new Error(
        `WorkflowRuntime persisted Cycle exceeds its budget: ${cycle.key}`
      );
    }
    if (cycle.id !== cycleIdentity(runId, cycle.key, cycle.instanceOrdinal)) {
      throw new Error(
        `WorkflowRuntime persisted Cycle identity is invalid: ${cycle.key}`
      );
    }
    counts.set(cycle.key, cycle.instanceOrdinal);
  }
  if (runtime.currentCycle && !seenIds.has(runtime.currentCycle.id)) {
    throw new Error(
      "WorkflowRuntime current Cycle is not present in the Cycle ledger"
    );
  }
  if (runtime.currentCycle && (runtime.currentCycle.id !== cycleIdentity(
    runId,
    runtime.currentCycle.key,
    runtime.currentCycle.instanceOrdinal
  ) || !analysis.planByKey.has(runtime.currentCycle.key))) {
    throw new Error("WorkflowRuntime current Cycle identity is invalid");
  }
}
function workflowCycleOwnsNode(protocol, key, nodeId) {
  return cycleAnalysis(protocol).planByKey.get(key)?.nodes.has(nodeId) ?? false;
}
function cycleIdentity(runId, key, instanceOrdinal) {
  return `cycle-${sha256(`${runId}:${key}:${instanceOrdinal}`).slice(0, 24)}`;
}
function allocateCycle(runId, plan, cycles) {
  const instanceOrdinal = cycles.filter((cycle) => cycle.key === plan.definition.key).length + 1;
  if (instanceOrdinal > plan.definition.maxInstances) {
    throw new WorkflowCycleBudgetError(
      plan.definition.key,
      plan.definition.maxInstances
    );
  }
  return {
    id: cycleIdentity(runId, plan.definition.key, instanceOrdinal),
    key: plan.definition.key,
    instanceOrdinal
  };
}
function copyCycleTransitionState(runtime) {
  return {
    currentCycle: runtime.currentCycle ? structuredClone(runtime.currentCycle) : null,
    cycles: structuredClone(runtime.cycles ?? [])
  };
}
function prepareWorkflowCycleEntry(protocol, runId, runtime, nodeId) {
  const analysis = cycleAnalysis(protocol);
  const next = copyCycleTransitionState(runtime);
  const owner = analysis.ownerByNode.get(nodeId);
  if (next.currentCycle) {
    const activePlan = analysis.planByKey.get(next.currentCycle.key);
    if (!activePlan) {
      throw new Error(
        `WorkflowRuntime current Cycle is not declared: ${next.currentCycle.key}`
      );
    }
    if (activePlan.nodes.has(nodeId)) return next;
    if (!owner) {
      next.currentCycle = null;
      return next;
    }
    if (nodeId !== owner.definition.entry) {
      throw cycleDefinitionError(
        owner.definition,
        `Node ${nodeId} cannot be entered except through ${owner.definition.entry}`
      );
    }
    const allocated2 = allocateCycle(runId, owner, next.cycles);
    next.cycles.push(allocated2);
    next.currentCycle = allocated2;
    return next;
  }
  if (!owner) return next;
  if (nodeId !== owner.definition.entry) {
    throw cycleDefinitionError(
      owner.definition,
      `Node ${nodeId} cannot be entered without its entry Node`
    );
  }
  const allocated = allocateCycle(runId, owner, next.cycles);
  next.cycles.push(allocated);
  next.currentCycle = allocated;
  return next;
}
function resolveWorkflowCycleTransition(protocol, runId, runtime, transition, nextNode) {
  const analysis = cycleAnalysis(protocol);
  const next = copyCycleTransitionState(runtime);
  if (nextNode === null) {
    next.currentCycle = null;
    return next;
  }
  const owner = analysis.ownerByNode.get(nextNode);
  if (next.currentCycle) {
    const activePlan = analysis.planByKey.get(next.currentCycle.key);
    if (!activePlan) {
      throw new Error(
        `WorkflowRuntime current Cycle is not declared: ${next.currentCycle.key}`
      );
    }
    if (activePlan.repeatTransitions.has(transitionKey(transition.from, nextNode))) {
      const allocated3 = allocateCycle(runId, activePlan, next.cycles);
      next.cycles.push(allocated3);
      next.currentCycle = allocated3;
      return next;
    }
    if (activePlan.nodes.has(nextNode)) return next;
    if (!owner) {
      next.currentCycle = null;
      return next;
    }
    if (nextNode !== owner.definition.entry) {
      throw cycleDefinitionError(
        owner.definition,
        `Node ${nextNode} cannot be entered except through ${owner.definition.entry}`
      );
    }
    const allocated2 = allocateCycle(runId, owner, next.cycles);
    next.cycles.push(allocated2);
    next.currentCycle = allocated2;
    return next;
  }
  if (!owner) return next;
  if (nextNode !== owner.definition.entry) {
    throw cycleDefinitionError(
      owner.definition,
      `Node ${nextNode} cannot be entered without its entry Node`
    );
  }
  const allocated = allocateCycle(runId, owner, next.cycles);
  next.cycles.push(allocated);
  next.currentCycle = allocated;
  return next;
}
function maxWorkflowIterations(protocol) {
  if (!protocol.cycles?.length) return Math.max(protocol.nodes.length, 1);
  const analysis = cycleAnalysis(protocol);
  const cycleBudget = analysis.plans.reduce(
    (total, plan) => total + plan.definition.maxInstances,
    0
  );
  const bound = Math.max(protocol.nodes.length, 1) * (cycleBudget + 1);
  return Number.isSafeInteger(bound) ? bound : Number.MAX_SAFE_INTEGER;
}
function isRevisionedWorkflowProtocol(protocol) {
  return Boolean(
    protocol.capabilities?.version === 3 || protocol.routing?.fields !== void 0 || protocol.routing?.routingFields !== void 0 || protocol.nodes.some((node) => node.kind === "decision") || protocol.cycles !== void 0 || protocol.capabilities?.features.includes("versioned-artifacts")
  );
}
function validateRevisionedWorkflow(protocol) {
  const active = activeNodes(protocol);
  cycleAnalysis(protocol);
  if (active.size === 0) return;
  const nodeIds = new Set(protocol.nodes.map((node) => node.id));
  const fields = fieldMap(routingFields(protocol));
  const predicatesByTransition = /* @__PURE__ */ new Map();
  for (const transition of protocol.edges) {
    if (!nodeIds.has(transition.from)) {
      throw new Error(
        `Workflow Protocol transition references unknown Node: ${transition.from}`
      );
    }
    if (transition.to !== null && !nodeIds.has(transition.to)) {
      throw new Error(
        `Workflow Protocol transition references unknown Node: ${transition.to}`
      );
    }
    if (transition.to !== null && !active.has(transition.to)) {
      throw new Error(
        `Workflow Protocol transition targets disabled Node: ${transition.to}`
      );
    }
    if ((transition.condition === "failure" || transition.condition === "pause") && transition.to !== transition.from) {
      throw new Error(
        `Workflow Protocol ${transition.condition} transition from Node ${transition.from} must self-loop`
      );
    }
    if (transition.condition !== "success" || transition.when === void 0) {
      continue;
    }
    const predicates = validatePredicates(transition, fields);
    if (predicates) predicatesByTransition.set(transition, predicates);
  }
  for (const node of protocol.nodes.filter(
    (candidate) => candidate.kind === "decision"
  )) {
    if (!node.decision) {
      throw new Error(
        `Workflow Protocol decision Node ${node.id} is missing a definition`
      );
    }
    for (const choice of node.decision.choices) {
      const target = decisionChoiceTarget(choice);
      if (target === void 0 || target !== null && !nodeIds.has(target)) {
        throw new Error(
          `Workflow Protocol decision choice ${choice.id} references unknown Node: ${target ?? "(missing)"}`
        );
      }
      if (target !== null && !active.has(target)) {
        throw new Error(
          `Workflow Protocol decision choice ${choice.id} targets disabled Node: ${target}`
        );
      }
    }
  }
  for (const nodeId of active) {
    const transitions = transitionsFrom(protocol, nodeId);
    if (decisionNode(protocol, nodeId)?.decision) continue;
    const defaults = transitions.filter(
      (transition) => transition.when === void 0
    );
    if (defaults.length > 1) {
      throw new Error(
        `Workflow Protocol has multiple default transitions from Node ${nodeId}`
      );
    }
    const conditional = transitions.filter(
      (transition) => transition.when !== void 0
    );
    for (let leftIndex = 0; leftIndex < conditional.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < conditional.length; rightIndex += 1) {
        const left = predicatesByTransition.get(conditional[leftIndex]);
        const right = predicatesByTransition.get(conditional[rightIndex]);
        if (left && right && predicatesOverlap(left, right)) {
          throw new Error(
            `Workflow Protocol has ambiguous conditional transitions from Node ${nodeId}`
          );
        }
      }
    }
  }
  const entry = protocol.nodes.find((node) => !node.disabled)?.id;
  if (!entry) return;
  const visited = /* @__PURE__ */ new Set();
  const visit = (nodeId) => {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    for (const transition of transitionsFrom(protocol, nodeId)) {
      if (transition.to !== null) visit(transition.to);
    }
  };
  visit(entry);
  for (const node of protocol.nodes) {
    if (!node.disabled && !node.optional && !visited.has(node.id)) {
      throw new Error(
        `Workflow Protocol required Node is unreachable: ${node.id}`
      );
    }
  }
  for (const nodeId of visited) {
    if (transitionsFrom(protocol, nodeId).length === 0) {
      throw new Error(
        `Workflow Protocol Node ${nodeId} has no success transition`
      );
    }
  }
}
function validateRoutingValues(protocol, routing) {
  const fields = fieldMap(routingFields(protocol));
  const values = /* @__PURE__ */ new Map();
  for (const [field, value] of Object.entries(routing ?? {})) {
    const allowed = fields.get(field);
    if (!allowed) {
      throw new WorkflowRouteResolutionError(
        `Route blocker: unknown routing field: ${field}`
      );
    }
    if (!allowed.has(value)) {
      throw new WorkflowRouteResolutionError(
        `Route blocker: invalid routing value for ${field}: ${value}`
      );
    }
    values.set(field, value);
  }
  return values;
}
function resolveWorkflowTransition(protocol, nodeId, outcome, runtime, runId) {
  const transitions = transitionsFrom(protocol, nodeId);
  const defaults = transitions.filter(
    (transition) => transition.when === void 0
  );
  const values = validateRoutingValues(protocol, outcome.routing);
  const fields = routingFields(protocol);
  const matches = transitions.filter((transition) => {
    if (transition.when === void 0) return false;
    const predicates = routingPredicates(transition.when, fields);
    return predicates.every((item) => values.get(item.field) === item.equals);
  });
  if (matches.length > 1) {
    throw new WorkflowRouteResolutionError(
      `Route blocker: ambiguous success transitions from Node ${nodeId}`
    );
  }
  const selected = matches[0] ?? defaults[0];
  if (!selected) {
    throw new WorkflowRouteResolutionError(
      `Route blocker: no matching success transition from Node ${nodeId}`
    );
  }
  return {
    next: selected.to,
    transition: selected,
    ...runtime && runId ? {
      workflowRuntime: resolveWorkflowCycleTransition(
        protocol,
        runId,
        runtime,
        selected,
        selected.to
      )
    } : {}
  };
}
function resolverHash(protocol) {
  return sha256(
    JSON.stringify(
      stableValue({
        capabilities: protocol.capabilities,
        routing: protocol.routing,
        edges: protocol.edges,
        cycles: protocol.cycles,
        decisions: protocol.nodes.filter((node) => node.kind === "decision").map((node) => ({ id: node.id, decision: node.decision }))
      })
    )
  );
}

// src/workflow/contract.ts
function isRecord3(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function decisionChoiceTarget2(choice) {
  return choice.to !== void 0 ? choice.to : choice.target !== void 0 ? choice.target : choice.transition;
}
function decisionScalarType(value) {
  return value === "string" || value === "number" || value === "boolean";
}
function scalarMatchesType(value, type) {
  if (type === "string") return typeof value === "string";
  if (type === "number")
    return typeof value === "number" && Number.isFinite(value);
  return typeof value === "boolean";
}
function decisionInputErrors(schema, label) {
  const errors = [];
  if (!isRecord3(schema)) return [`${label} must be an object`];
  const schemaKeys = /* @__PURE__ */ new Set(["type", "fields"]);
  const unknownSchemaKey = Object.keys(schema).find(
    (key) => !schemaKeys.has(key)
  );
  if (unknownSchemaKey) {
    errors.push(`${label} has unsupported field: ${unknownSchemaKey}`);
  }
  if (schema.type !== "object") {
    errors.push(`${label}.type must be object`);
  }
  if (!Array.isArray(schema.fields)) {
    errors.push(`${label}.fields must be an array`);
    return errors;
  }
  const ids = /* @__PURE__ */ new Set();
  for (const [index, field] of schema.fields.entries()) {
    const fieldLabel = `${label}.fields[${index}]`;
    if (!isRecord3(field)) {
      errors.push(`${fieldLabel} must be an object`);
      continue;
    }
    const fieldKeys = /* @__PURE__ */ new Set(["id", "type", "required", "values", "enum"]);
    const unknownFieldKey = Object.keys(field).find(
      (key) => !fieldKeys.has(key)
    );
    if (unknownFieldKey) {
      errors.push(`${fieldLabel} has unsupported field: ${unknownFieldKey}`);
    }
    if (typeof field.id !== "string" || field.id.length === 0) {
      errors.push(`${fieldLabel}.id must be a non-empty string`);
    } else if (ids.has(field.id)) {
      errors.push(`${label} has duplicate input field: ${field.id}`);
    } else {
      ids.add(field.id);
    }
    if (!decisionScalarType(field.type)) {
      errors.push(`${fieldLabel}.type must be string, number, or boolean`);
    }
    if (field.required !== void 0 && typeof field.required !== "boolean") {
      errors.push(`${fieldLabel}.required must be a boolean`);
    }
    const values = field.values ?? field.enum;
    if (field.values !== void 0 && field.enum !== void 0) {
      errors.push(`${fieldLabel} must use either values or enum, not both`);
    }
    if (values !== void 0) {
      if (!Array.isArray(values) || values.length === 0) {
        errors.push(`${fieldLabel}.values must be a non-empty array`);
      } else {
        const seenValues = /* @__PURE__ */ new Set();
        for (const value of values) {
          if (!scalarMatchesType(value, String(field.type))) {
            errors.push(
              `${fieldLabel}.values contains a value with the wrong type`
            );
            continue;
          }
          const key = JSON.stringify(value);
          if (seenValues.has(key)) {
            errors.push(`${fieldLabel}.values must not contain duplicates`);
          }
          seenValues.add(key);
        }
      }
    }
  }
  return errors;
}
function decisionScopeErrors(scope, label) {
  const errors = [];
  if (!isRecord3(scope)) return [`${label} must be an object`];
  const scopeKeys = /* @__PURE__ */ new Set(["artifacts", "evidence"]);
  const unknown = Object.keys(scope).find((key) => !scopeKeys.has(key));
  if (unknown) errors.push(`${label} has unsupported field: ${unknown}`);
  let entryCount = 0;
  for (const kind of ["artifacts", "evidence"]) {
    const entries = scope[kind];
    if (entries === void 0) continue;
    if (!Array.isArray(entries)) {
      errors.push(`${label}.${kind} must be an array`);
      continue;
    }
    const ids = /* @__PURE__ */ new Set();
    for (const [index, entry] of entries.entries()) {
      const entryLabel = `${label}.${kind}[${index}]`;
      if (!isRecord3(entry)) {
        errors.push(`${entryLabel} must be an object`);
        continue;
      }
      const unknownEntry = Object.keys(entry).find(
        (key) => key !== "id" && key !== "required"
      );
      if (unknownEntry) {
        errors.push(`${entryLabel} has unsupported field: ${unknownEntry}`);
      }
      if (typeof entry.id !== "string" || entry.id.length === 0) {
        errors.push(`${entryLabel}.id must be a non-empty string`);
      } else if (ids.has(entry.id)) {
        errors.push(`${label}.${kind} has duplicate entry: ${entry.id}`);
      } else {
        ids.add(entry.id);
      }
      if (entry.required !== void 0 && typeof entry.required !== "boolean") {
        errors.push(`${entryLabel}.required must be a boolean`);
      }
      entryCount += 1;
    }
  }
  if (entryCount > 64) {
    errors.push(`${label} must not contain more than 64 entries`);
  }
  return errors;
}
function decisionErrors(decision, nodeId) {
  const label = `Decision Node ${nodeId}`;
  const errors = [];
  if (!isRecord3(decision)) return [`${label} requires a decision definition`];
  const keys = /* @__PURE__ */ new Set([
    "id",
    "question",
    "choices",
    "inputs",
    "rationale",
    "reviewer",
    "scope"
  ]);
  const unknown = Object.keys(decision).find((key) => !keys.has(key));
  if (unknown) errors.push(`${label} has unsupported field: ${unknown}`);
  if (typeof decision.id !== "string" || decision.id.length === 0) {
    errors.push(`${label} id must be a non-empty string`);
  }
  if (typeof decision.question !== "string" || decision.question.length === 0) {
    errors.push(`${label} question must be a non-empty string`);
  }
  if (!Array.isArray(decision.choices) || decision.choices.length === 0) {
    errors.push(`${label} choices must be a non-empty array`);
  } else {
    const choiceIds = /* @__PURE__ */ new Set();
    const targets = /* @__PURE__ */ new Set();
    for (const [index, choice] of decision.choices.entries()) {
      const choiceLabel = `${label}.choices[${index}]`;
      if (!isRecord3(choice)) {
        errors.push(`${choiceLabel} must be an object`);
        continue;
      }
      const choiceKeys = /* @__PURE__ */ new Set([
        "id",
        "label",
        "to",
        "target",
        "transition",
        "inputs",
        "routing"
      ]);
      const unknownChoice = Object.keys(choice).find(
        (key) => !choiceKeys.has(key)
      );
      if (unknownChoice) {
        errors.push(`${choiceLabel} has unsupported field: ${unknownChoice}`);
      }
      if (typeof choice.id !== "string" || choice.id.length === 0) {
        errors.push(`${choiceLabel}.id must be a non-empty string`);
      } else if (choiceIds.has(choice.id)) {
        errors.push(`${label} has duplicate choice id: ${choice.id}`);
      } else {
        choiceIds.add(choice.id);
      }
      if (typeof choice.label !== "string" || choice.label.length === 0) {
        errors.push(`${choiceLabel}.label must be a non-empty string`);
      }
      const targetProperties = ["to", "target", "transition"].filter(
        (key) => Object.prototype.hasOwnProperty.call(choice, key)
      );
      if (targetProperties.length !== 1) {
        errors.push(
          `${choiceLabel} must declare exactly one transition target field`
        );
      }
      const target = decisionChoiceTarget2(
        choice
      );
      if (target === void 0 || target === "") {
        errors.push(`${choiceLabel} requires a transition target`);
      } else if (targets.has(target)) {
        errors.push(`${label} has duplicate choice mapping to: ${target}`);
      } else {
        targets.add(target);
      }
      if (choice.inputs !== void 0) {
        errors.push(
          ...decisionInputErrors(choice.inputs, `${choiceLabel}.inputs`)
        );
      }
      if (choice.routing !== void 0) {
        if (!isRecord3(choice.routing)) {
          errors.push(`${choiceLabel}.routing must be an object`);
        } else if (Object.entries(choice.routing).some(
          ([field, value]) => field.length === 0 || typeof value !== "string" || value.length === 0
        )) {
          errors.push(`${choiceLabel}.routing must contain non-empty strings`);
        }
      }
    }
  }
  if (decision.inputs !== void 0) {
    errors.push(...decisionInputErrors(decision.inputs, `${label}.inputs`));
  }
  if (decision.rationale !== void 0) {
    if (!isRecord3(decision.rationale)) {
      errors.push(`${label}.rationale must be an object`);
    } else if (Object.keys(decision.rationale).some((key) => key !== "required") || decision.rationale.required !== void 0 && typeof decision.rationale.required !== "boolean") {
      errors.push(`${label}.rationale.required must be a boolean`);
    }
  }
  if (decision.reviewer !== void 0) {
    if (!isRecord3(decision.reviewer)) {
      errors.push(`${label}.reviewer must be an object`);
    } else {
      const reviewerKeys = /* @__PURE__ */ new Set(["subjects", "authorities"]);
      const unknownReviewer = Object.keys(decision.reviewer).find(
        (key) => !reviewerKeys.has(key)
      );
      if (unknownReviewer) {
        errors.push(
          `${label}.reviewer has unsupported field: ${unknownReviewer}`
        );
      }
      for (const key of ["subjects", "authorities"]) {
        const values = decision.reviewer[key];
        if (values === void 0) continue;
        if (!Array.isArray(values) || values.length === 0 || values.some(
          (value) => typeof value !== "string" || value.length === 0
        )) {
          errors.push(
            `${label}.reviewer.${key} must be a non-empty string array`
          );
        } else if (new Set(values).size !== values.length) {
          errors.push(`${label}.reviewer.${key} must not contain duplicates`);
        }
      }
    }
  }
  if (decision.scope !== void 0) {
    errors.push(...decisionScopeErrors(decision.scope, `${label}.scope`));
  }
  return errors;
}
function validateDecisionDefinition(decision, nodeId) {
  const errors = decisionErrors(decision, nodeId);
  if (errors.length > 0) throw new Error(errors.join("\n"));
}

// src/workflow-runtime/decision-scope.ts
var WorkflowDecisionScopeError = class extends Error {
  blockers;
  constructor(message) {
    super(message);
    this.name = "WorkflowDecisionScopeError";
    this.blockers = [message];
  }
};
function fail2(message) {
  throw new WorkflowDecisionScopeError(message);
}
function isRecord4(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function protocolNodeForAction(pkg, action) {
  const nodeId = Object.entries(pkg.runtime?.nodeToStep ?? {}).find(
    ([, stepId2]) => stepId2 === action.stepId
  )?.[0];
  return pkg.runtime?.protocol.nodes.find((node) => node.id === nodeId);
}
function artifactDeclarations(protocol) {
  return protocol.outputSchemas.flatMap(
    (schema) => schema.artifacts.map((artifact) => ({
      id: `${schema.id}.${artifact.id}`,
      schemaId: schema.id,
      artifact
    }))
  );
}
function evidenceDeclarations(protocol) {
  return protocol.outputSchemas.flatMap(
    (schema) => schema.evidence.map((evidence) => ({
      id: `${schema.id}.${evidence.id}`,
      schemaId: schema.id,
      evidenceId: evidence.id
    }))
  );
}
function resolveDeclaration(requested, declarations2, label) {
  const exact = declarations2.find(
    (declaration) => declaration.id === requested
  );
  if (exact) return exact;
  const matches = declarations2.filter(
    (declaration) => declaration.id.slice(declaration.id.lastIndexOf(".") + 1) === requested
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    fail2(`${label} requires a schema-qualified id: ${requested}`);
  }
  fail2(`${label} is not declared: ${requested}`);
}
function referenceKey(reference) {
  return `${reference.id}\0${reference.versionId}`;
}
function producerEqual(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}
function contentHash(value) {
  return sha256(JSON.stringify(stableValue(value)) ?? "undefined");
}
function evidenceValue(evidence, declaration) {
  if (!evidence) return { found: false };
  const logicalId = declaration.id;
  for (const key of [logicalId, declaration.evidenceId]) {
    if (Object.prototype.hasOwnProperty.call(evidence, key)) {
      return { found: true, value: evidence[key] };
    }
  }
  const scoped = evidence.schemaEvidence;
  if (!isRecord4(scoped)) return { found: false };
  if (Object.prototype.hasOwnProperty.call(scoped, logicalId)) {
    return { found: true, value: scoped[logicalId] };
  }
  const schemaEvidence = scoped[declaration.schemaId];
  if (isRecord4(schemaEvidence)) {
    if (Object.prototype.hasOwnProperty.call(
      schemaEvidence,
      declaration.evidenceId
    )) {
      return {
        found: true,
        value: schemaEvidence[declaration.evidenceId]
      };
    }
  }
  return { found: false };
}
function outcomeRevision(runtime, visit, outcome) {
  if (!runtime) fail2("Decision evidence requires WorkflowRuntime state");
  let revision = 0;
  for (const candidate of runtime.visits) {
    for (const candidateOutcome of candidate.outcomes) {
      if (candidate.attemptId === visit.attemptId && candidateOutcome.actionId === outcome.actionId) {
        return revision;
      }
      revision += 1;
    }
  }
  fail2(`Decision evidence outcome is not accepted: ${outcome.actionId}`);
}
function evidenceProducer(state, visit, outcome) {
  return {
    runId: state.runId,
    nodeId: Object.entries(state.runtimeIdentity?.nodeToStep ?? {}).find(
      ([, stepId2]) => stepId2 === visit.stepId
    )?.[0] ?? visit.stepId,
    cycleId: visit.cycleId,
    attemptId: visit.attemptId,
    actionId: outcome.actionId,
    revision: outcomeRevision(state.workflowRuntime, visit, outcome)
  };
}
function evidenceVersionId(evidenceId, hash, producer) {
  return `evidence-version-${sha256(
    JSON.stringify(stableValue({ evidenceId, hash, producer }))
  ).slice(0, 24)}`;
}
function evidenceReference(state, declaration, visit, outcome, value, required) {
  const producer = evidenceProducer(state, visit, outcome);
  const hash = contentHash(value);
  return {
    id: declaration.id,
    required,
    versionId: evidenceVersionId(declaration.id, hash, producer),
    contentHash: hash,
    producer
  };
}
function nodeAllowsEvidence(protocol, nodeId, schemaId) {
  return protocol.nodes.find((node) => node.id === nodeId)?.outputSchemas.includes(schemaId) ?? false;
}
function acceptedEvidenceReference(protocol, state, declaration, required, producer) {
  const runtime = state.workflowRuntime;
  if (!runtime) fail2("Decision evidence requires WorkflowRuntime state");
  const nodeByStep = new Map(
    Object.entries(state.runtimeIdentity?.nodeToStep ?? {}).map(
      ([nodeId, stepId2]) => [stepId2, nodeId]
    )
  );
  const visits = [...runtime.visits].reverse();
  for (const visit of visits) {
    const nodeId = nodeByStep.get(visit.stepId);
    if (!nodeId || !nodeAllowsEvidence(protocol, nodeId, declaration.schemaId)) {
      continue;
    }
    for (const outcome of [...visit.outcomes].reverse()) {
      if (outcome.status !== "succeeded") continue;
      const value = evidenceValue(outcome.evidence, declaration);
      if (!value.found) continue;
      const reference = evidenceReference(
        state,
        declaration,
        visit,
        outcome,
        value.value,
        required
      );
      if (!producer || producerEqual(reference.producer, producer)) {
        return reference;
      }
    }
  }
  return void 0;
}
function artifactIsUsable(state, version) {
  if (version.producer.runId !== state.runId) return false;
  const currentCycleId = state.workflowRuntime?.currentCycle?.id ?? null;
  if (version.lifetime === "run") return version.scopeId === state.runId;
  if (version.lifetime === "cycle") return version.scopeId === currentCycleId;
  return version.scopeId === state.workflowRuntime?.currentAttempt?.id;
}
function acceptedArtifactVersion(state, artifactId) {
  const runtime = state.workflowRuntime;
  if (!runtime) fail2("Decision artifact scope requires WorkflowRuntime state");
  const versions = new Map(
    runtime.artifactVersions.map((version) => [version.id, version])
  );
  for (const selection2 of [...runtime.artifactSelections].reverse()) {
    if (selection2.artifactId !== artifactId) continue;
    const version = versions.get(selection2.versionId);
    if (version && artifactIsUsable(state, version)) return version;
  }
  return void 0;
}
function artifactReference(state, version, required) {
  return {
    id: version.artifactId,
    required,
    versionId: version.id,
    contentHash: version.contentHash,
    producer: structuredClone(version.producer)
  };
}
function validateScopeDefinition(pkg, action, scope) {
  const node = protocolNodeForAction(pkg, action);
  validateWorkflowDecisionScopeDefinitionForNode(pkg, node?.id, scope);
}
function validateWorkflowDecisionScopeDefinitionForNode(pkg, nodeId, scope) {
  const definition = pkg.runtime?.protocol.nodes.find(
    (candidate) => candidate.id === nodeId
  )?.decision?.scope;
  if (!definition) fail2("Decision action has an undeclared scope");
  const validateKind = (kind, references) => {
    const definitionEntries = (definition[kind] ?? []).map((entry) => ({
      ...entry,
      id: (kind === "artifacts" ? resolveDeclaration(
        entry.id,
        artifactDeclarations(pkg.runtime.protocol),
        `Decision ${kind} scope`
      ) : resolveDeclaration(
        entry.id,
        evidenceDeclarations(pkg.runtime.protocol),
        `Decision ${kind} scope`
      )).id
    }));
    const declarationById = new Map(
      definitionEntries.map((entry) => [entry.id, entry])
    );
    for (const reference of references) {
      const entry = declarationById.get(reference.id);
      if (!entry) {
        fail2(`Decision ${kind} scope reference is undeclared: ${reference.id}`);
      }
      if (reference.required !== (entry.required === true)) {
        fail2(`Decision ${kind} scope requiredness is invalid: ${reference.id}`);
      }
    }
    for (const entry of definitionEntries) {
      if (entry.required && !references.some((reference) => reference.id === entry.id)) {
        fail2(`Required decision ${kind} scope is missing: ${entry.id}`);
      }
    }
  };
  validateKind("artifacts", scope.artifacts ?? []);
  validateKind("evidence", scope.evidence ?? []);
}
async function captureWorkflowDecisionScope(runRoot, pkg, state, action) {
  if (action.type !== "ask_user") return action;
  const node = protocolNodeForAction(pkg, action);
  const scope = node?.decision?.scope;
  if (!scope) return action;
  const snapshot = {
    artifacts: [],
    evidence: []
  };
  for (const entry of scope.artifacts ?? []) {
    const declaration = resolveDeclaration(
      entry.id,
      artifactDeclarations(pkg.runtime.protocol),
      "Decision artifact scope"
    );
    const version = acceptedArtifactVersion(state, declaration.id);
    if (!version) {
      if (entry.required) {
        fail2(
          `Required decision artifact scope is unavailable: ${declaration.id}`
        );
      }
      continue;
    }
    try {
      await validateWorkflowArtifactVersion(
        runRoot,
        pkg.runtime.protocol,
        version
      );
    } catch (error) {
      fail2(
        `Decision artifact scope is unavailable: ${declaration.id} (${String(
          error instanceof Error ? error.message : error
        )})`
      );
    }
    snapshot.artifacts.push(
      artifactReference(state, version, entry.required === true)
    );
  }
  for (const entry of scope.evidence ?? []) {
    const declaration = resolveDeclaration(
      entry.id,
      evidenceDeclarations(pkg.runtime.protocol),
      "Decision evidence scope"
    );
    const reference = acceptedEvidenceReference(
      pkg.runtime.protocol,
      state,
      declaration,
      entry.required === true
    );
    if (!reference) {
      if (entry.required) {
        fail2(
          `Required decision evidence scope is unavailable: ${declaration.id}`
        );
      }
      continue;
    }
    snapshot.evidence.push(reference);
  }
  return { ...action, scope: snapshot };
}
function scopeReferenceEqual(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}
function pendingReference(references, id) {
  const matches = references.filter((reference) => reference.id === id);
  if (matches.length !== 1) {
    fail2(`Decision scope reference is not pending: ${id}`);
  }
  return matches[0];
}
function validateScopeList(references, pending, label) {
  const keys = /* @__PURE__ */ new Set();
  for (const reference of references) {
    if (!isRecord4(reference)) fail2(`${label} entries must be objects`);
    const unknown = Object.keys(reference).find(
      (key2) => !["id", "required", "versionId", "contentHash", "producer"].includes(
        key2
      )
    );
    if (unknown) fail2(`${label} has unsupported field: ${unknown}`);
    if (typeof reference.id !== "string" || typeof reference.versionId !== "string" || typeof reference.contentHash !== "string" || !/^[a-f0-9]{64}$/u.test(reference.contentHash) || reference.required !== void 0 && typeof reference.required !== "boolean" || reference.producer !== void 0 && !isRecord4(reference.producer)) {
      fail2(`${label} contains an invalid reference`);
    }
    const key = referenceKey(reference);
    if (keys.has(key))
      fail2(`${label} contains a duplicate reference: ${reference.id}`);
    keys.add(key);
    const expected = pendingReference(pending, reference.id);
    if (reference.required !== void 0 && reference.required !== expected.required) {
      fail2(
        `Decision scope requiredness does not match pending scope: ${reference.id}`
      );
    }
    if (reference.producer !== void 0 && !producerEqual(reference.producer, expected.producer)) {
      fail2(
        `Decision scope producer does not match pending scope: ${reference.id}`
      );
    }
    if (reference.id !== expected.id || reference.versionId !== expected.versionId || reference.contentHash !== expected.contentHash) {
      fail2(
        `Decision scope reference does not match pending scope: ${reference.id}`
      );
    }
  }
}
function validateWorkflowDecisionScopeResponse(pending, submitted, evidenceReferences) {
  let submittedScope;
  if (submitted) {
    const submittedValue = submitted;
    if (!isRecord4(submittedValue)) {
      fail2("Decision response scope must be an object");
    }
    const unknown = Object.keys(submittedValue).find(
      (key) => key !== "artifacts" && key !== "evidence"
    );
    if (unknown)
      fail2(`Decision response scope has unsupported field: ${unknown}`);
    if (submittedValue.artifacts !== void 0 && !Array.isArray(submittedValue.artifacts) || submittedValue.evidence !== void 0 && !Array.isArray(submittedValue.evidence)) {
      fail2("Decision response scope entries must be arrays");
    }
    if ((submittedValue.artifacts?.length ?? 0) > 64 || (submittedValue.evidence?.length ?? 0) > 64) {
      fail2("Decision response scope contains too many entries");
    }
    submittedScope = {
      artifacts: submittedValue.artifacts,
      evidence: submittedValue.evidence
    };
  }
  if (!pending) {
    if (submitted && ((submitted.artifacts?.length ?? 0) > 0 || (submitted.evidence?.length ?? 0) > 0) || evidenceReferences && evidenceReferences.length > 0) {
      fail2("Decision response includes scope that was not declared");
    }
    return;
  }
  const selected = submittedScope ? {
    artifacts: submittedScope.artifacts ?? [],
    evidence: submittedScope.evidence ?? []
  } : {
    artifacts: [],
    evidence: (pending.evidence ?? []).filter(
      (candidate) => evidenceReferences?.some(
        (reference) => reference === candidate.id || reference === candidate.versionId
      )
    )
  };
  validateScopeList(
    selected.artifacts ?? [],
    pending.artifacts,
    "Decision artifact scope"
  );
  validateScopeList(
    selected.evidence ?? [],
    pending.evidence,
    "Decision evidence scope"
  );
  if (evidenceReferences) {
    const selectedEvidence = new Set(
      (selected.evidence ?? []).map((reference) => reference.versionId)
    );
    for (const reference of evidenceReferences) {
      const pendingReferenceValue = pending.evidence.find(
        (candidate) => candidate.versionId === reference || candidate.id === reference
      );
      if (!pendingReferenceValue) {
        fail2(`Decision evidence reference is not pending: ${reference}`);
      }
      if (!selectedEvidence.has(pendingReferenceValue.versionId)) {
        fail2(`Decision evidence reference is not selected: ${reference}`);
      }
    }
  }
  for (const reference of pending.artifacts) {
    if (reference.required && !selected.artifacts.some((item) => item.id === reference.id)) {
      fail2(`Required decision artifact scope is missing: ${reference.id}`);
    }
  }
  for (const reference of pending.evidence) {
    if (reference.required && !selected.evidence.some((item) => item.id === reference.id)) {
      fail2(`Required decision evidence scope is missing: ${reference.id}`);
    }
  }
}
async function validateArtifactReference(runRoot, protocol, state, reference, requireCurrentScope, verifyContent) {
  const version = state.workflowRuntime?.artifactVersions.find(
    (candidate) => candidate.id === reference.versionId
  );
  if (!version)
    fail2(`Decision artifact version is missing: ${reference.versionId}`);
  if (version.artifactId !== reference.id || version.contentHash !== reference.contentHash || !producerEqual(version.producer, reference.producer) || requireCurrentScope && !artifactIsUsable(state, version)) {
    fail2(`Decision artifact scope is stale: ${reference.id}`);
  }
  if (verifyContent) {
    await validateWorkflowArtifactVersion(runRoot, protocol, version);
  }
}
function findEvidenceOutcome(state, reference) {
  for (const visit of state.workflowRuntime?.visits ?? []) {
    if (visit.attemptId !== reference.producer.attemptId) continue;
    const outcome = visit.outcomes.find(
      (candidate) => candidate.actionId === reference.producer.actionId
    );
    if (outcome) return { visit, outcome };
  }
  return void 0;
}
function validateEvidenceReference(protocol, state, reference) {
  const declaration = resolveDeclaration(
    reference.id,
    evidenceDeclarations(protocol),
    "Decision evidence scope"
  );
  const found = findEvidenceOutcome(state, reference);
  if (!found || found.outcome.status !== "succeeded") {
    fail2(`Decision evidence version is missing: ${reference.versionId}`);
  }
  const nodeId = Object.entries(state.runtimeIdentity?.nodeToStep ?? {}).find(
    ([, stepId2]) => stepId2 === found.visit.stepId
  )?.[0];
  if (!nodeId || !nodeAllowsEvidence(protocol, nodeId, declaration.schemaId)) {
    fail2(`Decision evidence producer is invalid: ${reference.versionId}`);
  }
  const value = evidenceValue(found.outcome.evidence, declaration);
  if (!value.found)
    fail2(`Decision evidence version is stale: ${reference.versionId}`);
  const expected = evidenceReference(
    state,
    declaration,
    found.visit,
    found.outcome,
    value.value,
    reference.required
  );
  if (!scopeReferenceEqual(expected, reference)) {
    fail2(`Decision evidence scope is stale: ${reference.id}`);
  }
}
async function validateWorkflowDecisionScope(runRoot, pkg, state, action) {
  const scope = action.scope;
  const node = protocolNodeForAction(pkg, action);
  const definition = node?.decision?.scope;
  if (definition && !scope) {
    fail2("Decision action is missing its captured scope");
  }
  if (!definition && scope) {
    fail2("Decision action has an undeclared scope");
  }
  if (!scope) return;
  validateScopeDefinition(pkg, action, scope);
  await validateWorkflowDecisionScopeSnapshot(runRoot, pkg, state, scope);
}
async function validateWorkflowDecisionScopeSnapshot(runRoot, pkg, state, scope, options = {}) {
  for (const reference of scope.artifacts ?? []) {
    await validateArtifactReference(
      runRoot,
      pkg.runtime.protocol,
      state,
      reference,
      options.requireCurrentScope !== false,
      options.verifyArtifactContent !== false
    );
  }
  for (const reference of scope.evidence ?? []) {
    validateEvidenceReference(pkg.runtime.protocol, state, reference);
  }
}
function validateWorkflowDecisionScopeDefinition(protocol) {
  const artifacts = artifactDeclarations(protocol);
  const evidence = evidenceDeclarations(protocol);
  for (const node of protocol.nodes) {
    if (!node.decision?.scope) continue;
    for (const kind of ["artifacts", "evidence"]) {
      const seen = /* @__PURE__ */ new Set();
      for (const entry of node.decision.scope[kind] ?? []) {
        const declaration = kind === "artifacts" ? resolveDeclaration(entry.id, artifacts, `Decision ${kind} scope`) : resolveDeclaration(entry.id, evidence, `Decision ${kind} scope`);
        if (seen.has(declaration.id)) {
          fail2(
            `Decision ${kind} scope repeats a declaration: ${declaration.id}`
          );
        }
        seen.add(declaration.id);
        if (kind === "artifacts" && !protocol.capabilities?.features.includes("versioned-artifacts")) {
          fail2(
            `Decision artifact scope requires versioned-artifacts capability: ${declaration.id}`
          );
        }
      }
    }
  }
}

// src/workflow-runtime/findings.ts
import path9 from "node:path";
var WORKFLOW_FINDING_CATALOG_VERSION = 1;
var MAX_WORKFLOW_FINDINGS = 32;
var MAX_WORKFLOW_FINDING_MESSAGE_LENGTH = 512;
var MAX_WORKFLOW_FINDING_PATH_LENGTH = 256;
var MAX_WORKFLOW_FINDING_OPERATION_ARGS = 16;
var MAX_WORKFLOW_FINDING_OPERATION_ARG_LENGTH = 256;
var MAX_WORKFLOW_FINDINGS_ENCODED_BYTES = 16 * 1024;
var WORKFLOW_FINDING_SEVERITIES = ["info", "warning", "error"];
var WORKFLOW_FINDING_REQUIRED_ACTIONS = [
  "none",
  "execute",
  "decide",
  "repair",
  "retry",
  "stop"
];
var WORKFLOW_FINDING_OPERATION_IDS = [
  "workflow.start",
  "workflow.resume",
  "workflow.submit",
  "workflow.recover"
];
var WORKFLOW_FINDING_CODES = [
  "action-available",
  "action-already-pending",
  "adaptive-requires-agent",
  "agent-not-allowed",
  "artifact-capability-required",
  "artifact-content-drift",
  "artifact-failed-submission",
  "artifact-invalid",
  "artifact-oversized",
  "artifact-stale-attempt",
  "artifact-unknown-version",
  "completion-invalid-artifact",
  "completion-missing-artifact",
  "completion-missing-augmentation",
  "completion-missing-evidence",
  "completion-missing-guardrail",
  "completion-missing-required-skill",
  "confirmation-required",
  "catalog-version-unsupported",
  "cycle-budget-exhausted",
  "cycle-invalid",
  "decision-required",
  "evaluation-warning",
  "identity-invalid",
  "iteration-budget-exhausted",
  "no-pending-action",
  "pending-action-invalid",
  "retry-budget-exhausted",
  "route-ambiguous",
  "route-invalid-value",
  "route-no-match",
  "route-unknown-field",
  "run-not-found",
  "run-status",
  "scope-invalid",
  "scope-unavailable",
  "skill-not-allowed",
  "state-invalid",
  "tool-not-allowed",
  "unknown-current-step",
  "unknown-next-step"
];
var severityRank = {
  error: 0,
  warning: 1,
  info: 2
};
var registeredOperations = new Set(
  WORKFLOW_FINDING_OPERATION_IDS
);
function isRecord5(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function truncate(value, maxLength) {
  if (new TextEncoder().encode(value).byteLength <= maxLength) return value;
  let result = "";
  for (const character of value) {
    const next = `${result}${character}\u2026`;
    if (new TextEncoder().encode(next).byteLength > maxLength) break;
    result += character;
  }
  return `${result}\u2026`;
}
function redactMessage(value) {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const redactedUrls = normalized.replace(
    /\b(?:https?|file):\/\/[^\s,;)]+/giu,
    "[URL]"
  );
  const redactedCredentials = redactedUrls.replace(
    /\b(password|passwd|secret|token|api[-_]?key|authorization|cookie|credential)["']?\s*[:=]\s*["']?[^\s,;"'}]+/giu,
    "$1=[REDACTED]"
  ).replace(/\bBearer\s+[^\s,;)]+/giu, "Bearer [REDACTED]").replace(/\b([A-Z][A-Z0-9_]{2,})\s*=\s*[^\s,;]+/gu, "$1=[REDACTED]");
  const redactedAbsolutePaths = redactedCredentials.replace(
    /(?:[A-Za-z]:[\\/]|\/)[^,;)]*/gu,
    "[PATH]"
  );
  return truncate(redactedAbsolutePaths, MAX_WORKFLOW_FINDING_MESSAGE_LENGTH);
}
function normalizeWorkflowFindingPath(value) {
  if (value === void 0 || value.length === 0 || new TextEncoder().encode(value).byteLength > MAX_WORKFLOW_FINDING_PATH_LENGTH) {
    return void 0;
  }
  const normalizedSeparators = value.replaceAll("\\", "/");
  if (normalizedSeparators.startsWith("/") || /^[A-Za-z]:/u.test(normalizedSeparators) || /[*?\u0000-\u001f\u007f]/u.test(normalizedSeparators)) {
    return void 0;
  }
  const segments = normalizedSeparators.split("/");
  if (segments.some(
    (segment) => segment.length === 0 || segment === "." || segment === ".."
  )) {
    return void 0;
  }
  const normalized = path9.posix.normalize(normalizedSeparators);
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../") || path9.posix.isAbsolute(normalized)) {
    return void 0;
  }
  return normalized;
}
function operation(value) {
  if (value === void 0) return void 0;
  if (!isRecord5(value)) {
    throw new Error("Workflow finding operation must be an object");
  }
  const unknown = Object.keys(value).find(
    (key) => key !== "id" && key !== "args"
  );
  if (unknown) {
    throw new Error(`Workflow finding operation has unknown field: ${unknown}`);
  }
  if (typeof value.id !== "string" || !registeredOperations.has(value.id)) {
    throw new Error(`Unknown Workflow finding operation: ${String(value.id)}`);
  }
  if (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string") || value.args.length > MAX_WORKFLOW_FINDING_OPERATION_ARGS || value.args.some(
    (arg) => arg.length === 0 || new TextEncoder().encode(arg).byteLength > MAX_WORKFLOW_FINDING_OPERATION_ARG_LENGTH || /[\u0000\r\n]/u.test(arg)
  )) {
    throw new Error("Workflow finding operation args are invalid");
  }
  const args = value.args.map(
    (arg) => truncate(redactMessage(arg), MAX_WORKFLOW_FINDING_OPERATION_ARG_LENGTH)
  );
  return {
    id: value.id,
    args
  };
}
function findingKey(value) {
  return JSON.stringify([
    value.code,
    value.severity,
    value.message,
    value.path ?? "",
    value.requiredAction,
    value.operation?.id ?? "",
    value.operation?.args ?? [],
    value.requiresUserDecision
  ]);
}
function compareFindings(left, right) {
  const severity = severityRank[left.severity] - severityRank[right.severity];
  if (severity !== 0) return severity;
  if (left.requiresUserDecision !== right.requiresUserDecision) {
    return left.requiresUserDecision ? -1 : 1;
  }
  const code = left.code.localeCompare(right.code);
  if (code !== 0) return code;
  const pathComparison = (left.path ?? "").localeCompare(right.path ?? "");
  if (pathComparison !== 0) return pathComparison;
  return left.message.localeCompare(right.message);
}
function findingBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
var findingCodes = new Set(WORKFLOW_FINDING_CODES);
var findingSeverities = new Set(
  WORKFLOW_FINDING_SEVERITIES
);
var findingActions = new Set(
  WORKFLOW_FINDING_REQUIRED_ACTIONS
);
function createWorkflowFinding(input) {
  if (!findingCodes.has(input.code)) {
    throw new Error(`Unknown Workflow finding code: ${input.code}`);
  }
  if (!findingSeverities.has(input.severity)) {
    throw new Error(`Unknown Workflow finding severity: ${input.severity}`);
  }
  if (!findingActions.has(input.requiredAction)) {
    throw new Error(
      `Unknown Workflow finding required action: ${input.requiredAction}`
    );
  }
  if (typeof input.message !== "string" || input.message.trim().length === 0) {
    throw new Error("Workflow finding message must be non-empty");
  }
  const safePath = normalizeWorkflowFindingPath(input.path);
  const safeOperation = operation(input.operation);
  const allowedOperations = {
    execute: ["workflow.start", "workflow.resume"],
    decide: ["workflow.submit"],
    repair: ["workflow.submit"],
    retry: ["workflow.resume"]
  };
  const expectedOperations = allowedOperations[input.requiredAction];
  if (expectedOperations && (!safeOperation || !expectedOperations.includes(safeOperation.id))) {
    throw new Error(
      `Workflow finding ${input.code} has an invalid operation for ${input.requiredAction}`
    );
  }
  return {
    catalogVersion: WORKFLOW_FINDING_CATALOG_VERSION,
    code: input.code,
    severity: input.severity,
    message: redactMessage(input.message),
    ...safePath ? { path: safePath } : {},
    requiredAction: input.requiredAction,
    ...safeOperation ? { operation: safeOperation } : {},
    requiresUserDecision: input.requiresUserDecision ?? false
  };
}
function parseWorkflowFinding(value) {
  if (!isRecord5(value)) {
    throw new Error("Workflow finding must be an object");
  }
  if (value.catalogVersion !== WORKFLOW_FINDING_CATALOG_VERSION) {
    throw new Error(
      `Unknown Workflow finding catalog version: ${String(value.catalogVersion)}`
    );
  }
  const keys = /* @__PURE__ */ new Set([
    "catalogVersion",
    "code",
    "severity",
    "message",
    "path",
    "requiredAction",
    "operation",
    "requiresUserDecision"
  ]);
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) {
    throw new Error(`Workflow finding has unknown field: ${unknown}`);
  }
  if (typeof value.code !== "string" || typeof value.severity !== "string" || typeof value.message !== "string" || typeof value.requiredAction !== "string" || typeof value.requiresUserDecision !== "boolean") {
    throw new Error("Workflow finding fields are invalid");
  }
  if (value.path !== void 0 && typeof value.path !== "string") {
    throw new Error("Workflow finding path must be a string");
  }
  const finding = createWorkflowFinding({
    code: value.code,
    severity: value.severity,
    message: value.message,
    ...value.path !== void 0 ? { path: value.path } : {},
    requiredAction: value.requiredAction,
    ...value.operation !== void 0 ? { operation: value.operation } : {},
    requiresUserDecision: value.requiresUserDecision
  });
  if (JSON.stringify(stableValue(finding)) !== JSON.stringify(stableValue(value))) {
    throw new Error("Workflow finding is not canonical");
  }
  return finding;
}
function boundWorkflowFindings(values) {
  const unique2 = /* @__PURE__ */ new Map();
  for (const value of values) {
    const finding = parseWorkflowFinding(value);
    unique2.set(findingKey(finding), finding);
  }
  const candidates = [...unique2.values()].sort(compareFindings);
  const findings = [];
  let encodedBytes = findingBytes(findings);
  for (const candidate of candidates) {
    if (findings.length >= MAX_WORKFLOW_FINDINGS) break;
    const next = [...findings, candidate];
    const nextBytes = findingBytes(next);
    if (nextBytes > MAX_WORKFLOW_FINDINGS_ENCODED_BYTES) continue;
    findings.push(candidate);
    encodedBytes = nextBytes;
  }
  const omittedValues = candidates.filter(
    (candidate) => !findings.some((value) => findingKey(value) === findingKey(candidate))
  );
  const omittedBySeverity = {
    info: 0,
    warning: 0,
    error: 0
  };
  const omittedByCode = {};
  for (const omitted of omittedValues) {
    omittedBySeverity[omitted.severity] += 1;
    omittedByCode[omitted.code] = (omittedByCode[omitted.code] ?? 0) + 1;
  }
  const summary = {
    catalogVersion: WORKFLOW_FINDING_CATALOG_VERSION,
    total: candidates.length,
    returned: findings.length,
    omitted: omittedValues.length,
    omittedBySeverity,
    omittedByCode,
    omittedRequiresUserDecision: omittedValues.filter(
      (finding) => finding.requiresUserDecision
    ).length,
    truncated: omittedValues.length > 0,
    encodedBytes,
    maxEncodedBytes: MAX_WORKFLOW_FINDINGS_ENCODED_BYTES
  };
  return { findings: structuredClone(findings), summary };
}
function parseWorkflowFindingSummary(value) {
  if (!isRecord5(value)) {
    throw new Error("Workflow finding summary must be an object");
  }
  const keys = /* @__PURE__ */ new Set([
    "catalogVersion",
    "total",
    "returned",
    "omitted",
    "omittedBySeverity",
    "omittedByCode",
    "omittedRequiresUserDecision",
    "truncated",
    "encodedBytes",
    "maxEncodedBytes"
  ]);
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) {
    throw new Error(`Workflow finding summary has unknown field: ${unknown}`);
  }
  if (value.catalogVersion !== WORKFLOW_FINDING_CATALOG_VERSION) {
    throw new Error(
      `Unknown Workflow finding catalog version: ${String(value.catalogVersion)}`
    );
  }
  const integerFields = [
    "total",
    "returned",
    "omitted",
    "omittedRequiresUserDecision",
    "encodedBytes",
    "maxEncodedBytes"
  ];
  for (const field of integerFields) {
    const entry = value[field];
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0) {
      throw new Error(`Workflow finding summary field is invalid: ${field}`);
    }
  }
  if (typeof value.truncated !== "boolean") {
    throw new Error("Workflow finding summary truncated field is invalid");
  }
  if (!isRecord5(value.omittedBySeverity)) {
    throw new Error("Workflow finding summary severities are invalid");
  }
  const omittedBySeverity = {
    info: 0,
    warning: 0,
    error: 0
  };
  const unknownSeverity = Object.keys(value.omittedBySeverity).find(
    (severity) => !(severity in omittedBySeverity)
  );
  if (unknownSeverity) {
    throw new Error(
      `Workflow finding summary has unknown severity: ${unknownSeverity}`
    );
  }
  for (const severity of Object.keys(
    omittedBySeverity
  )) {
    const entry = value.omittedBySeverity[severity];
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0) {
      throw new Error(
        `Workflow finding summary severity count is invalid: ${severity}`
      );
    }
    omittedBySeverity[severity] = entry;
  }
  if (!isRecord5(value.omittedByCode)) {
    throw new Error("Workflow finding summary codes are invalid");
  }
  const omittedByCode = {};
  for (const [code, entry] of Object.entries(value.omittedByCode)) {
    if (!findingCodes.has(code)) {
      throw new Error(`Unknown Workflow finding code: ${code}`);
    }
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry <= 0) {
      throw new Error(
        `Workflow finding summary code count is invalid: ${code}`
      );
    }
    omittedByCode[code] = entry;
  }
  const total = value.total;
  const returned = value.returned;
  const omitted = value.omitted;
  if (returned > total || returned > MAX_WORKFLOW_FINDINGS || omitted !== total - returned || value.truncated !== omitted > 0 || Object.values(omittedBySeverity).reduce((sum, count) => sum + count, 0) !== omitted || Object.values(omittedByCode).reduce(
    (sum, count) => sum + (count ?? 0),
    0
  ) !== omitted || value.omittedRequiresUserDecision > omitted || value.maxEncodedBytes !== MAX_WORKFLOW_FINDINGS_ENCODED_BYTES || value.encodedBytes > value.maxEncodedBytes) {
    throw new Error("Workflow finding summary counts are inconsistent");
  }
  return {
    catalogVersion: WORKFLOW_FINDING_CATALOG_VERSION,
    total,
    returned,
    omitted,
    omittedBySeverity,
    omittedByCode,
    omittedRequiresUserDecision: value.omittedRequiresUserDecision,
    truncated: value.truncated,
    encodedBytes: value.encodedBytes,
    maxEncodedBytes: value.maxEncodedBytes
  };
}
var blockerCatalog = [
  {
    match: /^No Comet Run found:/u,
    entry: {
      code: "run-not-found",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /^Unknown Workflow finding catalog version:/u,
    entry: {
      code: "catalog-version-unsupported",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /^Decision is pending/u,
    entry: {
      code: "decision-required",
      severity: "info",
      requiredAction: "decide",
      requiresUserDecision: true,
      operationId: "workflow.submit"
    }
  },
  {
    match: /^Missing Output Schema artifacts:/u,
    entry: {
      code: "completion-missing-artifact",
      severity: "error",
      requiredAction: "repair"
    }
  },
  {
    match: /^Missing Output Schema evidence:/u,
    entry: {
      code: "completion-missing-evidence",
      severity: "error",
      requiredAction: "repair"
    }
  },
  {
    match: /exceeds \d+ bytes/iu,
    entry: {
      code: "artifact-oversized",
      severity: "error",
      requiredAction: "repair"
    }
  },
  {
    match: /^Invalid Output Schema artifact/u,
    entry: {
      code: "completion-invalid-artifact",
      severity: "error",
      requiredAction: "repair"
    }
  },
  {
    match: /^Missing required Skill evidence:/u,
    entry: {
      code: "completion-missing-required-skill",
      severity: "error",
      requiredAction: "repair"
    }
  },
  {
    match: /^Missing augmentation evidence:/u,
    entry: {
      code: "completion-missing-augmentation",
      severity: "error",
      requiredAction: "repair"
    }
  },
  {
    match: /^Missing guardrail evidence:/u,
    entry: {
      code: "completion-missing-guardrail",
      severity: "error",
      requiredAction: "repair"
    }
  },
  {
    match: /^Route blocker: unknown routing field:/u,
    entry: {
      code: "route-unknown-field",
      severity: "error",
      requiredAction: "repair"
    }
  },
  {
    match: /^Route blocker: invalid routing value/u,
    entry: {
      code: "route-invalid-value",
      severity: "error",
      requiredAction: "repair"
    }
  },
  {
    match: /^Route blocker: ambiguous/u,
    entry: {
      code: "route-ambiguous",
      severity: "error",
      requiredAction: "repair"
    }
  },
  {
    match: /^Route blocker: no matching/u,
    entry: {
      code: "route-no-match",
      severity: "error",
      requiredAction: "repair"
    }
  },
  {
    match: /^Cycle budget exhausted:/u,
    entry: {
      code: "cycle-budget-exhausted",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /^Cycle /u,
    entry: {
      code: "cycle-invalid",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /Workflow Protocol Cycle|WorkflowRuntime .*Cycle/iu,
    entry: {
      code: "cycle-invalid",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /^Workflow artifact selections require versioned-artifacts capability$/u,
    entry: {
      code: "artifact-capability-required",
      severity: "error",
      requiredAction: "repair"
    }
  },
  {
    match: /^Failed submissions cannot update versioned artifacts$/u,
    entry: {
      code: "artifact-failed-submission",
      severity: "error",
      requiredAction: "repair"
    }
  },
  {
    match: /artifact content drift detected/iu,
    entry: {
      code: "artifact-content-drift",
      severity: "error",
      requiredAction: "repair"
    }
  },
  {
    match: /artifact version is unknown/iu,
    entry: {
      code: "artifact-unknown-version",
      severity: "error",
      requiredAction: "repair"
    }
  },
  {
    match: /stale for this Attempt/iu,
    entry: {
      code: "artifact-stale-attempt",
      severity: "error",
      requiredAction: "repair"
    }
  },
  {
    match: /scope is unavailable/iu,
    entry: {
      code: "scope-unavailable",
      severity: "error",
      requiredAction: "repair"
    }
  },
  {
    match: /scope/iu,
    entry: {
      code: "scope-invalid",
      severity: "error",
      requiredAction: "repair"
    }
  },
  {
    match: /WorkflowRuntime .*identity|execution identity|Skill snapshot is invalid or missing/iu,
    entry: {
      code: "identity-invalid",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /Decision response revision|Decision response execution identity|Decision response .* identity/iu,
    entry: {
      code: "identity-invalid",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /Outcome does not match pending action|Submission Node does not match pending Node|Decision response required|Decision response cannot satisfy|Decision choice|pending decision identity/iu,
    entry: {
      code: "pending-action-invalid",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /WorkflowRuntime pending action|pending action file|current Node does not match pending action/iu,
    entry: {
      code: "pending-action-invalid",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /WorkflowRuntime current (?:Cycle|Attempt)|Cycle identity|Cycle position is invalid/iu,
    entry: {
      code: "cycle-invalid",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /WorkflowRuntime current Node is not in the compiled route/iu,
    entry: {
      code: "pending-action-invalid",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /^Run has no pending action$/u,
    entry: {
      code: "no-pending-action",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /^Workflow artifact/u,
    entry: {
      code: "artifact-invalid",
      severity: "error",
      requiredAction: "repair"
    }
  },
  {
    match: /^Required Workflow artifact needs an explicit update or version:/u,
    entry: {
      code: "artifact-invalid",
      severity: "error",
      requiredAction: "repair"
    }
  },
  {
    match: /^Cycle-persistent artifact update requires a current Cycle$/u,
    entry: {
      code: "artifact-invalid",
      severity: "error",
      requiredAction: "repair"
    }
  },
  {
    match: /^Attempt artifact path must include the current Attempt id:/u,
    entry: {
      code: "artifact-invalid",
      severity: "error",
      requiredAction: "repair"
    }
  },
  {
    match: /^Versioned artifact submission requires revisioned Run state$/u,
    entry: {
      code: "artifact-invalid",
      severity: "error",
      requiredAction: "repair"
    }
  },
  {
    match: /^Retry budget exhausted for action:/u,
    entry: {
      code: "retry-budget-exhausted",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /^Iteration budget exhausted:/u,
    entry: {
      code: "iteration-budget-exhausted",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /^Skill is not allowed:/u,
    entry: {
      code: "skill-not-allowed",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /^Tool is not allowed:/u,
    entry: {
      code: "tool-not-allowed",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /^Agent is not allowed:/u,
    entry: {
      code: "agent-not-allowed",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /^User confirmation required for:/u,
    entry: {
      code: "confirmation-required",
      severity: "warning",
      requiredAction: "execute",
      requiresUserDecision: true
    }
  },
  {
    match: /^Action already pending:/u,
    entry: {
      code: "action-already-pending",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /^No pending action accepts an outcome$/u,
    entry: {
      code: "no-pending-action",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /^Adaptive orchestration requires an Agent candidate$/u,
    entry: {
      code: "adaptive-requires-agent",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /^Unknown current step:/u,
    entry: {
      code: "unknown-current-step",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /^Resolver returned unknown next step:/u,
    entry: {
      code: "unknown-next-step",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /^Run is /u,
    entry: {
      code: "run-status",
      severity: "error",
      requiredAction: "stop"
    }
  }
];
function operationFor(requiredAction, context, operationId) {
  const args = context.actionId ? [context.actionId] : [];
  if (operationId) return { id: operationId, args };
  if (requiredAction === "repair") {
    return { id: "workflow.submit", args };
  }
  if (requiredAction === "retry") {
    return { id: "workflow.resume", args };
  }
  if (requiredAction === "decide") {
    return { id: "workflow.submit", args };
  }
  if (requiredAction === "execute") {
    return { id: "workflow.resume", args };
  }
  return void 0;
}
function findingFromBlocker(message, context = {}) {
  const catalog = blockerCatalog.find((entry2) => entry2.match.test(message));
  const entry = catalog?.entry ?? {
    code: "state-invalid",
    severity: "error",
    requiredAction: "stop"
  };
  return createWorkflowFinding({
    ...entry,
    message,
    path: context.path,
    operation: operationFor(entry.requiredAction, context, entry.operationId)
  });
}
function attachWorkflowFinding(error) {
  if (error instanceof Error && "finding" in error) return error;
  const message = error instanceof Error ? error.message : String(error);
  const finding = findingFromBlocker(message);
  if (error instanceof Error) {
    Object.defineProperty(error, "finding", {
      configurable: true,
      enumerable: true,
      value: finding,
      writable: false
    });
    return error;
  }
  const wrapped = new Error(message, { cause: error });
  Object.defineProperty(wrapped, "finding", {
    configurable: true,
    enumerable: true,
    value: finding,
    writable: false
  });
  return wrapped;
}
function actionAvailableFinding(actionId2, retry = false) {
  return createWorkflowFinding({
    code: "action-available",
    severity: "info",
    message: "Executable workflow action is available.",
    requiredAction: retry ? "retry" : "execute",
    operation: { id: "workflow.resume", args: [actionId2] }
  });
}
function decisionRequiredFinding(actionId2) {
  return createWorkflowFinding({
    code: "decision-required",
    severity: "info",
    message: "A persisted workflow decision requires user input.",
    requiredAction: "decide",
    operation: { id: "workflow.submit", args: [actionId2] },
    requiresUserDecision: true
  });
}
function evaluationWarningFinding(evalId, evidence) {
  return createWorkflowFinding({
    code: "evaluation-warning",
    severity: "warning",
    message: `Terminal evaluation ${evalId} did not pass: ${evidence}`,
    requiredAction: "none"
  });
}
function legacyBlockersFromFindings(disposition, findings) {
  return disposition === "blocked" ? findings.map((finding) => finding.message) : [];
}

// src/workflow-runtime/compiler.ts
function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(value[key]);
  }
  return Object.freeze(value);
}
function hashProtocol(protocol) {
  return sha256(JSON.stringify(stableValue(protocol)));
}
function activeNodes2(protocol) {
  return protocol.nodes.filter((node) => !node.disabled);
}
function stepId(index, nodeId) {
  return `node-${index + 1}-${nodeId}`;
}
function nodeSkillName(workflow, nodeId) {
  return `${slug(workflow) || "workflow"}-${slug(nodeId) || "node"}`;
}
function nodeBindingSkills(node) {
  return [
    node.implementation.skill,
    ...node.requiredSkillCalls.map((binding) => binding.skill),
    ...node.augmentations.map((binding) => binding.skill)
  ];
}
function compiledSkillIds(protocol, nodes) {
  return [
    .../* @__PURE__ */ new Set([
      ...nodes.map((node) => nodeSkillName(protocol.name, node.id)),
      ...nodes.flatMap(nodeBindingSkills)
    ])
  ];
}
function bindingIsValid(binding, nodeId, label) {
  if (!binding || typeof binding !== "object") {
    throw new Error(`${nodeId}: ${label} must be an object`);
  }
  if (typeof binding.skill !== "string" || binding.skill.length === 0) {
    throw new Error(`${nodeId}: ${label} requires a Skill`);
  }
}
function validateProtocolShape(protocol) {
  if (!protocol || typeof protocol !== "object") {
    throw new Error("Workflow Protocol must be an object");
  }
  if (protocol.schemaVersion !== 1 || protocol.kind !== "workflow-kernel") {
    throw new Error("Unsupported Workflow Protocol");
  }
  if (typeof protocol.name !== "string" || protocol.name.length === 0) {
    throw new Error("Workflow Protocol name is required");
  }
  if (typeof protocol.goal !== "string" || protocol.goal.length === 0) {
    throw new Error("Workflow Protocol goal is required");
  }
  if (!Array.isArray(protocol.nodes)) {
    throw new Error("Workflow Protocol nodes must be an array");
  }
  if (!Array.isArray(protocol.edges)) {
    throw new Error("Workflow Protocol edges must be an array");
  }
  if (!Array.isArray(protocol.outputSchemas)) {
    throw new Error("Workflow Protocol Output Schemas must be an array");
  }
  if (protocol.capabilities !== void 0) {
    if (!protocol.capabilities || protocol.capabilities.version !== 3 || !Array.isArray(protocol.capabilities.features) || protocol.capabilities.features.some(
      (feature) => feature !== "conditional-routing" && feature !== "revisioned-attempts" && feature !== "decision-nodes" && feature !== "bounded-cycles" && feature !== "versioned-artifacts"
    ) || !protocol.capabilities.features.includes("conditional-routing") || !protocol.capabilities.features.includes("revisioned-attempts")) {
      throw new Error("Workflow Protocol capabilities are invalid");
    }
    if (protocol.cycles !== void 0 && !protocol.capabilities.features.includes("bounded-cycles")) {
      throw new Error(
        "Workflow Protocol cycle declarations require bounded-cycles capability"
      );
    }
  } else if (protocol.cycles !== void 0) {
    throw new Error(
      "Workflow Protocol cycle declarations require versioned capabilities"
    );
  }
  const schemaIds = /* @__PURE__ */ new Set();
  const logicalArtifactIds = /* @__PURE__ */ new Set();
  for (const schema of protocol.outputSchemas) {
    if (!schema || typeof schema !== "object" || typeof schema.id !== "string" || schema.id.length === 0 || typeof schema.description !== "string" || schema.description.length === 0 || !Array.isArray(schema.artifacts) || !Array.isArray(schema.evidence)) {
      throw new Error(
        "Workflow Protocol Output Schemas must have ids, descriptions, artifacts, and evidence"
      );
    }
    if (schemaIds.has(schema.id)) {
      throw new Error(
        `Workflow Protocol has duplicate Output Schema: ${schema.id}`
      );
    }
    schemaIds.add(schema.id);
    const artifactIds = /* @__PURE__ */ new Set();
    for (const artifact of schema.artifacts) {
      if (!artifact || typeof artifact !== "object" || typeof artifact.id !== "string" || artifact.id.length === 0 || typeof artifact.required !== "boolean" || !Array.isArray(artifact.paths) || artifact.paths.some(
        (artifactPath) => typeof artifactPath !== "string"
      ) || !Array.isArray(artifact.validations) || artifact.lifetime !== void 0 && artifact.lifetime !== "attempt" && artifact.lifetime !== "cycle" && artifact.lifetime !== "run") {
        throw new Error(
          `Workflow Protocol Output Schema ${schema.id} has an invalid artifact`
        );
      }
      if (artifactIds.has(artifact.id)) {
        throw new Error(
          `Workflow Protocol Output Schema ${schema.id} has duplicate artifact: ${artifact.id}`
        );
      }
      artifactIds.add(artifact.id);
      const logicalArtifactId = `${schema.id}.${artifact.id}`;
      if (logicalArtifactIds.has(logicalArtifactId)) {
        throw new Error(
          `Workflow Protocol has duplicate logical artifact: ${logicalArtifactId}`
        );
      }
      logicalArtifactIds.add(logicalArtifactId);
      if (artifact.lifetime !== void 0 && !protocol.capabilities?.features.includes("versioned-artifacts")) {
        throw new Error(
          `Workflow Protocol artifact ${schema.id}.${artifact.id} requires versioned-artifacts capability`
        );
      }
    }
    for (const evidence of schema.evidence) {
      if (!evidence || typeof evidence !== "object" || typeof evidence.id !== "string" || evidence.id.length === 0 || typeof evidence.required !== "boolean") {
        throw new Error(
          `Workflow Protocol Output Schema ${schema.id} has invalid evidence`
        );
      }
    }
  }
  const nodeIds = /* @__PURE__ */ new Set();
  const decisionIds = /* @__PURE__ */ new Set();
  for (const node of protocol.nodes) {
    if (!node || typeof node !== "object") {
      throw new Error("Workflow Protocol Nodes must be objects");
    }
    if (typeof node.id !== "string" || node.id.length === 0) {
      throw new Error("Workflow Protocol Node id is required");
    }
    if (nodeIds.has(node.id)) {
      throw new Error(`Workflow Protocol has duplicate Node: ${node.id}`);
    }
    nodeIds.add(node.id);
    if (typeof node.disabled !== "boolean") {
      throw new Error(
        `Workflow Protocol Node ${node.id} disabled flag is invalid`
      );
    }
    bindingIsValid(node.implementation, node.id, "implementation");
    if (!Array.isArray(node.requiredSkillCalls)) {
      throw new Error(
        `Workflow Protocol Node ${node.id} required Skill calls must be an array`
      );
    }
    if (!Array.isArray(node.augmentations)) {
      throw new Error(
        `Workflow Protocol Node ${node.id} augmentations must be an array`
      );
    }
    if (!Array.isArray(node.outputSchemas)) {
      throw new Error(
        `Workflow Protocol Node ${node.id} Output Schemas must be an array`
      );
    }
    if (!Array.isArray(node.guardrails)) {
      throw new Error(
        `Workflow Protocol Node ${node.id} guardrails must be an array`
      );
    }
    for (const binding of node.requiredSkillCalls) {
      bindingIsValid(binding, node.id, "required Skill call");
    }
    for (const binding of node.augmentations) {
      bindingIsValid(binding, node.id, "augmentation");
    }
    for (const guardrail of node.guardrails) {
      if (!guardrail || typeof guardrail !== "object" || typeof guardrail.id !== "string" || guardrail.id.length === 0 || typeof guardrail.label !== "string" || guardrail.label.length === 0) {
        throw new Error(
          `Workflow Protocol Node ${node.id} guardrail must have an id and label`
        );
      }
    }
    for (const schemaId of node.outputSchemas) {
      if (!schemaIds.has(schemaId)) {
        throw new Error(
          `Workflow Protocol Node ${node.id} references missing Output Schema: ${schemaId}`
        );
      }
    }
    if (node.kind === "decision") {
      validateDecisionDefinition(node.decision, node.id);
      const decisionId = node.decision.id;
      if (decisionIds.has(decisionId)) {
        throw new Error(
          `Workflow Protocol has duplicate decision id: ${decisionId}`
        );
      }
      decisionIds.add(decisionId);
    } else if (node.decision !== void 0) {
      throw new Error(
        `Workflow Protocol Node ${node.id} has a decision definition but is not a decision Node`
      );
    }
  }
  for (const transition of protocol.edges) {
    if (!transition || typeof transition !== "object") {
      throw new Error("Workflow Protocol transitions must be objects");
    }
    if (typeof transition.from !== "string" || transition.from.length === 0) {
      throw new Error("Workflow Protocol transition source is required");
    }
    if (transition.to !== null && typeof transition.to !== "string") {
      throw new Error("Workflow Protocol transition target is invalid");
    }
    if (transition.condition !== "success" && transition.condition !== "failure" && transition.condition !== "pause") {
      throw new Error(
        `Workflow Protocol transition condition is unsupported: ${String(transition.condition)}`
      );
    }
  }
  if (protocol.cycles !== void 0 && !Array.isArray(protocol.cycles)) {
    throw new Error("Workflow Protocol cycles must be an array");
  }
  for (const cycle of protocol.cycles ?? []) {
    if (!cycle || typeof cycle !== "object") {
      throw new Error("Workflow Protocol Cycle declarations must be objects");
    }
    const cycleKeys = /* @__PURE__ */ new Set([
      "key",
      "entry",
      "repeatTransitions",
      "maxInstances"
    ]);
    const unknown = Object.keys(cycle).find((key) => !cycleKeys.has(key));
    if (unknown) {
      throw new Error(`Workflow Protocol Cycle has unknown field: ${unknown}`);
    }
    if (typeof cycle.key !== "string" || cycle.key.length === 0) {
      throw new Error("Workflow Protocol Cycle key is required");
    }
    if (typeof cycle.entry !== "string" || cycle.entry.length === 0) {
      throw new Error(
        `Workflow Protocol Cycle ${cycle.key} entry Node is required`
      );
    }
    if (!Array.isArray(cycle.repeatTransitions)) {
      throw new Error(
        `Workflow Protocol Cycle ${cycle.key} repeatTransitions must be an array`
      );
    }
    if (!Number.isSafeInteger(cycle.maxInstances) || cycle.maxInstances < 1) {
      throw new Error(
        `Workflow Protocol Cycle ${cycle.key} maxInstances must be a finite positive integer`
      );
    }
    for (const repeat of cycle.repeatTransitions) {
      if (!repeat || typeof repeat !== "object" || typeof repeat.from !== "string" || typeof repeat.to !== "string") {
        throw new Error(
          `Workflow Protocol Cycle ${cycle.key} repeat transitions must name from and to Nodes`
        );
      }
      const repeatKeys = /* @__PURE__ */ new Set(["from", "to"]);
      const unknownRepeat = Object.keys(repeat).find(
        (key) => !repeatKeys.has(key)
      );
      if (unknownRepeat) {
        throw new Error(
          `Workflow Protocol Cycle ${cycle.key} repeat transition has unknown field: ${unknownRepeat}`
        );
      }
    }
  }
}
function transitionFor(transitions, from, condition) {
  const matches = transitions.filter(
    (transition) => transition.from === from && transition.condition === condition
  );
  if (matches.length > 1) {
    throw new Error(
      `Unsupported Workflow Protocol: ambiguous ${condition} transitions from Node ${from}`
    );
  }
  return matches[0];
}
function validateLinearRoute(protocol) {
  const active = activeNodes2(protocol);
  const activeIds = new Set(active.map((node) => node.id));
  const evaluation = protocol.evals?.[0];
  if ((protocol.evals?.length ?? 0) > 1) {
    throw new Error(
      "Unsupported Workflow Protocol: multiple evaluation routes are not supported"
    );
  }
  if ((evaluation?.expectedRoutes?.length ?? 0) > 1) {
    throw new Error(
      "Unsupported Workflow Protocol: ambiguous Workflow routes are not supported"
    );
  }
  const expectedOrder = evaluation?.expectedNodeOrder ?? evaluation?.expectedRoutes?.[0]?.nodeOrder ?? active.map((node) => node.id);
  if (!Array.isArray(expectedOrder)) {
    throw new Error(
      "Unsupported Workflow Protocol: expected Node order must be an array"
    );
  }
  if (new Set(expectedOrder).size !== expectedOrder.length) {
    throw new Error(
      "Unsupported Workflow Protocol: repeated Workflow Node visits are not supported"
    );
  }
  if (evaluation?.expectedRoutes?.[0] && JSON.stringify(evaluation.expectedRoutes[0].nodeOrder) !== JSON.stringify(expectedOrder)) {
    throw new Error(
      "Unsupported Workflow Protocol: route order does not match expected Node order"
    );
  }
  if (expectedOrder.some((nodeId) => !activeIds.has(nodeId))) {
    throw new Error(
      "Unsupported Workflow Protocol: route contains an unknown or disabled Node"
    );
  }
  if (expectedOrder.length !== active.length) {
    throw new Error(
      "Unsupported Workflow Protocol: active Nodes must use one declared linear route"
    );
  }
  const ordered = expectedOrder.map(
    (nodeId) => active.find((node) => node.id === nodeId)
  );
  const nodeById = new Map(protocol.nodes.map((node) => [node.id, node]));
  for (const transition of protocol.edges) {
    if (!nodeById.has(transition.from)) {
      throw new Error(
        `Unsupported Workflow Protocol: transition references unknown Node ${transition.from}`
      );
    }
    if (transition.to !== null && !nodeById.has(transition.to)) {
      throw new Error(
        `Unsupported Workflow Protocol: transition references unknown Node ${transition.to}`
      );
    }
    if (transition.when !== void 0) {
      throw new Error(
        `Unsupported Workflow Protocol: conditional transition from Node ${transition.from}`
      );
    }
    if (!activeIds.has(transition.from)) continue;
    if (transition.condition !== "success" && transition.to !== transition.from) {
      throw new Error(
        `Unsupported Workflow Protocol: ${transition.condition} transition from Node ${transition.from} must self-loop`
      );
    }
  }
  const visited = /* @__PURE__ */ new Set();
  const visiting = /* @__PURE__ */ new Set();
  const visitSuccessRoute = (nodeId) => {
    if (visiting.has(nodeId)) {
      throw new Error(
        "Unsupported Workflow Protocol: success route contains a cycle"
      );
    }
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    const success = transitionFor(protocol.edges, nodeId, "success");
    if (success?.to !== null && success?.to !== void 0) {
      visitSuccessRoute(success.to);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const node of active) visitSuccessRoute(node.id);
  function nextActiveNode(nodeId, seen = /* @__PURE__ */ new Set()) {
    if (seen.has(nodeId)) {
      throw new Error(
        "Unsupported Workflow Protocol: success route contains a cycle"
      );
    }
    seen.add(nodeId);
    const success = transitionFor(protocol.edges, nodeId, "success");
    if (!success) {
      throw new Error(
        `Unsupported Workflow Protocol: Node ${nodeId} has no success transition`
      );
    }
    if (success.to === null) return null;
    const target = nodeById.get(success.to);
    if (!target) {
      throw new Error(
        `Unsupported Workflow Protocol: transition references unknown Node ${success.to}`
      );
    }
    return target.disabled ? nextActiveNode(target.id, seen) : target.id;
  }
  for (const [index, node] of ordered.entries()) {
    const expectedNext = ordered[index + 1]?.id ?? null;
    if (nextActiveNode(node.id) !== expectedNext) {
      throw new Error(
        `Unsupported Workflow Protocol: success route from Node ${node.id} is not linear`
      );
    }
  }
  return ordered;
}
function compileDefinition(protocol, nodes, linear) {
  const steps = nodes.map((node, index) => ({
    id: stepId(index, node.id),
    action: {
      ...node.decision ? {
        type: "ask_user",
        decisionId: node.decision.id,
        question: node.decision.question,
        choices: node.decision.choices.map((choice) => ({
          id: choice.id,
          label: choice.label,
          ...choice.inputs ? { requiredInputs: structuredClone(choice.inputs) } : {}
        })),
        requiredInputs: structuredClone(
          node.decision.inputs ?? { type: "object", fields: [] }
        ),
        rationale: {
          required: node.decision.rationale?.required ?? false
        },
        reviewer: {
          subjects: [...node.decision.reviewer?.subjects ?? []],
          authorities: [...node.decision.reviewer?.authorities ?? []]
        }
      } : {
        type: "invoke_skill",
        ref: nodeSkillName(protocol.name, node.id)
      }
    },
    ...linear && nodes[index + 1] ? { next: stepId(index + 1, nodes[index + 1].id) } : {}
  }));
  if (steps.length === 0) {
    steps.push({
      id: "terminal-checkpoint",
      action: { type: "checkpoint" }
    });
  }
  const skills = compiledSkillIds(protocol, nodes).map(
    (id) => ({ id })
  );
  return {
    apiVersion: "comet/v1alpha1",
    kind: "Skill",
    metadata: {
      name: protocol.name,
      version: "1.0.0",
      description: protocol.goal
    },
    goal: {
      statement: protocol.goal,
      inputs: [],
      outputs: [],
      success: []
    },
    orchestration: {
      mode: "deterministic",
      entry: steps[0].id,
      steps
    },
    skills,
    agents: [],
    tools: []
  };
}
function compileGuardrails(protocol, nodes) {
  return {
    allowedSkills: compiledSkillIds(protocol, nodes),
    allowedAgents: [],
    allowedTools: [],
    maxIterations: maxWorkflowIterations(protocol),
    maxRetriesPerAction: 3,
    confirmationRequiredFor: []
  };
}
function compileCompletionPlans(nodes) {
  return Object.fromEntries(
    nodes.map((node) => [node.id, createCompletionPlan(node)])
  );
}
async function compileWorkflow(protocol) {
  validateProtocolShape(protocol);
  validateWorkflowDecisionScopeDefinition(protocol);
  const revisioned = isRevisionedWorkflowProtocol(protocol);
  if (revisioned && protocol.capabilities?.version !== 3) {
    throw new Error(
      "Workflow Protocol revisioned capabilities are required for branch routing"
    );
  }
  if (revisioned) validateRevisionedWorkflow(protocol);
  const nodes = revisioned ? activeNodes2(protocol) : validateLinearRoute(protocol);
  const definition = compileDefinition(protocol, nodes, !revisioned);
  const nodeToStep = Object.fromEntries(
    nodes.map((node, index) => [node.id, stepId(index, node.id)])
  );
  const protocolHash = hashProtocol(protocol);
  const runtime = {
    protocolHash,
    protocol: structuredClone(protocol),
    nodeToStep: { ...nodeToStep },
    ...revisioned ? { capabilityVersion: 3, resolverHash: resolverHash(protocol) } : {},
    findingCatalogVersion: WORKFLOW_FINDING_CATALOG_VERSION,
    completionPlans: compileCompletionPlans(nodes)
  };
  const pkg = {
    root: process.cwd(),
    packageKind: "runtime",
    runtime,
    definition,
    guardrails: compileGuardrails(protocol, nodes),
    evals: []
  };
  const packageErrors = validateSkillPackage(pkg);
  if (packageErrors.length > 0) {
    throw new Error(
      `Compiled WorkflowRuntime package is invalid:
${packageErrors.map((error) => `  - ${error}`).join("\n")}`
    );
  }
  const packageHash = await hashSkillPackage(pkg);
  return {
    package: deepFreeze(pkg),
    identity: {
      protocolHash,
      packageHash,
      snapshotHash: "",
      nodeToStep,
      ...revisioned ? {
        capabilityVersion: 3,
        resolverHash: resolverHash(protocol)
      } : {},
      findingCatalogVersion: WORKFLOW_FINDING_CATALOG_VERSION
    }
  };
}

// src/workflow-runtime/resolver.ts
function stepFor(pkg, stepId2) {
  return pkg.definition.orchestration.steps?.find((step) => step.id === stepId2);
}
function nodeForStep(pkg, stepId2) {
  if (!pkg.runtime || !stepId2) return void 0;
  return Object.entries(pkg.runtime.nodeToStep).find(
    ([, compiledStepId]) => compiledStepId === stepId2
  )?.[0];
}
var workflowDeterministicResolver = {
  resolveStep({
    pkg,
    state
  }) {
    return stepFor(pkg, state.currentStep);
  },
  prepareStep({ pkg, state, step }) {
    if (!pkg.runtime?.protocol.cycles || !state.workflowRuntime) {
      return void 0;
    }
    const nodeId = nodeForStep(pkg, step.id);
    if (!nodeId) {
      throw new Error(`WorkflowRuntime step has no Node identity: ${step.id}`);
    }
    return prepareWorkflowCycleEntry(
      pkg.runtime.protocol,
      state.runId,
      state.workflowRuntime,
      nodeId
    );
  },
  resolveTransition({
    pkg,
    state,
    step,
    outcome
  }) {
    if (!pkg.runtime || !isRevisionedWorkflowProtocol(pkg.runtime.protocol)) {
      return { next: step.next ?? null };
    }
    const nodeId = nodeForStep(pkg, step.id);
    if (!nodeId) {
      if (step.action.type === "checkpoint") return { next: null };
      throw new Error(`WorkflowRuntime step has no Node identity: ${step.id}`);
    }
    const resolved = resolveWorkflowTransition(
      pkg.runtime.protocol,
      nodeId,
      outcome,
      state.workflowRuntime,
      state.runId
    );
    const nextNode = resolved.next;
    const workflowRuntime = resolved.workflowRuntime;
    if (nextNode === null) {
      return {
        next: null,
        ...workflowRuntime ? { workflowRuntime } : {}
      };
    }
    const nextStep = pkg.runtime.nodeToStep[nextNode];
    if (!nextStep) {
      throw new Error(
        `WorkflowRuntime next Node has no step identity: ${nextNode}`
      );
    }
    return {
      next: nextStep,
      ...workflowRuntime ? { workflowRuntime } : {}
    };
  },
  resolveNext({ pkg, state, step, outcome }) {
    const transition = this.resolveTransition({
      pkg,
      state,
      step,
      outcome,
      context: void 0
    });
    return transition.next;
  }
};
function resolverForPackage() {
  return workflowDeterministicResolver;
}

// src/workflow-runtime/location.ts
import { randomUUID as randomUUID4 } from "node:crypto";

// src/engine/manual-run.ts
import { randomUUID as randomUUID3 } from "crypto";

// src/engine/evals.ts
function evaluateRuntime(definitions, scope, state, artifacts) {
  return definitions.filter((definition) => definition.scope === scope).map((definition) => {
    if (definition.type === "artifact_exists") {
      const value2 = definition.artifact ? artifacts[definition.artifact] : void 0;
      return {
        evalId: definition.id,
        passed: Boolean(value2),
        evidence: value2 ? `artifact ${definition.artifact} -> ${value2}` : `artifact ${definition.artifact ?? "(missing)"} not found`
      };
    }
    const value = definition.field ? state[definition.field] : void 0;
    return {
      evalId: definition.id,
      passed: String(value) === definition.equals,
      evidence: `state.${definition.field ?? "(missing)"} = ${String(value)}`
    };
  });
}

// src/engine/loop.ts
import { createHash as createHash3 } from "crypto";

// src/engine/guardrails.ts
function checkAction(action, state, guardrails, confirmations) {
  if (state.iteration >= guardrails.maxIterations) {
    return {
      allowed: false,
      reason: `Iteration budget exhausted: ${guardrails.maxIterations}`
    };
  }
  if (action.type === "invoke_skill" && !guardrails.allowedSkills.includes(action.ref ?? "")) {
    return {
      allowed: false,
      reason: `Skill is not allowed: ${action.ref ?? "(missing)"}`
    };
  }
  if (action.type === "call_tool" && !guardrails.allowedTools.includes(action.ref ?? "")) {
    return {
      allowed: false,
      reason: `Tool is not allowed: ${action.ref ?? "(missing)"}`
    };
  }
  if (action.type === "handoff" && !guardrails.allowedAgents.includes(action.ref ?? "")) {
    return {
      allowed: false,
      reason: `Agent is not allowed: ${action.ref ?? "(missing)"}`
    };
  }
  if (action.ref && guardrails.confirmationRequiredFor.includes(action.ref) && !confirmations.has(action.ref)) {
    return {
      allowed: false,
      reason: `User confirmation required for: ${action.ref}`
    };
  }
  const retryKey = action.attemptId ?? action.id;
  const retries = state.retries[retryKey] ?? 0;
  if (retries > guardrails.maxRetriesPerAction) {
    return {
      allowed: false,
      reason: `Retry budget exhausted for action: ${retryKey}`
    };
  }
  return { allowed: true };
}

// src/engine/resolver.ts
function deepFreeze2(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value))
    return value;
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze2(value[key]);
  }
  return Object.freeze(value);
}
function readonlyCopy(value) {
  return deepFreeze2(structuredClone(value));
}
function resolveDeterministicStep(resolver, pkg, state, context) {
  return resolver.resolveStep({
    pkg: readonlyCopy(pkg),
    state: readonlyCopy(state),
    context: readonlyCopy(context)
  });
}
function prepareDeterministicStep(resolver, pkg, state, step, context) {
  if (!resolver.prepareStep) return void 0;
  return resolver.prepareStep({
    pkg: readonlyCopy(pkg),
    state: readonlyCopy(state),
    step: readonlyCopy(step),
    context: readonlyCopy(context)
  });
}
function resolveDeterministicTransition(resolver, pkg, state, step, outcome, context) {
  const input = {
    pkg: readonlyCopy(pkg),
    state: readonlyCopy(state),
    step: readonlyCopy(step),
    outcome: readonlyCopy(outcome),
    context: readonlyCopy(context)
  };
  return resolver.resolveTransition ? resolver.resolveTransition(input) : { next: resolver.resolveNext(input) };
}
var staticDeterministicResolver = {
  resolveStep({ pkg, state }) {
    return pkg.definition.orchestration.steps?.find(
      (step) => step.id === state.currentStep
    );
  },
  resolveNext({ step }) {
    return step.next ?? null;
  }
};

// src/engine/loop.ts
function actionId(runId, iteration, stepId2, attempt) {
  const context = attempt ? `${runId}:${iteration}:${stepId2 ?? "adaptive"}:${attempt.id}:retry:${attempt.retryOrdinal}` : `${runId}:${iteration}:${stepId2 ?? "adaptive"}`;
  return createHash3("sha256").update(context).digest("hex").slice(0, 16);
}
function attemptId(runId, stepId2, visitOrdinal, cycleId) {
  return `attempt-${createHash3("sha256").update(`${runId}:${stepId2}:${visitOrdinal}:cycle:${cycleId ?? "none"}`).digest("hex").slice(0, 24)}`;
}
function applyPreparedWorkflowState(state, prepared) {
  if (!state.workflowRuntime) return state;
  return {
    ...state,
    workflowRuntime: {
      ...state.workflowRuntime,
      currentCycle: prepared.currentCycle,
      cycles: prepared.cycles
    }
  };
}
function nodeIdForStep(pkg, stepId2) {
  return Object.entries(pkg.runtime?.nodeToStep ?? {}).find(
    ([, candidate]) => candidate === stepId2
  )?.[0];
}
function enterAttempt(state, stepId2) {
  if (!state.workflowRuntime) {
    return state;
  }
  if (state.workflowRuntime.currentAttempt) {
    if (state.workflowRuntime.currentAttempt.stepId !== stepId2) {
      throw new Error("WorkflowRuntime current Attempt does not match step");
    }
    return state;
  }
  const workflowRuntime = structuredClone(
    state.workflowRuntime
  );
  workflowRuntime.decisionReceipts ??= [];
  workflowRuntime.artifactVersions ??= [];
  workflowRuntime.artifactSelections ??= [];
  workflowRuntime.currentCycle ??= null;
  workflowRuntime.cycles ??= [];
  const visitOrdinal = workflowRuntime.nextVisitOrdinal + 1;
  const currentAttempt = {
    id: attemptId(
      state.runId,
      stepId2,
      visitOrdinal,
      workflowRuntime.currentCycle?.id ?? null
    ),
    stepId: stepId2,
    cycleId: workflowRuntime.currentCycle?.id ?? null,
    visitOrdinal,
    retryOrdinal: 0
  };
  workflowRuntime.nextVisitOrdinal = visitOrdinal;
  workflowRuntime.currentAttempt = currentAttempt;
  workflowRuntime.visits.push({
    attemptId: currentAttempt.id,
    stepId: stepId2,
    cycleId: currentAttempt.cycleId,
    visitOrdinal,
    outcomes: []
  });
  return { ...state, workflowRuntime };
}
function recordWorkflowOutcome(pkg, state, outcome) {
  if (!state.workflowRuntime) return void 0;
  const workflowRuntime = structuredClone(
    state.workflowRuntime
  );
  workflowRuntime.decisionReceipts ??= [];
  workflowRuntime.artifactVersions ??= [];
  workflowRuntime.artifactSelections ??= [];
  workflowRuntime.currentCycle ??= null;
  workflowRuntime.cycles ??= [];
  const attempt = workflowRuntime.currentAttempt;
  if (!attempt) {
    throw new Error("WorkflowRuntime current Attempt is missing");
  }
  const visit = workflowRuntime.visits.find(
    (candidate) => candidate.attemptId === attempt.id
  );
  if (!visit) {
    throw new Error(
      "WorkflowRuntime current Attempt is not in the visit ledger"
    );
  }
  const receipt = decisionReceipt(pkg, state, outcome);
  const visitOutcome = {
    actionId: outcome.actionId,
    status: outcome.status,
    summary: outcome.summary,
    retryOrdinal: attempt.retryOrdinal,
    ...outcome.routing ? { routing: { ...outcome.routing } } : {},
    ...outcome.evidence ? { evidence: structuredClone(outcome.evidence) } : {},
    ...outcome.artifactVersions ? { artifactVersions: { ...outcome.artifactVersions } } : {}
  };
  visit.outcomes.push(visitOutcome);
  workflowRuntime.revision += 1;
  if (receipt) workflowRuntime.decisionReceipts.push(receipt);
  if (outcome.status === "failed") {
    attempt.retryOrdinal += 1;
  } else {
    workflowRuntime.currentAttempt = null;
  }
  return workflowRuntime;
}
function decisionReceipt(pkg, state, outcome) {
  if (outcome.kind !== "decision") return void 0;
  if (outcome.status !== "succeeded") {
    throw new Error("Decision responses must succeed");
  }
  const runtimeState = state.workflowRuntime;
  const attempt = runtimeState?.currentAttempt;
  const identity = state.runtimeIdentity;
  if (!runtimeState || !attempt || !identity || !pkg.runtime) {
    throw new Error(
      "Decision receipt requires WorkflowRuntime identity and Attempt"
    );
  }
  if (outcome.revision !== runtimeState.revision) {
    throw new Error("Decision response revision does not match Run revision");
  }
  const nodeId = outcome.nodeId;
  if (nodeId === void 0 || nodeId !== nodeIdForStep(pkg, attempt.stepId)) {
    throw new Error("Decision receipt Node identity is invalid");
  }
  if (outcome.attemptId !== attempt.id) {
    throw new Error("Decision receipt Attempt identity is invalid");
  }
  if ((outcome.cycleId ?? null) !== attempt.cycleId) {
    throw new Error("Decision receipt Cycle identity is invalid");
  }
  if (!outcome.decisionId || !outcome.choiceId || !outcome.reviewer) {
    throw new Error("Decision receipt fields are incomplete");
  }
  return {
    runId: state.runId,
    revision: runtimeState.revision,
    resultingRevision: runtimeState.revision + 1,
    actionId: outcome.actionId,
    decisionId: outcome.decisionId,
    nodeId,
    cycleId: attempt.cycleId,
    attemptId: attempt.id,
    choiceId: outcome.choiceId,
    reviewer: structuredClone(outcome.reviewer),
    inputs: structuredClone(outcome.inputs ?? {}),
    ...outcome.rationale !== void 0 ? { rationale: outcome.rationale } : {},
    ...outcome.evidenceReferences ? { evidenceReferences: [...outcome.evidenceReferences] } : {},
    ...outcome.scope ? { scope: structuredClone(outcome.scope) } : {},
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    protocolHash: identity.protocolHash,
    packageHash: identity.packageHash,
    snapshotHash: identity.snapshotHash
  };
}
function stepFor2(pkg, id) {
  return pkg.definition.orchestration.steps?.find((step) => step.id === id);
}
function startRun(pkg, runId, skillHash, workflowRuntime) {
  return {
    runId,
    skill: pkg.definition.metadata.name,
    skillVersion: pkg.definition.metadata.version,
    skillHash,
    orchestration: pkg.definition.orchestration.mode,
    currentStep: pkg.definition.orchestration.entry ?? null,
    iteration: 0,
    pending: null,
    pendingRef: ".comet/pending-action.json",
    trajectoryRef: ".comet/trajectory.jsonl",
    contextRef: ".comet/context.md",
    artifactsRef: ".comet/artifacts.json",
    checkpointRef: ".comet/checkpoint.json",
    status: "running",
    retries: {},
    ...workflowRuntime ? { workflowRuntime: structuredClone(workflowRuntime) } : {}
  };
}
function decideWithResolver(pkg, state, confirmations, resolver, context) {
  if (state.status !== "running")
    return { state, action: null, reason: `Run is ${state.status}` };
  if (state.pending)
    return {
      state,
      action: null,
      reason: `Action already pending: ${state.pending}`
    };
  if (state.orchestration === "adaptive") {
    return {
      state,
      action: null,
      reason: "Adaptive orchestration requires an Agent candidate"
    };
  }
  const resolvedStep = resolveDeterministicStep(resolver, pkg, state, context);
  if (!resolvedStep && state.currentStep === null) {
    return { state: { ...state, status: "completed" }, action: null };
  }
  if (!resolvedStep) {
    return {
      state: { ...state, status: "failed" },
      action: null,
      reason: `Unknown current step: ${state.currentStep}`
    };
  }
  const step = stepFor2(pkg, resolvedStep.id);
  if (!step) {
    return {
      state: { ...state, status: "failed" },
      action: null,
      reason: `Resolver returned unknown current step: ${resolvedStep.id}`
    };
  }
  const resolvedState = state.currentStep === step.id ? state : { ...state, currentStep: step.id };
  const prepared = prepareDeterministicStep(
    resolver,
    pkg,
    resolvedState,
    step,
    context
  );
  const attemptState = enterAttempt(
    prepared ? applyPreparedWorkflowState(resolvedState, prepared) : resolvedState,
    step.id
  );
  const action = {
    ...step.action,
    id: actionId(
      attemptState.runId,
      attemptState.iteration,
      step.id,
      attemptState.workflowRuntime?.currentAttempt ?? null
    ),
    stepId: step.id,
    ...attemptState.workflowRuntime?.currentAttempt ? {
      attemptId: attemptState.workflowRuntime.currentAttempt.id,
      cycleId: attemptState.workflowRuntime.currentAttempt.cycleId,
      visitOrdinal: attemptState.workflowRuntime.currentAttempt.visitOrdinal,
      retryOrdinal: attemptState.workflowRuntime.currentAttempt.retryOrdinal
    } : {}
  };
  return acceptAction(pkg, attemptState, action, confirmations, state);
}
function acceptAction(pkg, state, action, confirmations, rejectedState = state) {
  const guard = checkAction(action, state, pkg.guardrails, confirmations);
  if (!guard.allowed) {
    return { state: rejectedState, action: null, reason: guard.reason };
  }
  return { state: { ...state, pending: action.id, status: "waiting" }, action };
}
function recordOutcomeWithResolver(pkg, state, outcome, resolver, context) {
  if (!state.pending || state.pending !== outcome.actionId) {
    throw new Error(
      `Outcome does not match pending action: ${outcome.actionId}`
    );
  }
  if (state.status === "completed" || state.status === "failed") {
    throw new Error(`Run is ${state.status}`);
  }
  const resolvedStep = state.orchestration === "deterministic" ? resolveDeterministicStep(resolver, pkg, state, context) : void 0;
  const step = resolvedStep ? stepFor2(pkg, resolvedStep.id) : void 0;
  if (state.orchestration === "deterministic" && !resolvedStep) {
    throw new Error(
      `Unknown current step: ${state.currentStep ?? "(missing)"}`
    );
  }
  if (state.orchestration === "deterministic" && !step) {
    throw new Error(
      `Resolver returned unknown current step: ${resolvedStep.id}`
    );
  }
  if (step?.action.type === "ask_user" && outcome.kind !== "decision") {
    throw new Error("Decision response required for pending ask_user action");
  }
  if (step?.action.type !== "ask_user" && outcome.kind === "decision") {
    throw new Error(
      `Decision response cannot satisfy ${step?.action.type ?? "unknown"} action`
    );
  }
  if (outcome.status === "failed") {
    const retryKey = state.workflowRuntime?.currentAttempt?.id ?? outcome.actionId;
    const retries = {
      ...state.retries,
      [retryKey]: (state.retries[retryKey] ?? 0) + 1
    };
    const workflowRuntime2 = recordWorkflowOutcome(pkg, state, outcome);
    return {
      ...state,
      pending: null,
      status: "running",
      retries,
      ...workflowRuntime2 ? { workflowRuntime: workflowRuntime2 } : {}
    };
  }
  const transition = state.orchestration === "deterministic" ? resolveDeterministicTransition(
    resolver,
    pkg,
    state,
    step,
    outcome,
    context
  ) : { next: state.currentStep };
  const next = transition.next;
  if (next !== null && state.orchestration === "deterministic" && !stepFor2(pkg, next)) {
    throw new Error(`Resolver returned unknown next step: ${next}`);
  }
  const workflowRuntime = recordWorkflowOutcome(pkg, state, outcome);
  if (workflowRuntime && transition.workflowRuntime) {
    workflowRuntime.currentCycle = structuredClone(
      transition.workflowRuntime.currentCycle
    );
    workflowRuntime.cycles = structuredClone(transition.workflowRuntime.cycles);
  }
  return {
    ...state,
    currentStep: next,
    iteration: state.iteration + 1,
    pending: null,
    status: next === null && state.orchestration === "deterministic" ? "completed" : "running",
    ...workflowRuntime ? { workflowRuntime } : {}
  };
}

// src/engine/state.ts
import path10 from "path";
function assertSafeRunReference(value, key) {
  const normalized = value.replaceAll("\\", "/");
  if (path10.posix.isAbsolute(normalized) || path10.win32.isAbsolute(value) || /^(?:[A-Za-z]:|[\\/]|~)/u.test(value) || /[*?]/u.test(value) || normalized.split("/").some(
    (segment) => segment.length === 0 || segment === "." || segment === ".."
  )) {
    throw new Error(
      `Invalid Run state: ${key} must stay inside the change directory`
    );
  }
}
var RUN_STATE_FILE = ".comet/run-state.json";
var RUN_STATE_MAX_BYTES = 256 * 1024;
var RUN_STATE_JSON_KEYS = /* @__PURE__ */ new Set([
  "runId",
  "skill",
  "skillVersion",
  "skillHash",
  "orchestration",
  "currentStep",
  "iteration",
  "pending",
  "pendingRef",
  "trajectoryRef",
  "contextRef",
  "artifactsRef",
  "checkpointRef",
  "status",
  "retries",
  "runtimeIdentity",
  "workflowRuntime"
]);
function requiredJsonString(value, key) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid Run state: ${key} must be a non-empty string`);
  }
  return value;
}
function nullableJsonString(value, key) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Invalid Run state: ${key} must be a non-empty string or null`
    );
  }
  return value;
}
function parseStringRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Run state: ${label} must be an object`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!key || typeof entry !== "string" || entry.length === 0) {
      throw new Error(`Invalid Run state: ${label} must contain strings`);
    }
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, entry])
  );
}
function parseJsonRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Run state: ${label} must be an object`);
  }
  try {
    JSON.stringify(value);
  } catch (error) {
    throw new Error(`Invalid Run state: ${label} must be JSON-serializable`, {
      cause: error
    });
  }
  return structuredClone(value);
}
function parseDecisionScalarRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Run state: ${label} must be an object`);
  }
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!key || entry === null) {
      throw new Error(`Invalid Run state: ${label} must contain scalar values`);
    }
    if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") {
      throw new Error(`Invalid Run state: ${label} must contain scalar values`);
    }
    if (typeof entry === "number" && !Number.isFinite(entry)) {
      throw new Error(
        `Invalid Run state: ${label} must contain finite numbers`
      );
    }
    result[key] = entry;
  }
  return result;
}
function parseReviewerAttestation(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Run state: ${label} must be an object`);
  }
  const reviewer = value;
  const unknown = Object.keys(reviewer).find(
    (key) => key !== "subject" && key !== "authorities"
  );
  if (unknown)
    throw new Error(`Invalid Run state: ${label} has unknown field ${unknown}`);
  const subject = reviewer.subject;
  if (typeof subject !== "string" || subject.length === 0) {
    throw new Error(`Invalid Run state: ${label}.subject must be non-empty`);
  }
  if (!Array.isArray(reviewer.authorities) || reviewer.authorities.length === 0 || reviewer.authorities.some(
    (authority) => typeof authority !== "string" || authority.length === 0
  )) {
    throw new Error(`Invalid Run state: ${label}.authorities must be strings`);
  }
  if (new Set(reviewer.authorities).size !== reviewer.authorities.length) {
    throw new Error(
      `Invalid Run state: ${label}.authorities must not contain duplicates`
    );
  }
  return {
    subject,
    authorities: [...reviewer.authorities]
  };
}
function parseDecisionScopeReference(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Run state: ${label} must be an object`);
  }
  const reference = value;
  const keys = /* @__PURE__ */ new Set([
    "id",
    "required",
    "versionId",
    "contentHash",
    "producer"
  ]);
  const unknown = Object.keys(reference).find((key) => !keys.has(key));
  if (unknown) {
    throw new Error(`Invalid Run state: ${label} has unknown field ${unknown}`);
  }
  const contentHash2 = requiredJsonString(
    reference.contentHash,
    `${label}.contentHash`
  );
  if (!/^[a-f0-9]{64}$/u.test(contentHash2)) {
    throw new Error(
      `Invalid Run state: ${label}.contentHash must be a SHA-256 hash`
    );
  }
  if (typeof reference.required !== "boolean") {
    throw new Error(`Invalid Run state: ${label}.required must be a boolean`);
  }
  if (!reference.producer || typeof reference.producer !== "object" || Array.isArray(reference.producer)) {
    throw new Error(`Invalid Run state: ${label}.producer must be an object`);
  }
  const producer = reference.producer;
  const producerKeys = /* @__PURE__ */ new Set([
    "runId",
    "nodeId",
    "cycleId",
    "attemptId",
    "actionId",
    "revision"
  ]);
  const unknownProducer = Object.keys(producer).find(
    (key) => !producerKeys.has(key)
  );
  if (unknownProducer) {
    throw new Error(
      `Invalid Run state: ${label}.producer has unknown field ${unknownProducer}`
    );
  }
  return {
    id: requiredJsonString(reference.id, `${label}.id`),
    required: reference.required,
    versionId: requiredJsonString(reference.versionId, `${label}.versionId`),
    contentHash: contentHash2,
    producer: parseWorkflowArtifactCoordinate(producer, `${label}.producer`)
  };
}
function parseDecisionScope2(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Run state: ${label} must be an object`);
  }
  const scope = value;
  const unknown = Object.keys(scope).find(
    (key) => key !== "artifacts" && key !== "evidence"
  );
  if (unknown) {
    throw new Error(`Invalid Run state: ${label} has unknown field ${unknown}`);
  }
  const parseEntries = (kind) => {
    if (!Array.isArray(scope[kind])) {
      throw new Error(`Invalid Run state: ${label}.${kind} must be an array`);
    }
    if (scope[kind].length > 64) {
      throw new Error(
        `Invalid Run state: ${label}.${kind} has too many entries`
      );
    }
    return scope[kind].map(
      (entry, index) => parseDecisionScopeReference(entry, `${label}.${kind}[${index}]`)
    );
  };
  return {
    artifacts: parseEntries("artifacts"),
    evidence: parseEntries("evidence")
  };
}
function parseDecisionReceipt(value, index) {
  const label = `workflowRuntime.decisionReceipts[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Run state: ${label} must be an object`);
  }
  const receipt = value;
  const keys = /* @__PURE__ */ new Set([
    "runId",
    "revision",
    "resultingRevision",
    "actionId",
    "decisionId",
    "nodeId",
    "cycleId",
    "attemptId",
    "choiceId",
    "reviewer",
    "inputs",
    "rationale",
    "evidenceReferences",
    "scope",
    "timestamp",
    "protocolHash",
    "packageHash",
    "snapshotHash"
  ]);
  const unknown = Object.keys(receipt).find((key) => !keys.has(key));
  if (unknown)
    throw new Error(`Invalid Run state: ${label} has unknown field ${unknown}`);
  const integer = (key) => {
    const entry = receipt[key];
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0) {
      throw new Error(
        `Invalid Run state: ${label}.${key} must be a non-negative integer`
      );
    }
    return entry;
  };
  const revision = integer("revision");
  const resultingRevision = integer("resultingRevision");
  if (resultingRevision !== revision + 1) {
    throw new Error(
      `Invalid Run state: ${label} revisions are not consecutive`
    );
  }
  const cycleId = receipt.cycleId;
  if (cycleId !== null && (typeof cycleId !== "string" || cycleId.length === 0)) {
    throw new Error(
      `Invalid Run state: ${label}.cycleId must be a string or null`
    );
  }
  const protocolHash = requiredJsonString(receipt.protocolHash, "protocolHash");
  const packageHash = requiredJsonString(receipt.packageHash, "packageHash");
  const snapshotHash = requiredJsonString(receipt.snapshotHash, "snapshotHash");
  for (const [key, hash] of [
    ["protocolHash", protocolHash],
    ["packageHash", packageHash],
    ["snapshotHash", snapshotHash]
  ]) {
    if (!/^[a-f0-9]{64}$/u.test(hash)) {
      throw new Error(
        `Invalid Run state: ${label}.${key} must be a SHA-256 hash`
      );
    }
  }
  if (receipt.rationale !== void 0 && typeof receipt.rationale !== "string") {
    throw new Error(`Invalid Run state: ${label}.rationale must be a string`);
  }
  let evidenceReferences;
  if (receipt.evidenceReferences !== void 0) {
    if (!Array.isArray(receipt.evidenceReferences) || receipt.evidenceReferences.some(
      (reference) => typeof reference !== "string" || reference.length === 0
    )) {
      throw new Error(
        `Invalid Run state: ${label}.evidenceReferences must be strings`
      );
    }
    evidenceReferences = [...receipt.evidenceReferences];
  }
  const scope = receipt.scope === void 0 ? void 0 : parseDecisionScope2(receipt.scope, `${label}.scope`);
  return {
    runId: requiredJsonString(receipt.runId, "runId"),
    revision,
    resultingRevision,
    actionId: requiredJsonString(receipt.actionId, "actionId"),
    decisionId: requiredJsonString(receipt.decisionId, "decisionId"),
    nodeId: requiredJsonString(receipt.nodeId, "nodeId"),
    cycleId,
    attemptId: requiredJsonString(receipt.attemptId, "attemptId"),
    choiceId: requiredJsonString(receipt.choiceId, "choiceId"),
    reviewer: parseReviewerAttestation(receipt.reviewer, `${label}.reviewer`),
    inputs: parseDecisionScalarRecord(receipt.inputs, `${label}.inputs`),
    ...receipt.rationale !== void 0 ? { rationale: receipt.rationale } : {},
    ...evidenceReferences ? { evidenceReferences } : {},
    ...scope ? { scope } : {},
    timestamp: requiredJsonString(receipt.timestamp, "timestamp"),
    protocolHash,
    packageHash,
    snapshotHash
  };
}
function parseWorkflowCycle(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Run state: ${label} must be an object`);
  }
  const cycle = value;
  const keys = /* @__PURE__ */ new Set(["id", "key", "instanceOrdinal"]);
  const unknown = Object.keys(cycle).find((key) => !keys.has(key));
  if (unknown)
    throw new Error(`Invalid Run state: ${label} has unknown field ${unknown}`);
  const instanceOrdinal = cycle.instanceOrdinal;
  if (typeof instanceOrdinal !== "number" || !Number.isSafeInteger(instanceOrdinal) || instanceOrdinal < 1) {
    throw new Error(
      `Invalid Run state: ${label}.instanceOrdinal must be a positive integer`
    );
  }
  return {
    id: requiredJsonString(cycle.id, `${label}.id`),
    key: requiredJsonString(cycle.key, `${label}.key`),
    instanceOrdinal
  };
}
function parseWorkflowAttempt(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Run state: ${label} must be an object`);
  }
  const attempt = value;
  const keys = /* @__PURE__ */ new Set([
    "id",
    "stepId",
    "cycleId",
    "visitOrdinal",
    "retryOrdinal"
  ]);
  const unknown = Object.keys(attempt).find((key) => !keys.has(key));
  if (unknown)
    throw new Error(`Invalid Run state: ${label} has unknown field ${unknown}`);
  const id = requiredJsonString(
    attempt.id,
    `${label}.id`
  );
  const stepId2 = requiredJsonString(
    attempt.stepId,
    `${label}.stepId`
  );
  const cycleId = attempt.cycleId === void 0 ? null : attempt.cycleId;
  if (cycleId !== null && (typeof cycleId !== "string" || cycleId.length === 0)) {
    throw new Error(
      `Invalid Run state: ${label}.cycleId must be a string or null`
    );
  }
  const visitOrdinal = attempt.visitOrdinal;
  const retryOrdinal = attempt.retryOrdinal;
  if (typeof visitOrdinal !== "number" || !Number.isSafeInteger(visitOrdinal) || visitOrdinal < 1) {
    throw new Error(
      `Invalid Run state: ${label}.visitOrdinal must be a positive integer`
    );
  }
  if (typeof retryOrdinal !== "number" || !Number.isSafeInteger(retryOrdinal) || retryOrdinal < 0) {
    throw new Error(
      `Invalid Run state: ${label}.retryOrdinal must be a non-negative integer`
    );
  }
  return {
    id,
    stepId: stepId2,
    cycleId,
    visitOrdinal,
    retryOrdinal
  };
}
function parseWorkflowOutcome(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Run state: ${label} must be an object`);
  }
  const outcome = value;
  const keys = /* @__PURE__ */ new Set([
    "actionId",
    "status",
    "summary",
    "retryOrdinal",
    "routing",
    "evidence",
    "artifactVersions"
  ]);
  const unknown = Object.keys(outcome).find((key) => !keys.has(key));
  if (unknown)
    throw new Error(`Invalid Run state: ${label} has unknown field ${unknown}`);
  const actionId2 = requiredJsonString(
    outcome.actionId,
    `${label}.actionId`
  );
  const summary = requiredJsonString(
    outcome.summary,
    `${label}.summary`
  );
  if (outcome.status !== "succeeded" && outcome.status !== "failed") {
    throw new Error(`Invalid Run state: ${label}.status is invalid`);
  }
  const retryOrdinal = outcome.retryOrdinal;
  if (typeof retryOrdinal !== "number" || !Number.isSafeInteger(retryOrdinal) || retryOrdinal < 0) {
    throw new Error(
      `Invalid Run state: ${label}.retryOrdinal must be a non-negative integer`
    );
  }
  return {
    actionId: actionId2,
    status: outcome.status,
    summary,
    retryOrdinal,
    ...outcome.routing !== void 0 ? { routing: parseStringRecord(outcome.routing, `${label}.routing`) } : {},
    ...outcome.evidence !== void 0 ? { evidence: parseJsonRecord(outcome.evidence, `${label}.evidence`) } : {},
    ...outcome.artifactVersions !== void 0 ? {
      artifactVersions: parseStringRecord(
        outcome.artifactVersions,
        `${label}.artifactVersions`
      )
    } : {}
  };
}
function parseWorkflowVisit(value, index) {
  const label = `workflowRuntime.visits[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Run state: ${label} must be an object`);
  }
  const visit = value;
  const keys = /* @__PURE__ */ new Set([
    "attemptId",
    "stepId",
    "cycleId",
    "visitOrdinal",
    "outcomes"
  ]);
  const unknown = Object.keys(visit).find((key) => !keys.has(key));
  if (unknown)
    throw new Error(`Invalid Run state: ${label} has unknown field ${unknown}`);
  const attemptId2 = requiredJsonString(
    visit.attemptId,
    `${label}.attemptId`
  );
  const stepId2 = requiredJsonString(
    visit.stepId,
    `${label}.stepId`
  );
  const cycleId = visit.cycleId === void 0 ? null : visit.cycleId;
  if (cycleId !== null && (typeof cycleId !== "string" || cycleId.length === 0)) {
    throw new Error(
      `Invalid Run state: ${label}.cycleId must be a string or null`
    );
  }
  const visitOrdinal = visit.visitOrdinal;
  if (typeof visitOrdinal !== "number" || !Number.isSafeInteger(visitOrdinal) || visitOrdinal < 1) {
    throw new Error(
      `Invalid Run state: ${label}.visitOrdinal must be a positive integer`
    );
  }
  if (!Array.isArray(visit.outcomes)) {
    throw new Error(`Invalid Run state: ${label}.outcomes must be an array`);
  }
  return {
    attemptId: attemptId2,
    stepId: stepId2,
    cycleId,
    visitOrdinal,
    outcomes: visit.outcomes.map(
      (outcome, outcomeIndex) => parseWorkflowOutcome(outcome, `${label}.outcomes[${outcomeIndex}]`)
    )
  };
}
function parseWorkflowArtifactLifetime(value, label) {
  if (value !== "attempt" && value !== "cycle" && value !== "run") {
    throw new Error(`Invalid Run state: ${label} must be a valid lifetime`);
  }
  return value;
}
function parseWorkflowArtifactProducer(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Run state: ${label} must be an object`);
  }
  const producer = value;
  const keys = /* @__PURE__ */ new Set([
    "runId",
    "nodeId",
    "cycleId",
    "attemptId",
    "actionId",
    "revision"
  ]);
  const unknown = Object.keys(producer).find((key) => !keys.has(key));
  if (unknown) {
    throw new Error(`Invalid Run state: ${label} has unknown field ${unknown}`);
  }
  return parseWorkflowArtifactCoordinate(producer, label);
}
function parseWorkflowArtifactCoordinate(coordinate, label) {
  const cycleId = coordinate.cycleId;
  if (cycleId !== null && (typeof cycleId !== "string" || cycleId.length === 0)) {
    throw new Error(
      `Invalid Run state: ${label}.cycleId must be a string or null`
    );
  }
  const revision = coordinate.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error(
      `Invalid Run state: ${label}.revision must be a non-negative integer`
    );
  }
  return {
    runId: requiredJsonString(coordinate.runId, `${label}.runId`),
    nodeId: requiredJsonString(coordinate.nodeId, `${label}.nodeId`),
    cycleId,
    attemptId: requiredJsonString(coordinate.attemptId, `${label}.attemptId`),
    actionId: requiredJsonString(coordinate.actionId, `${label}.actionId`),
    revision
  };
}
function parseWorkflowArtifactVersion(value, index) {
  const label = `workflowRuntime.artifactVersions[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Run state: ${label} must be an object`);
  }
  const version = value;
  const keys = /* @__PURE__ */ new Set([
    "id",
    "artifactId",
    "schemaId",
    "lifetime",
    "scopeId",
    "contentHash",
    "path",
    "producer",
    "timestamp"
  ]);
  const unknown = Object.keys(version).find((key) => !keys.has(key));
  if (unknown) {
    throw new Error(`Invalid Run state: ${label} has unknown field ${unknown}`);
  }
  const contentHash2 = requiredJsonString(
    version.contentHash,
    `${label}.contentHash`
  );
  if (!/^[a-f0-9]{64}$/u.test(contentHash2)) {
    throw new Error(
      `Invalid Run state: ${label}.contentHash must be a SHA-256 hash`
    );
  }
  const artifactPath = requiredJsonString(version.path, `${label}.path`);
  assertSafeRunReference(artifactPath, `${label}.path`);
  return {
    id: requiredJsonString(version.id, `${label}.id`),
    artifactId: requiredJsonString(version.artifactId, `${label}.artifactId`),
    schemaId: requiredJsonString(version.schemaId, `${label}.schemaId`),
    lifetime: parseWorkflowArtifactLifetime(
      version.lifetime,
      `${label}.lifetime`
    ),
    scopeId: requiredJsonString(version.scopeId, `${label}.scopeId`),
    contentHash: contentHash2,
    path: artifactPath,
    producer: parseWorkflowArtifactProducer(
      version.producer,
      `${label}.producer`
    ),
    timestamp: requiredJsonString(version.timestamp, `${label}.timestamp`)
  };
}
function parseWorkflowArtifactSelection(value, index) {
  const label = `workflowRuntime.artifactSelections[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Run state: ${label} must be an object`);
  }
  const selection2 = value;
  const keys = /* @__PURE__ */ new Set([
    "artifactId",
    "versionId",
    "runId",
    "nodeId",
    "cycleId",
    "attemptId",
    "actionId",
    "revision",
    "timestamp"
  ]);
  const unknown = Object.keys(selection2).find((key) => !keys.has(key));
  if (unknown) {
    throw new Error(`Invalid Run state: ${label} has unknown field ${unknown}`);
  }
  const coordinate = parseWorkflowArtifactCoordinate(selection2, label);
  return {
    artifactId: requiredJsonString(selection2.artifactId, `${label}.artifactId`),
    versionId: requiredJsonString(selection2.versionId, `${label}.versionId`),
    ...coordinate,
    timestamp: requiredJsonString(selection2.timestamp, `${label}.timestamp`)
  };
}
function parseWorkflowRuntime(value, runId) {
  if (value === void 0) return void 0;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Run state: workflowRuntime must be an object");
  }
  const runtime = value;
  const keys = /* @__PURE__ */ new Set([
    "revision",
    "nextVisitOrdinal",
    "currentAttempt",
    "currentCycle",
    "cycles",
    "visits",
    "decisionReceipts",
    "artifactVersions",
    "artifactSelections"
  ]);
  const unknown = Object.keys(runtime).find((key) => !keys.has(key));
  if (unknown) {
    throw new Error(
      `Invalid Run state: workflowRuntime has unknown field ${unknown}`
    );
  }
  for (const key of ["revision", "nextVisitOrdinal"]) {
    const entry = runtime[key];
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0) {
      throw new Error(
        `Invalid Run state: workflowRuntime.${key} must be a non-negative integer`
      );
    }
  }
  const revision = runtime.revision;
  const nextVisitOrdinal = runtime.nextVisitOrdinal;
  if (!Array.isArray(runtime.visits)) {
    throw new Error(
      "Invalid Run state: workflowRuntime.visits must be an array"
    );
  }
  const visits = runtime.visits.map(parseWorkflowVisit);
  const cycles = runtime.cycles === void 0 ? [] : Array.isArray(runtime.cycles) ? runtime.cycles.map(
    (cycle, index) => parseWorkflowCycle(cycle, `workflowRuntime.cycles[${index}]`)
  ) : (() => {
    throw new Error(
      "Invalid Run state: workflowRuntime.cycles must be an array"
    );
  })();
  const cycleIds = /* @__PURE__ */ new Set();
  const cycleOrdinals = /* @__PURE__ */ new Map();
  for (const cycle of cycles) {
    if (cycleIds.has(cycle.id)) {
      throw new Error(
        `Invalid Run state: duplicate WorkflowRuntime Cycle ${cycle.id}`
      );
    }
    cycleIds.add(cycle.id);
    const expectedOrdinal = (cycleOrdinals.get(cycle.key) ?? 0) + 1;
    if (cycle.instanceOrdinal !== expectedOrdinal) {
      throw new Error(
        `Invalid Run state: WorkflowRuntime Cycle ordinal is invalid for ${cycle.key}`
      );
    }
    cycleOrdinals.set(cycle.key, cycle.instanceOrdinal);
  }
  const currentCycle = runtime.currentCycle === void 0 || runtime.currentCycle === null ? null : parseWorkflowCycle(
    runtime.currentCycle,
    "workflowRuntime.currentCycle"
  );
  if (currentCycle && !cycleIds.has(currentCycle.id)) {
    throw new Error(
      "Invalid Run state: current WorkflowRuntime Cycle is not in cycles"
    );
  }
  const decisionReceipts = runtime.decisionReceipts === void 0 ? [] : Array.isArray(runtime.decisionReceipts) ? runtime.decisionReceipts.map(parseDecisionReceipt) : (() => {
    throw new Error(
      "Invalid Run state: WorkflowRuntime decisionReceipts must be an array"
    );
  })();
  const artifactVersions = runtime.artifactVersions === void 0 ? [] : Array.isArray(runtime.artifactVersions) ? runtime.artifactVersions.map(parseWorkflowArtifactVersion) : (() => {
    throw new Error(
      "Invalid Run state: WorkflowRuntime artifactVersions must be an array"
    );
  })();
  const artifactSelections = runtime.artifactSelections === void 0 ? [] : Array.isArray(runtime.artifactSelections) ? runtime.artifactSelections.map(parseWorkflowArtifactSelection) : (() => {
    throw new Error(
      "Invalid Run state: WorkflowRuntime artifactSelections must be an array"
    );
  })();
  const artifactVersionIds = /* @__PURE__ */ new Set();
  for (const version of artifactVersions) {
    if (artifactVersionIds.has(version.id)) {
      throw new Error(
        `Invalid Run state: duplicate WorkflowRuntime artifact version ${version.id}`
      );
    }
    artifactVersionIds.add(version.id);
    if (version.producer.runId !== runId) {
      throw new Error(
        `Invalid Run state: artifact version ${version.id} belongs to another Run`
      );
    }
    if (version.lifetime === "attempt" && version.scopeId !== version.producer.attemptId || version.lifetime === "cycle" && version.scopeId !== version.producer.cycleId || version.lifetime === "run" && version.scopeId !== runId) {
      throw new Error(
        `Invalid Run state: artifact version ${version.id} has an invalid scope`
      );
    }
    if (version.producer.revision >= revision) {
      throw new Error(
        `Invalid Run state: artifact version ${version.id} has a future revision`
      );
    }
  }
  const artifactSelectionKeys = /* @__PURE__ */ new Set();
  for (const selection2 of artifactSelections) {
    const selectionKey = `${selection2.attemptId}\0${selection2.actionId}\0${selection2.artifactId}`;
    if (artifactSelectionKeys.has(selectionKey)) {
      throw new Error(
        `Invalid Run state: duplicate WorkflowRuntime artifact selection ${selection2.artifactId}`
      );
    }
    artifactSelectionKeys.add(selectionKey);
    if (!artifactVersionIds.has(selection2.versionId)) {
      throw new Error(
        `Invalid Run state: WorkflowRuntime selection references unknown artifact version ${selection2.versionId}`
      );
    }
    const version = artifactVersions.find(
      (candidate) => candidate.id === selection2.versionId
    );
    if (version.artifactId !== selection2.artifactId) {
      throw new Error(
        "Invalid Run state: WorkflowRuntime artifact selection id does not match its version"
      );
    }
    if (selection2.runId !== runId || selection2.revision >= revision) {
      throw new Error(
        `Invalid Run state: WorkflowRuntime artifact selection ${selection2.versionId} has an invalid Run or revision`
      );
    }
  }
  const attemptIds = /* @__PURE__ */ new Set();
  const visitOrdinals = /* @__PURE__ */ new Set();
  const receiptActionIds = /* @__PURE__ */ new Set();
  for (const receipt of decisionReceipts) {
    if (receiptActionIds.has(receipt.actionId)) {
      throw new Error(
        `Invalid Run state: duplicate WorkflowRuntime Decision Receipt ${receipt.actionId}`
      );
    }
    receiptActionIds.add(receipt.actionId);
  }
  let outcomeCount = 0;
  for (const visit of visits) {
    if (attemptIds.has(visit.attemptId)) {
      throw new Error(
        `Invalid Run state: duplicate WorkflowRuntime Attempt ${visit.attemptId}`
      );
    }
    attemptIds.add(visit.attemptId);
    if (visitOrdinals.has(visit.visitOrdinal)) {
      throw new Error(
        `Invalid Run state: duplicate WorkflowRuntime visit ordinal ${visit.visitOrdinal}`
      );
    }
    if (visit.cycleId !== null && !cycleIds.has(visit.cycleId)) {
      throw new Error(
        `Invalid Run state: WorkflowRuntime visit references unknown Cycle ${visit.cycleId}`
      );
    }
    visitOrdinals.add(visit.visitOrdinal);
    outcomeCount += visit.outcomes.length;
    if (visit.visitOrdinal > nextVisitOrdinal) {
      throw new Error(
        "Invalid Run state: WorkflowRuntime visit ordinal exceeds its counter"
      );
    }
  }
  const currentAttempt = runtime.currentAttempt === null ? null : parseWorkflowAttempt(
    runtime.currentAttempt,
    "workflowRuntime.currentAttempt"
  );
  if (currentAttempt && !attemptIds.has(currentAttempt.id)) {
    throw new Error(
      "Invalid Run state: current WorkflowRuntime Attempt is not in visits"
    );
  }
  if (currentAttempt && currentAttempt.cycleId !== (currentCycle?.id ?? null)) {
    throw new Error(
      "Invalid Run state: current WorkflowRuntime Attempt does not match current Cycle"
    );
  }
  if (revision !== outcomeCount) {
    throw new Error(
      "Invalid Run state: WorkflowRuntime revision does not match visit outcomes"
    );
  }
  if (currentAttempt) {
    const currentVisit = visits.find(
      (visit) => visit.attemptId === currentAttempt.id
    );
    if (currentVisit.stepId !== currentAttempt.stepId || currentVisit.cycleId !== currentAttempt.cycleId || currentVisit.visitOrdinal !== currentAttempt.visitOrdinal) {
      throw new Error(
        "Invalid Run state: current WorkflowRuntime Attempt does not match its visit"
      );
    }
    const lastOutcome = currentVisit.outcomes.at(-1);
    const expectedRetryOrdinal = lastOutcome ? lastOutcome.retryOrdinal + 1 : 0;
    if (currentAttempt.retryOrdinal !== expectedRetryOrdinal) {
      throw new Error(
        "Invalid Run state: current WorkflowRuntime retry ordinal is invalid"
      );
    }
  }
  return {
    revision,
    nextVisitOrdinal,
    currentAttempt,
    currentCycle,
    cycles,
    visits,
    decisionReceipts,
    artifactVersions,
    artifactSelections
  };
}
function parseRunStateJson(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Run state: stored value must be an object");
  }
  const json = value;
  const unknown = Object.keys(json).find(
    (key) => !RUN_STATE_JSON_KEYS.has(key)
  );
  if (unknown) throw new Error(`Invalid Run state: unknown field ${unknown}`);
  const runId = requiredJsonString(json.runId, "runId");
  const skill = requiredJsonString(json.skill, "skill");
  const skillVersion = requiredJsonString(json.skillVersion, "skillVersion");
  const skillHash = requiredJsonString(json.skillHash, "skillHash");
  if (json.orchestration !== "deterministic" && json.orchestration !== "adaptive") {
    throw new Error(
      "Invalid Run state: orchestration must be deterministic or adaptive"
    );
  }
  const currentStep = nullableJsonString(json.currentStep, "currentStep");
  const iteration = json.iteration;
  if (typeof iteration !== "number" || !Number.isSafeInteger(iteration) || iteration < 0) {
    throw new Error(
      "Invalid Run state: iteration must be a non-negative integer"
    );
  }
  const pending = nullableJsonString(json.pending, "pending");
  const pendingRef = requiredJsonString(json.pendingRef, "pendingRef");
  const trajectoryRef = requiredJsonString(json.trajectoryRef, "trajectoryRef");
  const contextRef = requiredJsonString(json.contextRef, "contextRef");
  const artifactsRef = requiredJsonString(json.artifactsRef, "artifactsRef");
  const checkpointRef = requiredJsonString(json.checkpointRef, "checkpointRef");
  assertSafeRunReference(pendingRef, "pending_ref");
  assertSafeRunReference(trajectoryRef, "trajectory_ref");
  assertSafeRunReference(contextRef, "context_ref");
  assertSafeRunReference(artifactsRef, "artifacts_ref");
  assertSafeRunReference(checkpointRef, "checkpoint_ref");
  if (json.status !== "running" && json.status !== "waiting" && json.status !== "completed" && json.status !== "failed") {
    throw new Error("Invalid Run state: run_status is invalid");
  }
  if (!json.retries || typeof json.retries !== "object" || Array.isArray(json.retries)) {
    throw new Error("Invalid Run state: run_retries must be a JSON object");
  }
  for (const count of Object.values(json.retries)) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(
        "Invalid Run state: retry counts must be non-negative integers"
      );
    }
  }
  let runtimeIdentity;
  if (json.runtimeIdentity !== void 0) {
    if (!json.runtimeIdentity || typeof json.runtimeIdentity !== "object" || Array.isArray(json.runtimeIdentity)) {
      throw new Error("Invalid Run state: runtimeIdentity must be an object");
    }
    const identity = json.runtimeIdentity;
    const identityKeys = /* @__PURE__ */ new Set([
      "protocolHash",
      "packageHash",
      "snapshotHash",
      "nodeToStep",
      "capabilityVersion",
      "resolverHash",
      "findingCatalogVersion"
    ]);
    const unknownIdentityKey = Object.keys(identity).find(
      (key) => !identityKeys.has(key)
    );
    if (unknownIdentityKey) {
      throw new Error(
        `Invalid Run state: runtimeIdentity unknown field ${unknownIdentityKey}`
      );
    }
    if (typeof identity.protocolHash !== "string" || !/^[a-f0-9]{64}$/u.test(identity.protocolHash) || typeof identity.packageHash !== "string" || !/^[a-f0-9]{64}$/u.test(identity.packageHash) || typeof identity.snapshotHash !== "string" || !/^[a-f0-9]{64}$/u.test(identity.snapshotHash) || !identity.nodeToStep || typeof identity.nodeToStep !== "object" || Array.isArray(identity.nodeToStep) || identity.capabilityVersion !== void 0 && identity.capabilityVersion !== 3 || identity.resolverHash !== void 0 && (typeof identity.resolverHash !== "string" || !/^[a-f0-9]{64}$/u.test(identity.resolverHash)) || identity.findingCatalogVersion !== void 0 && identity.findingCatalogVersion !== 1) {
      throw new Error("Invalid Run state: runtimeIdentity is invalid");
    }
    for (const [nodeId, stepId2] of Object.entries(identity.nodeToStep)) {
      if (!nodeId || typeof stepId2 !== "string" || !stepId2) {
        throw new Error(
          "Invalid Run state: runtimeIdentity mapping is invalid"
        );
      }
    }
    runtimeIdentity = {
      protocolHash: identity.protocolHash,
      packageHash: identity.packageHash,
      snapshotHash: identity.snapshotHash,
      nodeToStep: Object.fromEntries(
        Object.entries(identity.nodeToStep).map(([nodeId, stepId2]) => [
          nodeId,
          stepId2
        ])
      ),
      ...identity.capabilityVersion === 3 ? { capabilityVersion: 3 } : {},
      ...typeof identity.resolverHash === "string" ? { resolverHash: identity.resolverHash } : {},
      ...identity.findingCatalogVersion === 1 ? { findingCatalogVersion: 1 } : {}
    };
  }
  const workflowRuntime = parseWorkflowRuntime(json.workflowRuntime, runId);
  return {
    runId,
    skill,
    skillVersion,
    skillHash,
    orchestration: json.orchestration,
    currentStep,
    iteration,
    pending,
    pendingRef,
    trajectoryRef,
    contextRef,
    artifactsRef,
    checkpointRef,
    status: json.status,
    retries: json.retries,
    ...runtimeIdentity ? { runtimeIdentity } : {},
    ...workflowRuntime ? { workflowRuntime } : {}
  };
}
function parseRunStateValue(value) {
  return parseRunStateJson(value);
}
function serializeRunState(state) {
  return JSON.stringify(parseRunStateJson(state), null, 2);
}
async function readRunState(changeDir, options = {}) {
  const raw = await readOptionalEngineRunText(
    changeDir,
    RUN_STATE_FILE,
    RUN_STATE_MAX_BYTES,
    "Run state",
    options
  );
  if (raw === null) return null;
  return parseRunStateValue(JSON.parse(raw));
}
async function writeRunState(changeDir, state, options = {}) {
  const serialized = serializeRunState(state);
  await writeEngineRunText(
    changeDir,
    RUN_STATE_FILE,
    serialized,
    RUN_STATE_MAX_BYTES,
    "Run state",
    options
  );
}

// src/engine/manual-run.ts
async function existingRun(changeDir) {
  try {
    return await readRunState(changeDir);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function requiredRun(changeDir) {
  const state = await existingRun(changeDir);
  if (!state) throw new Error(`No Comet Run found in: ${changeDir}`);
  return state;
}
function validateStringRecord(value, label) {
  if (value === void 0) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const item of Object.values(value)) {
    if (typeof item !== "string") {
      throw new Error(`${label} values must be strings`);
    }
  }
}
function validateEvidenceRecord(value, label) {
  if (value === void 0) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  try {
    JSON.stringify(value);
  } catch (error) {
    throw new Error(`${label} must be JSON-serializable`, { cause: error });
  }
}
function validateOutcome(outcome) {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
    throw new Error("Outcome must be an object");
  }
  if (outcome.actionId !== void 0 && typeof outcome.actionId !== "string") {
    throw new Error("Outcome actionId must be a string");
  }
  if (outcome.status !== "succeeded" && outcome.status !== "failed") {
    throw new Error("Outcome status must be succeeded or failed");
  }
  if (typeof outcome.summary !== "string" || outcome.summary.length === 0) {
    throw new Error("Outcome summary must be a non-empty string");
  }
  validateStringRecord(outcome.artifacts, "Outcome artifacts");
  validateStringRecord(outcome.state, "Outcome state");
  validateStringRecord(outcome.routing, "Outcome routing");
  validateStringRecord(outcome.artifactVersions, "Outcome artifact versions");
  validateEvidenceRecord(outcome.evidence, "Outcome evidence");
}
function applyArtifactMutation(state, mutation) {
  if (!mutation) return state;
  if (!state.workflowRuntime) {
    throw new Error("Artifact mutation requires WorkflowRuntime state");
  }
  return {
    ...state,
    workflowRuntime: {
      ...state.workflowRuntime,
      artifactVersions: [
        ...state.workflowRuntime.artifactVersions ?? [],
        ...structuredClone(mutation.versions)
      ],
      artifactSelections: [
        ...state.workflowRuntime.artifactSelections ?? [],
        ...structuredClone(mutation.selections)
      ]
    }
  };
}
function validatePendingState(state, pending) {
  if (pending) {
    if (!state.pending || state.pending !== pending.id) {
      throw new Error("Pending action file does not match Run state");
    }
    if (state.status !== "waiting") {
      throw new Error(
        `Run state cannot have a pending action while status is ${state.status}`
      );
    }
    return;
  }
  if (state.pending || state.status === "waiting") {
    throw new Error("Run state references a missing pending action");
  }
}
function validateSnapshotState(pkg, state) {
  if (pkg.definition.metadata.name !== state.skill || pkg.definition.metadata.version !== state.skillVersion || pkg.definition.orchestration.mode !== state.orchestration) {
    throw new Error("Run state does not match Skill snapshot");
  }
}
async function appendEvent(changeDir, state, type, data) {
  const trajectory = await readTrajectory(changeDir, state.trajectoryRef);
  await appendTrajectory(changeDir, state.trajectoryRef, {
    sequence: trajectory.length + 1,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    type,
    runId: state.runId,
    data
  });
}
async function persistDecision(changeDir, state, pkg, confirmations, resolver = staticDeterministicResolver, prepareAction) {
  const decision = decideWithResolver(
    pkg,
    state,
    new Set(confirmations),
    resolver,
    void 0
  );
  let action = decision.action;
  if (action && prepareAction) {
    const prepared = await prepareAction(
      changeDir,
      pkg,
      decision.state,
      action
    );
    if (!prepared.action) {
      return {
        state,
        action: null,
        evals: [],
        reason: prepared.reason ?? "Pending action preparation was blocked"
      };
    }
    action = prepared.action;
  }
  if (action) {
    await writePendingAction(changeDir, decision.state.pendingRef, action);
  }
  await writeRunState(changeDir, action ? decision.state : state);
  if (action) {
    await appendEvent(changeDir, decision.state, "action_proposed", {
      action
    });
  }
  return {
    state: action ? decision.state : state,
    action,
    evals: [],
    reason: decision.reason
  };
}
async function evaluateAndRecord(changeDir, pkg, state, scope, artifacts) {
  const results = evaluateRuntime(pkg.evals, scope, state, artifacts);
  if (results.length > 0) {
    await appendEvent(changeDir, state, "eval_completed", { scope, results });
  }
  return results;
}
function normalizeStartOptions(value) {
  if (value && typeof value === "object" && ("confirmations" in value || "runId" in value || "runtimeIdentity" in value || "workflowRuntime" in value || "resolver" in value || "prepareAction" in value)) {
    return value;
  }
  return { confirmations: value };
}
async function startManualRun(pkg, changeDir, options = []) {
  const startOptions = normalizeStartOptions(options);
  if (pkg.definition.orchestration.mode === "adaptive") {
    throw new Error("Adaptive orchestration requires an Agent candidate");
  }
  if (await existingRun(changeDir)) {
    throw new Error(`A Comet Run already exists in: ${changeDir}`);
  }
  const snapshot = await createSkillSnapshot(pkg, changeDir);
  if (startOptions.runtimeIdentity && (startOptions.runtimeIdentity.snapshotHash !== snapshot.hash || startOptions.runtimeIdentity.packageHash !== snapshot.hash)) {
    throw new Error("Runtime identity hashes do not match the Skill snapshot");
  }
  const state = startRun(
    pkg,
    startOptions.runId ?? randomUUID3(),
    snapshot.hash,
    startOptions.workflowRuntime
  );
  if (startOptions.runtimeIdentity) {
    state.runtimeIdentity = structuredClone(startOptions.runtimeIdentity);
  }
  await writeRunState(changeDir, state);
  await appendEvent(changeDir, state, "run_started", {
    skill: state.skill,
    skillVersion: state.skillVersion,
    skillHash: state.skillHash,
    ...state.runtimeIdentity ? { runtimeIdentity: structuredClone(state.runtimeIdentity) } : {}
  });
  return persistDecision(
    changeDir,
    state,
    pkg,
    startOptions.confirmations ?? [],
    startOptions.resolver,
    startOptions.prepareAction
  );
}
async function resumeManualRunInternal(changeDir, options = {}) {
  const state = await requiredRun(changeDir);
  const pkg = await readSkillSnapshot(changeDir, state.skillHash);
  validateSnapshotState(pkg, state);
  if (pkg.definition.orchestration.mode === "adaptive") {
    throw new Error("Adaptive orchestration requires an Agent candidate");
  }
  const resolver = options.resolver ?? staticDeterministicResolver;
  const pending = await readPendingAction(changeDir, state.pendingRef);
  if (!options.outcome) {
    validatePendingState(state, pending);
    if (pending) {
      return { state, action: pending, evals: [] };
    }
    if (state.status !== "running") {
      return {
        state,
        action: null,
        evals: [],
        reason: `Run is ${state.status}`
      };
    }
    return persistDecision(
      changeDir,
      state,
      pkg,
      options.confirmations ?? [],
      resolver,
      options.prepareAction
    );
  }
  if (!pending || !state.pending) {
    throw new Error("No pending action accepts an outcome");
  }
  if (state.pending !== pending.id) {
    throw new Error("Pending action file does not match Run state");
  }
  validatePendingState(state, pending);
  validateOutcome(options.outcome);
  if (options.outcome.actionId !== void 0 && options.outcome.actionId !== pending.id) {
    throw new Error(
      `Outcome does not match pending action: ${options.outcome.actionId}`
    );
  }
  const outcome = { ...options.outcome, actionId: pending.id };
  const advanced = applyArtifactMutation(
    recordOutcomeWithResolver(pkg, state, outcome, resolver, void 0),
    options.artifactMutation
  );
  const artifacts = {
    ...await readArtifacts(changeDir, state.artifactsRef),
    ...outcome.artifacts ?? {},
    ...options.artifactMutation?.artifactPaths ?? {}
  };
  await writeArtifacts(changeDir, state.artifactsRef, artifacts);
  const decisionReceipt2 = advanced.workflowRuntime?.decisionReceipts.find(
    (receipt) => receipt.actionId === pending.id
  );
  await appendEvent(changeDir, state, "action_completed", {
    action: pending,
    outcome,
    ...decisionReceipt2 ? { decisionReceipt: decisionReceipt2 } : {}
  });
  await clearPendingAction(changeDir, advanced.pendingRef);
  await writeRunState(changeDir, advanced);
  const evals = await evaluateAndRecord(
    changeDir,
    pkg,
    advanced,
    "step",
    artifacts
  );
  if (advanced.status === "completed") {
    evals.push(
      ...await evaluateAndRecord(
        changeDir,
        pkg,
        advanced,
        "completion",
        artifacts
      )
    );
    return { state: advanced, action: null, evals };
  }
  if (advanced.status !== "running") {
    return {
      state: advanced,
      action: null,
      evals,
      reason: `Run is ${advanced.status}`
    };
  }
  const next = await persistDecision(
    changeDir,
    advanced,
    pkg,
    options.confirmations ?? [],
    resolver,
    options.prepareAction
  );
  return { ...next, evals };
}
async function resumeManualRun(changeDir, options = {}) {
  return resumeManualRunInternal(changeDir, options);
}
async function resumeManualWorkflowRun(changeDir, options, artifactMutation) {
  return resumeManualRunInternal(changeDir, {
    ...options,
    artifactMutation
  });
}

// src/engine/standalone-run.ts
import { promises as fs6 } from "node:fs";
import path11 from "path";
function validateRunId(runId) {
  if (typeof runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(runId)) {
    throw new Error(`Invalid standalone Run id: ${String(runId)}`);
  }
}
function validateProjectRoot(projectRoot) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new Error(`Invalid standalone project root: ${String(projectRoot)}`);
  }
}
function standaloneRunDir(projectRoot, runId) {
  validateRunId(runId);
  validateProjectRoot(projectRoot);
  return path11.resolve(projectRoot, ".comet", "runs", runId);
}
function pathSegments(projectRoot) {
  const lexicalRoot = path11.resolve(projectRoot);
  const root = path11.parse(lexicalRoot).root;
  const relative = path11.relative(root, lexicalRoot);
  return relative.length === 0 ? [] : relative.split(path11.sep);
}
function runRootRelativePath(projectRoot, runRoot) {
  return path11.relative(projectRoot, runRoot).replaceAll("\\", "/");
}
function isMissing(error) {
  const code = error.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
async function resolveStandaloneProjectRoot(projectRoot, createMissing) {
  validateProjectRoot(projectRoot);
  const lexicalRoot = path11.resolve(projectRoot);
  let cursor = path11.parse(lexicalRoot).root;
  for (const segment of pathSegments(lexicalRoot)) {
    cursor = path11.join(cursor, segment);
    let stat;
    try {
      stat = await fs6.lstat(cursor);
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (!createMissing) return lexicalRoot;
      try {
        await fs6.mkdir(cursor);
      } catch (mkdirError) {
        if (mkdirError.code !== "EEXIST") {
          throw mkdirError;
        }
      }
      stat = await fs6.lstat(cursor);
    }
    if (stat.isSymbolicLink()) {
      throw new Error("Standalone project root cannot cross a symbolic link");
    }
    if (!stat.isDirectory()) {
      throw new Error("Standalone project root must be a real directory");
    }
  }
  return lexicalRoot;
}
async function ensureStandaloneRunDir(projectRoot, runId) {
  validateRunId(runId);
  validateProjectRoot(projectRoot);
  const validatedRoot = await resolveStandaloneProjectRoot(projectRoot, true);
  const runDir = standaloneRunDir(validatedRoot, runId);
  await ensureProtectedProjectDirectory(
    validatedRoot,
    runRootRelativePath(validatedRoot, runDir),
    { label: "Standalone Run root" }
  );
  return runDir;
}
async function checkedStandaloneRunDir(projectRoot, runId) {
  validateRunId(runId);
  validateProjectRoot(projectRoot);
  const validatedRoot = await resolveStandaloneProjectRoot(projectRoot, false);
  const runDir = standaloneRunDir(validatedRoot, runId);
  await inspectProtectedProjectPath(
    validatedRoot,
    runRootRelativePath(validatedRoot, runDir),
    { label: "Standalone Run root", expected: "directory" }
  );
  const state = await readRunState(runDir);
  if (state && state.runId !== runId) {
    throw new Error(
      `Standalone Run state does not match requested Run id: ${runId}`
    );
  }
  return runDir;
}
async function readStandaloneRunState(projectRoot, runId) {
  return readRunState(await checkedStandaloneRunDir(projectRoot, runId));
}
async function startStandaloneRun(pkg, options) {
  const runDir = await ensureStandaloneRunDir(
    options.projectRoot,
    options.runId
  );
  return startManualRun(pkg, runDir, {
    runId: options.runId,
    confirmations: options.confirmations ?? [],
    runtimeIdentity: options.runtimeIdentity,
    workflowRuntime: options.workflowRuntime,
    resolver: options.resolver,
    prepareAction: options.prepareAction
  });
}
async function resumeStandaloneRun(projectRoot, runId, options = {}) {
  return resumeManualRun(
    await checkedStandaloneRunDir(projectRoot, runId),
    options
  );
}
async function resumeStandaloneWorkflowRun(projectRoot, runId, options, artifactMutation) {
  return resumeManualWorkflowRun(
    await checkedStandaloneRunDir(projectRoot, runId),
    options,
    artifactMutation
  );
}

// src/workflow-runtime/location.ts
function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}
function manualLocation(runRoot) {
  const validatedRoot = requiredString(runRoot, "WorkflowRuntime Run root");
  return {
    kind: "manual",
    runRoot: validatedRoot,
    async start(pkg, options) {
      return startManualRun(pkg, validatedRoot, options);
    },
    async resume(options = {}, artifactMutation) {
      return artifactMutation ? resumeManualWorkflowRun(validatedRoot, options, artifactMutation) : resumeManualRun(validatedRoot, options);
    },
    async readState() {
      return readRunState(validatedRoot);
    }
  };
}
function standaloneLocation(projectRoot, runId) {
  const validatedRunId = requiredString(
    runId,
    "WorkflowRuntime standalone Run id"
  );
  const validatedProjectRoot = requiredString(
    projectRoot,
    "WorkflowRuntime standalone project root"
  );
  const runRoot = standaloneRunDir(validatedProjectRoot, validatedRunId);
  return {
    kind: "standalone",
    runRoot,
    runId: validatedRunId,
    async start(pkg, options) {
      return startStandaloneRun(pkg, {
        projectRoot: validatedProjectRoot,
        runId: validatedRunId,
        confirmations: options.confirmations,
        runtimeIdentity: options.runtimeIdentity,
        workflowRuntime: options.workflowRuntime,
        resolver: options.resolver,
        prepareAction: options.prepareAction
      });
    },
    async resume(options = {}, artifactMutation) {
      return artifactMutation ? resumeStandaloneWorkflowRun(
        validatedProjectRoot,
        validatedRunId,
        options,
        artifactMutation
      ) : resumeStandaloneRun(validatedProjectRoot, validatedRunId, options);
    },
    async readState() {
      return readStandaloneRunState(validatedProjectRoot, validatedRunId);
    }
  };
}
function resolveWorkflowRunLocation(target) {
  if (typeof target === "string") return manualLocation(target);
  if (!target || typeof target !== "object") {
    throw new Error("WorkflowRuntime Run location must be an object");
  }
  if (target.kind === "manual") return manualLocation(target.runRoot);
  if (target.kind === "standalone") {
    return standaloneLocation(target.projectRoot, target.runId);
  }
  throw new Error("Unsupported WorkflowRuntime Run location");
}
function resolveWorkflowStartLocation(options) {
  if ("location" in options) {
    const location = resolveWorkflowRunLocation(options.location);
    if (location.kind === "standalone") {
      return { location, runId: location.runId };
    }
    return {
      location,
      runId: ("runId" in options ? options.runId : void 0) ?? randomUUID4()
    };
  }
  return {
    location: manualLocation(options.runRoot),
    runId: options.runId ?? randomUUID4()
  };
}

// src/workflow-runtime/index.ts
async function withStructuredRuntimeErrors(operation2) {
  try {
    return await operation2();
  } catch (error) {
    throw attachWorkflowFinding(error);
  }
}
function identityFromState(state) {
  if (!state.runtimeIdentity) {
    throw new Error("Run is not a WorkflowRuntime Run");
  }
  return {
    protocolHash: state.runtimeIdentity.protocolHash,
    packageHash: state.runtimeIdentity.packageHash,
    snapshotHash: state.runtimeIdentity.snapshotHash,
    nodeToStep: { ...state.runtimeIdentity.nodeToStep },
    ...state.runtimeIdentity.capabilityVersion === 3 ? { capabilityVersion: 3 } : {},
    ...state.runtimeIdentity.resolverHash ? { resolverHash: state.runtimeIdentity.resolverHash } : {},
    ...state.runtimeIdentity.findingCatalogVersion === WORKFLOW_FINDING_CATALOG_VERSION ? { findingCatalogVersion: WORKFLOW_FINDING_CATALOG_VERSION } : {}
  };
}
function currentNode(state, identity, action) {
  const step = action?.stepId ?? state.currentStep;
  if (!step) return null;
  return Object.entries(identity.nodeToStep).find(
    ([, stepId2]) => stepId2 === step
  )?.[0] ?? null;
}
function sameStringRecord(left, right) {
  const leftEntries = Object.entries(left).sort(
    ([a], [b]) => a.localeCompare(b)
  );
  const rightEntries = Object.entries(right).sort(
    ([a], [b]) => a.localeCompare(b)
  );
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}
function sameExecutionIdentity(left, right) {
  return left.protocolHash === right.protocolHash && left.packageHash === right.packageHash && left.snapshotHash === right.snapshotHash && sameStringRecord(left.nodeToStep, right.nodeToStep) && left.capabilityVersion === right.capabilityVersion && left.resolverHash === right.resolverHash && (left.findingCatalogVersion === void 0 || right.findingCatalogVersion === void 0 || left.findingCatalogVersion === right.findingCatalogVersion);
}
function isDecisionSubmission(submission) {
  return submission.kind === "decision";
}
var DECISION_SUBMISSION_KEYS = /* @__PURE__ */ new Set([
  "kind",
  "actionId",
  "revision",
  "nodeId",
  "cycleId",
  "attemptId",
  "decisionId",
  "choiceId",
  "reviewer",
  "inputs",
  "rationale",
  "evidenceReferences",
  "scope",
  "execution",
  "protocolHash",
  "packageHash",
  "snapshotHash"
]);
function redactVisitEvidence(visits) {
  return visits.map((visit) => ({
    ...visit,
    outcomes: visit.outcomes.map((outcome) => {
      const redacted = { ...outcome };
      delete redacted.evidence;
      return redacted;
    })
  }));
}
var MAX_PROJECTED_LEDGER_ENTRIES = 256;
function boundProjectedLedger(values) {
  return structuredClone(values.slice(-MAX_PROJECTED_LEDGER_ENTRIES));
}
function boundedContinuation(value) {
  const parsedFindings = (value.findings ?? []).map(parseWorkflowFinding);
  const parsedSummary = value.findingSummary ? parseWorkflowFindingSummary(value.findingSummary) : void 0;
  if (parsedSummary && (parsedFindings.length > MAX_WORKFLOW_FINDINGS || parsedSummary.returned !== parsedFindings.length || parsedSummary.omitted !== parsedSummary.total - parsedFindings.length)) {
    throw new Error("Workflow finding summary does not match findings");
  }
  if (parsedSummary) {
    const normalizedFindings = boundWorkflowFindings(parsedFindings).findings;
    if (JSON.stringify(stableValue(normalizedFindings)) !== JSON.stringify(stableValue(parsedFindings)) || new TextEncoder().encode(JSON.stringify(parsedFindings)).byteLength !== parsedSummary.encodedBytes) {
      throw new Error("Workflow findings are not canonically ordered");
    }
  }
  const projected = parsedSummary ? {
    findings: structuredClone(parsedFindings),
    summary: structuredClone(parsedSummary)
  } : boundWorkflowFindings(
    value.blockers.length > 0 ? value.blockers.map((blocker) => findingFromBlocker(blocker)) : value.pendingAction ? [
      value.pendingAction.type === "ask_user" ? decisionRequiredFinding(value.pendingAction.id) : actionAvailableFinding(
        value.pendingAction.id,
        (value.pendingAction.retryOrdinal ?? 0) > 0
      )
    ] : []
  );
  const disposition = value.disposition;
  return {
    ...structuredClone(value),
    decisionReceipts: boundProjectedLedger(value.decisionReceipts),
    cycles: boundProjectedLedger(value.cycles),
    visits: boundProjectedLedger(value.visits),
    artifactVersions: boundProjectedLedger(value.artifactVersions),
    artifactSelections: boundProjectedLedger(value.artifactSelections),
    findings: projected.findings,
    findingSummary: projected.summary,
    requiresUserDecision: projected.findings.some(
      (finding) => finding.requiresUserDecision
    ),
    blockers: legacyBlockersFromFindings(disposition, projected.findings)
  };
}
function emptyFindingSummary() {
  return boundWorkflowFindings([]).summary;
}
function terminalEvaluationResults(trajectory) {
  const latest = /* @__PURE__ */ new Map();
  for (const event of trajectory) {
    if (event.type !== "eval_completed" || !Array.isArray(event.data.results)) {
      continue;
    }
    for (const result of event.data.results) {
      if (!isRecord6(result)) continue;
      if (typeof result.evalId !== "string" || typeof result.passed !== "boolean" || typeof result.evidence !== "string") {
        continue;
      }
      latest.set(result.evalId, {
        evalId: result.evalId,
        passed: result.passed,
        evidence: result.evidence
      });
    }
  }
  return [...latest.values()];
}
function findingsForContinuation(disposition, reason, action, evals = [], retry = false) {
  const raw = [
    ...reason && disposition !== "done" ? [
      findingFromBlocker(reason, {
        actionId: action?.id,
        nodeId: action?.stepId
      })
    ] : action ? [
      action.type === "ask_user" ? decisionRequiredFinding(action.id) : actionAvailableFinding(
        action.id,
        retry || (action.retryOrdinal ?? 0) > 0
      )
    ] : [],
    ...disposition === "done" ? evals.filter((evaluation) => !evaluation.passed).map(
      (evaluation) => evaluationWarningFinding(evaluation.evalId, evaluation.evidence)
    ) : []
  ];
  return boundWorkflowFindings(raw);
}
function validateScalarRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!key || entry === null) {
      throw new Error(`${label} must contain scalar values`);
    }
    if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") {
      throw new Error(`${label} must contain scalar values`);
    }
    if (typeof entry === "number" && !Number.isFinite(entry)) {
      throw new Error(`${label} must contain finite numbers`);
    }
  }
}
function validateDecisionInputSchema2(schema, inputs) {
  const fields = new Map(schema.fields.map((field) => [field.id, field]));
  for (const key of Object.keys(inputs)) {
    if (!fields.has(key)) {
      throw new Error(`Decision input is not declared: ${key}`);
    }
  }
  for (const field of schema.fields) {
    const value = inputs[field.id];
    if (value === void 0) {
      if (field.required) {
        throw new Error(`Missing required decision input: ${field.id}`);
      }
      continue;
    }
    if (field.type === "string" && typeof value !== "string" || field.type === "number" && (typeof value !== "number" || !Number.isFinite(value)) || field.type === "boolean" && typeof value !== "boolean") {
      throw new Error(`Decision input has the wrong type: ${field.id}`);
    }
    const allowed = field.values ?? field.enum;
    if (allowed && !allowed.some((candidate) => candidate === value)) {
      throw new Error(`Decision input has an invalid value: ${field.id}`);
    }
  }
}
function validateReviewer(reviewer, policy) {
  if (!reviewer || typeof reviewer !== "object" || Array.isArray(reviewer)) {
    throw new Error("Decision reviewer attestation must be an object");
  }
  const attestation = reviewer;
  const unknown = Object.keys(reviewer).find(
    (key) => key !== "subject" && key !== "authorities"
  );
  if (unknown) {
    throw new Error(
      `Decision reviewer attestation has unknown field: ${unknown}`
    );
  }
  if (typeof attestation.subject !== "string" || !attestation.subject) {
    throw new Error("Decision reviewer subject must be non-empty");
  }
  if (!Array.isArray(attestation.authorities) || attestation.authorities.length === 0 || attestation.authorities.some(
    (authority) => typeof authority !== "string" || !authority
  )) {
    throw new Error("Decision reviewer authorities must be non-empty strings");
  }
  if (new Set(attestation.authorities).size !== attestation.authorities.length) {
    throw new Error(
      "Decision reviewer authorities must not contain duplicates"
    );
  }
  const subjects = policy?.subjects ?? [];
  if (subjects.length > 0 && !subjects.includes(attestation.subject)) {
    throw new Error(
      `Decision reviewer subject is not authorized: ${attestation.subject}`
    );
  }
  const authorities = attestation.authorities;
  for (const required of policy?.authorities ?? []) {
    if (!authorities.includes(required)) {
      throw new Error(`Decision reviewer lacks authority: ${required}`);
    }
  }
}
function validateSubmission(submission) {
  if (!submission || typeof submission !== "object") {
    throw new Error("Submission must be an object");
  }
  if (typeof submission.actionId !== "string" || !submission.actionId) {
    throw new Error("Submission actionId must be a non-empty string");
  }
  if (isDecisionSubmission(submission)) {
    const unknown = Object.keys(submission).find(
      (key) => !DECISION_SUBMISSION_KEYS.has(key)
    );
    if (unknown) {
      throw new Error(`Decision submission has unknown field: ${unknown}`);
    }
    if (!Number.isSafeInteger(submission.revision) || submission.revision < 0) {
      throw new Error("Decision revision must be a non-negative integer");
    }
    if (!submission.nodeId) {
      throw new Error("Decision Node id must be a non-empty string");
    }
    if (submission.cycleId !== null && (typeof submission.cycleId !== "string" || !submission.cycleId)) {
      throw new Error("Decision cycle id must be a string or null");
    }
    if (!submission.attemptId) {
      throw new Error("Decision Attempt id must be a non-empty string");
    }
    if (!submission.choiceId) {
      throw new Error("Decision choice id must be a non-empty string");
    }
    if (submission.decisionId !== void 0 && !submission.decisionId) {
      throw new Error("Decision id must be a non-empty string");
    }
    if (submission.inputs !== void 0) {
      validateScalarRecord(submission.inputs, "Decision inputs");
    }
    if (submission.rationale !== void 0 && (typeof submission.rationale !== "string" || !submission.rationale)) {
      throw new Error("Decision rationale must be a non-empty string");
    }
    if (submission.evidenceReferences !== void 0) {
      if (!Array.isArray(submission.evidenceReferences) || submission.evidenceReferences.some(
        (reference) => typeof reference !== "string" || !reference
      )) {
        throw new Error("Decision evidence references must be strings");
      }
    }
    return;
  }
  if (submission.nodeId !== void 0 && submission.nodeId !== null && (typeof submission.nodeId !== "string" || !submission.nodeId)) {
    throw new Error("Submission nodeId must be a non-empty string or null");
  }
  if (submission.kind !== void 0 && submission.kind !== "machine") {
    throw new Error("Machine submission kind is invalid");
  }
  if (submission.scope !== void 0) {
    throw new Error("Decision scope is only valid for decision submissions");
  }
  if (submission.status !== "succeeded" && submission.status !== "failed") {
    throw new Error("Submission status must be succeeded or failed");
  }
  if (typeof submission.summary !== "string" || !submission.summary) {
    throw new Error("Submission summary must be a non-empty string");
  }
  for (const [label, value] of [
    ["Submission artifacts", submission.artifacts],
    ["Submission state", submission.state],
    ["Submission artifact versions", submission.artifactVersions]
  ]) {
    if (value === void 0) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} must be an object`);
    }
    if (Object.values(value).some((item) => typeof item !== "string")) {
      throw new Error(`${label} values must be strings`);
    }
  }
  if (submission.evidence !== void 0) {
    if (!submission.evidence || typeof submission.evidence !== "object" || Array.isArray(submission.evidence)) {
      throw new Error("Submission evidence must be an object");
    }
    try {
      JSON.stringify(submission.evidence);
    } catch (error) {
      throw new Error("Submission evidence must be JSON-serializable", {
        cause: error
      });
    }
  }
  if (submission.routing !== void 0) {
    if (!submission.routing || typeof submission.routing !== "object" || Array.isArray(submission.routing)) {
      throw new Error("Submission routing must be an object");
    }
    if (Object.entries(submission.routing).some(
      ([field, value]) => !field || typeof value !== "string" || !value
    )) {
      throw new Error("Submission routing must contain non-empty strings");
    }
  }
  if (submission.status !== "succeeded" && submission.artifactVersions !== void 0) {
    throw new Error("Failed submissions cannot select artifact versions");
  }
}
function validateDecisionExecution(submission, expected) {
  const flatIdentity = {
    protocolHash: submission.protocolHash,
    packageHash: submission.packageHash,
    snapshotHash: submission.snapshotHash
  };
  const hasFlatIdentity = Object.values(flatIdentity).some(
    (value) => value !== void 0
  );
  if (hasFlatIdentity) {
    if (Object.values(flatIdentity).some(
      (value) => typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)
    ) || flatIdentity.protocolHash !== expected.protocolHash || flatIdentity.packageHash !== expected.packageHash || flatIdentity.snapshotHash !== expected.snapshotHash) {
      throw new Error(
        "Decision response execution identity does not match Run"
      );
    }
  }
  if (submission.execution !== void 0) {
    if (!sameExecutionIdentity(submission.execution, expected)) {
      throw new Error(
        "Decision response execution identity does not match Run"
      );
    }
    return;
  }
  if (!hasFlatIdentity) {
    throw new Error("Decision response execution identity is required");
  }
}
function continuation(result, identity) {
  const runtimeState = result.state.workflowRuntime;
  const currentAttempt = runtimeState?.currentAttempt ?? null;
  const disposition = result.action ? result.action.type === "ask_user" ? "await-user" : "continue" : result.state.status === "completed" ? "done" : "blocked";
  const projected = findingsForContinuation(
    disposition,
    result.reason,
    result.action,
    result.evals,
    result.action ? (result.action.retryOrdinal ?? result.state.retries[result.action.attemptId ?? result.action.id] ?? 0) > 0 : false
  );
  return {
    disposition,
    runId: result.state.runId,
    revision: runtimeState?.revision ?? 0,
    currentNode: currentNode(result.state, identity, result.action),
    cycleId: runtimeState?.currentCycle?.id ?? currentAttempt?.cycleId ?? null,
    attemptId: currentAttempt?.id ?? null,
    visitOrdinal: currentAttempt?.visitOrdinal ?? null,
    retryOrdinal: currentAttempt?.retryOrdinal ?? null,
    pendingAction: result.action,
    execution: structuredClone(identity),
    decisionReceipts: boundProjectedLedger(
      runtimeState?.decisionReceipts ?? []
    ),
    cycles: boundProjectedLedger(runtimeState?.cycles ?? []),
    visits: result.action?.type === "ask_user" ? boundProjectedLedger(redactVisitEvidence(runtimeState?.visits ?? [])) : boundProjectedLedger(runtimeState?.visits ?? []),
    artifactVersions: boundProjectedLedger(
      runtimeState?.artifactVersions ?? []
    ),
    artifactSelections: boundProjectedLedger(
      runtimeState?.artifactSelections ?? []
    ),
    currentArtifactVersions: currentWorkflowArtifactVersions(runtimeState),
    findings: projected.findings,
    findingSummary: projected.summary,
    requiresUserDecision: projected.findings.some(
      (finding) => finding.requiresUserDecision
    ),
    blockers: legacyBlockersFromFindings(disposition, projected.findings)
  };
}
var LEGACY_STATE_MAX_BYTES = 256 * 1024;
function isRecord6(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function projectionStatus(state, pending, maxRetriesPerAction) {
  const retriesExhausted = Object.values(state.retries).some(
    (count) => count > maxRetriesPerAction
  );
  return state.status === "failed" || !pending && retriesExhausted ? "blocked" : state.status;
}
async function projectWorkflowState(target) {
  const location = resolveWorkflowRunLocation(target);
  const state = await location.readState();
  if (!state) return null;
  const verified = await verifyStoredRun(location);
  const nodeByStep = new Map(
    Object.entries(verified.identity.nodeToStep).map(([nodeId, stepId2]) => [
      stepId2,
      nodeId
    ])
  );
  const completedNodes = [];
  const evidence = {};
  const history = [];
  const trajectory = await readTrajectory(
    location.runRoot,
    state.trajectoryRef
  );
  for (const event of trajectory) {
    if (event.type !== "action_completed") continue;
    if (!isRecord6(event.data.action) || !isRecord6(event.data.outcome)) continue;
    const stepId2 = event.data.action.stepId;
    const node = typeof stepId2 === "string" ? nodeByStep.get(stepId2) : void 0;
    const outcomeStatus = event.data.outcome.status;
    if (!node || outcomeStatus !== "succeeded" && outcomeStatus !== "failed") {
      continue;
    }
    history.push({
      event: "outcome-recorded",
      node,
      status: outcomeStatus,
      at: event.timestamp
    });
    if (outcomeStatus !== "succeeded") continue;
    if (!completedNodes.includes(node)) completedNodes.push(node);
    const outcomeEvidence = event.data.outcome.evidence;
    evidence[node] = isRecord6(outcomeEvidence) ? structuredClone(outcomeEvidence) : {};
  }
  const protocol = verified.package.runtime.protocol;
  const runtimeState = state.workflowRuntime;
  const currentAttempt = runtimeState?.currentAttempt ?? null;
  const status = projectionStatus(
    state,
    verified.pending,
    verified.package.guardrails.maxRetriesPerAction
  );
  const exhaustedAction = Object.entries(state.retries).find(
    ([, count]) => count > verified.package.guardrails.maxRetriesPerAction
  )?.[0];
  const projectedFindings = status === "blocked" ? boundWorkflowFindings([
    findingFromBlocker(
      exhaustedAction ? `Retry budget exhausted for action: ${exhaustedAction}` : `Run is ${state.status}`,
      { actionId: exhaustedAction }
    )
  ]) : verified.pending ? findingsForContinuation(
    verified.pending.type === "ask_user" ? "await-user" : "continue",
    void 0,
    verified.pending,
    [],
    (verified.pending.retryOrdinal ?? state.retries[verified.pending.attemptId ?? verified.pending.id] ?? 0) > 0
  ) : findingsForContinuation(
    status === "completed" ? "done" : "blocked",
    status === "running" ? "Run has no pending action" : void 0,
    null,
    status === "completed" ? terminalEvaluationResults(trajectory) : []
  );
  return {
    schemaVersion: 1,
    workflow: protocol.name,
    statePath: protocol.state.statePath,
    status,
    runId: state.runId,
    revision: runtimeState?.revision ?? 0,
    currentNode: currentNode(state, verified.identity, verified.pending),
    cycleId: runtimeState?.currentCycle?.id ?? currentAttempt?.cycleId ?? null,
    attemptId: currentAttempt?.id ?? null,
    visitOrdinal: currentAttempt?.visitOrdinal ?? null,
    retryOrdinal: currentAttempt?.retryOrdinal ?? null,
    completedNodes,
    evidence: verified.pending?.type === "ask_user" ? {} : evidence,
    history,
    pendingAction: verified.pending,
    execution: structuredClone(verified.identity),
    decisionReceipts: boundProjectedLedger(
      runtimeState?.decisionReceipts ?? []
    ),
    visits: verified.pending?.type === "ask_user" ? boundProjectedLedger(redactVisitEvidence(runtimeState?.visits ?? [])) : boundProjectedLedger(runtimeState?.visits ?? []),
    cycles: boundProjectedLedger(runtimeState?.cycles ?? []),
    artifactVersions: boundProjectedLedger(
      runtimeState?.artifactVersions ?? []
    ),
    artifactSelections: boundProjectedLedger(
      runtimeState?.artifactSelections ?? []
    ),
    currentArtifactVersions: currentWorkflowArtifactVersions(runtimeState),
    findings: projectedFindings.findings,
    findingSummary: projectedFindings.summary,
    requiresUserDecision: projectedFindings.findings.some(
      (finding) => finding.requiresUserDecision
    ),
    blockers: legacyBlockersFromFindings(
      status === "completed" ? "done" : verified.pending?.type === "ask_user" ? "await-user" : verified.pending ? "continue" : "blocked",
      projectedFindings.findings
    )
  };
}
async function writeWorkflowStateProjection(target, projection) {
  const projectRoot = resolveWorkflowRunLocation(target).runRoot;
  const label = "Workflow state projection";
  const relativePath = normalizeWorkflowRelativePath(
    projection.statePath,
    `${label} path`
  );
  const content = JSON.stringify(projection, null, 2) + "\n";
  if (Buffer.byteLength(content, "utf8") > LEGACY_STATE_MAX_BYTES) {
    throw new Error(`${label} exceeds ${LEGACY_STATE_MAX_BYTES} bytes`);
  }
  let inspection = await inspectProtectedProjectPath(
    projectRoot,
    relativePath,
    { label, expected: "file" }
  );
  if (inspection.exists) {
    const existing = await readProtectedProjectFile(
      projectRoot,
      relativePath,
      LEGACY_STATE_MAX_BYTES,
      { label }
    );
    if (Buffer.from(existing.bytes).equals(Buffer.from(content))) return;
  }
  const parent = path12.posix.dirname(relativePath);
  if (parent !== ".") {
    await ensureProtectedProjectDirectory(projectRoot, parent, { label });
    inspection = await inspectProtectedProjectPath(projectRoot, relativePath, {
      label,
      expected: "file"
    });
  }
  await atomicWriteContainedText(inspection.target, content, {
    containedRoot: inspection.projectRoot
  });
}
async function verifyStoredPackage(runRoot, state) {
  const identity = identityFromState(state);
  if (identity.snapshotHash !== state.skillHash) {
    throw new Error(
      "WorkflowRuntime snapshot identity does not match Run state"
    );
  }
  const pkg = await readSkillSnapshot(runRoot, state.skillHash);
  if (!pkg.runtime) {
    throw new Error("WorkflowRuntime Skill snapshot has no compiled protocol");
  }
  if (pkg.runtime.protocolHash !== identity.protocolHash) {
    throw new Error(
      "WorkflowRuntime protocol identity does not match Skill snapshot"
    );
  }
  if (!sameStringRecord(pkg.runtime.nodeToStep, identity.nodeToStep)) {
    throw new Error(
      "WorkflowRuntime Node-to-step identity does not match Skill snapshot"
    );
  }
  if (pkg.runtime.capabilityVersion !== identity.capabilityVersion) {
    throw new Error(
      "WorkflowRuntime capability identity does not match Skill snapshot"
    );
  }
  if (pkg.runtime.resolverHash !== identity.resolverHash) {
    throw new Error(
      "WorkflowRuntime resolver identity does not match Skill snapshot"
    );
  }
  if (identity.findingCatalogVersion !== void 0 && pkg.runtime.findingCatalogVersion !== identity.findingCatalogVersion) {
    throw new Error(
      "WorkflowRuntime finding catalog identity does not match Skill snapshot"
    );
  }
  const packageHash = await hashSkillPackage(pkg);
  if (packageHash !== identity.packageHash) {
    throw new Error(
      "WorkflowRuntime package identity does not match Skill snapshot"
    );
  }
  if (pkg.runtime.capabilityVersion === 3 && !state.workflowRuntime) {
    throw new Error(
      "WorkflowRuntime revisioned state is missing from Run state"
    );
  }
  if (pkg.runtime.capabilityVersion === 3 && state.workflowRuntime?.currentAttempt && state.workflowRuntime.currentAttempt.stepId !== state.currentStep) {
    throw new Error("WorkflowRuntime current Attempt does not match Run step");
  }
  if (pkg.runtime.capabilityVersion !== 3 && state.workflowRuntime) {
    throw new Error(
      "WorkflowRuntime revisioned state is not valid for a legacy Run"
    );
  }
  if (pkg.runtime.capabilityVersion === 3 && state.workflowRuntime) {
    validateWorkflowCycleState(
      pkg.runtime.protocol,
      state.runId,
      state.workflowRuntime
    );
    const cycleById = new Map(
      state.workflowRuntime.cycles.map((cycle) => [cycle.id, cycle])
    );
    for (const visit of state.workflowRuntime.visits) {
      const nodeId = Object.entries(identity.nodeToStep).find(
        ([, stepId2]) => stepId2 === visit.stepId
      )?.[0];
      if (!nodeId) {
        throw new Error("WorkflowRuntime visit has an unknown Node identity");
      }
      if (visit.cycleId !== null) {
        const cycle = cycleById.get(visit.cycleId);
        const plan = pkg.runtime.protocol.cycles?.find(
          (candidate) => candidate.key === cycle?.key
        );
        if (!cycle || !plan) {
          throw new Error(
            "WorkflowRuntime visit has an unknown Cycle identity"
          );
        }
        if (!workflowCycleOwnsNode(pkg.runtime.protocol, cycle.key, nodeId)) {
          throw new Error("WorkflowRuntime visit has an invalid Cycle Node");
        }
      }
    }
    if (state.currentStep !== null) {
      const currentNodeId = Object.entries(identity.nodeToStep).find(
        ([, stepId2]) => stepId2 === state.currentStep
      )?.[0];
      if (!currentNodeId) {
        throw new Error("WorkflowRuntime current Node identity is invalid");
      }
      const inCycle = state.workflowRuntime.cycles.some(
        (cycle) => workflowCycleOwnsNode(pkg.runtime.protocol, cycle.key, currentNodeId)
      );
      if (inCycle !== Boolean(state.workflowRuntime.currentCycle)) {
        throw new Error("WorkflowRuntime current Cycle position is invalid");
      }
      if (state.workflowRuntime.currentCycle && !workflowCycleOwnsNode(
        pkg.runtime.protocol,
        state.workflowRuntime.currentCycle.key,
        currentNodeId
      )) {
        throw new Error("WorkflowRuntime current Cycle position is invalid");
      }
    } else if (state.workflowRuntime.currentCycle) {
      throw new Error("WorkflowRuntime current Cycle position is invalid");
    }
    validateWorkflowArtifactState(
      pkg.runtime.protocol,
      state.runId,
      identity.nodeToStep,
      state.workflowRuntime
    );
  }
  for (const receipt of state.workflowRuntime?.decisionReceipts ?? []) {
    if (receipt.runId !== state.runId || receipt.protocolHash !== identity.protocolHash || receipt.packageHash !== identity.packageHash || receipt.snapshotHash !== identity.snapshotHash || receipt.resultingRevision !== receipt.revision + 1 || receipt.resultingRevision > (state.workflowRuntime?.revision ?? 0)) {
      throw new Error("WorkflowRuntime Decision Receipt identity is invalid");
    }
    const visit = state.workflowRuntime?.visits.find(
      (candidate) => candidate.attemptId === receipt.attemptId
    );
    const nodeId = visit ? Object.entries(identity.nodeToStep).find(
      ([, stepId2]) => stepId2 === visit.stepId
    )?.[0] : void 0;
    const outcome = visit?.outcomes.find(
      (candidate) => candidate.actionId === receipt.actionId
    );
    const node = nodeId ? pkg.runtime.protocol.nodes.find((candidate) => candidate.id === nodeId) : void 0;
    const choice = node?.decision?.choices.find(
      (candidate) => candidate.id === receipt.choiceId
    );
    if (!visit || !nodeId || receipt.nodeId !== nodeId || !outcome || outcome.status !== "succeeded" || !node?.decision || receipt.decisionId !== node.decision.id || !choice) {
      throw new Error("WorkflowRuntime Decision Receipt context is invalid");
    }
    if (receipt.cycleId !== visit.cycleId) {
      throw new Error("WorkflowRuntime Decision Receipt Cycle is invalid");
    }
    validateReviewer(receipt.reviewer, node.decision.reviewer);
    validateDecisionInputSchema2(
      choice.inputs ?? node.decision.inputs ?? { type: "object", fields: [] },
      receipt.inputs
    );
    if (node.decision.rationale?.required && !receipt.rationale) {
      throw new Error("WorkflowRuntime Decision Receipt rationale is invalid");
    }
    if (receipt.scope) {
      validateWorkflowDecisionScopeDefinitionForNode(
        pkg,
        receipt.nodeId,
        receipt.scope
      );
      await validateWorkflowDecisionScopeSnapshot(
        runRoot,
        pkg,
        state,
        receipt.scope,
        { requireCurrentScope: false, verifyArtifactContent: false }
      );
    }
  }
  return { identity, package: pkg };
}
async function verifyStoredRun(location) {
  const state = await location.readState();
  if (!state) throw new Error(`No Comet Run found in: ${location.runRoot}`);
  const verified = await verifyStoredPackage(location.runRoot, state);
  const pending = await verifyStoredAction(
    location.runRoot,
    state,
    verified.identity,
    verified.package
  );
  return { state, ...verified, pending };
}
async function continuationFromVerifiedRun(verified, runRoot) {
  const trajectory = await readTrajectory(
    runRoot,
    verified.state.trajectoryRef
  );
  return continuation(
    {
      state: verified.state,
      action: verified.pending,
      evals: verified.state.status === "completed" ? terminalEvaluationResults(trajectory) : [],
      ...verified.pending ? {} : {
        reason: verified.state.status === "running" ? "Run has no pending action" : verified.state.status === "failed" ? `Run is ${verified.state.status}` : void 0
      }
    },
    verified.identity
  );
}
async function inspectWorkflowRun(target) {
  return withStructuredRuntimeErrors(async () => {
    const location = resolveWorkflowRunLocation(target);
    try {
      if (!await location.readState()) return null;
    } catch (error) {
      const code = error.code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw error;
    }
    return continuationFromVerifiedRun(
      await verifyStoredRun(location),
      location.runRoot
    );
  });
}
async function prepareWorkflowSubmission(target, submission) {
  const location = resolveWorkflowRunLocation(target);
  const verified = await verifyStoredRun(location);
  const pending = verified.pending;
  if (!pending || !verified.state.pending || verified.state.status !== "waiting") {
    throw new Error(`Run is ${verified.state.status}`);
  }
  if (submission.actionId !== pending.id) {
    throw new Error(
      `Outcome does not match pending action: ${submission.actionId}`
    );
  }
  const node = currentNode(verified.state, verified.identity, pending);
  if (pending.type === "ask_user" && !isDecisionSubmission(submission)) {
    throw new Error("Decision response required for pending ask_user action");
  }
  if (pending.type !== "ask_user" && isDecisionSubmission(submission)) {
    throw new Error(`Decision response cannot satisfy ${pending.type} action`);
  }
  if (submission.nodeId !== void 0 && submission.nodeId !== node) {
    throw new Error(
      `Submission Node does not match pending Node: ${submission.nodeId}`
    );
  }
  if (isDecisionSubmission(submission)) {
    validateDecisionResponse(verified, pending, node, submission);
  }
  return { location, verified, pending, node };
}
function validateDecisionResponse(verified, pending, node, submission) {
  if (pending.type !== "ask_user") {
    throw new Error(`Decision response cannot satisfy ${pending.type} action`);
  }
  const runtimeState = verified.state.workflowRuntime;
  if (!runtimeState) {
    throw new Error(
      "Decision response requires revisioned WorkflowRuntime state"
    );
  }
  if (submission.revision !== runtimeState.revision) {
    throw new Error(
      `Decision response revision does not match Run revision: ${submission.revision}`
    );
  }
  if (submission.nodeId !== node) {
    throw new Error(
      `Decision Node does not match pending Node: ${submission.nodeId}`
    );
  }
  if (submission.attemptId !== pending.attemptId) {
    throw new Error(
      `Decision Attempt does not match pending Attempt: ${submission.attemptId}`
    );
  }
  if (submission.cycleId !== (pending.cycleId ?? null)) {
    throw new Error(
      `Decision Cycle does not match pending Cycle: ${submission.cycleId}`
    );
  }
  validateDecisionExecution(submission, verified.identity);
  const workflowNode = verified.package.runtime.protocol.nodes.find(
    (candidate) => candidate.id === node
  );
  if (!workflowNode?.decision) {
    throw new Error(
      `WorkflowRuntime decision Node is missing: ${node ?? "(none)"}`
    );
  }
  if (submission.decisionId && submission.decisionId !== workflowNode.decision.id) {
    throw new Error(
      `Decision id does not match pending decision: ${submission.decisionId}`
    );
  }
  const choice = workflowNode.decision.choices.find(
    (candidate) => candidate.id === submission.choiceId
  );
  if (!choice) {
    throw new Error(`Decision choice is not declared: ${submission.choiceId}`);
  }
  if (pending.decisionId !== workflowNode.decision.id) {
    throw new Error("WorkflowRuntime pending decision identity is invalid");
  }
  if (!pending.choices?.some((candidate) => candidate.id === choice.id)) {
    throw new Error(
      `Decision choice is not accepted by pending action: ${choice.id}`
    );
  }
  validateWorkflowDecisionScopeResponse(
    pending.scope,
    submission.scope,
    submission.evidenceReferences
  );
  validateReviewer(submission.reviewer, workflowNode.decision.reviewer);
  const inputs = submission.inputs ?? {};
  validateDecisionInputSchema2(
    choice.inputs ?? workflowNode.decision.inputs ?? { type: "object", fields: [] },
    inputs
  );
  if (pending.rationale?.required && !submission.rationale) {
    throw new Error("Decision rationale is required");
  }
}
function engineOutcome(prepared, submission, artifactMutation) {
  if (!isDecisionSubmission(submission)) {
    const artifacts = artifactMutation ? artifactMutation.artifactPaths : submission.artifacts;
    return {
      actionId: prepared.pending.id,
      status: submission.status,
      summary: submission.summary,
      ...artifacts && Object.keys(artifacts).length > 0 ? { artifacts } : {},
      ...submission.state ? { state: submission.state } : {},
      ...submission.evidence ? { evidence: submission.evidence } : {},
      ...submission.routing ? { routing: submission.routing } : {},
      ...artifactMutation && Object.keys(artifactMutation.selectedVersionIds).length > 0 ? { artifactVersions: artifactMutation.selectedVersionIds } : submission.artifactVersions ? { artifactVersions: submission.artifactVersions } : {}
    };
  }
  const node = prepared.verified.package.runtime.protocol.nodes.find(
    (candidate) => candidate.id === prepared.node
  );
  const decision = node.decision;
  const choice = decision.choices.find(
    (candidate) => candidate.id === submission.choiceId
  );
  return {
    actionId: prepared.pending.id,
    status: "succeeded",
    summary: `Decision ${decision.id}: ${choice.id}`,
    kind: "decision",
    revision: submission.revision,
    nodeId: submission.nodeId,
    cycleId: submission.cycleId,
    attemptId: submission.attemptId,
    decisionId: decision.id,
    choiceId: choice.id,
    reviewer: structuredClone(submission.reviewer),
    inputs: structuredClone(submission.inputs ?? {}),
    ...submission.rationale !== void 0 ? { rationale: submission.rationale } : {},
    ...submission.evidenceReferences ? { evidenceReferences: [...submission.evidenceReferences] } : {},
    ...prepared.pending.scope ? { scope: structuredClone(prepared.pending.scope) } : {},
    routing: {
      [decision.id]: choice.id,
      ...choice.routing ?? {}
    }
  };
}
async function completionBlockers(prepared, submission) {
  if (isDecisionSubmission(submission)) return [];
  if (submission.status !== "succeeded" || !prepared.node) return [];
  const workflowNode = prepared.verified.package.runtime.protocol.nodes.find(
    (candidate) => candidate.id === prepared.node
  );
  if (!workflowNode) {
    throw new Error(`WorkflowRuntime Node is missing: ${prepared.node}`);
  }
  const plan = prepared.verified.package.runtime.completionPlans?.[prepared.node] ?? createCompletionPlan(workflowNode);
  if (JSON.stringify(stableValue(plan)) !== JSON.stringify(stableValue(createCompletionPlan(workflowNode)))) {
    throw new Error(
      `WorkflowRuntime completion plan does not match Node: ${prepared.node}`
    );
  }
  return validateSuccessfulSubmission(
    prepared.location.runRoot,
    prepared.verified.package.runtime.protocol,
    workflowNode,
    plan,
    submission
  );
}
function routeBlockers(prepared, submission) {
  const protocol = prepared.verified.package.runtime.protocol;
  if (!isDecisionSubmission(submission) && submission.status !== "succeeded" || !prepared.node || !isRevisionedWorkflowProtocol(protocol)) {
    return [];
  }
  try {
    resolveWorkflowTransition(
      protocol,
      prepared.node,
      engineOutcome(prepared, submission),
      prepared.verified.state.workflowRuntime,
      prepared.verified.state.runId
    );
    return [];
  } catch (error) {
    if (error instanceof WorkflowRouteResolutionError) {
      return error.blockers;
    }
    throw error;
  }
}
async function artifactMutationForSubmission(prepared, submission) {
  if (isDecisionSubmission(submission) || !prepared.node) {
    return { blockers: [] };
  }
  const versioned = prepared.verified.package.runtime.protocol.capabilities?.features.includes(
    "versioned-artifacts"
  ) === true;
  if (!versioned) {
    return Object.keys(submission.artifactVersions ?? {}).length > 0 ? {
      blockers: [
        "Workflow artifact selections require versioned-artifacts capability"
      ]
    } : { blockers: [] };
  }
  if (submission.status !== "succeeded") {
    return Object.keys(submission.artifacts ?? {}).length > 0 ? {
      blockers: ["Failed submissions cannot update versioned artifacts"]
    } : { blockers: [] };
  }
  try {
    return {
      mutation: await prepareWorkflowArtifactMutation({
        runRoot: prepared.location.runRoot,
        protocol: prepared.verified.package.runtime.protocol,
        state: prepared.verified.state,
        nodeId: prepared.node,
        actionId: prepared.pending.id,
        ...submission.artifacts ? { artifacts: submission.artifacts } : {},
        ...submission.artifactVersions ? { artifactVersions: submission.artifactVersions } : {}
      }),
      blockers: []
    };
  } catch (error) {
    if (error instanceof WorkflowArtifactValidationError) {
      return { blockers: [...error.blockers] };
    }
    throw error;
  }
}
function blockedContinuation(prepared, blockers) {
  const projected = boundWorkflowFindings(
    blockers.map(
      (blocker) => findingFromBlocker(blocker, {
        actionId: prepared.pending.id,
        nodeId: prepared.node
      })
    )
  );
  return {
    disposition: "blocked",
    runId: prepared.verified.state.runId,
    revision: prepared.verified.state.workflowRuntime?.revision ?? 0,
    currentNode: prepared.node,
    cycleId: prepared.verified.state.workflowRuntime?.currentCycle?.id ?? prepared.verified.state.workflowRuntime?.currentAttempt?.cycleId ?? null,
    attemptId: prepared.verified.state.workflowRuntime?.currentAttempt?.id ?? null,
    visitOrdinal: prepared.verified.state.workflowRuntime?.currentAttempt?.visitOrdinal ?? null,
    retryOrdinal: prepared.verified.state.workflowRuntime?.currentAttempt?.retryOrdinal ?? null,
    pendingAction: prepared.pending,
    execution: structuredClone(prepared.verified.identity),
    decisionReceipts: structuredClone(
      prepared.verified.state.workflowRuntime?.decisionReceipts ?? []
    ),
    cycles: structuredClone(
      prepared.verified.state.workflowRuntime?.cycles ?? []
    ),
    visits: structuredClone(
      prepared.verified.state.workflowRuntime?.visits ?? []
    ),
    artifactVersions: structuredClone(
      prepared.verified.state.workflowRuntime?.artifactVersions ?? []
    ),
    artifactSelections: structuredClone(
      prepared.verified.state.workflowRuntime?.artifactSelections ?? []
    ),
    currentArtifactVersions: currentWorkflowArtifactVersions(
      prepared.verified.state.workflowRuntime
    ),
    findings: projected.findings,
    findingSummary: projected.summary,
    requiresUserDecision: projected.findings.some(
      (finding) => finding.requiresUserDecision
    ),
    blockers: legacyBlockersFromFindings("blocked", projected.findings)
  };
}
async function validateWorkflowSubmission(target, submission) {
  return withStructuredRuntimeErrors(async () => {
    validateSubmission(submission);
    const prepared = await prepareWorkflowSubmission(target, submission);
    const blockers = await completionBlockers(prepared, submission);
    if (blockers.length > 0) {
      return blockedContinuation(prepared, blockers);
    }
    const routeFindings = routeBlockers(prepared, submission);
    if (routeFindings.length > 0) {
      return blockedContinuation(prepared, routeFindings);
    }
    const artifact = await artifactMutationForSubmission(prepared, submission);
    if (artifact.blockers.length > 0) {
      return blockedContinuation(prepared, artifact.blockers);
    }
    return continuationFromVerifiedRun(
      prepared.verified,
      prepared.location.runRoot
    );
  });
}
async function verifyWorkflowProtocol(protocol) {
  const compiled = await compileWorkflow(protocol);
  return {
    ...compiled.identity,
    snapshotHash: compiled.identity.packageHash
  };
}
async function projectWorkflowHandoff(protocol, current) {
  const execution = await verifyWorkflowProtocol(protocol);
  const projectedCurrent = current ? boundedContinuation(current) : null;
  if (projectedCurrent && !sameExecutionIdentity(projectedCurrent.execution, execution)) {
    throw new Error(
      "WorkflowRuntime handoff identity does not match generated protocol"
    );
  }
  return {
    schemaVersion: 1,
    workflow: {
      name: protocol.name,
      goal: protocol.goal,
      protocolHash: execution.protocolHash
    },
    execution,
    nodes: structuredClone(protocol.nodes),
    outputSchemas: structuredClone(protocol.outputSchemas),
    decisionReceipts: boundProjectedLedger(
      projectedCurrent?.decisionReceipts ?? []
    ),
    cycles: boundProjectedLedger(projectedCurrent?.cycles ?? []),
    visits: projectedCurrent?.disposition === "await-user" ? boundProjectedLedger(redactVisitEvidence(projectedCurrent.visits)) : boundProjectedLedger(projectedCurrent?.visits ?? []),
    artifactVersions: boundProjectedLedger(
      projectedCurrent?.artifactVersions ?? []
    ),
    artifactSelections: boundProjectedLedger(
      projectedCurrent?.artifactSelections ?? []
    ),
    currentArtifactVersions: structuredClone(
      projectedCurrent?.currentArtifactVersions ?? {}
    ),
    findings: structuredClone(projectedCurrent?.findings ?? []),
    findingSummary: structuredClone(
      projectedCurrent?.findingSummary ?? emptyFindingSummary()
    ),
    requiresUserDecision: projectedCurrent?.requiresUserDecision ?? false,
    continuation: projectedCurrent
  };
}
async function resumeStoredRun(location, options) {
  const verified = await verifyStoredRun(location);
  const result = await location.resume({
    confirmations: options.confirmations ?? [],
    resolver: resolverForPackage(),
    prepareAction: prepareWorkflowAction
  });
  if (result.state.status !== "completed") {
    return continuation(result, verified.identity);
  }
  const trajectory = await readTrajectory(
    location.runRoot,
    result.state.trajectoryRef
  );
  return continuation(
    { ...result, evals: terminalEvaluationResults(trajectory) },
    verified.identity
  );
}
async function prepareWorkflowAction(runRoot, pkg, state, action) {
  try {
    return {
      action: await captureWorkflowDecisionScope(runRoot, pkg, state, action)
    };
  } catch (error) {
    if (error instanceof WorkflowDecisionScopeError) {
      return { action: null, reason: error.message };
    }
    throw error;
  }
}
async function verifyStoredAction(runRoot, state, identity, pkg) {
  const action = await readPendingAction(runRoot, state.pendingRef);
  if (state.status === "waiting") {
    if (!state.pending || !action || action.id !== state.pending) {
      throw new Error(
        "WorkflowRuntime pending action does not match Run state"
      );
    }
    if (action.type === "invoke_skill" || action.type === "ask_user") {
      if (!action.stepId || !Object.values(identity.nodeToStep).includes(action.stepId)) {
        throw new Error(
          "WorkflowRuntime pending action has an unknown workflow step"
        );
      }
      if (state.currentStep !== action.stepId) {
        throw new Error(
          "WorkflowRuntime current Node does not match pending action"
        );
      }
    } else if (action.type !== "checkpoint") {
      throw new Error(
        "WorkflowRuntime pending action is not a compiled action"
      );
    } else if (state.currentStep !== action.stepId) {
      throw new Error(
        "WorkflowRuntime current Node does not match pending action"
      );
    }
    const step = pkg.definition.orchestration.steps?.find(
      (candidate) => candidate.id === action.stepId
    );
    if (!step || step.action.type !== action.type || step.action.ref !== action.ref || step.action.prompt !== action.prompt || step.action.question !== action.question || JSON.stringify(stableValue(step.action.options)) !== JSON.stringify(stableValue(action.options)) || step.action.decisionId !== action.decisionId || JSON.stringify(stableValue(step.action.choices)) !== JSON.stringify(stableValue(action.choices)) || JSON.stringify(stableValue(step.action.requiredInputs)) !== JSON.stringify(stableValue(action.requiredInputs)) || JSON.stringify(stableValue(step.action.rationale)) !== JSON.stringify(stableValue(action.rationale)) || JSON.stringify(stableValue(step.action.reviewer)) !== JSON.stringify(stableValue(action.reviewer))) {
      throw new Error(
        "WorkflowRuntime pending action does not match compiled step"
      );
    }
    if (pkg.runtime?.capabilityVersion === 3) {
      const attempt = state.workflowRuntime?.currentAttempt;
      if (!attempt || action.attemptId !== attempt.id || action.cycleId !== attempt.cycleId || action.visitOrdinal !== attempt.visitOrdinal || action.retryOrdinal !== attempt.retryOrdinal) {
        throw new Error(
          "WorkflowRuntime pending action does not match current Attempt"
        );
      }
    }
    if (action.type === "ask_user") {
      const nodeId = Object.entries(identity.nodeToStep).find(
        ([, stepId2]) => stepId2 === action.stepId
      )?.[0];
      const node = pkg.runtime?.protocol.nodes.find(
        (candidate) => candidate.id === nodeId
      );
      if (node?.decision?.scope) {
        await validateWorkflowDecisionScope(runRoot, pkg, state, action);
        const trajectory = await readTrajectory(runRoot, state.trajectoryRef);
        const proposal = trajectory.slice().reverse().find(
          (event) => event.type === "action_proposed" && isRecord6(event.data.action) && event.data.action.id === action.id
        );
        if (!proposal || !isRecord6(proposal.data.action)) {
          throw new Error(
            "WorkflowRuntime scoped decision has no durable action proposal"
          );
        }
        if (JSON.stringify(stableValue(proposal.data.action)) !== JSON.stringify(stableValue(action))) {
          throw new Error(
            "WorkflowRuntime scoped decision does not match its durable action proposal"
          );
        }
      } else {
        await validateWorkflowDecisionScope(runRoot, pkg, state, action);
      }
    }
    return action;
  }
  if (action || state.pending) {
    throw new Error("WorkflowRuntime non-waiting Run has a pending action");
  }
  if (state.status === "completed" && state.currentStep !== null) {
    throw new Error("WorkflowRuntime completed Run has a current step");
  }
  if (state.status === "running" && (state.currentStep === null || !Object.values(identity.nodeToStep).includes(state.currentStep))) {
    throw new Error(
      "WorkflowRuntime current Node is not in the compiled route"
    );
  }
  return null;
}
function createWorkflowRuntime() {
  return {
    async start(options) {
      return withStructuredRuntimeErrors(async () => {
        const resolved = resolveWorkflowStartLocation(options);
        const compiled = await compileWorkflow(options.protocol);
        const revisioned = compiled.package.runtime?.capabilityVersion === 3;
        const result = await resolved.location.start(compiled.package, {
          runId: resolved.runId,
          confirmations: options.confirmations ?? [],
          resolver: resolverForPackage(),
          runtimeIdentity: {
            ...compiled.identity,
            snapshotHash: compiled.identity.packageHash
          },
          ...revisioned ? {
            workflowRuntime: {
              revision: 0,
              nextVisitOrdinal: 0,
              currentAttempt: null,
              currentCycle: null,
              cycles: [],
              visits: [],
              decisionReceipts: [],
              artifactVersions: [],
              artifactSelections: []
            }
          } : {},
          prepareAction: prepareWorkflowAction
        });
        if (result.state.skillHash !== compiled.identity.packageHash) {
          throw new Error(
            "WorkflowRuntime snapshot identity was not persisted"
          );
        }
        return continuation(result, {
          ...compiled.identity,
          snapshotHash: result.state.skillHash
        });
      });
    },
    async resume(target, options = {}) {
      return withStructuredRuntimeErrors(async () => {
        const location = resolveWorkflowRunLocation(target);
        return resumeStoredRun(location, options);
      });
    },
    async submit(target, submission) {
      return withStructuredRuntimeErrors(async () => {
        validateSubmission(submission);
        const prepared = await prepareWorkflowSubmission(target, submission);
        const blockers = await completionBlockers(prepared, submission);
        if (blockers.length > 0) {
          return blockedContinuation(prepared, blockers);
        }
        const routeFindings = routeBlockers(prepared, submission);
        if (routeFindings.length > 0) {
          return blockedContinuation(prepared, routeFindings);
        }
        const artifact = await artifactMutationForSubmission(
          prepared,
          submission
        );
        if (artifact.blockers.length > 0) {
          return blockedContinuation(prepared, artifact.blockers);
        }
        const result = await prepared.location.resume(
          {
            resolver: resolverForPackage(),
            outcome: engineOutcome(prepared, submission, artifact.mutation),
            prepareAction: prepareWorkflowAction
          },
          artifact.mutation
        );
        return continuation(result, prepared.verified.identity);
      });
    },
    async recover(target, options = {}) {
      return withStructuredRuntimeErrors(async () => {
        const location = resolveWorkflowRunLocation(target);
        return resumeStoredRun(location, options);
      });
    }
  };
}
var defaultRuntime = createWorkflowRuntime();
var startWorkflowRun = defaultRuntime.start;
var resumeWorkflowRun = defaultRuntime.resume;
var submitWorkflowRun = defaultRuntime.submit;
var recoverWorkflowRun = defaultRuntime.recover;
export {
  createWorkflowRuntime,
  inspectWorkflowRun,
  projectWorkflowHandoff,
  projectWorkflowState,
  recoverWorkflowRun,
  resumeWorkflowRun,
  startWorkflowRun,
  submitWorkflowRun,
  validateWorkflowSubmission,
  verifyWorkflowProtocol,
  writeWorkflowStateProjection
};
