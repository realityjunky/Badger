import type {
  CreatorState,
  FactoryProposal,
  SkillCandidate,
  UpgradeSourceEvidence,
} from "../types.js";
import type { SemanticDossier } from "../factory/questionnaire.js";

export type AuthoringDepth = "quick" | "full";

export type AuthoringLaneId =
  | "script"
  | "reference"
  | "pause-points"
  | "workflow-entry"
  | "skill-core"
  | "skill-review";

export type AuthoringWaveId = "wave1" | "wave2" | "barrier";

export type AuthoringControlPlaneScriptKind =
  "runtime-adapter" | "plan" | "check" | "hook-guard";

export interface AuthoringControlPlaneScript {
  id: string;
  role: string;
  upstreamRole: string;
  kind: AuthoringControlPlaneScriptKind;
  path: string;
  claim: string;
  authority: "WorkflowRuntime" | "Badger assembler";
}

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

export interface AuthoringLaneProjection {
  id: AuthoringLaneId;
  wave: AuthoringWaveId;
  dependencies: readonly AuthoringLaneId[];
  brief: string;
  claims: readonly string[];
  derivedClaims: readonly string[];
  contentLeaves: readonly string[];
  producesContentLeaves: boolean;
}

export interface AuthoringLaneProjectionOptions {
  activeNodeIds?: readonly string[];
  contentLeaves?: readonly string[];
  derivedClaims?: readonly string[];
  laneContentLeaves?: Partial<
    Readonly<Record<AuthoringLaneId, readonly string[]>>
  >;
  workflowName?: string;
}

export interface AuthoringProtocolProjection {
  schemaVersion: 1;
  description: string;
  hash: string;
  depth: {
    quick: AuthoringProtocolDepth;
    full: AuthoringProtocolDepth;
    dryThreshold: number;
  };
  dag: {
    wave1: readonly AuthoringLaneId[];
    wave2: readonly AuthoringLaneId[];
    barrier: readonly AuthoringLaneId[];
  };
  lanes: Readonly<Record<AuthoringLaneId, AuthoringLaneProjection>>;
  verify: {
    lenses: readonly string[];
    loopUntilDry: boolean;
  };
  merge: {
    deterministicBackbone: readonly string[];
    contentLeaves: readonly string[];
  };
  controlPlaneScripts: readonly AuthoringControlPlaneScript[];
  deterministicBackbone: readonly string[];
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
  name: string;
  status: SkillCandidate["status"];
  sources: Array<{
    name: string;
    root: string;
    origin: "explicit";
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
  upgradeSource?: UpgradeSourceEvidence;
  compatibility: AuthoringCompatibility;
  semanticDossierHash?: string;
  semanticDossier?: SemanticDossier;
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

export const AUTHORING_REVIEW_LENSES = [
  "contract-fit",
  "usability",
  "evidence-trace",
  "self-consistency",
] as const;

export type AuthoringReviewLens = (typeof AUTHORING_REVIEW_LENSES)[number];
export type AuthoringReviewFindingSource = "provider" | "deterministic";

export interface AuthoringLaneFinding {
  severity: AuthoringFindingSeverity;
  path?: string;
  claim?: string;
  problem: string;
  impact?: string;
  fix?: string;
}

export interface AuthoringReviewFinding extends AuthoringLaneFinding {
  lens?: AuthoringReviewLens;
  source?: AuthoringReviewFindingSource;
  voterIds?: string[];
}

export const AUTHORING_CROSS_VALIDATION_CODES = [
  "invalid-workflow-protocol",
  "workflow-protocol-hash-mismatch",
  "duplicate-authored-document",
  "missing-authored-document",
  "missing-decision",
  "missing-choice",
  "undeclared-decision",
  "undeclared-choice",
  "missing-route",
  "undeclared-route",
  "hidden-exit",
  "contradictory-transition",
  "missing-required-skill-call",
  "incomplete-required-skill-call",
  "undeclared-skill-call",
  "missing-output-schema",
  "incomplete-output-schema",
  "undeclared-output-schema",
  "missing-guardrail",
  "incomplete-guardrail",
  "undeclared-guardrail",
  "missing-recovery-reference",
  "alternate-recovery-authority",
  "alternate-route-authority",
  "direct-run-state-instruction",
  "implicit-latest-artifact",
  "artifact-selection-without-version",
] as const;

export type AuthoringCrossValidationCode =
  (typeof AUTHORING_CROSS_VALIDATION_CODES)[number];

export interface AuthoringCrossValidationFinding {
  code: AuthoringCrossValidationCode;
  severity: AuthoringFindingSeverity;
  lens: AuthoringReviewLens;
  path: string;
  subject: string;
  message: string;
  expected?: string;
  observed?: string;
}

export interface AuthoringCrossValidationResult {
  schemaVersion: 1;
  authority: "WorkflowProtocol";
  workflowProtocolHash: string;
  checkedArtifacts: string[];
  findings: AuthoringCrossValidationFinding[];
  passed: boolean;
  crossValidationHash: string;
}

export interface AuthoringReviewVoterEvidence {
  id: string;
  provider: string;
  model: string;
  inputHash: string;
  evidenceHash: string;
  passed: boolean;
  findings: AuthoringReviewFinding[];
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
  dryRounds?: number;
  mode?: AuthoringDepth;
  inputHash?: string;
  findings: AuthoringReviewFinding[];
  voterEvidence?: AuthoringReviewVoterEvidence[];
  reviewedAt: string;
}

export interface AuthoringLaneAction {
  kind: "question" | "repair";
  prompt: string;
  requirement: string;
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
  semanticDossierHash?: string;
  expectedRevision?: number;
  artifacts?: AuthoringLaneArtifactOutput[];
  claims?: AuthoringLaneClaimOutput[];
  findings?: AuthoringLaneFinding[];
  review?: AuthoringLaneReviewOutput;
  action?: AuthoringLaneAction;
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
  dryRounds?: number;
  findings?: AuthoringReviewFinding[];
  reviewedAt?: string;
  contractFit?: "pass" | "fail" | "needs_context";
  usability?: "pass" | "fail" | "needs_context";
  mode?: AuthoringDepth;
  inputHash?: string;
  voterEvidence?: AuthoringReviewVoterEvidence[];
}

export interface AuthoringReviewResult {
  schemaVersion: 1;
  mode: AuthoringDepth;
  decision: "approved" | "rejected" | "needs_context";
  passed: boolean;
  contractFit: "pass" | "fail" | "needs_context";
  usability: "pass" | "fail" | "needs_context";
  evidenceSource: AuthoringEvidenceSource;
  voters: number;
  lenses: AuthoringReviewLens[];
  rounds: number;
  dryRounds: number;
  reviewer: string;
  summary: string;
  blockingFindings: string[];
  warnings: string[];
  findings: AuthoringReviewFinding[];
  reviewedAt: string;
  authoringInputHash: string;
  authoredMaterialHash: string;
  packageHash: string;
  reviewHash: string;
  voterEvidence: AuthoringReviewVoterEvidence[];
  crossValidation?: AuthoringCrossValidationResult;
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
  semanticDossierHash?: string;
  action?: AuthoringLaneAction;
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
  semanticDossierHash?: string;
  action?: AuthoringLaneAction;
}

export type AuthoringSessionStatus =
  "pending" | "in-progress" | "stale" | "authored" | "assembled" | "legacy";

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
  workflow?: string;
  sessionId?: string;
  sessionPath: string;
  statePath?: string;
  planPath: string;
  recordsPath: string;
  revision: number;
  generatorContractVersion: 1 | 2;
  planHash: string;
  protocolHash: string;
  workflowProtocolHash: string;
  sourceEvidenceHash: string;
  authoringPlanHash: string;
  authoringInputHash: string;
  semanticDossierHash?: string;
  scaffoldHash: string;
  authoredMaterialHash: string | null;
  assembledPackageHash: string | null;
  records: Partial<Record<AuthoringLaneId, AuthoringRecordSummary>>;
  invalidatedLanes?: AuthoringLaneId[];
  conflict?: AuthoringRevisionConflict;
  review?: AuthoringReviewResult;
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
  action?: AuthoringLaneAction;
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
  recoveryRequired?: boolean;
  reason?: string;
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
  identity?: AuthoringSessionIdentity;
  lock?: AuthoringSessionLock;
  recoveryError?: string;
  blockers: string[];
  warnings: string[];
  evidence: Record<string, string>;
  records: Partial<Record<AuthoringLaneId, AuthoringRecord>>;
  nextLanes: AuthoringLaneId[];
  completedLanes: AuthoringLaneId[];
  lanes: Record<AuthoringLaneId, AuthoringLaneReadiness>;
  waves: AuthoringWaveReadiness[];
  recovery: AuthoringRecoveryInfo;
  review?: AuthoringReviewResult;
}

export type AuthoringSessionOperation =
  | "dispatch"
  | "record"
  | "invalidate"
  | "assemble"
  | "evaluate"
  | "publish"
  | "distribute";

export type AuthoringSessionDecisionState =
  "allowed" | "blocked" | "needs-context" | "stale";

export type AuthoringWriteOperation =
  "record" | "assemble" | "publish" | "distribute";

export interface AuthoringSessionIdentity {
  schemaVersion: 1;
  sessionId: string;
  workflow: string;
  sessionPath: string;
  revision: number;
  planHash: string;
  protocolHash: string;
  workflowProtocolHash: string;
  sourceEvidenceHash: string;
  authoringPlanHash: string;
  authoringInputHash: string;
  semanticDossierHash?: string;
  scaffoldHash: string;
}

export interface AuthoringSessionDecisionOptions {
  state: CreatorState;
  operation: AuthoringSessionOperation;
  lane?: AuthoringLaneId;
  expectedRevision?: number;
  confirmed?: boolean;
}

export interface AuthoringSessionDecision {
  schemaVersion: 1;
  operation: AuthoringSessionOperation;
  lane?: AuthoringLaneId;
  allowed: boolean;
  state: AuthoringSessionDecisionState;
  blockers: string[];
  warnings: string[];
  findings: AuthoringLaneFinding[];
  revision: number;
  identity?: AuthoringSessionIdentity;
  lock?: AuthoringSessionLock;
  authoring?: AuthoringStateSummary;
  readiness: AuthoringReadiness;
  recovery: AuthoringRecoveryInfo;
  conflict?: AuthoringRevisionConflict;
}

export interface AuthoringWriteGateOptions {
  state: CreatorState;
  operation: AuthoringWriteOperation;
  lane?: AuthoringLaneId;
  expectedRevision?: number;
  confirmed?: boolean;
}

export interface AuthoringWriteGate extends AuthoringSessionDecision {
  operation: AuthoringWriteOperation;
  confirmed: boolean;
}

export interface AuthoringInvalidationOptions {
  state: CreatorState;
  lanes: readonly AuthoringLaneId[];
  reason?: string;
  expectedRevision?: number;
  confirmed: boolean;
}

export interface AuthoringInvalidation {
  schemaVersion: 1;
  lanes: AuthoringLaneId[];
  revision: number;
  reason: string;
  identity?: AuthoringSessionIdentity;
  recovery: AuthoringRecoveryInfo;
  conflict?: AuthoringRevisionConflict;
}

export interface AuthoringSessionRecordOptions {
  state: CreatorState;
  lane: AuthoringLaneId;
  record: unknown;
  expectedRevision?: number;
  confirmed: boolean;
}

export type AuthoringSessionLockStatus =
  "available" | "held" | "stale" | "invalid";

export interface AuthoringSessionLock {
  path: string;
  status: AuthoringSessionLockStatus;
  owner?: { pid: number; at?: string };
}
