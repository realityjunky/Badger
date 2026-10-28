import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

describe("Badger discovery CLI", () => {
  let root: string;
  let project: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-cli-discovery-"));
    project = path.join(root, "project");
    await fs.mkdir(project, { recursive: true });
  });

  afterEach(async () => fs.rm(root, { recursive: true, force: true }));

  async function writeSkill(directory: string, name: string): Promise<void> {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} skill.\n---\n\n# ${name}\n`,
    );
  }

  async function runCli(...args: string[]): Promise<Record<string, unknown>> {
    return runCliWith({}, ...args);
  }

  async function runCliWith(
    env: NodeJS.ProcessEnv,
    ...args: string[]
  ): Promise<Record<string, unknown>> {
    const result = await execFileAsync(
      process.execPath,
      ["bin/badger.js", ...args, "--json"],
      {
        cwd: path.resolve(process.cwd()),
        env: { ...process.env, BADGER_SOURCE_ROOTS: undefined, ...env },
      },
    );
    return JSON.parse(result.stdout) as Record<string, unknown>;
  }

  it("keeps guide read-only and independent of preference files", async () => {
    await fs.mkdir(path.join(project, ".badger"), { recursive: true });
    await fs.writeFile(
      path.join(project, ".badger", "skill-preferences.yaml"),
      "invalid: preference state\n",
    );

    const result = await runCli("guide", "--project", project);

    expect(result).toMatchObject({
      schemaVersion: 1,
      intent: ["new-skill", "upgrade-existing"],
      resumable: [],
    });
    expect(result).not.toHaveProperty("preferenceFile");
    expect(result).not.toHaveProperty("preferences");
  });

  it("only returns explicitly supplied sources and accepts manifests", async () => {
    const explicit = path.join(project, "supplied", "review");
    const ambient = path.join(project, ".agents", "skills", "ambient");
    await writeSkill(explicit, "review");
    await writeSkill(ambient, "ambient");
    const manifest = path.join(project, "sources.json");
    await fs.writeFile(
      manifest,
      JSON.stringify({
        schemaVersion: 1,
        sources: [{ name: "review", location: "supplied/review" }],
      }),
    );

    const empty = await runCli("candidates", "--project", project);
    expect(empty.candidates).toEqual([]);

    const explicitResult = await runCli(
      "candidates",
      "--project",
      project,
      "--skill",
      "review=supplied/review",
    );
    expect(explicitResult.candidates).toMatchObject([
      { name: "review", status: "available" },
    ]);

    const manifestResult = await runCli(
      "candidates",
      "--project",
      project,
      "--source-manifest",
      manifest,
    );
    expect(manifestResult.candidates).toMatchObject([
      { name: "review", status: "available" },
    ]);
  });

  it("presents the source check and keeps the candidates name working", async () => {
    const explicit = path.join(project, "supplied", "review");
    await writeSkill(explicit, "review");
    await fs.mkdir(path.join(explicit, "scripts"), { recursive: true });
    await fs.writeFile(path.join(explicit, "scripts", "fetch.py"), "# fetch\n");
    const manifest = path.join(project, "sources.json");
    await fs.writeFile(
      manifest,
      JSON.stringify({
        schemaVersion: 1,
        sources: [
          {
            name: "review",
            location: "supplied/review",
            scripts: { "scripts/fetch.py": "network" },
          },
        ],
      }),
    );

    const primary = await runCli(
      "source-check",
      "--project",
      project,
      "--source-manifest",
      manifest,
    );
    const legacy = await runCli(
      "candidates",
      "--project",
      project,
      "--source-manifest",
      manifest,
    );

    expect(primary).toEqual(legacy);
    expect(primary.candidates).toMatchObject([
      {
        name: "review",
        status: "available",
        sources: [
          {
            scripts: [{ path: "scripts/fetch.py", sideEffects: ["network"] }],
            ignored: [],
          },
        ],
      },
    ]);

    const help = await execFileAsync(process.execPath, [
      "bin/badger.js",
      "--help",
    ]);
    expect(help.stdout).toMatch(/source-check/iu);
  });

  it("confines absolute source locations to roots the host registers", async () => {
    const external = path.join(root, "external", "review");
    await writeSkill(external, "review");
    const manifest = path.join(project, "sources.json");
    await fs.writeFile(
      manifest,
      JSON.stringify({
        schemaVersion: 1,
        sources: [{ name: "review", location: external }],
      }),
    );
    const check = async (env: NodeJS.ProcessEnv, ...flags: string[]) =>
      (
        await runCliWith(
          env,
          "source-check",
          "--project",
          project,
          "--source-manifest",
          manifest,
          ...flags,
        )
      ).candidates;

    expect(await check({})).toMatchObject([
      { name: "review", status: "unsafe" },
    ]);
    expect(await check({}, "--source-root", "../external")).toMatchObject([
      { name: "review", status: "available" },
    ]);
    expect(
      await check({
        BADGER_SOURCE_ROOTS: ["../elsewhere", "../external"].join(
          path.delimiter,
        ),
      }),
    ).toMatchObject([{ name: "review", status: "available" }]);
    expect(
      await check(
        { BADGER_SOURCE_ROOTS: "../elsewhere" },
        "--source-root",
        "../external",
      ),
    ).toMatchObject([{ name: "review", status: "available" }]);
  });

  it("refuses a source manifest that registers its own roots", async () => {
    const external = path.join(root, "external", "review");
    await writeSkill(external, "review");
    const manifest = path.join(project, "sources.json");
    await fs.writeFile(
      manifest,
      JSON.stringify({
        schemaVersion: 1,
        roots: ["../external"],
        sources: [{ name: "review", location: external }],
      }),
    );

    const failure = await runCli(
      "source-check",
      "--project",
      project,
      "--source-manifest",
      manifest,
    ).then(
      () => undefined,
      (error: { code: number; stderr: string }) => error,
    );

    expect(failure?.code).not.toBe(0);
    expect(failure?.stderr).toMatch(/roots are registered by the host/iu);
  });
});
