import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { generatePackage } from "../src/factory/generate.js";
import { normalizeWorkflow } from "../src/workflow/contract.js";
import { createWorkflowRuntime } from "../src/workflow-runtime/index.js";
import type {
  FactoryPlan,
  FactoryProposal,
  WorkflowInput,
} from "../src/types.js";

const execFileAsync = promisify(execFile);

function workflowInput(): WorkflowInput {
  return {
    kind: "workflow-kernel",
    name: "adapter-workflow",
    goal: "Run the adapter workflow.",
    customNodes: [
      {
        id: "prepare",
        label: "Prepare",
        kind: "action",
        responsibility: "Prepare the workflow.",
        implementation: {
          skill: "prepare-skill",
          operation: "default",
          scope: "main",
        },
        operations: ["require", "augment", "disable"],
        outputSchemas: [],
        guardrails: [],
      },
    ],
    outputSchemas: [],
  };
}

function proposal(): { plan: FactoryPlan; proposal: FactoryProposal } {
  const input = workflowInput();
  const normalized = normalizeWorkflow(input);
  return {
    plan: {
      schemaVersion: 1,
      goal: input.goal,
      skillCreatorIntent: "new-skill",
      preferredSkills: [],
      workflow: input,
      defaultLocale: "en",
    },
    proposal: {
      schemaVersion: 1,
      name: normalized.protocol.name,
      goal: normalized.protocol.goal,
      intent: "new-skill",
      planHash: "plan-hash",
      workflow: normalized.protocol,
      candidates: [],
      blockers: [],
      warnings: [],
      canInitialize: true,
    },
  };
}

describe("generated WorkflowRuntime state adapter", () => {
  let root: string;

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("ships one runtime asset and a thin state adapter", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "comet-workflow-adapter-"));
    const destination = path.join(root, "generated");
    const generated = await generatePackage({
      ...proposal(),
      destination,
    });

    const runtimePath = path.join(
      generated.packageRoot,
      "scripts",
      "workflow-runtime.mjs",
    );
    const statePath = path.join(
      generated.packageRoot,
      "scripts",
      "workflow-state.mjs",
    );
    const stateAdapter = await fs.readFile(statePath, "utf8");
    const entrySkill = await fs.readFile(
      path.join(generated.packageRoot, "SKILL.md"),
      "utf8",
    );

    await expect(fs.stat(runtimePath)).resolves.toMatchObject({
      isFile: expect.any(Function),
    });
    expect(stateAdapter).toContain("./workflow-runtime.mjs");
    expect(stateAdapter).toContain("createWorkflowRuntime");
    expect(stateAdapter).not.toContain("completedNodes");
    expect(stateAdapter).not.toContain("nextNode");
    expect(entrySkill).toContain("node scripts/workflow-state.mjs status");
    expect(entrySkill).toContain("node scripts/workflow-state.mjs next");
  });

  it("runs manual commands through the authoritative runtime", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "comet-workflow-adapter-"));
    const projectRoot = path.join(root, "project");
    await fs.mkdir(projectRoot, { recursive: true });
    const generated = await generatePackage({
      ...proposal(),
      destination: path.join(projectRoot, "generated"),
    });
    const scriptPath = path.join(
      generated.packageRoot,
      "scripts",
      "workflow-state.mjs",
    );
    const run = (args: string[]) =>
      execFileAsync(process.execPath, [scriptPath, ...args], {
        cwd: projectRoot,
        env: process.env,
      });

    const initialized = await run(["init", "--run-id", "manual-run"]);
    expect(initialized.stdout).toContain("NEXT: auto");
    expect(initialized.stdout).toContain("NODE: prepare");

    const stateFile = path.join(projectRoot, ".comet", "run-state.json");
    const stateBefore = await fs.readFile(stateFile, "utf8");
    const state = JSON.parse(stateBefore) as { trajectoryRef: string };
    const trajectoryFile = path.join(projectRoot, state.trajectoryRef);
    const trajectoryBefore = await fs.readFile(trajectoryFile, "utf8");

    const firstStatus = JSON.parse((await run(["status"])).stdout) as {
      status: string;
      currentNode: string;
      pendingAction: { id: string };
    };
    expect(firstStatus).toMatchObject({
      status: "waiting",
      currentNode: "prepare",
    });
    expect((await run(["next"])).stdout).toContain(
      `ACTION: ${firstStatus.pendingAction.id}`,
    );
    expect((await run(["status"])).stdout).toContain('"status": "waiting"');
    expect((await run(["next"])).stdout).toContain(
      `ACTION: ${firstStatus.pendingAction.id}`,
    );
    expect(await fs.readFile(stateFile, "utf8")).toBe(stateBefore);
    expect(await fs.readFile(trajectoryFile, "utf8")).toBe(trajectoryBefore);

    const legacyPath = path.join(
      projectRoot,
      ".comet",
      "runs",
      "adapter-workflow",
      "state.json",
    );
    await fs.rm(legacyPath);
    await run(["next"]);
    await expect(fs.access(legacyPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(run(["status", "--rebuild"])).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Rebuilding the legacy state projection requires --confirm legacy-state.",
      ),
    });
    await run(["next", "--rebuild", "--confirm", "legacy-state"]);
    await fs.writeFile(legacyPath, '{"status":"stale"}\n', "utf8");
    expect(JSON.parse((await run(["status"])).stdout)).toMatchObject({
      status: "waiting",
      currentNode: "prepare",
    });
    expect(JSON.parse(await fs.readFile(legacyPath, "utf8"))).toEqual({
      status: "stale",
    });
    await run(["status", "--rebuild", "--confirm", "legacy-state"]);

    const recorded = await run([
      "record",
      "prepare",
      '{"summary":"Prepared."}',
    ]);
    expect(recorded.stdout).toContain("EVIDENCE: prepare");
    expect(recorded.stdout).toContain("NEXT: done");

    const completed = JSON.parse((await run(["status"])).stdout) as {
      status: string;
      completedNodes: string[];
      evidence: Record<string, { summary: string }>;
    };
    expect(completed).toMatchObject({
      status: "completed",
      completedNodes: ["prepare"],
      evidence: { prepare: { summary: "Prepared." } },
    });
    const legacyProjection = JSON.parse(
      await fs.readFile(legacyPath, "utf8"),
    ) as { status: string };
    expect(legacyProjection.status).toBe("completed");
  });

  it("runs isolated standalone commands through the same runtime", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "comet-workflow-adapter-"));
    const projectRoot = path.join(root, "project");
    await fs.mkdir(projectRoot, { recursive: true });
    const generated = await generatePackage({
      ...proposal(),
      destination: path.join(projectRoot, "generated"),
    });
    const scriptPath = path.join(
      generated.packageRoot,
      "scripts",
      "workflow-state.mjs",
    );
    const run = (args: string[]) =>
      execFileAsync(process.execPath, [scriptPath, ...args], {
        cwd: projectRoot,
        env: process.env,
      });

    const first = JSON.parse(
      (
        await run([
          "init",
          "--project",
          projectRoot,
          "--run-id",
          "first-run",
          "--json",
        ])
      ).stdout,
    ) as { runId: string; currentNode: string };
    const second = JSON.parse(
      (
        await run([
          "init",
          "--project",
          projectRoot,
          "--run-id",
          "second-run",
          "--json",
        ])
      ).stdout,
    ) as { runId: string; currentNode: string };
    expect(first).toMatchObject({ runId: "first-run", currentNode: "prepare" });
    expect(second).toMatchObject({
      runId: "second-run",
      currentNode: "prepare",
    });

    const firstStatus = JSON.parse(
      (
        await run([
          "status",
          "--project",
          projectRoot,
          "--run-id",
          "first-run",
          "--json",
        ])
      ).stdout,
    ) as { status: string; runId: string; pendingAction: { id: string } };
    expect(firstStatus).toMatchObject({
      status: "waiting",
      runId: "first-run",
    });

    await run([
      "record",
      "prepare",
      '{"summary":"First prepared."}',
      "--project",
      projectRoot,
      "--run-id",
      "first-run",
    ]);
    const firstCompleted = JSON.parse(
      (
        await run([
          "status",
          "--project",
          projectRoot,
          "--run-id",
          "first-run",
          "--json",
        ])
      ).stdout,
    ) as { status: string; completedNodes: string[] };
    const secondStatus = JSON.parse(
      (
        await run([
          "status",
          "--project",
          projectRoot,
          "--run-id",
          "second-run",
          "--json",
        ])
      ).stdout,
    ) as { status: string; currentNode: string };
    expect(firstCompleted).toMatchObject({
      status: "completed",
      completedNodes: ["prepare"],
    });
    expect(secondStatus).toMatchObject({
      status: "waiting",
      currentNode: "prepare",
    });
  });

  it("preserves a blocked completion submission for the same action", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "comet-workflow-adapter-"));
    const projectRoot = path.join(root, "project");
    await fs.mkdir(projectRoot, { recursive: true });
    const fixture = proposal();
    fixture.plan.workflow.outputSchemas = [
      {
        id: "prepare.v1",
        description: "Preparation output.",
        artifacts: [
          {
            id: "result",
            kind: "file",
            required: true,
            paths: ["result.txt"],
            validations: ["artifact-exists"],
          },
        ],
        evidence: [{ id: "summary", required: true }],
      },
    ];
    fixture.plan.workflow.customNodes[0].outputSchemas = ["prepare.v1"];
    fixture.proposal.workflow = normalizeWorkflow(
      fixture.plan.workflow,
    ).protocol;
    const generated = await generatePackage({
      ...fixture,
      destination: path.join(projectRoot, "generated"),
    });
    const scriptPath = path.join(
      generated.packageRoot,
      "scripts",
      "workflow-state.mjs",
    );
    const run = (args: string[]) =>
      execFileAsync(process.execPath, [scriptPath, ...args], {
        cwd: projectRoot,
        env: process.env,
      });

    await run(["init", "--run-id", "evidence-run"]);
    const blocked = await run(["record", "prepare", "{}"]);
    expect(blocked.stdout).toContain("NEXT: blocked");
    expect(blocked.stdout).toContain("ACTION:");
    expect(blocked.stdout).toContain(
      "Missing Output Schema evidence: prepare.v1.summary",
    );

    const status = JSON.parse((await run(["status"])).stdout) as {
      status: string;
      currentNode: string;
      pendingAction: { id: string };
    };
    expect(status).toMatchObject({
      status: "waiting",
      currentNode: "prepare",
    });
    await fs.writeFile(path.join(projectRoot, "result.txt"), "ready\n");
    const completed = await run([
      "record",
      "prepare",
      '{"summary":"Prepared with the required result."}',
    ]);
    expect(completed.stdout).toContain("NEXT: done");
    expect((await run(["status"])).stdout).toContain('"status": "completed"');
  });

  it("reports an absent Run without creating compatibility state", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "comet-workflow-adapter-"));
    const projectRoot = path.join(root, "project");
    await fs.mkdir(projectRoot, { recursive: true });
    const generated = await generatePackage({
      ...proposal(),
      destination: path.join(projectRoot, "generated"),
    });
    const scriptPath = path.join(
      generated.packageRoot,
      "scripts",
      "workflow-state.mjs",
    );
    const status = await execFileAsync(
      process.execPath,
      [scriptPath, "status"],
      { cwd: projectRoot, env: process.env },
    );

    expect(JSON.parse(status.stdout)).toEqual({ status: "not-started" });
    await expect(
      execFileAsync(process.execPath, [scriptPath, "next"], {
        cwd: projectRoot,
        env: process.env,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Missing workflow state. Run workflow-state.mjs init first.",
      ),
    });
    await expect(
      fs.access(path.join(projectRoot, ".comet")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("projects exhausted Engine retries as blocked", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "comet-workflow-adapter-"));
    const projectRoot = path.join(root, "project");
    await fs.mkdir(projectRoot, { recursive: true });
    const generated = await generatePackage({
      ...proposal(),
      destination: path.join(projectRoot, "generated"),
    });
    const scriptPath = path.join(
      generated.packageRoot,
      "scripts",
      "workflow-state.mjs",
    );
    const run = (args: string[]) =>
      execFileAsync(process.execPath, [scriptPath, ...args], {
        cwd: projectRoot,
        env: process.env,
      });
    await run(["init", "--run-id", "retry-run"]);

    let continuation = await createWorkflowRuntime().recover(projectRoot);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      continuation = await createWorkflowRuntime().submit(projectRoot, {
        actionId: continuation.pendingAction!.id,
        nodeId: "prepare",
        status: "failed",
        summary: `Attempt ${attempt + 1} failed.`,
      });
    }

    expect(continuation).toMatchObject({
      disposition: "blocked",
      currentNode: "prepare",
      pendingAction: null,
    });
    const status = JSON.parse((await run(["status"])).stdout) as {
      status: string;
      currentNode: string;
      blockers: string[];
    };
    expect(status).toMatchObject({
      status: "blocked",
      currentNode: "prepare",
    });
    expect(status.blockers[0]).toContain("Retry budget exhausted for action:");
  });
});
