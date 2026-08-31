import { promises as fs } from "node:fs";
import path from "node:path";
import {
  WORKFLOW_RUNTIME_PHASE3_NEGATIVE_CASES,
  type CreatorState,
} from "../types.js";
import { copyDirectory, ensureDirectory } from "../util.js";
import { writeState } from "../factory/state.js";

function sameStrings(left: unknown, right: unknown): boolean {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    JSON.stringify(left) === JSON.stringify(right)
  );
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

export function reviewState(state: CreatorState): {
  state: "blocked" | "reviewable" | "publishable";
  blockers: string[];
  evidence: Record<string, string>;
} {
  const blockers: string[] = [];
  if (state.candidates.some((candidate) => candidate.status !== "available"))
    blockers.push("Unresolved Skill candidates remain");
  if (!state.generated) blockers.push("Generated package is missing");
  if (
    !state.currentHash ||
    !state.eval ||
    state.eval.hash !== state.currentHash ||
    !state.eval.passed
  )
    blockers.push(
      "Passing evaluation evidence for the current package hash is missing",
    );
  blockers.push(...runtimeEvidenceBlockers(state));
  blockers.push(...phase3EvidenceBlockers(state));
  if (state.review && state.review.hash !== state.currentHash)
    blockers.push("Review evidence is stale");
  const publishable =
    blockers.length === 0 &&
    state.review?.decision === "approved" &&
    state.review.hash === state.currentHash;
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
      ...(state.eval ? { eval: state.eval.resultPath } : {}),
    },
  };
}

export async function approveReview(options: {
  state: CreatorState;
  reviewer: string;
  approve: boolean;
}): Promise<CreatorState> {
  const readiness = reviewState(options.state);
  if (!options.approve) throw new Error("Review approval was not confirmed");
  if (readiness.blockers.length)
    throw new Error(
      `Cannot approve blocked workflow:\n${readiness.blockers.join("\n")}`,
    );
  if (!options.reviewer.trim())
    throw new Error("A reviewer identity is required");
  options.state.review = {
    hash: options.state.currentHash!,
    decision: "approved",
    reviewer: options.reviewer,
    at: new Date().toISOString(),
  };
  options.state.status = "review-approved";
  await writeState(options.state);
  return options.state;
}

export async function publishState(state: CreatorState): Promise<CreatorState> {
  const readiness = reviewState(state);
  if (readiness.state !== "publishable")
    throw new Error(
      `Workflow is not publishable:\n${readiness.blockers.join("\n")}`,
    );
  const destination = path.join(
    state.projectRoot,
    ".comet-any",
    "published",
    state.name,
  );
  await ensureDirectory(path.dirname(destination));
  await fs.rm(destination, { recursive: true, force: true });
  await copyDirectory(state.generated!.packageRoot, destination);
  state.published = {
    hash: state.currentHash!,
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
  const readiness = reviewState(state);
  if (readiness.state !== "publishable")
    throw new Error(
      `Workflow must be publishable before distribution:\n${readiness.blockers.join("\n")}`,
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
