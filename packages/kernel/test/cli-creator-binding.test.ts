import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface CliFailure {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["bin/badger.js", ...args], {
    cwd: path.resolve(process.cwd()),
  });
}

async function fail(args: string[]): Promise<CliFailure> {
  return execFileAsync(process.execPath, ["bin/badger.js", ...args], {
    cwd: path.resolve(process.cwd()),
  }).catch((error: CliFailure) => error);
}

describe("Badger Creator boundary CLI", () => {
  let project: string;
  let skillRoot: string;
  let planPath: string;

  beforeEach(async () => {
    project = await fs.mkdtemp(path.join(os.tmpdir(), "badger-cli-binding-"));
    skillRoot = path.join(project, "skills", "primer-design");
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.writeFile(
      path.join(skillRoot, "SKILL.md"),
      "---\nname: primer-design\ndescription: Primer design.\n---\n\n# Primer Design\n",
    );
    planPath = path.join(project, "plan.json");
    await fs.writeFile(
      planPath,
      JSON.stringify(plan("Create primers."), null, 2),
    );
  });

  afterEach(async () => fs.rm(project, { recursive: true, force: true }));

  function plan(goal: string) {
    return {
      schemaVersion: 1,
      goal,
      skillCreatorIntent: "new-skill",
      skillSources: [{ name: "primer-design", location: skillRoot }],
      defaultLocale: "en",
      workflow: {
        kind: "workflow-kernel",
        name: "primer-workflow",
        goal,
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
  }

  async function propose(): Promise<{ proposalHash: string }> {
    return JSON.parse(
      (await run(["propose", planPath, "--project", project, "--json"])).stdout,
    ) as { proposalHash: string };
  }

  it("requires the approved proposal hash before initialization", async () => {
    const missing = await fail([
      "init",
      planPath,
      "--project",
      project,
      "--confirm",
      "--json",
    ]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/--proposal/iu);
  });

  it("refuses a plan edited after the proposal and initializes the approved one", async () => {
    const approved = await propose();
    await fs.writeFile(planPath, JSON.stringify(plan("Edited after review.")));
    const drift = await fail([
      "init",
      planPath,
      "--proposal",
      approved.proposalHash,
      "--project",
      project,
      "--confirm",
      "--json",
    ]);
    expect(drift.code).toBe(1);
    expect(drift.stderr).toMatch(/stale/iu);

    await fs.writeFile(planPath, JSON.stringify(plan("Create primers.")));
    const created = JSON.parse(
      (
        await run([
          "init",
          planPath,
          "--proposal",
          approved.proposalHash,
          "--project",
          project,
          "--confirm",
          "--json",
        ])
      ).stdout,
    ) as { name: string; stateHash: string };
    expect(created.name).toBe("primer-workflow");
    expect(created.stateHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("replaces existing Creator state only when the caller quotes its hash", async () => {
    const approved = await propose();
    const created = JSON.parse(
      (
        await run([
          "init",
          planPath,
          "--proposal",
          approved.proposalHash,
          "--project",
          project,
          "--confirm",
          "--json",
        ])
      ).stdout,
    ) as { stateHash: string };

    const refused = await fail([
      "init",
      planPath,
      "--proposal",
      approved.proposalHash,
      "--project",
      project,
      "--confirm",
      "--json",
    ]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(created.stateHash);

    const wrong = await fail([
      "init",
      planPath,
      "--proposal",
      approved.proposalHash,
      "--replace-state",
      "0".repeat(64),
      "--project",
      project,
      "--confirm",
      "--json",
    ]);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toMatch(/state hash/iu);

    const replaced = await run([
      "init",
      planPath,
      "--proposal",
      approved.proposalHash,
      "--replace-state",
      created.stateHash,
      "--project",
      project,
      "--confirm",
      "--json",
    ]);
    expect(JSON.parse(replaced.stdout).stateHash).toBe(created.stateHash);
  });

  it("generates only after confirmation and only from the approved proposal", async () => {
    const approved = await propose();
    await run([
      "init",
      planPath,
      "--proposal",
      approved.proposalHash,
      "--project",
      project,
      "--confirm",
      "--json",
    ]);

    const unconfirmed = await fail([
      "generate",
      "primer-workflow",
      "--project",
      project,
      "--json",
    ]);
    expect(unconfirmed.code).toBe(1);
    expect(unconfirmed.stderr).toMatch(/confirmation/iu);

    const generated = await run([
      "generate",
      "primer-workflow",
      "--project",
      project,
      "--confirm",
      "--json",
    ]);
    expect(JSON.parse(generated.stdout)).toMatchObject({
      name: "primer-workflow",
      status: "generated",
      proposalHash: approved.proposalHash,
    });

    await fs.writeFile(planPath, JSON.stringify(plan("Edited after init.")));
    const drift = await fail([
      "generate",
      "primer-workflow",
      "--project",
      project,
      "--confirm",
      "--json",
    ]);
    expect(drift.code).toBe(1);
    expect(drift.stderr).toMatch(/plan changed/iu);
  });

  it("refuses generation when the approved Skill source evidence changed", async () => {
    const approved = await propose();
    await run([
      "init",
      planPath,
      "--proposal",
      approved.proposalHash,
      "--project",
      project,
      "--confirm",
      "--json",
    ]);
    await fs.appendFile(path.join(skillRoot, "SKILL.md"), "\nChanged.\n");

    const drift = await fail([
      "generate",
      "primer-workflow",
      "--project",
      project,
      "--confirm",
      "--json",
    ]);
    expect(drift.code).toBe(1);
    expect(drift.stderr).toMatch(/source evidence/iu);
  });

  it("reports the blocker instead of blaming source drift", async () => {
    const approved = await propose();
    await run([
      "init",
      planPath,
      "--proposal",
      approved.proposalHash,
      "--project",
      project,
      "--confirm",
      "--json",
    ]);
    await fs.rm(skillRoot, { recursive: true, force: true });

    const blocked = await fail([
      "generate",
      "primer-workflow",
      "--project",
      project,
      "--confirm",
      "--json",
    ]);
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toMatch(/usable proposal/iu);
    expect(blocked.stderr).toMatch(/Unresolved Skill candidate/iu);
  });

  it("refuses generation when the state carries no approved proposal", async () => {
    const approved = await propose();
    await run([
      "init",
      planPath,
      "--proposal",
      approved.proposalHash,
      "--project",
      project,
      "--confirm",
      "--json",
    ]);
    const statePath = path.join(
      project,
      ".badger",
      "states",
      "primer-workflow.json",
    );
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as Record<
      string,
      unknown
    >;
    delete state.confirmedProposal;
    await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n");

    const missing = await fail([
      "generate",
      "primer-workflow",
      "--project",
      project,
      "--confirm",
      "--json",
    ]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/no approved proposal/iu);
  });

  it("refuses a Creator state that predates the approved-proposal binding", async () => {
    const approved = await propose();
    await run([
      "init",
      planPath,
      "--proposal",
      approved.proposalHash,
      "--project",
      project,
      "--confirm",
      "--json",
    ]);
    const statePath = path.join(
      project,
      ".badger",
      "states",
      "primer-workflow.json",
    );
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      confirmedProposal?: { proposalHash?: string };
    };
    delete state.confirmedProposal?.proposalHash;
    await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n");

    const legacy = await fail([
      "generate",
      "primer-workflow",
      "--project",
      project,
      "--confirm",
      "--json",
    ]);
    expect(legacy.code).toBe(1);
    expect(legacy.stderr).toMatch(/predates the approved-proposal binding/iu);
  });

  it("honors the JSON output flag", async () => {
    const json = await run([
      "propose",
      planPath,
      "--project",
      project,
      "--json",
    ]);
    expect(() => JSON.parse(json.stdout)).not.toThrow();

    const human = await run(["propose", planPath, "--project", project]);
    expect(() => JSON.parse(human.stdout)).toThrow();
    expect(human.stdout).toContain("planHash:");
    expect(human.stdout).toContain("proposalHash:");
  });
});
