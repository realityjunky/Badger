import { promises as fs } from "node:fs";
import path from "node:path";
import type { CreatorIntent, CreatorState, CreatorStatus } from "../types.js";
import { sha256 } from "../util.js";
import { classifyCreatorDraft } from "./migration.js";
import { readPlan } from "./proposal.js";
import { readState } from "./state.js";

export type CreatorGuidePlanStatus = "available" | "missing" | "invalid";

export interface CreatorGuideSkillSource {
  name: string;
  location: string;
}

export interface CreatorGuidePlan {
  path: string;
  status: CreatorGuidePlanStatus;
  hash: string | null;
  hashMatchesState?: boolean;
  intent?: CreatorIntent;
  goal?: string;
  workflowName?: string;
  skillSources?: CreatorGuideSkillSource[];
  blockers?: string[];
}

export interface CreatorGuideResumableState {
  name: string;
  status: CreatorStatus;
  classification: ReturnType<typeof classifyCreatorDraft>;
  authoring: string;
  factoryPlan: CreatorGuidePlan;
}

export interface CreatorGuide {
  schemaVersion: 1;
  projectRoot: string;
  intent: CreatorIntent[];
  firstUse: boolean;
  questionnaire: {
    mode: "automatic-first-use" | "manual-refinement";
    automatic: boolean;
    reason: string;
  };
  factoryPlans: CreatorGuidePlan[];
  resumable: CreatorGuideResumableState[];
}

export interface ReadCreatorGuideOptions {
  projectRoot: string;
  planPaths?: string[];
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function creatorStates(projectRoot: string): Promise<CreatorState[]> {
  const statesRoot = path.join(projectRoot, ".badger", "states");
  let entries;
  try {
    entries = await fs.readdir(statesRoot, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }

  const states: CreatorState[] = [];
  for (const entry of entries
    .filter((item) => item.isFile() && item.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    states.push(await readState(projectRoot, entry.name.slice(0, -5)));
  }
  return states;
}

async function inspectPlan(
  planPath: string,
  stateHash?: string,
): Promise<CreatorGuidePlan> {
  const resolvedPath = path.resolve(planPath);
  try {
    const plan = await readPlan(resolvedPath);
    const hash = sha256(JSON.stringify(plan));
    return {
      path: resolvedPath,
      status: "available",
      hash,
      ...(stateHash !== undefined
        ? { hashMatchesState: hash === stateHash }
        : {}),
      intent: plan.skillCreatorIntent,
      goal: plan.goal,
      workflowName: plan.workflow.name,
      skillSources: plan.skillSources.map(({ name, location }) => ({
        name,
        location,
      })),
    };
  } catch (error) {
    return {
      path: resolvedPath,
      status: errorCode(error) === "ENOENT" ? "missing" : "invalid",
      hash: null,
      ...(stateHash !== undefined ? { hashMatchesState: false } : {}),
      blockers: [errorMessage(error)],
    };
  }
}

export async function readCreatorGuide(
  options: ReadCreatorGuideOptions,
): Promise<CreatorGuide> {
  const projectRoot = path.resolve(options.projectRoot);
  const states = await creatorStates(projectRoot);
  const stateHashes = new Map<string, string>();
  const statePlanPaths = states.map((state) => {
    const planPath = path.resolve(projectRoot, state.planPath);
    stateHashes.set(planPath, state.planHash);
    return planPath;
  });
  const explicitPlanPaths = (options.planPaths ?? []).map((planPath) =>
    path.resolve(projectRoot, planPath),
  );
  const planPaths = [...new Set([...explicitPlanPaths, ...statePlanPaths])];
  const factoryPlans = await Promise.all(
    planPaths.map((planPath) =>
      inspectPlan(planPath, stateHashes.get(planPath)),
    ),
  );
  const plansByPath = new Map(
    factoryPlans.map((factoryPlan) => [factoryPlan.path, factoryPlan]),
  );
  const resumable = states.map((state) => ({
    name: state.name,
    status: state.status,
    classification: classifyCreatorDraft(state),
    authoring: state.authoring?.status ?? "legacy-scaffold",
    factoryPlan: plansByPath.get(path.resolve(projectRoot, state.planPath))!,
  }));
  const firstUse = states.length === 0 && factoryPlans.length === 0;

  return {
    schemaVersion: 1,
    projectRoot,
    intent: ["new-skill", "upgrade-existing"],
    firstUse,
    questionnaire: {
      mode: firstUse ? "automatic-first-use" : "manual-refinement",
      automatic: firstUse,
      reason: firstUse
        ? "No FactoryPlan or resumable Creator state was found."
        : "An existing FactoryPlan or resumable Creator state was found; preserve it and invoke questionnaire explicitly for refinement.",
    },
    factoryPlans,
    resumable,
  };
}
