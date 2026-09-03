import type {
  FactoryPlan,
  SkillCandidate,
  WorkflowProtocol,
} from "../types.js";
import type { DirectorySnapshot, SnapshotFile } from "./fixture.js";

export interface DifferentialSkill {
  name: string;
  path: string;
}

export interface DifferentialFixture {
  schemaVersion: 1;
  id: string;
  skills: DifferentialSkill[];
  plan: FactoryPlan;
  extractionManifest: string;
}

export interface CanonicalCandidateSource {
  name: string;
  root: string;
  description: string;
  hash: string;
  references: Array<{ path: string; contentHash: string }>;
  scripts: Array<{ path: string; sideEffect: string }>;
}

export interface CanonicalCandidate {
  query: string;
  preferenceIndex: number | null;
  status: "available" | "missing" | "ambiguous";
  sources: CanonicalCandidateSource[];
}

export interface ArtifactInventory {
  root: string;
  files: SnapshotFile[];
  sha256: string;
}

export interface ReadinessObservation {
  state: string;
  blockers: string[];
  warnings: string[];
  evidence: Record<string, string>;
}

export interface DifferentialObservation {
  candidates: CanonicalCandidate[];
  sourceInventory: CanonicalCandidateSource[];
  sourceHashes: Array<{ name: string; root: string; hash: string }>;
  workflowProtocol: WorkflowProtocol;
  generatedArtifacts: ArtifactInventory;
  initialReadiness: ReadinessObservation;
}

export interface OfficialCommandRunner {
  run(
    args: string[],
    options: { cwd: string; homeDir: string },
  ): Promise<unknown>;
}

export interface DifferentialHarnessOptions {
  repositoryRoot: string;
  fixturePath: string;
  fixtureSkillsRoot?: string;
  officialRoot: string;
  officialCli?: string;
  officialRevision?: string;
  officialRunner?: OfficialCommandRunner;
}

export interface DifferentialComparison {
  candidateStatusEqual: boolean;
  sourceHashesEqual: boolean;
  referenceInventoryEqual: boolean;
  workflowProtocolEqual: boolean;
  generatedArtifactInventoryEqual: boolean;
  initialReadinessEqual: boolean;
  officialOnlyArtifacts: string[];
  standaloneOnlyArtifacts: string[];
}

export interface DifferentialReport {
  schemaVersion: 1;
  fixture: {
    id: string;
    skills: string[];
    sourceBefore: DirectorySnapshot[];
    sourceAfter: DirectorySnapshot[];
    unchanged: boolean;
  };
  official: {
    root: string;
    revision: string;
    observation: DifferentialObservation;
  };
  standalone: {
    observation: DifferentialObservation;
  };
  comparison: DifferentialComparison;
  extractionManifest: unknown;
}
