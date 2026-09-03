import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createPrivateEngineCommandRunner } from "../src/differential/engine/private.js";
import { runEngineDifferential } from "../src/differential/engine/run.js";
import { readEngineManifest } from "../src/differential/engine/fixture.js";
import type { EngineSourceManifest } from "../src/differential/engine/types.js";

const execFileAsync = promisify(execFile);

describe("private Engine differential runner", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-engine-differential-"),
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("compares private observations against the official command seam", async () => {
    const fixtureRoot = path.join(root, "fixture");
    const officialRoot = path.join(root, "official");
    const skillRoot = path.join(fixtureRoot, "skills", "demo");
    const fixturePath = path.join(fixtureRoot, "engine.json");
    const manifestPath = path.join(fixtureRoot, "manifest.json");
    await fs.mkdir(path.join(skillRoot, "badger"), { recursive: true });
    await fs.mkdir(officialRoot, { recursive: true });
    await fs.writeFile(path.join(skillRoot, "SKILL.md"), "# Demo\n");
    await fs.writeFile(
      path.join(skillRoot, "badger", "skill.yaml"),
      [
        "apiVersion: badger/v1alpha1",
        "kind: Skill",
        'metadata: { name: demo, version: "1", description: Demo }',
        "goal: { statement: Complete demo, inputs: [], outputs: [], success: [done] }",
        "orchestration:",
        "  mode: deterministic",
        "  entry: finish",
        "  steps:",
        "    - id: finish",
        "      action: { type: checkpoint }",
        "skills: []",
        "agents: []",
        "tools: []",
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(officialRoot, "engine.ts"),
      "export const engine = true;\n",
    );
    await execFileAsync("git", ["init", "--quiet", officialRoot]);
    await execFileAsync("git", [
      "-C",
      officialRoot,
      "config",
      "user.email",
      "engine-test@example.invalid",
    ]);
    await execFileAsync("git", [
      "-C",
      officialRoot,
      "config",
      "user.name",
      "Engine Test",
    ]);
    await execFileAsync("git", ["-C", officialRoot, "add", "engine.ts"]);
    await execFileAsync("git", [
      "-C",
      officialRoot,
      "commit",
      "--quiet",
      "-m",
      "baseline",
    ]);
    const revision = (
      await execFileAsync("git", ["-C", officialRoot, "rev-parse", "HEAD"])
    ).stdout.trim();
    const manifest: EngineSourceManifest = {
      schemaVersion: 1,
      kind: "official-engine-characterization",
      official: {
        remote: "example/official",
        revision,
        version: "test",
        checkout: "official",
        readOnly: true,
        sourcePaths: ["engine.ts"],
      },
      closure: {
        engine: ["engine.ts"],
        skillRuntime: ["engine.ts"],
        protectedFilesystem: ["engine.ts"],
      },
      excluded: ["raw_data"],
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    await fs.writeFile(
      fixturePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          id: "private-engine-v1",
          manifest: "manifest.json",
          skills: [{ name: "demo", path: "skills/demo" }],
          scenarios: [
            {
              id: "single",
              description: "A single private Engine action.",
              skill: "demo",
              runner: "standalone",
              runId: "demo-run",
              operations: [
                { type: "start" },
                {
                  type: "outcome",
                  status: "succeeded",
                  summary: "done",
                  artifacts: { report: "report.md" },
                },
                { type: "check", scope: "completion" },
              ],
            },
          ],
        },
        null,
        2,
      ) + "\n",
    );

    const runner = createPrivateEngineCommandRunner();
    const report = await runEngineDifferential({
      repositoryRoot: root,
      fixturePath,
      officialRoot,
      officialRunner: runner,
      privateRunner: runner,
    });

    expect(report.comparison).toMatchObject({
      status: "exact-match",
      exactMatches: ["single"],
      semanticMismatches: [],
    });
    expect(report.officialScenarios).toHaveLength(1);
    expect(report.privateScenarios).toHaveLength(1);
    expect(report.fixture.unchanged).toBe(true);
  });

  it("runs the complete canonical matrix through the public private seam", async () => {
    const packageRoot = path.resolve(process.cwd());
    const repositoryRoot = path.resolve(packageRoot, "..");
    const fixtureRoot = path.join(root, "fixture");
    await fs.cp(
      path.join(packageRoot, "test", "fixtures", "engine"),
      fixtureRoot,
      { recursive: true },
    );
    const fixturePath = path.join(fixtureRoot, "engine-characterization.json");
    const manifestPath = path.join(fixtureRoot, "manifest.json");
    const manifest = await readEngineManifest(manifestPath, { repositoryRoot });
    const officialRoot = path.join(root, "official");
    for (const sourcePath of manifest.official.sourcePaths) {
      const target = path.join(officialRoot, sourcePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, `${sourcePath}\n`);
    }
    await execFileAsync("git", ["init", "--quiet", officialRoot]);
    await execFileAsync("git", [
      "-C",
      officialRoot,
      "config",
      "user.email",
      "engine-test@example.invalid",
    ]);
    await execFileAsync("git", [
      "-C",
      officialRoot,
      "config",
      "user.name",
      "Engine Test",
    ]);
    await execFileAsync("git", ["-C", officialRoot, "add", "."]);
    await execFileAsync("git", [
      "-C",
      officialRoot,
      "commit",
      "--quiet",
      "-m",
      "baseline",
    ]);
    const manifestDocument = JSON.parse(
      await fs.readFile(manifestPath, "utf8"),
    ) as { official: { revision: string } };
    manifestDocument.official.revision = (
      await execFileAsync("git", ["-C", officialRoot, "rev-parse", "HEAD"])
    ).stdout.trim();
    await fs.writeFile(
      manifestPath,
      JSON.stringify(manifestDocument, null, 2) + "\n",
      "utf8",
    );
    const runner = createPrivateEngineCommandRunner();
    const report = await runEngineDifferential({
      repositoryRoot,
      fixturePath,
      officialRoot,
      officialRunner: runner,
      privateRunner: runner,
    });

    expect(report.coverage.missing).toEqual([]);
    expect(report.certification).toEqual({ status: "certified", blockers: [] });
    expect(report.comparison.semanticMismatches).toEqual([]);
    expect(report.officialScenarios).toHaveLength(14);
    expect(report.privateScenarios).toHaveLength(14);
    expect(
      report.privateScenarios.find(
        (scenario) => scenario.scenario.id === "source-drift",
      )?.run.snapshot,
    ).toEqual(expect.objectContaining({ files: expect.any(Array) }));
    expect(
      report.privateScenarios.find(
        (scenario) => scenario.scenario.id === "checkpoint-recovery",
      )?.run.checkpoint,
    ).toEqual(
      expect.objectContaining({ runId: "checkpoint-run", stateVersion: 1 }),
    );
  });
});
