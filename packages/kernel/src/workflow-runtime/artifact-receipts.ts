import { constants, promises as fs, type BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { inspectProtectedProjectPath } from "../engine/protected-project-path.js";
import type {
  ArtifactExternalRoot,
  ArtifactSchema,
  OutputSchema,
  WorkflowArtifactProducer,
  WorkflowArtifactReceipt,
} from "../types.js";

const MAX_EXTERNAL_ROOTS = 32;

export function validateArtifactReceiptDeclarations(
  schema: OutputSchema,
): void {
  if (schema.externalRoots !== undefined) {
    if (
      !schema.externalRoots ||
      typeof schema.externalRoots !== "object" ||
      Array.isArray(schema.externalRoots) ||
      Object.keys(schema.externalRoots).length > MAX_EXTERNAL_ROOTS
    ) {
      throw new Error(
        `Output Schema ${schema.id} artifact external roots must be a bounded map`,
      );
    }
    for (const [id, root] of Object.entries(schema.externalRoots)) {
      // A declaration names a root; the host chooses its directory, so a
      // workflow cannot pick the boundary that confines its own reads.
      if (
        !id ||
        id.length > 128 ||
        !root ||
        typeof root !== "object" ||
        Array.isArray(root) ||
        Object.keys(root).some((key) => key !== "description") ||
        typeof root.description !== "string" ||
        !root.description.trim() ||
        root.description.length > 1000
      ) {
        throw new Error(
          `Output Schema ${schema.id} artifact external root ${id} must declare only a description; the host binds its directory when a Run starts`,
        );
      }
      if (!schema.artifacts.some((artifact) => artifact.root === id)) {
        throw new Error(
          `Output Schema ${schema.id} declares external root ${id}, but no artifact uses it`,
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

/**
 * The external roots a workflow declares, by name. A name means one
 * directory per Run, so schemas that share a name must declare it alike.
 */
export function externalRootDeclarations(
  schemas: readonly OutputSchema[],
): Map<string, ArtifactExternalRoot> {
  const declared = new Map<string, ArtifactExternalRoot>();
  for (const schema of schemas) {
    const roots = schema?.externalRoots;
    // A malformed map is reported by validateArtifactReceiptDeclarations.
    if (!roots || typeof roots !== "object" || Array.isArray(roots)) continue;
    for (const [name, root] of Object.entries(roots)) {
      if (!root || typeof root !== "object") continue;
      const existing = declared.get(name);
      if (existing && existing.description !== root.description) {
        throw new Error(
          `Output Schemas declare external root ${name} with different descriptions`,
        );
      }
      declared.set(name, root);
    }
  }
  if (declared.size > MAX_EXTERNAL_ROOTS) {
    throw new Error(
      `A workflow declares at most ${MAX_EXTERNAL_ROOTS} external roots`,
    );
  }
  return declared;
}

/**
 * Checks the directories a host binds to the declared external roots when a
 * Run starts. Each must be an existing directory and not itself a link, the
 * same rule the Run root follows. The result is fixed for the Run.
 */
export async function bindWorkflowExternalRoots(
  schemas: readonly OutputSchema[],
  supplied: Readonly<Record<string, string>> | undefined,
): Promise<Record<string, string> | undefined> {
  const declared = externalRootDeclarations(schemas);
  if (
    supplied !== undefined &&
    (!supplied || typeof supplied !== "object" || Array.isArray(supplied))
  ) {
    throw new Error("Workflow artifact external roots must be a map");
  }
  for (const name of Object.keys(supplied ?? {})) {
    if (!declared.has(name)) {
      throw new Error(
        `Workflow artifact external root ${name} is not declared by this workflow`,
      );
    }
  }
  if (declared.size === 0) return undefined;
  const bound: Record<string, string> = {};
  for (const name of [...declared.keys()].sort()) {
    const value = supplied?.[name];
    if (value === undefined) {
      throw new Error(
        `Workflow artifact external root ${name} needs a directory when the Run starts`,
      );
    }
    if (
      typeof value !== "string" ||
      !path.isAbsolute(value) ||
      value.includes("\0")
    ) {
      throw new Error(
        `Workflow artifact external root ${name} must be bound to an absolute directory`,
      );
    }
    const directory = path.resolve(value);
    let stat;
    try {
      stat = await fs.lstat(directory);
    } catch {
      throw new Error(
        `Workflow artifact external root ${name} directory does not exist: ${directory}`,
      );
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(
        `Workflow artifact external root ${name} must be a real directory, not a link: ${directory}`,
      );
    }
    bound[name] = directory;
  }
  return bound;
}

export function artifactStorageRoot(
  runRoot: string,
  externalRoots: Readonly<Record<string, string>> | undefined,
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
  const root = externalRoots?.[artifact.root];
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error(
      `Workflow artifact external root ${artifact.root} is not bound for this Run`,
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
  /** Names the external root that storageRoot is bound to, if any. */
  rootName?: string;
  relativePath: string;
  artifactId: string;
  producer: WorkflowArtifactProducer;
  attemptStartedAt?: number;
}

function receiptRoot(
  options: CaptureArtifactReceiptOptions,
): Pick<WorkflowArtifactReceipt, "root"> {
  return options.rootName === undefined
    ? {}
    : {
        root: {
          name: options.rootName,
          path: path.resolve(options.storageRoot),
        },
      };
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
    ...receiptRoot(options),
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
      ...receiptRoot(options),
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
