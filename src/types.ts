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
  | "verified-checkpoints";

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
}

export interface WorkflowDurabilityProfile {
  version: 1;
  capabilities: WorkflowDurabilityCapability[];
  bounds: WorkflowDurabilityBounds;
  schemaVersions: WorkflowDurabilitySchemaVersions;
  findingCatalogVersion: 1;
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
  origin: "project" | "global" | "explicit" | "extra";
  description: string;
  skillMd: string;
  references: Array<{ path: string; contentHash: string }>;
  scripts: Array<{ path: string; sideEffect: "unknown" }>;
  hash: string;
}

export interface SkillCandidate {
  query: string;
  preferenceIndex: number | null;
  status: "available" | "missing" | "ambiguous";
  sources: SkillSource[];
}

export interface FactoryPlan {
  schemaVersion: 1;
  goal: string;
  skillCreatorIntent: CreatorIntent;
  preferredSkills: string[];
  workflow: WorkflowInput;
  sourceRoot?: string;
  skillRoots?: string[];
  artifactRoot?: string;
  defaultLocale: "en";
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
}

export type CreatorStatus =
  "draft" | "generated" | "evaluated" | "review-approved" | "published";

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
  generated?: {
    packageRoot: string;
    protocolPath: string;
    evalPath: string;
  };
  eval?: {
    hash: string;
    passed: boolean;
    resultPath: string;
    runtime?: WorkflowRuntimeCertificationEvidence;
  };
  review?: {
    hash: string;
    decision: "approved" | "rejected";
    reviewer: string;
    at: string;
  };
  published?: { hash: string; path: string; at: string };
}

export interface EvalReport {
  schemaVersion: 1;
  hash: string;
  passed: boolean;
  checks: Array<{ id: string; passed: boolean; detail: string }>;
  runtime?: WorkflowRuntimeCertificationEvidence;
}

export interface WorkflowRuntimeIdentityEvidence {
  protocolHash: string;
  packageHash: string;
  snapshotHash: string;
  nodeToStep: Record<string, string>;
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
