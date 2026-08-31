import path from "node:path";
import { atomicWriteContainedText } from "../engine/contained-atomic-write.js";
import {
  ensureProtectedProjectDirectory,
  inspectProtectedProjectPath,
  readProtectedProjectFile,
} from "../engine/protected-project-path.js";
import { normalizeWorkflowRelativePath } from "../engine/project-config.js";
import {
  hashSkillPackage,
  readSkillSnapshot,
} from "../skill-runtime/snapshot.js";
import { type ManualRunResult } from "../engine/manual-run.js";
import {
  parsePendingActionValue,
  readPendingAction,
  readTrajectory,
} from "../engine/run-store.js";
import { parseRunStateValue } from "../engine/state.js";
import { RaceSafeReadError } from "../engine/race-safe-read.js";
import type {
  EvalResult,
  EngineAction,
  RunState,
  TrajectoryEvent,
  WorkflowVisitState,
} from "../engine/types.js";
import type { WorkflowArtifactMutation } from "../engine/runtime-types.js";
import type {
  DecisionScalar,
  WorkflowDecisionInputSchema,
  WorkflowDurabilityProfile,
  WorkflowProtocol,
  WorkflowReviewerPolicy,
} from "../types.js";
import { stableValue } from "../util.js";
import { compileWorkflow } from "./compiler.js";
import {
  createCompletionPlan,
  validateSuccessfulSubmission,
} from "./completion.js";
import {
  currentWorkflowArtifactVersions,
  prepareWorkflowArtifactMutation,
  validateWorkflowArtifactState,
  WorkflowArtifactValidationError,
} from "./artifacts.js";
import {
  WorkflowRouteResolutionError,
  isRevisionedWorkflowProtocol,
  resolveWorkflowTransition,
  validateWorkflowCycleState,
  workflowCycleOwnsNode,
} from "./routing.js";
import {
  captureWorkflowDecisionScope,
  validateWorkflowDecisionScope,
  validateWorkflowDecisionScopeDefinitionForNode,
  validateWorkflowDecisionScopeResponse,
  validateWorkflowDecisionScopeSnapshot,
  WorkflowDecisionScopeError,
} from "./decision-scope.js";
import { resolverForPackage } from "./resolver.js";
import {
  MAX_WORKFLOW_FINDINGS,
  WORKFLOW_FINDING_CATALOG_VERSION,
  actionAvailableFinding,
  attachWorkflowFinding,
  boundWorkflowFindings,
  decisionRequiredFinding,
  evaluationWarningFinding,
  findingFromBlocker,
  legacyBlockersFromFindings,
  parseWorkflowFinding,
  parseWorkflowFindingSummary,
  revisionConflictFinding,
  recoveryRequiredFinding,
  type WorkflowFinding,
  type WorkflowFindingSummary,
} from "./findings.js";
import {
  acquireRevisionClaim,
  type RevisionClaimInput,
} from "./revision-claim.js";
import { sameDurabilityProfile } from "./durability.js";
import {
  readWorkflowTransitionJournal,
  recoverWorkflowTransition,
  WorkflowTransitionJournalPendingError,
  WorkflowTransitionRecordConflictError,
  type WorkflowTransitionJournal,
} from "./transition-journal.js";

async function withStructuredRuntimeErrors<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw attachWorkflowFinding(error);
  }
}
import {
  resolveWorkflowRunLocation,
  resolveWorkflowStartLocation,
  type ResolvedWorkflowRunLocation,
} from "./location.js";
import type {
  RecoverWorkflowRunOptions,
  ResumeWorkflowRunOptions,
  StartWorkflowRunOptions,
  WorkflowContinuation,
  WorkflowExecutionIdentity,
  WorkflowHandoff,
  WorkflowRuntime,
  WorkflowRunTarget,
  WorkflowStateProjection,
  WorkflowStateProjectionStatus,
  WorkflowDecisionSubmission,
  Submission,
  WorkflowSubmission,
} from "./types.js";

export type {
  ManualWorkflowRunLocation,
  ResumeWorkflowRunOptions,
  RecoverWorkflowRunOptions,
  StartWorkflowRunOptions,
  StandaloneWorkflowRunLocation,
  WorkflowContinuation,
  WorkflowExecutionIdentity,
  WorkflowHandoff,
  WorkflowRunLocation,
  WorkflowRuntime,
  WorkflowRunTarget,
  WorkflowStateProjection,
  WorkflowStateProjectionStatus,
  WorkflowDecisionSubmission,
  WorkflowMachineSubmission,
  Submission,
  WorkflowSubmission,
} from "./types.js";

export type {
  WorkflowDecisionScope,
  WorkflowDecisionScopeEntry,
  WorkflowDecisionScopeReference,
  WorkflowDecisionScopeSelection,
  WorkflowDecisionScopeSelectionReference,
  WorkflowDecisionScopeSnapshot,
} from "../types.js";

function identityFromState(state: RunState): WorkflowExecutionIdentity {
  if (!state.runtimeIdentity) {
    throw new Error("Run is not a WorkflowRuntime Run");
  }
  return {
    protocolHash: state.runtimeIdentity.protocolHash,
    packageHash: state.runtimeIdentity.packageHash,
    snapshotHash: state.runtimeIdentity.snapshotHash,
    nodeToStep: { ...state.runtimeIdentity.nodeToStep },
    ...(state.runtimeIdentity.capabilityVersion === 3
      ? { capabilityVersion: 3 as const }
      : {}),
    ...(state.runtimeIdentity.resolverHash
      ? { resolverHash: state.runtimeIdentity.resolverHash }
      : {}),
    ...(state.runtimeIdentity.findingCatalogVersion ===
    WORKFLOW_FINDING_CATALOG_VERSION
      ? { findingCatalogVersion: WORKFLOW_FINDING_CATALOG_VERSION }
      : {}),
    ...(state.runtimeIdentity.durabilityProfile
      ? {
          durabilityProfile: structuredClone(
            state.runtimeIdentity.durabilityProfile,
          ),
        }
      : {}),
  };
}

function currentNode(
  state: RunState,
  identity: WorkflowExecutionIdentity,
  action: { stepId: string | null } | null,
): string | null {
  const step = action?.stepId ?? state.currentStep;
  if (!step) return null;
  return (
    Object.entries(identity.nodeToStep).find(
      ([, stepId]) => stepId === step,
    )?.[0] ?? null
  );
}

function sameStringRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const rightEntries = Object.entries(right).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function sameExecutionIdentity(
  left: WorkflowExecutionIdentity,
  right: WorkflowExecutionIdentity,
): boolean {
  return (
    left.protocolHash === right.protocolHash &&
    left.packageHash === right.packageHash &&
    left.snapshotHash === right.snapshotHash &&
    sameStringRecord(left.nodeToStep, right.nodeToStep) &&
    left.capabilityVersion === right.capabilityVersion &&
    left.resolverHash === right.resolverHash &&
    (left.findingCatalogVersion === undefined ||
      right.findingCatalogVersion === undefined ||
      left.findingCatalogVersion === right.findingCatalogVersion) &&
    sameDurabilityProfile(left.durabilityProfile, right.durabilityProfile)
  );
}

function samePhase4ExecutionIdentity(
  left: WorkflowExecutionIdentity,
  right: WorkflowExecutionIdentity,
): boolean {
  return (
    sameExecutionIdentity(left, right) &&
    left.capabilityVersion === 3 &&
    right.capabilityVersion === 3 &&
    left.resolverHash !== undefined &&
    right.resolverHash !== undefined &&
    left.resolverHash === right.resolverHash &&
    left.findingCatalogVersion === WORKFLOW_FINDING_CATALOG_VERSION &&
    right.findingCatalogVersion === WORKFLOW_FINDING_CATALOG_VERSION &&
    left.durabilityProfile !== undefined &&
    right.durabilityProfile !== undefined
  );
}

function durabilityReadOptions(
  state: RunState,
  key: keyof WorkflowDurabilityProfile["bounds"],
): { maxBytes?: number } {
  const maxBytes = state.runtimeIdentity?.durabilityProfile?.bounds[key];
  return maxBytes === undefined ? {} : { maxBytes };
}

function isDecisionSubmission(
  submission: WorkflowSubmission,
): submission is WorkflowDecisionSubmission {
  return submission.kind === "decision";
}

const DECISION_SUBMISSION_KEYS = new Set([
  "kind",
  "actionId",
  "runId",
  "revision",
  "nodeId",
  "cycleId",
  "attemptId",
  "decisionId",
  "choiceId",
  "reviewer",
  "inputs",
  "rationale",
  "evidenceReferences",
  "scope",
  "execution",
  "protocolHash",
  "packageHash",
  "snapshotHash",
]);

function redactVisitEvidence(
  visits: readonly WorkflowVisitState[],
): WorkflowVisitState[] {
  return visits.map((visit) => ({
    ...visit,
    outcomes: visit.outcomes.map((outcome) => {
      const redacted = { ...outcome };
      delete redacted.evidence;
      return redacted;
    }),
  }));
}

const MAX_PROJECTED_LEDGER_ENTRIES = 256;

function boundProjectedLedger<T>(values: readonly T[]): T[] {
  return structuredClone(values.slice(-MAX_PROJECTED_LEDGER_ENTRIES)) as T[];
}

function boundedContinuation(
  value: WorkflowContinuation,
): WorkflowContinuation {
  const parsedFindings = (value.findings ?? []).map(parseWorkflowFinding);
  const parsedSummary = value.findingSummary
    ? parseWorkflowFindingSummary(value.findingSummary)
    : undefined;
  if (
    parsedSummary &&
    (parsedFindings.length > MAX_WORKFLOW_FINDINGS ||
      parsedSummary.returned !== parsedFindings.length ||
      parsedSummary.omitted !== parsedSummary.total - parsedFindings.length)
  ) {
    throw new Error("Workflow finding summary does not match findings");
  }
  if (parsedSummary) {
    const normalizedFindings = boundWorkflowFindings(parsedFindings).findings;
    if (
      JSON.stringify(stableValue(normalizedFindings)) !==
        JSON.stringify(stableValue(parsedFindings)) ||
      new TextEncoder().encode(JSON.stringify(parsedFindings)).byteLength !==
        parsedSummary.encodedBytes
    ) {
      throw new Error("Workflow findings are not canonically ordered");
    }
  }
  const projected = parsedSummary
    ? {
        findings: structuredClone(parsedFindings),
        summary: structuredClone(parsedSummary),
      }
    : boundWorkflowFindings(
        value.blockers.length > 0
          ? value.blockers.map((blocker) => findingFromBlocker(blocker))
          : value.pendingAction
            ? [
                value.pendingAction.type === "ask_user"
                  ? decisionRequiredFinding(value.pendingAction.id)
                  : actionAvailableFinding(
                      value.pendingAction.id,
                      (value.pendingAction.retryOrdinal ?? 0) > 0,
                    ),
              ]
            : [],
      );
  const disposition = value.disposition;
  return {
    ...structuredClone(value),
    decisionReceipts: boundProjectedLedger(value.decisionReceipts),
    cycles: boundProjectedLedger(value.cycles),
    visits: boundProjectedLedger(value.visits),
    artifactVersions: boundProjectedLedger(value.artifactVersions),
    artifactSelections: boundProjectedLedger(value.artifactSelections),
    findings: projected.findings,
    findingSummary: projected.summary,
    requiresUserDecision: projected.findings.some(
      (finding) => finding.requiresUserDecision,
    ),
    blockers: legacyBlockersFromFindings(disposition, projected.findings),
  };
}

function emptyFindingSummary(): WorkflowFindingSummary {
  return boundWorkflowFindings([]).summary;
}

function terminalEvaluationResults(
  trajectory: readonly TrajectoryEvent[],
): EvalResult[] {
  const latest = new Map<string, EvalResult>();
  for (const event of trajectory) {
    if (event.type !== "eval_completed" || !Array.isArray(event.data.results)) {
      continue;
    }
    for (const result of event.data.results) {
      if (!isRecord(result)) continue;
      if (
        typeof result.evalId !== "string" ||
        typeof result.passed !== "boolean" ||
        typeof result.evidence !== "string"
      ) {
        continue;
      }
      latest.set(result.evalId, {
        evalId: result.evalId,
        passed: result.passed,
        evidence: result.evidence,
      });
    }
  }
  return [...latest.values()];
}

function findingsForContinuation(
  disposition: WorkflowContinuation["disposition"],
  reason: string | undefined,
  action: EngineAction | null,
  evals: readonly { evalId: string; passed: boolean; evidence: string }[] = [],
  retry = false,
): { findings: WorkflowFinding[]; summary: WorkflowFindingSummary } {
  const raw = [
    ...(reason && disposition !== "done"
      ? [
          findingFromBlocker(reason, {
            actionId: action?.id,
            nodeId: action?.stepId,
          }),
        ]
      : action
        ? [
            action.type === "ask_user"
              ? decisionRequiredFinding(action.id)
              : actionAvailableFinding(
                  action.id,
                  retry || (action.retryOrdinal ?? 0) > 0,
                ),
          ]
        : []),
    ...(disposition === "done"
      ? evals
          .filter((evaluation) => !evaluation.passed)
          .map((evaluation) =>
            evaluationWarningFinding(evaluation.evalId, evaluation.evidence),
          )
      : []),
  ];
  return boundWorkflowFindings(raw);
}

function validateScalarRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, DecisionScalar> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!key || entry === null) {
      throw new Error(`${label} must contain scalar values`);
    }
    if (
      typeof entry !== "string" &&
      typeof entry !== "number" &&
      typeof entry !== "boolean"
    ) {
      throw new Error(`${label} must contain scalar values`);
    }
    if (typeof entry === "number" && !Number.isFinite(entry)) {
      throw new Error(`${label} must contain finite numbers`);
    }
  }
}

function validateDecisionInputSchema(
  schema: WorkflowDecisionInputSchema,
  inputs: Record<string, DecisionScalar>,
): void {
  const fields = new Map(schema.fields.map((field) => [field.id, field]));
  for (const key of Object.keys(inputs)) {
    if (!fields.has(key)) {
      throw new Error(`Decision input is not declared: ${key}`);
    }
  }
  for (const field of schema.fields) {
    const value = inputs[field.id];
    if (value === undefined) {
      if (field.required) {
        throw new Error(`Missing required decision input: ${field.id}`);
      }
      continue;
    }
    if (
      (field.type === "string" && typeof value !== "string") ||
      (field.type === "number" &&
        (typeof value !== "number" || !Number.isFinite(value))) ||
      (field.type === "boolean" && typeof value !== "boolean")
    ) {
      throw new Error(`Decision input has the wrong type: ${field.id}`);
    }
    const allowed = field.values ?? field.enum;
    if (allowed && !allowed.some((candidate) => candidate === value)) {
      throw new Error(`Decision input has an invalid value: ${field.id}`);
    }
  }
}

function validateReviewer(
  reviewer: unknown,
  policy: WorkflowReviewerPolicy | undefined,
): void {
  if (!reviewer || typeof reviewer !== "object" || Array.isArray(reviewer)) {
    throw new Error("Decision reviewer attestation must be an object");
  }
  const attestation = reviewer as {
    subject?: unknown;
    authorities?: unknown;
  };
  const unknown = Object.keys(reviewer as Record<string, unknown>).find(
    (key) => key !== "subject" && key !== "authorities",
  );
  if (unknown) {
    throw new Error(
      `Decision reviewer attestation has unknown field: ${unknown}`,
    );
  }
  if (typeof attestation.subject !== "string" || !attestation.subject) {
    throw new Error("Decision reviewer subject must be non-empty");
  }
  if (
    !Array.isArray(attestation.authorities) ||
    attestation.authorities.length === 0 ||
    attestation.authorities.some(
      (authority) => typeof authority !== "string" || !authority,
    )
  ) {
    throw new Error("Decision reviewer authorities must be non-empty strings");
  }
  if (
    new Set(attestation.authorities).size !== attestation.authorities.length
  ) {
    throw new Error(
      "Decision reviewer authorities must not contain duplicates",
    );
  }
  const subjects = policy?.subjects ?? [];
  if (subjects.length > 0 && !subjects.includes(attestation.subject)) {
    throw new Error(
      `Decision reviewer subject is not authorized: ${attestation.subject}`,
    );
  }
  const authorities = attestation.authorities as string[];
  for (const required of policy?.authorities ?? []) {
    if (!authorities.includes(required)) {
      throw new Error(`Decision reviewer lacks authority: ${required}`);
    }
  }
}

function validateSubmission(submission: WorkflowSubmission): void {
  if (!submission || typeof submission !== "object") {
    throw new Error("Submission must be an object");
  }
  if (typeof submission.actionId !== "string" || !submission.actionId) {
    throw new Error("Submission actionId must be a non-empty string");
  }
  if (isDecisionSubmission(submission)) {
    const unknown = Object.keys(submission).find(
      (key) => !DECISION_SUBMISSION_KEYS.has(key),
    );
    if (unknown) {
      throw new Error(`Decision submission has unknown field: ${unknown}`);
    }
    if (
      submission.runId !== undefined &&
      (typeof submission.runId !== "string" || !submission.runId)
    ) {
      throw new Error("Decision runId must be a non-empty string");
    }
    if (!Number.isSafeInteger(submission.revision) || submission.revision < 0) {
      throw new Error("Decision revision must be a non-negative integer");
    }
    if (!submission.nodeId) {
      throw new Error("Decision Node id must be a non-empty string");
    }
    if (
      submission.cycleId !== null &&
      (typeof submission.cycleId !== "string" || !submission.cycleId)
    ) {
      throw new Error("Decision cycle id must be a string or null");
    }
    if (!submission.attemptId) {
      throw new Error("Decision Attempt id must be a non-empty string");
    }
    if (!submission.choiceId) {
      throw new Error("Decision choice id must be a non-empty string");
    }
    if (submission.decisionId !== undefined && !submission.decisionId) {
      throw new Error("Decision id must be a non-empty string");
    }
    if (submission.inputs !== undefined) {
      validateScalarRecord(submission.inputs, "Decision inputs");
    }
    if (
      submission.rationale !== undefined &&
      (typeof submission.rationale !== "string" || !submission.rationale)
    ) {
      throw new Error("Decision rationale must be a non-empty string");
    }
    if (submission.evidenceReferences !== undefined) {
      if (
        !Array.isArray(submission.evidenceReferences) ||
        submission.evidenceReferences.some(
          (reference) => typeof reference !== "string" || !reference,
        )
      ) {
        throw new Error("Decision evidence references must be strings");
      }
    }
    return;
  }
  if (
    submission.runId !== undefined &&
    (typeof submission.runId !== "string" || !submission.runId)
  ) {
    throw new Error("Submission runId must be a non-empty string");
  }
  if (
    submission.revision !== undefined &&
    (!Number.isSafeInteger(submission.revision) || submission.revision < 0)
  ) {
    throw new Error("Submission revision must be a non-negative integer");
  }
  if (
    submission.nodeId !== undefined &&
    submission.nodeId !== null &&
    (typeof submission.nodeId !== "string" || !submission.nodeId)
  ) {
    throw new Error("Submission nodeId must be a non-empty string or null");
  }
  if (submission.kind !== undefined && submission.kind !== "machine") {
    throw new Error("Machine submission kind is invalid");
  }
  if (submission.scope !== undefined) {
    throw new Error("Decision scope is only valid for decision submissions");
  }
  if (submission.status !== "succeeded" && submission.status !== "failed") {
    throw new Error("Submission status must be succeeded or failed");
  }
  if (typeof submission.summary !== "string" || !submission.summary) {
    throw new Error("Submission summary must be a non-empty string");
  }
  for (const [label, value] of [
    ["Submission artifacts", submission.artifacts],
    ["Submission state", submission.state],
    ["Submission artifact versions", submission.artifactVersions],
  ] as const) {
    if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} must be an object`);
    }
    if (Object.values(value).some((item) => typeof item !== "string")) {
      throw new Error(`${label} values must be strings`);
    }
  }
  if (submission.evidence !== undefined) {
    if (
      !submission.evidence ||
      typeof submission.evidence !== "object" ||
      Array.isArray(submission.evidence)
    ) {
      throw new Error("Submission evidence must be an object");
    }
    try {
      JSON.stringify(submission.evidence);
    } catch (error) {
      throw new Error("Submission evidence must be JSON-serializable", {
        cause: error,
      });
    }
  }
  if (submission.routing !== undefined) {
    if (
      !submission.routing ||
      typeof submission.routing !== "object" ||
      Array.isArray(submission.routing)
    ) {
      throw new Error("Submission routing must be an object");
    }
    if (
      Object.entries(submission.routing).some(
        ([field, value]) => !field || typeof value !== "string" || !value,
      )
    ) {
      throw new Error("Submission routing must contain non-empty strings");
    }
  }
  if (
    submission.status !== "succeeded" &&
    submission.artifactVersions !== undefined
  ) {
    throw new Error("Failed submissions cannot select artifact versions");
  }
}

function validateDecisionExecution(
  submission: WorkflowDecisionSubmission,
  expected: WorkflowExecutionIdentity,
): void {
  const flatIdentity = {
    protocolHash: submission.protocolHash,
    packageHash: submission.packageHash,
    snapshotHash: submission.snapshotHash,
  };
  const hasFlatIdentity = Object.values(flatIdentity).some(
    (value) => value !== undefined,
  );
  if (hasFlatIdentity) {
    if (
      Object.values(flatIdentity).some(
        (value) => typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value),
      ) ||
      flatIdentity.protocolHash !== expected.protocolHash ||
      flatIdentity.packageHash !== expected.packageHash ||
      flatIdentity.snapshotHash !== expected.snapshotHash
    ) {
      throw new Error(
        "Decision response execution identity does not match Run",
      );
    }
  }
  if (submission.execution !== undefined) {
    if (!sameExecutionIdentity(submission.execution, expected)) {
      throw new Error(
        "Decision response execution identity does not match Run",
      );
    }
    return;
  }
  if (!hasFlatIdentity) {
    throw new Error("Decision response execution identity is required");
  }
}

function continuation(
  result: ManualRunResult,
  identity: WorkflowExecutionIdentity,
): WorkflowContinuation {
  const runtimeState = result.state.workflowRuntime;
  const currentAttempt = runtimeState?.currentAttempt ?? null;
  const disposition = result.action
    ? result.action.type === "ask_user"
      ? "await-user"
      : "continue"
    : result.state.status === "completed"
      ? "done"
      : "blocked";
  const projected = findingsForContinuation(
    disposition,
    result.reason,
    result.action,
    result.evals,
    result.action
      ? (result.action.retryOrdinal ??
          result.state.retries[result.action.attemptId ?? result.action.id] ??
          0) > 0
      : false,
  );
  return {
    disposition,
    runId: result.state.runId,
    revision: runtimeState?.revision ?? 0,
    currentNode: currentNode(result.state, identity, result.action),
    cycleId: runtimeState?.currentCycle?.id ?? currentAttempt?.cycleId ?? null,
    attemptId: currentAttempt?.id ?? null,
    visitOrdinal: currentAttempt?.visitOrdinal ?? null,
    retryOrdinal: currentAttempt?.retryOrdinal ?? null,
    pendingAction: result.action,
    execution: structuredClone(identity),
    decisionReceipts: boundProjectedLedger(
      runtimeState?.decisionReceipts ?? [],
    ),
    cycles: boundProjectedLedger(runtimeState?.cycles ?? []),
    visits:
      result.action?.type === "ask_user"
        ? boundProjectedLedger(redactVisitEvidence(runtimeState?.visits ?? []))
        : boundProjectedLedger(runtimeState?.visits ?? []),
    artifactVersions: boundProjectedLedger(
      runtimeState?.artifactVersions ?? [],
    ),
    artifactSelections: boundProjectedLedger(
      runtimeState?.artifactSelections ?? [],
    ),
    currentArtifactVersions: currentWorkflowArtifactVersions(runtimeState),
    findings: projected.findings,
    findingSummary: projected.summary,
    requiresUserDecision: projected.findings.some(
      (finding) => finding.requiresUserDecision,
    ),
    blockers: legacyBlockersFromFindings(disposition, projected.findings),
  };
}

const LEGACY_STATE_MAX_BYTES = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function projectionStatus(
  state: RunState,
  pending: EngineAction | null,
  maxRetriesPerAction: number,
): Exclude<WorkflowStateProjectionStatus, "not-started"> {
  const retriesExhausted = Object.values(state.retries).some(
    (count) => count > maxRetriesPerAction,
  );
  return state.status === "failed" || (!pending && retriesExhausted)
    ? "blocked"
    : state.status;
}

export async function projectWorkflowState(
  target: WorkflowRunTarget,
): Promise<WorkflowStateProjection | null> {
  const location = resolveWorkflowRunLocation(target);
  const state = await location.readState();
  if (!state) return null;

  const verified = await verifyStoredRun(location);
  const nodeByStep = new Map(
    Object.entries(verified.identity.nodeToStep).map(([nodeId, stepId]) => [
      stepId,
      nodeId,
    ]),
  );
  const completedNodes: string[] = [];
  const evidence: Record<string, Record<string, unknown>> = {};
  const history: WorkflowStateProjection["history"] = [];
  const trajectory = await readTrajectory(
    location.runRoot,
    state.trajectoryRef,
    durabilityReadOptions(state, "trajectoryBytes"),
  );

  for (const event of trajectory) {
    if (event.type !== "action_completed") continue;
    if (!isRecord(event.data.action) || !isRecord(event.data.outcome)) continue;
    const stepId = event.data.action.stepId;
    const node =
      typeof stepId === "string" ? nodeByStep.get(stepId) : undefined;
    const outcomeStatus = event.data.outcome.status;
    if (
      !node ||
      (outcomeStatus !== "succeeded" && outcomeStatus !== "failed")
    ) {
      continue;
    }
    history.push({
      event: "outcome-recorded",
      node,
      status: outcomeStatus,
      at: event.timestamp,
    });
    if (outcomeStatus !== "succeeded") continue;
    if (!completedNodes.includes(node)) completedNodes.push(node);
    const outcomeEvidence = event.data.outcome.evidence;
    evidence[node] = isRecord(outcomeEvidence)
      ? structuredClone(outcomeEvidence)
      : {};
  }

  const protocol = verified.package.runtime!.protocol;
  const runtimeState = state.workflowRuntime;
  const currentAttempt = runtimeState?.currentAttempt ?? null;
  const status = projectionStatus(
    state,
    verified.pending,
    verified.package.guardrails.maxRetriesPerAction,
  );
  const exhaustedAction = Object.entries(state.retries).find(
    ([, count]) => count > verified.package.guardrails.maxRetriesPerAction,
  )?.[0];
  const projectedFindings =
    status === "blocked"
      ? boundWorkflowFindings([
          findingFromBlocker(
            exhaustedAction
              ? `Retry budget exhausted for action: ${exhaustedAction}`
              : `Run is ${state.status}`,
            { actionId: exhaustedAction },
          ),
        ])
      : verified.pending
        ? findingsForContinuation(
            verified.pending.type === "ask_user" ? "await-user" : "continue",
            undefined,
            verified.pending,
            [],
            (verified.pending.retryOrdinal ??
              state.retries[
                verified.pending.attemptId ?? verified.pending.id
              ] ??
              0) > 0,
          )
        : findingsForContinuation(
            status === "completed" ? "done" : "blocked",
            status === "running" ? "Run has no pending action" : undefined,
            null,
            status === "completed" ? terminalEvaluationResults(trajectory) : [],
          );
  return {
    schemaVersion: 1,
    workflow: protocol.name,
    statePath: protocol.state.statePath,
    status,
    runId: state.runId,
    revision: runtimeState?.revision ?? 0,
    currentNode: currentNode(state, verified.identity, verified.pending),
    cycleId: runtimeState?.currentCycle?.id ?? currentAttempt?.cycleId ?? null,
    attemptId: currentAttempt?.id ?? null,
    visitOrdinal: currentAttempt?.visitOrdinal ?? null,
    retryOrdinal: currentAttempt?.retryOrdinal ?? null,
    completedNodes,
    evidence: verified.pending?.type === "ask_user" ? {} : evidence,
    history,
    pendingAction: verified.pending,
    execution: structuredClone(verified.identity),
    decisionReceipts: boundProjectedLedger(
      runtimeState?.decisionReceipts ?? [],
    ),
    visits:
      verified.pending?.type === "ask_user"
        ? boundProjectedLedger(redactVisitEvidence(runtimeState?.visits ?? []))
        : boundProjectedLedger(runtimeState?.visits ?? []),
    cycles: boundProjectedLedger(runtimeState?.cycles ?? []),
    artifactVersions: boundProjectedLedger(
      runtimeState?.artifactVersions ?? [],
    ),
    artifactSelections: boundProjectedLedger(
      runtimeState?.artifactSelections ?? [],
    ),
    currentArtifactVersions: currentWorkflowArtifactVersions(runtimeState),
    findings: projectedFindings.findings,
    findingSummary: projectedFindings.summary,
    requiresUserDecision: projectedFindings.findings.some(
      (finding) => finding.requiresUserDecision,
    ),
    blockers: legacyBlockersFromFindings(
      status === "completed"
        ? "done"
        : verified.pending?.type === "ask_user"
          ? "await-user"
          : verified.pending
            ? "continue"
            : "blocked",
      projectedFindings.findings,
    ),
  };
}

export async function writeWorkflowStateProjection(
  target: WorkflowRunTarget,
  projection: WorkflowStateProjection,
): Promise<void> {
  const projectRoot = resolveWorkflowRunLocation(target).runRoot;
  const label = "Workflow state projection";
  const relativePath = normalizeWorkflowRelativePath(
    projection.statePath,
    `${label} path`,
  );
  const content = JSON.stringify(projection, null, 2) + "\n";
  if (Buffer.byteLength(content, "utf8") > LEGACY_STATE_MAX_BYTES) {
    throw new Error(`${label} exceeds ${LEGACY_STATE_MAX_BYTES} bytes`);
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let inspection = await inspectProtectedProjectPath(
      projectRoot,
      relativePath,
      { label, expected: "file" },
    );
    if (inspection.exists) {
      try {
        const existing = await readProtectedProjectFile(
          projectRoot,
          relativePath,
          LEGACY_STATE_MAX_BYTES,
          { label },
        );
        if (Buffer.from(existing.bytes).equals(Buffer.from(content))) return;
      } catch (error) {
        if (
          !(error instanceof RaceSafeReadError) ||
          error.reason !== "changed" ||
          attempt === 2
        ) {
          throw error;
        }
        continue;
      }
    }

    const parent = path.posix.dirname(relativePath);
    if (parent !== ".") {
      await ensureProtectedProjectDirectory(projectRoot, parent, { label });
      inspection = await inspectProtectedProjectPath(
        projectRoot,
        relativePath,
        {
          label,
          expected: "file",
        },
      );
    }
    await atomicWriteContainedText(inspection.target, content, {
      containedRoot: inspection.projectRoot,
    });
    return;
  }
}

async function verifyStoredPackage(
  runRoot: string,
  state: RunState,
): Promise<{
  identity: WorkflowExecutionIdentity;
  package: Awaited<ReturnType<typeof readSkillSnapshot>>;
}> {
  const identity = identityFromState(state);
  if (identity.snapshotHash !== state.skillHash) {
    throw new Error(
      "WorkflowRuntime snapshot identity does not match Run state",
    );
  }
  const pkg = await readSkillSnapshot(runRoot, state.skillHash);
  if (!pkg.runtime) {
    throw new Error("WorkflowRuntime Skill snapshot has no compiled protocol");
  }
  if (pkg.runtime.protocolHash !== identity.protocolHash) {
    throw new Error(
      "WorkflowRuntime protocol identity does not match Skill snapshot",
    );
  }
  if (!sameStringRecord(pkg.runtime.nodeToStep, identity.nodeToStep)) {
    throw new Error(
      "WorkflowRuntime Node-to-step identity does not match Skill snapshot",
    );
  }
  if (pkg.runtime.capabilityVersion !== identity.capabilityVersion) {
    throw new Error(
      "WorkflowRuntime capability identity does not match Skill snapshot",
    );
  }
  if (pkg.runtime.resolverHash !== identity.resolverHash) {
    throw new Error(
      "WorkflowRuntime resolver identity does not match Skill snapshot",
    );
  }
  if (
    identity.findingCatalogVersion !== undefined &&
    pkg.runtime.findingCatalogVersion !== identity.findingCatalogVersion
  ) {
    throw new Error(
      "WorkflowRuntime finding catalog identity does not match Skill snapshot",
    );
  }
  if (
    identity.durabilityProfile !== undefined &&
    (identity.capabilityVersion !== 3 ||
      identity.resolverHash === undefined ||
      identity.findingCatalogVersion !== WORKFLOW_FINDING_CATALOG_VERSION ||
      pkg.runtime.capabilityVersion !== 3 ||
      pkg.runtime.resolverHash === undefined ||
      pkg.runtime.findingCatalogVersion !== WORKFLOW_FINDING_CATALOG_VERSION)
  ) {
    throw new Error(
      "WorkflowRuntime durability profile requires complete execution identity",
    );
  }
  if (
    !sameDurabilityProfile(
      identity.durabilityProfile,
      pkg.runtime.durabilityProfile,
    ) ||
    !sameDurabilityProfile(
      identity.durabilityProfile,
      pkg.runtime.protocol.capabilities?.durability,
    )
  ) {
    throw new Error(
      "WorkflowRuntime durability profile identity does not match Skill snapshot",
    );
  }
  const packageHash = await hashSkillPackage(pkg);
  if (packageHash !== identity.packageHash) {
    throw new Error(
      "WorkflowRuntime package identity does not match Skill snapshot",
    );
  }
  if (pkg.runtime.capabilityVersion === 3 && !state.workflowRuntime) {
    throw new Error(
      "WorkflowRuntime revisioned state is missing from Run state",
    );
  }
  if (
    pkg.runtime.capabilityVersion === 3 &&
    state.workflowRuntime?.currentAttempt &&
    state.workflowRuntime.currentAttempt.stepId !== state.currentStep
  ) {
    throw new Error("WorkflowRuntime current Attempt does not match Run step");
  }
  if (pkg.runtime.capabilityVersion !== 3 && state.workflowRuntime) {
    throw new Error(
      "WorkflowRuntime revisioned state is not valid for a legacy Run",
    );
  }
  if (pkg.runtime.capabilityVersion === 3 && state.workflowRuntime) {
    validateWorkflowCycleState(
      pkg.runtime.protocol,
      state.runId,
      state.workflowRuntime,
    );
    const cycleById = new Map(
      state.workflowRuntime.cycles.map((cycle) => [cycle.id, cycle]),
    );
    for (const visit of state.workflowRuntime.visits) {
      const nodeId = Object.entries(identity.nodeToStep).find(
        ([, stepId]) => stepId === visit.stepId,
      )?.[0];
      if (!nodeId) {
        throw new Error("WorkflowRuntime visit has an unknown Node identity");
      }
      if (visit.cycleId !== null) {
        const cycle = cycleById.get(visit.cycleId);
        const plan = pkg.runtime.protocol.cycles?.find(
          (candidate) => candidate.key === cycle?.key,
        );
        if (!cycle || !plan) {
          throw new Error(
            "WorkflowRuntime visit has an unknown Cycle identity",
          );
        }
        if (!workflowCycleOwnsNode(pkg.runtime.protocol, cycle.key, nodeId)) {
          throw new Error("WorkflowRuntime visit has an invalid Cycle Node");
        }
      }
    }
    if (state.currentStep !== null) {
      const currentNodeId = Object.entries(identity.nodeToStep).find(
        ([, stepId]) => stepId === state.currentStep,
      )?.[0];
      if (!currentNodeId) {
        throw new Error("WorkflowRuntime current Node identity is invalid");
      }
      const inCycle = state.workflowRuntime.cycles.some((cycle) =>
        workflowCycleOwnsNode(pkg.runtime!.protocol, cycle.key, currentNodeId),
      );
      if (inCycle !== Boolean(state.workflowRuntime.currentCycle)) {
        throw new Error("WorkflowRuntime current Cycle position is invalid");
      }
      if (
        state.workflowRuntime.currentCycle &&
        !workflowCycleOwnsNode(
          pkg.runtime.protocol,
          state.workflowRuntime.currentCycle.key,
          currentNodeId,
        )
      ) {
        throw new Error("WorkflowRuntime current Cycle position is invalid");
      }
    } else if (state.workflowRuntime.currentCycle) {
      throw new Error("WorkflowRuntime current Cycle position is invalid");
    }
    validateWorkflowArtifactState(
      pkg.runtime.protocol,
      state.runId,
      identity.nodeToStep,
      state.workflowRuntime,
    );
  }
  for (const receipt of state.workflowRuntime?.decisionReceipts ?? []) {
    if (
      receipt.runId !== state.runId ||
      receipt.protocolHash !== identity.protocolHash ||
      receipt.packageHash !== identity.packageHash ||
      receipt.snapshotHash !== identity.snapshotHash ||
      receipt.resultingRevision !== receipt.revision + 1 ||
      receipt.resultingRevision > (state.workflowRuntime?.revision ?? 0)
    ) {
      throw new Error("WorkflowRuntime Decision Receipt identity is invalid");
    }
    const visit = state.workflowRuntime?.visits.find(
      (candidate) => candidate.attemptId === receipt.attemptId,
    );
    const nodeId = visit
      ? Object.entries(identity.nodeToStep).find(
          ([, stepId]) => stepId === visit.stepId,
        )?.[0]
      : undefined;
    const outcome = visit?.outcomes.find(
      (candidate) => candidate.actionId === receipt.actionId,
    );
    const node = nodeId
      ? pkg.runtime.protocol.nodes.find((candidate) => candidate.id === nodeId)
      : undefined;
    const choice = node?.decision?.choices.find(
      (candidate) => candidate.id === receipt.choiceId,
    );
    if (
      !visit ||
      !nodeId ||
      receipt.nodeId !== nodeId ||
      !outcome ||
      outcome.status !== "succeeded" ||
      !node?.decision ||
      receipt.decisionId !== node.decision.id ||
      !choice
    ) {
      throw new Error("WorkflowRuntime Decision Receipt context is invalid");
    }
    if (receipt.cycleId !== visit.cycleId) {
      throw new Error("WorkflowRuntime Decision Receipt Cycle is invalid");
    }
    validateReviewer(receipt.reviewer, node.decision.reviewer);
    validateDecisionInputSchema(
      choice.inputs ?? node.decision.inputs ?? { type: "object", fields: [] },
      receipt.inputs,
    );
    if (node.decision.rationale?.required && !receipt.rationale) {
      throw new Error("WorkflowRuntime Decision Receipt rationale is invalid");
    }
    if (receipt.scope) {
      validateWorkflowDecisionScopeDefinitionForNode(
        pkg,
        receipt.nodeId,
        receipt.scope,
      );
      await validateWorkflowDecisionScopeSnapshot(
        runRoot,
        pkg,
        state,
        receipt.scope,
        { requireCurrentScope: false, verifyArtifactContent: false },
      );
    }
  }
  return { identity, package: pkg };
}

async function verifyStoredRun(location: ResolvedWorkflowRunLocation): Promise<{
  state: RunState;
  identity: WorkflowExecutionIdentity;
  package: Awaited<ReturnType<typeof readSkillSnapshot>>;
  pending: EngineAction | null;
}> {
  const state = await location.readState();
  if (!state) throw new Error(`No Comet Run found in: ${location.runRoot}`);
  const verified = await verifyStoredPackage(location.runRoot, state);
  const pending = await verifyStoredAction(
    location.runRoot,
    state,
    verified.identity,
    verified.package,
  );
  return { state, ...verified, pending };
}

type VerifiedWorkflowRun = Awaited<ReturnType<typeof verifyStoredRun>>;

class WorkflowRevisionConflictError extends Error {
  constructor(
    readonly verified: VerifiedWorkflowRun,
    readonly finding: WorkflowFinding,
  ) {
    super(finding.message);
    this.name = "WorkflowRevisionConflictError";
  }
}

function phase4SubmissionConflict(
  verified: VerifiedWorkflowRun,
  submission: WorkflowSubmission,
): WorkflowFinding | undefined {
  if (verified.identity.durabilityProfile === undefined) return undefined;
  const runtimeState = verified.state.workflowRuntime;
  if (!runtimeState) {
    throw new Error("Phase 4 WorkflowRuntime state is missing");
  }
  if (!submission.runId) {
    throw new Error("Phase 4 submission runId is required");
  }
  if (submission.revision === undefined) {
    throw new Error("Phase 4 submission revision is required");
  }
  if (!submission.execution) {
    throw new Error("Phase 4 submission execution identity is required");
  }
  let identityMatches = samePhase4ExecutionIdentity(
    submission.execution,
    verified.identity,
  );
  if (isDecisionSubmission(submission)) {
    const flatIdentity = [
      submission.protocolHash,
      submission.packageHash,
      submission.snapshotHash,
    ];
    if (flatIdentity.some((value) => value !== undefined)) {
      identityMatches =
        identityMatches &&
        submission.protocolHash === verified.identity.protocolHash &&
        submission.packageHash === verified.identity.packageHash &&
        submission.snapshotHash === verified.identity.snapshotHash;
    }
  }
  const currentActionId =
    verified.pending?.id ?? verified.state.pending ?? null;
  if (
    submission.runId !== verified.state.runId ||
    submission.revision !== runtimeState.revision ||
    submission.actionId !== currentActionId ||
    !identityMatches
  ) {
    return revisionConflictFinding(runtimeState.revision, currentActionId);
  }
  return undefined;
}

function throwOnPhase4SubmissionConflict(
  verified: VerifiedWorkflowRun,
  submission: WorkflowSubmission,
): void {
  const finding = phase4SubmissionConflict(verified, submission);
  if (finding) throw new WorkflowRevisionConflictError(verified, finding);
}

async function assertRevisionFence(
  location: ResolvedWorkflowRunLocation,
  input: RevisionClaimInput,
  checkPendingAction = true,
): Promise<void> {
  const state = await location.readState();
  if (!state) {
    throw new Error("WorkflowRuntime Run disappeared during submission");
  }
  const currentRevision = state.workflowRuntime?.revision ?? 0;
  const currentActionId = state.pending;
  const pending = checkPendingAction
    ? await readPendingAction(
        location.runRoot,
        state.pendingRef,
        durabilityReadOptions(state, "pendingActionBytes"),
      )
    : null;
  if (
    state.runId !== input.runId ||
    currentRevision !== input.expectedRevision ||
    currentActionId !== input.expectedActionId ||
    (checkPendingAction &&
      (!pending || pending.id !== input.expectedActionId)) ||
    !state.runtimeIdentity ||
    !samePhase4ExecutionIdentity(identityFromState(state), input.execution)
  ) {
    const current = await verifyStoredRun(location);
    throw new WorkflowRevisionConflictError(
      current,
      revisionConflictFinding(currentRevision, currentActionId),
    );
  }
}

async function continuationFromVerifiedRun(
  verified: VerifiedWorkflowRun,
  runRoot: string,
): Promise<WorkflowContinuation> {
  const trajectory = await readTrajectory(
    runRoot,
    verified.state.trajectoryRef,
    durabilityReadOptions(verified.state, "trajectoryBytes"),
  );
  return continuation(
    {
      state: verified.state,
      action: verified.pending,
      evals:
        verified.state.status === "completed"
          ? terminalEvaluationResults(trajectory)
          : [],
      ...(verified.pending
        ? {}
        : {
            reason:
              verified.state.status === "running"
                ? "Run has no pending action"
                : verified.state.status === "failed"
                  ? `Run is ${verified.state.status}`
                  : undefined,
          }),
    },
    verified.identity,
  );
}

export async function inspectWorkflowRun(
  target: WorkflowRunTarget,
): Promise<WorkflowContinuation | null> {
  return withStructuredRuntimeErrors(async () => {
    const location = resolveWorkflowRunLocation(target);
    const journal = await readWorkflowTransitionJournal(location.runRoot);
    if (journal) return recoveryRequiredContinuation(location, journal);
    try {
      if (!(await location.readState())) return null;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw error;
    }
    return continuationFromVerifiedRun(
      await verifyStoredRun(location),
      location.runRoot,
    );
  });
}

interface PreparedWorkflowSubmission {
  location: ResolvedWorkflowRunLocation;
  verified: VerifiedWorkflowRun;
  pending: EngineAction;
  node: string | null;
}

async function prepareWorkflowSubmission(
  target: WorkflowRunTarget,
  submission: WorkflowSubmission,
): Promise<PreparedWorkflowSubmission> {
  const location = resolveWorkflowRunLocation(target);
  const verified = await verifyStoredRun(location);
  throwOnPhase4SubmissionConflict(verified, submission);
  const pending = verified.pending;
  if (
    !pending ||
    !verified.state.pending ||
    verified.state.status !== "waiting"
  ) {
    throw new Error(`Run is ${verified.state.status}`);
  }
  if (submission.actionId !== pending.id) {
    throw new Error(
      `Outcome does not match pending action: ${submission.actionId}`,
    );
  }
  const node = currentNode(verified.state, verified.identity, pending);
  if (pending.type === "ask_user" && !isDecisionSubmission(submission)) {
    throw new Error("Decision response required for pending ask_user action");
  }
  if (pending.type !== "ask_user" && isDecisionSubmission(submission)) {
    throw new Error(`Decision response cannot satisfy ${pending.type} action`);
  }
  if (submission.nodeId !== undefined && submission.nodeId !== node) {
    throw new Error(
      `Submission Node does not match pending Node: ${submission.nodeId}`,
    );
  }
  if (isDecisionSubmission(submission)) {
    validateDecisionResponse(verified, pending, node, submission);
  }
  return { location, verified, pending, node };
}

function validateDecisionResponse(
  verified: VerifiedWorkflowRun,
  pending: EngineAction,
  node: string | null,
  submission: WorkflowDecisionSubmission,
): void {
  if (pending.type !== "ask_user") {
    throw new Error(`Decision response cannot satisfy ${pending.type} action`);
  }
  const runtimeState = verified.state.workflowRuntime;
  if (!runtimeState) {
    throw new Error(
      "Decision response requires revisioned WorkflowRuntime state",
    );
  }
  if (submission.revision !== runtimeState.revision) {
    throw new Error(
      `Decision response revision does not match Run revision: ${submission.revision}`,
    );
  }
  if (submission.nodeId !== node) {
    throw new Error(
      `Decision Node does not match pending Node: ${submission.nodeId}`,
    );
  }
  if (submission.attemptId !== pending.attemptId) {
    throw new Error(
      `Decision Attempt does not match pending Attempt: ${submission.attemptId}`,
    );
  }
  if (submission.cycleId !== (pending.cycleId ?? null)) {
    throw new Error(
      `Decision Cycle does not match pending Cycle: ${submission.cycleId}`,
    );
  }
  validateDecisionExecution(submission, verified.identity);
  const workflowNode = verified.package.runtime!.protocol.nodes.find(
    (candidate) => candidate.id === node,
  );
  if (!workflowNode?.decision) {
    throw new Error(
      `WorkflowRuntime decision Node is missing: ${node ?? "(none)"}`,
    );
  }
  if (
    submission.decisionId &&
    submission.decisionId !== workflowNode.decision.id
  ) {
    throw new Error(
      `Decision id does not match pending decision: ${submission.decisionId}`,
    );
  }
  const choice = workflowNode.decision.choices.find(
    (candidate) => candidate.id === submission.choiceId,
  );
  if (!choice) {
    throw new Error(`Decision choice is not declared: ${submission.choiceId}`);
  }
  if (pending.decisionId !== workflowNode.decision.id) {
    throw new Error("WorkflowRuntime pending decision identity is invalid");
  }
  if (!pending.choices?.some((candidate) => candidate.id === choice.id)) {
    throw new Error(
      `Decision choice is not accepted by pending action: ${choice.id}`,
    );
  }
  validateWorkflowDecisionScopeResponse(
    pending.scope,
    submission.scope,
    submission.evidenceReferences,
  );
  validateReviewer(submission.reviewer, workflowNode.decision.reviewer);
  const inputs = submission.inputs ?? {};
  validateDecisionInputSchema(
    choice.inputs ??
      workflowNode.decision.inputs ?? { type: "object", fields: [] },
    inputs,
  );
  if (pending.rationale?.required && !submission.rationale) {
    throw new Error("Decision rationale is required");
  }
}

function engineOutcome(
  prepared: PreparedWorkflowSubmission,
  submission: WorkflowSubmission,
  artifactMutation?: WorkflowArtifactMutation,
): import("../engine/types.js").ActionOutcome {
  if (!isDecisionSubmission(submission)) {
    const artifacts = artifactMutation
      ? artifactMutation.artifactPaths
      : submission.artifacts;
    return {
      actionId: prepared.pending.id,
      status: submission.status,
      summary: submission.summary,
      ...(artifacts && Object.keys(artifacts).length > 0 ? { artifacts } : {}),
      ...(submission.state ? { state: submission.state } : {}),
      ...(submission.evidence ? { evidence: submission.evidence } : {}),
      ...(submission.routing ? { routing: submission.routing } : {}),
      ...(artifactMutation &&
      Object.keys(artifactMutation.selectedVersionIds).length > 0
        ? { artifactVersions: artifactMutation.selectedVersionIds }
        : submission.artifactVersions
          ? { artifactVersions: submission.artifactVersions }
          : {}),
    };
  }
  const node = prepared.verified.package.runtime!.protocol.nodes.find(
    (candidate) => candidate.id === prepared.node,
  )!;
  const decision = node.decision!;
  const choice = decision.choices.find(
    (candidate) => candidate.id === submission.choiceId,
  )!;
  return {
    actionId: prepared.pending.id,
    status: "succeeded",
    summary: `Decision ${decision.id}: ${choice.id}`,
    kind: "decision",
    revision: submission.revision,
    nodeId: submission.nodeId,
    cycleId: submission.cycleId,
    attemptId: submission.attemptId,
    decisionId: decision.id,
    choiceId: choice.id,
    reviewer: structuredClone(submission.reviewer),
    inputs: structuredClone(submission.inputs ?? {}),
    ...(submission.rationale !== undefined
      ? { rationale: submission.rationale }
      : {}),
    ...(submission.evidenceReferences
      ? { evidenceReferences: [...submission.evidenceReferences] }
      : {}),
    ...(prepared.pending.scope
      ? { scope: structuredClone(prepared.pending.scope) }
      : {}),
    routing: {
      [decision.id]: choice.id,
      ...(choice.routing ?? {}),
    },
  };
}

async function completionBlockers(
  prepared: PreparedWorkflowSubmission,
  submission: WorkflowSubmission,
): Promise<string[]> {
  if (isDecisionSubmission(submission)) return [];
  if (submission.status !== "succeeded" || !prepared.node) return [];
  const workflowNode = prepared.verified.package.runtime!.protocol.nodes.find(
    (candidate) => candidate.id === prepared.node,
  );
  if (!workflowNode) {
    throw new Error(`WorkflowRuntime Node is missing: ${prepared.node}`);
  }
  const plan =
    prepared.verified.package.runtime!.completionPlans?.[prepared.node] ??
    createCompletionPlan(workflowNode);
  if (
    JSON.stringify(stableValue(plan)) !==
    JSON.stringify(stableValue(createCompletionPlan(workflowNode)))
  ) {
    throw new Error(
      `WorkflowRuntime completion plan does not match Node: ${prepared.node}`,
    );
  }
  return validateSuccessfulSubmission(
    prepared.location.runRoot,
    prepared.verified.package.runtime!.protocol,
    workflowNode,
    plan,
    submission,
  );
}

function routeBlockers(
  prepared: PreparedWorkflowSubmission,
  submission: WorkflowSubmission,
): string[] {
  const protocol = prepared.verified.package.runtime!.protocol;
  if (
    (!isDecisionSubmission(submission) && submission.status !== "succeeded") ||
    !prepared.node ||
    !isRevisionedWorkflowProtocol(protocol)
  ) {
    return [];
  }
  try {
    resolveWorkflowTransition(
      protocol,
      prepared.node,
      engineOutcome(prepared, submission),
      prepared.verified.state.workflowRuntime,
      prepared.verified.state.runId,
    );
    return [];
  } catch (error) {
    if (error instanceof WorkflowRouteResolutionError) {
      return error.blockers;
    }
    throw error;
  }
}

async function artifactMutationForSubmission(
  prepared: PreparedWorkflowSubmission,
  submission: WorkflowSubmission,
): Promise<{
  mutation?: WorkflowArtifactMutation;
  blockers: string[];
}> {
  if (isDecisionSubmission(submission) || !prepared.node) {
    return { blockers: [] };
  }
  const versioned =
    prepared.verified.package.runtime!.protocol.capabilities?.features.includes(
      "versioned-artifacts",
    ) === true;
  if (!versioned) {
    return Object.keys(submission.artifactVersions ?? {}).length > 0
      ? {
          blockers: [
            "Workflow artifact selections require versioned-artifacts capability",
          ],
        }
      : { blockers: [] };
  }
  if (submission.status !== "succeeded") {
    return Object.keys(submission.artifacts ?? {}).length > 0
      ? {
          blockers: ["Failed submissions cannot update versioned artifacts"],
        }
      : { blockers: [] };
  }
  try {
    return {
      mutation: await prepareWorkflowArtifactMutation({
        runRoot: prepared.location.runRoot,
        protocol: prepared.verified.package.runtime!.protocol,
        state: prepared.verified.state,
        nodeId: prepared.node,
        actionId: prepared.pending.id,
        ...(submission.artifacts ? { artifacts: submission.artifacts } : {}),
        ...(submission.artifactVersions
          ? { artifactVersions: submission.artifactVersions }
          : {}),
      }),
      blockers: [],
    };
  } catch (error) {
    if (error instanceof WorkflowArtifactValidationError) {
      return { blockers: [...error.blockers] };
    }
    throw error;
  }
}

function blockedContinuation(
  prepared: PreparedWorkflowSubmission,
  blockers: readonly string[],
): WorkflowContinuation {
  const projected = boundWorkflowFindings(
    blockers.map((blocker) =>
      findingFromBlocker(blocker, {
        actionId: prepared.pending.id,
        nodeId: prepared.node,
      }),
    ),
  );
  return {
    disposition: "blocked",
    runId: prepared.verified.state.runId,
    revision: prepared.verified.state.workflowRuntime?.revision ?? 0,
    currentNode: prepared.node,
    cycleId:
      prepared.verified.state.workflowRuntime?.currentCycle?.id ??
      prepared.verified.state.workflowRuntime?.currentAttempt?.cycleId ??
      null,
    attemptId:
      prepared.verified.state.workflowRuntime?.currentAttempt?.id ?? null,
    visitOrdinal:
      prepared.verified.state.workflowRuntime?.currentAttempt?.visitOrdinal ??
      null,
    retryOrdinal:
      prepared.verified.state.workflowRuntime?.currentAttempt?.retryOrdinal ??
      null,
    pendingAction: prepared.pending,
    execution: structuredClone(prepared.verified.identity),
    decisionReceipts: structuredClone(
      prepared.verified.state.workflowRuntime?.decisionReceipts ?? [],
    ),
    cycles: structuredClone(
      prepared.verified.state.workflowRuntime?.cycles ?? [],
    ),
    visits: structuredClone(
      prepared.verified.state.workflowRuntime?.visits ?? [],
    ),
    artifactVersions: structuredClone(
      prepared.verified.state.workflowRuntime?.artifactVersions ?? [],
    ),
    artifactSelections: structuredClone(
      prepared.verified.state.workflowRuntime?.artifactSelections ?? [],
    ),
    currentArtifactVersions: currentWorkflowArtifactVersions(
      prepared.verified.state.workflowRuntime,
    ),
    findings: projected.findings,
    findingSummary: projected.summary,
    requiresUserDecision: projected.findings.some(
      (finding) => finding.requiresUserDecision,
    ),
    blockers: legacyBlockersFromFindings("blocked", projected.findings),
  };
}

function conflictContinuation(
  verified: VerifiedWorkflowRun,
  finding: WorkflowFinding,
): WorkflowContinuation {
  const base = continuation(
    {
      state: verified.state,
      action: verified.pending,
      evals: [],
    },
    verified.identity,
  );
  const projected = boundWorkflowFindings([finding]);
  return {
    ...base,
    disposition: "blocked",
    findings: projected.findings,
    findingSummary: projected.summary,
    requiresUserDecision: projected.findings.some(
      (candidate) => candidate.requiresUserDecision,
    ),
    blockers: legacyBlockersFromFindings("blocked", projected.findings),
  };
}

function journalIntendedState(journal: WorkflowTransitionJournal): RunState {
  const record = journal.records.find(
    (candidate) => candidate.kind === "state",
  );
  if (!record || record.intended.content === null) {
    throw new Error("Workflow transition journal has no intended Run state");
  }
  return parseRunStateValue(JSON.parse(record.intended.content) as unknown);
}

async function recoveryRequiredContinuation(
  location: ResolvedWorkflowRunLocation,
  journal: WorkflowTransitionJournal,
): Promise<WorkflowContinuation> {
  const stateRecord = journal.records.find(
    (candidate) => candidate.kind === "state",
  );
  if (!stateRecord) {
    throw new Error("Workflow transition journal has no state record");
  }
  const declaredStates = [
    stateRecord.previous.content === null
      ? undefined
      : {
          label: "previous" as const,
          state: parseRunStateValue(
            JSON.parse(stateRecord.previous.content) as unknown,
          ),
        },
    stateRecord.intended.content === null
      ? undefined
      : {
          label: "intended" as const,
          state: parseRunStateValue(
            JSON.parse(stateRecord.intended.content) as unknown,
          ),
        },
  ].filter((candidate): candidate is NonNullable<typeof candidate> =>
    Boolean(candidate),
  );
  let current: RunState | null = null;
  try {
    current = await location.readState();
  } catch {
    current = null;
  }
  const selected =
    declaredStates.find(
      (candidate) =>
        current !== null &&
        JSON.stringify(stableValue(candidate.state)) ===
          JSON.stringify(stableValue(current)),
    ) ??
    declaredStates.find((candidate) => candidate.label === "previous") ??
    declaredStates.find((candidate) => candidate.label === "intended");
  if (!selected) {
    throw new Error("Workflow transition journal has no usable Run state");
  }
  const state = selected.state;
  let action: EngineAction | null = null;
  if (state.pending) {
    const record = journal.records.find(
      (candidate) =>
        candidate.path === state.pendingRef &&
        candidate[selected.label].content !== null,
    );
    const content = record?.[selected.label].content;
    if (content !== undefined && content !== null) {
      action = parsePendingActionValue(JSON.parse(content) as unknown);
    }
  }
  const base = continuation({ state, action, evals: [] }, journal.execution);
  const projected = boundWorkflowFindings([
    recoveryRequiredFinding(
      state.workflowRuntime?.revision ?? journal.previous.revision,
      state.pending,
    ),
  ]);
  return {
    ...base,
    disposition: "blocked",
    findings: projected.findings,
    findingSummary: projected.summary,
    requiresUserDecision: projected.findings.some(
      (finding) => finding.requiresUserDecision,
    ),
    blockers: legacyBlockersFromFindings("blocked", projected.findings),
  };
}

export async function validateWorkflowSubmission(
  target: WorkflowRunTarget,
  submission: WorkflowSubmission,
): Promise<WorkflowContinuation> {
  return withStructuredRuntimeErrors(async () => {
    const location = resolveWorkflowRunLocation(target);
    const journal = await readWorkflowTransitionJournal(location.runRoot);
    if (journal) return recoveryRequiredContinuation(location, journal);
    validateSubmission(submission);
    let prepared: PreparedWorkflowSubmission;
    try {
      prepared = await prepareWorkflowSubmission(target, submission);
    } catch (error) {
      if (error instanceof WorkflowRevisionConflictError) {
        return conflictContinuation(error.verified, error.finding);
      }
      throw error;
    }
    const blockers = await completionBlockers(prepared, submission);
    if (blockers.length > 0) {
      return blockedContinuation(prepared, blockers);
    }
    const routeFindings = routeBlockers(prepared, submission);
    if (routeFindings.length > 0) {
      return blockedContinuation(prepared, routeFindings);
    }
    const artifact = await artifactMutationForSubmission(prepared, submission);
    if (artifact.blockers.length > 0) {
      return blockedContinuation(prepared, artifact.blockers);
    }
    return continuationFromVerifiedRun(
      prepared.verified,
      prepared.location.runRoot,
    );
  });
}

export async function verifyWorkflowProtocol(
  protocol: WorkflowProtocol,
): Promise<WorkflowExecutionIdentity> {
  const compiled = await compileWorkflow(protocol);
  return {
    ...compiled.identity,
    snapshotHash: compiled.identity.packageHash,
  };
}

export async function projectWorkflowHandoff(
  protocol: WorkflowProtocol,
  current: WorkflowContinuation | null,
): Promise<WorkflowHandoff> {
  const execution = await verifyWorkflowProtocol(protocol);
  const projectedCurrent = current ? boundedContinuation(current) : null;
  if (
    projectedCurrent &&
    !sameExecutionIdentity(projectedCurrent.execution, execution)
  ) {
    throw new Error(
      "WorkflowRuntime handoff identity does not match generated protocol",
    );
  }
  return {
    schemaVersion: 1,
    workflow: {
      name: protocol.name,
      goal: protocol.goal,
      protocolHash: execution.protocolHash,
    },
    execution,
    nodes: structuredClone(protocol.nodes),
    outputSchemas: structuredClone(protocol.outputSchemas),
    decisionReceipts: boundProjectedLedger(
      projectedCurrent?.decisionReceipts ?? [],
    ),
    cycles: boundProjectedLedger(projectedCurrent?.cycles ?? []),
    visits:
      projectedCurrent?.disposition === "await-user"
        ? boundProjectedLedger(redactVisitEvidence(projectedCurrent.visits))
        : boundProjectedLedger(projectedCurrent?.visits ?? []),
    artifactVersions: boundProjectedLedger(
      projectedCurrent?.artifactVersions ?? [],
    ),
    artifactSelections: boundProjectedLedger(
      projectedCurrent?.artifactSelections ?? [],
    ),
    currentArtifactVersions: structuredClone(
      projectedCurrent?.currentArtifactVersions ?? {},
    ),
    findings: structuredClone(projectedCurrent?.findings ?? []),
    findingSummary: structuredClone(
      projectedCurrent?.findingSummary ?? emptyFindingSummary(),
    ),
    requiresUserDecision: projectedCurrent?.requiresUserDecision ?? false,
    continuation: projectedCurrent,
  };
}

async function resumeStoredRun(
  location: ResolvedWorkflowRunLocation,
  options: ResumeWorkflowRunOptions,
): Promise<WorkflowContinuation> {
  const verified = await verifyStoredRun(location);
  const result = await location.resume({
    confirmations: options.confirmations ?? [],
    resolver: resolverForPackage(),
    prepareAction: prepareWorkflowAction,
  });
  if (result.state.status !== "completed") {
    return continuation(result, verified.identity);
  }
  const trajectory = await readTrajectory(
    location.runRoot,
    result.state.trajectoryRef,
    durabilityReadOptions(result.state, "trajectoryBytes"),
  );
  return continuation(
    { ...result, evals: terminalEvaluationResults(trajectory) },
    verified.identity,
  );
}

async function prepareWorkflowAction(
  runRoot: string,
  pkg: Awaited<ReturnType<typeof readSkillSnapshot>>,
  state: RunState,
  action: EngineAction,
): Promise<{ action: EngineAction | null; reason?: string }> {
  try {
    return {
      action: await captureWorkflowDecisionScope(runRoot, pkg, state, action),
    };
  } catch (error) {
    if (error instanceof WorkflowDecisionScopeError) {
      return { action: null, reason: error.message };
    }
    throw error;
  }
}

async function verifyStoredAction(
  runRoot: string,
  state: RunState,
  identity: WorkflowExecutionIdentity,
  pkg: Awaited<ReturnType<typeof readSkillSnapshot>>,
): Promise<EngineAction | null> {
  const action = await readPendingAction(
    runRoot,
    state.pendingRef,
    durabilityReadOptions(state, "pendingActionBytes"),
  );
  if (state.status === "waiting") {
    if (!state.pending || !action || action.id !== state.pending) {
      throw new Error(
        "WorkflowRuntime pending action does not match Run state",
      );
    }
    if (action.type === "invoke_skill" || action.type === "ask_user") {
      if (
        !action.stepId ||
        !Object.values(identity.nodeToStep).includes(action.stepId)
      ) {
        throw new Error(
          "WorkflowRuntime pending action has an unknown workflow step",
        );
      }
      if (state.currentStep !== action.stepId) {
        throw new Error(
          "WorkflowRuntime current Node does not match pending action",
        );
      }
    } else if (action.type !== "checkpoint") {
      throw new Error(
        "WorkflowRuntime pending action is not a compiled action",
      );
    } else if (state.currentStep !== action.stepId) {
      throw new Error(
        "WorkflowRuntime current Node does not match pending action",
      );
    }
    const step = pkg.definition.orchestration.steps?.find(
      (candidate) => candidate.id === action.stepId,
    );
    if (
      !step ||
      step.action.type !== action.type ||
      step.action.ref !== action.ref ||
      step.action.prompt !== action.prompt ||
      step.action.question !== action.question ||
      JSON.stringify(stableValue(step.action.options)) !==
        JSON.stringify(stableValue(action.options)) ||
      step.action.decisionId !== action.decisionId ||
      JSON.stringify(stableValue(step.action.choices)) !==
        JSON.stringify(stableValue(action.choices)) ||
      JSON.stringify(stableValue(step.action.requiredInputs)) !==
        JSON.stringify(stableValue(action.requiredInputs)) ||
      JSON.stringify(stableValue(step.action.rationale)) !==
        JSON.stringify(stableValue(action.rationale)) ||
      JSON.stringify(stableValue(step.action.reviewer)) !==
        JSON.stringify(stableValue(action.reviewer))
    ) {
      throw new Error(
        "WorkflowRuntime pending action does not match compiled step",
      );
    }
    if (pkg.runtime?.capabilityVersion === 3) {
      const attempt = state.workflowRuntime?.currentAttempt;
      if (
        !attempt ||
        action.attemptId !== attempt.id ||
        action.cycleId !== attempt.cycleId ||
        action.visitOrdinal !== attempt.visitOrdinal ||
        action.retryOrdinal !== attempt.retryOrdinal
      ) {
        throw new Error(
          "WorkflowRuntime pending action does not match current Attempt",
        );
      }
    }
    if (action.type === "ask_user") {
      const nodeId = Object.entries(identity.nodeToStep).find(
        ([, stepId]) => stepId === action.stepId,
      )?.[0];
      const node = pkg.runtime?.protocol.nodes.find(
        (candidate) => candidate.id === nodeId,
      );
      if (node?.decision?.scope) {
        await validateWorkflowDecisionScope(runRoot, pkg, state, action);
        const trajectory = await readTrajectory(
          runRoot,
          state.trajectoryRef,
          durabilityReadOptions(state, "trajectoryBytes"),
        );
        const proposal = trajectory
          .slice()
          .reverse()
          .find(
            (event) =>
              event.type === "action_proposed" &&
              isRecord(event.data.action) &&
              event.data.action.id === action.id,
          );
        if (!proposal || !isRecord(proposal.data.action)) {
          throw new Error(
            "WorkflowRuntime scoped decision has no durable action proposal",
          );
        }
        if (
          JSON.stringify(stableValue(proposal.data.action)) !==
          JSON.stringify(stableValue(action))
        ) {
          throw new Error(
            "WorkflowRuntime scoped decision does not match its durable action proposal",
          );
        }
      } else {
        await validateWorkflowDecisionScope(runRoot, pkg, state, action);
      }
    }
    return action;
  }
  if (action || state.pending) {
    throw new Error("WorkflowRuntime non-waiting Run has a pending action");
  }
  if (state.status === "completed" && state.currentStep !== null) {
    throw new Error("WorkflowRuntime completed Run has a current step");
  }
  if (
    state.status === "running" &&
    (state.currentStep === null ||
      !Object.values(identity.nodeToStep).includes(state.currentStep))
  ) {
    throw new Error(
      "WorkflowRuntime current Node is not in the compiled route",
    );
  }
  return null;
}

export function createWorkflowRuntime(): WorkflowRuntime {
  return {
    async start(
      options: StartWorkflowRunOptions,
    ): Promise<WorkflowContinuation> {
      return withStructuredRuntimeErrors(async () => {
        const resolved = resolveWorkflowStartLocation(options);
        const compiled = await compileWorkflow(options.protocol);
        const revisioned = compiled.package.runtime?.capabilityVersion === 3;
        const result = await resolved.location.start(compiled.package, {
          runId: resolved.runId,
          confirmations: options.confirmations ?? [],
          resolver: resolverForPackage(),
          runtimeIdentity: {
            ...compiled.identity,
            snapshotHash: compiled.identity.packageHash,
          },
          ...(revisioned
            ? {
                workflowRuntime: {
                  revision: 0,
                  nextVisitOrdinal: 0,
                  currentAttempt: null,
                  currentCycle: null,
                  cycles: [],
                  visits: [],
                  decisionReceipts: [],
                  artifactVersions: [],
                  artifactSelections: [],
                },
              }
            : {}),
          prepareAction: prepareWorkflowAction,
        });
        if (result.state.skillHash !== compiled.identity.packageHash) {
          throw new Error(
            "WorkflowRuntime snapshot identity was not persisted",
          );
        }
        return continuation(result, {
          ...compiled.identity,
          snapshotHash: result.state.skillHash,
        });
      });
    },

    async resume(
      target: WorkflowRunTarget,
      options: ResumeWorkflowRunOptions = {},
    ): Promise<WorkflowContinuation> {
      return withStructuredRuntimeErrors(async () => {
        const location = resolveWorkflowRunLocation(target);
        const journal = await readWorkflowTransitionJournal(location.runRoot);
        if (journal) return recoveryRequiredContinuation(location, journal);
        return resumeStoredRun(location, options);
      });
    },

    async submit(
      target: WorkflowRunTarget,
      submission: WorkflowSubmission,
    ): Promise<WorkflowContinuation> {
      return withStructuredRuntimeErrors(async () => {
        const location = resolveWorkflowRunLocation(target);
        const journal = await readWorkflowTransitionJournal(location.runRoot);
        if (journal) return recoveryRequiredContinuation(location, journal);
        validateSubmission(submission);
        let prepared: PreparedWorkflowSubmission;
        try {
          prepared = await prepareWorkflowSubmission(target, submission);
        } catch (error) {
          if (error instanceof WorkflowRevisionConflictError) {
            return conflictContinuation(error.verified, error.finding);
          }
          throw error;
        }
        const blockers = await completionBlockers(prepared, submission);
        if (blockers.length > 0) {
          return blockedContinuation(prepared, blockers);
        }
        const routeFindings = routeBlockers(prepared, submission);
        if (routeFindings.length > 0) {
          return blockedContinuation(prepared, routeFindings);
        }
        const artifact = await artifactMutationForSubmission(
          prepared,
          submission,
        );
        if (artifact.blockers.length > 0) {
          return blockedContinuation(prepared, artifact.blockers);
        }
        const outcome = engineOutcome(prepared, submission, artifact.mutation);
        if (prepared.verified.identity.durabilityProfile === undefined) {
          const result = await prepared.location.resume(
            {
              resolver: resolverForPackage(),
              outcome,
              prepareAction: prepareWorkflowAction,
            },
            artifact.mutation,
          );
          return continuation(result, prepared.verified.identity);
        }

        const claimInput: RevisionClaimInput = {
          runId: submission.runId!,
          expectedRevision: submission.revision!,
          expectedActionId: submission.actionId,
          intendedRevision: submission.revision! + 1,
          execution: structuredClone(submission.execution!),
        };
        const claim = await acquireRevisionClaim(
          prepared.location.runRoot,
          claimInput,
        );
        if (!claim.acquired) {
          const current = await verifyStoredRun(prepared.location);
          return conflictContinuation(
            current,
            revisionConflictFinding(
              current.state.workflowRuntime?.revision ?? 0,
              current.pending?.id ?? current.state.pending ?? null,
            ),
          );
        }
        try {
          await assertRevisionFence(prepared.location, claimInput);
          const result = await prepared.location.resume(
            {
              resolver: resolverForPackage(),
              outcome,
              prepareAction: prepareWorkflowAction,
              revisionFence: () =>
                assertRevisionFence(prepared.location, claimInput),
              revisionStateFence: () =>
                assertRevisionFence(prepared.location, claimInput, false),
            },
            artifact.mutation,
          );
          await claim.commit();
          return continuation(result, prepared.verified.identity);
        } catch (error) {
          if (error instanceof WorkflowRevisionConflictError) {
            return conflictContinuation(error.verified, error.finding);
          }
          if (
            error instanceof WorkflowTransitionJournalPendingError ||
            error instanceof WorkflowTransitionRecordConflictError
          ) {
            const journal = await readWorkflowTransitionJournal(
              prepared.location.runRoot,
            );
            if (journal) {
              return recoveryRequiredContinuation(prepared.location, journal);
            }
            const current = await verifyStoredRun(prepared.location);
            return conflictContinuation(
              current,
              revisionConflictFinding(
                current.state.workflowRuntime?.revision ?? 0,
                current.pending?.id ?? current.state.pending ?? null,
              ),
            );
          }
          throw error;
        }
      });
    },

    async recover(
      target: WorkflowRunTarget,
      options: RecoverWorkflowRunOptions = {},
    ): Promise<WorkflowContinuation> {
      return withStructuredRuntimeErrors(async () => {
        const location = resolveWorkflowRunLocation(target);
        const journal = await readWorkflowTransitionJournal(location.runRoot);
        if (journal) {
          if (!journal.execution.durabilityProfile) {
            throw new Error(
              "Workflow transition journal has no durability profile",
            );
          }
          const recovery = await recoverWorkflowTransition(
            location.runRoot,
            journal.execution.durabilityProfile,
          );
          if (recovery.status === "blocked") {
            return recoveryRequiredContinuation(
              location,
              recovery.journal ?? journal,
            );
          }
        }
        return resumeStoredRun(location, options);
      });
    },
  };
}

const defaultRuntime = createWorkflowRuntime();

export const startWorkflowRun = defaultRuntime.start;
export const resumeWorkflowRun = defaultRuntime.resume;
export const submitWorkflowRun = defaultRuntime.submit;
export const recoverWorkflowRun = defaultRuntime.recover;
