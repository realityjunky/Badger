// src/workflow-runtime/index.ts
import path11 from "node:path";

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
function validateAction(value, filePath, fieldPath) {
  assertObject(value, filePath, fieldPath);
  assertEnum(value.type, ACTION_TYPES, filePath, `${fieldPath}.type`);
  assertOptionalString(value, "ref", filePath, fieldPath);
  assertOptionalString(value, "prompt", filePath, fieldPath);
  assertOptionalString(value, "question", filePath, fieldPath);
  if ("options" in value) {
    assertStringArray(value.options, filePath, `${fieldPath}.options`);
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
  "options"
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
function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
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
  return action;
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
async function withAppendLock(key, operation) {
  const previous = appendLocks.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  appendLocks.set(key, current);
  await previous;
  try {
    return await operation();
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

// src/workflow-runtime/completion.ts
import { promises as fs5 } from "node:fs";
import path8 from "node:path";
var ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
var MAX_BLOCKERS = 32;
var MAX_BLOCKER_LENGTH = 512;
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
function expectedArtifactKind(artifact) {
  return artifact.kind === "directory" ? "directory" : "file";
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
  return segments;
}
function patternMatcher(pattern) {
  return new RegExp(
    `^${pattern.split("*").map((part) => part.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&")).join(".*")}$`,
    "u"
  );
}
async function rootForPattern(runRoot, label) {
  const stat = await fs5.lstat(runRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} Run root must be a real directory`);
  }
  return path8.resolve(runRoot);
}
async function matchingArtifactPaths(runRoot, artifactPath, expected, label) {
  const segments = artifactPatternSegments(artifactPath, label);
  const root = await rootForPattern(runRoot, label);
  async function walk(relative, index) {
    if (index >= segments.length) {
      const inspection = await inspectProtectedProjectPath(runRoot, relative, {
        label,
        expected
      });
      return inspection.exists ? [relative] : [];
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
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error(
          `${label} crosses a symbolic link or junction at ${path8.join(current, entry.name)}`
        );
      }
      if (!matcher.test(entry.name)) continue;
      const next = relative.length === 0 ? entry.name : path8.posix.join(relative, entry.name);
      matches.push(...await walk(next, index + 1));
    }
    return matches;
  }
  return walk("", 0);
}
async function artifactExists(runRoot, schema, artifact) {
  let found = false;
  for (const artifactPath of artifact.paths) {
    const label = `Output Schema artifact ${schema.id}.${artifact.id}`;
    const matches = await matchingArtifactPaths(
      runRoot,
      artifactPath,
      expectedArtifactKind(artifact),
      label
    );
    if (matches.length === 0) continue;
    found = true;
    if (artifact.kind !== "directory") {
      for (const match of matches) {
        try {
          await readProtectedProjectFile(runRoot, match, ARTIFACT_MAX_BYTES, {
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
function boundBlockers(blockers) {
  return unique(
    blockers.slice(0, MAX_BLOCKERS).map(
      (blocker) => blocker.length > MAX_BLOCKER_LENGTH ? `${blocker.slice(0, MAX_BLOCKER_LENGTH - 1)}\u2026` : blocker
    )
  );
}
async function validateSuccessfulSubmission(runRoot, protocol, node, plan, submission) {
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
  return boundBlockers(blockers);
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
function activeNodes(protocol) {
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
  const schemaIds = /* @__PURE__ */ new Set();
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
    for (const artifact of schema.artifacts) {
      if (!artifact || typeof artifact !== "object" || typeof artifact.id !== "string" || artifact.id.length === 0 || typeof artifact.required !== "boolean" || !Array.isArray(artifact.paths) || artifact.paths.some(
        (artifactPath) => typeof artifactPath !== "string"
      ) || !Array.isArray(artifact.validations)) {
        throw new Error(
          `Workflow Protocol Output Schema ${schema.id} has an invalid artifact`
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
  const active = activeNodes(protocol);
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
function compileDefinition(protocol, nodes) {
  const steps = nodes.map((node, index) => ({
    id: stepId(index, node.id),
    action: {
      type: "invoke_skill",
      ref: nodeSkillName(protocol.name, node.id)
    },
    ...nodes[index + 1] ? { next: stepId(index + 1, nodes[index + 1].id) } : {}
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
    maxIterations: Math.max(nodes.length, 1),
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
  const nodes = validateLinearRoute(protocol);
  const definition = compileDefinition(protocol, nodes);
  const nodeToStep = Object.fromEntries(
    nodes.map((node, index) => [node.id, stepId(index, node.id)])
  );
  const protocolHash = hashProtocol(protocol);
  const runtime = {
    protocolHash,
    protocol: structuredClone(protocol),
    nodeToStep: { ...nodeToStep },
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
      nodeToStep
    }
  };
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
  const retries = state.retries[action.id] ?? 0;
  if (retries > guardrails.maxRetriesPerAction) {
    return {
      allowed: false,
      reason: `Retry budget exhausted for action: ${action.id}`
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
function resolveDeterministicNext(resolver, pkg, state, step, outcome, context) {
  return resolver.resolveNext({
    pkg: readonlyCopy(pkg),
    state: readonlyCopy(state),
    step: readonlyCopy(step),
    outcome: readonlyCopy(outcome),
    context: readonlyCopy(context)
  });
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
function actionId(runId, iteration, stepId2) {
  return createHash3("sha256").update(`${runId}:${iteration}:${stepId2 ?? "adaptive"}`).digest("hex").slice(0, 16);
}
function stepFor(pkg, id) {
  return pkg.definition.orchestration.steps?.find((step) => step.id === id);
}
function startRun(pkg, runId, skillHash) {
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
    retries: {}
  };
}
function decide(pkg, state, confirmations) {
  return decideWithResolver(
    pkg,
    state,
    confirmations,
    staticDeterministicResolver,
    void 0
  );
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
  const step = stepFor(pkg, resolvedStep.id);
  if (!step) {
    return {
      state: { ...state, status: "failed" },
      action: null,
      reason: `Resolver returned unknown current step: ${resolvedStep.id}`
    };
  }
  const resolvedState = state.currentStep === step.id ? state : { ...state, currentStep: step.id };
  const action = {
    ...step.action,
    id: actionId(resolvedState.runId, resolvedState.iteration, step.id),
    stepId: step.id
  };
  return acceptAction(pkg, resolvedState, action, confirmations, state);
}
function acceptAction(pkg, state, action, confirmations, rejectedState = state) {
  const guard = checkAction(action, state, pkg.guardrails, confirmations);
  if (!guard.allowed) {
    return { state: rejectedState, action: null, reason: guard.reason };
  }
  return { state: { ...state, pending: action.id, status: "waiting" }, action };
}
function recordOutcome(pkg, state, outcome) {
  return recordOutcomeWithResolver(
    pkg,
    state,
    outcome,
    staticDeterministicResolver,
    void 0
  );
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
  const step = resolvedStep ? stepFor(pkg, resolvedStep.id) : void 0;
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
  if (outcome.status === "failed") {
    const retries = {
      ...state.retries,
      [outcome.actionId]: (state.retries[outcome.actionId] ?? 0) + 1
    };
    return { ...state, pending: null, status: "running", retries };
  }
  const next = state.orchestration === "deterministic" ? resolveDeterministicNext(resolver, pkg, state, step, outcome, context) : state.currentStep;
  if (next !== null && state.orchestration === "deterministic" && !stepFor(pkg, next)) {
    throw new Error(`Resolver returned unknown next step: ${next}`);
  }
  return {
    ...state,
    currentStep: next,
    iteration: state.iteration + 1,
    pending: null,
    status: next === null && state.orchestration === "deterministic" ? "completed" : "running"
  };
}

// src/engine/state.ts
import path9 from "path";
function assertSafeRunReference(value, key) {
  const normalized = value.replaceAll("\\", "/");
  if (path9.posix.isAbsolute(normalized) || path9.win32.isAbsolute(value) || /^(?:[A-Za-z]:|[\\/]|~)/u.test(value) || /[*?]/u.test(value) || normalized.split("/").some(
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
  "runtimeIdentity"
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
      "nodeToStep"
    ]);
    const unknownIdentityKey = Object.keys(identity).find(
      (key) => !identityKeys.has(key)
    );
    if (unknownIdentityKey) {
      throw new Error(
        `Invalid Run state: runtimeIdentity unknown field ${unknownIdentityKey}`
      );
    }
    if (typeof identity.protocolHash !== "string" || !/^[a-f0-9]{64}$/u.test(identity.protocolHash) || typeof identity.packageHash !== "string" || !/^[a-f0-9]{64}$/u.test(identity.packageHash) || typeof identity.snapshotHash !== "string" || !/^[a-f0-9]{64}$/u.test(identity.snapshotHash) || !identity.nodeToStep || typeof identity.nodeToStep !== "object" || Array.isArray(identity.nodeToStep)) {
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
      )
    };
  }
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
    ...runtimeIdentity ? { runtimeIdentity } : {}
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
  validateEvidenceRecord(outcome.evidence, "Outcome evidence");
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
async function persistDecision(changeDir, state, pkg, confirmations) {
  const decision = decide(pkg, state, new Set(confirmations));
  if (decision.action) {
    await writePendingAction(
      changeDir,
      decision.state.pendingRef,
      decision.action
    );
  }
  await writeRunState(changeDir, decision.state);
  if (decision.action) {
    await appendEvent(changeDir, decision.state, "action_proposed", {
      action: decision.action
    });
  }
  return {
    state: decision.state,
    action: decision.action,
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
  if (value && typeof value === "object" && ("confirmations" in value || "runId" in value || "runtimeIdentity" in value)) {
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
    snapshot.hash
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
    startOptions.confirmations ?? []
  );
}
async function resumeManualRun(changeDir, options = {}) {
  const state = await requiredRun(changeDir);
  const pkg = await readSkillSnapshot(changeDir, state.skillHash);
  validateSnapshotState(pkg, state);
  if (pkg.definition.orchestration.mode === "adaptive") {
    throw new Error("Adaptive orchestration requires an Agent candidate");
  }
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
    return persistDecision(changeDir, state, pkg, options.confirmations ?? []);
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
  const artifacts = {
    ...await readArtifacts(changeDir, state.artifactsRef),
    ...outcome.artifacts ?? {}
  };
  await writeArtifacts(changeDir, state.artifactsRef, artifacts);
  await appendEvent(changeDir, state, "action_completed", {
    action: pending,
    outcome
  });
  const advanced = recordOutcome(pkg, state, outcome);
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
    options.confirmations ?? []
  );
  return { ...next, evals };
}

// src/engine/standalone-run.ts
import { promises as fs6 } from "node:fs";
import path10 from "path";
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
  return path10.resolve(projectRoot, ".comet", "runs", runId);
}
function pathSegments(projectRoot) {
  const lexicalRoot = path10.resolve(projectRoot);
  const root = path10.parse(lexicalRoot).root;
  const relative = path10.relative(root, lexicalRoot);
  return relative.length === 0 ? [] : relative.split(path10.sep);
}
function runRootRelativePath(projectRoot, runRoot) {
  return path10.relative(projectRoot, runRoot).replaceAll("\\", "/");
}
function isMissing(error) {
  const code = error.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
async function resolveStandaloneProjectRoot(projectRoot, createMissing) {
  validateProjectRoot(projectRoot);
  const lexicalRoot = path10.resolve(projectRoot);
  let cursor = path10.parse(lexicalRoot).root;
  for (const segment of pathSegments(lexicalRoot)) {
    cursor = path10.join(cursor, segment);
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
    runtimeIdentity: options.runtimeIdentity
  });
}
async function resumeStandaloneRun(projectRoot, runId, options = {}) {
  return resumeManualRun(
    await checkedStandaloneRunDir(projectRoot, runId),
    options
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
    async resume(options = {}) {
      return resumeManualRun(validatedRoot, options);
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
        runtimeIdentity: options.runtimeIdentity
      });
    },
    async resume(options = {}) {
      return resumeStandaloneRun(validatedProjectRoot, validatedRunId, options);
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
function identityFromState(state) {
  if (!state.runtimeIdentity) {
    throw new Error("Run is not a WorkflowRuntime Run");
  }
  return {
    protocolHash: state.runtimeIdentity.protocolHash,
    packageHash: state.runtimeIdentity.packageHash,
    snapshotHash: state.runtimeIdentity.snapshotHash,
    nodeToStep: { ...state.runtimeIdentity.nodeToStep }
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
function validateSubmission(submission) {
  if (!submission || typeof submission !== "object") {
    throw new Error("Submission must be an object");
  }
  if (typeof submission.actionId !== "string" || !submission.actionId) {
    throw new Error("Submission actionId must be a non-empty string");
  }
  if (submission.nodeId !== void 0 && submission.nodeId !== null && (typeof submission.nodeId !== "string" || !submission.nodeId)) {
    throw new Error("Submission nodeId must be a non-empty string or null");
  }
  if (submission.status !== "succeeded" && submission.status !== "failed") {
    throw new Error("Submission status must be succeeded or failed");
  }
  if (typeof submission.summary !== "string" || !submission.summary) {
    throw new Error("Submission summary must be a non-empty string");
  }
  for (const [label, value] of [
    ["Submission artifacts", submission.artifacts],
    ["Submission state", submission.state]
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
}
function continuation(result, identity) {
  const disposition = result.action ? "continue" : result.state.status === "completed" ? "done" : "blocked";
  return {
    disposition,
    runId: result.state.runId,
    currentNode: currentNode(result.state, identity, result.action),
    pendingAction: result.action,
    execution: structuredClone(identity),
    blockers: disposition === "blocked" && result.reason ? [result.reason] : []
  };
}
var LEGACY_STATE_MAX_BYTES = 256 * 1024;
function isRecord3(value) {
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
    if (!isRecord3(event.data.action) || !isRecord3(event.data.outcome)) continue;
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
    evidence[node] = isRecord3(outcomeEvidence) ? structuredClone(outcomeEvidence) : {};
  }
  const protocol = verified.package.runtime.protocol;
  const status = projectionStatus(
    state,
    verified.pending,
    verified.package.guardrails.maxRetriesPerAction
  );
  const exhaustedAction = Object.entries(state.retries).find(
    ([, count]) => count > verified.package.guardrails.maxRetriesPerAction
  )?.[0];
  return {
    schemaVersion: 1,
    workflow: protocol.name,
    statePath: protocol.state.statePath,
    status,
    runId: state.runId,
    currentNode: currentNode(state, verified.identity, verified.pending),
    completedNodes,
    evidence,
    history,
    pendingAction: verified.pending,
    execution: structuredClone(verified.identity),
    blockers: status === "blocked" ? [
      exhaustedAction ? `Retry budget exhausted for action: ${exhaustedAction}` : `Run is ${state.status}`
    ] : []
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
  const parent = path11.posix.dirname(relativePath);
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
  const packageHash = await hashSkillPackage(pkg);
  if (packageHash !== identity.packageHash) {
    throw new Error(
      "WorkflowRuntime package identity does not match Skill snapshot"
    );
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
async function resumeStoredRun(location, options) {
  const verified = await verifyStoredRun(location);
  const result = await location.resume({
    confirmations: options.confirmations ?? []
  });
  return continuation(result, verified.identity);
}
async function verifyStoredAction(runRoot, state, identity, pkg) {
  const action = await readPendingAction(runRoot, state.pendingRef);
  if (state.status === "waiting") {
    if (!state.pending || !action || action.id !== state.pending) {
      throw new Error(
        "WorkflowRuntime pending action does not match Run state"
      );
    }
    if (action.type === "invoke_skill") {
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
    if (!step || step.action.type !== action.type || step.action.ref !== action.ref || step.action.prompt !== action.prompt || step.action.question !== action.question || JSON.stringify(step.action.options) !== JSON.stringify(action.options)) {
      throw new Error(
        "WorkflowRuntime pending action does not match compiled step"
      );
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
      const resolved = resolveWorkflowStartLocation(options);
      const compiled = await compileWorkflow(options.protocol);
      const result = await resolved.location.start(compiled.package, {
        runId: resolved.runId,
        confirmations: options.confirmations ?? [],
        runtimeIdentity: {
          ...compiled.identity,
          snapshotHash: compiled.identity.packageHash
        }
      });
      if (result.state.skillHash !== compiled.identity.packageHash) {
        throw new Error("WorkflowRuntime snapshot identity was not persisted");
      }
      return continuation(result, {
        ...compiled.identity,
        snapshotHash: result.state.skillHash
      });
    },
    async resume(target, options = {}) {
      const location = resolveWorkflowRunLocation(target);
      return resumeStoredRun(location, options);
    },
    async submit(target, submission) {
      validateSubmission(submission);
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
      if (submission.nodeId !== void 0 && submission.nodeId !== node) {
        throw new Error(
          `Submission Node does not match pending Node: ${submission.nodeId}`
        );
      }
      if (submission.status === "succeeded" && node) {
        const workflowNode = verified.package.runtime.protocol.nodes.find(
          (candidate) => candidate.id === node
        );
        if (!workflowNode) {
          throw new Error(`WorkflowRuntime Node is missing: ${node}`);
        }
        const plan = verified.package.runtime.completionPlans?.[node] ?? createCompletionPlan(workflowNode);
        if (JSON.stringify(stableValue(plan)) !== JSON.stringify(stableValue(createCompletionPlan(workflowNode)))) {
          throw new Error(
            `WorkflowRuntime completion plan does not match Node: ${node}`
          );
        }
        const blockers = await validateSuccessfulSubmission(
          location.runRoot,
          verified.package.runtime.protocol,
          workflowNode,
          plan,
          submission
        );
        if (blockers.length > 0) {
          return {
            disposition: "blocked",
            runId: verified.state.runId,
            currentNode: node,
            pendingAction: pending,
            execution: structuredClone(verified.identity),
            blockers
          };
        }
      }
      const result = await location.resume({
        outcome: {
          actionId: submission.actionId,
          status: submission.status,
          summary: submission.summary,
          ...submission.artifacts ? { artifacts: submission.artifacts } : {},
          ...submission.state ? { state: submission.state } : {},
          ...submission.evidence ? { evidence: submission.evidence } : {}
        }
      });
      return continuation(result, verified.identity);
    },
    async recover(target, options = {}) {
      const location = resolveWorkflowRunLocation(target);
      return resumeStoredRun(location, options);
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
  projectWorkflowState,
  recoverWorkflowRun,
  resumeWorkflowRun,
  startWorkflowRun,
  submitWorkflowRun,
  writeWorkflowStateProjection
};
