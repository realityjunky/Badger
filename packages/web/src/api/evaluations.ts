import type { CompositeReadiness, EvalReport } from "@realityjunky/badger";
import type { WorkflowJob } from "./workflows.js";
export interface EvaluationReport {
  id: string;
  jobId: string;
  packageId: string;
  packageHash: string;
  starterId: string;
  starterName: string;
  startedAt: string;
  finishedAt: string;
  durationMilliseconds: number;
  report: EvalReport;
}
export interface EvaluationsView {
  canEvaluate: boolean;
  currentPackageHash: string | null;
  passingReportId: string | null;
  readiness: CompositeReadiness | null;
  reports: EvaluationReport[];
  jobs: (WorkflowJob & { progress: { phase: string } | null })[];
}
