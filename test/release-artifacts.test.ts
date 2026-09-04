import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTHORING_CONTROL_PLANE_SCRIPTS,
  AUTHORING_DETERMINISTIC_BACKBONE,
  AUTHORING_LANE_IDS,
  AUTHORING_PROTOCOL,
} from "../src/authoring/index.js";

const repositoryRoot = process.cwd();

async function readText(relativePath: string): Promise<string> {
  return fs.readFile(path.join(repositoryRoot, relativePath), "utf8");
}

async function readJson(
  relativePath: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(await readText(relativePath)) as Record<string, unknown>;
}

function objectRecord(value: unknown): Record<string, unknown> {
  expect(value).toEqual(expect.any(Object));
  return value as Record<string, unknown>;
}

describe("Badger release artifacts", () => {
  it("ships the complete package-facing authoring reference set", async () => {
    const compatibility = await readJson(
      "test/fixtures/authoring/authoring-compatibility.json",
    );
    const documentation = objectRecord(compatibility.documentation);
    const references = documentation.references as string[];

    expect(references).toEqual(
      expect.arrayContaining([
        "assets/skills/badger/reference/authoring-protocol.json",
        "assets/skills/badger/reference/authoring-subagents.md",
        "assets/skills/badger/reference/bundle-authoring.md",
        "assets/skills/badger/reference/authored-zone-example.md",
        "assets/skills/badger/reference/eval-provider.md",
        "assets/skills/badger/reference/package-inventory.example.json",
      ]),
    );

    const packageManifest = await readJson("package.json");
    expect(packageManifest.files).toEqual(
      expect.arrayContaining(["assets", "README.md", "CHANGELOG.md"]),
    );

    for (const relativePath of [
      "assets/skills/badger/SKILL.md",
      ...references,
      ...AUTHORING_LANE_IDS.map(
        (lane) =>
          `assets/skills/badger/${AUTHORING_PROTOCOL.lanes[lane].brief}`,
      ),
    ]) {
      await expect(
        fs.stat(path.join(repositoryRoot, relativePath)),
      ).resolves.toMatchObject({
        isFile: expect.any(Function),
      });
    }
  });

  it("documents every assembled backbone path and content owner", async () => {
    const inventory = await readJson(
      "assets/skills/badger/reference/package-inventory.example.json",
    );
    const files = inventory.files as Array<Record<string, unknown>>;
    const entries = new Map(
      files.map((file) => [String(file.path), String(file.owner)]),
    );
    const expectedContentLeaves = [
      "SKILL.md",
      "prepared-workflow-prepare/SKILL.md",
      "reference/decision-points.md",
      "reference/recovery.md",
      "reference/skill-review.md",
    ];

    expect(inventory).toMatchObject({
      schemaVersion: 1,
      kind: "badger-package-inventory",
      status: "assembled",
    });
    expect(
      AUTHORING_CONTROL_PLANE_SCRIPTS.map((script) => script.path),
    ).toEqual(
      expect.arrayContaining([
        "scripts/workflow-state.mjs",
        "scripts/workflow-guard.mjs",
        "scripts/workflow-handoff.mjs",
        "scripts/badger-plan.mjs",
        "scripts/badger-check.mjs",
        "scripts/badger-hook-guard.mjs",
      ]),
    );

    for (const relativePath of [
      ...AUTHORING_DETERMINISTIC_BACKBONE,
      ...AUTHORING_LANE_IDS.map((lane) => AUTHORING_PROTOCOL.lanes[lane].brief),
      ...expectedContentLeaves,
    ]) {
      expect(entries.has(relativePath), relativePath).toBe(true);
    }

    for (const relativePath of expectedContentLeaves) {
      expect(entries.get(relativePath)).toBe("authored");
    }
    for (const relativePath of AUTHORING_DETERMINISTIC_BACKBONE) {
      expect(entries.get(relativePath)).toBe("auto");
    }

    expect(
      files.every((file) => {
        const relativePath = String(file.path);
        return (
          !path.isAbsolute(relativePath) &&
          !relativePath.split("/").includes("..")
        );
      }),
    ).toBe(true);

    const inventoryText = JSON.stringify(inventory);
    expect(inventoryText).not.toMatch(
      /\.badger|provider|credential|raw_data|authoringInputHash/u,
    );
  });

  it("keeps the compatibility fixture and workflow manual truthful", async () => {
    const compatibility = await readJson(
      "test/fixtures/authoring/authoring-compatibility.json",
    );
    const official = objectRecord(compatibility.official);
    const manual = await readText("docs/badger-workflow-manual.html");

    expect(official.revision).toBe("99fd7495f8b9217efbaae3a46d885f6fa7f4102a");
    expect(compatibility.knownUpstreamInconsistencies).toEqual(
      expect.arrayContaining([
        "skill-core-claims",
        "script-claim-scope",
        "content-leaf-shape",
      ]),
    );
    expect(compatibility.badgerExtensions).toEqual(
      expect.arrayContaining([
        "workflow-protocol-hash",
        "source-evidence-hash",
        "concrete-node-content-leaves",
        "authoring-plan-hash",
        "control-plane-naming",
      ]),
    );
    expect(manual).toContain("Integrated authoring delivered");
    expect(manual).toContain("集成式创作已交付");
    expect(manual).toContain("docs/release-artifacts.md");
    expect(manual).not.toContain("Integrated authoring target");
    expect(manual).not.toContain("计划中的创作恢复");
    expect(manual).not.toContain("authoring integration will expose");

    const localLinks = [...manual.matchAll(/href="([^"]+)"/gu)]
      .map((match) => match[1])
      .filter(
        (href) => href && !href.startsWith("#") && !/^[a-z]+:/iu.test(href),
      )
      .map((href) => href.split("#", 1)[0]);
    for (const relativePath of new Set(localLinks)) {
      await expect(
        fs.stat(path.resolve(repositoryRoot, "docs", relativePath)),
        relativePath,
      ).resolves.toMatchObject({ isFile: expect.any(Function) });
    }
  });
});
