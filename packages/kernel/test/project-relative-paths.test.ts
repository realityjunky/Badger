import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProposal, readPlan } from "../src/factory/proposal.js";
import { generatePackage } from "../src/factory/generate.js";
import {
  initializeState,
  readState,
  writeState,
} from "../src/factory/state.js";
import { readCreatorGuide } from "../src/factory/guide.js";
import { evaluatePackage } from "../src/eval/run.js";
import {
  assemblePackage as assemblePackageImplementation,
  authoringReadiness,
  initializeAuthoringSession,
  runManualAuthoringFixture,
} from "../src/authoring/index.js";
import { deriveAuthoringPlan } from "../src/authoring/plan.js";
import {
  approveReview,
  publishState as publishStateImplementation,
  reviewState,
} from "../src/publish/lifecycle.js";
import type { CreatorState, FactoryPlan } from "../src/types.js";

const publishState = (
  state: Parameters<typeof publishStateImplementation>[0],
) => publishStateImplementation(state, true);

function planFor(skillRoot: string): FactoryPlan {
  return {
    schemaVersion: 1,
    goal: "Create a primer workflow.",
    skillCreatorIntent: "new-skill",
    skillSources: [{ name: "primer-design", location: skillRoot }],
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
}

describe("project-relative Creator records", () => {
  let root: string;
  let project: string;
  let skillRoot: string;
  let planPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-relative-paths-"));
    project = path.join(root, "project");
    skillRoot = path.join(project, ".agents", "skills", "primer-design");
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.writeFile(
      path.join(skillRoot, "SKILL.md"),
      "---\nname: primer-design\ndescription: Primer design.\n---\n\n# Primer Design\n",
    );
    planPath = path.join(project, "plan.json");
    await fs.writeFile(planPath, JSON.stringify(planFor(skillRoot), null, 2));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function runLifecycle(): Promise<CreatorState> {
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
    await initializeAuthoringSession({
      state,
      plan: deriveAuthoringPlan({ proposal }),
      generated,
    });
    Object.assign(
      state,
      await assemblePackageImplementation(
        await runManualAuthoringFixture({ state }),
        true,
      ),
    );
    const report = await evaluatePackage(state);
    expect(report.passed).toBe(true);
    const approved = await approveReview({
      state: await readState(project, state.name),
      reviewer: "test-reviewer",
      approve: true,
    });
    return publishState(approved);
  }

  async function storedState(name: string): Promise<Record<string, unknown>> {
    return JSON.parse(
      await fs.readFile(
        path.join(project, ".badger", "states", `${name}.json`),
        "utf8",
      ),
    ) as Record<string, unknown>;
  }

  it("stores Creator state, authoring session, eval, and publication paths project-relative", async () => {
    const state = await runLifecycle();
    const stored = await storedState(state.name);
    expect(stored.projectRoot).toBe(".");
    expect(stored.planPath).toBe("plan.json");
    expect(stored.draftPath).toBe(".badger/drafts/primer-workflow");
    expect(stored.generated).toMatchObject({
      packageRoot: ".badger/drafts/primer-workflow",
      protocolPath:
        ".badger/drafts/primer-workflow/reference/workflow-protocol.json",
      evalPath: ".badger/drafts/primer-workflow/badger/eval.yaml",
    });
    expect(stored.eval).toMatchObject({
      resultPath: ".badger/eval/primer-workflow.json",
    });
    expect(stored.published).toMatchObject({
      path: ".badger/published/primer-workflow",
    });
    expect(stored.authoring).toMatchObject({
      sessionPath: ".badger/authoring/primer-workflow",
      statePath: ".badger/authoring/primer-workflow/state.json",
      planPath: ".badger/authoring/primer-workflow/plan.json",
      recordsPath: ".badger/authoring/primer-workflow/records",
    });

    const summary = JSON.parse(
      await fs.readFile(
        path.join(project, ".badger", "authoring", state.name, "state.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(summary.sessionPath).toBe(".badger/authoring/primer-workflow");
    expect(summary.recordsPath).toBe(
      ".badger/authoring/primer-workflow/records",
    );
    expect(JSON.stringify(summary)).not.toContain(project);
  }, 30_000);

  it("refuses stored paths that escape the project", async () => {
    const state = await runLifecycle();
    await expect(
      writeState({ ...state, draftPath: path.join(root, "escaped") }),
    ).rejects.toThrow(/escapes the project root/iu);
    await expect(
      writeState({ ...state, planPath: "../plan.json" }),
    ).rejects.toThrow(/escapes the project root/iu);

    const stateFile = path.join(
      project,
      ".badger",
      "states",
      `${state.name}.json`,
    );
    const document = JSON.parse(await fs.readFile(stateFile, "utf8")) as Record<
      string,
      unknown
    >;
    await fs.writeFile(
      stateFile,
      JSON.stringify({ ...document, draftPath: "../escaped" }, null, 2) + "\n",
    );
    await expect(readState(project, state.name)).rejects.toThrow(
      /escapes the project root/iu,
    );
    await fs.writeFile(
      stateFile,
      JSON.stringify(
        {
          ...document,
          generated: {
            ...(document.generated as object),
            packageRoot: "../escaped",
          },
        },
        null,
        2,
      ) + "\n",
    );
    await expect(readState(project, state.name)).rejects.toThrow(
      /escapes the project root/iu,
    );
  }, 30_000);

  it("keeps a declared Skill source that lives outside the project absolute", async () => {
    const external = path.join(root, "external-skills", "primer-design");
    await fs.mkdir(external, { recursive: true });
    await fs.writeFile(
      path.join(external, "SKILL.md"),
      "---\nname: primer-design\ndescription: Primer design.\n---\n\n# Primer Design\n",
    );
    const plan = { ...planFor(skillRoot) };
    plan.skillSources = [{ name: "primer-design", location: external }];
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2));

    const proposal = await buildProposal({ projectRoot: project, planPath });
    expect(proposal.canInitialize).toBe(true);
    const state = await initializeState({
      projectRoot: project,
      planPath,
      plan: await readPlan(planPath),
      proposal,
      confirmed: true,
    });

    const stored = JSON.parse(
      await fs.readFile(
        path.join(project, ".badger", "states", `${state.name}.json`),
        "utf8",
      ),
    ) as {
      candidates: Array<{ sources: Array<{ root: string }> }>;
    };
    expect(stored.candidates[0]!.sources[0]!.root).toBe(external);
    const read = await readState(project, state.name);
    expect(read.candidates[0]!.sources[0]!.root).toBe(external);
  });

  it("passes guide, authoring status, eval, and review after the project moves", async () => {
    const state = await runLifecycle();
    const moved = path.join(root, "moved-project");
    await fs.rename(project, moved);

    const guide = await readCreatorGuide({ projectRoot: moved });
    expect(guide.firstUse).toBe(false);
    expect(guide.resumable).toEqual([
      expect.objectContaining({
        name: state.name,
        classification: "authoring-required",
        factoryPlan: expect.objectContaining({
          status: "available",
          hashMatchesState: true,
        }),
      }),
    ]);

    const movedState = await readState(moved, state.name);
    expect(movedState.projectRoot).toBe(moved);
    expect(movedState.generated?.packageRoot).toBe(
      path.join(moved, ".badger", "drafts", state.name),
    );

    const readiness = await authoringReadiness(movedState);
    expect(readiness.state).toBe("ready");
    expect(readiness.status).toBe("assembled");

    const report = await evaluatePackage(movedState);
    expect(report.passed).toBe(true);

    const reviewed = reviewState(await readState(moved, state.name));
    expect(reviewed.blockers).toEqual([]);
    expect(reviewed.state).toBe("publishable");

    const republished = await publishState(await readState(moved, state.name));
    expect(republished.published?.path).toBe(
      path.join(moved, ".badger", "published", state.name),
    );
  }, 60_000);
});
