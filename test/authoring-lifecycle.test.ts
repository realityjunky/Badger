import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProposal, readPlan } from "../src/factory/proposal.js";
import {
  generatePackage,
  type GeneratedPackage,
} from "../src/factory/generate.js";
import { initializeState } from "../src/factory/state.js";
import { evaluatePackage } from "../src/eval/run.js";
import {
  assemblePackage,
  authoringReadiness,
  initializeAuthoringSession,
  recordAuthoring,
} from "../src/authoring/index.js";
import { deriveAuthoringPlan } from "../src/authoring/plan.js";
import type { AuthoringPlan } from "../src/authoring/types.js";
import type { CreatorState, FactoryPlan } from "../src/types.js";

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
      preferredSkills: ["prepare"],
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

  async function createScaffold(): Promise<{
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
    });
    state.generated = generated;
    const authoringPlan = deriveAuthoringPlan({ proposal });
    await initializeAuthoringSession({
      state,
      plan: authoringPlan,
      generated,
    });
    return { state, plan, generated, authoringPlan };
  }

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
    const plan = authoringPlan;
    for (const lane of plan.lanes.map((item) => item.id)) {
      await recordAuthoring({
        state,
        lane,
        record: completeRecord(plan, lane),
      });
    }

    expect((await authoringReadiness(state)).state).toBe("ready");
    const assembled = await assemblePackage(state);
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
    expect(entry).toContain("Detect the current Node from persisted state.");
    expect(node).toContain("Load the bound Skill only after the entry check.");
    expect(entry).not.toContain("AUTHORING PENDING");
    expect(node).not.toContain("AUTHORING PENDING");
    expect(assembled.authoring?.status).toBe("assembled");
    expect(assembled.authoring?.assembledPackageHash).toMatch(
      /^[a-f0-9]{64}$/u,
    );
  });

  it("preserves upgrade sources and rejects destinations inside them", async () => {
    const source = path.join(project, "legacy-skill");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "legacy skill\n");
    await fs.writeFile(path.join(source, "legacy-notes.md"), "retain me\n");
    const plan = await readPlan(planPath);
    plan.skillCreatorIntent = "upgrade-existing";
    plan.sourceRoot = source;
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
    ).resolves.toBe("legacy skill\n");
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
