import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadSkillPackage,
  resumeStandaloneRun,
  startStandaloneRun,
  validateSkillPackage,
} from "../src/index.js";

describe("public Engine runtime", () => {
  let root: string;
  let skillRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "comet-private-engine-"));
    skillRoot = path.join(root, "skill");
    await fs.mkdir(path.join(skillRoot, "comet"), { recursive: true });
    await fs.writeFile(path.join(skillRoot, "SKILL.md"), "# Demo\n");
    await fs.writeFile(
      path.join(skillRoot, "comet", "skill.yaml"),
      [
        "apiVersion: comet/v1alpha1",
        "kind: Skill",
        'metadata: { name: demo, version: "1.0.0", description: Demo }',
        "goal:",
        "  statement: Produce a report",
        "  inputs: []",
        "  outputs: []",
        "  success: [report exists]",
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
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("resumes a standalone Run from an immutable Skill snapshot", async () => {
    const pkg = await loadSkillPackage(skillRoot);
    expect(validateSkillPackage(pkg)).toEqual([]);

    const started = await startStandaloneRun(pkg, {
      projectRoot: root,
      runId: "demo-run",
    });
    expect(started.state).toMatchObject({
      skill: "demo",
      skillVersion: "1.0.0",
      status: "waiting",
      currentStep: "finish",
    });
    expect(started.action).toMatchObject({
      type: "checkpoint",
      stepId: "finish",
    });

    await fs.writeFile(path.join(skillRoot, "SKILL.md"), "# Changed source\n");

    const completed = await resumeStandaloneRun(root, "demo-run", {
      outcome: { status: "succeeded", summary: "Report complete" },
    });
    expect(completed.state).toMatchObject({
      skillVersion: "1.0.0",
      status: "completed",
      currentStep: null,
      pending: null,
    });
    expect(completed.action).toBeNull();
  });
});
