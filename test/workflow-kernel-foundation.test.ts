import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProposal } from "../src/factory/proposal.js";
import {
  createStandaloneWorkflowKernel,
  createWorkflowKernel,
} from "../src/workflow-kernel/foundation.js";
import {
  hashDirectory,
  hashDirectorySync,
} from "../src/workflow-kernel/hash.js";
import type { FactoryPlan } from "../src/types.js";

describe("workflow-kernel foundation", () => {
  let root: string;
  let project: string;
  let home: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-kernel-foundation-"),
    );
    project = path.join(root, "project");
    home = path.join(root, "home");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(home, { recursive: true });
  });

  afterEach(async () => fs.rm(root, { recursive: true, force: true }));

  async function writeSkill(
    name: string,
    directory = path.join(project, ".agents", "skills", name),
  ): Promise<string> {
    await fs.mkdir(path.join(directory, "references"), { recursive: true });
    await fs.writeFile(
      path.join(directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} skill.\n---\n\n# ${name}\n`,
    );
    await fs.writeFile(
      path.join(directory, "references", "source.md"),
      "source evidence\n",
    );
    return directory;
  }

  function planFor(skill: string): FactoryPlan {
    return {
      schemaVersion: 1,
      goal: `Create a ${skill} workflow.`,
      skillCreatorIntent: "new-skill",
      preferredSkills: [skill],
      defaultLocale: "en",
      workflow: {
        kind: "workflow-kernel",
        name: `${skill}-workflow`,
        goal: `Run ${skill}.`,
        customNodes: [
          {
            id: "run",
            label: "Run",
            kind: "action",
            responsibility: `Run the ${skill} Skill.`,
            implementation: {
              skill,
              operation: "default",
              scope: "main",
            },
            operations: ["require", "augment", "disable"],
            outputSchemas: [`${skill}.v1`],
            guardrails: [],
          },
        ],
        outputSchemas: [
          {
            id: `${skill}.v1`,
            description: `${skill} output.`,
            artifacts: [],
            evidence: [{ id: "summary", required: true }],
          },
        ],
      },
    };
  }

  async function writePlan(plan: FactoryPlan): Promise<string> {
    const planPath = path.join(project, `${plan.workflow.name}.json`);
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2));
    return planPath;
  }

  it("produces the same source hash for identical files and references", async () => {
    const first = await writeSkill("primer-design");
    const second = path.join(project, ".codex", "skills", "primer-design");
    await fs.mkdir(path.dirname(second), { recursive: true });
    await fs.cp(first, second, { recursive: true });

    expect(await hashDirectory(first)).toBe(await hashDirectory(second));
  });

  it("matches the official digest for a one-file Skill source", async () => {
    const directory = path.join(project, "one");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "SKILL.md"), "a\n");

    expect(await hashDirectory(directory)).toBe(
      "0d314a1dda2aff2063c5e9893d264662219c5e81b3141d1b9c2c256e449121ae",
    );
  });

  it("hashes supported symbolic links without following them", async () => {
    if (process.platform === "win32") return;
    const directory = await writeSkill("linked");
    const before = await hashDirectory(directory);
    await fs.symlink("SKILL.md", path.join(directory, "linked.md"));
    const after = await hashDirectory(directory);

    expect(after).not.toBe(before);
  });

  it("keeps synchronous and asynchronous directory hashes identical", async () => {
    const directory = await writeSkill("hash-parity");

    expect(hashDirectorySync(directory)).toBe(await hashDirectory(directory));
  });

  it("uses strict candidate resolution for missing and ambiguous Skills", async () => {
    const ambiguousPlanPath = await writePlan(planFor("ambiguous"));
    await writeSkill(
      "ambiguous",
      path.join(project, ".agents", "skills", "ambiguous"),
    );
    await writeSkill(
      "ambiguous",
      path.join(project, ".codex", "skills", "ambiguous"),
    );
    const missingPlanPath = await writePlan(planFor("missing"));
    const kernel = createStandaloneWorkflowKernel({
      projectRoot: project,
      homeDir: home,
    });

    const ambiguous = await kernel.buildProposal(ambiguousPlanPath);
    expect(ambiguous.canInitialize).toBe(false);
    expect(ambiguous.blockers).toContain(
      "Unresolved Skill candidate: ambiguous (ambiguous)",
    );
    await expect(
      kernel.initializeState({
        planPath: ambiguousPlanPath,
        plan: await kernel.readPlan(ambiguousPlanPath),
        proposal: ambiguous,
        confirmed: true,
      }),
    ).rejects.toThrow("blocked proposal");

    const missing = await kernel.buildProposal(missingPlanPath);
    expect(missing.canInitialize).toBe(false);
    expect(missing.blockers).toContain(
      "Unresolved Skill candidate: missing (missing)",
    );
  });

  it("keeps the standalone state namespace behind the shared foundation", async () => {
    await writeSkill("primer-design");
    const planPath = await writePlan(planFor("primer-design"));
    const standalone = createStandaloneWorkflowKernel({
      projectRoot: project,
      homeDir: home,
    });
    const proposal = await standalone.buildProposal(planPath);
    const state = await standalone.initializeState({
      planPath,
      plan: await standalone.readPlan(planPath),
      proposal,
      confirmed: true,
    });

    expect(state.draftPath).toBe(
      path.join(project, ".badger", "drafts", "primer-design-workflow"),
    );
    await expect(
      fs.stat(
        path.join(project, ".badger", "states", "primer-design-workflow.json"),
      ),
    ).resolves.toBeTruthy();
    await expect(fs.stat(path.join(project, ".badger"))).resolves.toMatchObject(
      { isDirectory: expect.any(Function) },
    );
  });

  it("routes existing proposal callers through the same foundation", async () => {
    await writeSkill("primer-design");
    const planPath = await writePlan(planFor("primer-design"));
    const kernelProposal = await createWorkflowKernel({
      projectRoot: project,
      homeDir: home,
      stateNamespace: ".badger",
    }).buildProposal(planPath);
    const adapterProposal = await buildProposal({
      projectRoot: project,
      homeDir: home,
      planPath,
    });

    expect(adapterProposal).toEqual(kernelProposal);
  });
});
