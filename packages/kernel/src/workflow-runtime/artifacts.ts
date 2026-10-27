import { promises as fs } from "node:fs";
import path from "node:path";
import {
  inspectProtectedProjectPath,
  readProtectedProjectFile,
} from "../engine/protected-project-path.js";
import type { RunState, WorkflowRuntimeState } from "../engine/types.js";
import type { WorkflowArtifactMutation } from "../engine/runtime-types.js";
import type {
  ArtifactSchema,
  WorkflowArtifactId,
  WorkflowArtifactLifetime,
  WorkflowArtifactPath,
  WorkflowArtifactSelection,
  WorkflowArtifactVersionId,
  WorkflowArtifactVersion,
  WorkflowProtocol,
} from "../types.js";
import { sha256, stableValue } from "../util.js";

const ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
const ARTIFACT_MAX_ENTRIES = 256;

interface WorkflowArtifactDeclaration {
  artifactId: WorkflowArtifactId;
  schemaId: string;
  artifact: ArtifactSchema;
}

export class WorkflowArtifactValidationError extends Error {
  readonly blockers: string[];

  constructor(blockers: readonly string[]) {
    super(blockers.join("\n"));
    this.name = "WorkflowArtifactValidationError";
    this.blockers = [...blockers];
  }
}

function fail(message: string): never {
  throw new WorkflowArtifactValidationError([message]);
}

function versioningEnabled(protocol: WorkflowProtocol): boolean {
  return Boolean(
    protocol.capabilities?.features.includes("versioned-artifacts"),
  );
}

function declarations(
  protocol: WorkflowProtocol,
): WorkflowArtifactDeclaration[] {
  return protocol.outputSchemas.flatMap((schema) =>
    schema.artifacts.map((artifact) => ({
      artifactId: `${schema.id}.${artifact.id}`,
      schemaId: schema.id,
      artifact,
    })),
  );
}

function declarationsForNode(
  protocol: WorkflowProtocol,
  nodeId: string,
): WorkflowArtifactDeclaration[] {
  const node = protocol.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) fail(`Workflow artifact producer Node is unknown: ${nodeId}`);
  const schemaIds = new Set(node.outputSchemas);
  return declarations(protocol).filter((item) => schemaIds.has(item.schemaId));
}

function declarationFor(
  key: string,
  candidates: readonly WorkflowArtifactDeclaration[],
): WorkflowArtifactDeclaration {
  const exact = candidates.filter((candidate) => candidate.artifactId === key);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) fail(`Workflow artifact id is ambiguous: ${key}`);
  const short = candidates.filter((candidate) => candidate.artifact.id === key);
  if (short.length === 1) return short[0];
  if (short.length > 1) {
    fail(`Workflow artifact id requires a schema-qualified name: ${key}`);
  }
  fail(`Workflow artifact id is not declared: ${key}`);
}

function artifactPatternSegments(value: string, label: string): string[] {
  const normalized = value.trim().replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    /^(?:~|[\\/])/u.test(normalized)
  ) {
    throw new Error(`${label} must be relative to the Run root`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`${label} must stay inside the Run root`);
  }
  if (segments.some((segment) => segment.length === 0 || segment === ".")) {
    throw new Error(`${label} must not contain empty or dot path segments`);
  }
  if (segments.some((segment) => segment.includes("?"))) {
    throw new Error(`${label} supports only * wildcards`);
  }
  return segments;
}

function patternMatcher(pattern: string): RegExp {
  return new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&"))
      .join(".*")}$`,
    "u",
  );
}

function artifactPathMatches(
  artifactPath: string,
  patterns: readonly string[],
): boolean {
  const candidateSegments = artifactPatternSegments(
    artifactPath,
    "Workflow artifact path",
  );
  return patterns.some((pattern) => {
    const patternSegments = artifactPatternSegments(
      pattern,
      "Workflow artifact declaration",
    );
    return (
      candidateSegments.length === patternSegments.length &&
      candidateSegments.every((segment, index) =>
        patternMatcher(patternSegments[index]).test(segment),
      )
    );
  });
}

export function workflowArtifactExpectedKind(
  artifact: ArtifactSchema,
): "file" | "directory" {
  return artifact.kind === "directory" ? "directory" : "file";
}

async function realRunRoot(runRoot: string, label: string): Promise<string> {
  const stat = await fs.lstat(runRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} Run root must be a real directory`);
  }
  return path.resolve(runRoot);
}

export async function matchingWorkflowArtifactPaths(
  runRoot: string,
  artifactPath: string,
  expected: "file" | "directory",
  label: string,
  options: { maxMatches?: number } = { maxMatches: ARTIFACT_MAX_ENTRIES },
): Promise<string[]> {
  const segments = artifactPatternSegments(artifactPath, label);
  const root = await realRunRoot(runRoot, label);

  async function walk(relative: string, index: number): Promise<string[]> {
    if (index >= segments.length) {
      const inspection = await inspectProtectedProjectPath(runRoot, relative, {
        label,
        expected,
      });
      return inspection.exists ? [inspection.relative] : [];
    }
    const current = relative.length === 0 ? root : path.join(root, relative);
    if (relative.length > 0) {
      const inspection = await inspectProtectedProjectPath(runRoot, relative, {
        label,
        expected: "directory",
      });
      if (!inspection.exists) return [];
    }
    const segment = segments[index];
    if (!segment.includes("*")) {
      return walk(
        relative.length === 0 ? segment : path.posix.join(relative, segment),
        index + 1,
      );
    }
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return [];
      throw error;
    }
    const matcher = patternMatcher(segment);
    const matches: string[] = [];
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.isSymbolicLink()) {
        throw new Error(
          `${label} crosses a symbolic link or junction at ${path.join(current, entry.name)}`,
        );
      }
      if (!matcher.test(entry.name)) continue;
      const final = index === segments.length - 1;
      if (!final && !entry.isDirectory()) continue;
      if (
        final &&
        ((expected === "file" && !entry.isFile()) ||
          (expected === "directory" && !entry.isDirectory()))
      ) {
        continue;
      }
      const next =
        relative.length === 0
          ? entry.name
          : path.posix.join(relative, entry.name);
      matches.push(...(await walk(next, index + 1)));
      if (
        options.maxMatches !== undefined &&
        matches.length > options.maxMatches
      ) {
        throw new Error(
          `${label} exceeds ${options.maxMatches} matching paths`,
        );
      }
    }
    return matches;
  }

  return walk("", 0);
}

async function resolveArtifactPath(
  runRoot: string,
  declaration: WorkflowArtifactDeclaration,
  requestedPath: string,
): Promise<string | null> {
  const label = `Workflow artifact ${declaration.artifactId}`;
  if (!artifactPathMatches(requestedPath, declaration.artifact.paths)) {
    fail(`${label} path is outside its declaration: ${requestedPath}`);
  }
  const normalized = artifactPatternSegments(requestedPath, label).join("/");
  if (normalized.includes("*")) {
    fail(`${label} update path must identify one physical artifact`);
  }
  const inspection = await inspectProtectedProjectPath(runRoot, normalized, {
    label,
    expected: workflowArtifactExpectedKind(declaration.artifact),
  });
  return inspection.exists ? inspection.relative : null;
}

async function hashDirectoryArtifact(
  runRoot: string,
  relativePath: string,
  label: string,
): Promise<string> {
  const manifest: Array<{ path: string; contentHash: string }> = [];
  let totalBytes = 0;

  async function walk(directory: string): Promise<void> {
    const inspection = await inspectProtectedProjectPath(runRoot, directory, {
      label,
      expected: "directory",
    });
    if (!inspection.exists) throw new Error(`${label} does not exist`);
    const entries = (
      await fs.readdir(inspection.target, { withFileTypes: true })
    ).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = path.posix.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `${label} crosses a symbolic link or junction at ${relative}`,
        );
      }
      if (entry.isDirectory()) {
        await walk(relative);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          `${label} contains an unsupported object at ${relative}`,
        );
      }
      const result = await readProtectedProjectFile(
        runRoot,
        relative,
        ARTIFACT_MAX_BYTES,
        { label },
      );
      totalBytes += result.bytes.length;
      if (totalBytes > ARTIFACT_MAX_BYTES) {
        throw new Error(`${label} exceeds ${ARTIFACT_MAX_BYTES} bytes`);
      }
      manifest.push({ path: relative, contentHash: sha256(result.bytes) });
      if (manifest.length > ARTIFACT_MAX_ENTRIES) {
        throw new Error(`${label} exceeds ${ARTIFACT_MAX_ENTRIES} entries`);
      }
    }
  }

  await walk(relativePath);
  return sha256(JSON.stringify(stableValue({ kind: "directory", manifest })));
}

async function hashArtifactPath(
  runRoot: string,
  declaration: WorkflowArtifactDeclaration,
  relativePath: string,
): Promise<string> {
  const label = `Workflow artifact ${declaration.artifactId}`;
  if (!artifactPathMatches(relativePath, declaration.artifact.paths)) {
    fail(`${label} path is outside its declaration: ${relativePath}`);
  }
  if (declaration.artifact.kind === "directory") {
    return hashDirectoryArtifact(runRoot, relativePath, label);
  }
  const result = await readProtectedProjectFile(
    runRoot,
    relativePath,
    ARTIFACT_MAX_BYTES,
    { label },
  );
  return sha256(result.bytes);
}

export async function validateWorkflowArtifactVersion(
  runRoot: string,
  protocol: WorkflowProtocol,
  version: WorkflowArtifactVersion,
): Promise<void> {
  const declaration = declarationFor(
    version.artifactId,
    declarations(protocol),
  );
  if (
    version.schemaId !== declaration.schemaId ||
    version.lifetime !== artifactLifetime(declaration) ||
    !artifactPathMatches(version.path, declaration.artifact.paths)
  ) {
    fail(`Workflow artifact version identity is invalid: ${version.id}`);
  }
  const currentHash = await hashArtifactPath(
    runRoot,
    declaration,
    version.path,
  );
  if (currentHash !== version.contentHash) {
    fail(`Workflow artifact content drift detected: ${version.id}`);
  }
}

function artifactLifetime(
  declaration: WorkflowArtifactDeclaration,
): WorkflowArtifactLifetime {
  return declaration.artifact.lifetime ?? "attempt";
}

function artifactScopeId(
  lifetime: WorkflowArtifactLifetime,
  state: RunState,
): string {
  const attempt = state.workflowRuntime?.currentAttempt;
  if (!attempt) fail("Workflow artifact update requires a current Attempt");
  if (lifetime === "attempt") return attempt.id;
  if (lifetime === "cycle") {
    if (!attempt.cycleId) {
      fail("Cycle-persistent artifact update requires a current Cycle");
    }
    return attempt.cycleId;
  }
  return state.runId;
}

function selection(
  artifactId: string,
  versionId: string,
  state: RunState,
  nodeId: string,
  actionId: string,
  timestamp: string,
): WorkflowArtifactSelection {
  const runtime = state.workflowRuntime;
  const attempt = runtime?.currentAttempt;
  if (!runtime || !attempt) {
    fail("Workflow artifact selection requires a current Attempt");
  }
  return {
    artifactId,
    versionId,
    runId: state.runId,
    nodeId,
    cycleId: attempt.cycleId,
    attemptId: attempt.id,
    actionId,
    revision: runtime.revision,
    timestamp,
  };
}

function artifactVersionId(
  artifactId: string,
  contentHash: string,
  pathValue: string,
  producer: WorkflowArtifactVersion["producer"],
  scopeId: string,
): WorkflowArtifactVersionId {
  return `artifact-version-${sha256(
    JSON.stringify(
      stableValue({
        artifactId,
        contentHash,
        path: pathValue,
        producer,
        scopeId,
      }),
    ),
  ).slice(0, 24)}`;
}

function assertSelectionScope(
  version: WorkflowArtifactVersion,
  state: RunState,
): void {
  const attempt = state.workflowRuntime?.currentAttempt;
  if (!attempt) fail("Workflow artifact selection requires a current Attempt");
  if (version.producer.runId !== state.runId) {
    fail(`Workflow artifact version belongs to another Run: ${version.id}`);
  }
  if (version.lifetime === "attempt" && version.scopeId !== attempt.id) {
    fail(`Attempt artifact version is stale for this Attempt: ${version.id}`);
  }
  if (version.lifetime === "cycle" && version.scopeId !== attempt.cycleId) {
    fail(`Cycle artifact version is stale for this Cycle: ${version.id}`);
  }
  if (version.lifetime === "run" && version.scopeId !== state.runId) {
    fail(`Run artifact version has an invalid scope: ${version.id}`);
  }
}

function requestedDeclarations<TValue extends string>(
  values: Readonly<Record<WorkflowArtifactId, TValue>>,
  candidates: readonly WorkflowArtifactDeclaration[],
  label: string,
): Map<
  WorkflowArtifactId,
  { declaration: WorkflowArtifactDeclaration; value: TValue }
> {
  const result = new Map<
    WorkflowArtifactId,
    { declaration: WorkflowArtifactDeclaration; value: TValue }
  >();
  for (const [key, value] of Object.entries(values)) {
    const declaration = declarationFor(key, candidates);
    if (result.has(declaration.artifactId)) {
      fail(`${label} repeats artifact ${declaration.artifactId}`);
    }
    result.set(declaration.artifactId, { declaration, value });
  }
  return result;
}

export async function prepareWorkflowArtifactMutation(options: {
  runRoot: string;
  protocol: WorkflowProtocol;
  state: RunState;
  nodeId: string;
  actionId: string;
  artifacts?: Record<WorkflowArtifactId, WorkflowArtifactPath>;
  artifactVersions?: Record<WorkflowArtifactId, WorkflowArtifactVersionId>;
}): Promise<WorkflowArtifactMutation> {
  const empty: WorkflowArtifactMutation = {
    versions: [],
    selections: [],
    artifactPaths: {},
    selectedVersionIds: {},
  };
  if (!versioningEnabled(options.protocol)) {
    if (Object.keys(options.artifactVersions ?? {}).length > 0) {
      fail(
        "Workflow artifact selections require versioned-artifacts capability",
      );
    }
    return empty;
  }
  const runtime = options.state.workflowRuntime;
  const attempt = runtime?.currentAttempt;
  if (!runtime || !attempt) {
    fail("Versioned artifact submission requires revisioned Run state");
  }
  const allDeclarations = declarations(options.protocol);
  const outputDeclarations = declarationsForNode(
    options.protocol,
    options.nodeId,
  );
  const requestedUpdates = requestedDeclarations(
    options.artifacts ?? {},
    outputDeclarations,
    "Workflow artifact updates",
  );
  const requestedSelections = requestedDeclarations(
    options.artifactVersions ?? {},
    allDeclarations,
    "Workflow artifact selections",
  );
  for (const artifactId of requestedSelections.keys()) {
    if (requestedUpdates.has(artifactId)) {
      fail(
        `Workflow artifact cannot be updated and carried forward: ${artifactId}`,
      );
    }
  }
  for (const declaration of outputDeclarations) {
    if (
      declaration.artifact.required &&
      !requestedUpdates.has(declaration.artifactId) &&
      !requestedSelections.has(declaration.artifactId)
    ) {
      fail(
        `Required Workflow artifact needs an explicit update or version: ${declaration.artifactId}`,
      );
    }
  }

  const mutation: WorkflowArtifactMutation = structuredClone(empty);
  const timestamp = new Date().toISOString();
  for (const { declaration, value: requested } of requestedUpdates.values()) {
    const artifactPath = await resolveArtifactPath(
      options.runRoot,
      declaration,
      requested,
    );
    if (!artifactPath) {
      fail(
        `Workflow artifact update does not exist: ${declaration.artifactId}`,
      );
    }
    const lifetime = artifactLifetime(declaration);
    if (
      lifetime === "attempt" &&
      !artifactPath.split("/").includes(attempt.id)
    ) {
      fail(
        `Attempt artifact path must include the current Attempt id: ${declaration.artifactId}`,
      );
    }
    const contentHash = await hashArtifactPath(
      options.runRoot,
      declaration,
      artifactPath,
    );
    const scopeId = artifactScopeId(lifetime, options.state);
    const producer = {
      runId: options.state.runId,
      nodeId: options.nodeId,
      cycleId: attempt.cycleId,
      attemptId: attempt.id,
      actionId: options.actionId,
      revision: runtime.revision,
    };
    const id = artifactVersionId(
      declaration.artifactId,
      contentHash,
      artifactPath,
      producer,
      scopeId,
    );
    if (runtime.artifactVersions.some((version) => version.id === id)) {
      fail(`Workflow artifact version already exists: ${id}`);
    }
    const version: WorkflowArtifactVersion = {
      id,
      artifactId: declaration.artifactId,
      schemaId: declaration.schemaId,
      lifetime,
      scopeId,
      contentHash,
      path: artifactPath,
      producer,
      timestamp,
    };
    mutation.versions.push(version);
    mutation.selections.push(
      selection(
        declaration.artifactId,
        id,
        options.state,
        options.nodeId,
        options.actionId,
        timestamp,
      ),
    );
    mutation.artifactPaths[declaration.artifactId] = artifactPath;
    mutation.selectedVersionIds[declaration.artifactId] = id;
  }

  for (const {
    declaration,
    value: versionId,
  } of requestedSelections.values()) {
    const version = runtime.artifactVersions.find(
      (candidate) => candidate.id === versionId,
    );
    if (!version) fail(`Workflow artifact version is unknown: ${versionId}`);
    if (version.artifactId !== declaration.artifactId) {
      fail(
        `Workflow artifact version ${versionId} does not belong to ${declaration.artifactId}`,
      );
    }
    if (version.lifetime !== artifactLifetime(declaration)) {
      fail(
        `Workflow artifact lifetime is incompatible: ${declaration.artifactId}`,
      );
    }
    assertSelectionScope(version, options.state);
    const contentHash = await hashArtifactPath(
      options.runRoot,
      declaration,
      version.path,
    );
    if (contentHash !== version.contentHash) {
      fail(`Workflow artifact content drift detected: ${version.id}`);
    }
    mutation.selections.push(
      selection(
        declaration.artifactId,
        version.id,
        options.state,
        options.nodeId,
        options.actionId,
        timestamp,
      ),
    );
    mutation.artifactPaths[declaration.artifactId] = version.path;
    mutation.selectedVersionIds[declaration.artifactId] = version.id;
  }
  return mutation;
}

export function currentWorkflowArtifactVersions(
  runtime: Readonly<WorkflowRuntimeState> | undefined,
): Record<WorkflowArtifactId, WorkflowArtifactVersionId> {
  const current: Record<WorkflowArtifactId, WorkflowArtifactVersionId> = {};
  for (const selection of runtime?.artifactSelections ?? []) {
    const version = runtime?.artifactVersions?.find(
      (candidate) => candidate.id === selection.versionId,
    );
    if (!version) continue;
    if (
      (version.lifetime === "attempt" &&
        version.scopeId !== runtime?.currentAttempt?.id) ||
      (version.lifetime === "cycle" &&
        version.scopeId !== runtime?.currentCycle?.id)
    ) {
      continue;
    }
    current[selection.artifactId] = selection.versionId;
  }
  return current;
}

export function validateWorkflowArtifactState(
  protocol: WorkflowProtocol,
  runId: string,
  nodeToStep: Readonly<Record<string, string>>,
  runtime: Readonly<WorkflowRuntimeState>,
): void {
  const versions = runtime.artifactVersions ?? [];
  const selections = runtime.artifactSelections ?? [];
  if (!versioningEnabled(protocol)) {
    if (versions.length > 0 || selections.length > 0) {
      throw new Error(
        "WorkflowRuntime artifact state requires versioned-artifacts capability",
      );
    }
    return;
  }
  const declared = declarations(protocol);
  const versionsById = new Map(
    versions.map((version) => [version.id, version]),
  );
  for (const version of versions) {
    const declaration = declarationFor(version.artifactId, declared);
    if (
      version.schemaId !== declaration.schemaId ||
      version.lifetime !== artifactLifetime(declaration) ||
      !artifactPathMatches(version.path, declaration.artifact.paths) ||
      version.producer.runId !== runId ||
      version.producer.revision >= runtime.revision
    ) {
      throw new Error(
        `WorkflowRuntime artifact version identity is invalid: ${version.id}`,
      );
    }
    const stepId = nodeToStep[version.producer.nodeId];
    const visit = runtime.visits.find(
      (candidate) => candidate.attemptId === version.producer.attemptId,
    );
    const outcome = visit?.outcomes.find(
      (candidate) => candidate.actionId === version.producer.actionId,
    );
    if (
      !stepId ||
      !visit ||
      visit.stepId !== stepId ||
      visit.cycleId !== version.producer.cycleId ||
      !outcome ||
      outcome.status !== "succeeded" ||
      outcome.artifactVersions?.[version.artifactId] !== version.id
    ) {
      throw new Error(
        `WorkflowRuntime artifact producer is invalid: ${version.id}`,
      );
    }
    if (
      version.id !==
      artifactVersionId(
        version.artifactId,
        version.contentHash,
        version.path,
        version.producer,
        version.scopeId,
      )
    ) {
      throw new Error(
        `WorkflowRuntime artifact version identity is invalid: ${version.id}`,
      );
    }
    if (
      !selections.some(
        (item) =>
          item.artifactId === version.artifactId &&
          item.versionId === version.id &&
          item.attemptId === version.producer.attemptId &&
          item.actionId === version.producer.actionId,
      )
    ) {
      throw new Error(
        `WorkflowRuntime artifact version has no accepted selection: ${version.id}`,
      );
    }
  }
  for (const item of selections) {
    const version = versionsById.get(item.versionId);
    const stepId = nodeToStep[item.nodeId];
    const visit = runtime.visits.find(
      (candidate) => candidate.attemptId === item.attemptId,
    );
    const outcome = visit?.outcomes.find(
      (candidate) => candidate.actionId === item.actionId,
    );
    if (
      !version ||
      version.artifactId !== item.artifactId ||
      item.runId !== runId ||
      item.revision >= runtime.revision ||
      !stepId ||
      !visit ||
      visit.stepId !== stepId ||
      visit.cycleId !== item.cycleId ||
      !outcome ||
      outcome.status !== "succeeded" ||
      outcome.artifactVersions?.[item.artifactId] !== item.versionId ||
      (version.lifetime === "attempt" && version.scopeId !== item.attemptId) ||
      (version.lifetime === "cycle" && version.scopeId !== item.cycleId) ||
      (version.lifetime === "run" && version.scopeId !== runId)
    ) {
      throw new Error(
        `WorkflowRuntime artifact selection is invalid: ${item.versionId}`,
      );
    }
  }
  for (const visit of runtime.visits) {
    for (const outcome of visit.outcomes) {
      for (const [artifactId, versionId] of Object.entries(
        outcome.artifactVersions ?? {},
      )) {
        if (
          !selections.some(
            (item) =>
              item.artifactId === artifactId &&
              item.versionId === versionId &&
              item.attemptId === visit.attemptId &&
              item.actionId === outcome.actionId,
          )
        ) {
          throw new Error(
            `WorkflowRuntime outcome has an unknown artifact selection: ${versionId}`,
          );
        }
      }
    }
  }
}
