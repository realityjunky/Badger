import { describe, expect, it } from "vitest";
import {
  gitFolderPath,
  undeclaredScripts,
  type VersionPreview,
} from "../src/api/skills.js";

const preview: VersionPreview = {
  hash: "0".repeat(64),
  description: "Example Skill",
  inventory: [],
  scripts: [
    { path: "scripts/fetch.sh", sideEffects: "undeclared" },
    { path: "scripts/run.sh", sideEffects: "undeclared" },
  ],
};

describe("an upload's script declarations", () => {
  it("lists every script still without a declaration", () => {
    expect(undeclaredScripts(preview, {})).toEqual([
      "scripts/fetch.sh",
      "scripts/run.sh",
    ]);
    expect(
      undeclaredScripts(preview, { "scripts/run.sh": [], "x.sh": ["none"] }),
    ).toEqual(["scripts/fetch.sh", "scripts/run.sh"]);
  });

  it("counts none as a declaration", () => {
    expect(
      undeclaredScripts(preview, {
        "scripts/fetch.sh": ["network"],
        "scripts/run.sh": ["none"],
      }),
    ).toEqual([]);
  });
});

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
