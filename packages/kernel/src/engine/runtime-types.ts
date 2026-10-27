import type { ActionOutcome, EngineAction, RunState } from "./types.js";
import type {
  WorkflowArtifactId,
  WorkflowArtifactPath,
  WorkflowArtifactSelection,
  WorkflowArtifactVersionId,
  WorkflowArtifactVersion,
  WorkflowVerificationReceiptReference,
  WorkflowVerificationReceipt,
} from "../types.js";

export interface WorkflowArtifactMutation {
  versions: WorkflowArtifactVersion[];
  selections: WorkflowArtifactSelection[];
  artifactPaths: Record<WorkflowArtifactId, WorkflowArtifactPath>;
  selectedVersionIds: Record<WorkflowArtifactId, WorkflowArtifactVersionId>;
  verificationReceipts?: WorkflowVerificationReceiptReference[];
  verificationReceiptRecords?: WorkflowVerificationReceipt[];
}

export interface RuntimeContext {
  changeDir: string;
  state: RunState;
}

export interface RuntimeAdapter {
  readonly id: string;
  supports(action: EngineAction): boolean;
  execute(
    action: EngineAction,
    context: RuntimeContext,
  ): Promise<ActionOutcome>;
}
