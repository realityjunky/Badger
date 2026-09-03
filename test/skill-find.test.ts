import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findSkills } from "../src/skill/find.js";

describe("standalone Skill discovery", () => {
  let root: string;
  let project: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-find-"));
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
    await fs.mkdir(path.join(directory, "references"));
    await fs.writeFile(
      path.join(directory, "references", "notes.md"),
      "notes\n",
    );
  }

  it("resolves preferred local Skills and preserves plural references", async () => {
    await writeSkill(
      path.join(project, ".agents", "skills", "primer-design"),
      "primer-design",
    );
    const result = await findSkills({
      projectRoot: project,
      preferences: [{ query: "primer-design", preferenceIndex: 0 }],
    });
    expect(result[0]).toMatchObject({
      query: "primer-design",
      status: "available",
      preferenceIndex: 0,
    });
    expect(result[0].sources[0].references[0].path).toBe("references/notes.md");
  });

  it("reports ambiguity without selecting a source", async () => {
    await writeSkill(
      path.join(project, ".agents", "skills", "review"),
      "review",
    );
    await writeSkill(
      path.join(project, ".codex", "skills", "review"),
      "review",
    );
    const result = await findSkills({
      projectRoot: project,
      preferences: [{ query: "review", preferenceIndex: 0 }],
    });
    expect(result[0].status).toBe("ambiguous");
    expect(result[0].sources).toHaveLength(2);
  });
});
