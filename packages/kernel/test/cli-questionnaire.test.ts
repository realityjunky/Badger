import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { questionnaireFixture } from "./fixtures/semantic-dossier.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("questionnaire handoff CLI", () => {
  it("returns incomplete, stopped, and resolved handoffs without writing project state", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-questionnaire-cli-"),
    );
    roots.push(root);
    const { dossier, factoryPlan } = questionnaireFixture();
    dossier.remainingQuestions.push({
      id: "recovery",
      field: "topics.recoveryPolicy",
      question: "Where should repair resume?",
    });
    const dossierPath = path.join(root, "dossier.json");
    const planPath = path.join(root, "plan.json");
    await fs.writeFile(dossierPath, JSON.stringify(dossier));
    await fs.writeFile(planPath, JSON.stringify(factoryPlan));
    const args = [
      "bin/badger.js",
      "questionnaire-handoff",
      "dossier.json",
      "--plan",
      "plan.json",
      "--project",
      root,
      "--json",
    ];
    const failure = await execFileAsync(process.execPath, args).catch(
      (error: { code: number; stdout: string }) => error,
    );
    expect(failure).toHaveProperty("code", 1);
    const incomplete = JSON.parse(failure.stdout);
    expect(incomplete.status).toBe("incomplete");
    const stopped = JSON.parse(
      (
        await execFileAsync(process.execPath, [
          ...args,
          "--stopped",
          "--existing-context",
          "plan.json",
        ])
      ).stdout,
    );
    expect(stopped).toMatchObject({
      status: "stopped",
      existingContext: "plan.json",
      dossierHash: incomplete.dossierHash,
    });
    expect(await fs.readFile(dossierPath, "utf8")).toBe(
      JSON.stringify(dossier),
    );
    dossier.remainingQuestions = [];
    dossier.deferredQuestions.push({
      id: "column-contract",
      field: "interfaces",
      question: "Which columns does the receiving Skill read?",
      resolution: {
        outcome: "deferred",
        scope: "skill",
        reason: "Internal to the receiving Skill; fixed in its next revision.",
      },
    });
    await fs.writeFile(dossierPath, JSON.stringify(dossier));
    const complete = JSON.parse(
      (await execFileAsync(process.execPath, args)).stdout,
    );
    expect(complete).toMatchObject({
      status: "complete",
      nextAction: "factory-plan-confirmation",
      nextReadOnlyCommand: null,
    });
    expect(complete.factoryPlan.semanticDossier).toEqual(dossier);
    expect((await fs.readdir(root)).sort()).toEqual([
      "dossier.json",
      "plan.json",
    ]);
    expect(await fs.readFile(planPath, "utf8")).toBe(
      JSON.stringify(factoryPlan),
    );
  });

  it("refuses a retired version 1 dossier with a migration finding", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-questionnaire-cli-"),
    );
    roots.push(root);
    const { dossier, factoryPlan } = questionnaireFixture();
    const legacy = { ...dossier, schemaVersion: 1 };
    await fs.writeFile(path.join(root, "dossier.json"), JSON.stringify(legacy));
    await fs.writeFile(
      path.join(root, "plan.json"),
      JSON.stringify(factoryPlan),
    );
    const failure = await execFileAsync(process.execPath, [
      "bin/badger.js",
      "questionnaire-handoff",
      "dossier.json",
      "--plan",
      "plan.json",
      "--project",
      root,
      "--json",
    ]).catch((error: { code: number; stdout: string }) => error);
    expect(failure.code).toBe(1);
    expect(JSON.parse(failure.stdout).diagnostics).toContainEqual(
      expect.objectContaining({
        path: "schemaVersion",
        message: expect.stringContaining("version 1 is retired"),
      }),
    );
  });
});
