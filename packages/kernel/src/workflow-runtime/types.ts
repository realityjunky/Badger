import type {
  ActionOutcome,
  EngineAction,
  RuntimeIdentity,
  WorkflowCycleState,
  WorkflowVisitState,
} from "../engine/types.js";
import type {
  DecisionScalar,
  NodeProtocol,
  OutputSchema,
  WorkflowArtifactId,
  WorkflowArtifactSelection,
  WorkflowArtifactVersionId,
  WorkflowArtifactVersion,
  WorkflowContentSnapshotReference,
  WorkflowDecisionReceipt,
  WorkflowDecisionScopeSelection,
  WorkflowDecisionScopeSnapshot,
  WorkflowFinalizationState,
  WorkflowFinalizationSubmission,
  WorkflowFinalizationPendingConfirmation,
  WorkflowFinalizationPreview,
  WorkflowFinalizationReceiptReference,
  WorkflowFinalizationDefinition,
  WorkflowFinalizationConfirmationPolicy,
  WorkflowFinalizationReceipt,
  WorkflowProtocol,
  WorkflowRepairEpisodeState,
  WorkflowReviewerAttestation,
  WorkflowVerificationReceiptProposal,
  WorkflowVerificationReceiptReference,
  WorkflowVerificationSubmission,
} from "../types.js";
import type { WorkflowFinding, WorkflowFindingSummary } from "./findings.js";

export type WorkflowExecutionIdentity = RuntimeIdentity;

export type WorkflowPendingAction = EngineAction;

export interface WorkflowMachineSubmission extends ActionOutcome {
  kind?: "machine";
  nodeId?: string | null;
  runId?: string;
  execution?: WorkflowExecutionIdentity;
  verification?:
    | WorkflowVerificationSubmission
    | WorkflowVerificationReceiptProposal
    | WorkflowVerificationReceiptProposal[];
  verificationReceipts?:
    | WorkflowVerificationSubmission
    | string[]
    | WorkflowVerificationReceiptProposal[];
  verificationReceiptIds?: string[];
  receiptIds?: string[];
}

export interface WorkflowDecisionSubmission {
  kind: "decision";
  actionId: string;
  runId?: string;
  revision: number;
  nodeId: string | null;
  cycleId: string | null;
  attemptId: string | null;
  decisionId?: string;
  choiceId: string;
  reviewer: WorkflowReviewerAttestation;
  inputs?: Record<string, DecisionScalar>;
  rationale?: string;
  evidenceReferences?: string[];
  scope?: WorkflowDecisionScopeSelection;
  execution?: WorkflowExecutionIdentity;
  protocolHash?: string;
  packageHash?: string;
  snapshotHash?: string;
  verification?:
    | WorkflowVerificationSubmission
    | WorkflowVerificationReceiptProposal
    | WorkflowVerificationReceiptProposal[];
  verificationReceipts?:
    | WorkflowVerificationSubmission
    | string[]
    | WorkflowVerificationReceiptProposal[];
  verificationReceiptIds?: string[];
  receiptIds?: string[];
  repair?: {
    expectedSignatureHash?: string;
    signatureHash?: string;
    rationale?: string;
    hypothesis?: string;
    summary?: string;
  };
  finalization?: WorkflowFinalizationSubmission;
}

export interface ManualWorkflowRunLocation {
  kind: "manual";
  runRoot: string;
}

export interface StandaloneWorkflowRunLocation {
  kind: "standalone";
  projectRoot: string;
  runId: string;
}

export type WorkflowRunLocation =
  ManualWorkflowRunLocation | StandaloneWorkflowRunLocation;

export type WorkflowRunTarget = WorkflowRunLocation | string;

export interface WorkflowContinuation {
  disposition: "continue" | "await-user" | "blocked" | "done";
  runId: string;
  revision: number;
  currentNode: string | null;
  cycleId: string | null;
  attemptId: string | null;
  visitOrdinal: number | null;
  retryOrdinal: number | null;
  pendingAction: WorkflowPendingAction | null;
  execution: WorkflowExecutionIdentity;
  decisionReceipts: WorkflowDecisionReceipt[];
  verificationReceipts: WorkflowVerificationReceiptReference[];
  cycles: WorkflowCycleState[];
  visits: WorkflowVisitState[];
  artifactVersions: WorkflowArtifactVersion[];
  artifactSelections: WorkflowArtifactSelection[];
  contentSnapshots: WorkflowContentSnapshotReference[];
  currentArtifactVersions: Record<
    WorkflowArtifactId,
    WorkflowArtifactVersionId
  >;
  blockers: string[];
  findings: WorkflowFinding[];
  findingSummary: WorkflowFindingSummary;
  requiresUserDecision: boolean;
  repair?: WorkflowRepairEpisodeState;
  finalization?: WorkflowFinalizationState;
}

export interface WorkflowHandoff {
  schemaVersion: 1;
  workflow: {
    name: string;
    goal: string;
    protocolHash: string;
  };
  execution: WorkflowExecutionIdentity;
  nodes: NodeProtocol[];
  outputSchemas: OutputSchema[];
  finalization?: WorkflowFinalizationDefinition;
  decisionReceipts: WorkflowDecisionReceipt[];
  verificationReceipts: WorkflowVerificationReceiptReference[];
  cycles: WorkflowCycleState[];
  visits: WorkflowVisitState[];
  artifactVersions: WorkflowArtifactVersion[];
  artifactSelections: WorkflowArtifactSelection[];
  contentSnapshots: WorkflowContentSnapshotReference[];
  currentArtifactVersions: Record<
    WorkflowArtifactId,
    WorkflowArtifactVersionId
  >;
  findings: WorkflowFinding[];
  findingSummary: WorkflowFindingSummary;
  requiresUserDecision: boolean;
  repair?: WorkflowRepairEpisodeState;
  finalizationState?: WorkflowFinalizationState;
  continuation: WorkflowContinuation | null;
}

export type WorkflowStateProjectionStatus =
  "not-started" | "running" | "waiting" | "blocked" | "completed";

export interface WorkflowStateProjection {
  schemaVersion: 1;
  workflow: string;
  statePath: string;
  status: Exclude<WorkflowStateProjectionStatus, "not-started">;
  runId: string;
  revision: number;
  currentNode: string | null;
  cycleId: string | null;
  attemptId: string | null;
  visitOrdinal: number | null;
  retryOrdinal: number | null;
  completedNodes: string[];
  evidence: Record<string, Record<string, unknown>>;
  history: Array<{
    event: "outcome-recorded";
    node: string;
    status: "succeeded" | "failed";
    at: string;
  }>;
  pendingAction: WorkflowPendingAction | null;
  execution: WorkflowExecutionIdentity;
  visits: WorkflowVisitState[];
  cycles: WorkflowCycleState[];
  decisionReceipts: WorkflowDecisionReceipt[];
  verificationReceipts: WorkflowVerificationReceiptReference[];
  artifactVersions: WorkflowArtifactVersion[];
  artifactSelections: WorkflowArtifactSelection[];
  currentArtifactVersions: Record<
    WorkflowArtifactId,
    WorkflowArtifactVersionId
  >;
  contentSnapshots: WorkflowContentSnapshotReference[];
  blockers: string[];
  findings: WorkflowFinding[];
  findingSummary: WorkflowFindingSummary;
  requiresUserDecision: boolean;
  repair?: WorkflowRepairEpisodeState;
  finalization?: WorkflowFinalizationState;
}

export type StartWorkflowRunOptions =
  | {
      protocol: WorkflowProtocol;
      location: ManualWorkflowRunLocation;
      runId?: string;
      confirmations?: Iterable<string>;
      protectedSnapshotRoots?: readonly string[];
    }
  | {
      protocol: WorkflowProtocol;
      location: StandaloneWorkflowRunLocation;
      confirmations?: Iterable<string>;
      protectedSnapshotRoots?: readonly string[];
    }
  | {
      protocol: WorkflowProtocol;
      runRoot: string;
      runId?: string;
      confirmations?: Iterable<string>;
      protectedSnapshotRoots?: readonly string[];
    };

export interface ResumeWorkflowRunOptions {
  confirmations?: Iterable<string>;
  protectedSnapshotRoots?: readonly string[];
}

export interface RecoverWorkflowRunOptions extends ResumeWorkflowRunOptions {
  rollbackFinalization?: boolean;
}

export type WorkflowSubmission =
  WorkflowMachineSubmission | WorkflowDecisionSubmission;

export type {
  WorkflowFinalizationConfirmationPolicy,
  WorkflowFinalizationDefinition,
  WorkflowFinalizationPendingConfirmation,
  WorkflowFinalizationPreview,
  WorkflowFinalizationReceipt,
  WorkflowFinalizationReceiptReference,
};

export interface WorkflowRuntime {
  start(options: StartWorkflowRunOptions): Promise<WorkflowContinuation>;
  resume(
    target: WorkflowRunTarget,
    options?: ResumeWorkflowRunOptions,
  ): Promise<WorkflowContinuation>;
  submit(
    target: WorkflowRunTarget,
    submission: WorkflowSubmission,
  ): Promise<WorkflowContinuation>;
  recover(
    target: WorkflowRunTarget,
    options?: RecoverWorkflowRunOptions,
  ): Promise<WorkflowContinuation>;
}

export type Continuation = WorkflowContinuation;
export type StartOptions = StartWorkflowRunOptions;
export type Submission = WorkflowSubmission;
