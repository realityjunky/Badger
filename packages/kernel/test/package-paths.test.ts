import { describe, expect, it } from "vitest";
import { verifyPackageSnapshot } from "../src/index.js";

const file = (path: string) => ({
  path,
  content: Buffer.from("package").toString("base64"),
});
const verify = (paths: string[]) =>
  verifyPackageSnapshot({
    packageHash: "0".repeat(64),
    inventory: [],
    files: paths.map(file),
  });

describe("portable package paths", () => {
  it.each([
    "CON",
    "aux.txt",
    "src/NUL.json",
    "PRN",
    "COM1.md",
    "lpt9",
    "COM¹.txt",
    "trailing./file",
    "trailing /file",
    "a<b",
    "a>b",
    "a:b",
    'a"b',
    "a|b",
    "a?b",
    "a*b",
    "a\u0001b",
    "a\u007fb",
  ])("refuses the nonportable path %j and names it", (path) => {
    expect(() => verify([path])).toThrow(path);
  });

  it.each([
    ["SKILL.md", "skill.md"],
    ["caf\u00e9.md", "cafe\u0301.md"],
    ["Sources/a.md", "sources/b.md"],
    ["source", "SOURCE/file.md"],
  ])("refuses aliased package paths %j and %j", (first, second) => {
    expect(() => verify([first, second])).toThrow(second);
  });
});
