import { promises as fs } from "node:fs";
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
import {
  type ManualRunResult,
  type FinalizationRecovery,
  type FinalizationRefresh,
  type PrepareFinalizationOutcome,
  type PreparePendingAction,
  type PrepareOutcomeMutation,
} from "../engine/manual-run.js";
import {
  parsePendingActionValue,
  readPendingAction,
  readTrajectory,
} from "../engine/run-store.js";
import {
  readOptionalEngineRunText,
  type EngineRunMutationOverlay,
} from "../engine/protected-run-file.js";
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
  WorkflowArtifactProducer,
  WorkflowArtifactReceipt,
  WorkflowDecisionScopeReference,
  WorkflowDecisionScopeSnapshot,
  WorkflowDecisionInputSchema,
  WorkflowDurabilityProfile,
  NodeProtocol,
  WorkflowProtocol,
  WorkflowReviewerPolicy,
  WorkflowReviewerAttestation,
  WorkflowVerificationKind,
  WorkflowVerificationReceipt,
  WorkflowVerificationReceiptProposal,
  WorkflowVerificationReceiptReference,
  WorkflowRepairPendingDecision,
  WorkflowFinalizationPreview,
  WorkflowFinalizationConfirmationRecord,
  WorkflowFinalizationPendingConfirmation,
  WorkflowFinalizationState,
  WorkflowFinalizationSubmission,
  WorkflowFinalizationDefinition,
} from "../types.js";
import { sha256, stableValue } from "../util.js";
import { compileWorkflow } from "./compiler.js";
import {
  bindWorkflowExternalRoots,
  workflowStartRequirements,
  workflowReceiptOutputs,
} from "./artifact-receipts.js";
import {
  createCompletionPlan,
  validateSuccessfulSubmission,
  type WorkflowCompletionValidation,
} from "./completion.js";
import {
  currentWorkflowArtifactVersions,
  prepareWorkflowArtifactMutation,
  validateWorkflowArtifactVersion,
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
  checkpointHistoryAmbiguousFinding,
  checkpointInvalidFinding,
  decisionRequiredFinding,
  evaluationWarningFinding,
  findingFromBlocker,
  legacyBlockersFromFindings,
  parseWorkflowFinding,
  parseWorkflowFindingSummary,
  revisionConflictFinding,
  recoveryRequiredFinding,
  repairIterationLimitFinding,
  repairOverrideExhaustedFinding,
  repairStagnationStopFinding,
  repairStagnationWarningFinding,
  snapshotIncompleteFinding,
  type WorkflowFinding,
  type WorkflowFindingSummary,
} from "./findings.js";
import {
  acquireRevisionClaim,
  type RevisionClaimInput,
} from "./revision-claim.js";
import {
  sameDurabilityProfile,
  normalizeWorkflowDurabilityProtocol,
} from "./durability.js";
import {
  readWorkflowTransitionJournal,
  recoverWorkflowTransition,
  WorkflowTransitionJournalPendingError,
  WorkflowTransitionRecordConflictError,
  type WorkflowTransitionJournal,
} from "./transition-journal.js";
import {
  acquireWorkflowRunLock,
  recordWorkflowRunLockTakeover,
  WorkflowRunLockBlockedError,
  type WorkflowRunLockHandle,
  type WorkflowRunLockOperation,
} from "./run-lock.js";
import {
  createWorkflowCheckpoint,
  inspectWorkflowCheckpointCandidates,
  WORKFLOW_CHECKPOINT_INDEX_PATH,
  readWorkflowCheckpointIndex,
  readWorkflowCheckpointProfile,
  readWorkflowCheckpointRecoveryJournal,
  recoverWorkflowCheckpoint,
  restoreWorkflowCheckpoint,
  verifyWorkflowCheckpointCandidate,
  verifyWorkflowCheckpointHead,
  type WorkflowCheckpointInspection,
  type WorkflowCheckpointRecoveryJournal,
  type WorkflowCheckpointVerification,
} from "./checkpoints.js";
import {
  captureWorkflowContentSnapshot,
  hashWorkflowContentSnapshot,
  stageWorkflowContentSnapshot,
  readWorkflowContentSnapshot,
  workflowContentSnapshotFindings,
} from "./snapshots.js";
import {
  createWorkflowVerificationReceipt,
  normalizeWorkflowVerificationProposal,
  readWorkflowVerificationReceipt,
  stageWorkflowVerificationReceipt,
  validateWorkflowVerificationRequirement,
  workflowVerificationReceiptReference,
  workflowVerificationKinds,
} from "./verification-receipts.js";
import {
  buildWorkflowRepairSignature,
  decideWorkflowRepair,
  hashWorkflowRepairText,
  isWorkflowRepairAction,
  normalizeWorkflowRepairPolicy,
  normalizeWorkflowRepairText,
  parseWorkflowRepairAutomaticOperation,
  workflowRepairAction,
  type WorkflowRepairFailureFacts,
} from "./repair.js";
import {
  applyWorkflowFinalization,
  buildWorkflowFinalizationPreview,
  clearWorkflowFinalizationTransaction,
  parseWorkflowFinalizationState,
  readWorkflowFinalizationReceipt,
  readWorkflowFinalizationTransaction,
  recoverWorkflowFinalization,
  rollbackWorkflowFinalization,
  workflowFinalizationReceiptReference,
  WorkflowFinalizationConflictError,
  WorkflowFinalizationTransactionPendingError,
  normalizeWorkflowFinalizationDefinition,
} from "./finalization.js";

async function withStructuredRuntimeErrors<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw attachWorkflowFinding(error);
  }
}

function usesWorkflowRunLock(
  profile: WorkflowDurabilityProfile | undefined,
): boolean {
  return profile?.capabilities.includes("mutation-locks") ?? false;
}

function usesWorkflowCheckpoints(
  profile: WorkflowDurabilityProfile | undefined,
): boolean {
  return profile?.capabilities.includes("verified-checkpoints") ?? false;
}

function usesWorkflowContentSnapshots(
  profile: WorkflowDurabilityProfile | undefined,
): boolean {
  return profile?.capabilities.includes("content-snapshots") ?? false;
}

function usesWorkflowFinalization(
  profile: WorkflowDurabilityProfile | undefined,
): boolean {
  return profile?.capabilities.includes("transactional-finalization") ?? false;
}

async function durabilityProfileForLocation(
  location: ResolvedWorkflowRunLocation,
  options: { allowMalformedState?: boolean } = {},
): Promise<WorkflowDurabilityProfile | undefined> {
  try {
    const state = await location.readState(options);
    if (state) {
      if (state.runtimeIdentity?.durabilityProfile) {
        return state.runtimeIdentity.durabilityProfile;
      }
      const journal = await readWorkflowTransitionJournal(location.runRoot);
      return journal?.execution.durabilityProfile;
    }
  } catch (error) {
    const checkpointProfile = await readWorkflowCheckpointProfile(
      location.runRoot,
    );
    if (checkpointProfile) return checkpointProfile;
    throw error;
  }
  const journal = await readWorkflowTransitionJournal(location.runRoot);
  if (journal?.execution.durabilityProfile) {
    return journal.execution.durabilityProfile;
  }
  return readWorkflowCheckpointProfile(location.runRoot);
}

async function withWorkflowRunLock<T>(
  location: ResolvedWorkflowRunLocation,
  operation: WorkflowRunLockOperation,
  profile: WorkflowDurabilityProfile | undefined,
  work: (lock?: WorkflowRunLockHandle) => Promise<T>,
  options: {
    allowStale?: boolean;
    onBlocked?: (error: WorkflowRunLockBlockedError) => Promise<T>;
  } = {},
): Promise<T> {
  if (!usesWorkflowRunLock(profile)) return work();
  let lock: WorkflowRunLockHandle;
  try {
    lock = await acquireWorkflowRunLock(location.runRoot, operation, {
      maxBytes: profile?.bounds.runLockBytes,
      allowStale: options.allowStale,
    });
  } catch (error) {
    if (error instanceof WorkflowRunLockBlockedError && options.onBlocked) {
      return options.onBlocked(error);
    }
    throw error;
  }
  try {
    return await work(lock);
  } finally {
    await lock.release();
  }
}

async function lockBlockedContinuation(
  location: ResolvedWorkflowRunLocation,
  error: WorkflowRunLockBlockedError,
): Promise<WorkflowContinuation> {
  try {
    const verified = await verifyStoredRun(location);
    const base = await continuationFromVerifiedRun(verified, location.runRoot);
    const projected = boundWorkflowFindings([error.finding]);
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
  } catch {
    throw error;
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
  WorkflowMachineSubmission,
  StartWorkflowRunOptions,
  WorkflowContinuation,
  WorkflowExecutionIdentity,
  WorkflowHandoff,
  WorkflowRuntime,
  WorkflowRunRegistryEntry,
  WorkflowRunTarget,
  WorkflowRunReport,
  WorkflowStateProjection,
  WorkflowStateProjectionStatus,
  WorkflowDecisionSubmission,
  WorkflowGateAnswer,
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
  WorkflowRunRegistry,
  WorkflowRunRegistryEntry,
  WorkflowRunTarget,
  WorkflowStateProjection,
  WorkflowStateProjectionStatus,
  WorkflowDecisionSubmission,
  WorkflowMachineSubmission,
  WorkflowReceiptOutput,
  WorkflowReceiptRequirement,
  WorkflowStartRequirements,
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

function sameStableValue(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))
  );
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

function isWorkflowFinalizationAction(
  action: EngineAction | null,
): action is EngineAction & {
  finalization: WorkflowFinalizationPendingConfirmation;
} {
  return Boolean(action?.type === "ask_user" && action.finalization);
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
  "verification",
  "verificationReceipts",
  "verificationReceiptIds",
  "receiptIds",
  "repair",
  "finalization",
]);

const VERIFICATION_SUBMISSION_KEYS = new Set([
  "proposals",
  "receiptIds",
  "receipts",
]);

interface ResolvedWorkflowVerificationRequirement {
  id: string;
  role: string;
  kinds: WorkflowVerificationKind[];
  scope: {
    artifacts: Array<{ id: string; required: boolean }>;
    evidence: Array<{ id: string; required: boolean }>;
  };
  requireContentSnapshot: boolean;
}

interface NormalizedVerificationSubmission {
  proposals: unknown[];
  receiptIds: string[];
}

function verificationRequirements(
  node: NodeProtocol | undefined,
): ResolvedWorkflowVerificationRequirement[] {
  if (!node) return [];
  const result: ResolvedWorkflowVerificationRequirement[] = [];
  const ids = new Set<string>();
  for (const guardrail of node.guardrails) {
    if (!guardrail.verification) continue;
    validateWorkflowVerificationRequirement(
      guardrail.verification,
      `Workflow verification requirement for ${node.id}.${guardrail.id}`,
    );
    const requirement = guardrail.verification;
    const id = requirement.id ?? guardrail.id;
    if (ids.has(id)) {
      throw new Error(`Workflow verification requirement is duplicated: ${id}`);
    }
    ids.add(id);
    result.push({
      id,
      role: requirement.role,
      kinds: workflowVerificationKinds(requirement),
      scope: {
        artifacts: (requirement.scope?.artifacts ?? []).map((entry) => ({
          id: entry.id,
          required: entry.required === true,
        })),
        evidence: (requirement.scope?.evidence ?? []).map((entry) => ({
          id: entry.id,
          required: entry.required === true,
        })),
      },
      requireContentSnapshot: requirement.requireContentSnapshot === true,
    });
  }
  return result;
}

function normalizedVerificationSubmission(
  submission: WorkflowSubmission,
): NormalizedVerificationSubmission {
  const proposals: unknown[] = [];
  const receiptIds: string[] = [];
  const addReceiptEntry = (entry: unknown, label: string): void => {
    if (typeof entry === "string" && entry.length > 0) {
      receiptIds.push(entry);
      return;
    }
    if (
      isRecord(entry) &&
      typeof entry.receiptId === "string" &&
      entry.receiptId.length > 0
    ) {
      receiptIds.push(entry.receiptId);
      return;
    }
    if (
      isRecord(entry) &&
      typeof entry.receiptHash === "string" &&
      entry.receiptHash.length > 0
    ) {
      receiptIds.push(entry.receiptHash);
      return;
    }
    throw new Error(verificationFailure(`${label} must contain receipt ids`));
  };
  const addValue = (value: unknown, label: string): void => {
    if (value === undefined) return;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (
          typeof entry === "string" ||
          (isRecord(entry) &&
            (typeof entry.receiptId === "string" ||
              typeof entry.receiptHash === "string") &&
            (entry.kind === undefined ||
              entry.kind === "workflow-verification-receipt-reference"))
        ) {
          addReceiptEntry(entry, label);
        } else proposals.push(entry);
      }
      return;
    }
    if (isRecord(value)) {
      const keys = Object.keys(value);
      if (
        value.kind === undefined &&
        (typeof value.receiptId === "string" ||
          typeof value.receiptHash === "string")
      ) {
        addReceiptEntry(value, label);
        return;
      }
      if (keys.some((key) => VERIFICATION_SUBMISSION_KEYS.has(key))) {
        const unknown = keys.find(
          (key) => !VERIFICATION_SUBMISSION_KEYS.has(key),
        );
        if (unknown) {
          throw new Error(
            verificationFailure(`${label} has unknown field: ${unknown}`),
          );
        }
        if (value.proposals !== undefined) {
          if (!Array.isArray(value.proposals)) {
            throw new Error(
              verificationFailure(`${label}.proposals must be an array`),
            );
          }
          proposals.push(...value.proposals);
        }
        for (const key of ["receiptIds", "receipts"] as const) {
          const wrapperIds = value[key];
          if (wrapperIds === undefined) continue;
          if (!Array.isArray(wrapperIds)) {
            throw new Error(
              verificationFailure(`${label}.${key} must be an array`),
            );
          }
          for (const entry of wrapperIds) {
            if (
              typeof entry === "string" ||
              (isRecord(entry) &&
                (typeof entry.receiptId === "string" ||
                  typeof entry.receiptHash === "string") &&
                (entry.kind === undefined ||
                  entry.kind === "workflow-verification-receipt-reference"))
            ) {
              addReceiptEntry(entry, `${label}.${key}`);
            } else {
              proposals.push(entry);
            }
          }
        }
        return;
      }
      proposals.push(value);
      return;
    }
    throw new Error(
      verificationFailure(`${label} must be a proposal, wrapper, or array`),
    );
  };
  addValue(submission.verification, "Verification submission");
  addValue(submission.verificationReceipts, "verificationReceipts");
  if (submission.verificationReceiptIds !== undefined) {
    if (!Array.isArray(submission.verificationReceiptIds)) {
      throw new Error(
        verificationFailure("verificationReceiptIds must be an array"),
      );
    }
    for (const entry of submission.verificationReceiptIds) {
      if (typeof entry !== "string" || entry.length === 0) {
        throw new Error(
          verificationFailure(
            "verificationReceiptIds must contain non-empty strings",
          ),
        );
      }
      receiptIds.push(entry);
    }
  }
  if (submission.receiptIds !== undefined) {
    if (!Array.isArray(submission.receiptIds)) {
      throw new Error(verificationFailure("receiptIds must be an array"));
    }
    for (const entry of submission.receiptIds) {
      if (typeof entry !== "string" || entry.length === 0) {
        throw new Error(
          verificationFailure("receiptIds must contain non-empty strings"),
        );
      }
      receiptIds.push(entry);
    }
  }
  if (receiptIds.length > 64 || proposals.length > 64) {
    throw new Error(verificationFailure("submission exceeds its bound"));
  }
  if (new Set(receiptIds).size !== receiptIds.length) {
    throw new Error(
      verificationFailure("submission contains duplicate receipt ids"),
    );
  }
  return { proposals, receiptIds };
}

/** Machine adapters share the runtime's accepted verification representations.
 * Manual evidence remains reserved for an authenticated person's adapter. */
export function validateWorkflowMachineVerification(
  submission: WorkflowMachineSubmission,
): void {
  const { proposals } = normalizedVerificationSubmission(submission);
  if (
    proposals.some(
      (proposal) => isRecord(proposal) && proposal.kind === "manual-evidence",
    )
  )
    throw new Error(
      "A signed-in person supplies human verification evidence in Badger",
    );
}

function verificationFailure(message: string): string {
  return `Workflow Verification Receipt ${message}`;
}

function workflowContentSnapshotBinding(state: RunState): string | null {
  const snapshots = state.workflowRuntime?.contentSnapshots ?? [];
  if (snapshots.length === 0) return null;
  const ordered = [...snapshots]
    .map((snapshot) => ({
      hash: snapshot.hash,
      path: snapshot.path,
      provider: snapshot.provider,
      complete: snapshot.complete,
    }))
    .sort((left, right) => left.hash.localeCompare(right.hash));
  if (ordered.length === 1) return ordered[0].hash;
  return sha256(JSON.stringify(stableValue(ordered)));
}

async function currentWorkflowContentSnapshotBinding(
  prepared: PreparedWorkflowSubmission,
  state: RunState,
): Promise<string | null> {
  const profile = prepared.verified.identity.durabilityProfile;
  const policy = profile?.snapshotPolicy;
  if (!usesWorkflowContentSnapshots(profile) || !policy) {
    return workflowContentSnapshotBinding(state);
  }
  const references = state.workflowRuntime?.contentSnapshots ?? [];
  if (references.length !== 1) {
    throw new Error(
      verificationFailure(
        "content snapshot binding is unavailable or ambiguous",
      ),
    );
  }
  let current;
  try {
    current = await captureWorkflowContentSnapshot({
      root: prepared.location.contentSnapshotRoot,
      policy,
    });
  } catch (error) {
    throw new Error(
      verificationFailure(
        `content snapshot could not be recaptured: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  const currentHash = hashWorkflowContentSnapshot(current);
  if (currentHash !== references[0].hash) {
    throw new Error(
      verificationFailure(`content snapshot is stale: ${references[0].hash}`),
    );
  }
  if (!current.complete) {
    throw new Error(verificationFailure("content snapshot is incomplete"));
  }
  return currentHash;
}

function workflowArtifactDeclaration(
  protocol: WorkflowProtocol,
  requested: string,
): { id: string; schemaId: string } {
  const declarations = protocol.outputSchemas.flatMap((schema) =>
    schema.artifacts.map((artifact) => ({
      id: `${schema.id}.${artifact.id}`,
      shortId: artifact.id,
      schemaId: schema.id,
    })),
  );
  const exact = declarations.find(
    (declaration) => declaration.id === requested,
  );
  if (exact) return exact;
  const matches = declarations.filter(
    (declaration) => declaration.shortId === requested,
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      verificationFailure(
        `artifact scope requires a schema-qualified id: ${requested}`,
      ),
    );
  }
  throw new Error(
    verificationFailure(`artifact scope is not declared: ${requested}`),
  );
}

function workflowEvidenceDeclaration(
  protocol: WorkflowProtocol,
  requested: string,
): { id: string; schemaId: string; shortId: string } {
  const declarations = protocol.outputSchemas.flatMap((schema) =>
    schema.evidence.map((evidence) => ({
      id: `${schema.id}.${evidence.id}`,
      shortId: evidence.id,
      schemaId: schema.id,
    })),
  );
  const exact = declarations.find(
    (declaration) => declaration.id === requested,
  );
  if (exact) return exact;
  const matches = declarations.filter(
    (declaration) => declaration.shortId === requested,
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      verificationFailure(
        `evidence scope requires a schema-qualified id: ${requested}`,
      ),
    );
  }
  throw new Error(
    verificationFailure(`evidence scope is not declared: ${requested}`),
  );
}

function workflowEvidenceValue(
  evidence: Record<string, unknown> | undefined,
  declaration: { id: string; schemaId: string; shortId: string },
): { found: boolean; value?: unknown } {
  if (!evidence) return { found: false };
  for (const key of [declaration.id, declaration.shortId]) {
    if (Object.prototype.hasOwnProperty.call(evidence, key)) {
      return { found: true, value: evidence[key] };
    }
  }
  const schemaEvidence = evidence.schemaEvidence;
  if (!isRecord(schemaEvidence)) return { found: false };
  if (Object.prototype.hasOwnProperty.call(schemaEvidence, declaration.id)) {
    return { found: true, value: schemaEvidence[declaration.id] };
  }
  const scoped = schemaEvidence[declaration.schemaId];
  if (
    isRecord(scoped) &&
    Object.prototype.hasOwnProperty.call(scoped, declaration.shortId)
  ) {
    return { found: true, value: scoped[declaration.shortId] };
  }
  return { found: false };
}

function workflowOutcomeRevision(
  state: RunState,
  attemptId: string,
  actionId: string,
): number {
  let revision = 0;
  for (const visit of state.workflowRuntime?.visits ?? []) {
    for (const outcome of visit.outcomes) {
      if (visit.attemptId === attemptId && outcome.actionId === actionId) {
        return revision;
      }
      revision += 1;
    }
  }
  throw new Error(
    verificationFailure(`evidence producer is not accepted: ${actionId}`),
  );
}

function workflowEvidenceReference(
  state: RunState,
  declaration: { id: string; schemaId: string; shortId: string },
  visit: WorkflowVisitState,
  actionId: string,
  value: unknown,
  required: boolean,
): WorkflowDecisionScopeReference {
  const nodeId = Object.entries(state.runtimeIdentity?.nodeToStep ?? []).find(
    ([, stepId]) => stepId === visit.stepId,
  )?.[0];
  if (!nodeId) {
    throw new Error(
      verificationFailure(`evidence producer Node is unknown: ${visit.stepId}`),
    );
  }
  const producer: WorkflowArtifactProducer = {
    runId: state.runId,
    nodeId,
    cycleId: visit.cycleId,
    attemptId: visit.attemptId,
    actionId,
    revision: workflowOutcomeRevision(state, visit.attemptId, actionId),
  };
  const hash = sha256(JSON.stringify(stableValue(value)) ?? "undefined");
  return {
    id: declaration.id,
    required,
    versionId: `evidence-version-${sha256(
      JSON.stringify(
        stableValue({ evidenceId: declaration.id, hash, producer }),
      ),
    ).slice(0, 24)}`,
    contentHash: hash,
    producer,
  };
}

function currentWorkflowEvidenceReference(
  protocol: WorkflowProtocol,
  state: RunState,
  requested: string,
  required: boolean,
): WorkflowDecisionScopeReference | undefined {
  const declaration = workflowEvidenceDeclaration(protocol, requested);
  const nodeByStep = new Map(
    Object.entries(state.runtimeIdentity?.nodeToStep ?? {}).map(
      ([nodeId, stepId]) => [stepId, nodeId],
    ),
  );
  for (const visit of [...(state.workflowRuntime?.visits ?? [])].reverse()) {
    const nodeId = nodeByStep.get(visit.stepId);
    if (!nodeId) continue;
    const node = protocol.nodes.find((candidate) => candidate.id === nodeId);
    if (
      !node?.outputSchemas.some((schemaId) => schemaId === declaration.schemaId)
    ) {
      continue;
    }
    for (const outcome of [...visit.outcomes].reverse()) {
      if (outcome.status !== "succeeded") continue;
      const value = workflowEvidenceValue(outcome.evidence, declaration);
      if (!value.found) continue;
      return workflowEvidenceReference(
        state,
        declaration,
        visit,
        outcome.actionId,
        value.value,
        required,
      );
    }
  }
  return undefined;
}

function sortWorkflowScope(
  scope: WorkflowDecisionScopeSnapshot,
): WorkflowDecisionScopeSnapshot {
  return {
    artifacts: [...scope.artifacts].sort((left, right) =>
      `${left.id}\u0000${left.versionId}`.localeCompare(
        `${right.id}\u0000${right.versionId}`,
      ),
    ),
    evidence: [...scope.evidence].sort((left, right) =>
      `${left.id}\u0000${left.versionId}`.localeCompare(
        `${right.id}\u0000${right.versionId}`,
      ),
    ),
  };
}

async function captureWorkflowVerificationScope(
  prepared: PreparedWorkflowSubmission,
  requirement: ResolvedWorkflowVerificationRequirement,
  state: RunState,
): Promise<WorkflowDecisionScopeSnapshot> {
  const protocol = prepared.verified.package.runtime!.protocol;
  const runtime = state.workflowRuntime;
  if (!runtime) {
    throw new Error(verificationFailure("scope requires revisioned Run state"));
  }
  const artifactVersions = new Map(
    runtime.artifactVersions.map((version) => [version.id, version]),
  );
  const currentArtifacts = currentWorkflowArtifactVersions(runtime);
  const artifacts: WorkflowDecisionScopeReference[] = [];
  for (const entry of requirement.scope.artifacts) {
    const declaration = workflowArtifactDeclaration(protocol, entry.id);
    const versionId = currentArtifacts[declaration.id];
    const version = versionId ? artifactVersions.get(versionId) : undefined;
    if (!version) {
      if (entry.required) {
        throw new Error(
          verificationFailure(
            `required artifact scope is unavailable: ${declaration.id}`,
          ),
        );
      }
      continue;
    }
    try {
      await validateWorkflowArtifactVersion(
        prepared.location.runRoot,
        protocol,
        version,
      );
    } catch (error) {
      throw new Error(
        verificationFailure(
          `artifact scope is stale: ${declaration.id} (${error instanceof Error ? error.message : String(error)})`,
        ),
      );
    }
    artifacts.push({
      id: declaration.id,
      required: entry.required,
      versionId: version.id,
      contentHash: version.contentHash,
      producer: structuredClone(version.producer),
    });
  }
  const evidence: WorkflowDecisionScopeReference[] = [];
  for (const entry of requirement.scope.evidence) {
    const declaration = workflowEvidenceDeclaration(protocol, entry.id);
    const reference = currentWorkflowEvidenceReference(
      protocol,
      state,
      declaration.id,
      entry.required,
    );
    if (!reference) {
      if (entry.required) {
        throw new Error(
          verificationFailure(
            `required evidence scope is unavailable: ${declaration.id}`,
          ),
        );
      }
      continue;
    }
    evidence.push(reference);
  }
  return sortWorkflowScope({ artifacts, evidence });
}

function workflowScopeHash(scope: WorkflowDecisionScopeSnapshot): string {
  return sha256(JSON.stringify(stableValue(sortWorkflowScope(scope))));
}

function workflowScopeSelectionMatches(
  expected: WorkflowDecisionScopeSnapshot,
  submitted: WorkflowVerificationReceiptProposal["scope"],
): void {
  if (submitted === undefined) return;
  if (!isRecord(submitted)) {
    throw new Error(verificationFailure("proposal scope must be an object"));
  }
  const unknown = Object.keys(submitted).find(
    (key) => key !== "artifacts" && key !== "evidence",
  );
  if (unknown)
    throw new Error(
      verificationFailure(`proposal scope has unknown field: ${unknown}`),
    );
  const validate = (kind: "artifacts" | "evidence"): void => {
    const rawValues = submitted[kind];
    if (rawValues !== undefined && !Array.isArray(rawValues)) {
      throw new Error(
        verificationFailure(`proposal ${kind} scope must be an array`),
      );
    }
    const values = rawValues ?? [];
    if (values.length > 64) {
      throw new Error(
        verificationFailure(`proposal ${kind} scope is outside its bound`),
      );
    }
    const seen = new Set<string>();
    for (const value of values) {
      if (!isRecord(value))
        throw new Error(
          verificationFailure(
            `proposal ${kind} scope contains an invalid reference`,
          ),
        );
      const unknownReference = Object.keys(value).find(
        (key) =>
          !["id", "required", "versionId", "contentHash", "producer"].includes(
            key,
          ),
      );
      if (unknownReference) {
        throw new Error(
          verificationFailure(
            `proposal ${kind} scope has unknown field: ${unknownReference}`,
          ),
        );
      }
      const key = `${value.id}\u0000${value.versionId}`;
      if (seen.has(key))
        throw new Error(
          verificationFailure(
            `proposal ${kind} scope contains a duplicate reference`,
          ),
        );
      seen.add(key);
      const reference = expected[kind].find(
        (candidate) =>
          candidate.id === value.id && candidate.versionId === value.versionId,
      );
      if (
        !reference ||
        value.contentHash !== reference.contentHash ||
        (value.required !== undefined &&
          value.required !== reference.required) ||
        (value.producer !== undefined &&
          !sameStableValue(value.producer, reference.producer))
      ) {
        throw new Error(
          verificationFailure(`${kind} scope does not match the current scope`),
        );
      }
    }
    for (const reference of expected[kind]) {
      if (
        reference.required &&
        !values.some((value) => isRecord(value) && value.id === reference.id)
      ) {
        throw new Error(
          verificationFailure(
            `required ${kind} scope is missing: ${reference.id}`,
          ),
        );
      }
    }
  };
  validate("artifacts");
  validate("evidence");
}

function workflowStateWithArtifactMutation(
  state: RunState,
  mutation: WorkflowArtifactMutation | undefined,
): RunState {
  if (!mutation || !state.workflowRuntime) return state;
  return {
    ...state,
    workflowRuntime: {
      ...state.workflowRuntime,
      artifactVersions: [
        ...state.workflowRuntime.artifactVersions,
        ...structuredClone(mutation.versions),
      ],
      artifactSelections: [
        ...state.workflowRuntime.artifactSelections,
        ...structuredClone(mutation.selections),
      ],
    },
  };
}

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

function boundedRepairEpisode(
  value: WorkflowContinuation["repair"],
): WorkflowContinuation["repair"] {
  if (!value) return undefined;
  return {
    ...structuredClone(value),
    history: boundProjectedLedger(value.history),
  };
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
  const finalization = value.finalization
    ? parseWorkflowFinalizationState(
        value.finalization,
        value.execution.durabilityProfile,
      )
    : undefined;
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
    ...(value.repair ? { repair: boundedRepairEpisode(value.repair) } : {}),
    ...(finalization ? { finalization } : {}),
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

function contentSnapshotFindings(state: RunState): WorkflowFinding[] {
  const incomplete = (state.workflowRuntime?.contentSnapshots ?? []).some(
    (snapshot) => !snapshot.complete,
  );
  return incomplete
    ? [
        snapshotIncompleteFinding(
          "Workflow content snapshot is incomplete and cannot satisfy a complete-scope requirement.",
        ),
      ]
    : [];
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

/** The context a person reviews, also compared before delivering their answer. */
export function workflowGateBinding(current: WorkflowContinuation) {
  return {
    runId: current.runId,
    revision: current.revision,
    nodeId: current.currentNode,
    cycleId: current.cycleId,
    attemptId: current.attemptId,
    execution: current.execution,
    pendingAction: current.pendingAction,
  };
}

/** Apply the same published-policy normalization as runtime compilation. */
export function workflowGatePolicy(
  protocol: WorkflowProtocol,
  current: WorkflowContinuation,
): WorkflowReviewerPolicy {
  const normalized = normalizeWorkflowDurabilityProtocol(protocol);
  const action = current.pendingAction;
  let policy: WorkflowReviewerPolicy | undefined;
  if (action?.finalization && normalized.finalization) {
    policy = normalizeWorkflowFinalizationDefinition(normalized.finalization)
      .confirmation?.reviewer;
  } else if (action?.repair) {
    policy = normalized.capabilities?.durability?.repairPolicy?.reviewer;
  } else {
    const decision = normalized.nodes.find(
      (node) => node.id === current.currentNode,
    )?.decision;
    if (!decision || decision.id !== action?.decisionId)
      throw new Error("The pending gate has no matching published decision");
    policy = decision.reviewer;
  }
  return {
    subjects: [...(policy?.subjects ?? [])].sort(),
    authorities: [...(policy?.authorities ?? [])].sort(),
  };
}

/** Prepare a human response without evaluating or advancing a Run. */
export function prepareWorkflowGateAnswer(
  current: WorkflowContinuation,
  answer: WorkflowGateAnswer,
  reviewer: WorkflowReviewerAttestation,
): WorkflowDecisionSubmission {
  const action = current.pendingAction;
  if (action?.type !== "ask_user" || !action.decisionId)
    throw new Error("The Run has no answerable human gate");
  if (
    !answer ||
    typeof answer !== "object" ||
    Array.isArray(answer) ||
    Object.keys(answer).some(
      (key) => !["choiceId", "inputs", "rationale"].includes(key),
    )
  )
    throw new Error(
      "A gate answer accepts only choiceId, inputs, and rationale",
    );
  const choice = action.choices?.find(
    (choice) => choice.id === answer.choiceId,
  );
  if (!choice) throw new Error("Choose one of the pending gate's choices");
  const inputs = answer.inputs ?? {};
  validateScalarRecord(inputs, "Decision inputs");
  validateDecisionInputSchema(
    choice.requiredInputs ??
      action.requiredInputs ?? { type: "object", fields: [] },
    inputs,
  );
  if (
    answer.rationale !== undefined &&
    (typeof answer.rationale !== "string" || !answer.rationale.trim())
  )
    throw new Error("Gate rationale must contain text");
  if (action.rationale?.required && !answer.rationale?.trim())
    throw new Error("Gate rationale is required");
  validateReviewer(reviewer, action.reviewer);
  const submission: WorkflowDecisionSubmission = {
    kind: "decision",
    actionId: action.id,
    runId: current.runId,
    revision: current.revision,
    nodeId: current.currentNode,
    cycleId: current.cycleId,
    attemptId: current.attemptId,
    execution: structuredClone(current.execution),
    decisionId: action.decisionId,
    choiceId: answer.choiceId,
    reviewer: structuredClone(reviewer),
    ...(answer.inputs === undefined ? {} : { inputs: structuredClone(inputs) }),
    ...(answer.rationale === undefined ? {} : { rationale: answer.rationale }),
    ...(action.scope === undefined
      ? {}
      : { scope: structuredClone(action.scope) }),
    ...(action.repair && answer.choiceId === "retry-with-new-approach"
      ? {
          repair: {
            expectedSignatureHash: action.repair.signatureHash,
            hypothesis: answer.rationale,
          },
        }
      : {}),
    ...(action.finalization === undefined
      ? {}
      : {
          finalization: {
            planHash: action.finalization.planHash,
            decisionId: action.finalization.decisionId,
            choiceId: answer.choiceId as "confirm" | "cancel",
            contentSnapshotHash: action.finalization.contentSnapshotHash,
            verificationReceiptIds: [
              ...action.finalization.verificationReceiptIds,
            ],
          },
        }),
  };
  if (isWorkflowRepairAction(action))
    validateRepairDecisionResponse(
      current,
      action,
      current.currentNode,
      submission,
    );
  if (isWorkflowFinalizationAction(action))
    validateFinalizationDecisionResponse(current, action, submission);
  validateSubmission(submission);
  return submission;
}

function validateFinalizationSubmissionShape(
  value: WorkflowFinalizationSubmission,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Workflow finalization submission must be an object");
  }
  const keys = new Set([
    "planHash",
    "decisionId",
    "choiceId",
    "contentSnapshotHash",
    "verificationReceiptIds",
  ]);
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) {
    throw new Error(
      `Workflow finalization submission has unknown field: ${unknown}`,
    );
  }
  for (const [key, entry] of [
    ["planHash", value.planHash],
    ["decisionId", value.decisionId],
  ] as const) {
    if (
      entry !== undefined &&
      (typeof entry !== "string" || entry.length === 0)
    ) {
      throw new Error(
        `Workflow finalization ${key} must be a non-empty string`,
      );
    }
  }
  if (value.planHash !== undefined && !/^[a-f0-9]{64}$/u.test(value.planHash)) {
    throw new Error("Workflow finalization planHash must be a SHA-256 hash");
  }
  if (
    value.choiceId !== undefined &&
    value.choiceId !== "confirm" &&
    value.choiceId !== "cancel"
  ) {
    throw new Error("Workflow finalization choiceId is invalid");
  }
  if (
    value.contentSnapshotHash !== undefined &&
    value.contentSnapshotHash !== null &&
    (typeof value.contentSnapshotHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.contentSnapshotHash))
  ) {
    throw new Error("Workflow finalization contentSnapshotHash is invalid");
  }
  if (value.verificationReceiptIds !== undefined) {
    if (
      !Array.isArray(value.verificationReceiptIds) ||
      value.verificationReceiptIds.length > 256 ||
      value.verificationReceiptIds.some(
        (entry) => typeof entry !== "string" || entry.length === 0,
      )
    ) {
      throw new Error(
        "Workflow finalization verificationReceiptIds are invalid",
      );
    }
    if (
      new Set(value.verificationReceiptIds).size !==
      value.verificationReceiptIds.length
    ) {
      throw new Error(
        "Workflow finalization verificationReceiptIds must not contain duplicates",
      );
    }
  }
}

function validateSubmission(submission: WorkflowSubmission): void {
  if (!submission || typeof submission !== "object") {
    throw new Error("Submission must be an object");
  }
  normalizedVerificationSubmission(submission);
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
    if (!submission.nodeId && submission.nodeId !== null) {
      throw new Error("Decision Node id must be a non-empty string or null");
    }
    if (
      submission.cycleId !== null &&
      (typeof submission.cycleId !== "string" || !submission.cycleId)
    ) {
      throw new Error("Decision cycle id must be a string or null");
    }
    if (!submission.attemptId && submission.attemptId !== null) {
      throw new Error("Decision Attempt id must be a non-empty string or null");
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
    if (submission.finalization !== undefined) {
      validateFinalizationSubmissionShape(submission.finalization);
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
  if (Object.prototype.hasOwnProperty.call(submission, "repair")) {
    throw new Error(
      "Repair decision fields are only valid for decision submissions",
    );
  }
  if (submission.finalization !== undefined) {
    validateFinalizationSubmissionShape(submission.finalization);
  }
  if (
    submission.repairDecision !== undefined ||
    submission.repairFailure !== undefined
  ) {
    throw new Error("Workflow repair outcomes are runtime-generated");
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

function completionPlan(protocol: WorkflowProtocol, nodeId: string | null) {
  const node = protocol.nodes.find((node) => node.id === nodeId);
  if (!node) return null;
  const plan = createCompletionPlan(node);
  return {
    ...plan,
    outputSchemas: plan.outputSchemas.map((id) =>
      structuredClone(
        protocol.outputSchemas.find((schema) => schema.id === id)!,
      ),
    ),
  };
}

function continuation(
  result: ManualRunResult,
  identity: WorkflowExecutionIdentity,
  context: {
    package: Awaited<ReturnType<typeof readSkillSnapshot>>;
    runRoot: string;
  },
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
  const withSnapshots = boundWorkflowFindings([
    ...projected.findings,
    ...contentSnapshotFindings(result.state),
  ]);
  const withRepair = boundWorkflowFindings([
    ...withSnapshots.findings,
    ...repairFindings(result.state),
  ]);
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
    completion: completionPlan(
      context.package.runtime!.protocol,
      result.state.status === "completed"
        ? null
        : currentNode(result.state, identity, result.action),
    ),
    receiptOutputs: workflowReceiptOutputs(
      context.package.runtime!.protocol,
      result.state.status === "completed"
        ? null
        : currentNode(result.state, identity, result.action),
      context.runRoot,
      runtimeState?.externalRoots,
    ),
    execution: structuredClone(identity),
    decisionReceipts: boundProjectedLedger(
      runtimeState?.decisionReceipts ?? [],
    ),
    verificationReceipts: boundProjectedLedger(
      runtimeState?.verificationReceipts ?? [],
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
    contentSnapshots: boundProjectedLedger(
      runtimeState?.contentSnapshots ?? [],
    ),
    currentArtifactVersions: currentWorkflowArtifactVersions(runtimeState),
    findings: withRepair.findings,
    findingSummary: withRepair.summary,
    requiresUserDecision: withRepair.findings.some(
      (finding) => finding.requiresUserDecision,
    ),
    blockers: legacyBlockersFromFindings(disposition, withRepair.findings),
    ...(runtimeState?.repairEpisode
      ? { repair: boundedRepairEpisode(runtimeState.repairEpisode) }
      : {}),
    ...(runtimeState?.finalization
      ? { finalization: structuredClone(runtimeState.finalization) }
      : {}),
  };
}

function withAdditionalFindings(
  value: WorkflowContinuation,
  additional: readonly WorkflowFinding[],
  disposition = value.disposition,
): WorkflowContinuation {
  const projected = boundWorkflowFindings([...value.findings, ...additional]);
  return {
    ...value,
    disposition,
    findings: projected.findings,
    findingSummary: projected.summary,
    requiresUserDecision: projected.findings.some(
      (finding) => finding.requiresUserDecision,
    ),
    blockers: legacyBlockersFromFindings(disposition, projected.findings),
  };
}

function checkpointFindings(
  inspections: readonly WorkflowCheckpointInspection[],
  severity: "warning" | "error",
): WorkflowFinding[] {
  return inspections
    .filter((inspection) => inspection.error !== undefined)
    .map((inspection) =>
      checkpointInvalidFinding(
        `Workflow checkpoint revision ${inspection.entry.revision} is invalid: ${inspection.error}`,
        `.badger/checkpoints/manifests/${inspection.entry.manifestHash}.json`,
        severity,
      ),
    );
}

function checkpointIndexFinding(
  error: unknown,
  severity: "warning" | "error",
): WorkflowFinding {
  return checkpointInvalidFinding(
    `Workflow checkpoint index is invalid: ${
      error instanceof Error ? error.message : String(error)
    }`,
    ".badger/checkpoints/index.json",
    severity,
  );
}

async function checkpointRecoveryRequiredContinuation(
  location: ResolvedWorkflowRunLocation,
  journal: WorkflowCheckpointRecoveryJournal,
): Promise<WorkflowContinuation> {
  let base: WorkflowContinuation;
  let verified: VerifiedWorkflowRun | undefined;
  try {
    verified = await verifyStoredRun(location);
    base = await continuationFromVerifiedRun(verified, location.runRoot);
  } catch (error) {
    const profile = journal.execution.durabilityProfile;
    if (!profile) throw error;
    const index = await readWorkflowCheckpointIndex(location.runRoot, profile);
    const entry = index?.records.find(
      (candidate) => candidate.recordHash === journal.checkpointRecordHash,
    );
    if (!entry) throw error;
    const candidate = await verifyWorkflowCheckpointCandidate(
      location.runRoot,
      profile,
      entry,
    );
    base = continuation(
      { state: candidate.state, action: candidate.pending, evals: [] },
      candidate.identity,
      { package: candidate.package, runRoot: location.runRoot },
    );
  }
  return withAdditionalFindings(
    base,
    [
      recoveryRequiredFinding(
        base.revision,
        base.pendingAction?.id ?? null,
        ".badger/checkpoint-recovery-journal.json",
      ),
    ],
    "blocked",
  );
}

async function persistWorkflowCheckpoint(
  location: ResolvedWorkflowRunLocation,
  state: RunState,
  pending: EngineAction | null,
  pkg: Awaited<ReturnType<typeof readSkillSnapshot>>,
): Promise<void> {
  const profile = state.runtimeIdentity?.durabilityProfile;
  if (!usesWorkflowCheckpoints(profile)) return;
  await createWorkflowCheckpoint({
    runRoot: location.runRoot,
    state,
    pending,
    identity: identityFromState(state),
    package: pkg,
    profile: profile!,
  });
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

/** The outcomes a Run's trajectory records, in order, by Node. */
async function projectedOutcomes(
  location: ResolvedWorkflowRunLocation,
  state: RunState,
  identity: WorkflowExecutionIdentity,
): Promise<
  Pick<
    WorkflowStateProjection,
    "completedNodes" | "evidence" | "history" | "historySummary"
  > & {
    trajectory: Awaited<ReturnType<typeof readTrajectory>>;
  }
> {
  const nodeByStep = new Map(
    Object.entries(identity.nodeToStep).map(([nodeId, stepId]) => [
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
  const recentHistory = boundProjectedLedger(history);
  return {
    trajectory,
    completedNodes,
    evidence,
    history: recentHistory,
    historySummary: {
      total: history.length,
      returned: recentHistory.length,
      omitted: history.length - recentHistory.length,
    },
  };
}

/**
 * While a transition, checkpoint recovery, or finalization transaction is
 * pending, the projection reports the blocked continuation `inspect` returns.
 */
async function recoveryStateProjection(
  location: ResolvedWorkflowRunLocation,
  state: RunState,
  recovery: WorkflowContinuation,
): Promise<WorkflowStateProjection> {
  const protocol = (await verifyStoredPackage(location.runRoot, state)).package
    .runtime!.protocol;
  const { completedNodes, evidence, history, historySummary } =
    await projectedOutcomes(location, state, recovery.execution);
  const { disposition: _disposition, ...continuation } = recovery;
  return {
    schemaVersion: 1,
    workflow: protocol.name,
    statePath: protocol.state.statePath,
    status: "blocked",
    ...continuation,
    completedNodes,
    evidence: recovery.pendingAction?.type === "ask_user" ? {} : evidence,
    history,
    historySummary,
    artifactReceipts: projectedArtifactReceipts(state),
  };
}

/** Receipt evidence was issued by Completion for these producing Attempts. */
function projectedArtifactReceipts(state: RunState): WorkflowArtifactReceipt[] {
  const receipts: WorkflowArtifactReceipt[] = [];
  for (const visit of state.workflowRuntime?.visits ?? []) {
    for (const outcome of visit.outcomes) {
      const values = outcome.evidence?.artifactReceipts;
      if (Array.isArray(values))
        receipts.push(
          ...(structuredClone(values) as WorkflowArtifactReceipt[]),
        );
    }
  }
  return receipts.slice(-MAX_PROJECTED_LEDGER_ENTRIES);
}

export async function projectWorkflowState(
  target: WorkflowRunTarget,
): Promise<WorkflowStateProjection | null> {
  const location = resolveWorkflowRunLocation(target);
  const state = await location.readState();
  if (!state) return null;
  const recovery = await pendingRecoveryContinuation(location);
  if (recovery === undefined) return null;
  if (recovery) return recoveryStateProjection(location, state, recovery);

  const verified = await verifyStoredRun(location);
  const { trajectory, completedNodes, evidence, history, historySummary } =
    await projectedOutcomes(location, state, verified.identity);
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
  const projectedBaseFindings =
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
  const snapshotFindings: WorkflowFinding[] = [];
  const snapshotPolicy = verified.identity.durabilityProfile?.snapshotPolicy;
  if (
    usesWorkflowContentSnapshots(verified.identity.durabilityProfile) &&
    snapshotPolicy
  ) {
    for (const reference of runtimeState?.contentSnapshots ?? []) {
      const snapshot = await readWorkflowContentSnapshot(
        location.runRoot,
        reference.hash,
        snapshotPolicy.limits.maxManifestBytes,
      );
      if (snapshot) {
        snapshotFindings.push(...workflowContentSnapshotFindings(snapshot));
      }
    }
  }
  const projectedFindings = boundWorkflowFindings([
    ...projectedBaseFindings.findings,
    ...snapshotFindings,
    ...repairFindings(state),
  ]);
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
    historySummary,
    pendingAction: verified.pending,
    artifactReceipts: projectedArtifactReceipts(state),
    receiptOutputs: workflowReceiptOutputs(
      protocol,
      status === "completed"
        ? null
        : currentNode(state, verified.identity, verified.pending),
      location.runRoot,
      runtimeState?.externalRoots,
    ),
    execution: structuredClone(verified.identity),
    decisionReceipts: boundProjectedLedger(
      runtimeState?.decisionReceipts ?? [],
    ),
    verificationReceipts: boundProjectedLedger(
      runtimeState?.verificationReceipts ?? [],
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
    contentSnapshots: boundProjectedLedger(
      runtimeState?.contentSnapshots ?? [],
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
    ...(runtimeState?.repairEpisode
      ? { repair: boundedRepairEpisode(runtimeState.repairEpisode) }
      : {}),
    ...(runtimeState?.finalization
      ? { finalization: structuredClone(runtimeState.finalization) }
      : {}),
  };
}

export async function listWorkflowRuns(
  projectRoot: string,
): Promise<WorkflowRunRegistryEntry[]> {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new Error(
      "Workflow Run registry project root must be a non-empty string",
    );
  }
  const root = path.resolve(projectRoot);
  const registry = await inspectProtectedProjectPath(root, ".badger/runs", {
    label: "Workflow Run registry",
    expected: "directory",
  });
  if (!registry.exists) return [];
  const entries = await fs.readdir(registry.target, { withFileTypes: true });
  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  const runs: WorkflowRunRegistryEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const location = {
      kind: "standalone" as const,
      projectRoot: root,
      runId: entry.name,
    };
    let resolved: ResolvedWorkflowRunLocation;
    try {
      resolved = resolveWorkflowRunLocation(location);
    } catch {
      // A directory name that is not a Run id is not a registry entry.
      continue;
    }
    const stored = await resolved.readState();
    if (!stored?.runtimeIdentity) continue;
    const state = await projectWorkflowState(location);
    if (state) {
      runs.push({
        ...state,
        location,
        runRoot: resolved.runRoot,
      });
    }
  }
  return runs;
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

async function verifyStoredVerificationReceipts(
  runRoot: string,
  state: RunState,
  identity: WorkflowExecutionIdentity,
  pkg: Awaited<ReturnType<typeof readSkillSnapshot>>,
): Promise<void> {
  const profile = identity.durabilityProfile;
  const references = state.workflowRuntime?.verificationReceipts ?? [];
  if (references.length === 0) return;
  if (!profile?.capabilities.includes("verification-receipts")) {
    throw new Error(
      "WorkflowRuntime verification receipt state requires verification-receipts capability",
    );
  }
  if (
    profile.bounds.verificationReceiptCount !== undefined &&
    references.length > profile.bounds.verificationReceiptCount
  ) {
    throw new Error(
      "WorkflowRuntime verification receipt count exceeds its bound",
    );
  }
  const ids = new Set<string>();
  for (const reference of references) {
    if (ids.has(reference.receiptId)) {
      throw new Error(
        `WorkflowRuntime verification receipt is duplicated: ${reference.receiptId}`,
      );
    }
    ids.add(reference.receiptId);
    const receipt = await readWorkflowVerificationReceipt(
      runRoot,
      reference.receiptHash,
      profile,
    );
    if (!receipt) {
      throw new Error(
        `WorkflowRuntime verification receipt is missing: ${reference.receiptId}`,
      );
    }
    if (
      !receiptReferencesEqual(
        workflowVerificationReceiptReference(receipt),
        reference,
      ) ||
      receipt.runId !== state.runId ||
      receipt.protocolHash !== identity.protocolHash ||
      receipt.packageHash !== identity.packageHash ||
      receipt.snapshotHash !== identity.snapshotHash ||
      !sameExecutionIdentity(receipt.execution, identity)
    ) {
      throw new Error(
        `WorkflowRuntime verification receipt identity is invalid: ${reference.receiptId}`,
      );
    }
    for (const candidate of receipt.candidateArtifacts) {
      const version = state.workflowRuntime?.artifactVersions.find(
        (entry) => entry.id === candidate.versionId,
      );
      if (
        !version ||
        version.artifactId !== candidate.artifactId ||
        version.contentHash !== candidate.contentHash ||
        !sameStableValue(version.producer, candidate.producer)
      ) {
        throw new Error(
          `WorkflowRuntime verification receipt candidate artifact identity is invalid: ${reference.receiptId}`,
        );
      }
    }
    for (const candidate of receipt.scope.evidence) {
      const declaration = workflowEvidenceDeclaration(
        pkg.runtime!.protocol,
        candidate.id,
      );
      const visit = state.workflowRuntime?.visits.find(
        (entry) => entry.attemptId === candidate.producer.attemptId,
      );
      const outcome = visit?.outcomes.find(
        (entry) => entry.actionId === candidate.producer.actionId,
      );
      const value = workflowEvidenceValue(outcome?.evidence, declaration);
      if (
        !visit ||
        !outcome ||
        outcome.status !== "succeeded" ||
        !value.found
      ) {
        throw new Error(
          `WorkflowRuntime verification receipt evidence identity is invalid: ${reference.receiptId}`,
        );
      }
      const expected = workflowEvidenceReference(
        state,
        declaration,
        visit,
        outcome.actionId,
        value.value,
        candidate.required,
      );
      if (!sameStableValue(expected, candidate)) {
        throw new Error(
          `WorkflowRuntime verification receipt evidence identity is invalid: ${reference.receiptId}`,
        );
      }
    }
    const outcomeLocation = state.workflowRuntime?.visits
      .map((visit) => ({
        visit,
        outcome: visit.outcomes.find((outcome) =>
          outcome.verificationReceiptIds?.includes(reference.receiptId),
        ),
      }))
      .find((candidate) => candidate.outcome !== undefined);
    if (!outcomeLocation) {
      throw new Error(
        `WorkflowRuntime verification receipt is detached from an outcome: ${reference.receiptId}`,
      );
    }
    const outcome = outcomeLocation.outcome;
    if (!outcome) {
      throw new Error(
        `WorkflowRuntime verification receipt is detached from an outcome: ${reference.receiptId}`,
      );
    }
    const nodeId = Object.entries(identity.nodeToStep).find(
      ([, stepId]) => stepId === outcomeLocation.visit.stepId,
    )?.[0];
    const node = pkg.runtime?.protocol.nodes.find(
      (candidate) => candidate.id === nodeId,
    );
    const requirement = verificationRequirements(node).find(
      (candidate) => candidate.id === receipt.requirementId,
    );
    if (
      !nodeId ||
      !node ||
      !requirement ||
      receipt.role !== requirement.role ||
      !requirement.kinds.includes(receipt.receiptKind) ||
      receipt.nodeId !== nodeId ||
      receipt.attemptId !== outcomeLocation.visit.attemptId ||
      receipt.cycleId !== outcomeLocation.visit.cycleId ||
      receipt.actionId !== outcome.actionId ||
      receipt.revision !==
        workflowOutcomeRevision(
          state,
          outcomeLocation.visit.attemptId,
          outcome.actionId,
        )
    ) {
      throw new Error(
        `WorkflowRuntime verification receipt context is invalid: ${reference.receiptId}`,
      );
    }
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
  if (usesWorkflowContentSnapshots(identity.durabilityProfile)) {
    const snapshotPolicy = identity.durabilityProfile?.snapshotPolicy;
    const references = state.workflowRuntime?.contentSnapshots ?? [];
    if (!snapshotPolicy || references.length === 0) {
      throw new Error(
        "WorkflowRuntime content snapshot references are missing",
      );
    }
    for (const reference of references) {
      const snapshot = await readWorkflowContentSnapshot(
        runRoot,
        reference.hash,
        snapshotPolicy.limits.maxManifestBytes,
      );
      if (!snapshot) {
        throw new Error(
          `WorkflowRuntime content snapshot is missing: ${reference.hash}`,
        );
      }
      if (
        snapshot.complete !== reference.complete ||
        !sameStableValue(snapshot.policy, snapshotPolicy)
      ) {
        throw new Error(
          `WorkflowRuntime content snapshot identity is invalid: ${reference.hash}`,
        );
      }
    }
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
  await verifyStoredVerificationReceipts(runRoot, state, identity, pkg);
  const verificationReceiptIds = new Set(
    state.workflowRuntime?.verificationReceipts.map(
      (reference) => reference.receiptId,
    ) ?? [],
  );
  for (const visit of state.workflowRuntime?.visits ?? []) {
    for (const outcome of visit.outcomes) {
      for (const receiptId of outcome.verificationReceiptIds ?? []) {
        if (!verificationReceiptIds.has(receiptId)) {
          throw new Error(
            `WorkflowRuntime verification receipt reference is unknown: ${receiptId}`,
          );
        }
      }
    }
  }
  for (const receipt of state.workflowRuntime?.decisionReceipts ?? []) {
    for (const verificationReceiptId of receipt.verificationReceiptIds ?? []) {
      if (!verificationReceiptIds.has(verificationReceiptId)) {
        throw new Error(
          `WorkflowRuntime Decision Receipt references an unknown Verification Receipt: ${verificationReceiptId}`,
        );
      }
    }
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

async function verifyStoredRepairEpisode(
  runRoot: string,
  state: RunState,
  identity: WorkflowExecutionIdentity,
): Promise<void> {
  const episode = state.workflowRuntime?.repairEpisode;
  if (!episode) {
    if (identity.durabilityProfile?.capabilities.includes("repair-policy")) {
      throw new Error("WorkflowRuntime repair episode is missing");
    }
    return;
  }
  if (!identity.durabilityProfile?.capabilities.includes("repair-policy")) {
    throw new Error(
      "WorkflowRuntime repair episode has no repair-policy capability",
    );
  }
  const expectedExecutionHash = sha256(JSON.stringify(stableValue(identity)));
  if (
    episode.signature &&
    (episode.signature.protocolHash !== identity.protocolHash ||
      episode.signature.executionHash !== expectedExecutionHash)
  ) {
    throw new Error(
      "WorkflowRuntime repair signature is not bound to Run identity",
    );
  }
  const trajectory = await readTrajectory(
    runRoot,
    state.trajectoryRef,
    durabilityReadOptions(state, "trajectoryBytes"),
  );
  const proof: Array<{
    kind: "failure" | "decision" | "override";
    signatureHash: string;
    actionId?: string;
    decisionId?: string;
    choiceId?: string;
    outcome?: string;
    reviewer?: { subject: string; authorities: string[] };
    rationaleHash?: string | null;
    hypothesisHash?: string | null;
    findingCodes?: string[];
    failedReceiptCoverage?: string[];
    failedAcceptanceCoverage?: string[];
    scopeIdentities?: string[];
    snapshotIdentities?: string[];
    artifactIdentities?: string[];
    disposition?: string;
    reasonCode?: string;
    consecutiveFailures?: number;
    totalFailures?: number;
    remainingFailures?: number;
    overrideAccepted?: boolean;
    automaticRepair?: {
      id: string;
      operation: "workflow.resume";
      idempotent: true;
      maxExecutions: number;
    };
  }> = [];
  for (const event of trajectory) {
    if (event.type !== "action_completed" || !isRecord(event.data.outcome)) {
      continue;
    }
    const outcome = event.data.outcome;
    if (
      isRecord(outcome.repairFailure) &&
      isRecord(outcome.repairFailure.signature)
    ) {
      const rawSignature = outcome.repairFailure.signature;
      const signature = buildWorkflowRepairSignature({
        protocolHash: rawSignature.protocolHash as string,
        executionHash: rawSignature.executionHash as string,
        actionId: rawSignature.actionId as string | null,
        attemptId: rawSignature.attemptId as string | null,
        nodeId: rawSignature.nodeId as string | null,
        cycleId: rawSignature.cycleId as string | null,
        visitOrdinal: rawSignature.visitOrdinal as number | null,
        findingCodes: rawSignature.findingCodes as string[],
        failedReceiptCoverage: rawSignature.failedReceiptCoverage as string[],
        failedAcceptanceCoverage:
          rawSignature.failedAcceptanceCoverage as string[],
        scopeIdentities: rawSignature.scopeIdentities as string[],
        snapshotIdentities: rawSignature.snapshotIdentities as string[],
        artifactIdentities: rawSignature.artifactIdentities as string[],
      });
      if (rawSignature.signatureHash !== signature.signatureHash) {
        throw new Error(
          "WorkflowRuntime repair failure signature is not canonical",
        );
      }
      if (
        rawSignature.protocolHash !== identity.protocolHash ||
        rawSignature.executionHash !== expectedExecutionHash
      ) {
        throw new Error(
          "WorkflowRuntime repair failure identity is not bound to Run",
        );
      }
      const automaticRepair =
        outcome.repairFailure.automaticRepair === null ||
        outcome.repairFailure.automaticRepair === undefined
          ? undefined
          : parseWorkflowRepairAutomaticOperation(
              outcome.repairFailure.automaticRepair,
            );
      proof.push({
        kind: "failure",
        signatureHash: signature.signatureHash,
        findingCodes: signature.findingCodes,
        failedReceiptCoverage: signature.failedReceiptCoverage,
        failedAcceptanceCoverage: signature.failedAcceptanceCoverage,
        scopeIdentities: signature.scopeIdentities,
        snapshotIdentities: signature.snapshotIdentities,
        artifactIdentities: signature.artifactIdentities,
        disposition: outcome.repairFailure.disposition as string,
        reasonCode: outcome.repairFailure.reasonCode as string,
        consecutiveFailures: outcome.repairFailure
          .consecutiveFailures as number,
        totalFailures: outcome.repairFailure.totalFailures as number,
        remainingFailures: outcome.repairFailure.remainingFailures as number,
        overrideAccepted: outcome.repairFailure.overrideAccepted as boolean,
        ...(automaticRepair ? { automaticRepair } : {}),
      });
    }
    if (isRecord(outcome.repairDecision)) {
      const repairDecision = outcome.repairDecision;
      if (
        typeof repairDecision.signatureHash !== "string" ||
        !/^[a-f0-9]{64}$/u.test(repairDecision.signatureHash)
      ) {
        throw new Error("WorkflowRuntime repair decision signature is invalid");
      }
      if (
        typeof repairDecision.decisionId !== "string" ||
        typeof repairDecision.choiceId !== "string" ||
        (repairDecision.outcome !== "retry" &&
          repairDecision.outcome !== "stop" &&
          repairDecision.outcome !== "contract-change") ||
        !isRecord(repairDecision.reviewer) ||
        typeof repairDecision.reviewer.subject !== "string" ||
        !Array.isArray(repairDecision.reviewer.authorities) ||
        repairDecision.reviewer.authorities.some(
          (authority) => typeof authority !== "string",
        )
      ) {
        throw new Error("WorkflowRuntime repair decision evidence is invalid");
      }
      const hypothesis =
        typeof repairDecision.hypothesis === "string"
          ? repairDecision.hypothesis.trim()
          : "";
      const rationale =
        typeof repairDecision.rationale === "string"
          ? repairDecision.rationale.trim()
          : "";
      proof.push({
        kind: hypothesis.length > 0 ? "override" : "decision",
        signatureHash: repairDecision.signatureHash as string,
        actionId: outcome.actionId as string,
        decisionId: repairDecision.decisionId as string,
        choiceId: repairDecision.choiceId as string,
        outcome: repairDecision.outcome as string,
        reviewer: {
          subject: repairDecision.reviewer.subject,
          authorities: [...repairDecision.reviewer.authorities].sort(
            (left, right) => left.localeCompare(right),
          ),
        },
        ...(hypothesis.length > 0
          ? {
              rationaleHash: hashWorkflowRepairText(rationale),
              hypothesisHash: hashWorkflowRepairText(hypothesis),
            }
          : {
              rationaleHash:
                rationale.length > 0 ? hashWorkflowRepairText(rationale) : null,
            }),
      });
    }
  }
  if (proof.length !== episode.history.length) {
    throw new Error(
      "WorkflowRuntime repair history is detached from trajectory",
    );
  }
  for (const [index, record] of episode.history.entries()) {
    const evidence = proof[index];
    if (!evidence || record.kind !== evidence.kind) {
      throw new Error("WorkflowRuntime repair history order is invalid");
    }
    if (record.signatureHash !== evidence.signatureHash) {
      throw new Error("WorkflowRuntime repair history signature is invalid");
    }
    if (record.kind === "failure") {
      if (
        !sameStableValue(record.findingCodes, evidence.findingCodes) ||
        !sameStableValue(
          record.failedReceiptCoverage,
          evidence.failedReceiptCoverage,
        ) ||
        !sameStableValue(
          record.failedAcceptanceCoverage,
          evidence.failedAcceptanceCoverage,
        ) ||
        !sameStableValue(record.scopeIdentities, evidence.scopeIdentities) ||
        !sameStableValue(
          record.snapshotIdentities,
          evidence.snapshotIdentities,
        ) ||
        !sameStableValue(
          record.artifactIdentities,
          evidence.artifactIdentities,
        ) ||
        record.disposition !== evidence.disposition ||
        record.reasonCode !== evidence.reasonCode ||
        record.consecutiveFailures !== evidence.consecutiveFailures ||
        record.totalFailures !== evidence.totalFailures ||
        record.remainingFailures !== evidence.remainingFailures ||
        record.overrideAccepted !== evidence.overrideAccepted ||
        !sameStableValue(record.automaticRepair, evidence.automaticRepair)
      ) {
        throw new Error("WorkflowRuntime repair failure coverage is invalid");
      }
      continue;
    }
    if (record.kind === "decision") {
      if (
        record.actionId !== evidence.actionId ||
        record.decisionId !== evidence.decisionId ||
        record.choiceId !== evidence.choiceId ||
        record.outcome !== evidence.outcome ||
        !sameStableValue(record.reviewer, evidence.reviewer) ||
        record.rationaleHash !== evidence.rationaleHash
      ) {
        throw new Error("WorkflowRuntime repair decision history is invalid");
      }
    } else if (
      record.actionId !== evidence.actionId ||
      record.decisionId !== evidence.decisionId ||
      record.choiceId !== evidence.choiceId ||
      record.outcome !== evidence.outcome ||
      !sameStableValue(record.reviewer, evidence.reviewer) ||
      record.rationaleHash !== evidence.rationaleHash ||
      record.hypothesisHash !== evidence.hypothesisHash
    ) {
      throw new Error("WorkflowRuntime repair override history is invalid");
    }
  }
}

async function verifyStoredRun(location: ResolvedWorkflowRunLocation): Promise<{
  runRoot: string;
  state: RunState;
  identity: WorkflowExecutionIdentity;
  package: Awaited<ReturnType<typeof readSkillSnapshot>>;
  pending: EngineAction | null;
}> {
  const state = await location.readState();
  if (!state) throw new Error(`No Badger Run found in: ${location.runRoot}`);
  const verified = await verifyStoredPackage(location.runRoot, state);
  const pending = await verifyStoredAction(
    location.runRoot,
    state,
    verified.identity,
    verified.package,
  );
  const finalization = state.workflowRuntime?.finalization;
  const finalizationDefinition =
    verified.package.runtime?.protocol.finalization;
  if (
    finalization &&
    (!finalizationDefinition ||
      !usesWorkflowFinalization(verified.identity.durabilityProfile))
  ) {
    throw new Error(
      "WorkflowRuntime finalization state is not declared by the Run",
    );
  }
  if (
    finalizationDefinition &&
    usesWorkflowFinalization(verified.identity.durabilityProfile) &&
    state.status === "completed" &&
    finalization?.status !== "committed"
  ) {
    throw new Error(
      "WorkflowRuntime completed Run lacks committed finalization",
    );
  }
  if (finalization?.status === "committed" || finalization?.receipt) {
    const profile = verified.identity.durabilityProfile;
    const reference = finalization.receipt;
    if (!profile || !reference) {
      throw new Error("WorkflowRuntime finalization receipt is missing");
    }
    const receipt = await readWorkflowFinalizationReceipt(
      location.runRoot,
      reference.receiptHash,
      profile,
    );
    if (
      !receipt ||
      !sameStableValue(workflowFinalizationReceiptReference(receipt), reference)
    ) {
      throw new Error(
        "WorkflowRuntime finalization receipt identity is invalid",
      );
    }
  }
  await verifyStoredRepairEpisode(location.runRoot, state, verified.identity);
  return { state, ...verified, pending, runRoot: location.runRoot };
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
  const base = continuation(
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
    verified,
  );
  const snapshotFindings: WorkflowFinding[] = [];
  const snapshotPolicy = verified.identity.durabilityProfile?.snapshotPolicy;
  if (
    usesWorkflowContentSnapshots(verified.identity.durabilityProfile) &&
    snapshotPolicy
  ) {
    for (const reference of verified.state.workflowRuntime?.contentSnapshots ??
      []) {
      const snapshot = await readWorkflowContentSnapshot(
        runRoot,
        reference.hash,
        snapshotPolicy.limits.maxManifestBytes,
      );
      if (snapshot)
        snapshotFindings.push(...workflowContentSnapshotFindings(snapshot));
    }
  }
  return withAdditionalFindings(base, snapshotFindings);
}

/**
 * The blocked continuation a pending transition, checkpoint recovery, or
 * finalization transaction forces until `recover` resolves it; null when none
 * is pending, and undefined when there is no Run.
 */
async function pendingRecoveryContinuation(
  location: ResolvedWorkflowRunLocation,
): Promise<WorkflowContinuation | null | undefined> {
  const journal = await readWorkflowTransitionJournal(location.runRoot);
  if (journal) return recoveryRequiredContinuation(location, journal);
  const checkpointRecovery = await readWorkflowCheckpointRecoveryJournal(
    location.runRoot,
  );
  if (checkpointRecovery) {
    return checkpointRecoveryRequiredContinuation(location, checkpointRecovery);
  }
  try {
    const storedState = await location.readState();
    if (!storedState) return undefined;
    const profile = storedState.runtimeIdentity?.durabilityProfile;
    if (profile?.capabilities.includes("transactional-finalization")) {
      const transaction = await readWorkflowFinalizationTransaction(
        location.runRoot,
        profile,
      );
      if (transaction) {
        return finalizationRecoveryRequiredContinuation(location, transaction);
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
  return null;
}

export async function inspectWorkflowRun(
  target: WorkflowRunTarget,
): Promise<WorkflowContinuation | null> {
  return withStructuredRuntimeErrors(async () => {
    const location = resolveWorkflowRunLocation(target);
    const recovery = await pendingRecoveryContinuation(location);
    if (recovery === undefined) return null;
    if (recovery) return recovery;
    return continuationFromVerifiedRun(
      await verifyStoredRun(location),
      location.runRoot,
    );
  });
}

/** A stable committed report for observers; the trajectory remains authoritative. */
export async function readWorkflowRunReport(
  target: WorkflowRunTarget,
  afterSequence = 0,
): Promise<WorkflowRunReport | null> {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
    throw new Error("Workflow report sequence must be a non-negative integer");
  const location = resolveWorkflowRunLocation(target);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const before = await location.readState();
      if (!before) return null;
      if (await readWorkflowTransitionJournal(location.runRoot))
        throw new Error(
          "Workflow report is unavailable until the pending transition is recovered",
        );
      const projection = (await projectWorkflowState(target))!;
      const continuation = (await inspectWorkflowRun(target))!;
      if (continuation.pendingAction?.finalization)
        continuation.finalizationPreview =
          await previewWorkflowFinalization(target);
      const events = await readTrajectory(
        location.runRoot,
        before.trajectoryRef,
        durabilityReadOptions(before, "trajectoryBytes"),
      );
      const after = await location.readState();
      if (
        JSON.stringify(before) !== JSON.stringify(after) ||
        projection.revision !== continuation.revision ||
        (await readWorkflowTransitionJournal(location.runRoot))
      )
        continue;
      return {
        projection,
        continuation,
        events: structuredClone(
          events.filter((event) => event.sequence > afterSequence),
        ),
        lastSequence: events.at(-1)?.sequence ?? 0,
      };
    } catch (error) {
      if (
        !(error instanceof RaceSafeReadError) ||
        error.reason !== "changed" ||
        attempt === 3
      )
        throw error;
    }
  }
  throw new Error("Workflow Run changed while reporting; retry the read");
}

export async function previewWorkflowFinalization(
  target: WorkflowRunTarget,
): Promise<WorkflowFinalizationPreview> {
  return withStructuredRuntimeErrors(async () => {
    const location = resolveWorkflowRunLocation(target);
    const journal = await readWorkflowTransitionJournal(location.runRoot);
    if (journal) {
      throw new Error(
        "Workflow finalization preview is unavailable during recovery",
      );
    }
    const locationProfile = await durabilityProfileForLocation(location);
    if (locationProfile?.capabilities.includes("transactional-finalization")) {
      const transaction = await readWorkflowFinalizationTransaction(
        location.runRoot,
        locationProfile,
      );
      if (transaction) {
        throw new WorkflowFinalizationTransactionPendingError(transaction);
      }
    }
    const verified = await verifyStoredRun(location);
    const definition = verified.package.runtime?.protocol.finalization;
    const profile = verified.identity.durabilityProfile;
    if (
      !definition ||
      !profile?.capabilities.includes("transactional-finalization")
    ) {
      throw new Error("Workflow finalization is not enabled for this Run");
    }
    await validateFinalizationEvidenceBindings(
      location,
      verified.state,
      definition,
      profile,
    );
    return buildWorkflowFinalizationPreview({
      baseRoot: location.contentSnapshotRoot,
      state: verified.state,
      execution: verified.identity,
      definition,
      profile,
    });
  });
}

interface PreparedWorkflowSubmission {
  location: ResolvedWorkflowRunLocation;
  verified: VerifiedWorkflowRun;
  pending: EngineAction;
  node: string | null;
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function repairFactsForSubmission(
  prepared: PreparedWorkflowSubmission,
  submission: WorkflowSubmission,
  mutation: WorkflowArtifactMutation | undefined,
): WorkflowRepairFailureFacts {
  const runtime = prepared.verified.state.workflowRuntime;
  const failedReceipts = [
    ...(runtime?.verificationReceipts ?? []),
    ...(mutation?.verificationReceipts ?? []),
  ]
    .filter((receipt) => receipt.status !== "passed")
    .filter(
      (receipt, index, values) =>
        values.findIndex(
          (candidate) =>
            candidate.requirementId === receipt.requirementId &&
            candidate.status === receipt.status &&
            candidate.scopeHash === receipt.scopeHash,
        ) === index,
    );
  const failedReceiptCoverage = failedReceipts.map(
    (receipt) =>
      `${receipt.requirementId}:${receipt.status}:${receipt.scopeHash}`,
  );
  const evidence = !isDecisionSubmission(submission)
    ? submission.evidence
    : undefined;
  const failedAcceptanceCoverage = [
    ...stringValues(evidence && evidence.failedAcceptanceIds),
    ...stringValues(evidence && evidence.failedCheckIds),
    ...stringValues(evidence && evidence.failedAcceptanceCoverage),
  ];
  const findingCodes = [
    ...failedReceipts.map(() => "verification-receipt-failed"),
    ...stringValues(evidence && evidence.findingCodes),
  ];
  if (findingCodes.length === 0) findingCodes.push("action-failed");
  if (failedAcceptanceCoverage.length === 0 && failedReceipts.length === 0) {
    failedAcceptanceCoverage.push(
      `node:${prepared.node ?? prepared.pending.stepId}`,
    );
  }
  const scopeIdentities = [
    ...failedReceipts.map((receipt) => receipt.scopeHash),
    ...stringValues(evidence && evidence.scopeIdentities),
    ...stringValues(evidence && evidence.scopeHashes),
    ...(typeof evidence?.scopeHash === "string" ? [evidence.scopeHash] : []),
  ];
  const snapshotIdentities = [
    ...(runtime?.contentSnapshots ?? []).map((snapshot) => snapshot.hash),
    ...failedReceipts
      .map((receipt) => receipt.contentSnapshotHash)
      .filter((hash): hash is string => hash !== null),
    ...stringValues(evidence && evidence.snapshotIdentities),
    ...stringValues(evidence && evidence.snapshotHashes),
    ...(typeof evidence?.snapshotHash === "string"
      ? [evidence.snapshotHash]
      : []),
  ];
  const artifactIdentities = [
    ...(runtime?.artifactVersions ?? []).map(
      (version) => `${version.artifactId}:${version.id}:${version.contentHash}`,
    ),
    ...(mutation?.versions ?? []).map(
      (version) => `${version.artifactId}:${version.id}:${version.contentHash}`,
    ),
    ...stringValues(evidence && evidence.artifactIdentities),
    ...stringValues(evidence && evidence.artifactHashes),
    ...(typeof evidence?.artifactHash === "string"
      ? [evidence.artifactHash]
      : []),
  ];
  return {
    protocolHash: prepared.verified.identity.protocolHash,
    execution: prepared.verified.identity,
    actionId: prepared.pending.id,
    attemptId: runtime?.currentAttempt?.id ?? null,
    nodeId: prepared.node,
    cycleId: runtime?.currentAttempt?.cycleId ?? null,
    visitOrdinal: runtime?.currentAttempt?.visitOrdinal ?? null,
    findingCodes,
    failedReceiptCoverage,
    failedAcceptanceCoverage,
    scopeIdentities,
    snapshotIdentities,
    artifactIdentities,
  };
}

function repairFailureForSubmission(
  prepared: PreparedWorkflowSubmission,
  submission: WorkflowSubmission,
  mutation: WorkflowArtifactMutation | undefined,
):
  | {
      signature: ReturnType<typeof buildWorkflowRepairSignature>;
      disposition: "continue" | "warning" | "manual-stop" | "hard-stop";
      reasonCode: string;
      consecutiveFailures: number;
      totalFailures: number;
      remainingFailures: number;
      overrideAccepted: boolean;
      automaticRepair?: NonNullable<
        ReturnType<typeof decideWorkflowRepair>["automaticRepair"]
      >;
      pendingDecision?: WorkflowRepairPendingDecision;
    }
  | undefined {
  if (
    isDecisionSubmission(submission) ||
    submission.status !== "failed" ||
    !prepared.node
  ) {
    return undefined;
  }
  const profile = prepared.verified.identity.durabilityProfile;
  if (
    !profile?.capabilities.includes("repair-policy") ||
    !profile.repairPolicy
  ) {
    return undefined;
  }
  const facts = repairFactsForSubmission(prepared, submission, mutation);
  const decision = decideWorkflowRepair({
    facts,
    history:
      prepared.verified.state.workflowRuntime?.repairEpisode?.history ?? [],
    policy: profile.repairPolicy,
    maxHistoryRecords: profile.bounds.repairHistoryCount,
  });
  let pendingDecision: WorkflowRepairPendingDecision | undefined;
  if (decision.disposition === "manual-stop") {
    const attempt = prepared.verified.state.workflowRuntime?.currentAttempt;
    if (!attempt) {
      throw new Error("Workflow repair stop requires a current Attempt");
    }
    const policy = normalizeWorkflowRepairPolicy(profile.repairPolicy);
    const failureRevision =
      (prepared.verified.state.workflowRuntime?.revision ?? 0) + 1;
    const decisionId = `workflow-repair-${decision.signature.signatureHash.slice(0, 24)}`;
    const actionId = `workflow-repair-decision-${sha256(
      JSON.stringify(
        stableValue({
          runId: prepared.verified.state.runId,
          attemptId: attempt.id,
          signatureHash: decision.signature.signatureHash,
          failureRevision,
        }),
      ),
    ).slice(0, 24)}`;
    pendingDecision = {
      schemaVersion: 1,
      decisionId,
      actionId,
      signatureHash: decision.signature.signatureHash,
      failureRevision,
      attemptId: attempt.id,
      stepId: attempt.stepId,
      nodeId: prepared.node,
      cycleId: attempt.cycleId,
      visitOrdinal: attempt.visitOrdinal,
      retryOrdinal: attempt.retryOrdinal + 1,
      choices: structuredClone(policy.allowedChoices),
      rationale: structuredClone(policy.rationale),
      reviewer: structuredClone(policy.reviewer),
    };
  }
  return {
    signature: decision.signature,
    disposition: decision.disposition,
    reasonCode: decision.reasonCode,
    consecutiveFailures: decision.consecutiveFailures,
    totalFailures: decision.totalFailures,
    remainingFailures: decision.remainingFailures,
    overrideAccepted: decision.overrideAccepted,
    ...(decision.automaticRepair
      ? { automaticRepair: decision.automaticRepair }
      : {}),
    ...(pendingDecision ? { pendingDecision } : {}),
  };
}

function repairFindings(state: RunState): WorkflowFinding[] {
  const episode = state.workflowRuntime?.repairEpisode;
  if (!episode?.signature) return [];
  if (episode.disposition === "warning") {
    return [
      repairStagnationWarningFinding(
        episode.signature.signatureHash,
        episode.consecutiveFailures,
        episode.remainingFailures,
      ),
    ];
  }
  if (episode.disposition === "manual-stop") {
    if (!episode.pendingDecision) {
      return [
        repairStagnationStopFinding(
          episode.signature.signatureHash,
          episode.consecutiveFailures,
          episode.remainingFailures,
          false,
        ),
      ];
    }
    return episode.reasonCode === "override-already-used"
      ? [repairOverrideExhaustedFinding(episode.signature.signatureHash)]
      : [
          repairStagnationStopFinding(
            episode.signature.signatureHash,
            episode.consecutiveFailures,
            episode.remainingFailures,
          ),
        ];
  }
  if (episode.disposition === "hard-stop") {
    return [repairIterationLimitFinding(episode.signature.signatureHash)];
  }
  return [];
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
  const gateContext: WorkflowGateContext = {
    execution: verified.identity,
    revision: verified.state.workflowRuntime?.revision ?? 0,
    repair: verified.state.workflowRuntime?.repairEpisode,
    finalization: verified.state.workflowRuntime?.finalization,
  };
  if (isWorkflowFinalizationAction(pending)) {
    validateFinalizationDecisionResponse(gateContext, pending, submission);
    return;
  }
  if (isWorkflowRepairAction(pending)) {
    validateRepairDecisionResponse(gateContext, pending, node, submission);
    return;
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
  if (submission.repair !== undefined) {
    throw new Error(
      "Repair decision fields are only valid for a repair action",
    );
  }
}

type WorkflowGateContext = Pick<
  WorkflowContinuation,
  "execution" | "revision" | "repair" | "finalization"
>;

function validateFinalizationDecisionResponse(
  context: WorkflowGateContext,
  pending: EngineAction & {
    finalization: WorkflowFinalizationPendingConfirmation;
  },
  submission: WorkflowDecisionSubmission,
): void {
  const finalization = pending.finalization;
  const stateFinalization = context.finalization;
  if (
    !stateFinalization ||
    stateFinalization.status !== "awaiting-confirmation" ||
    !stateFinalization.pendingConfirmation ||
    !sameStableValue(stateFinalization.pendingConfirmation, finalization)
  ) {
    throw new Error("Workflow finalization confirmation state is invalid");
  }
  if (
    submission.revision !== context.revision ||
    submission.nodeId !== null ||
    submission.attemptId !== null ||
    submission.cycleId !== null
  ) {
    throw new Error(
      "Workflow finalization confirmation context does not match the Run",
    );
  }
  validateDecisionExecution(submission, context.execution);
  if (
    submission.decisionId !== undefined &&
    submission.decisionId !== finalization.decisionId
  ) {
    throw new Error(
      "Workflow finalization decision id does not match the pending action",
    );
  }
  if (submission.choiceId !== "confirm" && submission.choiceId !== "cancel") {
    throw new Error("Workflow finalization choice is invalid");
  }
  if (submission.inputs && Object.keys(submission.inputs).length > 0) {
    throw new Error(
      "Workflow finalization confirmation does not accept inputs",
    );
  }
  if (
    submission.scope !== undefined ||
    submission.evidenceReferences !== undefined ||
    submission.repair !== undefined
  ) {
    throw new Error(
      "Workflow finalization confirmation does not accept extra scope",
    );
  }
  validateReviewer(submission.reviewer, finalization.reviewer);
  const input = submission.finalization;
  if (
    !input ||
    input.planHash !== finalization.planHash ||
    input.decisionId !== finalization.decisionId ||
    input.choiceId !== submission.choiceId ||
    input.contentSnapshotHash !== finalization.contentSnapshotHash ||
    !sameStableValue(
      [...(input.verificationReceiptIds ?? [])].sort((left, right) =>
        left.localeCompare(right),
      ),
      finalization.verificationReceiptIds,
    )
  ) {
    throw new Error("Workflow finalization confirmation is stale");
  }
  if (finalization.rationale.required && !submission.rationale) {
    throw new Error("Workflow finalization confirmation rationale is required");
  }
  if (
    submission.rationale !== undefined &&
    Buffer.byteLength(submission.rationale, "utf8") >
      (context.execution.durabilityProfile?.bounds.finalizationContentBytes ??
        64 * 1024)
  ) {
    throw new Error(
      "Workflow finalization confirmation rationale exceeds its bound",
    );
  }
}

function validateRepairDecisionResponse(
  context: WorkflowGateContext,
  pending: EngineAction & {
    repair: WorkflowRepairPendingDecision;
  },
  node: string | null,
  submission: WorkflowDecisionSubmission,
): void {
  const repair = pending.repair;
  const episode = context.repair;
  if (!episode || episode.pendingDecision === undefined) {
    throw new Error("Workflow repair decision state is missing");
  }
  if (
    submission.revision !== context.revision ||
    submission.nodeId !== repair.nodeId ||
    submission.attemptId !== repair.attemptId ||
    submission.cycleId !== repair.cycleId
  ) {
    throw new Error("Workflow repair decision context does not match the Run");
  }
  if (node !== repair.nodeId) {
    throw new Error("Workflow repair decision Node does not match the Run");
  }
  validateDecisionExecution(submission, context.execution);
  if (
    submission.decisionId !== undefined &&
    submission.decisionId !== repair.decisionId
  ) {
    throw new Error(
      "Workflow repair decision id does not match the pending action",
    );
  }
  const choice = repair.choices.find(
    (candidate) => candidate.id === submission.choiceId,
  );
  if (!choice) {
    throw new Error(
      `Workflow repair choice is not declared: ${submission.choiceId}`,
    );
  }
  if (submission.inputs && Object.keys(submission.inputs).length > 0) {
    throw new Error("Workflow repair decisions do not accept inputs");
  }
  if (
    submission.scope !== undefined ||
    submission.evidenceReferences !== undefined
  ) {
    throw new Error("Workflow repair decisions do not accept evidence scope");
  }
  validateReviewer(submission.reviewer, repair.reviewer);
  const policy = context.execution.durabilityProfile?.repairPolicy;
  if (!policy) throw new Error("Workflow repair decision policy is missing");
  const normalizedPolicy = normalizeWorkflowRepairPolicy(policy);
  const repairInput = submission.repair;
  if (
    repairInput !== undefined &&
    (!repairInput ||
      typeof repairInput !== "object" ||
      Array.isArray(repairInput))
  ) {
    throw new Error("Workflow repair input must be an object");
  }
  if (repairInput !== undefined) {
    const unknown = Object.keys(repairInput).find(
      (key) =>
        ![
          "expectedSignatureHash",
          "signatureHash",
          "rationale",
          "hypothesis",
          "summary",
        ].includes(key),
    );
    if (unknown)
      throw new Error(`Workflow repair input has unknown field: ${unknown}`);
    if (
      repairInput.expectedSignatureHash !== undefined &&
      repairInput.signatureHash !== undefined &&
      repairInput.expectedSignatureHash !== repairInput.signatureHash
    ) {
      throw new Error("Workflow repair input signature aliases disagree");
    }
    for (const [label, value] of [
      ["expectedSignatureHash", repairInput.expectedSignatureHash],
      ["signatureHash", repairInput.signatureHash],
      ["rationale", repairInput.rationale],
      ["hypothesis", repairInput.hypothesis],
      ["summary", repairInput.summary],
    ] as const) {
      if (value !== undefined && typeof value !== "string") {
        throw new Error(`Workflow repair input ${label} must be a string`);
      }
    }
  }
  const expectedSignature =
    repairInput?.expectedSignatureHash ?? repairInput?.signatureHash;
  if (
    expectedSignature !== undefined &&
    expectedSignature !== repair.signatureHash
  ) {
    throw new Error(
      "Workflow repair decision signature does not match the pending episode",
    );
  }
  const rawRationale = repairInput?.rationale ?? submission.rationale;
  const rawHypothesis =
    repairInput?.hypothesis ??
    repairInput?.summary ??
    (choice.id === "retry-with-new-approach"
      ? submission.rationale
      : undefined);
  const rationale =
    rawRationale === undefined
      ? undefined
      : normalizeWorkflowRepairText(rawRationale, "Workflow repair rationale");
  const hypothesis =
    rawHypothesis === undefined
      ? undefined
      : normalizeWorkflowRepairText(
          rawHypothesis,
          "Workflow repair hypothesis",
        );
  if (repair.rationale.required && !rationale) {
    throw new Error("Workflow repair decision rationale is required");
  }
  if (
    rationale !== undefined &&
    Buffer.byteLength(rationale, "utf8") >
      normalizedPolicy.maxOverrideRationaleBytes
  )
    throw new Error("Workflow repair rationale exceeds its bound");
  const overrideRequested =
    expectedSignature !== undefined || hypothesis !== undefined;
  if (!overrideRequested) return;
  if (choice.outcome !== "retry") {
    throw new Error("Workflow repair override must choose a retry outcome");
  }
  if (!normalizedPolicy.allowOneTimeOverride) {
    throw new Error("Workflow repair override is not allowed by policy");
  }
  if (episode.totalFailures >= normalizedPolicy.maxFailures) {
    throw new Error("Workflow repair hard stop cannot be overridden");
  }
  if (expectedSignature !== repair.signatureHash) {
    throw new Error(
      "Workflow repair override requires the current failure signature",
    );
  }
  if (!rationale || !hypothesis) {
    throw new Error(
      "Workflow repair override requires rationale and hypothesis",
    );
  }
  if (
    Buffer.byteLength(rationale, "utf8") >
      normalizedPolicy.maxOverrideRationaleBytes ||
    Buffer.byteLength(hypothesis, "utf8") >
      normalizedPolicy.maxOverrideRationaleBytes
  ) {
    throw new Error("Workflow repair override rationale exceeds its bound");
  }
  const overrideAlreadyUsed = episode.history.some(
    (record) =>
      record.kind === "override" &&
      record.signatureHash === repair.signatureHash,
  );
  if (overrideAlreadyUsed || episode.reasonCode === "override-already-used") {
    throw new Error(
      "Workflow repair override has already been used for this signature",
    );
  }
  const hypothesisHash = hashWorkflowRepairText(
    hypothesis,
    "Workflow repair hypothesis",
    normalizedPolicy.maxOverrideRationaleBytes,
  );
  if (
    episode.history.some(
      (record) =>
        record.signatureHash === repair.signatureHash &&
        ((record.kind === "override" &&
          record.hypothesisHash === hypothesisHash) ||
          (record.kind === "decision" &&
            record.hypothesisHash === hypothesisHash)),
    )
  ) {
    throw new Error(
      "Workflow repair override hypothesis is not materially new",
    );
  }
}

function engineOutcome(
  prepared: PreparedWorkflowSubmission,
  submission: WorkflowSubmission,
  artifactMutation?: WorkflowArtifactMutation,
  repairFailure?: ReturnType<typeof repairFailureForSubmission>,
  artifactReceipts: readonly WorkflowArtifactReceipt[] = [],
): import("../engine/types.js").ActionOutcome {
  if (isWorkflowFinalizationAction(prepared.pending)) {
    if (!isDecisionSubmission(submission) || !submission.finalization) {
      throw new Error(
        "Workflow finalization confirmation requires a decision submission",
      );
    }
    return {
      actionId: prepared.pending.id,
      status: "succeeded",
      summary: `Workflow finalization ${submission.choiceId}.`,
      kind: "decision",
      decisionId: prepared.pending.finalization.decisionId,
      choiceId: submission.choiceId as "confirm" | "cancel",
      reviewer: structuredClone(submission.reviewer),
      ...(submission.rationale !== undefined
        ? { rationale: submission.rationale }
        : {}),
      finalization: {
        ...structuredClone(submission.finalization),
        decisionId: prepared.pending.finalization.decisionId,
        choiceId: submission.choiceId as "confirm" | "cancel",
      },
    };
  }
  if (isWorkflowRepairAction(prepared.pending)) {
    if (!isDecisionSubmission(submission)) {
      throw new Error(
        "Workflow repair decision requires a decision submission",
      );
    }
    const choice = prepared.pending.repair.choices.find(
      (candidate) => candidate.id === submission.choiceId,
    );
    if (!choice) {
      throw new Error(
        `Workflow repair choice is not declared: ${submission.choiceId}`,
      );
    }
    return {
      actionId: prepared.pending.id,
      status: "succeeded",
      summary: `Repair decision ${prepared.pending.repair.decisionId}: ${choice.id}`,
      revision: submission.revision,
      nodeId: submission.nodeId,
      cycleId: submission.cycleId,
      ...(submission.attemptId !== null
        ? { attemptId: submission.attemptId }
        : {}),
      repairDecision: {
        decisionId: prepared.pending.repair.decisionId,
        signatureHash: prepared.pending.repair.signatureHash,
        choiceId: choice.id,
        outcome: choice.outcome,
        reviewer: structuredClone(submission.reviewer),
        ...((submission.repair?.rationale ?? submission.rationale) !== undefined
          ? { rationale: submission.repair?.rationale ?? submission.rationale }
          : {}),
        ...(submission.repair?.hypothesis ||
        submission.repair?.summary ||
        choice.id === "retry-with-new-approach"
          ? {
              hypothesis:
                submission.repair?.hypothesis ??
                submission.repair?.summary ??
                submission.rationale,
            }
          : {}),
      },
    };
  }
  if (!isDecisionSubmission(submission)) {
    const artifacts = artifactMutation
      ? artifactMutation.artifactPaths
      : submission.artifacts;
    const evidence = submission.evidence
      ? structuredClone(submission.evidence)
      : {};
    delete evidence.verification;
    delete evidence.verificationReceipts;
    delete evidence.verificationReceiptIds;
    delete evidence.artifactReceipts;
    if (artifactReceipts.length > 0)
      evidence.artifactReceipts = structuredClone(artifactReceipts);
    return {
      actionId: prepared.pending.id,
      status: submission.status,
      summary: submission.summary,
      ...(artifacts && Object.keys(artifacts).length > 0 ? { artifacts } : {}),
      ...(submission.state ? { state: submission.state } : {}),
      ...(Object.keys(evidence).length > 0 ? { evidence } : {}),
      ...(submission.routing ? { routing: submission.routing } : {}),
      ...(artifactMutation &&
      Object.keys(artifactMutation.selectedVersionIds).length > 0
        ? { artifactVersions: artifactMutation.selectedVersionIds }
        : submission.artifactVersions
          ? { artifactVersions: submission.artifactVersions }
          : {}),
      ...(artifactMutation &&
      (artifactMutation.verificationReceipts?.length ?? 0) > 0
        ? {
            verificationReceiptIds: artifactMutation.verificationReceipts!.map(
              (reference) => reference.receiptId,
            ),
          }
        : {}),
      ...(repairFailure ? { repairFailure } : {}),
      ...(submission.finalization
        ? { finalization: structuredClone(submission.finalization) }
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
    ...(submission.attemptId !== null
      ? { attemptId: submission.attemptId }
      : {}),
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
    ...(artifactMutation &&
    (artifactMutation.verificationReceipts?.length ?? 0) > 0
      ? {
          verificationReceiptIds: artifactMutation.verificationReceipts!.map(
            (reference) => reference.receiptId,
          ),
        }
      : {}),
    routing: {
      [decision.id]: choice.id,
      ...(choice.routing ?? {}),
    },
  };
}

async function receiptAttemptStartedAt(
  prepared: PreparedWorkflowSubmission,
): Promise<number | undefined> {
  const currentAttempt =
    prepared.verified.state.workflowRuntime?.currentAttempt;
  const protocol = prepared.verified.package.runtime!.protocol;
  const node = protocol.nodes.find(
    (candidate) => candidate.id === prepared.node,
  );
  if (
    !currentAttempt ||
    !node ||
    !node.outputSchemas.some((schemaId) =>
      protocol.outputSchemas.some(
        (schema) =>
          schema.id === schemaId &&
          schema.artifacts.some((artifact) => artifact.requireCurrentAttempt),
      ),
    )
  )
    return undefined;
  const trajectory = await readTrajectory(
    prepared.location.runRoot,
    prepared.verified.state.trajectoryRef,
    durabilityReadOptions(prepared.verified.state, "trajectoryBytes"),
  );
  const firstAction = trajectory.find(
    (event) =>
      event.type === "action_proposed" &&
      isRecord(event.data.action) &&
      event.data.action.attemptId === currentAttempt.id,
  );
  const timestamp = firstAction ? Date.parse(firstAction.timestamp) : NaN;
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

async function validateCompletion(
  prepared: PreparedWorkflowSubmission,
  submission: WorkflowSubmission,
  mutation?: WorkflowArtifactMutation,
): Promise<WorkflowCompletionValidation> {
  if (
    isDecisionSubmission(submission) ||
    submission.status !== "succeeded" ||
    !prepared.node
  ) {
    return { blockers: [], artifactReceipts: [] };
  }
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
  const satisfiedGuardrails = new Set(
    workflowNode.guardrails
      .filter((guardrail) => guardrail.verification !== undefined)
      .filter((guardrail) =>
        (mutation?.verificationReceipts ?? []).some(
          (receipt) =>
            receipt.status === "passed" &&
            receipt.requirementId ===
              (guardrail.verification?.id ?? guardrail.id),
        ),
      )
      .map((guardrail) => `guardrail:${workflowNode.id}.${guardrail.id}`),
  );
  const attemptStartedAt = await receiptAttemptStartedAt(prepared);
  const selectedIds = new Set(
    Object.values(mutation?.selectedVersionIds ?? {}),
  );
  const selectedReceipts = [
    ...(prepared.verified.state.workflowRuntime?.artifactVersions ?? []),
    ...(mutation?.versions ?? []),
  ]
    .filter((version) => selectedIds.has(version.id) && version.receipt)
    .map((version) => version.receipt!);
  const state = prepared.verified.state;
  const attempt = state.workflowRuntime?.currentAttempt;
  return validateSuccessfulSubmission(
    prepared.location.runRoot,
    prepared.verified.package.runtime!.protocol,
    workflowNode,
    plan,
    submission,
    {
      satisfiedGuardrails,
      externalRoots: state.workflowRuntime?.externalRoots,
      producer: attempt
        ? {
            runId: state.runId,
            nodeId: prepared.node,
            cycleId: attempt.cycleId,
            attemptId: attempt.id,
            actionId: prepared.pending.id,
            revision: state.workflowRuntime!.revision,
          }
        : undefined,
      attemptStartedAt,
      selectedReceipts:
        prepared.verified.package.runtime!.protocol.capabilities?.features.includes(
          "versioned-artifacts",
        )
          ? selectedReceipts
          : undefined,
    },
  );
}

function routeBlockers(
  prepared: PreparedWorkflowSubmission,
  submission: WorkflowSubmission,
  artifactMutation?: WorkflowArtifactMutation,
): string[] {
  const protocol = prepared.verified.package.runtime!.protocol;
  if (
    isWorkflowRepairAction(prepared.pending) ||
    isWorkflowFinalizationAction(prepared.pending)
  )
    return [];
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
      engineOutcome(prepared, submission, artifactMutation),
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
        attemptStartedAt: await receiptAttemptStartedAt(prepared),
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
    if (error instanceof RaceSafeReadError) {
      return { blockers: [error.message] };
    }
    throw error;
  }
}

function mergeWorkflowMutations(
  artifact: WorkflowArtifactMutation | undefined,
  verification: WorkflowArtifactMutation | undefined,
): WorkflowArtifactMutation | undefined {
  if (!artifact && !verification) return undefined;
  return {
    versions: [
      ...(artifact?.versions ?? []),
      ...(verification?.versions ?? []),
    ],
    selections: [
      ...(artifact?.selections ?? []),
      ...(verification?.selections ?? []),
    ],
    artifactPaths: {
      ...(artifact?.artifactPaths ?? {}),
      ...(verification?.artifactPaths ?? {}),
    },
    selectedVersionIds: {
      ...(artifact?.selectedVersionIds ?? {}),
      ...(verification?.selectedVersionIds ?? {}),
    },
    ...(verification?.verificationReceipts ||
    verification?.verificationReceiptRecords
      ? {
          verificationReceipts: [
            ...(artifact?.verificationReceipts ?? []),
            ...(verification.verificationReceipts ?? []),
          ],
          verificationReceiptRecords: [
            ...(artifact?.verificationReceiptRecords ?? []),
            ...(verification.verificationReceiptRecords ?? []),
          ],
        }
      : artifact?.verificationReceipts || artifact?.verificationReceiptRecords
        ? {
            verificationReceipts: [...(artifact.verificationReceipts ?? [])],
            verificationReceiptRecords: [
              ...(artifact.verificationReceiptRecords ?? []),
            ],
          }
        : {}),
  };
}

function prepareVerificationReceiptRecords(
  mutation: WorkflowArtifactMutation | undefined,
  profile: WorkflowDurabilityProfile | undefined,
): PrepareOutcomeMutation | undefined {
  const records = mutation?.verificationReceiptRecords ?? [];
  if (records.length === 0) return undefined;
  if (!profile) {
    throw new Error(
      verificationFailure("persistence requires a durability profile"),
    );
  }
  return async (_runRoot, _state, _outcome, overlay) => {
    if (!overlay) {
      throw new Error(verificationFailure("persistence requires a transition"));
    }
    const seen = new Set<string>();
    for (const receipt of records) {
      if (seen.has(receipt.receiptHash)) continue;
      seen.add(receipt.receiptHash);
      const reference = await stageWorkflowVerificationReceipt({
        runRoot: _runRoot,
        receipt,
        transition: overlay,
        profile,
      });
      const referenceIndex = mutation?.verificationReceipts?.findIndex(
        (candidate) => candidate.receiptHash === receipt.receiptHash,
      );
      if (referenceIndex !== undefined && referenceIndex >= 0) {
        mutation!.verificationReceipts![referenceIndex] = reference;
      }
    }
  };
}

function receiptReferencesEqual(
  left: WorkflowVerificationReceiptReference,
  right: WorkflowVerificationReceiptReference,
): boolean {
  return sameStableValue(left, right);
}

async function validateCurrentVerificationReceipt(
  prepared: PreparedWorkflowSubmission,
  requirement: ResolvedWorkflowVerificationRequirement,
  receipt: WorkflowVerificationReceipt,
  reference: WorkflowVerificationReceiptReference,
  scope: WorkflowDecisionScopeSnapshot,
  contentSnapshotHash: string | null,
): Promise<void> {
  const identity = prepared.verified.identity;
  const state = prepared.verified.state;
  const runtime = state.workflowRuntime;
  const attempt = runtime?.currentAttempt;
  const expectedKinds = requirement.kinds;
  if (
    !receiptReferencesEqual(
      workflowVerificationReceiptReference(receipt),
      reference,
    )
  ) {
    throw new Error(
      verificationFailure(
        `reference does not match stored receipt: ${receipt.receiptId}`,
      ),
    );
  }
  if (
    receipt.runId !== state.runId ||
    receipt.revision !== runtime?.revision ||
    receipt.actionId !== prepared.pending.id ||
    receipt.nodeId !== prepared.node ||
    receipt.cycleId !== (attempt?.cycleId ?? null) ||
    receipt.attemptId !== attempt?.id ||
    receipt.protocolHash !== identity.protocolHash ||
    receipt.packageHash !== identity.packageHash ||
    receipt.snapshotHash !== identity.snapshotHash ||
    !sameExecutionIdentity(receipt.execution, identity) ||
    receipt.requirementId !== requirement.id ||
    receipt.role !== requirement.role ||
    !expectedKinds.includes(receipt.receiptKind) ||
    receipt.scopeHash !== workflowScopeHash(scope) ||
    !sameStableValue(receipt.scope, scope) ||
    receipt.contentSnapshotHash !== contentSnapshotHash ||
    !sameStableValue(
      receipt.candidateArtifacts,
      scope.artifacts.map((entry) => ({
        artifactId: entry.id,
        versionId: entry.versionId,
        contentHash: entry.contentHash,
        producer: entry.producer,
      })),
    )
  ) {
    throw new Error(verificationFailure(`is stale: ${receipt.receiptId}`));
  }
  for (const artifact of scope.artifacts) {
    const version = runtime?.artifactVersions.find(
      (candidate) => candidate.id === artifact.versionId,
    );
    if (!version) {
      throw new Error(
        verificationFailure(
          `candidate artifact is missing: ${artifact.versionId}`,
        ),
      );
    }
    try {
      await validateWorkflowArtifactVersion(
        prepared.location.runRoot,
        prepared.verified.package.runtime!.protocol,
        version,
      );
    } catch (error) {
      throw new Error(
        verificationFailure(
          `candidate artifact is stale: ${artifact.versionId} (${error instanceof Error ? error.message : String(error)})`,
        ),
      );
    }
  }
}

function receiptIdsForRequirement(
  refs: readonly WorkflowVerificationReceiptReference[],
  requirement: ResolvedWorkflowVerificationRequirement,
  submittedIds: readonly string[],
): WorkflowVerificationReceiptReference[] {
  return refs.filter(
    (reference) =>
      reference.requirementId === requirement.id &&
      (submittedIds.includes(reference.receiptId) ||
        submittedIds.includes(reference.receiptHash)),
  );
}

async function verificationMutationForSubmission(
  prepared: PreparedWorkflowSubmission,
  submission: WorkflowSubmission,
  artifactMutation: WorkflowArtifactMutation | undefined,
): Promise<{ mutation?: WorkflowArtifactMutation; blockers: string[] }> {
  if (isWorkflowRepairAction(prepared.pending)) return { blockers: [] };
  const input = normalizedVerificationSubmission(submission);
  const submissionSucceeded =
    isDecisionSubmission(submission) || submission.status === "succeeded";
  if (input.proposals.length === 0 && input.receiptIds.length === 0) {
    const node = prepared.verified.package.runtime!.protocol.nodes.find(
      (candidate) => candidate.id === prepared.node,
    );
    const requirements = verificationRequirements(node);
    return {
      blockers: submissionSucceeded
        ? requirements.map((requirement) =>
            verificationFailure(`is required: ${requirement.id}`),
          )
        : [],
    };
  }
  const profile = prepared.verified.identity.durabilityProfile;
  if (!profile || !profile.capabilities.includes("verification-receipts")) {
    return {
      blockers: [
        verificationFailure(
          "submissions require the verification-receipts capability",
        ),
      ],
    };
  }
  const node = prepared.verified.package.runtime!.protocol.nodes.find(
    (candidate) => candidate.id === prepared.node,
  );
  const requirements = verificationRequirements(node);
  if (requirements.length === 0) {
    return {
      blockers: [
        verificationFailure("has no declared requirement for this Node"),
      ],
    };
  }
  const normalizedProposals: WorkflowVerificationReceiptProposal[] = [];
  const blockers: string[] = [];
  for (const proposal of input.proposals) {
    try {
      normalizedProposals.push(
        normalizeWorkflowVerificationProposal(proposal, profile),
      );
    } catch (error) {
      blockers.push(
        error instanceof Error
          ? error.message
          : verificationFailure(String(error)),
      );
    }
  }
  if (blockers.length > 0) return { blockers };
  const projectedState = workflowStateWithArtifactMutation(
    prepared.verified.state,
    artifactMutation,
  );
  const mutation: WorkflowArtifactMutation = {
    versions: [],
    selections: [],
    artifactPaths: {},
    selectedVersionIds: {},
    verificationReceipts: [],
    verificationReceiptRecords: [],
  };
  const usedProposalIndexes = new Set<number>();
  const usedReceiptIds = new Set<string>();
  for (const requirement of requirements) {
    const matchingProposals = normalizedProposals
      .map((proposal, index) => ({ proposal, index }))
      .filter(
        ({ proposal }) =>
          (proposal.requirementId === undefined ||
            proposal.requirementId === requirement.id) &&
          (proposal.role === undefined || proposal.role === requirement.role) &&
          requirement.kinds.includes(proposal.kind),
      );
    if (matchingProposals.length > 1) {
      blockers.push(
        verificationFailure(
          `has duplicate proposals for requirement: ${requirement.id}`,
        ),
      );
      continue;
    }
    const submittedRefs = receiptIdsForRequirement(
      prepared.verified.state.workflowRuntime?.verificationReceipts ?? [],
      requirement,
      input.receiptIds,
    );
    if (matchingProposals.length > 0 && submittedRefs.length > 0) {
      blockers.push(
        verificationFailure(
          `cannot submit a proposal and existing receipt together: ${requirement.id}`,
        ),
      );
      continue;
    }
    if (matchingProposals.length === 0 && submittedRefs.length > 1) {
      blockers.push(
        verificationFailure(
          `has multiple existing receipts for requirement: ${requirement.id}`,
        ),
      );
      continue;
    }
    if (matchingProposals.length === 0 && submittedRefs.length === 0) {
      if (submissionSucceeded) {
        blockers.push(verificationFailure(`is required: ${requirement.id}`));
      }
      continue;
    }
    let expectedScope: WorkflowDecisionScopeSnapshot;
    let expectedSnapshotHash: string | null;
    try {
      expectedScope = await captureWorkflowVerificationScope(
        prepared,
        requirement,
        projectedState,
      );
      expectedSnapshotHash = await currentWorkflowContentSnapshotBinding(
        prepared,
        projectedState,
      );
    } catch (error) {
      blockers.push(
        error instanceof Error
          ? error.message
          : verificationFailure(String(error)),
      );
      continue;
    }
    if (requirement.requireContentSnapshot && expectedSnapshotHash === null) {
      blockers.push(
        verificationFailure(`requires a content snapshot: ${requirement.id}`),
      );
      continue;
    }
    if (matchingProposals.length > 0) {
      const { proposal, index } = matchingProposals[0];
      usedProposalIndexes.add(index);
      if (
        proposal.requirementId !== undefined &&
        proposal.requirementId !== requirement.id
      ) {
        blockers.push(
          verificationFailure(
            `proposal requirement does not match: ${requirement.id}`,
          ),
        );
        continue;
      }
      if (proposal.role !== undefined && proposal.role !== requirement.role) {
        blockers.push(
          verificationFailure(
            `proposal role does not match: ${requirement.id}`,
          ),
        );
        continue;
      }
      try {
        workflowScopeSelectionMatches(expectedScope, proposal.scope);
        if (proposal.artifactVersions !== undefined) {
          for (const [requestedId, versionId] of Object.entries(
            proposal.artifactVersions,
          )) {
            const declaration = workflowArtifactDeclaration(
              prepared.verified.package.runtime!.protocol,
              requestedId,
            );
            const expected = expectedScope.artifacts.find(
              (reference) => reference.id === declaration.id,
            );
            if (!expected || expected.versionId !== versionId) {
              throw new Error(
                verificationFailure(
                  `candidate artifact version is stale: ${requestedId}`,
                ),
              );
            }
          }
        }
        if (
          proposal.contentSnapshotHash !== undefined &&
          proposal.contentSnapshotHash !== expectedSnapshotHash
        ) {
          throw new Error(
            verificationFailure(`content snapshot is stale: ${requirement.id}`),
          );
        }
        const receipt = createWorkflowVerificationReceipt(
          {
            proposal,
            requirementId: requirement.id,
            role: requirement.role,
            runId: prepared.verified.state.runId,
            revision: prepared.verified.state.workflowRuntime?.revision ?? 0,
            actionId: prepared.pending.id,
            nodeId: prepared.node!,
            cycleId:
              prepared.verified.state.workflowRuntime?.currentAttempt
                ?.cycleId ?? null,
            attemptId:
              prepared.verified.state.workflowRuntime?.currentAttempt?.id ?? "",
            execution: structuredClone(prepared.verified.identity),
            protocolHash: prepared.verified.identity.protocolHash,
            packageHash: prepared.verified.identity.packageHash,
            snapshotHash: prepared.verified.identity.snapshotHash,
            scope: expectedScope,
            contentSnapshotHash: expectedSnapshotHash,
          },
          profile,
        );
        const reference = workflowVerificationReceiptReference(receipt);
        mutation.verificationReceipts!.push(reference);
        mutation.verificationReceiptRecords!.push(receipt);
        if (submissionSucceeded && receipt.status !== "passed") {
          blockers.push(
            verificationFailure(
              `does not pass requirement ${requirement.id}: ${receipt.status}`,
            ),
          );
        }
      } catch (error) {
        blockers.push(
          error instanceof Error
            ? error.message
            : verificationFailure(String(error)),
        );
      }
      continue;
    }
    const reference = submittedRefs[0];
    for (const submittedId of input.receiptIds) {
      if (
        submittedId === reference.receiptId ||
        submittedId === reference.receiptHash
      ) {
        usedReceiptIds.add(submittedId);
      }
    }
    if (!profile.capabilities.includes("verification-receipts")) {
      blockers.push(
        verificationFailure(
          "reuse requires the verification-receipts capability",
        ),
      );
      continue;
    }
    let receipt: WorkflowVerificationReceipt | null;
    try {
      receipt = await readWorkflowVerificationReceipt(
        prepared.location.runRoot,
        reference.receiptHash,
        profile,
      );
      if (!receipt)
        throw new Error(
          verificationFailure(`is missing: ${reference.receiptId}`),
        );
      await validateCurrentVerificationReceipt(
        prepared,
        requirement,
        receipt,
        reference,
        expectedScope,
        expectedSnapshotHash,
      );
      mutation.verificationReceipts!.push(reference);
      if (submissionSucceeded && receipt.status !== "passed") {
        blockers.push(
          verificationFailure(
            `does not pass requirement ${requirement.id}: ${receipt.status}`,
          ),
        );
      }
    } catch (error) {
      blockers.push(
        error instanceof Error
          ? error.message
          : verificationFailure(String(error)),
      );
    }
  }
  for (const [index, proposal] of normalizedProposals.entries()) {
    if (!usedProposalIndexes.has(index)) {
      blockers.push(
        verificationFailure(
          `proposal does not match a declared requirement: ${proposal.requirementId ?? proposal.role ?? proposal.kind}`,
        ),
      );
    }
  }
  for (const receiptId of input.receiptIds) {
    if (!usedReceiptIds.has(receiptId)) {
      blockers.push(
        verificationFailure(
          `receipt reference does not match a declared requirement: ${receiptId}`,
        ),
      );
    }
  }
  const existingCount =
    prepared.verified.state.workflowRuntime?.verificationReceipts.length ?? 0;
  const newIds = new Set(
    mutation.verificationReceipts!.map((reference) => reference.receiptId),
  );
  const newCount = [...newIds].filter(
    (id) =>
      !(
        prepared.verified.state.workflowRuntime?.verificationReceipts ?? []
      ).some((reference) => reference.receiptId === id),
  ).length;
  if (
    profile.bounds.verificationReceiptCount !== undefined &&
    existingCount + newCount > profile.bounds.verificationReceiptCount
  ) {
    blockers.push(verificationFailure("count exceeds its configured bound"));
  }
  return {
    mutation: blockers.length === 0 ? mutation : mutation,
    blockers,
  };
}

function blockedContinuation(
  prepared: PreparedWorkflowSubmission,
  blockers: readonly string[],
): WorkflowContinuation {
  const projected = boundWorkflowFindings([
    ...blockers.map((blocker) =>
      findingFromBlocker(blocker, {
        actionId: prepared.pending.id,
        nodeId: prepared.node,
      }),
    ),
    ...repairFindings(prepared.verified.state),
  ]);
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
    completion: completionPlan(
      prepared.verified.package.runtime!.protocol,
      prepared.node,
    ),
    receiptOutputs: workflowReceiptOutputs(
      prepared.verified.package.runtime!.protocol,
      prepared.node,
      prepared.location.runRoot,
      prepared.verified.state.workflowRuntime?.externalRoots,
    ),
    execution: structuredClone(prepared.verified.identity),
    decisionReceipts: structuredClone(
      prepared.verified.state.workflowRuntime?.decisionReceipts ?? [],
    ),
    verificationReceipts: structuredClone(
      prepared.verified.state.workflowRuntime?.verificationReceipts ?? [],
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
    contentSnapshots: structuredClone(
      prepared.verified.state.workflowRuntime?.contentSnapshots ?? [],
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
    ...(prepared.verified.state.workflowRuntime?.repairEpisode
      ? {
          repair: boundedRepairEpisode(
            prepared.verified.state.workflowRuntime.repairEpisode,
          ),
        }
      : {}),
    ...(prepared.verified.state.workflowRuntime?.finalization
      ? {
          finalization: structuredClone(
            prepared.verified.state.workflowRuntime.finalization,
          ),
        }
      : {}),
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
    verified,
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
  // The journal may still be staging Run records. Only the immutable package
  // is needed to describe receipt outputs before recovery commits those records.
  const pkg = await readSkillSnapshot(
    location.runRoot,
    journal.execution.snapshotHash,
  );
  const base = continuation({ state, action, evals: [] }, journal.execution, {
    package: pkg,
    runRoot: location.runRoot,
  });
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

async function finalizationRecoveryRequiredContinuation(
  location: ResolvedWorkflowRunLocation,
  transaction: import("./finalization.js").WorkflowFinalizationTransaction,
  unknownPaths: readonly string[] = [],
): Promise<WorkflowContinuation> {
  const verified = await verifyStoredRun(location);
  return withAdditionalFindings(
    await continuationFromVerifiedRun(verified, location.runRoot),
    [
      recoveryRequiredFinding(
        verified.state.workflowRuntime?.revision ?? transaction.revision,
        verified.state.pending,
        ".badger/finalization/transaction.json",
      ),
      ...unknownPaths.map((unknownPath) =>
        findingFromBlocker(
          `Workflow finalization observed an unknown file identity: ${unknownPath}`,
          { path: unknownPath },
        ),
      ),
    ],
    "blocked",
  );
}

async function validateFinalizationEvidenceBindings(
  location: ResolvedWorkflowRunLocation,
  state: RunState,
  definition: WorkflowFinalizationDefinition,
  profile: WorkflowDurabilityProfile,
): Promise<void> {
  for (const receiptId of definition.requiredVerificationReceiptIds ?? []) {
    const reference = state.workflowRuntime?.verificationReceipts.find(
      (candidate) => candidate.receiptId === receiptId,
    );
    if (!reference) {
      throw new Error(
        `Workflow finalization verification receipt is missing: ${receiptId}`,
      );
    }
    if (reference.status !== "passed") {
      throw new Error(
        `Workflow finalization verification receipt is not passed: ${receiptId}`,
      );
    }
    const receipt = await readWorkflowVerificationReceipt(
      location.runRoot,
      reference.receiptHash,
      profile,
    );
    if (
      !receipt ||
      !sameStableValue(workflowVerificationReceiptReference(receipt), reference)
    ) {
      throw new Error(
        `Workflow finalization verification receipt is stale: ${receiptId}`,
      );
    }
  }
  if (definition.requireContentSnapshot === true) {
    const reference = state.workflowRuntime?.contentSnapshots?.at(-1);
    const policy = profile.snapshotPolicy;
    if (!reference || !policy) {
      throw new Error("Workflow finalization requires a content snapshot");
    }
    const snapshot = await readWorkflowContentSnapshot(
      location.runRoot,
      reference.hash,
      policy.limits.maxManifestBytes,
    );
    if (
      !snapshot ||
      hashWorkflowContentSnapshot(snapshot) !== reference.hash ||
      !reference.complete ||
      !snapshot.complete
    ) {
      throw new Error("Workflow finalization content snapshot is stale");
    }
  }
}

async function finalizationSubmissionBlockers(
  prepared: PreparedWorkflowSubmission,
  submission: WorkflowSubmission,
): Promise<string[]> {
  const definition = prepared.verified.package.runtime?.protocol.finalization;
  const profile = prepared.verified.identity.durabilityProfile;
  if (!definition || !profile) return [];
  if (isWorkflowFinalizationAction(prepared.pending)) {
    await validateFinalizationEvidenceBindings(
      prepared.location,
      prepared.verified.state,
      definition,
      profile,
    );
    const preview = await buildWorkflowFinalizationPreview({
      baseRoot: prepared.location.contentSnapshotRoot,
      state: prepared.verified.state,
      execution: prepared.verified.identity,
      definition,
      profile,
    });
    return preview.planHash === prepared.pending.finalization.planHash
      ? []
      : ["Workflow finalization preview is stale"];
  }
  if (
    !isDecisionSubmission(submission) &&
    submission.finalization?.planHash !== undefined
  ) {
    await validateFinalizationEvidenceBindings(
      prepared.location,
      prepared.verified.state,
      definition,
      profile,
    );
    const preview = await buildWorkflowFinalizationPreview({
      baseRoot: prepared.location.contentSnapshotRoot,
      state: prepared.verified.state,
      execution: prepared.verified.identity,
      definition,
      profile,
    });
    return preview.planHash === submission.finalization.planHash
      ? []
      : ["Workflow finalization preview is stale"];
  }
  return [];
}

export async function validateWorkflowSubmission(
  target: WorkflowRunTarget,
  submission: WorkflowSubmission,
): Promise<WorkflowContinuation> {
  return withStructuredRuntimeErrors(async () => {
    const location = resolveWorkflowRunLocation(target);
    const journal = await readWorkflowTransitionJournal(location.runRoot);
    if (journal) return recoveryRequiredContinuation(location, journal);
    const checkpointRecovery = await readWorkflowCheckpointRecoveryJournal(
      location.runRoot,
    );
    if (checkpointRecovery) {
      return checkpointRecoveryRequiredContinuation(
        location,
        checkpointRecovery,
      );
    }
    const profile = await durabilityProfileForLocation(location);
    if (usesWorkflowFinalization(profile)) {
      const transaction = await readWorkflowFinalizationTransaction(
        location.runRoot,
        profile!,
      );
      if (transaction) {
        return finalizationRecoveryRequiredContinuation(location, transaction);
      }
    }
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
    const artifact = await artifactMutationForSubmission(prepared, submission);
    if (artifact.blockers.length > 0) {
      return blockedContinuation(prepared, artifact.blockers);
    }
    const verification = await verificationMutationForSubmission(
      prepared,
      submission,
      artifact.mutation,
    );
    if (verification.blockers.length > 0) {
      return blockedContinuation(prepared, verification.blockers);
    }
    const mutation = mergeWorkflowMutations(
      artifact.mutation,
      verification.mutation,
    );
    const completion = await validateCompletion(prepared, submission, mutation);
    if (completion.blockers.length > 0) {
      return blockedContinuation(prepared, completion.blockers);
    }
    const routeFindings = routeBlockers(prepared, submission, mutation);
    if (routeFindings.length > 0) {
      return blockedContinuation(prepared, routeFindings);
    }
    const finalizationBlockers = await finalizationSubmissionBlockers(
      prepared,
      submission,
    );
    if (finalizationBlockers.length > 0) {
      return blockedContinuation(prepared, finalizationBlockers);
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
    ...(protocol.finalization
      ? { finalization: structuredClone(protocol.finalization) }
      : {}),
    decisionReceipts: boundProjectedLedger(
      projectedCurrent?.decisionReceipts ?? [],
    ),
    verificationReceipts: boundProjectedLedger(
      projectedCurrent?.verificationReceipts ?? [],
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
    contentSnapshots: boundProjectedLedger(
      projectedCurrent?.contentSnapshots ?? [],
    ),
    currentArtifactVersions: structuredClone(
      projectedCurrent?.currentArtifactVersions ?? {},
    ),
    findings: structuredClone(projectedCurrent?.findings ?? []),
    findingSummary: structuredClone(
      projectedCurrent?.findingSummary ?? emptyFindingSummary(),
    ),
    requiresUserDecision: projectedCurrent?.requiresUserDecision ?? false,
    ...(projectedCurrent?.repair
      ? { repair: boundedRepairEpisode(projectedCurrent.repair) }
      : {}),
    ...(projectedCurrent?.finalization
      ? { finalizationState: structuredClone(projectedCurrent.finalization) }
      : {}),
    continuation: projectedCurrent,
  };
}

async function resumeStoredRun(
  location: ResolvedWorkflowRunLocation,
  options: ResumeWorkflowRunOptions & {
    finalizationRecovery?: FinalizationRecovery;
    refreshFinalization?: boolean;
  },
  forceCheckpoint = false,
  persistCheckpoint = true,
): Promise<WorkflowContinuation> {
  const verified = await verifyStoredRun(location);
  const finalizationRefresh = options.refreshFinalization
    ? await refreshWorkflowFinalization(location, verified)
    : undefined;
  const resumeOptions: import("../engine/manual-run.js").ResumeManualRunOptions =
    {
      confirmations: options.confirmations ?? [],
      resolver: resolverForPackage(),
      prepareAction: prepareWorkflowActionForLocation(
        location,
        options.protectedSnapshotRoots,
      ),
      ...(options.finalizationRecovery
        ? { finalizationRecovery: options.finalizationRecovery }
        : {}),
      ...(finalizationRefresh ? { finalizationRefresh } : {}),
    };
  const result = await location.resume(resumeOptions);
  const changed =
    !sameStableValue(verified.state, result.state) ||
    !sameStableValue(verified.pending, result.action);
  if ((changed || forceCheckpoint) && persistCheckpoint) {
    await persistWorkflowCheckpoint(
      location,
      result.state,
      result.action,
      verified.package,
    );
  }
  if (result.state.status !== "completed") {
    return continuation(result, verified.identity, verified);
  }
  const trajectory = await readTrajectory(
    location.runRoot,
    result.state.trajectoryRef,
    durabilityReadOptions(result.state, "trajectoryBytes"),
  );
  return continuation(
    { ...result, evals: terminalEvaluationResults(trajectory) },
    verified.identity,
    verified,
  );
}

async function prepareWorkflowAction(
  runRoot: string,
  pkg: Awaited<ReturnType<typeof readSkillSnapshot>>,
  state: RunState,
  action: EngineAction,
  mutationOverlay?: EngineRunMutationOverlay,
  snapshotRoot = runRoot,
  protectedSnapshotRoots: readonly string[] = [],
): Promise<Awaited<ReturnType<PreparePendingAction>>> {
  const profile = state.runtimeIdentity?.durabilityProfile;
  let snapshotRuntimeState: RunState["workflowRuntime"];
  try {
    if (
      usesWorkflowContentSnapshots(profile) &&
      state.workflowRuntime &&
      (state.workflowRuntime.contentSnapshots?.length ?? 0) === 0
    ) {
      if (!mutationOverlay) {
        throw new Error(
          "Workflow content snapshot persistence requires a transition",
        );
      }
      const snapshotPolicy = profile?.snapshotPolicy;
      if (!snapshotPolicy) {
        throw new Error(
          "Workflow content snapshot capability has no snapshot policy",
        );
      }
      const manifest = await captureWorkflowContentSnapshot({
        root: snapshotRoot,
        policy: snapshotPolicy,
        protectedRoots: protectedSnapshotRoots,
      });
      const reference = await stageWorkflowContentSnapshot({
        runRoot,
        manifest,
        transition: mutationOverlay,
      });
      state.workflowRuntime.contentSnapshots ??= [];
      state.workflowRuntime.contentSnapshots.push(reference);
      snapshotRuntimeState = structuredClone(state.workflowRuntime);
    }
    const preparedAction = await captureWorkflowDecisionScope(
      runRoot,
      pkg,
      state,
      action,
    );
    return {
      action: preparedAction,
      ...(snapshotRuntimeState
        ? { workflowRuntime: snapshotRuntimeState }
        : {}),
    };
  } catch (error) {
    if (error instanceof WorkflowDecisionScopeError) {
      return {
        action: null,
        reason: error.message,
        ...(snapshotRuntimeState
          ? { workflowRuntime: snapshotRuntimeState }
          : {}),
      };
    }
    throw error;
  }
}

function prepareWorkflowActionForLocation(
  location: ResolvedWorkflowRunLocation,
  protectedSnapshotRoots: readonly string[] = [],
): PreparePendingAction {
  return (runRoot, pkg, state, action, mutationOverlay) =>
    prepareWorkflowAction(
      runRoot,
      pkg,
      state,
      action,
      mutationOverlay,
      location.contentSnapshotRoot,
      protectedSnapshotRoots,
    );
}

function workflowFinalizationConfirmationAction(
  preview: WorkflowFinalizationPreview,
  sourceActionId: string,
  currentRevision = preview.revision,
): EngineAction {
  const decisionId = `workflow-finalization-${preview.planHash.slice(0, 24)}`;
  const actionId = `workflow-finalization-confirm-${sha256(
    JSON.stringify(
      stableValue({
        runId: preview.runId,
        planHash: preview.planHash,
        revision: preview.revision,
        currentRevision,
      }),
    ),
  ).slice(0, 24)}`;
  const pending: WorkflowFinalizationPendingConfirmation = {
    schemaVersion: 1,
    kind: "workflow-finalization-confirmation",
    decisionId,
    actionId,
    sourceActionId,
    planHash: preview.planHash,
    revision: currentRevision,
    planRevision: preview.revision,
    contentSnapshotHash: preview.contentSnapshotHash,
    verificationReceiptIds: [...preview.verificationReceiptIds],
    reviewer: structuredClone(preview.confirmation.reviewer!),
    rationale: structuredClone(preview.confirmation.rationale!),
  };
  return {
    id: actionId,
    stepId: null,
    type: "ask_user",
    decisionId,
    question: "Review and confirm the declared local finalization plan.",
    choices: [
      { id: "confirm", label: "Apply finalization" },
      { id: "cancel", label: "Cancel finalization" },
    ],
    requiredInputs: { type: "object", fields: [] },
    rationale: structuredClone(preview.confirmation.rationale!),
    reviewer: structuredClone(preview.confirmation.reviewer!),
    finalization: pending,
  };
}

function prepareWorkflowFinalizationForLocation(
  location: ResolvedWorkflowRunLocation,
  definition: WorkflowFinalizationDefinition,
  profile: WorkflowDurabilityProfile,
  execution: WorkflowExecutionIdentity,
): PrepareFinalizationOutcome {
  return async (_runRoot, before, outcome, advanced, pending) => {
    const runtime = advanced.workflowRuntime;
    if (!runtime)
      throw new Error("Workflow finalization requires WorkflowRuntime state");

    if (outcome.finalization && isWorkflowFinalizationAction(pending)) {
      await validateFinalizationEvidenceBindings(
        location,
        before,
        definition,
        profile,
      );
      const pendingConfirmation =
        before.workflowRuntime?.finalization?.pendingConfirmation;
      if (!pendingConfirmation || !isWorkflowFinalizationAction(pending)) {
        throw new Error("Workflow finalization confirmation state is missing");
      }
      const plan = await buildWorkflowFinalizationPreview({
        baseRoot: location.contentSnapshotRoot,
        state: before,
        execution,
        definition,
        profile,
      });
      if (plan.planHash !== pendingConfirmation.planHash) {
        throw new Error("Workflow finalization preview is stale");
      }
      const choiceId = outcome.finalization.choiceId;
      if (choiceId === "cancel") {
        return {
          state: {
            ...advanced,
            status: "blocked",
            currentStep: null,
            workflowRuntime: {
              ...runtime,
              finalization: {
                schemaVersion: 1,
                status: "rolled-back",
                planHash: pendingConfirmation.planHash,
                revision: runtime.revision,
                sourceActionId: pendingConfirmation.sourceActionId,
                planRevision: pendingConfirmation.planRevision,
                confirmationActionId: pending.id,
                confirmationCount:
                  (before.workflowRuntime?.finalization?.confirmationCount ??
                    0) + 1,
              },
            },
          },
          action: null,
          reason: "Workflow finalization was cancelled",
        };
      }
      if (choiceId !== "confirm") {
        throw new Error("Workflow finalization choice is invalid");
      }
      if (!outcome.reviewer) {
        throw new Error(
          "Workflow finalization confirmation reviewer is missing",
        );
      }
      const confirmation: WorkflowFinalizationConfirmationRecord = {
        decisionId: pendingConfirmation.decisionId,
        actionId: pending.id,
        sourceActionId: pendingConfirmation.sourceActionId,
        planHash: pendingConfirmation.planHash,
        revision: before.workflowRuntime?.revision ?? 0,
        choiceId: "confirm",
        reviewer: {
          subject: outcome.reviewer.subject,
          authorities: [...outcome.reviewer.authorities].sort((left, right) =>
            left.localeCompare(right),
          ),
        },
        rationaleHash:
          outcome.rationale === undefined
            ? null
            : sha256(outcome.rationale.trim()),
        confirmedAt: new Date().toISOString(),
      };
      const applied = await applyWorkflowFinalization({
        runRoot: location.runRoot,
        baseRoot: location.contentSnapshotRoot,
        profile,
        plan,
        definition,
        execution,
        sourceActionId: pendingConfirmation.sourceActionId,
        resultingRevision: runtime.revision,
        confirmation,
      });
      const receipt = workflowFinalizationReceiptReference(applied.receipt);
      const rolledBack = applied.status === "rolled-back";
      return {
        state: {
          ...advanced,
          status: rolledBack ? "blocked" : "completed",
          currentStep: null,
          workflowRuntime: {
            ...runtime,
            finalization: {
              schemaVersion: 1,
              status: rolledBack ? "rolled-back" : "committed",
              planHash: pendingConfirmation.planHash,
              revision: runtime.revision,
              sourceActionId: pendingConfirmation.sourceActionId,
              planRevision: pendingConfirmation.planRevision,
              confirmationActionId: pending.id,
              confirmationCount:
                (before.workflowRuntime?.finalization?.confirmationCount ?? 0) +
                1,
              transactionId: applied.transaction.transactionId,
              receipt,
            },
          },
        },
        action: null,
        ...(rolledBack
          ? { reason: "Workflow finalization was rolled back" }
          : {}),
      };
    }

    if (advanced.status !== "completed" || definition.operations.length === 0) {
      return undefined;
    }
    await validateFinalizationEvidenceBindings(
      location,
      before,
      definition,
      profile,
    );
    const plan = await buildWorkflowFinalizationPreview({
      baseRoot: location.contentSnapshotRoot,
      state: before,
      execution,
      definition,
      profile,
    });
    if (
      outcome.finalization?.planHash !== undefined &&
      outcome.finalization.planHash !== plan.planHash
    ) {
      throw new Error("Workflow finalization preview is stale");
    }
    if (!plan.requiresConfirmation) {
      throw new Error("Workflow finalization confirmation is required");
    }
    const action = workflowFinalizationConfirmationAction(
      plan,
      pending.id,
      runtime.revision,
    );
    const finalization: WorkflowFinalizationState = {
      schemaVersion: 1,
      status: "awaiting-confirmation",
      planHash: plan.planHash,
      revision: runtime.revision,
      sourceActionId: pending.id,
      planRevision: plan.revision,
      pendingConfirmation: action.finalization,
    };
    return {
      state: {
        ...advanced,
        status: "waiting",
        pending: action.id,
        currentStep: null,
        workflowRuntime: { ...runtime, finalization },
      },
      action,
    };
  };
}

async function clearFinalizationAfterResult(
  location: ResolvedWorkflowRunLocation,
  result: ManualRunResult,
): Promise<void> {
  const profile = result.state.runtimeIdentity?.durabilityProfile;
  const finalization = result.state.workflowRuntime?.finalization;
  if (
    !usesWorkflowFinalization(profile) ||
    !finalization?.transactionId ||
    (finalization.status !== "committed" &&
      finalization.status !== "rolled-back")
  ) {
    return;
  }
  await clearWorkflowFinalizationTransaction(
    location.runRoot,
    profile!,
    location.contentSnapshotRoot,
  );
}

async function refreshWorkflowFinalization(
  location: ResolvedWorkflowRunLocation,
  verified: VerifiedWorkflowRun,
): Promise<FinalizationRefresh | undefined> {
  const pending = verified.pending;
  if (!isWorkflowFinalizationAction(pending)) return undefined;
  const definition = verified.package.runtime?.protocol.finalization;
  const profile = verified.identity.durabilityProfile;
  if (!definition || !profile) {
    throw new Error("Workflow finalization declaration is missing");
  }
  await validateFinalizationEvidenceBindings(
    location,
    verified.state,
    definition,
    profile,
  );
  const preview = await buildWorkflowFinalizationPreview({
    baseRoot: location.contentSnapshotRoot,
    state: verified.state,
    execution: verified.identity,
    definition,
    profile,
  });
  if (preview.planHash === pending.finalization.planHash) return undefined;
  const runtime = verified.state.workflowRuntime;
  if (!runtime) {
    throw new Error("Workflow finalization requires WorkflowRuntime state");
  }
  const action = workflowFinalizationConfirmationAction(
    preview,
    pending.finalization.sourceActionId,
    runtime.revision,
  );
  if (!action.finalization) {
    throw new Error("Workflow finalization refresh action is incomplete");
  }
  return {
    action,
    state: {
      ...verified.state,
      pending: action.id,
      status: "waiting",
      currentStep: null,
      workflowRuntime: {
        ...runtime,
        finalization: {
          schemaVersion: 1,
          status: "awaiting-confirmation",
          planHash: preview.planHash,
          revision: runtime.revision,
          sourceActionId: pending.finalization.sourceActionId,
          planRevision: preview.revision,
          ...(runtime.finalization?.confirmationCount
            ? {
                confirmationCount: runtime.finalization.confirmationCount,
                confirmationActionId: runtime.finalization.confirmationActionId,
              }
            : {}),
          pendingConfirmation: action.finalization,
        },
      },
    },
  };
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
    if (isWorkflowFinalizationAction(action)) {
      const finalization = state.workflowRuntime?.finalization;
      if (
        !finalization ||
        finalization.status !== "awaiting-confirmation" ||
        !finalization.pendingConfirmation ||
        !sameStableValue(
          finalization.pendingConfirmation,
          action.finalization,
        ) ||
        state.currentStep !== null ||
        action.stepId !== null ||
        action.attemptId !== undefined ||
        action.cycleId !== undefined
      ) {
        throw new Error(
          "WorkflowRuntime pending finalization confirmation identity is invalid",
        );
      }
      return action;
    }
    if (isWorkflowRepairAction(action)) {
      const pendingRepair =
        state.workflowRuntime?.repairEpisode?.pendingDecision;
      const episode = state.workflowRuntime?.repairEpisode;
      const latestFailure = [...(episode?.history ?? [])]
        .reverse()
        .find((record) => record.kind === "failure");
      const policy = identity.durabilityProfile?.repairPolicy;
      const normalizedPolicy = policy
        ? normalizeWorkflowRepairPolicy(policy)
        : undefined;
      if (
        !pendingRepair ||
        !episode ||
        !sameStableValue(action.repair, pendingRepair) ||
        pendingRepair.stepId !== action.stepId ||
        state.currentStep !== action.stepId ||
        identity.nodeToStep[pendingRepair.nodeId] !== pendingRepair.stepId ||
        pendingRepair.failureRevision !== state.workflowRuntime?.revision ||
        latestFailure?.revision !== pendingRepair.failureRevision ||
        pendingRepair.signatureHash !== episode.signature?.signatureHash ||
        !normalizedPolicy ||
        !sameStableValue(
          pendingRepair.choices,
          normalizedPolicy.allowedChoices,
        ) ||
        !sameStableValue(pendingRepair.rationale, normalizedPolicy.rationale) ||
        !sameStableValue(pendingRepair.reviewer, normalizedPolicy.reviewer)
      ) {
        throw new Error(
          "WorkflowRuntime pending repair decision identity is invalid",
        );
      }
      return action;
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

class WorkflowCheckpointRecoveryBlockedError extends Error {
  readonly findings: WorkflowFinding[];
  readonly finding: WorkflowFinding;

  constructor(findings: readonly WorkflowFinding[]) {
    const projected = boundWorkflowFindings(findings).findings;
    const finding = projected[0];
    super(finding?.message ?? "Workflow checkpoint recovery is blocked");
    this.name = "WorkflowCheckpointRecoveryBlockedError";
    this.findings = projected;
    this.finding =
      finding ??
      checkpointInvalidFinding(
        "Workflow checkpoint recovery is blocked.",
        WORKFLOW_CHECKPOINT_INDEX_PATH,
      );
  }
}

class WorkflowCheckpointRecoveryPendingError extends Error {
  readonly finding: WorkflowFinding;

  constructor() {
    const finding = recoveryRequiredFinding(
      undefined,
      undefined,
      ".badger/checkpoint-recovery-journal.json",
    );
    super(finding.message);
    this.name = "WorkflowCheckpointRecoveryPendingError";
    this.finding = finding;
  }
}

async function checkpointBlockedContinuation(
  location: ResolvedWorkflowRunLocation,
  findings: readonly WorkflowFinding[],
  fallback?: WorkflowCheckpointVerification,
): Promise<WorkflowContinuation> {
  try {
    const verified = await verifyStoredRun(location);
    return withAdditionalFindings(
      await continuationFromVerifiedRun(verified, location.runRoot),
      findings,
      "blocked",
    );
  } catch (error) {
    if (!fallback) throw error;
    return withAdditionalFindings(
      continuation(
        { state: fallback.state, action: fallback.pending, evals: [] },
        fallback.identity,
        { package: fallback.package, runRoot: location.runRoot },
      ),
      findings,
      "blocked",
    );
  }
}

function throwCheckpointRecoveryBlocked(
  findings: readonly WorkflowFinding[],
): never {
  throw new WorkflowCheckpointRecoveryBlockedError(findings);
}

async function recoverCheckpointAwareRun(
  location: ResolvedWorkflowRunLocation,
  options: ResumeWorkflowRunOptions & {
    finalizationRecovery?: FinalizationRecovery;
  },
  forceCheckpoint: boolean,
): Promise<WorkflowContinuation> {
  const profile = await durabilityProfileForLocation(location);
  if (!profile || !usesWorkflowCheckpoints(profile)) {
    return resumeStoredRun(location, options, forceCheckpoint);
  }
  const checkpointRecovery = await recoverWorkflowCheckpoint(
    location.runRoot,
    profile,
  );
  if (checkpointRecovery.status === "blocked") {
    return checkpointBlockedContinuation(location, [
      checkpointHistoryAmbiguousFinding(
        `Workflow checkpoint restoration has ambiguous records: ${checkpointRecovery.unknownPaths?.join(", ") ?? "unknown"}.`,
        checkpointRecovery.unknownPaths?.[0],
      ),
    ]);
  }
  const checkpointChanged =
    forceCheckpoint || checkpointRecovery.status === "recovered";
  let persistedState: RunState | null = null;
  let persistedExecution: WorkflowExecutionIdentity | undefined;
  try {
    persistedState = await location.readState();
    if (persistedState?.runtimeIdentity) {
      persistedExecution = identityFromState(persistedState);
    }
  } catch {
    persistedState = null;
  }
  let verified: VerifiedWorkflowRun | undefined;
  let headError: unknown;
  let headVerified = false;
  try {
    verified = await verifyStoredRun(location);
  } catch (error) {
    headError = error;
  }
  if (verified) {
    try {
      await verifyWorkflowCheckpointHead({
        runRoot: location.runRoot,
        state: verified.state,
        pending: verified.pending,
        identity: verified.identity,
        package: verified.package,
        profile,
      });
      headVerified = true;
    } catch (error) {
      headError = error;
    }
  }

  let inspections: WorkflowCheckpointInspection[] = [];
  let auditFindings: WorkflowFinding[] = [];
  let checkpointIndexReadable = true;
  try {
    inspections = await inspectWorkflowCheckpointCandidates(
      location.runRoot,
      profile,
      verified
        ? {
            expectedRunId: verified.state.runId,
            expectedExecution: verified.identity,
          }
        : persistedState
          ? {
              expectedRunId: persistedState.runId,
              ...(persistedExecution
                ? { expectedExecution: persistedExecution }
                : {}),
            }
          : location.runId
            ? { expectedRunId: location.runId }
            : {},
    );
    auditFindings = checkpointFindings(inspections, "warning");
  } catch (error) {
    checkpointIndexReadable = false;
    auditFindings = [checkpointIndexFinding(error, "warning")];
  }

  const verifiedCandidates = inspections
    .filter(
      (
        inspection,
      ): inspection is WorkflowCheckpointInspection & {
        verification: WorkflowCheckpointVerification;
      } => inspection.verification !== undefined,
    )
    .sort(
      (left, right) =>
        right.verification.manifest.revision -
          left.verification.manifest.revision ||
        left.entry.recordHash.localeCompare(right.entry.recordHash),
    );

  if (verified) {
    if (headError && headVerified === false) {
      return checkpointBlockedContinuation(location, [
        checkpointInvalidFinding(
          `Workflow checkpoint authoritative-head verification failed: ${
            headError instanceof Error ? headError.message : String(headError)
          }`,
          ".badger/checkpoints/index.json",
        ),
        ...auditFindings,
      ]);
    }
    const currentRevision = verified.state.workflowRuntime?.revision ?? 0;
    const newerCheckpoint = verifiedCandidates.find(
      (inspection) =>
        inspection.verification.manifest.revision > currentRevision,
    );
    if (newerCheckpoint) {
      return checkpointBlockedContinuation(location, [
        checkpointHistoryAmbiguousFinding(
          `Workflow checkpoint revision ${newerCheckpoint.verification.manifest.revision} is newer than the authoritative Run head revision ${currentRevision}; recovery will not rewind or discard accepted history.`,
          ".badger/checkpoints/index.json",
        ),
        ...auditFindings,
      ]);
    }
    const currentTrajectory = await readOptionalEngineRunText(
      location.runRoot,
      verified.state.trajectoryRef,
      profile.bounds.trajectoryBytes,
      "Workflow checkpoint current trajectory",
    );
    const headCheckpoint = inspections.some(
      (inspection) =>
        inspection.verification !== undefined &&
        inspection.verification.manifest.revision ===
          (verified.state.workflowRuntime?.revision ?? 0) &&
        sameStableValue(inspection.verification.state, verified.state) &&
        sameStableValue(inspection.verification.pending, verified.pending) &&
        currentTrajectory === inspection.verification.contents.trajectory,
    );
    const result = await resumeStoredRun(
      location,
      options,
      checkpointChanged ||
        (headVerified && checkpointIndexReadable && !headCheckpoint),
      headVerified,
    );
    return withAdditionalFindings(result, auditFindings);
  }

  const candidates = verifiedCandidates;
  if (candidates.length === 0) {
    throwCheckpointRecoveryBlocked([
      ...auditFindings,
      checkpointInvalidFinding(
        `No completely verified checkpoint can restore the Run: ${
          headError instanceof Error ? headError.message : String(headError)
        }`,
        ".badger/run-state.json",
      ),
    ]);
  }
  const selected = candidates[0].verification;
  try {
    const restored = await restoreWorkflowCheckpoint(
      location.runRoot,
      profile,
      selected,
    );
    if (restored.status === "blocked") {
      throw new Error(
        `Workflow checkpoint history is ambiguous: ${restored.unknownPaths?.join(", ") ?? "unknown"}`,
      );
    }
  } catch (error) {
    return checkpointBlockedContinuation(
      location,
      [
        ...auditFindings,
        checkpointHistoryAmbiguousFinding(
          error instanceof Error ? error.message : String(error),
          ".badger/trajectory.jsonl",
        ),
      ],
      selected,
    );
  }
  const recovered = await verifyStoredRun(location);
  await persistWorkflowCheckpoint(
    location,
    recovered.state,
    recovered.pending,
    recovered.package,
  );
  return withAdditionalFindings(
    await continuationFromVerifiedRun(recovered, location.runRoot),
    auditFindings,
  );
}

export function createWorkflowRuntime(): WorkflowRuntime {
  return {
    async startRequirements(protocol) {
      return withStructuredRuntimeErrors(async () => {
        const compiled = await compileWorkflow(protocol);
        return workflowStartRequirements(compiled.package.runtime!.protocol);
      });
    },
    listRuns: listWorkflowRuns,
    executionIdentity: verifyWorkflowProtocol,
    inspect: inspectWorkflowRun,
    projectState: projectWorkflowState,
    readReport: readWorkflowRunReport,

    async start(
      options: StartWorkflowRunOptions,
    ): Promise<WorkflowContinuation> {
      return withStructuredRuntimeErrors(async () => {
        const resolved = resolveWorkflowStartLocation(options);
        const compiled = await compileWorkflow(options.protocol);
        const revisioned = compiled.package.runtime?.capabilityVersion === 3;
        // The compiler admits external roots only with revisioned Attempts,
        // so the binding always has WorkflowRuntime state to live in.
        const externalRoots = await bindWorkflowExternalRoots(
          options.protocol.outputSchemas,
          options.externalRoots,
        );
        await resolved.location.prepareStart();
        return withWorkflowRunLock(
          resolved.location,
          "workflow.start",
          compiled.identity.durabilityProfile,
          async () => {
            if (usesWorkflowRunLock(compiled.identity.durabilityProfile)) {
              const journal = await readWorkflowTransitionJournal(
                resolved.location.runRoot,
              );
              if (journal)
                throw new WorkflowTransitionJournalPendingError(journal);
            }
            if (usesWorkflowFinalization(compiled.identity.durabilityProfile)) {
              const transaction = await readWorkflowFinalizationTransaction(
                resolved.location.runRoot,
                compiled.identity.durabilityProfile!,
              );
              if (transaction) {
                throw new WorkflowFinalizationTransactionPendingError(
                  transaction,
                );
              }
            }
            if (usesWorkflowCheckpoints(compiled.identity.durabilityProfile)) {
              const checkpointRecovery =
                await readWorkflowCheckpointRecoveryJournal(
                  resolved.location.runRoot,
                );
              if (checkpointRecovery) {
                throw new WorkflowCheckpointRecoveryPendingError();
              }
            }
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
                      verificationReceipts: [],
                      artifactVersions: [],
                      artifactSelections: [],
                      ...(externalRoots ? { externalRoots } : {}),
                      ...(usesWorkflowContentSnapshots(
                        compiled.identity.durabilityProfile,
                      )
                        ? { contentSnapshots: [] }
                        : {}),
                      ...(compiled.identity.durabilityProfile?.capabilities.includes(
                        "repair-policy",
                      )
                        ? {
                            repairEpisode: {
                              schemaVersion: 1 as const,
                              history: [],
                              signature: null,
                              disposition: null,
                              reasonCode: null,
                              consecutiveFailures: 0,
                              totalFailures: 0,
                              remainingFailures: normalizeWorkflowRepairPolicy(
                                compiled.identity.durabilityProfile
                                  .repairPolicy!,
                              ).maxFailures,
                            },
                          }
                        : {}),
                    },
                  }
                : {}),
              prepareAction: prepareWorkflowActionForLocation(
                resolved.location,
                options.protectedSnapshotRoots,
              ),
            });
            if (result.state.skillHash !== compiled.identity.packageHash) {
              throw new Error(
                "WorkflowRuntime snapshot identity was not persisted",
              );
            }
            const next = continuation(
              result,
              {
                ...compiled.identity,
                snapshotHash: result.state.skillHash,
              },
              { package: compiled.package, runRoot: resolved.location.runRoot },
            );
            await persistWorkflowCheckpoint(
              resolved.location,
              result.state,
              result.action,
              compiled.package,
            );
            return next;
          },
        );
      });
    },

    async resume(
      target: WorkflowRunTarget,
      options: ResumeWorkflowRunOptions = {},
    ): Promise<WorkflowContinuation> {
      return withStructuredRuntimeErrors(async () => {
        const location = resolveWorkflowRunLocation(target);
        const profile = await durabilityProfileForLocation(location);
        return withWorkflowRunLock(
          location,
          "workflow.resume",
          profile,
          async () => {
            const journal = await readWorkflowTransitionJournal(
              location.runRoot,
            );
            if (journal) return recoveryRequiredContinuation(location, journal);
            if (profile?.capabilities.includes("transactional-finalization")) {
              const transaction = await readWorkflowFinalizationTransaction(
                location.runRoot,
                profile,
              );
              if (transaction) {
                return finalizationRecoveryRequiredContinuation(
                  location,
                  transaction,
                );
              }
            }
            const checkpointRecovery =
              await readWorkflowCheckpointRecoveryJournal(location.runRoot);
            if (checkpointRecovery) {
              return checkpointRecoveryRequiredContinuation(
                location,
                checkpointRecovery,
              );
            }
            return resumeStoredRun(location, {
              ...options,
              refreshFinalization: true,
            });
          },
          {
            onBlocked: (error) => lockBlockedContinuation(location, error),
          },
        );
      });
    },

    async submit(
      target: WorkflowRunTarget,
      submission: WorkflowSubmission,
    ): Promise<WorkflowContinuation> {
      return withStructuredRuntimeErrors(async () => {
        const location = resolveWorkflowRunLocation(target);
        const profile = await durabilityProfileForLocation(location);
        return withWorkflowRunLock(
          location,
          "workflow.submit",
          profile,
          async () => {
            const journal = await readWorkflowTransitionJournal(
              location.runRoot,
            );
            if (journal) return recoveryRequiredContinuation(location, journal);
            if (profile?.capabilities.includes("transactional-finalization")) {
              const transaction = await readWorkflowFinalizationTransaction(
                location.runRoot,
                profile,
              );
              if (transaction) {
                return finalizationRecoveryRequiredContinuation(
                  location,
                  transaction,
                );
              }
            }
            const checkpointRecovery =
              await readWorkflowCheckpointRecoveryJournal(location.runRoot);
            if (checkpointRecovery) {
              return checkpointRecoveryRequiredContinuation(
                location,
                checkpointRecovery,
              );
            }
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
            const artifact = await artifactMutationForSubmission(
              prepared,
              submission,
            );
            if (artifact.blockers.length > 0) {
              return blockedContinuation(prepared, artifact.blockers);
            }
            const verification = await verificationMutationForSubmission(
              prepared,
              submission,
              artifact.mutation,
            );
            if (verification.blockers.length > 0) {
              return blockedContinuation(prepared, verification.blockers);
            }
            const mutation = mergeWorkflowMutations(
              artifact.mutation,
              verification.mutation,
            );
            const completion = await validateCompletion(
              prepared,
              submission,
              mutation,
            );
            if (completion.blockers.length > 0) {
              return blockedContinuation(prepared, completion.blockers);
            }
            const routeFindings = routeBlockers(prepared, submission, mutation);
            if (routeFindings.length > 0) {
              return blockedContinuation(prepared, routeFindings);
            }
            const finalizationBlockers = await finalizationSubmissionBlockers(
              prepared,
              submission,
            );
            if (finalizationBlockers.length > 0) {
              return blockedContinuation(prepared, finalizationBlockers);
            }
            const repairFailure = repairFailureForSubmission(
              prepared,
              submission,
              mutation,
            );
            const outcome = engineOutcome(
              prepared,
              submission,
              mutation,
              repairFailure,
              completion.artifactReceipts,
            );
            const finalizationDefinition =
              prepared.verified.package.runtime!.protocol.finalization;
            const finalizationPreparation =
              finalizationDefinition &&
              prepared.verified.identity.durabilityProfile?.capabilities.includes(
                "transactional-finalization",
              )
                ? prepareWorkflowFinalizationForLocation(
                    prepared.location,
                    finalizationDefinition,
                    prepared.verified.identity.durabilityProfile,
                    prepared.verified.identity,
                  )
                : undefined;
            if (prepared.verified.identity.durabilityProfile === undefined) {
              const result = await prepared.location.resume(
                {
                  resolver: resolverForPackage(),
                  outcome,
                  prepareAction: prepareWorkflowActionForLocation(location),
                  prepareOutcome: prepareVerificationReceiptRecords(
                    mutation,
                    prepared.verified.identity.durabilityProfile,
                  ),
                  ...(finalizationPreparation
                    ? { prepareFinalization: finalizationPreparation }
                    : {}),
                },
                mutation,
              );
              await clearFinalizationAfterResult(prepared.location, result);
              return continuation(
                result,
                prepared.verified.identity,
                prepared.verified,
              );
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
                  prepareAction: prepareWorkflowActionForLocation(location),
                  prepareOutcome: prepareVerificationReceiptRecords(
                    mutation,
                    prepared.verified.identity.durabilityProfile,
                  ),
                  revisionFence: () =>
                    assertRevisionFence(prepared.location, claimInput),
                  revisionStateFence: () =>
                    assertRevisionFence(prepared.location, claimInput, false),
                  ...(finalizationPreparation
                    ? { prepareFinalization: finalizationPreparation }
                    : {}),
                },
                mutation,
              );
              await claim.commit();
              await clearFinalizationAfterResult(prepared.location, result);
              await persistWorkflowCheckpoint(
                prepared.location,
                result.state,
                result.action,
                prepared.verified.package,
              );
              return continuation(
                result,
                prepared.verified.identity,
                prepared.verified,
              );
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
                  return recoveryRequiredContinuation(
                    prepared.location,
                    journal,
                  );
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
              if (error instanceof WorkflowFinalizationConflictError) {
                const transaction = await readWorkflowFinalizationTransaction(
                  prepared.location.runRoot,
                  prepared.verified.identity.durabilityProfile!,
                );
                if (transaction) {
                  return finalizationRecoveryRequiredContinuation(
                    prepared.location,
                    transaction,
                  );
                }
                await claim.abandon();
                return blockedContinuation(prepared, [error.message]);
              }
              if (
                error instanceof WorkflowFinalizationTransactionPendingError
              ) {
                return finalizationRecoveryRequiredContinuation(
                  prepared.location,
                  error.transaction,
                );
              }
              throw error;
            }
          },
          {
            onBlocked: (error) => lockBlockedContinuation(location, error),
          },
        );
      });
    },

    async recover(
      target: WorkflowRunTarget,
      options: RecoverWorkflowRunOptions = {},
    ): Promise<WorkflowContinuation> {
      return withStructuredRuntimeErrors(async () => {
        const location = resolveWorkflowRunLocation(target);
        const profile = await durabilityProfileForLocation(location, {
          allowMalformedState: true,
        });
        return withWorkflowRunLock(
          location,
          "workflow.recover",
          profile,
          async (lock) => {
            if (lock?.takeover && profile?.bounds.runLockBytes) {
              await recordWorkflowRunLockTakeover(
                location.runRoot,
                lock.takeover,
                profile.bounds.runLockBytes,
              );
            }
            const journal = await readWorkflowTransitionJournal(
              location.runRoot,
            );
            let transitionRecovered = false;
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
              transitionRecovered = recovery.status === "recovered";
            }
            let finalizationRecovery: FinalizationRecovery | undefined;
            if (usesWorkflowFinalization(profile)) {
              let persistedRun: RunState | null = null;
              let recoveryDefinition:
                WorkflowFinalizationDefinition | undefined;
              try {
                persistedRun = await location.readState();
              } catch {
                persistedRun = null;
              }
              if (persistedRun) {
                try {
                  recoveryDefinition = (
                    await readSkillSnapshot(
                      location.runRoot,
                      persistedRun.skillHash,
                    )
                  ).runtime?.protocol.finalization;
                } catch {
                  recoveryDefinition = undefined;
                }
              }
              const recovery = options.rollbackFinalization
                ? await rollbackWorkflowFinalization({
                    runRoot: location.runRoot,
                    baseRoot: location.contentSnapshotRoot,
                    profile: profile!,
                    ...(persistedRun?.runId
                      ? { runId: persistedRun.runId }
                      : location.runId
                        ? { runId: location.runId }
                        : {}),
                    ...(persistedRun?.runtimeIdentity
                      ? { execution: persistedRun.runtimeIdentity }
                      : {}),
                    ...(recoveryDefinition
                      ? { definition: recoveryDefinition }
                      : {}),
                  })
                : await recoverWorkflowFinalization({
                    runRoot: location.runRoot,
                    baseRoot: location.contentSnapshotRoot,
                    profile: profile!,
                    ...(persistedRun?.runId
                      ? { runId: persistedRun.runId }
                      : location.runId
                        ? { runId: location.runId }
                        : {}),
                    ...(persistedRun?.runtimeIdentity
                      ? { execution: persistedRun.runtimeIdentity }
                      : {}),
                    ...(recoveryDefinition
                      ? { definition: recoveryDefinition }
                      : {}),
                  });
              if (recovery.status === "blocked" && recovery.transaction) {
                return finalizationRecoveryRequiredContinuation(
                  location,
                  recovery.transaction,
                  recovery.unknownPaths,
                );
              }
              if (recovery.receipt && recovery.transaction) {
                const current = await location.readState();
                if (
                  current?.workflowRuntime?.finalization?.status ===
                    "awaiting-confirmation" &&
                  current.pending
                ) {
                  finalizationRecovery = {
                    status:
                      recovery.receipt.recovery.status === "rolled-back"
                        ? "rolled-back"
                        : "committed",
                    transactionId: recovery.transaction.transactionId,
                    resultingRevision: recovery.transaction.resultingRevision,
                    receipt: workflowFinalizationReceiptReference(
                      recovery.receipt,
                    ),
                    confirmation: structuredClone(
                      recovery.receipt.confirmation,
                    ),
                  };
                } else if (
                  current?.workflowRuntime?.finalization?.transactionId ===
                    recovery.transaction.transactionId &&
                  (current.workflowRuntime.finalization.status ===
                    "committed" ||
                    current.workflowRuntime.finalization.status ===
                      "rolled-back")
                ) {
                  await clearWorkflowFinalizationTransaction(
                    location.runRoot,
                    profile!,
                    location.contentSnapshotRoot,
                  );
                }
              }
            }
            if (usesWorkflowCheckpoints(profile)) {
              const result = await recoverCheckpointAwareRun(
                location,
                {
                  ...options,
                  ...(finalizationRecovery ? { finalizationRecovery } : {}),
                },
                transitionRecovered,
              );
              if (finalizationRecovery) {
                await clearWorkflowFinalizationTransaction(
                  location.runRoot,
                  profile!,
                  location.contentSnapshotRoot,
                );
              }
              return result;
            }
            const result = await resumeStoredRun(
              location,
              {
                ...options,
                ...(finalizationRecovery ? { finalizationRecovery } : {}),
              },
              transitionRecovered,
            );
            if (finalizationRecovery) {
              await clearWorkflowFinalizationTransaction(
                location.runRoot,
                profile!,
                location.contentSnapshotRoot,
              );
            }
            return result;
          },
          {
            allowStale: true,
            onBlocked: (error) => lockBlockedContinuation(location, error),
          },
        );
      });
    },
  };
}

const defaultRuntime = createWorkflowRuntime();

export const startWorkflowRun = defaultRuntime.start;
export const resumeWorkflowRun = defaultRuntime.resume;
export const submitWorkflowRun = defaultRuntime.submit;
export const recoverWorkflowRun = defaultRuntime.recover;
