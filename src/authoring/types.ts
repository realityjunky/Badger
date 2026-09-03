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

export type AuthoringStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "COMPLETE"
  | "DONE"
  | "DONE_WITH_CONCERNS"
  | "BLOCKED"
  | "NEEDS_CONTEXT";

export type AuthoringLaneOutputStatus =
  "DONE" | "DONE_WITH_CONCERNS" | "BLOCKED" | "NEEDS_CONTEXT";

export type AuthoringFindingSeverity = "critical" | "important" | "minor";

export type AuthoringEvidenceSource =
  "deterministic-check-only" | "llm-single" | "llm-multivote";

export interface AuthoringLaneFinding {
  severity: AuthoringFindingSeverity;
  path?: string;
  claim?: string;
  problem: string;
  impact?: string;
  fix?: string;
}

export interface AuthoringLaneClaimOutput {
  id: string;
  kind?: string;
  paths?: string[];
  summary?: string;
  status?: AuthoringClaimStatus;
  evidence?: string[];
}

export interface AuthoringLaneArtifactOutput {
  path: string;
  kind?: string;
  id?: string;
  present?: boolean;
  content?: string;
  contentPath?: string;
  contentHash?: string;
}

export interface AuthoringLaneReviewOutput {
  passed: boolean;
  evidenceSource: AuthoringEvidenceSource;
  voters?: number;
  lenses?: string[];
  rounds?: number;
  findings: AuthoringLaneFinding[];
  reviewedAt: string;
}

export interface AuthoringLaneOutput {
  lane: string;
  status: AuthoringLaneOutputStatus;
  dispatchMode?: string;
  model?: string;
  summary?: string;
  protocolHash?: string;
  authoringPlanHash?: string;
  workflowProtocolHash?: string;
  sourceEvidenceHash?: string;
  authoringInputHash?: string;
  expectedRevision?: number;
  artifacts?: AuthoringLaneArtifactOutput[];
  claims?: AuthoringLaneClaimOutput[];
  findings?: AuthoringLaneFinding[];
  review?: AuthoringLaneReviewOutput;
}

export type AuthoringClaimStatus =
  "SUPPORTED" | "UNSUPPORTED" | "NEEDS_CONTEXT";

export interface AuthoringClaimEvidence {
  id: string;
  status: AuthoringClaimStatus;
  evidence: string[];
  kind?: string;
  paths?: string[];
  summary?: string;
}

export interface AuthoringArtifactEvidence {
  id: string;
  path: string;
  present: boolean;
  contentHash?: string;
  contentPath?: string;
  kind?: string;
}

export interface AuthoringArtifactInput extends Omit<
  AuthoringArtifactEvidence,
  "contentPath"
> {
  content?: string;
  contentPath?: string;
}

export interface AuthoringReviewOutput {
  decision: "approved" | "rejected" | "needs_context";
  reviewer: string;
  summary: string;
  blockingFindings: string[];
  warnings: string[];
  passed?: boolean;
  evidenceSource?: AuthoringEvidenceSource;
  voters?: number;
  lenses?: string[];
  rounds?: number;
  findings?: AuthoringLaneFinding[];
  reviewedAt?: string;
  contractFit?: "pass" | "fail" | "needs_context";
  usability?: "pass" | "fail" | "needs_context";
}

export interface AuthoringRecord {
  schemaVersion: 1;
  kind: "authoring-record";
  revision?: number;
  workflow: string;
  lane: AuthoringLaneId;
  status: AuthoringStatus;
  protocolHash: string;
  authoringPlanHash: string;
  workflowProtocolHash: string;
  sourceEvidenceHash: string;
  authoringInputHash: string;
  authoredMaterialHash: string;
  claims: AuthoringClaimEvidence[];
  artifacts: AuthoringArtifactEvidence[];
  findings?: AuthoringLaneFinding[];
  dispatchMode?: string;
  model?: string;
  review?: AuthoringReviewOutput;
  summary?: string;
  at: string;
}

export interface AuthoringRecordInput {
  lane?: AuthoringLaneId;
  status: AuthoringStatus;
  claims?: AuthoringClaimEvidence[];
  artifacts?: AuthoringArtifactInput[];
  findings?: AuthoringLaneFinding[];
  dispatchMode?: string;
  model?: string;
  review?: AuthoringReviewOutput;
  summary?: string;
  expectedRevision?: number;
  protocolHash?: string;
  authoringPlanHash?: string;
  workflowProtocolHash?: string;
  sourceEvidenceHash?: string;
  authoringInputHash?: string;
}

export type AuthoringSessionStatus =
  "pending" | "in-progress" | "stale" | "authored" | "assembled";

export interface AuthoringRecordSummary {
  path: string;
  revision?: number;
  status: AuthoringStatus;
  authoringInputHash: string;
  authoredMaterialHash: string;
  claims?: string[];
  artifacts?: string[];
  findingCount?: number;
}

export interface AuthoringStateSummary {
  schemaVersion: 1;
  status: AuthoringSessionStatus;
  sessionPath: string;
  statePath?: string;
  planPath: string;
  recordsPath: string;
  revision: number;
  generatorContractVersion: 1;
  planHash: string;
  protocolHash: string;
  workflowProtocolHash: string;
  sourceEvidenceHash: string;
  authoringPlanHash: string;
  authoringInputHash: string;
  scaffoldHash: string;
  authoredMaterialHash: string | null;
  assembledPackageHash: string | null;
  records: Partial<Record<AuthoringLaneId, AuthoringRecordSummary>>;
  invalidatedLanes?: AuthoringLaneId[];
  conflict?: AuthoringRevisionConflict;
}

export interface AuthoringRevisionConflict {
  lane: AuthoringLaneId;
  expectedRevision: number;
  actualRevision: number;
  at: string;
}

export interface AuthoringLaneReadiness {
  id: AuthoringLaneId;
  dependencies: AuthoringLaneId[];
  status: AuthoringStatus;
  executable: boolean;
  blockers: string[];
  claims: AuthoringClaimEvidence[];
  artifacts: AuthoringArtifactEvidence[];
  findings: AuthoringLaneFinding[];
  summary?: string;
}

export interface AuthoringWaveReadiness {
  id: "wave1" | "wave2" | "barrier";
  lanes: AuthoringLaneId[];
  completed: AuthoringLaneId[];
  next: AuthoringLaneId[];
  blocked: Partial<Record<AuthoringLaneId, string[]>>;
}

export interface AuthoringRecoveryInfo {
  resumable: boolean;
  freshProcess: boolean;
  revision: number;
  sessionPath: string;
  statePath: string;
  planPath: string;
  recordsPath: string;
  invalidatedLanes: AuthoringLaneId[];
  conflict?: AuthoringRevisionConflict;
}

export interface AuthoringReadiness {
  state: "blocked" | "needs-context" | "ready";
  status: AuthoringSessionStatus;
  blockers: string[];
  warnings: string[];
  evidence: Record<string, string>;
  records: Partial<Record<AuthoringLaneId, AuthoringRecord>>;
  nextLanes: AuthoringLaneId[];
  completedLanes: AuthoringLaneId[];
  lanes: Record<AuthoringLaneId, AuthoringLaneReadiness>;
  waves: AuthoringWaveReadiness[];
  recovery: AuthoringRecoveryInfo;
}
