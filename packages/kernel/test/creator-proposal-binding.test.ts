import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateFromApprovedProposal } from "../src/factory/approved-generation.js";
import {
  buildProposal,
  planHashMatches,
  readPlan,
} from "../src/factory/proposal.js";
import {
  creatorStateHash,
  initializeState,
  readState,
  verifyApprovedProposal,
} from "../src/factory/state.js";
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
    const stateHash = await creatorStateHash(project, "primer-workflow");
    expect(stateHash).toMatch(/^[a-f0-9]{64}$/u);
    await readState(project, "primer-workflow");
    expect(await creatorStateHash(project, "primer-workflow")).toBe(stateHash);
    expect(await creatorStateHash(project, "other-workflow")).toBeNull();
  });

  it("refuses to replace existing Creator state without the current state hash", async () => {
    const approved = await buildProposal({ projectRoot: project, planPath });
    await initializeState({
      projectRoot: project,
      planPath,
      proposalHash: approved.proposalHash,
      confirmed: true,
    });
    const currentHash = (await creatorStateHash(project, "primer-workflow"))!;

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

    await initializeState({
      projectRoot: project,
      planPath,
      proposalHash: approved.proposalHash,
      replaceStateHash: currentHash,
      confirmed: true,
    });
    expect(await creatorStateHash(project, "primer-workflow")).toBe(
      currentHash,
    );
  });

  it("refuses a pasted value that is not a hash", async () => {
    const approved = await buildProposal({ projectRoot: project, planPath });
    await expect(
      initializeState({
        projectRoot: project,
        planPath,
        proposalHash: "proposalHash: abc",
        confirmed: true,
      }),
    ).rejects.toThrow(/Not a proposal hash/u);
    await expect(
      initializeState({
        projectRoot: project,
        planPath,
        proposalHash: approved.proposalHash,
        replaceStateHash: "abc",
        confirmed: true,
      }),
    ).rejects.toThrow(/Not a Creator state hash/u);
    await expect(
      fs.stat(path.join(project, ".badger", "states", "primer-workflow.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lets exactly one of two concurrent initializations create the state", async () => {
    const approved = await buildProposal({ projectRoot: project, planPath });
    const attempts = await Promise.allSettled(
      [0, 1].map(() =>
        initializeState({
          projectRoot: project,
          planPath,
          proposalHash: approved.proposalHash,
          confirmed: true,
        }),
      ),
    );
    expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    const refused = attempts.find((item) => item.status === "rejected");
    expect(String((refused as PromiseRejectedResult).reason)).toMatch(
      /Existing Creator state/u,
    );
  });

  it("replaces a state file that no longer parses only by quoting its hash", async () => {
    const approved = await buildProposal({ projectRoot: project, planPath });
    const statePath = path.join(
      project,
      ".badger",
      "states",
      "primer-workflow.json",
    );
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, "{ not json");

    await expect(readState(project, "primer-workflow")).rejects.toThrow(
      /not valid JSON/u,
    );
    const refusal = await initializeState({
      projectRoot: project,
      planPath,
      proposalHash: approved.proposalHash,
      confirmed: true,
    }).catch((error: Error) => error);
    expect(String(refusal)).toMatch(/is not valid JSON and has hash/u);
    const garbledHash = (await creatorStateHash(project, "primer-workflow"))!;
    expect(String(refusal)).toContain(garbledHash);

    await initializeState({
      projectRoot: project,
      planPath,
      proposalHash: approved.proposalHash,
      replaceStateHash: garbledHash,
      confirmed: true,
    });
    await expect(readState(project, "primer-workflow")).resolves.toMatchObject({
      planHash: approved.planHash,
    });
  });

  it("verifies the approved proposal and returns the rebuilt proposal with the plan it read", async () => {
    const approved = await buildProposal({ projectRoot: project, planPath });
    const state = await initializeState({
      projectRoot: project,
      planPath,
      proposalHash: approved.proposalHash,
      confirmed: true,
    });

    const verified = await verifyApprovedProposal(state);
    expect(verified.proposal.proposalHash).toBe(approved.proposalHash);
    expect(verified.plan).toEqual(await readPlan(planPath));
  });

  it("generates through the kernel only after confirmation and from an untampered approved proposal", async () => {
    const approved = await buildProposal({ projectRoot: project, planPath });
    const state = await initializeState({
      projectRoot: project,
      planPath,
      proposalHash: approved.proposalHash,
      confirmed: true,
    });
    const statePath = path.join(
      project,
      ".badger",
      "states",
      "primer-workflow.json",
    );
    const stored = await fs.readFile(statePath, "utf8");

    await expect(
      generateFromApprovedProposal({
        projectRoot: project,
        name: "primer-workflow",
        confirmed: false,
      }),
    ).rejects.toThrow(/explicit confirmation/u);

    const tampered = JSON.parse(stored) as {
      confirmedProposal: { goal: string };
    };
    tampered.confirmedProposal.goal = "TAMPERED";
    await fs.writeFile(statePath, JSON.stringify(tampered, null, 2) + "\n");
    await expect(
      generateFromApprovedProposal({
        projectRoot: project,
        name: "primer-workflow",
        confirmed: true,
      }),
    ).rejects.toThrow(/does not match its proposal hash/u);
    await expect(
      fs.stat(path.join(state.draftPath, "SKILL.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await fs.writeFile(statePath, stored);
    await fs.writeFile(
      planPath,
      JSON.stringify({ ...planFixture(), goal: "Edited after init." }, null, 2),
    );
    await expect(
      generateFromApprovedProposal({
        projectRoot: project,
        name: "primer-workflow",
        confirmed: true,
      }),
    ).rejects.toThrow(/plan changed/u);

    await fs.writeFile(planPath, JSON.stringify(planFixture(), null, 2));
    const generated = await generateFromApprovedProposal({
      projectRoot: project,
      name: "primer-workflow",
      confirmed: true,
    });
    expect(generated.proposal.proposalHash).toBe(approved.proposalHash);
    expect(generated.state.status).toBe("generated");
    await expect(
      fs.readFile(path.join(state.draftPath, "SKILL.md"), "utf8"),
    ).resolves.not.toContain("TAMPERED");
  });

  it("honors plan hashes recorded before they became canonical", async () => {
    const plan = await readPlan(planPath);
    const legacy = createHash("sha256")
      .update(JSON.stringify(plan))
      .digest("hex");
    const proposal = await buildProposal({ projectRoot: project, planPath });

    expect(planHashMatches(plan, legacy)).toBe(true);
    expect(planHashMatches(plan, proposal.planHash)).toBe(true);
    expect(planHashMatches({ ...plan, goal: "Changed." }, legacy)).toBe(false);
    const reordered = Object.fromEntries(Object.entries(plan).reverse());
    expect(planHashMatches(reordered, proposal.planHash)).toBe(true);
    expect(planHashMatches(reordered, legacy)).toBe(false);
  });
});
