import path from "node:path";
import type {
  AuthoringPlan,
  AuthoringRecord,
  AuthoringStateSummary,
} from "../authoring/types.js";
import type {
  CreatorState,
  SkillCandidate,
  UpgradeMigrationManifest,
  UpgradeSourceEvidence,
} from "../types.js";
import { isWithin } from "../util.js";

/**
 * Rewrites every persisted path in a Creator record.
 *
 * The same pair serves both directions: `toStoredPaths` prepares a record for
 * storage, `toResolvedPaths` resolves a stored record against the project root
 * it is read from.
 *
 * `project` covers paths the project owns, so they stay inside it. `source`
 * covers declared Skill and upgrade sources, which may legally live outside
 * the project as an absolute location.
 */
export interface ProjectPathMappers {
  project: ProjectPathMapper;
  source: ProjectPathMapper;
}

export type ProjectPathMapper = (value: string) => string;

export function toStoredPaths(projectRoot: string): ProjectPathMappers {
  return {
    project: (value) => toProjectRelativePath(projectRoot, value),
    source: (value) => sourcePathToStored(projectRoot, value),
  };
}

export function toResolvedPaths(projectRoot: string): ProjectPathMappers {
  return {
    project: (value) => fromProjectRelativePath(projectRoot, value),
    source: (value) => sourcePathFromStored(projectRoot, value),
  };
}

export function toProjectRelativePath(
  projectRoot: string,
  value: string,
): string {
  const root = path.resolve(projectRoot);
  const absolute = path.resolve(root, value);
  if (!isWithin(root, absolute))
    throw new Error(`Path escapes the project root: ${value}`);
  return portableRelative(root, absolute);
}

export function fromProjectRelativePath(
  projectRoot: string,
  value: string,
): string {
  const root = path.resolve(projectRoot);
  const absolute = path.resolve(root, value);
  if (!isWithin(root, absolute))
    throw new Error(`Stored path escapes the project root: ${value}`);
  return absolute;
}

// A source inside the project moves with it; a declared external source keeps
// its absolute location.
function sourcePathToStored(projectRoot: string, value: string): string {
  const root = path.resolve(projectRoot);
  const absolute = path.resolve(root, value);
  return isWithin(root, absolute) ? portableRelative(root, absolute) : absolute;
}

function sourcePathFromStored(projectRoot: string, value: string): string {
  if (path.isAbsolute(value)) return path.resolve(value);
  return fromProjectRelativePath(projectRoot, value);
}

function portableRelative(root: string, absolute: string): string {
  const relative = path.relative(root, absolute);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

function mapRoot<T extends { root: string }>(
  value: T,
  map: ProjectPathMapper,
): T {
  return { ...value, root: map(value.root) };
}

function mapCandidate(
  candidate: SkillCandidate,
  mappers: ProjectPathMappers,
): SkillCandidate {
  return {
    ...candidate,
    sources: candidate.sources.map((source) => mapRoot(source, mappers.source)),
  };
}

function mapSourceEvidence(
  manifest: UpgradeMigrationManifest,
  mappers: ProjectPathMappers,
): UpgradeMigrationManifest {
  return { ...manifest, sourceRoot: mappers.source(manifest.sourceRoot) };
}

export function mapAuthoringPlanPaths(
  plan: AuthoringPlan,
  mappers: ProjectPathMappers,
): AuthoringPlan {
  return {
    ...plan,
    sourceEvidence: plan.sourceEvidence.map((candidate) => ({
      ...candidate,
      sources: candidate.sources.map((source) =>
        mapRoot(source, mappers.source),
      ),
    })),
    ...(plan.upgradeSource
      ? {
          upgradeSource: mapRoot(plan.upgradeSource, mappers.source),
        }
      : {}),
  };
}

export function mapAuthoringSummaryPaths(
  summary: AuthoringStateSummary,
  mappers: ProjectPathMappers,
): AuthoringStateSummary {
  const map = mappers.project;
  return {
    ...summary,
    sessionPath: map(summary.sessionPath),
    ...(summary.statePath !== undefined
      ? { statePath: map(summary.statePath) }
      : {}),
    planPath: map(summary.planPath),
    recordsPath: map(summary.recordsPath),
    records: Object.fromEntries(
      Object.entries(summary.records).map(([lane, record]) => [
        lane,
        record ? { ...record, path: map(record.path) } : record,
      ]),
    ),
  };
}

export function mapAuthoringRecordPaths(
  record: AuthoringRecord,
  mappers: ProjectPathMappers,
): AuthoringRecord {
  const map = mappers.project;
  return {
    ...record,
    artifacts: record.artifacts.map((artifact) =>
      artifact.contentPath === undefined
        ? artifact
        : { ...artifact, contentPath: map(artifact.contentPath) },
    ),
  };
}

export function mapCreatorStatePaths(
  state: CreatorState,
  mappers: ProjectPathMappers,
): CreatorState {
  const project = mappers.project;
  const generated = state.generated
    ? {
        ...state.generated,
        packageRoot: project(state.generated.packageRoot),
        protocolPath: project(state.generated.protocolPath),
        evalPath: project(state.generated.evalPath),
        ...(state.generated.authoringPlanPath !== undefined
          ? {
              authoringPlanPath: project(state.generated.authoringPlanPath),
            }
          : {}),
        ...(state.generated.sourceRoot !== undefined
          ? { sourceRoot: mappers.source(state.generated.sourceRoot) }
          : {}),
        ...(state.generated.sourceEvidencePath !== undefined
          ? {
              sourceEvidencePath: project(state.generated.sourceEvidencePath),
            }
          : {}),
        ...(state.generated.sourceEvidence
          ? {
              sourceEvidence: mapSourceEvidence(
                state.generated.sourceEvidence,
                mappers,
              ),
            }
          : {}),
      }
    : undefined;
  const confirmedProposal = state.confirmedProposal
    ? {
        ...state.confirmedProposal,
        candidates: state.confirmedProposal.candidates.map((candidate) =>
          mapCandidate(candidate, mappers),
        ),
        ...(state.confirmedProposal.sourceRoot !== undefined
          ? { sourceRoot: mappers.source(state.confirmedProposal.sourceRoot) }
          : {}),
        ...(state.confirmedProposal.upgradeSource
          ? {
              upgradeSource: mapRoot(
                state.confirmedProposal.upgradeSource,
                mappers.source,
              ),
            }
          : {}),
      }
    : undefined;
  return {
    ...state,
    projectRoot: project(state.projectRoot),
    planPath: project(state.planPath),
    draftPath: project(state.draftPath),
    candidates: state.candidates.map((candidate) =>
      mapCandidate(candidate, mappers),
    ),
    ...(generated ? { generated } : {}),
    ...(confirmedProposal ? { confirmedProposal } : {}),
    ...(state.eval
      ? {
          eval: {
            ...state.eval,
            resultPath: project(state.eval.resultPath),
          },
        }
      : {}),
    ...(state.authoring
      ? { authoring: mapAuthoringSummaryPaths(state.authoring, mappers) }
      : {}),
    ...(state.published
      ? {
          published: {
            ...state.published,
            path: project(state.published.path),
          },
        }
      : {}),
  };
}
