import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  assemblePackage,
  buildProposal,
  evaluatePackage,
  generateFromApprovedProposal,
  initializeState,
  runManualAuthoringFixture,
} from "../src/index.js";
import { readRunState } from "../src/engine/state.js";
import { questionnaireFixture } from "./fixtures/semantic-dossier.js";

const execFileAsync = promisify(execFile);

describe("generated package runtime modes", () => {
  let project: string;

  beforeEach(async () => {
    project = await fs.mkdtemp(path.join(os.tmpdir(), "badger-runtime-modes-"));
  });

  afterEach(async () => fs.rm(project, { recursive: true, force: true }));

  async function generate(decision = false, receipts = false) {
    const skillRoot = path.join(project, "skills", "prepare");
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.writeFile(
      path.join(skillRoot, "SKILL.md"),
      "---\nname: prepare\ndescription: Prepare a report.\n---\n\nPrepare the requested report.\n",
    );
    const plan = questionnaireFixture().factoryPlan;
    if (receipts) {
      plan.workflow.outputSchemas!.push({
        id: "report.v1",
        description: "The prepared report.",
        externalRoots: {
          reports: { description: "The shared folder that holds reports." },
        },
        artifacts: [
          {
            id: "report",
            kind: "file",
            required: true,
            paths: ["report.pdf"],
            validations: ["artifact-exists"],
            verification: "receipt",
            root: "reports",
            requireCurrentAttempt: true,
          },
        ],
        evidence: [],
      });
      plan.workflow.customNodes[0]!.outputSchemas.push("report.v1");
    }
    if (decision) {
      const node = plan.workflow.customNodes[0]!;
      plan.workflow.customNodes.push({
        ...node,
        id: "finish",
        label: "Finish",
      });
      node.kind = "decision";
      node.decision = {
        id: "report-review",
        question: "Should this report be accepted?",
        choices: [
          { id: "accept", label: "Accept", to: "finish" },
          { id: "reject", label: "Reject", to: null },
        ],
      };
    }
    const planPath = path.join(project, "plan.json");
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2));
    const proposal = await buildProposal({ projectRoot: project, planPath });
    expect(proposal.canInitialize).toBe(true);
    const state = await initializeState({
      projectRoot: project,
      planPath,
      proposalHash: proposal.proposalHash,
      confirmed: true,
    });
    return generateFromApprovedProposal({
      projectRoot: project,
      name: state.name,
      confirmed: true,
    });
  }

  it("prefers Badger MCP Run tools and describes the script fallback in entry and Node instructions", async () => {
    const { generated } = await generate();
    for (const file of ["SKILL.md", "prepared-workflow-prepare/SKILL.md"]) {
      const instructions = await fs.readFile(
        path.join(generated.packageRoot, file),
        "utf8",
      );
      expect(instructions, file).toContain(
        "Prefer the Badger MCP Run tools when they are available",
      );
      for (const tool of ["start", "next", "submit", "status", "recover"]) {
        expect(instructions, file).toContain(`\`${tool}\``);
      }
      expect(instructions, file).toContain("hosts without MCP");
      for (const command of ["status", "init", "next", "record", "recover"]) {
        expect(instructions, file).toContain(
          `node scripts/workflow-state.mjs ${command}`,
        );
      }
      expect(instructions, file).not.toContain("## Artifact Receipts");
    }
  });

  it("asks the person for each external root's directory and binds it at init", async () => {
    const { generated } = await generate(false, true);
    const entry = await fs.readFile(
      path.join(generated.packageRoot, "SKILL.md"),
      "utf8",
    );
    expect(entry).toContain("## Artifact Receipts");
    expect(entry).toContain(
      "- **report.v1.report**: `report.pdf` under external root `reports`; written during the current Attempt",
    );
    expect(entry).toContain("### External roots");
    expect(entry).toContain(
      "- **reports**: The shared folder that holds reports.",
    );
    expect(entry).toContain(
      "ask the person for each directory; never guess one",
    );
    expect(entry).toContain("`--external-root <name>=<directory>`");
    // The package names the root and leaves its directory to each Run.
    expect(await fs.readFile(generated.protocolPath, "utf8")).not.toContain(
      project,
    );

    const script = path.join(
      generated.packageRoot,
      "scripts",
      "workflow-state.mjs",
    );
    const runRoot = path.join(project, "run");
    const reports = path.join(project, "reports");
    await fs.mkdir(reports);
    const run = async (...args: string[]) => {
      const result = await execFileAsync(
        process.execPath,
        [script, ...args, "--run-root", runRoot, "--json"],
        { cwd: project },
      );
      return JSON.parse(result.stdout);
    };
    await expect(run("init")).rejects.toThrow(
      "external root reports needs a directory when the Run starts",
    );
    await expect(run("init", "--external-root", "reports")).rejects.toThrow(
      "--external-root requires <name>=<directory>.",
    );
    await expect(
      run(
        "init",
        "--external-root",
        `reports=${reports}`,
        "--external-root",
        `reports=${reports}`,
      ),
    ).rejects.toThrow("--external-root reports is given more than once.");
    expect(await run("status")).toMatchObject({ status: "not-started" });

    const started = await run(
      "init",
      "--run-id",
      "bound-reports",
      "--external-root",
      `reports=${reports}`,
    );
    expect(started).toMatchObject({
      runId: "bound-reports",
      currentNode: "prepare",
    });
    expect(
      (await readRunState(runRoot))?.workflowRuntime?.externalRoots,
    ).toEqual({ reports });
    await expect(
      run("next", "--external-root", `reports=${reports}`),
    ).rejects.toThrow("--external-root applies only to init.");
  });

  it("keeps MCP gate answers in the dashboard and local decisions behind the person's confirmation", async () => {
    const { generated } = await generate(true);
    const entry = await fs.readFile(
      path.join(generated.packageRoot, "SKILL.md"),
      "utf8",
    );
    const node = await fs.readFile(
      path.join(generated.packageRoot, "prepared-workflow-prepare", "SKILL.md"),
      "utf8",
    );
    for (const instructions of [entry, node]) {
      expect(instructions).toContain("returned dashboard link");
      expect(instructions).toContain("signed-in person");
      expect(instructions).toContain("The Agent never supplies a reviewer");
      expect(instructions).toContain(
        "decision, manual-stop, and finalization gates",
      );
    }
    expect(entry).toContain(
      "The commands in this section apply only to script adapter mode",
    );
    expect(node).toContain("In MCP mode, follow the dashboard gate");
    expect(node).toContain("In script adapter mode, after the person confirms");
    expect(node).toContain("scripts/workflow-state.mjs decide");
  });

  it("evaluates assembled packages with both modes and rejects drift in MCP guidance", async () => {
    const { state, generated } = await generate();
    const assembled = await assemblePackage(
      await runManualAuthoringFixture({ state }),
      true,
    );
    const nodePath = path.join(
      generated.packageRoot,
      "prepared-workflow-prepare",
      "SKILL.md",
    );
    const node = await fs.readFile(nodePath, "utf8");
    for (const instructions of [
      await fs.readFile(path.join(generated.packageRoot, "SKILL.md"), "utf8"),
      node,
    ]) {
      expect(instructions).toContain(
        "Prefer the Badger MCP Run tools when they are available",
      );
      expect(instructions).toContain("hosts without MCP");
    }
    const report = await evaluatePackage(assembled);
    expect(report.checks.filter((check) => !check.passed)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.hash).toBe(assembled.authoring!.assembledPackageHash);
    expect(report.runtime).toMatchObject({
      completed: true,
      publicRuntimeCompleted: true,
      compatibilityAdapterResumed: true,
      reverseAdapterCompleted: true,
    });

    await fs.writeFile(
      nodePath,
      node.replace(
        "Prefer the Badger MCP Run tools when they are available",
        "Always drive this Run through the script adapter",
      ),
    );
    const drifted = await evaluatePackage(assembled);
    expect(drifted.passed).toBe(false);
    expect(drifted.checks).toContainEqual(
      expect.objectContaining({ id: "authoring-assembly", passed: false }),
    );
  }, 30_000);

  it("runs the generated script adapter without MCP", async () => {
    const { generated } = await generate();
    const script = path.join(
      generated.packageRoot,
      "scripts",
      "workflow-state.mjs",
    );
    const runRoot = path.join(project, "run");
    const run = async (...args: string[]) => {
      const result = await execFileAsync(
        process.execPath,
        [script, ...args, "--run-root", runRoot, "--json"],
        { cwd: project },
      );
      return JSON.parse(result.stdout);
    };
    expect(await run("status")).toMatchObject({ status: "not-started" });
    const started = await run("init", "--run-id", "script-only");
    expect(started).toMatchObject({
      runId: "script-only",
      currentNode: "prepare",
      disposition: "continue",
    });
    const next = await run("next");
    expect(next.pendingAction.id).toBe(started.pendingAction.id);
    expect((await run("recover")).pendingAction.id).toBe(next.pendingAction.id);
    expect(
      await run(
        "record",
        "prepare",
        JSON.stringify({ summary: "Report ready." }),
      ),
    ).toMatchObject({ runId: "script-only", disposition: "done" });
    expect(await run("status")).toMatchObject({
      runId: "script-only",
      status: "completed",
      completedNodes: ["prepare"],
    });
  });
});
