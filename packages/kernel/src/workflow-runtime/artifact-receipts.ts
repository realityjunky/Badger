import { constants, promises as fs, type BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { inspectProtectedProjectPath } from "../engine/protected-project-path.js";
import type {
  ArtifactSchema,
  OutputSchema,
  WorkflowArtifactProducer,
  WorkflowArtifactReceipt,
} from "../types.js";

export function validateArtifactReceiptDeclarations(
  schema: OutputSchema,
): void {
  if (schema.externalRoots !== undefined) {
    if (
      !schema.externalRoots ||
      typeof schema.externalRoots !== "object" ||
      Array.isArray(schema.externalRoots) ||
      Object.keys(schema.externalRoots).length > 32
    ) {
      throw new Error(
        `Output Schema ${schema.id} artifact external roots must be a bounded map`,
      );
    }
    for (const [id, root] of Object.entries(schema.externalRoots)) {
      if (
        !id ||
        id.length > 128 ||
        typeof root !== "string" ||
        !path.isAbsolute(root) ||
        root.includes("\0")
      ) {
        throw new Error(
          `Output Schema ${schema.id} artifact external root ${id} must be an absolute directory path`,
        );
      }
    }
  }
  for (const artifact of schema.artifacts) {
    const label = `Workflow artifact ${schema.id}.${artifact.id}`;
    if (
      (artifact.verification !== undefined &&
        artifact.verification !== "content" &&
        artifact.verification !== "receipt") ||
      (artifact.requireCurrentAttempt !== undefined &&
        typeof artifact.requireCurrentAttempt !== "boolean")
    ) {
      throw new Error(`${label} has an invalid receipt policy`);
    }
    if (artifact.verification !== "receipt") {
      if (
        artifact.root !== undefined ||
        artifact.requireCurrentAttempt !== undefined
      ) {
        throw new Error(
          `${label} external roots and Attempt freshness require receipt verification`,
        );
      }
      continue;
    }
    if (
      artifact.root !== undefined &&
      (typeof artifact.root !== "string" ||
        !Object.hasOwn(schema.externalRoots ?? {}, artifact.root))
    ) {
      throw new Error(`${label} has an undeclared external root`);
    }
    for (const pattern of artifact.paths) {
      const normalized = pattern.trim().replaceAll("\\", "/");
      if (
        !normalized ||
        path.posix.isAbsolute(normalized) ||
        path.win32.isAbsolute(normalized) ||
        /^(?:~|[\\/])/u.test(normalized) ||
        normalized.includes("?") ||
        normalized.includes("\0") ||
        normalized
          .split("/")
          .some((segment) => !segment || segment === "." || segment === "..")
      ) {
        throw new Error(
          `${label} receipt paths must stay relative to the declared root and support only * wildcards`,
        );
      }
    }
  }
}

export function artifactStorageRoot(
  runRoot: string,
  schema: OutputSchema,
  artifact: ArtifactSchema,
): string {
  if (artifact.root === undefined) return runRoot;
  if (
    artifact.verification !== "receipt" ||
    !Object.hasOwn(schema.externalRoots ?? {}, artifact.root)
  ) {
    throw new Error(
      `Workflow artifact ${schema.id}.${artifact.id} has an undeclared external root`,
    );
  }
  const root = schema.externalRoots![artifact.root];
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error(
      `Workflow artifact external root ${artifact.root} must be absolute`,
    );
  }
  return root;
}

function sameStat(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

interface CaptureArtifactReceiptOptions {
  storageRoot: string;
  relativePath: string;
  artifactId: string;
  producer: WorkflowArtifactProducer;
  attemptStartedAt?: number;
}

function assertFresh(
  stat: BigIntStats,
  options: CaptureArtifactReceiptOptions,
): void {
  if (
    options.attemptStartedAt !== undefined &&
    stat.mtimeNs < BigInt(options.attemptStartedAt) * 1_000_000n
  ) {
    throw new Error(
      `Workflow artifact ${options.artifactId} is stale for this Attempt: ${options.relativePath}`,
    );
  }
}

function mtimeMs(stat: BigIntStats): number {
  return (
    Number(stat.mtimeNs / 1_000_000n) + Number(stat.mtimeNs % 1_000_000n) / 1e6
  );
}

async function captureDirectoryReceipt(
  options: CaptureArtifactReceiptOptions,
): Promise<WorkflowArtifactReceipt> {
  const label = `Workflow artifact ${options.artifactId}`;
  const manifest: Array<{
    path: string;
    kind: "directory" | "file";
    sha256?: string;
  }> = [];
  const observed: Array<{ relativePath: string; stat: BigIntStats }> = [];
  let size = 0;
  let fileCount = 0;
  async function walk(relativePath: string): Promise<void> {
    const inspection = await inspectProtectedProjectPath(
      options.storageRoot,
      relativePath,
      { label, expected: "any" },
    );
    if (!inspection.exists) throw new Error(`${label} does not exist`);
    const stat = await fs.lstat(inspection.target, { bigint: true });
    observed.push({ relativePath, stat });
    if (observed.length > 256)
      throw new Error(`${label} exceeds 256 receipt entries`);
    const manifestPath = path.posix.relative(
      options.relativePath,
      relativePath,
    );
    if (stat.isDirectory()) {
      if (manifestPath)
        manifest.push({ path: manifestPath, kind: "directory" });
      const entries = await fs.readdir(inspection.target);
      for (const entry of entries.sort())
        await walk(path.posix.join(relativePath, entry));
    } else {
      const receipt = await captureArtifactReceipt({
        ...options,
        relativePath,
      });
      manifest.push({
        path: manifestPath,
        kind: "file",
        sha256: receipt.sha256,
      });
      size += receipt.size;
      if (!Number.isSafeInteger(size))
        throw new Error(`${label} receipt size is not a safe integer`);
      fileCount += 1;
    }
  }
  await walk(options.relativePath);
  for (const entry of observed) {
    const inspection = await inspectProtectedProjectPath(
      options.storageRoot,
      entry.relativePath,
      { label, expected: "any" },
    );
    if (
      !inspection.exists ||
      !sameStat(entry.stat, await fs.lstat(inspection.target, { bigint: true }))
    ) {
      throw new Error(`${label} changed during receipt verification`);
    }
  }
  const directoryStat = observed[0].stat;
  if (fileCount === 0) assertFresh(directoryStat, options);
  return {
    artifactId: options.artifactId,
    path: path.resolve(options.storageRoot, options.relativePath),
    size,
    sha256: createHash("sha256")
      .update(JSON.stringify({ kind: "directory", manifest }))
      .digest("hex"),
    mtimeMs: mtimeMs(directoryStat),
    producer: structuredClone(options.producer),
  };
}

export async function captureArtifactReceipt(
  options: CaptureArtifactReceiptOptions,
): Promise<WorkflowArtifactReceipt> {
  const label = `Workflow artifact ${options.artifactId}`;
  const inspect = () =>
    inspectProtectedProjectPath(options.storageRoot, options.relativePath, {
      label,
      expected: "any",
    });
  const inspection = await inspect();
  if (!inspection.exists) throw new Error(`${label} does not exist`);
  if (inspection.kind === "directory") return captureDirectoryReceipt(options);
  const before = await fs.lstat(inspection.target, { bigint: true });
  if (before.size > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`${label} receipt size is not a safe integer`);
  assertFresh(before, options);
  const realPath = await fs.realpath(inspection.target);
  const flags =
    process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await fs.open(inspection.target, flags);
  try {
    const assertUnchanged = async () => {
      await inspect();
      const opened = await handle.stat({ bigint: true });
      const current = await fs.lstat(inspection.target, { bigint: true });
      if (
        !opened.isFile() ||
        !current.isFile() ||
        current.isSymbolicLink() ||
        !sameStat(before, opened) ||
        !sameStat(before, current) ||
        (await fs.realpath(inspection.target)) !== realPath
      ) {
        throw new Error(`${label} changed during receipt verification`);
      }
    };
    await assertUnchanged();
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (BigInt(size) > before.size) {
        throw new Error(`${label} changed during receipt verification`);
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
    await assertUnchanged();
    if (BigInt(size) !== before.size) {
      throw new Error(`${label} changed during receipt verification`);
    }
    return {
      artifactId: options.artifactId,
      path: path.resolve(inspection.target),
      size,
      sha256: hash.digest("hex"),
      mtimeMs: mtimeMs(before),
      producer: structuredClone(options.producer),
    };
  } finally {
    await handle.close();
  }
}
