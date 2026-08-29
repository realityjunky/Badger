import type {
  ActionOutcome,
  EngineAction,
  RuntimeIdentity,
} from "../engine/types.js";
import type { WorkflowProtocol } from "../types.js";

export type WorkflowExecutionIdentity = RuntimeIdentity;

export type WorkflowPendingAction = EngineAction;

export interface WorkflowContinuation {
  disposition: "continue" | "blocked" | "done";
  runId: string;
  currentNode: string | null;
  pendingAction: WorkflowPendingAction | null;
  execution: WorkflowExecutionIdentity;
  blockers: string[];
}

export interface StartWorkflowRunOptions {
  protocol: WorkflowProtocol;
  runRoot: string;
  runId?: string;
  confirmations?: Iterable<string>;
}

export interface ResumeWorkflowRunOptions {
  confirmations?: Iterable<string>;
}

export interface WorkflowSubmission extends ActionOutcome {
  nodeId?: string | null;
}

export interface WorkflowRuntime {
  start(options: StartWorkflowRunOptions): Promise<WorkflowContinuation>;
  resume(
    runRoot: string,
    options?: ResumeWorkflowRunOptions,
  ): Promise<WorkflowContinuation>;
  submit(
    runRoot: string,
    submission: WorkflowSubmission,
  ): Promise<WorkflowContinuation>;
}

export type Continuation = WorkflowContinuation;
export type StartOptions = StartWorkflowRunOptions;
export type Submission = WorkflowSubmission;
