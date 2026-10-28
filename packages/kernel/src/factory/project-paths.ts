import { realpathSync } from "node:fs";
import path from "node:path";
import type {
  AuthoringPlan,
  AuthoringRecord,
  AuthoringStateSummary,
} from "../authoring/types.js";
import type { CreatorState, UpgradeMigrationManifest } from "../types.js";
import { isWithin } from "../util.js";

export interface ProjectPathMappers {
  project: ProjectPathMapper;
  source: ProjectPathMapper;
}

export type ProjectPathMapper = (value: string) => string;

export function toStoredPaths(projectRoot: string): ProjectPathMappers {
  const sourceRoot = physicalProjectRoot(projectRoot);
  return {
    project: (value) => toProjectRelativePath(projectRoot, value),
    source: (value) => sourcePathToStored(sourceRoot, value),
  };
}

export function toResolvedPaths(projectRoot: string): ProjectPathMappers {
  const sourceRoot = physicalProjectRoot(projectRoot);
  return {
    project: (value) => fromProjectRelativePath(projectRoot, value),
    source: (value) => sourcePathFromStored(sourceRoot, value),
  };
}

export function physicalProjectRoot(projectRoot: string): string {
  const root = path.resolve(projectRoot);
  try {
    return realpathSync.native(root);
  } catch {
    return root;
  }
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

function sourcePathToStored(sourceRoot: string, value: string): string {
  const absolute = path.resolve(sourceRoot, value);
  return isWithin(sourceRoot, absolute)
    ? portableRelative(sourceRoot, absolute)
    : absolute;
}

function sourcePathFromStored(sourceRoot: string, value: string): string {
  if (path.isAbsolute(value)) return path.resolve(value);
  return fromProjectRelativePath(sourceRoot, value);
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

export function mapCandidatePaths<
  T extends { sources: Array<{ root: string }> },
>(candidate: T, mappers: ProjectPathMappers): T {
  return {
    ...candidate,
    sources: candidate.sources.map((source) => mapRoot(source, mappers.source)),
  };
}

export function mapUpgradeManifestPaths(
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
    sourceEvidence: plan.sourceEvidence.map((candidate) =>
      mapCandidatePaths(candidate, mappers),
    ),
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
              sourceEvidence: mapUpgradeManifestPaths(
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
          mapCandidatePaths(candidate, mappers),
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
      mapCandidatePaths(candidate, mappers),
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
