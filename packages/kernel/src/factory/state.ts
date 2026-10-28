import {
  createStandaloneWorkflowKernel,
  type ApprovedProposal,
  type InitializeStateOptions,
} from "../workflow-kernel/foundation.js";
import type { CreatorState, SkillCandidate } from "../types.js";

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

export async function verifyApprovedProposal(
  state: CreatorState,
  options: { sourceRoots?: readonly string[] } = {},
): Promise<ApprovedProposal> {
  return createStandaloneWorkflowKernel({
    projectRoot: state.projectRoot,
    sourceRoots: options.sourceRoots,
  }).verifyApprovedProposal(state);
}

/**
 * The hash `init` quotes to replace a Creator state: the state file exactly as
 * stored. Null when the workflow has no Creator state.
 */
export async function creatorStateHash(
  projectRoot: string,
  name: string,
): Promise<string | null> {
  return createStandaloneWorkflowKernel({ projectRoot }).stateHash(name);
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
