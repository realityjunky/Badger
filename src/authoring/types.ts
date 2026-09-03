import type { FactoryProposal, SkillCandidate } from "../types.js";

export type AuthoringDepth = "quick" | "full";

export type AuthoringLaneId =
  | "script"
  | "reference"
  | "pause-points"
  | "workflow-entry"
  | "skill-core"
  | "skill-review";

export interface AuthoringDag {
  wave1: AuthoringLaneId[];
  wave2: AuthoringLaneId[];
  barrier: AuthoringLaneId[];
}

export interface AuthoringProtocolDepth {
  voters: number;
  maxRounds: number;
  evidenceSource: "llm-single" | "llm-multivote";
}

export interface AuthoringProtocol {
  schemaVersion: 1;
  description: string;
  depth: {
    quick: AuthoringProtocolDepth;
    full: AuthoringProtocolDepth;
    dryThreshold: number;
  };
  dag: AuthoringDag;
  lanes: Record<
    AuthoringLaneId,
    {
      brief: string;
      claims: string[];
      producesContentLeaves: string[];
    }
  >;
  verify: {
    lenses: string[];
    loopUntilDry: boolean;
  };
  merge: {
    deterministicBackbone: string[];
    contentLeaves: string[];
  };
}

export interface AuthoringVerificationSettings {
  voters: number;
  lenses: string[];
  maxRounds: number;
  dryThreshold: number;
  evidenceSource: "llm-single" | "llm-multivote";
  loopUntilDry: boolean;
}

export interface AuthoringLane {
  id: AuthoringLaneId;
  dependencies: AuthoringLaneId[];
  brief: string;
  claims: string[];
  derivedClaims: string[];
  contentLeaves: string[];
  producesContentLeaves: boolean;
}

export interface AuthoringSourceEvidence {
  query: string;
  preferenceIndex: number | null;
  status: SkillCandidate["status"];
  sources: Array<{
    name: string;
    root: string;
    origin: "project" | "global" | "explicit" | "extra";
    description: string;
    references: Array<{ path: string; contentHash: string }>;
    scripts: Array<{ path: string; sideEffect: "unknown" }>;
    hash: string;
  }>;
}

export interface AuthoringMergeContract {
  deterministicBackbone: string[];
  contentLeaves: string[];
}

export interface AuthoringCompatibilityNote {
  id: string;
  detail: string;
}

export interface AuthoringCompatibility {
  officialRevision: string;
  officialVersion: string;
  knownUpstreamInconsistencies: AuthoringCompatibilityNote[];
  badgerExtensions: AuthoringCompatibilityNote[];
}

export interface AuthoringPlan {
  schemaVersion: 1;
  kind: "authoring-plan";
  name: string;
  depth: AuthoringDepth;
  protocolHash: string;
  workflowProtocolHash: string;
  planHash: string;
  sourceEvidenceHash: string;
  authoringPlanHash: string;
  dag: AuthoringDag;
  lanes: AuthoringLane[];
  verify: AuthoringVerificationSettings;
  merge: AuthoringMergeContract;
  sourceEvidence: AuthoringSourceEvidence[];
  compatibility: AuthoringCompatibility;
}

export type AuthoringPlanDiagnosticCode =
  | "invalid-plan"
  | "invalid-dag"
  | "unknown-lane"
  | "duplicate-lane"
  | "lane-order"
  | "invalid-lane"
  | "invalid-claims"
  | "invalid-content-leaves"
  | "invalid-verification"
  | "invalid-hash"
  | "identical-protocol-hashes"
  | "missing-extension"
  | "blocked-proposal";

export interface AuthoringPlanDiagnostic {
  code: AuthoringPlanDiagnosticCode;
  message: string;
  path?: string;
}

export interface DeriveAuthoringPlanOptions {
  proposal: FactoryProposal;
  depth?: AuthoringDepth;
}
