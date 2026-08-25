export type CreatorIntent = "new-skill" | "upgrade-existing";

export type NodeKind =
  "control" | "producer" | "action" | "handoff" | "guardrail";
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

export interface ArtifactSchema {
  id: string;
  kind: "file" | "directory" | "state" | "report";
  required: boolean;
  paths: string[];
  validations: ValidationKind[];
}

export interface EvidenceSchema {
  id: string;
  required: boolean;
}

export interface OutputSchema {
  id: string;
  description: string;
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
  operations: NodeOperation[];
  outputSchemas: string[];
  guardrails: Guardrail[];
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
  edges: Array<{
    from: string;
    to: string | null;
    condition: "success" | "failure" | "pause";
  }>;
  outputSchemas: OutputSchema[];
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
    bundleRoot?: string;
    packageRoot: string;
    protocolPath: string;
    evalPath: string;
    authoringPlanPath?: string;
  };
  eval?: { hash: string; passed: boolean; resultPath: string };
  authoring?: AuthoringStateSummary;
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
}

export type AuthoringLaneId =
  | "script"
  | "reference"
  | "pause-points"
  | "workflow-entry"
  | "skill-core"
  | "skill-review";

export type AuthoringStatus =
  "PENDING" | "IN_PROGRESS" | "COMPLETE" | "BLOCKED" | "NEEDS_CONTEXT";

export type AuthoringClaimStatus =
  "SUPPORTED" | "UNSUPPORTED" | "NEEDS_CONTEXT";

export interface AuthoringClaimDefinition {
  id: string;
  statement: string;
  required: boolean;
}

export interface AuthoringArtifactDefinition {
  id: string;
  path: string;
  kind: "file" | "directory";
  required: boolean;
}

export interface AuthoringLaneDefinition {
  lane: AuthoringLaneId;
  dependsOn: AuthoringLaneId[];
  claims: AuthoringClaimDefinition[];
  artifacts: AuthoringArtifactDefinition[];
  reviewRequired?: boolean;
}

export interface AuthoringPlan {
  schemaVersion: 1;
  kind: "authoring-plan";
  workflow: string;
  protocolHash: string;
  lanes: AuthoringLaneDefinition[];
}

export interface AuthoringClaimEvidence {
  id: string;
  status: AuthoringClaimStatus;
  evidence: string[];
}

export interface AuthoringArtifactEvidence {
  id: string;
  path: string;
  present: boolean;
  contentHash?: string;
}

export interface AuthoringReviewOutput {
  decision: "approved" | "rejected" | "needs_context";
  reviewer: string;
  summary: string;
  blockingFindings: string[];
  warnings: string[];
}

export interface AuthoringRecord {
  schemaVersion: 1;
  kind: "authoring-record";
  workflow: string;
  lane: AuthoringLaneId;
  status: AuthoringStatus;
  protocolHash: string;
  bundleHash: string;
  claims: AuthoringClaimEvidence[];
  artifacts: AuthoringArtifactEvidence[];
  review?: AuthoringReviewOutput;
  summary?: string;
  at: string;
}

export interface AuthoringRecordInput {
  status: AuthoringStatus;
  claims: AuthoringClaimEvidence[];
  artifacts: AuthoringArtifactEvidence[];
  review?: AuthoringReviewOutput;
  summary?: string;
}

export interface AuthoringStateSummary {
  planPath: string;
  recordsPath: string;
  records: Partial<
    Record<
      AuthoringLaneId,
      { path: string; status: AuthoringStatus; bundleHash: string }
    >
  >;
}

export interface AuthoringReadiness {
  state: "blocked" | "needs-context" | "ready";
  blockers: string[];
  warnings: string[];
  evidence: Record<string, string>;
  records: Partial<Record<AuthoringLaneId, AuthoringRecord>>;
}
