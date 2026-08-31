import type {
  EngineAction,
  RunState,
  WorkflowVisitOutcome,
  WorkflowVisitState,
} from "../engine/types.js";
import type { SkillPackage } from "../skill-runtime/types.js";
import type {
  ArtifactSchema,
  OutputSchema,
  WorkflowArtifactProducer,
  WorkflowArtifactVersion,
  WorkflowDecisionScope,
  WorkflowDecisionScopeReference,
  WorkflowDecisionScopeSelection,
  WorkflowDecisionScopeSelectionReference,
  WorkflowDecisionScopeSnapshot,
  WorkflowProtocol,
} from "../types.js";
import { sha256, stableValue } from "../util.js";
import { validateWorkflowArtifactVersion } from "./artifacts.js";

interface ArtifactDeclaration {
  id: string;
  schemaId: string;
  artifact: ArtifactSchema;
}

interface EvidenceDeclaration {
  id: string;
  schemaId: string;
  evidenceId: string;
}

export class WorkflowDecisionScopeError extends Error {
  readonly blockers: string[];

  constructor(message: string) {
    super(message);
    this.name = "WorkflowDecisionScopeError";
    this.blockers = [message];
  }
}

function fail(message: string): never {
  throw new WorkflowDecisionScopeError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function protocolNodeForAction(
  pkg: Readonly<SkillPackage>,
  action: EngineAction,
) {
  const nodeId = Object.entries(pkg.runtime?.nodeToStep ?? {}).find(
    ([, stepId]) => stepId === action.stepId,
  )?.[0];
  return pkg.runtime?.protocol.nodes.find((node) => node.id === nodeId);
}

function artifactDeclarations(
  protocol: WorkflowProtocol,
): ArtifactDeclaration[] {
  return protocol.outputSchemas.flatMap((schema: OutputSchema) =>
    schema.artifacts.map((artifact) => ({
      id: `${schema.id}.${artifact.id}`,
      schemaId: schema.id,
      artifact,
    })),
  );
}

function evidenceDeclarations(
  protocol: WorkflowProtocol,
): EvidenceDeclaration[] {
  return protocol.outputSchemas.flatMap((schema: OutputSchema) =>
    schema.evidence.map((evidence) => ({
      id: `${schema.id}.${evidence.id}`,
      schemaId: schema.id,
      evidenceId: evidence.id,
    })),
  );
}

function resolveDeclaration<T extends { id: string }>(
  requested: string,
  declarations: readonly T[],
  label: string,
): T {
  const exact = declarations.find(
    (declaration) => declaration.id === requested,
  );
  if (exact) return exact;
  const matches = declarations.filter(
    (declaration) =>
      declaration.id.slice(declaration.id.lastIndexOf(".") + 1) === requested,
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    fail(`${label} requires a schema-qualified id: ${requested}`);
  }
  fail(`${label} is not declared: ${requested}`);
}

function referenceKey(
  reference: Pick<WorkflowDecisionScopeReference, "id" | "versionId">,
): string {
  return `${reference.id}\u0000${reference.versionId}`;
}

function producerEqual(
  left: WorkflowArtifactProducer,
  right: WorkflowArtifactProducer,
): boolean {
  return (
    JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))
  );
}

function contentHash(value: unknown): string {
  return sha256(JSON.stringify(stableValue(value)) ?? "undefined");
}

function evidenceValue(
  evidence: Record<string, unknown> | undefined,
  declaration: EvidenceDeclaration,
): { found: boolean; value?: unknown } {
  if (!evidence) return { found: false };
  const logicalId = declaration.id;
  for (const key of [logicalId, declaration.evidenceId]) {
    if (Object.prototype.hasOwnProperty.call(evidence, key)) {
      return { found: true, value: evidence[key] };
    }
  }
  const scoped = evidence.schemaEvidence;
  if (!isRecord(scoped)) return { found: false };
  if (Object.prototype.hasOwnProperty.call(scoped, logicalId)) {
    return { found: true, value: scoped[logicalId] };
  }
  const schemaEvidence = scoped[declaration.schemaId];
  if (isRecord(schemaEvidence)) {
    if (
      Object.prototype.hasOwnProperty.call(
        schemaEvidence,
        declaration.evidenceId,
      )
    ) {
      return {
        found: true,
        value: schemaEvidence[declaration.evidenceId],
      };
    }
  }
  return { found: false };
}

function outcomeRevision(
  runtime: Readonly<RunState["workflowRuntime"]>,
  visit: WorkflowVisitState,
  outcome: WorkflowVisitOutcome,
): number {
  if (!runtime) fail("Decision evidence requires WorkflowRuntime state");
  let revision = 0;
  for (const candidate of runtime.visits) {
    for (const candidateOutcome of candidate.outcomes) {
      if (
        candidate.attemptId === visit.attemptId &&
        candidateOutcome.actionId === outcome.actionId
      ) {
        return revision;
      }
      revision += 1;
    }
  }
  fail(`Decision evidence outcome is not accepted: ${outcome.actionId}`);
}

function evidenceProducer(
  state: RunState,
  visit: WorkflowVisitState,
  outcome: WorkflowVisitOutcome,
): WorkflowArtifactProducer {
  return {
    runId: state.runId,
    nodeId:
      Object.entries(state.runtimeIdentity?.nodeToStep ?? {}).find(
        ([, stepId]) => stepId === visit.stepId,
      )?.[0] ?? visit.stepId,
    cycleId: visit.cycleId,
    attemptId: visit.attemptId,
    actionId: outcome.actionId,
    revision: outcomeRevision(state.workflowRuntime, visit, outcome),
  };
}

function evidenceVersionId(
  evidenceId: string,
  hash: string,
  producer: WorkflowArtifactProducer,
): string {
  return `evidence-version-${sha256(
    JSON.stringify(stableValue({ evidenceId, hash, producer })),
  ).slice(0, 24)}`;
}

function evidenceReference(
  state: RunState,
  declaration: EvidenceDeclaration,
  visit: WorkflowVisitState,
  outcome: WorkflowVisitOutcome,
  value: unknown,
  required: boolean,
): WorkflowDecisionScopeReference {
  const producer = evidenceProducer(state, visit, outcome);
  const hash = contentHash(value);
  return {
    id: declaration.id,
    required,
    versionId: evidenceVersionId(declaration.id, hash, producer),
    contentHash: hash,
    producer,
  };
}

function nodeAllowsEvidence(
  protocol: WorkflowProtocol,
  nodeId: string,
  schemaId: string,
): boolean {
  return (
    protocol.nodes
      .find((node) => node.id === nodeId)
      ?.outputSchemas.includes(schemaId) ?? false
  );
}

function acceptedEvidenceReference(
  protocol: WorkflowProtocol,
  state: RunState,
  declaration: EvidenceDeclaration,
  required: boolean,
  producer?: WorkflowArtifactProducer,
): WorkflowDecisionScopeReference | undefined {
  const runtime = state.workflowRuntime;
  if (!runtime) fail("Decision evidence requires WorkflowRuntime state");
  const nodeByStep = new Map(
    Object.entries(state.runtimeIdentity?.nodeToStep ?? {}).map(
      ([nodeId, stepId]) => [stepId, nodeId],
    ),
  );
  const visits = [...runtime.visits].reverse();
  for (const visit of visits) {
    const nodeId = nodeByStep.get(visit.stepId);
    if (
      !nodeId ||
      !nodeAllowsEvidence(protocol, nodeId, declaration.schemaId)
    ) {
      continue;
    }
    for (const outcome of [...visit.outcomes].reverse()) {
      if (outcome.status !== "succeeded") continue;
      const value = evidenceValue(outcome.evidence, declaration);
      if (!value.found) continue;
      const reference = evidenceReference(
        state,
        declaration,
        visit,
        outcome,
        value.value,
        required,
      );
      if (!producer || producerEqual(reference.producer, producer)) {
        return reference;
      }
    }
  }
  return undefined;
}

function artifactIsUsable(
  state: RunState,
  version: WorkflowArtifactVersion,
): boolean {
  if (version.producer.runId !== state.runId) return false;
  const currentCycleId = state.workflowRuntime?.currentCycle?.id ?? null;
  if (version.lifetime === "run") return version.scopeId === state.runId;
  if (version.lifetime === "cycle") return version.scopeId === currentCycleId;
  return version.scopeId === state.workflowRuntime?.currentAttempt?.id;
}

function acceptedArtifactVersion(
  state: RunState,
  artifactId: string,
): WorkflowArtifactVersion | undefined {
  const runtime = state.workflowRuntime;
  if (!runtime) fail("Decision artifact scope requires WorkflowRuntime state");
  const versions = new Map(
    runtime.artifactVersions.map((version) => [version.id, version]),
  );
  for (const selection of [...runtime.artifactSelections].reverse()) {
    if (selection.artifactId !== artifactId) continue;
    const version = versions.get(selection.versionId);
    if (version && artifactIsUsable(state, version)) return version;
  }
  return undefined;
}

function artifactReference(
  state: RunState,
  version: WorkflowArtifactVersion,
  required: boolean,
): WorkflowDecisionScopeReference {
  return {
    id: version.artifactId,
    required,
    versionId: version.id,
    contentHash: version.contentHash,
    producer: structuredClone(version.producer),
  };
}

function validateScopeDefinition(
  pkg: Readonly<SkillPackage>,
  action: EngineAction,
  scope: WorkflowDecisionScopeSnapshot,
): void {
  const node = protocolNodeForAction(pkg, action);
  validateWorkflowDecisionScopeDefinitionForNode(pkg, node?.id, scope);
}

export function validateWorkflowDecisionScopeDefinitionForNode(
  pkg: Readonly<SkillPackage>,
  nodeId: string | undefined,
  scope: WorkflowDecisionScopeSnapshot,
): void {
  const definition = pkg.runtime?.protocol.nodes.find(
    (candidate) => candidate.id === nodeId,
  )?.decision?.scope;
  if (!definition) fail("Decision action has an undeclared scope");
  const validateKind = (
    kind: "artifacts" | "evidence",
    references: readonly WorkflowDecisionScopeReference[],
  ): void => {
    const definitionEntries = (definition[kind] ?? []).map((entry) => ({
      ...entry,
      id: (kind === "artifacts"
        ? resolveDeclaration(
            entry.id,
            artifactDeclarations(pkg.runtime!.protocol),
            `Decision ${kind} scope`,
          )
        : resolveDeclaration(
            entry.id,
            evidenceDeclarations(pkg.runtime!.protocol),
            `Decision ${kind} scope`,
          )
      ).id,
    }));
    const declarationById = new Map(
      definitionEntries.map((entry) => [entry.id, entry]),
    );
    for (const reference of references) {
      const entry = declarationById.get(reference.id);
      if (!entry) {
        fail(`Decision ${kind} scope reference is undeclared: ${reference.id}`);
      }
      if (reference.required !== (entry.required === true)) {
        fail(`Decision ${kind} scope requiredness is invalid: ${reference.id}`);
      }
    }
    for (const entry of definitionEntries) {
      if (
        entry.required &&
        !references.some((reference) => reference.id === entry.id)
      ) {
        fail(`Required decision ${kind} scope is missing: ${entry.id}`);
      }
    }
  };
  validateKind("artifacts", scope.artifacts ?? []);
  validateKind("evidence", scope.evidence ?? []);
}

export async function captureWorkflowDecisionScope(
  runRoot: string,
  pkg: Readonly<SkillPackage>,
  state: RunState,
  action: EngineAction,
): Promise<EngineAction> {
  if (action.type !== "ask_user") return action;
  const node = protocolNodeForAction(pkg, action);
  const scope = node?.decision?.scope;
  if (!scope) return action;
  const snapshot: WorkflowDecisionScopeSnapshot = {
    artifacts: [],
    evidence: [],
  };
  for (const entry of scope.artifacts ?? []) {
    const declaration = resolveDeclaration(
      entry.id,
      artifactDeclarations(pkg.runtime!.protocol),
      "Decision artifact scope",
    );
    const version = acceptedArtifactVersion(state, declaration.id);
    if (!version) {
      if (entry.required) {
        fail(
          `Required decision artifact scope is unavailable: ${declaration.id}`,
        );
      }
      continue;
    }
    try {
      await validateWorkflowArtifactVersion(
        runRoot,
        pkg.runtime!.protocol,
        version,
      );
    } catch (error) {
      fail(
        `Decision artifact scope is unavailable: ${declaration.id} (${String(
          error instanceof Error ? error.message : error,
        )})`,
      );
    }
    snapshot.artifacts.push(
      artifactReference(state, version, entry.required === true),
    );
  }
  for (const entry of scope.evidence ?? []) {
    const declaration = resolveDeclaration(
      entry.id,
      evidenceDeclarations(pkg.runtime!.protocol),
      "Decision evidence scope",
    );
    const reference = acceptedEvidenceReference(
      pkg.runtime!.protocol,
      state,
      declaration,
      entry.required === true,
    );
    if (!reference) {
      if (entry.required) {
        fail(
          `Required decision evidence scope is unavailable: ${declaration.id}`,
        );
      }
      continue;
    }
    snapshot.evidence.push(reference);
  }
  return { ...action, scope: snapshot };
}

function scopeReferenceEqual(
  left: WorkflowDecisionScopeReference,
  right: WorkflowDecisionScopeReference,
): boolean {
  return (
    JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))
  );
}

function pendingReference(
  references: readonly WorkflowDecisionScopeReference[],
  id: string,
): WorkflowDecisionScopeReference {
  const matches = references.filter((reference) => reference.id === id);
  if (matches.length !== 1) {
    fail(`Decision scope reference is not pending: ${id}`);
  }
  return matches[0];
}

function validateScopeList(
  references: readonly WorkflowDecisionScopeSelectionReference[],
  pending: readonly WorkflowDecisionScopeReference[],
  label: string,
): void {
  const keys = new Set<string>();
  for (const reference of references) {
    if (!isRecord(reference)) fail(`${label} entries must be objects`);
    const unknown = Object.keys(reference).find(
      (key) =>
        !["id", "required", "versionId", "contentHash", "producer"].includes(
          key,
        ),
    );
    if (unknown) fail(`${label} has unsupported field: ${unknown}`);
    if (
      typeof reference.id !== "string" ||
      typeof reference.versionId !== "string" ||
      typeof reference.contentHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(reference.contentHash) ||
      (reference.required !== undefined &&
        typeof reference.required !== "boolean") ||
      (reference.producer !== undefined && !isRecord(reference.producer))
    ) {
      fail(`${label} contains an invalid reference`);
    }
    const key = referenceKey(reference);
    if (keys.has(key))
      fail(`${label} contains a duplicate reference: ${reference.id}`);
    keys.add(key);
    const expected = pendingReference(pending, reference.id);
    if (
      reference.required !== undefined &&
      reference.required !== expected.required
    ) {
      fail(
        `Decision scope requiredness does not match pending scope: ${reference.id}`,
      );
    }
    if (
      reference.producer !== undefined &&
      !producerEqual(reference.producer, expected.producer)
    ) {
      fail(
        `Decision scope producer does not match pending scope: ${reference.id}`,
      );
    }
    if (
      reference.id !== expected.id ||
      reference.versionId !== expected.versionId ||
      reference.contentHash !== expected.contentHash
    ) {
      fail(
        `Decision scope reference does not match pending scope: ${reference.id}`,
      );
    }
  }
}

export function validateWorkflowDecisionScopeResponse(
  pending: WorkflowDecisionScopeSnapshot | undefined,
  submitted: WorkflowDecisionScopeSelection | undefined,
  evidenceReferences: readonly string[] | undefined,
): void {
  let submittedScope: WorkflowDecisionScopeSelection | undefined;
  if (submitted) {
    const submittedValue: unknown = submitted;
    if (!isRecord(submittedValue)) {
      fail("Decision response scope must be an object");
    }
    const unknown = Object.keys(submittedValue).find(
      (key) => key !== "artifacts" && key !== "evidence",
    );
    if (unknown)
      fail(`Decision response scope has unsupported field: ${unknown}`);
    if (
      (submittedValue.artifacts !== undefined &&
        !Array.isArray(submittedValue.artifacts)) ||
      (submittedValue.evidence !== undefined &&
        !Array.isArray(submittedValue.evidence))
    ) {
      fail("Decision response scope entries must be arrays");
    }
    if (
      (submittedValue.artifacts?.length ?? 0) > 64 ||
      (submittedValue.evidence?.length ?? 0) > 64
    ) {
      fail("Decision response scope contains too many entries");
    }
    submittedScope = {
      artifacts: submittedValue.artifacts as
        WorkflowDecisionScopeSelectionReference[] | undefined,
      evidence: submittedValue.evidence as
        WorkflowDecisionScopeSelectionReference[] | undefined,
    };
  }
  if (!pending) {
    if (
      (submitted &&
        ((submitted.artifacts?.length ?? 0) > 0 ||
          (submitted.evidence?.length ?? 0) > 0)) ||
      (evidenceReferences && evidenceReferences.length > 0)
    ) {
      fail("Decision response includes scope that was not declared");
    }
    return;
  }
  const selected = submittedScope
    ? {
        artifacts: submittedScope.artifacts ?? [],
        evidence: submittedScope.evidence ?? [],
      }
    : {
        artifacts: [],
        evidence: (pending.evidence ?? []).filter((candidate) =>
          evidenceReferences?.some(
            (reference) =>
              reference === candidate.id || reference === candidate.versionId,
          ),
        ),
      };
  validateScopeList(
    selected.artifacts ?? [],
    pending.artifacts,
    "Decision artifact scope",
  );
  validateScopeList(
    selected.evidence ?? [],
    pending.evidence,
    "Decision evidence scope",
  );
  if (evidenceReferences) {
    const selectedEvidence = new Set(
      (selected.evidence ?? []).map((reference) => reference.versionId),
    );
    for (const reference of evidenceReferences) {
      const pendingReferenceValue = pending.evidence.find(
        (candidate) =>
          candidate.versionId === reference || candidate.id === reference,
      );
      if (!pendingReferenceValue) {
        fail(`Decision evidence reference is not pending: ${reference}`);
      }
      if (!selectedEvidence.has(pendingReferenceValue.versionId)) {
        fail(`Decision evidence reference is not selected: ${reference}`);
      }
    }
  }
  for (const reference of pending.artifacts) {
    if (
      reference.required &&
      !selected.artifacts.some((item) => item.id === reference.id)
    ) {
      fail(`Required decision artifact scope is missing: ${reference.id}`);
    }
  }
  for (const reference of pending.evidence) {
    if (
      reference.required &&
      !selected.evidence.some((item) => item.id === reference.id)
    ) {
      fail(`Required decision evidence scope is missing: ${reference.id}`);
    }
  }
}

async function validateArtifactReference(
  runRoot: string,
  protocol: WorkflowProtocol,
  state: RunState,
  reference: WorkflowDecisionScopeReference,
  requireCurrentScope: boolean,
  verifyContent: boolean,
): Promise<void> {
  const version = state.workflowRuntime?.artifactVersions.find(
    (candidate) => candidate.id === reference.versionId,
  );
  if (!version)
    fail(`Decision artifact version is missing: ${reference.versionId}`);
  if (
    version.artifactId !== reference.id ||
    version.contentHash !== reference.contentHash ||
    !producerEqual(version.producer, reference.producer) ||
    (requireCurrentScope && !artifactIsUsable(state, version))
  ) {
    fail(`Decision artifact scope is stale: ${reference.id}`);
  }
  if (verifyContent) {
    await validateWorkflowArtifactVersion(runRoot, protocol, version);
  }
}

function findEvidenceOutcome(
  state: RunState,
  reference: WorkflowDecisionScopeReference,
): { visit: WorkflowVisitState; outcome: WorkflowVisitOutcome } | undefined {
  for (const visit of state.workflowRuntime?.visits ?? []) {
    if (visit.attemptId !== reference.producer.attemptId) continue;
    const outcome = visit.outcomes.find(
      (candidate) => candidate.actionId === reference.producer.actionId,
    );
    if (outcome) return { visit, outcome };
  }
  return undefined;
}

function validateEvidenceReference(
  protocol: WorkflowProtocol,
  state: RunState,
  reference: WorkflowDecisionScopeReference,
): void {
  const declaration = resolveDeclaration(
    reference.id,
    evidenceDeclarations(protocol),
    "Decision evidence scope",
  );
  const found = findEvidenceOutcome(state, reference);
  if (!found || found.outcome.status !== "succeeded") {
    fail(`Decision evidence version is missing: ${reference.versionId}`);
  }
  const nodeId = Object.entries(state.runtimeIdentity?.nodeToStep ?? {}).find(
    ([, stepId]) => stepId === found.visit.stepId,
  )?.[0];
  if (!nodeId || !nodeAllowsEvidence(protocol, nodeId, declaration.schemaId)) {
    fail(`Decision evidence producer is invalid: ${reference.versionId}`);
  }
  const value = evidenceValue(found.outcome.evidence, declaration);
  if (!value.found)
    fail(`Decision evidence version is stale: ${reference.versionId}`);
  const expected = evidenceReference(
    state,
    declaration,
    found.visit,
    found.outcome,
    value.value,
    reference.required,
  );
  if (!scopeReferenceEqual(expected, reference)) {
    fail(`Decision evidence scope is stale: ${reference.id}`);
  }
}

export async function validateWorkflowDecisionScope(
  runRoot: string,
  pkg: Readonly<SkillPackage>,
  state: RunState,
  action: EngineAction,
): Promise<void> {
  const scope = action.scope;
  const node = protocolNodeForAction(pkg, action);
  const definition = node?.decision?.scope;
  if (definition && !scope) {
    fail("Decision action is missing its captured scope");
  }
  if (!definition && scope) {
    fail("Decision action has an undeclared scope");
  }
  if (!scope) return;
  validateScopeDefinition(pkg, action, scope);
  await validateWorkflowDecisionScopeSnapshot(runRoot, pkg, state, scope);
}

export async function validateWorkflowDecisionScopeSnapshot(
  runRoot: string,
  pkg: Readonly<SkillPackage>,
  state: RunState,
  scope: WorkflowDecisionScopeSnapshot,
  options: {
    requireCurrentScope?: boolean;
    verifyArtifactContent?: boolean;
  } = {},
): Promise<void> {
  for (const reference of scope.artifacts ?? []) {
    await validateArtifactReference(
      runRoot,
      pkg.runtime!.protocol,
      state,
      reference,
      options.requireCurrentScope !== false,
      options.verifyArtifactContent !== false,
    );
  }
  for (const reference of scope.evidence ?? []) {
    validateEvidenceReference(pkg.runtime!.protocol, state, reference);
  }
}

export function decisionScopeDefinition(
  protocol: WorkflowProtocol,
  nodeId: string,
): WorkflowDecisionScope | undefined {
  return protocol.nodes.find((node) => node.id === nodeId)?.decision?.scope;
}

export function validateWorkflowDecisionScopeDefinition(
  protocol: WorkflowProtocol,
): void {
  const artifacts = artifactDeclarations(protocol);
  const evidence = evidenceDeclarations(protocol);
  for (const node of protocol.nodes) {
    if (!node.decision?.scope) continue;
    for (const kind of ["artifacts", "evidence"] as const) {
      const seen = new Set<string>();
      for (const entry of node.decision.scope[kind] ?? []) {
        const declaration =
          kind === "artifacts"
            ? resolveDeclaration(entry.id, artifacts, `Decision ${kind} scope`)
            : resolveDeclaration(entry.id, evidence, `Decision ${kind} scope`);
        if (seen.has(declaration.id)) {
          fail(
            `Decision ${kind} scope repeats a declaration: ${declaration.id}`,
          );
        }
        seen.add(declaration.id);
        if (
          kind === "artifacts" &&
          !protocol.capabilities?.features.includes("versioned-artifacts")
        ) {
          fail(
            `Decision artifact scope requires versioned-artifacts capability: ${declaration.id}`,
          );
        }
      }
    }
  }
}
