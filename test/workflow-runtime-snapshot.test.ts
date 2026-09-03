import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  captureWorkflowContentSnapshot,
  createWorkflowContentSnapshotPolicy,
  hashWorkflowContentSnapshot,
  parseWorkflowContentSnapshotManifest,
  WorkflowContentSnapshotError,
} from "../src/workflow-runtime/snapshots.js";
import { parseWorkflowDurabilityProfile } from "../src/workflow-runtime/durability.js";
import { normalizeWorkflow } from "../src/workflow/contract.js";
import { createWorkflowRuntime } from "../src/workflow-runtime/public.js";
import type { WorkflowInput, WorkflowProtocol } from "../src/types.js";
import {
  clearWorkflowTransitionFaultForTests,
  setWorkflowTransitionFaultForTests,
} from "../src/workflow-runtime/transition-journal.js";

const execFile = promisify(execFileCallback);

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", root, ...args], {
    encoding: "utf8",
  });
  return result.stdout;
}

async function initializeGitRepository(root: string): Promise<void> {
  await git(root, "init", "--quiet");
  await git(root, "config", "user.email", "snapshot-tests@example.invalid");
  await git(root, "config", "user.name", "Snapshot Tests");
}

async function commitGitRepository(
  root: string,
  message: string,
): Promise<void> {
  await git(root, "add", "--all");
  await git(root, "commit", "--quiet", "-m", message);
}

const contentSnapshotProfile = {
  version: 1,
  capabilities: [
    "mutation-locks",
    "revision-fences",
    "transition-journal",
    "content-snapshots",
  ],
  bounds: {
    runStateBytes: 256 * 1024,
    pendingActionBytes: 256 * 1024,
    trajectoryBytes: 8 * 1024 * 1024,
    artifactsBytes: 1024 * 1024,
    claimBytes: 16 * 1024,
    transitionJournalBytes: 1024 * 1024,
    runLockBytes: 16 * 1024,
  },
  schemaVersions: {
    runState: 1,
    pendingAction: 1,
    trajectory: 1,
    artifacts: 1,
    revisionClaim: 1,
    transitionJournal: 1,
    runLock: 1,
    contentSnapshot: 1,
  },
  findingCatalogVersion: 1,
} as const;

function runtimeNode(id: string): WorkflowInput["customNodes"][number] {
  return {
    id,
    label: id,
    kind: "action",
    responsibility: `Run ${id}.`,
    implementation: {
      skill: `${id}-skill`,
      operation: "default",
      scope: "main",
    },
    operations: ["require", "augment", "disable"],
    outputSchemas: [],
    guardrails: [],
  };
}

function snapshotRuntimeProtocol(
  snapshotPolicy: ReturnType<typeof createWorkflowContentSnapshotPolicy>,
): WorkflowProtocol {
  return normalizeWorkflow({
    kind: "workflow-kernel",
    name: "content-snapshot-runtime",
    goal: "Capture a declared project scope.",
    customNodes: [runtimeNode("prepare"), runtimeNode("finish")],
    capabilities: {
      version: 3,
      features: ["conditional-routing", "revisioned-attempts"],
      durability: {
        ...contentSnapshotProfile,
        snapshotPolicy,
      },
    },
  }).protocol;
}

describe("WorkflowRuntime physical content snapshots", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-workflow-snapshot-"),
    );
    await fs.mkdir(path.join(root, "nested"));
    await Promise.all([
      fs.writeFile(path.join(root, "z.txt"), "last\n"),
      fs.writeFile(path.join(root, "nested", "a.txt"), "first\n"),
    ]);
  });

  afterEach(async () => {
    clearWorkflowTransitionFaultForTests();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("captures a sorted canonical manifest independent of capture time", async () => {
    const policy = createWorkflowContentSnapshotPolicy({
      provider: "physical-tree",
      include: ["**/*"],
      exclude: [],
      limits: {
        maxFiles: 10,
        maxFileBytes: 1024,
        maxTotalBytes: 4096,
        maxManifestBytes: 16 * 1024,
        maxVisitedNodes: 20,
        maxDurationMs: 10_000,
        maxOmissionEntries: 10,
      },
    });

    const first = await captureWorkflowContentSnapshot({
      root,
      policy,
      now: new Date("2026-09-01T00:00:00.000Z"),
    });
    const second = await captureWorkflowContentSnapshot({
      root,
      policy,
      now: new Date("2026-09-01T00:01:00.000Z"),
    });

    expect(first.schemaVersion).toBe(1);
    expect(first.kind).toBe("workflow-content-snapshot");
    expect(first.capture.provider).toBe("physical-tree");
    expect(first.complete).toBe(true);
    expect(first.omittedCount).toBe(0);
    expect(first.entries.map((entry) => entry.path)).toEqual([
      "nested/a.txt",
      "z.txt",
    ]);
    expect(JSON.stringify(first)).not.toContain("first\\n");
    expect(JSON.stringify(first)).not.toContain(root);
    expect(hashWorkflowContentSnapshot(first)).toBe(
      hashWorkflowContentSnapshot(second),
    );
    expect(
      parseWorkflowContentSnapshotManifest(JSON.parse(JSON.stringify(first))),
    ).toEqual(first);
  });

  it("records non-regular entries and ignores explicitly excluded paths", async () => {
    await fs.mkdir(path.join(root, "ignored"));
    await fs.writeFile(path.join(root, "ignored", "secret.txt"), "secret\n");
    if (process.platform !== "win32") {
      await fs.symlink(path.join(root, "z.txt"), path.join(root, "linked.txt"));
    }
    const manifest = await captureWorkflowContentSnapshot({
      root,
      policy: createWorkflowContentSnapshotPolicy({
        provider: "physical-tree",
        include: ["**/*"],
        exclude: ["ignored/**"],
        limits: { maxManifestBytes: 16 * 1024 },
      }),
    });

    expect(manifest.entries.map((entry) => entry.path)).toEqual([
      "nested/a.txt",
      "z.txt",
    ]);
    expect(
      manifest.omitted.find(
        (omission) => omission.path === "ignored/secret.txt",
      ),
    ).toBe(undefined);
    if (process.platform !== "win32") {
      expect(manifest.omitted).toContainEqual({
        path: "linked.txt",
        size: null,
        type: "other",
        reason: "non-regular",
      });
    }
  });

  it("marks a selection change after initial enumeration as incomplete", async () => {
    const manifest = await captureWorkflowContentSnapshot({
      root,
      policy: createWorkflowContentSnapshotPolicy({
        provider: "physical-tree",
        include: ["**/*"],
        limits: { maxManifestBytes: 16 * 1024 },
      }),
      hooks: {
        afterInitialSelection: async () => {
          await fs.writeFile(path.join(root, "created.txt"), "created\n");
        },
      },
    });

    expect(manifest.complete).toBe(false);
    expect(manifest.capture.physicalSelection?.status).toBe("changed");
    expect(manifest.omitted).toContainEqual({
      path: ".",
      size: null,
      type: "directory",
      reason: "physical-selection-changed",
    });
    expect(manifest.entries.map((entry) => entry.path)).not.toContain(
      "created.txt",
    );
  });

  it("records file, total-byte, and file-count bound omissions", async () => {
    await Promise.all([
      fs.writeFile(path.join(root, "a.txt"), "12345"),
      fs.writeFile(path.join(root, "b.txt"), "1234"),
      fs.writeFile(path.join(root, "c.txt"), "12"),
    ]);
    const manifest = await captureWorkflowContentSnapshot({
      root,
      policy: createWorkflowContentSnapshotPolicy({
        provider: "physical-tree",
        include: ["a.txt", "b.txt", "c.txt"],
        limits: {
          maxFiles: 1,
          maxFileBytes: 4,
          maxTotalBytes: 4,
          maxManifestBytes: 16 * 1024,
        },
      }),
    });

    expect(manifest.complete).toBe(false);
    expect(manifest.entries).toEqual([
      { path: "b.txt", hash: expect.any(String), size: 4, type: "file" },
    ]);
    expect(manifest.omitted).toEqual([
      { path: "a.txt", size: 5, type: "file", reason: "file-size" },
      { path: "c.txt", size: 2, type: "file", reason: "file-count" },
    ]);
  });

  it("rejects a requested scope that overlaps a protected exclusion", async () => {
    await fs.mkdir(path.join(root, "protected"));
    await expect(
      captureWorkflowContentSnapshot({
        root,
        protectedRoots: ["protected"],
        policy: createWorkflowContentSnapshotPolicy({
          provider: "physical-tree",
          include: ["**/*"],
          limits: { maxManifestBytes: 16 * 1024 },
        }),
      }),
    ).rejects.toMatchObject({
      name: "WorkflowContentSnapshotError",
      finding: expect.objectContaining({ code: "snapshot-unsafe-scope" }),
    } satisfies Partial<WorkflowContentSnapshotError>);
  });

  it("omits a file changed during its bounded content read", async () => {
    const manifest = await captureWorkflowContentSnapshot({
      root,
      policy: createWorkflowContentSnapshotPolicy({
        provider: "physical-tree",
        include: ["z.txt"],
        limits: { maxManifestBytes: 16 * 1024 },
      }),
      hooks: {
        beforeFileRead: async (relative) => {
          if (relative === "z.txt") {
            await fs.writeFile(path.join(root, relative), "changed\n");
          }
        },
      },
    });

    expect(manifest.complete).toBe(false);
    expect(manifest.entries).toEqual([]);
    expect(manifest.omitted).toContainEqual({
      path: "z.txt",
      size: null,
      type: "file",
      reason: "changed-during-read",
    });
  });

  it("folds omission details into bounded content-addressed overflow evidence", async () => {
    await Promise.all([
      fs.writeFile(path.join(root, "a.txt"), "aa"),
      fs.writeFile(path.join(root, "b.txt"), "bb"),
      fs.writeFile(path.join(root, "c.txt"), "cc"),
    ]);
    const policy = createWorkflowContentSnapshotPolicy({
      provider: "physical-tree",
      include: ["a.txt", "b.txt", "c.txt"],
      limits: {
        maxFileBytes: 1,
        maxOmissionEntries: 2,
        maxManifestBytes: 16 * 1024,
      },
    });
    const first = await captureWorkflowContentSnapshot({ root, policy });
    const second = await captureWorkflowContentSnapshot({ root, policy });

    expect(first.complete).toBe(false);
    expect(first.omitted).toHaveLength(2);
    expect(first.omittedCount).toBe(3);
    expect(first.omissionOverflow).toMatchObject({
      count: 1,
      hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      ref: expect.stringMatching(
        /^workflow-snapshot:\/\/omitted-overflow\/[a-f0-9]{64}$/u,
      ),
    });
    expect(second.omissionOverflow).toEqual(first.omissionOverflow);
    expect(
      parseWorkflowContentSnapshotManifest(JSON.parse(JSON.stringify(first))),
    ).toEqual(first);
  });

  it("turns an exhausted traversal budget into bounded incomplete evidence", async () => {
    const manifest = await captureWorkflowContentSnapshot({
      root,
      policy: createWorkflowContentSnapshotPolicy({
        provider: "physical-tree",
        include: ["**/*"],
        limits: { maxVisitedNodes: 1, maxManifestBytes: 16 * 1024 },
      }),
    });

    expect(manifest.complete).toBe(false);
    expect(manifest.capture.physicalSelection?.status).toBe("overflow");
    expect(manifest.omitted).toContainEqual({
      path: ".",
      size: null,
      type: "directory",
      reason: "physical-enumeration-limit",
    });
  });

  it("records a duration-bound capture as incomplete", async () => {
    const manifest = await captureWorkflowContentSnapshot({
      root,
      policy: createWorkflowContentSnapshotPolicy({
        provider: "physical-tree",
        include: ["**/*"],
        limits: { maxDurationMs: 1, maxManifestBytes: 16 * 1024 },
      }),
      hooks: {
        afterInitialSelection: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
        },
      },
    });

    expect(manifest.complete).toBe(false);
    expect(manifest.omitted).toContainEqual({
      path: ".",
      size: null,
      type: "directory",
      reason: "duration",
    });
  });

  it("bounds the serialized manifest while retaining omission totals", async () => {
    const files = await Promise.all(
      Array.from({ length: 12 }, (_, index) => {
        const file = path.join(
          root,
          `manifest-${index.toString().padStart(2, "0")}-${"x".repeat(80)}.txt`,
        );
        return fs.writeFile(file, "x").then(() => file);
      }),
    );
    const manifest = await captureWorkflowContentSnapshot({
      root,
      policy: createWorkflowContentSnapshotPolicy({
        provider: "physical-tree",
        include: files.map((file) => path.basename(file)),
        limits: {
          maxManifestBytes: 4_000,
          maxOmissionEntries: 12,
        },
      }),
    });

    expect(
      Buffer.byteLength(JSON.stringify(manifest, null, 2) + "\n"),
    ).toBeLessThanOrEqual(4_000);
    expect(manifest.complete).toBe(false);
    expect(manifest.omittedCount).toBeGreaterThan(0);
    expect(manifest.omissionOverflow?.count).toBe(
      manifest.omittedCount - manifest.omitted.length,
    );
    expect(
      parseWorkflowContentSnapshotManifest(
        JSON.parse(JSON.stringify(manifest)),
      ),
    ).toEqual(manifest);
  });

  it("does not follow a directory replaced by a symlink during enumeration", async () => {
    if (process.platform === "win32") return;
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-workflow-snapshot-outside-"),
    );
    const original = path.join(root, "nested");
    const moved = path.join(root, "nested-moved");
    try {
      await fs.writeFile(path.join(outside, "secret.txt"), "secret\n");
      let swapped = false;
      await expect(
        captureWorkflowContentSnapshot({
          root,
          policy: createWorkflowContentSnapshotPolicy({
            provider: "physical-tree",
            include: ["nested/**"],
            limits: { maxManifestBytes: 16 * 1024 },
          }),
          hooks: {
            afterNode: async (relative) => {
              if (relative !== "nested" || swapped) return;
              swapped = true;
              await fs.rename(original, moved);
              await fs.symlink(outside, original, "dir");
            },
          },
        }),
      ).rejects.toMatchObject({
        finding: expect.objectContaining({ code: "snapshot-unsafe-scope" }),
      });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
      await fs.rm(path.join(root, "nested"), { recursive: true, force: true });
      await fs.rename(moved, original).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  });

  it("requires a complete hash-bound policy when snapshots are enabled", () => {
    const policy = createWorkflowContentSnapshotPolicy({
      provider: "physical-tree",
      include: ["**/*"],
    });
    const profile = {
      version: 1,
      capabilities: [
        "mutation-locks",
        "revision-fences",
        "transition-journal",
        "content-snapshots",
      ],
      bounds: {
        runStateBytes: 256 * 1024,
        pendingActionBytes: 256 * 1024,
        trajectoryBytes: 8 * 1024 * 1024,
        artifactsBytes: 1024 * 1024,
        claimBytes: 16 * 1024,
        transitionJournalBytes: 1024 * 1024,
        runLockBytes: 16 * 1024,
      },
      schemaVersions: {
        runState: 1,
        pendingAction: 1,
        trajectory: 1,
        artifacts: 1,
        revisionClaim: 1,
        transitionJournal: 1,
        runLock: 1,
        contentSnapshot: 1,
      },
      findingCatalogVersion: 1,
      snapshotPolicy: policy,
    } as const;

    expect(parseWorkflowDurabilityProfile(profile)).toMatchObject({
      capabilities: [
        "content-snapshots",
        "mutation-locks",
        "revision-fences",
        "transition-journal",
      ],
      snapshotPolicy: policy,
    });
    expect(() =>
      parseWorkflowDurabilityProfile({
        ...profile,
        capabilities: ["content-snapshots"],
      }),
    ).toThrow(/content-snapshots requires/);
  });

  it("persists and recovers one snapshot reference through a standalone Run", async () => {
    const projectRoot = path.join(root, "standalone-project");
    await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "src", "input.txt"), "input\n");
    const policy = createWorkflowContentSnapshotPolicy({
      provider: "physical-tree",
      include: ["src/**"],
      exclude: [],
      limits: { maxManifestBytes: 16 * 1024 },
    });
    const protocol = snapshotRuntimeProtocol(policy);
    const location = {
      kind: "standalone" as const,
      projectRoot,
      runId: "snapshot-run",
    };
    const runtime = createWorkflowRuntime();

    const started = await runtime.start({ protocol, location });
    expect(started.contentSnapshots).toEqual([
      {
        schemaVersion: 1,
        kind: "workflow-content-snapshot-reference",
        hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        path: expect.stringMatching(
          /^\.badger\/content-snapshots\/[a-f0-9]{64}\.json$/u,
        ),
        provider: "physical-tree",
        complete: true,
      },
    ]);
    const snapshotPath = path.join(
      projectRoot,
      ".badger",
      "runs",
      location.runId,
      started.contentSnapshots[0]!.path,
    );
    await expect(fs.access(snapshotPath)).resolves.toBeUndefined();

    const recovered = await runtime.recover(location);
    expect(recovered).toEqual(started);
    expect(recovered.contentSnapshots).toEqual(started.contentSnapshots);

    const completed = await runtime.submit(location, {
      actionId: started.pendingAction!.id,
      runId: started.runId,
      revision: started.revision,
      nodeId: started.currentNode!,
      execution: started.execution,
      status: "succeeded",
      summary: "Prepared the snapshot workflow.",
    });
    expect(completed.contentSnapshots).toEqual(started.contentSnapshots);
  });

  it("recovers a snapshot staged before its journal record boundary", async () => {
    const projectRoot = path.join(root, "fault-project");
    await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "src", "input.txt"), "input\n");
    const policy = createWorkflowContentSnapshotPolicy({
      provider: "physical-tree",
      include: ["src/**"],
      limits: { maxManifestBytes: 16 * 1024 },
    });
    const protocol = snapshotRuntimeProtocol(policy);
    const location = {
      kind: "standalone" as const,
      projectRoot,
      runId: "snapshot-fault-run",
    };
    setWorkflowTransitionFaultForTests((boundary) => {
      if (
        boundary.phase === "record-write" &&
        boundary.path?.startsWith(".badger/content-snapshots/")
      ) {
        throw new Error("deterministic workflow transition fault");
      }
    });

    await expect(
      createWorkflowRuntime().start({ protocol, location }),
    ).rejects.toThrow("deterministic workflow transition fault");
    clearWorkflowTransitionFaultForTests();

    const recovered = await createWorkflowRuntime().recover(location);
    expect(recovered.contentSnapshots).toHaveLength(1);
    expect(recovered.contentSnapshots[0]).toMatchObject({
      provider: "physical-tree",
      complete: true,
    });
    expect(await createWorkflowRuntime().recover(location)).toEqual(recovered);
  });

  it("uses the same content identity for manual and standalone locations", async () => {
    const manualRoot = path.join(root, "manual-project");
    const standaloneRoot = path.join(root, "standalone-project");
    await Promise.all([
      fs.mkdir(path.join(manualRoot, "src"), { recursive: true }),
      fs.mkdir(path.join(standaloneRoot, "src"), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(manualRoot, "src", "input.txt"), "same\n"),
      fs.writeFile(path.join(standaloneRoot, "src", "input.txt"), "same\n"),
    ]);
    const policy = createWorkflowContentSnapshotPolicy({
      provider: "physical-tree",
      include: ["src/**"],
      limits: { maxManifestBytes: 16 * 1024 },
    });
    const protocol = snapshotRuntimeProtocol(policy);
    const runtime = createWorkflowRuntime();
    const manual = await runtime.start({
      protocol,
      location: { kind: "manual", runRoot: manualRoot },
      runId: "manual-snapshot-run",
    });
    const standalone = await runtime.start({
      protocol,
      location: {
        kind: "standalone",
        projectRoot: standaloneRoot,
        runId: "standalone-snapshot-run",
      },
    });

    expect(standalone.contentSnapshots).toEqual(manual.contentSnapshots);
    expect(
      (await runtime.recover({ kind: "manual", runRoot: manualRoot }))
        .contentSnapshots,
    ).toEqual(manual.contentSnapshots);
    expect(
      (
        await runtime.recover({
          kind: "standalone",
          projectRoot: standaloneRoot,
          runId: "standalone-snapshot-run",
        })
      ).contentSnapshots,
    ).toEqual(manual.contentSnapshots);
  });

  it("rejects broad scopes that overlap the runtime metadata tree", async () => {
    await fs.mkdir(path.join(root, ".badger"));
    await fs.writeFile(path.join(root, ".badger", "runtime.json"), "runtime\n");
    await expect(
      captureWorkflowContentSnapshot({
        root,
        policy: createWorkflowContentSnapshotPolicy({
          provider: "physical-tree",
          include: ["**/*"],
          limits: { maxManifestBytes: 16 * 1024 },
        }),
      }),
    ).rejects.toMatchObject({
      finding: expect.objectContaining({ code: "snapshot-unsafe-scope" }),
    });
  });

  it("changes identity when captured content changes", async () => {
    const policy = createWorkflowContentSnapshotPolicy({
      provider: "physical-tree",
      include: ["z.txt"],
      limits: { maxManifestBytes: 16 * 1024 },
    });
    const first = await captureWorkflowContentSnapshot({ root, policy });
    await fs.writeFile(path.join(root, "z.txt"), "changed\n");
    const second = await captureWorkflowContentSnapshot({ root, policy });

    expect(hashWorkflowContentSnapshot(second)).not.toBe(
      hashWorkflowContentSnapshot(first),
    );
    expect(second.entries[0]?.hash).not.toBe(first.entries[0]?.hash);
  });

  it("rejects content-addressed snapshot storage drift", async () => {
    const policy = createWorkflowContentSnapshotPolicy({
      provider: "physical-tree",
      include: ["z.txt"],
      limits: { maxManifestBytes: 16 * 1024 },
    });
    const manifest = await captureWorkflowContentSnapshot({ root, policy });
    const snapshotHash = hashWorkflowContentSnapshot(manifest);
    const storageRoot = path.join(root, "storage");
    await fs.mkdir(path.join(storageRoot, ".badger", "content-snapshots"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(
        storageRoot,
        ".badger",
        "content-snapshots",
        `${snapshotHash}.json`,
      ),
      "not-a-snapshot\n",
    );
    await expect(
      import("../src/workflow-runtime/snapshots.js").then(
        ({ readWorkflowContentSnapshot }) =>
          readWorkflowContentSnapshot(storageRoot, snapshotHash),
      ),
    ).rejects.toMatchObject({
      finding: expect.objectContaining({ code: "snapshot-storage-failed" }),
    });
  });

  it("rejects unknown snapshot policy fields and preserves protected boundaries", async () => {
    expect(() =>
      createWorkflowContentSnapshotPolicy({
        provider: "physical-tree",
        include: ["**/*"],
        limits: { unexpected: 1 } as never,
      }),
    ).toThrow(/unknown field/);

    await fs.mkdir(path.join(root, "protected"));
    await expect(
      captureWorkflowContentSnapshot({
        root,
        protectedRoots: ["protected"],
        policy: createWorkflowContentSnapshotPolicy({
          provider: "physical-tree",
          include: ["protected/file.txt"],
          limits: { maxManifestBytes: 16 * 1024 },
        }),
      }),
    ).rejects.toMatchObject({
      finding: expect.objectContaining({ code: "snapshot-unsafe-scope" }),
    });
  });

  it("captures a Git worktree with provider-independent content identity", async () => {
    await initializeGitRepository(root);
    await commitGitRepository(root, "initial snapshot");

    const gitPolicy = createWorkflowContentSnapshotPolicy({
      provider: "git",
      include: ["nested/**", "z.txt"],
      limits: { maxManifestBytes: 32 * 1024 },
    });
    const physicalPolicy = createWorkflowContentSnapshotPolicy({
      provider: "physical-tree",
      include: ["nested/**", "z.txt"],
      limits: { maxManifestBytes: 32 * 1024 },
    });
    const [gitManifest, physicalManifest] = await Promise.all([
      captureWorkflowContentSnapshot({ root, policy: gitPolicy }),
      captureWorkflowContentSnapshot({ root, policy: physicalPolicy }),
    ]);

    expect(gitManifest.capture.provider).toBe("git");
    expect(gitManifest.capture.gitSelection).toMatchObject({
      status: expect.any(String),
      before: { recordCount: 2 },
      after: { recordCount: 2 },
    });
    expect(gitManifest.capture.gitEvidence).toMatchObject({
      status: "available",
      diagnostics: [],
    });
    expect(gitManifest.complete).toBe(true);
    expect(gitManifest.entries).toEqual(physicalManifest.entries);
    expect(hashWorkflowContentSnapshot(gitManifest)).toBe(
      hashWorkflowContentSnapshot(physicalManifest),
    );
  });

  it("keeps broad Git and physical scopes aligned without capturing Git metadata", async () => {
    await initializeGitRepository(root);
    await commitGitRepository(root, "broad parity baseline");
    const gitManifest = await captureWorkflowContentSnapshot({
      root,
      policy: createWorkflowContentSnapshotPolicy({
        provider: "git",
        include: ["**/*"],
        limits: { maxManifestBytes: 64 * 1024 },
      }),
    });
    const physicalManifest = await captureWorkflowContentSnapshot({
      root,
      policy: createWorkflowContentSnapshotPolicy({
        provider: "physical-tree",
        include: ["**/*"],
        limits: { maxManifestBytes: 64 * 1024 },
      }),
    });

    expect(gitManifest.complete).toBe(true);
    expect(physicalManifest.complete).toBe(true);
    expect(gitManifest.entries).toEqual(physicalManifest.entries);
    expect(hashWorkflowContentSnapshot(gitManifest)).toBe(
      hashWorkflowContentSnapshot(physicalManifest),
    );
    expect(gitManifest.entries.map((entry) => entry.path)).not.toContain(
      ".git/config",
    );
  });

  it("uses current Git working-tree bytes for dirty tracked and untracked files", async () => {
    await initializeGitRepository(root);
    await Promise.all([
      fs.writeFile(path.join(root, "modified.txt"), "before\n"),
      fs.writeFile(path.join(root, "staged.txt"), "before\n"),
      fs.writeFile(path.join(root, "deleted.txt"), "delete me\n"),
      fs.writeFile(
        path.join(root, "unstaged-deleted.txt"),
        "delete me without staging\n",
      ),
    ]);
    await commitGitRepository(root, "dirty snapshot baseline");
    await fs.writeFile(path.join(root, "modified.txt"), "working tree\n");
    await fs.writeFile(path.join(root, "staged.txt"), "index bytes\n");
    await git(root, "add", "staged.txt");
    await fs.rm(path.join(root, "deleted.txt"));
    await git(root, "add", "-u", "--", "deleted.txt");
    await fs.rm(path.join(root, "unstaged-deleted.txt"));
    await fs.writeFile(path.join(root, "selected-untracked.txt"), "new\n");

    const manifest = await captureWorkflowContentSnapshot({
      root,
      policy: createWorkflowContentSnapshotPolicy({
        provider: "git",
        include: [
          "modified.txt",
          "staged.txt",
          "deleted.txt",
          "unstaged-deleted.txt",
          "selected-untracked.txt",
        ],
        limits: { maxManifestBytes: 32 * 1024 },
      }),
    });

    expect(manifest.complete).toBe(false);
    expect(manifest.entries.map((entry) => entry.path)).toEqual([
      "modified.txt",
      "selected-untracked.txt",
      "staged.txt",
    ]);
    expect(manifest.omitted).toContainEqual({
      path: "deleted.txt",
      size: null,
      type: "file",
      reason: "deleted",
    });
    expect(manifest.omitted).toContainEqual({
      path: "unstaged-deleted.txt",
      size: null,
      type: "file",
      reason: "deleted",
    });
    expect(JSON.stringify(manifest)).not.toContain("working tree");
    expect(JSON.stringify(manifest)).not.toContain("index bytes");
  });

  it("captures an explicitly selected ignored untracked file", async () => {
    await initializeGitRepository(root);
    await fs.writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
    await commitGitRepository(root, "ignored-file baseline");
    await fs.writeFile(path.join(root, "ignored.txt"), "current bytes\n");

    const manifest = await captureWorkflowContentSnapshot({
      root,
      policy: createWorkflowContentSnapshotPolicy({
        provider: "git",
        include: ["ignored.txt"],
        limits: { maxManifestBytes: 32 * 1024 },
      }),
    });

    expect(manifest.complete).toBe(true);
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]?.path).toBe("ignored.txt");
  });

  it("keeps content identity stable across Git metadata-only drift", async () => {
    await initializeGitRepository(root);
    await commitGitRepository(root, "metadata baseline");
    const policy = createWorkflowContentSnapshotPolicy({
      provider: "git",
      include: ["z.txt"],
      limits: { maxManifestBytes: 32 * 1024 },
    });
    const first = await captureWorkflowContentSnapshot({ root, policy });
    await git(
      root,
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "metadata drift",
    );
    const second = await captureWorkflowContentSnapshot({ root, policy });

    expect(second.capture.gitEvidence?.before.head).not.toBe(
      first.capture.gitEvidence?.before.head,
    );
    expect(hashWorkflowContentSnapshot(second)).toBe(
      hashWorkflowContentSnapshot(first),
    );

    const evidenceOnlyChange = structuredClone(first);
    evidenceOnlyChange.capture.gitEvidence!.diagnostics = [
      "provider-private diagnostic",
    ];
    evidenceOnlyChange.capture.gitSelection!.before.outputBytes += 1;
    expect(hashWorkflowContentSnapshot(evidenceOnlyChange)).toBe(
      hashWorkflowContentSnapshot(first),
    );
    const withFallback = await captureWorkflowContentSnapshot({
      root,
      policy: createWorkflowContentSnapshotPolicy({
        provider: "git",
        fallback: "physical-tree",
        include: ["z.txt"],
        limits: { maxManifestBytes: 32 * 1024 },
      }),
    });
    expect(hashWorkflowContentSnapshot(withFallback)).not.toBe(
      hashWorkflowContentSnapshot(first),
    );
    const oversizedEvidence = structuredClone(first);
    oversizedEvidence.capture.gitSelection!.before.outputBytes =
      8 * 1024 * 1024 + 1;
    expect(() => hashWorkflowContentSnapshot(oversizedEvidence)).toThrow(
      /outputBytes exceeds/,
    );
  });

  it("records explicit physical fallback in the snapshot identity", async () => {
    const fallbackRoot = path.join(root, "fallback");
    await fs.mkdir(fallbackRoot);
    await fs.writeFile(path.join(fallbackRoot, "input.txt"), "fallback\n");
    const gitPolicy = createWorkflowContentSnapshotPolicy({
      provider: "git",
      fallback: "physical-tree",
      include: ["input.txt"],
      limits: { maxManifestBytes: 32 * 1024 },
    });
    const physicalPolicy = createWorkflowContentSnapshotPolicy({
      provider: "physical-tree",
      include: ["input.txt"],
      limits: { maxManifestBytes: 32 * 1024 },
    });

    const [fallback, physical] = await Promise.all([
      captureWorkflowContentSnapshot({ root: fallbackRoot, policy: gitPolicy }),
      captureWorkflowContentSnapshot({
        root: fallbackRoot,
        policy: physicalPolicy,
      }),
    ]);

    expect(fallback.capture).toMatchObject({
      provider: "physical-tree",
      requestedProvider: "git",
      fallback: {
        from: "git",
        to: "physical-tree",
        reason: "git-metadata-unavailable",
      },
    });
    expect(fallback.complete).toBe(true);
    expect(hashWorkflowContentSnapshot(fallback)).not.toBe(
      hashWorkflowContentSnapshot(physical),
    );
  });

  it("preserves explicit Git fallback when metadata disappears during capture", async () => {
    if (process.platform === "win32") return;
    const fallbackRoot = path.join(root, "fallback-during-capture");
    await fs.mkdir(fallbackRoot);
    await fs.writeFile(path.join(fallbackRoot, "input.txt"), "fallback\n");
    await initializeGitRepository(fallbackRoot);
    await commitGitRepository(fallbackRoot, "fallback baseline");
    const manifest = await captureWorkflowContentSnapshot({
      root: fallbackRoot,
      policy: createWorkflowContentSnapshotPolicy({
        provider: "git",
        fallback: "physical-tree",
        include: ["input.txt"],
        limits: { maxManifestBytes: 32 * 1024 },
      }),
      hooks: {
        afterInitialSelection: async () => {
          await fs.rm(path.join(fallbackRoot, ".git"), {
            recursive: true,
            force: true,
          });
        },
      },
    });

    expect(manifest.capture).toMatchObject({
      provider: "physical-tree",
      requestedProvider: "git",
      fallback: { from: "git", to: "physical-tree" },
    });
    expect(manifest.complete).toBe(true);
  });

  it("detects a Git selection race during capture", async () => {
    await initializeGitRepository(root);
    await commitGitRepository(root, "race baseline");
    const manifest = await captureWorkflowContentSnapshot({
      root,
      policy: createWorkflowContentSnapshotPolicy({
        provider: "git",
        include: ["**/*"],
        limits: { maxManifestBytes: 32 * 1024 },
      }),
      hooks: {
        afterInitialSelection: async () => {
          await fs.writeFile(
            path.join(root, "created-during-selection.txt"),
            "race\n",
          );
        },
      },
    });

    expect(manifest.complete).toBe(false);
    expect(manifest.capture.gitSelection?.status).toBe("changed");
    expect(manifest.omitted).toContainEqual({
      path: ".",
      size: null,
      type: "directory",
      reason: "git-selection-changed",
    });
    expect(manifest.entries.map((entry) => entry.path)).not.toContain(
      "created-during-selection.txt",
    );
  });

  it("detects index drift during Git content reads", async () => {
    await initializeGitRepository(root);
    await commitGitRepository(root, "index race baseline");
    const manifest = await captureWorkflowContentSnapshot({
      root,
      policy: createWorkflowContentSnapshotPolicy({
        provider: "git",
        include: ["z.txt"],
        limits: { maxManifestBytes: 32 * 1024 },
      }),
      hooks: {
        afterInitialSelection: async () => {
          await fs.writeFile(path.join(root, "z.txt"), "staged race\n");
          await git(root, "add", "--", "z.txt");
        },
      },
    });

    expect(manifest.complete).toBe(false);
    expect(manifest.capture.gitSelection?.status).toBe("changed");
    expect(manifest.capture.gitSelection?.before.indexHash).not.toBe(
      manifest.capture.gitSelection?.after.indexHash,
    );
  });

  it("omits a Git file changed during bounded content hashing", async () => {
    await initializeGitRepository(root);
    await commitGitRepository(root, "Git content race baseline");
    const manifest = await captureWorkflowContentSnapshot({
      root,
      policy: createWorkflowContentSnapshotPolicy({
        provider: "git",
        include: ["z.txt"],
        limits: { maxManifestBytes: 32 * 1024 },
      }),
      hooks: {
        beforeFileRead: async (relative) => {
          if (relative === "z.txt") {
            await fs.writeFile(
              path.join(root, relative),
              "changed while hashing\n",
            );
          }
        },
      },
    });

    expect(manifest.complete).toBe(false);
    expect(manifest.entries).toEqual([]);
    expect(manifest.omitted).toContainEqual({
      path: "z.txt",
      size: null,
      type: "file",
      reason: "changed-during-read",
    });
  });

  it("returns bounded incomplete evidence when Git metadata is unavailable", async () => {
    const policy = createWorkflowContentSnapshotPolicy({
      provider: "git",
      include: ["z.txt"],
      limits: { maxManifestBytes: 32 * 1024 },
    });
    const manifest = await captureWorkflowContentSnapshot({ root, policy });

    expect(manifest.complete).toBe(false);
    expect(manifest.capture).toMatchObject({
      provider: "git",
      gitEvidence: {
        status: "unavailable",
        diagnostics: [expect.any(String)],
      },
    });
    expect(manifest.omitted).toContainEqual({
      path: ".",
      size: null,
      type: "directory",
      reason: "git-metadata-unavailable",
    });
  });

  it("records a Git provider error as bounded incomplete evidence", async () => {
    await initializeGitRepository(root);
    await commitGitRepository(root, "provider error baseline");
    await fs.writeFile(path.join(root, ".git", "index"), "corrupt index\n");

    const manifest = await captureWorkflowContentSnapshot({
      root,
      policy: createWorkflowContentSnapshotPolicy({
        provider: "git",
        include: ["z.txt"],
        limits: { maxManifestBytes: 32 * 1024 },
      }),
    });

    expect(manifest.complete).toBe(false);
    expect(manifest.capture.gitEvidence).toMatchObject({
      status: "error",
      diagnostics: [expect.any(String)],
    });
    expect(manifest.omitted).toContainEqual({
      path: ".",
      size: null,
      type: "directory",
      reason: "git-provider-error",
    });
  });

  it("rejects a protected Git scope before provider enumeration", async () => {
    await initializeGitRepository(root);
    await commitGitRepository(root, "protected scope baseline");
    await fs.mkdir(path.join(root, "protected"));

    await expect(
      captureWorkflowContentSnapshot({
        root,
        protectedRoots: ["protected"],
        policy: createWorkflowContentSnapshotPolicy({
          provider: "git",
          include: ["**/*"],
          limits: { maxManifestBytes: 32 * 1024 },
        }),
      }),
    ).rejects.toMatchObject({
      finding: expect.objectContaining({ code: "snapshot-unsafe-scope" }),
    });
  });

  it("records Git enumeration overflow without reading an incomplete selection", async () => {
    await initializeGitRepository(root);
    await commitGitRepository(root, "enumeration overflow baseline");
    const manifest = await captureWorkflowContentSnapshot({
      root,
      policy: createWorkflowContentSnapshotPolicy({
        provider: "git",
        include: ["**/*"],
        limits: {
          maxVisitedNodes: 1,
          maxManifestBytes: 32 * 1024,
        },
      }),
    });

    expect(manifest.complete).toBe(false);
    expect(manifest.capture.gitSelection?.status).toBe("overflow");
    expect(
      manifest.capture.gitSelection?.before.outputBytes,
    ).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(manifest.omitted).toContainEqual({
      path: ".",
      size: null,
      type: "directory",
      reason: "git-enumeration-limit",
    });
  });

  it("does not cross a nested Git repository boundary", async () => {
    if (process.platform === "win32") return;
    await initializeGitRepository(root);
    await commitGitRepository(root, "outer baseline");
    const nested = path.join(root, "nested-repository");
    await fs.mkdir(nested);
    await initializeGitRepository(nested);
    await fs.writeFile(path.join(nested, "child.txt"), "child\n");
    await commitGitRepository(nested, "nested baseline");
    await expect(
      captureWorkflowContentSnapshot({
        root,
        policy: createWorkflowContentSnapshotPolicy({
          provider: "git",
          include: ["nested-repository/child.txt"],
          limits: { maxManifestBytes: 32 * 1024 },
        }),
      }),
    ).resolves.toMatchObject({
      complete: false,
      capture: { gitEvidence: { status: "nested-repository" } },
      omitted: [
        {
          path: ".",
          size: null,
          type: "directory",
          reason: "git-nested-repository",
        },
      ],
    });
  });

  it("rejects a selected path inside an indexed Git submodule", async () => {
    if (process.platform === "win32") return;
    await initializeGitRepository(root);
    await commitGitRepository(root, "outer baseline");
    const nested = path.join(root, "indexed-submodule");
    await fs.mkdir(nested);
    await initializeGitRepository(nested);
    await fs.writeFile(path.join(nested, "child.txt"), "child\n");
    await commitGitRepository(nested, "submodule baseline");
    const nestedCommit = (await git(nested, "rev-parse", "HEAD")).trim();
    await git(
      root,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${nestedCommit},indexed-submodule`,
    );
    await git(root, "commit", "--quiet", "-m", "index submodule");

    const manifest = await captureWorkflowContentSnapshot({
      root,
      policy: createWorkflowContentSnapshotPolicy({
        provider: "git",
        include: ["indexed-submodule/child.txt"],
        limits: { maxManifestBytes: 32 * 1024 },
      }),
    });

    expect(manifest.complete).toBe(false);
    expect(manifest.capture.gitEvidence?.status).toBe("nested-repository");
    expect(manifest.omitted).toContainEqual({
      path: ".",
      size: null,
      type: "directory",
      reason: "git-nested-repository",
    });
  });

  it("persists and recovers Git snapshot references for both Run locations", async () => {
    const manualRoot = path.join(root, "manual-git-project");
    const standaloneRoot = path.join(root, "standalone-git-project");
    await Promise.all([
      fs.mkdir(path.join(manualRoot, "src"), { recursive: true }),
      fs.mkdir(path.join(standaloneRoot, "src"), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(
        path.join(manualRoot, "src", "input.txt"),
        "same Git bytes\n",
      ),
      fs.writeFile(
        path.join(standaloneRoot, "src", "input.txt"),
        "same Git bytes\n",
      ),
    ]);
    await Promise.all([
      initializeGitRepository(manualRoot),
      initializeGitRepository(standaloneRoot),
    ]);
    await Promise.all([
      commitGitRepository(manualRoot, "manual Git baseline"),
      commitGitRepository(standaloneRoot, "standalone Git baseline"),
    ]);
    const policy = createWorkflowContentSnapshotPolicy({
      provider: "git",
      include: ["src/**"],
      limits: { maxManifestBytes: 32 * 1024 },
    });
    const protocol = snapshotRuntimeProtocol(policy);
    const runtime = createWorkflowRuntime();
    const manual = await runtime.start({
      protocol,
      location: { kind: "manual", runRoot: manualRoot },
      runId: "manual-git-run",
    });
    const standalone = await runtime.start({
      protocol,
      location: {
        kind: "standalone",
        projectRoot: standaloneRoot,
        runId: "standalone-git-run",
      },
    });

    expect(manual.contentSnapshots).toEqual(standalone.contentSnapshots);
    expect(manual.contentSnapshots[0]?.provider).toBe("git");
    expect(
      (await runtime.recover({ kind: "manual", runRoot: manualRoot }))
        .contentSnapshots,
    ).toEqual(manual.contentSnapshots);
    expect(
      (
        await runtime.recover({
          kind: "standalone",
          projectRoot: standaloneRoot,
          runId: "standalone-git-run",
        })
      ).contentSnapshots,
    ).toEqual(standalone.contentSnapshots);
  });
});
