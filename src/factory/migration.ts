import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type {
  CreatorDraftClassification,
  CreatorState,
  FactoryPlan,
  UpgradeMigrationManifest,
} from "../types.js";
import { buildProposal, parsePlan } from "./proposal.js";
import { generatePackage, type GeneratedPackage } from "./generate.js";
import {
  assertDestinationWithinProject,
  assertUpgradeDestinationOutsideSource,
  inspectUpgradeSource,
} from "./source.js";
import { writeState } from "./state.js";
import { buildAuthoringPlan } from "../authoring/plan.js";
import { initializeAuthoringSession } from "../authoring/lifecycle.js";
import type { AuthoringDepth, AuthoringPlan } from "../authoring/types.js";
import { atomicWrite, ensureDirectory, isWithin } from "../util.js";

export interface LegacyDraftMigrationOptions {
  state: CreatorState;
  confirmed: boolean;
  destination?: string;
  depth?: AuthoringDepth;
}

export interface LegacyDraftMigrationResult {
  state: CreatorState;
  sourceRoot: string;
  destination: string;
  migrationPath: string;
  authoringPlan: AuthoringPlan;
  generated: GeneratedPackage;
  sourceEvidence: UpgradeMigrationManifest;
}

export function classifyCreatorDraft(
  state: Pick<CreatorState, "generated" | "authoring">,
): CreatorDraftClassification {
  if (!state.generated) return "uninitialized";
  if (!state.authoring) return "legacy-scaffold-only";
  return "authoring-required";
}

function migrationRoot(state: CreatorState, sourceRoot: string): string {
  const preferred = path.join(
    state.projectRoot,
    ".badger",
    "migrations",
    state.name,
  );
  if (
    !isWithin(sourceRoot, preferred) &&
    isWithin(state.projectRoot, preferred)
  ) {
    return preferred;
  }
  const sibling = path.join(
    path.dirname(sourceRoot),
    `.${path.basename(sourceRoot)}-badger-migration-${state.name}`,
  );
  if (!isWithin(state.projectRoot, sibling)) {
    throw new Error(
      "Legacy migration metadata must remain inside project root",
    );
  }
  return sibling;
}

function defaultDestination(sourceRoot: string): string {
  return path.join(
    path.dirname(sourceRoot),
    `${path.basename(sourceRoot)}-authoring`,
  );
}

async function migrationPlan(
  plan: FactoryPlan,
  sourceRoot: string,
  projectRoot: string,
): Promise<FactoryPlan> {
  const canonicalSourceRoot = await fs.realpath(sourceRoot);
  for (const source of plan.skillSources) {
    try {
      if (
        path.resolve(
          await fs.realpath(path.resolve(projectRoot, source.location)),
        ) === canonicalSourceRoot
      )
        return { ...plan, skillCreatorIntent: "upgrade-existing", sourceRoot };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const skillMd = await fs.readFile(
    path.join(canonicalSourceRoot, "SKILL.md"),
    "utf8",
  );
  const match = skillMd.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  const metadata = match
    ? (parse(match[1]) as Record<string, unknown>)
    : undefined;
  if (typeof metadata?.name !== "string" || metadata.name.trim().length === 0)
    throw new Error(`Upgrade source requires a named SKILL.md: ${sourceRoot}`);

  return {
    ...plan,
    skillCreatorIntent: "upgrade-existing",
    sourceRoot,
    skillSources: [
      ...plan.skillSources,
      {
        name: metadata.name.trim(),
        location: sourceRoot,
      },
    ],
  };
}

async function readMigrationPlan(state: CreatorState): Promise<FactoryPlan> {
  const file = path.resolve(state.planPath);
  const value = JSON.parse(await fs.readFile(file, "utf8")) as Record<
    string,
    unknown
  >;
  if (Object.prototype.hasOwnProperty.call(value, "preferredSkills")) {
    const declarations = new Map<string, { name: string; location: string }>();
    for (const candidate of state.candidates as unknown[]) {
      if (!candidate || typeof candidate !== "object") continue;
      const candidateValue = candidate as Record<string, unknown>;
      const sources = Array.isArray(candidateValue.sources)
        ? candidateValue.sources
        : [];
      for (const source of sources) {
        if (!source || typeof source !== "object") continue;
        const sourceValue = source as Record<string, unknown>;
        const name =
          typeof sourceValue.name === "string"
            ? sourceValue.name.trim()
            : typeof candidateValue.query === "string"
              ? candidateValue.query.trim()
              : "";
        const location =
          typeof sourceValue.root === "string" ? sourceValue.root : "";
        if (name && location)
          declarations.set(`${name}\0${location}`, { name, location });
      }
    }
    value.skillSources = [...declarations.values()];
    delete value.preferredSkills;
    delete value.skillRoots;
  } else if (Object.prototype.hasOwnProperty.call(value, "skillRoots")) {
    throw new Error(
      `Legacy Factory plan ${file} has no recorded explicit Skill source evidence; cannot migrate safely`,
    );
  }
  return parsePlan(value, file);
}

async function assertDestinationAvailable(destination: string): Promise<void> {
  try {
    await fs.lstat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Migration destination already exists: ${destination}`);
}

function stateForMigration(
  state: CreatorState,
  planPath: string,
  proposal: Awaited<ReturnType<typeof buildProposal>>,
  generated: GeneratedPackage,
  destination: string,
): CreatorState {
  return {
    ...structuredClone(state),
    planPath,
    planHash: proposal.planHash,
    draftPath: destination,
    currentHash: null,
    candidates: structuredClone(proposal.candidates),
    confirmedProposal: structuredClone(proposal),
    generated: structuredClone(generated),
    eval: undefined,
    review: undefined,
    status: "generated",
  };
}

export async function migrateLegacyDraft(
  options: LegacyDraftMigrationOptions,
): Promise<LegacyDraftMigrationResult> {
  if (!options.confirmed) {
    throw new Error("Legacy draft migration requires explicit confirmation");
  }
  if (classifyCreatorDraft(options.state) !== "legacy-scaffold-only") {
    throw new Error("Only legacy scaffold-only drafts can be migrated");
  }
  if (options.state.published) {
    throw new Error("Published drafts cannot be migrated");
  }
  const sourceRoot = path.resolve(
    options.state.generated?.packageRoot ?? options.state.draftPath,
  );
  if (!isWithin(options.state.projectRoot, sourceRoot)) {
    throw new Error("Legacy source draft must remain inside project root");
  }
  const destination = path.resolve(
    options.destination ?? defaultDestination(sourceRoot),
  );
  await assertUpgradeDestinationOutsideSource(
    sourceRoot,
    destination,
    "Migration destination must not be inside legacy source draft",
  );
  await assertDestinationWithinProject(options.state.projectRoot, destination);
  await assertDestinationAvailable(destination);
  const sourceEvidence = await inspectUpgradeSource(sourceRoot);
  const originalState = structuredClone(options.state);
  const root = migrationRoot(options.state, sourceRoot);
  const migrationPlanPath = path.join(root, "plan.json");
  const legacySessionPath = path.join(
    options.state.projectRoot,
    ".badger",
    "authoring",
    options.state.name,
  );
  const archivedSessionPath = path.join(root, "legacy-authoring");
  let archivedSession = false;
  let destinationCreated = false;
  try {
    const originalPlan = await readMigrationPlan(options.state);
    await ensureDirectory(root);
    await atomicWrite(
      path.join(root, "legacy-plan.json"),
      JSON.stringify(originalPlan, null, 2) + "\n",
    );
    const plan = await migrationPlan(
      originalPlan,
      sourceRoot,
      options.state.projectRoot,
    );
    await atomicWrite(migrationPlanPath, JSON.stringify(plan, null, 2) + "\n");
    const proposal = await buildProposal({
      projectRoot: options.state.projectRoot,
      planPath: migrationPlanPath,
    });
    if (!proposal.canInitialize) {
      throw new Error(
        `Cannot migrate blocked proposal:\n${proposal.blockers.join("\n")}`,
      );
    }
    const generated = await generatePackage({
      proposal,
      plan,
      destination,
      ...(options.depth ? { authoringDepth: options.depth } : {}),
    });
    destinationCreated = true;
    const migratedState = stateForMigration(
      options.state,
      migrationPlanPath,
      proposal,
      generated,
      destination,
    );
    await writeState(migratedState);
    try {
      await fs.rename(legacySessionPath, archivedSessionPath);
      archivedSession = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const authoringPlan = await buildAuthoringPlan({
      proposal,
      depth: options.depth,
    });
    await initializeAuthoringSession({
      state: migratedState,
      plan: authoringPlan,
      generated,
    });
    const manifest = generated.sourceEvidence;
    if (!manifest) {
      throw new Error("Upgrade migration source evidence is missing");
    }
    await atomicWrite(
      path.join(root, "migration.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          kind: "badger-legacy-draft-migration",
          sourceRoot,
          destination,
          sourceHash: manifest.sourceHash,
          decisions: manifest.decisions,
          authoringPlanHash: authoringPlan.authoringPlanHash,
        },
        null,
        2,
      ) + "\n",
    );
    return {
      state: migratedState,
      sourceRoot,
      destination,
      migrationPath: root,
      authoringPlan,
      generated,
      sourceEvidence: manifest,
    };
  } catch (error) {
    if (destinationCreated) {
      await fs
        .rm(destination, { recursive: true, force: true })
        .catch(() => undefined);
    }
    if (archivedSession) {
      try {
        await fs.rename(archivedSessionPath, legacySessionPath);
      } catch {}
    }
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    try {
      await writeState(originalState);
    } catch (restoreError) {
      throw new Error(
        `Legacy migration failed and state recovery failed: ${String(restoreError)}; original error: ${String(error)}`,
      );
    }
    throw error;
  }
}
