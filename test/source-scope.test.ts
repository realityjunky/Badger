import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

function files(root: string, result: string[] = []): string[] {
  for (const entry of readdirSync(root)) {
    const target = path.join(root, entry);
    if (statSync(target).isDirectory()) files(target, result);
    else result.push(path.relative(process.cwd(), target));
  }
  return result;
}

describe("standalone package scope", () => {
  it("contains no host workflow or installer imports", () => {
    const root = path.resolve("src");
    const forbidden =
      /platform-install|platforms\.js|@earendil-works\/pi-coding-agent/u;
    for (const file of files(root))
      expect(readFileSync(file, "utf8"), file).not.toMatch(forbidden);
  });
});
