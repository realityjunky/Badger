import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCreatorGuide } from "../src/factory/guide.js";
import type { FactoryPlan } from "../src/types.js";
import { sha256 } from "../src/util.js";

describe("Creator guide context", () => {
  let root: string;
  let project: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-factory-guide-"));
    project = path.join(root, "project");
    await fs.mkdir(project, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function plan(): FactoryPlan {
    return {
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
  }

  it("marks an empty project for automatic first-use questionnaire", async () => {
    await expect(
      readCreatorGuide({ projectRoot: project }),
    ).resolves.toMatchObject({
      schemaVersion: 1,
      firstUse: true,
      factoryPlans: [],
      resumable: [],
      questionnaire: {
        mode: "automatic-first-use",
        automatic: true,
      },
    });
  });

  it("reports an existing plan and resumable Creator state without mutation", async () => {
    const planPath = path.join(project, "plan.json");
    const planValue = plan();
    await fs.writeFile(planPath, JSON.stringify(planValue, null, 2) + "\n");
    const stateRoot = path.join(project, ".badger", "states");
    await fs.mkdir(stateRoot, { recursive: true });
    await fs.writeFile(
      path.join(stateRoot, "prepared-workflow.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          name: "prepared-workflow",
          status: "draft",
          projectRoot: project,
          planPath,
          planHash: sha256(JSON.stringify(planValue)),
          draftPath: path.join(
            project,
            ".badger",
            "drafts",
            "prepared-workflow",
          ),
          currentHash: null,
          candidates: [],
        },
        null,
        2,
      ) + "\n",
    );
    const before = await fs.readFile(planPath, "utf8");

    const guide = await readCreatorGuide({
      projectRoot: project,
      planPaths: [planPath],
    });

    expect(guide).toMatchObject({
      firstUse: false,
      questionnaire: {
        mode: "manual-refinement",
        automatic: false,
      },
      factoryPlans: [
        {
          path: planPath,
          status: "available",
          workflowName: "prepared-workflow",
          skillSources: [{ name: "prepare", location: "skills/prepare" }],
        },
      ],
      resumable: [
        {
          name: "prepared-workflow",
          classification: "uninitialized",
          factoryPlan: {
            hashMatchesState: true,
          },
        },
      ],
    });
    await expect(fs.readFile(planPath, "utf8")).resolves.toBe(before);
  });
});
