import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AUTHORING_PROTOCOL } from "../src/authoring/protocol.js";
import {
  BADGER_AUTHORING_OUTPUT_ENVELOPE,
  EXPECTED_BADGER_AUTHORING_EXTENSIONS,
  OFFICIAL_AUTHORING_OUTPUT_ENVELOPE,
  canonicalizeAuthoringProtocol,
  compareAuthoringOutputEnvelopes,
  compareAuthoringProtocols,
} from "../src/differential/authoring/certification.js";
import { runAuthoringDifferentialHarness } from "../src/differential/authoring/run.js";
import type { OfficialCommandRunner } from "../src/differential/types.js";

const OFFICIAL_BACKBONE = [
  "reference/workflow-protocol.json",
  "scripts/workflow-state.mjs",
  "scripts/workflow-guard.mjs",
  "scripts/workflow-handoff.mjs",
  "scripts/comet-plan.mjs",
  "scripts/comet-check.mjs",
  "scripts/comet-hook-guard.mjs",
  "bundle.yaml",
  "comet/skill.yaml",
  "comet/guardrails.yaml",
  "comet/checks.yaml",
  "comet/eval.yaml",
  "reference/resolved-skills.json",
  "reference/composition-report.md",
  "reference/authoring-lanes.json",
];

const OFFICIAL_REVISION = "99fd7495f8b9217efbaae3a46d885f6fa7f4102a";

async function writeSyntheticFixture(root: string): Promise<{
  fixturePath: string;
  skillsRoot: string;
}> {
  const fixtureRoot = path.join(root, "fixture");
  const skillsRoot = path.join(fixtureRoot, "skills");
  const skillRoot = path.join(skillsRoot, "prepare");
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(
    path.join(skillRoot, "SKILL.md"),
    "---\nname: prepare\ndescription: Prepare workflow.\n---\n\n# Prepare\n",
  );
  await fs.writeFile(
    path.join(fixtureRoot, "extraction-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      official: { revision: OFFICIAL_REVISION },
      reusableWorkflowKernel: { workflowContract: [] },
      excluded: {
        classic: [],
        native: [],
        entry: [],
        installer: [],
        engine: [],
        hostPlatform: [],
      },
    }),
  );
  const fixturePlan = {
    schemaVersion: 1,
    goal: "Create a prepared workflow.",
    skillCreatorIntent: "new-skill",
    preferredSkills: ["prepare"],
    defaultLocale: "en",
    workflow: {
      kind: "workflow-kernel",
      name: "prepared-workflow",
      goal: "Prepare workflow.",
      customNodes: [
        {
          id: "prepare",
          label: "Prepare",
          kind: "action",
          responsibility: "Prepare workflow.",
          implementation: {
            skill: "prepare",
            operation: "default",
            scope: "main",
          },
          operations: ["require", "augment", "disable"],
          outputSchemas: [],
          guardrails: [],
        },
      ],
      outputSchemas: [],
    },
  };
  const fixturePath = path.join(fixtureRoot, "prepared-workflow.json");
  await fs.writeFile(
    fixturePath,
    JSON.stringify({
      schemaVersion: 1,
      id: "prepared-workflow",
      skills: [{ name: "prepare", path: "skills/prepare" }],
      extractionManifest: "extraction-manifest.json",
      plan: fixturePlan,
    }),
  );
  return { fixturePath, skillsRoot };
}

async function writeSyntheticOfficialRoot(root: string): Promise<string> {
  const officialRoot = path.join(root, "official");
  const protocolPath = path.join(
    officialRoot,
    "assets/skills/comet-any/reference/authoring-protocol.json",
  );
  const officialProtocol = structuredClone(AUTHORING_PROTOCOL);
  officialProtocol.merge.deterministicBackbone = OFFICIAL_BACKBONE;
  await fs.mkdir(path.dirname(protocolPath), { recursive: true });
  await fs.writeFile(protocolPath, JSON.stringify(officialProtocol, null, 2));
  for (const relativePath of [
    "assets/skills/comet-any/SKILL.md",
    "domains/bundle/authoring.ts",
    "assets/skills/comet-any/reference/bundle-authoring.md",
    "assets/skills/comet-any/reference/authoring-subagents.md",
    "assets/skills/comet-any/reference/authored-zone-example.md",
    "assets/skills/comet-any/reference/eval-provider.md",
    "assets/skills/comet-any/reference/subagents/script-author.md",
    "assets/skills/comet-any/reference/subagents/reference-author.md",
    "assets/skills/comet-any/reference/subagents/pause-points-author.md",
    "assets/skills/comet-any/reference/subagents/workflow-entry-author.md",
    "assets/skills/comet-any/reference/subagents/skill-core-author.md",
    "assets/skills/comet-any/reference/subagents/skill-reviewer.md",
  ]) {
    const target = path.join(officialRoot, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `Synthetic upstream source: ${relativePath}\n`);
  }
  return officialRoot;
}

function syntheticOfficialRunner(): OfficialCommandRunner {
  return {
    async run(args, options) {
      if (args[0] === "creator" && args[1] === "candidates") {
        return { candidates: [] };
      }
      if (args[0] === "creator" && args[1] === "propose") {
        const fileIndex = args.indexOf("--file");
        const plan = JSON.parse(
          await fs.readFile(args[fileIndex + 1]!, "utf8"),
        ) as { workflow: unknown };
        return {
          canGenerate: true,
          blockers: [],
          warnings: [],
          planHash: "a".repeat(64),
          workflowProtocol: plan.workflow,
        };
      }
      if (args[0] === "creator" && args[1] === "init") return {};
      if (args[0] === "creator" && args[1] === "generate") {
        const root = path.join(
          options.cwd,
          ".comet",
          "bundle-drafts",
          args[2]!,
        );
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(path.join(root, "SKILL.md"), "# Authored\n");
        for (const relativePath of [
          `${args[2]}-prepare/SKILL.md`,
          "reference/decision-points.md",
          "reference/recovery.md",
          "reference/skill-review.md",
        ]) {
          const target = path.join(root, relativePath);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, "# Authored\n");
        }
        return { draftPath: root };
      }
      if (args[0] === "creator" && args[1] === "authoring-plan") {
        return {
          ...AUTHORING_PROTOCOL,
          name: args[2],
          protocolHash: "b".repeat(64),
        };
      }
      if (args[0] === "creator" && args[1] === "authoring-record") {
        return { status: "generated" };
      }
      if (args[0] === "creator" && args[1] === "status") {
        return { status: "generated" };
      }
      if (args[0] === "publish" && args[1] === "review") {
        return {
          readiness: {
            state: "blocked",
            blockers: ["Evaluation evidence missing"],
            warnings: [],
            evidence: {},
          },
        };
      }
      throw new Error(
        `Unexpected synthetic official command: ${args.join(" ")}`,
      );
    },
  };
}

describe("authoring differential certification", () => {
  it("reports exact parity for the shared authoring contract", () => {
    const official = canonicalizeAuthoringProtocol(
      AUTHORING_PROTOCOL,
      "official/authoring-protocol.json",
    );
    const badger = canonicalizeAuthoringProtocol(
      AUTHORING_PROTOCOL,
      "badger/authoring-protocol.json",
    );

    const comparison = compareAuthoringProtocols(official, badger);

    expect(comparison).toMatchObject({
      laneDagEqual: true,
      claimsEqual: true,
      reviewDepthEqual: true,
      contentLeavesEqual: true,
      deterministicBackboneEqual: true,
      semanticMismatches: [],
    });
  });

  it("classifies the Badger backbone layout as an expected extension", () => {
    const officialValue = structuredClone(AUTHORING_PROTOCOL);
    officialValue.merge.deterministicBackbone = OFFICIAL_BACKBONE;

    const official = canonicalizeAuthoringProtocol(
      officialValue,
      "official/authoring-protocol.json",
    );
    const badger = canonicalizeAuthoringProtocol(
      AUTHORING_PROTOCOL,
      "badger/authoring-protocol.json",
    );

    const comparison = compareAuthoringProtocols(official, badger);

    expect(comparison.deterministicBackboneEqual).toBe(false);
    expect(comparison.expectedExtensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: "deterministic-backbone",
          classification: "expected-extension",
        }),
      ]),
    );
    expect(comparison.semanticMismatches).toEqual([]);
  });

  it("detects a semantic lane-DAG mismatch", () => {
    const officialValue = structuredClone(AUTHORING_PROTOCOL);
    officialValue.dag.wave2 = ["skill-core", "workflow-entry"];

    const comparison = compareAuthoringProtocols(
      canonicalizeAuthoringProtocol(
        officialValue,
        "official/authoring-protocol.json",
      ),
      canonicalizeAuthoringProtocol(
        AUTHORING_PROTOCOL,
        "badger/authoring-protocol.json",
      ),
    );

    expect(comparison.laneDagEqual).toBe(false);
    expect(comparison.semanticMismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: "lane-dag",
          classification: "semantic-mismatch",
        }),
      ]),
    );
  });

  it("keeps Badger output fields separate from upstream compatibility", () => {
    const comparison = compareAuthoringOutputEnvelopes(
      OFFICIAL_AUTHORING_OUTPUT_ENVELOPE,
      BADGER_AUTHORING_OUTPUT_ENVELOPE,
    );

    expect(comparison).toMatchObject({ equal: false, compatible: true });
    expect(comparison.expectedExtensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: "output-envelope",
          classification: "expected-extension",
        }),
      ]),
    );
    expect(comparison.semanticMismatches).toEqual([]);
  });

  it("records each documented Badger extension category", () => {
    expect(
      new Set(
        EXPECTED_BADGER_AUTHORING_EXTENSIONS.map(
          (extension) => extension.category,
        ),
      ),
    ).toEqual(
      new Set([
        "naming",
        "namespace",
        "storage",
        "recovery",
        "concurrency",
        "hash",
      ]),
    );
  });

  it("runs the complete synthetic authoring lifecycle through readiness", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-authoring-differential-test-"),
    );
    try {
      const fixture = await writeSyntheticFixture(root);
      const officialRoot = await writeSyntheticOfficialRoot(root);
      const report = await runAuthoringDifferentialHarness({
        repositoryRoot: path.resolve(process.cwd()),
        fixturePath: fixture.fixturePath,
        fixtureSkillsRoot: fixture.skillsRoot,
        officialRoot,
        officialRevision: OFFICIAL_REVISION,
        officialRunner: syntheticOfficialRunner(),
      });

      expect(report.certification.status).toBe("certified");
      expect(report.fixture.unchanged).toBe(true);
      expect(report.official.unchanged).toBe(true);
      expect(report.official.observation.completedLanes).toHaveLength(6);
      expect(report.badger.observation.completedLanes).toHaveLength(6);
      expect(report.badger.observation.identities.assembledPackageHash).toMatch(
        /^[a-f0-9]{64}$/u,
      );
      expect(report.badger.observation.artifactOwners).toMatchObject({
        "SKILL.md": "authored",
        "reference/workflow-protocol.json": "auto",
      });
      expect(report.badger.observation.readiness.authoring.state).toBe("ready");
      expect(report.comparison.lifecycleComplete).toBe(true);
      expect(report.comparison.semanticMismatches).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
