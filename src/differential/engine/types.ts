import type { DirectorySnapshot } from "../fixture.js";

export type EngineRunnerMode = "manual" | "standalone";

export type EngineErrorCategory =
  | "revision-mismatch"
  | "invalid-run-id"
  | "invalid-run-state"
  | "unsafe-path"
  | "pending-action-mismatch"
  | "outcome-mismatch"
  | "guardrail-rejection"
  | "unknown-step"
  | "malformed-trajectory"
  | "file-too-large"
  | "terminal-run"
  | "command-failure"
  | "unknown";

export interface ClassifiedEngineError {
  category: EngineErrorCategory;
  message: string;
  operation?: string;
}

export interface EngineExpectedError {
  category: EngineErrorCategory;
  messageIncludes?: string;
}

export interface EngineExpectedResult {
  state?: {
    status?: "running" | "waiting" | "completed" | "failed";
    currentStep?: string | null;
  };
  action?: "present" | "absent";
  reason?: string;
}

interface EngineScenarioOperationBase {
  expectError?: EngineExpectedError;
  expectResult?: EngineExpectedResult;
}

export type EngineScenarioOperation =
  | (EngineScenarioOperationBase & {
      type: "start";
      confirmations?: string[];
    })
  | (EngineScenarioOperationBase & {
      type: "resume";
      confirmations?: string[];
    })
  | (EngineScenarioOperationBase & {
      type: "outcome";
      status: "succeeded" | "failed";
      summary: string;
      artifacts?: Record<string, string>;
      state?: Record<string, string>;
      confirmations?: string[];
    })
  | (EngineScenarioOperationBase & {
      type: "check";
      scope: "progress" | "step" | "completion";
    })
  | (EngineScenarioOperationBase & {
      type: "patch-state";
      patch: Record<string, unknown>;
    })
  | (EngineScenarioOperationBase & {
      type: "remove-pending";
    });

export interface EngineFixtureSkill {
  name: string;
  path: string;
}

export interface EngineScenario {
  id: string;
  description: string;
  skill: string;
  runner: EngineRunnerMode;
  runId?: string;
  operations: EngineScenarioOperation[];
}

export interface EngineCharacterizationFixture {
  schemaVersion: 1;
  id: string;
  manifest: string;
  skills: EngineFixtureSkill[];
  scenarios: EngineScenario[];
}

export interface EngineSourceManifest {
  schemaVersion: 1;
  kind: "official-engine-characterization";
  official: {
    remote: string;
    revision: string;
    version: string;
    checkout: string;
    readOnly: true;
    sourcePaths: string[];
  };
  closure: {
    engine: string[];
    skillRuntime: string[];
    protectedFilesystem: string[];
  };
  excluded: string[];
}

export interface EngineCommandObservation {
  operation: string;
  args: string[];
  result?: unknown;
  error?: ClassifiedEngineError;
}

export interface EngineEvalObservation {
  source: "command" | "trajectory";
  scope: "progress" | "step" | "completion" | null;
  results: unknown[];
}

export interface EngineRunFilesObservation {
  state: unknown | null;
  pendingAction: unknown | null;
  outcomes: unknown[];
  artifacts: unknown;
  trajectory: unknown[];
  checkpoint: unknown | null;
  evals: EngineEvalObservation[];
  errors: ClassifiedEngineError[];
}

export interface EngineScenarioObservation {
  scenario: Pick<EngineScenario, "id" | "description" | "skill" | "runner"> & {
    runId: string | null;
  };
  coordinates: {
    projectRoot: string;
    homeDir: string;
    skillRoot: string;
    runRoot: string;
  };
  commands: EngineCommandObservation[];
  run: EngineRunFilesObservation;
  errors: ClassifiedEngineError[];
}

export interface EngineComparisonDifference {
  scenarioId: string;
  path: string;
  official: unknown;
  private: unknown;
  classification: "expected-packaging" | "semantic";
}

export type EngineComparisonStatus =
  | "official-baseline"
  | "exact-match"
  | "expected-packaging-difference"
  | "semantic-mismatch";

export interface EngineComparison {
  status: EngineComparisonStatus;
  exactMatches: string[];
  expectedPackagingDifferences: EngineComparisonDifference[];
  semanticMismatches: EngineComparisonDifference[];
}

export interface EngineBaselineReport {
  schemaVersion: 1;
  kind: "official-engine-baseline";
  official: {
    root: string;
    revision: string;
    expectedRevision: string;
    verified: true;
    sourceBefore: DirectorySnapshot;
    sourceAfter: DirectorySnapshot;
    unchanged: boolean;
  };
  fixture: {
    id: string;
    sourceBefore: DirectorySnapshot[];
    sourceAfter: DirectorySnapshot[];
    unchanged: boolean;
  };
  scenarios: EngineScenarioObservation[];
  comparison: EngineComparison;
}

export interface EngineDifferentialReport {
  schemaVersion: 1;
  kind: "official-private-engine-differential";
  official: EngineBaselineReport["official"];
  fixture: EngineBaselineReport["fixture"];
  officialScenarios: EngineScenarioObservation[];
  privateScenarios: EngineScenarioObservation[];
  comparison: EngineComparison;
}

export interface EngineCommandRunner {
  run(
    args: string[],
    options: { cwd: string; homeDir: string },
  ): Promise<unknown>;
}

export interface EngineBaselineOptions {
  repositoryRoot: string;
  fixturePath: string;
  officialRoot: string;
  officialCli?: string;
  officialRunner?: EngineCommandRunner;
}

export interface EngineDifferentialOptions extends EngineBaselineOptions {
  privateRunner?: EngineCommandRunner;
}
