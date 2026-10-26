import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { generatePackage } from "../factory/generate.js";
import { readRunState } from "../engine/state.js";
import { readTrajectory } from "../engine/run-store.js";
import { normalizeWorkflow } from "../workflow/contract.js";
import {
  createWorkflowRuntime,
  previewWorkflowFinalization,
} from "../workflow-runtime/public.js";
import {
  projectWorkflowHandoff,
  projectWorkflowState,
  verifyWorkflowProtocol,
} from "../workflow-runtime/index.js";
import type {
  WorkflowContinuation,
  WorkflowExecutionIdentity,
  WorkflowRunLocation,
  WorkflowRuntime,
  WorkflowSubmission,
} from "../workflow-runtime/public.js";
import {
  captureWorkflowContentSnapshot,
  createWorkflowContentSnapshotPolicy,
  readWorkflowContentSnapshot,
} from "../workflow-runtime/snapshots.js";
import {
  readWorkflowCheckpointIndex,
  inspectWorkflowCheckpointCandidates,
} from "../workflow-runtime/checkpoints.js";
import { parseWorkflowDurabilityProfile } from "../workflow-runtime/durability.js";
import {
  WORKFLOW_FINALIZATION_BOUNDARY_PHASES,
  readWorkflowFinalizationReceipt,
} from "../workflow-runtime/finalization.js";
import {
  WORKFLOW_TRANSITION_BOUNDARY_PHASES,
  readWorkflowTransitionJournal,
  setWorkflowTransitionFaultForTests,
  clearWorkflowTransitionFaultForTests,
} from "../workflow-runtime/transition-journal.js";
import {
  setWorkflowFinalizationFaultForTests,
  clearWorkflowFinalizationFaultForTests,
} from "../workflow-runtime/finalization.js";
import { clearWorkflowCheckpointFaultForTests } from "../workflow-runtime/checkpoints.js";
import { hashDirectory, stableValue } from "../util.js";
import type {
  FactoryPlan,
  FactoryProposal,
  NodeProtocol,
  WorkflowDurabilityProfile,
  WorkflowInput,
  WorkflowProtocol,
  WorkflowRuntimePhase4CertificationEvidence,
  WorkflowRuntimePhase4NegativeCase,
} from "../types.js";
import { WORKFLOW_RUNTIME_PHASE4_NEGATIVE_CASES } from "../types.js";

const execFileAsync = promisify(execFile);
const ZERO_HASH = "0".repeat(64);
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const ABSENT_PID = 2_147_483_647;

const verificationPolicy = {
  maxSummaryBytes: 512,
  maxEvidenceBytes: 2_048,
};

const snapshotPolicy = createWorkflowContentSnapshotPolicy({
  provider: "physical-tree",
  include: ["input.txt"],
  exclude: [],
  limits: {
    maxFiles: 8,
    maxFileBytes: 4_096,
    maxTotalBytes: 16_384,
    maxManifestBytes: 64 * 1_024,
    maxVisitedNodes: 64,
    maxDurationMs: 5_000,
    maxOmissionEntries: 32,
  },
});

const repairPolicy = {
  maxFailures: 5,
  warningThreshold: 2,
  manualStopThreshold: 3,
  allowedChoices: [
    { id: "retry", label: "Retry with a new approach", outcome: "retry" },
    { id: "stop", label: "Stop", outcome: "stop" },
    {
      id: "contract-change",
      label: "Change the contract",
      outcome: "contract-change",
    },
  ],
  allowOneTimeOverride: true,
  maxOverrideRationaleBytes: 256,
};

const phase4Profile: WorkflowDurabilityProfile = {
  version: 1,
  capabilities: [
    "mutation-locks",
    "revision-fences",
    "transition-journal",
    "verified-checkpoints",
    "content-snapshots",
    "verification-receipts",
    "repair-policy",
    "transactional-finalization",
  ],
  bounds: {
    runStateBytes: 512 * 1_024,
    pendingActionBytes: 256 * 1_024,
    trajectoryBytes: 8 * 1_024 * 1_024,
    artifactsBytes: 1 * 1_024 * 1_024,
    claimBytes: 16 * 1_024,
    transitionJournalBytes: 1 * 1_024 * 1_024,
    runLockBytes: 16 * 1_024,
    checkpointManifestBytes: 256 * 1_024,
    checkpointRecordBytes: 256 * 1_024,
    checkpointCount: 8,
    verificationReceiptBytes: 256 * 1_024,
    verificationReceiptCount: 32,
    repairHistoryBytes: 256 * 1_024,
    repairHistoryCount: 32,
    finalizationPlanBytes: 256 * 1_024,
    finalizationTransactionBytes: 1 * 1_024 * 1_024,
    finalizationReceiptBytes: 256 * 1_024,
    finalizationContentBytes: 64 * 1_024,
    finalizationOperationCount: 16,
    finalizationEventCount: 128,
  },
  schemaVersions: {
    runState: 1,
    pendingAction: 1,
    trajectory: 1,
    artifacts: 1,
    revisionClaim: 1,
    transitionJournal: 1,
    runLock: 1,
    checkpointManifest: 1,
    checkpointRecord: 1,
    contentSnapshot: 1,
    verificationReceipt: 1,
    repairEpisode: 1,
    finalizationTransaction: 1,
    finalizationReceipt: 1,
  },
  findingCatalogVersion: 1,
  snapshotPolicy,
  verificationPolicy,
  repairPolicy,
};

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function isProtectedPath(candidate: string): boolean {
  const segments = path.resolve(candidate).split(path.sep);
  return segments.includes("raw_data") || segments.includes("raw_skills");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

interface GeneratedFixture {
  packageRoot: string;
  protocol: WorkflowProtocol;
  packageHash: string;
}

interface ChildResult<T> {
  ok: boolean;
  value?: T;
  message?: string;
  findingCode?: string;
}

interface FinalizationReadyRun {
  location: WorkflowRunLocation;
  current: WorkflowContinuation;
  confirmation: NonNullable<
    NonNullable<WorkflowContinuation["pendingAction"]>["finalization"]
  >;
}

export interface Phase4CertificationResult {
  evidence: WorkflowRuntimePhase4CertificationEvidence;
  blockers: string[];
}

function machineNode(
  id: string,
  outputSchemas: string[] = [],
  guardrails: WorkflowInput["customNodes"][number]["guardrails"] = [],
): WorkflowInput["customNodes"][number] {
  return {
    id,
    label: id,
    kind: "action",
    responsibility: `Run the synthetic Phase 4 ${id} Node.`,
    implementation: {
      skill: `phase4-${id}`,
      operation: "default",
      scope: "main",
    },
    operations: ["require", "augment", "disable"],
    outputSchemas,
    guardrails,
  };
}

function phase4Workflow(
  name = "phase4-certification-workflow",
  profile = phase4Profile,
): WorkflowInput {
  return {
    kind: "workflow-kernel",
    name,
    goal: "Certify the generated Phase 4 WorkflowRuntime lifecycle.",
    capabilities: {
      version: 3,
      features: [
        "conditional-routing",
        "revisioned-attempts",
        "decision-nodes",
        "bounded-cycles",
        "versioned-artifacts",
      ],
      durability: structuredClone(profile),
    },
    customNodes: [
      machineNode("prepare", ["prepare.v1"]),
      machineNode(
        "verify",
        [],
        [
          {
            id: "phase4-verification",
            label: "Phase 4 verification",
            validation: "semantic",
            verification: {
              id: "phase4-verification",
              role: "phase4-verifier",
              kind: "automated-check",
              requireContentSnapshot: true,
            },
          },
        ],
      ),
      {
        id: "review",
        label: "Review the Phase 4 result",
        kind: "decision",
        responsibility: "Persist the reviewed Phase 4 route decision.",
        implementation: {
          skill: "phase4-review",
          operation: "default",
          scope: "review",
        },
        operations: ["require", "augment", "disable"],
        outputSchemas: [],
        guardrails: [],
        decision: {
          id: "phase4-review-decision",
          question: "Should the generated Phase 4 workflow finish?",
          choices: [
            { id: "repeat", label: "Repeat verification", to: "verify" },
            { id: "approve", label: "Approve completion", to: "finish" },
          ],
          inputs: { type: "object", fields: [] },
          rationale: { required: true },
          reviewer: {
            subjects: ["phase4-reviewer"],
            authorities: ["phase4:approve"],
          },
        },
      },
      machineNode("finish"),
    ],
    outputSchemas: [
      {
        id: "prepare.v1",
        description: "Synthetic Phase 4 preparation artifacts.",
        artifacts: [
          {
            id: "attempt-proof",
            kind: "file",
            required: true,
            paths: ["artifacts/*/attempt-proof.txt"],
            validations: ["artifact-exists"],
            lifetime: "attempt",
          },
          {
            id: "run-report",
            kind: "file",
            required: true,
            paths: ["artifacts/run-report.txt"],
            validations: ["artifact-exists"],
            lifetime: "run",
          },
        ],
        evidence: [{ id: "basis", required: true }],
      },
    ],
    routing: {
      fields: [{ id: "route", values: ["verify"] }],
      transitions: [
        { from: "prepare", to: "verify", condition: "success" },
        { from: "verify", to: "review", condition: "success" },
        { from: "review", to: "verify", condition: "success" },
        { from: "review", to: "finish", condition: "success" },
        { from: "finish", to: null, condition: "success" },
      ],
    },
    cycles: [
      {
        key: "phase4-verification-cycle",
        entry: "verify",
        repeatTransitions: [{ from: "review", to: "verify" }],
        maxInstances: 2,
      },
    ],
    finalization: {
      schemaVersion: 1,
      roots: [{ id: "project", path: "." }],
      operations: [
        {
          id: "write-report",
          kind: "write",
          root: "project",
          target: "results/final-report.txt",
          content: "phase4-finalized\n",
        },
        {
          id: "move-source",
          kind: "move",
          root: "project",
          source: "results/source.txt",
          target: "results/moved.txt",
        },
        {
          id: "remove-obsolete",
          kind: "remove",
          root: "project",
          target: "results/obsolete.txt",
        },
      ],
      confirmation: {
        required: true,
        reviewer: {
          subjects: ["phase4-reviewer"],
          authorities: ["phase4:finalize"],
        },
        rationale: { required: true },
      },
      requireContentSnapshot: true,
    },
  };
}

function proposalFor(
  protocol: WorkflowProtocol,
  input: WorkflowInput,
): { proposal: FactoryProposal; plan: FactoryPlan } {
  return {
    proposal: {
      schemaVersion: 1,
      name: protocol.name,
      goal: protocol.goal,
      intent: "new-skill",
      planHash: "phase4-certification-plan",
      workflow: protocol,
      candidates: [],
      blockers: [],
      warnings: [],
      canInitialize: true,
    },
    plan: {
      schemaVersion: 1,
      goal: protocol.goal,
      skillCreatorIntent: "new-skill",
      skillSources: [],
      workflow: input,
      defaultLocale: "en",
    },
  };
}

async function createFixture(root: string): Promise<GeneratedFixture> {
  const input = phase4Workflow();
  const protocol = normalizeWorkflow(input).protocol;
  const generated = await generatePackage({
    ...proposalFor(protocol, input),
    destination: path.join(root, "generated"),
  });
  return {
    packageRoot: generated.packageRoot,
    protocol,
    packageHash: await hashDirectory(generated.packageRoot),
  };
}

function cleanEnvironment(
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, ...extra };
}

function locationRoot(location: WorkflowRunLocation): string {
  return location.kind === "manual"
    ? location.runRoot
    : path.join(location.projectRoot, ".badger", "runs", location.runId);
}

function baseRoot(location: WorkflowRunLocation): string {
  return location.kind === "manual" ? location.runRoot : location.projectRoot;
}

function nodeFor(
  protocol: WorkflowProtocol,
  nodeId: string | null,
): NodeProtocol | undefined {
  return nodeId
    ? protocol.nodes.find((candidate) => candidate.id === nodeId)
    : undefined;
}

function concretePath(pattern: string, attemptId: string): string {
  return pattern
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => segment.replaceAll("*", attemptId))
    .join("/");
}

async function materializeArtifacts(
  runRoot: string,
  protocol: WorkflowProtocol,
  node: NodeProtocol,
  attemptId: string,
): Promise<Record<string, string>> {
  const artifacts: Record<string, string> = {};
  for (const schemaId of node.outputSchemas) {
    const schema = protocol.outputSchemas.find((item) => item.id === schemaId);
    if (!schema) throw new Error(`Missing Phase 4 schema: ${schemaId}`);
    for (const artifact of schema.artifacts) {
      if (!artifact.required || !artifact.paths[0]) continue;
      const relative = concretePath(artifact.paths[0], attemptId);
      const target = path.join(runRoot, ...relative.split("/"));
      if (artifact.kind === "directory") {
        await fs.mkdir(target, { recursive: true });
      } else {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(
          target,
          `phase4 ${schema.id}.${artifact.id} ${attemptId}\n`,
          "utf8",
        );
      }
      artifacts[`${schema.id}.${artifact.id}`] = relative;
    }
  }
  return artifacts;
}

function evidenceFor(
  protocol: WorkflowProtocol,
  node: NodeProtocol,
): Record<string, unknown> {
  const schemaEvidence: Record<string, string> = {};
  for (const schemaId of node.outputSchemas) {
    const schema = protocol.outputSchemas.find((item) => item.id === schemaId);
    if (!schema) throw new Error(`Missing Phase 4 schema: ${schemaId}`);
    for (const evidence of schema.evidence) {
      if (evidence.required) {
        schemaEvidence[`${schema.id}.${evidence.id}`] = `phase4-${node.id}`;
      }
    }
  }
  return {
    summary: `Synthetic Phase 4 evidence for ${node.id}.`,
    schemaEvidence,
  };
}

function verificationProposal(
  status: "passed" | "failed",
): Record<string, unknown> {
  return {
    kind: "automated-check",
    status,
    verifierSubject: "phase4-verifier",
    provider: "phase4-local-check",
    evidence: {
      summary:
        status === "passed" ? "Phase 4 check passed." : "Phase 4 check failed.",
      outputHash: "1".repeat(64),
      durationMs: 1,
      truncated: false,
    },
  };
}

function machineSubmission(
  current: WorkflowContinuation,
  nodeId: string,
  status: "succeeded" | "failed",
  evidence?: Record<string, unknown>,
  artifacts?: Record<string, string>,
  verification?: Record<string, unknown>,
): WorkflowSubmission {
  return {
    actionId: current.pendingAction!.id,
    runId: current.runId,
    revision: current.revision,
    nodeId,
    execution: current.execution,
    status,
    summary: `Synthetic Phase 4 ${status} outcome for ${nodeId}.`,
    ...(evidence ? { evidence } : {}),
    ...(artifacts ? { artifacts } : {}),
    ...(verification ? { verification } : {}),
  };
}

function decisionSubmission(
  current: WorkflowContinuation,
  choiceId: string,
  reviewer: string,
  authority: string,
  extra: Record<string, unknown> = {},
): WorkflowSubmission {
  const pending = current.pendingAction!;
  return {
    kind: "decision",
    actionId: pending.id,
    runId: current.runId,
    revision: current.revision,
    nodeId: current.currentNode,
    cycleId: current.cycleId,
    attemptId: current.attemptId,
    decisionId: pending.decisionId,
    choiceId,
    reviewer: { subject: reviewer, authorities: [authority] },
    rationale: "The synthetic Phase 4 evidence supports this decision.",
    execution: current.execution,
    ...extra,
  } as WorkflowSubmission;
}

function finalizationSubmission(
  current: WorkflowContinuation,
  confirmation: NonNullable<
    NonNullable<WorkflowContinuation["pendingAction"]>["finalization"]
  >,
): WorkflowSubmission {
  return decisionSubmission(
    current,
    "confirm",
    "phase4-reviewer",
    "phase4:finalize",
    {
      nodeId: null,
      cycleId: null,
      attemptId: null,
      rationale: "Confirm the synthetic local finalization.",
      finalization: {
        planHash: confirmation.planHash,
        decisionId: confirmation.decisionId,
        choiceId: "confirm",
        contentSnapshotHash: confirmation.contentSnapshotHash,
        verificationReceiptIds: confirmation.verificationReceiptIds,
      },
    },
  );
}

function withoutVolatileValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutVolatileValues);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(
          ([key]) =>
            ![
              "timestamp",
              "issuedAt",
              "createdAt",
              "committedAt",
              "confirmedAt",
              "recordedAt",
              "updatedAt",
              "at",
            ].includes(key),
        )
        .map(([key, nested]) => [key, withoutVolatileValues(nested)]),
    );
  }
  return value;
}

function sameContinuation(
  left: WorkflowContinuation,
  right: WorkflowContinuation,
): boolean {
  const normalize = (value: WorkflowContinuation): unknown => {
    const normalized = withoutVolatileValues(value) as Record<string, unknown>;
    delete normalized.findings;
    delete normalized.findingSummary;
    delete normalized.blockers;
    return normalized;
  };
  return (
    JSON.stringify(stableValue(normalize(left))) ===
    JSON.stringify(stableValue(normalize(right)))
  );
}

function sameIdentity(
  left: WorkflowExecutionIdentity,
  right: WorkflowExecutionIdentity,
): boolean {
  return (
    JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))
  );
}

function lifecycleShape(value: WorkflowContinuation): unknown {
  return {
    disposition: value.disposition,
    revision: value.revision,
    currentNode: value.currentNode,
    cycles: value.cycles.map(({ key, instanceOrdinal }) => ({
      key,
      instanceOrdinal,
    })),
    visits: value.visits.map(({ stepId, cycleId, visitOrdinal, outcomes }) => ({
      stepId,
      cycle: cycleId === null ? null : "present",
      visitOrdinal,
      outcomes: outcomes.map(({ status, repairDecision }) => ({
        status,
        repairChoice: repairDecision?.choiceId ?? null,
      })),
    })),
    decisions: value.decisionReceipts.map(({ nodeId, choiceId }) => ({
      nodeId,
      choiceId,
    })),
    verifications: value.verificationReceipts.map(
      ({ requirementId, status }) => ({ requirementId, status }),
    ),
    artifacts: value.artifactVersions.map(
      ({ artifactId, schemaId, lifetime }) => ({
        artifactId,
        schemaId,
        lifetime,
      }),
    ),
    repair: value.repair
      ? {
          disposition: value.repair.disposition,
          totalFailures: value.repair.totalFailures,
          consecutiveFailures: value.repair.consecutiveFailures,
          historyKinds: value.repair.history.map(({ kind }) => kind),
        }
      : null,
    finalization: value.finalization
      ? {
          status: value.finalization.status,
          receiptStatus: value.finalization.receipt?.status ?? null,
        }
      : null,
  };
}

function targetArgs(location: WorkflowRunLocation): string[] {
  return location.kind === "manual"
    ? ["--run-root", location.runRoot]
    : ["--project", location.projectRoot, "--run-id", location.runId];
}

async function runGeneratedJson<T>(
  packageRoot: string,
  scriptName: string,
  args: string[],
): Promise<T> {
  const result = await execFileAsync(
    process.execPath,
    [path.join(packageRoot, "scripts", scriptName), ...args],
    { cwd: packageRoot, env: cleanEnvironment() },
  );
  return JSON.parse(result.stdout) as T;
}

function runGeneratedState(
  packageRoot: string,
  args: string[],
): Promise<WorkflowContinuation> {
  return runGeneratedJson<WorkflowContinuation>(
    packageRoot,
    "workflow-state.mjs",
    args,
  );
}

async function runChildJson<T>(
  packageRoot: string,
  source: string,
  environment: Record<string, string> = {},
): Promise<T> {
  const result = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", source],
    {
      cwd: packageRoot,
      env: cleanEnvironment(environment),
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return JSON.parse(result.stdout) as T;
}

function childRuntimeUrl(packageRoot: string): string {
  return pathToFileURL(
    path.join(packageRoot, "scripts", "workflow-runtime.mjs"),
  ).href;
}

async function childCall<T>(
  packageRoot: string,
  operation: string,
  target: WorkflowRunLocation | string,
  argument?: unknown,
  environment: Record<string, string> = {},
): Promise<ChildResult<T>> {
  const runtimeUrl = childRuntimeUrl(packageRoot);
  const targetText = JSON.stringify(target);
  const argumentText =
    argument === undefined ? "undefined" : JSON.stringify(argument);
  const invocation =
    operation === "start"
      ? `start({ protocol: JSON.parse(await fs.readFile(${JSON.stringify(path.join(packageRoot, "reference", "workflow-protocol.json"))}, "utf8")), location: target })`
      : `${operation}(target${argument === undefined ? "" : `, ${argumentText}`})`;
  const source = `import { promises as fs } from "node:fs"; const target = ${targetText}; const runtimeModule = await import(${JSON.stringify(runtimeUrl)}); try { const value = await runtimeModule.createWorkflowRuntime().${invocation}; console.log(JSON.stringify({ ok: true, value })); } catch (error) { console.log(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error), findingCode: error && typeof error === "object" && "finding" in error && error.finding && typeof error.finding === "object" && "code" in error.finding ? error.finding.code : undefined })); }`;
  return runChildJson<ChildResult<T>>(packageRoot, source, environment);
}

async function recoverFresh(
  packageRoot: string,
  location: WorkflowRunLocation,
  options?: Record<string, unknown>,
): Promise<WorkflowContinuation> {
  const result = await childCall<WorkflowContinuation>(
    packageRoot,
    "recover",
    location,
    options,
  );
  if (!result.ok || !result.value) {
    throw new Error(result.message ?? "Fresh-process recovery failed");
  }
  return result.value;
}

async function generatedAdapterSourceCheck(
  packageRoot: string,
): Promise<boolean> {
  const forbidden = [
    "resolveWorkflowNext",
    "resolveWorkflowTransition",
    "allocateCycle",
    "decisionReceipts.push",
    "first-incomplete",
    "reviewer-policy",
    "setWorkflowTransitionFaultForTests",
    "setWorkflowFinalizationFaultForTests",
    "writeRunState",
    "writePendingAction",
    "appendEvent",
    "createWorkflowTransition",
    "acquireRevisionClaim",
    "captureWorkflowContentSnapshot",
    "stageWorkflowVerificationReceipt",
    "fs.writeFile",
    "fs.appendFile",
    "fs.rename",
    "fs.rm",
  ];
  for (const relative of [
    "SKILL.md",
    path.join("scripts", "workflow-state.mjs"),
    path.join("scripts", "workflow-guard.mjs"),
    path.join("scripts", "workflow-handoff.mjs"),
  ]) {
    const source = await fs.readFile(path.join(packageRoot, relative), "utf8");
    if (forbidden.some((token) => source.includes(token))) return false;
  }
  return true;
}

async function prepareBaseFiles(location: WorkflowRunLocation): Promise<void> {
  const root = baseRoot(location);
  await fs.writeFile(path.join(root, "input.txt"), "phase4-input\n", "utf8");
  await fs.mkdir(path.join(root, "results"), { recursive: true });
  await fs.writeFile(
    path.join(root, "results", "source.txt"),
    "source\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "results", "obsolete.txt"),
    "obsolete\n",
    "utf8",
  );
}

async function completeThroughGenerated(
  fixture: GeneratedFixture,
  runtime: WorkflowRuntime,
  location: WorkflowRunLocation,
  existing?: WorkflowContinuation,
): Promise<WorkflowContinuation> {
  let current =
    existing ??
    (location.kind === "manual"
      ? await runtime.start({
          protocol: fixture.protocol,
          runRoot: location.runRoot,
        })
      : await runtime.start({ protocol: fixture.protocol, location }));
  let failureCount = 0;
  let repeated = false;
  for (let iteration = 0; current.pendingAction; iteration += 1) {
    if (iteration > 20)
      throw new Error("Phase 4 generated adapter did not finish");
    if (current.pendingAction.finalization) {
      current = await runGeneratedState(fixture.packageRoot, [
        "decide",
        "finalization",
        JSON.stringify({
          choiceId: "confirm",
          reviewer: {
            subject: "phase4-reviewer",
            authorities: ["phase4:finalize"],
          },
          rationale: "Confirm the synthetic local finalization.",
          finalization: {
            planHash: current.pendingAction.finalization.planHash,
            decisionId: current.pendingAction.finalization.decisionId,
            choiceId: "confirm",
            contentSnapshotHash:
              current.pendingAction.finalization.contentSnapshotHash,
            verificationReceiptIds:
              current.pendingAction.finalization.verificationReceiptIds,
          },
        }),
        ...targetArgs(location),
        "--json",
      ]);
      continue;
    }
    if (!current.currentNode)
      throw new Error("Phase 4 generated action has no Node");
    const node = nodeFor(fixture.protocol, current.currentNode);
    if (!node) throw new Error(`Missing Phase 4 Node: ${current.currentNode}`);
    if (current.repair?.pendingDecision) {
      current = await runGeneratedState(fixture.packageRoot, [
        "decide",
        node.id,
        JSON.stringify({
          choiceId: "retry",
          reviewer: {
            subject: "phase4-reviewer",
            authorities: ["phase4:repair"],
          },
          rationale: "Retry the synthetic Phase 4 verification.",
        }),
        ...targetArgs(location),
        "--json",
      ]);
    } else if (node.id === "prepare") {
      const artifacts = await materializeArtifacts(
        locationRoot(location),
        fixture.protocol,
        node,
        current.attemptId!,
      );
      current = await runGeneratedState(fixture.packageRoot, [
        "record",
        node.id,
        JSON.stringify({ ...evidenceFor(fixture.protocol, node), artifacts }),
        ...targetArgs(location),
        "--json",
      ]);
    } else if (node.id === "verify") {
      const status = failureCount < 3 ? "failed" : "succeeded";
      failureCount += status === "failed" ? 1 : 0;
      current = await runGeneratedState(fixture.packageRoot, [
        "record",
        node.id,
        JSON.stringify({
          ...evidenceFor(fixture.protocol, node),
          verification: verificationProposal(
            status === "succeeded" ? "passed" : "failed",
          ),
          ...(status === "failed" ? { status } : {}),
        }),
        ...targetArgs(location),
        "--json",
      ]);
    } else if (node.id === "review") {
      const choiceId = repeated ? "approve" : "repeat";
      repeated = true;
      current = await runGeneratedState(fixture.packageRoot, [
        "decide",
        node.id,
        JSON.stringify({
          choiceId,
          reviewer: {
            subject: "phase4-reviewer",
            authorities: ["phase4:approve"],
          },
          rationale: "Approve the synthetic Phase 4 result.",
        }),
        ...targetArgs(location),
        "--json",
      ]);
    } else {
      await prepareBaseFiles(location);
      current = await runGeneratedState(fixture.packageRoot, [
        "record",
        node.id,
        JSON.stringify(evidenceFor(fixture.protocol, node)),
        ...targetArgs(location),
        "--json",
      ]);
    }
  }
  return current;
}

async function runMainLifecycle(
  fixture: GeneratedFixture,
  temporaryRoot: string,
  evidence: WorkflowRuntimePhase4CertificationEvidence,
): Promise<WorkflowContinuation> {
  const runtime = createWorkflowRuntime();
  const location: WorkflowRunLocation = {
    kind: "manual",
    runRoot: path.join(temporaryRoot, "main-run"),
  };
  const runId = evidence.runId;
  await fs.mkdir(location.runRoot, { recursive: true });
  await prepareBaseFiles(location);
  const started = await runGeneratedState(fixture.packageRoot, [
    "init",
    "--run-root",
    location.runRoot,
    "--run-id",
    runId,
    "--json",
  ]);
  evidence.identity = structuredClone(started.execution);
  evidence.lifecycle.machineWork = started.currentNode === "prepare";
  evidence.adapters.generatedToPublic = started.currentNode === "prepare";
  evidence.freshProcess.pendingAction = sameContinuation(
    started,
    await recoverFresh(fixture.packageRoot, location),
  );
  let current = await runtime.recover(location);
  const prepare = nodeFor(fixture.protocol, "prepare")!;
  const artifacts = await materializeArtifacts(
    locationRoot(location),
    fixture.protocol,
    prepare,
    current.attemptId!,
  );
  current = await runtime.submit(
    location,
    machineSubmission(
      current,
      "prepare",
      "succeeded",
      evidenceFor(fixture.protocol, prepare),
      artifacts,
    ),
  );
  for (let failure = 0; failure < 3; failure += 1) {
    current = await runtime.submit(
      location,
      machineSubmission(
        current,
        "verify",
        "failed",
        undefined,
        undefined,
        verificationProposal("failed"),
      ),
    );
  }
  evidence.lifecycle.repairEpisode =
    current.repair?.totalFailures === 3 &&
    current.repair.history.some(
      (record) =>
        record.kind === "failure" && record.disposition === "manual-stop",
    );
  evidence.freshProcess.decision = sameContinuation(
    current,
    await recoverFresh(fixture.packageRoot, location),
  );
  const repairDecision = decisionSubmission(
    current,
    "retry",
    "phase4-reviewer",
    "phase4:repair",
  );
  current = await runtime.submit(location, repairDecision);
  evidence.lifecycle.persistedDecision =
    current.repair?.history.some(
      (record) => record.kind === "decision" && record.choiceId === "retry",
    ) ?? false;
  current = await runtime.submit(
    location,
    machineSubmission(
      current,
      "verify",
      "succeeded",
      undefined,
      undefined,
      verificationProposal("passed"),
    ),
  );
  evidence.lifecycle.verificationRequirement =
    current.verificationReceipts.some(
      (receipt) =>
        receipt.requirementId === "phase4-verification" &&
        receipt.status === "passed",
    );
  evidence.lifecycle.versionedArtifacts = current.artifactVersions.length >= 2;
  evidence.lifecycle.contentSnapshot =
    current.contentSnapshots.length === 1 &&
    current.contentSnapshots[0].complete;
  current = await runtime.submit(
    location,
    decisionSubmission(current, "repeat", "phase4-reviewer", "phase4:approve"),
  );
  evidence.freshProcess.decision =
    evidence.freshProcess.decision &&
    sameContinuation(
      current,
      await recoverFresh(fixture.packageRoot, location),
    );
  current = await runtime.submit(
    location,
    machineSubmission(
      current,
      "verify",
      "succeeded",
      undefined,
      undefined,
      verificationProposal("passed"),
    ),
  );
  current = await runtime.submit(
    location,
    decisionSubmission(current, "approve", "phase4-reviewer", "phase4:approve"),
  );
  await prepareBaseFiles(location);
  current = await runtime.submit(
    location,
    machineSubmission(
      current,
      "finish",
      "succeeded",
      evidenceFor(fixture.protocol, nodeFor(fixture.protocol, "finish")!),
    ),
  );
  evidence.lifecycle.finalizationPreview =
    current.pendingAction?.finalization !== undefined &&
    (await previewWorkflowFinalization(location)).operations.length === 3;
  const finalizationFresh = await recoverFresh(fixture.packageRoot, location);
  evidence.freshProcess.finalization = sameContinuation(
    current,
    finalizationFresh,
  );
  const finalization = current.pendingAction!.finalization!;
  current = await runtime.submit(
    location,
    finalizationSubmission(current, finalization),
  );
  evidence.lifecycle.finalizationConfirmed = current.disposition === "done";
  evidence.lifecycle.finalReceipt =
    current.finalization?.receipt?.status === "committed" &&
    current.finalization.receipt.receiptHash.length === 64;
  const terminalFresh = await recoverFresh(fixture.packageRoot, location);
  evidence.freshProcess.terminal = sameContinuation(current, terminalFresh);
  evidence.identities.nodeAction =
    Object.keys(current.execution.nodeToStep).length ===
      fixture.protocol.nodes.length &&
    current.visits.every((visit) =>
      Object.values(current.execution.nodeToStep).includes(visit.stepId),
    );
  evidence.identities.cycleAttempt =
    current.cycles.length === 2 &&
    current.visits.some(
      (visit) => visit.cycleId !== null && visit.attemptId.length > 0,
    );
  evidence.identities.contentSnapshot = await contentSnapshotIdentity(
    location,
    current,
  );
  evidence.identities.verificationReceipt = await verificationReceiptIdentity(
    location,
    current,
  );
  evidence.identities.finalizationReceipt = await finalizationReceiptIdentity(
    location,
    current,
  );
  evidence.identities.finalizationTransaction =
    evidence.identities.finalizationReceipt;
  evidence.identities.checkpoint = await checkpointIdentity(location, current);
  evidence.lifecycle.verifiedCheckpoint = evidence.identities.checkpoint;
  evidence.freshProcess.checkpoint = evidence.identities.checkpoint;
  evidence.identities.generatedPackageTree =
    fixture.packageHash === (await hashDirectory(fixture.packageRoot));
  const finalReport = path.join(
    baseRoot(location),
    "results",
    "final-report.txt",
  );
  const moved = path.join(baseRoot(location), "results", "moved.txt");
  const source = path.join(baseRoot(location), "results", "source.txt");
  const obsolete = path.join(baseRoot(location), "results", "obsolete.txt");
  evidence.lifecycle.finalizationConfirmed =
    evidence.lifecycle.finalizationConfirmed &&
    (await fs.readFile(finalReport, "utf8")) === "phase4-finalized\n" &&
    (await fs.readFile(moved, "utf8")) === "source\n" &&
    !(await exists(source)) &&
    !(await exists(obsolete));
  return current;
}

async function contentSnapshotIdentity(
  location: WorkflowRunLocation,
  current: WorkflowContinuation,
): Promise<boolean> {
  const reference = current.contentSnapshots[0];
  if (!reference) return false;
  const manifest = await readWorkflowContentSnapshot(
    locationRoot(location),
    reference.hash,
    phase4Profile.bounds.runStateBytes,
  );
  return Boolean(
    manifest &&
    manifest.complete &&
    manifest.capture.provider === reference.provider,
  );
}

async function verificationReceiptIdentity(
  location: WorkflowRunLocation,
  current: WorkflowContinuation,
): Promise<boolean> {
  const passed = current.verificationReceipts.find(
    (receipt) => receipt.status === "passed",
  );
  if (!passed) return false;
  const receipt =
    await import("../workflow-runtime/verification-receipts.js").then(
      ({ readWorkflowVerificationReceipt }) =>
        readWorkflowVerificationReceipt(
          locationRoot(location),
          passed.receiptHash,
          phase4Profile,
        ),
    );
  return Boolean(
    receipt &&
    receipt.receiptHash === passed.receiptHash &&
    receipt.runId === current.runId &&
    sameIdentity(receipt.execution, current.execution),
  );
}

async function finalizationReceiptIdentity(
  location: WorkflowRunLocation,
  current: WorkflowContinuation,
): Promise<boolean> {
  const reference = current.finalization?.receipt;
  if (!reference) return false;
  const receipt = await readWorkflowFinalizationReceipt(
    locationRoot(location),
    reference.receiptHash,
    phase4Profile,
  );
  return Boolean(
    receipt &&
    receipt.receiptHash === reference.receiptHash &&
    receipt.transactionId === reference.transactionId &&
    receipt.runId === current.runId &&
    receipt.recovery.status === "none",
  );
}

async function checkpointIdentity(
  location: WorkflowRunLocation,
  current: WorkflowContinuation,
): Promise<boolean> {
  const index = await readWorkflowCheckpointIndex(
    locationRoot(location),
    phase4Profile,
  );
  if (!index || index.runId !== current.runId || index.records.length === 0)
    return false;
  const inspections = await inspectWorkflowCheckpointCandidates(
    locationRoot(location),
    phase4Profile,
    { expectedRunId: current.runId, expectedExecution: current.execution },
  );
  const latest = inspections
    .filter((inspection) => inspection.verification)
    .sort((left, right) => right.entry.revision - left.entry.revision)[0];
  return Boolean(
    latest?.verification &&
    latest.verification.manifest.revision === current.revision &&
    latest.verification.state.runId === current.runId &&
    sameIdentity(latest.verification.identity, current.execution),
  );
}

async function runReverseAdapterLifecycle(
  fixture: GeneratedFixture,
  temporaryRoot: string,
  evidence: WorkflowRuntimePhase4CertificationEvidence,
): Promise<WorkflowContinuation> {
  const runtime = createWorkflowRuntime();
  const location: WorkflowRunLocation = {
    kind: "standalone",
    projectRoot: path.join(temporaryRoot, "reverse-project"),
    runId: evidence.reverseRunId,
  };
  await fs.mkdir(location.projectRoot, { recursive: true });
  await prepareBaseFiles(location);
  const started = await runtime.start({ protocol: fixture.protocol, location });
  const completed = await completeThroughGenerated(
    fixture,
    runtime,
    location,
    started,
  );
  evidence.adapters.publicToGenerated =
    started.currentNode === "prepare" && completed.disposition === "done";
  evidence.locations.standalone = completed.disposition === "done";
  evidence.adapters.projectionsConsistent =
    sameIdentity(started.execution, completed.execution) &&
    (await projectWorkflowState(location))?.runId === completed.runId &&
    (await projectWorkflowHandoff(fixture.protocol, completed)).continuation
      ?.runId === completed.runId;
  return completed;
}

async function checkpointNegativeCase(
  fixture: GeneratedFixture,
  root: string,
): Promise<boolean> {
  const runRoot = path.join(root, "checkpoint-mismatch");
  await fs.mkdir(runRoot, { recursive: true });
  await prepareBaseFiles({ kind: "manual", runRoot });
  const runtime = createWorkflowRuntime();
  const started = await runtime.start({
    protocol: fixture.protocol,
    runRoot,
    runId: "phase4-checkpoint-mismatch",
  });
  const index = await readWorkflowCheckpointIndex(runRoot, phase4Profile);
  const latest = index?.records[0];
  if (!latest) return false;
  const manifestPath = path.join(
    runRoot,
    ".badger",
    "checkpoints",
    "manifests",
    `${latest.manifestHash}.json`,
  );
  const manifest = JSON.parse(
    await fs.readFile(manifestPath, "utf8"),
  ) as Record<string, unknown>;
  manifest.revision = Number(manifest.revision) + 1;
  await fs.writeFile(manifestPath, JSON.stringify(manifest) + "\n", "utf8");
  const inspections = await inspectWorkflowCheckpointCandidates(
    runRoot,
    phase4Profile,
    { expectedRunId: started.runId, expectedExecution: started.execution },
  );
  const invalid = inspections.some((inspection) => inspection.error);
  const recovered = await runtime.recover(runRoot);
  return (
    invalid &&
    recovered.findings.some((finding) => finding.code === "checkpoint-invalid")
  );
}

async function staleReceiptNegativeCase(
  fixture: GeneratedFixture,
  root: string,
): Promise<boolean> {
  const location: WorkflowRunLocation = {
    kind: "manual",
    runRoot: path.join(root, "stale-receipt"),
  };
  await fs.mkdir(location.runRoot, { recursive: true });
  await prepareBaseFiles(location);
  const runtime = createWorkflowRuntime();
  let current = await runtime.start({
    protocol: fixture.protocol,
    location,
    runId: "phase4-stale-receipt",
  });
  const prepare = nodeFor(fixture.protocol, "prepare")!;
  current = await runtime.submit(
    location,
    machineSubmission(
      current,
      "prepare",
      "succeeded",
      evidenceFor(fixture.protocol, prepare),
      await materializeArtifacts(
        locationRoot(location),
        fixture.protocol,
        prepare,
        current.attemptId!,
      ),
    ),
  );
  current = await runtime.submit(
    location,
    machineSubmission(
      current,
      "verify",
      "succeeded",
      undefined,
      undefined,
      verificationProposal("passed"),
    ),
  );
  const receipt = current.verificationReceipts.find(
    (candidate) => candidate.status === "passed",
  );
  if (!receipt) return false;
  await fs.rm(
    path.join(
      locationRoot(location),
      ".badger",
      "verification-receipts",
      `${receipt.receiptHash}.json`,
    ),
  );
  try {
    await runtime.resume(location);
    return false;
  } catch (error) {
    return (
      (error as { finding?: { code?: string } }).finding?.code ===
      "verification-receipt-invalid"
    );
  }
}

async function contentDriftNegativeCase(
  fixture: GeneratedFixture,
  root: string,
): Promise<boolean> {
  const location: WorkflowRunLocation = {
    kind: "manual",
    runRoot: path.join(root, "content-drift"),
  };
  await fs.mkdir(location.runRoot, { recursive: true });
  await prepareBaseFiles(location);
  const runtime = createWorkflowRuntime();
  let current = await runtime.start({
    protocol: fixture.protocol,
    location,
    runId: "phase4-content-drift",
  });
  const prepare = nodeFor(fixture.protocol, "prepare");
  if (!prepare) return false;
  current = await runtime.submit(
    location,
    machineSubmission(
      current,
      "prepare",
      "succeeded",
      evidenceFor(fixture.protocol, prepare),
      await materializeArtifacts(
        locationRoot(location),
        fixture.protocol,
        prepare,
        current.attemptId!,
      ),
    ),
  );
  const trajectoryPath = path.join(
    locationRoot(location),
    ".badger",
    "trajectory.jsonl",
  );
  const beforeTrajectory = await fs.readFile(trajectoryPath, "utf8");
  const beforeState = await readRunState(locationRoot(location));
  await fs.writeFile(
    path.join(baseRoot(location), "input.txt"),
    "phase4-content-drift\n",
    "utf8",
  );
  const blocked = await runtime.submit(
    location,
    machineSubmission(
      current,
      "verify",
      "succeeded",
      undefined,
      undefined,
      verificationProposal("passed"),
    ),
  );
  if (blocked.disposition !== "blocked") {
    throw new Error(
      `Phase 4 content drift probe did not block: ${blocked.disposition}`,
    );
  }
  const afterState = await readRunState(locationRoot(location));
  const afterTrajectory = await fs.readFile(trajectoryPath, "utf8");
  return (
    blocked.disposition === "blocked" &&
    blocked.findings.some(
      (finding) => finding.code === "verification-receipt-stale",
    ) &&
    beforeState?.workflowRuntime?.revision ===
      afterState?.workflowRuntime?.revision &&
    beforeTrajectory === afterTrajectory
  );
}

async function snapshotNegativeCases(
  root: string,
): Promise<{ overflow: boolean; unstable: boolean }> {
  const overflowRoot = path.join(root, "snapshot-overflow");
  await fs.mkdir(overflowRoot, { recursive: true });
  await fs.writeFile(path.join(overflowRoot, "one.txt"), "one\n", "utf8");
  await fs.writeFile(path.join(overflowRoot, "two.txt"), "two\n", "utf8");
  const overflowPolicy = createWorkflowContentSnapshotPolicy({
    provider: "physical-tree",
    include: ["**/*"],
    limits: {
      maxFiles: 1,
      maxVisitedNodes: 16,
      maxManifestBytes: 16 * 1_024,
    },
  });
  const overflowManifest = await captureWorkflowContentSnapshot({
    root: overflowRoot,
    policy: overflowPolicy,
  });
  const unstableRoot = path.join(root, "snapshot-unstable");
  await fs.mkdir(unstableRoot, { recursive: true });
  const unstablePath = path.join(unstableRoot, "input.txt");
  await fs.writeFile(unstablePath, "before\n", "utf8");
  let changed = false;
  const unstableManifest = await captureWorkflowContentSnapshot({
    root: unstableRoot,
    policy: createWorkflowContentSnapshotPolicy({
      provider: "physical-tree",
      include: ["input.txt"],
      limits: { maxManifestBytes: 16 * 1_024 },
    }),
    hooks: {
      beforeFileRead: async () => {
        if (!changed) {
          changed = true;
          await fs.writeFile(unstablePath, "after\n", "utf8");
        }
      },
    },
  });
  return {
    overflow: !overflowManifest.complete && overflowManifest.omittedCount > 0,
    unstable:
      !unstableManifest.complete &&
      unstableManifest.omitted.some((omission) =>
        ["changed-during-read", "physical-selection-changed"].includes(
          omission.reason,
        ),
      ),
  };
}

async function repairNegativeCases(
  fixture: GeneratedFixture,
  root: string,
): Promise<{ stagnation: boolean; overrideExhaustion: boolean }> {
  const runRoot = path.join(root, "repair-negative");
  await fs.mkdir(runRoot, { recursive: true });
  await prepareBaseFiles({ kind: "manual", runRoot });
  const runtime = createWorkflowRuntime();
  let current = await runtime.start({
    protocol: fixture.protocol,
    runRoot,
    runId: "phase4-repair-negative",
  });
  const prepare = nodeFor(fixture.protocol, "prepare");
  if (!prepare) return { stagnation: false, overrideExhaustion: false };
  current = await runtime.submit(
    runRoot,
    machineSubmission(
      current,
      "prepare",
      "succeeded",
      evidenceFor(fixture.protocol, prepare),
      await materializeArtifacts(
        runRoot,
        fixture.protocol,
        prepare,
        current.attemptId!,
      ),
    ),
  );
  for (let failure = 0; failure < 3; failure += 1) {
    current = await runtime.submit(
      runRoot,
      machineSubmission(
        current,
        "verify",
        "failed",
        undefined,
        undefined,
        verificationProposal("failed"),
      ),
    );
  }
  const stagnation = current.repair?.disposition === "manual-stop";
  const signatureHash = current.repair?.signature?.signatureHash;
  if (!signatureHash) return { stagnation, overrideExhaustion: false };
  const overridden = await runtime.submit(
    runRoot,
    decisionSubmission(current, "retry", "phase4-reviewer", "phase4:repair", {
      repair: {
        expectedSignatureHash: signatureHash,
        rationale: "Use the independent synthetic repair path.",
        hypothesis: "Preserve all checks while changing the repair path.",
      },
    }),
  );
  current = await runtime.submit(
    runRoot,
    machineSubmission(
      overridden,
      "verify",
      "failed",
      undefined,
      undefined,
      verificationProposal("failed"),
    ),
  );
  const before = current;
  let rejected = false;
  try {
    await runtime.submit(
      runRoot,
      decisionSubmission(current, "retry", "phase4-reviewer", "phase4:repair", {
        repair: {
          expectedSignatureHash: signatureHash,
          rationale: "Use the independent synthetic repair path.",
          hypothesis: "Preserve all checks while changing the repair path.",
        },
      }),
    );
  } catch (error) {
    rejected =
      (error as { finding?: { code?: string } }).finding?.code ===
      "repair-override-exhausted";
  }
  if (!rejected) {
    rejected = current.findings.some(
      (finding) => finding.code === "repair-override-exhausted",
    );
  }
  return {
    stagnation,
    overrideExhaustion:
      rejected && sameContinuation(before, await runtime.recover(runRoot)),
  };
}

async function lockNegativeCases(
  fixture: GeneratedFixture,
  root: string,
): Promise<{ stale: boolean; unknown: boolean }> {
  const runtime = createWorkflowRuntime();
  const staleRoot = path.join(root, "stale-lock");
  await fs.mkdir(staleRoot, { recursive: true });
  await prepareBaseFiles({ kind: "manual", runRoot: staleRoot });
  const staleStarted = await runtime.start({
    protocol: fixture.protocol,
    runRoot: staleRoot,
    runId: "phase4-stale-lock",
  });
  await fs.writeFile(
    path.join(staleRoot, ".badger", "run-lock.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "workflow-run-lock",
      ownerToken: "11111111-1111-4111-8111-111111111111",
      pid: ABSENT_PID,
      hostname: os.hostname(),
      createdAt: "2026-09-01T00:00:00.000Z",
      operation: "workflow.resume",
    }) + "\n",
    "utf8",
  );
  const stale = await runtime.resume(staleRoot);
  const staleRecovered = await runtime.recover(staleRoot);
  const staleResult =
    stale.disposition === "blocked" &&
    stale.findings.some((finding) => finding.code === "run-lock-stale") &&
    sameContinuation(staleStarted, staleRecovered);
  const unknownRoot = path.join(root, "unknown-lock");
  await fs.mkdir(unknownRoot, { recursive: true });
  await prepareBaseFiles({ kind: "manual", runRoot: unknownRoot });
  const unknownStarted = await runtime.start({
    protocol: fixture.protocol,
    runRoot: unknownRoot,
    runId: "phase4-unknown-lock",
  });
  const unknownBefore = await readRunState(unknownRoot);
  await fs.writeFile(
    path.join(unknownRoot, ".badger", "run-lock.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "workflow-run-lock",
      ownerToken: "22222222-2222-4222-8222-222222222222",
      pid: 1,
      hostname: "foreign-phase4-host",
      createdAt: "2026-09-01T00:00:00.000Z",
      operation: "workflow.resume",
    }) + "\n",
    "utf8",
  );
  const unknown = await runtime.resume(unknownRoot);
  const unknownRecovered = await runtime.recover(unknownRoot);
  const unknownAfter = await readRunState(unknownRoot);
  return {
    stale: staleResult,
    unknown:
      unknown.disposition === "blocked" &&
      unknown.findings.some((finding) => finding.code === "run-lock-unknown") &&
      unknownRecovered.disposition === "blocked" &&
      unknownRecovered.findings.some(
        (finding) => finding.code === "run-lock-unknown",
      ) &&
      JSON.stringify(withoutVolatileValues(unknownAfter)) ===
        JSON.stringify(withoutVolatileValues(unknownBefore)),
  };
}

async function changedJournalNegativeCase(
  fixture: GeneratedFixture,
  root: string,
): Promise<boolean> {
  const runRoot = path.join(root, "changed-journal");
  await fs.mkdir(runRoot, { recursive: true });
  await prepareBaseFiles({ kind: "manual", runRoot });
  const runtime = createWorkflowRuntime();
  const started = await runtime.start({
    protocol: fixture.protocol,
    runRoot,
    runId: "phase4-changed-journal",
  });
  setWorkflowTransitionFaultForTests({
    phase: "record-write",
    path: ".badger/run-state.json",
  });
  try {
    await runtime.submit(
      runRoot,
      machineSubmission(
        started,
        "prepare",
        "succeeded",
        evidenceFor(fixture.protocol, nodeFor(fixture.protocol, "prepare")!),
        await materializeArtifacts(
          runRoot,
          fixture.protocol,
          nodeFor(fixture.protocol, "prepare")!,
          started.attemptId!,
        ),
      ),
    );
  } catch {
  } finally {
    clearWorkflowTransitionFaultForTests();
  }
  await fs.writeFile(
    path.join(runRoot, ".badger", "run-state.json"),
    '{"tampered":true}\n',
    "utf8",
  );
  const journal = await readWorkflowTransitionJournal(runRoot);
  const blocked = await runtime.recover(runRoot);
  return (
    journal !== null &&
    blocked.disposition === "blocked" &&
    blocked.findings.some((finding) => finding.code === "recovery-required")
  );
}

async function legacyNegativeCase(root: string): Promise<boolean> {
  const runRoot = path.join(root, "legacy-run");
  await fs.mkdir(runRoot, { recursive: true });
  const legacy = normalizeWorkflow({
    kind: "workflow-kernel",
    name: "phase4-legacy-workflow",
    goal: "Keep a legacy Run unchanged.",
    customNodes: [machineNode("legacy")],
  }).protocol;
  const runtime = createWorkflowRuntime();
  const started = await runtime.start({
    protocol: legacy,
    runRoot,
    runId: "legacy-run",
  });
  const stateBefore = await readRunState(runRoot);
  const recovered = await runtime.recover(runRoot);
  const stateAfter = await readRunState(runRoot);
  return (
    started.execution.durabilityProfile === undefined &&
    stateBefore?.workflowRuntime === undefined &&
    recovered.execution.durabilityProfile === undefined &&
    stateAfter?.workflowRuntime === undefined
  );
}

async function finalizationReadyRun(
  fixture: GeneratedFixture,
  root: string,
  runId: string,
): Promise<FinalizationReadyRun> {
  const location: WorkflowRunLocation = {
    kind: "manual",
    runRoot: path.join(root, runId),
  };
  await fs.mkdir(location.runRoot, { recursive: true });
  await prepareBaseFiles(location);
  const runtime = createWorkflowRuntime();
  let current = await runtime.start({ protocol: fixture.protocol, location });
  if (nodeFor(fixture.protocol, "prepare")) {
    const prepare = nodeFor(fixture.protocol, "prepare")!;
    current = await runtime.submit(
      location,
      machineSubmission(
        current,
        "prepare",
        "succeeded",
        evidenceFor(fixture.protocol, prepare),
        await materializeArtifacts(
          locationRoot(location),
          fixture.protocol,
          prepare,
          current.attemptId!,
        ),
      ),
    );
    current = await runtime.submit(
      location,
      machineSubmission(
        current,
        "verify",
        "succeeded",
        undefined,
        undefined,
        verificationProposal("passed"),
      ),
    );
    current = await runtime.submit(
      location,
      decisionSubmission(
        current,
        "approve",
        "phase4-reviewer",
        "phase4:approve",
      ),
    );
  }
  await prepareBaseFiles(location);
  current = await runtime.submit(
    location,
    machineSubmission(
      current,
      "finish",
      "succeeded",
      evidenceFor(fixture.protocol, nodeFor(fixture.protocol, "finish")!),
    ),
  );
  if (!current.pendingAction?.finalization)
    throw new Error("Finalization confirmation was not created");
  return {
    location,
    current,
    confirmation: current.pendingAction.finalization,
  };
}

async function finalizationRollbackCase(
  fixture: GeneratedFixture,
  root: string,
): Promise<boolean> {
  const prepared = await finalizationReadyRun(fixture, root, "rollback-case");
  const confirmation = prepared.confirmation;
  setWorkflowFinalizationFaultForTests({ phase: "after-operation" });
  try {
    await createWorkflowRuntime().submit(
      prepared.location,
      finalizationSubmission(prepared.current, confirmation),
    );
  } catch {
  } finally {
    clearWorkflowFinalizationFaultForTests();
  }
  const recovered = await createWorkflowRuntime().recover(prepared.location, {
    rollbackFinalization: true,
  });
  return (
    recovered.disposition === "blocked" &&
    recovered.finalization?.status === "rolled-back" &&
    recovered.finalization.receipt?.status === "rolled-back" &&
    (await fs.readFile(
      path.join(baseRoot(prepared.location), "results", "source.txt"),
      "utf8",
    )) === "source\n" &&
    (await fs.readFile(
      path.join(baseRoot(prepared.location), "results", "obsolete.txt"),
      "utf8",
    )) === "obsolete\n" &&
    !(await exists(
      path.join(baseRoot(prepared.location), "results", "final-report.txt"),
    )) &&
    !(await exists(
      path.join(baseRoot(prepared.location), "results", "moved.txt"),
    ))
  );
}

async function ambiguousFinalizationCase(
  fixture: GeneratedFixture,
  root: string,
): Promise<boolean> {
  const prepared = await finalizationReadyRun(fixture, root, "ambiguous-case");
  const confirmation = prepared.confirmation;
  setWorkflowFinalizationFaultForTests({ phase: "after-operation" });
  try {
    await createWorkflowRuntime().submit(
      prepared.location,
      finalizationSubmission(prepared.current, confirmation),
    );
  } catch {
  } finally {
    clearWorkflowFinalizationFaultForTests();
  }
  await fs.writeFile(
    path.join(baseRoot(prepared.location), "results", "final-report.txt"),
    "ambiguous\n",
    "utf8",
  );
  const blocked = await createWorkflowRuntime().recover(prepared.location);
  return (
    blocked.disposition === "blocked" &&
    blocked.findings.some(
      (finding) => finding.code === "finalization-transaction-unknown",
    )
  );
}

async function transitionBoundaryMatrix(
  fixture: GeneratedFixture,
  root: string,
): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};
  const startPhases = new Set([
    "journal-prepared",
    "journal-verified",
    "record-write",
    "record-verification",
    "commit-evidence",
    "commit-evidence-written",
    "journal-clearance",
    "journal-cleared",
  ]);
  for (const phase of WORKFLOW_TRANSITION_BOUNDARY_PHASES) {
    const runRoot = path.join(root, `transition-${phase}`);
    await fs.mkdir(runRoot, { recursive: true });
    await prepareBaseFiles({ kind: "manual", runRoot });
    const location: WorkflowRunLocation = { kind: "manual", runRoot };
    const runId = `phase4-transition-${phase}`;
    let started: WorkflowContinuation | undefined;
    let recovered: WorkflowContinuation | undefined;
    if (startPhases.has(phase)) {
      const child = await childCall<WorkflowContinuation>(
        fixture.packageRoot,
        "start",
        location,
        undefined,
        { BADGER_WORKFLOW_TEST_FAULT_BOUNDARY: phase },
      );
      const afterFault = await childCall<WorkflowContinuation>(
        fixture.packageRoot,
        "recover",
        location,
      );
      recovered = afterFault.value;
      result[phase] = Boolean(
        (!child.ok || phase === "journal-cleared") &&
        afterFault.ok &&
        recovered?.currentNode === "prepare" &&
        recovered.pendingAction !== null &&
        (await readWorkflowTransitionJournal(runRoot)) === null &&
        (await transitionRecoverySettled(runRoot, phase)),
      );
    } else {
      started = await createWorkflowRuntime().start({
        protocol: fixture.protocol,
        runRoot,
        runId,
      });
      setWorkflowTransitionFaultForTests({
        phase: "record-write",
        path: ".badger/run-state.json",
      });
      try {
        const prepare = nodeFor(fixture.protocol, "prepare");
        if (!prepare)
          throw new Error("Phase 4 transition fixture lacks prepare Node");
        await createWorkflowRuntime().submit(
          runRoot,
          machineSubmission(
            started,
            "prepare",
            "succeeded",
            evidenceFor(fixture.protocol, prepare),
            await materializeArtifacts(
              runRoot,
              fixture.protocol,
              prepare,
              started.attemptId!,
            ),
          ),
        );
      } catch {
      } finally {
        clearWorkflowTransitionFaultForTests();
      }
      const child = await childCall<WorkflowContinuation>(
        fixture.packageRoot,
        "recover",
        location,
        undefined,
        { BADGER_WORKFLOW_TEST_FAULT_BOUNDARY: phase },
      );
      const afterFault = await childCall<WorkflowContinuation>(
        fixture.packageRoot,
        "recover",
        location,
      );
      recovered = afterFault.value;
      result[phase] = Boolean(
        (!child.ok || phase === "recovery-evidence-recorded") &&
        afterFault.ok &&
        recovered?.revision === 1 &&
        recovered.pendingAction !== null &&
        (await readWorkflowTransitionJournal(runRoot)) === null &&
        (await transitionRecoverySettled(runRoot, phase)),
      );
    }
  }
  return result;
}

async function finalizationBoundaryMatrix(
  fixture: GeneratedFixture,
  root: string,
): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};
  const rollbackPhases = new Set([
    "rolling-back",
    "before-rollback-operation",
    "rollback-verified",
    "rolled-back",
  ]);
  const template = await finalizationReadyRun(
    fixture,
    root,
    "finalization-template",
  );
  for (const phase of WORKFLOW_FINALIZATION_BOUNDARY_PHASES) {
    const runRoot = path.join(root, `finalization-${phase}`);
    await fs.cp(locationRoot(template.location), runRoot, { recursive: true });
    const prepared: FinalizationReadyRun = {
      location: { kind: "manual", runRoot },
      current: structuredClone(template.current),
      confirmation: structuredClone(template.confirmation),
    };
    prepared.current = {
      ...prepared.current,
      pendingAction: structuredClone(template.current.pendingAction),
    };
    const confirmation = prepared.confirmation;
    const submission = finalizationSubmission(prepared.current, confirmation);
    let firstFault: ChildResult<WorkflowContinuation>;
    if (rollbackPhases.has(phase)) {
      await childCall<WorkflowContinuation>(
        fixture.packageRoot,
        "submit",
        prepared.location,
        submission,
        { BADGER_WORKFLOW_TEST_FINALIZATION_FAULT_BOUNDARY: "after-operation" },
      );
      firstFault = await childCall<WorkflowContinuation>(
        fixture.packageRoot,
        "recover",
        prepared.location,
        { rollbackFinalization: true },
        { BADGER_WORKFLOW_TEST_FINALIZATION_FAULT_BOUNDARY: phase },
      );
      const recovered = await childCall<WorkflowContinuation>(
        fixture.packageRoot,
        "recover",
        prepared.location,
        { rollbackFinalization: true },
      );
      result[phase] = Boolean(
        !firstFault.ok &&
        recovered.ok &&
        recovered.value?.finalization?.status === "rolled-back",
      );
    } else {
      firstFault = await childCall<WorkflowContinuation>(
        fixture.packageRoot,
        "submit",
        prepared.location,
        submission,
        { BADGER_WORKFLOW_TEST_FINALIZATION_FAULT_BOUNDARY: phase },
      );
      const recovered = await childCall<WorkflowContinuation>(
        fixture.packageRoot,
        "recover",
        prepared.location,
      );
      result[phase] = Boolean(
        (!firstFault.ok || phase === "cleared") &&
        recovered.ok &&
        (recovered.value?.disposition === "done" ||
          recovered.value?.finalization?.status === "committed"),
      );
    }
  }
  return result;
}

async function concurrencyCase(
  fixture: GeneratedFixture,
  root: string,
  conflicting: boolean,
): Promise<
  WorkflowRuntimePhase4CertificationEvidence["concurrency"]["identical"]
> {
  const runRoot = path.join(
    root,
    conflicting ? "concurrency-conflicting" : "concurrency-identical",
  );
  await fs.mkdir(runRoot, { recursive: true });
  await prepareBaseFiles({ kind: "manual", runRoot });
  const runtime = createWorkflowRuntime();
  const started = await runtime.start({
    protocol: fixture.protocol,
    runRoot,
    runId: conflicting ? "phase4-conflicting" : "phase4-identical",
  });
  const prepare = nodeFor(fixture.protocol, "prepare");
  if (!prepare)
    throw new Error("Phase 4 concurrency fixture lacks prepare Node");
  const artifacts = await materializeArtifacts(
    runRoot,
    fixture.protocol,
    prepare,
    started.attemptId!,
  );
  const prepared = await runtime.submit(
    runRoot,
    machineSubmission(
      started,
      "prepare",
      "succeeded",
      evidenceFor(fixture.protocol, prepare),
      artifacts,
    ),
  );
  const verifyActionId = prepared.pendingAction?.id;
  if (!verifyActionId) {
    throw new Error("Phase 4 concurrency fixture has no verification action");
  }
  if (!nodeFor(fixture.protocol, "verify")) {
    throw new Error("Phase 4 concurrency fixture lacks verify Node");
  }
  const firstSubmission = conflicting
    ? machineSubmission(
        prepared,
        "verify",
        "failed",
        undefined,
        undefined,
        verificationProposal("failed"),
      )
    : machineSubmission(
        prepared,
        "verify",
        "succeeded",
        undefined,
        undefined,
        verificationProposal("passed"),
      );
  const secondSubmission = conflicting
    ? machineSubmission(
        prepared,
        "verify",
        "succeeded",
        undefined,
        undefined,
        verificationProposal("passed"),
      )
    : { ...firstSubmission };
  const [first, second] = await Promise.all([
    childCall<WorkflowContinuation>(
      fixture.packageRoot,
      "submit",
      runRoot,
      firstSubmission,
    ),
    childCall<WorkflowContinuation>(
      fixture.packageRoot,
      "submit",
      runRoot,
      secondSubmission,
    ),
  ]);
  const values = [first.value, second.value].filter(
    (value): value is WorkflowContinuation => value !== undefined,
  );
  const accepted = values.filter(
    (value) =>
      value.revision === prepared.revision + 1 &&
      value.disposition !== "blocked",
  );
  const conflicts = values.filter((value) =>
    value.findings.some(
      (finding) =>
        finding.code === "revision-conflict" ||
        finding.code === "run-lock-active",
    ),
  );
  const childConflicts = [first, second].filter(
    (result) =>
      !result.ok &&
      (result.findingCode === "revision-conflict" ||
        result.findingCode === "run-lock-active"),
  );
  const state = await readRunState(runRoot);
  const trajectory = state
    ? await readTrajectory(runRoot, state.trajectoryRef)
    : [];
  const outcomes =
    state?.workflowRuntime?.visits
      .flatMap((visit) => visit.outcomes)
      .filter((outcome) => outcome.actionId === verifyActionId) ?? [];
  const actionEvents = trajectory.filter((event) => {
    if (event.type !== "action_completed") return false;
    const outcome = event.data.outcome;
    return isRecord(outcome) && outcome.actionId === verifyActionId;
  });
  const receipts = state?.workflowRuntime?.verificationReceipts ?? [];
  const acceptedNextAction = accepted[0]?.pendingAction?.id ?? null;
  const returnedNextActions = values.map(
    (value) => value.pendingAction?.id ?? null,
  );
  const expectedConcurrentActionIds = new Set([
    verifyActionId,
    acceptedNextAction,
  ]);
  return {
    oneAccepted: accepted.length === 1,
    oneConflict: conflicts.length + childConflicts.length === 1,
    noDuplicateOutcome: outcomes.length === 1,
    noDuplicateEvent: actionEvents.length === 1,
    noDuplicateReceipt:
      receipts.length === 1 &&
      new Set(receipts.map((receipt) => receipt.receiptHash)).size === 1,
    noDuplicateNextAction:
      accepted.length === 1 &&
      state?.pending === acceptedNextAction &&
      returnedNextActions.length > 0 &&
      returnedNextActions.every((actionId) =>
        expectedConcurrentActionIds.has(actionId),
      ),
  };
}

async function transitionRecoverySettled(
  runRoot: string,
  phase: string,
): Promise<boolean> {
  const state = await readRunState(runRoot);
  if (!state) return false;
  const trajectory = await readTrajectory(runRoot, state.trajectoryRef);
  const recoveryEvents = trajectory.filter(
    (event) => event.type === "recovery_reconciled",
  );
  if (
    recoveryEvents.length !==
    (phase === "commit-evidence-written" ||
    phase === "journal-clearance" ||
    phase === "journal-cleared"
      ? 0
      : 1)
  ) {
    return false;
  }
  try {
    const claimRoot = path.join(runRoot, ".badger", "revision-claims");
    const entries = await fs.readdir(claimRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        throw new Error(
          `Phase 4 transition recovery claim entry is invalid for ${phase}: ${entry.name}`,
        );
      }
      const claim = JSON.parse(
        await fs.readFile(path.join(claimRoot, entry.name), "utf8"),
      ) as { status?: unknown };
      if (claim.status !== "committed") {
        throw new Error(
          `Phase 4 transition recovery claim is unsettled for ${phase}: ${String(claim.status)}`,
        );
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return true;
}

function allBooleanValues(value: Record<string, boolean>): boolean {
  return Object.values(value).every(Boolean);
}

function falseEvidencePaths(value: unknown, prefix = ""): string[] {
  if (value === false) {
    return prefix.startsWith("identity.durabilityProfile.")
      ? []
      : prefix
        ? [prefix]
        : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      falseEvidencePaths(entry, `${prefix}[${index}]`),
    );
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) =>
    falseEvidencePaths(entry, prefix ? `${prefix}.${key}` : key),
  );
}

function initialEvidence(
  generatedPackageHash: string,
): WorkflowRuntimePhase4CertificationEvidence {
  return {
    status: "failed",
    fixtureName: "phase4-certification-workflow",
    generatedPackageHash,
    evaluatedPackageHash: generatedPackageHash,
    fixturePackageHash: ZERO_HASH,
    identity: {
      protocolHash: ZERO_HASH,
      packageHash: ZERO_HASH,
      snapshotHash: ZERO_HASH,
      nodeToStep: {},
      findingCatalogVersion: 1,
      durabilityProfile: structuredClone(phase4Profile),
    },
    declaredCapabilities: [...phase4Profile.capabilities],
    runId: `phase4-${generatedPackageHash.slice(0, 16)}`,
    reverseRunId: `phase4-${generatedPackageHash.slice(0, 16)}-reverse`,
    manualRunId: `phase4-${generatedPackageHash.slice(0, 16)}-manual`,
    standaloneRunId: `phase4-${generatedPackageHash.slice(0, 16)}-standalone`,
    lifecycle: {
      machineWork: false,
      persistedDecision: false,
      versionedArtifacts: false,
      verificationRequirement: false,
      contentSnapshot: false,
      contentDrift: false,
      repairEpisode: false,
      verifiedCheckpoint: false,
      finalizationPreview: false,
      finalizationConfirmed: false,
      finalReceipt: false,
    },
    locations: { manual: false, standalone: false, equivalent: false },
    adapters: {
      generatedToPublic: false,
      publicToGenerated: false,
      thin: false,
      projectionsConsistent: false,
    },
    freshProcess: {
      pendingAction: false,
      decision: false,
      checkpoint: false,
      finalization: false,
      terminal: false,
      crashBoundaries: false,
      converged: false,
    },
    transitionJournalCrashBoundaries: Object.fromEntries(
      WORKFLOW_TRANSITION_BOUNDARY_PHASES.map((phase) => [phase, false]),
    ),
    finalizationCrashBoundaries: Object.fromEntries(
      WORKFLOW_FINALIZATION_BOUNDARY_PHASES.map((phase) => [phase, false]),
    ),
    concurrency: {
      identical: {
        oneAccepted: false,
        oneConflict: false,
        noDuplicateOutcome: false,
        noDuplicateEvent: false,
        noDuplicateReceipt: false,
        noDuplicateNextAction: false,
      },
      conflicting: {
        oneAccepted: false,
        oneConflict: false,
        noDuplicateOutcome: false,
        noDuplicateEvent: false,
        noDuplicateReceipt: false,
        noDuplicateNextAction: false,
      },
    },
    identities: {
      protocol: false,
      package: false,
      snapshot: false,
      resolver: false,
      durabilityProfile: false,
      schema: false,
      catalog: false,
      nodeAction: false,
      cycleAttempt: false,
      contentSnapshot: false,
      verificationReceipt: false,
      checkpoint: false,
      finalizationTransaction: false,
      finalizationReceipt: false,
      generatedPackageTree: false,
    },
    negativeCases: Object.fromEntries(
      WORKFLOW_RUNTIME_PHASE4_NEGATIVE_CASES.map((name) => [name, false]),
    ) as Record<WorkflowRuntimePhase4NegativeCase, boolean>,
    allNegativeCases: false,
    generatedAdaptersThin: false,
    legacyRunUnchanged: false,
    sourceIntegrity: false,
    completed: false,
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function certificationFailure(error: unknown): string {
  return `Synthetic Phase 4 certification failed: ${
    error instanceof Error ? error.message : String(error)
  }`;
}

export async function certifyPhase4Workflow(options: {
  generatedPackageHash: string;
  packageRoot: string;
}): Promise<Phase4CertificationResult> {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "badger-phase4-certification-"),
  );
  const evidence = initialEvidence(options.generatedPackageHash);
  const blockers: string[] = [];
  try {
    if (isProtectedPath(options.packageRoot)) {
      throw new Error(
        "Phase 4 certification package root is inside a protected source path",
      );
    }
    const evaluatedPackageRoot = await fs.realpath(options.packageRoot);
    if (isProtectedPath(evaluatedPackageRoot)) {
      throw new Error(
        "Phase 4 certification package root resolves inside a protected source path",
      );
    }
    const evaluatedPackageHash = await hashDirectory(evaluatedPackageRoot);
    evidence.evaluatedPackageHash = evaluatedPackageHash;
    if (evaluatedPackageHash !== options.generatedPackageHash) {
      throw new Error(
        "Phase 4 certification package hash does not match the current package",
      );
    }
    const fixture = await createFixture(temporaryRoot);
    evidence.fixturePackageHash = fixture.packageHash;
    evidence.generatedAdaptersThin = await generatedAdapterSourceCheck(
      fixture.packageRoot,
    );
    evidence.sourceIntegrity =
      isWithin(temporaryRoot, fixture.packageRoot) &&
      !isProtectedPath(fixture.packageRoot) &&
      !JSON.stringify(fixture.protocol).includes("raw_data") &&
      !JSON.stringify(fixture.protocol).includes("raw_skills");
    const expectedIdentity = await verifyWorkflowProtocol(fixture.protocol);
    const terminal = await runMainLifecycle(fixture, temporaryRoot, evidence);
    const reverse = await runReverseAdapterLifecycle(
      fixture,
      temporaryRoot,
      evidence,
    );
    evidence.declaredCapabilities = [
      ...parseWorkflowDurabilityProfile(phase4Profile).capabilities,
    ];
    evidence.locations.manual = terminal.disposition === "done";
    evidence.locations.standalone = reverse.disposition === "done";
    evidence.locations.equivalent =
      sameIdentity(terminal.execution, reverse.execution) &&
      JSON.stringify(stableValue(lifecycleShape(terminal))) ===
        JSON.stringify(stableValue(lifecycleShape(reverse)));
    evidence.adapters.thin = evidence.generatedAdaptersThin;
    evidence.identities.protocol =
      evidence.identity.protocolHash === expectedIdentity.protocolHash;
    evidence.identities.package =
      evidence.identity.packageHash === expectedIdentity.packageHash;
    evidence.identities.snapshot =
      evidence.identity.snapshotHash === expectedIdentity.packageHash;
    evidence.identities.resolver = HASH_PATTERN.test(
      evidence.identity.resolverHash ?? "",
    );
    evidence.identities.durabilityProfile =
      JSON.stringify(stableValue(evidence.identity.durabilityProfile)) ===
      JSON.stringify(
        stableValue(parseWorkflowDurabilityProfile(phase4Profile)),
      );
    const schemaVersions = Object.values(
      evidence.identity.durabilityProfile?.schemaVersions ?? {},
    );
    evidence.identities.schema =
      schemaVersions.length > 0 && schemaVersions.every((value) => value === 1);
    evidence.identities.catalog =
      evidence.identity.findingCatalogVersion === 1 &&
      evidence.identity.durabilityProfile?.findingCatalogVersion === 1;
    evidence.transitionJournalCrashBoundaries = await transitionBoundaryMatrix(
      fixture,
      temporaryRoot,
    );
    evidence.finalizationCrashBoundaries = await finalizationBoundaryMatrix(
      fixture,
      temporaryRoot,
    );
    evidence.freshProcess.crashBoundaries =
      allBooleanValues(evidence.transitionJournalCrashBoundaries) &&
      allBooleanValues(evidence.finalizationCrashBoundaries);
    evidence.freshProcess.converged = Boolean(
      evidence.freshProcess.pendingAction &&
      evidence.freshProcess.decision &&
      evidence.freshProcess.finalization &&
      evidence.freshProcess.terminal &&
      evidence.freshProcess.crashBoundaries,
    );
    evidence.concurrency.identical = await concurrencyCase(
      fixture,
      temporaryRoot,
      false,
    );
    evidence.concurrency.conflicting = await concurrencyCase(
      fixture,
      temporaryRoot,
      true,
    );
    const locks = await lockNegativeCases(fixture, temporaryRoot);
    evidence.negativeCases["stale-local-lock"] = locks.stale;
    evidence.negativeCases["unknown-lock"] = locks.unknown;
    evidence.negativeCases["changed-journal-identity"] =
      await changedJournalNegativeCase(fixture, temporaryRoot);
    evidence.negativeCases["checkpoint-mismatch"] =
      await checkpointNegativeCase(fixture, temporaryRoot);
    evidence.negativeCases["stale-verification-receipt"] =
      await staleReceiptNegativeCase(fixture, temporaryRoot);
    evidence.lifecycle.contentDrift = await contentDriftNegativeCase(
      fixture,
      temporaryRoot,
    );
    evidence.negativeCases["content-drift"] = evidence.lifecycle.contentDrift;
    const snapshots = await snapshotNegativeCases(temporaryRoot);
    evidence.negativeCases["snapshot-overflow"] = snapshots.overflow;
    evidence.negativeCases["snapshot-instability"] = snapshots.unstable;
    const repair = await repairNegativeCases(fixture, temporaryRoot);
    evidence.negativeCases["repair-stagnation"] = repair.stagnation;
    evidence.negativeCases["override-exhaustion"] = repair.overrideExhaustion;
    evidence.negativeCases["finalization-rollback"] =
      await finalizationRollbackCase(fixture, temporaryRoot);
    evidence.negativeCases["ambiguous-finalization"] =
      await ambiguousFinalizationCase(fixture, temporaryRoot);
    evidence.negativeCases["legacy-run-compatibility"] =
      await legacyNegativeCase(temporaryRoot);
    evidence.legacyRunUnchanged =
      evidence.negativeCases["legacy-run-compatibility"];
    evidence.negativeCases["legacy-run-compatibility"] =
      evidence.negativeCases["legacy-run-compatibility"] &&
      evidence.sourceIntegrity;
    evidence.allNegativeCases = WORKFLOW_RUNTIME_PHASE4_NEGATIVE_CASES.every(
      (name) => evidence.negativeCases[name],
    );
    evidence.sourceIntegrity =
      evidence.sourceIntegrity &&
      evidence.fixturePackageHash ===
        (await hashDirectory(fixture.packageRoot)) &&
      evidence.evaluatedPackageHash ===
        (await hashDirectory(evaluatedPackageRoot));
    evidence.completed =
      evidence.lifecycle.machineWork &&
      evidence.lifecycle.persistedDecision &&
      evidence.lifecycle.versionedArtifacts &&
      evidence.lifecycle.verificationRequirement &&
      evidence.lifecycle.contentSnapshot &&
      evidence.lifecycle.contentDrift &&
      evidence.lifecycle.repairEpisode &&
      evidence.lifecycle.verifiedCheckpoint &&
      evidence.lifecycle.finalizationPreview &&
      evidence.lifecycle.finalizationConfirmed &&
      evidence.lifecycle.finalReceipt &&
      evidence.locations.manual &&
      evidence.locations.standalone &&
      evidence.locations.equivalent &&
      evidence.adapters.generatedToPublic &&
      evidence.adapters.publicToGenerated &&
      evidence.adapters.thin &&
      evidence.adapters.projectionsConsistent &&
      evidence.freshProcess.converged &&
      allBooleanValues(evidence.concurrency.identical) &&
      allBooleanValues(evidence.concurrency.conflicting) &&
      Object.values(evidence.identities).every(Boolean) &&
      evidence.allNegativeCases &&
      evidence.generatedAdaptersThin &&
      evidence.legacyRunUnchanged &&
      evidence.sourceIntegrity;
    evidence.status = evidence.completed ? "certified" : "failed";
    if (!evidence.completed) {
      const falsePaths = falseEvidencePaths(evidence);
      blockers.push(
        `Synthetic Phase 4 lifecycle evidence is incomplete${
          falsePaths.length > 0 ? `: ${falsePaths.join(", ")}` : ""
        }`,
      );
    }
  } catch (error) {
    blockers.push(certificationFailure(error));
  } finally {
    clearWorkflowTransitionFaultForTests();
    clearWorkflowFinalizationFaultForTests();
    clearWorkflowCheckpointFaultForTests();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
  return { evidence, blockers };
}
