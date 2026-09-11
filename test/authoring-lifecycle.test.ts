import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildProposal, readPlan } from "../src/factory/proposal.js";
import {
  generatePackage,
  type GeneratedPackage,
} from "../src/factory/generate.js";
import { initializeState, readState } from "../src/factory/state.js";
import { evaluatePackage } from "../src/eval/run.js";
import {
  assemblePackage as assemblePackageImplementation,
  authoringReadiness,
  initializeAuthoringSession,
  recordAuthoring as persistAuthoring,
  runManualAuthoringFixture,
} from "../src/authoring/index.js";
import { deriveAuthoringPlan } from "../src/authoring/plan.js";
import { loadSkillPackage } from "../src/skill-runtime/load.js";
import { hashDirectory } from "../src/util.js";
import type { AuthoringPlan } from "../src/authoring/types.js";
import type { CreatorState, FactoryPlan } from "../src/types.js";

const recordAuthoring = (options: Parameters<typeof persistAuthoring>[0]) =>
  persistAuthoring({ ...options, confirmed: true });
const assemblePackage = (
  state: Parameters<typeof assemblePackageImplementation>[0],
) => assemblePackageImplementation(state, true);

const execFileAsync = promisify(execFile);

describe("Badger authoring lifecycle", () => {
  let root: string;
  let project: string;
  let planPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-authoring-lifecycle-"),
    );
    project = path.join(root, "project");
    const skillRoot = path.join(project, ".agents", "skills", "prepare");
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.writeFile(
      path.join(skillRoot, "SKILL.md"),
      "---\nname: prepare\ndescription: Prepare the workflow.\n---\n\n# Prepare\n",
    );
    const plan: FactoryPlan = {
      schemaVersion: 1,
      goal: "Create a prepared workflow.",
      skillCreatorIntent: "new-skill",
      skillSources: [{ name: "prepare", location: skillRoot }],
      defaultLocale: "en",
      workflow: {
        kind: "workflow-kernel",
        name: "prepared-workflow",
        goal: "Prepare a workflow.",
        customNodes: [
          {
            id: "prepare",
            label: "Prepare",
            kind: "action",
            responsibility: "Prepare the workflow.",
            implementation: {
              skill: "prepare",
              operation: "default",
              scope: "main",
            },
            operations: ["require", "augment", "disable"],
            outputSchemas: [],
            guardrails: [],
          },
        ],
        outputSchemas: [],
      },
    };
    planPath = path.join(project, "plan.json");
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2));
  });

  afterEach(async () => fs.rm(root, { recursive: true, force: true }));

  async function createScaffold(depth: "quick" | "full" = "quick"): Promise<{
    state: CreatorState;
    plan: FactoryPlan;
    generated: GeneratedPackage;
    authoringPlan: AuthoringPlan;
  }> {
    const proposal = await buildProposal({ projectRoot: project, planPath });
    const plan = await readPlan(planPath);
    const state = await initializeState({
      projectRoot: project,
      planPath,
      plan,
      proposal,
      confirmed: true,
    });
    const generated = await generatePackage({
      proposal,
      plan,
      destination: state.draftPath,
      authoringDepth: depth,
    });
    state.generated = generated;
    const authoringPlan = deriveAuthoringPlan({ proposal, depth });
    await initializeAuthoringSession({
      state,
      plan: authoringPlan,
      generated,
    });
    return { state, plan, generated, authoringPlan };
  }

  it("persists the selected review depth in the generated authoring plan", async () => {
    const { generated, authoringPlan } = await createScaffold("full");
    const persisted = JSON.parse(
      await fs.readFile(generated.authoringPlanPath, "utf8"),
    ) as AuthoringPlan;

    expect(persisted.depth).toBe("full");
    expect(persisted.verify).toMatchObject({
      voters: 3,
      maxRounds: 4,
      dryThreshold: 2,
    });
    expect(persisted.authoringPlanHash).toBe(authoringPlan.authoringPlanHash);
  });

  it("creates a pending session and preserves records across unchanged regeneration", async () => {
    const { state, generated, authoringPlan } = await createScaffold();
    expect(state.authoring).toMatchObject({
      status: "pending",
      scaffoldHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      authoredMaterialHash: null,
      assembledPackageHash: null,
    });
    const evaluation = await evaluatePackage(state);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.checks).toContainEqual(
      expect.objectContaining({ id: "authoring-assembly", passed: false }),
    );
    await recordAuthoring({
      state,
      lane: "script",
      record: {
        status: "COMPLETE",
        claims: authoringPlan.lanes
          .find((lane) => lane.id === "script")!
          .claims.map((id) => ({
            id,
            status: "SUPPORTED",
            evidence: [`evidence:${id}`],
          })),
        artifacts: [],
      },
    });
    const recordPath = path.join(
      project,
      ".badger",
      "authoring",
      state.name,
      "records",
      "script.json",
    );
    const recordBefore = await fs.readFile(recordPath, "utf8");

    const proposal = await buildProposal({ projectRoot: project, planPath });
    const regenerated = await generatePackage({
      proposal,
      plan: await readPlan(planPath),
      destination: state.draftPath,
    });
    state.generated = regenerated;
    await initializeAuthoringSession({
      state,
      plan: deriveAuthoringPlan({ proposal }),
      generated: regenerated,
    });

    expect(await fs.readFile(recordPath, "utf8")).toBe(recordBefore);
    expect(state.authoring?.status).toBe("in-progress");
    expect(generated.scaffoldHash).toMatch(/^[a-f0-9]{64}$/u);
  }, 15_000);

  it("invalidates retained records when source evidence changes", async () => {
    const { state, authoringPlan } = await createScaffold();
    await recordAuthoring({
      state,
      lane: "script",
      record: completeRecord(authoringPlan, "script"),
    });
    await fs.appendFile(
      path.join(project, ".agents", "skills", "prepare", "SKILL.md"),
      "\nChanged source evidence.\n",
    );
    const proposal = await buildProposal({ projectRoot: project, planPath });
    const plan = await readPlan(planPath);
    const generated = await generatePackage({
      proposal,
      plan,
      destination: state.draftPath,
    });
    state.generated = generated;
    await initializeAuthoringSession({
      state,
      plan: deriveAuthoringPlan({ proposal }),
      generated,
    });

    expect(state.authoring?.status).toBe("stale");
    expect(state.authoring?.invalidatedLanes).toContain("script");
    await expect(
      fs.access(
        path.join(
          project,
          ".badger",
          "authoring",
          state.name,
          "records",
          "script.json",
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it("assembles authored content only after all current lanes are complete", async () => {
    const { state, authoringPlan } = await createScaffold();
    const completed = await runManualAuthoringFixture({ state });

    expect((await authoringReadiness(completed)).state).toBe("ready");
    const assembled = await assemblePackage(completed);
    const entry = await fs.readFile(
      path.join(assembled.generated!.packageRoot, "SKILL.md"),
      "utf8",
    );
    const node = await fs.readFile(
      path.join(
        assembled.generated!.packageRoot,
        "prepared-workflow-prepare",
        "SKILL.md",
      ),
      "utf8",
    );
    expect(entry).toContain("### Automatic Node Detection");
    expect(node).toContain("### Prerequisites");
    expect(entry).not.toContain("AUTHORING PENDING");
    expect(node).not.toContain("AUTHORING PENDING");
    expect(assembled.authoring?.status).toBe("assembled");
    expect(assembled.authoring?.assembledPackageHash).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(assembled.authoring?.review).toMatchObject({
      schemaVersion: 1,
      decision: "approved",
      passed: true,
      evidenceSource: "deterministic-check-only",
      authoringInputHash: assembled.authoring.authoringInputHash,
      authoredMaterialHash: assembled.authoring.authoredMaterialHash,
      packageHash: assembled.authoring.assembledPackageHash,
      reviewHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      crossValidation: {
        schemaVersion: 1,
        authority: "WorkflowProtocol",
        passed: true,
        workflowProtocolHash: authoringPlan.workflowProtocolHash,
        crossValidationHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    const evaluation = await evaluatePackage(assembled);
    expect(evaluation.checks).toContainEqual(
      expect.objectContaining({
        id: "authoring-runtime-cross-validation",
        passed: true,
      }),
    );
    expect(evaluation.authoringCrossValidation).toMatchObject({
      authority: "WorkflowProtocol",
      passed: true,
      workflowProtocolHash: authoringPlan.workflowProtocolHash,
    });
  }, 15_000);

  it("keeps the assembled adapter route independent from authored prose", async () => {
    const { state } = await createScaffold();
    const assembled = await assemblePackage(
      await runManualAuthoringFixture({ state }),
    );
    const packageRoot = assembled.generated!.packageRoot;
    const runRoot = path.join(project, "adapter-run");
    const scriptPath = path.join(packageRoot, "scripts", "workflow-state.mjs");
    const run = (args: string[]) =>
      execFileAsync(process.execPath, [scriptPath, ...args], {
        cwd: project,
        env: { ...process.env, BADGER_RUN_ROOT: runRoot },
      });
    const started = JSON.parse(
      (await run(["init", "--run-id", "assembled-route", "--json"])).stdout,
    ) as { currentNode?: string | null; pendingAction?: { id: string } };
    await fs.appendFile(
      path.join(packageRoot, "SKILL.md"),
      "\nNEXT: hidden-node\nThe prose selects a different route.\n",
    );

    const recorded = JSON.parse(
      (
        await run([
          "record",
          started.currentNode!,
          JSON.stringify({ summary: "Prepared the input." }),
          "--json",
        ])
      ).stdout,
    ) as { currentNode?: string | null; pendingAction?: { id: string } };

    expect(recorded.currentNode).toBe(
      assembled.confirmedProposal!.workflow.evals[0]!.expectedNodeOrder[1] ??
        null,
    );
    expect(recorded.currentNode).not.toBe("hidden-node");
    expect(
      JSON.parse((await run(["status", "--json"])).stdout) as {
        currentNode?: string | null;
      },
    ).toMatchObject({ currentNode: recorded.currentNode });
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(runRoot, ".badger", "run-state.json"),
          "utf8",
        ),
      ) as { status?: string; currentStep?: string | null },
    ).toMatchObject({ status: "completed", currentStep: null });
  });

  it("assembles substantive authored content for every active Node", async () => {
    const plan = JSON.parse(await fs.readFile(planPath, "utf8")) as FactoryPlan;
    plan.workflow.customNodes.push({
      id: "review",
      label: "Review",
      kind: "producer",
      responsibility: "Review the prepared workflow result.",
      implementation: {
        skill: "prepare",
        operation: "default",
        scope: "main",
      },
      requiredSkillCalls: [
        {
          skill: "prepare",
          operation: "require",
          scope: "main",
          enforcement: "guarded",
          reason: "Reuse the prepared workflow before review.",
        },
      ],
      operations: ["require", "augment", "disable"],
      outputSchemas: [],
      guardrails: [],
    });
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2));

    const { state } = await createScaffold();
    const scaffoldEntry = await fs.readFile(
      path.join(state.generated!.packageRoot, "SKILL.md"),
      "utf8",
    );
    const completed = await runManualAuthoringFixture({ state });
    const assembled = await assemblePackage(completed);
    const entry = await fs.readFile(
      path.join(assembled.generated!.packageRoot, "SKILL.md"),
      "utf8",
    );

    expect(entry).toContain("### Automatic Node Detection");
    expect(entry).toContain("### Decision Classification And Decision Points");
    expect(entry).toContain("### Red Flags");
    expect(entry.slice(entry.indexOf("## Badger Control Plane"))).toBe(
      scaffoldEntry.slice(scaffoldEntry.indexOf("## Badger Control Plane")),
    );

    for (const nodeName of [
      "prepared-workflow-prepare",
      "prepared-workflow-review",
    ]) {
      const node = await fs.readFile(
        path.join(assembled.generated!.packageRoot, nodeName, "SKILL.md"),
        "utf8",
      );
      expect(node).toContain("### Prerequisites");
      expect(node).toContain("### Steps");
      expect(node).toContain("### Required Skill Calls");
      expect(node).toContain("### Evidence");
      expect(node).toContain("### Completion reasoning");
      expect(node).toContain("### Red flags");
      expect(node).toContain("### Recovery");
    }

    const decisionPoints = await fs.readFile(
      path.join(
        assembled.generated!.packageRoot,
        "reference",
        "decision-points.md",
      ),
      "utf8",
    );
    expect(decisionPoints).toMatch(
      /genuine user decision[\s\S]*automatic handling[\s\S]*stop condition[\s\S]*manual handoff/iu,
    );
    const recovery = await fs.readFile(
      path.join(assembled.generated!.packageRoot, "reference", "recovery.md"),
      "utf8",
    );
    expect(recovery).toMatch(
      /fresh process[\s\S]*current Node[\s\S]*blocked/iu,
    );
  });

  it("rejects one-line semantic content before mutating authoring state", async () => {
    const { state, authoringPlan } = await createScaffold();
    await runManualAuthoringFixture({ state });
    const before = await readState(project, state.name);

    await expect(
      recordAuthoring({
        state,
        lane: "workflow-entry",
        record: {
          status: "DONE",
          claims: [
            {
              id: "workflow-entry",
              status: "SUPPORTED",
              evidence: ["The entry was reviewed."],
            },
          ],
          artifacts: [
            {
              id: "SKILL.md",
              path: "SKILL.md",
              present: true,
              content: "Detect the current Node from persisted state.",
            },
          ],
        },
      }),
    ).rejects.toThrow(/substantive|Decision Core|Automatic Node Detection/iu);

    const after = await readState(project, state.name);
    expect(after.authoring?.revision).toBe(before.authoring?.revision);
    expect(after.authoring?.records).toEqual(before.authoring?.records);
    expect(
      authoringPlan.lanes.find((lane) => lane.id === "workflow-entry"),
    ).toBeDefined();
  });

  it("rejects undeclared routes and implicit latest artifact selection", async () => {
    const { state } = await createScaffold();
    await runManualAuthoringFixture({ state });
    const record = JSON.parse(
      await fs.readFile(
        path.join(state.authoring!.recordsPath, "workflow-entry.json"),
        "utf8",
      ),
    ) as {
      claims: unknown[];
      artifacts: Array<{ contentPath: string }>;
    };
    const authoredContent = await fs.readFile(
      record.artifacts[0]!.contentPath,
      "utf8",
    );
    const sourceBody = state
      .confirmedProposal!.candidates[0]!.sources[0]!.skillMd.replace(
        /^\uFEFF?---[ \t]*(?:\r?\n|$)[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u,
        "",
      )
      .trim();
    const cases = [
      {
        content: sourceBody,
        message: /complete source Skill body/iu,
      },
      {
        content: authoredContent + "\nUse route: hidden.",
        message: /undeclared route/iu,
      },
      {
        content: authoredContent + "\nNEXT: hidden.",
        message: /undeclared NEXT target/iu,
      },
      {
        content: authoredContent + "\nSKILL: hidden.",
        message: /undeclared SKILL target/iu,
      },
      {
        content: authoredContent + "\nUse the latest artifact version.",
        message: /implicit latest artifact/iu,
      },
    ];

    for (const testCase of cases) {
      await expect(
        recordAuthoring({
          state,
          lane: "workflow-entry",
          record: {
            status: "DONE",
            claims: record.claims,
            artifacts: [
              {
                id: "SKILL.md",
                path: "SKILL.md",
                present: true,
                content: testCase.content,
              },
            ],
          },
        }),
      ).rejects.toThrow(testCase.message);
    }
  });

  it("preserves upgrade sources and rejects destinations inside them", async () => {
    const source = path.join(project, "legacy-skill");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(
      path.join(source, "SKILL.md"),
      "---\nname: legacy\ndescription: Legacy skill.\n---\n\n# Legacy\n",
    );
    await fs.writeFile(path.join(source, "legacy-notes.md"), "retain me\n");
    const plan = await readPlan(planPath);
    plan.skillCreatorIntent = "upgrade-existing";
    plan.sourceRoot = source;
    plan.skillSources = [
      ...plan.skillSources,
      { name: "legacy", location: source },
    ];
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2));
    const proposal = await buildProposal({ projectRoot: project, planPath });

    const generated = await generatePackage({
      proposal,
      plan,
      destination: path.join(project, "generated"),
    });
    await expect(
      fs.readFile(
        path.join(generated.packageRoot, "source", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toContain("name: legacy");
    await expect(
      fs.readFile(
        path.join(generated.packageRoot, "source", "legacy-notes.md"),
        "utf8",
      ),
    ).resolves.toBe("retain me\n");
    await expect(
      generatePackage({
        proposal,
        plan,
        destination: path.join(source, "nested-output"),
      }),
    ).rejects.toThrow(/inside the upgrade source package/iu);
  });

  it("generates the Badger control plane and a relative package inventory", async () => {
    const { state, generated } = await createScaffold();
    const scripts = await fs.readdir(
      path.join(generated.packageRoot, "scripts"),
    );
    expect(scripts).toEqual(
      expect.arrayContaining([
        "workflow-runtime.mjs",
        "workflow-state.mjs",
        "workflow-guard.mjs",
        "workflow-handoff.mjs",
        "badger-plan.mjs",
        "badger-check.mjs",
        "badger-hook-guard.mjs",
      ]),
    );
    expect(scripts).not.toEqual(
      expect.arrayContaining([
        "comet-plan.mjs",
        "comet-check.mjs",
        "comet-hook-guard.mjs",
      ]),
    );
    const hook = await fs.readFile(
      path.join(generated.packageRoot, "scripts", "badger-hook-guard.mjs"),
      "utf8",
    );
    expect(hook).not.toMatch(/\b(?:Classic|Native)\b/u);
    const lanes = JSON.parse(
      await fs.readFile(
        path.join(generated.packageRoot, "reference", "authoring-lanes.json"),
        "utf8",
      ),
    ) as { controlPlane: { scripts: Array<Record<string, string>> } };
    expect(lanes.controlPlane.scripts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "badger-plan",
          kind: "plan",
          path: "scripts/badger-plan.mjs",
          claim: "script:comet-plan",
        }),
        expect.objectContaining({
          id: "badger-check",
          kind: "check",
          path: "scripts/badger-check.mjs",
          claim: "script:comet-check",
        }),
        expect.objectContaining({
          id: "badger-hook-guard",
          kind: "hook-guard",
          path: "scripts/badger-hook-guard.mjs",
          claim: "script:comet-hook-guard",
        }),
      ]),
    );
    expect(generated.inventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "reference/package-inventory.json",
          owner: "auto",
        }),
      ]),
    );
    await expect(
      loadSkillPackage(generated.packageRoot),
    ).resolves.toMatchObject({
      definition: {
        apiVersion: "badger/v1alpha1",
        metadata: { name: state.name },
        orchestration: { mode: "deterministic" },
      },
    });
    const packageDefinition = await loadSkillPackage(generated.packageRoot);
    expect(packageDefinition.definition.orchestration.steps).toBeUndefined();
  });

  it("reassembles identical inputs into the same package inventory and hash", async () => {
    const { state } = await createScaffold();
    const completed = await runManualAuthoringFixture({ state });
    const first = await assemblePackage(completed);
    const firstHash = first.authoring?.assembledPackageHash;
    const firstInventory = first.generated?.inventory;

    const second = await assemblePackage(first);

    expect(second.authoring?.assembledPackageHash).toBe(firstHash);
    expect(second.generated?.inventory).toEqual(firstInventory);
    expect(firstHash).toBe(await hashDirectory(first.generated!.packageRoot));
  });

  it("runs the assembled Badger plan and completeness scripts", async () => {
    const { state } = await createScaffold();
    await runManualAuthoringFixture({ state });
    const assembled = await assemblePackage(state);
    const packageRoot = assembled.generated!.packageRoot;

    const plan = await execFileAsync(
      process.execPath,
      [path.join(packageRoot, "scripts", "badger-plan.mjs")],
      { cwd: packageRoot },
    );
    expect(JSON.parse(plan.stdout)).toMatchObject({
      kind: "badger-workflow-plan",
      workflow: "prepared-workflow",
    });
    const check = await execFileAsync(
      process.execPath,
      [path.join(packageRoot, "scripts", "badger-check.mjs")],
      { cwd: packageRoot },
    );
    expect(check.stdout).toContain("badger-package-check-ok");
    await execFileAsync(
      process.execPath,
      [path.join(packageRoot, "scripts", "workflow-state.mjs"), "init"],
      { cwd: packageRoot },
    );
    const hook = await execFileAsync(
      process.execPath,
      [
        path.join(packageRoot, "scripts", "badger-hook-guard.mjs"),
        "before_tool",
      ],
      {
        cwd: packageRoot,
        env: { ...process.env, BADGER_RUN_ROOT: packageRoot },
      },
    );
    expect(hook.stdout).toContain("workflow-hook-guard-ok");
  });

  it("rejects Auto-zone drift without changing the package or session", async () => {
    const { state } = await createScaffold();
    await runManualAuthoringFixture({ state });
    const entryPath = path.join(state.generated!.packageRoot, "SKILL.md");
    const beforeSession = await fs.readFile(
      state.authoring!.statePath!,
      "utf8",
    );
    const beforePackage = await fs.readFile(entryPath, "utf8");
    await fs.writeFile(
      entryPath,
      beforePackage.replace(
        "## Runtime Semantics",
        "## Runtime Semantics\n\nUnapproved runtime authority.",
      ),
    );

    await expect(assemblePackage(state)).rejects.toThrow(
      /Auto-zone file changed/iu,
    );

    expect(await fs.readFile(entryPath, "utf8")).not.toBe(beforePackage);
    expect(await fs.readFile(state.authoring!.statePath!, "utf8")).toBe(
      beforeSession,
    );
  });

  it("rejects stale authored artifacts without changing the last package", async () => {
    const { state } = await createScaffold();
    await runManualAuthoringFixture({ state });
    const record = JSON.parse(
      await fs.readFile(
        path.join(state.authoring!.recordsPath, "workflow-entry.json"),
        "utf8",
      ),
    ) as { artifacts: Array<{ contentPath: string }> };
    const artifactPath = record.artifacts[0]!.contentPath;
    const beforeSession = await fs.readFile(
      state.authoring!.statePath!,
      "utf8",
    );
    const beforePackage = await fs.readFile(
      path.join(state.generated!.packageRoot, "SKILL.md"),
      "utf8",
    );
    await fs.appendFile(artifactPath, "\nchanged after acceptance\n");

    await expect(assemblePackage(state)).rejects.toThrow(/stale/iu);

    expect(
      await fs.readFile(
        path.join(state.generated!.packageRoot, "SKILL.md"),
        "utf8",
      ),
    ).toBe(beforePackage);
    expect(await fs.readFile(state.authoring!.statePath!, "utf8")).toBe(
      beforeSession,
    );
  });

  it("rejects undeclared executable commands in authored content", async () => {
    const { state } = await createScaffold();
    await runManualAuthoringFixture({ state });
    const before = await fs.readFile(state.authoring!.statePath!, "utf8");

    await expect(
      recordAuthoring({
        state,
        lane: "workflow-entry",
        record: {
          status: "DONE",
          claims: [
            {
              id: "workflow-entry",
              status: "SUPPORTED",
              evidence: ["entry evidence"],
            },
          ],
          artifacts: [
            {
              id: "SKILL.md",
              path: "SKILL.md",
              present: true,
              content: "Use `rm -rf generated` before continuing.",
            },
          ],
        },
      }),
    ).rejects.toThrow(/undeclared inline command/iu);

    expect(await fs.readFile(state.authoring!.statePath!, "utf8")).toBe(before);
  });

  it("rejects common placeholders while allowing ordinary Node references", async () => {
    const { state } = await createScaffold();
    await runManualAuthoringFixture({ state });

    await expect(
      recordAuthoring({
        state,
        lane: "workflow-entry",
        record: {
          status: "DONE",
          claims: [
            {
              id: "workflow-entry",
              status: "SUPPORTED",
              evidence: ["entry evidence"],
            },
          ],
          artifacts: [
            {
              id: "SKILL.md",
              path: "SKILL.md",
              present: true,
              content:
                "Use the `Node` identified by state. TODO: add recovery guidance.",
            },
          ],
        },
      }),
    ).rejects.toThrow(/placeholder/iu);

    await expect(
      recordAuthoring({
        state,
        lane: "workflow-entry",
        record: {
          status: "DONE",
          claims: [
            {
              id: "workflow-entry",
              status: "SUPPORTED",
              evidence: ["entry evidence"],
            },
          ],
          artifacts: [
            {
              id: "SKILL.md",
              path: "SKILL.md",
              present: true,
              content: [
                "## Decision Core",
                "",
                "### Automatic Node Detection",
                "Read the current Node from persisted state before acting.",
                "",
                "### Resume And Drift",
                "On resume, re-read persisted state instead of trusting conversation history and handle topic changes explicitly.",
                "",
                "### Decision Classification And Decision Points",
                "Classify a genuine user decision, automatic handling, stop condition, or manual handoff before continuing.",
                "",
                "### Red Flags",
                "Do not skip the current Node or treat missing evidence as complete.",
              ].join("\n"),
            },
          ],
        },
      }),
    ).resolves.toMatchObject({ lane: "workflow-entry", status: "DONE" });
  });
});

function completeRecord(
  plan: AuthoringPlan,
  laneId: AuthoringPlan["lanes"][number]["id"],
) {
  const lane = plan.lanes.find((item) => item.id === laneId)!;
  return {
    status: "COMPLETE" as const,
    claims: [...lane.claims, ...lane.derivedClaims].map((id) => ({
      id,
      status: "SUPPORTED" as const,
      evidence: [`evidence:${id}`],
    })),
    artifacts: lane.contentLeaves.map((pathValue) => ({
      id: pathValue,
      path: pathValue,
      present: true,
      content:
        pathValue === "SKILL.md"
          ? "Detect the current Node from persisted state."
          : pathValue.includes("workflow-prepare")
            ? "Load the bound Skill only after the entry check."
            : pathValue.includes("decision-points")
              ? "Pause only for a genuine user decision."
              : pathValue.includes("recovery")
                ? "Resume from persisted authoring state."
                : "The authored review found no blocking concerns.",
    })),
    ...(laneId === "skill-review"
      ? {
          review: {
            decision: "approved" as const,
            reviewer: "authoring-reviewer",
            summary: "All authoring lanes are complete.",
            blockingFindings: [],
            warnings: [],
          },
        }
      : {}),
  };
}
