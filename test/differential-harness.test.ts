import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProposal } from "../src/factory/proposal.js";
import { findSkills } from "../src/skill/find.js";
import {
  assertFixtureSourcePath,
  snapshotDirectory,
  snapshotsEqual,
} from "../src/differential/fixture.js";
import { runDifferentialHarness } from "../src/differential/run.js";
import type { OfficialCommandRunner } from "../src/differential/types.js";

describe("differential fixture snapshots", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-differential-test-"),
    );
    await fs.mkdir(path.join(root, "skills", "one"), { recursive: true });
    await fs.writeFile(path.join(root, "skills", "one", "SKILL.md"), "one\n");
    await fs.writeFile(
      path.join(root, "skills", "one", "notes.txt"),
      "notes\n",
    );
  });

  afterEach(async () => fs.rm(root, { recursive: true, force: true }));

  it("records a stable byte manifest for a fixture directory", async () => {
    const directory = path.join(root, "skills", "one");
    const before = await snapshotDirectory(directory);
    const after = await snapshotDirectory(directory);

    expect(before).toEqual(after);
    expect(snapshotsEqual(before, after)).toBe(true);
    expect(before.files).toEqual([
      { path: "notes.txt", bytes: 6, sha256: expect.any(String) },
      { path: "SKILL.md", bytes: 4, sha256: expect.any(String) },
    ]);
  });

  it("rejects source paths inside protected raw data", async () => {
    const repositoryRoot = path.join(root, "repository");
    const safe = path.join(
      repositoryRoot,
      "primer_designer_harness",
      "skills",
      "primer-design",
    );
    const protectedPath = path.join(
      repositoryRoot,
      "primer_designer_harness",
      "raw_data",
      "fixture.xlsx",
    );

    expect(() => assertFixtureSourcePath(repositoryRoot, safe)).not.toThrow();
    expect(() =>
      assertFixtureSourcePath(repositoryRoot, protectedPath),
    ).toThrow("raw_data");
  });

  it("records both Creator observations without changing the source fixture", async () => {
    const repositoryRoot = path.resolve(process.cwd());
    const fixtureRoot = path.join(root, "fixture");
    const fixtureSkillsRoot = path.join(fixtureRoot, "skills");
    const skillNames = ["genome-download", "primer-design", "primer-pool-add"];
    for (const skillName of skillNames) {
      const skillRoot = path.join(fixtureSkillsRoot, skillName);
      await fs.mkdir(skillRoot, { recursive: true });
      await fs.writeFile(
        path.join(skillRoot, "SKILL.md"),
        `---\nname: ${skillName}\ndescription: Synthetic ${skillName} fixture.\n---\n\n# ${skillName}\n`,
        "utf8",
      );
    }
    await fs.writeFile(
      path.join(fixtureRoot, "extraction-manifest.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          official: { revision: "99fd7495f8b9217efbaae3a46d885f6fa7f4102a" },
          reusableWorkflowKernel: { workflowContract: [] },
          excluded: {
            classic: [],
            native: [],
            entry: [],
            installer: [],
            engine: [],
            hostPlatform: [],
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    const fixturePath = path.join(fixtureRoot, "primer-designer-workflow.json");
    await fs.writeFile(
      fixturePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          id: "primer-designer-three-skill",
          skills: skillNames.map((name) => ({
            name,
            path: `skills/${name}`,
          })),
          extractionManifest: "extraction-manifest.json",
          plan: {
            schemaVersion: 1,
            goal: "Compose a synthetic three-Skill workflow.",
            skillCreatorIntent: "new-skill",
            skillSources: skillNames.map((name) => ({
              name,
              location: path.join(".agents", "skills", name),
            })),
            defaultLocale: "en",
            workflow: {
              kind: "workflow-kernel",
              name: "primer-designer-workflow",
              goal: "Compose a synthetic three-Skill workflow.",
              customNodes: [
                {
                  id: "prepare",
                  label: "Prepare",
                  kind: "action",
                  responsibility: "Prepare the synthetic workflow.",
                  implementation: {
                    skill: "primer-design",
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
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    const fakeRunner: OfficialCommandRunner = {
      async run(args, options) {
        if (args[0] === "creator" && args[1] === "candidates") {
          return {
            candidates: await findSkills({
              projectRoot: options.cwd,
              sources: skillNames.map((name) => ({
                name,
                location: path.join(".agents", "skills", name),
              })),
            }),
          };
        }
        if (args[0] === "creator" && args[1] === "propose") {
          const fileIndex = args.indexOf("--file");
          const planPath = args[fileIndex + 1];
          const plan = JSON.parse(
            await fs.readFile(planPath, "utf8"),
          ) as Record<string, unknown>;
          plan.schemaVersion = 1;
          const proposal = await buildProposal({
            projectRoot: options.cwd,
            homeDir: options.homeDir,
            planPath: await writeTemporaryPlan(options.cwd, plan),
          });
          return {
            canGenerate: proposal.canInitialize,
            blockers: proposal.blockers,
            warnings: proposal.warnings,
            resolvedSkills: proposal.candidates,
            workflowProtocol: proposal.workflow,
          };
        }
        if (args[0] === "creator" && args[1] === "init") return {};
        if (args[0] === "creator" && args[1] === "generate") {
          const draftPath = path.join(
            options.cwd,
            ".comet",
            "bundle-drafts",
            args[2],
          );
          await fs.mkdir(path.join(draftPath, "skills", "entry"), {
            recursive: true,
          });
          await fs.writeFile(
            path.join(draftPath, "bundle.yaml"),
            "kind: SkillBundle\n",
          );
          await fs.writeFile(
            path.join(draftPath, "skills", "entry", "SKILL.md"),
            "---\nname: entry\ndescription: entry.\n---\n",
          );
          return { draftPath };
        }
        if (args[0] === "creator" && args[1] === "status") {
          return {
            draftPath: path.join(
              options.cwd,
              ".comet",
              "bundle-drafts",
              args[2],
            ),
          };
        }
        if (args[0] === "publish" && args[1] === "review") {
          return {
            readiness: {
              state: "blocked",
              blockers: ["[eval] Eval evidence is missing"],
              warnings: ["[authoring] Authoring evidence is missing"],
              evidence: {},
            },
          };
        }
        throw new Error(`Unexpected fake official command: ${args.join(" ")}`);
      },
    };

    const report = await runDifferentialHarness({
      repositoryRoot,
      fixturePath,
      fixtureSkillsRoot,
      officialRoot: path.join(root, "official"),
      officialRevision: "99fd7495f8b9217efbaae3a46d885f6fa7f4102a",
      officialRunner: fakeRunner,
    });

    expect(report.fixture).toMatchObject({
      id: "primer-designer-three-skill",
      skills: ["genome-download", "primer-design", "primer-pool-add"],
      unchanged: true,
    });
    expect(report.official.observation.candidates).toHaveLength(3);
    expect(report.standalone.observation.candidates).toHaveLength(3);
    expect(report.comparison).toMatchObject({
      candidateStatusEqual: true,
      sourceHashesEqual: true,
      referenceInventoryEqual: true,
      workflowProtocolEqual: true,
      generatedArtifactInventoryEqual: false,
    });
    expect(report.official.observation.initialReadiness).toMatchObject({
      state: "blocked",
      blockers: ["[eval] Eval evidence is missing"],
    });
    expect(report.extractionManifest).toMatchObject({
      reusableWorkflowKernel: expect.any(Object),
      excluded: {
        classic: expect.any(Array),
        native: expect.any(Array),
        installer: expect.any(Array),
        engine: expect.any(Array),
        hostPlatform: expect.any(Array),
      },
    });
  });
});

async function writeTemporaryPlan(
  projectRoot: string,
  plan: Record<string, unknown>,
): Promise<string> {
  const planPath = path.join(projectRoot, "fake-official-plan.json");
  await fs.writeFile(planPath, JSON.stringify(plan), "utf8");
  return planPath;
}
