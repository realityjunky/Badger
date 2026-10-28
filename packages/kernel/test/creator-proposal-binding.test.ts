import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProposal } from "../src/factory/proposal.js";
import { initializeState, readState } from "../src/factory/state.js";
import { creatorStateHash } from "../src/workflow-kernel/foundation.js";
import type { FactoryPlan } from "../src/types.js";

describe("Creator proposal binding", () => {
  let project: string;
  let skillRoot: string;
  let planPath: string;

  beforeEach(async () => {
    project = await fs.mkdtemp(path.join(os.tmpdir(), "badger-binding-"));
    skillRoot = path.join(project, ".agents", "skills", "primer-design");
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.writeFile(
      path.join(skillRoot, "SKILL.md"),
      "---\nname: primer-design\ndescription: Primer design.\n---\n\n# Primer Design\n",
    );
    planPath = path.join(project, "plan.json");
    await fs.writeFile(planPath, JSON.stringify(planFixture(), null, 2));
  });

  afterEach(async () => fs.rm(project, { recursive: true, force: true }));

  function planFixture(): FactoryPlan {
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
            artifacts: [],
            evidence: [{ id: "summary", required: true }],
          },
        ],
      },
    };
  }

  it("hashes the plan and proposal over canonical JSON", async () => {
    const proposal = await buildProposal({ projectRoot: project, planPath });
    expect(proposal.planHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(proposal.proposalHash).toMatch(/^[a-f0-9]{64}$/u);

    const plan = planFixture();
    const reordered = {
      workflow: plan.workflow,
      skillSources: plan.skillSources,
      goal: plan.goal,
      schemaVersion: plan.schemaVersion,
      defaultLocale: plan.defaultLocale,
      skillCreatorIntent: plan.skillCreatorIntent,
    };
    await fs.writeFile(planPath, JSON.stringify(reordered, null, 4));

    const again = await buildProposal({ projectRoot: project, planPath });
    expect(again.planHash).toBe(proposal.planHash);
    expect(again.proposalHash).toBe(proposal.proposalHash);

    await fs.writeFile(
      planPath,
      JSON.stringify({ ...reordered, goal: "Changed goal." }, null, 4),
    );
    const changed = await buildProposal({ projectRoot: project, planPath });
    expect(changed.planHash).not.toBe(proposal.planHash);
    expect(changed.proposalHash).not.toBe(proposal.proposalHash);
  });

  it("keeps plan and proposal identities stable when the project moves", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "badger-move-"));
    try {
      const original = path.join(parent, "original");
      await fs.mkdir(path.join(original, ".agents", "skills"), {
        recursive: true,
      });
      await fs.cp(
        skillRoot,
        path.join(original, ".agents", "skills", "primer-design"),
        {
          recursive: true,
        },
      );
      const portablePlan = {
        ...planFixture(),
        skillSources: [
          { name: "primer-design", location: ".agents/skills/primer-design" },
        ],
      };
      const portablePath = path.join(original, "plan.json");
      await fs.writeFile(portablePath, JSON.stringify(portablePlan, null, 2));
      const before = await buildProposal({
        projectRoot: original,
        planPath: portablePath,
      });

      const moved = path.join(parent, "moved");
      await fs.rename(original, moved);
      const after = await buildProposal({
        projectRoot: moved,
        planPath: path.join(moved, "plan.json"),
      });

      expect(after.planHash).toBe(before.planHash);
      expect(after.proposalHash).toBe(before.proposalHash);
      expect(after.candidates[0]!.sources[0]!.root).not.toBe(
        before.candidates[0]!.sources[0]!.root,
      );
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("refuses initialization from a proposal hash the current plan no longer produces", async () => {
    const approved = await buildProposal({ projectRoot: project, planPath });
    await fs.writeFile(
      planPath,
      JSON.stringify(
        { ...planFixture(), goal: "Edited after review." },
        null,
        2,
      ),
    );

    await expect(
      initializeState({
        projectRoot: project,
        planPath,
        proposalHash: approved.proposalHash,
        confirmed: true,
      }),
    ).rejects.toThrow(/stale|changed since/iu);
    await expect(
      fs.stat(path.join(project, ".badger", "states", "primer-workflow.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses initialization when declared Skill source evidence changed", async () => {
    const approved = await buildProposal({ projectRoot: project, planPath });
    await fs.appendFile(
      path.join(skillRoot, "SKILL.md"),
      "\nChanged after approval.\n",
    );

    await expect(
      initializeState({
        projectRoot: project,
        planPath,
        proposalHash: approved.proposalHash,
        confirmed: true,
      }),
    ).rejects.toThrow(/source evidence|stale|changed since/iu);
  });

  it("initializes from the approved proposal hash and reports the state hash", async () => {
    const approved = await buildProposal({ projectRoot: project, planPath });
    const state = await initializeState({
      projectRoot: project,
      planPath,
      proposalHash: approved.proposalHash,
      confirmed: true,
    });

    expect(state.planHash).toBe(approved.planHash);
    expect(state.confirmedProposal).toEqual(approved);
    expect(creatorStateHash(state)).toMatch(/^[a-f0-9]{64}$/u);
    expect(creatorStateHash(await readState(project, "primer-workflow"))).toBe(
      creatorStateHash(state),
    );
  });

  it("refuses to replace existing Creator state without the current state hash", async () => {
    const approved = await buildProposal({ projectRoot: project, planPath });
    const first = await initializeState({
      projectRoot: project,
      planPath,
      proposalHash: approved.proposalHash,
      confirmed: true,
    });
    const currentHash = creatorStateHash(first);

    await expect(
      initializeState({
        projectRoot: project,
        planPath,
        proposalHash: approved.proposalHash,
        confirmed: true,
      }),
    ).rejects.toThrow(new RegExp(currentHash, "u"));
    await expect(
      initializeState({
        projectRoot: project,
        planPath,
        proposalHash: approved.proposalHash,
        replaceStateHash: "0".repeat(64),
        confirmed: true,
      }),
    ).rejects.toThrow(/state hash/iu);

    const replaced = await initializeState({
      projectRoot: project,
      planPath,
      proposalHash: approved.proposalHash,
      replaceStateHash: currentHash,
      confirmed: true,
    });
    expect(creatorStateHash(replaced)).toBe(currentHash);
  });
});
