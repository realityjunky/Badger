// src/workflow-runtime/index.ts
import path17 from "node:path";

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
async function moveContainedFile(source, destination, options) {
  const lexicalRoot = path.resolve(options.containedRoot);
  const lexicalSource = path.resolve(source);
  const lexicalDestination = path.resolve(destination);
  if (!isInside(lexicalRoot, lexicalSource)) {
    throw new Error("Contained file move source is outside its managed root");
  }
  if (!isInside(lexicalRoot, lexicalDestination)) {
    throw new Error(
      "Contained file move destination is outside its managed root"
    );
  }
  const sourceDirectoryChain = await captureExistingContainedDirectoryChain(
    lexicalRoot,
    path.dirname(lexicalSource)
  );
  if (!sourceDirectoryChain) return false;
  const destinationDirectoryChain = await captureExistingContainedDirectoryChain(
    lexicalRoot,
    path.dirname(lexicalDestination)
  );
  if (!destinationDirectoryChain) {
    throw new Error("Contained file move destination parent is missing");
  }
  let sourceIdentity;
  let sourceRealPath;
  try {
    sourceIdentity = await fs.lstat(lexicalSource);
    sourceRealPath = await fs.realpath(lexicalSource);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (!sourceIdentity.isFile() || sourceIdentity.isSymbolicLink() || !isInside(sourceDirectoryChain[0].realPath, sourceRealPath)) {
    throw new Error(
      "Contained file move source must be a regular file inside its managed root"
    );
  }
  try {
    await fs.lstat(lexicalDestination);
    throw new Error("Contained file move destination must be missing");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await options.beforeMove?.();
  try {
    await verifyDirectoryChain(sourceDirectoryChain);
    await verifyDirectoryChain(destinationDirectoryChain);
  } catch (error) {
    throw new Error("Contained file move parent changed before move", {
      cause: error
    });
  }
  const [currentSource, currentSourceRealPath] = await Promise.all([
    fs.lstat(lexicalSource),
    fs.realpath(lexicalSource)
  ]);
  if (!currentSource.isFile() || currentSource.isSymbolicLink() || !sameUnchangedFile(sourceIdentity, currentSource) || currentSourceRealPath !== sourceRealPath) {
    throw new Error("Contained file move source changed before move");
  }
  try {
    await fs.lstat(lexicalDestination);
    throw new Error("Contained file move destination changed before move");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let linked = false;
  try {
    await fs.link(lexicalSource, lexicalDestination);
    linked = true;
  } catch (error) {
    const code = error.code;
    if (!["ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"].includes(code ?? "")) {
      throw error;
    }
    await fs.copyFile(
      lexicalSource,
      lexicalDestination,
      fsConstants.COPYFILE_EXCL
    );
  }
  const [destinationStat, destinationRealPath, currentSourceAfterLink] = await Promise.all([
    fs.lstat(lexicalDestination),
    fs.realpath(lexicalDestination),
    fs.lstat(lexicalSource)
  ]);
  if (!destinationStat.isFile() || destinationStat.isSymbolicLink() || !sameFileIdentity(sourceIdentity, currentSourceAfterLink) || (linked ? !sameFileIdentity(sourceIdentity, destinationStat) : !sameUnchangedFile(sourceIdentity, currentSourceAfterLink)) || !isInside(sourceDirectoryChain[0].realPath, destinationRealPath)) {
    throw new Error("Contained file move destination changed after move");
  }
  await options.beforeSourceUnlink?.();
  try {
    await verifyDirectoryChain(sourceDirectoryChain);
    await verifyDirectoryChain(destinationDirectoryChain);
  } catch (error) {
    throw new Error(
      "Contained file move parent changed before source removal",
      {
        cause: error
      }
    );
  }
  const [sourceBeforeUnlink, destinationBeforeUnlink] = await Promise.all([
    fs.lstat(lexicalSource),
    fs.lstat(lexicalDestination)
  ]);
  if (!sameUnchangedFile(currentSourceAfterLink, sourceBeforeUnlink) || !sameUnchangedFile(destinationStat, destinationBeforeUnlink)) {
    throw new Error(
      "Contained file move identity changed before source removal"
    );
  }
  await fs.unlink(lexicalSource);
  try {
    await verifyDirectoryChain(sourceDirectoryChain);
    await verifyDirectoryChain(destinationDirectoryChain);
  } catch (error) {
    throw new Error("Contained file move parent changed after source removal", {
      cause: error
    });
  }
  await syncDirectory(path.dirname(lexicalSource));
  if (path.dirname(lexicalSource) !== path.dirname(lexicalDestination)) {
    await syncDirectory(path.dirname(lexicalDestination));
  }
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
async function inspectProtectedProjectPath(projectRoot, relativePath2, options) {
  const relative = normalizeWorkflowRelativePath(relativePath2, options.label);
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
async function ensureProtectedProjectDirectory(projectRoot, relativePath2, options) {
  const relative = normalizeWorkflowRelativePath(relativePath2, options.label);
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
async function readProtectedProjectFile(projectRoot, relativePath2, maxBytes, options) {
  const inspection = await inspectProtectedProjectPath(
    projectRoot,
    relativePath2,
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
import { createHash as createHash3, randomUUID as randomUUID2 } from "crypto";
import { promises as fs5 } from "fs";
import path8 from "path";

// src/skill-runtime/load.ts
import path6 from "path";

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

// src/workflow-runtime/findings.ts
import path4 from "node:path";
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
  "checkpoint-history-ambiguous",
  "checkpoint-invalid",
  "catalog-version-unsupported",
  "cycle-budget-exhausted",
  "cycle-invalid",
  "decision-required",
  "evaluation-warning",
  "identity-invalid",
  "iteration-budget-exhausted",
  "no-pending-action",
  "pending-action-invalid",
  "revision-conflict",
  "recovery-required",
  "retry-budget-exhausted",
  "route-ambiguous",
  "route-invalid-value",
  "route-no-match",
  "route-unknown-field",
  "run-not-found",
  "run-lock-active",
  "run-lock-release-conflict",
  "run-lock-stale",
  "run-lock-unknown",
  "run-status",
  "scope-invalid",
  "scope-unavailable",
  "skill-not-allowed",
  "snapshot-incomplete",
  "snapshot-storage-failed",
  "snapshot-unsafe-scope",
  "snapshot-unstable",
  "state-invalid",
  "tool-not-allowed",
  "unknown-current-step",
  "unknown-next-step",
  "verification-receipt-required",
  "verification-receipt-invalid",
  "verification-receipt-stale",
  "verification-receipt-failed",
  "verification-receipt-storage-failed",
  "repair-stagnation-warning",
  "repair-stagnation-stop",
  "repair-iteration-limit",
  "repair-override-exhausted",
  "repair-decision-invalid",
  "finalization-plan-stale",
  "finalization-transaction-unknown",
  "finalization-rollback",
  "finalization-receipt-invalid"
];
var severityRank = {
  error: 0,
  warning: 1,
  info: 2
};
var registeredOperations = new Set(
  WORKFLOW_FINDING_OPERATION_IDS
);
function isRecord(value) {
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
  const normalized = path4.posix.normalize(normalizedSeparators);
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../") || path4.posix.isAbsolute(normalized)) {
    return void 0;
  }
  return normalized;
}
function operation(value) {
  if (value === void 0) return void 0;
  if (!isRecord(value)) {
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
    value.requiresUserDecision,
    value.currentRevision ?? null,
    value.currentActionId ?? null
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
  const message = left.message.localeCompare(right.message);
  if (message !== 0) return message;
  const revision = (left.currentRevision ?? -1) - (right.currentRevision ?? -1);
  if (revision !== 0) return revision;
  return (left.currentActionId ?? "").localeCompare(
    right.currentActionId ?? ""
  );
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
  if (input.currentRevision !== void 0 && (!Number.isSafeInteger(input.currentRevision) || input.currentRevision < 0)) {
    throw new Error("Workflow finding current revision must be non-negative");
  }
  if (input.currentActionId !== void 0 && input.currentActionId !== null && (typeof input.currentActionId !== "string" || input.currentActionId.length === 0 || input.currentActionId.length > MAX_WORKFLOW_FINDING_OPERATION_ARG_LENGTH || /[\u0000\r\n]/u.test(input.currentActionId))) {
    throw new Error("Workflow finding current action id is invalid");
  }
  const safePath2 = normalizeWorkflowFindingPath(input.path);
  const safeOperation = operation(input.operation);
  const allowedOperations = {
    execute: ["workflow.start", "workflow.resume"],
    decide: ["workflow.submit"],
    repair: ["workflow.submit", "workflow.recover"],
    retry: [
      "workflow.start",
      "workflow.resume",
      "workflow.submit",
      "workflow.recover"
    ]
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
    ...safePath2 ? { path: safePath2 } : {},
    requiredAction: input.requiredAction,
    ...safeOperation ? { operation: safeOperation } : {},
    requiresUserDecision: input.requiresUserDecision ?? false,
    ...input.currentRevision !== void 0 ? { currentRevision: input.currentRevision } : {},
    ...input.currentActionId !== void 0 ? { currentActionId: input.currentActionId } : {}
  };
}
function snapshotIncompleteFinding(message, path18) {
  return createWorkflowFinding({
    code: "snapshot-incomplete",
    severity: "error",
    message,
    ...path18 ? { path: path18 } : {},
    requiredAction: "stop"
  });
}
function snapshotStorageFailedFinding(message, path18) {
  return createWorkflowFinding({
    code: "snapshot-storage-failed",
    severity: "error",
    message,
    ...path18 ? { path: path18 } : {},
    requiredAction: "stop"
  });
}
function snapshotUnsafeScopeFinding(message, path18) {
  return createWorkflowFinding({
    code: "snapshot-unsafe-scope",
    severity: "error",
    message,
    ...path18 ? { path: path18 } : {},
    requiredAction: "stop"
  });
}
function snapshotUnstableFinding(message, path18) {
  return createWorkflowFinding({
    code: "snapshot-unstable",
    severity: "error",
    message,
    ...path18 ? { path: path18 } : {},
    requiredAction: "stop"
  });
}
function parseWorkflowFinding(value) {
  if (!isRecord(value)) {
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
    "requiresUserDecision",
    "currentRevision",
    "currentActionId"
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
  if (value.currentRevision !== void 0 && (typeof value.currentRevision !== "number" || !Number.isSafeInteger(value.currentRevision) || value.currentRevision < 0)) {
    throw new Error("Workflow finding current revision is invalid");
  }
  if (value.currentActionId !== void 0 && value.currentActionId !== null && typeof value.currentActionId !== "string") {
    throw new Error("Workflow finding current action id is invalid");
  }
  const finding = createWorkflowFinding({
    code: value.code,
    severity: value.severity,
    message: value.message,
    ...value.path !== void 0 ? { path: value.path } : {},
    requiredAction: value.requiredAction,
    ...value.operation !== void 0 ? { operation: value.operation } : {},
    requiresUserDecision: value.requiresUserDecision,
    ...value.currentRevision !== void 0 ? { currentRevision: value.currentRevision } : {},
    ...value.currentActionId !== void 0 ? { currentActionId: value.currentActionId } : {}
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
  if (!isRecord(value)) {
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
  if (!isRecord(value.omittedBySeverity)) {
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
  if (!isRecord(value.omittedByCode)) {
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
    match: /^Workflow Run lock is active/u,
    entry: {
      code: "run-lock-active",
      severity: "error",
      requiredAction: "retry"
    }
  },
  {
    match: /^Workflow Run lock owner is absent/u,
    entry: {
      code: "run-lock-stale",
      severity: "error",
      requiredAction: "repair",
      operationId: "workflow.recover"
    }
  },
  {
    match: /^Workflow Run lock ownership or file identity changed/u,
    entry: {
      code: "run-lock-release-conflict",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /^Workflow Run lock/u,
    entry: {
      code: "run-lock-unknown",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /^Workflow checkpoint history is ambiguous/u,
    entry: {
      code: "checkpoint-history-ambiguous",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /^Workflow checkpoint/u,
    entry: {
      code: "checkpoint-invalid",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /^WorkflowRuntime recovery is required/u,
    entry: {
      code: "recovery-required",
      severity: "error",
      requiredAction: "repair",
      operationId: "workflow.recover"
    }
  },
  {
    match: /^Workflow finalization preview is stale/u,
    entry: {
      code: "finalization-plan-stale",
      severity: "error",
      requiredAction: "repair",
      operationId: "workflow.submit"
    }
  },
  {
    match: /^Workflow finalization observed an unknown file identity/u,
    entry: {
      code: "finalization-transaction-unknown",
      severity: "error",
      requiredAction: "repair",
      operationId: "workflow.recover"
    }
  },
  {
    match: /^Workflow finalization (?:was cancelled|was rolled back)/u,
    entry: {
      code: "finalization-rollback",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /^WorkflowRuntime finalization receipt/u,
    entry: {
      code: "finalization-receipt-invalid",
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
    match: /^Workflow Verification Receipt is required:/u,
    entry: {
      code: "verification-receipt-required",
      severity: "error",
      requiredAction: "repair",
      operationId: "workflow.submit"
    }
  },
  {
    match: /^Workflow Verification Receipt (?:is stale:|content snapshot is stale:|artifact scope is stale:|candidate artifact is stale:)/u,
    entry: {
      code: "verification-receipt-stale",
      severity: "error",
      requiredAction: "repair",
      operationId: "workflow.submit"
    }
  },
  {
    match: /^Workflow Verification Receipt does not pass requirement:/u,
    entry: {
      code: "verification-receipt-failed",
      severity: "error",
      requiredAction: "repair",
      operationId: "workflow.submit"
    }
  },
  {
    match: /^Workflow Verification Receipt (?:is missing:|identity is invalid:|duplicate identity conflicts|is not valid JSON|record exceeds)/u,
    entry: {
      code: "verification-receipt-invalid",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /^Workflow Verification Receipt persistence/u,
    entry: {
      code: "verification-receipt-storage-failed",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /^Workflow repair hard stop/u,
    entry: {
      code: "repair-iteration-limit",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /^Workflow repair override has already been used/u,
    entry: {
      code: "repair-override-exhausted",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /^Workflow repair (?:override|decision)/u,
    entry: {
      code: "repair-decision-invalid",
      severity: "error",
      requiredAction: "stop"
    }
  },
  {
    match: /verification receipt|verificationReceipts/iu,
    entry: {
      code: "verification-receipt-invalid",
      severity: "error",
      requiredAction: "stop"
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
function revisionConflictFinding(currentRevision, currentActionId) {
  return createWorkflowFinding({
    code: "revision-conflict",
    severity: "error",
    message: `Workflow submission conflicts with the current Run revision ${currentRevision} and action ${currentActionId ?? "(none)"}. Refresh the authoritative continuation before retrying.`,
    requiredAction: "retry",
    operation: {
      id: "workflow.resume",
      args: currentActionId ? [currentActionId] : []
    },
    currentRevision,
    currentActionId
  });
}
function recoveryRequiredFinding(currentRevision, currentActionId, recoveryPath = ".comet/transition-journal.json") {
  return createWorkflowFinding({
    code: "recovery-required",
    severity: "error",
    message: recoveryPath === ".comet/transition-journal.json" ? "WorkflowRuntime has an unfinished transition journal. Run explicit recovery before resuming or submitting." : recoveryPath === ".comet/checkpoint-recovery-journal.json" ? "WorkflowRuntime has unfinished checkpoint recovery evidence. Run explicit recovery before resuming or submitting." : "WorkflowRuntime has an unfinished finalization transaction. Run explicit recovery before resuming or submitting.",
    requiredAction: "repair",
    operation: { id: "workflow.recover", args: [] },
    path: recoveryPath,
    ...currentRevision === void 0 ? {} : { currentRevision },
    ...currentActionId === void 0 ? {} : { currentActionId }
  });
}
function checkpointInvalidFinding(message, path18, severity = "error") {
  return createWorkflowFinding({
    code: "checkpoint-invalid",
    severity,
    message,
    path: path18,
    requiredAction: severity === "warning" ? "none" : "stop"
  });
}
function checkpointHistoryAmbiguousFinding(message, path18) {
  return createWorkflowFinding({
    code: "checkpoint-history-ambiguous",
    severity: "error",
    message,
    path: path18,
    requiredAction: "stop"
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
function repairStagnationWarningFinding(signatureHash, consecutiveFailures, remainingFailures) {
  return createWorkflowFinding({
    code: "repair-stagnation-warning",
    severity: "warning",
    message: `Equivalent repair failure has occurred ${consecutiveFailures} times; change the repair approach before the manual stop threshold. ${remainingFailures} repair attempt(s) remain.`,
    requiredAction: "retry",
    operation: { id: "workflow.resume", args: [signatureHash] }
  });
}
function repairStagnationStopFinding(signatureHash, consecutiveFailures, remainingFailures, requiresUserDecision = true) {
  return createWorkflowFinding({
    code: "repair-stagnation-stop",
    severity: "error",
    message: `Equivalent repair failure reached the manual stop threshold after ${consecutiveFailures} consecutive failure(s); an explicit repair decision is required. ${remainingFailures} repair attempt(s) remain.`,
    requiredAction: requiresUserDecision ? "decide" : "stop",
    ...requiresUserDecision ? { operation: { id: "workflow.submit", args: [signatureHash] } } : {},
    requiresUserDecision
  });
}
function repairIterationLimitFinding(signatureHash) {
  return createWorkflowFinding({
    code: "repair-iteration-limit",
    severity: "error",
    message: `The finite repair episode budget is exhausted for failure signature ${signatureHash}; no override can continue it.`,
    requiredAction: "stop"
  });
}
function repairOverrideExhaustedFinding(signatureHash) {
  return createWorkflowFinding({
    code: "repair-override-exhausted",
    severity: "error",
    message: `The one-time repair override has already been used for failure signature ${signatureHash}.`,
    requiredAction: "decide",
    operation: { id: "workflow.submit", args: [signatureHash] },
    requiresUserDecision: true
  });
}
function legacyBlockersFromFindings(disposition, findings) {
  return disposition === "blocked" ? findings.map((finding) => finding.message) : [];
}

// src/workflow-runtime/repair.ts
var WORKFLOW_REPAIR_SCHEMA_VERSION = 1;
var WORKFLOW_REPAIR_MAX_HISTORY_RECORDS = 256;
var WORKFLOW_REPAIR_MAX_COVERAGE_ENTRIES = 1024;
var WORKFLOW_REPAIR_MAX_TEXT_BYTES = 64 * 1024;
var WORKFLOW_REPAIR_DEFAULT_RATIONALE_BYTES = 4 * 1024;
var HASH_PATTERN = /^[a-f0-9]{64}$/u;
var TOKEN_PATTERN = /^[^\u0000\r\n]{1,512}$/u;
var SAFE_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;
var REPAIR_REASON_CODES = [
  "new-failure-signature",
  "repeated-failure-warning",
  "repeated-failure-stop",
  "repair-iteration-limit",
  "override-accepted",
  "override-already-used",
  "repair-decision-accepted"
];
var WORKFLOW_REPAIR_OPERATION_REGISTRY = {
  "workflow.resume": {
    idempotent: true,
    execute: async (operation2, executionCount, work) => {
      if (operation2.operation !== "workflow.resume" || executionCount < 1 || executionCount > operation2.maxExecutions) {
        throw new Error(
          "Workflow repair automatic operation exceeded its bound"
        );
      }
      return work();
    }
  }
};
function isRecord2(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function sameStableValue(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}
function boundedText(value, label) {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}
function boundedHash(value, label) {
  const result = boundedText(value, label);
  if (!HASH_PATTERN.test(result))
    throw new Error(`${label} must be a SHA-256 hash`);
  return result;
}
function nullableText(value, label) {
  if (value === void 0 || value === null) return null;
  return boundedText(value, label);
}
function nonNegativeInteger(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}
function positiveInteger(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}
function hashText(value, label) {
  if (Buffer.byteLength(value, "utf8") > WORKFLOW_REPAIR_MAX_TEXT_BYTES) {
    throw new Error(`${label} exceeds its byte bound`);
  }
  return sha256(normalizeWorkflowRepairText(value, label));
}
function normalizeWorkflowRepairText(value, label = "Workflow repair text", maxBytes = WORKFLOW_REPAIR_MAX_TEXT_BYTES) {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0 || Buffer.byteLength(normalized, "utf8") > maxBytes) {
    throw new Error(`${label} is outside its bound`);
  }
  return normalized;
}
function hashWorkflowRepairText(value, label = "Workflow repair text", maxBytes = WORKFLOW_REPAIR_MAX_TEXT_BYTES) {
  return sha256(normalizeWorkflowRepairText(value, label, maxBytes));
}
function hashValue(value) {
  return sha256(JSON.stringify(stableValue(value)));
}
function normalizedValues(values, label) {
  if (values === void 0) return [];
  if (!Array.isArray(values) || values.length > WORKFLOW_REPAIR_MAX_COVERAGE_ENTRIES) {
    throw new Error(`${label} exceeds its count boundary`);
  }
  const normalized = values.map((value) => {
    if (typeof value === "string") {
      const bounded = boundedText(value, label);
      return SAFE_IDENTITY_PATTERN.test(bounded) ? bounded : hashValue(bounded);
    }
    if (!isRecord2(value) && !Array.isArray(value)) {
      throw new Error(`${label} contains an invalid identity`);
    }
    return hashValue(value);
  });
  return [...new Set(normalized)].sort(
    (left, right) => left.localeCompare(right)
  );
}
function combinedValues(values, label) {
  return normalizedValues(
    values.flatMap((value) => value ?? []),
    label
  );
}
function identityHash(execution, explicit) {
  if (explicit !== void 0) return boundedText(explicit, "executionHash");
  if (typeof execution === "string") return boundedText(execution, "execution");
  if (execution !== void 0) return hashValue(execution);
  return hashValue({ execution: null });
}
function buildWorkflowRepairSignature(facts) {
  const attempt = typeof facts.attempt === "object" && facts.attempt !== null ? facts.attempt : void 0;
  const attemptId2 = nullableText(
    facts.attemptId ?? (typeof facts.attempt === "string" ? facts.attempt : attempt?.id),
    "attemptId"
  );
  const action = typeof facts.action === "object" && facts.action !== null ? facts.action : void 0;
  const actionId2 = facts.actionId ?? (typeof facts.action === "string" ? facts.action : action?.id);
  const protocolHash = boundedText(
    facts.protocolHash ?? facts.contractHash,
    "protocolHash"
  );
  const content = {
    schemaVersion: WORKFLOW_REPAIR_SCHEMA_VERSION,
    protocolHash,
    executionHash: identityHash(
      facts.execution ?? facts.executionIdentity,
      facts.executionHash
    ),
    actionId: attemptId2 === null ? nullableText(actionId2, "actionId") : null,
    attemptId: attemptId2,
    nodeId: nullableText(facts.nodeId ?? attempt?.nodeId, "nodeId"),
    cycleId: nullableText(facts.cycleId ?? attempt?.cycleId, "cycleId"),
    visitOrdinal: (facts.visitOrdinal ?? attempt?.visitOrdinal) === void 0 || (facts.visitOrdinal ?? attempt?.visitOrdinal) === null ? null : nonNegativeInteger(
      facts.visitOrdinal ?? attempt?.visitOrdinal,
      "visitOrdinal"
    ),
    findingCodes: combinedValues(
      [facts.findingCodes, facts.failedFindingCodes, facts.failedCheckIds],
      "findingCodes"
    ),
    failedReceiptCoverage: combinedValues(
      [
        facts.failedReceiptCoverage,
        facts.failedReceiptIds,
        facts.receiptCoverage
      ],
      "failedReceiptCoverage"
    ),
    failedAcceptanceCoverage: combinedValues(
      [
        facts.failedAcceptanceCoverage,
        facts.failedAcceptanceIds,
        facts.acceptanceCoverage
      ],
      "failedAcceptanceCoverage"
    ),
    scopeIdentities: combinedValues(
      [
        facts.scopeIdentities,
        facts.scopeHashes,
        facts.implementationScopeHash === void 0 || facts.implementationScopeHash === null ? void 0 : [facts.implementationScopeHash],
        facts.scopeHash === void 0 || facts.scopeHash === null ? void 0 : [facts.scopeHash]
      ],
      "scopeIdentities"
    ),
    snapshotIdentities: combinedValues(
      [
        facts.snapshotIdentities,
        facts.snapshotHashes,
        facts.artifactSnapshotHash === void 0 || facts.artifactSnapshotHash === null ? void 0 : [facts.artifactSnapshotHash],
        facts.snapshotHash === void 0 || facts.snapshotHash === null ? void 0 : [facts.snapshotHash]
      ],
      "snapshotIdentities"
    ),
    artifactIdentities: combinedValues(
      [
        facts.artifactIdentities,
        facts.artifactHashes,
        facts.artifactHash === void 0 || facts.artifactHash === null ? void 0 : [facts.artifactHash]
      ],
      "artifactIdentities"
    )
  };
  return {
    ...content,
    signatureHash: hashValue(content)
  };
}
function choiceOutcome(value) {
  return {
    retry: "retry",
    "retry-with-new-approach": "retry",
    stop: "stop",
    "contract-change": "contract-change",
    "replace-run": "contract-change"
  }[value];
}
function choiceLabel(id) {
  return {
    retry: "Retry with a new approach",
    "retry-with-new-approach": "Retry with a new approach",
    stop: "Stop",
    "contract-change": "Change the contract",
    "replace-run": "Change the contract"
  }[id] ?? id;
}
function normalizeChoice(value, index) {
  if (typeof value === "string") {
    const id2 = boundedText(value, `repair policy choice ${index}`);
    const outcome2 = choiceOutcome(id2);
    if (!outcome2) {
      throw new Error(`Repair policy choice has no declared outcome: ${id2}`);
    }
    return { id: id2, label: choiceLabel(id2), outcome: outcome2 };
  }
  if (!isRecord2(value)) {
    throw new Error(
      `Repair policy choice ${index} must be an object or string`
    );
  }
  const unknown = Object.keys(value).find(
    (key) => ![
      "id",
      "choiceId",
      "label",
      "description",
      "outcome",
      "effect",
      "kind"
    ].includes(key)
  );
  if (unknown)
    throw new Error(`Repair policy choice has unknown field: ${unknown}`);
  const id = boundedText(
    value.id ?? value.choiceId ?? value.kind,
    `repair policy choice ${index}.id`
  );
  const rawOutcome = value.outcome ?? value.effect ?? choiceOutcome(id);
  if (typeof rawOutcome !== "string") {
    throw new Error(`Repair policy choice ${id} requires an outcome`);
  }
  const outcome = choiceOutcome(rawOutcome) ?? rawOutcome;
  if (outcome !== "retry" && outcome !== "stop" && outcome !== "contract-change") {
    throw new Error(`Repair policy choice ${id} has an invalid outcome`);
  }
  const label = value.label ?? value.description ?? choiceLabel(id);
  return {
    id,
    label: boundedText(label, `repair policy choice ${index}.label`),
    outcome
  };
}
function policyNumber(policy, names, label) {
  const values = names.map((name) => policy[name]).filter((value2) => value2 !== void 0);
  if (values.length === 0)
    throw new Error(`Repair policy ${label} is required`);
  const value = positiveInteger(values[0], `Repair policy ${label}`);
  if (values.some((candidate) => candidate !== value)) {
    throw new Error(`Repair policy ${label} aliases disagree`);
  }
  return value;
}
function normalizeReviewer(value) {
  if (value === void 0) return {};
  if (!isRecord2(value))
    throw new Error("Repair policy reviewer must be an object");
  const unknown = Object.keys(value).find(
    (key) => key !== "subjects" && key !== "authorities"
  );
  if (unknown)
    throw new Error(`Repair policy reviewer has unknown field: ${unknown}`);
  const result = {};
  for (const key of ["subjects", "authorities"]) {
    if (value[key] === void 0) continue;
    if (!Array.isArray(value[key]) || value[key].some(
      (entry) => typeof entry !== "string" || entry.length === 0
    )) {
      throw new Error(`Repair policy reviewer ${key} must be a string array`);
    }
    const entries = [...value[key]];
    if (new Set(entries).size !== entries.length) {
      throw new Error(
        `Repair policy reviewer ${key} must not contain duplicates`
      );
    }
    result[key] = entries.sort((left, right) => left.localeCompare(right));
  }
  return result;
}
function normalizeRationale(value) {
  if (value === void 0) return { required: false };
  if (!isRecord2(value))
    throw new Error("Repair policy rationale must be an object");
  const unknown = Object.keys(value).find((key) => key !== "required");
  if (unknown)
    throw new Error(`Repair policy rationale has unknown field: ${unknown}`);
  if (value.required !== void 0 && typeof value.required !== "boolean") {
    throw new Error("Repair policy rationale required must be a boolean");
  }
  return { required: value.required === true };
}
function overrideSetting(policy) {
  const raw = policy.overridePolicy ?? policy.override ?? policy.oneTimeOverride;
  if (Object.prototype.hasOwnProperty.call(policy, "override") && policy.override === null || Object.prototype.hasOwnProperty.call(policy, "oneTimeOverride") && policy.oneTimeOverride === null || Object.prototype.hasOwnProperty.call(policy, "overridePolicy") && policy.overridePolicy === null) {
    throw new Error("Repair policy override must not be null");
  }
  let enabled = policy.allowOneTimeOverride ?? policy.allowOverride;
  let maxRationaleBytes = policy.maxOverrideRationaleBytes ?? policy.maxRationaleBytes ?? policy.maxOverrideBytes;
  if (typeof raw === "boolean") enabled ??= raw;
  if (raw !== void 0 && raw !== null && typeof raw !== "boolean" && !isRecord2(raw)) {
    throw new Error("Repair policy override must be a boolean or object");
  }
  if (isRecord2(raw)) {
    if (raw.enabled !== void 0) enabled ??= raw.enabled;
    maxRationaleBytes ??= raw.maxRationaleBytes ?? raw.maxOverrideRationaleBytes ?? raw.maxBytes;
    const unknown = Object.keys(raw).find(
      (key) => ![
        "enabled",
        "maxRationaleBytes",
        "maxOverrideRationaleBytes",
        "maxBytes"
      ].includes(key)
    );
    if (unknown)
      throw new Error(`Repair policy override has unknown field: ${unknown}`);
  }
  if (enabled !== void 0 && typeof enabled !== "boolean") {
    throw new Error("Repair policy allowOneTimeOverride must be a boolean");
  }
  if (policy.allowOneTimeOverride !== void 0 && policy.allowOverride !== void 0 && policy.allowOneTimeOverride !== policy.allowOverride) {
    throw new Error("Repair policy override aliases disagree");
  }
  const normalizedEnabled = enabled === true;
  const normalizedBytes = maxRationaleBytes === void 0 ? WORKFLOW_REPAIR_DEFAULT_RATIONALE_BYTES : positiveInteger(
    maxRationaleBytes,
    "Repair policy maxOverrideRationaleBytes"
  );
  if (normalizedBytes > WORKFLOW_REPAIR_MAX_TEXT_BYTES) {
    throw new Error(
      "Repair policy maxOverrideRationaleBytes exceeds its bound"
    );
  }
  return { enabled: normalizedEnabled, maxRationaleBytes: normalizedBytes };
}
function normalizeAutomaticRepair(value, index, maxFailures) {
  if (!isRecord2(value)) {
    throw new Error(`Repair automatic operation ${index} must be an object`);
  }
  const unknown = Object.keys(value).find(
    (key) => !["id", "operation", "idempotent", "maxExecutions"].includes(key)
  );
  if (unknown) {
    throw new Error(
      `Repair automatic operation ${index} has unknown field: ${unknown}`
    );
  }
  const id = boundedText(value.id, `Repair automatic operation ${index}.id`);
  if (value.operation !== "workflow.resume") {
    throw new Error(
      `Repair automatic operation ${id} must use workflow.resume`
    );
  }
  if (!Object.hasOwn(WORKFLOW_REPAIR_OPERATION_REGISTRY, value.operation)) {
    throw new Error(`Repair automatic operation ${id} is not registered`);
  }
  if (value.idempotent !== true) {
    throw new Error(`Repair automatic operation ${id} must be idempotent`);
  }
  const maxExecutions = value.maxExecutions === void 0 ? maxFailures : positiveInteger(
    value.maxExecutions,
    `Repair automatic operation ${id}.maxExecutions`
  );
  if (maxExecutions > maxFailures) {
    throw new Error(
      `Repair automatic operation ${id} cannot exceed the repair failure budget`
    );
  }
  return { id, operation: "workflow.resume", idempotent: true, maxExecutions };
}
function parseWorkflowRepairAutomaticOperation(value) {
  const maxExecutions = isRecord2(value) && typeof value.maxExecutions === "number" ? value.maxExecutions : WORKFLOW_REPAIR_MAX_HISTORY_RECORDS;
  return normalizeAutomaticRepair(value, 0, maxExecutions);
}
function normalizeAutomaticRepairs(policy, maxFailures) {
  const single = policy.automaticRepair;
  const plural = policy.automaticRepairs;
  if (single !== void 0 && plural !== void 0) {
    throw new Error(
      "Repair automatic operation aliases cannot both be declared"
    );
  }
  const values = plural ?? (single === void 0 ? [
    {
      id: "retry",
      operation: "workflow.resume",
      idempotent: true,
      maxExecutions: maxFailures
    }
  ] : [single]);
  if (!Array.isArray(values) || values.length === 0 || values.length > 16) {
    throw new Error(
      "Repair automatic operations must be a bounded non-empty array"
    );
  }
  const normalized = values.map(
    (value, index) => normalizeAutomaticRepair(value, index, maxFailures)
  );
  if (new Set(normalized.map((operation2) => operation2.id)).size !== normalized.length) {
    throw new Error("Repair automatic operation ids must not be duplicated");
  }
  return normalized;
}
function normalizeWorkflowRepairPolicy(value) {
  if (!isRecord2(value))
    throw new Error("Workflow repair policy must be an object");
  const allowedKeys = /* @__PURE__ */ new Set([
    "maxFailures",
    "maxRepairFailures",
    "maxVerifyFailures",
    "maxRepairIterations",
    "warningThreshold",
    "warningAtConsecutiveFailures",
    "warningAfter",
    "warnAfter",
    "manualStopThreshold",
    "manualStopAtConsecutiveFailures",
    "stopAfter",
    "manualStopAfter",
    "allowedChoices",
    "choices",
    "allowOneTimeOverride",
    "allowOverride",
    "oneTimeOverride",
    "override",
    "overridePolicy",
    "automaticRepair",
    "automaticRepairs",
    "maxOverrideRationaleBytes",
    "maxRationaleBytes",
    "maxOverrideBytes",
    "reviewer",
    "rationale"
  ]);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) throw new Error(`Repair policy has unknown field: ${unknown}`);
  const maxFailures = policyNumber(
    value,
    [
      "maxFailures",
      "maxRepairFailures",
      "maxVerifyFailures",
      "maxRepairIterations"
    ],
    "maxFailures"
  );
  const warningThreshold = policyNumber(
    value,
    [
      "warningThreshold",
      "warningAtConsecutiveFailures",
      "warningAfter",
      "warnAfter"
    ],
    "warningThreshold"
  );
  const manualStopThreshold = policyNumber(
    value,
    [
      "manualStopThreshold",
      "manualStopAtConsecutiveFailures",
      "stopAfter",
      "manualStopAfter"
    ],
    "manualStopThreshold"
  );
  if (warningThreshold > manualStopThreshold || manualStopThreshold > maxFailures) {
    throw new Error(
      "Repair policy thresholds must be warning <= manual-stop <= maxFailures"
    );
  }
  const rawChoices = value.allowedChoices ?? value.choices;
  if (value.allowedChoices !== void 0 && value.choices !== void 0 && JSON.stringify(stableValue(value.allowedChoices)) !== JSON.stringify(stableValue(value.choices))) {
    throw new Error("Repair policy choice aliases disagree");
  }
  if (!Array.isArray(rawChoices) || rawChoices.length === 0) {
    throw new Error("Repair policy allowedChoices must be a non-empty array");
  }
  const allowedChoices = rawChoices.map(normalizeChoice);
  if (new Set(allowedChoices.map((choice) => choice.id)).size !== allowedChoices.length) {
    throw new Error("Repair policy allowedChoices must not contain duplicates");
  }
  if (!allowedChoices.some(
    (choice) => choice.outcome === "stop" || choice.outcome === "contract-change"
  )) {
    throw new Error(
      "Repair policy allowedChoices must declare a stop or contract-change choice"
    );
  }
  const override = overrideSetting(value);
  const automaticRepairs = normalizeAutomaticRepairs(value, maxFailures);
  return {
    maxFailures,
    warningThreshold,
    manualStopThreshold,
    allowedChoices,
    allowOneTimeOverride: override.enabled,
    maxOverrideRationaleBytes: override.maxRationaleBytes,
    reviewer: normalizeReviewer(value.reviewer),
    rationale: normalizeRationale(value.rationale),
    automaticRepairs
  };
}
async function executeWorkflowRepairOperation(operation2, executionCount, work) {
  const registered = WORKFLOW_REPAIR_OPERATION_REGISTRY[operation2.operation];
  if (!registered || operation2.idempotent !== registered.idempotent || !Number.isSafeInteger(operation2.maxExecutions) || operation2.maxExecutions < 1) {
    throw new Error("Workflow repair automatic operation is not registered");
  }
  return registered.execute(operation2, executionCount, work);
}
function historyArray(value, maxRecords = WORKFLOW_REPAIR_MAX_HISTORY_RECORDS) {
  if (!Array.isArray(value) || value.length > maxRecords) {
    throw new Error("Workflow repair history exceeds its record boundary");
  }
  let previousRevision = -1;
  return value.map((record, index) => {
    if (!isRecord2(record) || typeof record.kind !== "string") {
      throw new Error(`Workflow repair history record ${index} is invalid`);
    }
    const allowedKeys = record.kind === "failure" ? /* @__PURE__ */ new Set([
      "kind",
      "revision",
      "actionId",
      "attemptId",
      "signatureHash",
      "findingCodes",
      "failedReceiptCoverage",
      "failedAcceptanceCoverage",
      "scopeIdentities",
      "snapshotIdentities",
      "artifactIdentities",
      "automaticRepair",
      "disposition",
      "reasonCode",
      "consecutiveFailures",
      "totalFailures",
      "remainingFailures",
      "overrideAccepted"
    ]) : record.kind === "decision" ? /* @__PURE__ */ new Set([
      "kind",
      "revision",
      "actionId",
      "attemptId",
      "signatureHash",
      "decisionId",
      "choiceId",
      "outcome",
      "reviewer",
      "rationaleHash",
      "hypothesisHash"
    ]) : record.kind === "override" ? /* @__PURE__ */ new Set([
      "kind",
      "revision",
      "actionId",
      "attemptId",
      "signatureHash",
      "decisionId",
      "choiceId",
      "outcome",
      "reviewer",
      "rationaleHash",
      "hypothesisHash"
    ]) : /* @__PURE__ */ new Set();
    const unknown = Object.keys(record).find((key) => !allowedKeys.has(key));
    if (unknown) {
      throw new Error(
        `Workflow repair history record ${index} has unknown field: ${unknown}`
      );
    }
    const revision = nonNegativeInteger(
      record.revision,
      `Workflow repair history ${index}.revision`
    );
    if (revision <= previousRevision) {
      throw new Error("Workflow repair history must be ordered by revision");
    }
    previousRevision = revision;
    const actionId2 = nullableText(
      record.actionId,
      `Workflow repair history ${index}.actionId`
    );
    const attemptId2 = nullableText(
      record.attemptId,
      `Workflow repair history ${index}.attemptId`
    );
    const signatureHash = boundedHash(
      record.signatureHash,
      `Workflow repair history ${index}.signatureHash`
    );
    if (!HASH_PATTERN.test(signatureHash)) {
      throw new Error(
        `Workflow repair history ${index} signature hash is invalid`
      );
    }
    if (record.kind === "failure") {
      const metadata = [
        record.disposition,
        record.reasonCode,
        record.consecutiveFailures,
        record.totalFailures,
        record.remainingFailures,
        record.overrideAccepted
      ];
      const hasMetadata = metadata.some((value2) => value2 !== void 0);
      if (hasMetadata && metadata.some((value2) => value2 === void 0)) {
        throw new Error(
          `Workflow repair history ${index} failure metadata is incomplete`
        );
      }
      if (record.disposition !== void 0 && !["continue", "warning", "manual-stop", "hard-stop"].includes(
        record.disposition
      )) {
        throw new Error(
          `Workflow repair history ${index} failure disposition is invalid`
        );
      }
      if (record.reasonCode !== void 0 && !REPAIR_REASON_CODES.includes(
        record.reasonCode
      )) {
        throw new Error(
          `Workflow repair history ${index} failure reasonCode is invalid`
        );
      }
      if (record.overrideAccepted !== void 0 && typeof record.overrideAccepted !== "boolean") {
        throw new Error(
          `Workflow repair history ${index} overrideAccepted is invalid`
        );
      }
      const automaticRepair = record.automaticRepair === void 0 ? void 0 : parseWorkflowRepairAutomaticOperation(record.automaticRepair);
      return {
        kind: "failure",
        revision,
        actionId: actionId2,
        attemptId: attemptId2,
        signatureHash,
        findingCodes: normalizedValues(
          record.findingCodes,
          `Workflow repair history ${index}.findingCodes`
        ),
        failedReceiptCoverage: normalizedValues(
          record.failedReceiptCoverage,
          `Workflow repair history ${index}.failedReceiptCoverage`
        ),
        failedAcceptanceCoverage: normalizedValues(
          record.failedAcceptanceCoverage,
          `Workflow repair history ${index}.failedAcceptanceCoverage`
        ),
        scopeIdentities: normalizedValues(
          record.scopeIdentities,
          `Workflow repair history ${index}.scopeIdentities`
        ),
        snapshotIdentities: normalizedValues(
          record.snapshotIdentities,
          `Workflow repair history ${index}.snapshotIdentities`
        ),
        artifactIdentities: normalizedValues(
          record.artifactIdentities,
          `Workflow repair history ${index}.artifactIdentities`
        ),
        ...hasMetadata ? {
          disposition: record.disposition,
          reasonCode: boundedText(
            record.reasonCode,
            `Workflow repair history ${index}.reasonCode`
          ),
          consecutiveFailures: nonNegativeInteger(
            record.consecutiveFailures,
            `Workflow repair history ${index}.consecutiveFailures`
          ),
          totalFailures: nonNegativeInteger(
            record.totalFailures,
            `Workflow repair history ${index}.totalFailures`
          ),
          remainingFailures: nonNegativeInteger(
            record.remainingFailures,
            `Workflow repair history ${index}.remainingFailures`
          ),
          overrideAccepted: record.overrideAccepted
        } : {},
        ...automaticRepair ? { automaticRepair } : {}
      };
    }
    if (record.kind === "decision") {
      const outcome = choiceOutcome(String(record.outcome));
      if (!outcome)
        throw new Error(
          `Workflow repair history ${index} decision outcome is invalid`
        );
      if (typeof record.reviewer !== "object" || !record.reviewer) {
        throw new Error(`Workflow repair history ${index} reviewer is invalid`);
      }
      const reviewer = record.reviewer;
      const unknownReviewer = Object.keys(reviewer).find(
        (key) => key !== "subject" && key !== "authorities"
      );
      if (unknownReviewer || typeof reviewer.subject !== "string" || !Array.isArray(reviewer.authorities)) {
        throw new Error(`Workflow repair history ${index} reviewer is invalid`);
      }
      return {
        kind: "decision",
        revision,
        actionId: boundedText(
          record.actionId,
          `Workflow repair history ${index}.actionId`
        ),
        attemptId: attemptId2,
        signatureHash,
        decisionId: boundedText(
          record.decisionId,
          `Workflow repair history ${index}.decisionId`
        ),
        choiceId: boundedText(
          record.choiceId,
          `Workflow repair history ${index}.choiceId`
        ),
        outcome,
        reviewer: {
          subject: boundedText(
            reviewer.subject,
            `Workflow repair history ${index}.reviewer.subject`
          ),
          authorities: normalizedValues(
            reviewer.authorities,
            `Workflow repair history ${index}.reviewer.authorities`
          )
        },
        rationaleHash: record.rationaleHash === null || record.rationaleHash === void 0 ? null : boundedHash(
          record.rationaleHash,
          `Workflow repair history ${index}.rationaleHash`
        ),
        hypothesisHash: record.hypothesisHash === null || record.hypothesisHash === void 0 ? null : boundedHash(
          record.hypothesisHash,
          `Workflow repair history ${index}.hypothesisHash`
        )
      };
    }
    if (record.kind === "override") {
      const overrideOutcome = choiceOutcome(String(record.outcome));
      if (!overrideOutcome) {
        throw new Error(
          `Workflow repair history ${index} override outcome is invalid`
        );
      }
      if (!isRecord2(record.reviewer)) {
        throw new Error(`Workflow repair history ${index} reviewer is invalid`);
      }
      const reviewerValue = record.reviewer;
      const unknownReviewer = Object.keys(reviewerValue).find(
        (key) => key !== "subject" && key !== "authorities"
      );
      if (unknownReviewer || typeof reviewerValue.subject !== "string" || !Array.isArray(reviewerValue.authorities)) {
        throw new Error(`Workflow repair history ${index} reviewer is invalid`);
      }
      const reviewer = {
        subject: boundedText(
          reviewerValue.subject,
          `Workflow repair history ${index}.reviewer.subject`
        ),
        authorities: normalizedValues(
          reviewerValue.authorities,
          `Workflow repair history ${index}.reviewer.authorities`
        )
      };
      return {
        kind: "override",
        revision,
        actionId: boundedText(
          record.actionId,
          `Workflow repair history ${index}.actionId`
        ),
        attemptId: attemptId2,
        signatureHash,
        decisionId: boundedText(
          record.decisionId,
          `Workflow repair history ${index}.decisionId`
        ),
        choiceId: boundedText(
          record.choiceId,
          `Workflow repair history ${index}.choiceId`
        ),
        outcome: overrideOutcome,
        reviewer,
        rationaleHash: boundedHash(
          record.rationaleHash,
          `Workflow repair history ${index}.rationaleHash`
        ),
        hypothesisHash: boundedHash(
          record.hypothesisHash,
          `Workflow repair history ${index}.hypothesisHash`
        )
      };
    }
    throw new Error(`Workflow repair history record ${index} kind is invalid`);
  });
}
function parseSignature(value) {
  if (!isRecord2(value)) {
    throw new Error("Workflow repair episode signature must be an object");
  }
  const allowedKeys = /* @__PURE__ */ new Set([
    "schemaVersion",
    "protocolHash",
    "executionHash",
    "actionId",
    "attemptId",
    "nodeId",
    "cycleId",
    "visitOrdinal",
    "findingCodes",
    "failedReceiptCoverage",
    "failedAcceptanceCoverage",
    "scopeIdentities",
    "snapshotIdentities",
    "artifactIdentities",
    "signatureHash"
  ]);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) {
    throw new Error(
      `Workflow repair episode signature has unknown field: ${unknown}`
    );
  }
  if (value.schemaVersion !== WORKFLOW_REPAIR_SCHEMA_VERSION) {
    throw new Error(
      "Workflow repair episode signature schema version is unsupported"
    );
  }
  const signature = {
    schemaVersion: WORKFLOW_REPAIR_SCHEMA_VERSION,
    protocolHash: boundedText(
      value.protocolHash,
      "Workflow repair signature protocolHash"
    ),
    executionHash: boundedText(
      value.executionHash,
      "Workflow repair signature executionHash"
    ),
    actionId: nullableText(
      value.actionId,
      "Workflow repair signature actionId"
    ),
    attemptId: nullableText(
      value.attemptId,
      "Workflow repair signature attemptId"
    ),
    nodeId: nullableText(value.nodeId, "Workflow repair signature nodeId"),
    cycleId: nullableText(value.cycleId, "Workflow repair signature cycleId"),
    visitOrdinal: value.visitOrdinal === null ? null : nonNegativeInteger(
      value.visitOrdinal,
      "Workflow repair signature visitOrdinal"
    ),
    findingCodes: normalizedValues(
      value.findingCodes,
      "Workflow repair signature findingCodes"
    ),
    failedReceiptCoverage: normalizedValues(
      value.failedReceiptCoverage,
      "Workflow repair signature failedReceiptCoverage"
    ),
    failedAcceptanceCoverage: normalizedValues(
      value.failedAcceptanceCoverage,
      "Workflow repair signature failedAcceptanceCoverage"
    ),
    scopeIdentities: normalizedValues(
      value.scopeIdentities,
      "Workflow repair signature scopeIdentities"
    ),
    snapshotIdentities: normalizedValues(
      value.snapshotIdentities,
      "Workflow repair signature snapshotIdentities"
    ),
    artifactIdentities: normalizedValues(
      value.artifactIdentities,
      "Workflow repair signature artifactIdentities"
    ),
    signatureHash: boundedText(
      value.signatureHash,
      "Workflow repair signature signatureHash"
    )
  };
  if (!HASH_PATTERN.test(signature.signatureHash)) {
    throw new Error("Workflow repair episode signature hash is invalid");
  }
  const expected = buildWorkflowRepairSignature({
    protocolHash: signature.protocolHash,
    executionHash: signature.executionHash,
    actionId: signature.actionId,
    attemptId: signature.attemptId,
    nodeId: signature.nodeId,
    cycleId: signature.cycleId,
    visitOrdinal: signature.visitOrdinal,
    findingCodes: signature.findingCodes,
    failedReceiptCoverage: signature.failedReceiptCoverage,
    failedAcceptanceCoverage: signature.failedAcceptanceCoverage,
    scopeIdentities: signature.scopeIdentities,
    snapshotIdentities: signature.snapshotIdentities,
    artifactIdentities: signature.artifactIdentities
  });
  if (!sameStableValue(expected, signature)) {
    throw new Error("Workflow repair episode signature is not canonical");
  }
  return signature;
}
function parseWorkflowRepairPendingDecision(value) {
  if (!isRecord2(value)) {
    throw new Error("Workflow repair pending decision must be an object");
  }
  const allowedKeys = /* @__PURE__ */ new Set([
    "schemaVersion",
    "decisionId",
    "actionId",
    "signatureHash",
    "failureRevision",
    "attemptId",
    "stepId",
    "nodeId",
    "cycleId",
    "visitOrdinal",
    "retryOrdinal",
    "choices",
    "rationale",
    "reviewer"
  ]);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) {
    throw new Error(
      `Workflow repair pending decision has unknown field: ${unknown}`
    );
  }
  if (value.schemaVersion !== WORKFLOW_REPAIR_SCHEMA_VERSION) {
    throw new Error(
      "Workflow repair pending decision schema version is unsupported"
    );
  }
  if (!Array.isArray(value.choices) || value.choices.length === 0) {
    throw new Error("Workflow repair pending decision choices are invalid");
  }
  const choices = value.choices.map((entry, index) => {
    const choice = normalizeChoice(entry, index);
    return choice;
  });
  if (new Set(choices.map((choice) => choice.id)).size !== choices.length) {
    throw new Error("Workflow repair pending decision choices are duplicated");
  }
  if (!isRecord2(value.rationale) || typeof value.rationale.required !== "boolean") {
    throw new Error("Workflow repair pending decision rationale is invalid");
  }
  if (!isRecord2(value.reviewer)) {
    throw new Error("Workflow repair pending decision reviewer is invalid");
  }
  const reviewer = normalizeReviewer(value.reviewer);
  const signatureHash = boundedText(
    value.signatureHash,
    "Workflow repair pending decision signatureHash"
  );
  if (!HASH_PATTERN.test(signatureHash)) {
    throw new Error(
      "Workflow repair pending decision signature hash is invalid"
    );
  }
  return {
    schemaVersion: WORKFLOW_REPAIR_SCHEMA_VERSION,
    decisionId: boundedText(
      value.decisionId,
      "Workflow repair pending decision decisionId"
    ),
    actionId: boundedText(
      value.actionId,
      "Workflow repair pending decision actionId"
    ),
    signatureHash,
    failureRevision: nonNegativeInteger(
      value.failureRevision,
      "Workflow repair pending decision failureRevision"
    ),
    attemptId: boundedText(
      value.attemptId,
      "Workflow repair pending decision attemptId"
    ),
    stepId: boundedText(
      value.stepId,
      "Workflow repair pending decision stepId"
    ),
    nodeId: boundedText(
      value.nodeId,
      "Workflow repair pending decision nodeId"
    ),
    cycleId: nullableText(
      value.cycleId,
      "Workflow repair pending decision cycleId"
    ),
    visitOrdinal: positiveInteger(
      value.visitOrdinal,
      "Workflow repair pending decision visitOrdinal"
    ),
    retryOrdinal: nonNegativeInteger(
      value.retryOrdinal,
      "Workflow repair pending decision retryOrdinal"
    ),
    choices,
    rationale: { required: value.rationale.required },
    reviewer
  };
}
function parseWorkflowRepairEpisode(value, maxRecords = WORKFLOW_REPAIR_MAX_HISTORY_RECORDS) {
  if (!isRecord2(value)) {
    throw new Error("Workflow repair episode must be an object");
  }
  const allowedKeys = /* @__PURE__ */ new Set([
    "schemaVersion",
    "history",
    "signature",
    "disposition",
    "reasonCode",
    "consecutiveFailures",
    "totalFailures",
    "remainingFailures",
    "pendingDecision"
  ]);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown)
    throw new Error(`Workflow repair episode has unknown field: ${unknown}`);
  if (value.schemaVersion !== WORKFLOW_REPAIR_SCHEMA_VERSION) {
    throw new Error("Workflow repair episode schema version is unsupported");
  }
  if (!Array.isArray(value.history)) {
    throw new Error("Workflow repair episode history must be an array");
  }
  const history = historyArray(
    value.history,
    maxRecords
  );
  const signature = value.signature === null ? null : parseSignature(value.signature);
  const dispositions = /* @__PURE__ */ new Set([
    "continue",
    "warning",
    "manual-stop",
    "hard-stop"
  ]);
  if (value.disposition !== null && !dispositions.has(value.disposition)) {
    throw new Error("Workflow repair episode disposition is invalid");
  }
  const reasonCode = nullableText(
    value.reasonCode,
    "Workflow repair episode reasonCode"
  );
  if (reasonCode !== null && !REPAIR_REASON_CODES.includes(
    reasonCode
  )) {
    throw new Error("Workflow repair episode reasonCode is invalid");
  }
  const consecutiveFailures = nonNegativeInteger(
    value.consecutiveFailures,
    "Workflow repair episode consecutiveFailures"
  );
  const totalFailures = nonNegativeInteger(
    value.totalFailures,
    "Workflow repair episode totalFailures"
  );
  const remainingFailures = nonNegativeInteger(
    value.remainingFailures,
    "Workflow repair episode remainingFailures"
  );
  const failureCount = history.filter(
    (record) => record.kind === "failure"
  ).length;
  const automaticExecutionCounts = /* @__PURE__ */ new Map();
  for (const record of history) {
    if (record.kind !== "failure" || !record.automaticRepair) continue;
    const count = (automaticExecutionCounts.get(record.automaticRepair.id) ?? 0) + 1;
    if (count > record.automaticRepair.maxExecutions) {
      throw new Error(
        "Workflow repair automatic operation history exceeds its bound"
      );
    }
    automaticExecutionCounts.set(record.automaticRepair.id, count);
  }
  if (failureCount !== totalFailures || totalFailures === 0 && signature !== null) {
    throw new Error(
      "Workflow repair episode failure counters are inconsistent"
    );
  }
  const latestFailure = [...history].reverse().find(
    (record) => record.kind === "failure"
  );
  if (latestFailure === void 0 && signature !== null || latestFailure !== void 0 && signature?.signatureHash !== latestFailure.signatureHash) {
    throw new Error(
      "Workflow repair episode signature is inconsistent with history"
    );
  }
  const pendingDecision = value.pendingDecision === void 0 ? void 0 : parseWorkflowRepairPendingDecision(value.pendingDecision);
  if (pendingDecision && signature?.signatureHash !== pendingDecision.signatureHash) {
    throw new Error(
      "Workflow repair pending decision signature is inconsistent"
    );
  }
  return {
    schemaVersion: WORKFLOW_REPAIR_SCHEMA_VERSION,
    history,
    signature,
    disposition: value.disposition ?? null,
    reasonCode,
    consecutiveFailures,
    totalFailures,
    remainingFailures,
    ...pendingDecision ? { pendingDecision } : {}
  };
}
function workflowRepairFailureRecord(revision, signature) {
  return {
    kind: "failure",
    revision: nonNegativeInteger(revision, "Workflow repair failure revision"),
    actionId: signature.actionId,
    attemptId: signature.attemptId,
    signatureHash: signature.signatureHash,
    findingCodes: [...signature.findingCodes],
    failedReceiptCoverage: [...signature.failedReceiptCoverage],
    failedAcceptanceCoverage: [...signature.failedAcceptanceCoverage],
    scopeIdentities: [...signature.scopeIdentities],
    snapshotIdentities: [...signature.snapshotIdentities],
    artifactIdentities: [...signature.artifactIdentities]
  };
}
function isStrictSubset(current, previous) {
  const previousSet = new Set(previous);
  return current.length < previous.length && current.every((value) => previousSet.has(value));
}
function semanticProgress(current, previous) {
  const failingSets = [
    [current.findingCodes, previous.findingCodes],
    [current.failedReceiptCoverage, previous.failedReceiptCoverage],
    [current.failedAcceptanceCoverage, previous.failedAcceptanceCoverage]
  ];
  const reducedFailureSet = failingSets.every(
    ([now, before]) => now.every((value) => before.includes(value))
  ) && failingSets.some(([now, before]) => isStrictSubset(now, before));
  const previousScope = /* @__PURE__ */ new Set([
    ...previous.scopeIdentities,
    ...previous.snapshotIdentities,
    ...previous.artifactIdentities
  ]);
  const newlyVerifiedScope = [
    ...current.scopeIdentities,
    ...current.snapshotIdentities,
    ...current.artifactIdentities
  ].some((value) => !previousScope.has(value));
  return reducedFailureSet || newlyVerifiedScope;
}
function workflowRepairConsecutiveFailures(current, history) {
  const failures = history.filter(
    (record) => record.kind === "failure"
  );
  let consecutive = 1;
  let later = current;
  for (let index = failures.length - 1; index >= 0; index -= 1) {
    const previous = failures[index];
    if (later.signatureHash !== previous.signatureHash || semanticProgress(later, previous)) {
      break;
    }
    consecutive += 1;
    later = previous;
  }
  return consecutive;
}
function validateOverride(request, signature, policy, history) {
  if (!policy.allowOneTimeOverride) {
    throw new Error("Workflow repair override is not allowed by policy");
  }
  if (request.expectedSignatureHash !== signature.signatureHash) {
    throw new Error(
      "Workflow repair override does not match the current failure signature"
    );
  }
  const rationale = (request.rationale ?? request.summary ?? "").trim();
  const hypothesis = (request.hypothesis ?? request.summary ?? "").trim();
  if (rationale.length === 0 || hypothesis.length === 0 || Buffer.byteLength(rationale, "utf8") > policy.maxOverrideRationaleBytes || Buffer.byteLength(hypothesis, "utf8") > policy.maxOverrideRationaleBytes) {
    throw new Error(
      "Workflow repair override rationale and hypothesis are outside their bounds"
    );
  }
  return {
    alreadyUsed: history.some(
      (record) => record.kind === "override" && record.signatureHash === signature.signatureHash
    ),
    rationale,
    hypothesis
  };
}
function decideWorkflowRepair(options) {
  const signature = buildWorkflowRepairSignature(options.facts);
  const policy = normalizeWorkflowRepairPolicy(options.policy);
  const history = historyArray(options.history, options.maxHistoryRecords);
  const current = workflowRepairFailureRecord(
    (history.at(-1)?.revision ?? 0) + 1,
    signature
  );
  const failures = history.filter(
    (record) => record.kind === "failure"
  );
  const totalFailures = failures.length + 1;
  const consecutiveFailures = workflowRepairConsecutiveFailures(
    current,
    history
  );
  const automaticLimit = Math.min(
    ...policy.automaticRepairs.map((operation2) => operation2.maxExecutions)
  );
  const effectiveMaxFailures = Math.min(policy.maxFailures, automaticLimit);
  const remainingFailures = Math.max(0, effectiveMaxFailures - totalFailures);
  const automaticRepair = totalFailures < effectiveMaxFailures && consecutiveFailures < policy.manualStopThreshold ? policy.automaticRepairs[0] ?? null : null;
  const base = {
    signature,
    consecutiveFailures,
    totalFailures,
    remainingFailures,
    totalRepairFailures: totalFailures,
    remainingIterations: remainingFailures,
    automaticRepair
  };
  if (totalFailures >= effectiveMaxFailures) {
    return {
      disposition: "hard-stop",
      reasonCode: "repair-iteration-limit",
      ...base,
      overrideAccepted: false
    };
  }
  if (consecutiveFailures < policy.warningThreshold) {
    return {
      disposition: "continue",
      reasonCode: "new-failure-signature",
      ...base,
      overrideAccepted: false
    };
  }
  if (consecutiveFailures < policy.manualStopThreshold) {
    return {
      disposition: "warning",
      reasonCode: "repeated-failure-warning",
      ...base,
      overrideAccepted: false
    };
  }
  const alreadyUsed = history.some(
    (record) => record.kind === "override" && record.signatureHash === signature.signatureHash
  );
  if (options.override) {
    const validated = validateOverride(
      options.override,
      signature,
      policy,
      history
    );
    return {
      disposition: validated.alreadyUsed ? "manual-stop" : "continue",
      reasonCode: validated.alreadyUsed ? "override-already-used" : "override-accepted",
      ...base,
      overrideAccepted: !validated.alreadyUsed
    };
  }
  return {
    disposition: "manual-stop",
    reasonCode: alreadyUsed ? "override-already-used" : "repeated-failure-stop",
    ...base,
    overrideAccepted: false
  };
}
function workflowRepairDecisionRecord(options) {
  const rationale = options.decision.rationale?.trim() ?? "";
  const hypothesis = options.decision.hypothesis?.trim() ?? "";
  if (rationale.length > 0 && Buffer.byteLength(rationale, "utf8") > options.maxRationaleBytes) {
    throw new Error("Workflow repair decision rationale exceeds its bound");
  }
  if (hypothesis.length > 0 && Buffer.byteLength(hypothesis, "utf8") > options.maxRationaleBytes) {
    throw new Error("Workflow repair decision hypothesis exceeds its bound");
  }
  const isOverride = hypothesis.length > 0;
  if (isOverride) {
    return {
      kind: "override",
      revision: options.revision,
      actionId: options.actionId,
      attemptId: options.attemptId,
      signatureHash: options.signatureHash,
      decisionId: options.decision.decisionId,
      choiceId: options.decision.choiceId,
      outcome: options.decision.outcome,
      reviewer: {
        subject: options.decision.reviewer.subject,
        authorities: [...options.decision.reviewer.authorities].sort(
          (left, right) => left.localeCompare(right)
        )
      },
      rationaleHash: hashText(rationale, "Workflow repair rationale"),
      hypothesisHash: hashText(hypothesis, "Workflow repair hypothesis")
    };
  }
  return {
    kind: "decision",
    revision: options.revision,
    actionId: options.actionId,
    attemptId: options.attemptId,
    signatureHash: options.signatureHash,
    decisionId: options.decision.decisionId,
    choiceId: options.decision.choiceId,
    outcome: options.decision.outcome,
    reviewer: {
      subject: options.decision.reviewer.subject,
      authorities: [...options.decision.reviewer.authorities].sort(
        (left, right) => left.localeCompare(right)
      )
    },
    rationaleHash: rationale.length > 0 ? hashText(rationale, "Workflow repair rationale") : null,
    hypothesisHash: null
  };
}
function workflowRepairAction(pending) {
  return {
    id: pending.actionId,
    stepId: pending.stepId,
    type: "ask_user",
    decisionId: pending.decisionId,
    question: "The repair episode requires an explicit continuation decision.",
    choices: pending.choices.map(({ id, label }) => ({ id, label })),
    requiredInputs: { type: "object", fields: [] },
    rationale: structuredClone(pending.rationale),
    reviewer: structuredClone(pending.reviewer),
    attemptId: pending.attemptId,
    cycleId: pending.cycleId,
    visitOrdinal: pending.visitOrdinal,
    retryOrdinal: pending.retryOrdinal,
    repair: structuredClone(pending)
  };
}
function isWorkflowRepairAction(action) {
  return Boolean(action?.type === "ask_user" && action.repair);
}
function repairEpisodeForFailure(options) {
  const previous = options.previous;
  const history = [
    ...previous?.history ?? [],
    {
      ...options.failure,
      disposition: options.decision.disposition,
      reasonCode: options.decision.reasonCode,
      consecutiveFailures: options.decision.consecutiveFailures,
      totalFailures: options.decision.totalFailures,
      remainingFailures: options.decision.remainingFailures,
      overrideAccepted: options.decision.overrideAccepted,
      ...options.decision.automaticRepair ? { automaticRepair: structuredClone(options.decision.automaticRepair) } : {}
    }
  ];
  return {
    schemaVersion: WORKFLOW_REPAIR_SCHEMA_VERSION,
    history,
    signature: structuredClone(options.decision.signature),
    disposition: options.decision.disposition,
    reasonCode: options.decision.reasonCode,
    consecutiveFailures: options.decision.consecutiveFailures,
    totalFailures: options.decision.totalFailures,
    remainingFailures: options.decision.remainingFailures,
    ...options.pendingDecision ? { pendingDecision: structuredClone(options.pendingDecision) } : {}
  };
}
function repairEpisodeForDecision(options) {
  const episode = structuredClone(options.previous);
  delete episode.pendingDecision;
  return {
    ...episode,
    history: [...options.previous.history, structuredClone(options.record)],
    disposition: options.disposition,
    reasonCode: options.reasonCode
  };
}

// src/workflow-runtime/snapshots.ts
import { constants as fsConstants3, promises as fs4 } from "node:fs";
import { createHash as createHash2 } from "node:crypto";
import { spawn } from "node:child_process";
import path5 from "node:path";

// src/engine/protected-run-file.ts
import { TextDecoder as TextDecoder2 } from "util";
var MAX_ENGINE_RUN_FILE_BYTES = 16 * 1024 * 1024;
function boundedMaxBytes(requested, fallback, label) {
  const value = requested ?? fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ENGINE_RUN_FILE_BYTES) {
    throw new Error(`${label} size bound is invalid`);
  }
  return value;
}
function identityOf2(stat) {
  return { dev: stat.dev, ino: stat.ino, birthtime: stat.birthtimeMs };
}
function decodeRunText(result, label) {
  try {
    return new TextDecoder2("utf-8", { fatal: true }).decode(result.bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
}
async function readSnapshot(changeDir, relativePath2, maxBytes, label, options = {}) {
  const effectiveMaxBytes = boundedMaxBytes(options.maxBytes, maxBytes, label);
  try {
    const result = await readProtectedProjectFile(
      changeDir,
      relativePath2,
      effectiveMaxBytes,
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
async function readOptionalEngineRunText(changeDir, relativePath2, maxBytes, label, options = {}) {
  if (options.overlay) {
    return options.overlay.read(
      relativePath2,
      options.maxBytes ?? maxBytes,
      label
    );
  }
  return (await readSnapshot(changeDir, relativePath2, maxBytes, label, options))?.text ?? null;
}
async function writeEngineRunText(changeDir, relativePath2, content, maxBytes, label, options = {}) {
  const effectiveMaxBytes = boundedMaxBytes(options.maxBytes, maxBytes, label);
  if (Buffer.byteLength(content, "utf8") > effectiveMaxBytes) {
    throw new Error(`${label} exceeds ${effectiveMaxBytes} bytes`);
  }
  if (options.overlay) {
    await options.overlay.write(
      relativePath2,
      content,
      effectiveMaxBytes,
      label
    );
    return;
  }
  const expected = await readSnapshot(
    changeDir,
    relativePath2,
    effectiveMaxBytes,
    label,
    options
  );
  const inspection = await inspectProtectedProjectPath(
    changeDir,
    relativePath2,
    {
      label,
      expected: "file"
    }
  );
  await atomicWriteContainedText(inspection.target, content, {
    containedRoot: inspection.projectRoot,
    exclusive: options.exclusive,
    beforeCommit: async () => {
      await options.beforeCommit?.();
      const current = await readSnapshot(
        changeDir,
        relativePath2,
        effectiveMaxBytes,
        label
      );
      if (!expected && !current) return;
      if (!expected || !current) {
        const error = new Error(
          `${label} changed before commit`
        );
        if (options.exclusive && !expected && current) error.code = "EEXIST";
        throw error;
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
async function appendEngineRunText(changeDir, relativePath2, addition, maxBytes, label, options = {}) {
  const existing = await readOptionalEngineRunText(
    changeDir,
    relativePath2,
    maxBytes,
    label,
    options
  );
  await writeEngineRunText(
    changeDir,
    relativePath2,
    `${existing ?? ""}${addition}`,
    maxBytes,
    label,
    options
  );
}
async function removeEngineRunFile(changeDir, relativePath2, label, options = {}) {
  if (options.overlay) {
    return options.overlay.remove(relativePath2, label);
  }
  const inspection = await inspectProtectedProjectPath(
    changeDir,
    relativePath2,
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

// src/workflow-runtime/snapshots.ts
var WORKFLOW_CONTENT_SNAPSHOT_DIRECTORY = ".comet/content-snapshots";
var WORKFLOW_CONTENT_SNAPSHOT_SCHEMA_VERSION = 1;
var WORKFLOW_CONTENT_SNAPSHOT_POLICY_SCHEMA_VERSION = 1;
var WORKFLOW_CONTENT_SNAPSHOT_SELECTION_SCHEMA_VERSION = 1;
var WORKFLOW_CONTENT_SNAPSHOT_DEFAULT_LIMITS = {
  maxFiles: 1e4,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxManifestBytes: 1024 * 1024,
  maxVisitedNodes: 2e4,
  maxDurationMs: 6e4,
  maxOmissionEntries: 1e3
};
var WORKFLOW_CONTENT_SNAPSHOT_HASH_TAG = "workflow-content-snapshot.v1";
var WORKFLOW_CONTENT_SNAPSHOT_POLICY_HASH_TAG = "workflow-content-snapshot-policy.v1";
var MAX_SNAPSHOT_PATH_BYTES = 64 * 1024;
var MAX_SELECTION_BYTES = 8 * 1024 * 1024;
var MAX_SNAPSHOT_FILE_BYTES = 256 * 1024 * 1024;
var MAX_SNAPSHOT_TOTAL_BYTES = 1024 * 1024 * 1024;
var MAX_SNAPSHOT_MANIFEST_BYTES = 16 * 1024 * 1024;
var MAX_SNAPSHOT_VISITED_NODES = 1e6;
var MAX_SNAPSHOT_DURATION_MS = 24 * 60 * 60 * 1e3;
var MAX_SNAPSHOT_OMISSION_ENTRIES = 1e4;
var MIN_SNAPSHOT_OMISSION_ENTRIES = 2;
var MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
var MAX_GIT_DIAGNOSTICS = 16;
var MAX_GIT_DIAGNOSTIC_BYTES = 256;
var HASH_PATTERN2 = /^[a-f0-9]{64}$/u;
var GIT_OBJECT_HASH_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
var ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
var SNAPSHOT_POLICY_KEYS = /* @__PURE__ */ new Set([
  "schemaVersion",
  "provider",
  "fallback",
  "include",
  "exclude",
  "limits",
  "hash"
]);
var SNAPSHOT_LIMIT_KEYS = /* @__PURE__ */ new Set([
  "maxFiles",
  "maxFileBytes",
  "maxTotalBytes",
  "maxManifestBytes",
  "maxVisitedNodes",
  "maxDurationMs",
  "maxOmissionEntries"
]);
var SNAPSHOT_MANIFEST_KEYS = /* @__PURE__ */ new Set([
  "schemaVersion",
  "kind",
  "origin",
  "capture",
  "createdAt",
  "complete",
  "policy",
  "limits",
  "entries",
  "omitted",
  "omittedCount",
  "omissionOverflow"
]);
var SNAPSHOT_CAPTURE_KEYS = /* @__PURE__ */ new Set([
  "provider",
  "requestedProvider",
  "fallback",
  "physicalSelection",
  "gitSelection",
  "gitEvidence"
]);
var SNAPSHOT_SELECTION_KEYS = /* @__PURE__ */ new Set([
  "schemaVersion",
  "status",
  "before",
  "after"
]);
var SNAPSHOT_SELECTION_STREAM_KEYS = /* @__PURE__ */ new Set([
  "hash",
  "visitedNodeCount",
  "recordCount",
  "storedRecordCount",
  "encodedBytes",
  "overflow",
  "unstable"
]);
var SNAPSHOT_GIT_SELECTION_STREAM_KEYS = /* @__PURE__ */ new Set([
  ...SNAPSHOT_SELECTION_STREAM_KEYS,
  "indexHash",
  "workingTreeHash",
  "outputBytes",
  "durationMs"
]);
var SNAPSHOT_GIT_EVIDENCE_KEYS = /* @__PURE__ */ new Set([
  "schemaVersion",
  "status",
  "before",
  "after",
  "diagnostics"
]);
var SNAPSHOT_GIT_METADATA_KEYS = /* @__PURE__ */ new Set(["head", "index", "workingTree"]);
var SNAPSHOT_FALLBACK_KEYS = /* @__PURE__ */ new Set(["from", "to", "reason"]);
var SNAPSHOT_ENTRY_KEYS = /* @__PURE__ */ new Set(["path", "hash", "size", "type"]);
var SNAPSHOT_OMISSION_KEYS = /* @__PURE__ */ new Set(["path", "size", "type", "reason"]);
var SNAPSHOT_OVERFLOW_KEYS = /* @__PURE__ */ new Set(["ref", "hash", "count"]);
var PHYSICAL_PROVIDER = "physical-tree";
var GIT_PROVIDER = "git";
var DEFAULT_PROTECTED_SNAPSHOT_ROOTS = [".comet"];
var INTEGRITY_OMISSION_REASONS = /* @__PURE__ */ new Set([
  "physical-enumeration-limit",
  "physical-selection-changed",
  "git-enumeration-limit",
  "git-selection-changed"
]);
var GitProviderFailure = class extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.name = "GitProviderFailure";
    this.status = status;
  }
};
var WorkflowContentSnapshotError = class extends Error {
  finding;
  constructor(finding, options) {
    super(finding.message, options);
    this.name = "WorkflowContentSnapshotError";
    this.finding = finding;
  }
};
function isRecord3(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function assertKnownFields(value, keys, label) {
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) throw new Error(`Invalid ${label}: unknown field ${unknown}`);
}
function positiveBound(value, key) {
  const hardMax = key === "maxFiles" ? MAX_SNAPSHOT_VISITED_NODES : key === "maxFileBytes" ? MAX_SNAPSHOT_FILE_BYTES : key === "maxTotalBytes" ? MAX_SNAPSHOT_TOTAL_BYTES : key === "maxManifestBytes" ? MAX_SNAPSHOT_MANIFEST_BYTES : key === "maxVisitedNodes" ? MAX_SNAPSHOT_VISITED_NODES : key === "maxDurationMs" ? MAX_SNAPSHOT_DURATION_MS : MAX_SNAPSHOT_OMISSION_ENTRIES;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > hardMax) {
    throw new Error(
      `Invalid Workflow content snapshot limits: ${key} must be a positive bounded integer`
    );
  }
  if (key === "maxOmissionEntries" && value < MIN_SNAPSHOT_OMISSION_ENTRIES) {
    throw new Error(
      "Invalid Workflow content snapshot limits: maxOmissionEntries must reserve two integrity entries"
    );
  }
  return value;
}
function normalizeSnapshotPattern(value, label) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 512 || value.includes("\\") || value.includes("\0") || path5.posix.isAbsolute(value) || path5.win32.isAbsolute(value) || value.startsWith("~")) {
    throw new Error(`${label} must be a bounded relative pattern`);
  }
  const segments = value.split("/");
  if (segments.some(
    (segment) => segment.length === 0 || segment === "." || segment === ".."
  )) {
    throw new Error(`${label} must not contain empty or traversal segments`);
  }
  if ([...value].filter((character) => character === "*" || character === "?").length > 64) {
    throw new Error(`${label} contains too many wildcards`);
  }
  return value;
}
function epsilonClosure(tokens, positions, checkpoint) {
  const closure = new Set(positions);
  const pending = [...positions];
  while (pending.length > 0) {
    if (checkpoint && !checkpoint()) return null;
    const position = pending.pop();
    const token = tokens[position];
    if (token && (token.kind === "star" || token.kind === "globstar" || token.kind === "globstar-slash") && !closure.has(position + 1)) {
      closure.add(position + 1);
      pending.push(position + 1);
    }
  }
  return closure;
}
function cooperativePatternCheckpoint(hasBudget) {
  let operationsUntilCheck = 0;
  return () => {
    if (operationsUntilCheck > 0) {
      operationsUntilCheck -= 1;
      return true;
    }
    if (!hasBudget()) return false;
    operationsUntilCheck = 63;
    return true;
  };
}
function patternTokens(normalized) {
  const tokens = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      index += 1;
      if (normalized[index + 1] === "/") {
        index += 1;
        tokens.push({ kind: "globstar-slash" });
      } else {
        tokens.push({ kind: "globstar" });
      }
    } else if (character === "*") {
      tokens.push({ kind: "star" });
    } else if (character === "?") {
      tokens.push({ kind: "question" });
    } else {
      tokens.push({ kind: "literal", value: character });
    }
  }
  return tokens;
}
function advancePattern(tokens, positions, character) {
  const next = /* @__PURE__ */ new Set();
  for (const position of positions) {
    const token = tokens[position];
    if (!token) continue;
    if (token.kind === "literal" && token.value === character) {
      next.add(position + 1);
    } else if (token.kind === "question" && character !== "/") {
      next.add(position + 1);
    } else if (token.kind === "star" && character !== "/") {
      next.add(position);
    } else if (token.kind === "globstar") {
      next.add(position);
    } else if (token.kind === "globstar-slash") {
      next.add(position);
      if (character === "/") next.add(position + 1);
    }
  }
  return epsilonClosure(tokens, next);
}
function compileWorkflowContentSnapshotPattern(pattern) {
  const normalized = normalizeSnapshotPattern(
    pattern,
    "Workflow content snapshot pattern"
  );
  const tokens = patternTokens(normalized);
  return (relative, hasBudget) => {
    const checkpoint = hasBudget ? cooperativePatternCheckpoint(hasBudget) : void 0;
    if (checkpoint && !checkpoint()) return false;
    let positions = epsilonClosure(tokens, /* @__PURE__ */ new Set([0]), checkpoint);
    if (positions === null) return false;
    for (const character of relative) {
      if (checkpoint && !checkpoint()) return false;
      positions = advancePattern(tokens, positions, character);
      if (positions === null || positions.size === 0) return false;
    }
    return epsilonClosure(tokens, positions, checkpoint)?.has(tokens.length) ?? false;
  };
}
function canonicalJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}
`;
}
function canonicalHash(value, tag) {
  return sha256(`${tag}
${JSON.stringify(stableValue(value))}`);
}
function policyHashValue(policy) {
  return canonicalHash(policy, WORKFLOW_CONTENT_SNAPSHOT_POLICY_HASH_TAG);
}
function normalizedLimits(limits) {
  if (limits !== void 0) {
    if (!isRecord3(limits)) {
      throw new Error("Workflow content snapshot limits must be an object");
    }
    assertKnownFields(
      limits,
      SNAPSHOT_LIMIT_KEYS,
      "Workflow content snapshot limits"
    );
  }
  const value = {
    ...WORKFLOW_CONTENT_SNAPSHOT_DEFAULT_LIMITS,
    ...limits ?? {}
  };
  return {
    maxFiles: positiveBound(value.maxFiles, "maxFiles"),
    maxFileBytes: positiveBound(value.maxFileBytes, "maxFileBytes"),
    maxTotalBytes: positiveBound(value.maxTotalBytes, "maxTotalBytes"),
    maxManifestBytes: positiveBound(value.maxManifestBytes, "maxManifestBytes"),
    maxVisitedNodes: positiveBound(value.maxVisitedNodes, "maxVisitedNodes"),
    maxDurationMs: positiveBound(value.maxDurationMs, "maxDurationMs"),
    maxOmissionEntries: positiveBound(
      value.maxOmissionEntries,
      "maxOmissionEntries"
    )
  };
}
function normalizedPatterns(values, label) {
  return [
    ...new Set(values.map((value) => normalizeSnapshotPattern(value, label)))
  ].sort((left, right) => left.localeCompare(right, "en"));
}
function createWorkflowContentSnapshotPolicy(input) {
  if (!isRecord3(input)) {
    throw new Error("Workflow content snapshot policy must be an object");
  }
  assertKnownFields(
    input,
    /* @__PURE__ */ new Set(["provider", "fallback", "include", "exclude", "limits", "hash"]),
    "Workflow content snapshot policy"
  );
  const provider = input.provider ?? PHYSICAL_PROVIDER;
  if (provider !== PHYSICAL_PROVIDER && provider !== GIT_PROVIDER) {
    throw new Error(
      `Unsupported Workflow content snapshot provider: ${provider}`
    );
  }
  if (input.fallback !== void 0 && input.fallback !== PHYSICAL_PROVIDER) {
    throw new Error("Unsupported Workflow content snapshot fallback");
  }
  if (input.fallback !== void 0 && provider !== GIT_PROVIDER) {
    throw new Error(
      "Workflow content snapshot fallback requires the Git provider"
    );
  }
  const include = normalizedPatterns(
    input.include,
    "Workflow snapshot include"
  );
  if (include.length === 0) {
    throw new Error("Workflow snapshot include must not be empty");
  }
  const exclude = normalizedPatterns(
    input.exclude ?? [],
    "Workflow snapshot exclude"
  );
  const policyWithoutHash = {
    schemaVersion: WORKFLOW_CONTENT_SNAPSHOT_POLICY_SCHEMA_VERSION,
    provider,
    ...input.fallback ? { fallback: input.fallback } : {},
    include,
    exclude,
    limits: normalizedLimits(input.limits)
  };
  const hash4 = policyHashValue(policyWithoutHash);
  if (input.hash !== void 0 && input.hash !== hash4) {
    throw new Error("Workflow content snapshot policy hash is invalid");
  }
  return { ...policyWithoutHash, hash: hash4 };
}
function parseWorkflowContentSnapshotPolicy(value) {
  if (!isRecord3(value)) {
    throw new Error(
      "Invalid Workflow content snapshot policy: must be an object"
    );
  }
  assertKnownFields(
    value,
    SNAPSHOT_POLICY_KEYS,
    "Workflow content snapshot policy"
  );
  if (value.schemaVersion !== WORKFLOW_CONTENT_SNAPSHOT_POLICY_SCHEMA_VERSION) {
    throw new Error("Unsupported Workflow content snapshot policy schema");
  }
  if (value.provider !== PHYSICAL_PROVIDER && value.provider !== GIT_PROVIDER) {
    throw new Error("Unsupported Workflow content snapshot provider");
  }
  if (value.fallback !== void 0 && value.fallback !== PHYSICAL_PROVIDER) {
    throw new Error("Unsupported Workflow content snapshot fallback");
  }
  if (!Array.isArray(value.include) || !Array.isArray(value.exclude)) {
    throw new Error("Workflow content snapshot policy patterns must be arrays");
  }
  if (!isRecord3(value.limits)) {
    throw new Error(
      "Workflow content snapshot policy limits must be an object"
    );
  }
  assertKnownFields(
    value.limits,
    SNAPSHOT_LIMIT_KEYS,
    "Workflow content snapshot limits"
  );
  const policy = createWorkflowContentSnapshotPolicy({
    provider: value.provider,
    ...value.fallback !== void 0 ? { fallback: value.fallback } : {},
    include: value.include,
    exclude: value.exclude,
    limits: value.limits,
    hash: typeof value.hash === "string" ? value.hash : void 0
  });
  if (typeof value.hash !== "string" || !HASH_PATTERN2.test(value.hash)) {
    throw new Error("Workflow content snapshot policy hash is invalid");
  }
  return policy;
}
function resolveSnapshotPolicy(value) {
  const policy = "hash" in value && value.hash !== void 0 ? parseWorkflowContentSnapshotPolicy(value) : createWorkflowContentSnapshotPolicy(value);
  return {
    policy,
    includeMatchers: policy.include.map(compileWorkflowContentSnapshotPattern),
    excludeMatchers: policy.exclude.map(compileWorkflowContentSnapshotPattern),
    excludedDirectoryPrefixes: policy.exclude.flatMap((pattern) => {
      if (!pattern.endsWith("/**")) return [];
      const prefix = pattern.slice(0, -3);
      return /[*?]/u.test(prefix) ? [] : [prefix];
    }).sort((left, right) => left.localeCompare(right, "en"))
  };
}
function isIncluded(policy, relative, execution) {
  const hasBudget = execution ? () => hasExecutionBudget(execution) : void 0;
  if (!policy.includeMatchers.some((matcher) => matcher(relative, hasBudget))) {
    return false;
  }
  return !policy.excludeMatchers.some(
    (matcher) => matcher(relative, hasBudget)
  );
}
function excludesDirectory(policy, relative) {
  return policy.excludedDirectoryPrefixes.includes(relative) || policy.excludeMatchers.some((matcher) => matcher(relative));
}
function isInside3(root, target) {
  const relative = path5.relative(path5.resolve(root), path5.resolve(target));
  return relative === "" || !path5.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path5.sep}`);
}
function portableRelative(root, target) {
  return path5.relative(root, target).split(path5.sep).join("/");
}
function relativePath(value, label, allowRoot = false) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_SNAPSHOT_PATH_BYTES || value.includes("\\") || value.includes("\0") || path5.posix.isAbsolute(value) || path5.win32.isAbsolute(value) || value.startsWith("~")) {
    throw new Error(`${label} must be a safe relative path`);
  }
  if (allowRoot && value === ".") return value;
  const segments = value.split("/");
  if (segments.some(
    (segment) => segment.length === 0 || segment === "." || segment === ".."
  )) {
    throw new Error(`${label} must be a normalized relative path`);
  }
  return value;
}
function hashValue2(value, label) {
  if (typeof value !== "string" || !HASH_PATTERN2.test(value)) {
    throw new Error(`${label} must be a SHA-256 hash`);
  }
  return value;
}
function nonNegativeInteger2(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}
function parseSelectionStream(value, label) {
  if (!isRecord3(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(value, SNAPSHOT_SELECTION_STREAM_KEYS, label);
  const recordCount = nonNegativeInteger2(
    value.recordCount,
    `${label}.recordCount`
  );
  const storedRecordCount = nonNegativeInteger2(
    value.storedRecordCount,
    `${label}.storedRecordCount`
  );
  const visitedNodeCount = nonNegativeInteger2(
    value.visitedNodeCount,
    `${label}.visitedNodeCount`
  );
  const encodedBytes = nonNegativeInteger2(
    value.encodedBytes,
    `${label}.encodedBytes`
  );
  if (visitedNodeCount > MAX_SNAPSHOT_VISITED_NODES || recordCount > MAX_SNAPSHOT_VISITED_NODES || encodedBytes > MAX_SELECTION_BYTES) {
    throw new Error(`${label} exceeds its enumeration bounds`);
  }
  const stream = {
    hash: hashValue2(value.hash, `${label}.hash`),
    visitedNodeCount,
    recordCount,
    storedRecordCount,
    encodedBytes,
    overflow: value.overflow,
    unstable: value.unstable
  };
  if (typeof stream.overflow !== "boolean" || typeof stream.unstable !== "boolean") {
    throw new Error(`${label} flags are invalid`);
  }
  if (storedRecordCount > recordCount || !stream.overflow && storedRecordCount !== recordCount) {
    throw new Error(`${label} record counts are inconsistent`);
  }
  return {
    ...stream,
    overflow: stream.overflow,
    unstable: stream.unstable
  };
}
function sameSelectionStream(left, right) {
  return left.hash === right.hash && left.visitedNodeCount === right.visitedNodeCount && left.recordCount === right.recordCount && left.storedRecordCount === right.storedRecordCount && left.encodedBytes === right.encodedBytes && left.overflow === right.overflow && left.unstable === right.unstable;
}
function parsePhysicalSelection(value) {
  if (!isRecord3(value)) {
    throw new Error("Workflow physical snapshot selection must be an object");
  }
  assertKnownFields(
    value,
    SNAPSHOT_SELECTION_KEYS,
    "Workflow physical snapshot selection"
  );
  if (value.schemaVersion !== WORKFLOW_CONTENT_SNAPSHOT_SELECTION_SCHEMA_VERSION) {
    throw new Error("Unsupported Workflow physical snapshot selection schema");
  }
  if (value.status !== "overflow" && value.status !== "changed" && value.status !== "overflow-and-changed") {
    throw new Error("Workflow physical snapshot selection status is invalid");
  }
  const before = parseSelectionStream(
    value.before,
    "Workflow physical snapshot selection before"
  );
  const after = parseSelectionStream(
    value.after,
    "Workflow physical snapshot selection after"
  );
  const hasOverflow = before.overflow || after.overflow;
  const changed = before.unstable || after.unstable || !sameSelectionStream(before, after);
  const expectedStatus = hasOverflow && changed ? "overflow-and-changed" : hasOverflow ? "overflow" : "changed";
  if (value.status !== expectedStatus) {
    throw new Error(
      "Workflow physical snapshot selection status is inconsistent"
    );
  }
  return {
    schemaVersion: WORKFLOW_CONTENT_SNAPSHOT_SELECTION_SCHEMA_VERSION,
    status: expectedStatus,
    before,
    after
  };
}
function parseGitSelectionStream(value, label) {
  if (!isRecord3(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(value, SNAPSHOT_GIT_SELECTION_STREAM_KEYS, label);
  const base = parseSelectionStream(
    Object.fromEntries(
      [...SNAPSHOT_SELECTION_STREAM_KEYS].map((key) => [key, value[key]])
    ),
    label
  );
  const outputBytes = nonNegativeInteger2(
    value.outputBytes,
    `${label}.outputBytes`
  );
  const durationMs = nonNegativeInteger2(
    value.durationMs,
    `${label}.durationMs`
  );
  if (outputBytes > MAX_GIT_OUTPUT_BYTES) {
    throw new Error(`${label}.outputBytes exceeds its bound`);
  }
  if (durationMs > MAX_SNAPSHOT_DURATION_MS) {
    throw new Error(`${label}.durationMs exceeds its bound`);
  }
  for (const key of ["indexHash", "workingTreeHash"]) {
    const hash4 = value[key];
    if (hash4 !== null && (typeof hash4 !== "string" || !HASH_PATTERN2.test(hash4))) {
      throw new Error(`${label}.${key} is invalid`);
    }
  }
  return {
    ...base,
    indexHash: value.indexHash,
    workingTreeHash: value.workingTreeHash,
    outputBytes,
    durationMs
  };
}
function sameGitSelectionStream(left, right) {
  return sameSelectionStream(left, right) && left.indexHash === right.indexHash && left.workingTreeHash === right.workingTreeHash;
}
function parseGitSelection(value) {
  if (!isRecord3(value)) {
    throw new Error("Workflow Git snapshot selection must be an object");
  }
  assertKnownFields(
    value,
    SNAPSHOT_SELECTION_KEYS,
    "Workflow Git snapshot selection"
  );
  if (value.schemaVersion !== WORKFLOW_CONTENT_SNAPSHOT_SELECTION_SCHEMA_VERSION) {
    throw new Error("Unsupported Workflow Git snapshot selection schema");
  }
  if (value.status !== "stable" && value.status !== "overflow" && value.status !== "changed" && value.status !== "overflow-and-changed") {
    throw new Error("Workflow Git snapshot selection status is invalid");
  }
  const before = parseGitSelectionStream(
    value.before,
    "Workflow Git snapshot selection before"
  );
  const after = parseGitSelectionStream(
    value.after,
    "Workflow Git snapshot selection after"
  );
  const hasOverflow = before.overflow || after.overflow;
  const changed = before.unstable || after.unstable || !sameGitSelectionStream(before, after);
  const expectedStatus = hasOverflow && changed ? "overflow-and-changed" : hasOverflow ? "overflow" : changed ? "changed" : "stable";
  if (value.status !== expectedStatus) {
    throw new Error("Workflow Git snapshot selection status is inconsistent");
  }
  return {
    schemaVersion: WORKFLOW_CONTENT_SNAPSHOT_SELECTION_SCHEMA_VERSION,
    status: expectedStatus,
    before,
    after
  };
}
function parseGitMetadata(value, label) {
  if (!isRecord3(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(value, SNAPSHOT_GIT_METADATA_KEYS, label);
  for (const [key, pattern] of [
    ["head", GIT_OBJECT_HASH_PATTERN],
    ["index", HASH_PATTERN2],
    ["workingTree", HASH_PATTERN2]
  ]) {
    const entry = value[key];
    if (entry !== null && (typeof entry !== "string" || !pattern.test(entry))) {
      throw new Error(`${label}.${key} is invalid`);
    }
  }
  return {
    head: value.head,
    index: value.index,
    workingTree: value.workingTree
  };
}
function parseGitEvidence(value) {
  const label = "Workflow Git snapshot evidence";
  if (!isRecord3(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(value, SNAPSHOT_GIT_EVIDENCE_KEYS, label);
  if (value.schemaVersion !== WORKFLOW_CONTENT_SNAPSHOT_SCHEMA_VERSION || value.status !== "available" && value.status !== "unavailable" && value.status !== "error" && value.status !== "nested-repository") {
    throw new Error(`${label} identity is invalid`);
  }
  if (!Array.isArray(value.diagnostics) || value.diagnostics.length > MAX_GIT_DIAGNOSTICS) {
    throw new Error(`${label}.diagnostics is invalid`);
  }
  const diagnostics = value.diagnostics.map((diagnostic, index) => {
    if (typeof diagnostic !== "string" || diagnostic.length === 0 || diagnostic.includes("\0") || Buffer.byteLength(diagnostic, "utf8") > MAX_GIT_DIAGNOSTIC_BYTES) {
      throw new Error(`${label}.diagnostics[${index}] is invalid`);
    }
    return diagnostic;
  });
  return {
    schemaVersion: WORKFLOW_CONTENT_SNAPSHOT_SCHEMA_VERSION,
    status: value.status,
    before: parseGitMetadata(value.before, `${label}.before`),
    after: parseGitMetadata(value.after, `${label}.after`),
    diagnostics
  };
}
function parseSnapshotFallback(value) {
  const label = "Workflow content snapshot fallback";
  if (!isRecord3(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(value, SNAPSHOT_FALLBACK_KEYS, label);
  const reasons = /* @__PURE__ */ new Set([
    "git-metadata-unavailable",
    "git-provider-error",
    "git-nested-repository"
  ]);
  if (value.from !== GIT_PROVIDER || value.to !== PHYSICAL_PROVIDER || typeof value.reason !== "string" || !reasons.has(value.reason)) {
    throw new Error(`${label} identity is invalid`);
  }
  return {
    from: GIT_PROVIDER,
    to: PHYSICAL_PROVIDER,
    reason: value.reason
  };
}
function parseEntry(value, index) {
  const label = `Workflow content snapshot entry ${index}`;
  if (!isRecord3(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(value, SNAPSHOT_ENTRY_KEYS, label);
  const entryPath = relativePath(value.path, `${label}.path`);
  if (value.type !== "file") throw new Error(`${label}.type is invalid`);
  return {
    path: entryPath,
    hash: hashValue2(value.hash, `${label}.hash`),
    size: nonNegativeInteger2(value.size, `${label}.size`),
    type: "file"
  };
}
var OMISSION_REASONS = /* @__PURE__ */ new Set([
  "file-size",
  "file-count",
  "total-size",
  "manifest-size",
  "changed-during-read",
  "unreadable",
  "non-regular",
  "duration",
  "physical-enumeration-limit",
  "physical-selection-changed",
  "deleted",
  "git-enumeration-limit",
  "git-selection-changed",
  "git-metadata-unavailable",
  "git-provider-error",
  "git-nested-repository"
]);
function parseOmission(value, index) {
  const label = `Workflow content snapshot omission ${index}`;
  if (!isRecord3(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(value, SNAPSHOT_OMISSION_KEYS, label);
  if (value.type !== "file" && value.type !== "directory" && value.type !== "other" || typeof value.reason !== "string" || !OMISSION_REASONS.has(
    value.reason
  )) {
    throw new Error(`${label} fields are invalid`);
  }
  return {
    path: relativePath(value.path, `${label}.path`, true),
    size: value.size === null ? null : nonNegativeInteger2(value.size, `${label}.size`),
    type: value.type,
    reason: value.reason
  };
}
function parseOverflow(value) {
  const label = "Workflow content snapshot omission overflow";
  if (!isRecord3(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(value, SNAPSHOT_OVERFLOW_KEYS, label);
  const hash4 = hashValue2(value.hash, `${label}.hash`);
  if (value.ref !== `workflow-snapshot://omitted-overflow/${hash4}`) {
    throw new Error(`${label}.ref is invalid`);
  }
  const count = nonNegativeInteger2(value.count, `${label}.count`);
  if (count < 1) throw new Error(`${label}.count must be positive`);
  return {
    ref: value.ref,
    hash: hash4,
    count
  };
}
function sameLimits(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}
function parseWorkflowContentSnapshotManifest(value) {
  const label = "Workflow content snapshot manifest";
  if (!isRecord3(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(value, SNAPSHOT_MANIFEST_KEYS, label);
  if (value.schemaVersion !== WORKFLOW_CONTENT_SNAPSHOT_SCHEMA_VERSION || value.kind !== "workflow-content-snapshot" || value.origin !== "explicit") {
    throw new Error(`${label} schema identity is invalid`);
  }
  if (!isRecord3(value.capture))
    throw new Error(`${label}.capture must be an object`);
  assertKnownFields(value.capture, SNAPSHOT_CAPTURE_KEYS, `${label}.capture`);
  if (value.capture.provider !== PHYSICAL_PROVIDER && value.capture.provider !== GIT_PROVIDER) {
    throw new Error(`${label}.capture.provider is invalid`);
  }
  const requestedProvider = value.capture.requestedProvider === void 0 ? void 0 : value.capture.requestedProvider;
  if (requestedProvider !== void 0 && requestedProvider !== PHYSICAL_PROVIDER && requestedProvider !== GIT_PROVIDER) {
    throw new Error(`${label}.capture.requestedProvider is invalid`);
  }
  const fallback = value.capture.fallback === void 0 ? void 0 : parseSnapshotFallback(value.capture.fallback);
  const physicalSelection = value.capture.physicalSelection === void 0 ? void 0 : parsePhysicalSelection(value.capture.physicalSelection);
  const gitSelection = value.capture.gitSelection === void 0 ? void 0 : parseGitSelection(value.capture.gitSelection);
  const gitEvidence = value.capture.gitEvidence === void 0 ? void 0 : parseGitEvidence(value.capture.gitEvidence);
  if (typeof value.createdAt !== "string" || !ISO_TIMESTAMP_PATTERN.test(value.createdAt) || Number.isNaN(Date.parse(value.createdAt))) {
    throw new Error(`${label}.createdAt is invalid`);
  }
  if (typeof value.complete !== "boolean") {
    throw new Error(`${label}.complete is invalid`);
  }
  const policy = parseWorkflowContentSnapshotPolicy(value.policy);
  if (fallback === void 0) {
    if (value.capture.provider !== policy.provider) {
      throw new Error(`${label}.capture provider does not match policy`);
    }
    if (requestedProvider !== void 0 && requestedProvider !== policy.provider) {
      throw new Error(`${label}.capture requested provider is inconsistent`);
    }
  } else if (policy.provider !== GIT_PROVIDER || value.capture.provider !== PHYSICAL_PROVIDER || requestedProvider !== GIT_PROVIDER) {
    throw new Error(`${label}.capture fallback is inconsistent`);
  }
  if (fallback !== void 0 && gitEvidence === void 0) {
    throw new Error(`${label}.capture fallback evidence is missing`);
  }
  if (fallback !== void 0) {
    const expectedStatus = fallback.reason === "git-metadata-unavailable" ? "unavailable" : fallback.reason === "git-nested-repository" ? "nested-repository" : "error";
    if (gitEvidence?.status !== expectedStatus) {
      throw new Error(`${label}.capture fallback evidence is inconsistent`);
    }
  }
  if (value.capture.provider === GIT_PROVIDER && (gitEvidence === void 0 || gitSelection === void 0)) {
    throw new Error(`${label}.capture Git evidence is missing`);
  }
  if (value.capture.provider === GIT_PROVIDER && gitEvidence !== void 0 && gitEvidence.status !== "available" && value.complete) {
    throw new Error(`${label}.complete is inconsistent with Git evidence`);
  }
  if (value.capture.provider !== GIT_PROVIDER && gitSelection !== void 0) {
    throw new Error(`${label}.capture Git selection is inconsistent`);
  }
  if (value.capture.provider === GIT_PROVIDER && physicalSelection !== void 0) {
    throw new Error(`${label}.capture physical selection is inconsistent`);
  }
  if (fallback === void 0 && value.capture.provider === PHYSICAL_PROVIDER && gitEvidence !== void 0) {
    throw new Error(`${label}.capture Git evidence is inconsistent`);
  }
  if (!isRecord3(value.limits))
    throw new Error(`${label}.limits must be an object`);
  assertKnownFields(value.limits, SNAPSHOT_LIMIT_KEYS, `${label}.limits`);
  const limits = normalizedLimits(
    value.limits
  );
  if (!sameLimits(limits, policy.limits)) {
    throw new Error(`${label}.limits does not match policy`);
  }
  if (!Array.isArray(value.entries) || !Array.isArray(value.omitted)) {
    throw new Error(`${label}.entries and omissions must be arrays`);
  }
  const entries = value.entries.map(parseEntry);
  const omitted = value.omitted.map(parseOmission);
  const gitOmissionReasons = /* @__PURE__ */ new Set([
    "deleted",
    "git-enumeration-limit",
    "git-selection-changed",
    "git-metadata-unavailable",
    "git-provider-error",
    "git-nested-repository"
  ]);
  if (omitted.some((omission) => gitOmissionReasons.has(omission.reason)) && value.capture.provider !== GIT_PROVIDER) {
    throw new Error(`${label} Git omissions require the Git provider`);
  }
  const omissionKeys = /* @__PURE__ */ new Set();
  for (const omission of omitted) {
    const key = snapshotIdentityOmissionKey(omission);
    if (omissionKeys.has(key)) {
      throw new Error(`${label}.omitted contains duplicate entries`);
    }
    omissionKeys.add(key);
  }
  if (entries.some(
    (entry, index) => index > 0 && entries[index - 1].path.localeCompare(entry.path, "en") >= 0
  ) || new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw new Error(`${label}.entries are not canonical`);
  }
  if (omitted.some(
    (omission, index) => index > 0 && snapshotOmissionSortKey(omitted[index - 1]).localeCompare(
      snapshotOmissionSortKey(omission),
      "en"
    ) > 0
  )) {
    throw new Error(`${label}.omitted is not canonical`);
  }
  const omittedCount = nonNegativeInteger2(
    value.omittedCount,
    `${label}.omittedCount`
  );
  const omissionOverflow = value.omissionOverflow === void 0 ? void 0 : parseOverflow(value.omissionOverflow);
  const overflowCount = omittedCount - omitted.length;
  if (omitted.length > limits.maxOmissionEntries || overflowCount < 0 || overflowCount === 0 && omissionOverflow !== void 0 || overflowCount > 0 && omissionOverflow?.count !== overflowCount) {
    throw new Error(`${label}.omissionOverflow is inconsistent`);
  }
  if (entries.length > limits.maxFiles) {
    throw new Error(`${label} exceeds its file-count limit`);
  }
  if (entries.some((entry) => entry.size > limits.maxFileBytes) || entries.reduce((total, entry) => total + entry.size, 0) > limits.maxTotalBytes) {
    throw new Error(`${label} exceeds its byte limits`);
  }
  if (value.complete !== (omittedCount === 0)) {
    throw new Error(`${label}.complete is inconsistent`);
  }
  const physicalEnumerationOmission = omitted.filter(
    (omission) => omission.reason === "physical-enumeration-limit"
  );
  const physicalChangedOmission = omitted.filter(
    (omission) => omission.reason === "physical-selection-changed"
  );
  const gitEnumerationOmission = omitted.filter(
    (omission) => omission.reason === "git-enumeration-limit"
  );
  const gitChangedOmission = omitted.filter(
    (omission) => omission.reason === "git-selection-changed"
  );
  for (const omission of [
    ...physicalEnumerationOmission,
    ...physicalChangedOmission
  ]) {
    if (omission.path !== "." || omission.type !== "directory" || omission.size !== null) {
      throw new Error(`${label} physical selection omissions are invalid`);
    }
  }
  if (physicalEnumerationOmission.length > 1 || physicalChangedOmission.length > 1) {
    throw new Error(`${label} physical selection omissions are duplicated`);
  }
  if (physicalSelection === void 0 && (physicalEnumerationOmission.length > 0 || physicalChangedOmission.length > 0)) {
    throw new Error(`${label} physical selection evidence is missing`);
  }
  if (physicalSelection !== void 0) {
    const hasOverflow = physicalSelection.status === "overflow" || physicalSelection.status === "overflow-and-changed";
    const hasChanged = physicalSelection.status === "changed" || physicalSelection.status === "overflow-and-changed";
    if (hasOverflow !== (physicalEnumerationOmission.length === 1) || hasChanged !== (physicalChangedOmission.length === 1)) {
      throw new Error(`${label} physical selection evidence is inconsistent`);
    }
    for (const stream of [physicalSelection.before, physicalSelection.after]) {
      if (stream.visitedNodeCount > limits.maxVisitedNodes) {
        throw new Error(`${label} physical selection exceeds its bounds`);
      }
    }
  }
  for (const omission of [...gitEnumerationOmission, ...gitChangedOmission]) {
    if (omission.path !== "." || omission.type !== "directory" || omission.size !== null) {
      throw new Error(`${label} Git selection omissions are invalid`);
    }
  }
  if (gitEnumerationOmission.length > 1 || gitChangedOmission.length > 1) {
    throw new Error(`${label} Git selection omissions are duplicated`);
  }
  if (gitSelection === void 0 && (gitEnumerationOmission.length > 0 || gitChangedOmission.length > 0)) {
    throw new Error(`${label} Git selection evidence is missing`);
  }
  if (gitSelection !== void 0) {
    const hasOverflow = gitSelection.status === "overflow" || gitSelection.status === "overflow-and-changed";
    const hasChanged = gitSelection.status === "changed" || gitSelection.status === "overflow-and-changed";
    if (hasOverflow !== (gitEnumerationOmission.length === 1) || hasChanged !== (gitChangedOmission.length === 1)) {
      throw new Error(`${label} Git selection evidence is inconsistent`);
    }
    for (const stream of [gitSelection.before, gitSelection.after]) {
      if (stream.visitedNodeCount > limits.maxVisitedNodes || stream.durationMs > limits.maxDurationMs) {
        throw new Error(`${label} Git selection exceeds its bounds`);
      }
    }
    if (gitEvidence !== void 0) {
      if (gitSelection.before.indexHash !== gitEvidence.before.index || gitSelection.before.workingTreeHash !== gitEvidence.before.workingTree || gitSelection.after.indexHash !== gitEvidence.after.index || gitSelection.after.workingTreeHash !== gitEvidence.after.workingTree) {
        throw new Error(`${label} Git selection metadata is inconsistent`);
      }
    }
  }
  if (Buffer.byteLength(
    canonicalJson({
      schemaVersion: WORKFLOW_CONTENT_SNAPSHOT_SCHEMA_VERSION,
      kind: "workflow-content-snapshot",
      origin: "explicit",
      capture: {
        provider: value.capture.provider,
        ...requestedProvider ? { requestedProvider } : {},
        ...fallback ? { fallback } : {},
        ...physicalSelection ? { physicalSelection } : {},
        ...gitSelection ? { gitSelection } : {},
        ...gitEvidence ? { gitEvidence } : {}
      },
      createdAt: value.createdAt,
      complete: value.complete,
      policy,
      limits,
      entries,
      omitted,
      omittedCount,
      ...omissionOverflow ? { omissionOverflow } : {}
    }),
    "utf8"
  ) > limits.maxManifestBytes) {
    throw new Error(`${label} exceeds its manifest byte limit`);
  }
  return {
    schemaVersion: WORKFLOW_CONTENT_SNAPSHOT_SCHEMA_VERSION,
    kind: "workflow-content-snapshot",
    origin: "explicit",
    capture: {
      provider: value.capture.provider,
      ...requestedProvider ? { requestedProvider } : {},
      ...fallback ? { fallback } : {},
      ...physicalSelection ? { physicalSelection } : {},
      ...gitSelection ? { gitSelection } : {},
      ...gitEvidence ? { gitEvidence } : {}
    },
    createdAt: value.createdAt,
    complete: value.complete,
    policy,
    limits,
    entries,
    omitted,
    omittedCount,
    ...omissionOverflow ? { omissionOverflow } : {}
  };
}
function snapshotIdentityProjection(manifest) {
  const policy = {
    schemaVersion: manifest.policy.schemaVersion,
    ...manifest.policy.fallback ? { fallback: manifest.policy.fallback } : {},
    include: manifest.policy.include,
    exclude: manifest.policy.exclude,
    limits: manifest.policy.limits
  };
  return {
    schemaVersion: manifest.schemaVersion,
    kind: manifest.kind,
    origin: manifest.origin,
    ...manifest.capture.fallback ? { fallback: manifest.capture.fallback } : {},
    complete: manifest.complete,
    policy,
    limits: manifest.limits,
    entries: manifest.entries,
    omitted: manifest.omitted,
    omittedCount: manifest.omittedCount,
    ...manifest.omissionOverflow ? { omissionOverflow: manifest.omissionOverflow } : {}
  };
}
function hashWorkflowContentSnapshot(value) {
  const manifest = parseWorkflowContentSnapshotManifest(value);
  return canonicalHash(
    snapshotIdentityProjection(manifest),
    WORKFLOW_CONTENT_SNAPSHOT_HASH_TAG
  );
}
function hashLegacyPhysicalWorkflowContentSnapshot(value) {
  return canonicalHash(
    {
      schemaVersion: value.schemaVersion,
      kind: value.kind,
      origin: value.origin,
      capture: value.capture,
      complete: value.complete,
      policy: value.policy,
      limits: value.limits,
      entries: value.entries,
      omitted: value.omitted,
      omittedCount: value.omittedCount,
      ...value.omissionOverflow ? { omissionOverflow: value.omissionOverflow } : {}
    },
    WORKFLOW_CONTENT_SNAPSHOT_HASH_TAG
  );
}
function snapshotPathForHash(hash4) {
  return `${WORKFLOW_CONTENT_SNAPSHOT_DIRECTORY}/${hash4}.json`;
}
function parseWorkflowContentSnapshotReference(value, label = "Workflow content snapshot reference") {
  if (!isRecord3(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(
    value,
    /* @__PURE__ */ new Set(["schemaVersion", "kind", "hash", "path", "provider", "complete"]),
    label
  );
  const hash4 = hashValue2(value.hash, `${label}.hash`);
  if (value.schemaVersion !== WORKFLOW_CONTENT_SNAPSHOT_SCHEMA_VERSION || value.kind !== "workflow-content-snapshot-reference" || value.path !== snapshotPathForHash(hash4) || value.provider !== PHYSICAL_PROVIDER && value.provider !== GIT_PROVIDER || typeof value.complete !== "boolean") {
    throw new Error(`${label} identity is invalid`);
  }
  return {
    schemaVersion: WORKFLOW_CONTENT_SNAPSHOT_SCHEMA_VERSION,
    kind: "workflow-content-snapshot-reference",
    hash: hash4,
    path: snapshotPathForHash(hash4),
    provider: value.provider,
    complete: value.complete
  };
}
function referenceFor(manifest) {
  const hash4 = hashWorkflowContentSnapshot(manifest);
  return {
    schemaVersion: 1,
    kind: "workflow-content-snapshot-reference",
    hash: hash4,
    path: snapshotPathForHash(hash4),
    provider: manifest.capture.provider,
    complete: manifest.complete
  };
}
function createExecution(limits) {
  return { deadlineAt: Date.now() + limits.maxDurationMs, expired: false };
}
function hasExecutionBudget(execution) {
  if (execution.expired) return false;
  if (Date.now() < execution.deadlineAt) return true;
  execution.expired = true;
  return false;
}
function boundedGitDiagnostic(command, result) {
  if (result.status === "duration")
    return `${command} exceeded its duration bound`;
  if (result.status === "overflow")
    return `${command} exceeded its output bound`;
  if (result.errorCode === "ENOENT") return "git executable is unavailable";
  if (result.code === null) return `${command} did not finish`;
  return `${command} failed with exit code ${result.code}`;
}
function gitFailureStatus(result, command) {
  if (result.errorCode === "ENOENT") return "unavailable";
  if (command === "repository" && result.code === 128) {
    return "unavailable";
  }
  if (result.status === "duration" || result.status === "overflow") {
    return "error";
  }
  return command === "repository" ? "unavailable" : "error";
}
async function runGitCommand(root, args, execution, maxOutputBytes = MAX_GIT_OUTPUT_BYTES) {
  if (!hasExecutionBudget(execution)) {
    return {
      status: "duration",
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      outputBytes: 0,
      durationMs: 0,
      code: null,
      errorCode: "ETIMEDOUT"
    };
  }
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", root, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let overflow = false;
    let duration = false;
    let errorCode = null;
    let settled = false;
    const remaining = Math.max(1, execution.deadlineAt - startedAt);
    const timer = setTimeout(() => {
      duration = true;
      child.kill();
    }, remaining);
    const append = (chunks, chunk) => {
      if (settled) return;
      const nextBytes = Math.min(maxOutputBytes, outputBytes + chunk.length);
      const remainingBytes = Math.max(0, maxOutputBytes - outputBytes);
      if (remainingBytes > 0) {
        chunks.push(chunk.subarray(0, remainingBytes));
      }
      outputBytes = nextBytes;
      if (chunk.length > remainingBytes) {
        overflow = true;
        child.kill();
      }
    };
    child.stdout.on("data", (chunk) => append(stdout, chunk));
    child.stderr.on("data", (chunk) => append(stderr, chunk));
    child.once("error", (error) => {
      errorCode = error.code ?? "UNKNOWN";
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const budgetExpired = !hasExecutionBudget(execution);
      const status = duration ? "duration" : budgetExpired ? "duration" : overflow ? "overflow" : code === 0 ? "ok" : "error";
      if (status === "duration") execution.expired = true;
      resolve({
        status,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        outputBytes,
        durationMs: Math.max(0, Date.now() - startedAt),
        code,
        errorCode
      });
    });
  });
}
function decodeGitPaths(output) {
  if (output.length === 0) return [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const paths = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    const raw = decoder.decode(output.subarray(start, index));
    if (raw.length === 0) throw new Error("Git returned an empty path");
    paths.push(raw);
    start = index + 1;
  }
  if (start !== output.length)
    throw new Error("Git returned an unterminated path");
  return paths;
}
function gitSelectionHash(records) {
  const canonical2 = records.map((record) => `${record.type}\0${record.path}`).sort((left, right) => left.localeCompare(right, "en")).join("\n");
  return sha256(`workflow-git-selection.v1
${canonical2}`);
}
function gitSelectionStream(records, metadata, limits, visitedNodeCount, encodedBytes, outputBytes, durationMs, overflow, unstable) {
  return {
    hash: overflow ? sha256(
      `workflow-git-selection-incomplete.v1
${JSON.stringify({
        maxVisitedNodes: limits.maxVisitedNodes,
        maxSelectionBytes: MAX_SELECTION_BYTES,
        maxOutputBytes: MAX_GIT_OUTPUT_BYTES
      })}`
    ) : gitSelectionHash(records),
    indexHash: metadata.index,
    workingTreeHash: metadata.workingTree,
    visitedNodeCount: Math.min(
      visitedNodeCount,
      limits.maxVisitedNodes,
      MAX_SNAPSHOT_VISITED_NODES
    ),
    recordCount: records.length,
    storedRecordCount: overflow ? 0 : records.length,
    encodedBytes,
    outputBytes,
    durationMs: Math.min(durationMs, limits.maxDurationMs),
    overflow,
    unstable
  };
}
function gitMetadataHash(output) {
  return sha256(`workflow-git-metadata.v1
${output.toString("base64")}`);
}
function emptyGitMetadata() {
  return { head: null, index: null, workingTree: null };
}
async function gitMetadata(root, repositoryRelative, execution) {
  const head = await runGitCommand(
    root.lexical,
    ["rev-parse", "--verify", "HEAD"],
    execution
  );
  const metadata = emptyGitMetadata();
  if (head.status === "ok") {
    const value = head.stdout.toString("utf8").trim();
    if (!GIT_OBJECT_HASH_PATTERN.test(value)) {
      throw new GitProviderFailure(
        "error",
        "Git returned an invalid HEAD identity"
      );
    }
    metadata.head = value;
  } else if (head.code !== 128) {
    throw new GitProviderFailure(
      gitFailureStatus(head, "head"),
      boundedGitDiagnostic("Git HEAD lookup", head)
    );
  }
  const index = await runGitCommand(
    root.lexical,
    ["ls-files", "--stage", "-z", "--", repositoryRelative],
    execution
  );
  if (index.status !== "ok") {
    throw new GitProviderFailure(
      gitFailureStatus(index, "index"),
      boundedGitDiagnostic("Git index lookup", index)
    );
  }
  metadata.index = gitMetadataHash(index.stdout);
  const nestedRepositoryPaths = [];
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let start = 0;
    for (let position = 0; position < index.stdout.length; position += 1) {
      if (index.stdout[position] !== 0) continue;
      const record = decoder.decode(index.stdout.subarray(start, position));
      const separator = record.indexOf("	");
      if (separator > 0 && record.startsWith("160000 ")) {
        const nestedPath = record.slice(separator + 1);
        if (nestedPath.length > 0) nestedRepositoryPaths.push(nestedPath);
      }
      start = position + 1;
    }
    if (start !== index.stdout.length) {
      throw new Error("Git index output is unterminated");
    }
  } catch (error) {
    throw new GitProviderFailure("error", "Git index output is invalid");
  }
  const workingTree = await runGitCommand(
    root.lexical,
    [
      "status",
      "--porcelain=v2",
      "--untracked-files=all",
      "-z",
      "--",
      repositoryRelative
    ],
    execution
  );
  if (workingTree.status !== "ok") {
    throw new GitProviderFailure(
      gitFailureStatus(workingTree, "working-tree"),
      boundedGitDiagnostic("Git working-tree lookup", workingTree)
    );
  }
  metadata.workingTree = gitMetadataHash(workingTree.stdout);
  return { metadata, nestedRepositoryPaths };
}
async function repositoryRelativeRoot(root, execution) {
  const result = await runGitCommand(
    root.lexical,
    ["rev-parse", "--is-inside-work-tree"],
    execution
  );
  if (result.status !== "ok" || result.stdout.toString("utf8").trim() !== "true") {
    throw new GitProviderFailure(
      gitFailureStatus(result, "repository"),
      boundedGitDiagnostic("Git repository lookup", result)
    );
  }
  const topLevel = await runGitCommand(
    root.lexical,
    ["rev-parse", "--show-toplevel"],
    execution
  );
  if (topLevel.status !== "ok") {
    throw new GitProviderFailure(
      gitFailureStatus(topLevel, "repository"),
      boundedGitDiagnostic("Git root lookup", topLevel)
    );
  }
  const repositoryRoot = topLevel.stdout.toString("utf8").trim();
  let repositoryRealPath;
  try {
    repositoryRealPath = await fs4.realpath(repositoryRoot);
  } catch (error) {
    throw new GitProviderFailure(
      "unavailable",
      "Git repository root is unavailable"
    );
  }
  if (!isInside3(repositoryRealPath, root.real)) {
    throw new GitProviderFailure(
      "error",
      "Git repository root does not contain the snapshot root"
    );
  }
  const relative = portableRelative(repositoryRealPath, root.real);
  return relative || ".";
}
async function hasNestedGitBoundary(root, relative) {
  const segments = relative === "." ? [] : relative.split("/");
  let cursor = root;
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path5.join(cursor, segments[index]);
    let stat;
    try {
      stat = await fs4.lstat(cursor);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    if (!stat.isDirectory()) continue;
    try {
      await fs4.lstat(path5.join(cursor, ".git"));
      return true;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return false;
}
function fileIdentity(stat) {
  return { dev: stat.dev, ino: stat.ino, birthtime: stat.birthtimeMs };
}
function sameStat(left, right) {
  const leftIdentity = fileIdentity(left);
  const rightIdentity = fileIdentity(right);
  const sameObject = hasComparableFileObject(leftIdentity, rightIdentity) ? sameFileObject(leftIdentity, rightIdentity) : sameFileObject(leftIdentity, rightIdentity) && left.birthtimeMs === right.birthtimeMs && left.ctimeMs === right.ctimeMs && left.size === right.size;
  return sameObject && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function isUnreadable(error) {
  return ["EACCES", "EPERM"].includes(
    error?.code ?? ""
  );
}
function isMissing(error) {
  return ["ENOENT", "ENOTDIR"].includes(
    error?.code ?? ""
  );
}
function isScopePath(protectedRoot, target) {
  return isInside3(protectedRoot.lexicalPath, target) || protectedRoot.realPath !== null && isInside3(protectedRoot.realPath, target);
}
async function resolveRoot(root) {
  if (typeof root !== "string" || root.length === 0) {
    throw new WorkflowContentSnapshotError(
      snapshotUnsafeScopeFinding("Workflow content snapshot root is invalid")
    );
  }
  const lexical = path5.resolve(root);
  let stat;
  try {
    stat = await fs4.lstat(lexical);
  } catch (error) {
    throw new WorkflowContentSnapshotError(
      snapshotUnsafeScopeFinding(
        "Workflow content snapshot root is unavailable"
      ),
      { cause: error }
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new WorkflowContentSnapshotError(
      snapshotUnsafeScopeFinding(
        "Workflow content snapshot root must be a real directory"
      )
    );
  }
  let real;
  try {
    real = await fs4.realpath(lexical);
  } catch (error) {
    throw new WorkflowContentSnapshotError(
      snapshotUnsafeScopeFinding(
        "Workflow content snapshot root cannot be resolved"
      ),
      { cause: error }
    );
  }
  return { lexical, real };
}
async function resolveProtectedRoots(root, values) {
  const result = [];
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) {
      throw new WorkflowContentSnapshotError(
        snapshotUnsafeScopeFinding(
          "Workflow content snapshot exclusion is invalid"
        )
      );
    }
    const lexicalPath = path5.isAbsolute(value) ? path5.resolve(value) : path5.resolve(root.lexical, value);
    if (lexicalPath === root.lexical) {
      throw new WorkflowContentSnapshotError(
        snapshotUnsafeScopeFinding(
          "Workflow content snapshot exclusion cannot be the declared root"
        )
      );
    }
    if (!isInside3(root.lexical, lexicalPath)) {
      if (!path5.isAbsolute(value)) {
        throw new WorkflowContentSnapshotError(
          snapshotUnsafeScopeFinding(
            "Workflow content snapshot exclusion must stay inside the root"
          )
        );
      }
      continue;
    }
    let realPath = null;
    let exists = false;
    try {
      const stat = await fs4.lstat(lexicalPath);
      exists = true;
      if (stat.isSymbolicLink()) {
        throw new WorkflowContentSnapshotError(
          snapshotUnsafeScopeFinding(
            "Workflow content snapshot exclusion cannot be a symbolic link"
          )
        );
      }
      realPath = await fs4.realpath(lexicalPath);
      if (!isInside3(root.real, realPath)) {
        throw new WorkflowContentSnapshotError(
          snapshotUnsafeScopeFinding(
            "Workflow content snapshot exclusion resolves outside the root"
          )
        );
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    result.push({ lexicalPath, realPath, exists });
  }
  return result;
}
function scopeOverlapsProtectedRoot(root, protectedRoot, policy) {
  const relative = portableRelative(root, protectedRoot.lexicalPath);
  if (!protectedRoot.exists || !relative || relative.startsWith(".."))
    return false;
  return policy.policy.include.some(
    (pattern) => patternMatchesPathOrDescendant(pattern, relative)
  );
}
function patternMatchesPathOrDescendant(pattern, relative) {
  const tokens = patternTokens(pattern);
  const consume = (value) => {
    let positions = epsilonClosure(tokens, /* @__PURE__ */ new Set([0]));
    if (positions === null) return null;
    for (const character of value) {
      positions = advancePattern(tokens, positions, character);
      if (positions === null || positions.size === 0) return null;
    }
    return positions;
  };
  if (consume(relative)?.has(tokens.length)) return true;
  const initial = consume(`${relative}/`);
  if (initial === null) return false;
  const literalCharacters = tokens.filter(
    (token) => token.kind === "literal" && token.value !== "/"
  ).map((token) => token.value);
  const characters = [.../* @__PURE__ */ new Set(["/", "x", ...literalCharacters])];
  const queue = [initial];
  const seen = /* @__PURE__ */ new Set();
  while (queue.length > 0) {
    if (seen.size >= 4096) return true;
    const positions = queue.shift();
    const key = [...positions].sort((left, right) => left - right).join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    if (positions.has(tokens.length)) return true;
    for (const character of characters) {
      const next = advancePattern(tokens, positions, character);
      if (next && next.size > 0) queue.push(next);
    }
  }
  return false;
}
function relativeGitPath(repositoryRelative, repositoryPath) {
  return repositoryRelative === "." ? repositoryPath : repositoryPath === repositoryRelative ? "." : repositoryPath.startsWith(`${repositoryRelative}/`) ? repositoryPath.slice(repositoryRelative.length + 1) : null;
}
function gitPathMayBeSelected(policy, relative) {
  if (isIncluded(policy, relative)) return true;
  return policy.policy.include.some(
    (pattern) => patternMatchesPathOrDescendant(pattern, relative)
  ) && !policy.policy.exclude.some(
    (pattern) => patternMatchesPathOrDescendant(pattern, relative)
  );
}
function isGitMetadataPath(relative) {
  return relative.split("/").includes(".git");
}
function literalSnapshotIncludePaths(policy, repositoryRelative) {
  return policy.policy.include.filter((pattern) => !/[*?]/u.test(pattern)).map(
    (pattern) => repositoryRelative === "." ? pattern : `${repositoryRelative}/${pattern}`
  ).filter((repositoryPath) => !isGitMetadataPath(repositoryPath));
}
function selectionHash(records) {
  const canonical2 = records.map((record) => `${record.type}\0${record.path}`).sort((left, right) => left.localeCompare(right, "en")).join("\n");
  return sha256(`workflow-physical-selection.v1
${canonical2}`);
}
function selectionEvidence(records, visitedNodeCount, encodedBytes, overflow, unstable, limits) {
  return {
    hash: overflow ? sha256(
      `workflow-physical-selection-incomplete.v1
${JSON.stringify({
        maxVisitedNodes: limits.maxVisitedNodes,
        maxSelectionBytes: MAX_SELECTION_BYTES
      })}`
    ) : selectionHash(records),
    visitedNodeCount: Math.min(visitedNodeCount, limits.maxVisitedNodes),
    recordCount: records.length,
    storedRecordCount: overflow ? 0 : records.length,
    encodedBytes,
    overflow,
    unstable
  };
}
async function enumeratePhysicalTree(options) {
  const records = [];
  const omissions = [];
  let visitedNodeCount = 0;
  let encodedBytes = 0;
  let overflow = false;
  let unstable = false;
  let stopped = false;
  const addRecord = (record) => {
    const encoded = Buffer.byteLength(
      `${record.type}\0${record.path}`,
      "utf8"
    );
    if (Buffer.byteLength(record.path, "utf8") > MAX_SNAPSHOT_PATH_BYTES || encodedBytes + encoded > MAX_SELECTION_BYTES) {
      overflow = true;
      stopped = true;
      return;
    }
    records.push(record);
    encodedBytes += encoded;
  };
  const visit = async (directory, relativeDirectory, expected) => {
    if (stopped || !hasExecutionBudget(options.execution)) return;
    if (expected) {
      let current;
      let currentRealPath;
      try {
        current = await fs4.lstat(directory);
        currentRealPath = await fs4.realpath(directory);
      } catch (error) {
        if (!hasExecutionBudget(options.execution)) return;
        if (!isUnreadable(error) && !isMissing(error)) throw error;
        unstable ||= isMissing(error);
        omissions.push({
          path: relativeDirectory || ".",
          size: null,
          type: "directory",
          reason: isUnreadable(error) ? "unreadable" : "changed-during-read"
        });
        return;
      }
      if (!isInside3(options.root.real, currentRealPath)) {
        throw new WorkflowContentSnapshotError(
          snapshotUnsafeScopeFinding(
            "Workflow content snapshot directory escapes its declared root"
          )
        );
      }
      if (current.isSymbolicLink() || !current.isDirectory() || currentRealPath !== expected.realPath || !sameStat(expected.stat, current)) {
        unstable = true;
        omissions.push({
          path: relativeDirectory || ".",
          size: null,
          type: "directory",
          reason: "changed-during-read"
        });
        return;
      }
    }
    let handle;
    try {
      handle = await fs4.opendir(directory);
    } catch (error) {
      if (!hasExecutionBudget(options.execution)) return;
      if (!isUnreadable(error) && !isMissing(error)) throw error;
      unstable ||= isMissing(error);
      omissions.push({
        path: relativeDirectory || ".",
        size: null,
        type: "directory",
        reason: isUnreadable(error) ? "unreadable" : "changed-during-read"
      });
      return;
    }
    const children = [];
    try {
      while (!stopped && hasExecutionBudget(options.execution)) {
        let child;
        try {
          child = await handle.read();
        } catch (error) {
          if (!hasExecutionBudget(options.execution)) break;
          if (!isUnreadable(error) && !isMissing(error)) throw error;
          unstable ||= isMissing(error);
          omissions.push({
            path: relativeDirectory || ".",
            size: null,
            type: "directory",
            reason: isUnreadable(error) ? "unreadable" : "changed-during-read"
          });
          break;
        }
        if (!hasExecutionBudget(options.execution) || child === null) break;
        visitedNodeCount += 1;
        if (visitedNodeCount > options.policy.policy.limits.maxVisitedNodes) {
          overflow = true;
          stopped = true;
          break;
        }
        const target = path5.join(directory, child.name);
        const relative = portableRelative(options.root.lexical, target);
        if (!relative || relative.startsWith("..") || relative.includes("/../")) {
          throw new WorkflowContentSnapshotError(
            snapshotUnsafeScopeFinding(
              "Workflow content snapshot discovered an unsafe path"
            )
          );
        }
        if (options.protectedRoots.some(
          (protectedRoot) => isScopePath(protectedRoot, target)
        )) {
          continue;
        }
        if (child.name === ".git") continue;
        if (child.isDirectory() && excludesDirectory(options.policy, relative)) {
          continue;
        }
        let stat;
        try {
          stat = await fs4.lstat(target);
        } catch (error) {
          if (!hasExecutionBudget(options.execution)) break;
          if (!isUnreadable(error) && !isMissing(error)) throw error;
          unstable ||= isMissing(error);
          if (isIncluded(options.policy, relative, options.execution)) {
            addRecord({ path: relative, type: "other" });
            omissions.push({
              path: relative,
              size: null,
              type: "other",
              reason: isUnreadable(error) ? "unreadable" : "changed-during-read"
            });
          }
          await options.hooks?.afterNode?.(relative);
          continue;
        }
        const type = stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : "other";
        let realDirectory = "";
        if (type === "directory") {
          try {
            realDirectory = await fs4.realpath(target);
          } catch (error) {
            if (!hasExecutionBudget(options.execution)) break;
            if (!isUnreadable(error) && !isMissing(error)) throw error;
            unstable ||= isMissing(error);
            addRecord({ path: relative, type });
            omissions.push({
              path: relative,
              size: null,
              type: "directory",
              reason: isUnreadable(error) ? "unreadable" : "changed-during-read"
            });
            await options.hooks?.afterNode?.(relative);
            continue;
          }
          if (!isInside3(options.root.real, realDirectory) || options.protectedRoots.some(
            (protectedRoot) => protectedRoot.realPath !== null && isInside3(protectedRoot.realPath, realDirectory)
          )) {
            throw new WorkflowContentSnapshotError(
              snapshotUnsafeScopeFinding(
                "Workflow content snapshot directory escapes its declared root"
              )
            );
          }
          addRecord({ path: relative, type });
        } else if (isIncluded(options.policy, relative, options.execution)) {
          addRecord({ path: relative, type });
        }
        if (!stopped) {
          children.push({
            target,
            relative,
            stat,
            type,
            realPath: realDirectory
          });
          await options.hooks?.afterNode?.(relative);
        }
      }
    } finally {
      await handle.close().catch((error) => {
        if (error.code !== "ERR_DIR_CLOSED")
          throw error;
      });
    }
    if (stopped || !hasExecutionBudget(options.execution)) return;
    children.sort(
      (left, right) => left.relative.localeCompare(right.relative, "en")
    );
    for (const child of children) {
      if (stopped || !hasExecutionBudget(options.execution)) return;
      if (child.type !== "directory") continue;
      if (excludesDirectory(options.policy, child.relative)) continue;
      await visit(child.target, child.relative, {
        stat: child.stat,
        realPath: child.realPath
      });
    }
  };
  await visit(options.root.lexical, "");
  if (options.execution.expired) overflow = true;
  const evidence = selectionEvidence(
    records,
    visitedNodeCount,
    encodedBytes,
    overflow,
    unstable,
    options.policy.policy.limits
  );
  return { records, evidence, omissions };
}
async function enumerateGitTree(options) {
  const repositoryRelative = await repositoryRelativeRoot(
    options.root,
    options.execution
  );
  const metadataResult = await gitMetadata(
    options.root,
    repositoryRelative,
    options.execution
  );
  const metadata = metadataResult.metadata;
  for (const nestedRepositoryPath of metadataResult.nestedRepositoryPaths) {
    const relative = relativeGitPath(repositoryRelative, nestedRepositoryPath);
    if (relative === null || relative === ".") continue;
    try {
      relativePath(relative, "Git nested repository path");
    } catch (error) {
      throw new GitProviderFailure(
        "error",
        "Git returned an unsafe nested repository path"
      );
    }
    const target = path5.resolve(options.root.lexical, ...relative.split("/"));
    if (options.protectedRoots.some(
      (protectedRoot) => isScopePath(protectedRoot, target)
    )) {
      continue;
    }
    if (gitPathMayBeSelected(options.policy, relative)) {
      throw new GitProviderFailure(
        "nested-repository",
        "Git snapshot scope reaches a nested repository boundary"
      );
    }
  }
  const result = await runGitCommand(
    options.root.lexical,
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--full-name",
      "--deduplicate",
      "-z",
      "--",
      repositoryRelative === "." ? "." : `${repositoryRelative}/`
    ],
    options.execution
  );
  const diagnostics = [];
  if (result.status !== "ok") {
    if (result.status === "error") {
      throw new GitProviderFailure(
        gitFailureStatus(result, "selection"),
        boundedGitDiagnostic("Git selection", result)
      );
    }
    diagnostics.push(boundedGitDiagnostic("Git selection", result));
    const stream2 = gitSelectionStream(
      [],
      metadata,
      options.policy.policy.limits,
      0,
      0,
      result.outputBytes,
      result.durationMs,
      true,
      result.status === "duration"
    );
    return {
      records: [],
      evidence: selectionEvidence(
        [],
        0,
        0,
        true,
        result.status === "duration",
        options.policy.policy.limits
      ),
      omissions: [],
      gitStream: stream2,
      gitMetadata: metadata,
      gitStatus: "error",
      gitDiagnostics: diagnostics
    };
  }
  const stagedDeleted = await runGitCommand(
    options.root.lexical,
    [
      "diff",
      "--cached",
      "--name-only",
      "--diff-filter=D",
      "-z",
      "--",
      repositoryRelative === "." ? "." : `${repositoryRelative}/`
    ],
    options.execution
  );
  if (stagedDeleted.status !== "ok") {
    if (stagedDeleted.status === "error") {
      throw new GitProviderFailure(
        gitFailureStatus(stagedDeleted, "staged-deletion"),
        boundedGitDiagnostic("Git staged deletion selection", stagedDeleted)
      );
    }
    diagnostics.push(
      boundedGitDiagnostic("Git staged deletion selection", stagedDeleted)
    );
    const stream2 = gitSelectionStream(
      [],
      metadata,
      options.policy.policy.limits,
      0,
      0,
      Math.min(
        MAX_GIT_OUTPUT_BYTES,
        result.outputBytes + stagedDeleted.outputBytes
      ),
      stagedDeleted.durationMs,
      true,
      stagedDeleted.status === "duration"
    );
    return {
      records: [],
      evidence: selectionEvidence(
        [],
        0,
        0,
        true,
        stagedDeleted.status === "duration",
        options.policy.policy.limits
      ),
      omissions: [],
      gitStream: stream2,
      gitMetadata: metadata,
      gitStatus: "error",
      gitDiagnostics: diagnostics
    };
  }
  const deleted = await runGitCommand(
    options.root.lexical,
    [
      "ls-files",
      "--deleted",
      "--full-name",
      "--deduplicate",
      "-z",
      "--",
      repositoryRelative === "." ? "." : `${repositoryRelative}/`
    ],
    options.execution
  );
  if (deleted.status !== "ok") {
    if (deleted.status === "error") {
      throw new GitProviderFailure(
        gitFailureStatus(deleted, "deleted"),
        boundedGitDiagnostic("Git deleted-path selection", deleted)
      );
    }
    diagnostics.push(
      boundedGitDiagnostic("Git deleted-path selection", deleted)
    );
    const stream2 = gitSelectionStream(
      [],
      metadata,
      options.policy.policy.limits,
      0,
      0,
      Math.min(
        MAX_GIT_OUTPUT_BYTES,
        result.outputBytes + stagedDeleted.outputBytes + deleted.outputBytes
      ),
      result.durationMs + stagedDeleted.durationMs + deleted.durationMs,
      true,
      deleted.status === "duration"
    );
    return {
      records: [],
      evidence: selectionEvidence(
        [],
        0,
        0,
        true,
        deleted.status === "duration",
        options.policy.policy.limits
      ),
      omissions: [],
      gitStream: stream2,
      gitMetadata: metadata,
      gitStatus: "error",
      gitDiagnostics: diagnostics
    };
  }
  const outputBytes = Math.min(
    MAX_GIT_OUTPUT_BYTES,
    result.outputBytes + stagedDeleted.outputBytes + deleted.outputBytes
  );
  const outputOverflow = result.outputBytes + stagedDeleted.outputBytes + deleted.outputBytes > MAX_GIT_OUTPUT_BYTES;
  const selectionOutput = outputOverflow ? Buffer.alloc(0) : Buffer.concat([result.stdout, stagedDeleted.stdout, deleted.stdout]);
  let paths;
  try {
    paths = outputOverflow ? [] : decodeGitPaths(selectionOutput);
  } catch (error) {
    throw new GitProviderFailure("error", "Git returned invalid path data");
  }
  const records = [];
  const omissions = [];
  let visitedNodeCount = 0;
  let encodedBytes = 0;
  let overflow = false;
  let unstable = false;
  const outputDurationMs = result.durationMs + stagedDeleted.durationMs + deleted.durationMs;
  const seen = /* @__PURE__ */ new Set();
  const literalIncludePaths = literalSnapshotIncludePaths(
    options.policy,
    repositoryRelative
  );
  for (const rawPath of [
    ...paths,
    ...literalIncludePaths.filter((candidate) => !paths.includes(candidate))
  ]) {
    if (!hasExecutionBudget(options.execution)) {
      overflow = true;
      break;
    }
    visitedNodeCount += 1;
    if (visitedNodeCount > options.policy.policy.limits.maxVisitedNodes) {
      overflow = true;
      break;
    }
    const directoryRecord = rawPath.endsWith("/");
    const repositoryPath = directoryRecord ? rawPath.slice(0, -1) : rawPath;
    const relative = relativeGitPath(repositoryRelative, repositoryPath);
    if (relative === null || relative.length === 0) continue;
    if (isGitMetadataPath(relative)) continue;
    try {
      relativePath(relative, "Git snapshot path");
    } catch (error) {
      throw new GitProviderFailure("error", "Git returned an unsafe path");
    }
    const target = path5.resolve(options.root.lexical, ...relative.split("/"));
    if (options.protectedRoots.some(
      (protectedRoot) => isScopePath(protectedRoot, target)
    )) {
      continue;
    }
    const included = isIncluded(options.policy, relative, options.execution);
    const directoryMayContainIncludedPath = directoryRecord && !excludesDirectory(options.policy, relative) && gitPathMayBeSelected(options.policy, relative);
    if (!included && !directoryMayContainIncludedPath) continue;
    if (seen.has(relative)) continue;
    seen.add(relative);
    if (metadataResult.nestedRepositoryPaths.includes(repositoryPath) || await hasNestedGitBoundary(options.root.lexical, relative)) {
      throw new GitProviderFailure(
        "nested-repository",
        "Git snapshot scope reaches a nested repository boundary"
      );
    }
    let stat = null;
    try {
      stat = await fs4.lstat(target);
    } catch (error) {
      if (!isMissing(error) && !isUnreadable(error)) throw error;
      if (isUnreadable(error)) {
        omissions.push({
          path: relative,
          size: null,
          type: "file",
          reason: "unreadable"
        });
        unstable = true;
      }
    }
    const type = directoryRecord ? "directory" : stat === null ? "file" : stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : "other";
    const encoded = Buffer.byteLength(`${type}\0${relative}`, "utf8");
    if (Buffer.byteLength(relative, "utf8") > MAX_SNAPSHOT_PATH_BYTES || encodedBytes + encoded > MAX_SELECTION_BYTES) {
      overflow = true;
      break;
    }
    records.push({
      path: relative,
      type,
      ...stat === null && !directoryRecord ? { missing: true } : {}
    });
    encodedBytes += encoded;
    await options.hooks?.afterNode?.(relative);
  }
  if (options.execution.expired) overflow = true;
  const stream = gitSelectionStream(
    records,
    metadata,
    options.policy.policy.limits,
    visitedNodeCount,
    encodedBytes,
    outputBytes,
    outputDurationMs,
    overflow || outputOverflow,
    unstable
  );
  return {
    records,
    evidence: selectionEvidence(
      records,
      visitedNodeCount,
      encodedBytes,
      overflow,
      unstable,
      options.policy.policy.limits
    ),
    omissions,
    gitStream: stream,
    gitMetadata: metadata,
    gitStatus: "available",
    gitDiagnostics: diagnostics
  };
}
async function hashFileBounded(target, before, limits, execution) {
  if (!hasExecutionBudget(execution)) return { status: "duration" };
  const flags = process.platform === "win32" ? fsConstants3.O_RDONLY : fsConstants3.O_RDONLY | fsConstants3.O_NOFOLLOW | fsConstants3.O_NONBLOCK;
  let handle;
  try {
    handle = await fs4.open(target, flags);
  } catch (error) {
    if (!hasExecutionBudget(execution)) return { status: "duration" };
    if (error.code === "ELOOP")
      return { status: "changed" };
    if (isUnreadable(error)) return { status: "unreadable" };
    if (isMissing(error)) return { status: "changed" };
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!hasExecutionBudget(execution)) return { status: "duration" };
    const openedRealPath = await fs4.realpath(target);
    if (!hasExecutionBudget(execution)) return { status: "duration" };
    if (!opened.isFile() || !sameStat(before, opened))
      return { status: "changed" };
    const digest = createHash2("sha256");
    const buffer = Buffer.allocUnsafe(
      Math.min(64 * 1024, limits.maxFileBytes + 1)
    );
    let bytes = 0;
    while (true) {
      if (!hasExecutionBudget(execution)) return { status: "duration" };
      const remaining = limits.maxFileBytes + 1 - bytes;
      if (remaining < 1) return { status: "changed" };
      const result = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, remaining),
        null
      );
      if (!hasExecutionBudget(execution)) return { status: "duration" };
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
      if (bytes > limits.maxFileBytes) return { status: "changed" };
      digest.update(buffer.subarray(0, result.bytesRead));
    }
    const finalHandle = await handle.stat();
    const finalPath = await fs4.lstat(target);
    const finalRealPath = await fs4.realpath(target);
    if (!hasExecutionBudget(execution)) return { status: "duration" };
    if (!finalHandle.isFile() || !finalPath.isFile() || !sameStat(opened, finalHandle) || !sameStat(before, finalPath) || finalRealPath !== openedRealPath || bytes !== before.size) {
      return { status: "changed" };
    }
    return {
      status: "complete",
      hash: digest.digest("hex"),
      stat: finalPath,
      realPath: finalRealPath
    };
  } catch (error) {
    if (!hasExecutionBudget(execution)) return { status: "duration" };
    if (isUnreadable(error)) return { status: "unreadable" };
    if (isMissing(error)) return { status: "changed" };
    throw error;
  } finally {
    await handle.close();
  }
}
function snapshotIdentityOmissionKey(value) {
  return `${value.path}\0${value.type}\0${value.reason}\0${value.size ?? ""}`;
}
function snapshotOmissionSortKey(value) {
  return `${value.path}\0${value.reason}\0${value.type}\0${value.size ?? ""}`;
}
function physicalSelectionEvidence(before, after) {
  const hasOverflow = before.overflow || after.overflow;
  const changed = before.unstable || after.unstable || !sameSelectionStream(before, after);
  if (!hasOverflow && !changed) return null;
  return {
    schemaVersion: WORKFLOW_CONTENT_SNAPSHOT_SELECTION_SCHEMA_VERSION,
    status: hasOverflow && changed ? "overflow-and-changed" : hasOverflow ? "overflow" : "changed",
    before,
    after
  };
}
function gitSelectionEvidence(before, after) {
  const hasOverflow = before.overflow || after.overflow;
  const changed = before.unstable || after.unstable || !sameGitSelectionStream(before, after);
  return {
    schemaVersion: WORKFLOW_CONTENT_SNAPSHOT_SELECTION_SCHEMA_VERSION,
    status: hasOverflow && changed ? "overflow-and-changed" : hasOverflow ? "overflow" : changed ? "changed" : "stable",
    before,
    after
  };
}
function emptyGitSelectionStream(limits = WORKFLOW_CONTENT_SNAPSHOT_DEFAULT_LIMITS) {
  return gitSelectionStream(
    [],
    emptyGitMetadata(),
    limits,
    0,
    0,
    0,
    0,
    false,
    false
  );
}
function gitFailureEvidence(status, diagnostic) {
  const normalizedDiagnostic = diagnostic.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim() || "Git provider failed";
  const diagnostics = [
    normalizedDiagnostic.slice(0, MAX_GIT_DIAGNOSTIC_BYTES)
  ].slice(0, MAX_GIT_DIAGNOSTICS);
  const metadata = emptyGitMetadata();
  return {
    schemaVersion: WORKFLOW_CONTENT_SNAPSHOT_SCHEMA_VERSION,
    status,
    before: metadata,
    after: metadata,
    diagnostics
  };
}
function gitFailureOmissionReason(status) {
  return status === "unavailable" ? "git-metadata-unavailable" : status === "nested-repository" ? "git-nested-repository" : "git-provider-error";
}
function gitFailureSelectionResult(status, diagnostic, limits) {
  const stream = emptyGitSelectionStream(limits);
  const evidence = gitFailureEvidence(status, diagnostic);
  return {
    records: [],
    evidence: selectionEvidence([], 0, 0, false, false, limits),
    omissions: [],
    gitStream: stream,
    gitMetadata: emptyGitMetadata(),
    gitStatus: status,
    gitDiagnostics: evidence.diagnostics
  };
}
function captureForGitFailure(policy, status, diagnostic, now) {
  const stream = emptyGitSelectionStream(policy.limits);
  const evidence = gitFailureEvidence(status, diagnostic);
  const manifest = {
    schemaVersion: WORKFLOW_CONTENT_SNAPSHOT_SCHEMA_VERSION,
    kind: "workflow-content-snapshot",
    origin: "explicit",
    capture: {
      provider: GIT_PROVIDER,
      gitSelection: {
        schemaVersion: WORKFLOW_CONTENT_SNAPSHOT_SELECTION_SCHEMA_VERSION,
        status: "stable",
        before: stream,
        after: stream
      },
      gitEvidence: evidence
    },
    createdAt: (now ?? /* @__PURE__ */ new Date()).toISOString(),
    complete: false,
    policy,
    limits: policy.limits,
    entries: [],
    omitted: [
      {
        path: ".",
        size: null,
        type: "directory",
        reason: gitFailureOmissionReason(status)
      }
    ],
    omittedCount: 1
  };
  return parseWorkflowContentSnapshotManifest(manifest);
}
function gitEvidenceStatus(before, after) {
  if (before === "available" && after === "available") return "available";
  if (before === "nested-repository" || after === "nested-repository") {
    return "nested-repository";
  }
  if (before === "unavailable" || after === "unavailable") {
    return "unavailable";
  }
  return "error";
}
function snapshotIdentityPath(value) {
  if (!HASH_PATTERN2.test(value))
    throw new Error("Workflow snapshot hash is invalid");
  return snapshotPathForHash(value);
}
function workflowContentSnapshotFindings(value) {
  const manifest = parseWorkflowContentSnapshotManifest(value);
  const unstable = manifest.omitted.some(
    (omission) => [
      "changed-during-read",
      "duration",
      "physical-selection-changed",
      "git-selection-changed"
    ].includes(omission.reason)
  );
  const findings = [];
  if (unstable) {
    findings.push(
      snapshotUnstableFinding(
        "Workflow content snapshot selection or content changed during capture."
      )
    );
  }
  if (!manifest.complete) {
    findings.push(
      snapshotIncompleteFinding(
        "Workflow content snapshot is incomplete and cannot satisfy a complete-scope requirement."
      )
    );
  }
  return findings;
}
async function captureWorkflowContentSnapshotInternal(options) {
  const policy = resolveSnapshotPolicy(options.policy);
  const root = await resolveRoot(options.root);
  const protectedRoots = await resolveProtectedRoots(
    root,
    options.protectedRoots ?? []
  );
  for (const protectedRoot of protectedRoots) {
    if (scopeOverlapsProtectedRoot(root.lexical, protectedRoot, policy)) {
      throw new WorkflowContentSnapshotError(
        snapshotUnsafeScopeFinding(
          "Workflow content snapshot scope overlaps a protected repository exclusion."
        )
      );
    }
  }
  const execution = createExecution(policy.policy.limits);
  const requestedProvider = policy.policy.provider;
  let selectedProvider = requestedProvider;
  let fallback;
  let gitFailure;
  let before;
  if (requestedProvider === GIT_PROVIDER) {
    try {
      before = await enumerateGitTree({
        root,
        policy,
        protectedRoots,
        execution,
        hooks: options.hooks
      });
    } catch (error) {
      const failure = error instanceof GitProviderFailure ? error : new GitProviderFailure("error", "Git snapshot provider failed");
      if (policy.policy.fallback === PHYSICAL_PROVIDER && failure.status !== "nested-repository") {
        selectedProvider = PHYSICAL_PROVIDER;
        fallback = {
          from: GIT_PROVIDER,
          to: PHYSICAL_PROVIDER,
          reason: failure.status === "unavailable" ? "git-metadata-unavailable" : "git-provider-error"
        };
        gitFailure = gitFailureEvidence(failure.status, failure.message);
        before = await enumeratePhysicalTree({
          root,
          policy,
          protectedRoots,
          execution,
          hooks: options.hooks
        });
      } else {
        return captureForGitFailure(
          policy.policy,
          failure.status,
          failure.message,
          options.now
        );
      }
    }
  } else {
    before = await enumeratePhysicalTree({
      root,
      policy,
      protectedRoots,
      execution,
      hooks: options.hooks
    });
  }
  await options.hooks?.afterInitialSelection?.();
  const entries = [];
  const captured = [];
  const omitted = [];
  const omissionKeys = /* @__PURE__ */ new Set();
  let omittedCount = 0;
  let overflowCount = 0;
  let overflowHash = sha256("workflow-content-snapshot-omission-overflow.v1");
  let totalBytes = 0;
  const foldOverflow = (value) => {
    overflowCount += 1;
    overflowHash = sha256(
      `${overflowHash}
${JSON.stringify(stableValue(value))}`
    );
  };
  const omit = (value) => {
    const key = snapshotIdentityOmissionKey(value);
    if (omissionKeys.has(key)) return;
    omissionKeys.add(key);
    omittedCount += 1;
    if (omitted.length < policy.policy.limits.maxOmissionEntries) {
      omitted.push(value);
      return;
    }
    if (INTEGRITY_OMISSION_REASONS.has(value.reason)) {
      const displacedIndex = omitted.findIndex(
        (candidate) => !INTEGRITY_OMISSION_REASONS.has(candidate.reason)
      );
      if (displacedIndex >= 0) {
        const [displaced] = omitted.splice(displacedIndex, 1);
        if (displaced) foldOverflow(displaced);
        omitted.push(value);
        return;
      }
    }
    foldOverflow(value);
  };
  for (const omission of before.omissions) omit(omission);
  const records = [...before.records].sort(
    (left, right) => left.path.localeCompare(right.path, "en")
  );
  for (const record of records) {
    if (!hasExecutionBudget(execution)) break;
    if (record.type !== "file") {
      if (record.type === "symlink" || record.type === "other") {
        omit({
          path: record.path,
          size: null,
          type: "other",
          reason: "non-regular"
        });
      }
      continue;
    }
    const target = path5.resolve(root.lexical, ...record.path.split("/"));
    let beforeStat;
    try {
      beforeStat = await fs4.lstat(target);
    } catch (error) {
      if (!hasExecutionBudget(execution)) break;
      if (!isUnreadable(error) && !isMissing(error)) throw error;
      omit({
        path: record.path,
        size: null,
        type: "file",
        reason: isUnreadable(error) ? "unreadable" : selectedProvider === GIT_PROVIDER && record.missing ? "deleted" : "changed-during-read"
      });
      continue;
    }
    if (!beforeStat.isFile() || beforeStat.isSymbolicLink()) {
      omit({
        path: record.path,
        size: null,
        type: "other",
        reason: "non-regular"
      });
      continue;
    }
    if (entries.length >= policy.policy.limits.maxFiles) {
      omit({
        path: record.path,
        size: beforeStat.size,
        type: "file",
        reason: "file-count"
      });
      continue;
    }
    if (beforeStat.size > policy.policy.limits.maxFileBytes) {
      omit({
        path: record.path,
        size: beforeStat.size,
        type: "file",
        reason: "file-size"
      });
      continue;
    }
    if (totalBytes + beforeStat.size > policy.policy.limits.maxTotalBytes) {
      omit({
        path: record.path,
        size: beforeStat.size,
        type: "file",
        reason: "total-size"
      });
      continue;
    }
    let realPath;
    try {
      realPath = await fs4.realpath(target);
    } catch (error) {
      if (!hasExecutionBudget(execution)) break;
      if (!isUnreadable(error) && !isMissing(error)) throw error;
      omit({
        path: record.path,
        size: beforeStat.size,
        type: "file",
        reason: isUnreadable(error) ? "unreadable" : "changed-during-read"
      });
      continue;
    }
    if (!isInside3(root.real, realPath) || protectedRoots.some(
      (protectedRoot) => protectedRoot.realPath !== null && isInside3(protectedRoot.realPath, realPath)
    )) {
      throw new WorkflowContentSnapshotError(
        snapshotUnsafeScopeFinding(
          "Workflow content snapshot file escapes its declared root"
        )
      );
    }
    await options.hooks?.beforeFileRead?.(record.path);
    const hashed = await hashFileBounded(
      target,
      beforeStat,
      policy.policy.limits,
      execution
    );
    await options.hooks?.afterFileRead?.(record.path);
    if (hashed.status !== "complete") {
      omit({
        path: record.path,
        size: hashed.status === "duration" ? beforeStat.size : null,
        type: "file",
        reason: hashed.status === "duration" ? "duration" : hashed.status === "unreadable" ? "unreadable" : "changed-during-read"
      });
      if (hashed.status === "duration") break;
      continue;
    }
    entries.push({
      path: record.path,
      hash: hashed.hash,
      size: hashed.stat.size,
      type: "file"
    });
    totalBytes += hashed.stat.size;
    captured.push({
      path: record.path,
      target,
      realPath,
      stat: hashed.stat
    });
  }
  for (const capturedFile of captured) {
    if (!hasExecutionBudget(execution)) break;
    let current;
    let currentRealPath;
    try {
      current = await fs4.lstat(capturedFile.target);
      currentRealPath = await fs4.realpath(capturedFile.target);
    } catch (error) {
      if (!hasExecutionBudget(execution)) break;
      if (!isUnreadable(error) && !isMissing(error)) throw error;
      const entry = entries.find(
        (candidate) => candidate.path === capturedFile.path
      );
      if (entry) {
        entries.splice(entries.indexOf(entry), 1);
        totalBytes -= entry.size;
      }
      omit({
        path: capturedFile.path,
        size: null,
        type: "file",
        reason: isUnreadable(error) ? "unreadable" : "changed-during-read"
      });
      continue;
    }
    if (!current.isFile() || currentRealPath !== capturedFile.realPath || !sameStat(capturedFile.stat, current)) {
      const entry = entries.find(
        (candidate) => candidate.path === capturedFile.path
      );
      if (entry) {
        entries.splice(entries.indexOf(entry), 1);
        totalBytes -= entry.size;
      }
      omit({
        path: capturedFile.path,
        size: current.isFile() ? current.size : null,
        type: current.isFile() ? "file" : "other",
        reason: "changed-during-read"
      });
    }
  }
  let after;
  if (hasExecutionBudget(execution)) {
    try {
      after = selectedProvider === GIT_PROVIDER ? await enumerateGitTree({
        root,
        policy,
        protectedRoots,
        execution
      }) : await enumeratePhysicalTree({
        root,
        policy,
        protectedRoots,
        execution
      });
    } catch (error) {
      if (selectedProvider !== GIT_PROVIDER) throw error;
      const failure = error instanceof GitProviderFailure ? error : new GitProviderFailure("error", "Git snapshot provider failed");
      if (policy.policy.fallback === PHYSICAL_PROVIDER && failure.status !== "nested-repository") {
        selectedProvider = PHYSICAL_PROVIDER;
        fallback ??= {
          from: GIT_PROVIDER,
          to: PHYSICAL_PROVIDER,
          reason: failure.status === "unavailable" ? "git-metadata-unavailable" : "git-provider-error"
        };
        gitFailure ??= gitFailureEvidence(failure.status, failure.message);
        before = await enumeratePhysicalTree({
          root,
          policy,
          protectedRoots,
          execution
        });
        after = await enumeratePhysicalTree({
          root,
          policy,
          protectedRoots,
          execution
        });
      } else {
        after = gitFailureSelectionResult(
          failure.status,
          failure.message,
          policy.policy.limits
        );
      }
    }
    for (const omission of after.omissions) omit(omission);
  } else {
    after = {
      records: [],
      evidence: selectionEvidence([], 0, 0, true, true, policy.policy.limits),
      omissions: [],
      ...selectedProvider === GIT_PROVIDER ? {
        gitStream: gitSelectionStream(
          [],
          emptyGitMetadata(),
          policy.policy.limits,
          0,
          0,
          0,
          0,
          true,
          true
        ),
        gitMetadata: emptyGitMetadata(),
        gitStatus: "error",
        gitDiagnostics: ["Git selection exceeded its duration bound"]
      } : {}
    };
  }
  const selection2 = selectedProvider === PHYSICAL_PROVIDER ? physicalSelectionEvidence(before.evidence, after.evidence) : null;
  const gitSelection = selectedProvider === GIT_PROVIDER && before.gitStream && after.gitStream ? gitSelectionEvidence(before.gitStream, after.gitStream) : null;
  const gitEvidence = selectedProvider === GIT_PROVIDER ? {
    schemaVersion: WORKFLOW_CONTENT_SNAPSHOT_SCHEMA_VERSION,
    status: gitEvidenceStatus(before.gitStatus, after.gitStatus),
    before: before.gitMetadata ?? emptyGitMetadata(),
    after: after.gitMetadata ?? emptyGitMetadata(),
    diagnostics: [
      .../* @__PURE__ */ new Set([
        ...before.gitDiagnostics ?? [],
        ...after.gitDiagnostics ?? []
      ])
    ].slice(0, MAX_GIT_DIAGNOSTICS)
  } : gitFailure;
  if (selectedProvider === GIT_PROVIDER) {
    const gitEnumerationOverflow = before.gitStream?.overflow || after.gitStream?.overflow || execution.expired;
    if (gitEnumerationOverflow) {
      omit({
        path: ".",
        size: null,
        type: "directory",
        reason: "git-enumeration-limit"
      });
    }
    if (gitSelection && (gitSelection.status === "changed" || gitSelection.status === "overflow-and-changed")) {
      omit({
        path: ".",
        size: null,
        type: "directory",
        reason: "git-selection-changed"
      });
    }
    if (after.gitStatus && after.gitStatus !== "available" && !after.gitStream?.overflow && !execution.expired) {
      omit({
        path: ".",
        size: null,
        type: "directory",
        reason: gitFailureOmissionReason(after.gitStatus)
      });
    }
  } else if (before.evidence.overflow || after.evidence.overflow || execution.expired) {
    omit({
      path: ".",
      size: null,
      type: "directory",
      reason: "physical-enumeration-limit"
    });
  }
  if (selection2 && (selection2.status === "changed" || selection2.status === "overflow-and-changed")) {
    omit({
      path: ".",
      size: null,
      type: "directory",
      reason: "physical-selection-changed"
    });
  }
  if (execution.expired) {
    omit({ path: ".", size: null, type: "directory", reason: "duration" });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  omitted.sort((left, right) => {
    const pathOrder = left.path.localeCompare(right.path, "en");
    return pathOrder !== 0 ? pathOrder : snapshotOmissionSortKey(left).localeCompare(
      snapshotOmissionSortKey(right),
      "en"
    );
  });
  const buildManifest = () => ({
    schemaVersion: WORKFLOW_CONTENT_SNAPSHOT_SCHEMA_VERSION,
    kind: "workflow-content-snapshot",
    origin: "explicit",
    capture: {
      provider: selectedProvider,
      ...selectedProvider !== requestedProvider ? {
        requestedProvider,
        fallback
      } : {},
      ...selection2 ? { physicalSelection: selection2 } : {},
      ...gitSelection ? { gitSelection } : {},
      ...gitEvidence ? { gitEvidence } : {}
    },
    createdAt: (options.now ?? /* @__PURE__ */ new Date()).toISOString(),
    complete: omittedCount === 0,
    policy: policy.policy,
    limits: policy.policy.limits,
    entries,
    omitted,
    omittedCount,
    ...overflowCount > 0 ? {
      omissionOverflow: {
        ref: `workflow-snapshot://omitted-overflow/${overflowHash}`,
        hash: overflowHash,
        count: overflowCount
      }
    } : {}
  });
  let manifest = buildManifest();
  while (Buffer.byteLength(canonicalJson(manifest), "utf8") > policy.policy.limits.maxManifestBytes) {
    const compactable = omitted.findIndex(
      (omission) => !INTEGRITY_OMISSION_REASONS.has(omission.reason)
    );
    if (compactable >= 0) {
      const [removed] = omitted.splice(compactable, 1);
      if (removed) foldOverflow(removed);
    } else if (entries.length > 0) {
      const removed = entries.pop();
      omittedCount += 1;
      foldOverflow({
        path: removed.path,
        size: removed.size,
        type: "file",
        reason: "manifest-size"
      });
    } else {
      throw new WorkflowContentSnapshotError(
        snapshotStorageFailedFinding(
          "Workflow content snapshot manifest metadata exceeds its configured bound."
        )
      );
    }
    manifest = buildManifest();
  }
  return parseWorkflowContentSnapshotManifest(manifest);
}
async function captureWorkflowContentSnapshot(options) {
  try {
    return await captureWorkflowContentSnapshotInternal({
      ...options,
      protectedRoots: [
        ...DEFAULT_PROTECTED_SNAPSHOT_ROOTS,
        ...options.protectedRoots ?? []
      ]
    });
  } catch (error) {
    if (error instanceof WorkflowContentSnapshotError) throw error;
    throw new WorkflowContentSnapshotError(
      snapshotStorageFailedFinding(
        "Workflow content snapshot capture failed without a safe diagnostic."
      ),
      { cause: error }
    );
  }
}
async function stageWorkflowContentSnapshot(options) {
  const manifest = parseWorkflowContentSnapshotManifest(options.manifest);
  const reference = referenceFor(manifest);
  const content = canonicalJson(manifest);
  try {
    const existing = await options.transition.read(
      reference.path,
      manifest.limits.maxManifestBytes,
      "Workflow content snapshot"
    );
    if (existing !== null) {
      const parsed = parseWorkflowContentSnapshotManifest(
        JSON.parse(existing)
      );
      if (hashWorkflowContentSnapshot(parsed) !== reference.hash) {
        throw new Error("Workflow content snapshot identity changed");
      }
      return reference;
    }
    await options.transition.write(
      reference.path,
      content,
      manifest.limits.maxManifestBytes,
      "Workflow content snapshot"
    );
    return reference;
  } catch (error) {
    if (error instanceof WorkflowContentSnapshotError) throw error;
    throw new WorkflowContentSnapshotError(
      snapshotStorageFailedFinding(
        "Workflow content snapshot evidence could not be persisted.",
        WORKFLOW_CONTENT_SNAPSHOT_DIRECTORY
      ),
      { cause: error }
    );
  }
}
async function readWorkflowContentSnapshot(runRoot, hash4, maxBytes = WORKFLOW_CONTENT_SNAPSHOT_DEFAULT_LIMITS.maxManifestBytes) {
  const relative = snapshotIdentityPath(hash4);
  try {
    const inspection = await inspectProtectedProjectPath(runRoot, relative, {
      label: "Workflow content snapshot",
      expected: "file"
    });
    if (!inspection.exists) return null;
    const content = await readOptionalEngineRunText(
      runRoot,
      relative,
      maxBytes,
      "Workflow content snapshot"
    );
    if (content === null) return null;
    const manifest = parseWorkflowContentSnapshotManifest(
      JSON.parse(content)
    );
    const currentHash = hashWorkflowContentSnapshot(manifest);
    const legacyPhysicalHash = manifest.capture.provider === PHYSICAL_PROVIDER ? hashLegacyPhysicalWorkflowContentSnapshot(manifest) : null;
    if (currentHash !== hash4 && legacyPhysicalHash !== hash4) {
      throw new Error(
        "Workflow content snapshot identity does not match its path"
      );
    }
    return manifest;
  } catch (error) {
    if (error instanceof WorkflowContentSnapshotError) throw error;
    throw new WorkflowContentSnapshotError(
      snapshotStorageFailedFinding(
        "Workflow content snapshot evidence could not be read.",
        WORKFLOW_CONTENT_SNAPSHOT_DIRECTORY
      ),
      { cause: error }
    );
  }
}

// src/workflow-runtime/durability.ts
var WORKFLOW_DURABILITY_PROFILE_VERSION = 1;
var WORKFLOW_DURABILITY_SCHEMA_VERSION = 1;
var WORKFLOW_DURABILITY_MAX_RECORD_BYTES = 16 * 1024 * 1024;
var PROFILE_KEYS = /* @__PURE__ */ new Set([
  "version",
  "capabilities",
  "bounds",
  "schemaVersions",
  "findingCatalogVersion",
  "snapshotPolicy",
  "verificationPolicy",
  "repairPolicy",
  "repair"
]);
var CAPABILITIES = /* @__PURE__ */ new Set([
  "mutation-locks",
  "revision-fences",
  "transition-journal",
  "verified-checkpoints",
  "content-snapshots",
  "verification-receipts",
  "repair-policy",
  "transactional-finalization"
]);
var BOUND_KEY_NAMES = [
  "runStateBytes",
  "pendingActionBytes",
  "trajectoryBytes",
  "artifactsBytes",
  "claimBytes"
];
var BOUND_KEYS = /* @__PURE__ */ new Set([
  ...BOUND_KEY_NAMES,
  "transitionJournalBytes",
  "runLockBytes",
  "checkpointManifestBytes",
  "checkpointRecordBytes",
  "checkpointCount",
  "verificationReceiptBytes",
  "verificationReceiptCount",
  "repairHistoryBytes",
  "repairHistoryCount",
  "repairEpisodeBytes",
  "repairEpisodeCount",
  "repairHistoryRecords",
  "repairEpisodeRecords",
  "finalizationPlanBytes",
  "finalizationTransactionBytes",
  "finalizationReceiptBytes",
  "finalizationContentBytes",
  "finalizationOperationCount",
  "finalizationEventCount"
]);
var SCHEMA_KEY_NAMES = [
  "runState",
  "pendingAction",
  "trajectory",
  "artifacts",
  "revisionClaim"
];
var SCHEMA_KEYS = /* @__PURE__ */ new Set([
  ...SCHEMA_KEY_NAMES,
  "runLock",
  "transitionJournal",
  "checkpointManifest",
  "checkpointRecord",
  "contentSnapshot",
  "verificationReceipt",
  "repairEpisode",
  "repairHistory",
  "finalizationTransaction",
  "finalizationReceipt"
]);
var MAX_PROFILE_BOUND = WORKFLOW_DURABILITY_MAX_RECORD_BYTES;
var MAX_CHECKPOINT_COUNT = 256;
var MAX_VERIFICATION_RECEIPT_COUNT = 256;
var MAX_REPAIR_HISTORY_COUNT = 1024;
var MAX_FINALIZATION_OPERATION_COUNT = 256;
var MAX_FINALIZATION_EVENT_COUNT = 1024;
var VERIFICATION_POLICY_KEYS = /* @__PURE__ */ new Set([
  "maxSummaryBytes",
  "maxEvidenceBytes"
]);
function isRecord4(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function assertKnownFields2(value, keys, label) {
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) throw new Error(`Invalid ${label}: unknown field ${unknown}`);
}
function requiredBound(value, key) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_PROFILE_BOUND) {
    throw new Error(
      `Invalid Workflow durability profile: bounds.${key} must be a positive bounded integer`
    );
  }
  return value;
}
function requiredCheckpointCount(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_CHECKPOINT_COUNT) {
    throw new Error(
      "Invalid Workflow durability profile: bounds.checkpointCount must be a positive bounded integer"
    );
  }
  return value;
}
function requiredVerificationReceiptCount(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_VERIFICATION_RECEIPT_COUNT) {
    throw new Error(
      "Invalid Workflow durability profile: bounds.verificationReceiptCount must be a positive bounded integer"
    );
  }
  return value;
}
function requiredFinalizationCount(value, key, maximum) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(
      `Invalid Workflow durability profile: bounds.${key} must be a positive bounded integer`
    );
  }
  return value;
}
function parseVerificationPolicy(value) {
  if (!isRecord4(value)) {
    throw new Error("Invalid Workflow verification policy: must be an object");
  }
  assertKnownFields2(
    value,
    VERIFICATION_POLICY_KEYS,
    "Workflow verification policy"
  );
  const maxSummaryBytes = requiredBound(
    value.maxSummaryBytes,
    "verificationPolicy.maxSummaryBytes"
  );
  const maxEvidenceBytes = requiredBound(
    value.maxEvidenceBytes,
    "verificationPolicy.maxEvidenceBytes"
  );
  if (maxSummaryBytes > maxEvidenceBytes) {
    throw new Error(
      "Invalid Workflow verification policy: maxSummaryBytes cannot exceed maxEvidenceBytes"
    );
  }
  return {
    maxSummaryBytes,
    maxEvidenceBytes
  };
}
function parseWorkflowDurabilityProfile(value) {
  if (!isRecord4(value)) {
    throw new Error("Invalid Workflow durability profile: must be an object");
  }
  assertKnownFields2(value, PROFILE_KEYS, "Workflow durability profile");
  if (value.version !== WORKFLOW_DURABILITY_PROFILE_VERSION) {
    throw new Error(
      `Unsupported Workflow durability profile version: ${String(value.version)}`
    );
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.length === 0) {
    throw new Error(
      "Invalid Workflow durability profile: capabilities must be a non-empty array"
    );
  }
  const capabilities = value.capabilities.map(
    (capability) => {
      if (typeof capability !== "string" || !CAPABILITIES.has(capability)) {
        throw new Error(
          `Invalid Workflow durability profile: unsupported capability ${String(capability)}`
        );
      }
      return capability;
    }
  );
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error(
      "Invalid Workflow durability profile: capabilities must not contain duplicates"
    );
  }
  if (!isRecord4(value.bounds)) {
    throw new Error(
      "Invalid Workflow durability profile: bounds must be an object"
    );
  }
  const boundsValue = value.bounds;
  assertKnownFields2(
    boundsValue,
    BOUND_KEYS,
    "Workflow durability profile bounds"
  );
  const bounds = Object.fromEntries(
    BOUND_KEY_NAMES.map((key) => [key, requiredBound(boundsValue[key], key)])
  );
  if (boundsValue.transitionJournalBytes !== void 0) {
    bounds.transitionJournalBytes = requiredBound(
      boundsValue.transitionJournalBytes,
      "transitionJournalBytes"
    );
  }
  if (boundsValue.runLockBytes !== void 0) {
    bounds.runLockBytes = requiredBound(
      boundsValue.runLockBytes,
      "runLockBytes"
    );
  }
  if (boundsValue.checkpointManifestBytes !== void 0) {
    bounds.checkpointManifestBytes = requiredBound(
      boundsValue.checkpointManifestBytes,
      "checkpointManifestBytes"
    );
  }
  if (boundsValue.checkpointRecordBytes !== void 0) {
    bounds.checkpointRecordBytes = requiredBound(
      boundsValue.checkpointRecordBytes,
      "checkpointRecordBytes"
    );
  }
  if (boundsValue.checkpointCount !== void 0) {
    bounds.checkpointCount = requiredCheckpointCount(
      boundsValue.checkpointCount
    );
  }
  if (boundsValue.verificationReceiptBytes !== void 0) {
    bounds.verificationReceiptBytes = requiredBound(
      boundsValue.verificationReceiptBytes,
      "verificationReceiptBytes"
    );
  }
  if (boundsValue.verificationReceiptCount !== void 0) {
    bounds.verificationReceiptCount = requiredVerificationReceiptCount(
      boundsValue.verificationReceiptCount
    );
  }
  if (boundsValue.finalizationPlanBytes !== void 0) {
    bounds.finalizationPlanBytes = requiredBound(
      boundsValue.finalizationPlanBytes,
      "finalizationPlanBytes"
    );
  }
  if (boundsValue.finalizationTransactionBytes !== void 0) {
    bounds.finalizationTransactionBytes = requiredBound(
      boundsValue.finalizationTransactionBytes,
      "finalizationTransactionBytes"
    );
  }
  if (boundsValue.finalizationReceiptBytes !== void 0) {
    bounds.finalizationReceiptBytes = requiredBound(
      boundsValue.finalizationReceiptBytes,
      "finalizationReceiptBytes"
    );
  }
  if (boundsValue.finalizationContentBytes !== void 0) {
    bounds.finalizationContentBytes = requiredBound(
      boundsValue.finalizationContentBytes,
      "finalizationContentBytes"
    );
  }
  if (boundsValue.finalizationOperationCount !== void 0) {
    bounds.finalizationOperationCount = requiredFinalizationCount(
      boundsValue.finalizationOperationCount,
      "finalizationOperationCount",
      MAX_FINALIZATION_OPERATION_COUNT
    );
  }
  if (boundsValue.finalizationEventCount !== void 0) {
    bounds.finalizationEventCount = requiredFinalizationCount(
      boundsValue.finalizationEventCount,
      "finalizationEventCount",
      MAX_FINALIZATION_EVENT_COUNT
    );
  }
  const repairHistoryBytes = boundsValue.repairHistoryBytes ?? boundsValue.repairEpisodeBytes;
  if (boundsValue.repairHistoryBytes !== void 0 && boundsValue.repairEpisodeBytes !== void 0 && boundsValue.repairHistoryBytes !== boundsValue.repairEpisodeBytes) {
    throw new Error(
      "Invalid Workflow durability profile: repair history byte aliases disagree"
    );
  }
  if (repairHistoryBytes !== void 0) {
    bounds.repairHistoryBytes = requiredBound(
      repairHistoryBytes,
      "repairHistoryBytes"
    );
  }
  const repairHistoryCount = boundsValue.repairHistoryCount ?? boundsValue.repairEpisodeCount ?? boundsValue.repairHistoryRecords ?? boundsValue.repairEpisodeRecords;
  const repairCountAliases = [
    boundsValue.repairHistoryCount,
    boundsValue.repairEpisodeCount,
    boundsValue.repairHistoryRecords,
    boundsValue.repairEpisodeRecords
  ].filter((value2) => value2 !== void 0);
  if (repairCountAliases.some((value2) => value2 !== repairCountAliases[0])) {
    throw new Error(
      "Invalid Workflow durability profile: repair history count aliases disagree"
    );
  }
  if (repairHistoryCount !== void 0) {
    if (typeof repairHistoryCount !== "number" || !Number.isSafeInteger(repairHistoryCount) || repairHistoryCount < 1 || repairHistoryCount > MAX_REPAIR_HISTORY_COUNT) {
      throw new Error(
        "Invalid Workflow durability profile: bounds.repairHistoryCount must be a positive bounded integer"
      );
    }
    bounds.repairHistoryCount = repairHistoryCount;
  }
  if (!isRecord4(value.schemaVersions)) {
    throw new Error(
      "Invalid Workflow durability profile: schemaVersions must be an object"
    );
  }
  assertKnownFields2(
    value.schemaVersions,
    SCHEMA_KEYS,
    "Workflow durability profile schemaVersions"
  );
  const schemaVersions = value.schemaVersions;
  for (const key of SCHEMA_KEY_NAMES) {
    if (schemaVersions[key] !== WORKFLOW_DURABILITY_SCHEMA_VERSION) {
      throw new Error(`Unsupported Workflow durability schema version: ${key}`);
    }
  }
  const transitionJournal = value.schemaVersions.transitionJournal;
  if (transitionJournal !== void 0 && transitionJournal !== WORKFLOW_DURABILITY_SCHEMA_VERSION) {
    throw new Error(
      "Unsupported Workflow durability schema version: transitionJournal"
    );
  }
  const runLock = value.schemaVersions.runLock;
  if (runLock !== void 0 && runLock !== WORKFLOW_DURABILITY_SCHEMA_VERSION) {
    throw new Error("Unsupported Workflow durability schema version: runLock");
  }
  const checkpointManifest = value.schemaVersions.checkpointManifest;
  if (checkpointManifest !== void 0 && checkpointManifest !== WORKFLOW_DURABILITY_SCHEMA_VERSION) {
    throw new Error(
      "Unsupported Workflow durability schema version: checkpointManifest"
    );
  }
  const checkpointRecord = value.schemaVersions.checkpointRecord;
  if (checkpointRecord !== void 0 && checkpointRecord !== WORKFLOW_DURABILITY_SCHEMA_VERSION) {
    throw new Error(
      "Unsupported Workflow durability schema version: checkpointRecord"
    );
  }
  const contentSnapshot = value.schemaVersions.contentSnapshot;
  if (contentSnapshot !== void 0 && contentSnapshot !== WORKFLOW_DURABILITY_SCHEMA_VERSION) {
    throw new Error(
      "Unsupported Workflow durability schema version: contentSnapshot"
    );
  }
  const verificationReceipt = value.schemaVersions.verificationReceipt;
  if (verificationReceipt !== void 0 && verificationReceipt !== WORKFLOW_DURABILITY_SCHEMA_VERSION) {
    throw new Error(
      "Unsupported Workflow durability schema version: verificationReceipt"
    );
  }
  const repairEpisode = value.schemaVersions.repairEpisode ?? value.schemaVersions.repairHistory ?? value.schemaVersions.repair;
  const repairSchemaAliases = [
    value.schemaVersions.repairEpisode,
    value.schemaVersions.repairHistory,
    value.schemaVersions.repair
  ].filter((value2) => value2 !== void 0);
  if (repairSchemaAliases.some((value2) => value2 !== repairSchemaAliases[0])) {
    throw new Error(
      "Invalid Workflow durability profile: repair schema aliases disagree"
    );
  }
  if (repairEpisode !== void 0 && repairEpisode !== WORKFLOW_DURABILITY_SCHEMA_VERSION) {
    throw new Error(
      "Unsupported Workflow durability schema version: repairEpisode"
    );
  }
  const finalizationTransaction = value.schemaVersions.finalizationTransaction;
  if (finalizationTransaction !== void 0 && finalizationTransaction !== WORKFLOW_DURABILITY_SCHEMA_VERSION) {
    throw new Error(
      "Unsupported Workflow durability schema version: finalizationTransaction"
    );
  }
  const finalizationReceipt = value.schemaVersions.finalizationReceipt;
  if (finalizationReceipt !== void 0 && finalizationReceipt !== WORKFLOW_DURABILITY_SCHEMA_VERSION) {
    throw new Error(
      "Unsupported Workflow durability schema version: finalizationReceipt"
    );
  }
  if (capabilities.includes("transition-journal") && (bounds.transitionJournalBytes === void 0 || transitionJournal !== WORKFLOW_DURABILITY_SCHEMA_VERSION)) {
    throw new Error(
      "Invalid Workflow durability profile: transition-journal requires its bound and schema version"
    );
  }
  if (capabilities.includes("transactional-finalization") && (!capabilities.includes("mutation-locks") || !capabilities.includes("revision-fences") || !capabilities.includes("transition-journal") || bounds.finalizationPlanBytes === void 0 || bounds.finalizationTransactionBytes === void 0 || bounds.finalizationReceiptBytes === void 0 || bounds.finalizationContentBytes === void 0 || bounds.finalizationOperationCount === void 0 || bounds.finalizationEventCount === void 0 || finalizationTransaction !== WORKFLOW_DURABILITY_SCHEMA_VERSION || finalizationReceipt !== WORKFLOW_DURABILITY_SCHEMA_VERSION)) {
    throw new Error(
      "Invalid Workflow durability profile: transactional-finalization requires mutation locks, revision fences, transition journal, finalization bounds, and schema versions"
    );
  }
  if (capabilities.includes("mutation-locks") && (bounds.runLockBytes === void 0 || runLock !== WORKFLOW_DURABILITY_SCHEMA_VERSION)) {
    throw new Error(
      "Invalid Workflow durability profile: mutation-locks requires its bound and schema version"
    );
  }
  if (capabilities.includes("verified-checkpoints") && (!capabilities.includes("mutation-locks") || !capabilities.includes("revision-fences") || !capabilities.includes("transition-journal") || bounds.checkpointManifestBytes === void 0 || bounds.checkpointRecordBytes === void 0 || bounds.checkpointCount === void 0 || checkpointManifest !== WORKFLOW_DURABILITY_SCHEMA_VERSION || checkpointRecord !== WORKFLOW_DURABILITY_SCHEMA_VERSION)) {
    throw new Error(
      "Invalid Workflow durability profile: verified-checkpoints requires mutation locks, transition journal, checkpoint bounds, and schema versions"
    );
  }
  const snapshotPolicy = value.snapshotPolicy === void 0 ? void 0 : parseWorkflowContentSnapshotPolicy(value.snapshotPolicy);
  if (snapshotPolicy !== void 0 && !capabilities.includes("content-snapshots")) {
    throw new Error(
      "Invalid Workflow durability profile: snapshotPolicy requires content-snapshots"
    );
  }
  if (capabilities.includes("content-snapshots") && (!capabilities.includes("mutation-locks") || !capabilities.includes("revision-fences") || !capabilities.includes("transition-journal") || snapshotPolicy === void 0 || contentSnapshot !== WORKFLOW_DURABILITY_SCHEMA_VERSION)) {
    throw new Error(
      "Invalid Workflow durability profile: content-snapshots requires mutation locks, revision fences, transition journal, snapshot policy, and schema version"
    );
  }
  let verificationPolicy;
  if (value.verificationPolicy !== void 0) {
    verificationPolicy = parseVerificationPolicy(value.verificationPolicy);
    if (!capabilities.includes("verification-receipts")) {
      throw new Error(
        "Invalid Workflow durability profile: verificationPolicy requires verification-receipts"
      );
    }
  }
  if (capabilities.includes("verification-receipts") && (!capabilities.includes("mutation-locks") || !capabilities.includes("revision-fences") || !capabilities.includes("transition-journal") || bounds.verificationReceiptBytes === void 0 || bounds.verificationReceiptCount === void 0 || verificationReceipt !== WORKFLOW_DURABILITY_SCHEMA_VERSION)) {
    throw new Error(
      "Invalid Workflow durability profile: verification-receipts requires mutation locks, revision fences, transition journal, receipt bounds, and schema version"
    );
  }
  const repairPolicyValue = value.repairPolicy ?? value.repair;
  if (value.repairPolicy !== void 0 && value.repair !== void 0 && JSON.stringify(stableValue(value.repairPolicy)) !== JSON.stringify(stableValue(value.repair))) {
    throw new Error(
      "Invalid Workflow durability profile: repair policy aliases disagree"
    );
  }
  const repairPolicy = repairPolicyValue === void 0 ? void 0 : normalizeWorkflowRepairPolicy(
    repairPolicyValue
  );
  if (repairPolicy !== void 0 && !capabilities.includes("repair-policy")) {
    throw new Error(
      "Invalid Workflow durability profile: repairPolicy requires repair-policy capability"
    );
  }
  if (capabilities.includes("repair-policy") && (!capabilities.includes("mutation-locks") || !capabilities.includes("revision-fences") || !capabilities.includes("transition-journal") || repairPolicy === void 0 || bounds.repairHistoryBytes === void 0 || bounds.repairHistoryCount === void 0 || repairPolicy !== void 0 && repairPolicy.maxFailures > bounds.repairHistoryCount || repairEpisode !== WORKFLOW_DURABILITY_SCHEMA_VERSION)) {
    throw new Error(
      "Invalid Workflow durability profile: repair-policy requires mutation locks, revision fences, transition journal, repair policy, repair history bounds, and schema version"
    );
  }
  if (value.findingCatalogVersion !== WORKFLOW_FINDING_CATALOG_VERSION) {
    throw new Error(
      `Unsupported Workflow durability finding catalog version: ${String(value.findingCatalogVersion)}`
    );
  }
  return {
    version: WORKFLOW_DURABILITY_PROFILE_VERSION,
    capabilities: [...capabilities].sort(),
    bounds,
    schemaVersions: {
      runState: WORKFLOW_DURABILITY_SCHEMA_VERSION,
      pendingAction: WORKFLOW_DURABILITY_SCHEMA_VERSION,
      trajectory: WORKFLOW_DURABILITY_SCHEMA_VERSION,
      artifacts: WORKFLOW_DURABILITY_SCHEMA_VERSION,
      revisionClaim: WORKFLOW_DURABILITY_SCHEMA_VERSION,
      ...runLock === WORKFLOW_DURABILITY_SCHEMA_VERSION ? { runLock: WORKFLOW_DURABILITY_SCHEMA_VERSION } : {},
      ...transitionJournal === WORKFLOW_DURABILITY_SCHEMA_VERSION ? { transitionJournal: WORKFLOW_DURABILITY_SCHEMA_VERSION } : {},
      ...checkpointManifest === WORKFLOW_DURABILITY_SCHEMA_VERSION ? { checkpointManifest: WORKFLOW_DURABILITY_SCHEMA_VERSION } : {},
      ...checkpointRecord === WORKFLOW_DURABILITY_SCHEMA_VERSION ? { checkpointRecord: WORKFLOW_DURABILITY_SCHEMA_VERSION } : {},
      ...contentSnapshot === WORKFLOW_DURABILITY_SCHEMA_VERSION ? { contentSnapshot: WORKFLOW_DURABILITY_SCHEMA_VERSION } : {},
      ...verificationReceipt === WORKFLOW_DURABILITY_SCHEMA_VERSION ? { verificationReceipt: WORKFLOW_DURABILITY_SCHEMA_VERSION } : {},
      ...repairEpisode === WORKFLOW_DURABILITY_SCHEMA_VERSION ? { repairEpisode: WORKFLOW_DURABILITY_SCHEMA_VERSION } : {},
      ...finalizationTransaction === WORKFLOW_DURABILITY_SCHEMA_VERSION ? { finalizationTransaction: WORKFLOW_DURABILITY_SCHEMA_VERSION } : {},
      ...finalizationReceipt === WORKFLOW_DURABILITY_SCHEMA_VERSION ? { finalizationReceipt: WORKFLOW_DURABILITY_SCHEMA_VERSION } : {}
    },
    findingCatalogVersion: WORKFLOW_FINDING_CATALOG_VERSION,
    ...snapshotPolicy ? { snapshotPolicy } : {},
    ...verificationPolicy ? { verificationPolicy } : {},
    ...repairPolicy ? { repairPolicy } : {}
  };
}
function normalizeWorkflowDurabilityProtocol(protocol) {
  const durability = protocol.capabilities?.durability;
  if (durability === void 0) return protocol;
  return {
    ...structuredClone(protocol),
    capabilities: {
      ...structuredClone(protocol.capabilities),
      durability: parseWorkflowDurabilityProfile(durability)
    }
  };
}
function durabilityProfileForProtocol(protocol) {
  const durability = protocol.capabilities?.durability;
  return durability === void 0 ? void 0 : parseWorkflowDurabilityProfile(durability);
}
function sameDurabilityProfile(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

// src/skill-runtime/load.ts
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
  const durabilityProfile = value.durabilityProfile === void 0 ? void 0 : parseWorkflowDurabilityProfile(value.durabilityProfile);
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
    ...durabilityProfile ? { durabilityProfile } : {},
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
function loadSkillPackageDocument(document, root, filePath = path6.join(root, "package.json")) {
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
    root: path6.resolve(root),
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
import path7 from "path";
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
    const normalized = path7.posix.normalize(tool.source.replaceAll("\\", "/"));
    if (path7.isAbsolute(tool.source) || normalized === ".." || normalized.startsWith("../")) {
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
  return path8.posix.normalize(source.replaceAll("\\", "/"));
}
function assertInside(parent, target, label) {
  const relative = path8.relative(parent, target);
  if (relative === "" || !path8.isAbsolute(relative) && !relative.startsWith(`..${path8.sep}`)) {
    return;
  }
  throw new Error(`${label} resolves outside the Skill package`);
}
async function readPackageFile(root, relativePath2, label) {
  const normalized = normalizedRelativePath(relativePath2);
  if (path8.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} resolves outside the Skill package`);
  }
  const target = path8.resolve(root, ...normalized.split("/"));
  assertInside(root, target, label);
  let realTarget;
  try {
    realTarget = await fs5.realpath(target);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${label} does not exist: ${relativePath2}`, {
        cause: error
      });
    }
    throw error;
  }
  assertInside(root, realTarget, label);
  if (!(await fs5.stat(realTarget)).isFile()) {
    throw new Error(`${label} is not a file: ${relativePath2}`);
  }
  return { path: normalized, content: await fs5.readFile(realTarget) };
}
async function snapshotFiles(pkg) {
  const root = await fs5.realpath(pkg.root);
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
    sha256: createHash3("sha256").update(file.content).digest("hex")
  }));
  return createHash3("sha256").update(
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
    await fs5.access(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function verifyPublishedSnapshot(snapshotDir, material) {
  try {
    const storedHash = (await fs5.readFile(path8.join(snapshotDir, "sha256"), "utf8")).trim();
    if (storedHash !== material.hash) throw new Error("hash mismatch");
    const storedPackage = await fs5.readFile(
      path8.join(snapshotDir, "package.json"),
      "utf8"
    );
    if (storedPackage !== packageJson(material.document))
      throw new Error("package mismatch");
    for (const file of material.files) {
      const stored = await fs5.readFile(
        path8.join(snapshotDir, ...file.path.split("/"))
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
  const snapshotsRoot = path8.resolve(changeDir, ".comet", "skill-snapshots");
  const snapshotDir = path8.join(snapshotsRoot, material.hash);
  await fs5.mkdir(snapshotsRoot, { recursive: true });
  if (await pathExists(snapshotDir)) {
    await verifyPublishedSnapshot(snapshotDir, material);
    return { hash: material.hash, snapshotDir };
  }
  const temporaryDir = path8.join(snapshotsRoot, `.tmp-${randomUUID2()}`);
  assertInside(snapshotsRoot, temporaryDir, "Temporary snapshot");
  assertInside(snapshotsRoot, snapshotDir, "Published snapshot");
  try {
    await fs5.mkdir(temporaryDir);
    for (const file of material.files) {
      const destination = path8.join(temporaryDir, ...file.path.split("/"));
      assertInside(temporaryDir, destination, `Snapshot file ${file.path}`);
      await fs5.mkdir(path8.dirname(destination), { recursive: true });
      await fs5.writeFile(destination, file.content);
    }
    await fs5.writeFile(
      path8.join(temporaryDir, "package.json"),
      packageJson(material.document)
    );
    await fs5.writeFile(path8.join(temporaryDir, "sha256"), material.hash + "\n");
    await fs5.rename(temporaryDir, snapshotDir);
  } catch (error) {
    if (await pathExists(snapshotDir)) {
      try {
        await verifyPublishedSnapshot(snapshotDir, material);
      } finally {
        await fs5.rm(temporaryDir, { recursive: true, force: true });
      }
      return { hash: material.hash, snapshotDir };
    }
    await fs5.rm(temporaryDir, { recursive: true, force: true });
    throw error;
  }
  return { hash: material.hash, snapshotDir };
}
async function readSkillSnapshot(changeDir, hash4) {
  if (!/^[a-f0-9]{64}$/u.test(hash4)) {
    throw new Error(`Invalid Skill snapshot hash: ${hash4}`);
  }
  const snapshotsRoot = path8.resolve(changeDir, ".comet", "skill-snapshots");
  const snapshotDir = path8.join(snapshotsRoot, hash4);
  assertInside(snapshotsRoot, snapshotDir, "Skill snapshot");
  try {
    const storedHash = (await fs5.readFile(path8.join(snapshotDir, "sha256"), "utf8")).trim();
    if (storedHash !== hash4) {
      throw new Error(`stored hash is ${storedHash || "(empty)"}`);
    }
    const packagePath = path8.join(snapshotDir, "package.json");
    const document = JSON.parse(
      await fs5.readFile(packagePath, "utf8")
    );
    const pkg = loadSkillPackageDocument(document, snapshotDir, packagePath);
    const errors = validateSkillPackage(pkg);
    if (errors.length > 0) {
      throw new Error(errors.map((error) => `  - ${error}`).join("\n"));
    }
    const calculated = await hashSkillPackage(pkg);
    if (calculated !== hash4) {
      throw new Error(`calculated hash is ${calculated}`);
    }
    return pkg;
  } catch (error) {
    throw new Error(`Skill snapshot is invalid or missing: ${hash4}`, {
      cause: error
    });
  }
}

// src/engine/run-store.ts
import path10 from "path";

// src/workflow-runtime/finalization.ts
import { promises as fs6 } from "node:fs";
import path9 from "node:path";

// src/workflow-runtime/revision-claim.ts
import { randomUUID as randomUUID3 } from "node:crypto";
var CLAIM_DIRECTORY = ".comet/revision-claims";
var CLAIM_MAX_IDENTIFIER_LENGTH = 256;
var CLAIM_WAIT_TIMEOUT_MS = 5e3;
var CLAIM_POLL_INTERVAL_MS = 10;
function isRecord5(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function assertKnownFields3(value, keys, label) {
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) throw new Error(`Invalid ${label}: unknown field ${unknown}`);
}
function requiredText(value, key, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > CLAIM_MAX_IDENTIFIER_LENGTH || /[\u0000\r\n]/u.test(value)) {
    throw new Error(`Invalid ${label}: ${key} must be a bounded string`);
  }
  return value;
}
function timestamp(value, key, label) {
  const result = requiredText(value, key, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result)) {
    throw new Error(`Invalid ${label}: ${key} must be an ISO timestamp`);
  }
  return result;
}
function nonNegativeInteger3(value, key, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}: ${key} must be a non-negative integer`);
  }
  return value;
}
function hash(value, key, label) {
  const result = requiredText(value, key, label);
  if (!/^[a-f0-9]{64}$/u.test(result)) {
    throw new Error(`Invalid ${label}: ${key} must be a SHA-256 hash`);
  }
  return result;
}
function parseExecutionIdentity(value) {
  const label = "Workflow revision claim execution";
  if (!isRecord5(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields3(
    value,
    /* @__PURE__ */ new Set([
      "protocolHash",
      "packageHash",
      "snapshotHash",
      "nodeToStep",
      "capabilityVersion",
      "resolverHash",
      "findingCatalogVersion",
      "durabilityProfile"
    ]),
    label
  );
  if (!isRecord5(value.nodeToStep)) {
    throw new Error(`Invalid ${label}: nodeToStep must be an object`);
  }
  const nodeToStep = {};
  for (const [nodeId, stepId2] of Object.entries(value.nodeToStep)) {
    nodeToStep[requiredText(nodeId, "nodeId", label)] = requiredText(
      stepId2,
      `nodeToStep.${nodeId}`,
      label
    );
  }
  if (value.capabilityVersion !== 3) {
    throw new Error(`Invalid ${label}: capabilityVersion is required`);
  }
  if (typeof value.resolverHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.resolverHash)) {
    throw new Error(`Invalid ${label}: resolverHash is required`);
  }
  if (value.findingCatalogVersion !== 1) {
    throw new Error(`Invalid ${label}: findingCatalogVersion is required`);
  }
  if (value.durabilityProfile === void 0) {
    throw new Error(`Invalid ${label}: durabilityProfile is required`);
  }
  const durabilityProfile = parseWorkflowDurabilityProfile(
    value.durabilityProfile
  );
  return {
    protocolHash: hash(value.protocolHash, "protocolHash", label),
    packageHash: hash(value.packageHash, "packageHash", label),
    snapshotHash: hash(value.snapshotHash, "snapshotHash", label),
    nodeToStep,
    ...value.capabilityVersion === 3 ? { capabilityVersion: 3 } : {},
    resolverHash: hash(value.resolverHash, "resolverHash", label),
    findingCatalogVersion: 1,
    durabilityProfile
  };
}
function parseClaim(value) {
  const label = "Workflow revision claim";
  if (!isRecord5(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields3(
    value,
    /* @__PURE__ */ new Set([
      "schemaVersion",
      "kind",
      "status",
      "operation",
      "runId",
      "expectedRevision",
      "expectedActionId",
      "intendedRevision",
      "execution",
      "ownerToken",
      "createdAt",
      "committedAt"
    ]),
    label
  );
  if (value.schemaVersion !== 1 || value.kind !== "workflow-revision-claim") {
    throw new Error(`Invalid ${label}: schema identity is invalid`);
  }
  if (value.status !== "prepared" && value.status !== "committed") {
    throw new Error(`Invalid ${label}: status is invalid`);
  }
  if (value.operation !== "workflow.submit") {
    throw new Error(`Invalid ${label}: operation is invalid`);
  }
  const expectedRevision = nonNegativeInteger3(
    value.expectedRevision,
    "expectedRevision",
    label
  );
  const intendedRevision = nonNegativeInteger3(
    value.intendedRevision,
    "intendedRevision",
    label
  );
  if (intendedRevision !== expectedRevision + 1) {
    throw new Error(`Invalid ${label}: revisions are not consecutive`);
  }
  const committedAt = value.committedAt === void 0 ? void 0 : requiredText(value.committedAt, "committedAt", label);
  if (value.status === "committed" !== (committedAt !== void 0)) {
    throw new Error(`Invalid ${label}: committedAt does not match status`);
  }
  const ownerToken = requiredText(value.ownerToken, "ownerToken", label);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    ownerToken
  )) {
    throw new Error(`Invalid ${label}: ownerToken is invalid`);
  }
  return {
    schemaVersion: 1,
    kind: "workflow-revision-claim",
    status: value.status,
    operation: "workflow.submit",
    runId: requiredText(value.runId, "runId", label),
    expectedRevision,
    expectedActionId: requiredText(
      value.expectedActionId,
      "expectedActionId",
      label
    ),
    intendedRevision,
    execution: parseExecutionIdentity(value.execution),
    ownerToken,
    createdAt: timestamp(value.createdAt, "createdAt", label),
    ...committedAt ? { committedAt: timestamp(committedAt, "committedAt", label) } : {}
  };
}
function revisionClaimPath(input) {
  return `${CLAIM_DIRECTORY}/revision-${input.expectedRevision}-${sha256(input.expectedActionId).slice(0, 24)}-${input.intendedRevision}.json`;
}
function profileForExecution(execution) {
  if (!execution.durabilityProfile) {
    throw new Error("Workflow revision claim requires a durability profile");
  }
  return parseWorkflowDurabilityProfile(execution.durabilityProfile);
}
function claimMatches(claim, input) {
  return claim.runId === input.runId && claim.expectedRevision === input.expectedRevision && claim.expectedActionId === input.expectedActionId && claim.intendedRevision === input.intendedRevision && JSON.stringify(stableValue(claim.execution)) === JSON.stringify(stableValue(input.execution));
}
async function readClaim(runRoot, input) {
  const raw = await readOptionalEngineRunText(
    runRoot,
    revisionClaimPath(input),
    profileForExecution(input.execution).bounds.claimBytes,
    "Workflow revision claim"
  );
  if (raw === null) return null;
  try {
    return parseClaim(JSON.parse(raw));
  } catch (error) {
    throw new Error("Workflow revision claim is malformed", { cause: error });
  }
}
function createClaim(input) {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || input.intendedRevision !== input.expectedRevision + 1) {
    throw new Error("Workflow revision claim revisions are invalid");
  }
  return {
    schemaVersion: 1,
    kind: "workflow-revision-claim",
    status: "prepared",
    operation: "workflow.submit",
    runId: input.runId,
    expectedRevision: input.expectedRevision,
    expectedActionId: input.expectedActionId,
    intendedRevision: input.intendedRevision,
    execution: structuredClone(input.execution),
    ownerToken: randomUUID3(),
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function serializeClaim(claim) {
  return `${JSON.stringify(stableValue(claim), null, 2)}
`;
}
async function waitForExistingClaim(runRoot, input, existing) {
  const deadline = Date.now() + CLAIM_WAIT_TIMEOUT_MS;
  let current = existing;
  while (current.status === "prepared" && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, CLAIM_POLL_INTERVAL_MS);
    });
    let next;
    try {
      next = await readClaim(runRoot, input);
    } catch (error) {
      if (error instanceof RaceSafeReadError && error.reason === "changed") {
        continue;
      }
      throw error;
    }
    if (!next) return current;
    if (!claimMatches(next, input)) {
      throw new Error("Workflow revision claim identity changed");
    }
    current = next;
  }
  return current;
}
async function acquireRevisionClaim(runRoot, input) {
  const candidate = createClaim(input);
  const relativePath2 = revisionClaimPath(input);
  const maxBytes = profileForExecution(input.execution).bounds.claimBytes;
  for (; ; ) {
    const existing = await readClaim(runRoot, input);
    if (existing) {
      if (!claimMatches(existing, input)) {
        throw new Error("Workflow revision claim identity changed");
      }
      return {
        acquired: false,
        claim: await waitForExistingClaim(runRoot, input, existing)
      };
    }
    try {
      await writeEngineRunText(
        runRoot,
        relativePath2,
        serializeClaim(candidate),
        maxBytes,
        "Workflow revision claim",
        { exclusive: true }
      );
      return {
        acquired: true,
        claim: candidate,
        async commit() {
          const current = await readClaim(runRoot, input);
          if (!current) {
            throw new Error(
              "Workflow revision claim disappeared before commit"
            );
          }
          if (current.status === "committed") {
            if (!claimMatches(current, input)) {
              throw new Error("Workflow revision claim identity changed");
            }
            return;
          }
          const committed = {
            ...candidate,
            status: "committed",
            committedAt: (/* @__PURE__ */ new Date()).toISOString()
          };
          await writeEngineRunText(
            runRoot,
            relativePath2,
            serializeClaim(committed),
            maxBytes,
            "Workflow revision claim",
            {
              beforeCommit: async () => {
                const current2 = await readClaim(runRoot, input);
                if (!current2 || current2.status !== "prepared" || current2.ownerToken !== candidate.ownerToken) {
                  throw new Error(
                    "Workflow revision claim changed before commit"
                  );
                }
              }
            }
          );
        },
        async abandon() {
          const current = await readClaim(runRoot, input);
          if (!current) return;
          if (current.status !== "prepared" || current.ownerToken !== candidate.ownerToken) {
            throw new Error(
              "Workflow revision claim changed before abandonment"
            );
          }
          await removeEngineRunFile(
            runRoot,
            relativePath2,
            "Workflow revision claim",
            {
              beforeRemove: async () => {
                const latest = await readClaim(runRoot, input);
                if (!latest || latest.status !== "prepared" || latest.ownerToken !== candidate.ownerToken) {
                  throw new Error(
                    "Workflow revision claim changed before abandonment"
                  );
                }
              }
            }
          );
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
}
async function commitExistingRevisionClaim(runRoot, input) {
  const existing = await readClaim(runRoot, input);
  if (!existing) return;
  if (existing.status === "committed") return;
  const committed = {
    ...existing,
    status: "committed",
    committedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  const maxBytes = profileForExecution(input.execution).bounds.claimBytes;
  await writeEngineRunText(
    runRoot,
    revisionClaimPath(input),
    serializeClaim(committed),
    maxBytes,
    "Workflow revision claim",
    {
      beforeCommit: async () => {
        const current = await readClaim(runRoot, input);
        if (!current || current.status !== "prepared" || current.ownerToken !== existing.ownerToken) {
          throw new Error("Workflow revision claim changed before commit");
        }
      }
    }
  );
}
function committedRevisionClaimText(raw) {
  let claim;
  try {
    claim = parseClaim(JSON.parse(raw));
  } catch (error) {
    throw new Error("Workflow revision claim is malformed", { cause: error });
  }
  if (claim.status === "committed") return serializeClaim(claim);
  return serializeClaim({
    ...claim,
    status: "committed",
    committedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
}

// src/workflow-runtime/finalization.ts
var WORKFLOW_FINALIZATION_SCHEMA_VERSION = 1;
var WORKFLOW_FINALIZATION_TRANSACTION_PATH = ".comet/finalization/transaction.json";
var WORKFLOW_FINALIZATION_RECEIPT_DIRECTORY = ".comet/finalization/receipts";
var WORKFLOW_FINALIZATION_MAX_OPERATIONS = 256;
var WORKFLOW_FINALIZATION_MAX_EVENTS = 1024;
var WORKFLOW_FINALIZATION_MAX_TEXT_BYTES = 64 * 1024;
var HASH_PATTERN3 = /^[a-f0-9]{64}$/u;
var SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
var MAX_IDENTIFIER_LENGTH = 256;
var PROTECTED_RUNTIME_DIRECTORY = ".comet";
var WORKFLOW_FINALIZATION_BOUNDARY_PHASES = [
  "prepared",
  "applying",
  "before-staging",
  "staged",
  "before-operation",
  "after-operation",
  "before-target-removal",
  "target-removed",
  "before-quarantine",
  "quarantined",
  "before-source-removal",
  "source-removed",
  "before-target-publication",
  "target-published",
  "operation-verified",
  "committing",
  "committed",
  "before-receipt",
  "receipt-written",
  "rolling-back",
  "before-rollback-operation",
  "rollback-verified",
  "before-cleanup",
  "cleanup-item",
  "cleaned",
  "rolled-back",
  "cleared"
];
var configuredFault;
var WorkflowFinalizationInjectedFaultError = class extends Error {
  constructor() {
    super("deterministic workflow finalization fault");
    this.name = "WorkflowFinalizationInjectedFaultError";
  }
};
async function invokeFault(boundary) {
  const configured = process.env.COMET_WORKFLOW_TEST_FINALIZATION_FAULT_BOUNDARY;
  const qualified = boundary.operationId ? `${boundary.phase}:${boundary.operationId}` : boundary.phase;
  if (configured === boundary.phase || configured === qualified) {
    throw new WorkflowFinalizationInjectedFaultError();
  }
  await configuredFault?.(boundary);
}
function isRecord6(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function assertKnownFields4(value, keys, label) {
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) throw new Error(`${label} has unknown field: ${unknown}`);
}
function boundedText2(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH || /[\u0000\r\n]/u.test(value)) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}
function boundedContent(value, label) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > WORKFLOW_FINALIZATION_MAX_TEXT_BYTES) {
    throw new Error(`${label} exceeds its byte bound`);
  }
  return value;
}
function safeId(value, label) {
  const result = boundedText2(value, label);
  if (!SAFE_ID_PATTERN.test(result)) {
    throw new Error(`${label} contains unsafe characters`);
  }
  return result;
}
function boundedHash2(value, label) {
  const result = boundedText2(value, label);
  if (!HASH_PATTERN3.test(result))
    throw new Error(`${label} must be a SHA-256 hash`);
  return result;
}
function nullableHash(value, label) {
  if (value === null) return null;
  return boundedHash2(value, label);
}
function nonNegativeInteger4(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}
function normalizePath(value, label, allowDot = false) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim().replaceAll("\\", "/");
  if (allowDot && (normalized === "." || normalized === "")) return "";
  if (normalized.length === 0 || path9.posix.isAbsolute(normalized) || path9.win32.isAbsolute(normalized) || /^(?:~|[\\/]|[A-Za-z]:)/u.test(normalized)) {
    throw new Error(`${label} must be relative`);
  }
  const segments = normalized.split("/");
  if (segments.some(
    (segment) => segment.length === 0 || segment === "." || segment === ".."
  ) || /[*?]/u.test(normalized)) {
    throw new Error(`${label} must be a safe relative path`);
  }
  return segments.join("/");
}
function parseFinalizationRoot(value, index) {
  const label = `Workflow finalization root ${index}`;
  if (!isRecord6(value)) throw new Error(`${label} must be an object`);
  assertKnownFields4(value, /* @__PURE__ */ new Set(["id", "path"]), label);
  const root = {
    id: safeId(value.id, `${label} id`),
    path: normalizePath(value.path, `${label} path`, true)
  };
  if (isProtectedRuntimePath(root.path)) {
    throw new Error(`${label} cannot target the protected runtime directory`);
  }
  return root;
}
function normalizeStringList(value, label) {
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error(`${label} must be a bounded array`);
  }
  const values = value.map((item) => boundedText2(item, label));
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  return [...values].sort((left, right) => left.localeCompare(right));
}
function normalizeReviewer2(value) {
  if (value === void 0) return { subjects: [], authorities: [] };
  if (!isRecord6(value))
    throw new Error("Finalization reviewer must be an object");
  assertKnownFields4(
    value,
    /* @__PURE__ */ new Set(["subjects", "authorities"]),
    "Finalization reviewer"
  );
  return {
    subjects: normalizeStringList(
      value.subjects ?? [],
      "Finalization reviewer subjects"
    ),
    authorities: normalizeStringList(
      value.authorities ?? [],
      "Finalization reviewer authorities"
    )
  };
}
function normalizeConfirmation(value) {
  if (value === void 0) {
    return {
      required: true,
      reviewer: { subjects: [], authorities: [] },
      rationale: { required: false }
    };
  }
  if (!isRecord6(value)) {
    throw new Error("Finalization confirmation must be an object");
  }
  assertKnownFields4(
    value,
    /* @__PURE__ */ new Set(["required", "reviewer", "rationale"]),
    "Finalization confirmation"
  );
  if (value.required !== void 0 && typeof value.required !== "boolean") {
    throw new Error("Finalization confirmation required must be boolean");
  }
  if (value.required === false) {
    throw new Error(
      "Finalization confirmation is required for every local write effect"
    );
  }
  let rationale = { required: false };
  if (value.rationale !== void 0) {
    if (!isRecord6(value.rationale)) {
      throw new Error("Finalization confirmation rationale must be an object");
    }
    assertKnownFields4(
      value.rationale,
      /* @__PURE__ */ new Set(["required"]),
      "Finalization confirmation rationale"
    );
    if (typeof value.rationale.required !== "boolean") {
      throw new Error(
        "Finalization confirmation rationale required must be boolean"
      );
    }
    rationale = { required: value.rationale.required };
  }
  return {
    required: true,
    reviewer: normalizeReviewer2(value.reviewer),
    rationale
  };
}
function normalizeOperation(value, index, roots) {
  const label = `Finalization operation ${index}`;
  if (!isRecord6(value)) throw new Error(`${label} must be an object`);
  if (typeof value.kind !== "string")
    throw new Error(`${label} kind is required`);
  const kind = value.kind;
  if (kind === "write") {
    assertKnownFields4(
      value,
      /* @__PURE__ */ new Set([
        "id",
        "kind",
        "root",
        "target",
        "content",
        "requiresConfirmation"
      ]),
      label
    );
    if (value.requiresConfirmation !== void 0 && typeof value.requiresConfirmation !== "boolean") {
      throw new Error(`${label} requiresConfirmation must be boolean`);
    }
    const operation2 = {
      id: safeId(value.id, `${label} id`),
      kind: "write",
      root: safeId(value.root, `${label} root`),
      target: normalizePath(value.target, `${label} target`),
      content: boundedContent(value.content, `${label} content`),
      ...value.requiresConfirmation === void 0 ? {} : { requiresConfirmation: value.requiresConfirmation }
    };
    if (!roots.has(operation2.root))
      throw new Error(`${label} root is not declared`);
    return operation2;
  }
  if (kind === "remove") {
    assertKnownFields4(
      value,
      /* @__PURE__ */ new Set(["id", "kind", "root", "target", "requiresConfirmation"]),
      label
    );
    if (value.requiresConfirmation !== void 0 && typeof value.requiresConfirmation !== "boolean") {
      throw new Error(`${label} requiresConfirmation must be boolean`);
    }
    const operation2 = {
      id: safeId(value.id, `${label} id`),
      kind: "remove",
      root: safeId(value.root, `${label} root`),
      target: normalizePath(value.target, `${label} target`),
      ...value.requiresConfirmation === void 0 ? {} : { requiresConfirmation: value.requiresConfirmation }
    };
    if (!roots.has(operation2.root))
      throw new Error(`${label} root is not declared`);
    return operation2;
  }
  if (kind === "move") {
    assertKnownFields4(
      value,
      /* @__PURE__ */ new Set([
        "id",
        "kind",
        "root",
        "source",
        "target",
        "requiresConfirmation"
      ]),
      label
    );
    if (value.requiresConfirmation !== void 0 && typeof value.requiresConfirmation !== "boolean") {
      throw new Error(`${label} requiresConfirmation must be boolean`);
    }
    const operation2 = {
      id: safeId(value.id, `${label} id`),
      kind: "move",
      root: safeId(value.root, `${label} root`),
      source: normalizePath(value.source, `${label} source`),
      target: normalizePath(value.target, `${label} target`),
      ...value.requiresConfirmation === void 0 ? {} : { requiresConfirmation: value.requiresConfirmation }
    };
    if (!roots.has(operation2.root))
      throw new Error(`${label} root is not declared`);
    if (operation2.source === operation2.target) {
      throw new Error(`${label} source and target must differ`);
    }
    return operation2;
  }
  throw new Error(`${label} kind is not registered: ${kind}`);
}
function normalizeWorkflowFinalizationDefinition(value) {
  if (!isRecord6(value))
    throw new Error("Workflow finalization must be an object");
  assertKnownFields4(
    value,
    /* @__PURE__ */ new Set([
      "schemaVersion",
      "roots",
      "operations",
      "confirmation",
      "requiredVerificationReceiptIds",
      "requireContentSnapshot"
    ]),
    "Workflow finalization"
  );
  if (value.schemaVersion !== WORKFLOW_FINALIZATION_SCHEMA_VERSION) {
    throw new Error("Workflow finalization schema version is unsupported");
  }
  if (!Array.isArray(value.roots) || value.roots.length === 0 || value.roots.length > 256) {
    throw new Error("Workflow finalization roots are outside their bound");
  }
  const roots = value.roots.map((entry, index) => {
    return parseFinalizationRoot(entry, index);
  });
  if (new Set(roots.map((root) => root.id)).size !== roots.length) {
    throw new Error("Workflow finalization root ids must be unique");
  }
  const rootIds = new Set(roots.map((root) => root.id));
  if (roots.some(
    (left, leftIndex) => roots.some(
      (right, rightIndex) => leftIndex !== rightIndex && (left.path === right.path || left.path.length === 0 && right.path.length > 0 || right.path.length === 0 && left.path.length > 0 || left.path.length > 0 && right.path.startsWith(`${left.path}/`) || right.path.length > 0 && left.path.startsWith(`${right.path}/`))
    )
  )) {
    throw new Error("Workflow finalization roots must not overlap");
  }
  if (!Array.isArray(value.operations) || value.operations.length === 0 || value.operations.length > WORKFLOW_FINALIZATION_MAX_OPERATIONS) {
    throw new Error("Workflow finalization operations are outside their bound");
  }
  const operations = value.operations.map(
    (entry, index) => normalizeOperation(entry, index, rootIds)
  );
  if (new Set(operations.map((operation2) => operation2.id)).size !== operations.length) {
    throw new Error("Workflow finalization operation ids must be unique");
  }
  const paths = operations.flatMap((operation2) => {
    const root = roots.find((candidate) => candidate.id === operation2.root);
    return [
      `${root.path}${root.path ? "/" : ""}${operation2.target}`,
      ...operation2.kind === "move" ? [`${root.path}${root.path ? "/" : ""}${operation2.source}`] : []
    ];
  });
  if (paths.some(isProtectedRuntimePath)) {
    throw new Error(
      "Workflow finalization cannot target the protected runtime directory"
    );
  }
  if (paths.some(
    (value2, index) => paths.some(
      (candidate, candidateIndex) => index !== candidateIndex && (value2 === candidate || value2.startsWith(`${candidate}/`) || candidate.startsWith(`${value2}/`))
    )
  )) {
    throw new Error("Workflow finalization operation paths must not overlap");
  }
  if (value.requiredVerificationReceiptIds !== void 0 && (!Array.isArray(value.requiredVerificationReceiptIds) || value.requiredVerificationReceiptIds.length > 256)) {
    throw new Error(
      "Workflow finalization receipt requirements are outside their bound"
    );
  }
  const requiredVerificationReceiptIds = [
    ...new Set(
      (value.requiredVerificationReceiptIds ?? []).map(
        (entry) => boundedText2(entry, "Workflow finalization verification receipt id")
      )
    )
  ].sort((left, right) => left.localeCompare(right));
  if (value.requireContentSnapshot !== void 0 && typeof value.requireContentSnapshot !== "boolean") {
    throw new Error(
      "Workflow finalization requireContentSnapshot must be boolean"
    );
  }
  return {
    schemaVersion: WORKFLOW_FINALIZATION_SCHEMA_VERSION,
    roots,
    operations,
    confirmation: normalizeConfirmation(value.confirmation),
    ...requiredVerificationReceiptIds.length > 0 ? { requiredVerificationReceiptIds } : {},
    ...value.requireContentSnapshot === true ? { requireContentSnapshot: true } : {}
  };
}
function validateWorkflowFinalizationDefinition(value) {
  normalizeWorkflowFinalizationDefinition(value);
}
function parseReviewerPolicy(value, label) {
  if (!isRecord6(value)) throw new Error(`${label} must be an object`);
  assertKnownFields4(value, /* @__PURE__ */ new Set(["subjects", "authorities"]), label);
  return {
    subjects: normalizeStringList(value.subjects, `${label}.subjects`),
    authorities: normalizeStringList(value.authorities, `${label}.authorities`)
  };
}
function parseRationalePolicy(value, label) {
  if (!isRecord6(value)) throw new Error(`${label} must be an object`);
  assertKnownFields4(value, /* @__PURE__ */ new Set(["required"]), label);
  if (typeof value.required !== "boolean") {
    throw new Error(`${label}.required must be boolean`);
  }
  return { required: value.required };
}
function parseWorkflowFinalizationPendingConfirmation(value) {
  const label = "Workflow finalization pending confirmation";
  if (!isRecord6(value)) throw new Error(`${label} must be an object`);
  assertKnownFields4(
    value,
    /* @__PURE__ */ new Set([
      "schemaVersion",
      "kind",
      "decisionId",
      "actionId",
      "sourceActionId",
      "planHash",
      "revision",
      "planRevision",
      "contentSnapshotHash",
      "verificationReceiptIds",
      "reviewer",
      "rationale"
    ]),
    label
  );
  if (value.schemaVersion !== WORKFLOW_FINALIZATION_SCHEMA_VERSION || value.kind !== "workflow-finalization-confirmation") {
    throw new Error(`${label} schema identity is invalid`);
  }
  if (!Array.isArray(value.verificationReceiptIds) || value.verificationReceiptIds.length > 256) {
    throw new Error(`${label} verificationReceiptIds are invalid`);
  }
  const verificationReceiptIds = value.verificationReceiptIds.map(
    (entry) => boundedText2(entry, `${label} verificationReceiptIds`)
  );
  if (new Set(verificationReceiptIds).size !== verificationReceiptIds.length) {
    throw new Error(
      `${label} verificationReceiptIds must not contain duplicates`
    );
  }
  return {
    schemaVersion: WORKFLOW_FINALIZATION_SCHEMA_VERSION,
    kind: "workflow-finalization-confirmation",
    decisionId: safeId(value.decisionId, `${label} decisionId`),
    actionId: safeId(value.actionId, `${label} actionId`),
    sourceActionId: safeId(value.sourceActionId, `${label} sourceActionId`),
    planHash: boundedHash2(value.planHash, `${label} planHash`),
    revision: nonNegativeInteger4(value.revision, `${label} revision`),
    planRevision: nonNegativeInteger4(
      value.planRevision,
      `${label} planRevision`
    ),
    contentSnapshotHash: nullableHash(
      value.contentSnapshotHash,
      `${label} contentSnapshotHash`
    ),
    verificationReceiptIds: [...verificationReceiptIds].sort(
      (left, right) => left.localeCompare(right)
    ),
    reviewer: parseReviewerPolicy(value.reviewer, `${label} reviewer`),
    rationale: parseRationalePolicy(value.rationale, `${label} rationale`)
  };
}
function parseWorkflowFinalizationReceiptReference(value) {
  const label = "Workflow finalization receipt reference";
  if (!isRecord6(value)) throw new Error(`${label} must be an object`);
  assertKnownFields4(
    value,
    /* @__PURE__ */ new Set([
      "schemaVersion",
      "kind",
      "receiptId",
      "receiptHash",
      "transactionId",
      "planHash",
      "runId",
      "revision",
      "resultingRevision",
      "status"
    ]),
    label
  );
  if (value.schemaVersion !== WORKFLOW_FINALIZATION_SCHEMA_VERSION || value.kind !== "workflow-finalization-receipt-reference") {
    throw new Error(`${label} schema identity is invalid`);
  }
  if (value.status !== "committed" && value.status !== "rolled-back") {
    throw new Error(`${label} status is invalid`);
  }
  return {
    schemaVersion: WORKFLOW_FINALIZATION_SCHEMA_VERSION,
    kind: "workflow-finalization-receipt-reference",
    receiptId: safeId(value.receiptId, `${label} receiptId`),
    receiptHash: boundedHash2(value.receiptHash, `${label} receiptHash`),
    transactionId: safeId(value.transactionId, `${label} transactionId`),
    planHash: boundedHash2(value.planHash, `${label} planHash`),
    runId: boundedText2(value.runId, `${label} runId`),
    revision: nonNegativeInteger4(value.revision, `${label} revision`),
    resultingRevision: nonNegativeInteger4(
      value.resultingRevision,
      `${label} resultingRevision`
    ),
    status: value.status
  };
}
function parseWorkflowFinalizationState(value, profile) {
  const label = "Workflow finalization state";
  if (!isRecord6(value)) throw new Error(`${label} must be an object`);
  assertKnownFields4(
    value,
    /* @__PURE__ */ new Set([
      "schemaVersion",
      "status",
      "planHash",
      "revision",
      "sourceActionId",
      "planRevision",
      "pendingConfirmation",
      "confirmationActionId",
      "confirmationCount",
      "transactionId",
      "receipt"
    ]),
    label
  );
  if (value.schemaVersion !== WORKFLOW_FINALIZATION_SCHEMA_VERSION) {
    throw new Error(`${label} schema version is unsupported`);
  }
  const statuses = /* @__PURE__ */ new Set([
    "awaiting-confirmation",
    "applying",
    "committed",
    "rolling-back",
    "rolled-back",
    "blocked"
  ]);
  if (typeof value.status !== "string" || !statuses.has(value.status)) {
    throw new Error(`${label} status is invalid`);
  }
  const pendingConfirmation = value.pendingConfirmation === void 0 ? void 0 : parseWorkflowFinalizationPendingConfirmation(value.pendingConfirmation);
  const receipt = value.receipt === void 0 ? void 0 : parseWorkflowFinalizationReceiptReference(value.receipt);
  const transactionId = value.transactionId === void 0 ? void 0 : safeId(value.transactionId, `${label} transactionId`);
  if (value.status === "awaiting-confirmation" && !pendingConfirmation) {
    throw new Error(
      `${label} awaiting-confirmation state is missing its action`
    );
  }
  const revision = nonNegativeInteger4(value.revision, `${label} revision`);
  const planRevision = nonNegativeInteger4(
    value.planRevision,
    `${label} planRevision`
  );
  if (planRevision > revision) {
    throw new Error(`${label} plan revision is newer than Run revision`);
  }
  if (pendingConfirmation && (pendingConfirmation.planRevision !== planRevision || pendingConfirmation.planHash !== value.planHash || pendingConfirmation.sourceActionId !== value.sourceActionId)) {
    throw new Error(`${label} pending confirmation identity is invalid`);
  }
  if (pendingConfirmation && pendingConfirmation.revision !== revision) {
    throw new Error(`${label} pending confirmation revision is invalid`);
  }
  if (value.status !== "awaiting-confirmation" && pendingConfirmation) {
    throw new Error(`${label} has an unexpected pending confirmation`);
  }
  if (value.confirmationActionId !== void 0 && value.status === "awaiting-confirmation") {
    if (value.confirmationCount === void 0) {
      throw new Error(`${label} confirmation count is missing`);
    }
  }
  const confirmationCount = value.confirmationCount === void 0 ? value.confirmationActionId === void 0 ? 0 : 1 : nonNegativeInteger4(
    value.confirmationCount,
    `${label} confirmationCount`
  );
  if (confirmationCount === 0 && value.confirmationActionId !== void 0 || confirmationCount > 0 && value.confirmationActionId === void 0) {
    throw new Error(`${label} confirmation identity is invalid`);
  }
  if (value.status === "committed" && !receipt) {
    throw new Error(`${label} terminal state is missing its receipt`);
  }
  if (value.status === "rolled-back" && transactionId !== void 0 && !receipt) {
    throw new Error(`${label} terminal state is missing its receipt`);
  }
  if (receipt && value.status !== "committed" && value.status !== "rolled-back") {
    throw new Error(`${label} has a receipt in an in-progress state`);
  }
  if (receipt && !transactionId) {
    throw new Error(`${label} receipt is missing its transaction id`);
  }
  if (receipt && transactionId !== receipt.transactionId) {
    throw new Error(`${label} receipt transaction identity is invalid`);
  }
  if (receipt && (value.status === "committed" && receipt.status !== "committed" || value.status === "rolled-back" && receipt.status !== "rolled-back")) {
    throw new Error(`${label} receipt status does not match its state`);
  }
  const state = {
    schemaVersion: WORKFLOW_FINALIZATION_SCHEMA_VERSION,
    status: value.status,
    planHash: boundedHash2(value.planHash, `${label} planHash`),
    revision,
    sourceActionId: safeId(value.sourceActionId, `${label} sourceActionId`),
    planRevision,
    ...pendingConfirmation ? { pendingConfirmation } : {},
    ...value.confirmationActionId !== void 0 ? {
      confirmationActionId: safeId(
        value.confirmationActionId,
        `${label} confirmationActionId`
      )
    } : {},
    ...confirmationCount > 0 ? { confirmationCount } : {},
    ...transactionId !== void 0 ? { transactionId } : {},
    ...receipt ? { receipt } : {}
  };
  const maxBytes = profile?.bounds.finalizationPlanBytes;
  if (maxBytes !== void 0 && Buffer.byteLength(JSON.stringify(state), "utf8") > maxBytes) {
    throw new Error(`${label} exceeds its configured bound`);
  }
  return state;
}
function isInside4(root, target) {
  const relative = path9.relative(path9.resolve(root), path9.resolve(target));
  return relative === "" || !path9.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path9.sep}`);
}
function joinRelative(root, child) {
  return root.length > 0 ? `${root}/${child}` : child;
}
function isRelativePathWithin(root, candidate) {
  return root === "" || candidate === root || candidate.startsWith(`${root}/`);
}
function isProtectedRuntimePath(relative) {
  return relative === PROTECTED_RUNTIME_DIRECTORY || relative.startsWith(`${PROTECTED_RUNTIME_DIRECTORY}/`);
}
function materialIdentity(content) {
  if (content === null) return { exists: false, bytes: 0, sha256: null };
  return {
    exists: true,
    bytes: Buffer.byteLength(content, "utf8"),
    sha256: sha256(content)
  };
}
function sameIdentity(left, right) {
  return left.exists === right.exists && left.bytes === right.bytes && left.sha256 === right.sha256;
}
async function readMaterial(root, relative, maxBytes) {
  const inspection = await inspectProtectedProjectPath(root, relative, {
    label: `Workflow finalization target ${relative}`,
    expected: "any"
  });
  if (!inspection.exists)
    return { identity: materialIdentity(null), content: null };
  if (inspection.kind !== "file") {
    throw new Error(
      `Workflow finalization target is not a regular file: ${relative}`
    );
  }
  const result = await readProtectedProjectFile(root, relative, maxBytes, {
    label: `Workflow finalization target ${relative}`
  });
  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
  } catch (error) {
    throw new Error(
      `Workflow finalization target is not valid UTF-8: ${relative}`,
      {
        cause: error
      }
    );
  }
  return { identity: materialIdentity(content), content };
}
async function assertRoot(root, relative) {
  if (relative === "") {
    const stat = await fs6.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(
        "Workflow finalization approved root must be a real directory"
      );
    }
    return;
  }
  const inspection = await inspectProtectedProjectPath(root, relative, {
    label: `Workflow finalization approved root ${relative}`,
    expected: "directory"
  });
  if (!inspection.exists) {
    throw new Error(
      `Workflow finalization approved root is missing: ${relative}`
    );
  }
}
function profileBound(profile, key) {
  const value = profile.bounds[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Workflow finalization bound is missing: ${key}`);
  }
  return value;
}
function operationRequiresConfirmation(operation2, confirmation) {
  return confirmation.required === true || operation2.requiresConfirmation === true || operation2.kind === "remove" || operation2.kind === "move";
}
function identityForOperation(operation2, rootPath, materialsByPath) {
  const targetPath = joinRelative(rootPath, operation2.target);
  const target = materialsByPath.get(targetPath);
  if (!target)
    throw new Error(
      `Workflow finalization target was not inspected: ${targetPath}`
    );
  const sourcePath = operation2.kind === "move" ? joinRelative(rootPath, operation2.source) : null;
  const source = sourcePath ? materialsByPath.get(sourcePath) : void 0;
  if (sourcePath && !source) {
    throw new Error(
      `Workflow finalization source was not inspected: ${sourcePath}`
    );
  }
  if (operation2.kind === "move" && !source?.identity.exists) {
    throw new Error(
      `Workflow finalization move source is missing: ${sourcePath}`
    );
  }
  const expectedTarget = operation2.kind === "write" ? materialIdentity(operation2.content) : operation2.kind === "remove" ? materialIdentity(null) : source.identity;
  const expectedSource = operation2.kind === "move" ? materialIdentity(null) : null;
  return {
    id: operation2.id,
    kind: operation2.kind,
    rootId: operation2.root,
    source: sourcePath,
    target: targetPath,
    stagedPath: null,
    backupPath: target.identity.exists ? null : null,
    quarantinePath: null,
    precondition: {
      source: source?.identity ?? null,
      target: target.identity
    },
    expectedPostState: {
      source: expectedSource,
      target: expectedTarget
    },
    contentHash: operation2.kind === "write" ? sha256(operation2.content) : operation2.kind === "move" ? source.identity.sha256 : null,
    contentBytes: operation2.kind === "write" ? Buffer.byteLength(operation2.content, "utf8") : operation2.kind === "move" ? source.identity.bytes : 0,
    requiresConfirmation: operationRequiresConfirmation(operation2, {
      required: false,
      reviewer: { subjects: [], authorities: [] },
      rationale: { required: false }
    })
  };
}
async function buildWorkflowFinalizationPreview(options) {
  const definition = normalizeWorkflowFinalizationDefinition(
    options.definition
  );
  const operationBound = profileBound(
    options.profile,
    "finalizationOperationCount"
  );
  if (definition.operations.length > operationBound) {
    throw new Error(
      "Workflow finalization operation count exceeds its configured bound"
    );
  }
  const contentBound = profileBound(
    options.profile,
    "finalizationContentBytes"
  );
  for (const operation2 of definition.operations) {
    if (operation2.kind === "write" && Buffer.byteLength(operation2.content, "utf8") > contentBound) {
      throw new Error(
        "Workflow finalization write content exceeds its configured bound"
      );
    }
  }
  const currentSnapshots = options.state.workflowRuntime?.contentSnapshots ?? [];
  const contentSnapshotHash = currentSnapshots.at(-1)?.hash ?? null;
  const finalizationState = options.state.workflowRuntime?.finalization;
  const planRevision = finalizationState?.planRevision ?? finalizationState?.pendingConfirmation?.planRevision ?? options.state.workflowRuntime?.revision ?? 0;
  const planActionId = finalizationState?.pendingConfirmation?.sourceActionId ?? options.state.pending ?? null;
  if (definition.requireContentSnapshot && contentSnapshotHash === null) {
    throw new Error("Workflow finalization requires a content snapshot");
  }
  const currentReceipts = new Map(
    (options.state.workflowRuntime?.verificationReceipts ?? []).map(
      (receipt) => [receipt.receiptId, receipt]
    )
  );
  const verificationReceiptIds = [
    ...definition.requiredVerificationReceiptIds ?? []
  ];
  for (const receiptId2 of verificationReceiptIds) {
    if (!currentReceipts.has(receiptId2)) {
      throw new Error(
        `Workflow finalization verification receipt is missing: ${receiptId2}`
      );
    }
    if (currentReceipts.get(receiptId2)?.status !== "passed") {
      throw new Error(
        `Workflow finalization verification receipt is not passed: ${receiptId2}`
      );
    }
  }
  const materialsByPath = /* @__PURE__ */ new Map();
  const roots = new Map(definition.roots.map((root) => [root.id, root.path]));
  for (const root of definition.roots) {
    await assertRoot(options.baseRoot, root.path);
  }
  for (const operation2 of definition.operations) {
    const rootPath = roots.get(operation2.root);
    const paths = [
      joinRelative(rootPath, operation2.target),
      ...operation2.kind === "move" ? [joinRelative(rootPath, operation2.source)] : []
    ];
    for (const relative of paths) {
      if (materialsByPath.has(relative)) continue;
      const material = await readMaterial(
        options.baseRoot,
        relative,
        contentBound
      );
      materialsByPath.set(relative, material);
    }
  }
  const baseOperations = definition.operations.map((operation2) => {
    const rootPath = roots.get(operation2.root);
    return identityForOperation(operation2, rootPath, materialsByPath);
  });
  const seed = {
    schemaVersion: WORKFLOW_FINALIZATION_SCHEMA_VERSION,
    runId: options.state.runId,
    revision: planRevision,
    actionId: planActionId,
    roots: structuredClone(definition.roots),
    execution: structuredClone(options.execution),
    contentSnapshotHash,
    verificationReceiptIds: [...verificationReceiptIds].sort(
      (left, right) => left.localeCompare(right)
    ),
    operations: baseOperations
  };
  const transactionId = `workflow-finalization-${sha256(
    JSON.stringify(stableValue(seed))
  ).slice(0, 32)}`;
  const confirmation = normalizeConfirmation(definition.confirmation);
  const operations = baseOperations.map((operation2) => {
    const rootPath = roots.get(operation2.rootId);
    const prefix = `${joinRelative(rootPath, ".comet/finalization")}/${transactionId}`;
    const backupPath = operation2.precondition.target.exists && (operation2.kind === "write" || operation2.kind === "move") ? `${prefix}/${operation2.id}.backup` : null;
    const stagedPath = operation2.kind === "write" ? `${prefix}/${operation2.id}.stage` : null;
    const quarantinePath = operation2.kind === "remove" && operation2.precondition.target.exists || operation2.kind === "move" && operation2.precondition.source?.exists ? `${prefix}/${operation2.id}.quarantine` : null;
    const declaration = definition.operations.find(
      (candidate) => candidate.id === operation2.id
    );
    return {
      ...operation2,
      stagedPath,
      backupPath,
      quarantinePath,
      requiresConfirmation: operationRequiresConfirmation(
        declaration,
        confirmation
      )
    };
  });
  const requiresConfirmation = operations.some(
    (operation2) => operationRequiresConfirmation(
      definition.operations.find((candidate) => candidate.id === operation2.id),
      confirmation
    )
  );
  const cleanupEntryCount = operations.reduce(
    (count, operation2) => count + [
      operation2.stagedPath,
      operation2.backupPath,
      operation2.quarantinePath
    ].filter((relative) => relative !== null).length,
    0
  );
  const estimatedEventCount = 16 + operations.length * 11 + cleanupEntryCount * 2;
  if (estimatedEventCount > profileBound(options.profile, "finalizationEventCount")) {
    throw new Error(
      "Workflow finalization event count exceeds its configured bound"
    );
  }
  for (const operation2 of operations) {
    const approvedRoot = path9.resolve(
      options.baseRoot,
      ...(roots.get(operation2.rootId) ?? "").split("/")
    );
    if (operation2.stagedPath && !isInside4(
      approvedRoot,
      path9.resolve(options.baseRoot, operation2.stagedPath)
    )) {
      throw new Error(
        `Workflow finalization staging path escapes its approved root: ${operation2.id}`
      );
    }
    if (operation2.backupPath && !isInside4(
      approvedRoot,
      path9.resolve(options.baseRoot, operation2.backupPath)
    )) {
      throw new Error(
        `Workflow finalization backup path escapes its approved root: ${operation2.id}`
      );
    }
    if (operation2.quarantinePath && !isInside4(
      approvedRoot,
      path9.resolve(options.baseRoot, operation2.quarantinePath)
    )) {
      throw new Error(
        `Workflow finalization quarantine path escapes its approved root: ${operation2.id}`
      );
    }
  }
  const previewBase = {
    schemaVersion: WORKFLOW_FINALIZATION_SCHEMA_VERSION,
    kind: "workflow-finalization-preview",
    runId: options.state.runId,
    revision: planRevision,
    actionId: planActionId,
    transactionId,
    roots: structuredClone(definition.roots),
    execution: structuredClone(options.execution),
    contentSnapshotHash,
    verificationReceiptIds: [...verificationReceiptIds].sort(
      (left, right) => left.localeCompare(right)
    ),
    operations,
    confirmation,
    requiresConfirmation
  };
  const planHash = sha256(JSON.stringify(stableValue(previewBase)));
  const preview = { ...previewBase, planHash };
  const planBytes = Buffer.byteLength(
    JSON.stringify(stableValue(preview)),
    "utf8"
  );
  if (planBytes > profileBound(options.profile, "finalizationPlanBytes")) {
    throw new Error(
      "Workflow finalization preview exceeds its configured bound"
    );
  }
  if (!HASH_PATTERN3.test(planHash))
    throw new Error("Workflow finalization plan hash is invalid");
  return preview;
}
var WorkflowFinalizationTransactionPendingError = class extends Error {
  constructor(transaction) {
    super(
      "WorkflowRuntime finalization recovery is required before another mutation"
    );
    this.transaction = transaction;
    this.name = "WorkflowFinalizationTransactionPendingError";
  }
  transaction;
};
var WorkflowFinalizationConflictError = class extends Error {
  constructor(paths) {
    super(
      `Workflow finalization observed an unknown file identity: ${paths.join(", ")}`
    );
    this.paths = paths;
    this.name = "WorkflowFinalizationConflictError";
  }
  paths;
};
function parseMaterialIdentity(value, label) {
  if (!isRecord6(value)) throw new Error(`${label} must be an object`);
  assertKnownFields4(value, /* @__PURE__ */ new Set(["exists", "bytes", "sha256"]), label);
  if (typeof value.exists !== "boolean")
    throw new Error(`${label}.exists must be boolean`);
  const bytes = nonNegativeInteger4(value.bytes, `${label}.bytes`);
  const digest = value.sha256 === null ? null : boundedHash2(value.sha256, `${label}.sha256`);
  if (!value.exists && (bytes !== 0 || digest !== null) || value.exists && digest === null) {
    throw new Error(`${label} identity is inconsistent`);
  }
  return { exists: value.exists, bytes, sha256: digest };
}
function parseOperationState(value, label) {
  if (!isRecord6(value)) throw new Error(`${label} must be an object`);
  assertKnownFields4(value, /* @__PURE__ */ new Set(["source", "target"]), label);
  return {
    source: value.source === null ? null : parseMaterialIdentity(value.source, `${label}.source`),
    target: parseMaterialIdentity(value.target, `${label}.target`)
  };
}
function parsePlannedOperation(value, index) {
  const label = `Workflow finalization planned operation ${index}`;
  if (!isRecord6(value)) throw new Error(`${label} must be an object`);
  assertKnownFields4(
    value,
    /* @__PURE__ */ new Set([
      "id",
      "kind",
      "rootId",
      "source",
      "target",
      "stagedPath",
      "backupPath",
      "quarantinePath",
      "precondition",
      "expectedPostState",
      "contentHash",
      "contentBytes",
      "requiresConfirmation"
    ]),
    label
  );
  if (value.kind !== "write" && value.kind !== "remove" && value.kind !== "move") {
    throw new Error(`${label} kind is invalid`);
  }
  if (value.source !== null && value.source !== void 0) {
    normalizePath(value.source, `${label} source`);
  }
  if (value.stagedPath !== null && value.stagedPath !== void 0) {
    normalizePath(value.stagedPath, `${label} stagedPath`);
  }
  if (value.backupPath !== null && value.backupPath !== void 0) {
    normalizePath(value.backupPath, `${label} backupPath`);
  }
  if (value.quarantinePath !== null && value.quarantinePath !== void 0) {
    normalizePath(value.quarantinePath, `${label} quarantinePath`);
  }
  const contentHash2 = value.contentHash === null ? null : boundedHash2(value.contentHash, `${label} contentHash`);
  const contentBytes = nonNegativeInteger4(
    value.contentBytes,
    `${label} contentBytes`
  );
  if (typeof value.requiresConfirmation !== "boolean") {
    throw new Error(`${label} requiresConfirmation must be boolean`);
  }
  const planned = {
    id: safeId(value.id, `${label} id`),
    kind: value.kind,
    rootId: safeId(value.rootId, `${label} rootId`),
    source: value.source === null || value.source === void 0 ? null : String(value.source),
    target: normalizePath(value.target, `${label} target`),
    stagedPath: value.stagedPath === null || value.stagedPath === void 0 ? null : String(value.stagedPath),
    backupPath: value.backupPath === null || value.backupPath === void 0 ? null : String(value.backupPath),
    quarantinePath: value.quarantinePath === null || value.quarantinePath === void 0 ? null : String(value.quarantinePath),
    precondition: parseOperationState(
      value.precondition,
      `${label} precondition`
    ),
    expectedPostState: parseOperationState(
      value.expectedPostState,
      `${label} expectedPostState`
    ),
    contentHash: contentHash2,
    contentBytes,
    requiresConfirmation: value.requiresConfirmation
  };
  if (planned.kind === "write" && (planned.source !== null || planned.contentHash === null || !planned.expectedPostState.target.exists || planned.expectedPostState.source !== null || planned.contentBytes !== planned.expectedPostState.target.bytes || planned.contentHash !== planned.expectedPostState.target.sha256)) {
    throw new Error(`${label} write identity is invalid`);
  }
  if (planned.kind === "remove" && (planned.source !== null || planned.contentHash !== null || planned.contentBytes !== 0 || planned.expectedPostState.source !== null || planned.expectedPostState.target.exists)) {
    throw new Error(`${label} remove identity is invalid`);
  }
  if (planned.kind === "move" && (planned.source === null || planned.precondition.source === null || planned.contentHash !== planned.precondition.source.sha256 || planned.contentBytes !== planned.precondition.source.bytes || planned.expectedPostState.source?.exists !== false || !sameIdentity(
    planned.expectedPostState.target,
    planned.precondition.source
  ))) {
    throw new Error(`${label} move identity is invalid`);
  }
  return planned;
}
function parseTimestamp(value, label) {
  const result = boundedText2(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result)) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return result;
}
function parseActionId(value, label) {
  return value === null ? null : safeId(value, label);
}
function parseWorkflowFinalizationPreview(value) {
  const label = "Workflow finalization preview";
  if (!isRecord6(value)) throw new Error(`${label} must be an object`);
  assertKnownFields4(
    value,
    /* @__PURE__ */ new Set([
      "schemaVersion",
      "kind",
      "runId",
      "revision",
      "actionId",
      "transactionId",
      "roots",
      "execution",
      "contentSnapshotHash",
      "verificationReceiptIds",
      "operations",
      "confirmation",
      "requiresConfirmation",
      "planHash"
    ]),
    label
  );
  if (value.schemaVersion !== WORKFLOW_FINALIZATION_SCHEMA_VERSION || value.kind !== "workflow-finalization-preview") {
    throw new Error(`${label} schema identity is invalid`);
  }
  const transactionId = safeId(value.transactionId, `${label} transactionId`);
  if (!Array.isArray(value.verificationReceiptIds) || value.verificationReceiptIds.length > 256) {
    throw new Error(`${label} verificationReceiptIds are invalid`);
  }
  const verificationReceiptIds = value.verificationReceiptIds.map(
    (entry) => boundedText2(entry, `${label} verificationReceiptIds`)
  );
  if (new Set(verificationReceiptIds).size !== verificationReceiptIds.length) {
    throw new Error(
      `${label} verificationReceiptIds must not contain duplicates`
    );
  }
  if (!Array.isArray(value.roots) || value.roots.length === 0 || value.roots.length > 256) {
    throw new Error(`${label}.roots are outside their bound`);
  }
  const roots = value.roots.map(
    (entry, index) => parseFinalizationRoot(entry, index)
  );
  if (new Set(roots.map((root) => root.id)).size !== roots.length) {
    throw new Error(`${label}.roots must have unique ids`);
  }
  if (roots.some(
    (left, leftIndex) => roots.some(
      (right, rightIndex) => leftIndex !== rightIndex && (left.path === right.path || isRelativePathWithin(left.path, right.path) || isRelativePathWithin(right.path, left.path))
    )
  )) {
    throw new Error(`${label}.roots must not overlap`);
  }
  if (!Array.isArray(value.operations) || value.operations.length === 0 || value.operations.length > WORKFLOW_FINALIZATION_MAX_OPERATIONS) {
    throw new Error(`${label} operations are outside their bound`);
  }
  const operations = value.operations.map(
    (entry, index) => parsePlannedOperation(entry, index)
  );
  if (new Set(operations.map((operation2) => operation2.id)).size !== operations.length) {
    throw new Error(`${label} operation ids must be unique`);
  }
  for (const operation2 of operations) {
    const root = roots.find((candidate) => candidate.id === operation2.rootId);
    if (!root) throw new Error(`${label} operation root is not declared`);
    const operationPrefix = `${joinRelative(
      root.path,
      `.comet/finalization/${transactionId}`
    )}/${operation2.id}`;
    const expectedStagedPath = operation2.kind === "write" ? `${operationPrefix}.stage` : null;
    const expectedBackupPath = operation2.precondition.target.exists && (operation2.kind === "write" || operation2.kind === "move") ? `${operationPrefix}.backup` : null;
    const expectedQuarantinePath = operation2.kind === "remove" && operation2.precondition.target.exists || operation2.kind === "move" && operation2.precondition.source?.exists ? `${operationPrefix}.quarantine` : null;
    if (operation2.stagedPath !== expectedStagedPath || operation2.backupPath !== expectedBackupPath || operation2.quarantinePath !== expectedQuarantinePath || operation2.kind !== "move" && operation2.source !== null || operation2.kind === "move" && operation2.source === null) {
      throw new Error(`${label} operation coordinates are invalid`);
    }
    const internalPrefix = `${joinRelative(
      root.path,
      `.comet/finalization/${transactionId}`
    )}/`;
    if (operation2.stagedPath !== null && !operation2.stagedPath.startsWith(internalPrefix) || operation2.backupPath !== null && !operation2.backupPath.startsWith(internalPrefix)) {
      throw new Error(
        `${label} staging or backup path is not transaction-scoped`
      );
    }
    for (const [candidate, protectedPath] of [
      [operation2.target, true],
      [operation2.source, true],
      [operation2.stagedPath, false],
      [operation2.backupPath, false],
      [operation2.quarantinePath, false]
    ]) {
      if (candidate !== null && (protectedPath && isProtectedRuntimePath(candidate) || !isRelativePathWithin(root.path, candidate))) {
        throw new Error(`${label} operation path escapes its approved root`);
      }
    }
  }
  if (typeof value.requiresConfirmation !== "boolean") {
    throw new Error(`${label} requiresConfirmation must be boolean`);
  }
  const preview = {
    schemaVersion: WORKFLOW_FINALIZATION_SCHEMA_VERSION,
    kind: "workflow-finalization-preview",
    runId: boundedText2(value.runId, `${label} runId`),
    revision: nonNegativeInteger4(value.revision, `${label} revision`),
    actionId: parseActionId(value.actionId, `${label} actionId`),
    transactionId,
    roots,
    execution: parseExecutionIdentity(value.execution),
    contentSnapshotHash: nullableHash(
      value.contentSnapshotHash,
      `${label} contentSnapshotHash`
    ),
    verificationReceiptIds: [...verificationReceiptIds].sort(
      (left, right) => left.localeCompare(right)
    ),
    operations,
    confirmation: normalizeConfirmation(value.confirmation),
    requiresConfirmation: value.requiresConfirmation,
    planHash: boundedHash2(value.planHash, `${label} planHash`)
  };
  const { planHash: _planHash, ...withoutHash } = preview;
  const expectedHash = sha256(JSON.stringify(stableValue(withoutHash)));
  if (expectedHash !== preview.planHash)
    throw new Error(`${label} hash is not canonical`);
  return preview;
}
function parseConfirmationRecord(value, label) {
  if (!isRecord6(value)) throw new Error(`${label} must be an object`);
  assertKnownFields4(
    value,
    /* @__PURE__ */ new Set([
      "decisionId",
      "actionId",
      "sourceActionId",
      "planHash",
      "revision",
      "choiceId",
      "reviewer",
      "rationaleHash",
      "confirmedAt"
    ]),
    label
  );
  const reviewer = value.reviewer;
  if (!isRecord6(reviewer))
    throw new Error(`${label}.reviewer must be an object`);
  assertKnownFields4(
    reviewer,
    /* @__PURE__ */ new Set(["subject", "authorities"]),
    `${label}.reviewer`
  );
  if (!Array.isArray(reviewer.authorities) || reviewer.authorities.length > 64) {
    throw new Error(`${label}.reviewer.authorities must be a bounded array`);
  }
  const authorities = reviewer.authorities.map(
    (entry) => boundedText2(entry, `${label}.reviewer.authorities`)
  );
  if (new Set(authorities).size !== authorities.length) {
    throw new Error(
      `${label}.reviewer.authorities must not contain duplicates`
    );
  }
  const sortedAuthorities = [...authorities].sort(
    (left, right) => left.localeCompare(right)
  );
  if (JSON.stringify(authorities) !== JSON.stringify(sortedAuthorities)) {
    throw new Error(`${label}.reviewer.authorities must be sorted`);
  }
  return {
    decisionId: safeId(value.decisionId, `${label}.decisionId`),
    actionId: safeId(value.actionId, `${label}.actionId`),
    sourceActionId: safeId(value.sourceActionId, `${label}.sourceActionId`),
    planHash: boundedHash2(value.planHash, `${label}.planHash`),
    revision: nonNegativeInteger4(value.revision, `${label}.revision`),
    choiceId: value.choiceId === "confirm" ? "confirm" : (() => {
      throw new Error(`${label}.choiceId is invalid`);
    })(),
    reviewer: {
      subject: boundedText2(reviewer.subject, `${label}.reviewer.subject`),
      authorities
    },
    rationaleHash: value.rationaleHash === null ? null : boundedHash2(value.rationaleHash, `${label}.rationaleHash`),
    confirmedAt: parseTimestamp(value.confirmedAt, `${label}.confirmedAt`)
  };
}
function parseOperationReceipt(value, index) {
  const label = `Workflow finalization operation receipt ${index}`;
  if (!isRecord6(value)) throw new Error(`${label} must be an object`);
  assertKnownFields4(
    value,
    /* @__PURE__ */ new Set([
      "id",
      "kind",
      "source",
      "target",
      "stagedPath",
      "backupPath",
      "quarantinePath",
      "precondition",
      "expectedPostState",
      "observedPostState",
      "status"
    ]),
    label
  );
  if (value.kind !== "write" && value.kind !== "remove" && value.kind !== "move") {
    throw new Error(`${label}.kind is invalid`);
  }
  if (value.status !== "committed" && value.status !== "rolled-back") {
    throw new Error(`${label}.status is invalid`);
  }
  return {
    id: safeId(value.id, `${label}.id`),
    kind: value.kind,
    source: value.source === null || value.source === void 0 ? null : normalizePath(value.source, `${label}.source`),
    target: normalizePath(value.target, `${label}.target`),
    stagedPath: value.stagedPath === null || value.stagedPath === void 0 ? null : normalizePath(value.stagedPath, `${label}.stagedPath`),
    backupPath: value.backupPath === null || value.backupPath === void 0 ? null : normalizePath(value.backupPath, `${label}.backupPath`),
    quarantinePath: value.quarantinePath === null || value.quarantinePath === void 0 ? null : normalizePath(value.quarantinePath, `${label}.quarantinePath`),
    precondition: parseOperationState(
      value.precondition,
      `${label}.precondition`
    ),
    expectedPostState: parseOperationState(
      value.expectedPostState,
      `${label}.expectedPostState`
    ),
    observedPostState: parseOperationState(
      value.observedPostState,
      `${label}.observedPostState`
    ),
    status: value.status
  };
}
function parseCleanupEntry(value, index) {
  const label = `Workflow finalization cleanup entry ${index}`;
  if (!isRecord6(value)) throw new Error(`${label} must be an object`);
  assertKnownFields4(
    value,
    /* @__PURE__ */ new Set(["operationId", "role", "path", "expected", "status"]),
    label
  );
  if (value.role !== "staged" && value.role !== "backup" && value.role !== "quarantine") {
    throw new Error(`${label}.role is invalid`);
  }
  if (value.status !== "pending" && value.status !== "cleaned" && value.status !== "missing") {
    throw new Error(`${label}.status is invalid`);
  }
  return {
    operationId: safeId(value.operationId, `${label}.operationId`),
    role: value.role,
    path: normalizePath(value.path, `${label}.path`),
    expected: parseMaterialIdentity(value.expected, `${label}.expected`),
    status: value.status
  };
}
function parseCleanup(value, label) {
  if (!isRecord6(value)) throw new Error(`${label} must be an object`);
  assertKnownFields4(value, /* @__PURE__ */ new Set(["status", "entries"]), label);
  if (value.status !== "pending" && value.status !== "completed") {
    throw new Error(`${label}.status is invalid`);
  }
  if (!Array.isArray(value.entries) || value.entries.length > 768) {
    throw new Error(`${label}.entries are outside their bound`);
  }
  const entries = value.entries.map(
    (entry, index) => parseCleanupEntry(entry, index)
  );
  const keys = entries.map(
    (entry) => `${entry.operationId}:${entry.role}:${entry.path}`
  );
  if (new Set(keys).size !== keys.length) {
    throw new Error(`${label}.entries must be unique`);
  }
  if (value.status === "completed" && entries.some((entry) => entry.status === "pending")) {
    throw new Error(`${label}.completed state has pending entries`);
  }
  return { status: value.status, entries };
}
function cleanupEntryKey(entry) {
  return `${entry.operationId}:${entry.role}`;
}
function validateCleanupEntries(expected, actual, label) {
  if (expected.length !== actual.entries.length) {
    throw new Error(`${label}.entries do not match transaction operations`);
  }
  const expectedByKey = new Map(
    expected.map((entry) => [cleanupEntryKey(entry), entry])
  );
  const actualKeys = /* @__PURE__ */ new Set();
  for (const entry of actual.entries) {
    const key = cleanupEntryKey(entry);
    const expectedEntry = expectedByKey.get(key);
    if (!expectedEntry || actualKeys.has(key) || entry.path !== expectedEntry.path || !sameIdentity(entry.expected, expectedEntry.expected)) {
      throw new Error(`${label}.entry identity is invalid`);
    }
    actualKeys.add(key);
  }
}
function receiptCleanupEntries(operations) {
  const entries = [];
  for (const operation2 of operations) {
    const values = [
      {
        role: "staged",
        path: operation2.stagedPath,
        expected: operation2.expectedPostState.target
      },
      {
        role: "backup",
        path: operation2.backupPath,
        expected: operation2.precondition.target
      },
      {
        role: "quarantine",
        path: operation2.quarantinePath,
        expected: operation2.kind === "remove" ? operation2.precondition.target : operation2.precondition.source ?? materialIdentity(null)
      }
    ];
    for (const value of values) {
      if (!value.path || !value.expected.exists) continue;
      entries.push({
        operationId: operation2.id,
        role: value.role,
        path: value.path,
        expected: value.expected,
        status: "pending"
      });
    }
  }
  return entries;
}
function parseFinalizationReceipt(value) {
  const label = "Workflow finalization receipt";
  if (!isRecord6(value)) throw new Error(`${label} must be an object`);
  assertKnownFields4(
    value,
    /* @__PURE__ */ new Set([
      "schemaVersion",
      "kind",
      "receiptId",
      "receiptHash",
      "transactionId",
      "runId",
      "revision",
      "resultingRevision",
      "planHash",
      "execution",
      "contentSnapshotHash",
      "verificationReceiptIds",
      "confirmation",
      "operations",
      "events",
      "cleanup",
      "recovery",
      "committedAt"
    ]),
    label
  );
  if (value.schemaVersion !== WORKFLOW_FINALIZATION_SCHEMA_VERSION || value.kind !== "workflow-finalization-receipt") {
    throw new Error(`${label} schema identity is invalid`);
  }
  if (!Array.isArray(value.verificationReceiptIds) || value.verificationReceiptIds.length > 256) {
    throw new Error(`${label}.verificationReceiptIds is invalid`);
  }
  const verificationReceiptIds = value.verificationReceiptIds.map(
    (entry) => boundedText2(entry, `${label}.verificationReceiptIds`)
  );
  const operations = Array.isArray(value.operations) ? value.operations.map(
    (entry, index) => parseOperationReceipt(entry, index)
  ) : (() => {
    throw new Error(`${label}.operations must be an array`);
  })();
  if (operations.length === 0 || operations.length > WORKFLOW_FINALIZATION_MAX_OPERATIONS) {
    throw new Error(`${label}.operations are outside their bound`);
  }
  if (new Set(operations.map((operation2) => operation2.id)).size !== operations.length) {
    throw new Error(`${label}.operations must have unique ids`);
  }
  if (!Array.isArray(value.events) || value.events.length === 0 || value.events.length > WORKFLOW_FINALIZATION_MAX_EVENTS) {
    throw new Error(`${label}.events are outside their bound`);
  }
  const events = value.events.map(
    (entry, index) => parseTransactionEvent(entry, index)
  );
  if (events.some((event, index) => event.sequence !== index + 1)) {
    throw new Error(`${label}.events must have contiguous sequences`);
  }
  if (!isRecord6(value.recovery))
    throw new Error(`${label}.recovery must be an object`);
  assertKnownFields4(
    value.recovery,
    /* @__PURE__ */ new Set(["status", "crashBoundaries"]),
    `${label}.recovery`
  );
  if (value.recovery.status !== "none" && value.recovery.status !== "recovered" && value.recovery.status !== "rolled-back") {
    throw new Error(`${label}.recovery.status is invalid`);
  }
  if (!Array.isArray(value.recovery.crashBoundaries) || value.recovery.crashBoundaries.length > WORKFLOW_FINALIZATION_MAX_EVENTS) {
    throw new Error(`${label}.recovery.crashBoundaries is invalid`);
  }
  const crashBoundaries = value.recovery.crashBoundaries.map(
    (entry) => boundedText2(entry, `${label}.recovery.crashBoundaries`)
  );
  const cleanup = value.cleanup === void 0 ? { status: "completed", entries: [] } : parseCleanup(value.cleanup, `${label}.cleanup`);
  if (value.cleanup !== void 0) {
    validateCleanupEntries(receiptCleanupEntries(operations), cleanup, label);
  }
  const receipt = {
    schemaVersion: WORKFLOW_FINALIZATION_SCHEMA_VERSION,
    kind: "workflow-finalization-receipt",
    receiptId: safeId(value.receiptId, `${label}.receiptId`),
    receiptHash: boundedHash2(value.receiptHash, `${label}.receiptHash`),
    transactionId: safeId(value.transactionId, `${label}.transactionId`),
    runId: boundedText2(value.runId, `${label}.runId`),
    revision: nonNegativeInteger4(value.revision, `${label}.revision`),
    resultingRevision: nonNegativeInteger4(
      value.resultingRevision,
      `${label}.resultingRevision`
    ),
    planHash: boundedHash2(value.planHash, `${label}.planHash`),
    execution: parseExecutionIdentity(value.execution),
    contentSnapshotHash: nullableHash(
      value.contentSnapshotHash,
      `${label}.contentSnapshotHash`
    ),
    verificationReceiptIds: [...verificationReceiptIds].sort(
      (left, right) => left.localeCompare(right)
    ),
    confirmation: value.confirmation === null ? (() => {
      throw new Error(`${label}.confirmation is required`);
    })() : parseConfirmationRecord(value.confirmation, `${label}.confirmation`),
    operations,
    events,
    cleanup,
    recovery: { status: value.recovery.status, crashBoundaries },
    committedAt: parseTimestamp(value.committedAt, `${label}.committedAt`)
  };
  if (cleanup.entries.some(
    (entry) => entry.status === "missing" && !cleanupMissingIsExpectedFor(operations, events, entry)
  )) {
    throw new Error(`${label} cleanup missing identity is ambiguous`);
  }
  if (receipt.confirmation.planHash !== receipt.planHash) {
    throw new Error(`${label} confirmation plan identity is invalid`);
  }
  const expectedOperationStatus = receipt.recovery.status === "rolled-back" ? "rolled-back" : "committed";
  for (const operation2 of receipt.operations) {
    if (operation2.status !== expectedOperationStatus) {
      throw new Error(`${label} operation status does not match recovery`);
    }
    const expectedObservedState = expectedOperationStatus === "rolled-back" ? operation2.precondition : operation2.expectedPostState;
    if (!sameStableValue2(operation2.observedPostState, expectedObservedState)) {
      throw new Error(`${label} operation observed state is invalid`);
    }
  }
  const { receiptHash: _receiptHash, ...withoutHash } = receipt;
  if (sha256(JSON.stringify(stableValue(withoutHash))) !== receipt.receiptHash) {
    throw new Error(`${label} hash is not canonical`);
  }
  return receipt;
}
function parseTransactionEvent(value, index) {
  const label = `Workflow finalization transaction event ${index}`;
  if (!isRecord6(value)) throw new Error(`${label} must be an object`);
  assertKnownFields4(
    value,
    /* @__PURE__ */ new Set(["sequence", "type", "operationId", "boundary", "timestamp"]),
    label
  );
  const eventTypes = /* @__PURE__ */ new Set([
    "prepared",
    "applying",
    "operation-staged",
    "operation-started",
    "operation-completed",
    "operation-quarantined",
    "operation-published",
    "operation-verified",
    "committing",
    "receipt-written",
    "committed",
    "rolling-back",
    "operation-rolled-back",
    "rolled-back",
    "cleanup-started",
    "cleanup-item",
    "cleanup-completed"
  ]);
  if (typeof value.type !== "string" || !eventTypes.has(value.type)) {
    throw new Error(`${label}.type is invalid`);
  }
  const boundary = boundedText2(value.boundary, `${label}.boundary`);
  if (!WORKFLOW_FINALIZATION_BOUNDARY_PHASES.some(
    (phase) => boundary === phase || boundary.startsWith(`${phase}:`)
  )) {
    throw new Error(`${label}.boundary is invalid`);
  }
  return {
    sequence: nonNegativeInteger4(value.sequence, `${label}.sequence`),
    type: value.type,
    operationId: value.operationId === null ? null : safeId(value.operationId, `${label}.operationId`),
    boundary,
    timestamp: parseTimestamp(value.timestamp, `${label}.timestamp`)
  };
}
function parseTransactionOperation(value, index) {
  const label = `Workflow finalization transaction operation ${index}`;
  if (!isRecord6(value)) throw new Error(`${label} must be an object`);
  assertKnownFields4(
    value,
    /* @__PURE__ */ new Set([
      "id",
      "kind",
      "rootId",
      "source",
      "target",
      "stagedPath",
      "backupPath",
      "quarantinePath",
      "precondition",
      "expectedPostState",
      "contentHash",
      "contentBytes",
      "requiresConfirmation",
      "content",
      "previousSourceContent",
      "previousTargetContent",
      "status"
    ]),
    label
  );
  const {
    content: _content,
    previousSourceContent: _previousSourceContent,
    previousTargetContent: _previousTargetContent,
    status: _status,
    ...plannedValue
  } = value;
  const planned = parsePlannedOperation(plannedValue, index);
  const statusValues = /* @__PURE__ */ new Set([
    "pending",
    "staged",
    "target-quarantined",
    "source-quarantined",
    "target-published",
    "verified",
    "applying",
    "committed",
    "rolled-back"
  ]);
  if (typeof value.status !== "string" || !statusValues.has(value.status)) {
    throw new Error(`${label}.status is invalid`);
  }
  const content = value.content === null ? null : boundedContent(value.content, `${label}.content`);
  const previousSourceContent = value.previousSourceContent === null ? null : boundedContent(
    value.previousSourceContent,
    `${label}.previousSourceContent`
  );
  const previousTargetContent = value.previousTargetContent === null ? null : boundedContent(
    value.previousTargetContent,
    `${label}.previousTargetContent`
  );
  const expectedContentIdentity = content === null ? materialIdentity(null) : materialIdentity(content);
  if ((planned.kind === "write" || planned.kind === "move") && (content === null || !sameIdentity(expectedContentIdentity, {
    exists: true,
    bytes: planned.contentBytes,
    sha256: planned.contentHash
  }))) {
    throw new Error(`${label}.content identity is invalid`);
  }
  if (planned.kind === "remove" && content !== null) {
    throw new Error(`${label}.content is invalid for remove`);
  }
  if (!sameIdentity(
    materialIdentity(previousTargetContent),
    planned.precondition.target
  ) || !sameIdentity(
    materialIdentity(previousSourceContent),
    planned.precondition.source ?? materialIdentity(null)
  )) {
    throw new Error(
      `${label} previous material does not match its precondition`
    );
  }
  return {
    ...planned,
    content,
    previousSourceContent,
    previousTargetContent,
    status: value.status
  };
}
function parseWorkflowFinalizationTransaction(value) {
  const label = "Workflow finalization transaction";
  if (!isRecord6(value)) throw new Error(`${label} must be an object`);
  assertKnownFields4(
    value,
    /* @__PURE__ */ new Set([
      "schemaVersion",
      "kind",
      "status",
      "transactionId",
      "runId",
      "revision",
      "resultingRevision",
      "sourceActionId",
      "execution",
      "plan",
      "operations",
      "confirmation",
      "events",
      "cleanup",
      "recovery",
      "receipt",
      "createdAt",
      "updatedAt"
    ]),
    label
  );
  if (value.schemaVersion !== WORKFLOW_FINALIZATION_SCHEMA_VERSION || value.kind !== "workflow-finalization-transaction") {
    throw new Error(`${label} schema identity is invalid`);
  }
  const statuses = /* @__PURE__ */ new Set([
    "prepared",
    "applying",
    "committed",
    "rolling-back",
    "rolled-back"
  ]);
  if (typeof value.status !== "string" || !statuses.has(value.status)) {
    throw new Error(`${label}.status is invalid`);
  }
  if (!Array.isArray(value.operations) || value.operations.length === 0 || value.operations.length > WORKFLOW_FINALIZATION_MAX_OPERATIONS) {
    throw new Error(`${label}.operations are outside their bound`);
  }
  if (!Array.isArray(value.events) || value.events.length === 0 || value.events.length > WORKFLOW_FINALIZATION_MAX_EVENTS) {
    throw new Error(`${label}.events are outside their bound`);
  }
  const plan = parseWorkflowFinalizationPreview(value.plan);
  const operations = value.operations.map(
    (entry, index) => parseTransactionOperation(entry, index)
  );
  if (new Set(operations.map((operation2) => operation2.id)).size !== operations.length) {
    throw new Error(`${label}.operations must have unique ids`);
  }
  if (JSON.stringify(
    stableValue(
      operations.map(
        ({
          content,
          previousSourceContent,
          previousTargetContent,
          status,
          ...operation2
        }) => operation2
      )
    )
  ) !== JSON.stringify(stableValue(plan.operations))) {
    throw new Error(`${label}.operations do not match its plan`);
  }
  const events = value.events.map(
    (entry, index) => parseTransactionEvent(entry, index)
  );
  if (events.some((event, index) => event.sequence !== index + 1)) {
    throw new Error(`${label}.events must have contiguous sequences`);
  }
  if (!isRecord6(value.recovery))
    throw new Error(`${label}.recovery must be an object`);
  assertKnownFields4(
    value.recovery,
    /* @__PURE__ */ new Set(["status", "crashBoundaries"]),
    `${label}.recovery`
  );
  if (value.recovery.status !== "none" && value.recovery.status !== "recovered" && value.recovery.status !== "rolled-back") {
    throw new Error(`${label}.recovery.status is invalid`);
  }
  if (!Array.isArray(value.recovery.crashBoundaries) || value.recovery.crashBoundaries.length > WORKFLOW_FINALIZATION_MAX_EVENTS) {
    throw new Error(`${label}.recovery.crashBoundaries is invalid`);
  }
  const receipt = value.receipt === void 0 ? void 0 : parseFinalizationReceipt(value.receipt);
  const legacyCleanupEntries = cleanupEntriesForOperations(operations);
  const cleanup = value.cleanup === void 0 ? legacyCleanupEntries.length > 0 ? { status: "pending", entries: legacyCleanupEntries } : { status: "completed", entries: [] } : parseCleanup(value.cleanup, `${label}.cleanup`);
  if (value.cleanup !== void 0) {
    validateCleanupEntries(
      cleanupEntriesForOperations(operations),
      cleanup,
      label
    );
  }
  if (value.status === "committed" && !receipt) {
    throw new Error(`${label} committed state is missing its receipt`);
  }
  if (value.status === "rolled-back" && !receipt) {
    throw new Error(`${label} rolled-back transaction is missing its receipt`);
  }
  if (receipt && (receipt.transactionId !== value.transactionId || receipt.planHash !== plan.planHash || value.status === "rolled-back" && receipt.recovery.status !== "rolled-back")) {
    throw new Error(`${label} receipt identity does not match the transaction`);
  }
  const transaction = {
    schemaVersion: WORKFLOW_FINALIZATION_SCHEMA_VERSION,
    kind: "workflow-finalization-transaction",
    status: value.status,
    transactionId: safeId(value.transactionId, `${label}.transactionId`),
    runId: boundedText2(value.runId, `${label}.runId`),
    revision: nonNegativeInteger4(value.revision, `${label}.revision`),
    resultingRevision: nonNegativeInteger4(
      value.resultingRevision,
      `${label}.resultingRevision`
    ),
    sourceActionId: safeId(value.sourceActionId, `${label}.sourceActionId`),
    execution: parseExecutionIdentity(value.execution),
    plan,
    operations,
    confirmation: value.confirmation === null ? (() => {
      throw new Error(`${label}.confirmation is required`);
    })() : parseConfirmationRecord(value.confirmation, `${label}.confirmation`),
    events,
    cleanup,
    recovery: {
      status: value.recovery.status,
      crashBoundaries: value.recovery.crashBoundaries.map(
        (entry) => boundedText2(entry, `${label}.recovery.crashBoundaries`)
      )
    },
    ...receipt ? { receipt } : {},
    createdAt: parseTimestamp(value.createdAt, `${label}.createdAt`),
    updatedAt: parseTimestamp(value.updatedAt, `${label}.updatedAt`)
  };
  if (transaction.cleanup.entries.some(
    (entry) => entry.status === "missing" && !cleanupMissingIsExpected(transaction, entry)
  )) {
    throw new Error(`${label} cleanup missing identity is ambiguous`);
  }
  const reviewerPolicy = normalizeConfirmation(plan.confirmation).reviewer;
  const reviewerSubjects = reviewerPolicy?.subjects ?? [];
  const reviewerAuthorities = reviewerPolicy?.authorities ?? [];
  if (transaction.status === "committed" && transaction.operations.some((operation2) => operation2.status !== "committed")) {
    throw new Error(`${label} committed transaction has incomplete operations`);
  }
  if (transaction.status === "rolled-back" && transaction.operations.some(
    (operation2) => operation2.status !== "rolled-back"
  )) {
    throw new Error(
      `${label} rolled-back transaction has incomplete operations`
    );
  }
  if (transaction.cleanup.status === "completed" && transaction.cleanup.entries.some((entry) => entry.status === "pending")) {
    throw new Error(`${label} completed cleanup has pending entries`);
  }
  if (reviewerSubjects.length > 0 && !reviewerSubjects.includes(transaction.confirmation.reviewer.subject) || reviewerAuthorities.some(
    (authority) => !transaction.confirmation.reviewer.authorities.includes(authority)
  )) {
    throw new Error(`${label} confirmation reviewer is unauthorized`);
  }
  if (transaction.runId !== plan.runId || transaction.revision !== plan.revision || transaction.transactionId !== plan.transactionId || transaction.plan.actionId !== plan.actionId || transaction.sourceActionId !== plan.actionId || transaction.resultingRevision !== transaction.confirmation.revision + 1 || transaction.sourceActionId.length === 0 || JSON.stringify(stableValue(transaction.execution)) !== JSON.stringify(stableValue(plan.execution))) {
    throw new Error(`${label} identity does not match its plan`);
  }
  if (plan.requiresConfirmation !== (transaction.confirmation !== null)) {
    throw new Error(`${label} confirmation policy does not match its plan`);
  }
  if (transaction.confirmation && (transaction.confirmation.planHash !== plan.planHash || transaction.confirmation.sourceActionId !== transaction.sourceActionId || transaction.confirmation.revision !== plan.revision + 1)) {
    throw new Error(`${label} confirmation identity is invalid`);
  }
  if (receipt && (receipt.runId !== transaction.runId || receipt.revision !== transaction.revision || receipt.resultingRevision !== transaction.resultingRevision || !sameStableValue2(receipt.execution, transaction.execution) || !sameStableValue2(receipt.confirmation, transaction.confirmation) || transaction.status === "committed" && receipt.recovery.status === "rolled-back" || transaction.status === "rolled-back" && receipt.recovery.status !== "rolled-back")) {
    throw new Error(`${label} receipt identity is invalid`);
  }
  if (receipt && transaction.cleanup.status === "completed" && !sameStableValue2(receipt.cleanup, transaction.cleanup)) {
    throw new Error(`${label} receipt cleanup does not match transaction`);
  }
  if (receipt && value.cleanup !== void 0) {
    const expectedOperations = transaction.operations.map(
      (operation2) => receiptOperation(
        operation2,
        receipt.recovery.status === "rolled-back" ? "rolled-back" : "committed"
      )
    );
    if (!sameStableValue2(receipt.operations, expectedOperations)) {
      throw new Error(`${label} receipt operations do not match transaction`);
    }
    if (transaction.cleanup.status === "completed" && !sameStableValue2(receipt.events, transaction.events)) {
      throw new Error(`${label} receipt events do not match transaction`);
    }
  }
  return transaction;
}
function sameStableValue2(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}
function transactionMaxBytes(profile) {
  return profileBound(profile, "finalizationTransactionBytes");
}
function receiptMaxBytes(profile) {
  return profileBound(profile, "finalizationReceiptBytes");
}
function contentMaxBytes(profile) {
  return profileBound(profile, "finalizationContentBytes");
}
function serializeTransaction(transaction) {
  return `${JSON.stringify(stableValue(transaction), null, 2)}
`;
}
async function writeTransaction(runRoot, profile, transaction, options = {}) {
  const serialized = serializeTransaction(transaction);
  const maxBytes = transactionMaxBytes(profile);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new Error(
      `Workflow finalization transaction exceeds ${maxBytes} bytes`
    );
  }
  await writeEngineRunText(
    runRoot,
    WORKFLOW_FINALIZATION_TRANSACTION_PATH,
    serialized,
    maxBytes,
    "Workflow finalization transaction",
    { exclusive: options.exclusive, maxBytes }
  );
}
async function readWorkflowFinalizationTransaction(runRoot, profile) {
  const raw = await readOptionalEngineRunText(
    runRoot,
    WORKFLOW_FINALIZATION_TRANSACTION_PATH,
    transactionMaxBytes(profile),
    "Workflow finalization transaction"
  );
  if (raw === null) return null;
  try {
    const transaction = parseWorkflowFinalizationTransaction(
      JSON.parse(raw)
    );
    if (Buffer.byteLength(raw, "utf8") > transactionMaxBytes(profile)) {
      throw new Error(
        "Workflow finalization transaction exceeds its configured bound"
      );
    }
    if (Buffer.byteLength(JSON.stringify(stableValue(transaction.plan)), "utf8") > profileBound(profile, "finalizationPlanBytes")) {
      throw new Error(
        "Workflow finalization plan exceeds its configured bound"
      );
    }
    if (transaction.operations.length > profileBound(profile, "finalizationOperationCount")) {
      throw new Error(
        "Workflow finalization transaction operation count exceeds its configured bound"
      );
    }
    if (transaction.events.length > profileBound(profile, "finalizationEventCount")) {
      throw new Error(
        "Workflow finalization transaction event count exceeds its configured bound"
      );
    }
    return transaction;
  } catch (error) {
    throw new Error("Workflow finalization transaction is malformed", {
      cause: error
    });
  }
}
async function appendTransactionEvent(runRoot, profile, transaction, type, boundary, operationId = boundary.operationId ?? null) {
  if (transaction.events.length >= profileBound(profile, "finalizationEventCount")) {
    throw new Error(
      "Workflow finalization transaction event bound is exhausted"
    );
  }
  const timestamp6 = (/* @__PURE__ */ new Date()).toISOString();
  transaction.events.push({
    sequence: transaction.events.length + 1,
    type,
    operationId,
    boundary: boundary.path ? `${boundary.phase}:${boundary.path}` : boundary.phase,
    timestamp: timestamp6
  });
  transaction.updatedAt = timestamp6;
  await writeTransaction(runRoot, profile, transaction);
  await invokeFault(boundary);
}
function basePath(root, relative, label) {
  const normalized = normalizePath(relative, label);
  const resolved = path9.resolve(root, ...normalized.split("/"));
  if (!isInside4(root, resolved))
    throw new Error(`${label} escapes its managed root`);
  return resolved;
}
async function writeBaseText(root, relative, content, maxBytes, beforeCommit) {
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    throw new Error(
      "Workflow finalization content exceeds its configured bound"
    );
  }
  await atomicWriteContainedText(
    basePath(root, relative, "Workflow finalization write target"),
    content,
    {
      containedRoot: path9.resolve(root),
      beforeCommit
    }
  );
}
async function removeBaseFile(root, relative, beforeRemove) {
  const inspection = await inspectProtectedProjectPath(
    root,
    normalizePath(relative, "Workflow finalization remove target"),
    { label: "Workflow finalization remove target", expected: "file" }
  );
  if (!inspection.exists) return false;
  try {
    return await removeContainedFile(inspection.target, {
      containedRoot: inspection.projectRoot,
      beforeRemove
    });
  } catch (error) {
    if (error instanceof Error && /Contained file removal target changed before removal/u.test(
      error.message
    )) {
      throw new WorkflowFinalizationConflictError([relative]);
    }
    throw error;
  }
}
async function moveBaseFile(root, source, destination, beforeMove, beforeSourceUnlink) {
  const destinationParent = path9.posix.dirname(destination);
  if (destinationParent !== ".") {
    await ensureProtectedProjectDirectory(
      path9.resolve(root),
      destinationParent,
      {
        label: "Workflow finalization move destination parent"
      }
    );
  }
  try {
    return await moveContainedFile(
      basePath(root, source, "Workflow finalization move source"),
      basePath(root, destination, "Workflow finalization move destination"),
      {
        containedRoot: path9.resolve(root),
        beforeMove,
        beforeSourceUnlink
      }
    );
  } catch (error) {
    const code = error.code;
    if (code === "EEXIST" || error instanceof Error && /Contained file move (?:source|destination) (?:changed|must be missing)|Contained file move (?:parent|identity) changed/u.test(
      error.message
    )) {
      throw new WorkflowFinalizationConflictError([source, destination]);
    }
    throw error;
  }
}
async function operationMaterial(root, operation2, maxBytes) {
  const target = await readMaterial(root, operation2.target, maxBytes);
  const source = operation2.source === null ? null : await readMaterial(root, operation2.source, maxBytes);
  const staged = operation2.stagedPath === null ? null : await readMaterial(root, operation2.stagedPath, maxBytes);
  const backup = operation2.backupPath === null ? null : await readMaterial(root, operation2.backupPath, maxBytes);
  const quarantine = operation2.quarantinePath === null ? null : await readMaterial(root, operation2.quarantinePath, maxBytes);
  return { source, target, staged, backup, quarantine };
}
function operationMatches(actual, expected) {
  return (actual.source === null && expected.source === null || actual.source !== null && expected.source !== null && sameIdentity(actual.source.identity, expected.source)) && sameIdentity(actual.target.identity, expected.target);
}
function operationSourceExpected(operation2) {
  if (!operation2.precondition.source) {
    return materialIdentity(null);
  }
  return operation2.precondition.source;
}
function operationTargetExpected(operation2) {
  return operation2.precondition.target;
}
function operationPostSourceExpected(operation2) {
  if (!operation2.expectedPostState.source) {
    return materialIdentity(null);
  }
  return operation2.expectedPostState.source;
}
function operationPostTargetExpected(operation2) {
  return operation2.expectedPostState.target;
}
function storageContentExpected(operation2, role) {
  if (role === "staged") {
    return operation2.kind === "write" ? operation2.content : null;
  }
  if (role === "backup") return operation2.previousTargetContent;
  return operation2.kind === "remove" ? operation2.previousTargetContent : operation2.kind === "move" ? operation2.previousSourceContent : null;
}
function storageMaterial(actual, role) {
  return actual[role];
}
function storageMatchesContent(actual, role, content) {
  const material = storageMaterial(actual, role);
  return Boolean(
    material?.identity.exists && sameIdentity(material.identity, materialIdentity(content))
  );
}
function storagePath(operation2, role) {
  return role === "staged" ? operation2.stagedPath : role === "backup" ? operation2.backupPath : operation2.quarantinePath;
}
function storageIsExpectedOrMissing(actual, operation2, role) {
  const material = storageMaterial(actual, role);
  const expected = storageContentExpected(operation2, role);
  if (material === null) return expected === null;
  if (!material.identity.exists) return true;
  return expected !== null && sameIdentity(material.identity, materialIdentity(expected));
}
function operationStorageUnknownPaths(operation2, actual) {
  return ["staged", "backup", "quarantine"].flatMap((role) => {
    const material = storageMaterial(actual, role);
    if (!material || storageIsExpectedOrMissing(actual, operation2, role)) {
      return [];
    }
    return [storagePath(operation2, role)];
  });
}
function operationProgress(operation2, actual) {
  const sourcePre = operation2.source === null || actual.source !== null && sameIdentity(actual.source.identity, operationSourceExpected(operation2));
  const sourcePost = operation2.source === null || actual.source !== null && sameIdentity(
    actual.source.identity,
    operationPostSourceExpected(operation2)
  );
  const targetPre = sameIdentity(
    actual.target.identity,
    operationTargetExpected(operation2)
  );
  const targetPost = sameIdentity(
    actual.target.identity,
    operationPostTargetExpected(operation2)
  );
  if (operation2.kind === "write") {
    if (targetPost) return "post";
    if (targetPre) {
      return actual.staged?.identity.exists ? "staged" : "previous";
    }
    if (!actual.target.identity.exists && actual.staged?.identity.exists) {
      return "staged";
    }
    return null;
  }
  if (operation2.kind === "remove") {
    if (targetPre) return "previous";
    if (targetPost) return "post";
    return null;
  }
  if (sourcePre && targetPre) return "previous";
  if (sourcePost && targetPre) return "source-quarantined";
  if (sourcePost && !actual.target.identity.exists) return "source-quarantined";
  if (sourcePre && targetPost) return "source-quarantined";
  if (sourcePost && targetPost) return "post";
  return null;
}
function transactionOperationContent(operation2, material) {
  if (operation2.kind === "write") return operation2.content;
  if (operation2.kind === "move") {
    if (!material.source || material.source.content === null) {
      throw new Error(
        `Workflow finalization move source is not readable: ${operation2.source}`
      );
    }
    return material.source.content;
  }
  return null;
}
async function createTransactionOperations(request) {
  const definition = normalizeWorkflowFinalizationDefinition(
    request.definition
  );
  const declarations2 = new Map(
    definition.operations.map((operation2) => [operation2.id, operation2])
  );
  const result = [];
  for (const planned of request.plan.operations) {
    const declaration = declarations2.get(planned.id);
    if (!declaration || declaration.kind !== planned.kind || declaration.root !== planned.rootId || joinRelative(
      definition.roots.find((root) => root.id === declaration.root).path,
      declaration.target
    ) !== planned.target || declaration.kind === "move" && joinRelative(
      definition.roots.find((root) => root.id === declaration.root).path,
      declaration.source
    ) !== planned.source) {
      throw new WorkflowFinalizationConflictError([planned.id]);
    }
    const material = await operationMaterial(
      request.baseRoot,
      planned,
      contentMaxBytes(request.profile)
    );
    if (!operationMatches(material, planned.precondition)) {
      throw new WorkflowFinalizationConflictError([
        planned.target,
        ...planned.source ? [planned.source] : []
      ]);
    }
    const content = transactionOperationContent(declaration, material);
    if (content !== null && !sameIdentity(materialIdentity(content), {
      exists: true,
      bytes: planned.contentBytes,
      sha256: planned.contentHash
    })) {
      throw new WorkflowFinalizationConflictError([planned.target]);
    }
    result.push({
      ...structuredClone(planned),
      content,
      previousSourceContent: material.source?.content ?? null,
      previousTargetContent: material.target.content,
      status: "pending"
    });
  }
  return result;
}
function transactionMatchesRequest(transaction, request) {
  return transaction.transactionId === request.plan.transactionId && transaction.runId === request.plan.runId && transaction.revision === request.plan.revision && transaction.resultingRevision === request.resultingRevision && transaction.sourceActionId === request.sourceActionId && transaction.plan.planHash === request.plan.planHash && sameStableValue2(transaction.execution, request.execution) && sameStableValue2(transaction.confirmation, request.confirmation);
}
function validateWorkflowFinalizationPlanDeclaration(plan, definition) {
  const normalized = normalizeWorkflowFinalizationDefinition(definition);
  if (!sameStableValue2(plan.roots, normalized.roots) || !sameStableValue2(plan.confirmation, normalized.confirmation) || !sameStableValue2(
    plan.verificationReceiptIds,
    normalized.requiredVerificationReceiptIds ?? []
  ) || plan.requiresConfirmation !== true || plan.operations.length !== normalized.operations.length) {
    throw new WorkflowFinalizationConflictError(["plan"]);
  }
  for (const [index, operation2] of normalized.operations.entries()) {
    const planned = plan.operations[index];
    const target = joinRelative(
      normalized.roots.find((root) => root.id === operation2.root).path,
      operation2.target
    );
    const source = operation2.kind === "move" ? joinRelative(
      normalized.roots.find((root) => root.id === operation2.root).path,
      operation2.source
    ) : null;
    const prefix = `${joinRelative(
      normalized.roots.find((root) => root.id === operation2.root).path,
      `.comet/finalization/${plan.transactionId}`
    )}/${operation2.id}`;
    const stagedPath = operation2.kind === "write" ? `${prefix}.stage` : null;
    const backupPath = plan.operations[index].precondition.target.exists && (operation2.kind === "write" || operation2.kind === "move") ? `${prefix}.backup` : null;
    const quarantinePath = operation2.kind === "remove" && plan.operations[index].precondition.target.exists || operation2.kind === "move" && plan.operations[index].precondition.source?.exists ? `${prefix}.quarantine` : null;
    if (!planned || planned.id !== operation2.id || planned.kind !== operation2.kind || planned.rootId !== operation2.root || planned.target !== target || planned.source !== source || planned.stagedPath !== stagedPath || planned.backupPath !== backupPath || planned.quarantinePath !== quarantinePath || planned.requiresConfirmation !== true || operation2.kind === "write" && (planned.contentHash !== sha256(operation2.content) || planned.contentBytes !== Buffer.byteLength(operation2.content, "utf8"))) {
      throw new WorkflowFinalizationConflictError([operation2.id]);
    }
  }
}
function cleanupEntriesForOperations(operations) {
  const entries = [];
  for (const operation2 of operations) {
    for (const role of ["staged", "backup", "quarantine"]) {
      const relative = storagePath(operation2, role);
      const content = storageContentExpected(operation2, role);
      if (!relative || content === null) continue;
      entries.push({
        operationId: operation2.id,
        role,
        path: relative,
        expected: materialIdentity(content),
        status: "pending"
      });
    }
  }
  return entries;
}
function newTransaction(request, operations) {
  const timestamp6 = (/* @__PURE__ */ new Date()).toISOString();
  return {
    schemaVersion: WORKFLOW_FINALIZATION_SCHEMA_VERSION,
    kind: "workflow-finalization-transaction",
    status: "prepared",
    transactionId: request.plan.transactionId,
    runId: request.plan.runId,
    revision: request.plan.revision,
    resultingRevision: request.resultingRevision,
    sourceActionId: request.sourceActionId,
    execution: structuredClone(request.execution),
    plan: structuredClone(request.plan),
    operations,
    confirmation: structuredClone(request.confirmation),
    events: [],
    cleanup: {
      status: "pending",
      entries: cleanupEntriesForOperations(operations)
    },
    recovery: { status: "none", crashBoundaries: [] },
    createdAt: timestamp6,
    updatedAt: timestamp6
  };
}
function receiptRelativePath(receiptHash) {
  return `${WORKFLOW_FINALIZATION_RECEIPT_DIRECTORY}/${receiptHash}.json`;
}
function receiptReference(receipt) {
  return {
    schemaVersion: WORKFLOW_FINALIZATION_SCHEMA_VERSION,
    kind: "workflow-finalization-receipt-reference",
    receiptId: receipt.receiptId,
    receiptHash: receipt.receiptHash,
    transactionId: receipt.transactionId,
    planHash: receipt.planHash,
    runId: receipt.runId,
    revision: receipt.revision,
    resultingRevision: receipt.resultingRevision,
    status: receipt.recovery.status === "rolled-back" ? "rolled-back" : "committed"
  };
}
function workflowFinalizationReceiptReference(receipt) {
  return receiptReference(receipt);
}
function receiptOperation(operation2, status) {
  const precondition = operation2.precondition;
  const expectedPostState = operation2.expectedPostState;
  return {
    id: operation2.id,
    kind: operation2.kind,
    source: operation2.source,
    target: operation2.target,
    stagedPath: operation2.stagedPath,
    backupPath: operation2.backupPath,
    quarantinePath: operation2.quarantinePath,
    precondition: structuredClone(precondition),
    expectedPostState: structuredClone(expectedPostState),
    observedPostState: status === "committed" ? structuredClone(expectedPostState) : structuredClone(precondition),
    status
  };
}
function buildFinalizationReceipt(transaction, status) {
  const base = {
    schemaVersion: WORKFLOW_FINALIZATION_SCHEMA_VERSION,
    kind: "workflow-finalization-receipt",
    transactionId: transaction.transactionId,
    runId: transaction.runId,
    revision: transaction.revision,
    resultingRevision: transaction.resultingRevision,
    planHash: transaction.plan.planHash,
    execution: structuredClone(transaction.execution),
    contentSnapshotHash: transaction.plan.contentSnapshotHash,
    verificationReceiptIds: [...transaction.plan.verificationReceiptIds],
    confirmation: structuredClone(transaction.confirmation),
    operations: transaction.operations.map(
      (operation2) => receiptOperation(operation2, status)
    ),
    events: structuredClone(transaction.events),
    cleanup: structuredClone(transaction.cleanup),
    recovery: structuredClone(transaction.recovery),
    committedAt: transaction.createdAt
  };
  const receiptId2 = `workflow-finalization-receipt-${sha256(
    JSON.stringify(stableValue(base))
  ).slice(0, 24)}`;
  const withId = { ...base, receiptId: receiptId2 };
  const receiptHash = sha256(JSON.stringify(stableValue(withId)));
  return { ...withId, receiptHash };
}
async function publishReceipt(runRoot, profile, receipt) {
  const serialized = `${JSON.stringify(stableValue(receipt), null, 2)}
`;
  if (Buffer.byteLength(serialized, "utf8") > receiptMaxBytes(profile)) {
    throw new Error(
      "Workflow finalization receipt exceeds its configured bound"
    );
  }
  const relative = receiptRelativePath(receipt.receiptHash);
  const existing = await readOptionalEngineRunText(
    runRoot,
    relative,
    receiptMaxBytes(profile),
    "Workflow finalization receipt"
  );
  if (existing !== null) {
    const parsed = parseFinalizationReceipt(JSON.parse(existing));
    if (!sameStableValue2(parsed, receipt)) {
      throw new WorkflowFinalizationConflictError([relative]);
    }
    return;
  }
  try {
    await writeEngineRunText(
      runRoot,
      relative,
      serialized,
      receiptMaxBytes(profile),
      "Workflow finalization receipt",
      { exclusive: true, maxBytes: receiptMaxBytes(profile) }
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const raced = await readOptionalEngineRunText(
      runRoot,
      relative,
      receiptMaxBytes(profile),
      "Workflow finalization receipt"
    );
    if (raced === null || !sameStableValue2(parseFinalizationReceipt(JSON.parse(raced)), receipt)) {
      throw new WorkflowFinalizationConflictError([relative]);
    }
  }
}
async function completeFinalizationCleanup(runRoot, baseRoot, profile, transaction) {
  if (transaction.cleanup.status === "completed" && transaction.receipt?.cleanup.status === "completed") {
    for (const entry of transaction.cleanup.entries) {
      const current = await readMaterial(
        baseRoot,
        entry.path,
        contentMaxBytes(profile)
      );
      if (current.identity.exists) {
        throw new WorkflowFinalizationConflictError([entry.path]);
      }
    }
    return transaction.receipt;
  }
  if (!hasTransactionEvent(transaction, "cleanup-started", null, "before-cleanup")) {
    await appendTransactionEvent(
      runRoot,
      profile,
      transaction,
      "cleanup-started",
      { phase: "before-cleanup" },
      null
    );
  }
  for (const entry of transaction.cleanup.entries) {
    if (entry.status !== "pending") continue;
    const operation2 = transaction.operations.find(
      (candidate) => candidate.id === entry.operationId
    );
    if (!operation2) {
      throw new WorkflowFinalizationConflictError([entry.path]);
    }
    const beforeCleanup = {
      phase: "cleanup-item",
      operationId: entry.operationId,
      path: entry.path
    };
    if (!hasTransactionPathEvent(
      transaction,
      "cleanup-item",
      entry.operationId,
      "cleanup-item",
      entry.path
    )) {
      await appendTransactionEvent(
        runRoot,
        profile,
        transaction,
        "cleanup-item",
        beforeCleanup,
        entry.operationId
      );
    }
    let current;
    try {
      current = await readMaterial(
        baseRoot,
        entry.path,
        contentMaxBytes(profile)
      );
    } catch (error) {
      throw error;
    }
    if (!current.identity.exists) {
      if (!cleanupMissingIsExpected(transaction, entry)) {
        throw new WorkflowFinalizationConflictError([entry.path]);
      }
      entry.status = "missing";
    } else {
      if (!sameIdentity(current.identity, entry.expected)) {
        throw new WorkflowFinalizationConflictError([entry.path]);
      }
      await removeBaseFile(baseRoot, entry.path, async () => {
        const latest = await readMaterial(
          baseRoot,
          entry.path,
          contentMaxBytes(profile)
        );
        if (!sameIdentity(latest.identity, entry.expected)) {
          throw new WorkflowFinalizationConflictError([entry.path]);
        }
      });
      const verified = await readMaterial(
        baseRoot,
        entry.path,
        contentMaxBytes(profile)
      );
      if (verified.identity.exists) {
        throw new WorkflowFinalizationConflictError([entry.path]);
      }
      entry.status = "cleaned";
    }
    await appendTransactionEvent(
      runRoot,
      profile,
      transaction,
      "cleanup-item",
      { phase: "cleaned", operationId: entry.operationId, path: entry.path },
      entry.operationId
    );
  }
  for (const entry of transaction.cleanup.entries) {
    let current;
    try {
      current = await readMaterial(
        baseRoot,
        entry.path,
        contentMaxBytes(profile)
      );
    } catch (error) {
      throw error;
    }
    if (current.identity.exists) {
      throw new WorkflowFinalizationConflictError([entry.path]);
    }
  }
  if (!hasTransactionEvent(transaction, "cleanup-completed", null, "cleaned")) {
    await appendTransactionEvent(
      runRoot,
      profile,
      transaction,
      "cleanup-completed",
      { phase: "cleaned" },
      null
    );
  }
  transaction.cleanup.status = "completed";
  if (!hasTransactionEvent(transaction, "receipt-written", null, "cleaned")) {
    await appendTransactionEvent(
      runRoot,
      profile,
      transaction,
      "receipt-written",
      { phase: "cleaned" },
      null
    );
  }
  const receipt = buildFinalizationReceipt(
    transaction,
    transaction.status === "rolled-back" ? "rolled-back" : "committed"
  );
  await publishReceipt(runRoot, profile, receipt);
  transaction.receipt = receipt;
  await writeTransaction(runRoot, profile, transaction);
  return receipt;
}
async function readWorkflowFinalizationReceipt(runRoot, receiptHash, profile) {
  const hash4 = boundedHash2(receiptHash, "Workflow finalization receipt hash");
  const raw = await readOptionalEngineRunText(
    runRoot,
    receiptRelativePath(hash4),
    receiptMaxBytes(profile),
    "Workflow finalization receipt"
  );
  if (raw === null) return null;
  try {
    const receipt = parseFinalizationReceipt(JSON.parse(raw));
    if (receipt.receiptHash !== hash4) {
      throw new Error(
        "Workflow finalization receipt hash does not match its path"
      );
    }
    if (Buffer.byteLength(raw, "utf8") > receiptMaxBytes(profile)) {
      throw new Error(
        "Workflow finalization receipt exceeds its configured bound"
      );
    }
    return receipt;
  } catch (error) {
    throw new Error("Workflow finalization receipt is malformed", {
      cause: error
    });
  }
}
async function createOperationMaterials(request) {
  const operations = await createTransactionOperations(request);
  if (operations.length > profileBound(request.profile, "finalizationOperationCount")) {
    throw new Error(
      "Workflow finalization operation count exceeds its configured bound"
    );
  }
  return operations;
}
function transactionAffectedPaths(transaction) {
  return uniqueStrings(
    transaction.operations.flatMap((operation2) => [
      operation2.target,
      ...operation2.source ? [operation2.source] : [],
      ...operation2.stagedPath ? [operation2.stagedPath] : [],
      ...operation2.backupPath ? [operation2.backupPath] : [],
      ...operation2.quarantinePath ? [operation2.quarantinePath] : []
    ])
  );
}
function recoveryBlocked(transaction, error) {
  if (error instanceof WorkflowFinalizationInjectedFaultError || error instanceof Error && error.message === "deterministic workflow finalization fault") {
    throw error;
  }
  if (error instanceof WorkflowFinalizationConflictError) {
    return {
      status: "blocked",
      transaction,
      unknownPaths: [...error.paths]
    };
  }
  if (error instanceof Error && (error.code === "ENOENT" || error.code === "ENOTDIR" || /crosses a symbolic link|must be a real (?:file|directory|any)|not a regular file|not valid UTF-8|resolves outside the project root/u.test(
    error.message
  ))) {
    return {
      status: "blocked",
      transaction,
      unknownPaths: transactionAffectedPaths(transaction)
    };
  }
  throw error;
}
async function applyTransaction(runRoot, baseRoot, profile, transaction, recovery) {
  if (transaction.status === "prepared") {
    transaction.status = "applying";
    await appendTransactionEvent(
      runRoot,
      profile,
      transaction,
      "applying",
      { phase: "applying" },
      null
    );
  }
  for (const operation2 of transaction.operations) {
    await applyTransactionOperation(
      runRoot,
      baseRoot,
      profile,
      transaction,
      operation2,
      recovery
    );
  }
}
async function commitTransaction(runRoot, baseRoot, profile, transaction) {
  if (transaction.status === "rolled-back") {
    if (!transaction.receipt) {
      throw new Error("Workflow finalization rollback receipt is missing");
    }
    return transaction.receipt;
  }
  if (transaction.status !== "committed") {
    const current = await Promise.all(
      transaction.operations.map(
        (operation2) => currentOperation(baseRoot, operation2, profile)
      )
    );
    if (current.some(
      (material, index) => !operationMatches(
        material,
        transaction.operations[index].expectedPostState
      )
    )) {
      throw new WorkflowFinalizationConflictError(
        transaction.operations.flatMap((operation2) => [
          operation2.target,
          ...operation2.source ? [operation2.source] : []
        ])
      );
    }
    await appendTransactionEvent(
      runRoot,
      profile,
      transaction,
      "committing",
      { phase: "committing" },
      null
    );
    await appendTransactionEvent(
      runRoot,
      profile,
      transaction,
      "committing",
      { phase: "before-receipt" },
      null
    );
    const receipt = transaction.recovery.status === "recovered" ? buildFinalizationReceipt(transaction, "committed") : transaction.receipt ?? buildFinalizationReceipt(transaction, "committed");
    await publishReceipt(runRoot, profile, receipt);
    transaction.receipt = receipt;
    await appendTransactionEvent(
      runRoot,
      profile,
      transaction,
      "receipt-written",
      { phase: "receipt-written" },
      null
    );
    transaction.status = "committed";
    await appendTransactionEvent(
      runRoot,
      profile,
      transaction,
      "committed",
      { phase: "committed" },
      null
    );
  }
  if (!transaction.receipt) {
    throw new Error(
      "Workflow finalization committed transaction has no receipt"
    );
  }
  return transaction.receipt;
}
function validateApplyRequest(request) {
  const plan = parseWorkflowFinalizationPreview(request.plan);
  if (request.sourceActionId.length === 0) {
    throw new WorkflowFinalizationConflictError(["sourceActionId"]);
  }
  if (!sameStableValue2(plan.execution, request.execution)) {
    throw new WorkflowFinalizationConflictError(["execution"]);
  }
  if (plan.actionId !== request.sourceActionId) {
    throw new WorkflowFinalizationConflictError(["actionId"]);
  }
  if (!plan.requiresConfirmation || !request.confirmation) {
    throw new WorkflowFinalizationConflictError(["confirmation"]);
  }
  const expectedResultingRevision = request.confirmation.revision + 1;
  if (request.resultingRevision !== expectedResultingRevision) {
    throw new WorkflowFinalizationConflictError(["resultingRevision"]);
  }
  if (request.confirmation.planHash !== plan.planHash || request.confirmation.revision !== plan.revision + 1 || request.confirmation.sourceActionId !== request.sourceActionId) {
    throw new WorkflowFinalizationConflictError(["confirmation"]);
  }
  return plan;
}
async function applyWorkflowFinalization(request) {
  const plan = validateApplyRequest(request);
  const normalizedDefinition = normalizeWorkflowFinalizationDefinition(
    request.definition
  );
  validateWorkflowFinalizationPlanDeclaration(plan, normalizedDefinition);
  const existing = await readWorkflowFinalizationTransaction(
    request.runRoot,
    request.profile
  );
  if (existing) {
    if (!transactionMatchesRequest(existing, { ...request, plan })) {
      throw new WorkflowFinalizationTransactionPendingError(existing);
    }
    if (existing.status === "committed") {
      if (!existing.receipt)
        throw new Error("Workflow finalization receipt is missing");
      const receipt2 = await completeFinalizationCleanup(
        request.runRoot,
        request.baseRoot,
        request.profile,
        existing
      );
      return {
        status: "committed",
        transaction: existing,
        receipt: receipt2
      };
    }
    if (existing.status === "rolled-back") {
      if (!existing.receipt)
        throw new Error("Workflow finalization rollback receipt is missing");
      const receipt2 = await completeFinalizationCleanup(
        request.runRoot,
        request.baseRoot,
        request.profile,
        existing
      );
      return {
        status: "rolled-back",
        transaction: existing,
        receipt: receipt2
      };
    }
    throw new WorkflowFinalizationTransactionPendingError(existing);
  }
  const operations = await createOperationMaterials({ ...request, plan });
  const transaction = newTransaction(
    {
      ...request,
      plan: structuredClone(plan),
      definition: normalizedDefinition
    },
    operations
  );
  await appendTransactionEvent(
    request.runRoot,
    request.profile,
    transaction,
    "prepared",
    { phase: "prepared" },
    null
  );
  await applyTransaction(
    request.runRoot,
    request.baseRoot,
    request.profile,
    transaction,
    false
  );
  await commitTransaction(
    request.runRoot,
    request.baseRoot,
    request.profile,
    transaction
  );
  const receipt = await completeFinalizationCleanup(
    request.runRoot,
    request.baseRoot,
    request.profile,
    transaction
  );
  return { status: "committed", transaction, receipt };
}
async function recoverWorkflowFinalization(options) {
  const transaction = await readWorkflowFinalizationTransaction(
    options.runRoot,
    options.profile
  );
  if (!transaction) return { status: "none" };
  if (options.definition) {
    validateWorkflowFinalizationPlanDeclaration(
      transaction.plan,
      options.definition
    );
  }
  if (options.runId !== void 0 && transaction.runId !== options.runId) {
    throw new WorkflowFinalizationConflictError(["runId"]);
  }
  if (options.execution !== void 0 && !sameStableValue2(transaction.execution, options.execution)) {
    throw new WorkflowFinalizationConflictError(["execution"]);
  }
  if (transaction.status === "committed") {
    if (!transaction.receipt)
      throw new Error("Workflow finalization committed receipt is missing");
    let current;
    try {
      current = await Promise.all(
        transaction.operations.map(
          (operation2) => currentOperation(options.baseRoot, operation2, options.profile)
        )
      );
    } catch (error) {
      return recoveryBlocked(transaction, error);
    }
    const unknown = current.flatMap(
      (material, index) => operationMatches(
        material,
        transaction.operations[index].expectedPostState
      ) ? [] : [
        transaction.operations[index].target,
        ...transaction.operations[index].source ? [transaction.operations[index].source] : []
      ]
    );
    if (unknown.length > 0) {
      return {
        status: "blocked",
        transaction,
        unknownPaths: uniqueStrings(unknown)
      };
    }
    try {
      if (transaction.cleanup.status !== "completed" || transaction.receipt.cleanup.status !== "completed") {
        transaction.recovery = {
          status: "recovered",
          crashBoundaries: uniqueStrings(
            transaction.events.map((event) => event.boundary)
          )
        };
        await writeTransaction(options.runRoot, options.profile, transaction);
      }
      const receipt = await completeFinalizationCleanup(
        options.runRoot,
        options.baseRoot,
        options.profile,
        transaction
      );
      return { status: "recovered", transaction, receipt };
    } catch (error) {
      return recoveryBlocked(transaction, error);
    }
  }
  if (transaction.status === "rolling-back") {
    return rollbackWorkflowFinalization(options);
  }
  if (transaction.status === "rolled-back") {
    try {
      const receipt = await completeFinalizationCleanup(
        options.runRoot,
        options.baseRoot,
        options.profile,
        transaction
      );
      return { status: "rolled-back", transaction, receipt };
    } catch (error) {
      return recoveryBlocked(transaction, error);
    }
  }
  transaction.recovery = {
    status: "recovered",
    crashBoundaries: uniqueStrings(
      transaction.events.map((event) => event.boundary)
    )
  };
  try {
    await applyTransaction(
      options.runRoot,
      options.baseRoot,
      options.profile,
      transaction,
      true
    );
    await commitTransaction(
      options.runRoot,
      options.baseRoot,
      options.profile,
      transaction
    );
    const receipt = await completeFinalizationCleanup(
      options.runRoot,
      options.baseRoot,
      options.profile,
      transaction
    );
    return { status: "recovered", transaction, receipt };
  } catch (error) {
    return recoveryBlocked(transaction, error);
  }
}
async function restoreContent(root, relative, content, expectedCurrent, profile) {
  const verifyCurrent = async () => {
    const current = await readMaterial(
      root,
      relative,
      contentMaxBytes(profile)
    );
    if (!sameIdentity(current.identity, expectedCurrent)) {
      throw new WorkflowFinalizationConflictError([relative]);
    }
  };
  if (content === null) {
    await removeBaseFile(root, relative, verifyCurrent);
    return;
  }
  await writeBaseText(
    root,
    relative,
    content,
    contentMaxBytes(profile),
    verifyCurrent
  );
}
function cleanupMissingIsExpectedFor(operations, events, entry) {
  const operation2 = operations.find(
    (candidate) => candidate.id === entry.operationId
  );
  if (!operation2) return false;
  if (operation2.status === "rolled-back" && events.some(
    (event) => event.type === "operation-rolled-back" && event.operationId === operation2.id && event.boundary.startsWith("rollback-verified")
  )) {
    return true;
  }
  if (entry.role === "staged" && operation2.kind === "write" && events.some(
    (event) => event.type === "operation-published" && event.operationId === operation2.id && event.boundary.startsWith("target-published")
  )) {
    return true;
  }
  return entry.role === "quarantine" && operation2.kind === "move" && events.some(
    (event) => event.type === "operation-published" && event.operationId === operation2.id && event.boundary.startsWith("target-published")
  );
}
function cleanupMissingIsExpected(transaction, entry) {
  return cleanupMissingIsExpectedFor(
    transaction.operations,
    transaction.events,
    entry
  );
}
async function rollbackTransactionOperation(baseRoot, operation2, actual, profile) {
  if (operation2.kind === "write") {
    if (operationMatches(actual, operation2.precondition)) return;
    await restoreContent(
      baseRoot,
      operation2.target,
      operation2.previousTargetContent,
      actual.target.identity,
      profile
    );
    return;
  }
  if (operation2.kind === "remove") {
    if (!operation2.precondition.target.exists) return;
    if (!operation2.quarantinePath || actual.target.identity.exists) {
      if (!actual.target.identity.exists) {
        throw new WorkflowFinalizationConflictError([
          operation2.target,
          ...operation2.quarantinePath ? [operation2.quarantinePath] : []
        ]);
      }
      return;
    }
    const moved = await moveBaseFile(
      baseRoot,
      operation2.quarantinePath,
      operation2.target,
      async () => {
        const current = await currentOperation(baseRoot, operation2, profile);
        if (current.target.identity.exists || !current.quarantine?.identity.exists || !sameIdentity(
          current.quarantine.identity,
          materialIdentity(operation2.previousTargetContent)
        )) {
          throw new WorkflowFinalizationConflictError(
            operationConflictPaths(operation2, current)
          );
        }
      },
      async () => {
        const current = await currentOperation(baseRoot, operation2, profile);
        if (!sameIdentity(
          current.target.identity,
          operationTargetExpected(operation2)
        ) || !storageMatchesContent(
          current,
          "quarantine",
          operation2.previousTargetContent
        )) {
          throw new WorkflowFinalizationConflictError(
            operationConflictPaths(operation2, current)
          );
        }
      }
    );
    if (!moved) {
      throw new WorkflowFinalizationConflictError([
        operation2.quarantinePath,
        operation2.target
      ]);
    }
    return;
  }
  if (!operation2.source || !actual.source) {
    throw new WorkflowFinalizationConflictError([operation2.target]);
  }
  const sourcePre = sameIdentity(
    actual.source.identity,
    operationSourceExpected(operation2)
  );
  const sourcePost = sameIdentity(
    actual.source.identity,
    operationPostSourceExpected(operation2)
  );
  const targetPre = sameIdentity(
    actual.target.identity,
    operationTargetExpected(operation2)
  );
  const targetPost = sameIdentity(
    actual.target.identity,
    operationPostTargetExpected(operation2)
  );
  if (sourcePre && targetPre) return;
  if (sourcePost && targetPre) {
    if (!operation2.quarantinePath) {
      throw new WorkflowFinalizationConflictError([
        operation2.source,
        operation2.target
      ]);
    }
    const moved = await moveBaseFile(
      baseRoot,
      operation2.quarantinePath,
      operation2.source,
      async () => {
        const current = await currentOperation(baseRoot, operation2, profile);
        if (current.source?.identity.exists || !sameIdentity(
          current.target.identity,
          operationTargetExpected(operation2)
        ) || !current.quarantine?.identity.exists) {
          throw new WorkflowFinalizationConflictError(
            operationConflictPaths(operation2, current)
          );
        }
      },
      async () => {
        const current = await currentOperation(baseRoot, operation2, profile);
        if (!current.source || !sameIdentity(
          current.source.identity,
          operationSourceExpected(operation2)
        ) || !sameIdentity(
          current.target.identity,
          operationTargetExpected(operation2)
        ) || !storageMatchesContent(
          current,
          "quarantine",
          operation2.previousSourceContent
        )) {
          throw new WorkflowFinalizationConflictError(
            operationConflictPaths(operation2, current)
          );
        }
      }
    );
    if (!moved) {
      throw new WorkflowFinalizationConflictError([
        operation2.quarantinePath,
        operation2.source
      ]);
    }
    return;
  }
  if (sourcePost && targetPost) {
    const moved = await moveBaseFile(
      baseRoot,
      operation2.target,
      operation2.source,
      async () => {
        const current = await currentOperation(baseRoot, operation2, profile);
        if (current.source?.identity.exists || !sameIdentity(
          current.target.identity,
          operationPostTargetExpected(operation2)
        )) {
          throw new WorkflowFinalizationConflictError(
            operationConflictPaths(operation2, current)
          );
        }
      },
      async () => {
        const current = await currentOperation(baseRoot, operation2, profile);
        if (!current.source || !sameIdentity(
          current.source.identity,
          operationSourceExpected(operation2)
        ) || !sameIdentity(
          current.target.identity,
          operationPostTargetExpected(operation2)
        )) {
          throw new WorkflowFinalizationConflictError(
            operationConflictPaths(operation2, current)
          );
        }
      }
    );
    if (!moved) {
      throw new WorkflowFinalizationConflictError([
        operation2.target,
        operation2.source
      ]);
    }
    if (operation2.precondition.target.exists) {
      if (!operation2.backupPath) {
        throw new WorkflowFinalizationConflictError([operation2.target]);
      }
      const restored = await moveBaseFile(
        baseRoot,
        operation2.backupPath,
        operation2.target,
        async () => {
          const current = await currentOperation(baseRoot, operation2, profile);
          if (current.target.identity.exists || !current.backup?.identity.exists || !current.source?.identity.exists) {
            throw new WorkflowFinalizationConflictError(
              operationConflictPaths(operation2, current)
            );
          }
        },
        async () => {
          const current = await currentOperation(baseRoot, operation2, profile);
          if (!current.source || !sameIdentity(
            current.source.identity,
            operationSourceExpected(operation2)
          ) || !sameIdentity(
            current.target.identity,
            operationTargetExpected(operation2)
          ) || !storageMatchesContent(
            current,
            "backup",
            operation2.previousTargetContent
          )) {
            throw new WorkflowFinalizationConflictError(
              operationConflictPaths(operation2, current)
            );
          }
        }
      );
      if (!restored) {
        throw new WorkflowFinalizationConflictError([
          operation2.backupPath,
          operation2.target
        ]);
      }
    }
    return;
  }
  if (sourcePre && targetPost) {
    throw new WorkflowFinalizationConflictError([
      operation2.source,
      operation2.target
    ]);
  }
  throw new WorkflowFinalizationConflictError([
    operation2.source,
    operation2.target
  ]);
}
async function rollbackWorkflowFinalization(options) {
  const transaction = await readWorkflowFinalizationTransaction(
    options.runRoot,
    options.profile
  );
  if (!transaction) return { status: "none" };
  if (options.definition) {
    validateWorkflowFinalizationPlanDeclaration(
      transaction.plan,
      options.definition
    );
  }
  if (options.runId !== void 0 && transaction.runId !== options.runId) {
    throw new WorkflowFinalizationConflictError(["runId"]);
  }
  if (options.execution !== void 0 && !sameStableValue2(transaction.execution, options.execution)) {
    throw new WorkflowFinalizationConflictError(["execution"]);
  }
  if (transaction.status === "rolled-back") {
    const receipt = await completeFinalizationCleanup(
      options.runRoot,
      options.baseRoot,
      options.profile,
      transaction
    );
    return { status: "rolled-back", transaction, receipt };
  }
  if (transaction.status === "committed") {
    return {
      status: "blocked",
      transaction,
      unknownPaths: [WORKFLOW_FINALIZATION_TRANSACTION_PATH]
    };
  }
  transaction.status = "rolling-back";
  await appendTransactionEvent(
    options.runRoot,
    options.profile,
    transaction,
    "rolling-back",
    { phase: "rolling-back" },
    null
  );
  for (const operation2 of [...transaction.operations].reverse()) {
    try {
      const actual = await currentOperation(
        options.baseRoot,
        operation2,
        options.profile
      );
      if (!operationCanResume(operation2, actual)) {
        return {
          status: "blocked",
          transaction,
          unknownPaths: operationConflictPaths(operation2, actual)
        };
      }
      if (operation2.status === "rolled-back" && operationMatches(actual, operation2.precondition)) {
        continue;
      }
      if (!hasTransactionEvent(
        transaction,
        "operation-rolled-back",
        operation2.id,
        "before-rollback-operation"
      )) {
        await appendTransactionEvent(
          options.runRoot,
          options.profile,
          transaction,
          "operation-rolled-back",
          {
            phase: "before-rollback-operation",
            operationId: operation2.id,
            path: operation2.target
          },
          operation2.id
        );
      }
      await rollbackTransactionOperation(
        options.baseRoot,
        operation2,
        actual,
        options.profile
      );
      const verified = await currentOperation(
        options.baseRoot,
        operation2,
        options.profile
      );
      if (!operationMatches(verified, operation2.precondition)) {
        throw new WorkflowFinalizationConflictError([
          operation2.target,
          ...operation2.source ? [operation2.source] : []
        ]);
      }
      operation2.status = "rolled-back";
      await appendTransactionEvent(
        options.runRoot,
        options.profile,
        transaction,
        "operation-rolled-back",
        {
          phase: "rollback-verified",
          operationId: operation2.id,
          path: operation2.target
        },
        operation2.id
      );
      await appendTransactionEvent(
        options.runRoot,
        options.profile,
        transaction,
        "operation-rolled-back",
        {
          phase: "rolled-back",
          operationId: operation2.id,
          path: operation2.target
        },
        operation2.id
      );
    } catch (error) {
      return recoveryBlocked(transaction, error);
    }
  }
  transaction.recovery = {
    status: "rolled-back",
    crashBoundaries: uniqueStrings(
      transaction.events.map((event) => event.boundary)
    )
  };
  try {
    await appendTransactionEvent(
      options.runRoot,
      options.profile,
      transaction,
      "rolling-back",
      { phase: "before-receipt" },
      null
    );
    const receipt = buildFinalizationReceipt(transaction, "rolled-back");
    await publishReceipt(options.runRoot, options.profile, receipt);
    transaction.receipt = receipt;
    transaction.status = "rolled-back";
    await appendTransactionEvent(
      options.runRoot,
      options.profile,
      transaction,
      "rolled-back",
      { phase: "rolled-back" },
      null
    );
    const finalReceipt = await completeFinalizationCleanup(
      options.runRoot,
      options.baseRoot,
      options.profile,
      transaction
    );
    return {
      status: "rolled-back",
      transaction,
      receipt: finalReceipt
    };
  } catch (error) {
    return recoveryBlocked(transaction, error);
  }
}
async function clearWorkflowFinalizationTransaction(runRoot, profile, baseRoot) {
  const transaction = await readWorkflowFinalizationTransaction(
    runRoot,
    profile
  );
  if (!transaction) return false;
  if (transaction.status !== "committed" && transaction.status !== "rolled-back" || !transaction.receipt) {
    throw new WorkflowFinalizationTransactionPendingError(transaction);
  }
  const receipt = transaction.receipt;
  if (baseRoot) {
    await completeFinalizationCleanup(runRoot, baseRoot, profile, transaction);
  }
  if (transaction.cleanup.status !== "completed" || transaction.receipt.cleanup.status !== "completed") {
    throw new WorkflowFinalizationTransactionPendingError(transaction);
  }
  const removed = await removeEngineRunFile(
    runRoot,
    WORKFLOW_FINALIZATION_TRANSACTION_PATH,
    "Workflow finalization transaction",
    {
      beforeRemove: async () => {
        const current = await readWorkflowFinalizationTransaction(
          runRoot,
          profile
        );
        if (!current || current.transactionId !== transaction.transactionId || current.status !== transaction.status || !current.receipt || current.receipt.receiptHash !== receipt.receiptHash) {
          throw new WorkflowFinalizationConflictError([
            WORKFLOW_FINALIZATION_TRANSACTION_PATH
          ]);
        }
      }
    }
  );
  if (removed) await invokeFault({ phase: "cleared" });
  return removed;
}
async function ensureContentFile(root, relative, content, profile) {
  const expected = materialIdentity(content);
  const current = await readMaterial(root, relative, contentMaxBytes(profile));
  if (sameIdentity(current.identity, expected)) return;
  if (current.identity.exists) {
    throw new WorkflowFinalizationConflictError([relative]);
  }
  await writeBaseText(root, relative, content, contentMaxBytes(profile));
  const verified = await readMaterial(root, relative, contentMaxBytes(profile));
  if (!sameIdentity(verified.identity, expected)) {
    throw new WorkflowFinalizationConflictError([relative]);
  }
}
async function currentOperation(root, operation2, profile) {
  return operationMaterial(root, operation2, contentMaxBytes(profile));
}
function operationCanResume(operation2, actual, allowDurableContent = false) {
  return operationStorageUnknownPaths(operation2, actual).length === 0 && operationProgress(operation2, actual) !== null && operationStorageMissingRequiredPaths(operation2, actual, allowDurableContent).length === 0;
}
function operationStorageMissingRequiredPaths(operation2, actual, allowDurableContent = false) {
  const missing = [];
  const has = (role) => actual[role]?.identity.exists === true;
  const progress = operationProgress(operation2, actual);
  if (operation2.kind === "write" && progress === "post" && operation2.precondition.target.exists && !has("backup")) {
    if (operation2.backupPath) missing.push(operation2.backupPath);
  }
  if (operation2.kind === "remove" && progress === "post" && operation2.precondition.target.exists && !has("quarantine")) {
    if (operation2.quarantinePath) missing.push(operation2.quarantinePath);
  }
  if (operation2.kind === "move" && progress === "source-quarantined" && !allowDurableContent && !has("quarantine")) {
    if (operation2.quarantinePath) missing.push(operation2.quarantinePath);
  }
  if (operation2.kind === "move" && progress === "post" && operation2.precondition.target.exists && !has("backup")) {
    if (operation2.backupPath) missing.push(operation2.backupPath);
  }
  return missing;
}
function operationConflictPaths(operation2, actual) {
  return uniqueStrings([
    ...operationStorageUnknownPaths(operation2, actual),
    ...operationStorageMissingRequiredPaths(operation2, actual),
    operation2.target,
    ...operation2.source ? [operation2.source] : []
  ]);
}
function hasTransactionEvent(transaction, type, operationId, boundary) {
  return transaction.events.some(
    (event) => event.type === type && event.operationId === operationId && event.boundary.startsWith(boundary)
  );
}
function hasTransactionPathEvent(transaction, type, operationId, phase, relativePath2) {
  return transaction.events.some(
    (event) => event.type === type && event.operationId === operationId && event.boundary === `${phase}:${relativePath2}`
  );
}
async function readValidatedOperation(baseRoot, operation2, profile) {
  const actual = await currentOperation(baseRoot, operation2, profile);
  if (!operationCanResume(operation2, actual)) {
    throw new WorkflowFinalizationConflictError(
      operationConflictPaths(operation2, actual)
    );
  }
  return actual;
}
async function appendOperationEvent(runRoot, profile, transaction, operation2, type, phase, path18) {
  await appendTransactionEvent(
    runRoot,
    profile,
    transaction,
    type,
    { phase, operationId: operation2.id, path: path18 },
    operation2.id
  );
}
async function applyTransactionOperation(runRoot, baseRoot, profile, transaction, operation2, recovery) {
  let actual = await readValidatedOperation(baseRoot, operation2, profile);
  let progress = operationProgress(operation2, actual);
  if (progress === null) {
    throw new WorkflowFinalizationConflictError(
      operationConflictPaths(operation2, actual)
    );
  }
  if (progress === "post") {
    operation2.status = "verified";
  } else if (operation2.status === "pending" || operation2.status === "applying") {
    if (!hasTransactionEvent(
      transaction,
      "operation-staged",
      operation2.id,
      "before-staging"
    )) {
      await appendOperationEvent(
        runRoot,
        profile,
        transaction,
        operation2,
        "operation-staged",
        "before-staging",
        operation2.target
      );
    }
    if (operation2.previousTargetContent !== null && operation2.backupPath) {
      await ensureContentFile(
        baseRoot,
        operation2.backupPath,
        operation2.previousTargetContent,
        profile
      );
    }
    if (operation2.content !== null && operation2.stagedPath) {
      await ensureContentFile(
        baseRoot,
        operation2.stagedPath,
        operation2.content,
        profile
      );
    }
    operation2.status = "staged";
    if (!hasTransactionEvent(
      transaction,
      "operation-staged",
      operation2.id,
      "staged"
    )) {
      await appendOperationEvent(
        runRoot,
        profile,
        transaction,
        operation2,
        "operation-staged",
        "staged",
        operation2.target
      );
    }
    actual = await readValidatedOperation(baseRoot, operation2, profile);
    progress = operationProgress(operation2, actual);
  }
  if (!hasTransactionEvent(
    transaction,
    "operation-started",
    operation2.id,
    "before-operation"
  )) {
    await appendOperationEvent(
      runRoot,
      profile,
      transaction,
      operation2,
      "operation-started",
      "before-operation",
      operation2.target
    );
  }
  actual = await readValidatedOperation(baseRoot, operation2, profile);
  progress = operationProgress(operation2, actual);
  if (progress === null) {
    throw new WorkflowFinalizationConflictError(
      operationConflictPaths(operation2, actual)
    );
  }
  if (operation2.kind === "write" && progress !== "post") {
    if (operation2.content === null || !operation2.stagedPath) {
      throw new Error("Workflow finalization write staging is missing");
    }
    if (!sameIdentity(
      actual.target.identity,
      operationPostTargetExpected(operation2)
    )) {
      if (!hasTransactionEvent(
        transaction,
        "operation-quarantined",
        operation2.id,
        "before-target-removal"
      )) {
        await appendOperationEvent(
          runRoot,
          profile,
          transaction,
          operation2,
          "operation-quarantined",
          "before-target-removal",
          operation2.target
        );
      }
      await removeBaseFile(baseRoot, operation2.target, async () => {
        const current = await currentOperation(baseRoot, operation2, profile);
        if (!operationMatches(current, operation2.precondition) || !current.staged?.identity.exists || operation2.backupPath && operation2.precondition.target.exists && !current.backup?.identity.exists) {
          throw new WorkflowFinalizationConflictError(
            operationConflictPaths(operation2, current)
          );
        }
      });
      if (!hasTransactionEvent(
        transaction,
        "operation-quarantined",
        operation2.id,
        "target-removed"
      )) {
        await appendOperationEvent(
          runRoot,
          profile,
          transaction,
          operation2,
          "operation-quarantined",
          "target-removed",
          operation2.target
        );
      }
      actual = await readValidatedOperation(baseRoot, operation2, profile);
    }
    actual = await readValidatedOperation(baseRoot, operation2, profile);
    if (!actual.target.identity.exists && actual.staged?.identity.exists) {
      if (!hasTransactionEvent(
        transaction,
        "operation-published",
        operation2.id,
        "before-target-publication"
      )) {
        await appendOperationEvent(
          runRoot,
          profile,
          transaction,
          operation2,
          "operation-published",
          "before-target-publication",
          operation2.target
        );
      }
      const moved = await moveBaseFile(
        baseRoot,
        operation2.stagedPath,
        operation2.target,
        async () => {
          const current = await currentOperation(baseRoot, operation2, profile);
          if (current.target.identity.exists || !current.staged?.identity.exists || operation2.backupPath && operation2.precondition.target.exists && !current.backup?.identity.exists) {
            throw new WorkflowFinalizationConflictError(
              operationConflictPaths(operation2, current)
            );
          }
        },
        async () => {
          const current = await currentOperation(baseRoot, operation2, profile);
          if (!sameIdentity(
            current.target.identity,
            operationPostTargetExpected(operation2)
          ) || !storageMatchesContent(current, "staged", operation2.content) || operation2.backupPath && operation2.precondition.target.exists && !storageMatchesContent(
            current,
            "backup",
            operation2.previousTargetContent
          )) {
            throw new WorkflowFinalizationConflictError(
              operationConflictPaths(operation2, current)
            );
          }
        }
      );
      if (!moved) {
        throw new WorkflowFinalizationConflictError([
          operation2.stagedPath,
          operation2.target
        ]);
      }
      operation2.status = "target-published";
      await appendOperationEvent(
        runRoot,
        profile,
        transaction,
        operation2,
        "operation-published",
        "target-published",
        operation2.target
      );
    }
  } else if (operation2.kind === "remove" && progress !== "post") {
    if (operation2.precondition.target.exists) {
      if (!operation2.quarantinePath) {
        throw new Error("Workflow finalization remove quarantine is missing");
      }
      actual = await currentOperation(baseRoot, operation2, profile);
      if (!actual.quarantine?.identity.exists) {
        if (!hasTransactionEvent(
          transaction,
          "operation-quarantined",
          operation2.id,
          "before-quarantine"
        )) {
          await appendOperationEvent(
            runRoot,
            profile,
            transaction,
            operation2,
            "operation-quarantined",
            "before-quarantine",
            operation2.target
          );
        }
        const moved = await moveBaseFile(
          baseRoot,
          operation2.target,
          operation2.quarantinePath,
          async () => {
            const current = await currentOperation(
              baseRoot,
              operation2,
              profile
            );
            if (!operationMatches(current, operation2.precondition) || current.quarantine?.identity.exists) {
              throw new WorkflowFinalizationConflictError(
                operationConflictPaths(operation2, current)
              );
            }
          },
          async () => {
            const current = await currentOperation(
              baseRoot,
              operation2,
              profile
            );
            if (!operationMatches(current, operation2.precondition) || !storageMatchesContent(
              current,
              "quarantine",
              operation2.previousTargetContent
            )) {
              throw new WorkflowFinalizationConflictError(
                operationConflictPaths(operation2, current)
              );
            }
          }
        );
        if (!moved) {
          throw new WorkflowFinalizationConflictError([
            operation2.target,
            operation2.quarantinePath
          ]);
        }
      } else {
        await removeBaseFile(baseRoot, operation2.target, async () => {
          const current = await currentOperation(baseRoot, operation2, profile);
          if (!operationMatches(current, operation2.precondition) || !current.quarantine?.identity.exists) {
            throw new WorkflowFinalizationConflictError(
              operationConflictPaths(operation2, current)
            );
          }
        });
      }
      operation2.status = "target-quarantined";
      if (!hasTransactionEvent(
        transaction,
        "operation-quarantined",
        operation2.id,
        "quarantined"
      )) {
        await appendOperationEvent(
          runRoot,
          profile,
          transaction,
          operation2,
          "operation-quarantined",
          "quarantined",
          operation2.target
        );
      }
    }
  } else if (operation2.kind === "move" && progress !== "post") {
    if (operation2.content === null || !operation2.source || !operation2.quarantinePath) {
      throw new Error("Workflow finalization move quarantine is missing");
    }
    actual = await currentOperation(baseRoot, operation2, profile);
    progress = operationProgress(operation2, actual);
    if (progress === "previous") {
      if (actual.quarantine?.identity.exists) {
        await removeBaseFile(baseRoot, operation2.quarantinePath, async () => {
          const current = await currentOperation(baseRoot, operation2, profile);
          if (!current.quarantine?.identity.exists || !sameIdentity(
            current.quarantine.identity,
            materialIdentity(operation2.previousSourceContent)
          )) {
            throw new WorkflowFinalizationConflictError(
              operationConflictPaths(operation2, current)
            );
          }
        });
      }
      if (!hasTransactionEvent(
        transaction,
        "operation-quarantined",
        operation2.id,
        "before-source-removal"
      )) {
        await appendOperationEvent(
          runRoot,
          profile,
          transaction,
          operation2,
          "operation-quarantined",
          "before-source-removal",
          operation2.source
        );
      }
      const moved = await moveBaseFile(
        baseRoot,
        operation2.source,
        operation2.quarantinePath,
        async () => {
          const current = await currentOperation(baseRoot, operation2, profile);
          if (!operationMatches(current, operation2.precondition) || current.quarantine?.identity.exists) {
            throw new WorkflowFinalizationConflictError(
              operationConflictPaths(operation2, current)
            );
          }
        },
        async () => {
          const current = await currentOperation(baseRoot, operation2, profile);
          if (!operationMatches(current, operation2.precondition) || !storageMatchesContent(
            current,
            "quarantine",
            operation2.previousSourceContent
          )) {
            throw new WorkflowFinalizationConflictError(
              operationConflictPaths(operation2, current)
            );
          }
        }
      );
      if (!moved) {
        throw new WorkflowFinalizationConflictError([
          operation2.source,
          operation2.quarantinePath
        ]);
      }
      operation2.status = "source-quarantined";
      await appendOperationEvent(
        runRoot,
        profile,
        transaction,
        operation2,
        "operation-quarantined",
        "source-removed",
        operation2.source
      );
    }
    actual = await currentOperation(baseRoot, operation2, profile);
    progress = operationProgress(operation2, actual);
    if (progress === "source-quarantined") {
      if (actual.target.identity.exists) {
        if (!hasTransactionEvent(
          transaction,
          "operation-quarantined",
          operation2.id,
          "before-target-removal"
        )) {
          await appendOperationEvent(
            runRoot,
            profile,
            transaction,
            operation2,
            "operation-quarantined",
            "before-target-removal",
            operation2.target
          );
        }
        await removeBaseFile(baseRoot, operation2.target, async () => {
          const current = await currentOperation(baseRoot, operation2, profile);
          if (!current.source || !sameIdentity(
            current.source.identity,
            operationPostSourceExpected(operation2)
          ) || !sameIdentity(
            current.target.identity,
            operationTargetExpected(operation2)
          ) || !current.quarantine?.identity.exists || !operation2.precondition.target.exists || !current.backup?.identity.exists) {
            throw new WorkflowFinalizationConflictError(
              operationConflictPaths(operation2, current)
            );
          }
        });
        await appendOperationEvent(
          runRoot,
          profile,
          transaction,
          operation2,
          "operation-quarantined",
          "target-removed",
          operation2.target
        );
        actual = await currentOperation(baseRoot, operation2, profile);
      }
      if (!hasTransactionEvent(
        transaction,
        "operation-published",
        operation2.id,
        "before-target-publication"
      )) {
        await appendOperationEvent(
          runRoot,
          profile,
          transaction,
          operation2,
          "operation-published",
          "before-target-publication",
          operation2.target
        );
      }
      const moved = await moveBaseFile(
        baseRoot,
        operation2.quarantinePath,
        operation2.target,
        async () => {
          const current = await currentOperation(baseRoot, operation2, profile);
          if (!current.source || !sameIdentity(
            current.source.identity,
            operationPostSourceExpected(operation2)
          ) || current.target.identity.exists || !current.quarantine?.identity.exists || operation2.precondition.target.exists && !current.backup?.identity.exists) {
            throw new WorkflowFinalizationConflictError(
              operationConflictPaths(operation2, current)
            );
          }
        },
        async () => {
          const current = await currentOperation(baseRoot, operation2, profile);
          if (!current.source || !sameIdentity(
            current.source.identity,
            operationPostSourceExpected(operation2)
          ) || !sameIdentity(
            current.target.identity,
            operationPostTargetExpected(operation2)
          ) || !storageMatchesContent(
            current,
            "quarantine",
            operation2.previousSourceContent
          ) || operation2.precondition.target.exists && !storageMatchesContent(
            current,
            "backup",
            operation2.previousTargetContent
          )) {
            throw new WorkflowFinalizationConflictError(
              operationConflictPaths(operation2, current)
            );
          }
        }
      );
      if (!moved) {
        throw new WorkflowFinalizationConflictError([
          operation2.quarantinePath,
          operation2.target
        ]);
      }
      operation2.status = "target-published";
      await appendOperationEvent(
        runRoot,
        profile,
        transaction,
        operation2,
        "operation-published",
        "target-published",
        operation2.target
      );
    }
  }
  actual = await currentOperation(baseRoot, operation2, profile);
  progress = operationProgress(operation2, actual);
  if (progress !== "post" && operation2.kind === "move") {
    if (progress === "source-quarantined" && actual.quarantine?.identity.exists && actual.target.identity.exists) {
      throw new WorkflowFinalizationConflictError(
        operationConflictPaths(operation2, actual)
      );
    }
  }
  if (!hasTransactionEvent(
    transaction,
    "operation-started",
    operation2.id,
    "after-operation"
  ) && progress === "post") {
    await appendOperationEvent(
      runRoot,
      profile,
      transaction,
      operation2,
      "operation-started",
      "after-operation",
      operation2.target
    );
  }
  const verified = await currentOperation(baseRoot, operation2, profile);
  if (!operationMatches(verified, operation2.expectedPostState)) {
    throw new WorkflowFinalizationConflictError(
      operationConflictPaths(operation2, verified)
    );
  }
  operation2.status = "verified";
  if (!hasTransactionEvent(
    transaction,
    "operation-verified",
    operation2.id,
    "operation-verified"
  )) {
    await appendOperationEvent(
      runRoot,
      profile,
      transaction,
      operation2,
      "operation-verified",
      "operation-verified",
      operation2.target
    );
  }
  operation2.status = "committed";
  if (!hasTransactionEvent(
    transaction,
    "operation-completed",
    operation2.id,
    "operation-verified"
  )) {
    await appendOperationEvent(
      runRoot,
      profile,
      transaction,
      operation2,
      "operation-completed",
      "operation-verified",
      operation2.target
    );
  }
  if (recovery)
    transaction.recovery.crashBoundaries = uniqueStrings([
      ...transaction.recovery.crashBoundaries,
      ...transaction.events.map((event) => event.boundary)
    ]);
}
function uniqueStrings(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
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
  "retryOrdinal",
  "repair",
  "finalization"
]);
var appendLocks = /* @__PURE__ */ new Map();
function assertRunPath(changeDir, relativePath2) {
  const normalized = typeof relativePath2 === "string" ? relativePath2.replaceAll("\\", "/") : "";
  if (typeof relativePath2 !== "string" || normalized.length === 0 || path10.posix.isAbsolute(normalized) || path10.win32.isAbsolute(relativePath2) || /^(?:[A-Za-z]:|[\\/]|~)/u.test(relativePath2) || normalized.split("/").some(
    (segment) => segment.length === 0 || segment === "." || segment === ".."
  )) {
    throw new Error("Run path must stay inside the change directory");
  }
  const root = path10.resolve(changeDir);
  const target = path10.resolve(root, ...normalized.split("/"));
  if (target !== root && !target.startsWith(root + path10.sep)) {
    throw new Error("Run path must stay inside the change directory");
  }
  return normalized;
}
function isRecord7(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function requiredText2(value, key, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${label}: ${key} must be a non-empty string`);
  }
  return value;
}
function nullableText2(value, key, label) {
  if (value === null) return null;
  return requiredText2(value, key, label);
}
function assertKnownFields5(value, keys, label) {
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
function nonNegativeInteger5(value, key, label) {
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
  if (!isRecord7(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields5(
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
    runId: requiredText2(value.runId, "runId", label),
    nodeId: requiredText2(value.nodeId, "nodeId", label),
    cycleId,
    attemptId: requiredText2(value.attemptId, "attemptId", label),
    actionId: requiredText2(value.actionId, "actionId", label),
    revision: nonNegativeInteger5(value.revision, "revision", label)
  };
}
function parseScopeReference(value, label) {
  if (!isRecord7(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields5(
    value,
    /* @__PURE__ */ new Set(["id", "required", "versionId", "contentHash", "producer"]),
    label
  );
  const contentHash2 = requiredText2(value.contentHash, "contentHash", label);
  if (!/^[a-f0-9]{64}$/u.test(contentHash2)) {
    throw new Error(`Invalid ${label}: contentHash must be a SHA-256 hash`);
  }
  if (typeof value.required !== "boolean") {
    throw new Error(`Invalid ${label}: required must be a boolean`);
  }
  return {
    id: requiredText2(value.id, "id", label),
    required: value.required,
    versionId: requiredText2(value.versionId, "versionId", label),
    contentHash: contentHash2,
    producer: parseScopeProducer(value.producer, `${label}.producer`)
  };
}
function parseDecisionScope(value, label) {
  if (!isRecord7(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields5(value, /* @__PURE__ */ new Set(["artifacts", "evidence"]), label);
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
  if (!isRecord7(value)) {
    throw new Error(
      "Invalid Run pending action: stored value must be an object"
    );
  }
  assertKnownFields5(value, ACTION_KEYS, "Run pending action");
  requiredFields(
    value,
    /* @__PURE__ */ new Set(["id", "stepId", "type"]),
    "Run pending action"
  );
  const id = requiredText2(value.id, "id", "Run pending action");
  const stepId2 = nullableText2(value.stepId, "stepId", "Run pending action");
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
    action.decisionId = requiredText2(
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
    action.rationale = parseRationalePolicy2(
      value.rationale,
      "Run pending action rationale"
    );
  }
  if (Object.prototype.hasOwnProperty.call(value, "reviewer")) {
    action.reviewer = parseReviewerPolicy2(
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
    action.attemptId = requiredText2(
      value.attemptId,
      "attemptId",
      "Run pending action"
    );
  }
  if (Object.prototype.hasOwnProperty.call(value, "cycleId")) {
    action.cycleId = nullableText2(
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
  if (Object.prototype.hasOwnProperty.call(value, "repair")) {
    if (action.type !== "ask_user") {
      throw new Error("Invalid Run pending action: repair requires ask_user");
    }
    const repair = parseWorkflowRepairPendingDecision(value.repair);
    if (repair.actionId !== action.id || repair.stepId !== action.stepId || repair.attemptId !== action.attemptId || repair.cycleId !== (action.cycleId ?? null) || repair.visitOrdinal !== action.visitOrdinal || repair.retryOrdinal !== action.retryOrdinal || repair.decisionId !== action.decisionId) {
      throw new Error(
        "Invalid Run pending action: repair identity does not match action"
      );
    }
    action.repair = repair;
  }
  if (Object.prototype.hasOwnProperty.call(value, "finalization")) {
    if (action.type !== "ask_user") {
      throw new Error(
        "Invalid Run pending action: finalization requires ask_user"
      );
    }
    const finalization = parseWorkflowFinalizationPendingConfirmation(
      value.finalization
    );
    if (finalization.actionId !== action.id || finalization.decisionId !== action.decisionId || finalization.sourceActionId.length === 0) {
      throw new Error(
        "Invalid Run pending action: finalization identity does not match action"
      );
    }
    action.finalization = finalization;
  }
  return action;
}
function parsePendingActionValue(value) {
  return parseAction(value);
}
function parseDecisionScalarType(value, label) {
  if (value !== "string" && value !== "number" && value !== "boolean") {
    throw new Error(`Invalid ${label}: type is invalid`);
  }
  return value;
}
function parseDecisionInputSchema(value, label) {
  if (!isRecord7(value)) {
    throw new Error(`Invalid ${label}: must be an object`);
  }
  assertKnownFields5(value, /* @__PURE__ */ new Set(["type", "fields"]), label);
  if (value.type !== "object") {
    throw new Error(`Invalid ${label}: type must be object`);
  }
  if (!Array.isArray(value.fields)) {
    throw new Error(`Invalid ${label}: fields must be an array`);
  }
  const ids = /* @__PURE__ */ new Set();
  const fields = value.fields.map((entry, index) => {
    const fieldLabel = `${label}.fields[${index}]`;
    if (!isRecord7(entry)) {
      throw new Error(`Invalid ${fieldLabel}: must be an object`);
    }
    assertKnownFields5(
      entry,
      /* @__PURE__ */ new Set(["id", "type", "required", "values", "enum"]),
      fieldLabel
    );
    const id = requiredText2(entry.id, "id", fieldLabel);
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
  if (!isRecord7(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields5(value, /* @__PURE__ */ new Set(["id", "label", "requiredInputs"]), label);
  const result = {
    id: requiredText2(value.id, "id", label),
    label: requiredText2(value.label, "label", label)
  };
  if (value.requiredInputs !== void 0) {
    result.requiredInputs = parseDecisionInputSchema(
      value.requiredInputs,
      `${label}.requiredInputs`
    );
  }
  return result;
}
function parseRationalePolicy2(value, label) {
  if (!isRecord7(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields5(value, /* @__PURE__ */ new Set(["required"]), label);
  if (value.required !== void 0 && typeof value.required !== "boolean") {
    throw new Error(`Invalid ${label}: required must be a boolean`);
  }
  return { required: value.required === true };
}
function parseReviewerPolicy2(value, label) {
  if (!isRecord7(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields5(value, /* @__PURE__ */ new Set(["subjects", "authorities"]), label);
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
  if (!isRecord7(value)) {
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
  if (!isRecord7(value)) {
    throw new Error("Invalid Run trajectory: stored value must be an object");
  }
  const keys = /* @__PURE__ */ new Set(["sequence", "timestamp", "type", "runId", "data"]);
  assertKnownFields5(value, keys, "Run trajectory");
  requiredFields(value, keys, "Run trajectory");
  if (typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    throw new Error(
      "Invalid Run trajectory: sequence must be a positive integer"
    );
  }
  if (!TRAJECTORY_EVENT_TYPES.has(value.type)) {
    throw new Error("Invalid Run trajectory: type is invalid");
  }
  if (!isRecord7(value.data)) {
    throw new Error("Invalid Run trajectory: data must be an object");
  }
  return {
    sequence: value.sequence,
    timestamp: requiredText2(value.timestamp, "timestamp", "Run trajectory"),
    type: value.type,
    runId: requiredText2(value.runId, "runId", "Run trajectory"),
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
async function appendTrajectory(changeDir, relativePath2, event, options = {}) {
  const normalized = assertRunPath(changeDir, relativePath2);
  const key = `${path10.resolve(changeDir)}\0${normalized}`;
  await withAppendLock(key, async () => {
    const raw = await readOptionalEngineRunText(
      changeDir,
      normalized,
      RUN_FILE_LIMITS.trajectory,
      "Run trajectory",
      options
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
        ...options,
        beforeCommit: async () => {
          await options.beforeCommit?.();
          const latest = parseTrajectory(
            await readOptionalEngineRunText(
              changeDir,
              normalized,
              RUN_FILE_LIMITS.trajectory,
              "Run trajectory",
              options
            )
          );
          assertNextTrajectoryEvent(latest, parsed);
        }
      }
    );
  });
}
async function readTrajectory(changeDir, relativePath2, options = {}) {
  const normalized = assertRunPath(changeDir, relativePath2);
  const raw = await readOptionalEngineRunText(
    changeDir,
    normalized,
    RUN_FILE_LIMITS.trajectory,
    "Run trajectory",
    options
  );
  return parseTrajectory(raw);
}
async function readArtifacts(changeDir, relativePath2, options = {}) {
  const normalized = assertRunPath(changeDir, relativePath2);
  const raw = await readOptionalEngineRunText(
    changeDir,
    normalized,
    RUN_FILE_LIMITS.artifacts,
    "Run artifacts",
    options
  );
  return raw === null ? {} : parseArtifacts(parseJson(raw, "Run artifacts"));
}
async function writeArtifacts(changeDir, relativePath2, artifacts, options = {}) {
  const normalized = assertRunPath(changeDir, relativePath2);
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
async function writePendingAction(changeDir, relativePath2, action, options = {}) {
  const normalized = assertRunPath(changeDir, relativePath2);
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
async function readPendingAction(changeDir, relativePath2, options = {}) {
  const normalized = assertRunPath(changeDir, relativePath2);
  const raw = await readOptionalEngineRunText(
    changeDir,
    normalized,
    RUN_FILE_LIMITS.pendingAction,
    "Run pending action",
    options
  );
  return raw === null ? null : parseAction(parseJson(raw, "Run pending action"));
}
async function clearPendingAction(changeDir, relativePath2, options = {}) {
  const normalized = assertRunPath(changeDir, relativePath2);
  await removeEngineRunFile(
    changeDir,
    normalized,
    "Run pending action",
    options
  );
}

// src/engine/state.ts
import path11 from "path";

// src/workflow-runtime/verification-receipts.ts
var WORKFLOW_VERIFICATION_RECEIPT_DIRECTORY = ".comet/verification-receipts";
var WORKFLOW_VERIFICATION_RECEIPT_SCHEMA_VERSION = 1;
var WORKFLOW_VERIFICATION_RECEIPT_MAX_SCOPE_ENTRIES = 64;
var WORKFLOW_VERIFICATION_RECEIPT_DEFAULT_SUMMARY_BYTES = 4 * 1024;
var WORKFLOW_VERIFICATION_RECEIPT_DEFAULT_EVIDENCE_BYTES = 8 * 1024;
var HASH_PATTERN4 = /^[a-f0-9]{64}$/u;
var ISO_TIMESTAMP_PATTERN2 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
var MAX_IDENTIFIER_BYTES = 256;
var MAX_RAW_SUMMARY_BYTES = 16 * 1024 * 1024;
var MAX_DURATION_MS = 24 * 60 * 60 * 1e3;
var RECEIPT_LABEL = "Workflow Verification Receipt";
var RECEIPT_REFERENCE_KEYS = /* @__PURE__ */ new Set([
  "schemaVersion",
  "kind",
  "receiptId",
  "receiptHash",
  "receiptKind",
  "status",
  "requirementId",
  "role",
  "runId",
  "revision",
  "actionId",
  "nodeId",
  "cycleId",
  "attemptId",
  "execution",
  "protocolHash",
  "packageHash",
  "snapshotHash",
  "scopeHash",
  "contentSnapshotHash",
  "candidateArtifacts",
  "verifierSubject",
  "provider",
  "issuedAt",
  "evidenceHash",
  "truncated"
]);
var RECEIPT_KEYS = /* @__PURE__ */ new Set([...RECEIPT_REFERENCE_KEYS, "scope", "evidence"]);
var EVIDENCE_KEYS = /* @__PURE__ */ new Set([
  "summary",
  "outputHash",
  "durationMs",
  "truncated"
]);
var ARTIFACT_REFERENCE_KEYS = /* @__PURE__ */ new Set([
  "artifactId",
  "versionId",
  "contentHash",
  "producer"
]);
var PRODUCER_KEYS = /* @__PURE__ */ new Set([
  "runId",
  "nodeId",
  "cycleId",
  "attemptId",
  "actionId",
  "revision"
]);
var STATUS_VALUES = /* @__PURE__ */ new Set([
  "passed",
  "failed",
  "skipped",
  "blocked"
]);
var KIND_VALUES = /* @__PURE__ */ new Set([
  "automated-check",
  "static-inspection",
  "manual-evidence"
]);
function workflowVerificationKinds(requirement) {
  const values = Array.isArray(requirement.kind) ? [...requirement.kind] : [requirement.kind];
  if (values.length === 0 || values.some((value) => !KIND_VALUES.has(value)) || new Set(values).size !== values.length) {
    throw new Error("Workflow verification requirement kinds are invalid");
  }
  return values;
}
function validateWorkflowVerificationRequirement(value, label = "Workflow verification requirement") {
  if (!isRecord8(value)) throw new Error(`${label} must be an object`);
  assertKnownFields6(
    value,
    /* @__PURE__ */ new Set(["id", "role", "kind", "scope", "requireContentSnapshot"]),
    label
  );
  if (value.id !== void 0 && (typeof value.id !== "string" || value.id.length === 0 || Buffer.byteLength(value.id, "utf8") > MAX_IDENTIFIER_BYTES || /[\u0000\r\n]/u.test(value.id))) {
    throw new Error(`${label}.id must be a non-empty string`);
  }
  if (typeof value.role !== "string" || value.role.length === 0 || Buffer.byteLength(value.role, "utf8") > MAX_IDENTIFIER_BYTES || /[\u0000\r\n]/u.test(value.role)) {
    throw new Error(`${label}.role must be a non-empty string`);
  }
  workflowVerificationKinds(
    value
  );
  if (value.requireContentSnapshot !== void 0 && typeof value.requireContentSnapshot !== "boolean") {
    throw new Error(`${label}.requireContentSnapshot must be a boolean`);
  }
  if (value.scope === void 0) return;
  if (!isRecord8(value.scope))
    throw new Error(`${label}.scope must be an object`);
  assertKnownFields6(
    value.scope,
    /* @__PURE__ */ new Set(["artifacts", "evidence"]),
    `${label}.scope`
  );
  for (const key of ["artifacts", "evidence"]) {
    const entries = value.scope[key];
    if (entries === void 0) continue;
    if (!Array.isArray(entries) || entries.length > WORKFLOW_VERIFICATION_RECEIPT_MAX_SCOPE_ENTRIES) {
      throw new Error(`${label}.scope.${key} is outside its bound`);
    }
    const ids = /* @__PURE__ */ new Set();
    for (const [index, entry] of entries.entries()) {
      if (!isRecord8(entry)) {
        throw new Error(`${label}.scope.${key}[${index}] must be an object`);
      }
      assertKnownFields6(
        entry,
        /* @__PURE__ */ new Set(["id", "required"]),
        `${label}.scope.${key}[${index}]`
      );
      if (typeof entry.id !== "string" || entry.id.length === 0 || Buffer.byteLength(entry.id, "utf8") > MAX_IDENTIFIER_BYTES || /[\u0000\r\n]/u.test(entry.id) || ids.has(entry.id)) {
        throw new Error(
          `${label}.scope.${key} contains an invalid or duplicate id`
        );
      }
      if (entry.required !== void 0 && typeof entry.required !== "boolean") {
        throw new Error(
          `${label}.scope.${key}[${index}].required must be a boolean`
        );
      }
      ids.add(entry.id);
    }
  }
}
function isRecord8(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function assertKnownFields6(value, keys, label) {
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) throw new Error(`Invalid ${label}: unknown field ${unknown}`);
}
function boundedText3(value, key, label) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES || /[\u0000\r\n]/u.test(value)) {
    throw new Error(`Invalid ${label}: ${key} must be a bounded string`);
  }
  return value;
}
function hashValue3(value, key, label) {
  const result = boundedText3(value, key, label);
  if (!HASH_PATTERN4.test(result)) {
    throw new Error(`Invalid ${label}: ${key} must be a SHA-256 hash`);
  }
  return result;
}
function identityText(value, key, label) {
  const result = boundedText3(value, key, label);
  if (/\b(?:password|passwd|secret|token|api[-_]?key|authorization|cookie|credential)\s*[:=]/iu.test(
    result
  ) || /\bBearer\s+/iu.test(result)) {
    throw new Error(`Invalid ${label}: ${key} contains credential material`);
  }
  return result;
}
function nullableHash2(value, key, label) {
  return value === null ? null : hashValue3(value, key, label);
}
function nonNegativeInteger6(value, key, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}: ${key} must be a non-negative integer`);
  }
  return value;
}
function timestamp2(value, key, label) {
  const result = boundedText3(value, key, label);
  if (!ISO_TIMESTAMP_PATTERN2.test(result)) {
    throw new Error(`Invalid ${label}: ${key} must be an ISO timestamp`);
  }
  return result;
}
function verificationBounds(profile) {
  const normalized = parseWorkflowDurabilityProfile(profile);
  if (!normalized.capabilities.includes("verification-receipts")) {
    throw new Error(
      "Workflow durability profile has no verification receipt capability"
    );
  }
  const receiptBytes = normalized.bounds.verificationReceiptBytes;
  const receiptCount = normalized.bounds.verificationReceiptCount;
  if (receiptBytes === void 0 || receiptCount === void 0) {
    throw new Error("Workflow verification receipt bounds are missing");
  }
  return {
    receiptBytes,
    receiptCount,
    summaryBytes: normalized.verificationPolicy?.maxSummaryBytes ?? WORKFLOW_VERIFICATION_RECEIPT_DEFAULT_SUMMARY_BYTES,
    evidenceBytes: normalized.verificationPolicy?.maxEvidenceBytes ?? WORKFLOW_VERIFICATION_RECEIPT_DEFAULT_EVIDENCE_BYTES
  };
}
function parseProducer(value, label) {
  if (!isRecord8(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields6(value, PRODUCER_KEYS, label);
  const cycleId = value.cycleId;
  if (cycleId !== null && (typeof cycleId !== "string" || cycleId.length === 0)) {
    throw new Error(`Invalid ${label}: cycleId must be a string or null`);
  }
  return {
    runId: boundedText3(value.runId, "runId", label),
    nodeId: boundedText3(value.nodeId, "nodeId", label),
    cycleId,
    attemptId: boundedText3(value.attemptId, "attemptId", label),
    actionId: boundedText3(value.actionId, "actionId", label),
    revision: nonNegativeInteger6(value.revision, "revision", label)
  };
}
function parseScopeReference2(value, label) {
  if (!isRecord8(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields6(
    value,
    /* @__PURE__ */ new Set(["id", "required", "versionId", "contentHash", "producer"]),
    label
  );
  if (typeof value.required !== "boolean") {
    throw new Error(`Invalid ${label}: required must be a boolean`);
  }
  return {
    id: boundedText3(value.id, "id", label),
    required: value.required,
    versionId: boundedText3(value.versionId, "versionId", label),
    contentHash: hashValue3(value.contentHash, "contentHash", label),
    producer: parseProducer(value.producer, `${label}.producer`)
  };
}
function parseScope(value, label) {
  if (!isRecord8(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields6(value, /* @__PURE__ */ new Set(["artifacts", "evidence"]), label);
  const parseEntries = (key) => {
    const entries = value[key];
    if (!Array.isArray(entries)) {
      throw new Error(`Invalid ${label}.${key}: must be an array`);
    }
    if (entries.length > WORKFLOW_VERIFICATION_RECEIPT_MAX_SCOPE_ENTRIES) {
      throw new Error(`Invalid ${label}.${key}: too many entries`);
    }
    const parsed = entries.map(
      (entry, index) => parseScopeReference2(entry, `${label}.${key}[${index}]`)
    );
    const references = /* @__PURE__ */ new Set();
    for (const [index, reference] of parsed.entries()) {
      const identity = `${reference.id}\0${reference.versionId}`;
      if (references.has(identity)) {
        throw new Error(`Invalid ${label}.${key}: duplicate reference`);
      }
      references.add(identity);
      if (index > 0 && `${parsed[index - 1].id}\0${parsed[index - 1].versionId}`.localeCompare(
        identity,
        "en"
      ) > 0) {
        throw new Error(
          `Invalid ${label}.${key}: entries are not canonically ordered`
        );
      }
    }
    return parsed;
  };
  return {
    artifacts: parseEntries("artifacts"),
    evidence: parseEntries("evidence")
  };
}
function parseEvidence(value, label, bounds, options = {}) {
  if (!isRecord8(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields6(value, EVIDENCE_KEYS, label);
  if (typeof value.summary !== "string" || value.summary.length === 0 || Buffer.byteLength(value.summary, "utf8") > bounds.summaryBytes || /[\u0000\r\n]/u.test(value.summary)) {
    throw new Error(`Invalid ${label}: summary is outside its bound`);
  }
  const summary = value.summary;
  const durationMs = nonNegativeInteger6(value.durationMs, "durationMs", label);
  if (durationMs > MAX_DURATION_MS) {
    throw new Error(`Invalid ${label}: durationMs exceeds its bound`);
  }
  if (typeof value.truncated !== "boolean") {
    throw new Error(`Invalid ${label}: truncated must be a boolean`);
  }
  const evidence = {
    summary,
    outputHash: hashValue3(value.outputHash, "outputHash", label),
    durationMs,
    truncated: value.truncated
  };
  if (options.requireRedacted && redactedSummary(summary, bounds.summaryBytes).value !== summary) {
    throw new Error(`Invalid ${label}: summary is not safely redacted`);
  }
  if (Buffer.byteLength(JSON.stringify(stableValue(evidence)), "utf8") > bounds.evidenceBytes) {
    throw new Error(`Invalid ${label}: evidence exceeds its bound`);
  }
  return evidence;
}
function parseArtifactReference(value, label) {
  if (!isRecord8(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields6(value, ARTIFACT_REFERENCE_KEYS, label);
  return {
    artifactId: boundedText3(value.artifactId, "artifactId", label),
    versionId: boundedText3(value.versionId, "versionId", label),
    contentHash: hashValue3(value.contentHash, "contentHash", label),
    producer: parseProducer(value.producer, `${label}.producer`)
  };
}
function parseArtifactReferences(value, label) {
  if (!Array.isArray(value))
    throw new Error(`Invalid ${label}: must be an array`);
  if (value.length > WORKFLOW_VERIFICATION_RECEIPT_MAX_SCOPE_ENTRIES) {
    throw new Error(`Invalid ${label}: too many entries`);
  }
  const entries = value.map(
    (entry, index) => parseArtifactReference(entry, `${label}[${index}]`)
  );
  const keys = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    const key = `${entry.artifactId}\0${entry.versionId}`;
    if (keys.has(key)) throw new Error(`Invalid ${label}: duplicate entry`);
    keys.add(key);
  }
  if (entries.some((entry, index) => {
    const previous = entries[index - 1];
    return previous !== void 0 && `${previous.artifactId}\0${previous.versionId}`.localeCompare(
      `${entry.artifactId}\0${entry.versionId}`,
      "en"
    ) > 0;
  })) {
    throw new Error(`Invalid ${label}: entries are not canonically ordered`);
  }
  return entries;
}
function receiptIdentityMaterial(receipt) {
  return {
    schemaVersion: receipt.schemaVersion,
    receiptKind: receipt.receiptKind,
    status: receipt.status,
    requirementId: receipt.requirementId,
    role: receipt.role,
    runId: receipt.runId,
    revision: receipt.revision,
    actionId: receipt.actionId,
    nodeId: receipt.nodeId,
    cycleId: receipt.cycleId,
    attemptId: receipt.attemptId,
    execution: receipt.execution,
    protocolHash: receipt.protocolHash,
    packageHash: receipt.packageHash,
    snapshotHash: receipt.snapshotHash,
    scopeHash: receipt.scopeHash,
    scope: receipt.scope,
    contentSnapshotHash: receipt.contentSnapshotHash,
    candidateArtifacts: receipt.candidateArtifacts,
    verifierSubject: receipt.verifierSubject,
    provider: receipt.provider,
    evidenceHash: receipt.evidenceHash,
    truncated: receipt.truncated
  };
}
function workflowVerificationReceiptHash(receipt) {
  return sha256(JSON.stringify(stableValue(receiptIdentityMaterial(receipt))));
}
function receiptId(hash4) {
  return `verification-receipt-${hash4.slice(0, 24)}`;
}
function scopeHash(scope) {
  return sha256(JSON.stringify(stableValue(scope)));
}
function evidenceHash(evidence) {
  return sha256(JSON.stringify(stableValue(evidence)));
}
function referenceFromReceipt(receipt) {
  const {
    kind: _kind,
    scope: _scope,
    evidence: _evidence,
    ...fields
  } = receipt;
  return {
    ...fields,
    kind: "workflow-verification-receipt-reference"
  };
}
function workflowVerificationReceiptReference(receipt) {
  return structuredClone(referenceFromReceipt(receipt));
}
function validateReceiptFields(value, label, bounds) {
  assertKnownFields6(value, RECEIPT_KEYS, label);
  if (value.schemaVersion !== WORKFLOW_VERIFICATION_RECEIPT_SCHEMA_VERSION) {
    throw new Error(`Invalid ${label}: schemaVersion is unsupported`);
  }
  if (value.kind !== "workflow-verification-receipt") {
    throw new Error(`Invalid ${label}: kind is invalid`);
  }
  if (!KIND_VALUES.has(value.receiptKind)) {
    throw new Error(`Invalid ${label}: receiptKind is invalid`);
  }
  if (!STATUS_VALUES.has(value.status)) {
    throw new Error(`Invalid ${label}: status is invalid`);
  }
}
function parseWorkflowVerificationReceipt(value, profile) {
  const bounds = verificationBounds(profile);
  const label = RECEIPT_LABEL;
  if (!isRecord8(value)) throw new Error(`Invalid ${label}: must be an object`);
  validateReceiptFields(value, label, bounds);
  const scope = parseScope(value.scope, `${label}.scope`);
  const evidence = parseEvidence(value.evidence, `${label}.evidence`, bounds, {
    requireRedacted: true
  });
  const candidateArtifacts = parseArtifactReferences(
    value.candidateArtifacts,
    `${label}.candidateArtifacts`
  );
  const expectedArtifacts = scope.artifacts.map((reference) => ({
    artifactId: reference.id,
    versionId: reference.versionId,
    contentHash: reference.contentHash,
    producer: reference.producer
  }));
  if (JSON.stringify(stableValue(candidateArtifacts)) !== JSON.stringify(stableValue(expectedArtifacts))) {
    throw new Error(`Invalid ${label}: candidateArtifacts do not match scope`);
  }
  const receipt = {
    schemaVersion: WORKFLOW_VERIFICATION_RECEIPT_SCHEMA_VERSION,
    kind: "workflow-verification-receipt",
    receiptId: boundedText3(value.receiptId, "receiptId", label),
    receiptHash: hashValue3(value.receiptHash, "receiptHash", label),
    receiptKind: value.receiptKind,
    status: value.status,
    requirementId: boundedText3(value.requirementId, "requirementId", label),
    role: boundedText3(value.role, "role", label),
    runId: boundedText3(value.runId, "runId", label),
    revision: nonNegativeInteger6(value.revision, "revision", label),
    actionId: boundedText3(value.actionId, "actionId", label),
    nodeId: boundedText3(value.nodeId, "nodeId", label),
    cycleId: value.cycleId === null ? null : boundedText3(value.cycleId, "cycleId", label),
    attemptId: boundedText3(value.attemptId, "attemptId", label),
    execution: parseExecutionIdentity(value.execution),
    protocolHash: hashValue3(value.protocolHash, "protocolHash", label),
    packageHash: hashValue3(value.packageHash, "packageHash", label),
    snapshotHash: hashValue3(value.snapshotHash, "snapshotHash", label),
    scopeHash: hashValue3(value.scopeHash, "scopeHash", label),
    contentSnapshotHash: nullableHash2(
      value.contentSnapshotHash,
      "contentSnapshotHash",
      label
    ),
    candidateArtifacts,
    verifierSubject: identityText(
      value.verifierSubject,
      "verifierSubject",
      label
    ),
    provider: identityText(value.provider, "provider", label),
    issuedAt: timestamp2(value.issuedAt, "issuedAt", label),
    evidenceHash: hashValue3(value.evidenceHash, "evidenceHash", label),
    truncated: value.truncated,
    scope,
    evidence
  };
  if (typeof receipt.truncated !== "boolean") {
    throw new Error(`Invalid ${label}: truncated must be a boolean`);
  }
  if (receipt.truncated !== evidence.truncated) {
    throw new Error(`Invalid ${label}: truncation identity is inconsistent`);
  }
  if (receipt.scopeHash !== scopeHash(scope)) {
    throw new Error(`Invalid ${label}: scopeHash is invalid`);
  }
  if (receipt.evidenceHash !== evidenceHash(evidence)) {
    throw new Error(`Invalid ${label}: evidenceHash is invalid`);
  }
  if (receipt.receiptId !== receiptId(receipt.receiptHash)) {
    throw new Error(`Invalid ${label}: receiptId is invalid`);
  }
  if (receipt.receiptHash !== workflowVerificationReceiptHash(receipt)) {
    throw new Error(`Invalid ${label}: receiptHash is invalid`);
  }
  if (receipt.execution.protocolHash !== receipt.protocolHash || receipt.execution.packageHash !== receipt.packageHash || receipt.execution.snapshotHash !== receipt.snapshotHash) {
    throw new Error(`Invalid ${label}: execution identity is inconsistent`);
  }
  if (JSON.stringify(stableValue(receipt)) !== JSON.stringify(stableValue(value))) {
    throw new Error(`Invalid ${label}: record is not canonical`);
  }
  const encodedBytes = Buffer.byteLength(
    JSON.stringify(stableValue(receipt)),
    "utf8"
  );
  if (encodedBytes > bounds.receiptBytes) {
    throw new Error(`Invalid ${label}: record exceeds its bound`);
  }
  return receipt;
}
function parseWorkflowVerificationReceiptReference(value, profile) {
  const bounds = verificationBounds(profile);
  const label = "Workflow Verification Receipt reference";
  if (!isRecord8(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields6(value, RECEIPT_REFERENCE_KEYS, label);
  if (value.schemaVersion !== WORKFLOW_VERIFICATION_RECEIPT_SCHEMA_VERSION || value.kind !== "workflow-verification-receipt-reference") {
    throw new Error(`Invalid ${label}: schema identity is invalid`);
  }
  if (!KIND_VALUES.has(value.receiptKind)) {
    throw new Error(`Invalid ${label}: receiptKind is invalid`);
  }
  if (!STATUS_VALUES.has(value.status)) {
    throw new Error(`Invalid ${label}: status is invalid`);
  }
  const candidateArtifacts = parseArtifactReferences(
    value.candidateArtifacts,
    `${label}.candidateArtifacts`
  );
  const reference = {
    schemaVersion: WORKFLOW_VERIFICATION_RECEIPT_SCHEMA_VERSION,
    kind: "workflow-verification-receipt-reference",
    receiptId: boundedText3(value.receiptId, "receiptId", label),
    receiptHash: hashValue3(value.receiptHash, "receiptHash", label),
    receiptKind: value.receiptKind,
    status: value.status,
    requirementId: boundedText3(value.requirementId, "requirementId", label),
    role: boundedText3(value.role, "role", label),
    runId: boundedText3(value.runId, "runId", label),
    revision: nonNegativeInteger6(value.revision, "revision", label),
    actionId: boundedText3(value.actionId, "actionId", label),
    nodeId: boundedText3(value.nodeId, "nodeId", label),
    cycleId: value.cycleId === null ? null : boundedText3(value.cycleId, "cycleId", label),
    attemptId: boundedText3(value.attemptId, "attemptId", label),
    execution: parseExecutionIdentity(value.execution),
    protocolHash: hashValue3(value.protocolHash, "protocolHash", label),
    packageHash: hashValue3(value.packageHash, "packageHash", label),
    snapshotHash: hashValue3(value.snapshotHash, "snapshotHash", label),
    scopeHash: hashValue3(value.scopeHash, "scopeHash", label),
    contentSnapshotHash: nullableHash2(
      value.contentSnapshotHash,
      "contentSnapshotHash",
      label
    ),
    candidateArtifacts,
    verifierSubject: identityText(
      value.verifierSubject,
      "verifierSubject",
      label
    ),
    provider: identityText(value.provider, "provider", label),
    issuedAt: timestamp2(value.issuedAt, "issuedAt", label),
    evidenceHash: hashValue3(value.evidenceHash, "evidenceHash", label),
    truncated: value.truncated
  };
  if (typeof reference.truncated !== "boolean") {
    throw new Error(`Invalid ${label}: truncated must be a boolean`);
  }
  if (reference.receiptId !== receiptId(reference.receiptHash)) {
    throw new Error(`Invalid ${label}: receiptId is invalid`);
  }
  if (reference.execution.protocolHash !== reference.protocolHash || reference.execution.packageHash !== reference.packageHash || reference.execution.snapshotHash !== reference.snapshotHash) {
    throw new Error(`Invalid ${label}: execution identity is inconsistent`);
  }
  if (JSON.stringify(stableValue(reference)) !== JSON.stringify(stableValue(value))) {
    throw new Error(`Invalid ${label}: record is not canonical`);
  }
  if (Buffer.byteLength(JSON.stringify(stableValue(reference)), "utf8") > bounds.receiptBytes) {
    throw new Error(`Invalid ${label}: record exceeds its bound`);
  }
  return reference;
}
function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  for (const character of value) {
    const next = `${result}${character}\u2026`;
    if (Buffer.byteLength(next, "utf8") > maxBytes) break;
    result += character;
  }
  return `${result}\u2026`;
}
function redactedSummary(value, maxBytes) {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const redacted = normalized.replace(/\b(?:https?|file):\/\/[^\s,;)]+/giu, "[URL]").replace(
    /\b(password|passwd|secret|token|api[-_]?key|authorization|cookie|credential)["']?\s*[:=]\s*["']?[^\s,;"'}]+/giu,
    "$1=[REDACTED]"
  ).replace(/\bBearer\s+[^\s,;)]+/gu, "Bearer [REDACTED]").replace(/(?:[A-Za-z]:[\\/]|\/)[^\s,;)]*/gu, "[PATH]");
  const valueAfterLimit = truncateUtf8(redacted, maxBytes);
  return {
    value: valueAfterLimit,
    truncated: valueAfterLimit !== redacted || Buffer.byteLength(value, "utf8") > maxBytes
  };
}
function normalizeWorkflowVerificationProposal(value, profile) {
  const bounds = verificationBounds(profile);
  const label = "Workflow Verification Receipt proposal";
  if (!isRecord8(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields6(
    value,
    /* @__PURE__ */ new Set([
      "kind",
      "status",
      "requirementId",
      "role",
      "scope",
      "artifactVersions",
      "contentSnapshotHash",
      "verifierSubject",
      "provider",
      "providerId",
      "verifier",
      "evidence",
      "summary",
      "outputHash",
      "durationMs",
      "truncated"
    ]),
    label
  );
  if (!KIND_VALUES.has(value.kind)) {
    throw new Error(`Invalid ${label}: kind is invalid`);
  }
  if (!STATUS_VALUES.has(value.status)) {
    throw new Error(`Invalid ${label}: status is invalid`);
  }
  const evidenceValue2 = value.evidence ?? (value.summary !== void 0 || value.outputHash !== void 0 || value.durationMs !== void 0 || value.truncated !== void 0 ? {
    summary: value.summary,
    outputHash: value.outputHash,
    durationMs: value.durationMs,
    truncated: value.truncated
  } : void 0);
  if (!isRecord8(evidenceValue2)) {
    throw new Error(`Invalid ${label}: evidence is required`);
  }
  const evidence = parseEvidence(evidenceValue2, `${label}.evidence`, {
    ...bounds,
    summaryBytes: MAX_RAW_SUMMARY_BYTES,
    evidenceBytes: MAX_RAW_SUMMARY_BYTES
  });
  const redacted = redactedSummary(evidence.summary, bounds.summaryBytes);
  const normalizedEvidence = {
    ...evidence,
    summary: redacted.value,
    truncated: evidence.truncated || redacted.truncated
  };
  if (Buffer.byteLength(JSON.stringify(stableValue(normalizedEvidence)), "utf8") > bounds.evidenceBytes) {
    throw new Error(`Invalid ${label}: evidence exceeds its bound`);
  }
  let artifactVersions;
  if (value.artifactVersions !== void 0) {
    if (!isRecord8(value.artifactVersions)) {
      throw new Error(`Invalid ${label}: artifactVersions must be an object`);
    }
    const entries = Object.entries(value.artifactVersions);
    if (entries.length > WORKFLOW_VERIFICATION_RECEIPT_MAX_SCOPE_ENTRIES) {
      throw new Error(`Invalid ${label}: too many artifact versions`);
    }
    if (entries.some(
      ([key, entry]) => !key || typeof entry !== "string" || !entry
    )) {
      throw new Error(
        `Invalid ${label}: artifactVersions must contain strings`
      );
    }
    artifactVersions = Object.fromEntries(
      entries.map(([key, entry]) => [key, entry])
    );
  }
  const contentSnapshotHash = value.contentSnapshotHash === void 0 ? void 0 : nullableHash2(value.contentSnapshotHash, "contentSnapshotHash", label);
  const provider = value.provider ?? value.providerId;
  if (value.provider !== void 0 && value.providerId !== void 0) {
    throw new Error(`Invalid ${label}: use provider or providerId, not both`);
  }
  const verifierSubject = value.verifierSubject ?? value.verifier;
  if (value.verifierSubject !== void 0 && value.verifier !== void 0) {
    throw new Error(
      `Invalid ${label}: use verifierSubject or verifier, not both`
    );
  }
  return {
    kind: value.kind,
    status: value.status,
    ...value.requirementId !== void 0 ? {
      requirementId: boundedText3(
        value.requirementId,
        "requirementId",
        label
      )
    } : {},
    ...value.role !== void 0 ? { role: boundedText3(value.role, "role", label) } : {},
    ...value.scope !== void 0 ? { scope: value.scope } : {},
    ...artifactVersions ? { artifactVersions } : {},
    ...contentSnapshotHash !== void 0 ? { contentSnapshotHash } : {},
    verifierSubject: identityText(verifierSubject, "verifierSubject", label),
    provider: identityText(provider, "provider", label),
    evidence: normalizedEvidence
  };
}
function createWorkflowVerificationReceipt(options, profile) {
  const bounds = verificationBounds(profile);
  const proposal = normalizeWorkflowVerificationProposal(
    options.proposal,
    profile
  );
  const scope = structuredClone(options.scope);
  const evidence = structuredClone(proposal.evidence);
  const receiptWithoutIdentity = {
    schemaVersion: WORKFLOW_VERIFICATION_RECEIPT_SCHEMA_VERSION,
    kind: "workflow-verification-receipt",
    receiptId: "pending",
    receiptHash: "0".repeat(64),
    receiptKind: proposal.kind,
    status: proposal.status,
    requirementId: options.requirementId,
    role: options.role,
    runId: options.runId,
    revision: options.revision,
    actionId: options.actionId,
    nodeId: options.nodeId,
    cycleId: options.cycleId,
    attemptId: options.attemptId,
    execution: structuredClone(options.execution),
    protocolHash: options.protocolHash,
    packageHash: options.packageHash,
    snapshotHash: options.snapshotHash,
    scopeHash: scopeHash(scope),
    contentSnapshotHash: proposal.contentSnapshotHash ?? options.contentSnapshotHash,
    candidateArtifacts: scope.artifacts.map((reference) => ({
      artifactId: reference.id,
      versionId: reference.versionId,
      contentHash: reference.contentHash,
      producer: structuredClone(reference.producer)
    })),
    verifierSubject: proposal.verifierSubject,
    provider: proposal.provider,
    issuedAt: (options.now ?? /* @__PURE__ */ new Date()).toISOString(),
    evidenceHash: evidenceHash(evidence),
    truncated: evidence.truncated,
    scope,
    evidence
  };
  const hash4 = workflowVerificationReceiptHash(receiptWithoutIdentity);
  const receipt = {
    ...receiptWithoutIdentity,
    receiptId: receiptId(hash4),
    receiptHash: hash4
  };
  if (Buffer.byteLength(JSON.stringify(stableValue(receipt)), "utf8") > bounds.receiptBytes) {
    throw new Error(`${RECEIPT_LABEL} exceeds ${bounds.receiptBytes} bytes`);
  }
  return parseWorkflowVerificationReceipt(receipt, profile);
}
function receiptPath(hash4) {
  return `${WORKFLOW_VERIFICATION_RECEIPT_DIRECTORY}/${hash4}.json`;
}
function serializedReceipt(receipt) {
  return `${JSON.stringify(stableValue(receipt), null, 2)}
`;
}
async function readWorkflowVerificationReceipt(runRoot, receiptHash, profile, options = {}) {
  const bounds = verificationBounds(profile);
  const hash4 = hashValue3(receiptHash, "receiptHash", RECEIPT_LABEL);
  const raw = await readOptionalEngineRunText(
    runRoot,
    receiptPath(hash4),
    bounds.receiptBytes,
    RECEIPT_LABEL,
    options.overlay ? { overlay: options.overlay } : {}
  );
  if (raw === null) return null;
  if (Buffer.byteLength(raw, "utf8") > bounds.receiptBytes) {
    throw new Error(`${RECEIPT_LABEL} exceeds ${bounds.receiptBytes} bytes`);
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${RECEIPT_LABEL} is not valid JSON`, { cause: error });
  }
  const receipt = parseWorkflowVerificationReceipt(value, profile);
  if (receipt.receiptHash !== hash4) {
    throw new Error(`${RECEIPT_LABEL} path identity does not match content`);
  }
  if (raw !== serializedReceipt(receipt)) {
    throw new Error(`${RECEIPT_LABEL} is not canonically serialized`);
  }
  return receipt;
}
async function stageWorkflowVerificationReceipt(options) {
  const bounds = verificationBounds(options.profile);
  const receipt = parseWorkflowVerificationReceipt(
    options.receipt,
    options.profile
  );
  const path18 = receiptPath(receipt.receiptHash);
  const existingRaw = await options.transition.read(
    path18,
    bounds.receiptBytes,
    RECEIPT_LABEL
  );
  if (existingRaw !== null) {
    let value;
    try {
      value = JSON.parse(existingRaw);
    } catch (error) {
      throw new Error(`${RECEIPT_LABEL} is not valid JSON`, { cause: error });
    }
    const existing = parseWorkflowVerificationReceipt(value, options.profile);
    if (existingRaw !== serializedReceipt(existing)) {
      throw new Error(`${RECEIPT_LABEL} duplicate record is not canonical`);
    }
    if (existing.receiptHash !== receipt.receiptHash || JSON.stringify(stableValue(receiptIdentityMaterial(existing))) !== JSON.stringify(stableValue(receiptIdentityMaterial(receipt)))) {
      throw new Error(`${RECEIPT_LABEL} duplicate identity conflicts`);
    }
    return workflowVerificationReceiptReference(existing);
  }
  await options.transition.write(
    path18,
    serializedReceipt(receipt),
    bounds.receiptBytes,
    RECEIPT_LABEL
  );
  return workflowVerificationReceiptReference(receipt);
}

// src/engine/state.ts
function assertSafeRunReference(value, key) {
  const normalized = value.replaceAll("\\", "/");
  if (path11.posix.isAbsolute(normalized) || path11.win32.isAbsolute(value) || /^(?:[A-Za-z]:|[\\/]|~)/u.test(value) || /[*?]/u.test(value) || normalized.split("/").some(
    (segment) => segment.length === 0 || segment === "." || segment === ".."
  )) {
    throw new Error(
      `Invalid Run state: ${key} must stay inside the change directory`
    );
  }
}
var RUN_STATE_FILE = ".comet/run-state.json";
var RUN_STATE_MAX_BYTES = 256 * 1024;
var RUN_STATE_READ_MAX_BYTES = Math.max(
  RUN_STATE_MAX_BYTES,
  WORKFLOW_DURABILITY_MAX_RECORD_BYTES
);
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
    "snapshotHash",
    "verificationReceiptIds"
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
  for (const [key, hash4] of [
    ["protocolHash", protocolHash],
    ["packageHash", packageHash],
    ["snapshotHash", snapshotHash]
  ]) {
    if (!/^[a-f0-9]{64}$/u.test(hash4)) {
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
  let verificationReceiptIds;
  if (receipt.verificationReceiptIds !== void 0) {
    if (!Array.isArray(receipt.verificationReceiptIds) || receipt.verificationReceiptIds.length > 64 || receipt.verificationReceiptIds.some(
      (reference) => typeof reference !== "string" || reference.length === 0
    )) {
      throw new Error(
        `Invalid Run state: ${label}.verificationReceiptIds must be bounded strings`
      );
    }
    if (new Set(receipt.verificationReceiptIds).size !== receipt.verificationReceiptIds.length) {
      throw new Error(
        `Invalid Run state: ${label}.verificationReceiptIds must not contain duplicates`
      );
    }
    verificationReceiptIds = [...receipt.verificationReceiptIds];
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
    ...verificationReceiptIds ? { verificationReceiptIds } : {},
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
    "artifactVersions",
    "verificationReceiptIds",
    "repairDecision"
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
    } : {},
    ...outcome.verificationReceiptIds !== void 0 ? (() => {
      if (!Array.isArray(outcome.verificationReceiptIds) || outcome.verificationReceiptIds.length > 64 || outcome.verificationReceiptIds.some(
        (reference) => typeof reference !== "string" || reference.length === 0
      )) {
        throw new Error(
          `Invalid Run state: ${label}.verificationReceiptIds must be bounded strings`
        );
      }
      if (new Set(outcome.verificationReceiptIds).size !== outcome.verificationReceiptIds.length) {
        throw new Error(
          `Invalid Run state: ${label}.verificationReceiptIds must not contain duplicates`
        );
      }
      return {
        verificationReceiptIds: [
          ...outcome.verificationReceiptIds
        ]
      };
    })() : {},
    ...outcome.repairDecision !== void 0 ? (() => {
      const repair = outcome.repairDecision;
      if (!repair || typeof repair !== "object" || Array.isArray(repair)) {
        throw new Error(
          `Invalid Run state: ${label}.repairDecision must be an object`
        );
      }
      const repairValue = repair;
      const repairKeys = /* @__PURE__ */ new Set([
        "decisionId",
        "signatureHash",
        "choiceId",
        "outcome"
      ]);
      const unknownRepair = Object.keys(repairValue).find(
        (key) => !repairKeys.has(key)
      );
      if (unknownRepair) {
        throw new Error(
          `Invalid Run state: ${label}.repairDecision has unknown field ${unknownRepair}`
        );
      }
      const repairOutcome = repairValue.outcome;
      if (repairOutcome !== "retry" && repairOutcome !== "stop" && repairOutcome !== "contract-change") {
        throw new Error(
          `Invalid Run state: ${label}.repairDecision.outcome is invalid`
        );
      }
      const signatureHash = requiredJsonString(
        repairValue.signatureHash,
        `${label}.repairDecision.signatureHash`
      );
      if (!/^[a-f0-9]{64}$/u.test(signatureHash)) {
        throw new Error(
          `Invalid Run state: ${label}.repairDecision.signatureHash is invalid`
        );
      }
      return {
        repairDecision: {
          decisionId: requiredJsonString(
            repairValue.decisionId,
            `${label}.repairDecision.decisionId`
          ),
          signatureHash,
          choiceId: requiredJsonString(
            repairValue.choiceId,
            `${label}.repairDecision.choiceId`
          ),
          outcome: repairOutcome
        }
      };
    })() : {}
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
function parseWorkflowRuntime(value, runId, durabilityProfile) {
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
    "verificationReceipts",
    "artifactVersions",
    "artifactSelections",
    "contentSnapshots",
    "repairEpisode",
    "finalization"
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
  const verificationReceipts = runtime.verificationReceipts === void 0 ? [] : Array.isArray(runtime.verificationReceipts) ? (() => {
    if (!durabilityProfile && runtime.verificationReceipts.length > 0) {
      throw new Error(
        "Invalid Run state: verification receipts require a durability profile"
      );
    }
    if (!durabilityProfile) return [];
    const maxCount = durabilityProfile.bounds.verificationReceiptCount;
    if (maxCount !== void 0 && runtime.verificationReceipts.length > maxCount) {
      throw new Error(
        "Invalid Run state: WorkflowRuntime verificationReceipts exceeds its bound"
      );
    }
    return runtime.verificationReceipts.map(
      (receipt, index) => parseWorkflowVerificationReceiptReference(
        receipt,
        durabilityProfile
      )
    );
  })() : (() => {
    throw new Error(
      "Invalid Run state: WorkflowRuntime verificationReceipts must be an array"
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
  const contentSnapshots = runtime.contentSnapshots === void 0 ? void 0 : Array.isArray(runtime.contentSnapshots) ? runtime.contentSnapshots.length > 64 ? (() => {
    throw new Error(
      "Invalid Run state: WorkflowRuntime contentSnapshots exceeds its bound"
    );
  })() : runtime.contentSnapshots.map(
    (snapshot, index) => parseWorkflowContentSnapshotReference(
      snapshot,
      `workflowRuntime.contentSnapshots[${index}]`
    )
  ) : (() => {
    throw new Error(
      "Invalid Run state: WorkflowRuntime contentSnapshots must be an array"
    );
  })();
  if (contentSnapshots) {
    const snapshotHashes = /* @__PURE__ */ new Set();
    for (const snapshot of contentSnapshots) {
      if (snapshotHashes.has(snapshot.hash)) {
        throw new Error(
          `Invalid Run state: duplicate WorkflowRuntime content snapshot ${snapshot.hash}`
        );
      }
      snapshotHashes.add(snapshot.hash);
    }
  }
  const repairEpisode = runtime.repairEpisode === void 0 ? void 0 : (() => {
    if (!durabilityProfile?.capabilities.includes("repair-policy")) {
      throw new Error(
        "Invalid Run state: repair episodes require repair-policy capability"
      );
    }
    const maxCount = durabilityProfile.bounds.repairHistoryCount;
    const parsed = parseWorkflowRepairEpisode(
      runtime.repairEpisode,
      maxCount
    );
    const repairPolicy = durabilityProfile.repairPolicy;
    if (!repairPolicy) {
      throw new Error(
        "Invalid Run state: repair-policy capability has no repair policy"
      );
    }
    const normalizedPolicy = normalizeWorkflowRepairPolicy(repairPolicy);
    if (parsed.totalFailures > normalizedPolicy.maxFailures || parsed.remainingFailures !== normalizedPolicy.maxFailures - parsed.totalFailures || parsed.consecutiveFailures > parsed.totalFailures) {
      throw new Error(
        "Invalid Run state: WorkflowRuntime repair counters are outside policy"
      );
    }
    const maxBytes = durabilityProfile.bounds.repairHistoryBytes;
    if (maxBytes !== void 0 && Buffer.byteLength(JSON.stringify(parsed), "utf8") > maxBytes) {
      throw new Error(
        "Invalid Run state: WorkflowRuntime repair episode exceeds its bound"
      );
    }
    if (parsed.history.some((record) => record.revision > revision)) {
      throw new Error(
        "Invalid Run state: WorkflowRuntime repair history has a future revision"
      );
    }
    return parsed;
  })();
  if (durabilityProfile?.capabilities.includes("repair-policy") && repairEpisode === void 0) {
    throw new Error(
      "Invalid Run state: repair-policy capability requires a repair episode"
    );
  }
  const finalization = runtime.finalization === void 0 ? void 0 : (() => {
    if (!durabilityProfile?.capabilities.includes(
      "transactional-finalization"
    )) {
      throw new Error(
        "Invalid Run state: finalization requires transactional-finalization capability"
      );
    }
    return parseWorkflowFinalizationState(
      runtime.finalization,
      durabilityProfile
    );
  })();
  if (finalization) {
    if (finalization.status === "awaiting-confirmation" && finalization.revision !== revision) {
      throw new Error(
        "Invalid Run state: awaiting finalization revision does not match Run revision"
      );
    }
    if (finalization.status === "awaiting-confirmation" && (!finalization.pendingConfirmation || finalization.pendingConfirmation.revision !== revision)) {
      throw new Error(
        "Invalid Run state: finalization confirmation revision is invalid"
      );
    }
    if (finalization.status !== "awaiting-confirmation" && finalization.revision !== revision) {
      throw new Error(
        "Invalid Run state: finalization revision does not match Run revision"
      );
    }
    if (finalization.receipt) {
      const expectedReceiptStatus = finalization.status === "rolled-back" ? "rolled-back" : "committed";
      if (finalization.receipt.runId !== runId || finalization.transactionId !== finalization.receipt.transactionId || finalization.receipt.planHash !== finalization.planHash || finalization.receipt.revision !== finalization.planRevision || finalization.receipt.resultingRevision !== revision || finalization.receipt.status !== expectedReceiptStatus) {
        throw new Error(
          "Invalid Run state: finalization receipt does not match its state"
        );
      }
    }
  }
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
  const verificationReceiptIds = /* @__PURE__ */ new Set();
  for (const receipt of verificationReceipts) {
    if (verificationReceiptIds.has(receipt.receiptId)) {
      throw new Error(
        `Invalid Run state: duplicate WorkflowRuntime Verification Receipt ${receipt.receiptId}`
      );
    }
    verificationReceiptIds.add(receipt.receiptId);
    if (receipt.runId !== runId) {
      throw new Error(
        `Invalid Run state: Verification Receipt ${receipt.receiptId} belongs to another Run`
      );
    }
    if (receipt.revision >= revision) {
      throw new Error(
        `Invalid Run state: Verification Receipt ${receipt.receiptId} has a future revision`
      );
    }
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
  const finalizationRevisionIncrement = finalization?.confirmationCount ?? (finalization?.confirmationActionId === void 0 ? 0 : 1);
  if (revision !== outcomeCount + finalizationRevisionIncrement) {
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
    verificationReceipts,
    artifactVersions,
    artifactSelections,
    ...contentSnapshots ? { contentSnapshots } : {},
    ...repairEpisode ? { repairEpisode } : {},
    ...finalization ? { finalization } : {}
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
  if (json.status !== "running" && json.status !== "waiting" && json.status !== "completed" && json.status !== "failed" && json.status !== "blocked") {
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
      "findingCatalogVersion",
      "durabilityProfile"
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
    const durabilityProfile = identity.durabilityProfile === void 0 ? void 0 : parseWorkflowDurabilityProfile(identity.durabilityProfile);
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
      ...identity.findingCatalogVersion === 1 ? { findingCatalogVersion: 1 } : {},
      ...durabilityProfile ? { durabilityProfile } : {}
    };
  }
  const workflowRuntime = parseWorkflowRuntime(
    json.workflowRuntime,
    runId,
    runtimeIdentity?.durabilityProfile
  );
  if (workflowRuntime?.finalization?.status === "awaiting-confirmation") {
    if (json.pending !== workflowRuntime.finalization.pendingConfirmation?.actionId || json.status !== "waiting") {
      throw new Error(
        "Invalid Run state: finalization confirmation action does not match Run"
      );
    }
  }
  if (json.status === "completed" && workflowRuntime?.finalization && workflowRuntime.finalization.status !== "committed") {
    throw new Error(
      "Invalid Run state: completed Run requires committed finalization"
    );
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
    RUN_STATE_READ_MAX_BYTES,
    "Run state",
    options
  );
  if (raw === null) return null;
  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    if (Buffer.byteLength(raw, "utf8") > RUN_STATE_MAX_BYTES) {
      throw new Error(`Run state exceeds ${RUN_STATE_MAX_BYTES} bytes`, {
        cause: error
      });
    }
    throw error;
  }
  const identity = document && typeof document === "object" && !Array.isArray(document) ? document.runtimeIdentity : void 0;
  const profile = identity && typeof identity === "object" && !Array.isArray(identity) ? identity.durabilityProfile : void 0;
  const maxBytes = profile === void 0 ? RUN_STATE_MAX_BYTES : parseWorkflowDurabilityProfile(profile).bounds.runStateBytes;
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    throw new Error(`Run state exceeds ${maxBytes} bytes`);
  }
  return parseRunStateValue(document);
}
async function writeRunState(changeDir, state, options = {}) {
  const serialized = serializeRunState(state);
  const maxBytes = state.runtimeIdentity?.durabilityProfile?.bounds.runStateBytes ?? RUN_STATE_MAX_BYTES;
  await writeEngineRunText(
    changeDir,
    RUN_STATE_FILE,
    serialized,
    maxBytes,
    "Run state",
    { ...options, maxBytes }
  );
}

// src/workflow-runtime/artifacts.ts
import { promises as fs7 } from "node:fs";
import path12 from "node:path";
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
  if (normalized.length === 0 || path12.posix.isAbsolute(normalized) || path12.win32.isAbsolute(normalized) || /^(?:~|[\\/])/u.test(normalized)) {
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
  const stat = await fs7.lstat(runRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} Run root must be a real directory`);
  }
  return path12.resolve(runRoot);
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
    const current = relative.length === 0 ? root : path12.join(root, relative);
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
        relative.length === 0 ? segment : path12.posix.join(relative, segment),
        index + 1
      );
    }
    let entries;
    try {
      entries = await fs7.readdir(current, { withFileTypes: true });
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
          `${label} crosses a symbolic link or junction at ${path12.join(current, entry.name)}`
        );
      }
      if (!matcher.test(entry.name)) continue;
      const final = index === segments.length - 1;
      if (!final && !entry.isDirectory()) continue;
      if (final && (expected === "file" && !entry.isFile() || expected === "directory" && !entry.isDirectory())) {
        continue;
      }
      const next = relative.length === 0 ? entry.name : path12.posix.join(relative, entry.name);
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
async function hashDirectoryArtifact(runRoot, relativePath2, label) {
  const manifest = [];
  let totalBytes = 0;
  async function walk(directory) {
    const inspection = await inspectProtectedProjectPath(runRoot, directory, {
      label,
      expected: "directory"
    });
    if (!inspection.exists) throw new Error(`${label} does not exist`);
    const entries = (await fs7.readdir(inspection.target, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = path12.posix.join(directory, entry.name);
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
  await walk(relativePath2);
  return sha256(JSON.stringify(stableValue({ kind: "directory", manifest })));
}
async function hashArtifactPath(runRoot, declaration, relativePath2) {
  const label = `Workflow artifact ${declaration.artifactId}`;
  if (!artifactPathMatches(relativePath2, declaration.artifact.paths)) {
    fail(`${label} path is outside its declaration: ${relativePath2}`);
  }
  if (declaration.artifact.kind === "directory") {
    return hashDirectoryArtifact(runRoot, relativePath2, label);
  }
  const result = await readProtectedProjectFile(
    runRoot,
    relativePath2,
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
function selection(artifactId, versionId, state, nodeId, actionId2, timestamp6) {
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
    timestamp: timestamp6
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
  const timestamp6 = (/* @__PURE__ */ new Date()).toISOString();
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
      timestamp: timestamp6
    };
    mutation.versions.push(version);
    mutation.selections.push(
      selection(
        declaration.artifactId,
        id,
        options.state,
        options.nodeId,
        options.actionId,
        timestamp6
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
        timestamp6
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
function isRecord9(value) {
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
  if (!isRecord9(value)) return false;
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
function missingGuardrailEvidence(node, plan, evidence, satisfiedGuardrails = /* @__PURE__ */ new Set()) {
  const guardrailByKey = new Map(
    node.guardrails.map((guardrail) => [
      `guardrail:${node.id}.${guardrail.id}`,
      guardrail
    ])
  );
  return plan.guardrails.filter(
    (key) => !satisfiedGuardrails.has(key) && !hasEvidence(
      evidence,
      [key, guardrailByKey.get(key)?.id ?? key],
      ["guardrails"]
    )
  ).map((key) => key);
}
async function validateSuccessfulSubmission(runRoot, protocol, node, plan, submission, satisfiedGuardrails = /* @__PURE__ */ new Set()) {
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
  for (const key of missingGuardrailEvidence(
    node,
    plan,
    evidence,
    satisfiedGuardrails
  )) {
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
function isRecord10(value) {
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
  if (!isRecord10(schema)) return [`${label} must be an object`];
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
    if (!isRecord10(field)) {
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
  if (!isRecord10(scope)) return [`${label} must be an object`];
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
      if (!isRecord10(entry)) {
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
  if (!isRecord10(decision)) return [`${label} requires a decision definition`];
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
      const choiceLabel2 = `${label}.choices[${index}]`;
      if (!isRecord10(choice)) {
        errors.push(`${choiceLabel2} must be an object`);
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
        errors.push(`${choiceLabel2} has unsupported field: ${unknownChoice}`);
      }
      if (typeof choice.id !== "string" || choice.id.length === 0) {
        errors.push(`${choiceLabel2}.id must be a non-empty string`);
      } else if (choiceIds.has(choice.id)) {
        errors.push(`${label} has duplicate choice id: ${choice.id}`);
      } else {
        choiceIds.add(choice.id);
      }
      if (typeof choice.label !== "string" || choice.label.length === 0) {
        errors.push(`${choiceLabel2}.label must be a non-empty string`);
      }
      const targetProperties = ["to", "target", "transition"].filter(
        (key) => Object.prototype.hasOwnProperty.call(choice, key)
      );
      if (targetProperties.length !== 1) {
        errors.push(
          `${choiceLabel2} must declare exactly one transition target field`
        );
      }
      const target = decisionChoiceTarget2(
        choice
      );
      if (target === void 0 || target === "") {
        errors.push(`${choiceLabel2} requires a transition target`);
      } else if (targets.has(target)) {
        errors.push(`${label} has duplicate choice mapping to: ${target}`);
      } else {
        targets.add(target);
      }
      if (choice.inputs !== void 0) {
        errors.push(
          ...decisionInputErrors(choice.inputs, `${choiceLabel2}.inputs`)
        );
      }
      if (choice.routing !== void 0) {
        if (!isRecord10(choice.routing)) {
          errors.push(`${choiceLabel2}.routing must be an object`);
        } else if (Object.entries(choice.routing).some(
          ([field, value]) => field.length === 0 || typeof value !== "string" || value.length === 0
        )) {
          errors.push(`${choiceLabel2}.routing must contain non-empty strings`);
        }
      }
    }
  }
  if (decision.inputs !== void 0) {
    errors.push(...decisionInputErrors(decision.inputs, `${label}.inputs`));
  }
  if (decision.rationale !== void 0) {
    if (!isRecord10(decision.rationale)) {
      errors.push(`${label}.rationale must be an object`);
    } else if (Object.keys(decision.rationale).some((key) => key !== "required") || decision.rationale.required !== void 0 && typeof decision.rationale.required !== "boolean") {
      errors.push(`${label}.rationale.required must be a boolean`);
    }
  }
  if (decision.reviewer !== void 0) {
    if (!isRecord10(decision.reviewer)) {
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
function isRecord11(value) {
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
  if (!isRecord11(scoped)) return { found: false };
  if (Object.prototype.hasOwnProperty.call(scoped, logicalId)) {
    return { found: true, value: scoped[logicalId] };
  }
  const schemaEvidence = scoped[declaration.schemaId];
  if (isRecord11(schemaEvidence)) {
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
function evidenceVersionId(evidenceId, hash4, producer) {
  return `evidence-version-${sha256(
    JSON.stringify(stableValue({ evidenceId, hash: hash4, producer }))
  ).slice(0, 24)}`;
}
function evidenceReference(state, declaration, visit, outcome, value, required) {
  const producer = evidenceProducer(state, visit, outcome);
  const hash4 = contentHash(value);
  return {
    id: declaration.id,
    required,
    versionId: evidenceVersionId(declaration.id, hash4, producer),
    contentHash: hash4,
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
    if (!isRecord11(reference)) fail2(`${label} entries must be objects`);
    const unknown = Object.keys(reference).find(
      (key2) => !["id", "required", "versionId", "contentHash", "producer"].includes(
        key2
      )
    );
    if (unknown) fail2(`${label} has unsupported field: ${unknown}`);
    if (typeof reference.id !== "string" || typeof reference.versionId !== "string" || typeof reference.contentHash !== "string" || !/^[a-f0-9]{64}$/u.test(reference.contentHash) || reference.required !== void 0 && typeof reference.required !== "boolean" || reference.producer !== void 0 && !isRecord11(reference.producer)) {
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
    if (!isRecord11(submittedValue)) {
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
    if (protocol.capabilities.durability !== void 0) {
      durabilityProfileForProtocol(protocol);
    }
  } else if (protocol.cycles !== void 0) {
    throw new Error(
      "Workflow Protocol cycle declarations require versioned capabilities"
    );
  }
  const finalizationEnabled = protocol.capabilities?.durability?.capabilities.includes(
    "transactional-finalization"
  );
  if (protocol.finalization !== void 0) {
    if (!finalizationEnabled) {
      throw new Error(
        "Workflow Protocol finalization requires transactional-finalization capability"
      );
    }
    validateWorkflowFinalizationDefinition(protocol.finalization);
    if ((protocol.finalization.requiredVerificationReceiptIds?.length ?? 0) > 0 && !protocol.capabilities?.durability?.capabilities.includes(
      "verification-receipts"
    )) {
      throw new Error(
        "Workflow Protocol finalization receipt requirements require verification-receipts capability"
      );
    }
    if (protocol.finalization.requireContentSnapshot === true && !protocol.capabilities?.durability?.capabilities.includes(
      "content-snapshots"
    )) {
      throw new Error(
        "Workflow Protocol finalization snapshot requirement requires content-snapshots capability"
      );
    }
  } else if (finalizationEnabled) {
    throw new Error(
      "Workflow Protocol transactional-finalization requires a finalization declaration"
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
  const verificationRequirementIds = /* @__PURE__ */ new Set();
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
      if (guardrail.verification !== void 0) {
        validateWorkflowVerificationRequirement(
          guardrail.verification,
          `Workflow Protocol Node ${node.id} guardrail ${guardrail.id} verification`
        );
        if (!protocol.capabilities?.durability?.capabilities.includes(
          "verification-receipts"
        )) {
          throw new Error(
            `Workflow Protocol Node ${node.id} verification guardrails require verification-receipts durability`
          );
        }
        const verificationId = guardrail.verification.id ?? guardrail.id;
        if (verificationRequirementIds.has(verificationId)) {
          throw new Error(
            `Workflow Protocol has duplicate verification requirement: ${verificationId}`
          );
        }
        verificationRequirementIds.add(verificationId);
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
  const repairFailures = protocol.capabilities?.durability?.repairPolicy ? normalizeWorkflowRepairPolicy(
    protocol.capabilities.durability.repairPolicy
  ).maxFailures : 0;
  return {
    allowedSkills: compiledSkillIds(protocol, nodes),
    allowedAgents: [],
    allowedTools: [],
    maxIterations: maxWorkflowIterations(protocol) + repairFailures,
    maxRetriesPerAction: repairFailures > 0 ? repairFailures : 3,
    confirmationRequiredFor: []
  };
}
function compileCompletionPlans(nodes) {
  return Object.fromEntries(
    nodes.map((node) => [node.id, createCompletionPlan(node)])
  );
}
async function compileWorkflow(protocol) {
  const normalizedProtocol = normalizeWorkflowDurabilityProtocol(protocol);
  const executableProtocol = normalizedProtocol.finalization ? {
    ...normalizedProtocol,
    finalization: normalizeWorkflowFinalizationDefinition(
      normalizedProtocol.finalization
    )
  } : normalizedProtocol;
  validateProtocolShape(executableProtocol);
  validateWorkflowDecisionScopeDefinition(executableProtocol);
  const revisioned = isRevisionedWorkflowProtocol(executableProtocol);
  if (executableProtocol.capabilities?.durability?.capabilities.includes(
    "verified-checkpoints"
  ) && !revisioned) {
    throw new Error(
      "Workflow Protocol verified checkpoints require revisioned capabilities"
    );
  }
  if (executableProtocol.capabilities?.durability?.capabilities.includes(
    "verification-receipts"
  ) && !revisioned) {
    throw new Error(
      "Workflow Protocol verification receipts require revisioned capabilities"
    );
  }
  if (executableProtocol.capabilities?.durability?.capabilities.includes(
    "repair-policy"
  ) && !revisioned) {
    throw new Error(
      "Workflow Protocol repair policy requires revisioned capabilities"
    );
  }
  if (revisioned && executableProtocol.capabilities?.version !== 3) {
    throw new Error(
      "Workflow Protocol revisioned capabilities are required for branch routing"
    );
  }
  if (revisioned) validateRevisionedWorkflow(executableProtocol);
  const nodes = revisioned ? activeNodes2(executableProtocol) : validateLinearRoute(executableProtocol);
  const definition = compileDefinition(executableProtocol, nodes, !revisioned);
  const nodeToStep = Object.fromEntries(
    nodes.map((node, index) => [node.id, stepId(index, node.id)])
  );
  const protocolHash = hashProtocol(executableProtocol);
  const runtime = {
    protocolHash,
    protocol: structuredClone(executableProtocol),
    nodeToStep: { ...nodeToStep },
    ...revisioned ? {
      capabilityVersion: 3,
      resolverHash: resolverHash(executableProtocol)
    } : {},
    findingCatalogVersion: WORKFLOW_FINDING_CATALOG_VERSION,
    ...executableProtocol.capabilities?.durability ? {
      durabilityProfile: durabilityProfileForProtocol(executableProtocol)
    } : {},
    completionPlans: compileCompletionPlans(nodes)
  };
  const pkg = {
    root: process.cwd(),
    packageKind: "runtime",
    runtime,
    definition,
    guardrails: compileGuardrails(executableProtocol, nodes),
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
        resolverHash: resolverHash(executableProtocol)
      } : {},
      findingCatalogVersion: WORKFLOW_FINDING_CATALOG_VERSION,
      ...executableProtocol.capabilities?.durability ? {
        durabilityProfile: durabilityProfileForProtocol(executableProtocol)
      } : {}
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

// src/workflow-runtime/transition-journal.ts
import { randomUUID as randomUUID4 } from "node:crypto";
import path13 from "node:path";
var WORKFLOW_TRANSITION_JOURNAL_PATH = ".comet/transition-journal.json";
var WORKFLOW_TRANSITION_JOURNAL_SCHEMA_VERSION = 1;
var WORKFLOW_TRANSITION_JOURNAL_MAX_RECORDS = 16;
var MAX_IDENTIFIER_LENGTH2 = 256;
var JOURNAL_LABEL = "Workflow transition journal";
var STATE_PATH = ".comet/run-state.json";
var TRANSITION_OPERATION_IDS = [
  "workflow.start",
  "workflow.resume",
  "workflow.submit"
];
var RECORD_ORDER = [
  "state",
  "pending",
  "artifacts",
  "verification-receipt",
  "trajectory",
  "revision-claim"
];
var WorkflowTransitionJournalPendingError = class extends Error {
  constructor(journal) {
    super("WorkflowRuntime recovery is required before another mutation");
    this.journal = journal;
    this.name = "WorkflowTransitionJournalPendingError";
  }
  journal;
};
var WorkflowTransitionRecordConflictError = class extends Error {
  constructor(path18) {
    super(`Workflow transition record changed before journaling: ${path18}`);
    this.path = path18;
    this.name = "WorkflowTransitionRecordConflictError";
  }
  path;
};
function isBlockedRecoveryResult(value) {
  return value.status === "blocked";
}
var configuredFault2;
function isRecord12(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function assertKnownFields7(value, keys, label) {
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) throw new Error(`Invalid ${label}: unknown field ${unknown}`);
}
function requiredText3(value, key, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH2 || /[\u0000\r\n]/u.test(value)) {
    throw new Error(`Invalid ${label}: ${key} must be a bounded string`);
  }
  return value;
}
function timestamp3(value, key, label) {
  const result = requiredText3(value, key, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result)) {
    throw new Error(`Invalid ${label}: ${key} must be an ISO timestamp`);
  }
  return result;
}
function nonNegativeInteger7(value, key, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}: ${key} must be a non-negative integer`);
  }
  return value;
}
function hash2(value, key, label) {
  const result = requiredText3(value, key, label);
  if (!/^[a-f0-9]{64}$/u.test(result)) {
    throw new Error(`Invalid ${label}: ${key} must be a SHA-256 hash`);
  }
  return result;
}
function uuid(value, key, label) {
  const result = requiredText3(value, key, label);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    result
  )) {
    throw new Error(`Invalid ${label}: ${key} is invalid`);
  }
  return result;
}
function nullableActionId(value, key, label) {
  return value === null ? null : requiredText3(value, key, label);
}
function parseMaterialIdentity2(value, key, label) {
  if (!isRecord12(value))
    throw new Error(`Invalid ${label}: ${key} must be an object`);
  assertKnownFields7(
    value,
    /* @__PURE__ */ new Set(["exists", "bytes", "sha256"]),
    `${label}.${key}`
  );
  if (typeof value.exists !== "boolean") {
    throw new Error(`Invalid ${label}: ${key}.exists must be a boolean`);
  }
  const bytes = nonNegativeInteger7(value.bytes, `${key}.bytes`, label);
  const digest = value.sha256 === null ? null : hash2(value.sha256, `${key}.sha256`, label);
  if (!value.exists && (bytes !== 0 || digest !== null) || value.exists && (bytes < 1 || digest === null)) {
    throw new Error(`Invalid ${label}: ${key} identity is inconsistent`);
  }
  return { exists: value.exists, bytes, sha256: digest };
}
function parseMaterial(value, key, label, maxBytes) {
  if (!isRecord12(value))
    throw new Error(`Invalid ${label}: ${key} must be an object`);
  assertKnownFields7(
    value,
    /* @__PURE__ */ new Set(["content", "exists", "bytes", "sha256"]),
    `${label}.${key}`
  );
  const identity = parseMaterialIdentity2(
    {
      exists: value.exists,
      bytes: value.bytes,
      sha256: value.sha256
    },
    key,
    label
  );
  if (identity.exists !== (value.content !== null)) {
    throw new Error(`Invalid ${label}: ${key}.content does not match exists`);
  }
  if (identity.exists && typeof value.content !== "string") {
    throw new Error(`Invalid ${label}: ${key}.content must be a string`);
  }
  if (!identity.exists && value.content !== null) {
    throw new Error(`Invalid ${label}: ${key}.content must be null`);
  }
  const content = value.content;
  if (content !== null && (Buffer.byteLength(content, "utf8") !== identity.bytes || Buffer.byteLength(content, "utf8") > maxBytes || sha256(content) !== identity.sha256)) {
    throw new Error(`Invalid ${label}: ${key} content identity is invalid`);
  }
  return { ...identity, content };
}
function recordKind(relativePath2) {
  if (relativePath2 === STATE_PATH) return "state";
  if (relativePath2.endsWith("/pending-action.json")) return "pending";
  if (relativePath2.endsWith("/artifacts.json")) return "artifacts";
  if (relativePath2.startsWith(".comet/verification-receipts/")) {
    return "verification-receipt";
  }
  if (relativePath2.endsWith("/trajectory.jsonl")) return "trajectory";
  if (relativePath2.startsWith(".comet/revision-claims/")) {
    return "revision-claim";
  }
  return "other";
}
function orderOf(record) {
  const rank = record.kind === "other" ? RECORD_ORDER.length : RECORD_ORDER.indexOf(record.kind);
  return `${String(rank).padStart(2, "0")}\0${record.path}`;
}
function assertSafeRecordPath(value, label) {
  const normalized = typeof value === "string" ? value.replaceAll("\\", "/") : "";
  if (normalized.length === 0 || normalized.length > MAX_IDENTIFIER_LENGTH2 || path13.posix.isAbsolute(normalized) || path13.win32.isAbsolute(String(value)) || /^(?:[A-Za-z]:|[\\/]|~)/u.test(String(value)) || normalized.split("/").some(
    (segment) => segment.length === 0 || segment === "." || segment === ".."
  )) {
    throw new Error(`Invalid ${label}: path must stay inside the Run root`);
  }
  if (normalized === WORKFLOW_TRANSITION_JOURNAL_PATH) {
    throw new Error(`Invalid ${label}: journal cannot contain itself`);
  }
  return normalized;
}
function parseRevisionIdentity(value, key, label) {
  if (!isRecord12(value))
    throw new Error(`Invalid ${label}: ${key} must be an object`);
  assertKnownFields7(
    value,
    /* @__PURE__ */ new Set(["revision", "actionId"]),
    `${label}.${key}`
  );
  return {
    revision: nonNegativeInteger7(value.revision, `${key}.revision`, label),
    actionId: nullableActionId(value.actionId, `${key}.actionId`, label)
  };
}
function parseRecoveryEvent(value) {
  const label = "Workflow transition journal recovery event";
  if (!isRecord12(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields7(
    value,
    /* @__PURE__ */ new Set(["sequence", "timestamp", "type", "runId", "data"]),
    label
  );
  if (value.type !== "recovery_reconciled") {
    throw new Error(`Invalid ${label}: type is invalid`);
  }
  if (!isRecord12(value.data))
    throw new Error(`Invalid ${label}: data must be an object`);
  const sequence = nonNegativeInteger7(value.sequence, "sequence", label);
  if (sequence < 1) throw new Error(`Invalid ${label}: sequence is invalid`);
  return {
    sequence,
    timestamp: timestamp3(value.timestamp, "timestamp", label),
    type: "recovery_reconciled",
    runId: requiredText3(value.runId, "runId", label),
    data: value.data
  };
}
function parseCommitEvidence(value) {
  const label = "Workflow transition commit evidence";
  if (!isRecord12(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields7(
    value,
    /* @__PURE__ */ new Set([
      "kind",
      "journalId",
      "operation",
      "runId",
      "previousRevision",
      "intendedRevision",
      "recovered",
      "committedAt"
    ]),
    label
  );
  if (value.kind !== "workflow-transition-commit") {
    throw new Error(`Invalid ${label}: kind is invalid`);
  }
  if (!TRANSITION_OPERATION_IDS.includes(
    value.operation
  )) {
    throw new Error(`Invalid ${label}: operation is invalid`);
  }
  if (typeof value.recovered !== "boolean") {
    throw new Error(`Invalid ${label}: recovered is invalid`);
  }
  return {
    kind: "workflow-transition-commit",
    journalId: uuid(value.journalId, "journalId", label),
    operation: value.operation,
    runId: requiredText3(value.runId, "runId", label),
    previousRevision: nonNegativeInteger7(
      value.previousRevision,
      "previousRevision",
      label
    ),
    intendedRevision: nonNegativeInteger7(
      value.intendedRevision,
      "intendedRevision",
      label
    ),
    recovered: value.recovered,
    committedAt: timestamp3(value.committedAt, "committedAt", label)
  };
}
function parseRecovery(value, maxBytes) {
  const label = "Workflow transition journal recovery";
  if (!isRecord12(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields7(
    value,
    /* @__PURE__ */ new Set([
      "status",
      "crashBoundary",
      "trajectoryPath",
      "event",
      "intendedTrajectory"
    ]),
    label
  );
  if (value.status !== "prepared" && value.status !== "recorded") {
    throw new Error(`Invalid ${label}: status is invalid`);
  }
  return {
    status: value.status,
    crashBoundary: requiredText3(value.crashBoundary, "crashBoundary", label),
    trajectoryPath: assertSafeRecordPath(
      value.trajectoryPath,
      `${label} trajectory`
    ),
    event: parseRecoveryEvent(value.event),
    intendedTrajectory: parseMaterialIdentity2(
      value.intendedTrajectory,
      "intendedTrajectory",
      label
    )
  };
}
function parseWorkflowTransitionJournal(value, maxBytes = WORKFLOW_DURABILITY_MAX_RECORD_BYTES) {
  const label = "Workflow transition journal";
  if (!isRecord12(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields7(
    value,
    /* @__PURE__ */ new Set([
      "schemaVersion",
      "kind",
      "status",
      "journalId",
      "operation",
      "runId",
      "execution",
      "previous",
      "intended",
      "records",
      "createdAt",
      "lastBoundary",
      "committedAt",
      "commitEvidence",
      "recovery"
    ]),
    label
  );
  if (value.schemaVersion !== WORKFLOW_TRANSITION_JOURNAL_SCHEMA_VERSION || value.kind !== "workflow-transition-journal") {
    throw new Error(`Invalid ${label}: schema identity is invalid`);
  }
  if (value.status !== "prepared" && value.status !== "committed") {
    throw new Error(`Invalid ${label}: status is invalid`);
  }
  if (!TRANSITION_OPERATION_IDS.includes(
    value.operation
  )) {
    throw new Error(`Invalid ${label}: operation is invalid`);
  }
  if (!Array.isArray(value.records) || value.records.length === 0 || value.records.length > WORKFLOW_TRANSITION_JOURNAL_MAX_RECORDS) {
    throw new Error(`Invalid ${label}: records are outside the allowed bound`);
  }
  const records = [];
  const paths = /* @__PURE__ */ new Set();
  for (const [index, entry] of value.records.entries()) {
    if (!isRecord12(entry))
      throw new Error(`Invalid ${label}: records[${index}] must be an object`);
    assertKnownFields7(
      entry,
      /* @__PURE__ */ new Set(["path", "kind", "previous", "intended"]),
      `${label} record`
    );
    const recordPath = assertSafeRecordPath(entry.path, `${label} record`);
    if (paths.has(recordPath))
      throw new Error(`Invalid ${label}: duplicate record path ${recordPath}`);
    paths.add(recordPath);
    const kind = entry.kind;
    if (kind !== "state" && kind !== "pending" && kind !== "artifacts" && kind !== "verification-receipt" && kind !== "trajectory" && kind !== "revision-claim" && kind !== "other") {
      throw new Error(`Invalid ${label}: record kind is invalid`);
    }
    if (kind !== recordKind(recordPath)) {
      throw new Error(`Invalid ${label}: record kind does not match path`);
    }
    records.push({
      path: recordPath,
      kind,
      previous: parseMaterial(entry.previous, "previous", label, maxBytes),
      intended: parseMaterial(entry.intended, "intended", label, maxBytes)
    });
  }
  if (records.map(orderOf).some((entry, index, values) => index > 0 && entry <= values[index - 1])) {
    throw new Error(`Invalid ${label}: records are not in deterministic order`);
  }
  const execution = parseExecutionIdentity(value.execution);
  const previous = parseRevisionIdentity(value.previous, "previous", label);
  const intended = parseRevisionIdentity(value.intended, "intended", label);
  const revisionIncrement = value.operation === "workflow.submit" ? 1 : 0;
  if (intended.revision !== previous.revision + revisionIncrement) {
    throw new Error(`Invalid ${label}: revisions are inconsistent`);
  }
  const committedAt = value.committedAt === void 0 ? void 0 : timestamp3(value.committedAt, "committedAt", label);
  const commitEvidence = value.commitEvidence === void 0 ? void 0 : parseCommitEvidence(value.commitEvidence);
  if (value.status === "committed" !== (committedAt !== void 0 && commitEvidence !== void 0)) {
    throw new Error(`Invalid ${label}: commit evidence does not match status`);
  }
  if (commitEvidence && (commitEvidence.journalId !== value.journalId || commitEvidence.runId !== value.runId || commitEvidence.operation !== value.operation || commitEvidence.previousRevision !== previous.revision || commitEvidence.intendedRevision !== intended.revision || commitEvidence.committedAt !== committedAt)) {
    throw new Error(`Invalid ${label}: commit evidence identity is invalid`);
  }
  const recovery = value.recovery === void 0 ? void 0 : parseRecovery(value.recovery, maxBytes);
  if (recovery && recovery.event.runId !== value.runId) {
    throw new Error(`Invalid ${label}: recovery event Run identity is invalid`);
  }
  if (value.status === "committed" && recovery?.status !== "recorded" && recovery !== void 0) {
    throw new Error(
      `Invalid ${label}: committed recovery evidence is incomplete`
    );
  }
  const journal = {
    schemaVersion: 1,
    kind: "workflow-transition-journal",
    status: value.status,
    journalId: uuid(value.journalId, "journalId", label),
    operation: value.operation,
    runId: requiredText3(value.runId, "runId", label),
    execution,
    previous,
    intended,
    records,
    createdAt: timestamp3(value.createdAt, "createdAt", label),
    ...value.lastBoundary === void 0 ? {} : {
      lastBoundary: requiredText3(value.lastBoundary, "lastBoundary", label)
    },
    ...committedAt ? { committedAt } : {},
    ...commitEvidence ? { commitEvidence } : {},
    ...recovery ? { recovery } : {}
  };
  return journal;
}
function journalMaxBytes(profile) {
  const bounds = profile.bounds;
  const value = bounds.transitionJournalBytes ?? bounds.runStateBytes;
  if (!Number.isSafeInteger(value) || value < 1 || value > WORKFLOW_DURABILITY_MAX_RECORD_BYTES) {
    throw new Error("Workflow transition journal size bound is invalid");
  }
  return value;
}
function recordMaxBytes(profile, kind) {
  if (kind === "state") return profile.bounds.runStateBytes;
  if (kind === "pending") return profile.bounds.pendingActionBytes;
  if (kind === "artifacts") return profile.bounds.artifactsBytes;
  if (kind === "verification-receipt") {
    if (profile.bounds.verificationReceiptBytes === void 0) {
      throw new Error("Workflow verification receipt bound is missing");
    }
    return profile.bounds.verificationReceiptBytes;
  }
  if (kind === "trajectory") return profile.bounds.trajectoryBytes;
  if (kind === "revision-claim") return profile.bounds.claimBytes;
  return journalMaxBytes(profile);
}
function validateJournalRecordBounds(journal, profile) {
  for (const record of journal.records) {
    const maxBytes = recordMaxBytes(profile, record.kind);
    for (const material of [record.previous, record.intended]) {
      if (material.bytes > maxBytes) {
        throw new Error(
          `Workflow transition record ${record.path} exceeds ${maxBytes} bytes`
        );
      }
    }
  }
}
function validateJournalStateIdentity(journal) {
  const record = journal.records.find(
    (candidate) => candidate.kind === "state"
  );
  if (!record)
    throw new Error("Workflow transition journal has no state record");
  for (const material of [record.previous, record.intended]) {
    if (material.content === null) continue;
    const state = parseRunStateValue(JSON.parse(material.content));
    if (state.runId !== journal.runId || !state.runtimeIdentity) {
      throw new Error("Workflow transition journal Run identity is invalid");
    }
    if (JSON.stringify(stableValue(state.runtimeIdentity)) !== JSON.stringify(stableValue(journal.execution))) {
      throw new Error(
        "Workflow transition journal execution identity does not match Run state"
      );
    }
  }
}
function validateJournalRevisionIdentity(journal) {
  const record = journal.records.find(
    (candidate) => candidate.kind === "state"
  );
  if (!record)
    throw new Error("Workflow transition journal has no state record");
  const materials = [
    [record.previous, journal.previous],
    [record.intended, journal.intended]
  ];
  for (const [material, expected] of materials) {
    const actual = stateMetadata(material.content);
    if (actual.revision !== expected.revision || actual.actionId !== expected.actionId) {
      throw new Error(
        "Workflow transition journal revision or action identity is invalid"
      );
    }
  }
}
function validateJournalPendingIdentity(journal) {
  const stateRecord2 = journal.records.find(
    (candidate) => candidate.kind === "state"
  );
  if (!stateRecord2)
    throw new Error("Workflow transition journal has no state record");
  const states = [
    [stateRecord2.previous.content, "previous"],
    [stateRecord2.intended.content, "intended"]
  ];
  for (const [content, label] of states) {
    if (content === null) continue;
    const state = parseRunStateValue(JSON.parse(content));
    const pendingRecord = journal.records.find(
      (candidate) => candidate.path === state.pendingRef
    );
    if (state.pending === null) {
      if (pendingRecord?.[label].content !== null) {
        throw new Error(
          `Workflow transition journal ${label} pending identity is invalid`
        );
      }
      continue;
    }
    if (!pendingRecord || pendingRecord[label].content === null) {
      throw new Error(
        `Workflow transition journal ${label} pending action is missing`
      );
    }
    const action = parsePendingActionValue(
      JSON.parse(pendingRecord[label].content)
    );
    if (action.id !== state.pending) {
      throw new Error(
        `Workflow transition journal ${label} pending action identity is invalid`
      );
    }
  }
}
function serializeJournal(journal) {
  return `${JSON.stringify(stableValue(journal), null, 2)}
`;
}
async function readJournal(runRoot, profile) {
  const maxBytes = journalMaxBytes(profile);
  const raw = await readOptionalEngineRunText(
    runRoot,
    WORKFLOW_TRANSITION_JOURNAL_PATH,
    maxBytes,
    JOURNAL_LABEL
  );
  if (raw === null) return null;
  try {
    const journal = parseWorkflowTransitionJournal(
      JSON.parse(raw),
      maxBytes
    );
    validateJournalRecordBounds(journal, profile);
    validateJournalStateIdentity(journal);
    validateJournalRevisionIdentity(journal);
    validateJournalPendingIdentity(journal);
    return journal;
  } catch (error) {
    throw new Error(`${JOURNAL_LABEL} is malformed`, { cause: error });
  }
}
async function readWorkflowTransitionJournal(runRoot) {
  const raw = await readOptionalEngineRunText(
    runRoot,
    WORKFLOW_TRANSITION_JOURNAL_PATH,
    WORKFLOW_DURABILITY_MAX_RECORD_BYTES,
    JOURNAL_LABEL
  );
  if (raw === null) return null;
  try {
    const journal = parseWorkflowTransitionJournal(
      JSON.parse(raw),
      WORKFLOW_DURABILITY_MAX_RECORD_BYTES
    );
    const profile = journal.execution.durabilityProfile;
    validateJournalRecordBounds(journal, profile);
    validateJournalStateIdentity(journal);
    validateJournalRevisionIdentity(journal);
    validateJournalPendingIdentity(journal);
    const maxBytes = journalMaxBytes(profile);
    if (Buffer.byteLength(raw, "utf8") > maxBytes) {
      throw new Error(`Workflow transition journal exceeds ${maxBytes} bytes`);
    }
    return journal;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Workflow transition journal exceeds")) {
      throw error;
    }
    throw new Error(`${JOURNAL_LABEL} is malformed`, { cause: error });
  }
}
async function writeJournal(runRoot, profile, journal, options = {}) {
  const maxBytes = journalMaxBytes(profile);
  await writeEngineRunText(
    runRoot,
    WORKFLOW_TRANSITION_JOURNAL_PATH,
    serializeJournal(journal),
    maxBytes,
    JOURNAL_LABEL,
    { exclusive: options.exclusive }
  );
}
function materialOf(content) {
  return content === null ? { content: null, exists: false, bytes: 0, sha256: null } : {
    content,
    exists: true,
    bytes: Buffer.byteLength(content, "utf8"),
    sha256: sha256(content)
  };
}
function materialIdentityOf(content) {
  const material = materialOf(content);
  return {
    exists: material.exists,
    bytes: material.bytes,
    sha256: material.sha256
  };
}
function sameMaterialIdentity(left, right) {
  return left.exists === right.exists && left.bytes === right.bytes && left.sha256 === right.sha256;
}
function sameMaterial(left, right) {
  return sameMaterialIdentity(left, right) && left.content === right.content;
}
function stateMetadata(raw) {
  if (raw === null) return { revision: 0, actionId: null };
  const state = parseRunStateValue(JSON.parse(raw));
  return {
    revision: state.workflowRuntime?.revision ?? 0,
    actionId: state.pending
  };
}
function eventBoundary(boundary) {
  return boundary.path ? `${boundary.phase}:${boundary.path}` : boundary.phase;
}
async function invokeConfiguredFault(boundary) {
  const envBoundary = process.env.COMET_WORKFLOW_TEST_FAULT_BOUNDARY;
  if (envBoundary && (envBoundary === boundary.phase || envBoundary === eventBoundary(boundary))) {
    throw new Error("deterministic workflow transition fault");
  }
  await configuredFault2?.(boundary);
}
function createJournal(input, previousState, intendedState, records, journalId) {
  return {
    schemaVersion: 1,
    kind: "workflow-transition-journal",
    status: "prepared",
    journalId,
    operation: input.operation,
    runId: input.runId,
    execution: structuredClone(input.execution),
    previous: stateMetadata(previousState),
    intended: stateMetadata(intendedState),
    records,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function stagedOrder(records) {
  return [...records].sort(
    (left, right) => orderOf(left).localeCompare(orderOf(right))
  );
}
function stateRecord(records) {
  return records.find((record) => record.kind === "state");
}
function trajectoryRecord(records) {
  return records.find((record) => record.kind === "trajectory");
}
function boundedRecoveryData(journal, repaired, crashBoundary) {
  return {
    journalId: journal.journalId,
    operation: journal.operation,
    crashBoundary,
    previousRevision: journal.previous.revision,
    intendedRevision: journal.intended.revision,
    repairedRecords: repaired.map((record) => ({
      path: record.path,
      previous: record.previous.sha256,
      intended: record.intended.sha256
    }))
  };
}
function recoveryEvent(journal, trajectory, repaired, crashBoundary) {
  const lines = trajectory.split(/\r?\n/u).filter((line) => line.length > 0);
  return {
    sequence: lines.length + 1,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    type: "recovery_reconciled",
    runId: journal.runId,
    data: boundedRecoveryData(journal, repaired, crashBoundary)
  };
}
function appendEventText(raw, event) {
  const prefix = raw.length === 0 || raw.endsWith("\n") ? raw : `${raw}
`;
  return `${prefix}${JSON.stringify(stableValue(event))}
`;
}
function recoveryJournal(journal, trajectoryPath, event, intendedTrajectory, crashBoundary) {
  return {
    ...journal,
    recovery: {
      status: "prepared",
      crashBoundary,
      trajectoryPath,
      event,
      intendedTrajectory
    }
  };
}
async function markBoundary(runRoot, profile, journal, boundary) {
  const marked = { ...journal, lastBoundary: eventBoundary(boundary) };
  await writeJournal(runRoot, profile, marked);
  await invokeConfiguredFault(boundary);
  return marked;
}
async function readRecordMaterial(runRoot, record, maxBytes) {
  const raw = await readOptionalEngineRunText(
    runRoot,
    record.path,
    maxBytes,
    `Workflow transition record ${record.path}`
  );
  return materialOf(raw);
}
async function classifyRecords(runRoot, profile, journal) {
  const classifications = /* @__PURE__ */ new Map();
  for (const record of journal.records) {
    const current = await readRecordMaterial(
      runRoot,
      record,
      recordMaxBytes(profile, record.kind)
    );
    const recoveryTrajectory = journal.recovery?.trajectoryPath === record.path && sameMaterialIdentity(current, journal.recovery.intendedTrajectory);
    classifications.set(
      record.path,
      recoveryTrajectory ? "intended" : sameMaterial(current, record.previous) ? "previous" : sameMaterial(current, record.intended) ? "intended" : "unknown"
    );
  }
  return classifications;
}
async function verifyJournalPrevious(runRoot, profile, journal) {
  const classifications = await classifyRecords(runRoot, profile, journal);
  const unknown = [...classifications.entries()].filter(([, classification]) => classification !== "previous").map(([recordPath]) => recordPath);
  if (unknown.length > 0)
    throw new WorkflowTransitionRecordConflictError(unknown[0]);
}
async function applyJournalRecords(runRoot, profile, journal, recovery) {
  const repaired = [];
  for (const record of stagedOrder(journal.records)) {
    const classifications = await classifyRecords(runRoot, profile, {
      ...journal,
      records: [record]
    });
    const classification = classifications.get(record.path);
    if (classification === "unknown") {
      throw new WorkflowTransitionRecordConflictError(record.path);
    }
    if (classification === "intended" || sameMaterial(record.previous, record.intended))
      continue;
    const phase = recovery ? "recovery-record-write" : "record-write";
    journal = await markBoundary(runRoot, profile, journal, {
      phase,
      path: record.path
    });
    if (record.intended.content === null) {
      await removeEngineRunFile(
        runRoot,
        record.path,
        `Workflow transition record ${record.path}`
      );
    } else {
      await writeEngineRunText(
        runRoot,
        record.path,
        record.intended.content,
        recordMaxBytes(profile, record.kind),
        `Workflow transition record ${record.path}`
      );
    }
    const current = await readRecordMaterial(
      runRoot,
      record,
      recordMaxBytes(profile, record.kind)
    );
    if (!sameMaterial(current, record.intended)) {
      throw new WorkflowTransitionRecordConflictError(record.path);
    }
    journal = await markBoundary(runRoot, profile, journal, {
      phase: recovery ? "recovery-record-verification" : "record-verification",
      path: record.path
    });
    repaired.push(record);
  }
  return repaired;
}
async function clearJournal(runRoot, profile, journal) {
  await removeEngineRunFile(
    runRoot,
    WORKFLOW_TRANSITION_JOURNAL_PATH,
    JOURNAL_LABEL,
    {
      beforeRemove: async () => {
        const current = await readJournal(runRoot, profile);
        if (!current || current.journalId !== journal.journalId || current.status !== "committed") {
          throw new Error(
            "Workflow transition journal changed before clearance"
          );
        }
      }
    }
  );
}
async function settleRevisionClaim(runRoot, journal) {
  if (journal.operation !== "workflow.submit" || !journal.previous.actionId) {
    return;
  }
  const input = {
    runId: journal.runId,
    expectedRevision: journal.previous.revision,
    expectedActionId: journal.previous.actionId,
    intendedRevision: journal.intended.revision,
    execution: journal.execution
  };
  await commitExistingRevisionClaim(runRoot, input);
}
async function finalizeCommittedJournal(runRoot, profile, journal) {
  let active = await markBoundary(runRoot, profile, journal, {
    phase: "commit-evidence-written"
  });
  await settleRevisionClaim(runRoot, active);
  active = await markBoundary(runRoot, profile, active, {
    phase: "journal-clearance"
  });
  await clearJournal(runRoot, profile, active);
  await invokeConfiguredFault({ phase: "journal-cleared" });
}
var WorkflowTransitionImpl = class {
  constructor(input) {
    this.input = input;
  }
  input;
  journalId = randomUUID4();
  staged = /* @__PURE__ */ new Map();
  baseline = /* @__PURE__ */ new Map();
  committing = false;
  committed = false;
  async read(relativePath2, maxBytes, label) {
    const normalized = assertSafeRecordPath(relativePath2, label);
    if (this.staged.has(normalized)) return this.staged.get(normalized) ?? null;
    if (!this.baseline.has(normalized)) {
      this.baseline.set(
        normalized,
        await readOptionalEngineRunText(
          this.input.runRoot,
          normalized,
          maxBytes,
          label
        )
      );
    }
    return this.baseline.get(normalized) ?? null;
  }
  async write(relativePath2, content, maxBytes, label) {
    const normalized = assertSafeRecordPath(relativePath2, label);
    if (Buffer.byteLength(content, "utf8") > maxBytes) {
      throw new Error(`${label} exceeds ${maxBytes} bytes`);
    }
    await this.read(normalized, maxBytes, label);
    this.staged.set(normalized, content);
  }
  async remove(relativePath2, label) {
    const normalized = assertSafeRecordPath(relativePath2, label);
    await this.read(
      normalized,
      recordMaxBytes(this.input.profile, recordKind(normalized)),
      label
    );
    this.staged.set(normalized, null);
    return this.baseline.get(normalized) !== null;
  }
  async records() {
    const stateContent = this.staged.get(STATE_PATH);
    if (this.input.operation === "workflow.submit" && stateContent) {
      const previous = stateMetadata(this.baseline.get(STATE_PATH) ?? null);
      if (previous.actionId) {
        const claimInput = {
          runId: this.input.runId,
          expectedRevision: previous.revision,
          expectedActionId: previous.actionId,
          intendedRevision: stateMetadata(stateContent).revision,
          execution: this.input.execution
        };
        const claimPath = revisionClaimPath(claimInput);
        const claim = await this.read(
          claimPath,
          this.input.profile.bounds.claimBytes,
          "Workflow revision claim"
        );
        if (claim !== null) {
          this.staged.set(claimPath, committedRevisionClaimText(claim));
        }
      }
    }
    const records = [];
    for (const [recordPath, intendedContent] of this.staged) {
      const previousContent = this.baseline.get(recordPath) ?? null;
      records.push({
        path: recordPath,
        kind: recordKind(recordPath),
        previous: materialOf(previousContent),
        intended: materialOf(intendedContent)
      });
    }
    return stagedOrder(records);
  }
  async commit() {
    if (this.committed) return;
    if (this.committing)
      throw new Error("Workflow transition commit is already running");
    this.committing = true;
    try {
      const records = await this.records();
      if (records.length === 0) {
        this.committed = true;
        return;
      }
      const state = stateRecord(records);
      if (!state || state.intended.content === null) {
        throw new Error("Workflow transition must declare intended Run state");
      }
      const journal = createJournal(
        this.input,
        state.previous.content,
        state.intended.content,
        records,
        this.journalId
      );
      validateJournalRecordBounds(journal, this.input.profile);
      validateJournalStateIdentity(journal);
      validateJournalRevisionIdentity(journal);
      validateJournalPendingIdentity(journal);
      const existing = await readJournal(
        this.input.runRoot,
        this.input.profile
      );
      if (existing) throw new WorkflowTransitionJournalPendingError(existing);
      await verifyJournalPrevious(
        this.input.runRoot,
        this.input.profile,
        journal
      );
      try {
        await writeJournal(this.input.runRoot, this.input.profile, journal, {
          exclusive: true
        });
      } catch (error) {
        if (error.code === "EEXIST") {
          const pending = await readJournal(
            this.input.runRoot,
            this.input.profile
          );
          if (pending) throw new WorkflowTransitionJournalPendingError(pending);
        }
        throw error;
      }
      let active = await markBoundary(
        this.input.runRoot,
        this.input.profile,
        journal,
        { phase: "journal-prepared" }
      );
      const verified = await readJournal(
        this.input.runRoot,
        this.input.profile
      );
      if (!verified || verified.journalId !== active.journalId) {
        throw new Error(
          "Workflow transition journal changed after preparation"
        );
      }
      active = await markBoundary(
        this.input.runRoot,
        this.input.profile,
        active,
        { phase: "journal-verified" }
      );
      await applyJournalRecords(
        this.input.runRoot,
        this.input.profile,
        active,
        false
      );
      active = await markBoundary(
        this.input.runRoot,
        this.input.profile,
        active,
        { phase: "commit-evidence" }
      );
      const committedAt = (/* @__PURE__ */ new Date()).toISOString();
      active = {
        ...active,
        status: "committed",
        committedAt,
        commitEvidence: {
          kind: "workflow-transition-commit",
          journalId: active.journalId,
          operation: active.operation,
          runId: active.runId,
          previousRevision: active.previous.revision,
          intendedRevision: active.intended.revision,
          recovered: false,
          committedAt
        }
      };
      await writeJournal(this.input.runRoot, this.input.profile, active);
      await finalizeCommittedJournal(
        this.input.runRoot,
        this.input.profile,
        active
      );
      this.committed = true;
    } finally {
      this.committing = false;
    }
  }
};
function createWorkflowTransition(input) {
  return new WorkflowTransitionImpl({
    ...input,
    execution: structuredClone(input.execution),
    profile: parseWorkflowDurabilityProfile(input.profile)
  });
}
async function recoverPreparedJournal(runRoot, profile, initial) {
  let journal = initial;
  const crashBoundary = journal.recovery?.crashBoundary ?? journal.lastBoundary ?? "unknown";
  const classifications = await classifyRecords(runRoot, profile, journal);
  const unknown = [...classifications.entries()].filter(([, classification]) => classification === "unknown").map(([recordPath]) => recordPath);
  if (unknown.length > 0) {
    const blocked2 = {
      status: "blocked",
      journal,
      unknownPaths: unknown
    };
    return blocked2;
  }
  const repaired = await applyJournalRecords(runRoot, profile, journal, true);
  journal = await readJournal(runRoot, profile) ?? journal;
  const record = trajectoryRecord(journal.records);
  if (!record || record.intended.content === null) {
    throw new Error("Workflow transition journal has no intended trajectory");
  }
  const currentTrajectory = await readRecordMaterial(
    runRoot,
    record,
    profile.bounds.trajectoryBytes
  );
  const alreadyRecorded = journal.recovery !== void 0 && sameMaterialIdentity(
    currentTrajectory,
    journal.recovery.intendedTrajectory
  );
  if (!alreadyRecorded && !sameMaterial(currentTrajectory, record.intended)) {
    throw new WorkflowTransitionRecordConflictError(record.path);
  }
  if (!journal.recovery) {
    const event = recoveryEvent(
      journal,
      record.intended.content,
      repaired,
      crashBoundary
    );
    const nextTrajectory = appendEventText(record.intended.content, event);
    journal = recoveryJournal(
      journal,
      record.path,
      event,
      materialIdentityOf(nextTrajectory),
      crashBoundary
    );
    journal = await markBoundary(runRoot, profile, journal, {
      phase: "recovery-evidence-prepared"
    });
  }
  const recovery = journal.recovery;
  if (!recovery)
    throw new Error("Workflow transition recovery evidence is missing");
  const current = await readRecordMaterial(
    runRoot,
    { path: recovery.trajectoryPath, kind: "trajectory" },
    profile.bounds.trajectoryBytes
  );
  if (!sameMaterialIdentity(current, recovery.intendedTrajectory)) {
    if (!sameMaterial(current, record.intended)) {
      const blocked2 = {
        status: "blocked",
        journal,
        unknownPaths: [recovery.trajectoryPath]
      };
      return blocked2;
    }
    journal = await markBoundary(runRoot, profile, journal, {
      phase: "recovery-evidence",
      path: recovery.trajectoryPath
    });
    const nextTrajectory = appendEventText(
      record.intended.content,
      recovery.event
    );
    await writeEngineRunText(
      runRoot,
      recovery.trajectoryPath,
      nextTrajectory,
      profile.bounds.trajectoryBytes,
      `Workflow transition record ${recovery.trajectoryPath}`
    );
    const verified = await readRecordMaterial(
      runRoot,
      { path: recovery.trajectoryPath, kind: "trajectory" },
      profile.bounds.trajectoryBytes
    );
    if (!sameMaterialIdentity(verified, recovery.intendedTrajectory)) {
      throw new WorkflowTransitionRecordConflictError(recovery.trajectoryPath);
    }
    journal = await markBoundary(runRoot, profile, journal, {
      phase: "recovery-evidence-recorded",
      path: recovery.trajectoryPath
    });
  }
  if (recovery.status !== "recorded") {
    journal = {
      ...journal,
      recovery: { ...recovery, status: "recorded" }
    };
    await writeJournal(runRoot, profile, journal);
  }
  const finalTrajectory = await readRecordMaterial(
    runRoot,
    { path: recovery.trajectoryPath, kind: "trajectory" },
    profile.bounds.trajectoryBytes
  );
  const finalRecords = journal.records.map(
    (candidate) => candidate.path === recovery.trajectoryPath ? { ...candidate, intended: { ...finalTrajectory } } : candidate
  );
  journal = {
    ...journal,
    records: finalRecords
  };
  journal = await markBoundary(runRoot, profile, journal, {
    phase: "commit-evidence"
  });
  const committedAt = journal.committedAt ?? (/* @__PURE__ */ new Date()).toISOString();
  journal = {
    ...journal,
    status: "committed",
    committedAt,
    commitEvidence: {
      kind: "workflow-transition-commit",
      journalId: journal.journalId,
      operation: journal.operation,
      runId: journal.runId,
      previousRevision: journal.previous.revision,
      intendedRevision: journal.intended.revision,
      recovered: true,
      committedAt
    }
  };
  await writeJournal(runRoot, profile, journal);
  await finalizeCommittedJournal(runRoot, profile, journal);
  return journal;
}
async function recoverWorkflowTransition(runRoot, profile) {
  const normalizedProfile = parseWorkflowDurabilityProfile(profile);
  const journal = await readJournal(runRoot, normalizedProfile);
  if (!journal) return { status: "none" };
  if (journal.status === "committed") {
    const classifications = await classifyRecords(
      runRoot,
      normalizedProfile,
      journal
    );
    const unknown = [...classifications.entries()].filter(([, classification]) => classification === "unknown").map(([recordPath]) => recordPath);
    if (unknown.length > 0)
      return { status: "blocked", journal, unknownPaths: unknown };
    const needsRepair = [...classifications.values()].some(
      (classification) => classification === "previous"
    );
    if (needsRepair) {
      const {
        committedAt: _committedAt,
        commitEvidence: _commitEvidence,
        ...withoutCommitEvidence
      } = journal;
      const prepared = {
        ...withoutCommitEvidence,
        status: "prepared"
      };
      const result2 = await recoverPreparedJournal(
        runRoot,
        normalizedProfile,
        prepared
      );
      if (isBlockedRecoveryResult(result2)) return result2;
      return { status: "recovered", journal: result2 };
    }
    await finalizeCommittedJournal(runRoot, normalizedProfile, journal);
    return { status: "recovered", journal };
  }
  const result = await recoverPreparedJournal(
    runRoot,
    normalizedProfile,
    journal
  );
  if (isBlockedRecoveryResult(result)) return result;
  return { status: "recovered", journal: result };
}

// src/workflow-runtime/run-lock.ts
import { randomUUID as randomUUID5 } from "node:crypto";
import { promises as fs8 } from "node:fs";
import os from "node:os";
import path14 from "node:path";
var WORKFLOW_RUN_LOCK_PATH = ".comet/run-lock.json";
var WORKFLOW_RUN_LOCK_RECOVERY_PATH = ".comet/run-lock-recovery.jsonl";
var WORKFLOW_RUN_LOCK_QUARANTINE_DIRECTORY = ".comet/run-lock-quarantine";
var WORKFLOW_RUN_LOCK_SCHEMA_VERSION = 1;
var WORKFLOW_RUN_LOCK_MAX_BYTES = 16 * 1024;
var MAX_LOCK_TEXT_LENGTH = 256;
var MAX_LOCK_EVENTS = 256;
var LOCK_OPERATIONS = [
  "workflow.start",
  "workflow.resume",
  "workflow.submit",
  "workflow.recover"
];
var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
var LOCK_TAKEOVER_KIND = "workflow-run-lock-takeover";
var WorkflowRunLockBlockedError = class extends Error {
  finding;
  diagnosis;
  constructor(finding, diagnosis) {
    super(finding.message);
    this.name = "WorkflowRunLockBlockedError";
    this.finding = finding;
    this.diagnosis = diagnosis;
  }
};
var configuredFault3;
async function invokeConfiguredFault2(boundary) {
  await configuredFault3?.(boundary);
}
function isRecord13(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function assertKnownFields8(value, keys, label) {
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) throw new Error(`${label} has unknown field: ${unknown}`);
}
function boundedText4(value, key, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LOCK_TEXT_LENGTH || /[\u0000\r\n]/u.test(value)) {
    throw new Error(`${label} ${key} must be a bounded string`);
  }
  return value;
}
function timestamp4(value, key, label) {
  const result = boundedText4(value, key, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result)) {
    throw new Error(`${label} ${key} must be an ISO timestamp`);
  }
  return result;
}
function parseWorkflowRunLockRecord(value) {
  const label = "Workflow Run lock";
  if (!isRecord13(value)) throw new Error(`${label} must be an object`);
  assertKnownFields8(
    value,
    /* @__PURE__ */ new Set([
      "schemaVersion",
      "kind",
      "ownerToken",
      "pid",
      "hostname",
      "createdAt",
      "operation"
    ]),
    label
  );
  if (value.schemaVersion !== WORKFLOW_RUN_LOCK_SCHEMA_VERSION || value.kind !== "workflow-run-lock") {
    throw new Error(`${label} schema identity is invalid`);
  }
  const ownerToken = boundedText4(value.ownerToken, "ownerToken", label);
  if (!UUID_PATTERN.test(ownerToken)) {
    throw new Error(`${label} ownerToken is invalid`);
  }
  if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid < 1) {
    throw new Error(`${label} pid is invalid`);
  }
  const operation2 = boundedText4(value.operation, "operation", label);
  if (!LOCK_OPERATIONS.includes(operation2)) {
    throw new Error(`${label} operation is invalid`);
  }
  return {
    schemaVersion: WORKFLOW_RUN_LOCK_SCHEMA_VERSION,
    kind: "workflow-run-lock",
    ownerToken,
    pid: value.pid,
    hostname: boundedText4(value.hostname, "hostname", label),
    createdAt: timestamp4(value.createdAt, "createdAt", label),
    operation: operation2
  };
}
function parseWorkflowRunLockTakeoverEvidence(value) {
  const label = "Workflow Run lock takeover evidence";
  if (!isRecord13(value)) throw new Error(`${label} must be an object`);
  assertKnownFields8(
    value,
    /* @__PURE__ */ new Set([
      "schemaVersion",
      "kind",
      "ownerToken",
      "pid",
      "hostname",
      "ownerOperation",
      "operation",
      "quarantinePath",
      "recordedAt"
    ]),
    label
  );
  const ownerToken = boundedText4(value.ownerToken, "ownerToken", label);
  if (!UUID_PATTERN.test(ownerToken)) {
    throw new Error(`${label} ownerToken is invalid`);
  }
  if (value.schemaVersion !== WORKFLOW_RUN_LOCK_SCHEMA_VERSION || value.kind !== LOCK_TAKEOVER_KIND || value.operation !== "workflow.recover") {
    throw new Error(`${label} schema identity is invalid`);
  }
  if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid < 1) {
    throw new Error(`${label} pid is invalid`);
  }
  const ownerOperation = boundedText4(
    value.ownerOperation,
    "ownerOperation",
    label
  );
  if (!LOCK_OPERATIONS.includes(ownerOperation)) {
    throw new Error(`${label} ownerOperation is invalid`);
  }
  const quarantinePath = boundedText4(
    value.quarantinePath,
    "quarantinePath",
    label
  );
  if (quarantinePath !== WORKFLOW_RUN_LOCK_QUARANTINE_DIRECTORY && !quarantinePath.startsWith(`${WORKFLOW_RUN_LOCK_QUARANTINE_DIRECTORY}/`)) {
    throw new Error(`${label} quarantinePath is invalid`);
  }
  return {
    schemaVersion: WORKFLOW_RUN_LOCK_SCHEMA_VERSION,
    kind: LOCK_TAKEOVER_KIND,
    ownerToken,
    pid: value.pid,
    hostname: boundedText4(value.hostname, "hostname", label),
    ownerOperation,
    operation: "workflow.recover",
    quarantinePath,
    recordedAt: timestamp4(value.recordedAt, "recordedAt", label)
  };
}
function identityOf3(stat) {
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    size: stat.size.toString(),
    birthtime: stat.birthtimeMs.toString(),
    ctime: stat.ctimeMs.toString(),
    mtime: stat.mtimeMs.toString()
  };
}
function objectIdentity(identity) {
  return {
    dev: identity.device,
    ino: identity.inode,
    birthtime: identity.birthtime
  };
}
function sameLockObject(left, right) {
  const leftObject = objectIdentity(left);
  const rightObject = objectIdentity(right);
  if (hasComparableFileObject(leftObject, rightObject)) {
    return sameFileObject(leftObject, rightObject);
  }
  return sameFileObject(leftObject, rightObject) && left.size === right.size;
}
function sameLockVersion(left, right) {
  return sameLockObject(left, right) && left.size === right.size && left.birthtime === right.birthtime && left.ctime === right.ctime && left.mtime === right.mtime;
}
function sameDiagnosis(left, right) {
  if (left.status !== right.status) return false;
  if (!left.owner || !left.identity || !right.owner || !right.identity) {
    return left.owner === right.owner && left.identity === right.identity;
  }
  return left.owner.ownerToken === right.owner.ownerToken && sameLockVersion(left.identity, right.identity);
}
function decode(bytes) {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
function safeErrorMessage(error) {
  if (error instanceof RaceSafeReadError) return error.reason;
  if (error instanceof Error) return error.message;
  return String(error);
}
function validateMaxBytes(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 16 * 1024 * 1024) {
    throw new Error("Workflow Run lock size bound is invalid");
  }
  return value;
}
async function readSnapshot2(runRoot, relativePath2 = WORKFLOW_RUN_LOCK_PATH, maxBytes = WORKFLOW_RUN_LOCK_MAX_BYTES) {
  const label = relativePath2 === WORKFLOW_RUN_LOCK_PATH ? "Workflow Run lock" : "Workflow Run lock quarantine";
  const inspection = await inspectProtectedProjectPath(runRoot, relativePath2, {
    label,
    expected: "file"
  });
  if (!inspection.exists) return null;
  try {
    const result = await readProtectedProjectFile(
      runRoot,
      relativePath2,
      validateMaxBytes(maxBytes),
      { label }
    );
    const owner = parseWorkflowRunLockRecord(JSON.parse(decode(result.bytes)));
    return {
      file: inspection.target,
      relativePath: inspection.relative,
      realPath: result.realPath,
      owner,
      identity: identityOf3(result.stat)
    };
  } catch (error) {
    const code = error.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    if (error instanceof RaceSafeReadError && error.reason === "changed") {
      throw new Error("Workflow Run lock changed while reading", {
        cause: error
      });
    }
    throw error;
  }
}
function diagnosisFromSnapshot(snapshot) {
  if (!snapshot) return { status: "missing", owner: null, identity: null };
  if (snapshot.owner.hostname !== os.hostname()) {
    return {
      status: "unknown",
      owner: snapshot.owner,
      identity: snapshot.identity
    };
  }
  const alive = isProcessAlive(snapshot.owner.pid);
  return {
    status: alive === true ? "active" : alive === false ? "stale" : "unknown",
    owner: snapshot.owner,
    identity: snapshot.identity
  };
}
function lockFinding(operation2, diagnosis) {
  if (diagnosis.status === "active") {
    const owner = diagnosis.owner;
    return createWorkflowFinding({
      code: "run-lock-active",
      severity: "error",
      message: `Workflow Run lock is active for ${owner?.operation ?? "another operation"} (pid ${owner?.pid ?? "unknown"}, host ${owner?.hostname ?? "unknown"}).`,
      path: WORKFLOW_RUN_LOCK_PATH,
      requiredAction: "retry",
      operation: { id: operation2, args: [] }
    });
  }
  if (diagnosis.status === "stale") {
    return createWorkflowFinding({
      code: "run-lock-stale",
      severity: "error",
      message: "Workflow Run lock owner is absent; explicit recovery is required.",
      path: WORKFLOW_RUN_LOCK_PATH,
      requiredAction: "repair",
      operation: { id: "workflow.recover", args: [] }
    });
  }
  return createWorkflowFinding({
    code: "run-lock-unknown",
    severity: "error",
    message: "Workflow Run lock owner or file identity cannot be verified safely.",
    path: WORKFLOW_RUN_LOCK_PATH,
    requiredAction: "stop"
  });
}
function releaseFinding() {
  return createWorkflowFinding({
    code: "run-lock-release-conflict",
    severity: "error",
    message: "Workflow Run lock ownership or file identity changed before release.",
    path: WORKFLOW_RUN_LOCK_PATH,
    requiredAction: "stop"
  });
}
function blocked(operation2, diagnosis) {
  return new WorkflowRunLockBlockedError(
    lockFinding(operation2, diagnosis),
    diagnosis
  );
}
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error.code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return null;
  }
}
async function diagnoseWorkflowRunLock(runRoot, maxBytes = WORKFLOW_RUN_LOCK_MAX_BYTES) {
  try {
    return diagnosisFromSnapshot(
      await readSnapshot2(runRoot, WORKFLOW_RUN_LOCK_PATH, maxBytes)
    );
  } catch (error) {
    return {
      status: "unknown",
      owner: null,
      identity: null,
      reason: safeErrorMessage(error)
    };
  }
}
function newLockRecord(operation2) {
  return {
    schemaVersion: WORKFLOW_RUN_LOCK_SCHEMA_VERSION,
    kind: "workflow-run-lock",
    ownerToken: randomUUID5(),
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    operation: operation2
  };
}
function serializedLock(record) {
  return `${JSON.stringify(stableValue(record), null, 2)}
`;
}
async function ensureLockDirectory(runRoot, operation2) {
  try {
    await ensureProtectedProjectDirectory(runRoot, ".comet", {
      label: "Workflow Run lock"
    });
  } catch (error) {
    const diagnosis = {
      status: "unknown",
      owner: null,
      identity: null,
      reason: safeErrorMessage(error)
    };
    throw new WorkflowRunLockBlockedError(
      lockFinding(operation2, diagnosis),
      diagnosis
    );
  }
}
async function takeOverStaleLock(runRoot, expected, maxBytes) {
  let currentSnapshot;
  try {
    currentSnapshot = await readSnapshot2(
      runRoot,
      WORKFLOW_RUN_LOCK_PATH,
      maxBytes
    );
  } catch {
    return {
      status: "changed",
      diagnosis: {
        status: "unknown",
        owner: null,
        identity: null,
        reason: "Workflow Run lock changed before quarantine"
      }
    };
  }
  const currentDiagnosis = diagnosisFromSnapshot(currentSnapshot);
  if (currentDiagnosis.status === "missing") return { status: "missing" };
  if (!sameDiagnosis(expected, currentDiagnosis) || !currentSnapshot) {
    return { status: "changed", diagnosis: currentDiagnosis };
  }
  if (currentDiagnosis.status !== "stale") {
    return { status: "changed", diagnosis: currentDiagnosis };
  }
  await ensureProtectedProjectDirectory(
    runRoot,
    WORKFLOW_RUN_LOCK_QUARANTINE_DIRECTORY,
    { label: "Workflow Run lock quarantine" }
  );
  const quarantinePath = `${WORKFLOW_RUN_LOCK_QUARANTINE_DIRECTORY}/${currentSnapshot.owner.ownerToken}-${randomUUID5()}.json`;
  const quarantine = await inspectProtectedProjectPath(
    runRoot,
    quarantinePath,
    { label: "Workflow Run lock quarantine", expected: "file" }
  );
  if (quarantine.exists) {
    return {
      status: "changed",
      diagnosis: {
        status: "unknown",
        owner: null,
        identity: null,
        reason: "Workflow Run lock quarantine target already exists"
      }
    };
  }
  const latest = await readSnapshot2(runRoot, WORKFLOW_RUN_LOCK_PATH, maxBytes);
  if (!latest || latest.owner.ownerToken !== currentSnapshot.owner.ownerToken || !sameLockVersion(latest.identity, currentSnapshot.identity)) {
    return {
      status: "changed",
      diagnosis: diagnosisFromSnapshot(latest)
    };
  }
  await invokeConfiguredFault2({
    phase: "before-quarantine",
    path: WORKFLOW_RUN_LOCK_PATH
  });
  const verified = await readSnapshot2(
    runRoot,
    WORKFLOW_RUN_LOCK_PATH,
    maxBytes
  );
  const verifiedDiagnosis = diagnosisFromSnapshot(verified);
  if (!verified || !sameDiagnosis(expected, verifiedDiagnosis) || verifiedDiagnosis.status !== "stale") {
    return { status: "changed", diagnosis: verifiedDiagnosis };
  }
  try {
    await fs8.rename(verified.file, quarantine.target);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { status: "missing" };
    }
    throw error;
  }
  let moved;
  try {
    moved = await readSnapshot2(runRoot, quarantinePath, maxBytes);
  } catch {
    moved = null;
  }
  if (!moved || moved.owner.ownerToken !== currentSnapshot.owner.ownerToken || !sameLockObject(moved.identity, currentSnapshot.identity)) {
    try {
      const source = await inspectProtectedProjectPath(
        runRoot,
        WORKFLOW_RUN_LOCK_PATH,
        { label: "Workflow Run lock", expected: "file" }
      );
      const quarantined = await inspectProtectedProjectPath(
        runRoot,
        quarantinePath,
        { label: "Workflow Run lock quarantine", expected: "file" }
      );
      if (!source.exists && quarantined.exists) {
        await fs8.rename(quarantined.target, source.target);
      }
    } catch {
      return {
        status: "changed",
        diagnosis: {
          status: "unknown",
          owner: null,
          identity: null,
          reason: "Workflow Run lock changed during quarantine"
        }
      };
    }
    return {
      status: "changed",
      diagnosis: {
        status: "unknown",
        owner: null,
        identity: null,
        reason: "Workflow Run lock changed during quarantine"
      }
    };
  }
  return {
    status: "removed",
    evidence: {
      schemaVersion: WORKFLOW_RUN_LOCK_SCHEMA_VERSION,
      kind: LOCK_TAKEOVER_KIND,
      ownerToken: currentSnapshot.owner.ownerToken,
      pid: currentSnapshot.owner.pid,
      hostname: currentSnapshot.owner.hostname,
      ownerOperation: currentSnapshot.owner.operation,
      operation: "workflow.recover",
      quarantinePath,
      recordedAt: (/* @__PURE__ */ new Date()).toISOString()
    }
  };
}
async function releaseLock(runRoot, handle) {
  let current;
  try {
    current = await readSnapshot2(runRoot, WORKFLOW_RUN_LOCK_PATH);
  } catch (error) {
    throw new WorkflowRunLockBlockedError(releaseFinding(), {
      status: "unknown",
      owner: null,
      identity: null,
      reason: safeErrorMessage(error)
    });
  }
  if (!current) return;
  if (current.owner.ownerToken !== handle.owner.ownerToken || !sameLockVersion(current.identity, handle.identity)) {
    throw new WorkflowRunLockBlockedError(releaseFinding(), {
      status: "unknown",
      owner: current.owner,
      identity: current.identity,
      reason: "Workflow Run lock changed before release"
    });
  }
  try {
    await removeContainedFile(current.file, {
      containedRoot: path14.resolve(runRoot),
      beforeRemove: async () => {
        const latest = await readSnapshot2(runRoot, WORKFLOW_RUN_LOCK_PATH);
        if (!latest || latest.owner.ownerToken !== handle.owner.ownerToken || !sameLockVersion(latest.identity, handle.identity)) {
          throw new WorkflowRunLockBlockedError(
            releaseFinding(),
            latest ? {
              status: "unknown",
              owner: latest.owner,
              identity: latest.identity,
              reason: "Workflow Run lock changed before release"
            } : {
              status: "unknown",
              owner: null,
              identity: null,
              reason: "Workflow Run lock disappeared before release"
            }
          );
        }
      }
    });
  } catch (error) {
    if (error instanceof WorkflowRunLockBlockedError) throw error;
    throw new WorkflowRunLockBlockedError(releaseFinding(), {
      status: "unknown",
      owner: null,
      identity: null,
      reason: safeErrorMessage(error)
    });
  }
}
async function holdLockForTests() {
  const value = process.env.COMET_WORKFLOW_TEST_LOCK_HOLD_MS;
  if (value === void 0) return;
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 3e4) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function acquireWorkflowRunLock(runRoot, operation2, options = {}) {
  const maxBytes = validateMaxBytes(
    options.maxBytes ?? WORKFLOW_RUN_LOCK_MAX_BYTES
  );
  let takeover;
  await ensureLockDirectory(runRoot, operation2);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const diagnosis = await diagnoseWorkflowRunLock(runRoot, maxBytes);
    if (diagnosis.status !== "missing") {
      if (options.allowStale && diagnosis.status === "stale") {
        const result = await takeOverStaleLock(runRoot, diagnosis, maxBytes);
        if (result.status === "removed") {
          takeover = result.evidence;
          continue;
        }
        if (result.status === "missing") continue;
        throw blocked(operation2, result.diagnosis);
      }
      throw blocked(operation2, diagnosis);
    }
    const owner = newLockRecord(operation2);
    try {
      await writeEngineRunText(
        runRoot,
        WORKFLOW_RUN_LOCK_PATH,
        serializedLock(owner),
        maxBytes,
        "Workflow Run lock",
        { exclusive: true, maxBytes }
      );
    } catch (error) {
      if (error.code === "EEXIST") continue;
      throw new WorkflowRunLockBlockedError(
        createWorkflowFinding({
          code: "run-lock-unknown",
          severity: "error",
          message: "Workflow Run lock could not be published safely.",
          path: WORKFLOW_RUN_LOCK_PATH,
          requiredAction: "stop"
        }),
        {
          status: "unknown",
          owner: null,
          identity: null,
          reason: safeErrorMessage(error)
        }
      );
    }
    let snapshot;
    try {
      snapshot = await readSnapshot2(runRoot, WORKFLOW_RUN_LOCK_PATH, maxBytes);
    } catch (error) {
      const diagnosis2 = {
        status: "unknown",
        owner: null,
        identity: null,
        reason: safeErrorMessage(error)
      };
      throw new WorkflowRunLockBlockedError(
        lockFinding(operation2, diagnosis2),
        diagnosis2
      );
    }
    if (!snapshot || snapshot.owner.ownerToken !== owner.ownerToken || snapshot.owner.operation !== owner.operation) {
      throw new WorkflowRunLockBlockedError(
        createWorkflowFinding({
          code: "run-lock-unknown",
          severity: "error",
          message: "Workflow Run lock changed while ownership was published.",
          path: WORKFLOW_RUN_LOCK_PATH,
          requiredAction: "stop"
        }),
        diagnosisFromSnapshot(snapshot)
      );
    }
    const handle = {
      file: snapshot.file,
      owner,
      identity: snapshot.identity,
      ...takeover ? { takeover } : {},
      async release() {
        await releaseLock(runRoot, handle);
      }
    };
    await holdLockForTests();
    return handle;
  }
  throw blocked(operation2, {
    status: "unknown",
    owner: null,
    identity: null,
    reason: "Workflow Run lock publication raced repeatedly"
  });
}
async function recordWorkflowRunLockTakeover(runRoot, evidence, maxBytes = WORKFLOW_RUN_LOCK_MAX_BYTES) {
  const parsed = parseWorkflowRunLockTakeoverEvidence(evidence);
  const raw = await readOptionalEngineRunText(
    runRoot,
    WORKFLOW_RUN_LOCK_RECOVERY_PATH,
    validateMaxBytes(maxBytes),
    "Workflow Run lock recovery evidence"
  );
  const lines = (raw ?? "").split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length >= MAX_LOCK_EVENTS) {
    throw new WorkflowRunLockBlockedError(
      createWorkflowFinding({
        code: "run-lock-unknown",
        severity: "error",
        message: "Workflow Run lock recovery evidence is at its safe bound.",
        path: WORKFLOW_RUN_LOCK_RECOVERY_PATH,
        requiredAction: "stop"
      }),
      { status: "unknown", owner: null, identity: null }
    );
  }
  try {
    for (const line of lines) {
      parseWorkflowRunLockTakeoverEvidence(JSON.parse(line));
    }
  } catch (error) {
    const diagnosis = {
      status: "unknown",
      owner: null,
      identity: null,
      reason: safeErrorMessage(error)
    };
    throw new WorkflowRunLockBlockedError(
      lockFinding("workflow.recover", diagnosis),
      diagnosis
    );
  }
  await appendEngineRunText(
    runRoot,
    WORKFLOW_RUN_LOCK_RECOVERY_PATH,
    `${JSON.stringify(stableValue(parsed))}
`,
    validateMaxBytes(maxBytes),
    "Workflow Run lock recovery evidence"
  );
}

// src/workflow-runtime/checkpoints.ts
import { randomUUID as randomUUID6 } from "node:crypto";
import { promises as fs9 } from "node:fs";
import path15 from "node:path";
var WORKFLOW_CHECKPOINT_DIRECTORY = ".comet/checkpoints";
var WORKFLOW_CHECKPOINT_INDEX_PATH = ".comet/checkpoints/index.json";
var WORKFLOW_CHECKPOINT_MANIFEST_DIRECTORY = ".comet/checkpoints/manifests";
var WORKFLOW_CHECKPOINT_RECORD_DIRECTORY = ".comet/checkpoints/records";
var WORKFLOW_CHECKPOINT_CONTENT_DIRECTORY = ".comet/checkpoints/content";
var WORKFLOW_CHECKPOINT_RECOVERY_JOURNAL_PATH = ".comet/checkpoint-recovery-journal.json";
var WORKFLOW_CHECKPOINT_SCHEMA_VERSION = 1;
var WORKFLOW_CHECKPOINT_RECOVERY_SCHEMA_VERSION = 1;
var STATE_PATH2 = ".comet/run-state.json";
var PENDING_PATH = ".comet/pending-action.json";
var ARTIFACTS_PATH = ".comet/artifacts.json";
var CONTEXT_PATH = ".comet/context.md";
var TRAJECTORY_PATH = ".comet/trajectory.jsonl";
var TRANSITION_JOURNAL_PATH = ".comet/transition-journal.json";
var HASH_PATTERN5 = /^[a-f0-9]{64}$/u;
var MAX_IDENTIFIER_LENGTH3 = 256;
var MAX_CHECKPOINT_ENTRIES = 256;
var MAX_RECOVERY_RECORDS = 8;
var TRAJECTORY_EVENT_TYPES2 = /* @__PURE__ */ new Set([
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
var configuredFault4;
function isRecord14(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function assertKnownFields9(value, keys, label) {
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) throw new Error(`Invalid ${label}: unknown field ${unknown}`);
}
function boundedText5(value, key, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH3 || /[\u0000\r\n]/u.test(value)) {
    throw new Error(`Invalid ${label}: ${key} must be a bounded string`);
  }
  return value;
}
function timestamp5(value, key, label) {
  const result = boundedText5(value, key, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result)) {
    throw new Error(`Invalid ${label}: ${key} must be an ISO timestamp`);
  }
  return result;
}
function nonNegativeInteger8(value, key, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}: ${key} must be a non-negative integer`);
  }
  return value;
}
function positiveInteger2(value, key, label) {
  const result = nonNegativeInteger8(value, key, label);
  if (result < 1) throw new Error(`Invalid ${label}: ${key} must be positive`);
  return result;
}
function hash3(value, key, label) {
  const result = boundedText5(value, key, label);
  if (!HASH_PATTERN5.test(result)) {
    throw new Error(`Invalid ${label}: ${key} must be a SHA-256 hash`);
  }
  return result;
}
function nullableHash3(value, key, label) {
  return value === null ? null : hash3(value, key, label);
}
function safePath(value, key, label) {
  const result = boundedText5(value, key, label);
  return normalizeWorkflowRelativePath(result, `${label}: ${key}`);
}
function canonical(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}
`;
}
function canonicalHash2(value) {
  return sha256(JSON.stringify(stableValue(value)));
}
function contentAddressHash(value) {
  if (isRecord14(value) && value.kind === "workflow-checkpoint-manifest") {
    const { manifestHash: _manifestHash, ...withoutHash } = value;
    return canonicalHash2(withoutHash);
  }
  if (isRecord14(value) && value.kind === "workflow-checkpoint-record") {
    const { recordHash: _recordHash, ...withoutHash } = value;
    return canonicalHash2(withoutHash);
  }
  return canonicalHash2(value);
}
function contentIdentity(content) {
  if (content === null) return { exists: false, bytes: 0, sha256: null };
  const bytes = Buffer.byteLength(content, "utf8");
  return { exists: true, bytes, sha256: sha256(Buffer.from(content, "utf8")) };
}
function identityOf4(value) {
  return {
    path: value.path,
    exists: value.exists,
    bytes: value.bytes,
    sha256: value.sha256
  };
}
function sameIdentity2(left, right) {
  return left.path === right.path && left.exists === right.exists && left.bytes === right.bytes && left.sha256 === right.sha256;
}
function sameStableValue3(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}
function sameActionDefinition(action, step) {
  if (action.repair) {
    return action.type === "ask_user" && action.stepId !== null && action.repair.stepId === action.stepId && action.repair.actionId === action.id && action.repair.decisionId === action.decisionId && action.repair.signatureHash.length === 64;
  }
  return action.type === step.action.type && action.ref === step.action.ref && action.prompt === step.action.prompt && action.question === step.action.question && sameStableValue3(action.options, step.action.options) && action.decisionId === step.action.decisionId && sameStableValue3(action.choices, step.action.choices) && sameStableValue3(action.requiredInputs, step.action.requiredInputs) && sameStableValue3(action.rationale, step.action.rationale) && sameStableValue3(action.reviewer, step.action.reviewer);
}
function contentPathFor(hashValue4) {
  return `${WORKFLOW_CHECKPOINT_CONTENT_DIRECTORY}/${hashValue4}.txt`;
}
function manifestPathFor(hashValue4) {
  return `${WORKFLOW_CHECKPOINT_MANIFEST_DIRECTORY}/${hashValue4}.json`;
}
function recordPathFor(hashValue4) {
  return `${WORKFLOW_CHECKPOINT_RECORD_DIRECTORY}/${hashValue4}.json`;
}
function checkpointBounds(profile) {
  const parsed = parseWorkflowDurabilityProfile(profile);
  if (!parsed.capabilities.includes("verified-checkpoints")) {
    throw new Error(
      "Workflow durability profile has no verified checkpoint capability"
    );
  }
  const manifestBytes = parsed.bounds.checkpointManifestBytes;
  const recordBytes = parsed.bounds.checkpointRecordBytes;
  const count = parsed.bounds.checkpointCount;
  if (manifestBytes === void 0 || recordBytes === void 0 || count === void 0) {
    throw new Error("Workflow checkpoint bounds are missing");
  }
  return { manifestBytes, recordBytes, count };
}
function maxBytesForPath(profile, relativePath2) {
  if (relativePath2 === STATE_PATH2) return profile.bounds.runStateBytes;
  if (relativePath2 === PENDING_PATH) return profile.bounds.pendingActionBytes;
  if (relativePath2 === TRAJECTORY_PATH) return profile.bounds.trajectoryBytes;
  if (relativePath2 === ARTIFACTS_PATH) return profile.bounds.artifactsBytes;
  return Math.max(profile.bounds.runStateBytes, profile.bounds.artifactsBytes);
}
function parseExecutionIdentity2(value, label) {
  if (!isRecord14(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields9(
    value,
    /* @__PURE__ */ new Set([
      "protocolHash",
      "packageHash",
      "snapshotHash",
      "nodeToStep",
      "capabilityVersion",
      "resolverHash",
      "findingCatalogVersion",
      "durabilityProfile"
    ]),
    label
  );
  if (!value.nodeToStep || typeof value.nodeToStep !== "object" || Array.isArray(value.nodeToStep)) {
    throw new Error(`Invalid ${label}: nodeToStep is invalid`);
  }
  const nodeToStep = {};
  for (const [nodeId, stepId2] of Object.entries(value.nodeToStep)) {
    if (!nodeId || typeof stepId2 !== "string" || stepId2.length === 0) {
      throw new Error(`Invalid ${label}: nodeToStep is invalid`);
    }
    nodeToStep[nodeId] = stepId2;
  }
  if (value.capabilityVersion !== void 0 && value.capabilityVersion !== 3) {
    throw new Error(`Invalid ${label}: capabilityVersion is invalid`);
  }
  if (value.findingCatalogVersion !== void 0 && value.findingCatalogVersion !== 1) {
    throw new Error(`Invalid ${label}: findingCatalogVersion is invalid`);
  }
  const identity = {
    protocolHash: hash3(value.protocolHash, "protocolHash", label),
    packageHash: hash3(value.packageHash, "packageHash", label),
    snapshotHash: hash3(value.snapshotHash, "snapshotHash", label),
    nodeToStep,
    ...value.capabilityVersion === 3 ? { capabilityVersion: 3 } : {},
    ...value.resolverHash !== void 0 ? { resolverHash: hash3(value.resolverHash, "resolverHash", label) } : {},
    ...value.findingCatalogVersion === 1 ? { findingCatalogVersion: 1 } : {}
  };
  if (value.durabilityProfile !== void 0) {
    identity.durabilityProfile = parseWorkflowDurabilityProfile(
      value.durabilityProfile
    );
  }
  return identity;
}
function parseMaterialIdentity3(value, label) {
  if (!isRecord14(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields9(
    value,
    /* @__PURE__ */ new Set(["path", "exists", "bytes", "sha256"]),
    label
  );
  const pathValue = safePath(value.path, "path", label);
  if (typeof value.exists !== "boolean") {
    throw new Error(`Invalid ${label}: exists must be a boolean`);
  }
  const bytes = nonNegativeInteger8(value.bytes, "bytes", label);
  const digest = nullableHash3(value.sha256, "sha256", label);
  if (!value.exists && (bytes !== 0 || digest !== null) || value.exists && (bytes < 1 || digest === null)) {
    throw new Error(`Invalid ${label}: identity is inconsistent`);
  }
  return { path: pathValue, exists: value.exists, bytes, sha256: digest };
}
function parseMaterialReference(value, label) {
  if (!isRecord14(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields9(
    value,
    /* @__PURE__ */ new Set(["path", "contentPath", "exists", "bytes", "sha256"]),
    label
  );
  const { contentPath: rawContentPath, ...material } = value;
  const identity = parseMaterialIdentity3(material, label);
  const contentPath = rawContentPath === null ? null : safePath(rawContentPath, "contentPath", label);
  if (!identity.exists && contentPath !== null) {
    throw new Error(`Invalid ${label}: missing material cannot have content`);
  }
  if (identity.exists && (contentPath === null || contentPath !== contentPathFor(identity.sha256))) {
    throw new Error(`Invalid ${label}: contentPath is not content-addressed`);
  }
  return { ...identity, contentPath };
}
function parsePendingActionIdentity(value, label) {
  if (!isRecord14(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields9(
    value,
    /* @__PURE__ */ new Set(["id", "path", "exists", "bytes", "sha256"]),
    label
  );
  const { id, ...material } = value;
  return {
    id: boundedText5(id, "id", label),
    ...parseMaterialIdentity3(material, label)
  };
}
function parseTrajectoryIdentity(value, label) {
  if (!isRecord14(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields9(
    value,
    /* @__PURE__ */ new Set(["path", "exists", "bytes", "sha256", "offset", "prefixSha256"]),
    label
  );
  const {
    offset: rawOffset,
    prefixSha256: rawPrefixSha256,
    ...material
  } = value;
  const identity = parseMaterialIdentity3(material, label);
  const offset = nonNegativeInteger8(rawOffset, "offset", label);
  const prefixSha256 = hash3(rawPrefixSha256, "prefixSha256", label);
  if (!identity.exists || offset > identity.bytes) {
    throw new Error(`Invalid ${label}: offset is inconsistent`);
  }
  return { ...identity, offset, prefixSha256 };
}
function parseArtifactVersionReference(value, label) {
  if (!isRecord14(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields9(
    value,
    /* @__PURE__ */ new Set(["artifactId", "versionId", "path", "contentHash", "bytes"]),
    label
  );
  return {
    artifactId: boundedText5(value.artifactId, "artifactId", label),
    versionId: boundedText5(value.versionId, "versionId", label),
    path: safePath(value.path, "path", label),
    contentHash: hash3(value.contentHash, "contentHash", label),
    bytes: positiveInteger2(value.bytes, "bytes", label)
  };
}
function parseCheckpointManifest(value, bounds) {
  const label = "Workflow checkpoint manifest";
  if (!isRecord14(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields9(
    value,
    /* @__PURE__ */ new Set([
      "schemaVersion",
      "kind",
      "manifestHash",
      "runId",
      "revision",
      "execution",
      "pendingAction",
      "nodeId",
      "cycleId",
      "attemptId",
      "state",
      "context",
      "artifacts",
      "trajectory",
      "artifactVersions",
      "createdAt"
    ]),
    label
  );
  if (value.schemaVersion !== WORKFLOW_CHECKPOINT_SCHEMA_VERSION || value.kind !== "workflow-checkpoint-manifest") {
    throw new Error(`Invalid ${label}: schema identity is invalid`);
  }
  const artifactVersions = value.artifactVersions;
  if (!Array.isArray(artifactVersions) || artifactVersions.length > MAX_CHECKPOINT_ENTRIES) {
    throw new Error(`Invalid ${label}: artifactVersions are outside the bound`);
  }
  const parsed = {
    schemaVersion: WORKFLOW_CHECKPOINT_SCHEMA_VERSION,
    kind: "workflow-checkpoint-manifest",
    manifestHash: hash3(value.manifestHash, "manifestHash", label),
    runId: boundedText5(value.runId, "runId", label),
    revision: nonNegativeInteger8(value.revision, "revision", label),
    execution: parseExecutionIdentity2(value.execution, `${label}.execution`),
    pendingAction: value.pendingAction === null ? null : parsePendingActionIdentity(
      value.pendingAction,
      `${label}.pendingAction`
    ),
    nodeId: value.nodeId === null ? null : boundedText5(value.nodeId, "nodeId", label),
    cycleId: value.cycleId === null ? null : boundedText5(value.cycleId, "cycleId", label),
    attemptId: value.attemptId === null ? null : boundedText5(value.attemptId, "attemptId", label),
    state: parseMaterialIdentity3(value.state, `${label}.state`),
    context: parseMaterialIdentity3(value.context, `${label}.context`),
    artifacts: parseMaterialIdentity3(value.artifacts, `${label}.artifacts`),
    trajectory: parseTrajectoryIdentity(
      value.trajectory,
      `${label}.trajectory`
    ),
    artifactVersions: artifactVersions.map(
      (entry, index) => parseArtifactVersionReference(
        entry,
        `${label}.artifactVersions[${index}]`
      )
    ),
    createdAt: timestamp5(value.createdAt, "createdAt", label)
  };
  if (Buffer.byteLength(canonical(parsed), "utf8") > bounds.manifestBytes) {
    throw new Error(`Invalid ${label}: exceeds ${bounds.manifestBytes} bytes`);
  }
  return parsed;
}
function parseCheckpointRecord(value, bounds) {
  const label = "Workflow checkpoint record";
  if (!isRecord14(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields9(
    value,
    /* @__PURE__ */ new Set([
      "schemaVersion",
      "kind",
      "recordHash",
      "runId",
      "revision",
      "manifestHash",
      "state",
      "pendingAction",
      "context",
      "artifacts",
      "trajectory"
    ]),
    label
  );
  if (value.schemaVersion !== WORKFLOW_CHECKPOINT_SCHEMA_VERSION || value.kind !== "workflow-checkpoint-record") {
    throw new Error(`Invalid ${label}: schema identity is invalid`);
  }
  const parsed = {
    schemaVersion: WORKFLOW_CHECKPOINT_SCHEMA_VERSION,
    kind: "workflow-checkpoint-record",
    recordHash: hash3(value.recordHash, "recordHash", label),
    runId: boundedText5(value.runId, "runId", label),
    revision: nonNegativeInteger8(value.revision, "revision", label),
    manifestHash: hash3(value.manifestHash, "manifestHash", label),
    state: parseMaterialReference(value.state, `${label}.state`),
    pendingAction: parseMaterialReference(
      value.pendingAction,
      `${label}.pendingAction`
    ),
    context: parseMaterialReference(value.context, `${label}.context`),
    artifacts: parseMaterialReference(value.artifacts, `${label}.artifacts`),
    trajectory: parseMaterialReference(value.trajectory, `${label}.trajectory`)
  };
  if (Buffer.byteLength(canonical(parsed), "utf8") > bounds.recordBytes) {
    throw new Error(`Invalid ${label}: exceeds ${bounds.recordBytes} bytes`);
  }
  return parsed;
}
function parseCheckpointIndex(value, bounds) {
  const label = "Workflow checkpoint index";
  if (!isRecord14(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields9(
    value,
    /* @__PURE__ */ new Set(["schemaVersion", "kind", "runId", "records"]),
    label
  );
  if (value.schemaVersion !== WORKFLOW_CHECKPOINT_SCHEMA_VERSION || value.kind !== "workflow-checkpoint-index") {
    throw new Error(`Invalid ${label}: schema identity is invalid`);
  }
  if (!Array.isArray(value.records) || value.records.length > (bounds?.count ?? MAX_CHECKPOINT_ENTRIES)) {
    throw new Error(`Invalid ${label}: records are outside the bound`);
  }
  const records = value.records.map((entry, index) => {
    if (!isRecord14(entry)) {
      throw new Error(`Invalid ${label}: records[${index}] must be an object`);
    }
    assertKnownFields9(
      entry,
      /* @__PURE__ */ new Set(["recordHash", "manifestHash", "revision"]),
      label
    );
    return {
      recordHash: hash3(entry.recordHash, "recordHash", label),
      manifestHash: hash3(entry.manifestHash, "manifestHash", label),
      revision: nonNegativeInteger8(entry.revision, "revision", label)
    };
  });
  const recordKeys = /* @__PURE__ */ new Set();
  const manifestHashes = /* @__PURE__ */ new Set();
  for (const record of records) {
    if (recordKeys.has(record.recordHash) || manifestHashes.has(record.manifestHash)) {
      throw new Error(`Invalid ${label}: duplicate record identity`);
    }
    recordKeys.add(record.recordHash);
    manifestHashes.add(record.manifestHash);
  }
  records.sort(
    (left, right) => right.revision - left.revision || left.recordHash.localeCompare(right.recordHash)
  );
  return {
    schemaVersion: WORKFLOW_CHECKPOINT_SCHEMA_VERSION,
    kind: "workflow-checkpoint-index",
    runId: boundedText5(value.runId, "runId", label),
    records
  };
}
function parseRecoveryJournal(value, bounds) {
  const label = "Workflow checkpoint recovery journal";
  if (!isRecord14(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields9(
    value,
    /* @__PURE__ */ new Set([
      "schemaVersion",
      "kind",
      "status",
      "journalId",
      "runId",
      "execution",
      "checkpointRecordHash",
      "records",
      "recoveryEvent",
      "createdAt",
      "committedAt"
    ]),
    label
  );
  if (value.schemaVersion !== WORKFLOW_CHECKPOINT_RECOVERY_SCHEMA_VERSION || value.kind !== "workflow-checkpoint-recovery-journal" || value.status !== "prepared" && value.status !== "committed") {
    throw new Error(`Invalid ${label}: schema identity is invalid`);
  }
  if (!Array.isArray(value.records) || value.records.length === 0 || value.records.length > MAX_RECOVERY_RECORDS) {
    throw new Error(`Invalid ${label}: records are outside the bound`);
  }
  const records = value.records.map(
    (entry, index) => {
      if (!isRecord14(entry)) {
        throw new Error(
          `Invalid ${label}: records[${index}] must be an object`
        );
      }
      assertKnownFields9(
        entry,
        /* @__PURE__ */ new Set(["path", "previous", "intended", "contentPath"]),
        label
      );
      const intended = parseMaterialIdentity3(
        entry.intended,
        `${label}.intended`
      );
      const contentPath = entry.contentPath === null ? null : safePath(entry.contentPath, "contentPath", label);
      if (intended.exists && contentPath !== contentPathFor(intended.sha256)) {
        throw new Error(`Invalid ${label}: intended content is not addressed`);
      }
      if (!intended.exists && contentPath !== null) {
        throw new Error(
          `Invalid ${label}: missing intended content is addressed`
        );
      }
      const pathValue = safePath(entry.path, "path", label);
      const previous = parseMaterialIdentity3(
        entry.previous,
        `${label}.previous`
      );
      if (previous.path !== pathValue || intended.path !== pathValue) {
        throw new Error(`Invalid ${label}: record path identity is invalid`);
      }
      return { path: pathValue, previous, intended, contentPath };
    }
  );
  records.sort((left, right) => left.path.localeCompare(right.path));
  const recoveryPaths = /* @__PURE__ */ new Set([
    STATE_PATH2,
    PENDING_PATH,
    CONTEXT_PATH,
    ARTIFACTS_PATH,
    TRAJECTORY_PATH
  ]);
  if (records.some((record) => !recoveryPaths.has(record.path)) || new Set(records.map((record) => record.path)).size !== records.length || records.length !== recoveryPaths.size || [...recoveryPaths].some(
    (pathValue) => !records.some((record) => record.path === pathValue)
  )) {
    throw new Error(`Invalid ${label}: recovery path is not a Run record`);
  }
  const recoveryEvent2 = parseTrajectoryEvent2(value.recoveryEvent, label);
  if (recoveryEvent2.type !== "recovery_reconciled") {
    throw new Error(`Invalid ${label}: recoveryEvent type is invalid`);
  }
  const parsed = {
    schemaVersion: WORKFLOW_CHECKPOINT_RECOVERY_SCHEMA_VERSION,
    kind: "workflow-checkpoint-recovery-journal",
    status: value.status,
    journalId: boundedText5(value.journalId, "journalId", label),
    runId: boundedText5(value.runId, "runId", label),
    execution: parseExecutionIdentity2(value.execution, `${label}.execution`),
    checkpointRecordHash: hash3(
      value.checkpointRecordHash,
      "checkpointRecordHash",
      label
    ),
    records,
    recoveryEvent: recoveryEvent2,
    createdAt: timestamp5(value.createdAt, "createdAt", label),
    ...value.committedAt === void 0 ? {} : { committedAt: timestamp5(value.committedAt, "committedAt", label) }
  };
  if (parsed.status === "committed" !== (parsed.committedAt !== void 0) || parsed.recoveryEvent.runId !== parsed.runId || Buffer.byteLength(canonical(parsed), "utf8") > bounds.recordBytes) {
    throw new Error(`Invalid ${label}: evidence is inconsistent or oversized`);
  }
  return parsed;
}
function parseTrajectoryEvent2(value, label) {
  if (!isRecord14(value))
    throw new Error(`Invalid ${label}: event must be an object`);
  assertKnownFields9(
    value,
    /* @__PURE__ */ new Set(["sequence", "timestamp", "type", "runId", "data"]),
    label
  );
  const sequence = positiveInteger2(value.sequence, "sequence", label);
  const type = value.type;
  if (typeof type !== "string" || !TRAJECTORY_EVENT_TYPES2.has(type)) {
    throw new Error(`Invalid ${label}: event type is invalid`);
  }
  if (!isRecord14(value.data))
    throw new Error(`Invalid ${label}: event data is invalid`);
  return {
    sequence,
    timestamp: timestamp5(value.timestamp, "timestamp", label),
    type,
    runId: boundedText5(value.runId, "runId", label),
    data: value.data
  };
}
function parseTrajectory2(raw, runId) {
  const events = [];
  let expectedSequence = 1;
  for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    if (line.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `Invalid checkpoint trajectory event at line ${index + 1}`,
        {
          cause: error
        }
      );
    }
    const event = parseTrajectoryEvent2(
      parsed,
      `checkpoint trajectory line ${index + 1}`
    );
    if (event.sequence !== expectedSequence || event.runId !== runId) {
      throw new Error(
        `Invalid checkpoint trajectory sequence at line ${index + 1}`
      );
    }
    events.push(event);
    expectedSequence += 1;
  }
  if (events.length === 0)
    throw new Error("Invalid checkpoint trajectory: no events");
  return events;
}
function validateArtifactContent(raw) {
  if (raw === null) return;
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error("Workflow checkpoint artifacts are not valid JSON", {
      cause: error
    });
  }
  if (!isRecord14(value)) {
    throw new Error("Workflow checkpoint artifacts are not an object");
  }
  for (const [key, artifact] of Object.entries(value)) {
    if (!key || typeof artifact !== "string") {
      throw new Error("Workflow checkpoint artifacts contain an invalid entry");
    }
  }
}
function validateTrajectorySemantics(events, state, pending) {
  const proposals = /* @__PURE__ */ new Map();
  const completed = /* @__PURE__ */ new Set();
  for (const event of events) {
    if (event.type === "action_proposed") {
      if (!isRecord14(event.data.action)) {
        throw new Error("Workflow checkpoint action proposal is invalid");
      }
      const action2 = parsePendingActionValue(event.data.action);
      if (proposals.has(action2.id)) {
        throw new Error("Workflow checkpoint action proposal is duplicated");
      }
      proposals.set(action2.id, action2);
      continue;
    }
    if (event.type !== "action_completed") continue;
    if (!isRecord14(event.data.action) || !isRecord14(event.data.outcome)) {
      throw new Error("Workflow checkpoint action completion is invalid");
    }
    const action = parsePendingActionValue(event.data.action);
    const outcome = event.data.outcome;
    if (typeof outcome.actionId !== "string" || outcome.actionId !== action.id || outcome.status !== "succeeded" && outcome.status !== "failed" || typeof outcome.summary !== "string" || outcome.summary.length === 0) {
      throw new Error("Workflow checkpoint action outcome is invalid");
    }
    if (!proposals.has(action.id) || completed.has(action.id)) {
      throw new Error(
        "Workflow checkpoint action completion is not attributable"
      );
    }
    completed.add(action.id);
  }
  if (completed.size !== (state.workflowRuntime?.revision ?? 0)) {
    throw new Error("Workflow checkpoint trajectory revision is invalid");
  }
  for (const actionId2 of proposals.keys()) {
    if (!completed.has(actionId2) && actionId2 !== pending?.id) {
      throw new Error(
        "Workflow checkpoint trajectory has an uncommitted action"
      );
    }
  }
  if (pending && !proposals.has(pending.id)) {
    throw new Error("Workflow checkpoint pending action has no proposal");
  }
}
async function readRaw(runRoot, relativePath2, maxBytes, label) {
  return readOptionalEngineRunText(runRoot, relativePath2, maxBytes, label);
}
async function readMaterial2(runRoot, relativePath2, maxBytes, label) {
  const content = await readRaw(runRoot, relativePath2, maxBytes, label);
  return {
    content,
    identity: { path: relativePath2, ...contentIdentity(content) }
  };
}
async function readReferencedContent(runRoot, reference, maxBytes, label) {
  if (!reference.exists || reference.contentPath === null) return null;
  const content = await readRaw(
    runRoot,
    reference.contentPath,
    maxBytes,
    label
  );
  if (content === null) throw new Error(`${label} content is missing`);
  const identity = contentIdentity(content);
  if (!identity.exists || identity.bytes !== reference.bytes || identity.sha256 !== reference.sha256) {
    throw new Error(`${label} content identity is invalid`);
  }
  return content;
}
async function publishContent(runRoot, reference, content, maxBytes) {
  if (!reference.contentPath)
    throw new Error("Cannot publish missing checkpoint content");
  await ensureProtectedProjectDirectory(
    runRoot,
    WORKFLOW_CHECKPOINT_CONTENT_DIRECTORY,
    {
      label: "Workflow checkpoint content"
    }
  );
  const existing = await readRaw(
    runRoot,
    reference.contentPath,
    maxBytes,
    "Workflow checkpoint content"
  );
  if (existing !== null) {
    if (existing !== content)
      throw new Error("Workflow checkpoint content identity changed");
    return;
  }
  try {
    await writeEngineRunText(
      runRoot,
      reference.contentPath,
      content,
      maxBytes,
      "Workflow checkpoint content",
      { exclusive: true, maxBytes }
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const raced = await readRaw(
      runRoot,
      reference.contentPath,
      maxBytes,
      "Workflow checkpoint content"
    );
    if (raced !== content) throw error;
  }
}
async function publishJson(runRoot, relativePath2, value, maxBytes, label) {
  const content = canonical(value);
  const existing = await readRaw(runRoot, relativePath2, maxBytes, label);
  if (existing !== null) {
    if (relativePath2 === WORKFLOW_CHECKPOINT_INDEX_PATH) {
      await writeEngineRunText(
        runRoot,
        relativePath2,
        content,
        maxBytes,
        label,
        {
          maxBytes
        }
      );
      return;
    }
    if (existing !== content)
      throw new Error(`${label} content identity changed`);
    return;
  }
  try {
    await writeEngineRunText(runRoot, relativePath2, content, maxBytes, label, {
      exclusive: true,
      maxBytes
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const raced = await readRaw(runRoot, relativePath2, maxBytes, label);
    if (raced !== content) throw error;
  }
}
async function captureMaterial(runRoot, relativePath2, maxBytes, label) {
  const material = await readMaterial2(runRoot, relativePath2, maxBytes, label);
  if (material.content === null) {
    return {
      content: null,
      reference: { ...material.identity, contentPath: null }
    };
  }
  return {
    content: material.content,
    reference: {
      ...material.identity,
      contentPath: contentPathFor(material.identity.sha256)
    }
  };
}
async function physicalArtifactBytes(runRoot, protocol, version, maxBytes) {
  await validateWorkflowArtifactVersion(runRoot, protocol, version);
  const inspection = await inspectProtectedProjectPath(runRoot, version.path, {
    label: `Workflow checkpoint artifact ${version.id}`,
    expected: "any"
  });
  if (!inspection.exists)
    throw new Error(`Workflow checkpoint artifact is missing: ${version.id}`);
  if (inspection.kind === "file") {
    return (await readProtectedProjectFile(runRoot, version.path, maxBytes, {
      label: `Workflow checkpoint artifact ${version.id}`
    })).bytes.length;
  }
  let total = 0;
  async function walk(relativePath2) {
    const current = await inspectProtectedProjectPath(runRoot, relativePath2, {
      label: `Workflow checkpoint artifact ${version.id}`,
      expected: "directory"
    });
    for (const entry of (await fs9.readdir(current.target, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const child = path15.posix.join(relativePath2, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Workflow checkpoint artifact crosses a symbolic link: ${child}`
        );
      }
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      if (!entry.isFile())
        throw new Error(
          `Workflow checkpoint artifact has an invalid entry: ${child}`
        );
      total += (await readProtectedProjectFile(runRoot, child, maxBytes, {
        label: `Workflow checkpoint artifact ${version.id}`
      })).bytes.length;
      if (total > maxBytes)
        throw new Error(
          `Workflow checkpoint artifact exceeds ${maxBytes} bytes`
        );
    }
  }
  await walk(version.path);
  return total;
}
async function artifactVersionReferences(runRoot, pkg, state, profile) {
  const versions = state.workflowRuntime?.artifactVersions ?? [];
  if (!pkg.runtime)
    throw new Error("Workflow checkpoint package has no runtime");
  validateWorkflowArtifactState(
    pkg.runtime.protocol,
    state.runId,
    state.runtimeIdentity?.nodeToStep ?? {},
    state.workflowRuntime
  );
  const references = [];
  for (const version of versions) {
    const bytes = await physicalArtifactBytes(
      runRoot,
      pkg.runtime.protocol,
      version,
      profile.bounds.artifactsBytes
    );
    references.push({
      artifactId: version.artifactId,
      versionId: version.id,
      path: version.path,
      contentHash: version.contentHash,
      bytes
    });
  }
  return references.sort(
    (left, right) => left.artifactId.localeCompare(right.artifactId) || left.versionId.localeCompare(right.versionId)
  );
}
function currentNodeIdentity(state, identity, pending) {
  const step = pending?.stepId ?? state.currentStep;
  if (!step) return null;
  return Object.entries(identity.nodeToStep).find(
    ([, stepId2]) => stepId2 === step
  )?.[0] ?? null;
}
async function buildCheckpoint(options) {
  const bounds = checkpointBounds(options.profile);
  const stateMaterial = await captureMaterial(
    options.runRoot,
    STATE_PATH2,
    options.profile.bounds.runStateBytes,
    "Workflow checkpoint state"
  );
  if (!stateMaterial.content)
    throw new Error("Workflow checkpoint state is missing");
  const parsedState = parseRunStateValue(
    JSON.parse(stateMaterial.content)
  );
  if (!sameStableValue3(parsedState, options.state))
    throw new Error("Workflow checkpoint state changed during capture");
  const pendingMaterial = await captureMaterial(
    options.runRoot,
    PENDING_PATH,
    options.profile.bounds.pendingActionBytes,
    "Workflow checkpoint pending action"
  );
  const contextMaterial = await captureMaterial(
    options.runRoot,
    CONTEXT_PATH,
    Math.max(
      options.profile.bounds.runStateBytes,
      options.profile.bounds.artifactsBytes
    ),
    "Workflow checkpoint context"
  );
  const artifactsMaterial = await captureMaterial(
    options.runRoot,
    ARTIFACTS_PATH,
    options.profile.bounds.artifactsBytes,
    "Workflow checkpoint artifacts"
  );
  const trajectoryMaterial = await captureMaterial(
    options.runRoot,
    TRAJECTORY_PATH,
    options.profile.bounds.trajectoryBytes,
    "Workflow checkpoint trajectory"
  );
  if (!trajectoryMaterial.content)
    throw new Error("Workflow checkpoint trajectory is missing");
  parseTrajectory2(trajectoryMaterial.content, options.state.runId);
  const trajectoryBytes = Buffer.byteLength(trajectoryMaterial.content, "utf8");
  if (trajectoryBytes !== trajectoryMaterial.reference.bytes)
    throw new Error("Workflow checkpoint trajectory size changed");
  const pending = pendingMaterial.content ? parsePendingActionValue(JSON.parse(pendingMaterial.content)) : null;
  if (Boolean(pending) !== Boolean(options.pending))
    throw new Error(
      "Workflow checkpoint pending action changed during capture"
    );
  if (pending && options.pending && !sameStableValue3(pending, options.pending)) {
    throw new Error(
      "Workflow checkpoint pending action changed during capture"
    );
  }
  if (options.state.pending !== (pending?.id ?? null)) {
    throw new Error("Workflow checkpoint pending action does not match state");
  }
  const artifactVersions = await artifactVersionReferences(
    options.runRoot,
    options.package,
    options.state,
    options.profile
  );
  const runtimeState = options.state.workflowRuntime;
  const manifestWithoutHash = {
    schemaVersion: WORKFLOW_CHECKPOINT_SCHEMA_VERSION,
    kind: "workflow-checkpoint-manifest",
    runId: options.state.runId,
    revision: runtimeState?.revision ?? 0,
    execution: structuredClone(options.identity),
    pendingAction: pending ? { id: pending.id, ...identityOf4(pendingMaterial.reference) } : null,
    nodeId: currentNodeIdentity(options.state, options.identity, pending),
    cycleId: runtimeState?.currentCycle?.id ?? runtimeState?.currentAttempt?.cycleId ?? null,
    attemptId: runtimeState?.currentAttempt?.id ?? null,
    state: identityOf4(stateMaterial.reference),
    context: identityOf4(contextMaterial.reference),
    artifacts: identityOf4(artifactsMaterial.reference),
    trajectory: {
      ...identityOf4(trajectoryMaterial.reference),
      offset: trajectoryBytes,
      prefixSha256: sha256(Buffer.from(trajectoryMaterial.content, "utf8"))
    },
    artifactVersions,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  const manifest = {
    ...manifestWithoutHash,
    manifestHash: canonicalHash2(manifestWithoutHash)
  };
  parseCheckpointManifest(manifest, bounds);
  const recordWithoutHash = {
    schemaVersion: WORKFLOW_CHECKPOINT_SCHEMA_VERSION,
    kind: "workflow-checkpoint-record",
    runId: options.state.runId,
    revision: manifest.revision,
    manifestHash: manifest.manifestHash,
    state: stateMaterial.reference,
    pendingAction: pendingMaterial.reference,
    context: contextMaterial.reference,
    artifacts: artifactsMaterial.reference,
    trajectory: trajectoryMaterial.reference
  };
  const record = {
    ...recordWithoutHash,
    recordHash: canonicalHash2(recordWithoutHash)
  };
  parseCheckpointRecord(record, bounds);
  return {
    manifest,
    record,
    contents: new Map(
      [
        stateMaterial,
        pendingMaterial,
        contextMaterial,
        artifactsMaterial,
        trajectoryMaterial
      ].filter(
        (material) => material.content !== null
      ).map((material) => [material.reference.contentPath, material.content])
    )
  };
}
async function readIndexWithBounds(runRoot, profile) {
  const bounds = profile ? checkpointBounds(profile) : void 0;
  const raw = await readRaw(
    runRoot,
    WORKFLOW_CHECKPOINT_INDEX_PATH,
    bounds?.recordBytes ?? 16 * 1024 * 1024,
    "Workflow checkpoint index"
  );
  if (raw === null) return null;
  if (Buffer.byteLength(raw, "utf8") > (bounds?.recordBytes ?? 16 * 1024 * 1024)) {
    throw new Error("Workflow checkpoint index is oversized");
  }
  return parseCheckpointIndex(JSON.parse(raw), bounds);
}
async function readAddressedJson(runRoot, relativePath2, expectedHash, maxBytes, label) {
  const raw = await readRaw(runRoot, relativePath2, maxBytes, label);
  if (raw === null) throw new Error(`${label} is missing`);
  const value = JSON.parse(raw);
  if (contentAddressHash(value) !== expectedHash)
    throw new Error(`${label} content address is invalid`);
  return value;
}
async function readRecordAndManifest(runRoot, profile, entry) {
  const bounds = checkpointBounds(profile);
  const recordValue = await readAddressedJson(
    runRoot,
    recordPathFor(entry.recordHash),
    entry.recordHash,
    bounds.recordBytes,
    "Workflow checkpoint record"
  );
  const record = parseCheckpointRecord(recordValue, bounds);
  if (record.manifestHash !== entry.manifestHash || record.revision !== entry.revision) {
    throw new Error("Workflow checkpoint record index identity is invalid");
  }
  const manifestValue = await readAddressedJson(
    runRoot,
    manifestPathFor(entry.manifestHash),
    entry.manifestHash,
    bounds.manifestBytes,
    "Workflow checkpoint manifest"
  );
  const manifest = parseCheckpointManifest(manifestValue, bounds);
  if (manifest.runId !== record.runId || manifest.revision !== record.revision) {
    throw new Error("Workflow checkpoint manifest identity is invalid");
  }
  if (manifest.manifestHash !== entry.manifestHash || record.recordHash !== entry.recordHash) {
    throw new Error("Workflow checkpoint content address is invalid");
  }
  if (record.state.path !== STATE_PATH2 || record.pendingAction.path !== PENDING_PATH || record.context.path !== CONTEXT_PATH || record.artifacts.path !== ARTIFACTS_PATH || record.trajectory.path !== TRAJECTORY_PATH || manifest.state.path !== STATE_PATH2 || manifest.context.path !== CONTEXT_PATH || manifest.artifacts.path !== ARTIFACTS_PATH || manifest.trajectory.path !== TRAJECTORY_PATH || manifest.pendingAction !== null && manifest.pendingAction.path !== PENDING_PATH) {
    throw new Error("Workflow checkpoint record paths are invalid");
  }
  return { record, manifest };
}
function materialMatchesManifest(reference, identity) {
  return sameIdentity2(identityOf4(reference), identity);
}
async function verifyPackageIdentity(runRoot, state, manifest) {
  if (!state.runtimeIdentity)
    throw new Error("Workflow checkpoint state has no execution identity");
  const identity = state.runtimeIdentity;
  if (!sameStableValue3(identity, manifest.execution)) {
    throw new Error(
      "Workflow checkpoint execution identity does not match state"
    );
  }
  if (state.skillHash !== identity.snapshotHash)
    throw new Error("Workflow checkpoint snapshot identity is invalid");
  const pkg = await readSkillSnapshot(runRoot, state.skillHash);
  if (!pkg.runtime)
    throw new Error("Workflow checkpoint Skill snapshot has no runtime");
  if (pkg.runtime.protocolHash !== identity.protocolHash || !sameStableValue3(pkg.runtime.nodeToStep, identity.nodeToStep) || pkg.runtime.capabilityVersion !== identity.capabilityVersion || pkg.runtime.resolverHash !== identity.resolverHash || pkg.runtime.findingCatalogVersion !== identity.findingCatalogVersion || !sameStableValue3(
    pkg.runtime.durabilityProfile,
    identity.durabilityProfile
  ) || await hashSkillPackage(pkg) !== identity.packageHash) {
    throw new Error("Workflow checkpoint package identity is invalid");
  }
  return { identity, package: pkg };
}
async function invokeFault2(boundary) {
  const configured = process.env.COMET_WORKFLOW_TEST_CHECKPOINT_FAULT_BOUNDARY;
  const value = boundary.path ? `${boundary.phase}:${boundary.path}` : boundary.phase;
  if (configured === boundary.phase || configured === value) {
    throw new Error("deterministic workflow checkpoint fault");
  }
  await configuredFault4?.(boundary);
}
async function readWorkflowCheckpointIndex(runRoot, profile) {
  return readIndexWithBounds(runRoot, parseWorkflowDurabilityProfile(profile));
}
async function readWorkflowCheckpointRecord(runRoot, profile, entry) {
  return (await readRecordAndManifest(runRoot, profile, entry)).record;
}
async function readWorkflowCheckpointProfile(runRoot) {
  const index = await readIndexWithBounds(runRoot);
  if (!index || index.records.length === 0) return void 0;
  for (const entry of index.records) {
    try {
      const raw = await readRaw(
        runRoot,
        manifestPathFor(entry.manifestHash),
        16 * 1024 * 1024,
        "Workflow checkpoint manifest"
      );
      if (raw === null) continue;
      const value = JSON.parse(raw);
      const execution = parseExecutionIdentity2(
        value.execution,
        "Workflow checkpoint manifest execution"
      );
      if (execution.durabilityProfile) return execution.durabilityProfile;
    } catch {
      continue;
    }
  }
  return void 0;
}
async function verifyWorkflowCheckpointCandidate(runRoot, profile, entry, options = {}) {
  const normalizedProfile = parseWorkflowDurabilityProfile(profile);
  const bounds = checkpointBounds(normalizedProfile);
  const { record, manifest } = await readRecordAndManifest(
    runRoot,
    normalizedProfile,
    entry
  );
  if (options.expectedRunId && manifest.runId !== options.expectedRunId) {
    throw new Error("Workflow checkpoint Run identity is invalid");
  }
  if (options.expectedExecution && !sameStableValue3(options.expectedExecution, manifest.execution)) {
    throw new Error("Workflow checkpoint execution identity is invalid");
  }
  for (const [reference, manifestIdentity] of [
    [record.state, manifest.state],
    [record.context, manifest.context],
    [record.artifacts, manifest.artifacts],
    [record.trajectory, manifest.trajectory]
  ]) {
    if (!materialMatchesManifest(reference, manifestIdentity)) {
      throw new Error("Workflow checkpoint material identity is invalid");
    }
  }
  const stateContent = await readReferencedContent(
    runRoot,
    record.state,
    normalizedProfile.bounds.runStateBytes,
    "Workflow checkpoint state content"
  );
  if (stateContent === null)
    throw new Error("Workflow checkpoint state content is missing");
  const pendingContent = await readReferencedContent(
    runRoot,
    record.pendingAction,
    normalizedProfile.bounds.pendingActionBytes,
    "Workflow checkpoint pending action content"
  );
  const contextContent = await readReferencedContent(
    runRoot,
    record.context,
    Math.max(
      normalizedProfile.bounds.runStateBytes,
      normalizedProfile.bounds.artifactsBytes
    ),
    "Workflow checkpoint context content"
  );
  const artifactsContent = await readReferencedContent(
    runRoot,
    record.artifacts,
    normalizedProfile.bounds.artifactsBytes,
    "Workflow checkpoint artifacts content"
  );
  const trajectoryContent = await readReferencedContent(
    runRoot,
    record.trajectory,
    normalizedProfile.bounds.trajectoryBytes,
    "Workflow checkpoint trajectory content"
  );
  if (trajectoryContent === null)
    throw new Error("Workflow checkpoint trajectory content is missing");
  validateArtifactContent(artifactsContent);
  const state = parseRunStateValue(JSON.parse(stateContent));
  if (state.runId !== manifest.runId || state.workflowRuntime?.revision !== manifest.revision) {
    throw new Error("Workflow checkpoint state revision is invalid");
  }
  if (state.pendingRef !== PENDING_PATH || state.trajectoryRef !== TRAJECTORY_PATH || state.contextRef !== CONTEXT_PATH || state.artifactsRef !== ARTIFACTS_PATH) {
    throw new Error("Workflow checkpoint state references are invalid");
  }
  const verifiedPackage = await verifyPackageIdentity(runRoot, state, manifest);
  if (!verifiedPackage.package.runtime)
    throw new Error("Workflow checkpoint package has no runtime");
  if (!sameStableValue3(
    state.runtimeIdentity?.durabilityProfile,
    normalizedProfile
  )) {
    throw new Error("Workflow checkpoint durability profile is invalid");
  }
  const pending = pendingContent ? parsePendingActionValue(JSON.parse(pendingContent)) : null;
  if (Boolean(pending) !== Boolean(state.pending))
    throw new Error("Workflow checkpoint pending state is invalid");
  if (pending && pending.id !== state.pending)
    throw new Error("Workflow checkpoint pending action id is invalid");
  if (pending && state.status !== "waiting" || !pending && state.status === "waiting" || state.status === "completed" && state.currentStep !== null || state.status === "running" && (state.currentStep === null || !Object.values(verifiedPackage.identity.nodeToStep).includes(
    state.currentStep
  ))) {
    throw new Error("Workflow checkpoint Run status is invalid");
  }
  if (pending) {
    if (pending.finalization) {
      const finalization = state.workflowRuntime?.finalization;
      if (!finalization || finalization.status !== "awaiting-confirmation" || !finalization.pendingConfirmation || !sameStableValue3(
        finalization.pendingConfirmation,
        pending.finalization
      ) || state.currentStep !== null || pending.stepId !== null || pending.attemptId !== void 0 || pending.cycleId !== void 0) {
        throw new Error(
          "Workflow checkpoint pending finalization identity is invalid"
        );
      }
    } else {
      const step = verifiedPackage.package.definition.orchestration.steps?.find(
        (candidate) => candidate.id === pending.stepId
      );
      if (!step || !sameActionDefinition(pending, step)) {
        throw new Error(
          "Workflow checkpoint pending action definition is invalid"
        );
      }
    }
  }
  if (manifest.pendingAction === null) {
    if (pending !== null || record.pendingAction.exists)
      throw new Error("Workflow checkpoint pending identity is invalid");
  } else if (!pending || manifest.pendingAction.id !== pending.id || !sameIdentity2(manifest.pendingAction, identityOf4(record.pendingAction))) {
    throw new Error("Workflow checkpoint pending action identity is invalid");
  }
  const events = parseTrajectory2(trajectoryContent, state.runId);
  validateTrajectorySemantics(events, state, pending);
  const trajectoryBytes = Buffer.byteLength(trajectoryContent, "utf8");
  if (manifest.trajectory.offset !== trajectoryBytes || manifest.trajectory.prefixSha256 !== sha256(Buffer.from(trajectoryContent, "utf8"))) {
    throw new Error("Workflow checkpoint trajectory boundary is invalid");
  }
  const identity = verifiedPackage.identity;
  const nodeId = currentNodeIdentity(state, identity, pending);
  const runtimeState = state.workflowRuntime;
  if (manifest.nodeId !== nodeId || manifest.cycleId !== (runtimeState?.currentCycle?.id ?? runtimeState?.currentAttempt?.cycleId ?? null) || manifest.attemptId !== (runtimeState?.currentAttempt?.id ?? null)) {
    throw new Error("Workflow checkpoint Node or Attempt identity is invalid");
  }
  if (verifiedPackage.package.runtime.capabilityVersion !== 3 || !runtimeState) {
    throw new Error("Workflow checkpoint requires revisioned runtime state");
  }
  validateWorkflowArtifactState(
    verifiedPackage.package.runtime.protocol,
    state.runId,
    identity.nodeToStep,
    runtimeState
  );
  const artifactVersions = await artifactVersionReferences(
    runRoot,
    verifiedPackage.package,
    state,
    normalizedProfile
  );
  if (!sameStableValue3(artifactVersions, manifest.artifactVersions)) {
    throw new Error("Workflow checkpoint artifact identity is invalid");
  }
  return {
    entry,
    manifest,
    record,
    state,
    pending,
    identity,
    package: verifiedPackage.package,
    contents: {
      state: stateContent,
      pendingAction: pendingContent,
      context: contextContent,
      artifacts: artifactsContent,
      trajectory: trajectoryContent
    }
  };
}
async function inspectWorkflowCheckpointCandidates(runRoot, profile, options = {}) {
  const index = await readWorkflowCheckpointIndex(runRoot, profile);
  if (!index) return [];
  const expectedRunId = options.expectedRunId ?? index.runId;
  if (index.runId !== expectedRunId) {
    throw new Error("Workflow checkpoint index Run identity is invalid");
  }
  return Promise.all(
    index.records.map(async (entry) => {
      try {
        return {
          entry,
          verification: await verifyWorkflowCheckpointCandidate(
            runRoot,
            profile,
            entry,
            { ...options, expectedRunId }
          )
        };
      } catch (error) {
        return {
          entry,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    })
  );
}
async function activeRecoveryRecordHash(runRoot, profile) {
  return (await readWorkflowCheckpointRecoveryJournal(runRoot, profile))?.checkpointRecordHash;
}
async function cleanupRetainedCheckpoints(runRoot, removed, retained, profile) {
  const retainedContent = /* @__PURE__ */ new Set();
  for (const entry of retained) {
    try {
      const record = await readWorkflowCheckpointRecord(
        runRoot,
        profile,
        entry
      );
      for (const reference of [
        record.state,
        record.pendingAction,
        record.context,
        record.artifacts,
        record.trajectory
      ]) {
        if (reference.contentPath) retainedContent.add(reference.contentPath);
      }
    } catch {
      return;
    }
  }
  for (const entry of removed) {
    let record;
    try {
      record = await readWorkflowCheckpointRecord(runRoot, profile, entry);
    } catch {
      continue;
    }
    await removeEngineRunFile(
      runRoot,
      recordPathFor(entry.recordHash),
      "Workflow checkpoint record"
    );
    await removeEngineRunFile(
      runRoot,
      manifestPathFor(entry.manifestHash),
      "Workflow checkpoint manifest"
    );
    for (const reference of [
      record.state,
      record.pendingAction,
      record.context,
      record.artifacts,
      record.trajectory
    ]) {
      if (reference.contentPath && !retainedContent.has(reference.contentPath)) {
        await removeEngineRunFile(
          runRoot,
          reference.contentPath,
          "Workflow checkpoint content"
        );
      }
    }
  }
}
async function createWorkflowCheckpoint(options) {
  const profile = parseWorkflowDurabilityProfile(options.profile);
  const bounds = checkpointBounds(profile);
  const built = await buildCheckpoint({ ...options, profile });
  for (const [contentPath, content] of built.contents) {
    const originalPath = contentPath === built.record.state.contentPath ? built.record.state.path : contentPath === built.record.pendingAction.contentPath ? built.record.pendingAction.path : contentPath === built.record.context.contentPath ? built.record.context.path : contentPath === built.record.artifacts.contentPath ? built.record.artifacts.path : built.record.trajectory.path;
    await publishContent(
      options.runRoot,
      {
        path: originalPath,
        contentPath,
        ...contentIdentity(content)
      },
      content,
      maxBytesForPath(profile, originalPath)
    );
  }
  await ensureProtectedProjectDirectory(
    options.runRoot,
    WORKFLOW_CHECKPOINT_MANIFEST_DIRECTORY,
    {
      label: "Workflow checkpoint manifest"
    }
  );
  await ensureProtectedProjectDirectory(
    options.runRoot,
    WORKFLOW_CHECKPOINT_RECORD_DIRECTORY,
    {
      label: "Workflow checkpoint record"
    }
  );
  const manifestHash = built.manifest.manifestHash;
  const recordHash = built.record.recordHash;
  await publishJson(
    options.runRoot,
    manifestPathFor(manifestHash),
    built.manifest,
    bounds.manifestBytes,
    "Workflow checkpoint manifest"
  );
  await publishJson(
    options.runRoot,
    recordPathFor(recordHash),
    built.record,
    bounds.recordBytes,
    "Workflow checkpoint record"
  );
  const existing = await readWorkflowCheckpointIndex(options.runRoot, profile);
  if (existing && existing.runId !== options.state.runId) {
    throw new Error("Workflow checkpoint index Run identity is invalid");
  }
  const entry = {
    recordHash,
    manifestHash,
    revision: built.manifest.revision
  };
  const all = [
    ...(existing?.records ?? []).filter(
      (candidate) => candidate.recordHash !== recordHash
    ),
    entry
  ];
  all.sort(
    (left, right) => right.revision - left.revision || left.recordHash.localeCompare(right.recordHash)
  );
  const active = await activeRecoveryRecordHash(options.runRoot, profile);
  if (active && !all.some((candidate) => candidate.recordHash === active)) {
    throw new Error(
      "Workflow checkpoint retention cannot preserve the active recovery anchor"
    );
  }
  if (active) {
    const activeEntry = all.find(
      (candidate) => candidate.recordHash === active
    );
    try {
      await readWorkflowCheckpointRecord(options.runRoot, profile, activeEntry);
    } catch (error) {
      throw new Error(
        "Workflow checkpoint retention cannot verify the active recovery anchor",
        { cause: error }
      );
    }
  }
  const top = all.slice(0, bounds.count);
  if (active && bounds.count === 1 && !top.some((candidate) => candidate.recordHash === active)) {
    throw new Error(
      "Workflow checkpoint retention cannot preserve the active recovery anchor"
    );
  }
  let retained = top;
  if (active && all.some((candidate) => candidate.recordHash === active) && !retained.some((candidate) => candidate.recordHash === active)) {
    retained = [
      ...retained.slice(0, Math.max(0, bounds.count - 1)),
      all.find((candidate) => candidate.recordHash === active)
    ];
    retained.sort(
      (left, right) => right.revision - left.revision || left.recordHash.localeCompare(right.recordHash)
    );
  }
  const removed = all.filter(
    (candidate) => !retained.some((kept) => kept.recordHash === candidate.recordHash)
  );
  const index = {
    schemaVersion: WORKFLOW_CHECKPOINT_SCHEMA_VERSION,
    kind: "workflow-checkpoint-index",
    runId: options.state.runId,
    records: retained
  };
  await ensureProtectedProjectDirectory(
    options.runRoot,
    WORKFLOW_CHECKPOINT_DIRECTORY,
    {
      label: "Workflow checkpoint index"
    }
  );
  await publishJson(
    options.runRoot,
    WORKFLOW_CHECKPOINT_INDEX_PATH,
    index,
    bounds.recordBytes,
    "Workflow checkpoint index"
  );
  await cleanupRetainedCheckpoints(options.runRoot, removed, retained, profile);
  return built.manifest;
}
async function verifyWorkflowCheckpointHead(options) {
  await buildCheckpoint({
    ...options,
    profile: parseWorkflowDurabilityProfile(options.profile)
  });
}
function recoveryJournalFor(runId, identity, checkpointRecordHash, records, recoveryEvent2) {
  return {
    schemaVersion: WORKFLOW_CHECKPOINT_RECOVERY_SCHEMA_VERSION,
    kind: "workflow-checkpoint-recovery-journal",
    status: "prepared",
    journalId: randomUUID6(),
    runId,
    execution: structuredClone(identity),
    checkpointRecordHash,
    records: [...records].sort(
      (left, right) => left.path.localeCompare(right.path)
    ),
    recoveryEvent: recoveryEvent2,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
async function writeRecoveryJournal(runRoot, profile, journal, exclusive = false) {
  const bounds = checkpointBounds(profile);
  parseRecoveryJournal(journal, bounds);
  await writeEngineRunText(
    runRoot,
    WORKFLOW_CHECKPOINT_RECOVERY_JOURNAL_PATH,
    canonical(journal),
    bounds.recordBytes,
    "Workflow checkpoint recovery journal",
    { exclusive, maxBytes: bounds.recordBytes }
  );
}
async function readWorkflowCheckpointRecoveryJournal(runRoot, profile) {
  const raw = await readRaw(
    runRoot,
    WORKFLOW_CHECKPOINT_RECOVERY_JOURNAL_PATH,
    profile ? checkpointBounds(profile).recordBytes : 16 * 1024 * 1024,
    "Workflow checkpoint recovery journal"
  );
  if (raw === null) return null;
  const value = JSON.parse(raw);
  const execution = isRecord14(value) ? parseExecutionIdentity2(
    value.execution,
    "Workflow checkpoint recovery execution"
  ) : void 0;
  const effectiveProfile = profile ?? execution?.durabilityProfile;
  if (!effectiveProfile)
    throw new Error("Workflow checkpoint recovery has no durability profile");
  const bounds = checkpointBounds(effectiveProfile);
  if (Buffer.byteLength(raw, "utf8") > bounds.recordBytes)
    throw new Error("Workflow checkpoint recovery journal is oversized");
  return parseRecoveryJournal(value, bounds);
}
async function clearRecoveryJournal(runRoot, profile, journal) {
  const current = await readWorkflowCheckpointRecoveryJournal(runRoot, profile);
  if (!current || current.journalId !== journal.journalId || current.status !== "committed") {
    throw new Error(
      "Workflow checkpoint recovery journal changed before clearance"
    );
  }
  await invokeFault2({ phase: "checkpoint-recovery-journal-clearance" });
  await removeEngineRunFile(
    runRoot,
    WORKFLOW_CHECKPOINT_RECOVERY_JOURNAL_PATH,
    "Workflow checkpoint recovery journal"
  );
}
async function settleRecoveryJournal(runRoot, profile, journal) {
  const index = await readWorkflowCheckpointIndex(runRoot, profile);
  const indexed = index?.records.find(
    (entry) => entry.recordHash === journal.checkpointRecordHash
  );
  if (!indexed)
    throw new Error("Workflow checkpoint recovery record is not retained");
  const candidate = await verifyWorkflowCheckpointCandidate(
    runRoot,
    profile,
    indexed
  );
  if (journal.runId !== candidate.state.runId || !sameStableValue3(journal.execution, candidate.identity)) {
    throw new Error("Workflow checkpoint recovery identity is invalid");
  }
  const unknownPaths = [];
  const currentMaterials = /* @__PURE__ */ new Map();
  for (const record of journal.records) {
    const current = await readMaterial2(
      runRoot,
      record.path,
      maxBytesForPath(profile, record.path),
      `Workflow checkpoint recovery record ${record.path}`
    );
    if (!sameIdentity2(current.identity, record.previous) && !sameIdentity2(current.identity, record.intended)) {
      unknownPaths.push(record.path);
    }
    currentMaterials.set(record.path, current.content);
  }
  if (unknownPaths.length > 0)
    return { status: "blocked", journal, unknownPaths };
  for (const record of journal.records) {
    const current = currentMaterials.get(record.path);
    if (sameIdentity2(
      { path: record.path, ...contentIdentity(current ?? null) },
      record.intended
    ))
      continue;
    const contentPath = record.contentPath;
    if (!record.intended.exists || !contentPath) {
      await removeEngineRunFile(
        runRoot,
        record.path,
        `Workflow checkpoint recovery record ${record.path}`
      );
    } else {
      const content = record.path === TRAJECTORY_PATH ? await readReferencedContent(
        runRoot,
        { ...record.intended, contentPath },
        profile.bounds.trajectoryBytes,
        "Workflow checkpoint recovery trajectory"
      ) : await readRaw(
        runRoot,
        contentPath,
        maxBytesForPath(profile, record.path),
        `Workflow checkpoint recovery content ${record.path}`
      );
      if (content === null)
        throw new Error(
          `Workflow checkpoint recovery content is missing: ${record.path}`
        );
      const contentIdentityValue = contentIdentity(content);
      if (!record.intended.exists || contentIdentityValue.bytes !== record.intended.bytes || contentIdentityValue.sha256 !== record.intended.sha256) {
        throw new Error(
          `Workflow checkpoint recovery content identity is invalid: ${record.path}`
        );
      }
      await writeEngineRunText(
        runRoot,
        record.path,
        content,
        maxBytesForPath(profile, record.path),
        `Workflow checkpoint recovery record ${record.path}`
      );
    }
    await invokeFault2({
      phase: "checkpoint-recovery-record-write",
      path: record.path
    });
    const verified = await readMaterial2(
      runRoot,
      record.path,
      maxBytesForPath(profile, record.path),
      `Workflow checkpoint recovery record ${record.path}`
    );
    if (!sameIdentity2(verified.identity, record.intended)) {
      throw new Error(
        `Workflow checkpoint recovery record changed: ${record.path}`
      );
    }
    await invokeFault2({
      phase: "checkpoint-recovery-record-verification",
      path: record.path
    });
  }
  const committedAt = journal.committedAt ?? (/* @__PURE__ */ new Date()).toISOString();
  const committed = {
    ...journal,
    status: "committed",
    committedAt
  };
  await invokeFault2({ phase: "checkpoint-recovery-commit-evidence" });
  await writeRecoveryJournal(runRoot, profile, committed);
  await clearRecoveryJournal(runRoot, profile, committed);
  return { status: "recovered", journal: committed };
}
async function recoverWorkflowCheckpoint(runRoot, profile) {
  const journal = await readWorkflowCheckpointRecoveryJournal(runRoot, profile);
  if (!journal) return { status: "none" };
  return settleRecoveryJournal(runRoot, profile, journal);
}
async function proveNoLaterTrajectory(runRoot, profile, candidate) {
  const transitionJournal = await readRaw(
    runRoot,
    TRANSITION_JOURNAL_PATH,
    profile.bounds.transitionJournalBytes ?? profile.bounds.runStateBytes,
    "Workflow transition journal"
  );
  if (transitionJournal !== null) {
    throw new Error("Workflow checkpoint history is ambiguous");
  }
  const current = await readRaw(
    runRoot,
    candidate.record.trajectory.path,
    profile.bounds.trajectoryBytes,
    "Workflow checkpoint current trajectory"
  );
  if (current === null || current !== candidate.contents.trajectory || Buffer.byteLength(current, "utf8") !== candidate.manifest.trajectory.offset) {
    throw new Error("Workflow checkpoint history is ambiguous");
  }
}
async function restoreWorkflowCheckpoint(runRoot, profile, candidate) {
  const existing = await readWorkflowCheckpointRecoveryJournal(
    runRoot,
    profile
  );
  if (existing) return settleRecoveryJournal(runRoot, profile, existing);
  await proveNoLaterTrajectory(runRoot, profile, candidate);
  const paths = [
    candidate.record.state,
    candidate.record.pendingAction,
    candidate.record.context,
    candidate.record.artifacts
  ];
  const trajectoryEvent = {
    sequence: parseTrajectory2(candidate.contents.trajectory, candidate.state.runId).length + 1,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    type: "recovery_reconciled",
    runId: candidate.state.runId,
    data: {
      kind: "workflow-checkpoint-restored",
      checkpointRecordHash: candidate.entry.recordHash,
      revision: candidate.manifest.revision,
      paths: [...paths.map((reference) => reference.path), TRAJECTORY_PATH]
    }
  };
  const nextTrajectory = `${candidate.contents.trajectory}${JSON.stringify(trajectoryEvent)}
`;
  const trajectoryReference = {
    path: candidate.record.trajectory.path,
    contentPath: contentPathFor(sha256(Buffer.from(nextTrajectory, "utf8"))),
    ...contentIdentity(nextTrajectory)
  };
  await publishContent(
    runRoot,
    trajectoryReference,
    nextTrajectory,
    profile.bounds.trajectoryBytes
  );
  const records = [];
  for (const reference of [...paths, candidate.record.trajectory]) {
    const current = await readMaterial2(
      runRoot,
      reference.path,
      maxBytesForPath(profile, reference.path),
      `Workflow checkpoint current record ${reference.path}`
    );
    const intended = reference.path === TRAJECTORY_PATH ? trajectoryReference : reference;
    records.push({
      path: reference.path,
      previous: current.identity,
      intended: identityOf4(intended),
      contentPath: intended.contentPath
    });
  }
  const journal = recoveryJournalFor(
    candidate.state.runId,
    candidate.identity,
    candidate.entry.recordHash,
    records,
    trajectoryEvent
  );
  await writeRecoveryJournal(runRoot, profile, journal, true);
  await invokeFault2({ phase: "checkpoint-recovery-journal-prepared" });
  return settleRecoveryJournal(runRoot, profile, journal);
}

// src/workflow-runtime/location.ts
import { promises as fs11 } from "node:fs";
import { randomUUID as randomUUID8 } from "node:crypto";

// src/engine/manual-run.ts
import { randomUUID as randomUUID7 } from "crypto";

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
import { createHash as createHash4 } from "crypto";

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
  return createHash4("sha256").update(context).digest("hex").slice(0, 16);
}
function attemptId(runId, stepId2, visitOrdinal, cycleId) {
  return `attempt-${createHash4("sha256").update(`${runId}:${stepId2}:${visitOrdinal}:cycle:${cycleId ?? "none"}`).digest("hex").slice(0, 24)}`;
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
  workflowRuntime.verificationReceipts ??= [];
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
    ...outcome.artifactVersions ? { artifactVersions: { ...outcome.artifactVersions } } : {},
    ...outcome.verificationReceiptIds ? { verificationReceiptIds: [...outcome.verificationReceiptIds] } : {},
    ...outcome.repairDecision ? {
      repairDecision: {
        decisionId: outcome.repairDecision.decisionId,
        signatureHash: outcome.repairDecision.signatureHash,
        choiceId: outcome.repairDecision.choiceId,
        outcome: outcome.repairDecision.outcome
      }
    } : {}
  };
  visit.outcomes.push(visitOutcome);
  workflowRuntime.revision += 1;
  if (receipt) workflowRuntime.decisionReceipts.push(receipt);
  if (outcome.repairFailure) {
    const failure = workflowRepairFailureRecord(
      workflowRuntime.revision,
      outcome.repairFailure.signature
    );
    workflowRuntime.repairEpisode = repairEpisodeForFailure({
      previous: workflowRuntime.repairEpisode,
      decision: {
        disposition: outcome.repairFailure.disposition,
        reasonCode: outcome.repairFailure.reasonCode,
        signature: outcome.repairFailure.signature,
        consecutiveFailures: outcome.repairFailure.consecutiveFailures,
        totalFailures: outcome.repairFailure.totalFailures,
        remainingFailures: outcome.repairFailure.remainingFailures,
        totalRepairFailures: outcome.repairFailure.totalFailures,
        remainingIterations: outcome.repairFailure.remainingFailures,
        overrideAccepted: outcome.repairFailure.overrideAccepted,
        automaticRepair: outcome.repairFailure.automaticRepair ?? null
      },
      failure,
      ...outcome.repairFailure.pendingDecision ? { pendingDecision: outcome.repairFailure.pendingDecision } : {}
    });
  }
  if (outcome.repairDecision) {
    const episode = workflowRuntime.repairEpisode;
    const policy = state.runtimeIdentity?.durabilityProfile?.repairPolicy;
    if (!episode || !policy) {
      throw new Error(
        "Workflow repair decision requires a repair episode policy"
      );
    }
    const pendingDecision = episode.pendingDecision;
    if (!pendingDecision || pendingDecision.actionId !== outcome.actionId || pendingDecision.signatureHash !== outcome.repairDecision.signatureHash || !pendingDecision.choices.some(
      (choice) => choice.id === outcome.repairDecision.choiceId
    )) {
      throw new Error(
        "Workflow repair decision does not match pending policy decision"
      );
    }
    const normalizedPolicy = normalizeWorkflowRepairPolicy(policy);
    const record = workflowRepairDecisionRecord({
      revision: workflowRuntime.revision,
      actionId: outcome.actionId,
      attemptId: pendingDecision.attemptId,
      signatureHash: outcome.repairDecision.signatureHash,
      decision: outcome.repairDecision,
      maxRationaleBytes: normalizedPolicy.maxOverrideRationaleBytes
    });
    workflowRuntime.repairEpisode = repairEpisodeForDecision({
      previous: episode,
      record,
      disposition: outcome.repairDecision.outcome === "retry" ? "continue" : "manual-stop",
      reasonCode: outcome.repairDecision.hypothesis !== void 0 ? "override-accepted" : "repair-decision-accepted"
    });
  }
  if (outcome.status === "failed") {
    attempt.retryOrdinal += 1;
  } else if (outcome.repairDecision) {
    attempt.retryOrdinal += 1;
  } else if (!outcome.repairDecision) {
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
    ...outcome.verificationReceiptIds ? { verificationReceiptIds: [...outcome.verificationReceiptIds] } : {},
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
  if (state.status === "completed" || state.status === "failed" || state.status === "blocked") {
    throw new Error(`Run is ${state.status}`);
  }
  if (outcome.finalization && state.workflowRuntime?.finalization) {
    const pending = state.workflowRuntime.finalization.pendingConfirmation;
    if (!pending || pending.actionId !== outcome.actionId || outcome.status !== "succeeded") {
      throw new Error(
        "Workflow finalization confirmation does not match pending action"
      );
    }
    return {
      ...state,
      iteration: state.iteration + 1,
      pending: null,
      status: "running",
      workflowRuntime: {
        ...structuredClone(state.workflowRuntime),
        revision: state.workflowRuntime.revision + 1
      }
    };
  }
  const repairDecision = outcome.repairDecision;
  if (repairDecision) {
    const pendingDecision = state.workflowRuntime?.repairEpisode?.pendingDecision;
    if (!pendingDecision || pendingDecision.actionId !== outcome.actionId || pendingDecision.signatureHash !== repairDecision.signatureHash || pendingDecision.decisionId !== repairDecision.decisionId) {
      throw new Error("Workflow repair decision does not match pending action");
    }
    if (outcome.status !== "succeeded") {
      throw new Error("Workflow repair decisions must succeed");
    }
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
  if (!repairDecision && step?.action.type === "ask_user" && outcome.kind !== "decision") {
    throw new Error("Decision response required for pending ask_user action");
  }
  if (!repairDecision && step?.action.type !== "ask_user" && outcome.kind === "decision") {
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
    const pendingRepair = workflowRuntime2?.repairEpisode?.pendingDecision;
    const repairAction = pendingRepair ? workflowRepairAction(pendingRepair) : null;
    return {
      ...state,
      pending: repairAction?.id ?? null,
      status: repairAction !== null ? "waiting" : outcome.repairFailure?.disposition === "hard-stop" ? "failed" : "running",
      retries,
      ...workflowRuntime2 ? { workflowRuntime: workflowRuntime2 } : {}
    };
  }
  if (repairDecision) {
    const workflowRuntime2 = recordWorkflowOutcome(pkg, state, outcome);
    return {
      ...state,
      iteration: state.iteration + 1,
      pending: null,
      status: repairDecision.outcome === "retry" ? "running" : "failed",
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

// src/engine/manual-run.ts
function durabilityBound(state, key) {
  return state.runtimeIdentity?.durabilityProfile?.bounds[key];
}
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
  const existingReceiptIds = new Set(
    state.workflowRuntime.verificationReceipts?.map(
      (receipt) => receipt.receiptId
    ) ?? []
  );
  const verificationReceipts = (mutation.verificationReceipts ?? []).filter(
    (receipt) => {
      if (existingReceiptIds.has(receipt.receiptId)) return false;
      existingReceiptIds.add(receipt.receiptId);
      return true;
    }
  );
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
      ],
      verificationReceipts: [
        ...state.workflowRuntime.verificationReceipts ?? [],
        ...structuredClone(verificationReceipts)
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
async function appendEvent(changeDir, state, type, data, options = {}) {
  const trajectoryMaxBytes = durabilityBound(state, "trajectoryBytes");
  const trajectoryOptions = {
    ...options,
    ...options.maxBytes === void 0 && trajectoryMaxBytes !== void 0 ? { maxBytes: trajectoryMaxBytes } : {}
  };
  const trajectory = await readTrajectory(
    changeDir,
    state.trajectoryRef,
    trajectoryOptions
  );
  await appendTrajectory(
    changeDir,
    state.trajectoryRef,
    {
      sequence: trajectory.length + 1,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      type,
      runId: state.runId,
      data
    },
    trajectoryOptions
  );
}
async function persistDecision(changeDir, state, pkg, confirmations, resolver = staticDeterministicResolver, prepareAction, mutationOverlay) {
  let decision = decideWithResolver(
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
      action,
      mutationOverlay
    );
    const preparedState = prepared.workflowRuntime ? { ...decision.state, workflowRuntime: prepared.workflowRuntime } : decision.state;
    if (!prepared.action) {
      if (prepared.workflowRuntime) {
        await writeRunState(
          changeDir,
          { ...state, workflowRuntime: prepared.workflowRuntime },
          mutationOverlay ? { overlay: mutationOverlay } : {}
        );
      }
      return {
        state: prepared.workflowRuntime ? { ...state, workflowRuntime: prepared.workflowRuntime } : state,
        action: null,
        evals: [],
        reason: prepared.reason ?? "Pending action preparation was blocked"
      };
    }
    decision = { ...decision, state: preparedState };
    action = prepared.action;
  }
  if (action) {
    const pendingMaxBytes = durabilityBound(
      decision.state,
      "pendingActionBytes"
    );
    await writePendingAction(changeDir, decision.state.pendingRef, action, {
      ...pendingMaxBytes === void 0 ? {} : { maxBytes: pendingMaxBytes },
      ...mutationOverlay ? { overlay: mutationOverlay } : {}
    });
  }
  await writeRunState(
    changeDir,
    action ? decision.state : state,
    mutationOverlay ? { overlay: mutationOverlay } : {}
  );
  if (action) {
    await appendEvent(
      changeDir,
      decision.state,
      "action_proposed",
      { action },
      mutationOverlay ? { overlay: mutationOverlay } : {}
    );
  }
  return {
    state: action ? decision.state : state,
    action,
    evals: [],
    reason: decision.reason
  };
}
async function evaluateAndRecord(changeDir, pkg, state, scope, artifacts, mutationOverlay) {
  const results = evaluateRuntime(pkg.evals, scope, state, artifacts);
  if (results.length > 0) {
    await appendEvent(
      changeDir,
      state,
      "eval_completed",
      { scope, results },
      mutationOverlay ? { overlay: mutationOverlay } : {}
    );
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
    startOptions.runId ?? randomUUID7(),
    snapshot.hash,
    startOptions.workflowRuntime
  );
  if (startOptions.runtimeIdentity) {
    state.runtimeIdentity = structuredClone(startOptions.runtimeIdentity);
  }
  const transition = startOptions.runtimeIdentity?.durabilityProfile ? createWorkflowTransition({
    runRoot: changeDir,
    runId: state.runId,
    operation: "workflow.start",
    execution: startOptions.runtimeIdentity,
    profile: startOptions.runtimeIdentity.durabilityProfile
  }) : void 0;
  if (!transition) {
    await writeRunState(changeDir, state);
    await appendEvent(changeDir, state, "run_started", {
      skill: state.skill,
      skillVersion: state.skillVersion,
      skillHash: state.skillHash,
      ...state.runtimeIdentity ? { runtimeIdentity: structuredClone(state.runtimeIdentity) } : {}
    });
  } else {
    await writeRunState(changeDir, state, { overlay: transition });
    await appendEvent(
      changeDir,
      state,
      "run_started",
      {
        skill: state.skill,
        skillVersion: state.skillVersion,
        skillHash: state.skillHash,
        ...state.runtimeIdentity ? { runtimeIdentity: structuredClone(state.runtimeIdentity) } : {}
      },
      { overlay: transition }
    );
  }
  const result = await persistDecision(
    changeDir,
    state,
    pkg,
    startOptions.confirmations ?? [],
    startOptions.resolver,
    startOptions.prepareAction,
    transition
  );
  await transition?.commit();
  return result;
}
async function resumeManualRunInternal(changeDir, options = {}) {
  const state = await requiredRun(changeDir);
  const pkg = await readSkillSnapshot(changeDir, state.skillHash);
  validateSnapshotState(pkg, state);
  if (pkg.definition.orchestration.mode === "adaptive") {
    throw new Error("Adaptive orchestration requires an Agent candidate");
  }
  const resolver = options.resolver ?? staticDeterministicResolver;
  const pendingMaxBytes = durabilityBound(state, "pendingActionBytes");
  const pending = await readPendingAction(
    changeDir,
    state.pendingRef,
    pendingMaxBytes === void 0 ? {} : { maxBytes: pendingMaxBytes }
  );
  if (!options.outcome) {
    if (options.finalizationRefresh) {
      if (!pending || !pending.finalization || state.status !== "waiting") {
        throw new Error("Workflow finalization refresh state is missing");
      }
      const transition3 = state.runtimeIdentity?.durabilityProfile ? createWorkflowTransition({
        runRoot: changeDir,
        runId: state.runId,
        operation: "workflow.resume",
        execution: state.runtimeIdentity,
        profile: state.runtimeIdentity.durabilityProfile
      }) : void 0;
      await clearPendingAction(changeDir, state.pendingRef, {
        ...transition3 ? { overlay: transition3 } : {}
      });
      await writePendingAction(
        changeDir,
        state.pendingRef,
        options.finalizationRefresh.action,
        transition3 ? { overlay: transition3 } : {}
      );
      await appendEvent(
        changeDir,
        options.finalizationRefresh.state,
        "action_proposed",
        { action: options.finalizationRefresh.action },
        transition3 ? { overlay: transition3 } : {}
      );
      await writeRunState(
        changeDir,
        options.finalizationRefresh.state,
        transition3 ? { overlay: transition3 } : {}
      );
      await transition3?.commit();
      return {
        state: options.finalizationRefresh.state,
        action: options.finalizationRefresh.action,
        evals: []
      };
    }
    if (options.finalizationRecovery) {
      if (!pending || !pending.finalization || !state.workflowRuntime?.finalization) {
        throw new Error("Workflow finalization recovery state is missing");
      }
      const transition3 = state.runtimeIdentity?.durabilityProfile ? createWorkflowTransition({
        runRoot: changeDir,
        runId: state.runId,
        operation: "workflow.submit",
        execution: state.runtimeIdentity,
        profile: state.runtimeIdentity.durabilityProfile
      }) : void 0;
      const confirmationCount = (state.workflowRuntime.finalization.confirmationCount ?? 0) + 1;
      const finalization = {
        schemaVersion: 1,
        status: options.finalizationRecovery.status === "committed" ? "committed" : "rolled-back",
        planHash: pending.finalization.planHash,
        revision: options.finalizationRecovery.resultingRevision,
        sourceActionId: pending.finalization.sourceActionId,
        planRevision: pending.finalization.planRevision,
        transactionId: options.finalizationRecovery.transactionId,
        confirmationActionId: pending.id,
        confirmationCount,
        receipt: structuredClone(options.finalizationRecovery.receipt)
      };
      const recoveredState = {
        ...state,
        iteration: state.iteration + 1,
        pending: null,
        status: options.finalizationRecovery.status === "committed" ? "completed" : "blocked",
        workflowRuntime: {
          ...structuredClone(state.workflowRuntime),
          revision: options.finalizationRecovery.resultingRevision,
          finalization
        }
      };
      await appendEvent(
        changeDir,
        state,
        "action_completed",
        {
          action: pending,
          outcome: {
            actionId: pending.id,
            status: "succeeded",
            summary: "Recovered Workflow finalization.",
            kind: "decision",
            finalization: {
              planHash: pending.finalization.planHash,
              decisionId: pending.finalization.decisionId,
              choiceId: options.finalizationRecovery.status === "committed" ? "confirm" : "cancel"
            }
          }
        },
        transition3 ? { overlay: transition3 } : {}
      );
      await clearPendingAction(changeDir, state.pendingRef, {
        ...transition3 ? { overlay: transition3 } : {}
      });
      await writeRunState(
        changeDir,
        recoveredState,
        transition3 ? { overlay: transition3 } : {}
      );
      await transition3?.commit();
      return {
        state: recoveredState,
        action: null,
        evals: [],
        ...options.finalizationRecovery.status === "rolled-back" ? { reason: "Workflow finalization was rolled back" } : {}
      };
    }
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
    const transition2 = state.runtimeIdentity?.durabilityProfile ? createWorkflowTransition({
      runRoot: changeDir,
      runId: state.runId,
      operation: "workflow.resume",
      execution: state.runtimeIdentity,
      profile: state.runtimeIdentity.durabilityProfile
    }) : void 0;
    const result = await persistDecision(
      changeDir,
      state,
      pkg,
      options.confirmations ?? [],
      resolver,
      options.prepareAction,
      transition2
    );
    await transition2?.commit();
    return result;
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
  const transition = state.runtimeIdentity?.durabilityProfile ? createWorkflowTransition({
    runRoot: changeDir,
    runId: state.runId,
    operation: "workflow.submit",
    execution: state.runtimeIdentity,
    profile: state.runtimeIdentity.durabilityProfile
  }) : void 0;
  await options.prepareOutcome?.(changeDir, state, outcome, transition);
  let advanced = applyArtifactMutation(
    recordOutcomeWithResolver(pkg, state, outcome, resolver, void 0),
    options.artifactMutation
  );
  const preparedFinalization = await options.prepareFinalization?.(
    changeDir,
    state,
    outcome,
    advanced,
    pending,
    transition
  );
  let finalizationAction = null;
  if (preparedFinalization) {
    advanced = preparedFinalization.state;
    finalizationAction = preparedFinalization.action;
  }
  const artifactsMaxBytes = durabilityBound(state, "artifactsBytes");
  const artifactReadOptions = {
    ...artifactsMaxBytes === void 0 ? {} : { maxBytes: artifactsMaxBytes },
    ...transition ? { overlay: transition } : {}
  };
  const artifacts = {
    ...await readArtifacts(
      changeDir,
      state.artifactsRef,
      artifactReadOptions
    ),
    ...outcome.artifacts ?? {},
    ...options.artifactMutation?.artifactPaths ?? {}
  };
  await options.revisionFence?.();
  const artifactWriteOptions = {
    ...options.revisionFence ? { beforeCommit: options.revisionFence } : {},
    ...artifactsMaxBytes === void 0 ? {} : { maxBytes: artifactsMaxBytes },
    ...transition ? { overlay: transition } : {}
  };
  await writeArtifacts(
    changeDir,
    state.artifactsRef,
    artifacts,
    artifactWriteOptions
  );
  const trajectoryMaxBytes = durabilityBound(state, "trajectoryBytes");
  const trajectoryWriteOptions = {
    ...options.revisionFence ? { beforeCommit: options.revisionFence } : {},
    ...trajectoryMaxBytes === void 0 ? {} : { maxBytes: trajectoryMaxBytes },
    ...transition ? { overlay: transition } : {}
  };
  const decisionReceipt2 = advanced.workflowRuntime?.decisionReceipts.find(
    (receipt) => receipt.actionId === pending.id
  );
  await appendEvent(
    changeDir,
    state,
    "action_completed",
    {
      action: pending,
      outcome,
      ...decisionReceipt2 ? { decisionReceipt: decisionReceipt2 } : {}
    },
    trajectoryWriteOptions
  );
  await clearPendingAction(changeDir, advanced.pendingRef, {
    ...options.revisionFence ? { beforeRemove: options.revisionFence } : {},
    ...transition ? { overlay: transition } : {}
  });
  const stateFence = options.revisionStateFence ?? options.revisionFence;
  await writeRunState(changeDir, advanced, {
    ...stateFence ? { beforeCommit: stateFence } : {},
    ...transition ? { overlay: transition } : {}
  });
  const repairAction = advanced.workflowRuntime?.repairEpisode?.pendingDecision ? workflowRepairAction(
    advanced.workflowRuntime.repairEpisode.pendingDecision
  ) : null;
  const nextAction = finalizationAction ?? repairAction;
  if (nextAction) {
    await writePendingAction(changeDir, advanced.pendingRef, nextAction, {
      ...transition ? { overlay: transition } : {}
    });
    await appendEvent(
      changeDir,
      advanced,
      "action_proposed",
      { action: nextAction },
      transition ? { overlay: transition } : {}
    );
  }
  const evals = await evaluateAndRecord(
    changeDir,
    pkg,
    advanced,
    "step",
    artifacts,
    transition
  );
  if (advanced.status === "completed") {
    evals.push(
      ...await evaluateAndRecord(
        changeDir,
        pkg,
        advanced,
        "completion",
        artifacts,
        transition
      )
    );
    await transition?.commit();
    return { state: advanced, action: null, evals };
  }
  if (advanced.status !== "running") {
    await transition?.commit();
    return {
      state: advanced,
      action: nextAction,
      evals,
      ...nextAction ? {} : {
        reason: preparedFinalization?.reason ?? `Run is ${advanced.status}`
      }
    };
  }
  const materializeNextAction = () => persistDecision(
    changeDir,
    advanced,
    pkg,
    options.confirmations ?? [],
    resolver,
    options.prepareAction,
    transition
  );
  const latestRepairRecord = advanced.workflowRuntime?.repairEpisode?.history.at(-1);
  const automaticRepair = options.outcome?.status === "failed" && latestRepairRecord?.kind === "failure" ? latestRepairRecord.automaticRepair : void 0;
  const automaticExecutionCount = automaticRepair ? advanced.workflowRuntime?.repairEpisode?.history.filter(
    (record) => record.kind === "failure" && record.automaticRepair?.id === automaticRepair.id
  ).length ?? 0 : 0;
  const next = automaticRepair ? await executeWorkflowRepairOperation(
    automaticRepair,
    automaticExecutionCount,
    materializeNextAction
  ) : await materializeNextAction();
  await transition?.commit();
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
import { promises as fs10 } from "node:fs";
import path16 from "path";
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
  return path16.resolve(projectRoot, ".comet", "runs", runId);
}
function pathSegments(projectRoot) {
  const lexicalRoot = path16.resolve(projectRoot);
  const root = path16.parse(lexicalRoot).root;
  const relative = path16.relative(root, lexicalRoot);
  return relative.length === 0 ? [] : relative.split(path16.sep);
}
function runRootRelativePath(projectRoot, runRoot) {
  return path16.relative(projectRoot, runRoot).replaceAll("\\", "/");
}
function isMissing2(error) {
  const code = error.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
async function resolveStandaloneProjectRoot(projectRoot, createMissing) {
  validateProjectRoot(projectRoot);
  const lexicalRoot = path16.resolve(projectRoot);
  let cursor = path16.parse(lexicalRoot).root;
  for (const segment of pathSegments(lexicalRoot)) {
    cursor = path16.join(cursor, segment);
    let stat;
    try {
      stat = await fs10.lstat(cursor);
    } catch (error) {
      if (!isMissing2(error)) throw error;
      if (!createMissing) return lexicalRoot;
      try {
        await fs10.mkdir(cursor);
      } catch (mkdirError) {
        if (mkdirError.code !== "EEXIST") {
          throw mkdirError;
        }
      }
      stat = await fs10.lstat(cursor);
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
async function checkedStandaloneRunDir(projectRoot, runId, options = {}) {
  validateRunId(runId);
  validateProjectRoot(projectRoot);
  const validatedRoot = await resolveStandaloneProjectRoot(projectRoot, false);
  const runDir = standaloneRunDir(validatedRoot, runId);
  await inspectProtectedProjectPath(
    validatedRoot,
    runRootRelativePath(validatedRoot, runDir),
    { label: "Standalone Run root", expected: "directory" }
  );
  let state;
  try {
    state = await readRunState(runDir);
  } catch (error) {
    if (!options.allowMalformedState) throw error;
    state = null;
  }
  if (state && state.runId !== runId) {
    throw new Error(
      `Standalone Run state does not match requested Run id: ${runId}`
    );
  }
  return runDir;
}
async function readStandaloneRunState(projectRoot, runId, options = {}) {
  const runDir = await checkedStandaloneRunDir(projectRoot, runId, options);
  try {
    return await readRunState(runDir);
  } catch (error) {
    if (!options.allowMalformedState) throw error;
    return null;
  }
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
    contentSnapshotRoot: validatedRoot,
    async start(pkg, options) {
      return startManualRun(pkg, validatedRoot, options);
    },
    async resume(options = {}, artifactMutation) {
      return artifactMutation ? resumeManualWorkflowRun(validatedRoot, options, artifactMutation) : resumeManualRun(validatedRoot, options);
    },
    async readState() {
      return readRunState(validatedRoot);
    },
    async prepareStart() {
      await fs11.mkdir(validatedRoot, { recursive: true });
      const stat = await fs11.lstat(validatedRoot);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(
          "WorkflowRuntime manual Run root must be a real directory"
        );
      }
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
    contentSnapshotRoot: validatedProjectRoot,
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
    async readState(options) {
      return readStandaloneRunState(
        validatedProjectRoot,
        validatedRunId,
        options
      );
    },
    async prepareStart() {
      await ensureStandaloneRunDir(validatedProjectRoot, validatedRunId);
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
      runId: ("runId" in options ? options.runId : void 0) ?? randomUUID8()
    };
  }
  return {
    location: manualLocation(options.runRoot),
    runId: options.runId ?? randomUUID8()
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
function usesWorkflowRunLock(profile) {
  return profile?.capabilities.includes("mutation-locks") ?? false;
}
function usesWorkflowCheckpoints(profile) {
  return profile?.capabilities.includes("verified-checkpoints") ?? false;
}
function usesWorkflowContentSnapshots(profile) {
  return profile?.capabilities.includes("content-snapshots") ?? false;
}
function usesWorkflowFinalization(profile) {
  return profile?.capabilities.includes("transactional-finalization") ?? false;
}
async function durabilityProfileForLocation(location, options = {}) {
  try {
    const state = await location.readState(options);
    if (state) {
      if (state.runtimeIdentity?.durabilityProfile) {
        return state.runtimeIdentity.durabilityProfile;
      }
      const journal2 = await readWorkflowTransitionJournal(location.runRoot);
      return journal2?.execution.durabilityProfile;
    }
  } catch (error) {
    const checkpointProfile = await readWorkflowCheckpointProfile(
      location.runRoot
    );
    if (checkpointProfile) return checkpointProfile;
    throw error;
  }
  const journal = await readWorkflowTransitionJournal(location.runRoot);
  if (journal?.execution.durabilityProfile) {
    return journal.execution.durabilityProfile;
  }
  return readWorkflowCheckpointProfile(location.runRoot);
}
async function withWorkflowRunLock(location, operation2, profile, work, options = {}) {
  if (!usesWorkflowRunLock(profile)) return work();
  let lock;
  try {
    lock = await acquireWorkflowRunLock(location.runRoot, operation2, {
      maxBytes: profile?.bounds.runLockBytes,
      allowStale: options.allowStale
    });
  } catch (error) {
    if (error instanceof WorkflowRunLockBlockedError && options.onBlocked) {
      return options.onBlocked(error);
    }
    throw error;
  }
  try {
    return await work(lock);
  } finally {
    await lock.release();
  }
}
async function lockBlockedContinuation(location, error) {
  try {
    const verified = await verifyStoredRun(location);
    const base = await continuationFromVerifiedRun(verified, location.runRoot);
    const projected = boundWorkflowFindings([error.finding]);
    return {
      ...base,
      disposition: "blocked",
      findings: projected.findings,
      findingSummary: projected.summary,
      requiresUserDecision: projected.findings.some(
        (finding) => finding.requiresUserDecision
      ),
      blockers: legacyBlockersFromFindings("blocked", projected.findings)
    };
  } catch {
    throw error;
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
    ...state.runtimeIdentity.findingCatalogVersion === WORKFLOW_FINDING_CATALOG_VERSION ? { findingCatalogVersion: WORKFLOW_FINDING_CATALOG_VERSION } : {},
    ...state.runtimeIdentity.durabilityProfile ? {
      durabilityProfile: structuredClone(
        state.runtimeIdentity.durabilityProfile
      )
    } : {}
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
function sameStableValue4(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}
function sameExecutionIdentity(left, right) {
  return left.protocolHash === right.protocolHash && left.packageHash === right.packageHash && left.snapshotHash === right.snapshotHash && sameStringRecord(left.nodeToStep, right.nodeToStep) && left.capabilityVersion === right.capabilityVersion && left.resolverHash === right.resolverHash && (left.findingCatalogVersion === void 0 || right.findingCatalogVersion === void 0 || left.findingCatalogVersion === right.findingCatalogVersion) && sameDurabilityProfile(left.durabilityProfile, right.durabilityProfile);
}
function samePhase4ExecutionIdentity(left, right) {
  return sameExecutionIdentity(left, right) && left.capabilityVersion === 3 && right.capabilityVersion === 3 && left.resolverHash !== void 0 && right.resolverHash !== void 0 && left.resolverHash === right.resolverHash && left.findingCatalogVersion === WORKFLOW_FINDING_CATALOG_VERSION && right.findingCatalogVersion === WORKFLOW_FINDING_CATALOG_VERSION && left.durabilityProfile !== void 0 && right.durabilityProfile !== void 0;
}
function durabilityReadOptions(state, key) {
  const maxBytes = state.runtimeIdentity?.durabilityProfile?.bounds[key];
  return maxBytes === void 0 ? {} : { maxBytes };
}
function isDecisionSubmission(submission) {
  return submission.kind === "decision";
}
function isWorkflowFinalizationAction(action) {
  return Boolean(action?.type === "ask_user" && action.finalization);
}
var DECISION_SUBMISSION_KEYS = /* @__PURE__ */ new Set([
  "kind",
  "actionId",
  "runId",
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
  "snapshotHash",
  "verification",
  "verificationReceipts",
  "verificationReceiptIds",
  "receiptIds",
  "repair",
  "finalization"
]);
var VERIFICATION_SUBMISSION_KEYS = /* @__PURE__ */ new Set([
  "proposals",
  "receiptIds",
  "receipts"
]);
function verificationRequirements(node) {
  if (!node) return [];
  const result = [];
  const ids = /* @__PURE__ */ new Set();
  for (const guardrail of node.guardrails) {
    if (!guardrail.verification) continue;
    validateWorkflowVerificationRequirement(
      guardrail.verification,
      `Workflow verification requirement for ${node.id}.${guardrail.id}`
    );
    const requirement = guardrail.verification;
    const id = requirement.id ?? guardrail.id;
    if (ids.has(id)) {
      throw new Error(`Workflow verification requirement is duplicated: ${id}`);
    }
    ids.add(id);
    result.push({
      id,
      role: requirement.role,
      kinds: workflowVerificationKinds(requirement),
      scope: {
        artifacts: (requirement.scope?.artifacts ?? []).map((entry) => ({
          id: entry.id,
          required: entry.required === true
        })),
        evidence: (requirement.scope?.evidence ?? []).map((entry) => ({
          id: entry.id,
          required: entry.required === true
        }))
      },
      requireContentSnapshot: requirement.requireContentSnapshot === true
    });
  }
  return result;
}
function normalizedVerificationSubmission(submission) {
  const proposals = [];
  const receiptIds = [];
  const addReceiptEntry = (entry, label) => {
    if (typeof entry === "string" && entry.length > 0) {
      receiptIds.push(entry);
      return;
    }
    if (isRecord15(entry) && typeof entry.receiptId === "string" && entry.receiptId.length > 0) {
      receiptIds.push(entry.receiptId);
      return;
    }
    if (isRecord15(entry) && typeof entry.receiptHash === "string" && entry.receiptHash.length > 0) {
      receiptIds.push(entry.receiptHash);
      return;
    }
    throw new Error(verificationFailure(`${label} must contain receipt ids`));
  };
  const addValue = (value, label) => {
    if (value === void 0) return;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string" || isRecord15(entry) && (typeof entry.receiptId === "string" || typeof entry.receiptHash === "string") && (entry.kind === void 0 || entry.kind === "workflow-verification-receipt-reference")) {
          addReceiptEntry(entry, label);
        } else proposals.push(entry);
      }
      return;
    }
    if (isRecord15(value)) {
      const keys = Object.keys(value);
      if (value.kind === void 0 && (typeof value.receiptId === "string" || typeof value.receiptHash === "string")) {
        addReceiptEntry(value, label);
        return;
      }
      if (keys.some((key) => VERIFICATION_SUBMISSION_KEYS.has(key))) {
        const unknown = keys.find(
          (key) => !VERIFICATION_SUBMISSION_KEYS.has(key)
        );
        if (unknown) {
          throw new Error(
            verificationFailure(`${label} has unknown field: ${unknown}`)
          );
        }
        if (value.proposals !== void 0) {
          if (!Array.isArray(value.proposals)) {
            throw new Error(
              verificationFailure(`${label}.proposals must be an array`)
            );
          }
          proposals.push(...value.proposals);
        }
        const wrapperIds = value.receiptIds ?? value.receipts;
        if (wrapperIds !== void 0) {
          if (!Array.isArray(wrapperIds)) {
            throw new Error(
              verificationFailure(`${label}.receiptIds must be an array`)
            );
          }
          for (const entry of wrapperIds) {
            if (typeof entry === "string" || isRecord15(entry) && (typeof entry.receiptId === "string" || typeof entry.receiptHash === "string") && (entry.kind === void 0 || entry.kind === "workflow-verification-receipt-reference")) {
              addReceiptEntry(entry, `${label}.receiptIds`);
            } else {
              proposals.push(entry);
            }
          }
        }
        return;
      }
      proposals.push(value);
      return;
    }
    throw new Error(
      verificationFailure(`${label} must be a proposal, wrapper, or array`)
    );
  };
  addValue(submission.verification, "Verification submission");
  addValue(submission.verificationReceipts, "verificationReceipts");
  if (submission.verificationReceiptIds !== void 0) {
    if (!Array.isArray(submission.verificationReceiptIds)) {
      throw new Error(
        verificationFailure("verificationReceiptIds must be an array")
      );
    }
    for (const entry of submission.verificationReceiptIds) {
      if (typeof entry !== "string" || entry.length === 0) {
        throw new Error(
          verificationFailure(
            "verificationReceiptIds must contain non-empty strings"
          )
        );
      }
      receiptIds.push(entry);
    }
  }
  if (submission.receiptIds !== void 0) {
    if (!Array.isArray(submission.receiptIds)) {
      throw new Error(verificationFailure("receiptIds must be an array"));
    }
    for (const entry of submission.receiptIds) {
      if (typeof entry !== "string" || entry.length === 0) {
        throw new Error(
          verificationFailure("receiptIds must contain non-empty strings")
        );
      }
      receiptIds.push(entry);
    }
  }
  if (receiptIds.length > 64 || proposals.length > 64) {
    throw new Error(verificationFailure("submission exceeds its bound"));
  }
  if (new Set(receiptIds).size !== receiptIds.length) {
    throw new Error(
      verificationFailure("submission contains duplicate receipt ids")
    );
  }
  return { proposals, receiptIds };
}
function verificationFailure(message) {
  return `Workflow Verification Receipt ${message}`;
}
function workflowContentSnapshotBinding(state) {
  const snapshots = state.workflowRuntime?.contentSnapshots ?? [];
  if (snapshots.length === 0) return null;
  const ordered = [...snapshots].map((snapshot) => ({
    hash: snapshot.hash,
    path: snapshot.path,
    provider: snapshot.provider,
    complete: snapshot.complete
  })).sort((left, right) => left.hash.localeCompare(right.hash));
  if (ordered.length === 1) return ordered[0].hash;
  return sha256(JSON.stringify(stableValue(ordered)));
}
async function currentWorkflowContentSnapshotBinding(prepared, state) {
  const profile = prepared.verified.identity.durabilityProfile;
  const policy = profile?.snapshotPolicy;
  if (!usesWorkflowContentSnapshots(profile) || !policy) {
    return workflowContentSnapshotBinding(state);
  }
  const references = state.workflowRuntime?.contentSnapshots ?? [];
  if (references.length !== 1) {
    throw new Error(
      verificationFailure(
        "content snapshot binding is unavailable or ambiguous"
      )
    );
  }
  let current;
  try {
    current = await captureWorkflowContentSnapshot({
      root: prepared.location.contentSnapshotRoot,
      policy
    });
  } catch (error) {
    throw new Error(
      verificationFailure(
        `content snapshot could not be recaptured: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
  const currentHash = hashWorkflowContentSnapshot(current);
  if (currentHash !== references[0].hash) {
    throw new Error(
      verificationFailure(`content snapshot is stale: ${references[0].hash}`)
    );
  }
  if (!current.complete) {
    throw new Error(verificationFailure("content snapshot is incomplete"));
  }
  return currentHash;
}
function workflowArtifactDeclaration(protocol, requested) {
  const declarations2 = protocol.outputSchemas.flatMap(
    (schema) => schema.artifacts.map((artifact) => ({
      id: `${schema.id}.${artifact.id}`,
      shortId: artifact.id,
      schemaId: schema.id
    }))
  );
  const exact = declarations2.find(
    (declaration) => declaration.id === requested
  );
  if (exact) return exact;
  const matches = declarations2.filter(
    (declaration) => declaration.shortId === requested
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      verificationFailure(
        `artifact scope requires a schema-qualified id: ${requested}`
      )
    );
  }
  throw new Error(
    verificationFailure(`artifact scope is not declared: ${requested}`)
  );
}
function workflowEvidenceDeclaration(protocol, requested) {
  const declarations2 = protocol.outputSchemas.flatMap(
    (schema) => schema.evidence.map((evidence) => ({
      id: `${schema.id}.${evidence.id}`,
      shortId: evidence.id,
      schemaId: schema.id
    }))
  );
  const exact = declarations2.find(
    (declaration) => declaration.id === requested
  );
  if (exact) return exact;
  const matches = declarations2.filter(
    (declaration) => declaration.shortId === requested
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      verificationFailure(
        `evidence scope requires a schema-qualified id: ${requested}`
      )
    );
  }
  throw new Error(
    verificationFailure(`evidence scope is not declared: ${requested}`)
  );
}
function workflowEvidenceValue(evidence, declaration) {
  if (!evidence) return { found: false };
  for (const key of [declaration.id, declaration.shortId]) {
    if (Object.prototype.hasOwnProperty.call(evidence, key)) {
      return { found: true, value: evidence[key] };
    }
  }
  const schemaEvidence = evidence.schemaEvidence;
  if (!isRecord15(schemaEvidence)) return { found: false };
  if (Object.prototype.hasOwnProperty.call(schemaEvidence, declaration.id)) {
    return { found: true, value: schemaEvidence[declaration.id] };
  }
  const scoped = schemaEvidence[declaration.schemaId];
  if (isRecord15(scoped) && Object.prototype.hasOwnProperty.call(scoped, declaration.shortId)) {
    return { found: true, value: scoped[declaration.shortId] };
  }
  return { found: false };
}
function workflowOutcomeRevision(state, attemptId2, actionId2) {
  let revision = 0;
  for (const visit of state.workflowRuntime?.visits ?? []) {
    for (const outcome of visit.outcomes) {
      if (visit.attemptId === attemptId2 && outcome.actionId === actionId2) {
        return revision;
      }
      revision += 1;
    }
  }
  throw new Error(
    verificationFailure(`evidence producer is not accepted: ${actionId2}`)
  );
}
function workflowEvidenceReference(state, declaration, visit, actionId2, value, required) {
  const nodeId = Object.entries(state.runtimeIdentity?.nodeToStep ?? []).find(
    ([, stepId2]) => stepId2 === visit.stepId
  )?.[0];
  if (!nodeId) {
    throw new Error(
      verificationFailure(`evidence producer Node is unknown: ${visit.stepId}`)
    );
  }
  const producer = {
    runId: state.runId,
    nodeId,
    cycleId: visit.cycleId,
    attemptId: visit.attemptId,
    actionId: actionId2,
    revision: workflowOutcomeRevision(state, visit.attemptId, actionId2)
  };
  const hash4 = sha256(JSON.stringify(stableValue(value)) ?? "undefined");
  return {
    id: declaration.id,
    required,
    versionId: `evidence-version-${sha256(
      JSON.stringify(
        stableValue({ evidenceId: declaration.id, hash: hash4, producer })
      )
    ).slice(0, 24)}`,
    contentHash: hash4,
    producer
  };
}
function currentWorkflowEvidenceReference(protocol, state, requested, required) {
  const declaration = workflowEvidenceDeclaration(protocol, requested);
  const nodeByStep = new Map(
    Object.entries(state.runtimeIdentity?.nodeToStep ?? {}).map(
      ([nodeId, stepId2]) => [stepId2, nodeId]
    )
  );
  for (const visit of [...state.workflowRuntime?.visits ?? []].reverse()) {
    const nodeId = nodeByStep.get(visit.stepId);
    if (!nodeId) continue;
    const node = protocol.nodes.find((candidate) => candidate.id === nodeId);
    if (!node?.outputSchemas.some((schemaId) => schemaId === declaration.schemaId)) {
      continue;
    }
    for (const outcome of [...visit.outcomes].reverse()) {
      if (outcome.status !== "succeeded") continue;
      const value = workflowEvidenceValue(outcome.evidence, declaration);
      if (!value.found) continue;
      return workflowEvidenceReference(
        state,
        declaration,
        visit,
        outcome.actionId,
        value.value,
        required
      );
    }
  }
  return void 0;
}
function sortWorkflowScope(scope) {
  return {
    artifacts: [...scope.artifacts].sort(
      (left, right) => `${left.id}\0${left.versionId}`.localeCompare(
        `${right.id}\0${right.versionId}`
      )
    ),
    evidence: [...scope.evidence].sort(
      (left, right) => `${left.id}\0${left.versionId}`.localeCompare(
        `${right.id}\0${right.versionId}`
      )
    )
  };
}
async function captureWorkflowVerificationScope(prepared, requirement, state) {
  const protocol = prepared.verified.package.runtime.protocol;
  const runtime = state.workflowRuntime;
  if (!runtime) {
    throw new Error(verificationFailure("scope requires revisioned Run state"));
  }
  const artifactVersions = new Map(
    runtime.artifactVersions.map((version) => [version.id, version])
  );
  const currentArtifacts = currentWorkflowArtifactVersions(runtime);
  const artifacts = [];
  for (const entry of requirement.scope.artifacts) {
    const declaration = workflowArtifactDeclaration(protocol, entry.id);
    const versionId = currentArtifacts[declaration.id];
    const version = versionId ? artifactVersions.get(versionId) : void 0;
    if (!version) {
      if (entry.required) {
        throw new Error(
          verificationFailure(
            `required artifact scope is unavailable: ${declaration.id}`
          )
        );
      }
      continue;
    }
    try {
      await validateWorkflowArtifactVersion(
        prepared.location.runRoot,
        protocol,
        version
      );
    } catch (error) {
      throw new Error(
        verificationFailure(
          `artifact scope is stale: ${declaration.id} (${error instanceof Error ? error.message : String(error)})`
        )
      );
    }
    artifacts.push({
      id: declaration.id,
      required: entry.required,
      versionId: version.id,
      contentHash: version.contentHash,
      producer: structuredClone(version.producer)
    });
  }
  const evidence = [];
  for (const entry of requirement.scope.evidence) {
    const declaration = workflowEvidenceDeclaration(protocol, entry.id);
    const reference = currentWorkflowEvidenceReference(
      protocol,
      state,
      declaration.id,
      entry.required
    );
    if (!reference) {
      if (entry.required) {
        throw new Error(
          verificationFailure(
            `required evidence scope is unavailable: ${declaration.id}`
          )
        );
      }
      continue;
    }
    evidence.push(reference);
  }
  return sortWorkflowScope({ artifacts, evidence });
}
function workflowScopeHash(scope) {
  return sha256(JSON.stringify(stableValue(sortWorkflowScope(scope))));
}
function workflowScopeSelectionMatches(expected, submitted) {
  if (submitted === void 0) return;
  if (!isRecord15(submitted)) {
    throw new Error(verificationFailure("proposal scope must be an object"));
  }
  const unknown = Object.keys(submitted).find(
    (key) => key !== "artifacts" && key !== "evidence"
  );
  if (unknown)
    throw new Error(
      verificationFailure(`proposal scope has unknown field: ${unknown}`)
    );
  const validate = (kind) => {
    const rawValues = submitted[kind];
    if (rawValues !== void 0 && !Array.isArray(rawValues)) {
      throw new Error(
        verificationFailure(`proposal ${kind} scope must be an array`)
      );
    }
    const values = rawValues ?? [];
    if (values.length > 64) {
      throw new Error(
        verificationFailure(`proposal ${kind} scope is outside its bound`)
      );
    }
    const seen = /* @__PURE__ */ new Set();
    for (const value of values) {
      if (!isRecord15(value))
        throw new Error(
          verificationFailure(
            `proposal ${kind} scope contains an invalid reference`
          )
        );
      const unknownReference = Object.keys(value).find(
        (key2) => !["id", "required", "versionId", "contentHash", "producer"].includes(
          key2
        )
      );
      if (unknownReference) {
        throw new Error(
          verificationFailure(
            `proposal ${kind} scope has unknown field: ${unknownReference}`
          )
        );
      }
      const key = `${value.id}\0${value.versionId}`;
      if (seen.has(key))
        throw new Error(
          verificationFailure(
            `proposal ${kind} scope contains a duplicate reference`
          )
        );
      seen.add(key);
      const reference = expected[kind].find(
        (candidate) => candidate.id === value.id && candidate.versionId === value.versionId
      );
      if (!reference || value.contentHash !== reference.contentHash || value.required !== void 0 && value.required !== reference.required || value.producer !== void 0 && !sameStableValue4(value.producer, reference.producer)) {
        throw new Error(
          verificationFailure(`${kind} scope does not match the current scope`)
        );
      }
    }
    for (const reference of expected[kind]) {
      if (reference.required && !values.some((value) => isRecord15(value) && value.id === reference.id)) {
        throw new Error(
          verificationFailure(
            `required ${kind} scope is missing: ${reference.id}`
          )
        );
      }
    }
  };
  validate("artifacts");
  validate("evidence");
}
function workflowStateWithArtifactMutation(state, mutation) {
  if (!mutation || !state.workflowRuntime) return state;
  return {
    ...state,
    workflowRuntime: {
      ...state.workflowRuntime,
      artifactVersions: [
        ...state.workflowRuntime.artifactVersions,
        ...structuredClone(mutation.versions)
      ],
      artifactSelections: [
        ...state.workflowRuntime.artifactSelections,
        ...structuredClone(mutation.selections)
      ]
    }
  };
}
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
function boundedRepairEpisode(value) {
  if (!value) return void 0;
  return {
    ...structuredClone(value),
    history: boundProjectedLedger(value.history)
  };
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
  const finalization = value.finalization ? parseWorkflowFinalizationState(
    value.finalization,
    value.execution.durabilityProfile
  ) : void 0;
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
    blockers: legacyBlockersFromFindings(disposition, projected.findings),
    ...value.repair ? { repair: boundedRepairEpisode(value.repair) } : {},
    ...finalization ? { finalization } : {}
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
      if (!isRecord15(result)) continue;
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
function contentSnapshotFindings(state) {
  const incomplete = (state.workflowRuntime?.contentSnapshots ?? []).some(
    (snapshot) => !snapshot.complete
  );
  return incomplete ? [
    snapshotIncompleteFinding(
      "Workflow content snapshot is incomplete and cannot satisfy a complete-scope requirement."
    )
  ] : [];
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
function validateFinalizationSubmissionShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Workflow finalization submission must be an object");
  }
  const keys = /* @__PURE__ */ new Set([
    "planHash",
    "decisionId",
    "choiceId",
    "contentSnapshotHash",
    "verificationReceiptIds"
  ]);
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) {
    throw new Error(
      `Workflow finalization submission has unknown field: ${unknown}`
    );
  }
  for (const [key, entry] of [
    ["planHash", value.planHash],
    ["decisionId", value.decisionId]
  ]) {
    if (entry !== void 0 && (typeof entry !== "string" || entry.length === 0)) {
      throw new Error(
        `Workflow finalization ${key} must be a non-empty string`
      );
    }
  }
  if (value.planHash !== void 0 && !/^[a-f0-9]{64}$/u.test(value.planHash)) {
    throw new Error("Workflow finalization planHash must be a SHA-256 hash");
  }
  if (value.choiceId !== void 0 && value.choiceId !== "confirm" && value.choiceId !== "cancel") {
    throw new Error("Workflow finalization choiceId is invalid");
  }
  if (value.contentSnapshotHash !== void 0 && value.contentSnapshotHash !== null && (typeof value.contentSnapshotHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.contentSnapshotHash))) {
    throw new Error("Workflow finalization contentSnapshotHash is invalid");
  }
  if (value.verificationReceiptIds !== void 0) {
    if (!Array.isArray(value.verificationReceiptIds) || value.verificationReceiptIds.length > 256 || value.verificationReceiptIds.some(
      (entry) => typeof entry !== "string" || entry.length === 0
    )) {
      throw new Error(
        "Workflow finalization verificationReceiptIds are invalid"
      );
    }
    if (new Set(value.verificationReceiptIds).size !== value.verificationReceiptIds.length) {
      throw new Error(
        "Workflow finalization verificationReceiptIds must not contain duplicates"
      );
    }
  }
}
function validateSubmission(submission) {
  if (!submission || typeof submission !== "object") {
    throw new Error("Submission must be an object");
  }
  normalizedVerificationSubmission(submission);
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
    if (submission.runId !== void 0 && (typeof submission.runId !== "string" || !submission.runId)) {
      throw new Error("Decision runId must be a non-empty string");
    }
    if (!Number.isSafeInteger(submission.revision) || submission.revision < 0) {
      throw new Error("Decision revision must be a non-negative integer");
    }
    if (!submission.nodeId && submission.nodeId !== null) {
      throw new Error("Decision Node id must be a non-empty string or null");
    }
    if (submission.cycleId !== null && (typeof submission.cycleId !== "string" || !submission.cycleId)) {
      throw new Error("Decision cycle id must be a string or null");
    }
    if (!submission.attemptId && submission.attemptId !== null) {
      throw new Error("Decision Attempt id must be a non-empty string or null");
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
    if (submission.finalization !== void 0) {
      validateFinalizationSubmissionShape(submission.finalization);
    }
    return;
  }
  if (submission.runId !== void 0 && (typeof submission.runId !== "string" || !submission.runId)) {
    throw new Error("Submission runId must be a non-empty string");
  }
  if (submission.revision !== void 0 && (!Number.isSafeInteger(submission.revision) || submission.revision < 0)) {
    throw new Error("Submission revision must be a non-negative integer");
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
  if (Object.prototype.hasOwnProperty.call(submission, "repair")) {
    throw new Error(
      "Repair decision fields are only valid for decision submissions"
    );
  }
  if (submission.finalization !== void 0) {
    validateFinalizationSubmissionShape(submission.finalization);
  }
  if (submission.repairDecision !== void 0 || submission.repairFailure !== void 0) {
    throw new Error("Workflow repair outcomes are runtime-generated");
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
  const withSnapshots = boundWorkflowFindings([
    ...projected.findings,
    ...contentSnapshotFindings(result.state)
  ]);
  const withRepair = boundWorkflowFindings([
    ...withSnapshots.findings,
    ...repairFindings(result.state)
  ]);
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
    verificationReceipts: boundProjectedLedger(
      runtimeState?.verificationReceipts ?? []
    ),
    cycles: boundProjectedLedger(runtimeState?.cycles ?? []),
    visits: result.action?.type === "ask_user" ? boundProjectedLedger(redactVisitEvidence(runtimeState?.visits ?? [])) : boundProjectedLedger(runtimeState?.visits ?? []),
    artifactVersions: boundProjectedLedger(
      runtimeState?.artifactVersions ?? []
    ),
    artifactSelections: boundProjectedLedger(
      runtimeState?.artifactSelections ?? []
    ),
    contentSnapshots: boundProjectedLedger(
      runtimeState?.contentSnapshots ?? []
    ),
    currentArtifactVersions: currentWorkflowArtifactVersions(runtimeState),
    findings: withRepair.findings,
    findingSummary: withRepair.summary,
    requiresUserDecision: withRepair.findings.some(
      (finding) => finding.requiresUserDecision
    ),
    blockers: legacyBlockersFromFindings(disposition, withRepair.findings),
    ...runtimeState?.repairEpisode ? { repair: boundedRepairEpisode(runtimeState.repairEpisode) } : {},
    ...runtimeState?.finalization ? { finalization: structuredClone(runtimeState.finalization) } : {}
  };
}
function withAdditionalFindings(value, additional, disposition = value.disposition) {
  const projected = boundWorkflowFindings([...value.findings, ...additional]);
  return {
    ...value,
    disposition,
    findings: projected.findings,
    findingSummary: projected.summary,
    requiresUserDecision: projected.findings.some(
      (finding) => finding.requiresUserDecision
    ),
    blockers: legacyBlockersFromFindings(disposition, projected.findings)
  };
}
function checkpointFindings(inspections, severity) {
  return inspections.filter((inspection) => inspection.error !== void 0).map(
    (inspection) => checkpointInvalidFinding(
      `Workflow checkpoint revision ${inspection.entry.revision} is invalid: ${inspection.error}`,
      `.comet/checkpoints/manifests/${inspection.entry.manifestHash}.json`,
      severity
    )
  );
}
function checkpointIndexFinding(error, severity) {
  return checkpointInvalidFinding(
    `Workflow checkpoint index is invalid: ${error instanceof Error ? error.message : String(error)}`,
    ".comet/checkpoints/index.json",
    severity
  );
}
async function checkpointRecoveryRequiredContinuation(location, journal) {
  let base;
  let verified;
  try {
    verified = await verifyStoredRun(location);
    base = await continuationFromVerifiedRun(verified, location.runRoot);
  } catch (error) {
    const profile = journal.execution.durabilityProfile;
    if (!profile) throw error;
    const index = await readWorkflowCheckpointIndex(location.runRoot, profile);
    const entry = index?.records.find(
      (candidate2) => candidate2.recordHash === journal.checkpointRecordHash
    );
    if (!entry) throw error;
    const candidate = await verifyWorkflowCheckpointCandidate(
      location.runRoot,
      profile,
      entry
    );
    base = continuation(
      { state: candidate.state, action: candidate.pending, evals: [] },
      candidate.identity
    );
  }
  return withAdditionalFindings(
    base,
    [
      recoveryRequiredFinding(
        base.revision,
        base.pendingAction?.id ?? null,
        ".comet/checkpoint-recovery-journal.json"
      )
    ],
    "blocked"
  );
}
async function persistWorkflowCheckpoint(location, state, pending, pkg) {
  const profile = state.runtimeIdentity?.durabilityProfile;
  if (!usesWorkflowCheckpoints(profile)) return;
  await createWorkflowCheckpoint({
    runRoot: location.runRoot,
    state,
    pending,
    identity: identityFromState(state),
    package: pkg,
    profile
  });
}
var LEGACY_STATE_MAX_BYTES = 256 * 1024;
function isRecord15(value) {
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
    state.trajectoryRef,
    durabilityReadOptions(state, "trajectoryBytes")
  );
  for (const event of trajectory) {
    if (event.type !== "action_completed") continue;
    if (!isRecord15(event.data.action) || !isRecord15(event.data.outcome)) continue;
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
    evidence[node] = isRecord15(outcomeEvidence) ? structuredClone(outcomeEvidence) : {};
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
  const projectedBaseFindings = status === "blocked" ? boundWorkflowFindings([
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
  const snapshotFindings = [];
  const snapshotPolicy = verified.identity.durabilityProfile?.snapshotPolicy;
  if (usesWorkflowContentSnapshots(verified.identity.durabilityProfile) && snapshotPolicy) {
    for (const reference of runtimeState?.contentSnapshots ?? []) {
      const snapshot = await readWorkflowContentSnapshot(
        location.runRoot,
        reference.hash,
        snapshotPolicy.limits.maxManifestBytes
      );
      if (snapshot) {
        snapshotFindings.push(...workflowContentSnapshotFindings(snapshot));
      }
    }
  }
  const projectedFindings = boundWorkflowFindings([
    ...projectedBaseFindings.findings,
    ...snapshotFindings,
    ...repairFindings(state)
  ]);
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
    verificationReceipts: boundProjectedLedger(
      runtimeState?.verificationReceipts ?? []
    ),
    visits: verified.pending?.type === "ask_user" ? boundProjectedLedger(redactVisitEvidence(runtimeState?.visits ?? [])) : boundProjectedLedger(runtimeState?.visits ?? []),
    cycles: boundProjectedLedger(runtimeState?.cycles ?? []),
    artifactVersions: boundProjectedLedger(
      runtimeState?.artifactVersions ?? []
    ),
    artifactSelections: boundProjectedLedger(
      runtimeState?.artifactSelections ?? []
    ),
    contentSnapshots: boundProjectedLedger(
      runtimeState?.contentSnapshots ?? []
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
    ),
    ...runtimeState?.repairEpisode ? { repair: boundedRepairEpisode(runtimeState.repairEpisode) } : {},
    ...runtimeState?.finalization ? { finalization: structuredClone(runtimeState.finalization) } : {}
  };
}
async function writeWorkflowStateProjection(target, projection) {
  const projectRoot = resolveWorkflowRunLocation(target).runRoot;
  const label = "Workflow state projection";
  const relativePath2 = normalizeWorkflowRelativePath(
    projection.statePath,
    `${label} path`
  );
  const content = JSON.stringify(projection, null, 2) + "\n";
  if (Buffer.byteLength(content, "utf8") > LEGACY_STATE_MAX_BYTES) {
    throw new Error(`${label} exceeds ${LEGACY_STATE_MAX_BYTES} bytes`);
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let inspection = await inspectProtectedProjectPath(
      projectRoot,
      relativePath2,
      { label, expected: "file" }
    );
    if (inspection.exists) {
      try {
        const existing = await readProtectedProjectFile(
          projectRoot,
          relativePath2,
          LEGACY_STATE_MAX_BYTES,
          { label }
        );
        if (Buffer.from(existing.bytes).equals(Buffer.from(content))) return;
      } catch (error) {
        if (!(error instanceof RaceSafeReadError) || error.reason !== "changed" || attempt === 2) {
          throw error;
        }
        continue;
      }
    }
    const parent = path17.posix.dirname(relativePath2);
    if (parent !== ".") {
      await ensureProtectedProjectDirectory(projectRoot, parent, { label });
      inspection = await inspectProtectedProjectPath(
        projectRoot,
        relativePath2,
        {
          label,
          expected: "file"
        }
      );
    }
    await atomicWriteContainedText(inspection.target, content, {
      containedRoot: inspection.projectRoot
    });
    return;
  }
}
async function verifyStoredVerificationReceipts(runRoot, state, identity, pkg) {
  const profile = identity.durabilityProfile;
  const references = state.workflowRuntime?.verificationReceipts ?? [];
  if (references.length === 0) return;
  if (!profile?.capabilities.includes("verification-receipts")) {
    throw new Error(
      "WorkflowRuntime verification receipt state requires verification-receipts capability"
    );
  }
  if (profile.bounds.verificationReceiptCount !== void 0 && references.length > profile.bounds.verificationReceiptCount) {
    throw new Error(
      "WorkflowRuntime verification receipt count exceeds its bound"
    );
  }
  const ids = /* @__PURE__ */ new Set();
  for (const reference of references) {
    if (ids.has(reference.receiptId)) {
      throw new Error(
        `WorkflowRuntime verification receipt is duplicated: ${reference.receiptId}`
      );
    }
    ids.add(reference.receiptId);
    const receipt = await readWorkflowVerificationReceipt(
      runRoot,
      reference.receiptHash,
      profile
    );
    if (!receipt) {
      throw new Error(
        `WorkflowRuntime verification receipt is missing: ${reference.receiptId}`
      );
    }
    if (!receiptReferencesEqual(
      workflowVerificationReceiptReference(receipt),
      reference
    ) || receipt.runId !== state.runId || receipt.protocolHash !== identity.protocolHash || receipt.packageHash !== identity.packageHash || receipt.snapshotHash !== identity.snapshotHash || !sameExecutionIdentity(receipt.execution, identity)) {
      throw new Error(
        `WorkflowRuntime verification receipt identity is invalid: ${reference.receiptId}`
      );
    }
    for (const candidate of receipt.candidateArtifacts) {
      const version = state.workflowRuntime?.artifactVersions.find(
        (entry) => entry.id === candidate.versionId
      );
      if (!version || version.artifactId !== candidate.artifactId || version.contentHash !== candidate.contentHash || !sameStableValue4(version.producer, candidate.producer)) {
        throw new Error(
          `WorkflowRuntime verification receipt candidate artifact identity is invalid: ${reference.receiptId}`
        );
      }
    }
    for (const candidate of receipt.scope.evidence) {
      const declaration = workflowEvidenceDeclaration(
        pkg.runtime.protocol,
        candidate.id
      );
      const visit = state.workflowRuntime?.visits.find(
        (entry) => entry.attemptId === candidate.producer.attemptId
      );
      const outcome2 = visit?.outcomes.find(
        (entry) => entry.actionId === candidate.producer.actionId
      );
      const value = workflowEvidenceValue(outcome2?.evidence, declaration);
      if (!visit || !outcome2 || outcome2.status !== "succeeded" || !value.found) {
        throw new Error(
          `WorkflowRuntime verification receipt evidence identity is invalid: ${reference.receiptId}`
        );
      }
      const expected = workflowEvidenceReference(
        state,
        declaration,
        visit,
        outcome2.actionId,
        value.value,
        candidate.required
      );
      if (!sameStableValue4(expected, candidate)) {
        throw new Error(
          `WorkflowRuntime verification receipt evidence identity is invalid: ${reference.receiptId}`
        );
      }
    }
    const outcomeLocation = state.workflowRuntime?.visits.map((visit) => ({
      visit,
      outcome: visit.outcomes.find(
        (outcome2) => outcome2.verificationReceiptIds?.includes(reference.receiptId)
      )
    })).find((candidate) => candidate.outcome !== void 0);
    if (!outcomeLocation) {
      throw new Error(
        `WorkflowRuntime verification receipt is detached from an outcome: ${reference.receiptId}`
      );
    }
    const outcome = outcomeLocation.outcome;
    if (!outcome) {
      throw new Error(
        `WorkflowRuntime verification receipt is detached from an outcome: ${reference.receiptId}`
      );
    }
    const nodeId = Object.entries(identity.nodeToStep).find(
      ([, stepId2]) => stepId2 === outcomeLocation.visit.stepId
    )?.[0];
    const node = pkg.runtime?.protocol.nodes.find(
      (candidate) => candidate.id === nodeId
    );
    const requirement = verificationRequirements(node).find(
      (candidate) => candidate.id === receipt.requirementId
    );
    if (!nodeId || !node || !requirement || receipt.role !== requirement.role || !requirement.kinds.includes(receipt.receiptKind) || receipt.nodeId !== nodeId || receipt.attemptId !== outcomeLocation.visit.attemptId || receipt.cycleId !== outcomeLocation.visit.cycleId || receipt.actionId !== outcome.actionId || receipt.revision !== workflowOutcomeRevision(
      state,
      outcomeLocation.visit.attemptId,
      outcome.actionId
    )) {
      throw new Error(
        `WorkflowRuntime verification receipt context is invalid: ${reference.receiptId}`
      );
    }
  }
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
  if (identity.durabilityProfile !== void 0 && (identity.capabilityVersion !== 3 || identity.resolverHash === void 0 || identity.findingCatalogVersion !== WORKFLOW_FINDING_CATALOG_VERSION || pkg.runtime.capabilityVersion !== 3 || pkg.runtime.resolverHash === void 0 || pkg.runtime.findingCatalogVersion !== WORKFLOW_FINDING_CATALOG_VERSION)) {
    throw new Error(
      "WorkflowRuntime durability profile requires complete execution identity"
    );
  }
  if (!sameDurabilityProfile(
    identity.durabilityProfile,
    pkg.runtime.durabilityProfile
  ) || !sameDurabilityProfile(
    identity.durabilityProfile,
    pkg.runtime.protocol.capabilities?.durability
  )) {
    throw new Error(
      "WorkflowRuntime durability profile identity does not match Skill snapshot"
    );
  }
  if (usesWorkflowContentSnapshots(identity.durabilityProfile)) {
    const snapshotPolicy = identity.durabilityProfile?.snapshotPolicy;
    const references = state.workflowRuntime?.contentSnapshots ?? [];
    if (!snapshotPolicy || references.length === 0) {
      throw new Error(
        "WorkflowRuntime content snapshot references are missing"
      );
    }
    for (const reference of references) {
      const snapshot = await readWorkflowContentSnapshot(
        runRoot,
        reference.hash,
        snapshotPolicy.limits.maxManifestBytes
      );
      if (!snapshot) {
        throw new Error(
          `WorkflowRuntime content snapshot is missing: ${reference.hash}`
        );
      }
      if (snapshot.complete !== reference.complete || !sameStableValue4(snapshot.policy, snapshotPolicy)) {
        throw new Error(
          `WorkflowRuntime content snapshot identity is invalid: ${reference.hash}`
        );
      }
    }
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
  await verifyStoredVerificationReceipts(runRoot, state, identity, pkg);
  const verificationReceiptIds = new Set(
    state.workflowRuntime?.verificationReceipts.map(
      (reference) => reference.receiptId
    ) ?? []
  );
  for (const visit of state.workflowRuntime?.visits ?? []) {
    for (const outcome of visit.outcomes) {
      for (const receiptId2 of outcome.verificationReceiptIds ?? []) {
        if (!verificationReceiptIds.has(receiptId2)) {
          throw new Error(
            `WorkflowRuntime verification receipt reference is unknown: ${receiptId2}`
          );
        }
      }
    }
  }
  for (const receipt of state.workflowRuntime?.decisionReceipts ?? []) {
    for (const verificationReceiptId of receipt.verificationReceiptIds ?? []) {
      if (!verificationReceiptIds.has(verificationReceiptId)) {
        throw new Error(
          `WorkflowRuntime Decision Receipt references an unknown Verification Receipt: ${verificationReceiptId}`
        );
      }
    }
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
async function verifyStoredRepairEpisode(runRoot, state, identity) {
  const episode = state.workflowRuntime?.repairEpisode;
  if (!episode) {
    if (identity.durabilityProfile?.capabilities.includes("repair-policy")) {
      throw new Error("WorkflowRuntime repair episode is missing");
    }
    return;
  }
  if (!identity.durabilityProfile?.capabilities.includes("repair-policy")) {
    throw new Error(
      "WorkflowRuntime repair episode has no repair-policy capability"
    );
  }
  const expectedExecutionHash = sha256(JSON.stringify(stableValue(identity)));
  if (episode.signature && (episode.signature.protocolHash !== identity.protocolHash || episode.signature.executionHash !== expectedExecutionHash)) {
    throw new Error(
      "WorkflowRuntime repair signature is not bound to Run identity"
    );
  }
  const trajectory = await readTrajectory(
    runRoot,
    state.trajectoryRef,
    durabilityReadOptions(state, "trajectoryBytes")
  );
  const proof = [];
  for (const event of trajectory) {
    if (event.type !== "action_completed" || !isRecord15(event.data.outcome)) {
      continue;
    }
    const outcome = event.data.outcome;
    if (isRecord15(outcome.repairFailure) && isRecord15(outcome.repairFailure.signature)) {
      const rawSignature = outcome.repairFailure.signature;
      const signature = buildWorkflowRepairSignature({
        protocolHash: rawSignature.protocolHash,
        executionHash: rawSignature.executionHash,
        actionId: rawSignature.actionId,
        attemptId: rawSignature.attemptId,
        nodeId: rawSignature.nodeId,
        cycleId: rawSignature.cycleId,
        visitOrdinal: rawSignature.visitOrdinal,
        findingCodes: rawSignature.findingCodes,
        failedReceiptCoverage: rawSignature.failedReceiptCoverage,
        failedAcceptanceCoverage: rawSignature.failedAcceptanceCoverage,
        scopeIdentities: rawSignature.scopeIdentities,
        snapshotIdentities: rawSignature.snapshotIdentities,
        artifactIdentities: rawSignature.artifactIdentities
      });
      if (rawSignature.signatureHash !== signature.signatureHash) {
        throw new Error(
          "WorkflowRuntime repair failure signature is not canonical"
        );
      }
      if (rawSignature.protocolHash !== identity.protocolHash || rawSignature.executionHash !== expectedExecutionHash) {
        throw new Error(
          "WorkflowRuntime repair failure identity is not bound to Run"
        );
      }
      const automaticRepair = outcome.repairFailure.automaticRepair === null || outcome.repairFailure.automaticRepair === void 0 ? void 0 : parseWorkflowRepairAutomaticOperation(
        outcome.repairFailure.automaticRepair
      );
      proof.push({
        kind: "failure",
        signatureHash: signature.signatureHash,
        findingCodes: signature.findingCodes,
        failedReceiptCoverage: signature.failedReceiptCoverage,
        failedAcceptanceCoverage: signature.failedAcceptanceCoverage,
        scopeIdentities: signature.scopeIdentities,
        snapshotIdentities: signature.snapshotIdentities,
        artifactIdentities: signature.artifactIdentities,
        disposition: outcome.repairFailure.disposition,
        reasonCode: outcome.repairFailure.reasonCode,
        consecutiveFailures: outcome.repairFailure.consecutiveFailures,
        totalFailures: outcome.repairFailure.totalFailures,
        remainingFailures: outcome.repairFailure.remainingFailures,
        overrideAccepted: outcome.repairFailure.overrideAccepted,
        ...automaticRepair ? { automaticRepair } : {}
      });
    }
    if (isRecord15(outcome.repairDecision)) {
      const repairDecision = outcome.repairDecision;
      if (typeof repairDecision.signatureHash !== "string" || !/^[a-f0-9]{64}$/u.test(repairDecision.signatureHash)) {
        throw new Error("WorkflowRuntime repair decision signature is invalid");
      }
      if (typeof repairDecision.decisionId !== "string" || typeof repairDecision.choiceId !== "string" || repairDecision.outcome !== "retry" && repairDecision.outcome !== "stop" && repairDecision.outcome !== "contract-change" || !isRecord15(repairDecision.reviewer) || typeof repairDecision.reviewer.subject !== "string" || !Array.isArray(repairDecision.reviewer.authorities) || repairDecision.reviewer.authorities.some(
        (authority) => typeof authority !== "string"
      )) {
        throw new Error("WorkflowRuntime repair decision evidence is invalid");
      }
      const hypothesis = typeof repairDecision.hypothesis === "string" ? repairDecision.hypothesis.trim() : "";
      const rationale = typeof repairDecision.rationale === "string" ? repairDecision.rationale.trim() : "";
      proof.push({
        kind: hypothesis.length > 0 ? "override" : "decision",
        signatureHash: repairDecision.signatureHash,
        actionId: outcome.actionId,
        decisionId: repairDecision.decisionId,
        choiceId: repairDecision.choiceId,
        outcome: repairDecision.outcome,
        reviewer: {
          subject: repairDecision.reviewer.subject,
          authorities: [...repairDecision.reviewer.authorities].sort(
            (left, right) => left.localeCompare(right)
          )
        },
        ...hypothesis.length > 0 ? {
          rationaleHash: hashWorkflowRepairText(rationale),
          hypothesisHash: hashWorkflowRepairText(hypothesis)
        } : {
          rationaleHash: rationale.length > 0 ? hashWorkflowRepairText(rationale) : null
        }
      });
    }
  }
  if (proof.length !== episode.history.length) {
    throw new Error(
      "WorkflowRuntime repair history is detached from trajectory"
    );
  }
  for (const [index, record] of episode.history.entries()) {
    const evidence = proof[index];
    if (!evidence || record.kind !== evidence.kind) {
      throw new Error("WorkflowRuntime repair history order is invalid");
    }
    if (record.signatureHash !== evidence.signatureHash) {
      throw new Error("WorkflowRuntime repair history signature is invalid");
    }
    if (record.kind === "failure") {
      if (!sameStableValue4(record.findingCodes, evidence.findingCodes) || !sameStableValue4(
        record.failedReceiptCoverage,
        evidence.failedReceiptCoverage
      ) || !sameStableValue4(
        record.failedAcceptanceCoverage,
        evidence.failedAcceptanceCoverage
      ) || !sameStableValue4(record.scopeIdentities, evidence.scopeIdentities) || !sameStableValue4(
        record.snapshotIdentities,
        evidence.snapshotIdentities
      ) || !sameStableValue4(
        record.artifactIdentities,
        evidence.artifactIdentities
      ) || record.disposition !== evidence.disposition || record.reasonCode !== evidence.reasonCode || record.consecutiveFailures !== evidence.consecutiveFailures || record.totalFailures !== evidence.totalFailures || record.remainingFailures !== evidence.remainingFailures || record.overrideAccepted !== evidence.overrideAccepted || !sameStableValue4(record.automaticRepair, evidence.automaticRepair)) {
        throw new Error("WorkflowRuntime repair failure coverage is invalid");
      }
      continue;
    }
    if (record.kind === "decision") {
      if (record.actionId !== evidence.actionId || record.decisionId !== evidence.decisionId || record.choiceId !== evidence.choiceId || record.outcome !== evidence.outcome || !sameStableValue4(record.reviewer, evidence.reviewer) || record.rationaleHash !== evidence.rationaleHash) {
        throw new Error("WorkflowRuntime repair decision history is invalid");
      }
    } else if (record.actionId !== evidence.actionId || record.decisionId !== evidence.decisionId || record.choiceId !== evidence.choiceId || record.outcome !== evidence.outcome || !sameStableValue4(record.reviewer, evidence.reviewer) || record.rationaleHash !== evidence.rationaleHash || record.hypothesisHash !== evidence.hypothesisHash) {
      throw new Error("WorkflowRuntime repair override history is invalid");
    }
  }
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
  const finalization = state.workflowRuntime?.finalization;
  const finalizationDefinition = verified.package.runtime?.protocol.finalization;
  if (finalization && (!finalizationDefinition || !usesWorkflowFinalization(verified.identity.durabilityProfile))) {
    throw new Error(
      "WorkflowRuntime finalization state is not declared by the Run"
    );
  }
  if (finalizationDefinition && usesWorkflowFinalization(verified.identity.durabilityProfile) && state.status === "completed" && finalization?.status !== "committed") {
    throw new Error(
      "WorkflowRuntime completed Run lacks committed finalization"
    );
  }
  if (finalization?.status === "committed" || finalization?.receipt) {
    const profile = verified.identity.durabilityProfile;
    const reference = finalization.receipt;
    if (!profile || !reference) {
      throw new Error("WorkflowRuntime finalization receipt is missing");
    }
    const receipt = await readWorkflowFinalizationReceipt(
      location.runRoot,
      reference.receiptHash,
      profile
    );
    if (!receipt || !sameStableValue4(workflowFinalizationReceiptReference(receipt), reference)) {
      throw new Error(
        "WorkflowRuntime finalization receipt identity is invalid"
      );
    }
  }
  await verifyStoredRepairEpisode(location.runRoot, state, verified.identity);
  return { state, ...verified, pending };
}
var WorkflowRevisionConflictError = class extends Error {
  constructor(verified, finding) {
    super(finding.message);
    this.verified = verified;
    this.finding = finding;
    this.name = "WorkflowRevisionConflictError";
  }
  verified;
  finding;
};
function phase4SubmissionConflict(verified, submission) {
  if (verified.identity.durabilityProfile === void 0) return void 0;
  const runtimeState = verified.state.workflowRuntime;
  if (!runtimeState) {
    throw new Error("Phase 4 WorkflowRuntime state is missing");
  }
  if (!submission.runId) {
    throw new Error("Phase 4 submission runId is required");
  }
  if (submission.revision === void 0) {
    throw new Error("Phase 4 submission revision is required");
  }
  if (!submission.execution) {
    throw new Error("Phase 4 submission execution identity is required");
  }
  let identityMatches = samePhase4ExecutionIdentity(
    submission.execution,
    verified.identity
  );
  if (isDecisionSubmission(submission)) {
    const flatIdentity = [
      submission.protocolHash,
      submission.packageHash,
      submission.snapshotHash
    ];
    if (flatIdentity.some((value) => value !== void 0)) {
      identityMatches = identityMatches && submission.protocolHash === verified.identity.protocolHash && submission.packageHash === verified.identity.packageHash && submission.snapshotHash === verified.identity.snapshotHash;
    }
  }
  const currentActionId = verified.pending?.id ?? verified.state.pending ?? null;
  if (submission.runId !== verified.state.runId || submission.revision !== runtimeState.revision || submission.actionId !== currentActionId || !identityMatches) {
    return revisionConflictFinding(runtimeState.revision, currentActionId);
  }
  return void 0;
}
function throwOnPhase4SubmissionConflict(verified, submission) {
  const finding = phase4SubmissionConflict(verified, submission);
  if (finding) throw new WorkflowRevisionConflictError(verified, finding);
}
async function assertRevisionFence(location, input, checkPendingAction = true) {
  const state = await location.readState();
  if (!state) {
    throw new Error("WorkflowRuntime Run disappeared during submission");
  }
  const currentRevision = state.workflowRuntime?.revision ?? 0;
  const currentActionId = state.pending;
  const pending = checkPendingAction ? await readPendingAction(
    location.runRoot,
    state.pendingRef,
    durabilityReadOptions(state, "pendingActionBytes")
  ) : null;
  if (state.runId !== input.runId || currentRevision !== input.expectedRevision || currentActionId !== input.expectedActionId || checkPendingAction && (!pending || pending.id !== input.expectedActionId) || !state.runtimeIdentity || !samePhase4ExecutionIdentity(identityFromState(state), input.execution)) {
    const current = await verifyStoredRun(location);
    throw new WorkflowRevisionConflictError(
      current,
      revisionConflictFinding(currentRevision, currentActionId)
    );
  }
}
async function continuationFromVerifiedRun(verified, runRoot) {
  const trajectory = await readTrajectory(
    runRoot,
    verified.state.trajectoryRef,
    durabilityReadOptions(verified.state, "trajectoryBytes")
  );
  const base = continuation(
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
  const snapshotFindings = [];
  const snapshotPolicy = verified.identity.durabilityProfile?.snapshotPolicy;
  if (usesWorkflowContentSnapshots(verified.identity.durabilityProfile) && snapshotPolicy) {
    for (const reference of verified.state.workflowRuntime?.contentSnapshots ?? []) {
      const snapshot = await readWorkflowContentSnapshot(
        runRoot,
        reference.hash,
        snapshotPolicy.limits.maxManifestBytes
      );
      if (snapshot)
        snapshotFindings.push(...workflowContentSnapshotFindings(snapshot));
    }
  }
  return withAdditionalFindings(base, snapshotFindings);
}
async function inspectWorkflowRun(target) {
  return withStructuredRuntimeErrors(async () => {
    const location = resolveWorkflowRunLocation(target);
    const journal = await readWorkflowTransitionJournal(location.runRoot);
    if (journal) return recoveryRequiredContinuation(location, journal);
    const checkpointRecovery = await readWorkflowCheckpointRecoveryJournal(
      location.runRoot
    );
    if (checkpointRecovery) {
      return checkpointRecoveryRequiredContinuation(
        location,
        checkpointRecovery
      );
    }
    try {
      const storedState = await location.readState();
      if (!storedState) return null;
      const profile = storedState.runtimeIdentity?.durabilityProfile;
      if (profile?.capabilities.includes("transactional-finalization")) {
        const transaction = await readWorkflowFinalizationTransaction(
          location.runRoot,
          profile
        );
        if (transaction) {
          return finalizationRecoveryRequiredContinuation(
            location,
            transaction
          );
        }
      }
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
async function previewWorkflowFinalization(target) {
  return withStructuredRuntimeErrors(async () => {
    const location = resolveWorkflowRunLocation(target);
    const journal = await readWorkflowTransitionJournal(location.runRoot);
    if (journal) {
      throw new Error(
        "Workflow finalization preview is unavailable during recovery"
      );
    }
    const locationProfile = await durabilityProfileForLocation(location);
    if (locationProfile?.capabilities.includes("transactional-finalization")) {
      const transaction = await readWorkflowFinalizationTransaction(
        location.runRoot,
        locationProfile
      );
      if (transaction) {
        throw new WorkflowFinalizationTransactionPendingError(transaction);
      }
    }
    const verified = await verifyStoredRun(location);
    const definition = verified.package.runtime?.protocol.finalization;
    const profile = verified.identity.durabilityProfile;
    if (!definition || !profile?.capabilities.includes("transactional-finalization")) {
      throw new Error("Workflow finalization is not enabled for this Run");
    }
    await validateFinalizationEvidenceBindings(
      location,
      verified.state,
      definition,
      profile
    );
    return buildWorkflowFinalizationPreview({
      baseRoot: location.contentSnapshotRoot,
      state: verified.state,
      execution: verified.identity,
      definition,
      profile
    });
  });
}
function stringValues(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}
function repairFactsForSubmission(prepared, submission, mutation) {
  const runtime = prepared.verified.state.workflowRuntime;
  const failedReceipts = [
    ...runtime?.verificationReceipts ?? [],
    ...mutation?.verificationReceipts ?? []
  ].filter((receipt) => receipt.status !== "passed").filter(
    (receipt, index, values) => values.findIndex(
      (candidate) => candidate.requirementId === receipt.requirementId && candidate.status === receipt.status && candidate.scopeHash === receipt.scopeHash
    ) === index
  );
  const failedReceiptCoverage = failedReceipts.map(
    (receipt) => `${receipt.requirementId}:${receipt.status}:${receipt.scopeHash}`
  );
  const evidence = !isDecisionSubmission(submission) ? submission.evidence : void 0;
  const failedAcceptanceCoverage = [
    ...stringValues(evidence && evidence.failedAcceptanceIds),
    ...stringValues(evidence && evidence.failedCheckIds),
    ...stringValues(evidence && evidence.failedAcceptanceCoverage)
  ];
  const findingCodes2 = [
    ...failedReceipts.map(() => "verification-receipt-failed"),
    ...stringValues(evidence && evidence.findingCodes)
  ];
  if (findingCodes2.length === 0) findingCodes2.push("action-failed");
  if (failedAcceptanceCoverage.length === 0 && failedReceipts.length === 0) {
    failedAcceptanceCoverage.push(
      `node:${prepared.node ?? prepared.pending.stepId}`
    );
  }
  const scopeIdentities = [
    ...failedReceipts.map((receipt) => receipt.scopeHash),
    ...stringValues(evidence && evidence.scopeIdentities),
    ...stringValues(evidence && evidence.scopeHashes),
    ...typeof evidence?.scopeHash === "string" ? [evidence.scopeHash] : []
  ];
  const snapshotIdentities = [
    ...(runtime?.contentSnapshots ?? []).map((snapshot) => snapshot.hash),
    ...failedReceipts.map((receipt) => receipt.contentSnapshotHash).filter((hash4) => hash4 !== null),
    ...stringValues(evidence && evidence.snapshotIdentities),
    ...stringValues(evidence && evidence.snapshotHashes),
    ...typeof evidence?.snapshotHash === "string" ? [evidence.snapshotHash] : []
  ];
  const artifactIdentities = [
    ...(runtime?.artifactVersions ?? []).map(
      (version) => `${version.artifactId}:${version.id}:${version.contentHash}`
    ),
    ...(mutation?.versions ?? []).map(
      (version) => `${version.artifactId}:${version.id}:${version.contentHash}`
    ),
    ...stringValues(evidence && evidence.artifactIdentities),
    ...stringValues(evidence && evidence.artifactHashes),
    ...typeof evidence?.artifactHash === "string" ? [evidence.artifactHash] : []
  ];
  return {
    protocolHash: prepared.verified.identity.protocolHash,
    execution: prepared.verified.identity,
    actionId: prepared.pending.id,
    attemptId: runtime?.currentAttempt?.id ?? null,
    nodeId: prepared.node,
    cycleId: runtime?.currentAttempt?.cycleId ?? null,
    visitOrdinal: runtime?.currentAttempt?.visitOrdinal ?? null,
    findingCodes: findingCodes2,
    failedReceiptCoverage,
    failedAcceptanceCoverage,
    scopeIdentities,
    snapshotIdentities,
    artifactIdentities
  };
}
function repairFailureForSubmission(prepared, submission, mutation) {
  if (isDecisionSubmission(submission) || submission.status !== "failed" || !prepared.node) {
    return void 0;
  }
  const profile = prepared.verified.identity.durabilityProfile;
  if (!profile?.capabilities.includes("repair-policy") || !profile.repairPolicy) {
    return void 0;
  }
  const facts = repairFactsForSubmission(prepared, submission, mutation);
  const decision = decideWorkflowRepair({
    facts,
    history: prepared.verified.state.workflowRuntime?.repairEpisode?.history ?? [],
    policy: profile.repairPolicy,
    maxHistoryRecords: profile.bounds.repairHistoryCount
  });
  let pendingDecision;
  if (decision.disposition === "manual-stop") {
    const attempt = prepared.verified.state.workflowRuntime?.currentAttempt;
    if (!attempt) {
      throw new Error("Workflow repair stop requires a current Attempt");
    }
    const policy = normalizeWorkflowRepairPolicy(profile.repairPolicy);
    const failureRevision = (prepared.verified.state.workflowRuntime?.revision ?? 0) + 1;
    const decisionId = `workflow-repair-${decision.signature.signatureHash.slice(0, 24)}`;
    const actionId2 = `workflow-repair-decision-${sha256(
      JSON.stringify(
        stableValue({
          runId: prepared.verified.state.runId,
          attemptId: attempt.id,
          signatureHash: decision.signature.signatureHash,
          failureRevision
        })
      )
    ).slice(0, 24)}`;
    pendingDecision = {
      schemaVersion: 1,
      decisionId,
      actionId: actionId2,
      signatureHash: decision.signature.signatureHash,
      failureRevision,
      attemptId: attempt.id,
      stepId: attempt.stepId,
      nodeId: prepared.node,
      cycleId: attempt.cycleId,
      visitOrdinal: attempt.visitOrdinal,
      retryOrdinal: attempt.retryOrdinal + 1,
      choices: structuredClone(policy.allowedChoices),
      rationale: structuredClone(policy.rationale),
      reviewer: structuredClone(policy.reviewer)
    };
  }
  return {
    signature: decision.signature,
    disposition: decision.disposition,
    reasonCode: decision.reasonCode,
    consecutiveFailures: decision.consecutiveFailures,
    totalFailures: decision.totalFailures,
    remainingFailures: decision.remainingFailures,
    overrideAccepted: decision.overrideAccepted,
    ...decision.automaticRepair ? { automaticRepair: decision.automaticRepair } : {},
    ...pendingDecision ? { pendingDecision } : {}
  };
}
function repairFindings(state) {
  const episode = state.workflowRuntime?.repairEpisode;
  if (!episode?.signature) return [];
  if (episode.disposition === "warning") {
    return [
      repairStagnationWarningFinding(
        episode.signature.signatureHash,
        episode.consecutiveFailures,
        episode.remainingFailures
      )
    ];
  }
  if (episode.disposition === "manual-stop") {
    if (!episode.pendingDecision) {
      return [
        repairStagnationStopFinding(
          episode.signature.signatureHash,
          episode.consecutiveFailures,
          episode.remainingFailures,
          false
        )
      ];
    }
    return episode.reasonCode === "override-already-used" ? [repairOverrideExhaustedFinding(episode.signature.signatureHash)] : [
      repairStagnationStopFinding(
        episode.signature.signatureHash,
        episode.consecutiveFailures,
        episode.remainingFailures
      )
    ];
  }
  if (episode.disposition === "hard-stop") {
    return [repairIterationLimitFinding(episode.signature.signatureHash)];
  }
  return [];
}
async function prepareWorkflowSubmission(target, submission) {
  const location = resolveWorkflowRunLocation(target);
  const verified = await verifyStoredRun(location);
  throwOnPhase4SubmissionConflict(verified, submission);
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
  if (isWorkflowFinalizationAction(pending)) {
    validateFinalizationDecisionResponse(verified, pending, submission);
    return;
  }
  if (isWorkflowRepairAction(pending)) {
    validateRepairDecisionResponse(verified, pending, node, submission);
    return;
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
  if (submission.repair !== void 0) {
    throw new Error(
      "Repair decision fields are only valid for a repair action"
    );
  }
}
function validateFinalizationDecisionResponse(verified, pending, submission) {
  const finalization = pending.finalization;
  const stateFinalization = verified.state.workflowRuntime?.finalization;
  if (!stateFinalization || stateFinalization.status !== "awaiting-confirmation" || !stateFinalization.pendingConfirmation || !sameStableValue4(stateFinalization.pendingConfirmation, finalization)) {
    throw new Error("Workflow finalization confirmation state is invalid");
  }
  if (submission.revision !== verified.state.workflowRuntime?.revision || submission.nodeId !== null || submission.attemptId !== null || submission.cycleId !== null) {
    throw new Error(
      "Workflow finalization confirmation context does not match the Run"
    );
  }
  validateDecisionExecution(submission, verified.identity);
  if (submission.decisionId !== void 0 && submission.decisionId !== finalization.decisionId) {
    throw new Error(
      "Workflow finalization decision id does not match the pending action"
    );
  }
  if (submission.choiceId !== "confirm" && submission.choiceId !== "cancel") {
    throw new Error("Workflow finalization choice is invalid");
  }
  if (submission.inputs && Object.keys(submission.inputs).length > 0) {
    throw new Error(
      "Workflow finalization confirmation does not accept inputs"
    );
  }
  if (submission.scope !== void 0 || submission.evidenceReferences !== void 0 || submission.repair !== void 0) {
    throw new Error(
      "Workflow finalization confirmation does not accept extra scope"
    );
  }
  validateReviewer(submission.reviewer, finalization.reviewer);
  const input = submission.finalization;
  if (!input || input.planHash !== finalization.planHash || input.decisionId !== finalization.decisionId || input.choiceId !== submission.choiceId || input.contentSnapshotHash !== finalization.contentSnapshotHash || !sameStableValue4(
    [...input.verificationReceiptIds ?? []].sort(
      (left, right) => left.localeCompare(right)
    ),
    finalization.verificationReceiptIds
  )) {
    throw new Error("Workflow finalization confirmation is stale");
  }
  if (finalization.rationale.required && !submission.rationale) {
    throw new Error("Workflow finalization confirmation rationale is required");
  }
  if (submission.rationale !== void 0 && Buffer.byteLength(submission.rationale, "utf8") > (verified.identity.durabilityProfile?.bounds.finalizationContentBytes ?? 64 * 1024)) {
    throw new Error(
      "Workflow finalization confirmation rationale exceeds its bound"
    );
  }
}
function validateRepairDecisionResponse(verified, pending, node, submission) {
  const repair = pending.repair;
  const runtime = verified.state.workflowRuntime;
  const episode = runtime?.repairEpisode;
  if (!runtime || !episode || episode.pendingDecision === void 0) {
    throw new Error("Workflow repair decision state is missing");
  }
  if (submission.revision !== runtime.revision || submission.nodeId !== repair.nodeId || submission.attemptId !== repair.attemptId || submission.cycleId !== repair.cycleId) {
    throw new Error("Workflow repair decision context does not match the Run");
  }
  if (node !== repair.nodeId) {
    throw new Error("Workflow repair decision Node does not match the Run");
  }
  validateDecisionExecution(submission, verified.identity);
  if (submission.decisionId !== void 0 && submission.decisionId !== repair.decisionId) {
    throw new Error(
      "Workflow repair decision id does not match the pending action"
    );
  }
  const choice = repair.choices.find(
    (candidate) => candidate.id === submission.choiceId
  );
  if (!choice) {
    throw new Error(
      `Workflow repair choice is not declared: ${submission.choiceId}`
    );
  }
  if (submission.inputs && Object.keys(submission.inputs).length > 0) {
    throw new Error("Workflow repair decisions do not accept inputs");
  }
  if (submission.scope !== void 0 || submission.evidenceReferences !== void 0) {
    throw new Error("Workflow repair decisions do not accept evidence scope");
  }
  validateReviewer(submission.reviewer, repair.reviewer);
  const policy = verified.identity.durabilityProfile?.repairPolicy;
  if (!policy) throw new Error("Workflow repair decision policy is missing");
  const normalizedPolicy = normalizeWorkflowRepairPolicy(policy);
  const repairInput = submission.repair;
  if (repairInput !== void 0 && (!repairInput || typeof repairInput !== "object" || Array.isArray(repairInput))) {
    throw new Error("Workflow repair input must be an object");
  }
  if (repairInput !== void 0) {
    const unknown = Object.keys(repairInput).find(
      (key) => ![
        "expectedSignatureHash",
        "signatureHash",
        "rationale",
        "hypothesis",
        "summary"
      ].includes(key)
    );
    if (unknown)
      throw new Error(`Workflow repair input has unknown field: ${unknown}`);
    if (repairInput.expectedSignatureHash !== void 0 && repairInput.signatureHash !== void 0 && repairInput.expectedSignatureHash !== repairInput.signatureHash) {
      throw new Error("Workflow repair input signature aliases disagree");
    }
    for (const [label, value] of [
      ["expectedSignatureHash", repairInput.expectedSignatureHash],
      ["signatureHash", repairInput.signatureHash],
      ["rationale", repairInput.rationale],
      ["hypothesis", repairInput.hypothesis],
      ["summary", repairInput.summary]
    ]) {
      if (value !== void 0 && typeof value !== "string") {
        throw new Error(`Workflow repair input ${label} must be a string`);
      }
    }
  }
  const expectedSignature = repairInput?.expectedSignatureHash ?? repairInput?.signatureHash;
  if (expectedSignature !== void 0 && expectedSignature !== repair.signatureHash) {
    throw new Error(
      "Workflow repair decision signature does not match the pending episode"
    );
  }
  const rawRationale = repairInput?.rationale ?? submission.rationale;
  const rawHypothesis = repairInput?.hypothesis ?? repairInput?.summary ?? (choice.id === "retry-with-new-approach" ? submission.rationale : void 0);
  const rationale = rawRationale === void 0 ? void 0 : normalizeWorkflowRepairText(rawRationale, "Workflow repair rationale");
  const hypothesis = rawHypothesis === void 0 ? void 0 : normalizeWorkflowRepairText(
    rawHypothesis,
    "Workflow repair hypothesis"
  );
  if (repair.rationale.required && !rationale) {
    throw new Error("Workflow repair decision rationale is required");
  }
  const overrideRequested = expectedSignature !== void 0 || hypothesis !== void 0;
  if (!overrideRequested) return;
  if (choice.outcome !== "retry") {
    throw new Error("Workflow repair override must choose a retry outcome");
  }
  if (!normalizedPolicy.allowOneTimeOverride) {
    throw new Error("Workflow repair override is not allowed by policy");
  }
  if (episode.totalFailures >= normalizedPolicy.maxFailures) {
    throw new Error("Workflow repair hard stop cannot be overridden");
  }
  if (expectedSignature !== repair.signatureHash) {
    throw new Error(
      "Workflow repair override requires the current failure signature"
    );
  }
  if (!rationale || !hypothesis) {
    throw new Error(
      "Workflow repair override requires rationale and hypothesis"
    );
  }
  if (Buffer.byteLength(rationale, "utf8") > normalizedPolicy.maxOverrideRationaleBytes || Buffer.byteLength(hypothesis, "utf8") > normalizedPolicy.maxOverrideRationaleBytes) {
    throw new Error("Workflow repair override rationale exceeds its bound");
  }
  const overrideAlreadyUsed = episode.history.some(
    (record) => record.kind === "override" && record.signatureHash === repair.signatureHash
  );
  if (overrideAlreadyUsed) {
    throw new Error(
      "Workflow repair override has already been used for this signature"
    );
  }
  const hypothesisHash = hashWorkflowRepairText(
    hypothesis,
    "Workflow repair hypothesis",
    normalizedPolicy.maxOverrideRationaleBytes
  );
  if (episode.history.some(
    (record) => record.signatureHash === repair.signatureHash && (record.kind === "override" && record.hypothesisHash === hypothesisHash || record.kind === "decision" && record.hypothesisHash === hypothesisHash)
  )) {
    throw new Error(
      "Workflow repair override hypothesis is not materially new"
    );
  }
}
function engineOutcome(prepared, submission, artifactMutation, repairFailure) {
  if (isWorkflowFinalizationAction(prepared.pending)) {
    if (!isDecisionSubmission(submission) || !submission.finalization) {
      throw new Error(
        "Workflow finalization confirmation requires a decision submission"
      );
    }
    return {
      actionId: prepared.pending.id,
      status: "succeeded",
      summary: `Workflow finalization ${submission.choiceId}.`,
      kind: "decision",
      decisionId: prepared.pending.finalization.decisionId,
      choiceId: submission.choiceId,
      reviewer: structuredClone(submission.reviewer),
      ...submission.rationale !== void 0 ? { rationale: submission.rationale } : {},
      finalization: {
        ...structuredClone(submission.finalization),
        decisionId: prepared.pending.finalization.decisionId,
        choiceId: submission.choiceId
      }
    };
  }
  if (isWorkflowRepairAction(prepared.pending)) {
    if (!isDecisionSubmission(submission)) {
      throw new Error(
        "Workflow repair decision requires a decision submission"
      );
    }
    const choice2 = prepared.pending.repair.choices.find(
      (candidate) => candidate.id === submission.choiceId
    );
    if (!choice2) {
      throw new Error(
        `Workflow repair choice is not declared: ${submission.choiceId}`
      );
    }
    return {
      actionId: prepared.pending.id,
      status: "succeeded",
      summary: `Repair decision ${prepared.pending.repair.decisionId}: ${choice2.id}`,
      revision: submission.revision,
      nodeId: submission.nodeId,
      cycleId: submission.cycleId,
      ...submission.attemptId !== null ? { attemptId: submission.attemptId } : {},
      repairDecision: {
        decisionId: prepared.pending.repair.decisionId,
        signatureHash: prepared.pending.repair.signatureHash,
        choiceId: choice2.id,
        outcome: choice2.outcome,
        reviewer: structuredClone(submission.reviewer),
        ...(submission.repair?.rationale ?? submission.rationale) !== void 0 ? { rationale: submission.repair?.rationale ?? submission.rationale } : {},
        ...submission.repair?.hypothesis || submission.repair?.summary || choice2.id === "retry-with-new-approach" ? {
          hypothesis: submission.repair?.hypothesis ?? submission.repair?.summary ?? submission.rationale
        } : {}
      }
    };
  }
  if (!isDecisionSubmission(submission)) {
    const artifacts = artifactMutation ? artifactMutation.artifactPaths : submission.artifacts;
    const evidence = submission.evidence ? structuredClone(submission.evidence) : void 0;
    if (evidence) {
      delete evidence.verification;
      delete evidence.verificationReceipts;
      delete evidence.verificationReceiptIds;
    }
    return {
      actionId: prepared.pending.id,
      status: submission.status,
      summary: submission.summary,
      ...artifacts && Object.keys(artifacts).length > 0 ? { artifacts } : {},
      ...submission.state ? { state: submission.state } : {},
      ...evidence && Object.keys(evidence).length > 0 ? { evidence } : {},
      ...submission.routing ? { routing: submission.routing } : {},
      ...artifactMutation && Object.keys(artifactMutation.selectedVersionIds).length > 0 ? { artifactVersions: artifactMutation.selectedVersionIds } : submission.artifactVersions ? { artifactVersions: submission.artifactVersions } : {},
      ...artifactMutation && (artifactMutation.verificationReceipts?.length ?? 0) > 0 ? {
        verificationReceiptIds: artifactMutation.verificationReceipts.map(
          (reference) => reference.receiptId
        )
      } : {},
      ...repairFailure ? { repairFailure } : {},
      ...submission.finalization ? { finalization: structuredClone(submission.finalization) } : {}
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
    ...submission.attemptId !== null ? { attemptId: submission.attemptId } : {},
    decisionId: decision.id,
    choiceId: choice.id,
    reviewer: structuredClone(submission.reviewer),
    inputs: structuredClone(submission.inputs ?? {}),
    ...submission.rationale !== void 0 ? { rationale: submission.rationale } : {},
    ...submission.evidenceReferences ? { evidenceReferences: [...submission.evidenceReferences] } : {},
    ...prepared.pending.scope ? { scope: structuredClone(prepared.pending.scope) } : {},
    ...artifactMutation && (artifactMutation.verificationReceipts?.length ?? 0) > 0 ? {
      verificationReceiptIds: artifactMutation.verificationReceipts.map(
        (reference) => reference.receiptId
      )
    } : {},
    routing: {
      [decision.id]: choice.id,
      ...choice.routing ?? {}
    }
  };
}
async function completionBlockers(prepared, submission, mutation) {
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
  const satisfiedGuardrails = new Set(
    workflowNode.guardrails.filter((guardrail) => guardrail.verification !== void 0).filter(
      (guardrail) => (mutation?.verificationReceipts ?? []).some(
        (receipt) => receipt.status === "passed" && receipt.requirementId === (guardrail.verification?.id ?? guardrail.id)
      )
    ).map((guardrail) => `guardrail:${workflowNode.id}.${guardrail.id}`)
  );
  return validateSuccessfulSubmission(
    prepared.location.runRoot,
    prepared.verified.package.runtime.protocol,
    workflowNode,
    plan,
    submission,
    satisfiedGuardrails
  );
}
function routeBlockers(prepared, submission, artifactMutation) {
  const protocol = prepared.verified.package.runtime.protocol;
  if (isWorkflowRepairAction(prepared.pending) || isWorkflowFinalizationAction(prepared.pending))
    return [];
  if (!isDecisionSubmission(submission) && submission.status !== "succeeded" || !prepared.node || !isRevisionedWorkflowProtocol(protocol)) {
    return [];
  }
  try {
    resolveWorkflowTransition(
      protocol,
      prepared.node,
      engineOutcome(prepared, submission, artifactMutation),
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
    if (error instanceof RaceSafeReadError) {
      return { blockers: [error.message] };
    }
    throw error;
  }
}
function mergeWorkflowMutations(artifact, verification) {
  if (!artifact && !verification) return void 0;
  return {
    versions: [
      ...artifact?.versions ?? [],
      ...verification?.versions ?? []
    ],
    selections: [
      ...artifact?.selections ?? [],
      ...verification?.selections ?? []
    ],
    artifactPaths: {
      ...artifact?.artifactPaths ?? {},
      ...verification?.artifactPaths ?? {}
    },
    selectedVersionIds: {
      ...artifact?.selectedVersionIds ?? {},
      ...verification?.selectedVersionIds ?? {}
    },
    ...verification?.verificationReceipts || verification?.verificationReceiptRecords ? {
      verificationReceipts: [
        ...artifact?.verificationReceipts ?? [],
        ...verification.verificationReceipts ?? []
      ],
      verificationReceiptRecords: [
        ...artifact?.verificationReceiptRecords ?? [],
        ...verification.verificationReceiptRecords ?? []
      ]
    } : artifact?.verificationReceipts || artifact?.verificationReceiptRecords ? {
      verificationReceipts: [...artifact.verificationReceipts ?? []],
      verificationReceiptRecords: [
        ...artifact.verificationReceiptRecords ?? []
      ]
    } : {}
  };
}
function prepareVerificationReceiptRecords(mutation, profile) {
  const records = mutation?.verificationReceiptRecords ?? [];
  if (records.length === 0) return void 0;
  if (!profile) {
    throw new Error(
      verificationFailure("persistence requires a durability profile")
    );
  }
  return async (_runRoot, _state, _outcome, overlay) => {
    if (!overlay) {
      throw new Error(verificationFailure("persistence requires a transition"));
    }
    const seen = /* @__PURE__ */ new Set();
    for (const receipt of records) {
      if (seen.has(receipt.receiptHash)) continue;
      seen.add(receipt.receiptHash);
      const reference = await stageWorkflowVerificationReceipt({
        runRoot: _runRoot,
        receipt,
        transition: overlay,
        profile
      });
      const referenceIndex = mutation?.verificationReceipts?.findIndex(
        (candidate) => candidate.receiptHash === receipt.receiptHash
      );
      if (referenceIndex !== void 0 && referenceIndex >= 0) {
        mutation.verificationReceipts[referenceIndex] = reference;
      }
    }
  };
}
function receiptReferencesEqual(left, right) {
  return sameStableValue4(left, right);
}
async function validateCurrentVerificationReceipt(prepared, requirement, receipt, reference, scope, contentSnapshotHash) {
  const identity = prepared.verified.identity;
  const state = prepared.verified.state;
  const runtime = state.workflowRuntime;
  const attempt = runtime?.currentAttempt;
  const expectedKinds = requirement.kinds;
  if (!receiptReferencesEqual(
    workflowVerificationReceiptReference(receipt),
    reference
  )) {
    throw new Error(
      verificationFailure(
        `reference does not match stored receipt: ${receipt.receiptId}`
      )
    );
  }
  if (receipt.runId !== state.runId || receipt.revision !== runtime?.revision || receipt.actionId !== prepared.pending.id || receipt.nodeId !== prepared.node || receipt.cycleId !== (attempt?.cycleId ?? null) || receipt.attemptId !== attempt?.id || receipt.protocolHash !== identity.protocolHash || receipt.packageHash !== identity.packageHash || receipt.snapshotHash !== identity.snapshotHash || !sameExecutionIdentity(receipt.execution, identity) || receipt.requirementId !== requirement.id || receipt.role !== requirement.role || !expectedKinds.includes(receipt.receiptKind) || receipt.scopeHash !== workflowScopeHash(scope) || !sameStableValue4(receipt.scope, scope) || receipt.contentSnapshotHash !== contentSnapshotHash || !sameStableValue4(
    receipt.candidateArtifacts,
    scope.artifacts.map((entry) => ({
      artifactId: entry.id,
      versionId: entry.versionId,
      contentHash: entry.contentHash,
      producer: entry.producer
    }))
  )) {
    throw new Error(verificationFailure(`is stale: ${receipt.receiptId}`));
  }
  for (const artifact of scope.artifacts) {
    const version = runtime?.artifactVersions.find(
      (candidate) => candidate.id === artifact.versionId
    );
    if (!version) {
      throw new Error(
        verificationFailure(
          `candidate artifact is missing: ${artifact.versionId}`
        )
      );
    }
    try {
      await validateWorkflowArtifactVersion(
        prepared.location.runRoot,
        prepared.verified.package.runtime.protocol,
        version
      );
    } catch (error) {
      throw new Error(
        verificationFailure(
          `candidate artifact is stale: ${artifact.versionId} (${error instanceof Error ? error.message : String(error)})`
        )
      );
    }
  }
}
function receiptIdsForRequirement(refs, requirement, submittedIds) {
  return refs.filter(
    (reference) => reference.requirementId === requirement.id && (submittedIds.includes(reference.receiptId) || submittedIds.includes(reference.receiptHash))
  );
}
async function verificationMutationForSubmission(prepared, submission, artifactMutation) {
  if (isWorkflowRepairAction(prepared.pending)) return { blockers: [] };
  const input = normalizedVerificationSubmission(submission);
  const submissionSucceeded = isDecisionSubmission(submission) || submission.status === "succeeded";
  if (input.proposals.length === 0 && input.receiptIds.length === 0) {
    const node2 = prepared.verified.package.runtime.protocol.nodes.find(
      (candidate) => candidate.id === prepared.node
    );
    const requirements2 = verificationRequirements(node2);
    return {
      blockers: submissionSucceeded ? requirements2.map(
        (requirement) => verificationFailure(`is required: ${requirement.id}`)
      ) : []
    };
  }
  const profile = prepared.verified.identity.durabilityProfile;
  if (!profile || !profile.capabilities.includes("verification-receipts")) {
    return {
      blockers: [
        verificationFailure(
          "submissions require the verification-receipts capability"
        )
      ]
    };
  }
  const node = prepared.verified.package.runtime.protocol.nodes.find(
    (candidate) => candidate.id === prepared.node
  );
  const requirements = verificationRequirements(node);
  if (requirements.length === 0) {
    return {
      blockers: [
        verificationFailure("has no declared requirement for this Node")
      ]
    };
  }
  const normalizedProposals = [];
  const blockers = [];
  for (const proposal of input.proposals) {
    try {
      normalizedProposals.push(
        normalizeWorkflowVerificationProposal(proposal, profile)
      );
    } catch (error) {
      blockers.push(
        error instanceof Error ? error.message : verificationFailure(String(error))
      );
    }
  }
  if (blockers.length > 0) return { blockers };
  const projectedState = workflowStateWithArtifactMutation(
    prepared.verified.state,
    artifactMutation
  );
  const mutation = {
    versions: [],
    selections: [],
    artifactPaths: {},
    selectedVersionIds: {},
    verificationReceipts: [],
    verificationReceiptRecords: []
  };
  const usedProposalIndexes = /* @__PURE__ */ new Set();
  const usedReceiptIds = /* @__PURE__ */ new Set();
  for (const requirement of requirements) {
    const matchingProposals = normalizedProposals.map((proposal, index) => ({ proposal, index })).filter(
      ({ proposal }) => (proposal.requirementId === void 0 || proposal.requirementId === requirement.id) && (proposal.role === void 0 || proposal.role === requirement.role) && requirement.kinds.includes(proposal.kind)
    );
    if (matchingProposals.length > 1) {
      blockers.push(
        verificationFailure(
          `has duplicate proposals for requirement: ${requirement.id}`
        )
      );
      continue;
    }
    const submittedRefs = receiptIdsForRequirement(
      prepared.verified.state.workflowRuntime?.verificationReceipts ?? [],
      requirement,
      input.receiptIds
    );
    if (matchingProposals.length > 0 && submittedRefs.length > 0) {
      blockers.push(
        verificationFailure(
          `cannot submit a proposal and existing receipt together: ${requirement.id}`
        )
      );
      continue;
    }
    if (matchingProposals.length === 0 && submittedRefs.length > 1) {
      blockers.push(
        verificationFailure(
          `has multiple existing receipts for requirement: ${requirement.id}`
        )
      );
      continue;
    }
    if (matchingProposals.length === 0 && submittedRefs.length === 0) {
      if (submissionSucceeded) {
        blockers.push(verificationFailure(`is required: ${requirement.id}`));
      }
      continue;
    }
    let expectedScope;
    let expectedSnapshotHash;
    try {
      expectedScope = await captureWorkflowVerificationScope(
        prepared,
        requirement,
        projectedState
      );
      expectedSnapshotHash = await currentWorkflowContentSnapshotBinding(
        prepared,
        projectedState
      );
    } catch (error) {
      blockers.push(
        error instanceof Error ? error.message : verificationFailure(String(error))
      );
      continue;
    }
    if (requirement.requireContentSnapshot && expectedSnapshotHash === null) {
      blockers.push(
        verificationFailure(`requires a content snapshot: ${requirement.id}`)
      );
      continue;
    }
    if (matchingProposals.length > 0) {
      const { proposal, index } = matchingProposals[0];
      usedProposalIndexes.add(index);
      if (proposal.requirementId !== void 0 && proposal.requirementId !== requirement.id) {
        blockers.push(
          verificationFailure(
            `proposal requirement does not match: ${requirement.id}`
          )
        );
        continue;
      }
      if (proposal.role !== void 0 && proposal.role !== requirement.role) {
        blockers.push(
          verificationFailure(
            `proposal role does not match: ${requirement.id}`
          )
        );
        continue;
      }
      try {
        workflowScopeSelectionMatches(expectedScope, proposal.scope);
        if (proposal.artifactVersions !== void 0) {
          for (const [requestedId, versionId] of Object.entries(
            proposal.artifactVersions
          )) {
            const declaration = workflowArtifactDeclaration(
              prepared.verified.package.runtime.protocol,
              requestedId
            );
            const expected = expectedScope.artifacts.find(
              (reference3) => reference3.id === declaration.id
            );
            if (!expected || expected.versionId !== versionId) {
              throw new Error(
                verificationFailure(
                  `candidate artifact version is stale: ${requestedId}`
                )
              );
            }
          }
        }
        if (proposal.contentSnapshotHash !== void 0 && proposal.contentSnapshotHash !== expectedSnapshotHash) {
          throw new Error(
            verificationFailure(`content snapshot is stale: ${requirement.id}`)
          );
        }
        const receipt2 = createWorkflowVerificationReceipt(
          {
            proposal,
            requirementId: requirement.id,
            role: requirement.role,
            runId: prepared.verified.state.runId,
            revision: prepared.verified.state.workflowRuntime?.revision ?? 0,
            actionId: prepared.pending.id,
            nodeId: prepared.node,
            cycleId: prepared.verified.state.workflowRuntime?.currentAttempt?.cycleId ?? null,
            attemptId: prepared.verified.state.workflowRuntime?.currentAttempt?.id ?? "",
            execution: structuredClone(prepared.verified.identity),
            protocolHash: prepared.verified.identity.protocolHash,
            packageHash: prepared.verified.identity.packageHash,
            snapshotHash: prepared.verified.identity.snapshotHash,
            scope: expectedScope,
            contentSnapshotHash: expectedSnapshotHash
          },
          profile
        );
        const reference2 = workflowVerificationReceiptReference(receipt2);
        mutation.verificationReceipts.push(reference2);
        mutation.verificationReceiptRecords.push(receipt2);
        if (submissionSucceeded && receipt2.status !== "passed") {
          blockers.push(
            verificationFailure(
              `does not pass requirement ${requirement.id}: ${receipt2.status}`
            )
          );
        }
      } catch (error) {
        blockers.push(
          error instanceof Error ? error.message : verificationFailure(String(error))
        );
      }
      continue;
    }
    const reference = submittedRefs[0];
    for (const submittedId of input.receiptIds) {
      if (submittedId === reference.receiptId || submittedId === reference.receiptHash) {
        usedReceiptIds.add(submittedId);
      }
    }
    if (!profile.capabilities.includes("verification-receipts")) {
      blockers.push(
        verificationFailure(
          "reuse requires the verification-receipts capability"
        )
      );
      continue;
    }
    let receipt;
    try {
      receipt = await readWorkflowVerificationReceipt(
        prepared.location.runRoot,
        reference.receiptHash,
        profile
      );
      if (!receipt)
        throw new Error(
          verificationFailure(`is missing: ${reference.receiptId}`)
        );
      await validateCurrentVerificationReceipt(
        prepared,
        requirement,
        receipt,
        reference,
        expectedScope,
        expectedSnapshotHash
      );
      mutation.verificationReceipts.push(reference);
      if (submissionSucceeded && receipt.status !== "passed") {
        blockers.push(
          verificationFailure(
            `does not pass requirement ${requirement.id}: ${receipt.status}`
          )
        );
      }
    } catch (error) {
      blockers.push(
        error instanceof Error ? error.message : verificationFailure(String(error))
      );
    }
  }
  for (const [index, proposal] of normalizedProposals.entries()) {
    if (!usedProposalIndexes.has(index)) {
      blockers.push(
        verificationFailure(
          `proposal does not match a declared requirement: ${proposal.requirementId ?? proposal.role ?? proposal.kind}`
        )
      );
    }
  }
  for (const receiptId2 of input.receiptIds) {
    if (!usedReceiptIds.has(receiptId2)) {
      blockers.push(
        verificationFailure(
          `receipt reference does not match a declared requirement: ${receiptId2}`
        )
      );
    }
  }
  const existingCount = prepared.verified.state.workflowRuntime?.verificationReceipts.length ?? 0;
  const newIds = new Set(
    mutation.verificationReceipts.map((reference) => reference.receiptId)
  );
  const newCount = [...newIds].filter(
    (id) => !(prepared.verified.state.workflowRuntime?.verificationReceipts ?? []).some((reference) => reference.receiptId === id)
  ).length;
  if (profile.bounds.verificationReceiptCount !== void 0 && existingCount + newCount > profile.bounds.verificationReceiptCount) {
    blockers.push(verificationFailure("count exceeds its configured bound"));
  }
  return {
    mutation: blockers.length === 0 ? mutation : mutation,
    blockers
  };
}
function blockedContinuation(prepared, blockers) {
  const projected = boundWorkflowFindings([
    ...blockers.map(
      (blocker) => findingFromBlocker(blocker, {
        actionId: prepared.pending.id,
        nodeId: prepared.node
      })
    ),
    ...repairFindings(prepared.verified.state)
  ]);
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
    verificationReceipts: structuredClone(
      prepared.verified.state.workflowRuntime?.verificationReceipts ?? []
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
    contentSnapshots: structuredClone(
      prepared.verified.state.workflowRuntime?.contentSnapshots ?? []
    ),
    currentArtifactVersions: currentWorkflowArtifactVersions(
      prepared.verified.state.workflowRuntime
    ),
    findings: projected.findings,
    findingSummary: projected.summary,
    requiresUserDecision: projected.findings.some(
      (finding) => finding.requiresUserDecision
    ),
    blockers: legacyBlockersFromFindings("blocked", projected.findings),
    ...prepared.verified.state.workflowRuntime?.repairEpisode ? {
      repair: boundedRepairEpisode(
        prepared.verified.state.workflowRuntime.repairEpisode
      )
    } : {},
    ...prepared.verified.state.workflowRuntime?.finalization ? {
      finalization: structuredClone(
        prepared.verified.state.workflowRuntime.finalization
      )
    } : {}
  };
}
function conflictContinuation(verified, finding) {
  const base = continuation(
    {
      state: verified.state,
      action: verified.pending,
      evals: []
    },
    verified.identity
  );
  const projected = boundWorkflowFindings([finding]);
  return {
    ...base,
    disposition: "blocked",
    findings: projected.findings,
    findingSummary: projected.summary,
    requiresUserDecision: projected.findings.some(
      (candidate) => candidate.requiresUserDecision
    ),
    blockers: legacyBlockersFromFindings("blocked", projected.findings)
  };
}
async function recoveryRequiredContinuation(location, journal) {
  const stateRecord2 = journal.records.find(
    (candidate) => candidate.kind === "state"
  );
  if (!stateRecord2) {
    throw new Error("Workflow transition journal has no state record");
  }
  const declaredStates = [
    stateRecord2.previous.content === null ? void 0 : {
      label: "previous",
      state: parseRunStateValue(
        JSON.parse(stateRecord2.previous.content)
      )
    },
    stateRecord2.intended.content === null ? void 0 : {
      label: "intended",
      state: parseRunStateValue(
        JSON.parse(stateRecord2.intended.content)
      )
    }
  ].filter(
    (candidate) => Boolean(candidate)
  );
  let current = null;
  try {
    current = await location.readState();
  } catch {
    current = null;
  }
  const selected = declaredStates.find(
    (candidate) => current !== null && JSON.stringify(stableValue(candidate.state)) === JSON.stringify(stableValue(current))
  ) ?? declaredStates.find((candidate) => candidate.label === "previous") ?? declaredStates.find((candidate) => candidate.label === "intended");
  if (!selected) {
    throw new Error("Workflow transition journal has no usable Run state");
  }
  const state = selected.state;
  let action = null;
  if (state.pending) {
    const record = journal.records.find(
      (candidate) => candidate.path === state.pendingRef && candidate[selected.label].content !== null
    );
    const content = record?.[selected.label].content;
    if (content !== void 0 && content !== null) {
      action = parsePendingActionValue(JSON.parse(content));
    }
  }
  const base = continuation({ state, action, evals: [] }, journal.execution);
  const projected = boundWorkflowFindings([
    recoveryRequiredFinding(
      state.workflowRuntime?.revision ?? journal.previous.revision,
      state.pending
    )
  ]);
  return {
    ...base,
    disposition: "blocked",
    findings: projected.findings,
    findingSummary: projected.summary,
    requiresUserDecision: projected.findings.some(
      (finding) => finding.requiresUserDecision
    ),
    blockers: legacyBlockersFromFindings("blocked", projected.findings)
  };
}
async function finalizationRecoveryRequiredContinuation(location, transaction, unknownPaths = []) {
  const verified = await verifyStoredRun(location);
  return withAdditionalFindings(
    await continuationFromVerifiedRun(verified, location.runRoot),
    [
      recoveryRequiredFinding(
        verified.state.workflowRuntime?.revision ?? transaction.revision,
        verified.state.pending,
        ".comet/finalization/transaction.json"
      ),
      ...unknownPaths.map(
        (unknownPath) => findingFromBlocker(
          `Workflow finalization observed an unknown file identity: ${unknownPath}`,
          { path: unknownPath }
        )
      )
    ],
    "blocked"
  );
}
async function validateFinalizationEvidenceBindings(location, state, definition, profile) {
  for (const receiptId2 of definition.requiredVerificationReceiptIds ?? []) {
    const reference = state.workflowRuntime?.verificationReceipts.find(
      (candidate) => candidate.receiptId === receiptId2
    );
    if (!reference) {
      throw new Error(
        `Workflow finalization verification receipt is missing: ${receiptId2}`
      );
    }
    if (reference.status !== "passed") {
      throw new Error(
        `Workflow finalization verification receipt is not passed: ${receiptId2}`
      );
    }
    const receipt = await readWorkflowVerificationReceipt(
      location.runRoot,
      reference.receiptHash,
      profile
    );
    if (!receipt || !sameStableValue4(workflowVerificationReceiptReference(receipt), reference)) {
      throw new Error(
        `Workflow finalization verification receipt is stale: ${receiptId2}`
      );
    }
  }
  if (definition.requireContentSnapshot === true) {
    const reference = state.workflowRuntime?.contentSnapshots?.at(-1);
    const policy = profile.snapshotPolicy;
    if (!reference || !policy) {
      throw new Error("Workflow finalization requires a content snapshot");
    }
    const snapshot = await readWorkflowContentSnapshot(
      location.runRoot,
      reference.hash,
      policy.limits.maxManifestBytes
    );
    if (!snapshot || hashWorkflowContentSnapshot(snapshot) !== reference.hash || !reference.complete || !snapshot.complete) {
      throw new Error("Workflow finalization content snapshot is stale");
    }
  }
}
async function finalizationSubmissionBlockers(prepared, submission) {
  const definition = prepared.verified.package.runtime?.protocol.finalization;
  const profile = prepared.verified.identity.durabilityProfile;
  if (!definition || !profile) return [];
  if (isWorkflowFinalizationAction(prepared.pending)) {
    await validateFinalizationEvidenceBindings(
      prepared.location,
      prepared.verified.state,
      definition,
      profile
    );
    const preview = await buildWorkflowFinalizationPreview({
      baseRoot: prepared.location.contentSnapshotRoot,
      state: prepared.verified.state,
      execution: prepared.verified.identity,
      definition,
      profile
    });
    return preview.planHash === prepared.pending.finalization.planHash ? [] : ["Workflow finalization preview is stale"];
  }
  if (!isDecisionSubmission(submission) && submission.finalization?.planHash !== void 0) {
    await validateFinalizationEvidenceBindings(
      prepared.location,
      prepared.verified.state,
      definition,
      profile
    );
    const preview = await buildWorkflowFinalizationPreview({
      baseRoot: prepared.location.contentSnapshotRoot,
      state: prepared.verified.state,
      execution: prepared.verified.identity,
      definition,
      profile
    });
    return preview.planHash === submission.finalization.planHash ? [] : ["Workflow finalization preview is stale"];
  }
  return [];
}
async function validateWorkflowSubmission(target, submission) {
  return withStructuredRuntimeErrors(async () => {
    const location = resolveWorkflowRunLocation(target);
    const journal = await readWorkflowTransitionJournal(location.runRoot);
    if (journal) return recoveryRequiredContinuation(location, journal);
    const checkpointRecovery = await readWorkflowCheckpointRecoveryJournal(
      location.runRoot
    );
    if (checkpointRecovery) {
      return checkpointRecoveryRequiredContinuation(
        location,
        checkpointRecovery
      );
    }
    const profile = await durabilityProfileForLocation(location);
    if (usesWorkflowFinalization(profile)) {
      const transaction = await readWorkflowFinalizationTransaction(
        location.runRoot,
        profile
      );
      if (transaction) {
        return finalizationRecoveryRequiredContinuation(location, transaction);
      }
    }
    validateSubmission(submission);
    let prepared;
    try {
      prepared = await prepareWorkflowSubmission(target, submission);
    } catch (error) {
      if (error instanceof WorkflowRevisionConflictError) {
        return conflictContinuation(error.verified, error.finding);
      }
      throw error;
    }
    const artifact = await artifactMutationForSubmission(prepared, submission);
    if (artifact.blockers.length > 0) {
      return blockedContinuation(prepared, artifact.blockers);
    }
    const verification = await verificationMutationForSubmission(
      prepared,
      submission,
      artifact.mutation
    );
    if (verification.blockers.length > 0) {
      return blockedContinuation(prepared, verification.blockers);
    }
    const mutation = mergeWorkflowMutations(
      artifact.mutation,
      verification.mutation
    );
    const blockers = await completionBlockers(prepared, submission, mutation);
    if (blockers.length > 0) {
      return blockedContinuation(prepared, blockers);
    }
    const routeFindings = routeBlockers(prepared, submission, mutation);
    if (routeFindings.length > 0) {
      return blockedContinuation(prepared, routeFindings);
    }
    const finalizationBlockers = await finalizationSubmissionBlockers(
      prepared,
      submission
    );
    if (finalizationBlockers.length > 0) {
      return blockedContinuation(prepared, finalizationBlockers);
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
    ...protocol.finalization ? { finalization: structuredClone(protocol.finalization) } : {},
    decisionReceipts: boundProjectedLedger(
      projectedCurrent?.decisionReceipts ?? []
    ),
    verificationReceipts: boundProjectedLedger(
      projectedCurrent?.verificationReceipts ?? []
    ),
    cycles: boundProjectedLedger(projectedCurrent?.cycles ?? []),
    visits: projectedCurrent?.disposition === "await-user" ? boundProjectedLedger(redactVisitEvidence(projectedCurrent.visits)) : boundProjectedLedger(projectedCurrent?.visits ?? []),
    artifactVersions: boundProjectedLedger(
      projectedCurrent?.artifactVersions ?? []
    ),
    artifactSelections: boundProjectedLedger(
      projectedCurrent?.artifactSelections ?? []
    ),
    contentSnapshots: boundProjectedLedger(
      projectedCurrent?.contentSnapshots ?? []
    ),
    currentArtifactVersions: structuredClone(
      projectedCurrent?.currentArtifactVersions ?? {}
    ),
    findings: structuredClone(projectedCurrent?.findings ?? []),
    findingSummary: structuredClone(
      projectedCurrent?.findingSummary ?? emptyFindingSummary()
    ),
    requiresUserDecision: projectedCurrent?.requiresUserDecision ?? false,
    ...projectedCurrent?.repair ? { repair: boundedRepairEpisode(projectedCurrent.repair) } : {},
    ...projectedCurrent?.finalization ? { finalizationState: structuredClone(projectedCurrent.finalization) } : {},
    continuation: projectedCurrent
  };
}
async function resumeStoredRun(location, options, forceCheckpoint = false, persistCheckpoint = true) {
  const verified = await verifyStoredRun(location);
  const finalizationRefresh = options.refreshFinalization ? await refreshWorkflowFinalization(location, verified) : void 0;
  const resumeOptions = {
    confirmations: options.confirmations ?? [],
    resolver: resolverForPackage(),
    prepareAction: prepareWorkflowActionForLocation(
      location,
      options.protectedSnapshotRoots
    ),
    ...options.finalizationRecovery ? { finalizationRecovery: options.finalizationRecovery } : {},
    ...finalizationRefresh ? { finalizationRefresh } : {}
  };
  const result = await location.resume(resumeOptions);
  const changed = !sameStableValue4(verified.state, result.state) || !sameStableValue4(verified.pending, result.action);
  if ((changed || forceCheckpoint) && persistCheckpoint) {
    await persistWorkflowCheckpoint(
      location,
      result.state,
      result.action,
      verified.package
    );
  }
  if (result.state.status !== "completed") {
    return continuation(result, verified.identity);
  }
  const trajectory = await readTrajectory(
    location.runRoot,
    result.state.trajectoryRef,
    durabilityReadOptions(result.state, "trajectoryBytes")
  );
  return continuation(
    { ...result, evals: terminalEvaluationResults(trajectory) },
    verified.identity
  );
}
async function prepareWorkflowAction(runRoot, pkg, state, action, mutationOverlay, snapshotRoot = runRoot, protectedSnapshotRoots = []) {
  const profile = state.runtimeIdentity?.durabilityProfile;
  let snapshotRuntimeState;
  try {
    if (usesWorkflowContentSnapshots(profile) && state.workflowRuntime && (state.workflowRuntime.contentSnapshots?.length ?? 0) === 0) {
      if (!mutationOverlay) {
        throw new Error(
          "Workflow content snapshot persistence requires a transition"
        );
      }
      const snapshotPolicy = profile?.snapshotPolicy;
      if (!snapshotPolicy) {
        throw new Error(
          "Workflow content snapshot capability has no snapshot policy"
        );
      }
      const manifest = await captureWorkflowContentSnapshot({
        root: snapshotRoot,
        policy: snapshotPolicy,
        protectedRoots: protectedSnapshotRoots
      });
      const reference = await stageWorkflowContentSnapshot({
        runRoot,
        manifest,
        transition: mutationOverlay
      });
      state.workflowRuntime.contentSnapshots ??= [];
      state.workflowRuntime.contentSnapshots.push(reference);
      snapshotRuntimeState = structuredClone(state.workflowRuntime);
    }
    const preparedAction = await captureWorkflowDecisionScope(
      runRoot,
      pkg,
      state,
      action
    );
    return {
      action: preparedAction,
      ...snapshotRuntimeState ? { workflowRuntime: snapshotRuntimeState } : {}
    };
  } catch (error) {
    if (error instanceof WorkflowDecisionScopeError) {
      return {
        action: null,
        reason: error.message,
        ...snapshotRuntimeState ? { workflowRuntime: snapshotRuntimeState } : {}
      };
    }
    throw error;
  }
}
function prepareWorkflowActionForLocation(location, protectedSnapshotRoots = []) {
  return (runRoot, pkg, state, action, mutationOverlay) => prepareWorkflowAction(
    runRoot,
    pkg,
    state,
    action,
    mutationOverlay,
    location.contentSnapshotRoot,
    protectedSnapshotRoots
  );
}
function workflowFinalizationConfirmationAction(preview, sourceActionId, currentRevision = preview.revision) {
  const decisionId = `workflow-finalization-${preview.planHash.slice(0, 24)}`;
  const actionId2 = `workflow-finalization-confirm-${sha256(
    JSON.stringify(
      stableValue({
        runId: preview.runId,
        planHash: preview.planHash,
        revision: preview.revision,
        currentRevision
      })
    )
  ).slice(0, 24)}`;
  const pending = {
    schemaVersion: 1,
    kind: "workflow-finalization-confirmation",
    decisionId,
    actionId: actionId2,
    sourceActionId,
    planHash: preview.planHash,
    revision: currentRevision,
    planRevision: preview.revision,
    contentSnapshotHash: preview.contentSnapshotHash,
    verificationReceiptIds: [...preview.verificationReceiptIds],
    reviewer: structuredClone(preview.confirmation.reviewer),
    rationale: structuredClone(preview.confirmation.rationale)
  };
  return {
    id: actionId2,
    stepId: null,
    type: "ask_user",
    decisionId,
    question: "Review and confirm the declared local finalization plan.",
    choices: [
      { id: "confirm", label: "Apply finalization" },
      { id: "cancel", label: "Cancel finalization" }
    ],
    requiredInputs: { type: "object", fields: [] },
    rationale: structuredClone(preview.confirmation.rationale),
    reviewer: structuredClone(preview.confirmation.reviewer),
    finalization: pending
  };
}
function prepareWorkflowFinalizationForLocation(location, definition, profile, execution) {
  return async (_runRoot, before, outcome, advanced, pending) => {
    const runtime = advanced.workflowRuntime;
    if (!runtime)
      throw new Error("Workflow finalization requires WorkflowRuntime state");
    if (outcome.finalization && isWorkflowFinalizationAction(pending)) {
      await validateFinalizationEvidenceBindings(
        location,
        before,
        definition,
        profile
      );
      const pendingConfirmation = before.workflowRuntime?.finalization?.pendingConfirmation;
      if (!pendingConfirmation || !isWorkflowFinalizationAction(pending)) {
        throw new Error("Workflow finalization confirmation state is missing");
      }
      const plan2 = await buildWorkflowFinalizationPreview({
        baseRoot: location.contentSnapshotRoot,
        state: before,
        execution,
        definition,
        profile
      });
      if (plan2.planHash !== pendingConfirmation.planHash) {
        throw new Error("Workflow finalization preview is stale");
      }
      const choiceId = outcome.finalization.choiceId;
      if (choiceId === "cancel") {
        return {
          state: {
            ...advanced,
            status: "blocked",
            currentStep: null,
            workflowRuntime: {
              ...runtime,
              finalization: {
                schemaVersion: 1,
                status: "rolled-back",
                planHash: pendingConfirmation.planHash,
                revision: runtime.revision,
                sourceActionId: pendingConfirmation.sourceActionId,
                planRevision: pendingConfirmation.planRevision,
                confirmationActionId: pending.id,
                confirmationCount: (before.workflowRuntime?.finalization?.confirmationCount ?? 0) + 1
              }
            }
          },
          action: null,
          reason: "Workflow finalization was cancelled"
        };
      }
      if (choiceId !== "confirm") {
        throw new Error("Workflow finalization choice is invalid");
      }
      if (!outcome.reviewer) {
        throw new Error(
          "Workflow finalization confirmation reviewer is missing"
        );
      }
      const confirmation = {
        decisionId: pendingConfirmation.decisionId,
        actionId: pending.id,
        sourceActionId: pendingConfirmation.sourceActionId,
        planHash: pendingConfirmation.planHash,
        revision: before.workflowRuntime?.revision ?? 0,
        choiceId: "confirm",
        reviewer: {
          subject: outcome.reviewer.subject,
          authorities: [...outcome.reviewer.authorities].sort(
            (left, right) => left.localeCompare(right)
          )
        },
        rationaleHash: outcome.rationale === void 0 ? null : sha256(outcome.rationale.trim()),
        confirmedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      const applied = await applyWorkflowFinalization({
        runRoot: location.runRoot,
        baseRoot: location.contentSnapshotRoot,
        profile,
        plan: plan2,
        definition,
        execution,
        sourceActionId: pendingConfirmation.sourceActionId,
        resultingRevision: runtime.revision,
        confirmation
      });
      const receipt = workflowFinalizationReceiptReference(applied.receipt);
      const rolledBack = applied.status === "rolled-back";
      return {
        state: {
          ...advanced,
          status: rolledBack ? "blocked" : "completed",
          currentStep: null,
          workflowRuntime: {
            ...runtime,
            finalization: {
              schemaVersion: 1,
              status: rolledBack ? "rolled-back" : "committed",
              planHash: pendingConfirmation.planHash,
              revision: runtime.revision,
              sourceActionId: pendingConfirmation.sourceActionId,
              planRevision: pendingConfirmation.planRevision,
              confirmationActionId: pending.id,
              confirmationCount: (before.workflowRuntime?.finalization?.confirmationCount ?? 0) + 1,
              transactionId: applied.transaction.transactionId,
              receipt
            }
          }
        },
        action: null,
        ...rolledBack ? { reason: "Workflow finalization was rolled back" } : {}
      };
    }
    if (advanced.status !== "completed" || definition.operations.length === 0) {
      return void 0;
    }
    await validateFinalizationEvidenceBindings(
      location,
      before,
      definition,
      profile
    );
    const plan = await buildWorkflowFinalizationPreview({
      baseRoot: location.contentSnapshotRoot,
      state: before,
      execution,
      definition,
      profile
    });
    if (outcome.finalization?.planHash !== void 0 && outcome.finalization.planHash !== plan.planHash) {
      throw new Error("Workflow finalization preview is stale");
    }
    if (!plan.requiresConfirmation) {
      throw new Error("Workflow finalization confirmation is required");
    }
    const action = workflowFinalizationConfirmationAction(
      plan,
      pending.id,
      runtime.revision
    );
    const finalization = {
      schemaVersion: 1,
      status: "awaiting-confirmation",
      planHash: plan.planHash,
      revision: runtime.revision,
      sourceActionId: pending.id,
      planRevision: plan.revision,
      pendingConfirmation: action.finalization
    };
    return {
      state: {
        ...advanced,
        status: "waiting",
        pending: action.id,
        currentStep: null,
        workflowRuntime: { ...runtime, finalization }
      },
      action
    };
  };
}
async function clearFinalizationAfterResult(location, result) {
  const profile = result.state.runtimeIdentity?.durabilityProfile;
  const finalization = result.state.workflowRuntime?.finalization;
  if (!usesWorkflowFinalization(profile) || !finalization?.transactionId || finalization.status !== "committed" && finalization.status !== "rolled-back") {
    return;
  }
  await clearWorkflowFinalizationTransaction(
    location.runRoot,
    profile,
    location.contentSnapshotRoot
  );
}
async function refreshWorkflowFinalization(location, verified) {
  const pending = verified.pending;
  if (!isWorkflowFinalizationAction(pending)) return void 0;
  const definition = verified.package.runtime?.protocol.finalization;
  const profile = verified.identity.durabilityProfile;
  if (!definition || !profile) {
    throw new Error("Workflow finalization declaration is missing");
  }
  await validateFinalizationEvidenceBindings(
    location,
    verified.state,
    definition,
    profile
  );
  const preview = await buildWorkflowFinalizationPreview({
    baseRoot: location.contentSnapshotRoot,
    state: verified.state,
    execution: verified.identity,
    definition,
    profile
  });
  if (preview.planHash === pending.finalization.planHash) return void 0;
  const runtime = verified.state.workflowRuntime;
  if (!runtime) {
    throw new Error("Workflow finalization requires WorkflowRuntime state");
  }
  const action = workflowFinalizationConfirmationAction(
    preview,
    pending.finalization.sourceActionId,
    runtime.revision
  );
  if (!action.finalization) {
    throw new Error("Workflow finalization refresh action is incomplete");
  }
  return {
    action,
    state: {
      ...verified.state,
      pending: action.id,
      status: "waiting",
      currentStep: null,
      workflowRuntime: {
        ...runtime,
        finalization: {
          schemaVersion: 1,
          status: "awaiting-confirmation",
          planHash: preview.planHash,
          revision: runtime.revision,
          sourceActionId: pending.finalization.sourceActionId,
          planRevision: preview.revision,
          ...runtime.finalization?.confirmationCount ? {
            confirmationCount: runtime.finalization.confirmationCount,
            confirmationActionId: runtime.finalization.confirmationActionId
          } : {},
          pendingConfirmation: action.finalization
        }
      }
    }
  };
}
async function verifyStoredAction(runRoot, state, identity, pkg) {
  const action = await readPendingAction(
    runRoot,
    state.pendingRef,
    durabilityReadOptions(state, "pendingActionBytes")
  );
  if (state.status === "waiting") {
    if (!state.pending || !action || action.id !== state.pending) {
      throw new Error(
        "WorkflowRuntime pending action does not match Run state"
      );
    }
    if (isWorkflowFinalizationAction(action)) {
      const finalization = state.workflowRuntime?.finalization;
      if (!finalization || finalization.status !== "awaiting-confirmation" || !finalization.pendingConfirmation || !sameStableValue4(
        finalization.pendingConfirmation,
        action.finalization
      ) || state.currentStep !== null || action.stepId !== null || action.attemptId !== void 0 || action.cycleId !== void 0) {
        throw new Error(
          "WorkflowRuntime pending finalization confirmation identity is invalid"
        );
      }
      return action;
    }
    if (isWorkflowRepairAction(action)) {
      const pendingRepair = state.workflowRuntime?.repairEpisode?.pendingDecision;
      const episode = state.workflowRuntime?.repairEpisode;
      const latestFailure = [...episode?.history ?? []].reverse().find((record) => record.kind === "failure");
      const policy = identity.durabilityProfile?.repairPolicy;
      const normalizedPolicy = policy ? normalizeWorkflowRepairPolicy(policy) : void 0;
      if (!pendingRepair || !episode || !sameStableValue4(action.repair, pendingRepair) || pendingRepair.stepId !== action.stepId || state.currentStep !== action.stepId || identity.nodeToStep[pendingRepair.nodeId] !== pendingRepair.stepId || pendingRepair.failureRevision !== state.workflowRuntime?.revision || latestFailure?.revision !== pendingRepair.failureRevision || pendingRepair.signatureHash !== episode.signature?.signatureHash || !normalizedPolicy || !sameStableValue4(
        pendingRepair.choices,
        normalizedPolicy.allowedChoices
      ) || !sameStableValue4(pendingRepair.rationale, normalizedPolicy.rationale) || !sameStableValue4(pendingRepair.reviewer, normalizedPolicy.reviewer)) {
        throw new Error(
          "WorkflowRuntime pending repair decision identity is invalid"
        );
      }
      return action;
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
        const trajectory = await readTrajectory(
          runRoot,
          state.trajectoryRef,
          durabilityReadOptions(state, "trajectoryBytes")
        );
        const proposal = trajectory.slice().reverse().find(
          (event) => event.type === "action_proposed" && isRecord15(event.data.action) && event.data.action.id === action.id
        );
        if (!proposal || !isRecord15(proposal.data.action)) {
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
var WorkflowCheckpointRecoveryBlockedError = class extends Error {
  findings;
  finding;
  constructor(findings) {
    const projected = boundWorkflowFindings(findings).findings;
    const finding = projected[0];
    super(finding?.message ?? "Workflow checkpoint recovery is blocked");
    this.name = "WorkflowCheckpointRecoveryBlockedError";
    this.findings = projected;
    this.finding = finding ?? checkpointInvalidFinding(
      "Workflow checkpoint recovery is blocked.",
      WORKFLOW_CHECKPOINT_INDEX_PATH
    );
  }
};
var WorkflowCheckpointRecoveryPendingError = class extends Error {
  finding;
  constructor() {
    const finding = recoveryRequiredFinding(
      void 0,
      void 0,
      ".comet/checkpoint-recovery-journal.json"
    );
    super(finding.message);
    this.name = "WorkflowCheckpointRecoveryPendingError";
    this.finding = finding;
  }
};
async function checkpointBlockedContinuation(location, findings, fallback) {
  try {
    const verified = await verifyStoredRun(location);
    return withAdditionalFindings(
      await continuationFromVerifiedRun(verified, location.runRoot),
      findings,
      "blocked"
    );
  } catch (error) {
    if (!fallback) throw error;
    return withAdditionalFindings(
      continuation(
        { state: fallback.state, action: fallback.pending, evals: [] },
        fallback.identity
      ),
      findings,
      "blocked"
    );
  }
}
function throwCheckpointRecoveryBlocked(findings) {
  throw new WorkflowCheckpointRecoveryBlockedError(findings);
}
async function recoverCheckpointAwareRun(location, options, forceCheckpoint) {
  const profile = await durabilityProfileForLocation(location);
  if (!profile || !usesWorkflowCheckpoints(profile)) {
    return resumeStoredRun(location, options, forceCheckpoint);
  }
  const checkpointRecovery = await recoverWorkflowCheckpoint(
    location.runRoot,
    profile
  );
  if (checkpointRecovery.status === "blocked") {
    return checkpointBlockedContinuation(location, [
      checkpointHistoryAmbiguousFinding(
        `Workflow checkpoint restoration has ambiguous records: ${checkpointRecovery.unknownPaths?.join(", ") ?? "unknown"}.`,
        checkpointRecovery.unknownPaths?.[0]
      )
    ]);
  }
  const checkpointChanged = forceCheckpoint || checkpointRecovery.status === "recovered";
  let persistedState = null;
  let persistedExecution;
  try {
    persistedState = await location.readState();
    if (persistedState?.runtimeIdentity) {
      persistedExecution = identityFromState(persistedState);
    }
  } catch {
    persistedState = null;
  }
  let verified;
  let headError;
  let headVerified = false;
  try {
    verified = await verifyStoredRun(location);
  } catch (error) {
    headError = error;
  }
  if (verified) {
    try {
      await verifyWorkflowCheckpointHead({
        runRoot: location.runRoot,
        state: verified.state,
        pending: verified.pending,
        identity: verified.identity,
        package: verified.package,
        profile
      });
      headVerified = true;
    } catch (error) {
      headError = error;
    }
  }
  let inspections = [];
  let auditFindings = [];
  let checkpointIndexReadable = true;
  try {
    inspections = await inspectWorkflowCheckpointCandidates(
      location.runRoot,
      profile,
      verified ? {
        expectedRunId: verified.state.runId,
        expectedExecution: verified.identity
      } : persistedState ? {
        expectedRunId: persistedState.runId,
        ...persistedExecution ? { expectedExecution: persistedExecution } : {}
      } : location.runId ? { expectedRunId: location.runId } : {}
    );
    auditFindings = checkpointFindings(inspections, "warning");
  } catch (error) {
    checkpointIndexReadable = false;
    auditFindings = [checkpointIndexFinding(error, "warning")];
  }
  const verifiedCandidates = inspections.filter(
    (inspection) => inspection.verification !== void 0
  ).sort(
    (left, right) => right.verification.manifest.revision - left.verification.manifest.revision || left.entry.recordHash.localeCompare(right.entry.recordHash)
  );
  if (verified) {
    if (headError && headVerified === false) {
      return checkpointBlockedContinuation(location, [
        checkpointInvalidFinding(
          `Workflow checkpoint authoritative-head verification failed: ${headError instanceof Error ? headError.message : String(headError)}`,
          ".comet/checkpoints/index.json"
        ),
        ...auditFindings
      ]);
    }
    const currentRevision = verified.state.workflowRuntime?.revision ?? 0;
    const newerCheckpoint = verifiedCandidates.find(
      (inspection) => inspection.verification.manifest.revision > currentRevision
    );
    if (newerCheckpoint) {
      return checkpointBlockedContinuation(location, [
        checkpointHistoryAmbiguousFinding(
          `Workflow checkpoint revision ${newerCheckpoint.verification.manifest.revision} is newer than the authoritative Run head revision ${currentRevision}; recovery will not rewind or discard accepted history.`,
          ".comet/checkpoints/index.json"
        ),
        ...auditFindings
      ]);
    }
    const currentTrajectory = await readOptionalEngineRunText(
      location.runRoot,
      verified.state.trajectoryRef,
      profile.bounds.trajectoryBytes,
      "Workflow checkpoint current trajectory"
    );
    const headCheckpoint = inspections.some(
      (inspection) => inspection.verification !== void 0 && inspection.verification.manifest.revision === (verified.state.workflowRuntime?.revision ?? 0) && sameStableValue4(inspection.verification.state, verified.state) && sameStableValue4(inspection.verification.pending, verified.pending) && currentTrajectory === inspection.verification.contents.trajectory
    );
    const result = await resumeStoredRun(
      location,
      options,
      checkpointChanged || headVerified && checkpointIndexReadable && !headCheckpoint,
      headVerified
    );
    return withAdditionalFindings(result, auditFindings);
  }
  const candidates = verifiedCandidates;
  if (candidates.length === 0) {
    throwCheckpointRecoveryBlocked([
      ...auditFindings,
      checkpointInvalidFinding(
        `No completely verified checkpoint can restore the Run: ${headError instanceof Error ? headError.message : String(headError)}`,
        ".comet/run-state.json"
      )
    ]);
  }
  const selected = candidates[0].verification;
  try {
    const restored = await restoreWorkflowCheckpoint(
      location.runRoot,
      profile,
      selected
    );
    if (restored.status === "blocked") {
      throw new Error(
        `Workflow checkpoint history is ambiguous: ${restored.unknownPaths?.join(", ") ?? "unknown"}`
      );
    }
  } catch (error) {
    return checkpointBlockedContinuation(
      location,
      [
        ...auditFindings,
        checkpointHistoryAmbiguousFinding(
          error instanceof Error ? error.message : String(error),
          ".comet/trajectory.jsonl"
        )
      ],
      selected
    );
  }
  const recovered = await verifyStoredRun(location);
  await persistWorkflowCheckpoint(
    location,
    recovered.state,
    recovered.pending,
    recovered.package
  );
  return withAdditionalFindings(
    await continuationFromVerifiedRun(recovered, location.runRoot),
    auditFindings
  );
}
function createWorkflowRuntime() {
  return {
    async start(options) {
      return withStructuredRuntimeErrors(async () => {
        const resolved = resolveWorkflowStartLocation(options);
        const compiled = await compileWorkflow(options.protocol);
        const revisioned = compiled.package.runtime?.capabilityVersion === 3;
        await resolved.location.prepareStart();
        return withWorkflowRunLock(
          resolved.location,
          "workflow.start",
          compiled.identity.durabilityProfile,
          async () => {
            if (usesWorkflowRunLock(compiled.identity.durabilityProfile)) {
              const journal = await readWorkflowTransitionJournal(
                resolved.location.runRoot
              );
              if (journal)
                throw new WorkflowTransitionJournalPendingError(journal);
            }
            if (usesWorkflowFinalization(compiled.identity.durabilityProfile)) {
              const transaction = await readWorkflowFinalizationTransaction(
                resolved.location.runRoot,
                compiled.identity.durabilityProfile
              );
              if (transaction) {
                throw new WorkflowFinalizationTransactionPendingError(
                  transaction
                );
              }
            }
            if (usesWorkflowCheckpoints(compiled.identity.durabilityProfile)) {
              const checkpointRecovery = await readWorkflowCheckpointRecoveryJournal(
                resolved.location.runRoot
              );
              if (checkpointRecovery) {
                throw new WorkflowCheckpointRecoveryPendingError();
              }
            }
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
                  verificationReceipts: [],
                  artifactVersions: [],
                  artifactSelections: [],
                  ...usesWorkflowContentSnapshots(
                    compiled.identity.durabilityProfile
                  ) ? { contentSnapshots: [] } : {},
                  ...compiled.identity.durabilityProfile?.capabilities.includes(
                    "repair-policy"
                  ) ? {
                    repairEpisode: {
                      schemaVersion: 1,
                      history: [],
                      signature: null,
                      disposition: null,
                      reasonCode: null,
                      consecutiveFailures: 0,
                      totalFailures: 0,
                      remainingFailures: normalizeWorkflowRepairPolicy(
                        compiled.identity.durabilityProfile.repairPolicy
                      ).maxFailures
                    }
                  } : {}
                }
              } : {},
              prepareAction: prepareWorkflowActionForLocation(
                resolved.location,
                options.protectedSnapshotRoots
              )
            });
            if (result.state.skillHash !== compiled.identity.packageHash) {
              throw new Error(
                "WorkflowRuntime snapshot identity was not persisted"
              );
            }
            const next = continuation(result, {
              ...compiled.identity,
              snapshotHash: result.state.skillHash
            });
            await persistWorkflowCheckpoint(
              resolved.location,
              result.state,
              result.action,
              compiled.package
            );
            return next;
          }
        );
      });
    },
    async resume(target, options = {}) {
      return withStructuredRuntimeErrors(async () => {
        const location = resolveWorkflowRunLocation(target);
        const profile = await durabilityProfileForLocation(location);
        return withWorkflowRunLock(
          location,
          "workflow.resume",
          profile,
          async () => {
            const journal = await readWorkflowTransitionJournal(
              location.runRoot
            );
            if (journal) return recoveryRequiredContinuation(location, journal);
            if (profile?.capabilities.includes("transactional-finalization")) {
              const transaction = await readWorkflowFinalizationTransaction(
                location.runRoot,
                profile
              );
              if (transaction) {
                return finalizationRecoveryRequiredContinuation(
                  location,
                  transaction
                );
              }
            }
            const checkpointRecovery = await readWorkflowCheckpointRecoveryJournal(location.runRoot);
            if (checkpointRecovery) {
              return checkpointRecoveryRequiredContinuation(
                location,
                checkpointRecovery
              );
            }
            return resumeStoredRun(location, {
              ...options,
              refreshFinalization: true
            });
          },
          {
            onBlocked: (error) => lockBlockedContinuation(location, error)
          }
        );
      });
    },
    async submit(target, submission) {
      return withStructuredRuntimeErrors(async () => {
        const location = resolveWorkflowRunLocation(target);
        const profile = await durabilityProfileForLocation(location);
        return withWorkflowRunLock(
          location,
          "workflow.submit",
          profile,
          async () => {
            const journal = await readWorkflowTransitionJournal(
              location.runRoot
            );
            if (journal) return recoveryRequiredContinuation(location, journal);
            if (profile?.capabilities.includes("transactional-finalization")) {
              const transaction = await readWorkflowFinalizationTransaction(
                location.runRoot,
                profile
              );
              if (transaction) {
                return finalizationRecoveryRequiredContinuation(
                  location,
                  transaction
                );
              }
            }
            const checkpointRecovery = await readWorkflowCheckpointRecoveryJournal(location.runRoot);
            if (checkpointRecovery) {
              return checkpointRecoveryRequiredContinuation(
                location,
                checkpointRecovery
              );
            }
            validateSubmission(submission);
            let prepared;
            try {
              prepared = await prepareWorkflowSubmission(target, submission);
            } catch (error) {
              if (error instanceof WorkflowRevisionConflictError) {
                return conflictContinuation(error.verified, error.finding);
              }
              throw error;
            }
            const artifact = await artifactMutationForSubmission(
              prepared,
              submission
            );
            if (artifact.blockers.length > 0) {
              return blockedContinuation(prepared, artifact.blockers);
            }
            const verification = await verificationMutationForSubmission(
              prepared,
              submission,
              artifact.mutation
            );
            if (verification.blockers.length > 0) {
              return blockedContinuation(prepared, verification.blockers);
            }
            const mutation = mergeWorkflowMutations(
              artifact.mutation,
              verification.mutation
            );
            const blockers = await completionBlockers(
              prepared,
              submission,
              mutation
            );
            if (blockers.length > 0) {
              return blockedContinuation(prepared, blockers);
            }
            const routeFindings = routeBlockers(prepared, submission, mutation);
            if (routeFindings.length > 0) {
              return blockedContinuation(prepared, routeFindings);
            }
            const finalizationBlockers = await finalizationSubmissionBlockers(
              prepared,
              submission
            );
            if (finalizationBlockers.length > 0) {
              return blockedContinuation(prepared, finalizationBlockers);
            }
            const repairFailure = repairFailureForSubmission(
              prepared,
              submission,
              mutation
            );
            const outcome = engineOutcome(
              prepared,
              submission,
              mutation,
              repairFailure
            );
            const finalizationDefinition = prepared.verified.package.runtime.protocol.finalization;
            const finalizationPreparation = finalizationDefinition && prepared.verified.identity.durabilityProfile?.capabilities.includes(
              "transactional-finalization"
            ) ? prepareWorkflowFinalizationForLocation(
              prepared.location,
              finalizationDefinition,
              prepared.verified.identity.durabilityProfile,
              prepared.verified.identity
            ) : void 0;
            if (prepared.verified.identity.durabilityProfile === void 0) {
              const result = await prepared.location.resume(
                {
                  resolver: resolverForPackage(),
                  outcome,
                  prepareAction: prepareWorkflowActionForLocation(location),
                  prepareOutcome: prepareVerificationReceiptRecords(
                    mutation,
                    prepared.verified.identity.durabilityProfile
                  ),
                  ...finalizationPreparation ? { prepareFinalization: finalizationPreparation } : {}
                },
                mutation
              );
              await clearFinalizationAfterResult(prepared.location, result);
              return continuation(result, prepared.verified.identity);
            }
            const claimInput = {
              runId: submission.runId,
              expectedRevision: submission.revision,
              expectedActionId: submission.actionId,
              intendedRevision: submission.revision + 1,
              execution: structuredClone(submission.execution)
            };
            const claim = await acquireRevisionClaim(
              prepared.location.runRoot,
              claimInput
            );
            if (!claim.acquired) {
              const current = await verifyStoredRun(prepared.location);
              return conflictContinuation(
                current,
                revisionConflictFinding(
                  current.state.workflowRuntime?.revision ?? 0,
                  current.pending?.id ?? current.state.pending ?? null
                )
              );
            }
            try {
              await assertRevisionFence(prepared.location, claimInput);
              const result = await prepared.location.resume(
                {
                  resolver: resolverForPackage(),
                  outcome,
                  prepareAction: prepareWorkflowActionForLocation(location),
                  prepareOutcome: prepareVerificationReceiptRecords(
                    mutation,
                    prepared.verified.identity.durabilityProfile
                  ),
                  revisionFence: () => assertRevisionFence(prepared.location, claimInput),
                  revisionStateFence: () => assertRevisionFence(prepared.location, claimInput, false),
                  ...finalizationPreparation ? { prepareFinalization: finalizationPreparation } : {}
                },
                mutation
              );
              await claim.commit();
              await clearFinalizationAfterResult(prepared.location, result);
              await persistWorkflowCheckpoint(
                prepared.location,
                result.state,
                result.action,
                prepared.verified.package
              );
              return continuation(result, prepared.verified.identity);
            } catch (error) {
              if (error instanceof WorkflowRevisionConflictError) {
                return conflictContinuation(error.verified, error.finding);
              }
              if (error instanceof WorkflowTransitionJournalPendingError || error instanceof WorkflowTransitionRecordConflictError) {
                const journal2 = await readWorkflowTransitionJournal(
                  prepared.location.runRoot
                );
                if (journal2) {
                  return recoveryRequiredContinuation(
                    prepared.location,
                    journal2
                  );
                }
                const current = await verifyStoredRun(prepared.location);
                return conflictContinuation(
                  current,
                  revisionConflictFinding(
                    current.state.workflowRuntime?.revision ?? 0,
                    current.pending?.id ?? current.state.pending ?? null
                  )
                );
              }
              if (error instanceof WorkflowFinalizationConflictError) {
                const transaction = await readWorkflowFinalizationTransaction(
                  prepared.location.runRoot,
                  prepared.verified.identity.durabilityProfile
                );
                if (transaction) {
                  return finalizationRecoveryRequiredContinuation(
                    prepared.location,
                    transaction
                  );
                }
                await claim.abandon();
                return blockedContinuation(prepared, [error.message]);
              }
              if (error instanceof WorkflowFinalizationTransactionPendingError) {
                return finalizationRecoveryRequiredContinuation(
                  prepared.location,
                  error.transaction
                );
              }
              throw error;
            }
          },
          {
            onBlocked: (error) => lockBlockedContinuation(location, error)
          }
        );
      });
    },
    async recover(target, options = {}) {
      return withStructuredRuntimeErrors(async () => {
        const location = resolveWorkflowRunLocation(target);
        const profile = await durabilityProfileForLocation(location, {
          allowMalformedState: true
        });
        return withWorkflowRunLock(
          location,
          "workflow.recover",
          profile,
          async (lock) => {
            if (lock?.takeover && profile?.bounds.runLockBytes) {
              await recordWorkflowRunLockTakeover(
                location.runRoot,
                lock.takeover,
                profile.bounds.runLockBytes
              );
            }
            const journal = await readWorkflowTransitionJournal(
              location.runRoot
            );
            let transitionRecovered = false;
            if (journal) {
              if (!journal.execution.durabilityProfile) {
                throw new Error(
                  "Workflow transition journal has no durability profile"
                );
              }
              const recovery = await recoverWorkflowTransition(
                location.runRoot,
                journal.execution.durabilityProfile
              );
              if (recovery.status === "blocked") {
                return recoveryRequiredContinuation(
                  location,
                  recovery.journal ?? journal
                );
              }
              transitionRecovered = recovery.status === "recovered";
            }
            let finalizationRecovery;
            if (usesWorkflowFinalization(profile)) {
              let persistedRun = null;
              let recoveryDefinition;
              try {
                persistedRun = await location.readState();
              } catch {
                persistedRun = null;
              }
              if (persistedRun) {
                try {
                  recoveryDefinition = (await readSkillSnapshot(
                    location.runRoot,
                    persistedRun.skillHash
                  )).runtime?.protocol.finalization;
                } catch {
                  recoveryDefinition = void 0;
                }
              }
              const recovery = options.rollbackFinalization ? await rollbackWorkflowFinalization({
                runRoot: location.runRoot,
                baseRoot: location.contentSnapshotRoot,
                profile,
                ...persistedRun?.runId ? { runId: persistedRun.runId } : location.runId ? { runId: location.runId } : {},
                ...persistedRun?.runtimeIdentity ? { execution: persistedRun.runtimeIdentity } : {},
                ...recoveryDefinition ? { definition: recoveryDefinition } : {}
              }) : await recoverWorkflowFinalization({
                runRoot: location.runRoot,
                baseRoot: location.contentSnapshotRoot,
                profile,
                ...persistedRun?.runId ? { runId: persistedRun.runId } : location.runId ? { runId: location.runId } : {},
                ...persistedRun?.runtimeIdentity ? { execution: persistedRun.runtimeIdentity } : {},
                ...recoveryDefinition ? { definition: recoveryDefinition } : {}
              });
              if (recovery.status === "blocked" && recovery.transaction) {
                return finalizationRecoveryRequiredContinuation(
                  location,
                  recovery.transaction,
                  recovery.unknownPaths
                );
              }
              if (recovery.receipt && recovery.transaction) {
                const current = await location.readState();
                if (current?.workflowRuntime?.finalization?.status === "awaiting-confirmation" && current.pending) {
                  finalizationRecovery = {
                    status: recovery.receipt.recovery.status === "rolled-back" ? "rolled-back" : "committed",
                    transactionId: recovery.transaction.transactionId,
                    resultingRevision: recovery.transaction.resultingRevision,
                    receipt: workflowFinalizationReceiptReference(
                      recovery.receipt
                    )
                  };
                } else if (current?.workflowRuntime?.finalization?.transactionId === recovery.transaction.transactionId && (current.workflowRuntime.finalization.status === "committed" || current.workflowRuntime.finalization.status === "rolled-back")) {
                  await clearWorkflowFinalizationTransaction(
                    location.runRoot,
                    profile,
                    location.contentSnapshotRoot
                  );
                }
              }
            }
            if (usesWorkflowCheckpoints(profile)) {
              const result2 = await recoverCheckpointAwareRun(
                location,
                {
                  ...options,
                  ...finalizationRecovery ? { finalizationRecovery } : {}
                },
                transitionRecovered
              );
              if (finalizationRecovery) {
                await clearWorkflowFinalizationTransaction(
                  location.runRoot,
                  profile,
                  location.contentSnapshotRoot
                );
              }
              return result2;
            }
            const result = await resumeStoredRun(
              location,
              {
                ...options,
                ...finalizationRecovery ? { finalizationRecovery } : {}
              },
              transitionRecovered
            );
            if (finalizationRecovery) {
              await clearWorkflowFinalizationTransaction(
                location.runRoot,
                profile,
                location.contentSnapshotRoot
              );
            }
            return result;
          },
          {
            allowStale: true,
            onBlocked: (error) => lockBlockedContinuation(location, error)
          }
        );
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
  previewWorkflowFinalization,
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
