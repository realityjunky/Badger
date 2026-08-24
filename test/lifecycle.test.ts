import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProposal, readPlan } from "../src/factory/proposal.js";
import { generatePackage } from "../src/factory/generate.js";
import { initializeState, readState } from "../src/factory/state.js";
import { evaluatePackage } from "../src/eval/run.js";
import {
  approveReview,
  distributePreview,
  publishState,
  reviewState,
} from "../src/publish/lifecycle.js";
import type { FactoryPlan } from "../src/types.js";

describe("standalone Creator lifecycle", () => {
  let project: string;
  let skillRoot: string;
  let planPath: string;

  beforeEach(async () => {
    project = await fs.mkdtemp(path.join(os.tmpdir(), "comet-any-lifecycle-"));
    skillRoot = path.join(project, ".agents", "skills", "primer-design");
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

  it("requires confirmation, then binds eval/review/publish to one hash", async () => {
    const proposal = await buildProposal({ projectRoot: project, planPath });
    expect(proposal.canInitialize).toBe(true);
    const plan = await readPlan(planPath);
    await expect(
      initializeState({
        projectRoot: project,
        planPath,
        plan,
        proposal,
        confirmed: false,
      }),
    ).rejects.toThrow("confirmation");
    const initial = await initializeState({
      projectRoot: project,
      planPath,
      plan,
      proposal,
      confirmed: true,
    });
    const generated = await generatePackage({
      proposal,
      plan,
      destination: initial.draftPath,
    });
    initial.generated = generated;
    const report = await evaluatePackage(initial);
    expect(report.passed).toBe(true);
    expect(reviewState(await readState(project, initial.name)).state).toBe(
      "reviewable",
    );
    const approved = await approveReview({
      state: await readState(project, initial.name),
      reviewer: "test-reviewer",
      approve: true,
    });
    expect(reviewState(approved).state).toBe("publishable");
    const published = await publishState(approved);
    expect(published.status).toBe("published");
    const preview = await distributePreview(
      published,
      path.join(project, "install-preview"),
    );
    expect(preview.preview).toBe(true);
    expect(preview.files).toContain(
      path.join(project, "install-preview", "SKILL.md"),
    );
  });
});
