import { initializeAuthoringSession } from "../authoring/lifecycle.js";
import { buildAuthoringPlan } from "../authoring/plan.js";
import type { AuthoringDepth } from "../authoring/types.js";
import type { CreatorState, FactoryProposal } from "../types.js";
import { generatePackage, type GeneratedPackage } from "./generate.js";
import { readState, verifyApprovedProposal } from "./state.js";

export interface ApprovedGenerationOptions {
  projectRoot: string;
  name: string;
  stateNamespace?: string;
  /** The person's explicit confirmation; generation refuses without it. */
  confirmed: boolean;
  sourceRoots?: readonly string[];
  depth?: AuthoringDepth;
}

export interface ApprovedGeneration {
  state: CreatorState;
  /** The approved proposal the scaffold was generated from. */
  proposal: FactoryProposal;
  generated: GeneratedPackage;
}

/**
 * Generates the authoring-pending scaffold once a person confirms it, and only
 * from the approved proposal: a plan or Skill source set that drifted from it,
 * or a state whose recorded proposal no longer matches its hash, is refused
 * before anything is written.
 */
export async function generateFromApprovedProposal(
  options: ApprovedGenerationOptions,
): Promise<ApprovedGeneration> {
  if (!options.confirmed)
    throw new Error("Generation requires explicit confirmation");
  const state = await readState(
    options.projectRoot,
    options.name,
    options.stateNamespace,
  );
  const { proposal, plan } = await verifyApprovedProposal(state, {
    sourceRoots: options.sourceRoots,
  });
  const generated = await generatePackage({
    proposal,
    plan,
    destination: state.draftPath,
    projectRoot: state.projectRoot,
    sourceRoots: options.sourceRoots,
    authoringDepth: options.depth,
  });
  const updated = await initializeAuthoringSession({
    state,
    plan: await buildAuthoringPlan({ proposal, depth: options.depth }),
    generated,
  });
  return { state: updated, proposal, generated };
}
