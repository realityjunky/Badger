import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  assertEngineFixturePath,
  assertEngineFixtureSourcePath,
  readEngineFixture,
  readEngineManifest,
} from "../src/differential/engine/fixture.js";
import {
  classifyEngineError,
  compareEngineObservations,
} from "../src/differential/engine/observe.js";
import { runOfficialEngineBaseline } from "../src/differential/engine/run.js";
import type {
  EngineCommandRunner,
  EngineScenarioObservation,
  EngineSourceManifest,
} from "../src/differential/engine/types.js";

const execFileAsync = promisify(execFile);

describe("official Engine characterization harness", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(
      path.join(os.tmpdir(), "comet-engine-characterization-test-"),
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("loads the pinned synthetic fixture matrix without entering protected inputs", async () => {
    const packageRoot = path.resolve(process.cwd());
    const repositoryRoot = path.resolve(packageRoot, "..");
    const fixturePath = path.join(
      packageRoot,
      "test",
      "fixtures",
      "engine",
      "engine-characterization.json",
    );
    const fixture = await readEngineFixture(fixturePath, { repositoryRoot });
    const manifest = await readEngineManifest(
      path.join(path.dirname(fixturePath), fixture.manifest),
      { repositoryRoot },
    );

    expect(fixture.id).toBe("official-engine-v1");
    expect(fixture.scenarios.map((scenario) => scenario.id)).toEqual([
      "deterministic-single-step",
      "deterministic-multi-step",
      "failed-outcome-retry",
      "waiting-action-recovery",
      "confirmation-guardrail-rejection",
      "unsafe-run-state",
      "manual-run-persistence",
      "corrupt-current-step",
    ]);
    expect(manifest.official.revision).toBe(
      "99fd7495f8b9217efbaae3a46d885f6fa7f4102a",
    );
    expect(() =>
      assertEngineFixturePath(
        repositoryRoot,
        path.join(repositoryRoot, "primer_designer_harness", "raw_data"),
      ),
    ).toThrow("protected raw data");
    expect(() =>
      assertEngineFixtureSourcePath(
        repositoryRoot,
        fixturePath,
        path.join(
          repositoryRoot,
          "primer_designer_harness",
          "raw_data",
          "fixture.xlsx",
        ),
      ),
    ).toThrow("protected raw data");
  });

  it("records an official-only baseline with durable Run observations", async () => {
    const fixtureRoot = path.join(root, "fixture");
    const officialRoot = path.join(root, "official");
    const fixturePath = path.join(fixtureRoot, "engine-characterization.json");
    const manifestPath = path.join(fixtureRoot, "manifest.json");
    const skillRoot = path.join(fixtureRoot, "skills", "demo");
    await fs.mkdir(path.join(skillRoot, "comet"), { recursive: true });
    await fs.mkdir(officialRoot, { recursive: true });
    await fs.writeFile(
      path.join(officialRoot, "engine.ts"),
      "export const engine = true;\n",
    );
    await fs.writeFile(
      path.join(skillRoot, "SKILL.md"),
      "# Synthetic Engine fixture\n",
    );
    await fs.writeFile(
      path.join(skillRoot, "comet", "skill.yaml"),
      "apiVersion: comet/v1alpha1\nkind: Skill\n",
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
          id: "test-engine-baseline",
          manifest: "manifest.json",
          skills: [{ name: "demo", path: "skills/demo" }],
          scenarios: [
            {
              id: "single",
              description: "One durable synthetic action.",
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

    const runner = fakeOfficialRunner();
    const report = await runOfficialEngineBaseline({
      repositoryRoot: root,
      fixturePath,
      officialRoot,
      officialRunner: runner,
    });
    const observation = report.scenarios[0];

    expect(report).toMatchObject({
      kind: "official-engine-baseline",
      official: {
        revision,
        expectedRevision: revision,
        verified: true,
        unchanged: true,
      },
      fixture: { id: "test-engine-baseline", unchanged: true },
      comparison: {
        status: "official-baseline",
        semanticMismatches: [],
      },
    });
    expect(observation).toMatchObject({
      coordinates: {
        projectRoot: "<project-root>",
        homeDir: "<home-dir>",
        skillRoot: "<skill-root>",
        runRoot: "<run-root>",
      },
      run: {
        state: { runId: "demo-run", status: "completed", currentStep: null },
        pendingAction: null,
        outcomes: [{ actionId: "action-1", status: "succeeded" }],
        artifacts: { report: "report.md" },
        checkpoint: null,
        errors: [],
      },
      errors: [],
    });
    expect(observation.run.trajectory).toEqual([
      expect.objectContaining({
        type: "run_started",
        timestamp: "<timestamp>",
      }),
      expect.objectContaining({
        type: "action_proposed",
        timestamp: "<timestamp>",
      }),
      expect.objectContaining({
        type: "action_completed",
        timestamp: "<timestamp>",
      }),
      expect.objectContaining({
        type: "eval_completed",
        timestamp: "<timestamp>",
      }),
    ]);
    expect(observation.run.evals).toHaveLength(4);
    expect(report.official.sourceBefore.files).toEqual([
      { path: "engine.ts", bytes: 28, sha256: expect.any(String) },
    ]);
  });

  it("preserves semantic differences while classifying only packaging coordinates", () => {
    const official = observation("official", "<official-project>", "completed");
    const packagingOnly = observation(
      "official",
      "<private-project>",
      "completed",
    );
    const packagingComparison = compareEngineObservations(
      official,
      packagingOnly,
    );
    expect(packagingComparison.status).toBe("expected-packaging-difference");
    expect(packagingComparison.semanticMismatches).toEqual([]);

    const semantic = observation("official", "<official-project>", "failed");
    const semanticComparison = compareEngineObservations(official, semantic);
    expect(semanticComparison.status).toBe("semantic-mismatch");
    expect(semanticComparison.semanticMismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.run.state.status",
          classification: "semantic",
        }),
      ]),
    );
  });

  it.each([
    ["Invalid standalone Run id: ../escape", "invalid-run-id"],
    [
      "Invalid Run state: pending_ref must stay inside the change directory",
      "unsafe-path",
    ],
    ["Skill is not allowed: unknown", "guardrail-rejection"],
    ["Unknown current step: missing", "unknown-step"],
  ])("classifies official error %s", (message, category) => {
    expect(classifyEngineError(new Error(message)).category).toBe(category);
  });
});

function fakeOfficialRunner(): EngineCommandRunner {
  return {
    async run(args, options) {
      const isStart = args[0] === "skill" && args[1] === "run";
      const runId = argument(args, "--run-id") ?? "manual-run";
      const runRoot = path.join(options.cwd, ".comet", "runs", runId);
      const statePath = path.join(runRoot, ".comet", "run-state.json");
      const pendingPath = path.join(runRoot, ".comet", "pending-action.json");
      const trajectoryPath = path.join(runRoot, ".comet", "trajectory.jsonl");
      const state = {
        runId,
        skill: "demo",
        skillVersion: "1.0.0",
        skillHash: "a".repeat(64),
        orchestration: "deterministic",
        currentStep: "finish",
        iteration: 0,
        pending: "action-1",
        pendingRef: ".comet/pending-action.json",
        trajectoryRef: ".comet/trajectory.jsonl",
        contextRef: ".comet/context.md",
        artifactsRef: ".comet/artifacts.json",
        checkpointRef: ".comet/checkpoint.json",
        status: "waiting",
        retries: {},
      };
      const action = { id: "action-1", stepId: "finish", type: "checkpoint" };
      if (isStart) {
        await fs.mkdir(path.dirname(statePath), { recursive: true });
        await fs.writeFile(statePath, JSON.stringify(state, null, 2));
        await fs.writeFile(pendingPath, JSON.stringify(action, null, 2));
        await appendFakeEvent(trajectoryPath, "run_started", runId, {});
        await appendFakeEvent(trajectoryPath, "action_proposed", runId, {
          action,
        });
        return { state, action, checks: [] };
      }
      const current = JSON.parse(
        await fs.readFile(statePath, "utf8"),
      ) as Record<string, unknown>;
      if (args[1] === "check") {
        return {
          state: current,
          scope: argument(args, "--scope"),
          checks: [
            {
              checkId: "report",
              passed: true,
              evidence: "artifact report -> report.md",
            },
          ],
        };
      }
      const outcome = {
        actionId: "action-1",
        status: "succeeded",
        summary: argument(args, "--summary"),
      };
      await fs.writeFile(
        path.join(runRoot, ".comet", "artifacts.json"),
        JSON.stringify({ report: "report.md" }, null, 2),
      );
      await appendFakeEvent(trajectoryPath, "action_completed", runId, {
        action,
        outcome,
      });
      await appendFakeEvent(trajectoryPath, "eval_completed", runId, {
        scope: "completion",
        results: [
          {
            evalId: "report",
            passed: true,
            evidence: "artifact report -> report.md",
          },
        ],
      });
      const completed = {
        ...current,
        currentStep: null,
        iteration: 1,
        pending: null,
        status: "completed",
      };
      await fs.writeFile(statePath, JSON.stringify(completed, null, 2));
      await fs.rm(pendingPath, { force: true });
      return {
        state: completed,
        action: null,
        checks: [
          {
            checkId: "report",
            passed: true,
            evidence: "artifact report -> report.md",
          },
        ],
      };
    },
  };
}

async function appendFakeEvent(
  file: string,
  type: string,
  runId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await fs.appendFile(
    file,
    JSON.stringify({
      sequence: (await readFakeEvents(file)).length + 1,
      timestamp: new Date().toISOString(),
      type,
      runId,
      data,
    }) + "\n",
  );
}

async function readFakeEvents(file: string): Promise<unknown[]> {
  try {
    const text = await fs.readFile(file, "utf8");
    return text
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function observation(
  scenarioId: string,
  projectRoot: string,
  status: string,
): EngineScenarioObservation {
  return {
    scenario: {
      id: scenarioId,
      description: "test",
      skill: "demo",
      runner: "standalone",
      runId: "run",
    },
    coordinates: {
      projectRoot,
      homeDir: "<home>",
      skillRoot: "<skill>",
      runRoot: "<run>",
    },
    commands: [
      {
        operation: "start",
        args: ["skill", "run", "<skill>"],
      },
    ],
    run: {
      state: { status },
      pendingAction: null,
      outcomes: [],
      artifacts: {},
      trajectory: [],
      checkpoint: null,
      evals: [],
      errors: [],
    },
    errors: [],
  };
}
