import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProposal } from "../src/factory/proposal.js";
import { generatePackage } from "../src/factory/generate.js";
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

  beforeEach(async () => {
    root = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-kernel-foundation-"),
    );
    project = path.join(root, "project");
    await fs.mkdir(project, { recursive: true });
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
      skillSources: [
        { name: skill, location: path.join(".agents", "skills", skill) },
      ],
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
    const ambiguousPlan = planFor("ambiguous");
    ambiguousPlan.skillSources = [
      {
        name: "ambiguous",
        location: path.join(".agents", "skills", "ambiguous"),
      },
      {
        name: "ambiguous",
        location: path.join(".codex", "skills", "ambiguous"),
      },
    ];
    const ambiguousPlanPath = await writePlan(ambiguousPlan);
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

  it("does not resolve an ambient Skill that is not declared by the plan", async () => {
    await writeSkill(
      "ambient-only",
      path.join(project, ".agents", "skills", "ambient-only"),
    );
    const plan = planFor("ambient-only");
    plan.skillSources = [];
    const planPath = await writePlan(plan);

    const proposal = await createStandaloneWorkflowKernel({
      projectRoot: project,
    }).buildProposal(planPath);

    expect(proposal.canInitialize).toBe(false);
    expect(proposal.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "ambient-only",
          status: "missing",
          sources: [],
        }),
      ]),
    );
    expect(proposal.blockers).toContain(
      "Workflow binding ambient-only has no explicitly declared Skill source",
    );
  });

  it("rejects initialization when declared source evidence changes", async () => {
    const planPath = await writePlan(planFor("primer-design"));
    await writeSkill("primer-design");
    const kernel = createStandaloneWorkflowKernel({ projectRoot: project });
    const plan = await kernel.readPlan(planPath);
    const proposal = await kernel.buildProposal(planPath);
    await fs.appendFile(
      path.join(project, ".agents", "skills", "primer-design", "SKILL.md"),
      "\nChanged after proposal.\n",
    );

    await expect(
      kernel.initializeState({
        planPath,
        plan,
        proposal,
        confirmed: true,
      }),
    ).rejects.toThrow(/source evidence is stale/iu);
  });

  it("rejects legacy preference-based plan fields", async () => {
    const plan = {
      ...planFor("legacy"),
      preferredSkills: ["legacy"],
    } as unknown as FactoryPlan;
    const planPath = await writePlan(plan);

    await expect(
      createStandaloneWorkflowKernel({ projectRoot: project }).readPlan(
        planPath,
      ),
    ).rejects.toThrow(/removed preference-based Skill fields/u);
  });

  it("keeps the standalone state namespace behind the shared foundation", async () => {
    await writeSkill("primer-design");
    const planPath = await writePlan(planFor("primer-design"));
    const standalone = createStandaloneWorkflowKernel({
      projectRoot: project,
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

  it("confines plan sources and the upgrade source to the project or the host's roots", async () => {
    const external = await writeSkill(
      "shared",
      path.join(root, "external", "shared"),
    );
    const plan = planFor("shared");
    plan.skillCreatorIntent = "upgrade-existing";
    plan.skillSources = [{ name: "shared", location: external }];
    plan.sourceRoot = external;
    const planPath = await writePlan(plan);

    const refused = await createStandaloneWorkflowKernel({
      projectRoot: project,
    }).buildProposal(planPath);
    expect(refused.canInitialize).toBe(false);
    expect(refused.blockers).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^Skill shared source is outside the project and its registered roots/u,
        ),
        expect.stringMatching(
          /^Upgrade source is outside the project and its registered roots/u,
        ),
      ]),
    );

    const accepted = await createStandaloneWorkflowKernel({
      projectRoot: project,
      sourceRoots: ["../external"],
    }).buildProposal(planPath);
    expect(accepted.blockers).toEqual([]);
    expect(accepted.canInitialize).toBe(true);
  });

  it("refuses an upgrade source that resolves outside the project and the host's roots", async () => {
    const outside = await writeSkill(
      "shared",
      path.join(root, "elsewhere", "shared"),
    );
    await fs.symlink(path.dirname(outside), path.join(project, "linked"));
    const plan = planFor("shared");
    plan.skillCreatorIntent = "upgrade-existing";
    plan.skillSources = [{ name: "shared", location: "linked/shared" }];
    plan.sourceRoot = "linked/shared";
    const planPath = await writePlan(plan);

    const proposal = await createStandaloneWorkflowKernel({
      projectRoot: project,
    }).buildProposal(planPath);

    expect(proposal.canInitialize).toBe(false);
    expect(proposal.blockers).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^Upgrade source resolves outside the project and its registered roots/u,
        ),
      ]),
    );
  });

  it("refuses a plan that registers its own source roots", async () => {
    await writeSkill("primer-design");
    const planPath = await writePlan({
      ...planFor("primer-design"),
      sourceRoots: ["/"],
    } as FactoryPlan);

    await expect(
      createStandaloneWorkflowKernel({ projectRoot: project }).readPlan(
        planPath,
      ),
    ).rejects.toThrow(/sourceRoots are registered by the host/u);
  });

  it("refuses a plan whose source scripts declare unknown or conflicting side effects", async () => {
    await writeSkill("primer-design");
    const kernel = createStandaloneWorkflowKernel({ projectRoot: project });
    const withScripts = (scripts: Record<string, unknown>): FactoryPlan => {
      const plan = planFor("primer-design");
      plan.skillSources = [
        {
          ...plan.skillSources[0]!,
          scripts,
        } as FactoryPlan["skillSources"][number],
      ];
      return plan;
    };

    await expect(
      kernel.readPlan(
        await writePlan(withScripts({ "scripts/run.py": ["none", "network"] })),
      ),
    ).rejects.toThrow(/none together with other side effects/u);
    await expect(
      kernel.readPlan(
        await writePlan(withScripts({ "scripts/run.py": "reads-only" })),
      ),
    ).rejects.toThrow(/unknown side effect/u);
    await expect(
      kernel.readPlan(await writePlan(withScripts({ "run.py": "none" }))),
    ).rejects.toThrow(/scripts\/ path/u);
    await expect(
      kernel.readPlan(
        await writePlan(
          withScripts({ "scripts/run.py": ["network", "local-writes"] }),
        ),
      ),
    ).resolves.toMatchObject({
      skillSources: [
        { scripts: { "scripts/run.py": ["network", "local-writes"] } },
      ],
    });
  });

  it("keeps a proposal and its package unchanged when environment noise appears in a source", async () => {
    const source = await writeSkill("primer-design");
    const plan = planFor("primer-design");
    const planPath = await writePlan(plan);
    const kernel = createStandaloneWorkflowKernel({ projectRoot: project });
    const proposal = await kernel.buildProposal(planPath);
    const before = await generatePackage({
      proposal,
      plan,
      destination: path.join(root, "packages", "before"),
      projectRoot: project,
    });

    await fs.writeFile(path.join(source, ".DS_Store"), "stray\n");
    await fs.mkdir(path.join(source, "__pycache__"), { recursive: true });
    await fs.writeFile(
      path.join(source, "__pycache__", "run.cpython-312.pyc"),
      "stray\n",
    );

    const again = await kernel.buildProposal(planPath);
    expect(again).toEqual(proposal);
    const after = await generatePackage({
      proposal: again,
      plan,
      destination: path.join(root, "packages", "after"),
      projectRoot: project,
    });
    expect(after.scaffoldHash).toBe(before.scaffoldHash);
    await expect(
      kernel.initializeState({
        planPath,
        plan: await kernel.readPlan(planPath),
        proposal,
        confirmed: true,
      }),
    ).resolves.toMatchObject({ status: "draft" });
  });

  it("routes existing proposal callers through the same foundation", async () => {
    await writeSkill("primer-design");
    const planPath = await writePlan(planFor("primer-design"));
    const kernelProposal = await createWorkflowKernel({
      projectRoot: project,
      stateNamespace: ".badger",
    }).buildProposal(planPath);
    const adapterProposal = await buildProposal({
      projectRoot: project,
      planPath,
    });

    expect(adapterProposal).toEqual(kernelProposal);
  });
});
