import type { WorkflowRunReport, WorkflowRunEvent } from "@realityjunky/badger";
import type {
  WorkflowDecisionSubmission,
  WorkflowFinalizationPreview,
} from "@realityjunky/badger/workflow-runtime";
export interface RunGate {
  id: string;
  state: "open" | "answered" | "superseded";
  revision: number;
  pendingAction: NonNullable<
    WorkflowRunReport["continuation"]["pendingAction"]
  >;
  finalizationPreview: WorkflowFinalizationPreview | null;
  canAnswer: boolean;
  answer: {
    actorId: string;
    answeredAt: string;
    submission: WorkflowDecisionSubmission;
  } | null;
}
export interface Run {
  id: string;
  workflowId: string;
  publicationId: string;
  packageHash: string;
  personId: string;
  personName: string;
  localRunId: string;
  hostLabel: string;
  agentHost: string;
  testRun: boolean;
  createdAt: string;
  updatedAt: string;
  lastSequence: number;
  projection: WorkflowRunReport["projection"] | null;
  continuation: WorkflowRunReport["continuation"] | null;
  needsRecovery: boolean;
  integrityFindings: {
    code:
      "unattested-decision" | "event-sequence-gap" | "package-hash-mismatch";
    message: string;
    evidence: Record<string, unknown>;
    detectedAt: string;
  }[];
  recovery: {
    requestId: string;
    outcome: "settled" | "blocked";
    revision: number;
    lastSequence: number;
    reportedAt: string;
  } | null;
  events?: WorkflowRunEvent[];
  eventsTruncated?: boolean;
}
