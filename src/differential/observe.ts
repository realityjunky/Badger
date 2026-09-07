import path from "node:path";
import type {
  ArtifactInventory,
  CanonicalCandidate,
  CanonicalCandidateSource,
  DifferentialComparison,
  DifferentialObservation,
  ReadinessObservation,
} from "./types.js";
import { snapshotDirectory } from "./fixture.js";
import type { WorkflowProtocol } from "../types.js";
import { sha256 } from "../util.js";

type RecordValue = Record<string, unknown>;

function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as RecordValue;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

function canonicalReferences(
  value: unknown,
): Array<{ path: string; contentHash: string }> {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const entry = record(item, `candidate source reference ${index}`);
    return {
      path: stringValue(entry.path, `candidate source reference ${index}.path`),
      contentHash: stringValue(
        entry.contentHash ?? entry.hash,
        `candidate source reference ${index}.contentHash`,
      ),
    };
  });
}

function canonicalScripts(
  value: unknown,
): Array<{ path: string; sideEffect: string }> {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const entry = record(item, `candidate source script ${index}`);
    return {
      path: stringValue(entry.path, `candidate source script ${index}.path`),
      sideEffect:
        typeof entry.sideEffect === "string" ? entry.sideEffect : "unknown",
    };
  });
}

function canonicalSource(
  value: unknown,
  label: string,
): CanonicalCandidateSource {
  const source = record(value, label);
  return {
    name: stringValue(source.name, `${label}.name`),
    root: stringValue(source.root, `${label}.root`),
    description:
      typeof source.description === "string" ? source.description : "",
    hash: stringValue(source.hash, `${label}.hash`),
    references: canonicalReferences(source.references),
    scripts: canonicalScripts(source.scripts),
  };
}

export function canonicalizeCandidates(value: unknown): CanonicalCandidate[] {
  const document = Array.isArray(value)
    ? { candidates: value }
    : record(value, "candidate result");
  if (!Array.isArray(document.candidates))
    throw new Error("candidate result.candidates must be an array");
  return document.candidates.map((item, index) => {
    const candidate = record(item, `candidate ${index}`);
    const status = candidate.status;
    if (
      status !== "available" &&
      status !== "missing" &&
      status !== "invalid" &&
      status !== "unsafe" &&
      status !== "ambiguous"
    )
      throw new Error(`candidate ${index}.status is invalid`);
    return {
      name: stringValue(candidate.name, `candidate ${index}.name`),
      status,
      sources: Array.isArray(candidate.sources)
        ? candidate.sources.map((source, sourceIndex) =>
            canonicalSource(source, `candidate ${index}.source ${sourceIndex}`),
          )
        : [],
    };
  });
}

export function canonicalizeWorkflowProtocol(value: unknown): WorkflowProtocol {
  const protocol = record(value, "workflow protocol");
  if (protocol.kind !== "workflow-kernel")
    throw new Error("workflow protocol must be workflow-kernel");
  return protocol as unknown as WorkflowProtocol;
}

export function canonicalizeReadiness(value: unknown): ReadinessObservation {
  const document = record(value, "readiness result");
  const readiness = document.readiness
    ? record(document.readiness, "readiness")
    : document;
  return {
    state: typeof readiness.state === "string" ? readiness.state : "unknown",
    blockers: Array.isArray(readiness.blockers)
      ? readiness.blockers.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    warnings: Array.isArray(readiness.warnings)
      ? readiness.warnings.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    evidence:
      readiness.evidence && typeof readiness.evidence === "object"
        ? Object.fromEntries(
            Object.entries(
              readiness.evidence as Record<string, unknown>,
            ).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            ),
          )
        : {},
  };
}

export async function inventoryDirectory(
  root: string,
  allowMissing = false,
): Promise<ArtifactInventory> {
  const absoluteRoot = path.resolve(root);
  try {
    const snapshot = await snapshotDirectory(absoluteRoot);
    return snapshot;
  } catch (error) {
    if (
      allowMissing &&
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { root: absoluteRoot, files: [], sha256: sha256("[]") };
    }
    throw error;
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

function sourceHashSignature(observation: DifferentialObservation): string {
  return JSON.stringify(
    observation.sourceHashes
      .map(({ name, hash }) => ({ name, hash }))
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
  );
}

function referenceSignature(observation: DifferentialObservation): string {
  return JSON.stringify(
    observation.sourceInventory
      .flatMap((source) =>
        source.references.map((reference) => ({
          name: source.name,
          path: reference.path,
          contentHash: reference.contentHash,
        })),
      )
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
  );
}

function artifactSignature(inventory: ArtifactInventory): string {
  return JSON.stringify(
    inventory.files.map(({ path: filePath, bytes, sha256: hash }) => ({
      path: filePath,
      bytes,
      sha256: hash,
    })),
  );
}

function artifactPaths(inventory: ArtifactInventory): Set<string> {
  return new Set(inventory.files.map((file) => file.path));
}

function candidateStatusSignature(
  observation: DifferentialObservation,
): string {
  return JSON.stringify(
    observation.candidates.map(({ name, status }) => ({
      name,
      status,
    })),
  );
}

export function compareObservations(
  official: DifferentialObservation,
  standalone: DifferentialObservation,
): DifferentialComparison {
  const officialPaths = artifactPaths(official.generatedArtifacts);
  const standalonePaths = artifactPaths(standalone.generatedArtifacts);
  return {
    candidateStatusEqual:
      candidateStatusSignature(official) ===
      candidateStatusSignature(standalone),
    sourceHashesEqual:
      sourceHashSignature(official) === sourceHashSignature(standalone),
    referenceInventoryEqual:
      referenceSignature(official) === referenceSignature(standalone),
    workflowProtocolEqual:
      JSON.stringify(stableValue(official.workflowProtocol)) ===
      JSON.stringify(stableValue(standalone.workflowProtocol)),
    generatedArtifactInventoryEqual:
      artifactSignature(official.generatedArtifacts) ===
      artifactSignature(standalone.generatedArtifacts),
    initialReadinessEqual:
      JSON.stringify(stableValue(official.initialReadiness)) ===
      JSON.stringify(stableValue(standalone.initialReadiness)),
    officialOnlyArtifacts: [...officialPaths]
      .filter((filePath) => !standalonePaths.has(filePath))
      .sort(),
    standaloneOnlyArtifacts: [...standalonePaths]
      .filter((filePath) => !officialPaths.has(filePath))
      .sort(),
  };
}

export function observationParts(
  candidates: CanonicalCandidate[],
  workflowProtocol: WorkflowProtocol,
  generatedArtifacts: ArtifactInventory,
  initialReadiness: ReadinessObservation,
): DifferentialObservation {
  const sourceInventory = candidates.flatMap((candidate) => candidate.sources);
  return {
    candidates,
    sourceInventory,
    sourceHashes: sourceInventory.map(({ name, root, hash }) => ({
      name,
      root,
      hash,
    })),
    workflowProtocol,
    generatedArtifacts,
    initialReadiness,
  };
}
