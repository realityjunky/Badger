import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { generatePackage } from "../src/factory/generate.js";
import { normalizeWorkflow } from "../src/workflow/contract.js";
import type {
  FactoryPlan,
  FactoryProposal,
  WorkflowInput,
} from "../src/types.js";

const execFileAsync = promisify(execFile);

function workflowInput(): WorkflowInput {
  return {
    kind: "workflow-kernel",
    name: "guard-handoff-workflow",
    goal: "Run the guard and handoff workflow.",
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
        requiredSkillCalls: [
          {
            skill: "support-skill",
            operation: "require",
            scope: "main",
          },
        ],
        augmentations: [
          {
            skill: "mandatory-augmentation",
            operation: "augment",
            scope: "main",
            enforcement: "evidence-only",
          },
          {
            skill: "advisory-augmentation",
            operation: "augment",
            scope: "main",
            enforcement: "advisory",
          },
        ],
        operations: ["require", "augment", "disable"],
        outputSchemas: ["prepare.v1"],
        guardrails: [
          {
            id: "prepare-guardrail",
            label: "Preparation is safe.",
            validation: "evidence-only",
          },
        ],
      },
      {
        id: "finish",
        label: "Finish",
        kind: "action",
        responsibility: "Finish the workflow.",
        implementation: {
          skill: "finish-skill",
          operation: "default",
          scope: "main",
        },
        operations: ["require", "augment", "disable"],
        outputSchemas: [],
        guardrails: [],
      },
    ],
    outputSchemas: [
      {
        id: "prepare.v1",
        description: "Preparation output.",
        artifacts: [
          {
            id: "result",
            kind: "file",
            required: true,
            paths: ["prepare.txt"],
            validations: ["artifact-exists"],
          },
        ],
        evidence: [{ id: "summary", required: true }],
      },
    ],
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
      skillSources: [],
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

async function createGeneratedProject(root: string): Promise<{
  projectRoot: string;
  packageRoot: string;
}> {
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot, { recursive: true });
  const generated = await generatePackage({
    ...proposal(),
    destination: path.join(projectRoot, "generated"),
  });
  return { projectRoot, packageRoot: generated.packageRoot };
}

function scriptPath(packageRoot: string, name: string): string {
  return path.join(packageRoot, "scripts", name);
}

function runScript(
  script: string,
  projectRoot: string,
  args: string[],
): ReturnType<typeof execFileAsync> {
  return execFileAsync(process.execPath, [script, ...args], {
    cwd: projectRoot,
    env: process.env,
  });
}

const preparationEvidence = JSON.stringify({
  summary: "Prepared.",
  completedChecks: [
    "required-skill:prepare.support-skill",
    "augmentation:prepare.mandatory-augmentation",
    "guardrail:prepare.prepare-guardrail",
  ],
});

describe("generated WorkflowRuntime guard and handoff adapters", () => {
  let root: string;

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("generates thin guard and handoff adapters", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-guard-handoff-"));
    const { projectRoot, packageRoot } = await createGeneratedProject(root);
    const guard = await fs.readFile(
      scriptPath(packageRoot, "workflow-guard.mjs"),
      "utf8",
    );
    const handoff = await fs.readFile(
      scriptPath(packageRoot, "workflow-handoff.mjs"),
      "utf8",
    );
    const entry = await fs.readFile(path.join(packageRoot, "SKILL.md"), "utf8");

    await expect(
      fs.stat(scriptPath(packageRoot, "workflow-guard.mjs")),
    ).resolves.toMatchObject({ isFile: expect.any(Function) });
    await expect(
      fs.stat(scriptPath(packageRoot, "workflow-handoff.mjs")),
    ).resolves.toMatchObject({ isFile: expect.any(Function) });
    expect(guard).toContain("./workflow-runtime.mjs");
    expect(guard).toContain("validateWorkflowSubmission");
    expect(guard).toContain('submissionField(evidence, "verification")');
    expect(handoff).toContain("VERIFICATION:");
    expect(guard).not.toContain("completedNodes");
    expect(guard).not.toContain("nextNode");
    expect(guard).not.toContain("writeRunState");
    expect(guard).not.toContain("recordOutcome");
    expect(handoff).toContain("./workflow-runtime.mjs");
    expect(handoff).toContain("projectWorkflowHandoff");
    expect(handoff).not.toContain("completedNodes");
    expect(handoff).not.toContain("nextNode");
    expect(entry).toContain("node scripts/workflow-guard.mjs verify");
    expect(entry).toContain("node scripts/workflow-guard.mjs entry <node>");
    expect(entry).toContain("node scripts/workflow-guard.mjs exit <node>");
    expect(entry).toContain("node scripts/workflow-handoff.mjs --json");
    await expect(
      fs.access(path.join(projectRoot, ".badger")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("verifies, guards, validates, applies, and hands off a manual Run", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-guard-handoff-"));
    const { projectRoot, packageRoot } = await createGeneratedProject(root);
    const guard = scriptPath(packageRoot, "workflow-guard.mjs");
    const handoff = scriptPath(packageRoot, "workflow-handoff.mjs");
    const state = scriptPath(packageRoot, "workflow-state.mjs");

    const verification = JSON.parse(
      (await runScript(guard, projectRoot, ["verify", "--json"])).stdout,
    ) as {
      protocolHash: string;
      packageHash: string;
      snapshotHash: string;
      nodeToStep: Record<string, string>;
      findingCatalogVersion: number;
    };
    expect(verification).toMatchObject({
      protocolHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      packageHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      nodeToStep: {
        prepare: "node-1-prepare",
        finish: "node-2-finish",
      },
      findingCatalogVersion: 1,
    });

    const beforeRun = JSON.parse(
      (await runScript(handoff, projectRoot, ["--json"])).stdout,
    ) as { continuation: unknown };
    expect(beforeRun.continuation).toBeNull();

    await runScript(state, projectRoot, ["init", "--run-id", "manual-run"]);
    const runStatePath = path.join(projectRoot, ".badger", "run-state.json");
    const runStateBefore = await fs.readFile(runStatePath, "utf8");
    const runState = JSON.parse(runStateBefore) as { trajectoryRef: string };
    const trajectoryPath = path.join(projectRoot, runState.trajectoryRef);
    const trajectoryBefore = await fs.readFile(trajectoryPath, "utf8");

    const currentHandoff = JSON.parse(
      (await runScript(handoff, projectRoot, ["--json"])).stdout,
    ) as {
      workflow: { name: string; protocolHash: string };
      execution: { protocolHash: string };
      nodes: Array<{
        id: string;
        requiredSkillCalls: Array<{ skill: string }>;
      }>;
      outputSchemas: Array<{ id: string }>;
      continuation: {
        disposition: string;
        currentNode: string;
        pendingAction: { id: string };
        findings: Array<{ code: string; requiredAction: string }>;
      };
    };
    expect(currentHandoff).toMatchObject({
      workflow: {
        name: "guard-handoff-workflow",
        protocolHash: verification.protocolHash,
      },
      execution: { protocolHash: verification.protocolHash },
      outputSchemas: [{ id: "prepare.v1" }],
      continuation: {
        disposition: "continue",
        currentNode: "prepare",
        findings: [
          expect.objectContaining({
            code: "action-available",
            requiredAction: "execute",
          }),
        ],
      },
    });
    expect(currentHandoff.nodes.find((node) => node.id === "prepare")).toEqual(
      expect.objectContaining({
        requiredSkillCalls: expect.arrayContaining([
          expect.objectContaining({ skill: "support-skill" }),
        ]),
      }),
    );
    expect(await fs.readFile(runStatePath, "utf8")).toBe(runStateBefore);
    expect(await fs.readFile(trajectoryPath, "utf8")).toBe(trajectoryBefore);

    await expect(
      runScript(guard, projectRoot, ["entry", "finish"]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("BLOCKED: current Node is prepare"),
    });
    await runScript(guard, projectRoot, ["entry", "prepare"]);

    await expect(
      runScript(guard, projectRoot, [
        "exit",
        "prepare",
        '{"summary":"Not ready."}',
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "BLOCKED: Missing Output Schema artifacts: prepare.v1.result",
      ),
    });
    await expect(
      runScript(guard, projectRoot, [
        "exit",
        "prepare",
        '{"summary":"Not ready."}',
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("FINDING: {"),
    });
    expect(await fs.readFile(runStatePath, "utf8")).toBe(runStateBefore);
    expect(await fs.readFile(trajectoryPath, "utf8")).toBe(trajectoryBefore);

    await fs.writeFile(path.join(projectRoot, "prepare.txt"), "prepared\n");
    const dryExit = await runScript(guard, projectRoot, [
      "exit",
      "prepare",
      preparationEvidence,
    ]);
    expect(dryExit.stdout).toContain("ALL CHECKS PASSED");
    expect(dryExit.stdout).toContain("--apply");
    expect(await fs.readFile(runStatePath, "utf8")).toBe(runStateBefore);
    expect(await fs.readFile(trajectoryPath, "utf8")).toBe(trajectoryBefore);

    const applied = await runScript(guard, projectRoot, [
      "exit",
      "prepare",
      preparationEvidence,
      "--apply",
    ]);
    expect(applied.stdout).toContain("NODE: finish");

    await expect(
      runScript(guard, projectRoot, [
        "exit",
        "prepare",
        preparationEvidence,
        "--action-id",
        currentHandoff.continuation.pendingAction.id,
        "--apply",
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("BLOCKED: current Node is finish"),
    });

    await runScript(guard, projectRoot, [
      "exit",
      "finish",
      '{"summary":"Finished."}',
      "--apply",
    ]);
    await expect(
      runScript(guard, projectRoot, [
        "exit",
        "finish",
        '{"summary":"Finished twice."}',
        "--apply",
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("BLOCKED: current Node is (none)"),
    });
  });

  it("uses the same guard and handoff adapters for standalone Runs", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-guard-handoff-"));
    const { projectRoot, packageRoot } = await createGeneratedProject(root);
    const guard = scriptPath(packageRoot, "workflow-guard.mjs");
    const handoff = scriptPath(packageRoot, "workflow-handoff.mjs");
    const state = scriptPath(packageRoot, "workflow-state.mjs");
    const target = ["--project", projectRoot, "--run-id", "standalone-run"];

    const initialized = JSON.parse(
      (await runScript(state, projectRoot, ["init", ...target, "--json"]))
        .stdout,
    ) as { runId: string; currentNode: string };
    expect(initialized).toMatchObject({
      runId: "standalone-run",
      currentNode: "prepare",
    });
    await runScript(guard, projectRoot, ["entry", "prepare", ...target]);
    const standaloneHandoff = JSON.parse(
      (await runScript(handoff, projectRoot, [...target, "--json"])).stdout,
    ) as {
      continuation: { runId: string; currentNode: string };
    };
    expect(standaloneHandoff.continuation).toMatchObject({
      runId: "standalone-run",
      currentNode: "prepare",
    });
    await fs.writeFile(
      path.join(
        projectRoot,
        ".badger",
        "runs",
        "standalone-run",
        "prepare.txt",
      ),
      "prepared\n",
    );
    await runScript(guard, projectRoot, [
      "exit",
      "prepare",
      preparationEvidence,
      "--apply",
      ...target,
    ]);
    const next = JSON.parse(
      (await runScript(state, projectRoot, ["status", ...target, "--json"]))
        .stdout,
    ) as { currentNode: string; runId: string };
    expect(next).toMatchObject({
      runId: "standalone-run",
      currentNode: "finish",
    });
  });
});
