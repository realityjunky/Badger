import { describe, expect, it } from "vitest";
import { gitFolderPath } from "../src/api/skills.js";

describe("a folder selection's .git check", () => {
  it("names the first path with a segment the service refuses as Git metadata", () => {
    for (const segment of [
      ".git",
      ".GIT",
      ".Git.",
      ".git ",
      ".g\u200cit",
      ".gi\ufefft",
      ".git\u200e.",
    ])
      expect(
        gitFolderPath([
          "example/SKILL.md",
          `example/reference/${segment}/config`,
          "example/.git/HEAD",
        ]),
        JSON.stringify(segment),
      ).toBe(`example/reference/${segment}/config`);
    expect(gitFolderPath([".git/SKILL.md"])).toBe(".git/SKILL.md");
  });

  it("accepts names that only contain .git", () => {
    expect(
      gitFolderPath([
        "example/SKILL.md",
        "example/.gitignore",
        "example/.github/workflows/check.yml",
        "example/notes.git/README.md",
        "example/git/config",
      ]),
    ).toBeNull();
  });
});
