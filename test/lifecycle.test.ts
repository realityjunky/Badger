import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildProposal, readPlan } from "../src/factory/proposal.js";
import { generatePackage } from "../src/factory/generate.js";
import { initializeState, readState } from "../src/factory/state.js";
import { evaluatePackage } from "../src/eval/run.js";
import {
  approveReview,
  distributePreview,
  publishState,
  reviewState,
} from "../src/publish/lifecycle.js";
import type { FactoryPlan } from "../src/types.js";

const execFileAsync = promisify(execFile);

describe("standalone Creator lifecycle", () => {
  let project: string;
  let skillRoot: string;
  let planPath: string;

  beforeEach(async () => {
    project = await fs.mkdtemp(path.join(os.tmpdir(), "comet-any-lifecycle-"));
    skillRoot = path.join(project, ".agents", "skills", "primer-design");
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.writeFile(
      path.join(skillRoot, "SKILL.md"),
      "---\nname: primer-design\ndescription: Primer design.\n---\n\n# Primer Design\n",
    );
    const plan: FactoryPlan = {
      schemaVersion: 1,
      goal: "Create a primer workflow.",
      skillCreatorIntent: "new-skill",
      preferredSkills: ["primer-design"],
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
    planPath = path.join(project, "plan.json");
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2));
  });

  afterEach(async () => fs.rm(project, { recursive: true, force: true }));

  it("requires confirmation, then binds eval/review/publish to one hash", async () => {
    const proposal = await buildProposal({ projectRoot: project, planPath });
    expect(proposal.canInitialize).toBe(true);
    const plan = await readPlan(planPath);
    await expect(
      initializeState({
        projectRoot: project,
        planPath,
        plan,
        proposal,
        confirmed: false,
      }),
    ).rejects.toThrow("confirmation");
    const initial = await initializeState({
      projectRoot: project,
      planPath,
      plan,
      proposal,
      confirmed: true,
    });
    const generated = await generatePackage({
      proposal,
      plan,
      destination: initial.draftPath,
    });
    initial.generated = generated;
    const report = await evaluatePackage(initial);
    expect(report.passed).toBe(true);
    expect(reviewState(await readState(project, initial.name)).state).toBe(
      "reviewable",
    );
    const approved = await approveReview({
      state: await readState(project, initial.name),
      reviewer: "test-reviewer",
      approve: true,
    });
    expect(reviewState(approved).state).toBe("publishable");
    const published = await publishState(approved);
    expect(published.status).toBe("published");
    const preview = await distributePreview(
      published,
      path.join(project, "install-preview"),
    );
    expect(preview.preview).toBe(true);
    expect(preview.files).toContain(
      path.join(project, "install-preview", "bundle.yaml"),
    );
  });

  it("generates a complete inspectable workflow-kernel Bundle", async () => {
    const proposal = await buildProposal({ projectRoot: project, planPath });
    const plan = await readPlan(planPath);
    const initial = await initializeState({
      projectRoot: project,
      planPath,
      plan,
      proposal,
      confirmed: true,
    });

    const generated = await generatePackage({
      proposal,
      plan,
      destination: initial.draftPath,
    });

    const expectedFiles = [
      "bundle.yaml",
      "skills/primer-workflow/SKILL.md",
      "skills/primer-workflow-design/SKILL.md",
      "skills/primer-workflow/reference/resolved-skills.json",
      "skills/primer-workflow/reference/workflow-protocol.json",
      "skills/primer-workflow/reference/decision-points.md",
      "skills/primer-workflow/reference/recovery.md",
      "skills/primer-workflow/reference/authoring-lanes.json",
      "skills/primer-workflow/reference/skill-review.md",
      "skills/primer-workflow/reference/composition-report.md",
      "skills/primer-workflow/reference/subagents/script-author.md",
      "skills/primer-workflow/scripts/comet-plan.mjs",
      "skills/primer-workflow/scripts/comet-check.mjs",
      "skills/primer-workflow/scripts/comet-hook-guard.mjs",
      "skills/primer-workflow/scripts/workflow-state.mjs",
      "skills/primer-workflow/scripts/workflow-guard.mjs",
      "skills/primer-workflow/scripts/workflow-handoff.mjs",
      "rules/primer-workflow-orchestration.md",
      "hooks/primer-workflow-before-write-guard.yaml",
      "hooks/primer-workflow-before-tool-guard.yaml",
      "skills/primer-workflow/comet/skill.yaml",
      "skills/primer-workflow/comet/guardrails.yaml",
      "skills/primer-workflow/comet/checks.yaml",
      "skills/primer-workflow/comet/eval.yaml",
    ];
    const files = await listFiles(generated.bundleRoot);

    expect(files.sort()).toEqual(expectedFiles.sort());
    expect(generated.bundleRoot).toBe(initial.draftPath);
    expect(generated.packageRoot).toBe(
      path.join(initial.draftPath, "skills", "primer-workflow"),
    );
    expect(generated.protocolPath).toBe(
      path.join(
        initial.draftPath,
        "skills",
        "primer-workflow",
        "reference",
        "workflow-protocol.json",
      ),
    );
    expect(generated.evalPath).toBe(
      path.join(
        initial.draftPath,
        "skills",
        "primer-workflow",
        "comet",
        "eval.yaml",
      ),
    );

    const manifest = await fs.readFile(
      path.join(initial.draftPath, "bundle.yaml"),
      "utf8",
    );
    expect(manifest).toContain("kind: SkillBundle");
    expect(manifest).toContain("path: skills/primer-workflow");
    expect(manifest).toContain("visibility: entry");
    expect(manifest).toContain("path: skills/primer-workflow-design");
    expect(manifest).toContain("visibility: internal");
    expect(manifest).toContain("path: rules/primer-workflow-orchestration.md");
    expect(manifest).toContain(
      "path: skills/primer-workflow/scripts/workflow-state.mjs",
    );

    const protocol = JSON.parse(
      await fs.readFile(generated.protocolPath, "utf8"),
    ) as { kind: string; nodes: unknown[]; evals: unknown[] };
    expect(protocol.kind).toBe("workflow-kernel");
    expect(protocol.nodes).toHaveLength(1);
    expect(protocol.evals).toHaveLength(1);

    await expect(
      execFileAsync(process.execPath, [
        path.join(
          initial.draftPath,
          "skills",
          "primer-workflow",
          "scripts",
          "comet-check.mjs",
        ),
      ]),
    ).resolves.toMatchObject({ stdout: "workflow-contract-ok\n" });

    const stateScript = path.join(
      generated.packageRoot,
      "scripts",
      "workflow-state.mjs",
    );
    const guardScript = path.join(
      generated.packageRoot,
      "scripts",
      "workflow-guard.mjs",
    );
    const scriptOptions = { cwd: project, env: process.env };
    await expect(
      execFileAsync(process.execPath, [stateScript, "init"], scriptOptions),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining("SKILL: primer-workflow-design"),
    });
    await expect(
      execFileAsync(
        process.execPath,
        [stateScript, "record", "design", '{"summary":"done"}'],
        scriptOptions,
      ),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining("EVIDENCE: design"),
    });
    await expect(
      execFileAsync(
        process.execPath,
        [guardScript, "exit", "design", "--apply"],
        scriptOptions,
      ),
    ).resolves.toMatchObject({ stdout: expect.stringContaining("NEXT: done") });
    await expect(
      fs.readFile(
        path.join(project, ".comet", "runs", "primer-workflow", "state.json"),
        "utf8",
      ),
    ).resolves.toContain('"status": "completed"');
  });

  it("fails evaluation when a declared Bundle resource is missing", async () => {
    const proposal = await buildProposal({ projectRoot: project, planPath });
    const plan = await readPlan(planPath);
    const initial = await initializeState({
      projectRoot: project,
      planPath,
      plan,
      proposal,
      confirmed: true,
    });
    const generated = await generatePackage({
      proposal,
      plan,
      destination: initial.draftPath,
    });
    await fs.rm(
      path.join(initial.draftPath, "rules", "primer-workflow-orchestration.md"),
    );
    initial.generated = generated;

    const report = await evaluatePackage(initial);

    expect(report.passed).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "control-plane:../../rules/primer-workflow-orchestration.md",
        passed: false,
      }),
    );
  });

  it("requires declared Output Schema artifacts before Node exit", async () => {
    const plan = await readPlan(planPath);
    plan.workflow.outputSchemas[0].artifacts = [
      {
        id: "design-table",
        kind: "file",
        required: true,
        paths: ["design.tsv"],
        validations: ["artifact-exists"],
      },
    ];
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2));
    const proposal = await buildProposal({ projectRoot: project, planPath });
    const initial = await initializeState({
      projectRoot: project,
      planPath,
      plan,
      proposal,
      confirmed: true,
    });
    const generated = await generatePackage({
      proposal,
      plan,
      destination: initial.draftPath,
    });
    const stateScript = path.join(
      generated.packageRoot,
      "scripts",
      "workflow-state.mjs",
    );
    const guardScript = path.join(
      generated.packageRoot,
      "scripts",
      "workflow-guard.mjs",
    );
    const scriptOptions = { cwd: project, env: process.env };
    await execFileAsync(process.execPath, [stateScript, "init"], scriptOptions);
    await execFileAsync(
      process.execPath,
      [stateScript, "record", "design", '{"summary":"done"}'],
      scriptOptions,
    );
    await expect(
      execFileAsync(
        process.execPath,
        [guardScript, "exit", "design", "--apply"],
        scriptOptions,
      ),
    ).rejects.toThrow(/missing Output Schema artifacts/iu);
    await fs.writeFile(path.join(project, "design.tsv"), "primer\n");
    await expect(
      execFileAsync(
        process.execPath,
        [guardScript, "exit", "design", "--apply"],
        scriptOptions,
      ),
    ).resolves.toMatchObject({ stdout: expect.stringContaining("NEXT: done") });
  });
});

async function listFiles(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative);
  const entries = (await fs.readdir(directory, { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name),
  );
  const files: string[] = [];
  for (const entry of entries) {
    const next = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(root, next)));
    else files.push(next.split(path.sep).join("/"));
  }
  return files;
}
