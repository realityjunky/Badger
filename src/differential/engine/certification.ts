import {
  ENGINE_PARITY_REQUIREMENTS,
  type EngineBaselineReport,
  type EngineCertification,
  type EngineComparison,
  type EngineCoverageReport,
  type EngineCharacterizationFixture,
} from "./types.js";

export function getEngineParityCoverage(
  fixture: Pick<EngineCharacterizationFixture, "scenarios">,
): EngineCoverageReport {
  const scenarios: Record<string, string[]> = {};
  for (const scenario of fixture.scenarios) {
    for (const requirement of scenario.coverage ?? []) {
      scenarios[requirement] ??= [];
      scenarios[requirement].push(scenario.id);
    }
  }
  const required = [...ENGINE_PARITY_REQUIREMENTS];
  const covered = required.filter((requirement) => scenarios[requirement]);
  return {
    required,
    covered,
    missing: required.filter((requirement) => !covered.includes(requirement)),
    scenarios,
  };
}

type CertificationEvidence = {
  official: Pick<EngineBaselineReport["official"], "verified" | "unchanged">;
  fixture: Pick<EngineBaselineReport["fixture"], "unchanged">;
  comparison: EngineComparison;
  coverage: EngineCoverageReport;
};

export function certifyEngineDifferential(
  evidence: CertificationEvidence,
): EngineCertification {
  if (evidence.comparison.status === "official-baseline") {
    return {
      status: "official-baseline",
      blockers: ["Private Engine differential evidence is not available"],
    };
  }

  const blockers: string[] = [];
  if (!evidence.official.verified) {
    blockers.push("Official Engine revision was not verified");
  }
  if (!evidence.official.unchanged) {
    blockers.push("Official Engine source changed during characterization");
  }
  if (!evidence.fixture.unchanged) {
    blockers.push("Engine fixture source changed during characterization");
  }
  if (evidence.coverage.missing.length > 0) {
    blockers.push(
      `Parity matrix is missing: ${evidence.coverage.missing.join(", ")}`,
    );
  }
  if (evidence.comparison.semanticMismatches.length > 0) {
    blockers.push(
      `Semantic mismatches: ${evidence.comparison.semanticMismatches.length}`,
    );
  }
  return {
    status: blockers.length === 0 ? "certified" : "blocked",
    blockers,
  };
}

export function assertEngineCertification(
  certification: EngineCertification,
): void {
  if (certification.status === "certified") return;
  throw new Error(
    `Engine Phase 1 certification is ${certification.status}: ${certification.blockers.join("; ")}`,
  );
}
