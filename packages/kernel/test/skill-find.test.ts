import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findSkills } from "../src/skill/find.js";

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
      scripts: [{ path: "scripts/danger.sh", sideEffect: "unknown" }],
      hash: second[0]?.sources[0]?.hash,
    });
    await expect(fs.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
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

  it("accepts absolute source locations", async () => {
    const explicit = path.join(root, "external", "review");
    await writeSkill(explicit, "review");

    const result = await findSkills({
      projectRoot: project,
      sources: [{ name: "review", location: explicit }],
    });

    expect(result[0]).toMatchObject({ name: "review", status: "available" });
    expect(result[0]?.sources[0]?.root).toBe(await fs.realpath(explicit));
  });
});
