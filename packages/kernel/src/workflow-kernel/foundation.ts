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
import { findSkills, scriptDeclarationProblems } from "./discovery.js";
import { normalizeWorkflow } from "../workflow/contract.js";
import {
  atomicCreate,
  atomicWrite,
  canonicalHash,
  ensureDirectory,
  sha256,
  stableValue,
} from "../util.js";
import { inspectUpgradeSource } from "../factory/source.js";
import {
  locationFreeSourceEvidence,
  mapCreatorStatePaths,
  toResolvedPaths,
  toStoredPaths,
  withoutKey,
} from "../factory/project-paths.js";
import {
  assertValidSemanticDossier,
  semanticDossierHash,
  validateDossierPlan,
} from "../factory/questionnaire.js";

export interface WorkflowKernelOptions {
  projectRoot: string;
  stateNamespace?: string;
  sourceRoots?: readonly string[];
}

export interface InitializeStateOptions {
  planPath: string;
  proposalHash: string;
  confirmed: boolean;
  replaceStateHash?: string;
}

/** The approved proposal, rebuilt from the plan that still produces it. */
export interface ApprovedProposal {
  proposal: FactoryProposal;
  /** The plan the check read; generation uses it instead of reading again. */
  plan: FactoryPlan;
}

export interface WorkflowKernel {
  findSkills(options?: {
    sources?: SkillSourceDeclaration[];
  }): Promise<SkillCandidate[]>;
  readPlan(file: string): Promise<FactoryPlan>;
  buildProposal(planPath: string): Promise<FactoryProposal>;
  initializeState(options: InitializeStateOptions): Promise<CreatorState>;
  verifyApprovedProposal(state: CreatorState): Promise<ApprovedProposal>;
  readState(name: string): Promise<CreatorState>;
  /** The hash that replacing a Creator state quotes; null when it has none. */
  stateHash(name: string): Promise<string | null>;
  writeState(state: CreatorState): Promise<void>;
  updateCandidates(
    name: string,
    candidates: SkillCandidate[],
  ): Promise<CreatorState>;
}

const standaloneStateNamespace = ".badger";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;

/** A pasted hash, refused as such when it cannot be one. */
function quotedHash(value: string, kind: string, source: string): string {
  const hash = value.trim().toLowerCase();
  if (!HASH_PATTERN.test(hash))
    throw new Error(
      `Not a ${kind} hash: ${JSON.stringify(value)}; quote the 64-character ${source}`,
    );
  return hash;
}

/**
 * Whether a plan hash recorded in Creator state names this plan. States from
 * before plan hashes became canonical recorded the SHA-256 of the plan's JSON
 * in its own key order; an unchanged plan still matches that form, so those
 * states stay current.
 */
export function planHashMatches(plan: unknown, recorded: string): boolean {
  return (
    recorded === canonicalHash(plan) ||
    recorded === sha256(JSON.stringify(plan))
  );
}

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
  if (Object.prototype.hasOwnProperty.call(plan, "sourceRoots"))
    throw new Error(
      `Invalid Factory plan: ${file} sourceRoots are registered by the host, not the plan; pass --source-root or set BADGER_SOURCE_ROOTS`,
    );
  for (const declaration of plan.skillSources) {
    const [problem] = scriptDeclarationProblems(
      declaration?.scripts,
      `skillSources ${String(declaration?.name)}`,
    );
    if (problem) throw new Error(`Invalid Factory plan: ${file} ${problem}`);
  }
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

// Resolved source roots stay out of the identity so a moved project keeps the
// same proposal; the plan still binds each declared location. The roots are
// stripped as the authoring plan strips them, but the hash is canonicalHash:
// recorded authoring sessions depend on the authoring plan's stableValue form.
function proposalIdentity(
  proposal: Omit<FactoryProposal, "proposalHash">,
): string {
  const { sourceRoot: _sourceRoot, upgradeSource, ...rest } = proposal;
  return canonicalHash({
    ...rest,
    candidates: locationFreeSourceEvidence(rest.candidates),
    ...(upgradeSource
      ? { upgradeSource: withoutKey(upgradeSource, "root") }
      : {}),
  });
}

function parsesAsJson(text: Buffer): boolean {
  try {
    JSON.parse(text.toString("utf8"));
    return true;
  } catch {
    return false;
  }
}

export function createWorkflowKernel(
  options: WorkflowKernelOptions,
): WorkflowKernel {
  const projectRoot = path.resolve(options.projectRoot);
  const sourceRoots = [...(options.sourceRoots ?? [])];
  const stateNamespace = options.stateNamespace ?? ".badger";
  validateStateNamespace(stateNamespace);
  const stateRoot = path.resolve(projectRoot, stateNamespace);

  function stateFile(name: string): string {
    validateName(name);
    return path.join(stateRoot, "states", `${name}.json`);
  }

  async function discover(
    optionsForDiscovery: {
      sources?: SkillSourceDeclaration[];
    } = {},
  ): Promise<SkillCandidate[]> {
    return findSkills({
      projectRoot,
      roots: sourceRoots,
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

  async function proposalForPlan(plan: FactoryPlan): Promise<FactoryProposal> {
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
        upgradeSource = await inspectUpgradeSource(sourceRoot, {
          projectRoot,
          roots: sourceRoots,
        });
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
    const body: Omit<FactoryProposal, "proposalHash"> = {
      schemaVersion: 1,
      name: plan.workflow.name,
      goal: plan.goal,
      intent: plan.skillCreatorIntent,
      planHash: canonicalHash(plan),
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
    return { ...body, proposalHash: proposalIdentity(body) };
  }

  async function buildProposal(planPath: string): Promise<FactoryProposal> {
    return proposalForPlan(await readPlan(planPath));
  }

  async function readState(name: string): Promise<CreatorState> {
    const text = await fs.readFile(stateFile(name), "utf8");
    let stored: CreatorState;
    try {
      stored = JSON.parse(text) as CreatorState;
    } catch {
      throw new Error(
        `Invalid Creator state: ${name}: the state file is not valid JSON`,
      );
    }
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

  function serializeState(state: CreatorState): string {
    validateName(state.name);
    if (path.resolve(state.projectRoot) !== projectRoot)
      throw new Error("Creator state belongs to a different project root");
    const stored = mapCreatorStatePaths(state, toStoredPaths(projectRoot));
    return JSON.stringify(stored, null, 2) + "\n";
  }

  async function writeState(state: CreatorState): Promise<void> {
    await atomicWrite(stateFile(state.name), serializeState(state));
  }

  async function readStateBytes(name: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(stateFile(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  // The hash covers the state file exactly as stored, so a state written with
  // absolute paths, or one that no longer parses, can still be named and
  // replaced.
  async function stateHash(name: string): Promise<string | null> {
    const bytes = await readStateBytes(name);
    return bytes === null ? null : sha256(bytes);
  }

  /** Refuses to replace a Creator state unless the caller quotes its hash. */
  async function assertStateReplaceable(
    name: string,
    quoted: string | undefined,
  ): Promise<"absent" | "present"> {
    const bytes = await readStateBytes(name);
    if (bytes === null) return "absent";
    const current = sha256(bytes);
    if (quoted === undefined)
      throw new Error(
        `Existing Creator state for ${name}${
          parsesAsJson(bytes) ? "" : " is not valid JSON and"
        } has hash ${current}; pass --replace-state ${current} to replace it`,
      );
    if (quoted !== current)
      throw new Error(
        `Existing Creator state hash does not match: expected ${current}, received ${quoted}`,
      );
    return "present";
  }

  /**
   * Writes a new Creator state. Without a quoted hash the write only creates,
   * so two concurrent inits cannot both succeed; with one, the hash is checked
   * again immediately before the replacement.
   */
  async function claimState(
    state: CreatorState,
    quoted: string | undefined,
  ): Promise<void> {
    const file = stateFile(state.name);
    const text = serializeState(state);
    if (
      quoted !== undefined &&
      (await assertStateReplaceable(state.name, quoted)) === "present"
    ) {
      await atomicWrite(file, text);
      return;
    }
    try {
      await atomicCreate(file, text);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await assertStateReplaceable(state.name, undefined);
      throw error;
    }
  }

  async function reapprovalMessage(
    state: CreatorState,
    problem: string,
  ): Promise<string> {
    const project = JSON.stringify(state.projectRoot);
    const plan = JSON.stringify(state.planPath);
    const current = (await stateHash(state.name)) ?? "<state hash>";
    return `Creator state ${state.name} ${problem}; approve its proposal again: run \`badger propose ${plan} --project ${project}\`, then \`badger init ${plan} --proposal <proposalHash> --replace-state ${current} --confirm --project ${project}\``;
  }

  async function initializeState(
    stateOptions: InitializeStateOptions,
  ): Promise<CreatorState> {
    if (!stateOptions.confirmed)
      throw new Error("Initialization requires explicit proposal confirmation");
    const proposalHash = quotedHash(
      stateOptions.proposalHash,
      "proposal",
      "proposalHash that propose printed",
    );
    const replaceStateHash =
      stateOptions.replaceStateHash === undefined
        ? undefined
        : quotedHash(
            stateOptions.replaceStateHash,
            "Creator state",
            "state hash that a refused init reported",
          );
    const plan = await readPlan(stateOptions.planPath);
    const proposal = await proposalForPlan(plan);
    if (!proposal.canInitialize || proposal.blockers.length)
      throw new Error(
        `Cannot initialize blocked proposal:\n${proposal.blockers.join("\n")}`,
      );
    if (proposal.proposalHash !== proposalHash)
      throw new Error(
        "Approved proposal is stale: the plan or declared Skill source evidence is stale for the quoted proposal hash; rerun propose and confirm the new proposal",
      );
    // Refuse before writing anything; claimState checks again at the write.
    await assertStateReplaceable(plan.workflow.name, replaceStateHash);
    const draftPath = path.resolve(
      projectRoot,
      plan.artifactRoot ?? path.join(stateNamespace, "drafts"),
      plan.workflow.name,
    );
    const state: CreatorState = {
      schemaVersion: 1,
      name: plan.workflow.name,
      status: "draft",
      projectRoot,
      planPath: path.resolve(stateOptions.planPath),
      planHash: proposal.planHash,
      draftPath,
      currentHash: null,
      candidates: structuredClone(proposal.candidates),
      confirmedProposal: structuredClone(proposal),
    };
    await ensureDirectory(draftPath);
    await claimState(state, replaceStateHash);
    return state;
  }

  async function verifyApprovedProposal(
    state: CreatorState,
  ): Promise<ApprovedProposal> {
    const approved = state.confirmedProposal;
    if (!approved)
      throw new Error(
        "Creator state has no approved proposal; rerun init with the approved proposal hash",
      );
    if (typeof approved.proposalHash !== "string")
      throw new Error(
        await reapprovalMessage(
          state,
          "predates the approved-proposal binding",
        ),
      );
    const { proposalHash: approvedHash, ...approvedBody } = approved;
    if (proposalIdentity(approvedBody) !== approvedHash)
      throw new Error(
        await reapprovalMessage(
          state,
          "records an approved proposal that does not match its proposal hash",
        ),
      );
    const plan = await readPlan(state.planPath);
    const planHash = canonicalHash(plan);
    if (planHash !== state.planHash || planHash !== approved.planHash)
      throw new Error(
        "The plan changed since the approved proposal; rerun propose and init",
      );
    const current = await proposalForPlan(plan);
    if (!current.canInitialize || current.blockers.length)
      throw new Error(
        `The current plan and Skill sources no longer produce a usable proposal:\n${current.blockers.join("\n")}`,
      );
    if (current.proposalHash !== approvedHash)
      throw new Error(
        "The plan or declared Skill source evidence changed since the approved proposal; rerun propose and init",
      );
    // The rebuilt proposal has the approved identity and this project's
    // resolved roots, and nothing read from the state file reaches generation.
    return { proposal: current, plan };
  }

  return {
    findSkills: discover,
    readPlan,
    buildProposal,
    initializeState,
    verifyApprovedProposal,
    readState,
    stateHash,
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
  sourceRoots?: readonly string[];
}): WorkflowKernel {
  return createWorkflowKernel({
    ...options,
    stateNamespace: standaloneStateNamespace,
  });
}
