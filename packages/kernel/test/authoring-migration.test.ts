import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProposal, readPlan } from "../src/factory/proposal.js";
import { generatePackage } from "../src/factory/generate.js";
import { initializeState, readState } from "../src/factory/state.js";
import {
  assemblePackage as assemblePackageImplementation,
  authoringReadiness,
  initializeAuthoringSession,
  runManualAuthoringFixture,
} from "../src/authoring/index.js";
import { buildAuthoringPlan } from "../src/authoring/plan.js";
import {
  classifyCreatorDraft,
  migrateLegacyDraft,
} from "../src/factory/migration.js";
import { reviewState } from "../src/publish/lifecycle.js";
import type { CreatorState, FactoryPlan } from "../src/types.js";

const assemblePackage = (
  state: Parameters<typeof assemblePackageImplementation>[0],
) => assemblePackageImplementation(state, true);

describe("Badger upgrade and legacy migration", () => {
  let root: string;
  let project: string;
  let planPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-migration-"));
    project = path.join(root, "project");
    const skillRoot = path.join(project, ".agents", "skills", "prepare");
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.writeFile(
      path.join(skillRoot, "SKILL.md"),
      "---\nname: prepare\ndescription: Prepare workflow.\n---\n\n# Prepare\n",
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
        goal: "Prepare workflow.",
        customNodes: [
          {
            id: "prepare",
            label: "Prepare",
            kind: "action",
            responsibility: "Prepare workflow.",
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

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function createUpgradePlan(sourceRoot: string): Promise<{
    plan: FactoryPlan;
    proposal: Awaited<ReturnType<typeof buildProposal>>;
  }> {
    const plan = await readPlan(planPath);
    plan.skillCreatorIntent = "upgrade-existing";
    plan.sourceRoot = sourceRoot;
    const skillMd = await fs.readFile(
      path.join(sourceRoot, "SKILL.md"),
      "utf8",
    );
    const name =
      skillMd.match(/^name:\s*(\S+)/mu)?.[1] ?? path.basename(sourceRoot);
    plan.skillSources = [...plan.skillSources, { name, location: sourceRoot }];
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2));
    return {
      plan,
      proposal: await buildProposal({ projectRoot: project, planPath }),
    };
  }

  async function createScaffold(): Promise<{
    state: CreatorState;
    generated: Awaited<ReturnType<typeof generatePackage>>;
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
    await initializeAuthoringSession({
      state,
      plan: await buildAuthoringPlan({ proposal }),
      generated,
    });
    return { state, generated };
  }

  it("records retained, replaced, and wrapped upgrade decisions", async () => {
    const sourceRoot = path.join(project, "legacy-skill");
    await fs.mkdir(path.join(sourceRoot, "badger"), { recursive: true });
    await fs.mkdir(path.join(sourceRoot, "source"), { recursive: true });
    await fs.writeFile(
      path.join(sourceRoot, "SKILL.md"),
      "---\nname: legacy\ndescription: Legacy implementation.\n---\n\n# Legacy\n\nOriginal implementation.\n",
    );
    await fs.writeFile(
      path.join(sourceRoot, "notes.md"),
      "Retain this evidence.\n",
    );
    await fs.writeFile(
      path.join(sourceRoot, "badger", "eval.yaml"),
      "legacy: true\n",
    );
    await fs.writeFile(
      path.join(sourceRoot, "source", "prior-source.txt"),
      "Prior source evidence.\n",
    );

    const { plan, proposal } = await createUpgradePlan(sourceRoot);
    expect(proposal.upgradeSource?.hash).toMatch(/^[a-f0-9]{64}$/u);
    const generated = await generatePackage({
      proposal,
      plan,
      destination: path.join(project, "generated"),
    });
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(generated.packageRoot, "reference", "source-evidence.json"),
        "utf8",
      ),
    ) as {
      sourceHash: string;
      decisions: Array<{
        sourcePath: string;
        decision: string;
        preservedPath: string;
      }>;
    };

    expect(manifest.sourceHash).toBe(proposal.upgradeSource?.hash);
    expect(manifest.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourcePath: "SKILL.md",
          decision: "wrapped",
          preservedPath: "source/SKILL.md",
        }),
        expect.objectContaining({
          sourcePath: "notes.md",
          decision: "retained",
          preservedPath: "source/notes.md",
        }),
        expect.objectContaining({
          sourcePath: "badger/eval.yaml",
          decision: "replaced",
          preservedPath: "source/badger/eval.yaml",
        }),
      ]),
    );
    await expect(
      fs.readFile(
        path.join(generated.packageRoot, "source", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toContain("Original implementation");
    await expect(
      fs.readFile(
        path.join(generated.packageRoot, "source", "badger", "eval.yaml"),
        "utf8",
      ),
    ).resolves.toBe("legacy: true\n");
    await expect(
      fs.readFile(
        path.join(
          generated.packageRoot,
          "source",
          "source",
          "prior-source.txt",
        ),
        "utf8",
      ),
    ).resolves.toBe("Prior source evidence.\n");
  });

  it("derives and deduplicates the upgrade source declaration", async () => {
    const sourceRoot = path.join(project, "legacy-source");
    await fs.mkdir(sourceRoot, { recursive: true });
    await fs.writeFile(
      path.join(sourceRoot, "SKILL.md"),
      "---\nname: legacy-source\ndescription: Legacy source.\n---\n",
    );
    const { plan, proposal } = await createUpgradePlan(sourceRoot);

    expect(proposal.canInitialize).toBe(true);
    expect(
      plan.skillSources.filter((source) => source.name === "legacy-source"),
    ).toHaveLength(1);
  });

  it("keeps legacy scaffolds blocked and readable until migrated", async () => {
    const { state } = await createScaffold();
    const legacy = structuredClone(state);
    delete legacy.authoring;
    await fs.rm(path.join(project, ".badger", "authoring", state.name), {
      recursive: true,
      force: true,
    });

    expect(classifyCreatorDraft(legacy)).toBe("legacy-scaffold-only");
    expect(reviewState(legacy).authoring).toMatchObject({
      state: "blocked",
      blockers: expect.arrayContaining([
        expect.stringMatching(/legacy.*scaffold.*only/iu),
      ]),
    });
    await expect(authoringReadiness(legacy)).resolves.toMatchObject({
      state: "blocked",
      status: "legacy",
      blockers: expect.arrayContaining([expect.stringMatching(/migrat/iu)]),
    });
  });

  it("migrates a legacy draft to a new authoring-pending package without replacing it", async () => {
    const { state } = await createScaffold();
    const legacyPath = state.draftPath;
    const legacyContent = await fs.readFile(
      path.join(legacyPath, "SKILL.md"),
      "utf8",
    );
    const legacy = structuredClone(state);
    delete legacy.authoring;
    await fs.writeFile(
      path.join(project, ".badger", "states", `${state.name}.json`),
      JSON.stringify(legacy, null, 2) + "\n",
    );

    const migrated = await migrateLegacyDraft({
      state: legacy,
      confirmed: true,
      depth: "quick",
    });

    expect(migrated.state.draftPath).not.toBe(legacyPath);
    expect(migrated.state.authoring?.status).toBe("pending");
    expect(migrated.state.authoring?.sourceEvidenceHash).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(migrated.state.generated?.sourceRoot).toBe(legacyPath);
    await expect(
      fs.readFile(path.join(legacyPath, "SKILL.md"), "utf8"),
    ).resolves.toBe(legacyContent);
    await expect(
      fs.readFile(
        path.join(migrated.state.generated!.packageRoot, "source", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toBe(legacyContent);
    const recovered = await readState(project, migrated.state.name);
    await expect(authoringReadiness(recovered)).resolves.toMatchObject({
      state: "blocked",
      status: "pending",
    });
  });

  it("requires confirmation and never replaces an existing migration destination", async () => {
    const { state } = await createScaffold();
    const legacy = structuredClone(state);
    delete legacy.authoring;
    const destination = path.join(project, "migrated-draft");
    await fs.mkdir(destination, { recursive: true });

    await expect(
      migrateLegacyDraft({ state: legacy, confirmed: false, destination }),
    ).rejects.toThrow(/confirmation/iu);
    await expect(
      migrateLegacyDraft({ state: legacy, confirmed: true, destination }),
    ).rejects.toThrow(/destination already exists/iu);
  });

  it("rejects upgrade destinations reached through a source symlink", async () => {
    const sourceRoot = path.join(project, "legacy-skill");
    await fs.mkdir(sourceRoot, { recursive: true });
    await fs.writeFile(
      path.join(sourceRoot, "SKILL.md"),
      "---\nname: legacy\ndescription: Legacy implementation.\n---\n\n# Legacy\n",
    );
    const { plan, proposal } = await createUpgradePlan(sourceRoot);
    const destination = path.join(project, "source-link", "nested-output");
    await fs.symlink(sourceRoot, path.join(project, "source-link"));

    await expect(
      generatePackage({ proposal, plan, destination }),
    ).rejects.toThrow(/inside.*source/iu);
  });

  it("reports all authoring lanes stale when an upgrade source drifts after assembly", async () => {
    const sourceRoot = path.join(project, "legacy-skill");
    await fs.mkdir(sourceRoot, { recursive: true });
    await fs.writeFile(
      path.join(sourceRoot, "SKILL.md"),
      "---\nname: legacy\ndescription: Legacy implementation.\n---\n\n# Legacy\n",
    );
    const { plan, proposal } = await createUpgradePlan(sourceRoot);
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
      plan: await buildAuthoringPlan({ proposal }),
      generated,
    });
    await expect(
      fs.readFile(
        path.join(
          generated.packageRoot,
          "prepared-workflow-prepare",
          "SKILL.md",
        ),
        "utf8",
      ),
    ).resolves.toContain("## Guidance");
    const authored = await runManualAuthoringFixture({ state });
    const assembled = await assemblePackage(authored);
    const assembledManifest = JSON.parse(
      await fs.readFile(
        path.join(
          assembled.generated!.packageRoot,
          "reference",
          "source-evidence.json",
        ),
        "utf8",
      ),
    ) as { preservedAt: string };
    expect(assembledManifest.preservedAt).toBe("assembled");
    await fs.appendFile(
      path.join(sourceRoot, "SKILL.md"),
      "\nDrifted source.\n",
    );

    const readiness = await authoringReadiness(assembled);
    expect(readiness.state).toBe("blocked");
    expect(readiness.status).toBe("stale");
    expect(readiness.recovery.invalidatedLanes).toEqual([
      "script",
      "reference",
      "pause-points",
      "workflow-entry",
      "skill-core",
      "skill-review",
    ]);
    expect(readiness.blockers).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/source evidence.*stale/iu),
      ]),
    );
  });
});
