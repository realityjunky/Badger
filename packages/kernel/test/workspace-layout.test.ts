import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

async function readText(relativePath: string): Promise<string> {
  return fs.readFile(path.join(repositoryRoot, relativePath), "utf8");
}

async function readJson(
  relativePath: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(await readText(relativePath)) as Record<string, unknown>;
}

describe("Badger npm workspace", () => {
  it("keeps the kernel's published name, CLI, exports, and license in its workspace package", async () => {
    const workspace = await readJson("package.json");
    expect(workspace.private).toBe(true);
    expect(workspace.workspaces).toEqual(
      expect.arrayContaining(["packages/kernel"]),
    );

    const kernel = await readJson("packages/kernel/package.json");
    expect(kernel).toMatchObject({
      name: "@realityjunky/badger",
      bin: { badger: "bin/badger.js" },
    });
    expect(Object.keys(kernel.exports as Record<string, unknown>)).toEqual([
      ".",
      "./engine",
      "./workflow-runtime",
      "./skill-runtime",
      "./prompts",
      "./cli",
    ]);
    expect(await readText("packages/kernel/LICENSE")).toBe(
      await readText("LICENSE"),
    );
  });

  it("tells contributors where new workspace packages go", async () => {
    for (const relativePath of ["AGENTS.md", "README.md"]) {
      const prose = (await readText(relativePath)).replace(/\s+/gu, " ");
      expect(prose, relativePath).toContain("`packages/kernel/`");
      expect(prose, relativePath).toContain("`packages/<name>/`");
    }
  });
});
