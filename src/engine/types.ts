import type { OrchestrationMode, StepAction } from "../skill-runtime/types.js";
import type {
  DecisionScalar,
  WorkflowArtifactId,
  WorkflowArtifactPath,
  WorkflowArtifactSelection,
  WorkflowArtifactVersionId,
  WorkflowArtifactVersion,
  WorkflowDecisionReceipt,
  WorkflowDecisionScopeSnapshot,
  WorkflowContentSnapshotReference,
  WorkflowDurabilityProfile,
  WorkflowRepairDecisionOutcome,
  WorkflowRepairAutomaticOperation,
  WorkflowRepairEpisodeState,
  WorkflowRepairFailureSignature,
  WorkflowRepairPendingDecision,
  WorkflowReviewerAttestation,
  WorkflowVerificationReceiptReference,
} from "../types.js";

export type RunStatus = "running" | "waiting" | "completed" | "failed";

export interface RuntimeIdentity {
  protocolHash: string;
  packageHash: string;
  snapshotHash: string;
  nodeToStep: Record<string, string>;
  capabilityVersion?: 3;
  resolverHash?: string;
  findingCatalogVersion?: 1;
  durabilityProfile?: WorkflowDurabilityProfile;
}

export interface WorkflowCycleState {
  id: string;
  key: string;
  instanceOrdinal: number;
}

export interface WorkflowCycleTransitionState {
  currentCycle: WorkflowCycleState | null;
  cycles: WorkflowCycleState[];
}

export interface WorkflowAttemptState {
  id: string;
  stepId: string;
  cycleId: string | null;
  visitOrdinal: number;
  retryOrdinal: number;
}

export interface WorkflowVisitOutcome {
  actionId: string;
  status: "succeeded" | "failed";
  summary: string;
  retryOrdinal: number;
  routing?: Record<string, string>;
  evidence?: Record<string, unknown>;
  artifactVersions?: Record<string, string>;
  verificationReceiptIds?: string[];
  repairDecision?: {
    decisionId: string;
    signatureHash: string;
    choiceId: string;
    outcome: "retry" | "stop" | "contract-change";
  };
}

export interface WorkflowVisitState {
  attemptId: string;
  stepId: string;
  cycleId: string | null;
  visitOrdinal: number;
  outcomes: WorkflowVisitOutcome[];
}

export interface WorkflowRuntimeState {
  revision: number;
  nextVisitOrdinal: number;
  currentAttempt: WorkflowAttemptState | null;
  currentCycle: WorkflowCycleState | null;
  cycles: WorkflowCycleState[];
  visits: WorkflowVisitState[];
  decisionReceipts: WorkflowDecisionReceipt[];
  verificationReceipts: WorkflowVerificationReceiptReference[];
  artifactVersions: WorkflowArtifactVersion[];
  artifactSelections: WorkflowArtifactSelection[];
  contentSnapshots?: WorkflowContentSnapshotReference[];
  repairEpisode?: WorkflowRepairEpisodeState;
}

export interface RunState {
  runId: string;
  skill: string;
  skillVersion: string;
  skillHash: string;
  orchestration: OrchestrationMode;
  currentStep: string | null;
  iteration: number;
  pending: string | null;
  pendingRef: string;
  trajectoryRef: string;
  contextRef: string;
  artifactsRef: string;
  checkpointRef: string;
  status: RunStatus;
  retries: Record<string, number>;
  runtimeIdentity?: RuntimeIdentity;
  workflowRuntime?: WorkflowRuntimeState;
}

export interface EngineAction extends StepAction {
  id: string;
  stepId: string | null;
  attemptId?: string;
  cycleId?: string | null;
  visitOrdinal?: number;
  retryOrdinal?: number;
  repair?: WorkflowRepairPendingDecision;
}

export interface ActionOutcome {
  actionId: string;
  status: "succeeded" | "failed";
  summary: string;
  artifacts?: Record<WorkflowArtifactId, WorkflowArtifactPath>;
  state?: Record<string, string>;
  evidence?: Record<string, unknown>;
  routing?: Record<string, string>;
  kind?: "machine" | "decision";
  revision?: number;
  nodeId?: string | null;
  cycleId?: string | null;
  attemptId?: string;
  decisionId?: string;
  choiceId?: string;
  reviewer?: WorkflowReviewerAttestation;
  inputs?: Record<string, DecisionScalar>;
  rationale?: string;
  evidenceReferences?: string[];
  scope?: WorkflowDecisionScopeSnapshot;
  artifactVersions?: Record<WorkflowArtifactId, WorkflowArtifactVersionId>;
  verificationReceiptIds?: string[];
  repairDecision?: WorkflowRepairDecisionOutcome;
  repairFailure?: {
    signature: WorkflowRepairFailureSignature;
    disposition: "continue" | "warning" | "manual-stop" | "hard-stop";
    reasonCode: string;
    consecutiveFailures: number;
    totalFailures: number;
    remainingFailures: number;
    overrideAccepted: boolean;
    automaticRepair?: WorkflowRepairAutomaticOperation;
    pendingDecision?: WorkflowRepairPendingDecision;
  };
}

export interface TrajectoryEvent {
  sequence: number;
  timestamp: string;
  type:
    | "run_started"
    | "action_proposed"
    | "action_completed"
    | "eval_completed"
    | "checkpoint"
    | "state_migrated"
    | "state_transitioned"
    | "command_check_recorded"
    | "recovery_reconciled";
  runId: string;
  data: Record<string, unknown>;
}

export interface EvalResult {
  evalId: string;
  passed: boolean;
  evidence: string;
}

export interface Checkpoint {
  runId: string;
  stateVersion: number;
  trajectoryOffset: number;
  contextHash: string | null;
  artifactsHash: string;
  createdAt: string;
}
