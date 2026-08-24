import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  CreatorState,
  FactoryPlan,
  FactoryProposal,
  SkillCandidate,
} from "../types.js";
import { atomicWrite, ensureDirectory } from "../util.js";

function stateFile(projectRoot: string, name: string): string {
  return path.resolve(projectRoot, ".comet-any", "states", `${name}.json`);
}

function validateName(name: string): void {
  if (!/^[a-z][a-z0-9-]{1,63}$/u.test(name))
    throw new Error(`Invalid workflow name: ${name}`);
}

export async function readState(
  projectRoot: string,
  name: string,
): Promise<CreatorState> {
  validateName(name);
  const file = stateFile(projectRoot, name);
  return JSON.parse(await fs.readFile(file, "utf8")) as CreatorState;
}

export async function writeState(state: CreatorState): Promise<void> {
  validateName(state.name);
  await atomicWrite(
    stateFile(state.projectRoot, state.name),
    JSON.stringify(state, null, 2) + "\n",
  );
}

export async function initializeState(options: {
  projectRoot: string;
  planPath: string;
  plan: FactoryPlan;
  proposal: FactoryProposal;
  confirmed: boolean;
}): Promise<CreatorState> {
  if (!options.confirmed)
    throw new Error("Initialization requires explicit proposal confirmation");
  const draftPath = path.resolve(
    options.projectRoot,
    ".comet-any",
    "drafts",
    options.plan.workflow.name,
  );
  const state: CreatorState = {
    schemaVersion: 1,
    name: options.plan.workflow.name,
    status: "draft",
    projectRoot: path.resolve(options.projectRoot),
    planPath: path.resolve(options.planPath),
    planHash: options.proposal.planHash,
    draftPath,
    currentHash: null,
    candidates: structuredClone(options.proposal.candidates),
  };
  await ensureDirectory(draftPath);
  await writeState(state);
  return state;
}

export async function updateCandidates(
  projectRoot: string,
  name: string,
  candidates: SkillCandidate[],
): Promise<CreatorState> {
  const state = await readState(projectRoot, name);
  state.candidates = structuredClone(candidates);
  await writeState(state);
  return state;
}
