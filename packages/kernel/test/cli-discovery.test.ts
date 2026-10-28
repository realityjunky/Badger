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
    const result = await execFileAsync(
      process.execPath,
      ["bin/badger.js", ...args, "--json"],
      { cwd: path.resolve(process.cwd()) },
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
          { scripts: [{ path: "scripts/fetch.py", sideEffect: "network" }] },
        ],
      },
    ]);

    const help = await execFileAsync(process.execPath, [
      "bin/badger.js",
      "--help",
    ]);
    expect(help.stdout).toMatch(/source-check/iu);
  });

  it("confines absolute source locations to registered roots", async () => {
    const external = path.join(root, "external", "review");
    await writeSkill(external, "review");
    const manifest = path.join(project, "sources.json");
    const writeManifest = async (roots?: string[]): Promise<void> =>
      fs.writeFile(
        manifest,
        JSON.stringify({
          schemaVersion: 1,
          ...(roots ? { roots } : {}),
          sources: [{ name: "review", location: external }],
        }),
      );

    await writeManifest();
    const refused = await runCli(
      "source-check",
      "--project",
      project,
      "--source-manifest",
      manifest,
    );
    expect(refused.candidates).toMatchObject([
      { name: "review", status: "unsafe" },
    ]);

    await writeManifest(["../external"]);
    const registered = await runCli(
      "source-check",
      "--project",
      project,
      "--source-manifest",
      manifest,
    );
    expect(registered.candidates).toMatchObject([
      { name: "review", status: "available" },
    ]);

    await writeManifest();
    const flagged = await runCli(
      "source-check",
      "--project",
      project,
      "--source-manifest",
      manifest,
      "--source-root",
      "../external",
    );
    expect(flagged.candidates).toMatchObject([
      { name: "review", status: "available" },
    ]);
  });
});
