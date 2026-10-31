import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import {
  applyEdits,
  modify,
  parseTree,
  type Node as JsonNode,
} from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import {
  atomicWriteContainedBytes,
  removeContainedFile,
  canonicalHash,
  createPackageSnapshot,
  verifyPackageSnapshot,
  type PackageSnapshot,
} from "@realityjunky/badger";
import {
  deploymentUrl,
  hostPaths,
  mcpEntry,
  renderMcpConfiguration,
  type AgentHost,
  type InstallScope,
  type McpConfiguration,
} from "./configuration.js";
export * from "./configuration.js";
export { saveHostPlan, readHostPlan, removeHostPlan } from "./plans.js";
export {
  downloadPublishedPackage,
  verifyPublishedPackage,
  publishedPackagePath,
  type PublishedPackageRead,
} from "./publication.js";

export interface HostTarget {
  host: AgentHost;
  scope: InstallScope;
  projectRoot: string;
  homeRoot: string;
}
export interface PublishedIdentity {
  workflowId: string;
  publicationId: string;
  packageHash: string;
}
export interface InstallInput extends McpConfiguration {
  target: HostTarget;
  publication: PublishedIdentity;
  snapshot: PackageSnapshot;
}
export interface UninstallInput {
  target: HostTarget;
  workflowId: string;
}
export interface HostOperation {
  action: "write" | "delete" | "mkdir" | "rmdir";
  path: string;
  expectedHash: string | null;
  contentHash: string | null;
  bytes: number;
}
export interface HostPreview {
  action: "install" | "uninstall";
  target: HostTarget;
  rootIdentity: { device: number; inode: number; birthtime: number };
  publication: PublishedIdentity;
  packageDirectory: string;
  configuration: string;
  operations: HostOperation[];
  digest: string;
}
export type HostPlan = {
  format: "badger-host-plan-v1";
  input:
    | ({ action: "install" } & InstallInput)
    | ({ action: "uninstall" } & UninstallInput);
  preview: HostPreview;
};
interface InstalledPackage extends PublishedIdentity {
  inventory: PackageSnapshot["inventory"];
}
interface Registry {
  format: "badger-host-registry-v1";
  host: AgentHost;
  scope: InstallScope;
  configuration: {
    entry: ReturnType<typeof mcpEntry>;
    addition?: string;
    fileCreated: boolean;
    parentCreated: boolean;
  };
  packages: Record<string, InstalledPackage>;
}
interface Change {
  operation: HostOperation;
  before: Buffer | null;
  after: Buffer | null;
}
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) =>
  Buffer.from(JSON.stringify(value, null, 2) + "\n");
function identifier(value: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/u.test(value))
    throw new Error("Invalid published package identity");
  return value;
}
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

/** No target or ancestor may redirect the adapter into another directory. */
async function inspect(root: string, target: string) {
  if (target !== root && !target.startsWith(root + path.sep))
    throw new Error("Host path escapes its selected root");
  let current = path.parse(target).root;
  for (const component of target
    .slice(current.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink())
        throw new Error("Host paths must not contain symbolic links");
      if (current !== target && !stat.isDirectory())
        throw new Error("Host path ancestor is not a directory");
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  return fs.lstat(target);
}
async function read(root: string, target: string): Promise<Buffer | null> {
  const stat = await inspect(root, target);
  if (!stat) return null;
  if (!stat.isFile() || stat.nlink !== 1)
    throw new Error("Host target must be a regular file without hard links");
  const handle = await fs.open(
    target,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || !opened.isFile())
      throw new Error("Host file changed while reading");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
function rootFor(target: HostTarget): string {
  hostPaths(target.host, target.scope);
  if (!path.isAbsolute(target.projectRoot) || !path.isAbsolute(target.homeRoot))
    throw new Error("Use explicit absolute project and home roots");
  return path.resolve(
    target.scope === "project" ? target.projectRoot : target.homeRoot,
  );
}
function jsonObject(text: string): Record<string, any> {
  const errors: { error: number; offset: number; length: number }[] = [];
  const tree = parseTree(text, errors, {
    disallowComments: true,
    allowTrailingComma: false,
  });
  if (!tree || tree.type !== "object" || errors.length)
    throw new Error("Host configuration must be a JSON object");
  function unique(node: JsonNode) {
    if (node.type === "object") {
      const names = new Set<string>();
      for (const property of node.children ?? []) {
        const name = property.children![0].value as string;
        if (names.has(name))
          throw new Error("Duplicate JSON configuration keys are unsafe");
        names.add(name);
      }
    }
    for (const child of node.children ?? []) unique(child);
  }
  unique(tree);
  return JSON.parse(text) as Record<string, any>;
}
function editJson(text: string, keys: string[], value: unknown) {
  return applyEdits(
    text,
    modify(text, keys, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  );
}
function configValue(
  host: AgentHost,
  text: string,
): { entry: unknown; parent: unknown } {
  let doc: ReturnType<typeof parseToml> | Record<string, any>;
  try {
    doc = host === "codex" ? parseToml(text) : jsonObject(text);
  } catch {
    throw new Error(
      "Host configuration is invalid or cannot be edited safely; repair its JSON/TOML before previewing",
    );
  }
  const parent = doc[host === "codex" ? "mcp_servers" : "mcpServers"];
  if (
    parent !== undefined &&
    (parent === null || typeof parent !== "object" || Array.isArray(parent))
  )
    throw new Error("Host MCP configuration must be an object");
  return {
    entry: (parent as Record<string, unknown> | undefined)?.badger,
    parent,
  };
}
function matches(a: unknown, b: unknown) {
  return canonicalHash(a ?? null) === canonicalHash(b ?? null);
}

async function compile(
  input: HostPlan["input"],
): Promise<{ plan: HostPlan; changes: Change[]; root: string }> {
  const target = input.target;
  const root = rootFor(target);
  const rootStat = await inspect(root, root);
  if (!rootStat?.isDirectory())
    throw new Error("The selected host root must already exist");
  const paths = hostPaths(target.host, target.scope);
  const registryFile = path.join(
    root,
    ".badger",
    "hosts",
    `${target.host}.json`,
  );
  const oldRegistry = await read(root, registryFile);
  let registry: Registry | null = oldRegistry
    ? (JSON.parse(oldRegistry.toString("utf8")) as Registry)
    : null;
  if (
    registry &&
    (registry.format !== "badger-host-registry-v1" ||
      registry.host !== target.host ||
      registry.scope !== target.scope ||
      !registry.configuration ||
      !registry.packages ||
      Array.isArray(registry.packages))
  )
    throw new Error("Unrecognized host ownership record");
  const workflowId = identifier(
    input.action === "install"
      ? input.publication.workflowId
      : input.workflowId,
  );
  const packageDirectory = path.join(
    root,
    paths.skills,
    `badger-${workflowId}`,
  );
  const configurationFile = path.join(root, paths.configuration);
  const previousConfig = await read(root, configurationFile);
  const original =
    previousConfig?.toString("utf8") ?? (target.host === "codex" ? "" : "{}\n");
  const current = configValue(target.host, original);
  if (registry) {
    if (!matches(current.entry, registry.configuration.entry))
      throw new Error(
        "Conflict: managed Badger MCP configuration was modified",
      );
  } else if (current.entry !== undefined)
    throw new Error(
      "Conflict: the existing Badger MCP entry is unowned; review and remove it yourself",
    );
  const installed = registry?.packages[workflowId];
  const existingDirectory = await inspect(root, packageDirectory);
  if (installed) {
    identifier(installed.workflowId);
    identifier(installed.publicationId);
    if (
      installed.workflowId !== workflowId ||
      !existingDirectory?.isDirectory()
    )
      throw new Error("Conflict: installed package is missing or unowned");
    try {
      const snapshot = await createPackageSnapshot(
        packageDirectory,
        installed.inventory,
      );
      if (snapshot.packageHash !== installed.packageHash)
        throw new Error("Modified package hash");
    } catch {
      throw new Error(
        "Conflict: installed package files were modified or are unowned",
      );
    }
  } else if (existingDirectory)
    throw new Error(
      "Conflict: the package destination already exists and is unowned",
    );
  if (input.action === "uninstall" && !installed)
    throw new Error("No owned Badger package is installed for this workflow");
  const changes: Change[] = [];
  async function file(file: string, after: Buffer | null) {
    const before = await read(root, file);
    if (
      (before === null && after === null) ||
      (before !== null && after !== null && before.equals(after))
    )
      return;
    changes.push({
      operation: {
        action: after ? "write" : "delete",
        path: file,
        expectedHash: before ? sha(before) : null,
        contentHash: after ? sha(after) : null,
        bytes: after?.length ?? 0,
      },
      before,
      after,
    });
  }
  let publication: PublishedIdentity;
  let configuration: string;
  let nextConfig = original;
  if (input.action === "install") {
    identifier(input.publication.publicationId);
    verifyPackageSnapshot(input.snapshot);
    if (input.publication.packageHash !== input.snapshot.packageHash)
      throw new Error("Published package identity does not match its bytes");
    if (!input.snapshot.files.some((f) => f.path === "SKILL.md"))
      throw new Error("A published Skill package must contain SKILL.md");
    publication = { ...input.publication };
    const entry = mcpEntry(target.host, input);
    configuration = renderMcpConfiguration(target.host, input);
    if (
      registry &&
      !matches(registry.configuration.entry, entry) &&
      Object.keys(registry.packages).some((id) => id !== workflowId)
    )
      throw new Error(
        "Conflict: another package uses this Badger MCP configuration",
      );
    const owned = registry?.configuration ?? {
      entry,
      fileCreated: !previousConfig,
      parentCreated: current.parent === undefined,
    };
    if (target.host === "codex") {
      if (owned.addition) {
        if (!nextConfig.includes(owned.addition))
          throw new Error("Conflict: managed TOML block was modified");
        nextConfig = nextConfig.replace(owned.addition, "");
      }
      const addition =
        (nextConfig && !nextConfig.endsWith("\n")
          ? "\n\n"
          : nextConfig
            ? "\n"
            : "") + configuration;
      nextConfig += addition;
      owned.addition = addition;
    } else nextConfig = editJson(nextConfig, ["mcpServers", "badger"], entry);
    if (!matches(configValue(target.host, nextConfig).entry, entry))
      throw new Error("Host configuration cannot be edited safely");
    owned.entry = entry;
    registry ??= {
      format: "badger-host-registry-v1",
      host: target.host,
      scope: target.scope,
      configuration: owned,
      packages: {},
    };
    registry.configuration = owned;
    registry.packages[workflowId] = {
      ...publication,
      inventory: structuredClone(input.snapshot.inventory),
    };
    const incoming = new Set(input.snapshot.files.map((f) => f.path));
    for (const old of installed?.inventory ?? [])
      if (!incoming.has(old.path))
        await file(path.join(packageDirectory, old.path), null);
    for (const entry of input.snapshot.files)
      await file(
        path.join(packageDirectory, entry.path),
        Buffer.from(entry.content, "base64"),
      );
    await file(configurationFile, Buffer.from(nextConfig));
    await file(registryFile, json(registry));
  } else {
    publication = {
      workflowId,
      publicationId: installed!.publicationId,
      packageHash: installed!.packageHash,
    };
    configuration = renderMcpConfiguration(target.host, {
      deploymentUrl: registry!.configuration.entry.env.BADGER_URL,
      command: registry!.configuration.entry.command,
      args: registry!.configuration.entry.args,
      profile: registry!.configuration.entry.env.BADGER_MCP_PROFILE,
    });
    for (const old of installed!.inventory)
      await file(path.join(packageDirectory, old.path), null);
    delete registry!.packages[workflowId];
    if (Object.keys(registry!.packages).length === 0) {
      const owned = registry!.configuration;
      if (target.host === "codex") {
        if (!owned.addition || !nextConfig.includes(owned.addition))
          throw new Error("Conflict: managed TOML block was modified");
        nextConfig = nextConfig.replace(owned.addition, "");
      } else {
        nextConfig = editJson(nextConfig, ["mcpServers", "badger"], undefined);
        const remaining = jsonObject(nextConfig);
        if (
          owned.parentCreated &&
          Object.keys(remaining.mcpServers ?? {}).length === 0
        )
          nextConfig = editJson(nextConfig, ["mcpServers"], undefined);
      }
      const empty =
        target.host === "codex"
          ? nextConfig.trim() === ""
          : Object.keys(jsonObject(nextConfig)).length === 0;
      await file(
        configurationFile,
        owned.fileCreated && empty ? null : Buffer.from(nextConfig),
      );
      await file(registryFile, null);
    } else await file(registryFile, json(registry));
  }
  const mkdirs = new Set<string>();
  for (const change of changes.filter((c) => c.after)) {
    let directory = path.dirname(change.operation.path);
    while (directory !== root) {
      const stat = await inspect(root, directory);
      if (stat) {
        if (!stat.isDirectory())
          throw new Error("Host path is not a directory");
        break;
      }
      mkdirs.add(directory);
      directory = path.dirname(directory);
    }
  }
  const directoryChanges: Change[] = [...mkdirs]
    .sort((a, b) => a.length - b.length)
    .map((directory) => ({
      operation: {
        action: "mkdir",
        path: directory,
        expectedHash: null,
        contentHash: null,
        bytes: 0,
      },
      before: null,
      after: null,
    }));
  if (input.action === "uninstall") {
    async function directories(directory: string) {
      for (const entry of await fs.readdir(directory, { withFileTypes: true }))
        if (entry.isDirectory())
          await directories(path.join(directory, entry.name));
      directoryChanges.push({
        operation: {
          action: "rmdir",
          path: directory,
          expectedHash: canonicalHash((await fs.readdir(directory)).sort()),
          contentHash: null,
          bytes: 0,
        },
        before: null,
        after: null,
      });
    }
    await directories(packageDirectory);
  }
  const all = [
    ...directoryChanges.filter((c) => c.operation.action === "mkdir"),
    ...changes,
    ...directoryChanges.filter((c) => c.operation.action === "rmdir"),
  ];
  const preview = {
    action: input.action,
    target: structuredClone(target),
    rootIdentity: {
      device: rootStat.dev,
      inode: rootStat.ino,
      birthtime: rootStat.birthtimeMs,
    },
    publication,
    packageDirectory,
    configuration,
    operations: all.map((c) => c.operation),
    digest: "",
  };
  preview.digest = canonicalHash({
    format: "badger-host-plan-v1",
    input,
    preview: { ...preview, digest: undefined },
  });
  return {
    plan: {
      format: "badger-host-plan-v1",
      input: structuredClone(input),
      preview,
    },
    changes: all,
    root,
  };
}
export async function previewInstall(input: InstallInput): Promise<HostPlan> {
  return (
    await compile({
      ...input,
      deploymentUrl: deploymentUrl(input.deploymentUrl),
      action: "install",
    })
  ).plan;
}
export async function previewUninstall(
  input: UninstallInput,
): Promise<HostPlan> {
  return (await compile({ ...input, action: "uninstall" })).plan;
}

/** Re-read the entire reviewed target before the first persistent write. */
export async function commitHostPlan(
  plan: HostPlan,
  confirmation: { digest: string; confirmed: boolean },
): Promise<{
  packageDirectory: string;
  packageHash: string;
  action: "install" | "uninstall";
}> {
  if (confirmation.confirmed !== true)
    throw new Error("Confirm the local host preview before committing");
  if (
    plan.format !== "badger-host-plan-v1" ||
    confirmation.digest !== plan.preview.digest
  )
    throw new Error("Quote the exact host preview digest");
  const root = rootFor(plan.input.target);
  const lock = path.join(
    root,
    `.badger-${plan.input.target.host}-install.lock`,
  );
  await inspect(root, lock);
  let handle;
  try {
    handle = await fs.open(lock, "wx", 0o600);
  } catch {
    throw new Error(
      "Another local host installation is active; retry after it finishes",
    );
  }
  try {
    const current = await compile(plan.input);
    if (
      current.plan.preview.digest !== confirmation.digest ||
      !matches(current.plan.preview, plan.preview)
    )
      throw new Error("Conflict: the host preview is stale; preview again");
    for (const change of current.changes) {
      const op = change.operation;
      const existing = await inspect(root, op.path);
      if (op.action === "mkdir") {
        await fs.mkdir(op.path, { mode: 0o700 });
        continue;
      }
      if (op.action === "rmdir") {
        await fs.rmdir(op.path);
        continue;
      }
      async function unchanged() {
        const now = await read(root, op.path);
        if ((now ? sha(now) : null) !== op.expectedHash)
          throw new Error("Conflict: host file changed during commit");
      }
      if (change.after)
        await atomicWriteContainedBytes(op.path, change.after, {
          containedRoot: root,
          exclusive: change.before === null,
          // A replaced file, such as a private 0600 configuration, keeps its
          // permission bits; a new file gets the default mode.
          mode:
            change.before !== null && existing
              ? existing.mode & 0o777
              : undefined,
          beforeCommit: unchanged,
        });
      else {
        await unchanged();
        await removeContainedFile(op.path, {
          containedRoot: root,
          beforeRemove: unchanged,
        });
      }
    }
    if (plan.input.action === "install") {
      const installed = await createPackageSnapshot(
        plan.preview.packageDirectory,
        plan.input.snapshot.inventory,
      );
      if (installed.packageHash !== plan.preview.publication.packageHash)
        throw new Error("Installed package verification failed");
    }
    return {
      packageDirectory: plan.preview.packageDirectory,
      packageHash: plan.preview.publication.packageHash,
      action: plan.input.action,
    };
  } finally {
    await handle.close();
    await fs.unlink(lock);
  }
}
