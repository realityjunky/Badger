import { promises as fs } from "node:fs";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  WORKFLOW_RUNTIME_PHASE3_NEGATIVE_CASES,
  WORKFLOW_RUNTIME_PHASE4_NEGATIVE_CASES,
  type CompositeReadiness,
  type CreatorState,
  type PublicationReadinessEvidence,
} from "../types.js";
import {
  copyDirectory,
  ensureDirectory,
  hashDirectory,
  isWithin,
  sha256,
  stableValue,
} from "../util.js";
import { writeState } from "../factory/state.js";
import { WORKFLOW_FINALIZATION_BOUNDARY_PHASES } from "../workflow-runtime/finalization.js";
import { WORKFLOW_TRANSITION_BOUNDARY_PHASES } from "../workflow-runtime/transition-journal.js";
import { validateAuthoringReviewResult } from "../authoring/review.js";
import { authoringReadiness } from "../authoring/lifecycle.js";
import { hashDirectorySync } from "../workflow-kernel/hash.js";

function sameStrings(left: unknown, right: unknown): boolean {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    JSON.stringify(left) === JSON.stringify(right)
  );
}

interface PackageHashCheck {
  currentHash: string | null;
  blockers: string[];
}

function currentPackageHashCheck(state: CreatorState): PackageHashCheck {
  if (!state.generated) return { currentHash: null, blockers: [] };
  let currentHash: string;
  try {
    currentHash = hashDirectorySync(state.generated.packageRoot);
  } catch (error) {
    return {
      currentHash: null,
      blockers: [
        `Current generated package hash is unavailable: ${String(error)}`,
      ],
    };
  }
  const blockers: string[] = [];
  if (!/^[a-f0-9]{64}$/u.test(state.currentHash ?? "")) {
    blockers.push("Current generated package hash evidence is missing");
  } else if (state.currentHash !== currentHash) {
    blockers.push(
      "Current generated package hash does not match the persisted current package hash",
    );
  }
  if (
    state.authoring?.assembledPackageHash &&
    state.authoring.assembledPackageHash !== currentHash
  ) {
    blockers.push("Authoring assembly is stale for the current package hash");
  }
  if (
    state.generated.assembledPackageHash &&
    state.generated.assembledPackageHash !== currentHash
  ) {
    blockers.push(
      "Generated package evidence is stale for the current package hash",
    );
  }
  return { currentHash, blockers };
}

interface SourceEvidenceCheck {
  currentHash: string | null;
  blockers: string[];
}

function sourceEvidenceCheck(state: CreatorState): SourceEvidenceCheck {
  const expected = new Map<string, string>();
  const conflictingRoots = new Set<string>();
  const rememberSource = (root: string, hash: string) => {
    const previousHash = expected.get(root);
    if (previousHash !== undefined && previousHash !== hash) {
      conflictingRoots.add(root);
      return;
    }
    expected.set(root, hash);
  };
  for (const candidate of state.confirmedProposal?.candidates ?? []) {
    for (const source of candidate.sources)
      rememberSource(source.root, source.hash);
  }
  const upgradeSource = state.confirmedProposal?.upgradeSource;
  if (upgradeSource) rememberSource(upgradeSource.root, upgradeSource.hash);
  if (state.generated?.sourceRoot && state.generated.sourceHash) {
    rememberSource(state.generated.sourceRoot, state.generated.sourceHash);
  }
  if (state.generated?.sourceEvidence) {
    rememberSource(
      state.generated.sourceEvidence.sourceRoot,
      state.generated.sourceEvidence.sourceHash,
    );
  }
  if (expected.size === 0) return { currentHash: null, blockers: [] };

  const entries: Array<{
    root: string;
    expectedHash: string;
    currentHash: string | null;
  }> = [];
  const blockers = [...conflictingRoots].map(
    (root) => `Source evidence hashes conflict for root: ${root}`,
  );
  for (const [root, expectedHash] of expected) {
    let currentHash: string | null = null;
    if (!/^[a-f0-9]{64}$/u.test(expectedHash)) {
      blockers.push(`Source evidence hash is invalid: ${root}`);
    } else {
      try {
        currentHash = hashDirectorySync(root);
      } catch (error) {
        blockers.push(
          `Source evidence hash is unavailable: ${root}: ${String(error)}`,
        );
      }
      if (currentHash !== null && currentHash !== expectedHash) {
        blockers.push(`Source evidence is stale for current package: ${root}`);
      }
    }
    entries.push({ root, expectedHash, currentHash });
  }
  entries.sort((left, right) => left.root.localeCompare(right.root));
  return {
    currentHash: sha256(JSON.stringify(stableValue(entries))),
    blockers,
  };
}

interface EvaluationEvidenceCheck {
  reportHash: string | null;
  blockers: string[];
}

function evaluationEvidenceCheck(state: CreatorState): EvaluationEvidenceCheck {
  const evaluation = state.eval;
  if (!evaluation) return { reportHash: null, blockers: [] };
  if (!isWithin(state.projectRoot, evaluation.resultPath)) {
    return {
      reportHash: null,
      blockers: ["Evaluation evidence path is outside the project root"],
    };
  }
  try {
    const stats = realpathSync(evaluation.resultPath);
    if (!isWithin(state.projectRoot, stats)) {
      return {
        reportHash: null,
        blockers: [
          "Evaluation evidence path resolves outside the project root",
        ],
      };
    }
    const reportDocument = readFileSync(stats);
    const report = JSON.parse(reportDocument.toString("utf8")) as Record<
      string,
      unknown
    >;
    const blockers: string[] = [];
    if (!Array.isArray(report.checks) || report.checks.length === 0) {
      blockers.push("Evaluation evidence checks are invalid");
    } else if (
      report.checks.some(
        (check) =>
          !isRecord(check) ||
          typeof check.id !== "string" ||
          check.id.length === 0 ||
          typeof check.passed !== "boolean" ||
          typeof check.detail !== "string",
      )
    ) {
      blockers.push("Evaluation evidence checks are invalid");
    } else if (
      report.passed !==
      report.checks.every((check) => isRecord(check) && check.passed === true)
    ) {
      blockers.push("Evaluation evidence result does not match checks");
    }
    if (report.schemaVersion !== 1) {
      blockers.push("Evaluation evidence schema is invalid");
    }
    if (report.hash !== evaluation.hash) {
      blockers.push(
        "Evaluation evidence hash does not match the persisted report",
      );
    }
    if (report.passed !== evaluation.passed) {
      blockers.push(
        "Evaluation evidence result does not match the persisted report",
      );
    }
    if (
      JSON.stringify(stableValue(report.runtime)) !==
      JSON.stringify(stableValue(evaluation.runtime))
    ) {
      blockers.push(
        "WorkflowRuntime certification evidence does not match evaluation",
      );
    }
    if (
      JSON.stringify(stableValue(report.authoringCrossValidation)) !==
      JSON.stringify(stableValue(evaluation.authoringCrossValidation))
    ) {
      blockers.push(
        "Authoring cross-validation evidence does not match evaluation",
      );
    }
    return { reportHash: sha256(reportDocument), blockers };
  } catch (error) {
    return {
      reportHash: null,
      blockers: [`Evaluation evidence is unavailable: ${String(error)}`],
    };
  }
}

function publicationReadinessEvidence(
  state: CreatorState,
  readiness: Pick<CompositeReadiness, "authoring" | "runtime">,
  packageHash: string | null,
  sourceEvidenceHash: string | null,
  evaluationReportHash: string | null,
): PublicationReadinessEvidence | null {
  if (!packageHash) return null;
  const evidence = {
    packageHash,
    sourceEvidenceHash,
    authoringInputHash: readiness.authoring.hashes.authoringInput ?? null,
    authoredMaterialHash: readiness.authoring.hashes.authoredMaterial ?? null,
    assembledPackageHash: readiness.authoring.hashes.assembledPackage ?? null,
    authoringReviewHash: readiness.authoring.hashes.review ?? null,
    evaluationHash: readiness.runtime.hashes.evaluation ?? null,
    evaluationReportHash,
    runtimeEvidenceHash: state.eval?.runtime
      ? sha256(JSON.stringify(stableValue(state.eval.runtime)))
      : null,
  };
  return {
    ...evidence,
    readinessHash: sha256(
      JSON.stringify(
        stableValue({
          authoring: readiness.authoring,
          runtime: readiness.runtime,
          evidence,
        }),
      ),
    ),
  };
}

function publicationApprovalHash(value: {
  hash: string;
  decision: "approved" | "rejected";
  reviewer: string;
  at: string;
  readinessHash?: string;
}): string {
  return sha256(
    JSON.stringify(
      stableValue({
        hash: value.hash,
        decision: value.decision,
        reviewer: value.reviewer,
        at: value.at,
        readinessHash: value.readinessHash ?? null,
      }),
    ),
  );
}

function publicationApprovalBlockers(
  state: CreatorState,
  current: PublicationReadinessEvidence | null,
): string[] {
  if (!state.review || state.review.decision !== "approved") return [];
  if (!state.review.readiness || !state.review.readinessHash) {
    return ["Publication approval readiness evidence is missing"];
  }
  if (!state.review.approvalHash) {
    return ["Publication approval integrity evidence is missing"];
  }
  if (state.review.approvalHash !== publicationApprovalHash(state.review)) {
    return ["Publication approval integrity evidence is invalid"];
  }
  if (!current)
    return ["Publication approval readiness evidence is unavailable"];
  if (
    state.review.readinessHash !== current.readinessHash ||
    JSON.stringify(stableValue(state.review.readiness)) !==
      JSON.stringify(stableValue(current))
  ) {
    return ["Publication approval evidence is stale for current readiness"];
  }
  return [];
}

async function publicationGate(state: CreatorState) {
  const authoring = await authoringReadiness(state);
  const readiness = reviewState(state);
  return {
    authoring,
    readiness,
    blockers: [...new Set([...authoring.blockers, ...readiness.blockers])],
  };
}

function runtimeEvidenceBlockers(state: CreatorState): string[] {
  const runtime = state.eval?.runtime;
  if (!runtime) return ["WorkflowRuntime certification evidence is missing"];
  const blockers: string[] = [];
  const hashPattern = /^[a-f0-9]{64}$/u;
  if (runtime.authority !== "WorkflowRuntime") {
    blockers.push("WorkflowRuntime certification authority is invalid");
  }
  if (
    !hashPattern.test(state.currentHash ?? "") ||
    !hashPattern.test(runtime.generatedPackageHash)
  ) {
    blockers.push("WorkflowRuntime package hash evidence is invalid");
  } else if (state.currentHash !== runtime.generatedPackageHash) {
    blockers.push(
      "WorkflowRuntime evidence is stale for the generated package",
    );
  }
  if (
    !runtime.identity ||
    !hashPattern.test(runtime.identity.protocolHash) ||
    !hashPattern.test(runtime.identity.packageHash) ||
    !hashPattern.test(runtime.identity.snapshotHash) ||
    !runtime.identity.nodeToStep ||
    typeof runtime.identity.nodeToStep !== "object" ||
    Array.isArray(runtime.identity.nodeToStep)
  ) {
    blockers.push("WorkflowRuntime execution identity is missing");
  } else if (runtime.identity.packageHash !== runtime.identity.snapshotHash) {
    blockers.push("WorkflowRuntime package and snapshot identities differ");
  } else if (
    Object.values(runtime.identity.nodeToStep).some(
      (stepId) => typeof stepId !== "string" || stepId.length === 0,
    ) ||
    !sameStrings(
      Object.keys(runtime.identity.nodeToStep),
      runtime.compiledNodeOrder,
    )
  ) {
    blockers.push("WorkflowRuntime Node-to-step identity is invalid");
  }
  if (runtime.phase2Applicable === false) return blockers;
  if (!sameStrings(runtime.declaredNodeOrder, runtime.compiledNodeOrder)) {
    blockers.push("WorkflowRuntime declared and compiled Node orders differ");
  }
  if (!sameStrings(runtime.compiledNodeOrder, runtime.observedNodeOrder)) {
    blockers.push("WorkflowRuntime compiled and observed Node orders differ");
  }
  if (runtime.recovered !== true) {
    blockers.push("WorkflowRuntime recovery evidence is missing");
  }
  if (runtime.completed !== true) {
    blockers.push("WorkflowRuntime terminal evidence is missing");
  }
  if (runtime.identityConsistent !== true) {
    blockers.push("WorkflowRuntime execution identity consistency is missing");
  }
  if (runtime.entryAdapterStarted !== true) {
    blockers.push("WorkflowRuntime entry adapter evidence is missing");
  }
  if (runtime.compatibilityAdapterResumed !== true) {
    blockers.push("WorkflowRuntime compatibility adapter evidence is missing");
  }
  if (runtime.freshProcessRecovered !== true) {
    blockers.push("WorkflowRuntime fresh-process evidence is missing");
  }
  if (runtime.publicRuntimeCompleted !== true) {
    blockers.push("WorkflowRuntime public completion evidence is missing");
  }
  if (runtime.reverseAdapterCompleted !== true) {
    blockers.push("WorkflowRuntime reverse adapter evidence is missing");
  }
  if (
    !Number.isSafeInteger(runtime.recoveryCount) ||
    runtime.recoveryCount < 1
  ) {
    blockers.push("WorkflowRuntime recovery count is invalid");
  }
  return blockers;
}

function phase3EvidenceBlockersUnchecked(state: CreatorState): string[] {
  const runtime = state.eval?.runtime?.phase3;
  if (!runtime) {
    return ["WorkflowRuntime Phase 3 certification evidence is missing"];
  }
  const blockers: string[] = [];
  const hashPattern = /^[a-f0-9]{64}$/u;
  if (runtime.status !== "certified" || runtime.completed !== true) {
    blockers.push("WorkflowRuntime Phase 3 certification is incomplete");
  }
  if (
    !hashPattern.test(runtime.generatedPackageHash) ||
    !hashPattern.test(runtime.evaluatedPackageHash) ||
    !hashPattern.test(runtime.fixturePackageHash) ||
    runtime.generatedPackageHash !== runtime.evaluatedPackageHash ||
    runtime.evaluatedPackageHash !== state.currentHash
  ) {
    blockers.push(
      "WorkflowRuntime Phase 3 evidence is stale for the generated package",
    );
  }
  if (
    !hashPattern.test(runtime.identity.protocolHash) ||
    !hashPattern.test(runtime.identity.packageHash) ||
    !hashPattern.test(runtime.identity.snapshotHash) ||
    !hashPattern.test(runtime.identity.resolverHash) ||
    runtime.identity.capabilityVersion !== 3 ||
    !runtime.identity.nodeToStep ||
    typeof runtime.identity.nodeToStep !== "object" ||
    Array.isArray(runtime.identity.nodeToStep) ||
    Object.values(runtime.identity.nodeToStep).some(
      (stepId) => typeof stepId !== "string" || stepId.length === 0,
    )
  ) {
    blockers.push("WorkflowRuntime Phase 3 identity evidence is invalid");
  } else if (runtime.identity.packageHash !== runtime.identity.snapshotHash) {
    blockers.push(
      "WorkflowRuntime Phase 3 package and snapshot identities differ",
    );
  }
  if (!sameStrings(runtime.expectedVisitOrder, runtime.observedVisitOrder)) {
    blockers.push("WorkflowRuntime Phase 3 visit order evidence differs");
  }
  const requiredFlags: Array<[string, boolean]> = [
    ["continue disposition", runtime.dispositions.continue],
    ["await-user disposition", runtime.dispositions.awaitUser],
    ["blocked disposition", runtime.dispositions.blocked],
    ["done disposition", runtime.dispositions.done],
    ["pending-machine recovery", runtime.recovery.pendingMachine],
    ["await-user recovery", runtime.recovery.awaitingDecision],
    ["accepted-branch recovery", runtime.recovery.acceptedBranch],
    ["scoped-receipt recovery", runtime.recovery.afterScopedReceipt],
    ["between-cycle recovery", runtime.recovery.betweenCycles],
    ["terminal recovery", runtime.recovery.terminal],
    ["fresh-process recovery", runtime.recovery.freshProcess],
    ["conditional branch evidence", runtime.branch.conditional],
    ["selected branch evidence", runtime.branch.selected === "review"],
    ["default route evidence", runtime.branch.defaultRoute],
    ["terminal choice evidence", runtime.branch.terminalChoice],
    ["declared Cycle evidence", runtime.cycle.declared],
    ["Cycle repeat evidence", runtime.cycle.repeatTransition],
    ["Cycle budget evidence", runtime.cycle.budgetRejected],
    ["rework Attempt evidence", runtime.attempts.rework],
    ["retry Attempt evidence", runtime.attempts.retryStable],
    ["unique Attempt evidence", runtime.attempts.uniqueVisits],
    ["Attempt artifact evidence", runtime.artifacts.attemptVersion],
    ["Run artifact evidence", runtime.artifacts.runVersion],
    ["artifact carry-forward evidence", runtime.artifacts.carryForward],
    ["immutable artifact evidence", runtime.artifacts.immutable],
    ["authorized Decision evidence", runtime.decisions.authorized],
    ["Decision scope evidence", runtime.decisions.scopeBound],
    ["Decision replay evidence", runtime.decisions.replayRejected],
    [
      "generated-to-public entry evidence",
      runtime.entryDirections.generatedToPublic,
    ],
    [
      "public-to-generated entry evidence",
      runtime.entryDirections.publicToGenerated,
    ],
    [
      "manual/standalone parity evidence",
      runtime.entryDirections.manualStandalone,
    ],
    ["generated adapter source evidence", runtime.generatedAdaptersThin],
    ["identity reconciliation evidence", runtime.identityReconciled],
    ["projection reconciliation evidence", runtime.projectionsConsistent],
    ["synthetic source evidence", runtime.sourceIntegrity],
    ["negative-case evidence", runtime.allNegativeCases],
  ];
  for (const [label, passed] of requiredFlags) {
    if (passed !== true) {
      blockers.push(`WorkflowRuntime Phase 3 ${label} is missing`);
    }
  }
  if (
    runtime.cycle.instances !== 2 ||
    runtime.cycle.repeatedNodeVisits !== 2 ||
    runtime.decisions.receiptCount !== 2
  ) {
    blockers.push("WorkflowRuntime Phase 3 ledger counts are incomplete");
  }
  for (const name of WORKFLOW_RUNTIME_PHASE3_NEGATIVE_CASES) {
    if (runtime.negativeCases[name] !== true) {
      blockers.push(
        `WorkflowRuntime Phase 3 negative case is missing: ${name}`,
      );
    }
  }
  return blockers;
}

function phase3EvidenceBlockers(state: CreatorState): string[] {
  try {
    return phase3EvidenceBlockersUnchecked(state);
  } catch {
    return ["WorkflowRuntime Phase 3 certification evidence is invalid"];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredTrueFields(
  value: unknown,
  fields: readonly string[],
  label: string,
): string[] {
  if (!isRecord(value)) return [`${label} evidence is missing`];
  return fields
    .filter((field) => value[field] !== true)
    .map((field) => `${label} evidence is missing: ${field}`);
}

function isProtectedPath(candidate: string): boolean {
  const segments = path.resolve(candidate).split(path.sep);
  return (
    segments.includes("raw_data") ||
    segments.includes("raw_skills") ||
    segments.some(
      (segment, index) =>
        segment === "repos" && segments[index + 1] === "comet",
    )
  );
}

function phase4DeclaredByPackage(state: CreatorState): boolean {
  if (state.eval?.runtime?.identity?.durabilityProfile !== undefined) {
    return true;
  }
  const protocolPath = state.generated?.protocolPath;
  if (!protocolPath) return false;
  const packageRoot = state.generated?.packageRoot;
  if (
    !packageRoot ||
    !isWithin(packageRoot, protocolPath) ||
    isProtectedPath(packageRoot) ||
    isProtectedPath(protocolPath)
  ) {
    return true;
  }
  try {
    const realPackageRoot = realpathSync(packageRoot);
    const realProtocolPath = realpathSync(protocolPath);
    if (
      isProtectedPath(realPackageRoot) ||
      isProtectedPath(realProtocolPath) ||
      !isWithin(realPackageRoot, realProtocolPath)
    ) {
      return true;
    }
    const protocol = JSON.parse(readFileSync(realProtocolPath, "utf8")) as {
      capabilities?: { durability?: unknown };
    };
    return protocol.capabilities?.durability !== undefined;
  } catch {
    return true;
  }
}

function phase4EvidenceBlockersUnchecked(state: CreatorState): string[] {
  if (!phase4DeclaredByPackage(state)) return [];
  const runtime = state.eval?.runtime;
  const raw = runtime?.phase4 as unknown;
  if (!isRecord(raw)) {
    return ["WorkflowRuntime Phase 4 certification evidence is missing"];
  }
  const blockers: string[] = [];
  const hashPattern = /^[a-f0-9]{64}$/u;
  if (raw.fixtureName !== "phase4-certification-workflow") {
    blockers.push("WorkflowRuntime Phase 4 fixture identity is invalid");
  }
  if (raw.status !== "certified" || raw.completed !== true) {
    blockers.push("WorkflowRuntime Phase 4 certification is incomplete");
  }
  for (const [label, value] of [
    ["generatedPackageHash", raw.generatedPackageHash],
    ["evaluatedPackageHash", raw.evaluatedPackageHash],
    ["fixturePackageHash", raw.fixturePackageHash],
  ] as const) {
    if (typeof value !== "string" || !hashPattern.test(value)) {
      blockers.push(`WorkflowRuntime Phase 4 ${label} is invalid`);
    }
  }
  if (
    typeof state.currentHash !== "string" ||
    raw.generatedPackageHash !== state.currentHash ||
    raw.evaluatedPackageHash !== state.currentHash
  ) {
    blockers.push(
      "WorkflowRuntime Phase 4 evidence is stale for the generated package",
    );
  }
  if (!runtime || raw.generatedPackageHash !== runtime.generatedPackageHash) {
    blockers.push(
      "WorkflowRuntime Phase 4 evidence is not bound to the runtime report",
    );
  }

  const identity = raw.identity;
  if (!isRecord(identity)) {
    blockers.push("WorkflowRuntime Phase 4 execution identity is missing");
  } else {
    for (const [label, value] of [
      ["protocolHash", identity.protocolHash],
      ["packageHash", identity.packageHash],
      ["snapshotHash", identity.snapshotHash],
      ["resolverHash", identity.resolverHash],
    ] as const) {
      if (typeof value !== "string" || !hashPattern.test(value)) {
        blockers.push(`WorkflowRuntime Phase 4 identity ${label} is invalid`);
      }
    }
    if (identity.packageHash !== identity.snapshotHash) {
      blockers.push(
        "WorkflowRuntime Phase 4 package and snapshot identities differ",
      );
    }
    if (
      identity.capabilityVersion !== 3 ||
      identity.findingCatalogVersion !== 1 ||
      !isRecord(identity.nodeToStep) ||
      Object.keys(identity.nodeToStep).length === 0 ||
      Object.values(identity.nodeToStep).some(
        (stepId) => typeof stepId !== "string" || stepId.length === 0,
      )
    ) {
      blockers.push("WorkflowRuntime Phase 4 Node-to-step identity is invalid");
    }
    const profile = identity.durabilityProfile;
    if (!isRecord(profile)) {
      blockers.push("WorkflowRuntime Phase 4 durability profile is missing");
    } else {
      const rawCapabilities = profile.capabilities;
      const capabilities = Array.isArray(rawCapabilities)
        ? rawCapabilities.filter(
            (capability): capability is string =>
              typeof capability === "string",
          )
        : [];
      const rawDeclaredCapabilities = raw.declaredCapabilities;
      const declaredCapabilities = Array.isArray(rawDeclaredCapabilities)
        ? rawDeclaredCapabilities.filter(
            (capability): capability is string =>
              typeof capability === "string",
          )
        : [];
      const requiredCapabilities = [
        "mutation-locks",
        "revision-fences",
        "transition-journal",
        "verified-checkpoints",
        "content-snapshots",
        "verification-receipts",
        "repair-policy",
        "transactional-finalization",
      ];
      if (
        !Array.isArray(rawCapabilities) ||
        !Array.isArray(rawDeclaredCapabilities) ||
        capabilities.length !== rawCapabilities.length ||
        declaredCapabilities.length !== rawDeclaredCapabilities.length ||
        JSON.stringify([...capabilities].sort()) !==
          JSON.stringify([...declaredCapabilities].sort())
      ) {
        blockers.push(
          "WorkflowRuntime Phase 4 declared capabilities do not match the profile",
        );
      }
      if (
        requiredCapabilities.some(
          (capability) => !capabilities.includes(capability),
        )
      ) {
        blockers.push(
          "WorkflowRuntime Phase 4 durability capabilities are incomplete",
        );
      }
      if (profile.findingCatalogVersion !== 1) {
        blockers.push("WorkflowRuntime Phase 4 catalog identity is invalid");
      }
      const schemaVersions = profile.schemaVersions;
      const requiredSchemaVersions = [
        "runState",
        "pendingAction",
        "trajectory",
        "artifacts",
        "revisionClaim",
        "transitionJournal",
        "runLock",
        "checkpointManifest",
        "checkpointRecord",
        "contentSnapshot",
        "verificationReceipt",
        "repairEpisode",
        "finalizationTransaction",
        "finalizationReceipt",
      ];
      if (
        !isRecord(schemaVersions) ||
        requiredSchemaVersions.some((key) => schemaVersions[key] !== 1)
      ) {
        blockers.push("WorkflowRuntime Phase 4 schema identity is incomplete");
      }
    }
  }

  blockers.push(
    ...requiredTrueFields(
      raw.lifecycle,
      [
        "machineWork",
        "persistedDecision",
        "versionedArtifacts",
        "verificationRequirement",
        "contentSnapshot",
        "contentDrift",
        "repairEpisode",
        "verifiedCheckpoint",
        "finalizationPreview",
        "finalizationConfirmed",
        "finalReceipt",
      ],
      "WorkflowRuntime Phase 4 lifecycle",
    ),
    ...requiredTrueFields(
      raw.locations,
      ["manual", "standalone", "equivalent"],
      "WorkflowRuntime Phase 4 location",
    ),
    ...requiredTrueFields(
      raw.adapters,
      [
        "generatedToPublic",
        "publicToGenerated",
        "thin",
        "projectionsConsistent",
      ],
      "WorkflowRuntime Phase 4 adapter",
    ),
    ...requiredTrueFields(
      raw.freshProcess,
      [
        "pendingAction",
        "decision",
        "checkpoint",
        "finalization",
        "terminal",
        "crashBoundaries",
        "converged",
      ],
      "WorkflowRuntime Phase 4 fresh-process",
    ),
  );
  for (const [label, value] of [
    [
      "identical",
      isRecord(raw.concurrency) ? raw.concurrency.identical : undefined,
    ],
    [
      "conflicting",
      isRecord(raw.concurrency) ? raw.concurrency.conflicting : undefined,
    ],
  ] as const) {
    blockers.push(
      ...requiredTrueFields(
        value,
        [
          "oneAccepted",
          "oneConflict",
          "noDuplicateOutcome",
          "noDuplicateEvent",
          "noDuplicateReceipt",
          "noDuplicateNextAction",
        ],
        `WorkflowRuntime Phase 4 ${label} concurrency`,
      ),
    );
  }
  blockers.push(
    ...requiredTrueFields(
      raw.identities,
      [
        "protocol",
        "package",
        "snapshot",
        "resolver",
        "durabilityProfile",
        "schema",
        "catalog",
        "nodeAction",
        "cycleAttempt",
        "contentSnapshot",
        "verificationReceipt",
        "checkpoint",
        "finalizationTransaction",
        "finalizationReceipt",
        "generatedPackageTree",
      ],
      "WorkflowRuntime Phase 4 identity",
    ),
  );
  if (raw.allNegativeCases !== true) {
    blockers.push(
      "WorkflowRuntime Phase 4 negative-case evidence is incomplete",
    );
  }
  if (!isRecord(raw.negativeCases)) {
    blockers.push("WorkflowRuntime Phase 4 negative-case evidence is missing");
  } else {
    for (const name of WORKFLOW_RUNTIME_PHASE4_NEGATIVE_CASES) {
      if (raw.negativeCases[name] !== true) {
        blockers.push(
          `WorkflowRuntime Phase 4 negative case is missing: ${name}`,
        );
      }
    }
  }
  for (const [label, value, fields] of [
    [
      "transition-journal crash boundary",
      raw.transitionJournalCrashBoundaries,
      WORKFLOW_TRANSITION_BOUNDARY_PHASES,
    ],
    [
      "finalization crash boundary",
      raw.finalizationCrashBoundaries,
      WORKFLOW_FINALIZATION_BOUNDARY_PHASES,
    ],
  ] as const) {
    blockers.push(
      ...requiredTrueFields(value, fields, `WorkflowRuntime Phase 4 ${label}`),
    );
  }
  if (raw.generatedAdaptersThin !== true) {
    blockers.push(
      "WorkflowRuntime Phase 4 generated adapter evidence is missing",
    );
  }
  if (raw.legacyRunUnchanged !== true) {
    blockers.push("WorkflowRuntime Phase 4 legacy Run evidence is missing");
  }
  if (raw.sourceIntegrity !== true) {
    blockers.push(
      "WorkflowRuntime Phase 4 source-integrity evidence is missing",
    );
  }
  return blockers;
}

function phase4EvidenceBlockers(state: CreatorState): string[] {
  try {
    return phase4EvidenceBlockersUnchecked(state);
  } catch {
    return ["WorkflowRuntime Phase 4 certification evidence is invalid"];
  }
}

function authoringReadinessSection(
  state: CreatorState,
): CompositeReadiness["authoring"] {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const authoring = state.authoring;
  const hashes = {
    authoringInput: authoring?.authoringInputHash ?? null,
    scaffold: authoring?.scaffoldHash ?? null,
    authoredMaterial: authoring?.authoredMaterialHash ?? null,
    assembledPackage: authoring?.assembledPackageHash ?? null,
    review: authoring?.review?.reviewHash ?? null,
  };
  if (!authoring) {
    return {
      state: "blocked",
      blockers: [
        state.generated
          ? "Legacy deterministic scaffold is scaffold-only; migrate before authoring or publication"
          : "Authoring session is missing; generate a confirmed scaffold",
      ],
      warnings,
      evidence: state.generated
        ? { generated: state.generated.packageRoot }
        : {},
      hashes,
    };
  }
  if (authoring.status !== "assembled") {
    blockers.push("Authoring session is not assembled");
  }
  if (
    state.currentHash &&
    authoring.assembledPackageHash !== state.currentHash
  ) {
    blockers.push("Authoring assembly is stale for current package hash");
  }
  const review = authoring.review;
  if (!review) {
    blockers.push("Authoring review evidence is missing");
  } else {
    const reviewValidation = validateAuthoringReviewResult(review);
    if (reviewValidation.length) {
      blockers.push(
        `Authoring review evidence is invalid: ${reviewValidation.join("; ")}`,
      );
    }
    const reviewWarnings = Array.isArray(review.warnings)
      ? review.warnings
      : [];
    const reviewBlockers = Array.isArray(review.blockingFindings)
      ? review.blockingFindings
      : [];
    warnings.push(...reviewWarnings);
    if (
      !Array.isArray(review.warnings) ||
      !Array.isArray(review.blockingFindings)
    ) {
      blockers.push("Authoring review evidence is malformed");
    }
    if (
      !review.passed ||
      review.decision !== "approved" ||
      reviewBlockers.length
    ) {
      blockers.push(
        `Authoring review did not pass${
          reviewBlockers.length ? `: ${reviewBlockers.join("; ")}` : ""
        }`,
      );
    }
    if (review.authoringInputHash !== authoring.authoringInputHash) {
      blockers.push("Authoring review is stale for authoring input");
    }
    if (
      authoring.authoredMaterialHash &&
      review.authoredMaterialHash !== authoring.authoredMaterialHash
    ) {
      blockers.push("Authoring review is stale for authored material");
    }
    const expectedPackageHash =
      authoring.assembledPackageHash ?? state.currentHash;
    if (expectedPackageHash && review.packageHash !== expectedPackageHash) {
      blockers.push("Authoring review is stale for assembled package");
    }
  }
  return {
    state: blockers.length === 0 ? "ready" : "blocked",
    blockers,
    warnings,
    evidence: {
      session: authoring.sessionPath,
      ...(authoring.review
        ? { authoringReview: authoring.review.reviewHash }
        : {}),
    },
    hashes,
    ...(authoring.review ? { review: authoring.review } : {}),
  };
}

export function reviewState(state: CreatorState): CompositeReadiness {
  const authoring = authoringReadinessSection(state);
  const blockers: string[] = [...authoring.blockers];
  const runtimeBlockers: string[] = [];
  const packageHash = currentPackageHashCheck(state);
  const sourceEvidence = sourceEvidenceCheck(state);
  const evaluation = evaluationEvidenceCheck(state);
  if (state.candidates.some((candidate) => candidate.status !== "available"))
    blockers.push("Unresolved Skill candidates remain");
  if (!state.generated) blockers.push("Generated package is missing");
  if (
    !state.currentHash ||
    !state.eval ||
    state.eval.hash !== state.currentHash ||
    !state.eval.passed
  )
    runtimeBlockers.push(
      "Passing evaluation evidence for the current package hash is missing",
    );
  runtimeBlockers.push(...runtimeEvidenceBlockers(state));
  runtimeBlockers.push(...packageHash.blockers);
  runtimeBlockers.push(...sourceEvidence.blockers);
  runtimeBlockers.push(...evaluation.blockers);
  runtimeBlockers.push(...phase3EvidenceBlockers(state));
  runtimeBlockers.push(...phase4EvidenceBlockers(state));
  blockers.push(...runtimeBlockers);
  const runtime = {
    state: runtimeBlockers.length === 0 ? "ready" : "blocked",
    blockers: [...new Set(runtimeBlockers)],
    warnings: [],
    evidence: {
      ...(state.generated ? { generated: state.generated.packageRoot } : {}),
      ...(state.eval ? { eval: state.eval.resultPath } : {}),
    },
    hashes: {
      package: packageHash.currentHash ?? state.currentHash,
      evaluation: state.eval?.hash ?? null,
      evaluationReport: evaluation.reportHash,
      runtimePackage: state.eval?.runtime?.generatedPackageHash ?? null,
      sourceEvidence: sourceEvidence.currentHash,
    },
  } satisfies CompositeReadiness["runtime"];
  const currentApprovalEvidence = publicationReadinessEvidence(
    state,
    { authoring, runtime },
    packageHash.currentHash,
    sourceEvidence.currentHash,
    evaluation.reportHash,
  );
  const publicationBlockers: string[] = [];
  const expectedPackageHash = packageHash.currentHash ?? state.currentHash;
  if (
    !state.review ||
    state.review.decision !== "approved" ||
    state.review.hash !== expectedPackageHash
  ) {
    publicationBlockers.push("Publication approval is missing");
  }
  if (state.review && state.review.hash !== expectedPackageHash) {
    publicationBlockers.push("Review evidence is stale");
  }
  const approvalEvidenceBlockers = publicationApprovalBlockers(
    state,
    currentApprovalEvidence,
  );
  if (approvalEvidenceBlockers.length) {
    publicationBlockers.push(...approvalEvidenceBlockers);
    blockers.push(...approvalEvidenceBlockers);
  }
  const publication = {
    state: publicationBlockers.length === 0 ? "ready" : "blocked",
    blockers: [...new Set(publicationBlockers)],
    warnings: [],
    evidence: {
      ...(state.review ? { approval: state.review.reviewer } : {}),
      ...(state.review?.readinessHash
        ? { approvalReadiness: state.review.readinessHash }
        : {}),
      ...(state.published ? { published: state.published.path } : {}),
    },
    hashes: {
      package: packageHash.currentHash ?? state.currentHash,
      approval: state.review?.hash ?? null,
      sourceEvidence: sourceEvidence.currentHash,
      approvalReadiness: state.review?.readinessHash ?? null,
    },
  } satisfies CompositeReadiness["publication"];
  if (state.review && state.review.hash !== expectedPackageHash)
    blockers.push("Review evidence is stale");
  const publishable =
    blockers.length === 0 &&
    publicationBlockers.length === 0 &&
    state.review?.decision === "approved" &&
    state.review.hash === expectedPackageHash;
  return {
    state: publishable
      ? "publishable"
      : blockers.length === 0
        ? "reviewable"
        : "blocked",
    blockers,
    evidence: {
      draft: state.draftPath,
      ...(state.generated ? { generated: state.generated.packageRoot } : {}),
      ...(state.authoring ? { authoring: state.authoring.sessionPath } : {}),
      ...(state.eval ? { eval: state.eval.resultPath } : {}),
    },
    warnings: [
      ...authoring.warnings,
      ...runtime.warnings,
      ...publication.warnings,
    ],
    hashes: {
      package: packageHash.currentHash ?? state.currentHash,
      authoringInput: state.authoring?.authoringInputHash ?? null,
      authoredMaterial: state.authoring?.authoredMaterialHash ?? null,
      assembledPackage: state.authoring?.assembledPackageHash ?? null,
      authoringReview: state.authoring?.review?.reviewHash ?? null,
      evaluation: state.eval?.hash ?? null,
      publicationApproval: state.review?.hash ?? null,
      sourceEvidence: sourceEvidence.currentHash,
      publicationReadiness: currentApprovalEvidence?.readinessHash ?? null,
    },
    authoring,
    runtime,
    publication,
  };
}

export async function approveReview(options: {
  state: CreatorState;
  reviewer: string;
  approve: boolean;
}): Promise<CreatorState> {
  if (!options.approve) throw new Error("Review approval was not confirmed");
  if (!options.reviewer.trim())
    throw new Error("A reviewer identity is required");
  const publicationReviewer = options.reviewer.trim();
  const authoringReviewer =
    typeof options.state.authoring?.review?.reviewer === "string"
      ? options.state.authoring.review.reviewer.trim()
      : undefined;
  if (authoringReviewer && authoringReviewer === publicationReviewer) {
    throw new Error(
      "Publication reviewer must differ from the authoring reviewer",
    );
  }
  const authoring = await authoringReadiness(options.state);
  if (authoring.state !== "ready") {
    throw new Error(
      `Cannot approve blocked authoring session:\n${authoring.blockers.join("\n")}`,
    );
  }
  const readiness = reviewState({
    ...options.state,
    review: undefined,
  });
  if (readiness.state !== "reviewable" || readiness.blockers.length)
    throw new Error(
      `Cannot approve blocked workflow:\n${readiness.blockers.join("\n")}`,
    );
  const packageHash = currentPackageHashCheck(options.state);
  const sourceEvidence = sourceEvidenceCheck(options.state);
  const evaluation = evaluationEvidenceCheck(options.state);
  const approvalEvidence = publicationReadinessEvidence(
    options.state,
    readiness,
    packageHash.currentHash,
    sourceEvidence.currentHash,
    evaluation.reportHash,
  );
  if (!approvalEvidence) {
    throw new Error("Cannot approve workflow without current package evidence");
  }
  const review = {
    hash: approvalEvidence.packageHash,
    decision: "approved" as const,
    reviewer: publicationReviewer,
    at: new Date().toISOString(),
    readiness: approvalEvidence,
    readinessHash: approvalEvidence.readinessHash,
  };
  options.state.review = {
    ...review,
    approvalHash: publicationApprovalHash(review),
  };
  options.state.status = "review-approved";
  await writeState(options.state);
  return options.state;
}

export async function publishState(state: CreatorState): Promise<CreatorState> {
  const gate = await publicationGate(state);
  if (
    gate.authoring.state !== "ready" ||
    gate.readiness.state !== "publishable"
  )
    throw new Error(
      `Workflow is not publishable:\n${[...gate.blockers].join("\n")}`,
    );
  const approvedPackageHash = state.review?.readiness?.packageHash;
  if (!approvedPackageHash) {
    throw new Error("Publication approval package hash evidence is missing");
  }
  const packageHashBeforeCopy = await hashDirectory(
    state.generated!.packageRoot,
  );
  if (packageHashBeforeCopy !== approvedPackageHash) {
    throw new Error("Generated package changed before publication");
  }
  const destination = path.join(
    state.projectRoot,
    ".badger",
    "published",
    state.name,
  );
  await ensureDirectory(path.dirname(destination));
  await fs.rm(destination, { recursive: true, force: true });
  await copyDirectory(state.generated!.packageRoot, destination);
  const publishedHash = await hashDirectory(destination);
  if (publishedHash !== approvedPackageHash) {
    await fs.rm(destination, { recursive: true, force: true });
    throw new Error("Published package hash does not match approval");
  }
  state.published = {
    hash: publishedHash,
    path: destination,
    at: new Date().toISOString(),
  };
  state.status = "published";
  await writeState(state);
  return state;
}

export async function distributePreview(
  state: CreatorState,
  destination: string,
): Promise<{ destination: string; files: string[]; preview: true }> {
  const gate = await publicationGate(state);
  if (
    gate.authoring.state !== "ready" ||
    gate.readiness.state !== "publishable"
  )
    throw new Error(
      `Workflow must be publishable before distribution:\n${[
        ...gate.blockers,
      ].join("\n")}`,
    );
  const files = await listFiles(state.generated!.packageRoot);
  return {
    destination: path.resolve(destination),
    files: files.map((file) => path.join(path.resolve(destination), file)),
    preview: true,
  };
}

async function listFiles(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative);
  const entries = (await fs.readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  );
  const result: string[] = [];
  for (const entry of entries) {
    const next = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) result.push(...(await listFiles(root, next)));
    else if (entry.isFile()) result.push(next);
  }
  return result;
}
