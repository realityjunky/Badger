import type { RuntimeIdentity } from "./engine/types.js";
import type { SemanticDossier } from "./factory/questionnaire.js";
import type {
  AuthoringCrossValidationResult,
  AuthoringReviewResult,
  AuthoringStateSummary,
} from "./authoring/types.js";

export type CreatorIntent = "new-skill" | "upgrade-existing";

export type NodeKind =
  "control" | "producer" | "action" | "decision" | "handoff" | "guardrail";
export type NodeOperation = "require" | "augment" | "override" | "disable";
export type BindingOperation = "default" | NodeOperation;
export type Enforcement =
  "guarded" | "handoff-guarded" | "evidence-only" | "advisory";
export type ValidationKind =
  | "evidence-only"
  | "artifact-exists"
  | "artifact-structured"
  | "semantic"
  | "state-transition";

export type WorkflowArtifactLifetime = "attempt" | "cycle" | "run";
export type WorkflowArtifactId = string;
export type WorkflowArtifactPath = string;
export type WorkflowArtifactVersionId = string;

export interface ArtifactSchema {
  id: string;
  kind: "file" | "directory" | "state" | "report";
  required: boolean;
  paths: string[];
  validations: ValidationKind[];
  lifetime?: WorkflowArtifactLifetime;
}

export interface EvidenceSchema {
  id: string;
  required: boolean;
}

export interface OutputSchema {
  id: string;
  description: string;
  optional?: boolean;
  artifacts: ArtifactSchema[];
  evidence: EvidenceSchema[];
}

export interface BindingInput {
  skill: string;
  operation?: BindingOperation;
  reason?: string;
  scope?: "main" | "handoff" | "review";
  enforcement?: Enforcement;
}

export interface Binding extends Required<Pick<BindingInput, "skill">> {
  operation: BindingOperation;
  scope: "main" | "handoff" | "review";
  enforcement: Enforcement;
  reason?: string;
}

export interface Guardrail {
  id: string;
  label: string;
  validation: ValidationKind;
  verification?: WorkflowVerificationRequirement;
}

export type DecisionScalarType = "string" | "number" | "boolean";
export type DecisionScalar = string | number | boolean;

export interface WorkflowDecisionInputField {
  id: string;
  type: DecisionScalarType;
  required?: boolean;
  values?: DecisionScalar[];
  enum?: DecisionScalar[];
}

export interface WorkflowDecisionInputSchema {
  type: "object";
  fields: WorkflowDecisionInputField[];
}

export interface WorkflowRationalePolicy {
  required?: boolean;
}

export interface WorkflowReviewerPolicy {
  subjects?: string[];
  authorities?: string[];
}

export interface WorkflowReviewerAttestation {
  subject: string;
  authorities: string[];
}

export interface WorkflowDecisionChoice {
  id: string;
  label: string;
  to?: string | null;
  target?: string | null;
  transition?: string | null;
  inputs?: WorkflowDecisionInputSchema;
  routing?: Record<string, string>;
}

export interface WorkflowDecisionDefinition {
  id: string;
  question: string;
  choices: WorkflowDecisionChoice[];
  inputs?: WorkflowDecisionInputSchema;
  rationale?: WorkflowRationalePolicy;
  reviewer?: WorkflowReviewerPolicy;
  scope?: WorkflowDecisionScope;
}

export interface WorkflowDecisionChoiceSummary {
  id: string;
  label: string;
  requiredInputs?: WorkflowDecisionInputSchema;
}

export interface WorkflowDecisionScopeEntry {
  id: string;
  required?: boolean;
}

export interface WorkflowDecisionScope {
  artifacts?: WorkflowDecisionScopeEntry[];
  evidence?: WorkflowDecisionScopeEntry[];
}

export interface WorkflowDecisionScopeReference {
  id: string;
  required: boolean;
  versionId: string;
  contentHash: string;
  producer: WorkflowArtifactProducer;
}

export interface WorkflowDecisionScopeSnapshot {
  artifacts: WorkflowDecisionScopeReference[];
  evidence: WorkflowDecisionScopeReference[];
}

export interface WorkflowDecisionScopeSelectionReference {
  id: string;
  versionId: string;
  contentHash: string;
  required?: boolean;
  producer?: WorkflowArtifactProducer;
}

export interface WorkflowDecisionScopeSelection {
  artifacts?: WorkflowDecisionScopeSelectionReference[];
  evidence?: WorkflowDecisionScopeSelectionReference[];
}

export type WorkflowVerificationKind =
  "automated-check" | "static-inspection" | "manual-evidence";
export type WorkflowVerificationStatus =
  "passed" | "failed" | "skipped" | "blocked";

export interface WorkflowVerificationEvidence {
  summary: string;
  outputHash: string;
  durationMs: number;
  truncated: boolean;
}

export interface WorkflowVerificationRequirement {
  id?: string;
  role: string;
  kind: WorkflowVerificationKind | WorkflowVerificationKind[];
  scope?: WorkflowDecisionScope;
  requireContentSnapshot?: boolean;
}

export interface WorkflowVerificationArtifactReference {
  artifactId: WorkflowArtifactId;
  versionId: WorkflowArtifactVersionId;
  contentHash: string;
  producer: WorkflowArtifactProducer;
}

interface WorkflowVerificationReceiptFields {
  schemaVersion: 1;
  receiptId: string;
  receiptHash: string;
  receiptKind: WorkflowVerificationKind;
  status: WorkflowVerificationStatus;
  requirementId: string;
  role: string;
  runId: string;
  revision: number;
  actionId: string;
  nodeId: string;
  cycleId: string | null;
  attemptId: string;
  execution: RuntimeIdentity;
  protocolHash: string;
  packageHash: string;
  snapshotHash: string;
  scopeHash: string;
  contentSnapshotHash: string | null;
  candidateArtifacts: WorkflowVerificationArtifactReference[];
  verifierSubject: string;
  provider: string;
  issuedAt: string;
  evidenceHash: string;
  truncated: boolean;
}

export interface WorkflowVerificationReceiptReference extends WorkflowVerificationReceiptFields {
  kind: "workflow-verification-receipt-reference";
}

export interface WorkflowVerificationReceipt extends WorkflowVerificationReceiptFields {
  kind: "workflow-verification-receipt";
  scope: WorkflowDecisionScopeSnapshot;
  evidence: WorkflowVerificationEvidence;
}

export interface WorkflowVerificationReceiptProposal {
  kind: WorkflowVerificationKind;
  status: WorkflowVerificationStatus;
  requirementId?: string;
  role?: string;
  scope?: WorkflowDecisionScopeSelection;
  artifactVersions?: Record<WorkflowArtifactId, WorkflowArtifactVersionId>;
  contentSnapshotHash?: string | null;
  verifierSubject?: string;
  verifier?: string;
  provider?: string;
  providerId?: string;
  evidence?: WorkflowVerificationEvidence;
  summary?: string;
  outputHash?: string;
  durationMs?: number;
  truncated?: boolean;
}

export interface WorkflowVerificationSubmission {
  proposals?: WorkflowVerificationReceiptProposal[];
  receiptIds?: string[];
}

export interface NodeTemplate {
  id: string;
  label: string;
  kind: NodeKind;
  responsibility: string;
  implementation: BindingInput & {
    operation: BindingOperation;
    scope: "main" | "handoff" | "review";
  };
  requiredSkillCalls?: BindingInput[];
  augmentations?: BindingInput[];
  satisfies?: string[];
  disabled?: boolean;
  optional?: boolean;
  operations: NodeOperation[];
  outputSchemas: string[];
  guardrails: Guardrail[];
  decision?: WorkflowDecisionDefinition;
}

export interface NodePatch {
  implementation?: BindingInput;
  requiredSkillCalls?: BindingInput[];
  augmentations?: BindingInput[];
  outputSchemas?: string[];
  satisfies?: string[];
  disabled?: boolean;
}

export interface WorkflowInput {
  kind: "workflow-kernel";
  name: string;
  goal: string;
  nodes?: Record<string, NodePatch>;
  customNodes: NodeTemplate[];
  outputSchemas?: OutputSchema[];
  routing?: WorkflowRouting;
  cycles?: WorkflowCycleDefinition[];
  capabilities?: WorkflowProtocolCapabilities;
  finalization?: WorkflowFinalizationDefinition;
}

export type TransitionCondition = "success" | "failure" | "pause";

export interface WorkflowRoutingPredicate {
  field: string;
  equals: string;
}

export interface WorkflowRoutingConjunction {
  all: WorkflowRoutingPredicate[];
}

export type WorkflowRoutingCondition =
  | string
  | WorkflowRoutingPredicate
  | WorkflowRoutingPredicate[]
  | WorkflowRoutingConjunction;

export interface WorkflowRoutingField {
  id?: string;
  name?: string;
  values?: string[];
  allowedValues?: string[];
}

export interface WorkflowTransition {
  from: string;
  to: string | null;
  condition: TransitionCondition;
  when?: WorkflowRoutingCondition;
}

export interface WorkflowCycleRepeatTransition {
  from: string;
  to: string;
}

export interface WorkflowCycleDefinition {
  key: string;
  entry: string;
  repeatTransitions: WorkflowCycleRepeatTransition[];
  maxInstances: number;
}

export interface WorkflowRoute {
  id: string;
  nodeOrder: string[];
  requiredOutputSchemas?: string[];
}

export interface WorkflowRouting {
  transitions: WorkflowTransition[];
  routes?: WorkflowRoute[];
  fields?: WorkflowRoutingField[] | Record<string, string[]>;
  routingFields?: WorkflowRoutingField[] | Record<string, string[]>;
}

export type WorkflowProtocolCapability =
  | "conditional-routing"
  | "revisioned-attempts"
  | "decision-nodes"
  | "bounded-cycles"
  | "versioned-artifacts";

export type WorkflowDurabilityCapability =
  | "mutation-locks"
  | "revision-fences"
  | "transition-journal"
  | "verified-checkpoints"
  | "content-snapshots"
  | "verification-receipts"
  | "repair-policy"
  | "transactional-finalization";

export type WorkflowFinalizationOperationKind = "write" | "remove" | "move";

export interface WorkflowFinalizationRoot {
  id: string;
  path: string;
}

export interface WorkflowFinalizationWriteOperation {
  id: string;
  kind: "write";
  root: string;
  target: string;
  content: string;
  requiresConfirmation?: boolean;
}

export interface WorkflowFinalizationRemoveOperation {
  id: string;
  kind: "remove";
  root: string;
  target: string;
  requiresConfirmation?: boolean;
}

export interface WorkflowFinalizationMoveOperation {
  id: string;
  kind: "move";
  root: string;
  source: string;
  target: string;
  requiresConfirmation?: boolean;
}

export type WorkflowFinalizationOperation =
  | WorkflowFinalizationWriteOperation
  | WorkflowFinalizationRemoveOperation
  | WorkflowFinalizationMoveOperation;

export interface WorkflowFinalizationConfirmationPolicy {
  required?: boolean;
  reviewer?: WorkflowReviewerPolicy;
  rationale?: WorkflowRationalePolicy;
}

export interface WorkflowFinalizationDefinition {
  schemaVersion: 1;
  roots: WorkflowFinalizationRoot[];
  operations: WorkflowFinalizationOperation[];
  confirmation?: WorkflowFinalizationConfirmationPolicy;
  requiredVerificationReceiptIds?: string[];
  requireContentSnapshot?: boolean;
}

export interface WorkflowFinalizationMaterialIdentity {
  exists: boolean;
  bytes: number;
  sha256: string | null;
}

export interface WorkflowFinalizationPlannedOperation {
  id: string;
  kind: WorkflowFinalizationOperationKind;
  rootId: string;
  source: string | null;
  target: string;
  stagedPath: string | null;
  backupPath: string | null;
  quarantinePath: string | null;
  precondition: {
    source: WorkflowFinalizationMaterialIdentity | null;
    target: WorkflowFinalizationMaterialIdentity;
  };
  expectedPostState: {
    source: WorkflowFinalizationMaterialIdentity | null;
    target: WorkflowFinalizationMaterialIdentity;
  };
  contentHash: string | null;
  contentBytes: number;
  requiresConfirmation: boolean;
}

export interface WorkflowFinalizationPreview {
  schemaVersion: 1;
  kind: "workflow-finalization-preview";
  runId: string;
  revision: number;
  actionId: string | null;
  transactionId: string;
  roots: WorkflowFinalizationRoot[];
  execution: RuntimeIdentity;
  contentSnapshotHash: string | null;
  verificationReceiptIds: string[];
  operations: WorkflowFinalizationPlannedOperation[];
  confirmation: WorkflowFinalizationConfirmationPolicy;
  requiresConfirmation: boolean;
  planHash: string;
}

export interface WorkflowFinalizationPendingConfirmation {
  schemaVersion: 1;
  kind: "workflow-finalization-confirmation";
  decisionId: string;
  actionId: string;
  sourceActionId: string;
  planHash: string;
  revision: number;
  planRevision: number;
  contentSnapshotHash: string | null;
  verificationReceiptIds: string[];
  reviewer: WorkflowReviewerPolicy;
  rationale: WorkflowRationalePolicy;
}

export type WorkflowFinalizationStatus =
  | "awaiting-confirmation"
  | "applying"
  | "committed"
  | "rolling-back"
  | "rolled-back"
  | "blocked";

export interface WorkflowFinalizationState {
  schemaVersion: 1;
  status: WorkflowFinalizationStatus;
  planHash: string;
  revision: number;
  sourceActionId: string;
  planRevision: number;
  pendingConfirmation?: WorkflowFinalizationPendingConfirmation;
  confirmationActionId?: string;
  confirmationCount?: number;
  transactionId?: string;
  receipt?: WorkflowFinalizationReceiptReference;
}

export interface WorkflowFinalizationConfirmationRecord {
  decisionId: string;
  actionId: string;
  sourceActionId: string;
  planHash: string;
  revision: number;
  choiceId: "confirm";
  reviewer: WorkflowReviewerAttestation;
  rationaleHash: string | null;
  confirmedAt: string;
}

export interface WorkflowFinalizationOperationReceipt {
  id: string;
  kind: WorkflowFinalizationOperationKind;
  source: string | null;
  target: string;
  stagedPath: string | null;
  backupPath: string | null;
  quarantinePath: string | null;
  precondition: {
    source: WorkflowFinalizationMaterialIdentity | null;
    target: WorkflowFinalizationMaterialIdentity;
  };
  expectedPostState: {
    source: WorkflowFinalizationMaterialIdentity | null;
    target: WorkflowFinalizationMaterialIdentity;
  };
  observedPostState: {
    source: WorkflowFinalizationMaterialIdentity | null;
    target: WorkflowFinalizationMaterialIdentity;
  };
  status: "committed" | "rolled-back";
}

export type WorkflowFinalizationCleanupStatus =
  "pending" | "cleaned" | "missing";

export interface WorkflowFinalizationCleanupEntry {
  operationId: string;
  role: "staged" | "backup" | "quarantine";
  path: string;
  expected: WorkflowFinalizationMaterialIdentity;
  status: WorkflowFinalizationCleanupStatus;
}

export interface WorkflowFinalizationCleanup {
  status: "pending" | "completed";
  entries: WorkflowFinalizationCleanupEntry[];
}

export interface WorkflowFinalizationEvent {
  sequence: number;
  type:
    | "prepared"
    | "applying"
    | "operation-staged"
    | "operation-started"
    | "operation-completed"
    | "operation-quarantined"
    | "operation-published"
    | "operation-verified"
    | "committing"
    | "receipt-written"
    | "committed"
    | "rolling-back"
    | "operation-rolled-back"
    | "rolled-back"
    | "cleanup-started"
    | "cleanup-item"
    | "cleanup-completed";
  operationId: string | null;
  boundary: string;
  timestamp: string;
}

export interface WorkflowFinalizationReceipt {
  schemaVersion: 1;
  kind: "workflow-finalization-receipt";
  receiptId: string;
  receiptHash: string;
  transactionId: string;
  runId: string;
  revision: number;
  resultingRevision: number;
  planHash: string;
  execution: RuntimeIdentity;
  contentSnapshotHash: string | null;
  verificationReceiptIds: string[];
  confirmation: WorkflowFinalizationConfirmationRecord;
  operations: WorkflowFinalizationOperationReceipt[];
  events: WorkflowFinalizationEvent[];
  cleanup: WorkflowFinalizationCleanup;
  recovery: {
    status: "none" | "recovered" | "rolled-back";
    crashBoundaries: string[];
  };
  committedAt: string;
}

export interface WorkflowFinalizationReceiptReference {
  schemaVersion: 1;
  kind: "workflow-finalization-receipt-reference";
  receiptId: string;
  receiptHash: string;
  transactionId: string;
  planHash: string;
  runId: string;
  revision: number;
  resultingRevision: number;
  status: "committed" | "rolled-back";
}

export interface WorkflowFinalizationSubmission {
  planHash?: string;
  decisionId?: string;
  choiceId?: "confirm" | "cancel";
  contentSnapshotHash?: string | null;
  verificationReceiptIds?: string[];
}

export type WorkflowContentSnapshotProvider = "physical-tree" | "git";
export type WorkflowContentSnapshotOrigin = "explicit";

export type WorkflowContentSnapshotFallbackReason =
  "git-metadata-unavailable" | "git-provider-error" | "git-nested-repository";

export type WorkflowContentSnapshotOmissionReason =
  | "file-size"
  | "file-count"
  | "total-size"
  | "manifest-size"
  | "changed-during-read"
  | "unreadable"
  | "non-regular"
  | "duration"
  | "physical-enumeration-limit"
  | "physical-selection-changed"
  | "deleted"
  | "git-enumeration-limit"
  | "git-selection-changed"
  | "git-metadata-unavailable"
  | "git-provider-error"
  | "git-nested-repository";

export interface WorkflowContentSnapshotLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxManifestBytes: number;
  maxVisitedNodes: number;
  maxDurationMs: number;
  maxOmissionEntries: number;
}

export interface WorkflowContentSnapshotPolicy {
  schemaVersion: 1;
  provider: WorkflowContentSnapshotProvider;
  fallback?: "physical-tree";
  include: string[];
  exclude: string[];
  limits: WorkflowContentSnapshotLimits;
  hash: string;
}

export interface WorkflowPhysicalSnapshotSelectionStream {
  hash: string;
  visitedNodeCount: number;
  recordCount: number;
  storedRecordCount: number;
  encodedBytes: number;
  overflow: boolean;
  unstable: boolean;
}

export interface WorkflowPhysicalSnapshotSelection {
  schemaVersion: 1;
  status: "overflow" | "changed" | "overflow-and-changed";
  before: WorkflowPhysicalSnapshotSelectionStream;
  after: WorkflowPhysicalSnapshotSelectionStream;
}

export interface WorkflowGitSnapshotSelectionStream {
  hash: string;
  indexHash: string | null;
  workingTreeHash: string | null;
  visitedNodeCount: number;
  recordCount: number;
  storedRecordCount: number;
  encodedBytes: number;
  outputBytes: number;
  durationMs: number;
  overflow: boolean;
  unstable: boolean;
}

export interface WorkflowGitSnapshotSelection {
  schemaVersion: 1;
  status: "stable" | "overflow" | "changed" | "overflow-and-changed";
  before: WorkflowGitSnapshotSelectionStream;
  after: WorkflowGitSnapshotSelectionStream;
}

export interface WorkflowGitSnapshotMetadata {
  head: string | null;
  index: string | null;
  workingTree: string | null;
}

export interface WorkflowGitSnapshotEvidence {
  schemaVersion: 1;
  status: "available" | "unavailable" | "error" | "nested-repository";
  before: WorkflowGitSnapshotMetadata;
  after: WorkflowGitSnapshotMetadata;
  diagnostics: string[];
}

export interface WorkflowContentSnapshotFallback {
  from: "git";
  to: "physical-tree";
  reason: WorkflowContentSnapshotFallbackReason;
}

export interface WorkflowContentSnapshotCapture {
  provider: WorkflowContentSnapshotProvider;
  requestedProvider?: WorkflowContentSnapshotProvider;
  fallback?: WorkflowContentSnapshotFallback;
  physicalSelection?: WorkflowPhysicalSnapshotSelection;
  gitSelection?: WorkflowGitSnapshotSelection;
  gitEvidence?: WorkflowGitSnapshotEvidence;
}

export interface WorkflowContentSnapshotEntry {
  path: string;
  hash: string;
  size: number;
  type: "file";
}

export interface WorkflowContentSnapshotOmission {
  path: string;
  size: number | null;
  type: "file" | "directory" | "other";
  reason: WorkflowContentSnapshotOmissionReason;
}

export interface WorkflowContentSnapshotOmissionOverflow {
  ref: string;
  hash: string;
  count: number;
}

export interface WorkflowContentSnapshotManifest {
  schemaVersion: 1;
  kind: "workflow-content-snapshot";
  origin: WorkflowContentSnapshotOrigin;
  capture: WorkflowContentSnapshotCapture;
  createdAt: string;
  complete: boolean;
  policy: WorkflowContentSnapshotPolicy;
  limits: WorkflowContentSnapshotLimits;
  entries: WorkflowContentSnapshotEntry[];
  omitted: WorkflowContentSnapshotOmission[];
  omittedCount: number;
  omissionOverflow?: WorkflowContentSnapshotOmissionOverflow;
}

export interface WorkflowContentSnapshotReference {
  schemaVersion: 1;
  kind: "workflow-content-snapshot-reference";
  hash: string;
  path: string;
  provider: WorkflowContentSnapshotProvider;
  complete: boolean;
}

export interface WorkflowDurabilityBounds {
  runStateBytes: number;
  pendingActionBytes: number;
  trajectoryBytes: number;
  artifactsBytes: number;
  claimBytes: number;
  transitionJournalBytes?: number;
  runLockBytes?: number;
  checkpointManifestBytes?: number;
  checkpointRecordBytes?: number;
  checkpointCount?: number;
  verificationReceiptBytes?: number;
  verificationReceiptCount?: number;
  repairHistoryBytes?: number;
  repairHistoryCount?: number;
  repairEpisodeBytes?: number;
  repairEpisodeCount?: number;
  repairHistoryRecords?: number;
  repairEpisodeRecords?: number;
  finalizationPlanBytes?: number;
  finalizationTransactionBytes?: number;
  finalizationReceiptBytes?: number;
  finalizationContentBytes?: number;
  finalizationOperationCount?: number;
  finalizationEventCount?: number;
}

export interface WorkflowDurabilitySchemaVersions {
  runState: 1;
  pendingAction: 1;
  trajectory: 1;
  artifacts: 1;
  revisionClaim: 1;
  transitionJournal?: 1;
  runLock?: 1;
  checkpointManifest?: 1;
  checkpointRecord?: 1;
  contentSnapshot?: 1;
  verificationReceipt?: 1;
  repairEpisode?: 1;
  repairHistory?: 1;
  repair?: 1;
  finalizationTransaction?: 1;
  finalizationReceipt?: 1;
}

export interface WorkflowVerificationPolicy {
  maxSummaryBytes: number;
  maxEvidenceBytes: number;
}

export type WorkflowRepairDisposition =
  "continue" | "warning" | "manual-stop" | "hard-stop";

export type WorkflowRepairOutcome = "retry" | "stop" | "contract-change";

export interface WorkflowRepairChoice {
  id: string;
  label: string;
  outcome: WorkflowRepairOutcome;
}

export type WorkflowRepairChoiceInput =
  | WorkflowRepairChoice
  | {
      id?: string;
      choiceId?: string;
      label?: string;
      description?: string;
      outcome?: string;
      effect?: string;
      kind?: string;
    }
  | WorkflowRepairOutcome
  | "retry-with-new-approach"
  | "replace-run";

export interface WorkflowRepairOverridePolicy {
  enabled?: boolean;
  maxRationaleBytes?: number;
  maxOverrideRationaleBytes?: number;
  maxBytes?: number;
}

export interface WorkflowRepairAutomaticOperation {
  id: string;
  operation: "workflow.resume";
  idempotent: true;
  maxExecutions: number;
}

export interface WorkflowRepairPolicy {
  maxFailures?: number;
  maxRepairFailures?: number;
  maxVerifyFailures?: number;
  maxRepairIterations?: number;
  warningThreshold?: number;
  warningAtConsecutiveFailures?: number;
  warningAfter?: number;
  warnAfter?: number;
  manualStopThreshold?: number;
  manualStopAtConsecutiveFailures?: number;
  stopAfter?: number;
  manualStopAfter?: number;
  allowedChoices?: WorkflowRepairChoiceInput[];
  choices?: WorkflowRepairChoiceInput[];
  allowOneTimeOverride?: boolean;
  allowOverride?: boolean;
  oneTimeOverride?: WorkflowRepairOverridePolicy | boolean;
  override?: WorkflowRepairOverridePolicy | boolean;
  overridePolicy?: WorkflowRepairOverridePolicy | boolean;
  automaticRepair?: WorkflowRepairAutomaticOperation;
  automaticRepairs?: WorkflowRepairAutomaticOperation[];
  maxOverrideRationaleBytes?: number;
  maxRationaleBytes?: number;
  maxOverrideBytes?: number;
  reviewer?: WorkflowReviewerPolicy;
  rationale?: WorkflowRationalePolicy;
}

export interface WorkflowRepairFailureSignature {
  schemaVersion: 1;
  protocolHash: string;
  executionHash: string;
  actionId: string | null;
  attemptId: string | null;
  nodeId: string | null;
  cycleId: string | null;
  visitOrdinal: number | null;
  findingCodes: string[];
  failedReceiptCoverage: string[];
  failedAcceptanceCoverage: string[];
  scopeIdentities: string[];
  snapshotIdentities: string[];
  artifactIdentities: string[];
  signatureHash: string;
}

export interface WorkflowRepairFailureRecord {
  kind: "failure";
  revision: number;
  actionId: string | null;
  attemptId: string | null;
  signatureHash: string;
  findingCodes: string[];
  failedReceiptCoverage: string[];
  failedAcceptanceCoverage: string[];
  scopeIdentities: string[];
  snapshotIdentities: string[];
  artifactIdentities: string[];
  automaticRepair?: WorkflowRepairAutomaticOperation;
  disposition?: WorkflowRepairDisposition;
  reasonCode?: string;
  consecutiveFailures?: number;
  totalFailures?: number;
  remainingFailures?: number;
  overrideAccepted?: boolean;
}

export interface WorkflowRepairDecisionRecord {
  kind: "decision";
  revision: number;
  actionId: string;
  attemptId: string | null;
  signatureHash: string;
  decisionId: string;
  choiceId: string;
  outcome: WorkflowRepairOutcome;
  reviewer: WorkflowReviewerAttestation;
  rationaleHash: string | null;
  hypothesisHash: string | null;
}

export interface WorkflowRepairOverrideRecord {
  kind: "override";
  revision: number;
  actionId: string;
  attemptId: string | null;
  signatureHash: string;
  decisionId: string;
  choiceId: string;
  outcome: WorkflowRepairOutcome;
  reviewer: WorkflowReviewerAttestation;
  rationaleHash: string;
  hypothesisHash: string;
}

export type WorkflowRepairHistoryRecord =
  | WorkflowRepairFailureRecord
  | WorkflowRepairDecisionRecord
  | WorkflowRepairOverrideRecord;

export interface WorkflowRepairPendingDecision {
  schemaVersion: 1;
  decisionId: string;
  actionId: string;
  signatureHash: string;
  failureRevision: number;
  attemptId: string;
  stepId: string;
  nodeId: string;
  cycleId: string | null;
  visitOrdinal: number;
  retryOrdinal: number;
  choices: WorkflowRepairChoice[];
  rationale: WorkflowRationalePolicy;
  reviewer: WorkflowReviewerPolicy;
}

export interface WorkflowRepairEpisodeState {
  schemaVersion: 1;
  history: WorkflowRepairHistoryRecord[];
  signature: WorkflowRepairFailureSignature | null;
  disposition: WorkflowRepairDisposition | null;
  reasonCode: string | null;
  consecutiveFailures: number;
  totalFailures: number;
  remainingFailures: number;
  pendingDecision?: WorkflowRepairPendingDecision;
}

export interface WorkflowRepairDecisionOutcome {
  decisionId: string;
  signatureHash: string;
  choiceId: string;
  outcome: WorkflowRepairOutcome;
  reviewer: WorkflowReviewerAttestation;
  rationale?: string;
  hypothesis?: string;
}

export interface WorkflowDurabilityProfile {
  version: 1;
  capabilities: WorkflowDurabilityCapability[];
  bounds: WorkflowDurabilityBounds;
  schemaVersions: WorkflowDurabilitySchemaVersions;
  findingCatalogVersion: 1;
  snapshotPolicy?: WorkflowContentSnapshotPolicy;
  verificationPolicy?: WorkflowVerificationPolicy;
  repairPolicy?: WorkflowRepairPolicy;
  repair?: WorkflowRepairPolicy;
}

export interface WorkflowProtocolCapabilities {
  version: 3;
  features: WorkflowProtocolCapability[];
  durability?: WorkflowDurabilityProfile;
}

export interface NodeProtocol extends Omit<
  NodeTemplate,
  | "implementation"
  | "requiredSkillCalls"
  | "augmentations"
  | "satisfies"
  | "disabled"
> {
  implementation: Binding;
  requiredSkillCalls: Binding[];
  augmentations: Binding[];
  satisfies: string[];
  disabled: boolean;
}

export interface WorkflowProtocol {
  schemaVersion: 1;
  kind: "workflow-kernel";
  name: string;
  goal: string;
  nodes: NodeProtocol[];
  edges: WorkflowTransition[];
  outputSchemas: OutputSchema[];
  capabilities?: WorkflowProtocolCapabilities;
  finalization?: WorkflowFinalizationDefinition;
  routing?: WorkflowRouting;
  cycles?: WorkflowCycleDefinition[];
  state: {
    kind: "workflow-run";
    statePath: string;
    currentNodeField: "currentNode";
    completedNodesField: "completedNodes";
    evidenceField: "evidence";
  };
  evals: Array<{
    id: "workflow-route-conformance";
    expectedNodeOrder: string[];
    expectedRoutes?: WorkflowRoute[];
    requiredOutputSchemas: string[];
  }>;
}

export interface NormalizedWorkflow {
  input: WorkflowInput;
  protocol: WorkflowProtocol;
  requiredSkills: string[];
  sourceSkills: string[];
}

export interface SkillSource {
  name: string;
  root: string;
  origin: "explicit";
  description: string;
  skillMd: string;
  references: Array<{ path: string; contentHash: string }>;
  scripts: Array<{ path: string; sideEffect: "unknown" }>;
  hash: string;
}

export interface SkillSourceDeclaration {
  name: string;
  location: string;
}

export interface SkillSourceManifest {
  schemaVersion: 1;
  sources: SkillSourceDeclaration[];
}

export interface UpgradeSourceFileEvidence {
  path: string;
  bytes: number;
  hash: string;
}

export interface UpgradeSourceEvidence {
  schemaVersion: 1;
  kind: "badger-upgrade-source";
  root: string;
  hash: string;
  files: UpgradeSourceFileEvidence[];
}

export type UpgradeMigrationDecisionKind = "retained" | "replaced" | "wrapped";

export interface UpgradeMigrationDecision {
  sourcePath: string;
  preservedPath: string;
  destinationPath: string;
  sourceHash: string;
  decision: UpgradeMigrationDecisionKind;
  reason: string;
}

export interface UpgradeMigrationManifest {
  schemaVersion: 1;
  kind: "badger-upgrade-migration";
  sourceRoot: string;
  sourceHash: string;
  files: UpgradeSourceFileEvidence[];
  decisions: UpgradeMigrationDecision[];
  preservedAt: "scaffold" | "assembled";
}

export interface SkillCandidate {
  name: string;
  status: "available" | "missing" | "invalid" | "unsafe" | "ambiguous";
  sources: SkillSource[];
  blockers?: string[];
}

export type GeneratedPackageFileOwner = "auto" | "authored" | "source";

export interface GeneratedPackageFile {
  path: string;
  bytes: number;
  sha256: string;
  owner: GeneratedPackageFileOwner;
}

export interface FactoryPlan {
  schemaVersion: 1;
  goal: string;
  skillCreatorIntent: CreatorIntent;
  skillSources: SkillSourceDeclaration[];
  workflow: WorkflowInput;
  sourceRoot?: string;
  artifactRoot?: string;
  defaultLocale: "en";
  semanticDossier?: SemanticDossier;
}

export interface FactoryProposal {
  schemaVersion: 1;
  name: string;
  goal: string;
  intent: CreatorIntent;
  planHash: string;
  workflow: WorkflowProtocol;
  candidates: SkillCandidate[];
  blockers: string[];
  warnings: string[];
  canInitialize: boolean;
  sourceRoot?: string;
  upgradeSource?: UpgradeSourceEvidence;
  semanticDossierHash?: string;
  semanticDossier?: SemanticDossier;
}

export type CreatorStatus =
  "draft" | "generated" | "evaluated" | "review-approved" | "published";

export type CreatorDraftClassification =
  "uninitialized" | "legacy-scaffold-only" | "authoring-required";

export interface ReadinessSection {
  state: "blocked" | "ready";
  blockers: string[];
  warnings: string[];
  evidence: Record<string, string>;
  hashes: Record<string, string | null>;
  review?: AuthoringReviewResult;
}

export interface CompositeReadiness {
  state: "blocked" | "reviewable" | "publishable";
  blockers: string[];
  warnings: string[];
  evidence: Record<string, string>;
  hashes: Record<string, string | null>;
  authoring: ReadinessSection;
  runtime: ReadinessSection;
  publication: ReadinessSection;
}

export interface PublicationReadinessEvidence {
  packageHash: string;
  sourceEvidenceHash: string | null;
  authoringInputHash: string | null;
  authoredMaterialHash: string | null;
  assembledPackageHash: string | null;
  authoringReviewHash: string | null;
  evaluationHash: string | null;
  evaluationReportHash: string | null;
  runtimeEvidenceHash: string | null;
  readinessHash: string;
}

export interface CreatorState {
  schemaVersion: 1;
  name: string;
  status: CreatorStatus;
  projectRoot: string;
  planPath: string;
  planHash: string;
  draftPath: string;
  currentHash: string | null;
  candidates: SkillCandidate[];
  confirmedProposal?: FactoryProposal;
  generated?: {
    packageRoot: string;
    protocolPath: string;
    evalPath: string;
    authoringPlanPath?: string;
    scaffoldHash?: string;
    sourceRoot?: string;
    sourceHash?: string;
    assembledPackageHash?: string;
    inventory?: GeneratedPackageFile[];
    sourceEvidencePath?: string;
    sourceEvidence?: UpgradeMigrationManifest;
  };
  eval?: {
    hash: string;
    passed: boolean;
    resultPath: string;
    authoringCrossValidation?: AuthoringCrossValidationResult;
    runtime?: WorkflowRuntimeCertificationEvidence;
  };
  authoring?: AuthoringStateSummary;
  review?: {
    hash: string;
    decision: "approved" | "rejected";
    reviewer: string;
    at: string;
    readiness?: PublicationReadinessEvidence;
    readinessHash?: string;
    approvalHash?: string;
  };
  published?: { hash: string; path: string; at: string };
}

export interface EvalReport {
  schemaVersion: 1;
  hash: string;
  passed: boolean;
  checks: Array<{ id: string; passed: boolean; detail: string }>;
  authoringCrossValidation?: AuthoringCrossValidationResult;
  runtime?: WorkflowRuntimeCertificationEvidence;
}

export interface WorkflowRuntimeIdentityEvidence {
  protocolHash: string;
  packageHash: string;
  snapshotHash: string;
  nodeToStep: Record<string, string>;
  resolverHash?: string;
  findingCatalogVersion?: 1;
  durabilityProfile?: WorkflowDurabilityProfile;
}

export interface WorkflowRuntimeCertificationEvidence {
  authority: "WorkflowRuntime";
  phase2Applicable?: boolean;
  generatedPackageHash: string;
  identity: WorkflowRuntimeIdentityEvidence;
  declaredNodeOrder: string[];
  compiledNodeOrder: string[];
  observedNodeOrder: string[];
  runId: string;
  reverseRunId: string;
  recoveryCount: number;
  recovered: boolean;
  completed: boolean;
  identityConsistent: boolean;
  guardVerified: boolean;
  handoffConsistent: boolean;
  entryAdapterStarted: boolean;
  compatibilityAdapterResumed: boolean;
  freshProcessRecovered: boolean;
  publicRuntimeCompleted: boolean;
  reverseAdapterCompleted: boolean;
  phase3?: WorkflowRuntimePhase3CertificationEvidence;
  phase4?: WorkflowRuntimePhase4CertificationEvidence;
}

export const WORKFLOW_RUNTIME_PHASE4_NEGATIVE_CASES = [
  "stale-local-lock",
  "unknown-lock",
  "changed-journal-identity",
  "checkpoint-mismatch",
  "stale-verification-receipt",
  "content-drift",
  "snapshot-overflow",
  "snapshot-instability",
  "repair-stagnation",
  "override-exhaustion",
  "finalization-rollback",
  "ambiguous-finalization",
  "legacy-run-compatibility",
] as const;

export type WorkflowRuntimePhase4NegativeCase =
  (typeof WORKFLOW_RUNTIME_PHASE4_NEGATIVE_CASES)[number];

export interface WorkflowRuntimePhase4CertificationEvidence {
  status: "certified" | "failed";
  fixtureName: string;
  generatedPackageHash: string;
  evaluatedPackageHash: string;
  fixturePackageHash: string;
  identity: WorkflowRuntimeIdentityEvidence;
  declaredCapabilities: WorkflowDurabilityCapability[];
  runId: string;
  reverseRunId: string;
  manualRunId: string;
  standaloneRunId: string;
  lifecycle: {
    machineWork: boolean;
    persistedDecision: boolean;
    versionedArtifacts: boolean;
    verificationRequirement: boolean;
    contentSnapshot: boolean;
    contentDrift: boolean;
    repairEpisode: boolean;
    verifiedCheckpoint: boolean;
    finalizationPreview: boolean;
    finalizationConfirmed: boolean;
    finalReceipt: boolean;
  };
  locations: {
    manual: boolean;
    standalone: boolean;
    equivalent: boolean;
  };
  adapters: {
    generatedToPublic: boolean;
    publicToGenerated: boolean;
    thin: boolean;
    projectionsConsistent: boolean;
  };
  freshProcess: {
    pendingAction: boolean;
    decision: boolean;
    checkpoint: boolean;
    finalization: boolean;
    terminal: boolean;
    crashBoundaries: boolean;
    converged: boolean;
  };
  transitionJournalCrashBoundaries: Record<string, boolean>;
  finalizationCrashBoundaries: Record<string, boolean>;
  concurrency: {
    identical: {
      oneAccepted: boolean;
      oneConflict: boolean;
      noDuplicateOutcome: boolean;
      noDuplicateEvent: boolean;
      noDuplicateReceipt: boolean;
      noDuplicateNextAction: boolean;
    };
    conflicting: {
      oneAccepted: boolean;
      oneConflict: boolean;
      noDuplicateOutcome: boolean;
      noDuplicateEvent: boolean;
      noDuplicateReceipt: boolean;
      noDuplicateNextAction: boolean;
    };
  };
  identities: {
    protocol: boolean;
    package: boolean;
    snapshot: boolean;
    resolver: boolean;
    durabilityProfile: boolean;
    schema: boolean;
    catalog: boolean;
    nodeAction: boolean;
    cycleAttempt: boolean;
    contentSnapshot: boolean;
    verificationReceipt: boolean;
    checkpoint: boolean;
    finalizationTransaction: boolean;
    finalizationReceipt: boolean;
    generatedPackageTree: boolean;
  };
  negativeCases: Record<WorkflowRuntimePhase4NegativeCase, boolean>;
  allNegativeCases: boolean;
  generatedAdaptersThin: boolean;
  legacyRunUnchanged: boolean;
  sourceIntegrity: boolean;
  completed: boolean;
}

export const WORKFLOW_RUNTIME_PHASE3_NEGATIVE_CASES = [
  "stale-revision",
  "unrelated-action",
  "wrong-node",
  "wrong-cycle",
  "wrong-attempt",
  "invalid-choice",
  "unauthorized-reviewer",
  "missing-input",
  "missing-rationale",
  "stale-evidence-scope",
  "content-drift",
  "exact-replay",
  "cross-run-copy",
  "route-ambiguity",
  "route-no-match",
  "exhausted-cycle",
] as const;

export type WorkflowRuntimePhase3NegativeCase =
  (typeof WORKFLOW_RUNTIME_PHASE3_NEGATIVE_CASES)[number];

export interface WorkflowRuntimePhase3IdentityEvidence extends WorkflowRuntimeIdentityEvidence {
  capabilityVersion: 3;
  resolverHash: string;
}

export interface WorkflowRuntimePhase3CertificationEvidence {
  status: "certified" | "failed";
  fixtureName: string;
  generatedPackageHash: string;
  evaluatedPackageHash: string;
  fixturePackageHash: string;
  identity: WorkflowRuntimePhase3IdentityEvidence;
  expectedVisitOrder: string[];
  observedVisitOrder: string[];
  runId: string;
  reverseRunId: string;
  manualRunId: string;
  standaloneRunId: string;
  recoveryCount: number;
  dispositions: {
    continue: boolean;
    awaitUser: boolean;
    blocked: boolean;
    done: boolean;
  };
  recovery: {
    pendingMachine: boolean;
    awaitingDecision: boolean;
    acceptedBranch: boolean;
    afterScopedReceipt: boolean;
    betweenCycles: boolean;
    terminal: boolean;
    freshProcess: boolean;
  };
  branch: {
    conditional: boolean;
    selected: string;
    defaultRoute: boolean;
    terminalChoice: boolean;
  };
  cycle: {
    declared: boolean;
    repeatTransition: boolean;
    repeatedNodeVisits: number;
    instances: number;
    budgetRejected: boolean;
  };
  attempts: {
    rework: boolean;
    retryStable: boolean;
    uniqueVisits: boolean;
  };
  artifacts: {
    attemptVersion: boolean;
    runVersion: boolean;
    carryForward: boolean;
    immutable: boolean;
  };
  decisions: {
    authorized: boolean;
    receiptCount: number;
    scopeBound: boolean;
    replayRejected: boolean;
  };
  entryDirections: {
    generatedToPublic: boolean;
    publicToGenerated: boolean;
    manualStandalone: boolean;
  };
  negativeCases: Record<WorkflowRuntimePhase3NegativeCase, boolean>;
  allNegativeCases: boolean;
  generatedAdaptersThin: boolean;
  identityReconciled: boolean;
  projectionsConsistent: boolean;
  sourceIntegrity: boolean;
  completed: boolean;
}

export interface WorkflowDecisionReceipt {
  runId: string;
  revision: number;
  resultingRevision: number;
  actionId: string;
  decisionId: string;
  nodeId: string;
  cycleId: string | null;
  attemptId: string;
  choiceId: string;
  reviewer: WorkflowReviewerAttestation;
  inputs: Record<string, DecisionScalar>;
  rationale?: string;
  evidenceReferences?: string[];
  scope?: WorkflowDecisionScopeSnapshot;
  timestamp: string;
  protocolHash: string;
  packageHash: string;
  snapshotHash: string;
  verificationReceiptIds?: string[];
}

export interface WorkflowArtifactProducer {
  runId: string;
  nodeId: string;
  cycleId: string | null;
  attemptId: string;
  actionId: string;
  revision: number;
}

export interface WorkflowArtifactVersion {
  id: WorkflowArtifactVersionId;
  artifactId: WorkflowArtifactId;
  schemaId: string;
  lifetime: WorkflowArtifactLifetime;
  scopeId: string;
  contentHash: string;
  path: WorkflowArtifactPath;
  producer: WorkflowArtifactProducer;
  timestamp: string;
}

export interface WorkflowArtifactSelection {
  artifactId: WorkflowArtifactId;
  versionId: WorkflowArtifactVersionId;
  runId: string;
  nodeId: string;
  cycleId: string | null;
  attemptId: string;
  actionId: string;
  revision: number;
  timestamp: string;
}
