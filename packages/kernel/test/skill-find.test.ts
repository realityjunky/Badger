import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findSkills, readSkillSourceManifest } from "../src/skill/find.js";

describe("closed-world Skill discovery", () => {
  let root: string;
  let project: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-find-"));
    project = path.join(root, "project");
    await fs.mkdir(project, { recursive: true });
  });

  afterEach(async () => fs.rm(root, { recursive: true, force: true }));

  async function writeSkill(
    directory: string,
    name: string,
    description = `${name} skill.`,
  ): Promise<void> {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    );
  }

  it("inspects only explicitly declared sources", async () => {
    const explicit = path.join(project, "supplied", "primer-design");
    await writeSkill(explicit, "primer-design");
    await writeSkill(
      path.join(project, ".agents", "skills", "ambient-project"),
      "ambient-project",
    );
    await writeSkill(
      path.join(root, "home", ".codex", "skills", "ambient-home"),
      "ambient-home",
    );

    const result = await findSkills({
      projectRoot: project,
      sources: [{ name: "primer-design", location: "supplied/primer-design" }],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "primer-design",
      status: "available",
    });
    expect(result[0]?.sources[0]).toMatchObject({
      name: "primer-design",
      root: await fs.realpath(explicit),
      description: "primer-design skill.",
      references: [],
      scripts: [],
    });
  });

  it("returns deterministic source evidence without executing scripts", async () => {
    const explicit = path.join(project, "supplied", "review");
    await writeSkill(explicit, "review", "Review supplied evidence.");
    await fs.mkdir(path.join(explicit, "references"), { recursive: true });
    await fs.mkdir(path.join(explicit, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(explicit, "references", "notes.md"),
      "notes\n",
    );
    const marker = path.join(project, "script-executed");
    await fs.writeFile(
      path.join(explicit, "scripts", "danger.sh"),
      `touch ${marker}\n`,
    );

    const declaration = [{ name: "review", location: "supplied/review" }];
    const first = await findSkills({
      projectRoot: project,
      sources: declaration,
    });
    const second = await findSkills({
      projectRoot: project,
      sources: declaration,
    });

    expect(first[0]?.sources[0]).toMatchObject({
      description: "Review supplied evidence.",
      references: [{ path: "references/notes.md" }],
      scripts: [{ path: "scripts/danger.sh", sideEffect: "undeclared" }],
      hash: second[0]?.sources[0]?.hash,
    });
    await expect(fs.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores a fixed set of operating-system and editor files in identity", async () => {
    const explicit = path.join(project, "supplied", "review");
    await writeSkill(explicit, "review");
    const declaration = [{ name: "review", location: "supplied/review" }];
    const before = await findSkills({
      projectRoot: project,
      sources: declaration,
    });

    for (const stray of [
      ".DS_Store",
      "Thumbs.db",
      ".#SKILL.md",
      ".idea/workspace.xml",
      ".vscode/settings.json",
      "__pycache__/review.cpython-312.pyc",
      "notes.md.swp",
      "notes.md~",
    ]) {
      const target = path.join(explicit, stray);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, "stray\n");
    }

    const after = await findSkills({
      projectRoot: project,
      sources: declaration,
    });

    expect(after[0]?.sources[0]?.hash).toBe(before[0]?.sources[0]?.hash);
    expect(after[0]?.sources[0]?.inventory.map((file) => file.path)).toEqual([
      "SKILL.md",
    ]);
  });

  it("inventories every file, configuration included, with its hash", async () => {
    const explicit = path.join(project, "supplied", "review");
    await writeSkill(explicit, "review");
    await fs.mkdir(path.join(explicit, "config"), { recursive: true });
    await fs.writeFile(
      path.join(explicit, "config", "thresholds.yaml"),
      "thresholds: 3\n",
    );
    await fs.mkdir(path.join(explicit, "notes"), { recursive: true });
    await fs.writeFile(path.join(explicit, "notes", "audit.md"), "notes\n");

    const result = await findSkills({
      projectRoot: project,
      sources: [{ name: "review", location: "supplied/review" }],
    });

    expect(result[0]?.sources[0]?.inventory).toEqual([
      {
        path: "SKILL.md",
        bytes: 58,
        hash: "1fb67a87fd7b13ba9ac18459b6ecaa575e45fcf8b497abf8962b0112e790c00b",
      },
      {
        path: "config/thresholds.yaml",
        bytes: 14,
        hash: "5d1bf0c8e127ed1e9f62194409717477960c7a0c212ccd5c625bebdad74bc883",
      },
      {
        path: "notes/audit.md",
        bytes: 6,
        hash: "444e0fffbd825e9610ff5b199485707a0c895339ae80c15cc8a8aee41b106fda",
      },
    ]);
  });

  it("reports each script's declared side effect and marks undeclared ones", async () => {
    const explicit = path.join(project, "supplied", "review");
    await writeSkill(explicit, "review");
    await fs.mkdir(path.join(explicit, "scripts"), { recursive: true });
    for (const script of ["add.py", "download.py", "local.sh"])
      await fs.writeFile(path.join(explicit, "scripts", script), "# script\n");

    const result = await findSkills({
      projectRoot: project,
      sources: [
        {
          name: "review",
          location: "supplied/review",
          scripts: {
            "scripts/add.py": "scheduler-submission",
            "scripts/download.py": "network",
          },
        },
      ],
    });

    expect(result[0]?.sources[0]?.scripts).toEqual([
      { path: "scripts/add.py", sideEffect: "scheduler-submission" },
      { path: "scripts/download.py", sideEffect: "network" },
      { path: "scripts/local.sh", sideEffect: "undeclared" },
    ]);
  });

  it("rejects a manifest that declares an unknown side effect", async () => {
    const manifest = path.join(project, "sources.json");
    await fs.writeFile(
      manifest,
      JSON.stringify({
        schemaVersion: 1,
        sources: [
          {
            name: "review",
            location: "supplied/review",
            scripts: { "scripts/add.py": "reads-only" },
          },
        ],
      }),
    );

    await expect(readSkillSourceManifest(manifest)).rejects.toThrow(
      /side effect/iu,
    );
  });

  it("rejects a manifest script path that escapes the source", async () => {
    const manifest = path.join(project, "sources.json");
    await fs.writeFile(
      manifest,
      JSON.stringify({
        schemaVersion: 1,
        sources: [
          {
            name: "review",
            location: "supplied/review",
            scripts: { "../outside.py": "none" },
          },
        ],
      }),
    );

    await expect(readSkillSourceManifest(manifest)).rejects.toThrow(
      /script path/iu,
    );
  });

  it("reports missing, invalid, and unsafe declarations as blockers", async () => {
    const outside = path.join(root, "outside");
    await writeSkill(outside, "outside");
    await fs.mkdir(path.join(project, "project-file"), { recursive: true });
    await fs.symlink(outside, path.join(project, "escape"));

    const result = await findSkills({
      projectRoot: project,
      sources: [
        { name: "missing", location: "missing" },
        { name: "invalid", location: "project-file" },
        { name: "escape", location: "escape" },
      ],
    });

    expect(result.map((candidate) => candidate.status)).toEqual([
      "missing",
      "invalid",
      "unsafe",
    ]);
    expect(result[0]?.blockers?.join(" ")).toMatch(/does not exist/u);
    expect(result[2]?.blockers?.join(" ")).toMatch(/escapes/u);
  });

  it("rejects a relative symlink that escapes the project root", async () => {
    const outside = path.join(root, "outside");
    await writeSkill(outside, "outside");
    await fs.symlink(outside, path.join(project, "escape"));

    const result = await findSkills({
      projectRoot: project,
      sources: [{ name: "outside", location: "escape" }],
    });

    expect(result[0]?.status).toBe("unsafe");
  });

  it("rejects a Skill whose frontmatter name differs from its declaration", async () => {
    const explicit = path.join(project, "supplied", "wrong-name");
    await writeSkill(explicit, "actual-name");

    const result = await findSkills({
      projectRoot: project,
      sources: [{ name: "declared-name", location: "supplied/wrong-name" }],
    });

    expect(result[0]?.status).toBe("invalid");
    expect(result[0]?.blockers?.join(" ")).toMatch(
      /declares name actual-name/iu,
    );
  });

  it("blocks duplicate names even when locations differ", async () => {
    const first = path.join(project, "one", "review");
    const second = path.join(project, "two", "review");
    await writeSkill(first, "review");
    await writeSkill(second, "review");

    const result = await findSkills({
      projectRoot: project,
      sources: [
        { name: "review", location: "one/review" },
        { name: "review", location: "two/review" },
      ],
    });

    expect(result[0]?.status).toBe("ambiguous");
    expect(result[0]?.sources).toHaveLength(2);
    expect(result[0]?.blockers?.join(" ")).toMatch(
      /duplicate.*exactly one location/iu,
    );
  });

  it("deduplicates repeated declarations for one canonical location", async () => {
    const explicit = path.join(project, "one", "review");
    await writeSkill(explicit, "review");

    const result = await findSkills({
      projectRoot: project,
      sources: [
        { name: "review", location: "one/review" },
        { name: "review", location: "one/./review" },
      ],
    });

    expect(result[0]?.status).toBe("available");
    expect(result[0]?.sources).toHaveLength(1);
    expect(result[0]?.blockers).toBeUndefined();
  });

  it("refuses an absolute source outside the project and registered roots", async () => {
    const outside = path.join(root, "external", "review");
    await writeSkill(outside, "review");

    const result = await findSkills({
      projectRoot: project,
      sources: [{ name: "review", location: outside }],
    });

    expect(result[0]?.status).toBe("unsafe");
    expect(result[0]?.sources).toEqual([]);
    expect(result[0]?.blockers?.join(" ")).toMatch(/registered root/iu);
  });

  it("accepts an absolute source inside the project", async () => {
    const explicit = path.join(project, "supplied", "review");
    await writeSkill(explicit, "review");

    const result = await findSkills({
      projectRoot: project,
      sources: [{ name: "review", location: explicit }],
    });

    expect(result[0]).toMatchObject({ name: "review", status: "available" });
  });

  it("accepts an absolute source inside a registered root", async () => {
    const explicit = path.join(root, "external", "review");
    await writeSkill(explicit, "review");

    const result = await findSkills({
      projectRoot: project,
      roots: [path.join(root, "external")],
      sources: [{ name: "review", location: explicit }],
    });

    expect(result[0]).toMatchObject({ name: "review", status: "available" });
    expect(result[0]?.sources[0]?.root).toBe(await fs.realpath(explicit));
  });

  it("resolves a registered root through a symbolic link", async () => {
    const explicit = path.join(root, "external", "review");
    await writeSkill(explicit, "review");
    await fs.symlink(path.join(root, "external"), path.join(project, "linked"));

    const result = await findSkills({
      projectRoot: project,
      roots: ["linked"],
      sources: [{ name: "review", location: explicit }],
    });

    expect(result[0]).toMatchObject({ name: "review", status: "available" });
  });
});
