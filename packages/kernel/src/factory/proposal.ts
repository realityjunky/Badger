import { createStandaloneWorkflowKernel } from "../workflow-kernel/foundation.js";

export { parsePlan, readPlan } from "../workflow-kernel/foundation.js";

export async function buildProposal(options: {
  projectRoot: string;
  planPath: string;
  sourceRoots?: readonly string[];
}) {
  return createStandaloneWorkflowKernel({
    projectRoot: options.projectRoot,
    sourceRoots: options.sourceRoots,
  }).buildProposal(options.planPath);
}
