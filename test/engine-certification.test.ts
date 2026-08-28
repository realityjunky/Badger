import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  certifyEngineDifferential,
  getEngineParityCoverage,
} from "../src/differential/engine/certification.js";
import {
  ENGINE_PARITY_REQUIREMENTS,
  type EngineDifferentialReport,
} from "../src/differential/engine/types.js";
import { readEngineFixture } from "../src/differential/engine/fixture.js";

describe("Engine Phase 1 certification", () => {
  it("covers every required parity capability in the canonical fixture", async () => {
    const packageRoot = path.resolve(process.cwd());
    const fixture = await readEngineFixture(
      path.join(
        packageRoot,
        "test",
        "fixtures",
        "engine",
        "engine-characterization.json",
      ),
      { repositoryRoot: path.resolve(packageRoot, "..") },
    );

    const coverage = getEngineParityCoverage(fixture);

    expect(coverage.missing).toEqual([]);
    expect(coverage.required).toEqual([...ENGINE_PARITY_REQUIREMENTS]);
    expect(coverage.scenarios["source-drift"]).toContain("source-drift");
    expect(coverage.scenarios["incompatible-upgrades"]).toContain(
      "incompatible-upgrade",
    );
  });

  it("certifies only complete, unchanged, semantically matching evidence", () => {
    const base = {
      official: { verified: true, unchanged: true },
      fixture: { unchanged: true },
      comparison: {
        status: "exact-match",
        exactMatches: ["scenario"],
        expectedPackagingDifferences: [],
        semanticMismatches: [],
      },
      coverage: {
        required: ["deterministic-single-step"],
        covered: ["deterministic-single-step"],
        missing: [],
        scenarios: { "deterministic-single-step": ["scenario"] },
      },
    } satisfies Pick<
      EngineDifferentialReport,
      "official" | "fixture" | "comparison" | "coverage"
    >;

    expect(certifyEngineDifferential(base)).toMatchObject({
      status: "certified",
      blockers: [],
    });
    expect(
      certifyEngineDifferential({
        ...base,
        comparison: {
          ...base.comparison,
          status: "semantic-mismatch",
          semanticMismatches: [
            {
              scenarioId: "scenario",
              path: "$.run.state.status",
              official: "completed",
              private: "running",
              classification: "semantic",
            },
          ],
        },
      }).status,
    ).toBe("blocked");
  });
});
