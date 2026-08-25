import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  CreatorState,
  FactoryPlan,
  FactoryProposal,
  SkillCandidate,
} from "../types.js";
import {
  findSkills,
  type PreferenceEntry,
  type SearchRoot,
} from "./discovery.js";
import { normalizeWorkflow } from "../workflow/contract.js";
import { atomicWrite, ensureDirectory, sha256 } from "../util.js";

export interface WorkflowKernelOptions {
  projectRoot: string;
  homeDir?: string;
  stateNamespace?: string;
}

export interface InitializeStateOptions {
  planPath: string;
  plan: FactoryPlan;
  proposal: FactoryProposal;
  confirmed: boolean;
}

export interface WorkflowKernel {
  findSkills(options?: {
    preferences?: PreferenceEntry[];
    extraRoots?: SearchRoot[];
  }): Promise<SkillCandidate[]>;
  readPlan(file: string): Promise<FactoryPlan>;
  buildProposal(planPath: string): Promise<FactoryProposal>;
  initializeState(options: InitializeStateOptions): Promise<CreatorState>;
  readState(name: string): Promise<CreatorState>;
  writeState(state: CreatorState): Promise<void>;
  updateCandidates(
    name: string,
    candidates: SkillCandidate[],
  ): Promise<CreatorState>;
}

const standaloneStateNamespace = ".comet-any";

function validateName(name: string): void {
  if (!/^[a-z][a-z0-9-]{1,63}$/u.test(name))
    throw new Error(`Invalid workflow name: ${name}`);
}

function validateStateNamespace(namespace: string): void {
  if (
    !namespace ||
    path.isAbsolute(namespace) ||
    path.normalize(namespace) !== namespace ||
    namespace === "." ||
    namespace.split(/[\\/]/u).includes("..")
  )
    throw new Error(`Invalid workflow state namespace: ${namespace}`);
}

export async function readPlan(file: string): Promise<FactoryPlan> {
  const value = JSON.parse(
    await fs.readFile(path.resolve(file), "utf8"),
  ) as FactoryPlan;
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !value.goal ||
    !value.workflow ||
    !value.skillCreatorIntent ||
    !Array.isArray(value.preferredSkills)
  )
    throw new Error(`Invalid Factory plan: ${file}`);
  if (value.skillCreatorIntent === "upgrade-existing" && !value.sourceRoot)
    throw new Error("upgrade-existing plans require sourceRoot");
  if (value.workflow.kind !== "workflow-kernel")
    throw new Error("Standalone Comet-any supports workflow-kernel plans only");
  return value;
}

function queryEntries(
  plan: FactoryPlan,
  requiredSkills: string[],
): PreferenceEntry[] {
  const entries: PreferenceEntry[] = [];
  const seen = new Set<string>();
  for (const [preferenceIndex, query] of plan.preferredSkills.entries()) {
    if (seen.has(query)) continue;
    seen.add(query);
    entries.push({ query, preferenceIndex });
  }
  for (const query of requiredSkills) {
    if (seen.has(query)) continue;
    seen.add(query);
    entries.push({ query, preferenceIndex: null });
  }
  return entries;
}

function blockedCandidateMessages(candidates: SkillCandidate[]): string[] {
  return candidates
    .filter((candidate) => candidate.status !== "available")
    .map(
      (candidate) =>
        `Unresolved Skill candidate: ${candidate.query} (${candidate.status})`,
    );
}

export function createWorkflowKernel(
  options: WorkflowKernelOptions,
): WorkflowKernel {
  const projectRoot = path.resolve(options.projectRoot);
  const homeDir = options.homeDir ? path.resolve(options.homeDir) : undefined;
  const stateNamespace = options.stateNamespace ?? ".comet";
  validateStateNamespace(stateNamespace);
  const stateRoot = path.resolve(projectRoot, stateNamespace);

  function stateFile(name: string): string {
    validateName(name);
    return path.join(stateRoot, "states", `${name}.json`);
  }

  async function discover(
    optionsForDiscovery: {
      preferences?: PreferenceEntry[];
      extraRoots?: SearchRoot[];
    } = {},
  ): Promise<SkillCandidate[]> {
    return findSkills({
      projectRoot,
      homeDir,
      stateNamespace,
      preferencePolicy: "strict",
      ...optionsForDiscovery,
    });
  }

  async function buildProposal(planPath: string): Promise<FactoryProposal> {
    const plan = await readPlan(planPath);
    const normalized = normalizeWorkflow(plan.workflow);
    const candidates = await discover({
      preferences: queryEntries(plan, normalized.requiredSkills),
    });
    const blockers = blockedCandidateMessages(candidates);
    const sourceRoot = plan.sourceRoot
      ? path.resolve(projectRoot, plan.sourceRoot)
      : undefined;
    if (plan.skillCreatorIntent === "upgrade-existing" && sourceRoot) {
      try {
        await fs.access(path.join(sourceRoot, "SKILL.md"));
      } catch {
        blockers.push(`Upgrade source is not a Skill directory: ${sourceRoot}`);
      }
    }
    return {
      schemaVersion: 1,
      name: plan.workflow.name,
      goal: plan.goal,
      intent: plan.skillCreatorIntent,
      planHash: sha256(JSON.stringify(plan)),
      workflow: normalized.protocol,
      candidates,
      blockers,
      warnings:
        plan.skillCreatorIntent === "upgrade-existing"
          ? ["Upgrade mode copies the source package before generation."]
          : [],
      canInitialize: blockers.length === 0,
    };
  }

  async function readState(name: string): Promise<CreatorState> {
    const state = JSON.parse(
      await fs.readFile(stateFile(name), "utf8"),
    ) as CreatorState;
    if (
      !state ||
      state.schemaVersion !== 1 ||
      state.name !== name ||
      path.resolve(state.projectRoot) !== projectRoot
    )
      throw new Error(`Invalid Creator state: ${name}`);
    return state;
  }

  async function writeState(state: CreatorState): Promise<void> {
    validateName(state.name);
    if (path.resolve(state.projectRoot) !== projectRoot)
      throw new Error("Creator state belongs to a different project root");
    await atomicWrite(
      stateFile(state.name),
      JSON.stringify(state, null, 2) + "\n",
    );
  }

  async function initializeState(
    stateOptions: InitializeStateOptions,
  ): Promise<CreatorState> {
    if (!stateOptions.confirmed)
      throw new Error("Initialization requires explicit proposal confirmation");
    if (
      !stateOptions.proposal.canInitialize ||
      stateOptions.proposal.blockers.length
    )
      throw new Error(
        `Cannot initialize blocked proposal:\n${stateOptions.proposal.blockers.join("\n")}`,
      );
    const planHash = sha256(JSON.stringify(stateOptions.plan));
    if (
      stateOptions.proposal.planHash !== planHash ||
      stateOptions.proposal.name !== stateOptions.plan.workflow.name
    )
      throw new Error("Confirmed proposal does not match the Factory plan");
    const draftPath = path.join(
      stateRoot,
      "drafts",
      stateOptions.plan.workflow.name,
    );
    const state: CreatorState = {
      schemaVersion: 1,
      name: stateOptions.plan.workflow.name,
      status: "draft",
      projectRoot,
      planPath: path.resolve(stateOptions.planPath),
      planHash,
      draftPath,
      currentHash: null,
      candidates: structuredClone(stateOptions.proposal.candidates),
    };
    await ensureDirectory(draftPath);
    await writeState(state);
    return state;
  }

  return {
    findSkills: discover,
    readPlan,
    buildProposal,
    initializeState,
    readState,
    writeState,
    async updateCandidates(name, candidates) {
      const state = await readState(name);
      state.candidates = structuredClone(candidates);
      await writeState(state);
      return state;
    },
  };
}

export function createStandaloneWorkflowKernel(options: {
  projectRoot: string;
  homeDir?: string;
}): WorkflowKernel {
  return createWorkflowKernel({
    ...options,
    stateNamespace: standaloneStateNamespace,
  });
}
