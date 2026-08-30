import type {
  ActionOutcome,
  EngineAction,
  RuntimeIdentity,
  WorkflowVisitState,
} from "../engine/types.js";
import type { NodeProtocol, OutputSchema, WorkflowProtocol } from "../types.js";

export type WorkflowExecutionIdentity = RuntimeIdentity;

export type WorkflowPendingAction = EngineAction;

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
  disposition: "continue" | "blocked" | "done";
  runId: string;
  revision: number;
  currentNode: string | null;
  cycleId: string | null;
  attemptId: string | null;
  visitOrdinal: number | null;
  retryOrdinal: number | null;
  pendingAction: WorkflowPendingAction | null;
  execution: WorkflowExecutionIdentity;
  blockers: string[];
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
  blockers: string[];
}

export type StartWorkflowRunOptions =
  | {
      protocol: WorkflowProtocol;
      location: ManualWorkflowRunLocation;
      runId?: string;
      confirmations?: Iterable<string>;
    }
  | {
      protocol: WorkflowProtocol;
      location: StandaloneWorkflowRunLocation;
      confirmations?: Iterable<string>;
    }
  | {
      protocol: WorkflowProtocol;
      runRoot: string;
      runId?: string;
      confirmations?: Iterable<string>;
    };

export interface ResumeWorkflowRunOptions {
  confirmations?: Iterable<string>;
}

export type RecoverWorkflowRunOptions = ResumeWorkflowRunOptions;

export interface WorkflowSubmission extends ActionOutcome {
  nodeId?: string | null;
}

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
