import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProposal, readPlan } from "../src/factory/proposal.js";
import { generatePackage } from "../src/factory/generate.js";
import { initializeState, writeState } from "../src/factory/state.js";
import {
  authoringReadiness,
  buildAuthoringPlan,
  recordAuthoring,
  validateAuthoringRecord,
  validateAuthoringPlan,
} from "../src/authoring/lifecycle.js";
import type {
  AuthoringPlan,
  FactoryPlan,
  WorkflowProtocol,
} from "../src/types.js";

const protocol: WorkflowProtocol = {
  schemaVersion: 1,
  kind: "workflow-kernel",
  name: "primer-workflow",
  goal: "Create primers.",
  nodes: [
    {
      id: "design",
      label: "Design",
      kind: "action",
      responsibility: "Design candidate primers.",
      implementation: {
        skill: "primer-design",
        operation: "default",
        scope: "main",
        enforcement: "guarded",
      },
      requiredSkillCalls: [],
      augmentations: [],
      satisfies: [],
      disabled: false,
      operations: ["require", "augment", "disable"],
      outputSchemas: [],
      guardrails: [],
    },
  ],
  edges: [],
  outputSchemas: [],
  state: {
    kind: "workflow-run",
    statePath: ".comet/runs/primer-workflow/state.json",
    currentNodeField: "currentNode",
    completedNodesField: "completedNodes",
    evidenceField: "evidence",
  },
  evals: [
    {
      id: "workflow-route-conformance",
      expectedNodeOrder: ["design"],
      requiredOutputSchemas: [],
    },
  ],
};

describe("authoring lifecycle", () => {
  let project: string;
  let planPath: string;

  beforeEach(async () => {
    project = await fs.mkdtemp(path.join(os.tmpdir(), "comet-authoring-test-"));
    const skillRoot = path.join(project, ".agents", "skills", "primer-design");
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.writeFile(
      path.join(skillRoot, "SKILL.md"),
      "---\nname: primer-design\ndescription: Primer design.\n---\n\n# Primer Design\n",
    );
    const plan: FactoryPlan = {
      schemaVersion: 1,
      goal: "Create a primer workflow.",
      skillCreatorIntent: "new-skill",
      preferredSkills: ["primer-design"],
      defaultLocale: "en",
      workflow: {
        kind: "workflow-kernel",
        name: "primer-workflow",
        goal: "Create primers.",
        customNodes: [
          {
            id: "design",
            label: "Design",
            kind: "action",
            responsibility: "Design candidate primers.",
            implementation: {
              skill: "primer-design",
              operation: "default",
              scope: "main",
            },
            operations: ["require", "augment", "disable"],
            outputSchemas: ["design.v1"],
            guardrails: [],
          },
        ],
        outputSchemas: [
          {
            id: "design.v1",
            description: "Design output.",
            artifacts: [],
            evidence: [{ id: "summary", required: true }],
          },
        ],
      },
    };
    planPath = path.join(project, "plan.json");
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2));
  });

  afterEach(async () => fs.rm(project, { recursive: true, force: true }));

  it("builds the canonical authoring-lane DAG and rejects unknown lanes", () => {
    const plan = buildAuthoringPlan(protocol, "primer-workflow");

    expect(plan.lanes.map((lane) => lane.lane)).toEqual([
      "script",
      "reference",
      "pause-points",
      "workflow-entry",
      "skill-core",
      "skill-review",
    ]);
    expect(
      plan.lanes.find((lane) => lane.lane === "pause-points")?.dependsOn,
    ).toEqual(["reference"]);
    expect(
      plan.lanes.find((lane) => lane.lane === "workflow-entry")?.dependsOn,
    ).toEqual(["pause-points", "script"]);
    expect(
      plan.lanes.find((lane) => lane.lane === "skill-review")?.dependsOn,
    ).toEqual([
      "script",
      "reference",
      "pause-points",
      "workflow-entry",
      "skill-core",
    ]);
    expect(validateAuthoringPlan(plan)).toEqual([]);
    expect(
      validateAuthoringPlan({
        ...plan,
        lanes: [...plan.lanes, { ...plan.lanes[0], lane: "unknown" }],
      }),
    ).toContain("unknown authoring lane: unknown");
  });

  it("blocks scaffold content and stops when a lane needs context", async () => {
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
    state.status = "generated";
    await writeState(state);

    const generatedPlan = JSON.parse(
      await fs.readFile(generated.authoringPlanPath!, "utf8"),
    ) as AuthoringPlan;
    const initialReadiness = await authoringReadiness(state);
    expect(initialReadiness.state).toBe("blocked");
    expect(initialReadiness.blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining("scaffold"),
        expect.stringContaining("missing authoring record"),
      ]),
    );

    const workflowEntry = recordInput(generatedPlan, "workflow-entry");
    await expect(
      recordAuthoring({ state, lane: "workflow-entry", record: workflowEntry }),
    ).rejects.toThrow(/dependency|blocked/iu);

    const scriptRecord = await recordAuthoring({
      state,
      lane: "script",
      record: recordInput(generatedPlan, "script"),
    });
    expect(scriptRecord.status).toBe("COMPLETE");

    const contextRecord = await recordAuthoring({
      state,
      lane: "reference",
      record: recordInput(generatedPlan, "reference", "NEEDS_CONTEXT"),
    });
    expect(contextRecord.status).toBe("NEEDS_CONTEXT");
    expect((await authoringReadiness(state)).state).toBe("needs-context");

    const blockedRecord = await recordAuthoring({
      state,
      lane: "script",
      record: recordInput(generatedPlan, "script", "BLOCKED"),
    });
    expect(blockedRecord.status).toBe("BLOCKED");
    expect((await authoringReadiness(state)).state).toBe("blocked");
  });

  it("rejects unknown claims, missing artifacts, and blocking review output", async () => {
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
    state.status = "generated";
    await writeState(state);
    const generatedPlan = JSON.parse(
      await fs.readFile(generated.authoringPlanPath!, "utf8"),
    ) as AuthoringPlan;

    const unknownClaim = recordInput(generatedPlan, "script") as {
      claims: Array<{ id: string; status: string; evidence: string[] }>;
    };
    unknownClaim.claims.push({
      id: "not-in-plan",
      status: "SUPPORTED",
      evidence: ["untrusted"],
    });
    await expect(
      recordAuthoring({ state, lane: "script", record: unknownClaim }),
    ).rejects.toThrow(/unknown authoring claim/iu);

    await fs.rm(
      path.join(state.draftPath, "skills", "primer-workflow", "scripts"),
      {
        recursive: true,
      },
    );
    await expect(
      recordAuthoring({
        state,
        lane: "script",
        record: recordInput(generatedPlan, "script"),
      }),
    ).rejects.toThrow(/presence changed/iu);

    const reviewInput = recordInput(generatedPlan, "skill-review") as Record<
      string,
      unknown
    >;
    reviewInput.review = {
      decision: "approved",
      reviewer: "reviewer",
      summary: "Looks good.",
      blockingFindings: ["The entry is incomplete."],
      warnings: [],
    };
    const findings = validateAuthoringRecord(
      {
        schemaVersion: 1,
        kind: "authoring-record",
        workflow: generatedPlan.workflow,
        lane: "skill-review",
        protocolHash: generatedPlan.protocolHash,
        bundleHash: "bundle-hash",
        at: new Date().toISOString(),
        ...reviewInput,
      },
      generatedPlan,
      "skill-review",
    );
    expect(findings).toContain(
      "approved review output cannot contain blocking findings",
    );
  });
});

function recordInput(
  plan: AuthoringPlan,
  lane: AuthoringPlan["lanes"][number]["lane"],
  status: "COMPLETE" | "BLOCKED" | "NEEDS_CONTEXT" = "COMPLETE",
) {
  const definition = plan.lanes.find((item) => item.lane === lane)!;
  return {
    status,
    claims: definition.claims.map((claim) => ({
      id: claim.id,
      status: status === "COMPLETE" ? "SUPPORTED" : "NEEDS_CONTEXT",
      evidence: status === "COMPLETE" ? [`evidence:${claim.id}`] : [],
    })),
    artifacts: definition.artifacts.map((artifact) => ({
      id: artifact.id,
      path: artifact.path,
      present: true,
    })),
    ...(status !== "COMPLETE"
      ? { summary: `Additional context is required for ${lane}.` }
      : {}),
    ...(lane === "skill-review" && status === "COMPLETE"
      ? {
          review: {
            decision: "approved",
            reviewer: "authoring-reviewer",
            summary: "All authoring lanes are complete.",
            blockingFindings: [],
            warnings: [],
          },
        }
      : {}),
  };
}
