import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
  }).then(
    ({ stdout }) => {
      throw new Error(`Expected badger ${args[0]} to fail:\n${stdout}`);
    },
    (error: CliFailure) => error,
  );
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

  function init(proposalHash: string, ...extra: string[]) {
    return [
      "init",
      planPath,
      "--proposal",
      proposalHash,
      "--project",
      project,
      ...extra,
    ];
  }

  const statePath = () =>
    path.join(project, ".badger", "states", "primer-workflow.json");

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

  it("requires confirmation before initialization", async () => {
    const approved = await propose();
    const unconfirmed = await fail(init(approved.proposalHash, "--json"));
    expect(unconfirmed.code).toBe(1);
    expect(unconfirmed.stderr).toMatch(/explicit proposal confirmation/iu);
    await expect(fs.stat(statePath())).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses initialization after a Skill source changed since the proposal", async () => {
    const approved = await propose();
    await fs.appendFile(path.join(skillRoot, "SKILL.md"), "\nChanged.\n");
    const stale = await fail(init(approved.proposalHash, "--confirm"));
    expect(stale.code).toBe(1);
    expect(stale.stderr).toMatch(/stale/iu);
    await expect(fs.stat(statePath())).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to initialize a blocked proposal", async () => {
    await fs.rm(skillRoot, { recursive: true, force: true });
    const blocked = await propose();
    const refused = await fail(init(blocked.proposalHash, "--confirm"));
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/Cannot initialize blocked proposal/u);
    await expect(fs.stat(statePath())).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("tells a pasted value that is not a hash apart from a stale one", async () => {
    const approved = await propose();
    const badProposal = await fail(init("proposalHash:", "--confirm"));
    expect(badProposal.code).toBe(1);
    expect(badProposal.stderr).toMatch(/Not a proposal hash/u);
    expect(badProposal.stderr).not.toMatch(/stale/iu);

    const badState = await fail(
      init(approved.proposalHash, "--replace-state", "abc", "--confirm"),
    );
    expect(badState.code).toBe(1);
    expect(badState.stderr).toMatch(/Not a Creator state hash/u);
  });

  it("refuses generation from an approved proposal edited in the state file", async () => {
    const approved = await propose();
    await run(init(approved.proposalHash, "--confirm", "--json"));
    const state = JSON.parse(await fs.readFile(statePath(), "utf8")) as {
      draftPath: string;
      confirmedProposal: { goal: string };
    };
    state.confirmedProposal.goal = "TAMPERED";
    await fs.writeFile(statePath(), JSON.stringify(state, null, 2) + "\n");

    const tampered = await fail([
      "generate",
      "primer-workflow",
      "--project",
      project,
      "--confirm",
      "--json",
    ]);
    expect(tampered.code).toBe(1);
    expect(tampered.stderr).toMatch(/does not match its proposal hash/u);
    await expect(
      fs.stat(path.resolve(project, state.draftPath, "SKILL.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prints the state hash that replacing a state with absolute paths accepts", async () => {
    const approved = await propose();
    await run(init(approved.proposalHash, "--confirm", "--json"));
    const stored = JSON.parse(await fs.readFile(statePath(), "utf8")) as {
      planPath: string;
      draftPath: string;
    };
    const absolute = {
      ...stored,
      planPath: path.resolve(project, stored.planPath),
      draftPath: path.resolve(project, stored.draftPath),
    };
    await fs.writeFile(statePath(), JSON.stringify(absolute, null, 2) + "\n");

    const refused = await fail(init(approved.proposalHash, "--confirm"));
    expect(refused.code).toBe(1);
    const printed = refused.stderr.match(/has hash ([a-f0-9]{64})/u)?.[1];
    expect(printed).toBeDefined();

    const replaced = JSON.parse(
      (
        await run(
          init(
            approved.proposalHash,
            "--replace-state",
            printed!,
            "--confirm",
            "--json",
          ),
        )
      ).stdout,
    ) as { stateHash: string; draftPath: string };
    expect(replaced.draftPath).toBe(absolute.draftPath);
    expect(replaced.stateHash).not.toBe(printed);
  });

  it("names a state file that no longer parses and replaces it by its hash", async () => {
    const approved = await propose();
    await fs.mkdir(path.dirname(statePath()), { recursive: true });
    await fs.writeFile(statePath(), "{ not json");

    const unreadable = await fail([
      "generate",
      "primer-workflow",
      "--project",
      project,
      "--confirm",
    ]);
    expect(unreadable.code).toBe(1);
    expect(unreadable.stderr).toMatch(/not valid JSON/u);
    expect(unreadable.stderr).not.toMatch(/SyntaxError/u);

    const refused = await fail(init(approved.proposalHash, "--confirm"));
    const garbledHash = refused.stderr.match(
      /is not valid JSON and has hash ([a-f0-9]{64})/u,
    )?.[1];
    expect(garbledHash).toBeDefined();
    await run(
      init(approved.proposalHash, "--replace-state", garbledHash!, "--confirm"),
    );
    expect(
      JSON.parse(await fs.readFile(statePath(), "utf8")) as { name: string },
    ).toMatchObject({ name: "primer-workflow" });
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
    expect(legacy.stderr).toMatch(/badger propose/u);
    expect(legacy.stderr).toMatch(/--replace-state [a-f0-9]{64}/u);
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

    const guideJson = await run(["guide", "--project", project, "--json"]);
    expect(JSON.parse(guideJson.stdout)).toHaveProperty("firstUse");
    const guideHuman = await run(["guide", "--project", project]);
    expect(() => JSON.parse(guideHuman.stdout)).toThrow();
    expect(guideHuman.stdout).toMatch(/^firstUse: /mu);

    const approved = JSON.parse(json.stdout) as { proposalHash: string };
    const initHuman = await run(init(approved.proposalHash, "--confirm"));
    expect(() => JSON.parse(initHuman.stdout)).toThrow();
    const stateHash = initHuman.stdout.match(/^stateHash: ([a-f0-9]{64})$/mu);
    expect(stateHash).not.toBeNull();
    const initJson = await run(
      init(
        approved.proposalHash,
        "--replace-state",
        stateHash![1]!,
        "--confirm",
        "--json",
      ),
    );
    expect(JSON.parse(initJson.stdout)).toMatchObject({
      name: "primer-workflow",
      stateHash: stateHash![1],
    });
  });

  it("matches a plan hash recorded before plan hashes became canonical", async () => {
    const approved = await propose();
    await run(init(approved.proposalHash, "--confirm"));
    const state = JSON.parse(await fs.readFile(statePath(), "utf8")) as {
      planHash: string;
    };
    state.planHash = createHash("sha256")
      .update(JSON.stringify(JSON.parse(await fs.readFile(planPath, "utf8"))))
      .digest("hex");
    await fs.writeFile(statePath(), JSON.stringify(state, null, 2) + "\n");

    const guide = JSON.parse(
      (await run(["guide", "--project", project, "--json"])).stdout,
    ) as { factoryPlans: Array<{ hashMatchesState?: boolean }> };
    expect(guide.factoryPlans[0]?.hashMatchesState).toBe(true);

    await fs.writeFile(planPath, JSON.stringify(plan("Edited after init.")));
    const edited = JSON.parse(
      (await run(["guide", "--project", project, "--json"])).stdout,
    ) as { factoryPlans: Array<{ hashMatchesState?: boolean }> };
    expect(edited.factoryPlans[0]?.hashMatchesState).toBe(false);
  });
});
