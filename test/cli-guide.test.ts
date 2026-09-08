import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

describe("Badger guide CLI", () => {
  let root: string;
  let project: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-cli-guide-"));
    project = path.join(root, "project");
    await fs.mkdir(project, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("exposes explicit FactoryPlan context without changing the plan", async () => {
    const planPath = path.join(project, "plan.json");
    const plan = {
      schemaVersion: 1,
      goal: "Create a prepared workflow.",
      skillCreatorIntent: "new-skill",
      skillSources: [{ name: "prepare", location: "skills/prepare" }],
      defaultLocale: "en",
      workflow: {
        kind: "workflow-kernel",
        name: "prepared-workflow",
        goal: "Prepare the requested work.",
        customNodes: [],
        outputSchemas: [],
      },
    };
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2) + "\n");
    const before = await fs.readFile(planPath, "utf8");

    const result = await execFileAsync(
      process.execPath,
      [
        "bin/badger.js",
        "guide",
        "--project",
        project,
        "--plan",
        "plan.json",
        "--json",
      ],
      { cwd: path.resolve(process.cwd()) },
    );
    const guide = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(guide).toMatchObject({
      firstUse: false,
      questionnaire: { mode: "manual-refinement" },
      factoryPlans: [
        {
          path: planPath,
          status: "available",
          workflowName: "prepared-workflow",
        },
      ],
    });
    await expect(fs.readFile(planPath, "utf8")).resolves.toBe(before);
  });
});
