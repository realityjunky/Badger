import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findSkills,
  scriptEffectContract,
  scriptEffectReviewFindings,
  validateScriptEffectSuggestions,
} from "../src/index.js";

const source = {
  skillId: "skill-1",
  hash: "a".repeat(64),
  scripts: [{ path: "scripts/run.sh" }],
  inventory: [{ path: "scripts/run.sh", hash: "b".repeat(64), bytes: 20 }],
};

describe("script effect declarations", () => {
  it("keeps missing and uncertain script coverage pending until a person reviews the complete set", () => {
    expect(scriptEffectContract().labels.map((label) => label.value)).toEqual([
      "none",
      "local-writes",
      "network",
      "scheduler-submission",
      "installs",
    ]);
    expect(scriptEffectReviewFindings(source, [], false)).toEqual([
      expect.objectContaining({ code: "SCRIPT_EFFECTS_PENDING" }),
    ]);
    const [suggestion] = validateScriptEffectSuggestions(source, [
      {
        skillId: source.skillId,
        hash: source.hash,
        path: "scripts/run.sh",
        effects: ["local-writes"],
        rationale: "The helper creates an output file.",
        evidence: [
          {
            skillId: source.skillId,
            hash: source.hash,
            path: "scripts/run.sh",
            fileHash: "b".repeat(64),
            startLine: 1,
            endLine: 1,
          },
        ],
        conditionalBehavior: "Writes only with --output.",
        uncertainty: "Does the default also create a temporary file?",
      },
    ]);
    const rows = [{ ...suggestion!, reviewed: true, uncertaintyAnswer: "" }];
    expect(scriptEffectReviewFindings(source, rows, true)).toEqual([
      expect.objectContaining({ code: "SCRIPT_EFFECTS_PENDING" }),
    ]);
    rows[0]!.uncertaintyAnswer = "Yes; temporary files are local writes too.";
    expect(scriptEffectReviewFindings(source, rows, true)).toEqual([]);
    const incomplete = validateScriptEffectSuggestions(
      source,
      [{ ...rows[0], rationale: "", effects: [] }],
      true,
    );
    expect(scriptEffectReviewFindings(source, incomplete, true)).toEqual([
      expect.objectContaining({ code: "SCRIPT_EFFECTS_PENDING" }),
    ]);
    expect(scriptEffectReviewFindings(source, rows, false)).toEqual([
      expect.objectContaining({ code: "SCRIPT_EFFECTS_PENDING" }),
    ]);
    expect(
      scriptEffectReviewFindings({ ...source, scripts: [] }, [], false),
    ).toEqual([]);
  });

  it("binds a declaration revision to the exact scanned source and rejects malformed or mismatched bindings", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-effect-binding-"),
    );
    try {
      await fs.writeFile(
        path.join(root, "SKILL.md"),
        "---\nname: example\ndescription: Example\n---\n",
      );
      const declaration = { name: "example", location: "." };
      const [initial] = await findSkills({
        projectRoot: root,
        sources: [declaration],
      });
      const binding = {
        skillId: "skill-1",
        sourceHash: initial!.sources[0]!.hash,
        revision: 3,
        hash: "c".repeat(64),
      };
      const [bound] = await findSkills({
        projectRoot: root,
        sources: [{ ...declaration, effectDeclaration: binding }],
      });
      expect(bound!.sources[0]!.effectDeclaration).toEqual(binding);
      for (const invalid of [
        { ...binding, sourceHash: "d".repeat(64) },
        { ...binding, revision: 0 },
        { ...binding, hash: "invalid" },
      ]) {
        const [candidate] = await findSkills({
          projectRoot: root,
          sources: [{ ...declaration, effectDeclaration: invalid }],
        });
        expect(candidate!.status).toBe("invalid");
        expect(candidate!.blockers!.join(" ")).toMatch(
          /declaration revision/iu,
        );
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
