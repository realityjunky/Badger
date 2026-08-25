import { createStandaloneWorkflowKernel } from "../workflow-kernel/foundation.js";

export { readPlan } from "../workflow-kernel/foundation.js";

export async function buildProposal(options: {
  projectRoot: string;
  planPath: string;
  homeDir?: string;
}) {
  return createStandaloneWorkflowKernel({
    projectRoot: options.projectRoot,
    homeDir: options.homeDir,
  }).buildProposal(options.planPath);
}
