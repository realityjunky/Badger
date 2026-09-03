import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { resumeManualRun, startManualRun } from "../src/engine/manual-run.js";
import {
  evaluateStandaloneRun,
  resumeStandaloneRun,
  standaloneRunDir,
  startStandaloneRun,
  upgradeStandaloneRun,
} from "../src/engine/standalone-run.js";
import {
  readArtifacts,
  readPendingAction,
  readTrajectory,
} from "../src/engine/run-store.js";
import { readRunState } from "../src/engine/state.js";
import { loadSkillPackage } from "../src/skill-runtime/load.js";

async function writeSkill(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "badger"), { recursive: true });
  await fs.writeFile(path.join(root, "SKILL.md"), "# Demo\n");
  await fs.writeFile(
    path.join(root, "badger", "skill.yaml"),
    `apiVersion: badger/v1alpha1
kind: Skill
metadata:
  name: demo
  version: "1"
  description: Demo Skill
goal:
  statement: Complete the demo
  inputs: []
  outputs: []
  success: [Done]
orchestration:
  mode: deterministic
  entry: finish
  steps:
    - id: finish
      action: { type: checkpoint }
skills: []
agents: []
tools: []
`,
  );
  await fs.writeFile(
    path.join(root, "badger", "checks.yaml"),
    `runtime:
  - id: report
    scope: completion
    type: artifact_exists
    artifact: report
`,
  );
}

describe("standalone Skill runs", () => {
  let root: string;
  let projectRoot: string;
  let skillRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-standalone-run-"));
    projectRoot = path.join(root, "project");
    skillRoot = path.join(root, "skill");
    await writeSkill(skillRoot);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("starts, resumes, and evaluates a run under .badger/runs/<run-id>", async () => {
    const pkg = await loadSkillPackage(skillRoot);
    const runDir = standaloneRunDir(projectRoot, "demo-run");

    const started = await startStandaloneRun(pkg, {
      projectRoot,
      runId: "demo-run",
    });
    const completed = await resumeStandaloneRun(projectRoot, "demo-run", {
      outcome: {
        status: "succeeded",
        summary: "Finished",
        artifacts: { report: "report.md" },
      },
    });
    const evaluated = await evaluateStandaloneRun(
      projectRoot,
      "demo-run",
      "completion",
    );

    expect(started.state.runId).toBe("demo-run");
    expect(started.action).toMatchObject({
      type: "checkpoint",
      stepId: "finish",
    });
    expect(await readRunState(runDir)).toEqual(completed.state);
    expect(
      await readPendingAction(runDir, completed.state.pendingRef),
    ).toBeNull();
    expect(await readArtifacts(runDir, completed.state.artifactsRef)).toEqual({
      report: "report.md",
    });
    expect(evaluated.evals).toEqual([
      {
        evalId: "report",
        passed: true,
        evidence: "artifact report -> report.md",
      },
    ]);
  });

  it("rejects unsafe standalone run ids before resolving a path", () => {
    expect(() => standaloneRunDir(projectRoot, "../escape")).toThrow(
      /Invalid standalone Run id/u,
    );
    expect(() => standaloneRunDir(projectRoot, "nested/path")).toThrow(
      /Invalid standalone Run id/u,
    );
  });

  it("rejects non-string Run ids before creating project storage", async () => {
    const invalidRunId = 123 as unknown as string;
    const pkg = await loadSkillPackage(skillRoot);

    await expect(
      startStandaloneRun(pkg, {
        projectRoot,
        runId: invalidRunId,
      }),
    ).rejects.toThrow("Invalid standalone Run id: 123");
    await expect(fs.access(projectRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects state copied from a different standalone Run", async () => {
    const pkg = await loadSkillPackage(skillRoot);
    const started = await startStandaloneRun(pkg, {
      projectRoot,
      runId: "demo-run",
    });
    const statePath = path.join(
      standaloneRunDir(projectRoot, "demo-run"),
      ".badger",
      "run-state.json",
    );
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as Record<
      string,
      unknown
    >;
    state.runId = "other-run";
    await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n");

    await expect(resumeStandaloneRun(projectRoot, "demo-run")).rejects.toThrow(
      "Standalone Run state does not match requested Run id: demo-run",
    );
    expect(
      await readRunState(standaloneRunDir(projectRoot, "demo-run")),
    ).toEqual(expect.objectContaining({ runId: "other-run" }));
    expect(started.state.runId).toBe("demo-run");
  });

  it("keeps multiple Runs isolated through failure recovery and completion", async () => {
    const pkg = await loadSkillPackage(skillRoot);
    const first = await startStandaloneRun(pkg, {
      projectRoot,
      runId: "first-run",
    });
    const second = await startStandaloneRun(pkg, {
      projectRoot,
      runId: "second-run",
    });

    expect(first.action?.id).not.toBe(second.action?.id);

    const failed = await resumeStandaloneRun(projectRoot, "first-run", {
      outcome: { status: "failed", summary: "Retry me" },
    });
    expect(failed.state.status).toBe("waiting");
    expect(failed.state.retries).toEqual({ [first.action!.id]: 1 });
    expect(failed.action).toEqual(first.action);

    const recovered = await resumeStandaloneRun(projectRoot, "first-run");
    expect(recovered.action).toEqual(first.action);

    const firstCompleted = await resumeStandaloneRun(projectRoot, "first-run", {
      outcome: {
        status: "succeeded",
        summary: "First complete",
        artifacts: { first: "first.md" },
      },
    });
    const secondCompleted = await resumeStandaloneRun(
      projectRoot,
      "second-run",
      {
        outcome: {
          status: "succeeded",
          summary: "Second complete",
          artifacts: { second: "second.md" },
        },
      },
    );

    expect(firstCompleted.state.status).toBe("completed");
    expect(secondCompleted.state.status).toBe("completed");
    expect(
      await readArtifacts(
        standaloneRunDir(projectRoot, "first-run"),
        firstCompleted.state.artifactsRef,
      ),
    ).toEqual({ first: "first.md" });
    expect(
      await readArtifacts(
        standaloneRunDir(projectRoot, "second-run"),
        secondCompleted.state.artifactsRef,
      ),
    ).toEqual({ second: "second.md" });
    expect(
      (
        await readTrajectory(
          standaloneRunDir(projectRoot, "first-run"),
          firstCompleted.state.trajectoryRef,
        )
      ).every((event) => event.runId === "first-run"),
    ).toBe(true);
    expect(
      (
        await readTrajectory(
          standaloneRunDir(projectRoot, "second-run"),
          secondCompleted.state.trajectoryRef,
        )
      ).every((event) => event.runId === "second-run"),
    ).toBe(true);
  });

  it("preserves manual Run state and action semantics at the standalone location", async () => {
    const pkg = await loadSkillPackage(skillRoot);
    const manualDir = path.join(root, "manual-run");
    const standalone = await startStandaloneRun(pkg, {
      projectRoot,
      runId: "parity-run",
    });
    const manual = await startManualRun(pkg, manualDir, {
      runId: "parity-run",
    });

    expect(standalone.state).toEqual(manual.state);
    expect(standalone.action).toEqual(manual.action);

    const standaloneCompleted = await resumeStandaloneRun(
      projectRoot,
      "parity-run",
      {
        outcome: {
          status: "succeeded",
          summary: "Parity complete",
          artifacts: { report: "report.md" },
        },
      },
    );
    const manualCompleted = await resumeManualRun(manualDir, {
      outcome: {
        status: "succeeded",
        summary: "Parity complete",
        artifacts: { report: "report.md" },
      },
    });

    expect(standaloneCompleted.state).toEqual(manualCompleted.state);
    expect(standaloneCompleted.action).toEqual(manualCompleted.action);
    expect(standaloneCompleted.evals).toEqual(manualCompleted.evals);
  });

  it.each([
    "",
    ".",
    "..",
    "../escape",
    "/tmp/escape",
    "C:\\escape",
    "nested/path",
    "nested\\path",
    "~escape",
  ])("rejects invalid Run id %j before any operation writes", async (runId) => {
    const pkg = await loadSkillPackage(skillRoot);
    const expected = `Invalid standalone Run id: ${runId}`;
    const operations = [
      () => startStandaloneRun(pkg, { projectRoot, runId }),
      () => resumeStandaloneRun(projectRoot, runId),
      () => evaluateStandaloneRun(projectRoot, runId, "step"),
      () => upgradeStandaloneRun(projectRoot, runId, pkg),
    ];

    for (const operation of operations) {
      await expect(operation()).rejects.toThrow(expected);
    }
    await expect(fs.access(projectRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
