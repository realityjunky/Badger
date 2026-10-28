import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  CreatorState,
  FactoryPlan,
  FactoryProposal,
  SkillCandidate,
  SkillSourceDeclaration,
  UpgradeSourceEvidence,
} from "../types.js";
import { findSkills } from "./discovery.js";
import { normalizeWorkflow } from "../workflow/contract.js";
import { atomicWrite, ensureDirectory, sha256, stableValue } from "../util.js";
import { inspectUpgradeSource } from "../factory/source.js";
import {
  mapCreatorStatePaths,
  toResolvedPaths,
  toStoredPaths,
} from "../factory/project-paths.js";
import {
  assertValidSemanticDossier,
  semanticDossierHash,
  validateDossierPlan,
} from "../factory/questionnaire.js";

export interface WorkflowKernelOptions {
  projectRoot: string;
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
    sources?: SkillSourceDeclaration[];
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

const standaloneStateNamespace = ".badger";

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

export function parsePlan(value: unknown, file: string): FactoryPlan {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid Factory plan: ${file}`);
  const plan = value as Partial<FactoryPlan> & Record<string, unknown>;
  if (
    Object.prototype.hasOwnProperty.call(plan, "preferredSkills") ||
    Object.prototype.hasOwnProperty.call(plan, "skillRoots")
  )
    throw new Error(
      `Invalid Factory plan: ${file} uses removed preference-based Skill fields; use skillSources[{name,location}]`,
    );
  if (
    plan.schemaVersion !== 1 ||
    !plan.goal ||
    !plan.workflow ||
    !plan.skillCreatorIntent ||
    !Array.isArray(plan.skillSources)
  )
    throw new Error(`Invalid Factory plan: ${file}`);
  if (plan.skillCreatorIntent === "upgrade-existing" && !plan.sourceRoot)
    throw new Error("upgrade-existing plans require sourceRoot");
  if (plan.workflow.kind !== "workflow-kernel")
    throw new Error("Standalone Badger supports workflow-kernel plans only");
  if (plan.semanticDossier !== undefined) {
    assertValidSemanticDossier(plan.semanticDossier);
    const diagnostics = validateDossierPlan(
      plan.semanticDossier,
      plan as FactoryPlan,
    );
    if (diagnostics.length)
      throw new Error(
        diagnostics
          .map(({ path, message }) => `${path}: ${message}`)
          .join("\n"),
      );
    plan.semanticDossier = stableValue(
      plan.semanticDossier,
    ) as typeof plan.semanticDossier;
  }
  return plan as FactoryPlan;
}

export async function readPlan(file: string): Promise<FactoryPlan> {
  const value = JSON.parse(await fs.readFile(path.resolve(file), "utf8"));
  return parsePlan(value, file);
}

function blockedCandidateMessages(candidates: SkillCandidate[]): string[] {
  return candidates
    .filter((candidate) => candidate.status !== "available")
    .flatMap((candidate) => [
      `Unresolved Skill candidate: ${candidate.name} (${candidate.status})`,
      ...(candidate.blockers ?? []),
    ]);
}

export function createWorkflowKernel(
  options: WorkflowKernelOptions,
): WorkflowKernel {
  const projectRoot = path.resolve(options.projectRoot);
  const stateNamespace = options.stateNamespace ?? ".badger";
  validateStateNamespace(stateNamespace);
  const stateRoot = path.resolve(projectRoot, stateNamespace);

  function stateFile(name: string): string {
    validateName(name);
    return path.join(stateRoot, "states", `${name}.json`);
  }

  async function discover(
    optionsForDiscovery: { sources?: SkillSourceDeclaration[] } = {},
  ): Promise<SkillCandidate[]> {
    return findSkills({
      projectRoot,
      ...optionsForDiscovery,
    });
  }

  async function resolveCandidates(
    plan: FactoryPlan,
    requiredSkills: string[],
  ): Promise<SkillCandidate[]> {
    const candidates = await discover({ sources: plan.skillSources });
    const candidateNames = new Set(
      candidates.map((candidate) => candidate.name),
    );
    for (const requiredSkill of requiredSkills) {
      if (candidateNames.has(requiredSkill)) continue;
      candidates.push({
        name: requiredSkill,
        status: "missing",
        sources: [],
        blockers: [
          `Workflow binding ${requiredSkill} has no explicitly declared Skill source`,
        ],
      });
    }
    return candidates;
  }

  async function buildProposal(planPath: string): Promise<FactoryProposal> {
    const plan = await readPlan(planPath);
    const normalized = normalizeWorkflow(plan.workflow);
    const candidates = await resolveCandidates(plan, normalized.requiredSkills);
    const blockers = blockedCandidateMessages(candidates);
    if (plan.semanticDossier) {
      for (const source of plan.semanticDossier.sources) {
        const candidate = candidates.find(
          (entry) => entry.name === source.name,
        );
        if (
          !candidate?.sources.some(
            (entry) =>
              entry.root === source.canonicalPath &&
              entry.hash === source.contentHash,
          )
        ) {
          blockers.push(
            `Semantic dossier source identity is stale: ${source.name}`,
          );
        }
      }
    }
    const sourceRoot = plan.sourceRoot
      ? path.resolve(projectRoot, plan.sourceRoot)
      : undefined;
    let upgradeSource: UpgradeSourceEvidence | undefined;
    if (plan.skillCreatorIntent === "upgrade-existing" && sourceRoot) {
      try {
        upgradeSource = await inspectUpgradeSource(sourceRoot);
        if (
          !candidates.some((candidate) =>
            candidate.sources.some(
              (source) => source.root === upgradeSource?.root,
            ),
          )
        ) {
          blockers.push(
            `Upgrade source ${sourceRoot} must be included in skillSources as an explicit declaration`,
          );
        }
      } catch (error) {
        blockers.push(error instanceof Error ? error.message : String(error));
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
      ...(sourceRoot ? { sourceRoot } : {}),
      ...(upgradeSource ? { upgradeSource } : {}),
      ...(plan.semanticDossier
        ? {
            semanticDossier: structuredClone(plan.semanticDossier),
            semanticDossierHash: semanticDossierHash(plan.semanticDossier),
          }
        : {}),
    };
  }

  async function readState(name: string): Promise<CreatorState> {
    const stored = JSON.parse(
      await fs.readFile(stateFile(name), "utf8"),
    ) as CreatorState;
    if (
      !stored ||
      stored.schemaVersion !== 1 ||
      stored.name !== name ||
      typeof stored.projectRoot !== "string" ||
      typeof stored.planPath !== "string" ||
      typeof stored.draftPath !== "string"
    )
      throw new Error(`Invalid Creator state: ${name}`);
    let state: CreatorState;
    try {
      state = mapCreatorStatePaths(stored, toResolvedPaths(projectRoot));
    } catch (error) {
      throw new Error(
        `Invalid Creator state: ${name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (path.resolve(state.projectRoot) !== projectRoot)
      throw new Error(`Invalid Creator state: ${name}`);
    return state;
  }

  async function writeState(state: CreatorState): Promise<void> {
    validateName(state.name);
    if (path.resolve(state.projectRoot) !== projectRoot)
      throw new Error("Creator state belongs to a different project root");
    const stored = mapCreatorStatePaths(state, toStoredPaths(projectRoot));
    await atomicWrite(
      stateFile(state.name),
      JSON.stringify(stored, null, 2) + "\n",
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
    const normalized = normalizeWorkflow(stateOptions.plan.workflow);
    const currentCandidates = await resolveCandidates(
      stateOptions.plan,
      normalized.requiredSkills,
    );
    if (
      JSON.stringify(currentCandidates) !==
      JSON.stringify(stateOptions.proposal.candidates)
    )
      throw new Error(
        "Declared Skill source evidence is stale; rerun propose before initialization",
      );
    const draftPath = path.resolve(
      projectRoot,
      stateOptions.plan.artifactRoot ?? path.join(stateNamespace, "drafts"),
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
      confirmedProposal: structuredClone(stateOptions.proposal),
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
}): WorkflowKernel {
  return createWorkflowKernel({
    ...options,
    stateNamespace: standaloneStateNamespace,
  });
}
