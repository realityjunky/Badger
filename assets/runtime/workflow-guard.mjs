#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWorkflowRuntime,
  inspectWorkflowRun,
  validateWorkflowSubmission,
  verifyWorkflowProtocol,
} from "./workflow-runtime.mjs";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const protocolPath = path.join(
  packageRoot,
  "reference",
  "workflow-protocol.json",
);

function requiredOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function parseArguments(argv) {
  const positionals = [];
  const options = {};
  let positionalOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (positionalOnly) {
      positionals.push(argument);
      continue;
    }
    if (argument === "--") {
      positionalOnly = true;
      continue;
    }
    if (argument === "--apply" || argument === "--json") {
      options[argument.slice(2)] = true;
      continue;
    }
    if (argument === "--evidence") {
      options.evidence = requiredOptionValue(argv, index, "--evidence");
      index += 1;
      continue;
    }
    if (argument === "--response") {
      options.response = requiredOptionValue(argv, index, "--response");
      index += 1;
      continue;
    }
    if (argument === "--action-id") {
      options.actionid = requiredOptionValue(argv, index, "--action-id");
      index += 1;
      continue;
    }
    if (
      argument === "--run-root" ||
      argument === "--project" ||
      argument === "--run-id"
    ) {
      options[argument.slice(2).replaceAll("-", "")] = requiredOptionValue(
        argv,
        index,
        argument,
      );
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    }
    positionals.push(argument);
  }
  return { positionals, options };
}

function resolveTarget(options) {
  const projectRoot = options.project ?? process.env.COMET_PROJECT_ROOT;
  if (projectRoot !== undefined) {
    const runId = options.runid ?? process.env.COMET_RUN_ID;
    if (!runId) {
      throw new Error("Standalone workflow commands require --run-id.");
    }
    return {
      kind: "standalone",
      projectRoot: path.resolve(projectRoot),
      runId,
    };
  }
  return path.resolve(
    options.runroot ?? process.env.COMET_RUN_ROOT ?? process.cwd(),
  );
}

async function readProtocol() {
  return JSON.parse(await fs.readFile(protocolPath, "utf8"));
}

function sameRecord(left, right) {
  const normalize = (value) =>
    Object.entries(value).sort(([leftKey], [rightKey]) =>
      leftKey.localeCompare(rightKey),
    );
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function assertCurrentContract(continuation, verification) {
  const execution = continuation.execution;
  if (
    execution.protocolHash !== verification.protocolHash ||
    execution.packageHash !== verification.packageHash ||
    execution.snapshotHash !== verification.snapshotHash ||
    !sameRecord(execution.nodeToStep, verification.nodeToStep) ||
    JSON.stringify(execution.durabilityProfile) !==
      JSON.stringify(verification.durabilityProfile) ||
    (execution.findingCatalogVersion !== undefined &&
      execution.findingCatalogVersion !== verification.findingCatalogVersion)
  ) {
    throw new Error(
      "WorkflowRuntime generated protocol does not match persisted Run identity",
    );
  }
}

function parseEvidence(raw) {
  if (!raw || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : { value: parsed };
  } catch {
    return { summary: raw };
  }
}

function parseDecisionResponse(raw) {
  if (!raw || raw.trim().length === 0) {
    throw new Error("decision requires a JSON response object.");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("decision requires valid JSON.", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("decision requires a JSON response object.");
  }
  return parsed;
}

function submissionSummary(evidence, raw, nodeId) {
  if (typeof evidence.summary === "string" && evidence.summary.length > 0) {
    return evidence.summary;
  }
  if (raw.trim().length > 0) return raw.trim();
  return `Evidence recorded for ${nodeId}`;
}

function submissionRouting(evidence) {
  if (
    !evidence ||
    typeof evidence.routing !== "object" ||
    Array.isArray(evidence.routing)
  ) {
    return undefined;
  }
  return evidence.routing;
}

function submissionField(evidence, field) {
  return Object.prototype.hasOwnProperty.call(evidence, field)
    ? evidence[field]
    : undefined;
}

function blockedError(value) {
  const findings = (value.findings ?? []).map(
    (finding) => `FINDING: ${JSON.stringify(finding)}`,
  );
  const summary = value.findingSummary
    ? [`FINDING_SUMMARY: ${JSON.stringify(value.findingSummary)}`]
    : [];
  const blockers = (value.blockers ?? []).map(
    (blocker) => `BLOCKED: ${blocker}`,
  );
  return new Error([...findings, ...summary, ...blockers].join("\n"));
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printContinuation(value) {
  for (const finding of value.findings ?? []) {
    console.log(`FINDING: ${JSON.stringify(finding)}`);
  }
  if (value.findingSummary?.truncated) {
    console.log(`FINDING_SUMMARY: ${JSON.stringify(value.findingSummary)}`);
  }
  if (value.disposition === "done") {
    console.log("NEXT: done");
    return;
  }
  if (value.disposition === "blocked") {
    console.log("NEXT: blocked");
    for (const blocker of value.blockers) console.log(`REASON: ${blocker}`);
    return;
  }
  if (value.disposition === "await-user") {
    console.log("NEXT: await-user");
    if (value.currentNode) console.log(`NODE: ${value.currentNode}`);
    if (value.pendingAction?.decisionId) {
      console.log(`DECISION: ${value.pendingAction.decisionId}`);
    }
    if (value.pendingAction?.question) {
      console.log(`QUESTION: ${value.pendingAction.question}`);
    }
    if (value.pendingAction?.scope) {
      console.log(`SCOPE: ${JSON.stringify(value.pendingAction.scope)}`);
    }
    if (value.pendingAction) console.log(`ACTION: ${value.pendingAction.id}`);
    return;
  }
  console.log("NEXT: auto");
  if (value.currentNode) console.log(`NODE: ${value.currentNode}`);
  if (value.pendingAction?.ref) {
    console.log(`SKILL: ${value.pendingAction.ref}`);
  }
  if (value.pendingAction) console.log(`ACTION: ${value.pendingAction.id}`);
}

function matchesNode(nodeArgument, continuation) {
  const pending = continuation.pendingAction;
  if (!pending) return false;
  if (continuation.currentNode && nodeArgument === continuation.currentNode) {
    return true;
  }
  if (nodeArgument === pending.ref) return true;
  return (
    !continuation.currentNode &&
    pending.type === "checkpoint" &&
    nodeArgument === "checkpoint"
  );
}

function requireCurrentNode(nodeArgument, continuation) {
  if (!nodeArgument) throw new Error("guard command requires a Node id.");
  if (matchesNode(nodeArgument, continuation)) return;
  throw new Error(
    `BLOCKED: current Node is ${continuation.currentNode ?? "(none)"}, cannot use ${nodeArgument}.`,
  );
}

function requireCurrentAction(actionId, continuation) {
  if (!actionId) return;
  if (actionId === continuation.pendingAction?.id) return;
  throw new Error(
    `BLOCKED: pending action is ${continuation.pendingAction?.id ?? "(none)"}, not ${actionId}.`,
  );
}

async function currentRun(protocol, target) {
  const verification = await verifyWorkflowProtocol(protocol);
  const continuation = await inspectWorkflowRun(target);
  if (continuation) assertCurrentContract(continuation, verification);
  return { continuation, verification };
}

async function main() {
  const { positionals, options } = parseArguments(process.argv.slice(2));
  const command = positionals.shift() ?? "verify";
  const protocol = await readProtocol();

  if (command === "verify") {
    const verification = await verifyWorkflowProtocol(protocol);
    if (options.json) printJson(verification);
    else console.log("workflow-guard-ok");
    return;
  }
  if (
    command !== "entry" &&
    command !== "exit" &&
    command !== "decision" &&
    command !== "decide"
  ) {
    throw new Error(`Unknown command: ${command}`);
  }

  const nodeArgument = positionals.shift();
  const evidenceRaw = options.evidence ?? positionals.join(" ");
  const target = resolveTarget(options);
  const { continuation } = await currentRun(protocol, target);
  if (!continuation) {
    throw new Error(
      "Missing workflow state. Run workflow-state.mjs init first.",
    );
  }
  requireCurrentNode(nodeArgument, continuation);
  requireCurrentAction(options.actionid, continuation);

  if (command === "entry") {
    if (options.json) printJson(continuation);
    else console.log(`ENTRY OK: ${continuation.currentNode ?? "checkpoint"}`);
    return;
  }

  if (command === "decision" || command === "decide") {
    const response = parseDecisionResponse(options.response ?? evidenceRaw);
    const submission = {
      ...response,
      kind: "decision",
      actionId: continuation.pendingAction.id,
      runId: continuation.runId,
      revision: continuation.revision,
      nodeId: continuation.currentNode,
      cycleId: continuation.cycleId,
      attemptId: continuation.attemptId,
      execution: continuation.execution,
    };
    const validation = await validateWorkflowSubmission(target, submission);
    if (validation.disposition === "blocked") {
      throw blockedError(validation);
    }
    if (!options.apply) {
      if (options.json) printJson(validation);
      else {
        console.log("ALL CHECKS PASSED");
        console.log("APPLY: rerun with --apply to submit the decision");
      }
      return;
    }
    const applied = await createWorkflowRuntime().submit(target, submission);
    if (applied.disposition === "blocked") {
      throw blockedError(applied);
    }
    if (options.json) printJson(applied);
    else {
      console.log("ALL CHECKS PASSED");
      printContinuation(applied);
    }
    return;
  }

  const evidence = parseEvidence(evidenceRaw);
  const artifacts = submissionField(evidence, "artifacts");
  const artifactVersions = submissionField(evidence, "artifactVersions");
  const verification = submissionField(evidence, "verification");
  const verificationReceipts = submissionField(evidence, "verificationReceipts");
  const verificationReceiptIds = submissionField(evidence, "verificationReceiptIds");
  const receiptIds = submissionField(evidence, "receiptIds");
  const status = evidence.status === "failed" ? "failed" : "succeeded";
  const submission = {
    actionId: options.actionid ?? continuation.pendingAction.id,
    status,
    summary: submissionSummary(
      evidence,
      evidenceRaw,
      continuation.currentNode ?? "checkpoint",
    ),
    evidence,
    ...(submissionRouting(evidence)
      ? { routing: submissionRouting(evidence) }
      : {}),
    ...(artifacts !== undefined ? { artifacts } : {}),
    ...(artifactVersions !== undefined ? { artifactVersions } : {}),
    ...(verification !== undefined ? { verification } : {}),
    ...(verificationReceipts !== undefined ? { verificationReceipts } : {}),
    ...(verificationReceiptIds !== undefined ? { verificationReceiptIds } : {}),
    ...(receiptIds !== undefined ? { receiptIds } : {}),
    runId: continuation.runId,
    revision: continuation.revision,
    execution: continuation.execution,
    nodeId: continuation.currentNode,
  };
  const validation = await validateWorkflowSubmission(target, submission);
  if (validation.disposition === "blocked") {
    throw blockedError(validation);
  }
  if (!options.apply) {
    if (options.json) printJson(validation);
    else {
      console.log("ALL CHECKS PASSED");
      console.log("APPLY: rerun with --apply to submit the outcome");
    }
    return;
  }

  const applied = await createWorkflowRuntime().submit(target, submission);
  if (applied.disposition === "blocked") {
    throw blockedError(applied);
  }
  if (options.json) printJson(applied);
  else {
    console.log("ALL CHECKS PASSED");
    printContinuation(applied);
  }
}

main().catch((error) => {
  if (error && typeof error === "object" && error.finding) {
    console.error(`FINDING: ${JSON.stringify(error.finding)}`);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
