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
            artifacts: [
              {
                id: "result",
                kind: "file",
                required: true,
                paths: ["design.txt"],
                validations: ["artifact-exists"],
              },
            ],
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
    expect(report.runtime).toMatchObject({
      authority: "WorkflowRuntime",
      generatedPackageHash: report.hash,
      identity: {
        protocolHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        packageHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        nodeToStep: { design: "node-1-design" },
      },
      declaredNodeOrder: ["design"],
      compiledNodeOrder: ["design"],
      observedNodeOrder: ["design"],
      runId: expect.stringMatching(/^certification-[a-f0-9]{16}$/u),
      reverseRunId: expect.stringMatching(
        /^certification-[a-f0-9]{16}-reverse$/u,
      ),
      recoveryCount: 3,
      recovered: true,
      completed: true,
      identityConsistent: true,
      guardVerified: true,
      handoffConsistent: true,
      entryAdapterStarted: true,
      compatibilityAdapterResumed: true,
      freshProcessRecovered: true,
      publicRuntimeCompleted: true,
      reverseAdapterCompleted: true,
    });
    expect(report.runtime?.phase3).toMatchObject({
      status: "certified",
      generatedPackageHash: report.hash,
      evaluatedPackageHash: report.hash,
      fixturePackageHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      identity: {
        capabilityVersion: 3,
        resolverHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    expect((await readState(project, initial.name)).eval?.runtime).toEqual(
      report.runtime,
    );
    const missingPhase3 = structuredClone(
      await readState(project, initial.name),
    );
    delete missingPhase3.eval!.runtime!.phase3;
    expect(reviewState(missingPhase3).blockers).toContain(
      "WorkflowRuntime Phase 3 certification evidence is missing",
    );
    const malformedPhase3 = structuredClone(
      await readState(project, initial.name),
    );
    malformedPhase3.eval!.runtime!.phase3 = {} as NonNullable<
      typeof malformedPhase3.eval.runtime.phase3
    >;
    expect(reviewState(malformedPhase3).blockers).toContain(
      "WorkflowRuntime Phase 3 certification evidence is invalid",
    );
    const stalePhase3 = structuredClone(await readState(project, initial.name));
    stalePhase3.eval!.runtime!.phase3!.generatedPackageHash = "0".repeat(64);
    expect(reviewState(stalePhase3).blockers).toContain(
      "WorkflowRuntime Phase 3 evidence is stale for the generated package",
    );
    const stale = structuredClone(await readState(project, initial.name));
    stale.eval!.runtime!.identity.packageHash = "0".repeat(64);
    expect(reviewState(stale).blockers).toContain(
      "WorkflowRuntime package and snapshot identities differ",
    );
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
  }, 15_000);

  it("resolves shared Skill roots and isolates generated artifacts", async () => {
    const sharedRoot = path.join(project, "shared-skills");
    const sharedSkill = path.join(sharedRoot, "genome-download");
    await fs.mkdir(sharedSkill, { recursive: true });
    await fs.writeFile(
      path.join(sharedSkill, "SKILL.md"),
      "---\nname: genome-download\ndescription: Genome download.\n---\n",
    );
    const plan = await readPlan(planPath);
    plan.preferredSkills = ["genome-download"];
    plan.skillRoots = ["shared-skills"];
    plan.artifactRoot = "generated";
    plan.workflow.customNodes[0].implementation.skill = "genome-download";
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2));

    const proposal = await buildProposal({ projectRoot: project, planPath });
    expect(proposal.canInitialize).toBe(true);
    expect(proposal.candidates[0].sources[0].root).toBe(sharedSkill);
    const state = await initializeState({
      projectRoot: project,
      planPath,
      plan,
      proposal,
      confirmed: true,
    });
    expect(state.draftPath).toBe(
      path.join(project, "generated", "primer-workflow"),
    );
  });
});
