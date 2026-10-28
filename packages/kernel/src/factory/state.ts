import { createStandaloneWorkflowKernel } from "../workflow-kernel/foundation.js";
import type { CreatorState, SkillCandidate } from "../types.js";
import type { InitializeStateOptions } from "../workflow-kernel/foundation.js";

export async function readState(
  projectRoot: string,
  name: string,
): Promise<CreatorState> {
  return createStandaloneWorkflowKernel({ projectRoot }).readState(name);
}

export async function writeState(state: CreatorState): Promise<void> {
  await createStandaloneWorkflowKernel({
    projectRoot: state.projectRoot,
  }).writeState(state);
}

export async function initializeState(
  options: InitializeStateOptions & {
    projectRoot: string;
    sourceRoots?: readonly string[];
  },
): Promise<CreatorState> {
  return createStandaloneWorkflowKernel({
    projectRoot: options.projectRoot,
    sourceRoots: options.sourceRoots,
  }).initializeState(options);
}

export async function updateCandidates(
  projectRoot: string,
  name: string,
  candidates: SkillCandidate[],
): Promise<CreatorState> {
  return createStandaloneWorkflowKernel({ projectRoot }).updateCandidates(
    name,
    candidates,
  );
}
