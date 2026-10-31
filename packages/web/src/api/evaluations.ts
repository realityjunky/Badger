import type {
  CompositeReadiness,
  EvalReport,
  WorkflowMcpCertificationEvidence,
} from "@realityjunky/badger";
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

/** Checks a report groups with runtime certification rather than package checks. */
export const isRuntimeCheck = (id: string) =>
  id === "workflow-runtime-certification" || id === "mcp-runtime-certification";

const MCP_NEGATIVE_CASES = [
  "rootBindingRequired",
  "refusedStartRegisteredNothing",
  "skippedNodeRefused",
  "missingCompletionRefused",
  "illegalRouteRefused",
  "exhaustedCycleRefused",
] as const satisfies readonly (keyof WorkflowMcpCertificationEvidence)[];

/** Badger MCP evidence shaped like a runtime phase, its refusals as negative cases. */
export function mcpPhaseEvidence(
  mcp: WorkflowMcpCertificationEvidence,
): Record<string, unknown> {
  const negative: readonly string[] = MCP_NEGATIVE_CASES;
  return {
    ...Object.fromEntries(
      Object.entries(mcp).filter(([key]) => !negative.includes(key)),
    ),
    negativeCases: Object.fromEntries(
      MCP_NEGATIVE_CASES.map((key) => [key, mcp[key]]),
    ),
  };
}
