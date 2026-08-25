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
    root = await fs.mkdtemp(path.join(os.tmpdir(), "comet-differential-test-"));
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
    const repositoryRoot = path.resolve(process.cwd(), "..");
    const fixturePath = path.join(
      repositoryRoot,
      "primer_designer_harness",
      "differential",
      "primer-designer-workflow.json",
    );
    const fakeRunner: OfficialCommandRunner = {
      async run(args, options) {
        if (args[0] === "creator" && args[1] === "candidates") {
          return {
            candidates: await findSkills({
              projectRoot: options.cwd,
              homeDir: options.homeDir,
              preferences: [
                { query: "genome-download", preferenceIndex: 0 },
                { query: "primer-design", preferenceIndex: 1 },
                { query: "primer-pool-add", preferenceIndex: 2 },
              ],
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
