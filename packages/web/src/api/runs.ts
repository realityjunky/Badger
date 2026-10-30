import type { WorkflowRunReport, WorkflowRunEvent } from "@realityjunky/badger";
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
  events?: WorkflowRunEvent[];
  eventsTruncated?: boolean;
}
