import { describe, expect, it } from "vitest";
import { undeclaredScripts, type VersionPreview } from "../src/api/skills.js";

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
