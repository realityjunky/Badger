import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { generatePackage } from "../factory/generate.js";
import { normalizeWorkflow } from "../workflow/contract.js";
import { createCompletionPlan } from "../workflow-runtime/completion.js";
import { createWorkflowRuntime } from "../workflow-runtime/public.js";
import type {
  WorkflowContinuation,
  WorkflowExecutionIdentity,
  WorkflowRunLocation,
  WorkflowRuntime,
  WorkflowSubmission,
} from "../workflow-runtime/public.js";
import { hashDirectory, stableValue } from "../util.js";
import {
  WORKFLOW_RUNTIME_PHASE3_NEGATIVE_CASES,
  type FactoryPlan,
  type FactoryProposal,
  type NodeProtocol,
  type WorkflowInput,
  type WorkflowProtocol,
  type WorkflowRuntimePhase3CertificationEvidence,
  type WorkflowRuntimePhase3NegativeCase,
} from "../types.js";

const execFileAsync = promisify(execFile);
const ZERO_HASH = "0".repeat(64);

interface GeneratedFixture {
  packageRoot: string;
  protocol: WorkflowProtocol;
  packageHash: string;
}

interface AwaitingDecision {
  started: WorkflowContinuation;
  awaiting: WorkflowContinuation;
  location: WorkflowRunLocation;
  prepareArtifactPaths: Record<string, string>;
}

interface Phase3CertificationResult {
  evidence: WorkflowRuntimePhase3CertificationEvidence;
  blockers: string[];
}

interface PublicCompletionResult {
  continuation: WorkflowContinuation;
  trace: WorkflowContinuation[];
}

function machineNode(
  id: string,
  outputSchemas: string[] = [],
): WorkflowInput["customNodes"][number] {
  return {
    id,
    label: id,
    kind: "action",
    responsibility: `Run the synthetic ${id} Node.`,
    implementation: {
      skill: `synthetic-${id}`,
      operation: "default",
      scope: "main",
    },
    operations: ["require", "augment", "disable"],
    outputSchemas,
    guardrails: [],
  };
}

function phase3Workflow(): WorkflowInput {
  return {
    kind: "workflow-kernel",
    name: "phase3-certification-workflow",
    goal: "Certify deterministic Phase 3 workflow behavior.",
    capabilities: {
      version: 3,
      features: [
        "conditional-routing",
        "revisioned-attempts",
        "decision-nodes",
        "bounded-cycles",
        "versioned-artifacts",
      ],
    },
    customNodes: [
      machineNode("prepare", ["prepare.v1"]),
      machineNode("classify"),
      {
        id: "review",
        label: "Review the synthetic evidence",
        kind: "decision",
        responsibility: "Authorize the next synthetic workflow transition.",
        implementation: {
          skill: "synthetic-review",
          operation: "default",
          scope: "main",
        },
        operations: ["require", "augment", "disable"],
        outputSchemas: [],
        guardrails: [],
        decision: {
          id: "phase3-review",
          question: "Should the synthetic workflow repeat the review?",
          choices: [
            { id: "repeat", label: "Repeat review", to: "rework" },
            { id: "finish", label: "Finish review", to: "finish" },
          ],
          inputs: {
            type: "object",
            fields: [
              {
                id: "ticket",
                type: "string",
                required: true,
                values: ["PHASE3-CERT"],
              },
            ],
          },
          rationale: { required: true },
          reviewer: {
            subjects: ["phase3-reviewer"],
            authorities: ["phase3:approve"],
          },
          scope: {
            artifacts: [{ id: "prepare.v1.run-report", required: true }],
            evidence: [{ id: "prepare.v1.basis", required: true }],
          },
        },
      },
      machineNode("rework", ["rework.v1"]),
      machineNode("finish"),
    ],
    outputSchemas: [
      {
        id: "prepare.v1",
        description: "Synthetic preparation evidence.",
        artifacts: [
          {
            id: "attempt-proof",
            kind: "file",
            required: true,
            paths: ["evidence/*/attempt-proof.txt"],
            validations: ["artifact-exists"],
            lifetime: "attempt",
          },
          {
            id: "run-report",
            kind: "file",
            required: true,
            paths: ["evidence/run-report.txt"],
            validations: ["artifact-exists"],
            lifetime: "run",
          },
        ],
        evidence: [{ id: "basis", required: true }],
      },
      {
        id: "rework.v1",
        description: "Synthetic rework evidence.",
        artifacts: [
          {
            id: "attempt-proof",
            kind: "file",
            required: true,
            paths: ["evidence/rework/*/attempt-proof.txt"],
            validations: ["artifact-exists"],
            lifetime: "attempt",
          },
        ],
        evidence: [{ id: "basis", required: true }],
      },
    ],
    routing: {
      fields: [{ id: "branch", values: ["review", "finish"] }],
      transitions: [
        { from: "prepare", to: "classify", condition: "success" },
        {
          from: "classify",
          to: "review",
          condition: "success",
          when: { field: "branch", equals: "review" },
        },
        { from: "classify", to: "finish", condition: "success" },
        { from: "rework", to: "review", condition: "success" },
        { from: "finish", to: null, condition: "success" },
      ],
    },
    cycles: [
      {
        key: "review-cycle",
        entry: "review",
        repeatTransitions: [{ from: "rework", to: "review" }],
        maxInstances: 2,
      },
    ],
  };
}

function certificationProposal(
  protocol: WorkflowProtocol,
  input: WorkflowInput,
): { proposal: FactoryProposal; plan: FactoryPlan } {
  return {
    proposal: {
      schemaVersion: 1,
      name: protocol.name,
      goal: protocol.goal,
      intent: "new-skill",
      planHash: "phase3-certification-plan",
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
      preferredSkills: [],
      workflow: input,
      defaultLocale: "en",
    },
  };
}

async function createFixture(root: string): Promise<GeneratedFixture> {
  const input = phase3Workflow();
  const protocol = normalizeWorkflow(input).protocol;
  const paths = certificationProposal(protocol, input);
  const generated = await generatePackage({
    ...paths,
    destination: path.join(root, "generated"),
  });
  return {
    packageRoot: generated.packageRoot,
    protocol,
    packageHash: await hashDirectory(generated.packageRoot),
  };
}

function locationRoot(location: WorkflowRunLocation): string {
  return location.kind === "manual"
    ? location.runRoot
    : path.join(location.projectRoot, ".comet", "runs", location.runId);
}

function concretePath(pattern: string, attemptId: string): string {
  return pattern
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => segment.replaceAll("*", attemptId))
    .join("/");
}

function schemaFor(
  protocol: WorkflowProtocol,
  schemaId: string,
): WorkflowProtocol["outputSchemas"][number] {
  const schema = protocol.outputSchemas.find(
    (candidate) => candidate.id === schemaId,
  );
  if (!schema)
    throw new Error(`Missing certification Output Schema: ${schemaId}`);
  return schema;
}

async function materializeArtifacts(
  runRoot: string,
  protocol: WorkflowProtocol,
  node: NodeProtocol,
  attemptId: string,
): Promise<Record<string, string>> {
  const artifacts: Record<string, string> = {};
  for (const schemaId of node.outputSchemas) {
    const schema = schemaFor(protocol, schemaId);
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
          `synthetic ${schema.id}.${artifact.id} ${attemptId}\n`,
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
  const plan = createCompletionPlan(node);
  const schemaEvidence: Record<string, string> = {};
  for (const schemaId of plan.outputSchemas) {
    const schema = schemaFor(protocol, schemaId);
    for (const evidence of schema.evidence) {
      if (evidence.required) {
        schemaEvidence[`${schema.id}.${evidence.id}`] = `synthetic-${node.id}`;
      }
    }
  }
  return {
    summary: `Synthetic evidence for ${node.id}.`,
    completedChecks: [
      ...plan.requiredSkillCalls,
      ...plan.enforcedAugmentations,
      ...plan.guardrails,
    ],
    schemaEvidence,
  };
}

function nodeFor(
  protocol: WorkflowProtocol,
  nodeId: string | null,
): NodeProtocol | undefined {
  return nodeId
    ? protocol.nodes.find((candidate) => candidate.id === nodeId)
    : undefined;
}

function withoutTimestamps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTimestamps);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "timestamp" && key !== "at")
        .map(([key, item]) => [key, withoutTimestamps(item)]),
    );
  }
  return value;
}

function sameContinuation(
  left: WorkflowContinuation,
  right: WorkflowContinuation,
): boolean {
  return (
    JSON.stringify(stableValue(withoutTimestamps(left))) ===
    JSON.stringify(stableValue(withoutTimestamps(right)))
  );
}

function sameIdentity(
  left: WorkflowContinuation,
  right: WorkflowContinuation,
): boolean {
  return (
    JSON.stringify(stableValue(left.execution)) ===
    JSON.stringify(stableValue(right.execution))
  );
}

function sameExecutionIdentity(
  left: WorkflowExecutionIdentity,
  right: WorkflowExecutionIdentity,
): boolean {
  return (
    JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))
  );
}

function projectionMatches(
  projection: unknown,
  continuation: WorkflowContinuation,
): boolean {
  if (!projection || typeof projection !== "object") return false;
  const value = projection as Record<string, unknown>;
  return (
    value.runId === continuation.runId &&
    value.revision === continuation.revision &&
    value.currentNode === continuation.currentNode &&
    value.cycleId === continuation.cycleId &&
    value.attemptId === continuation.attemptId &&
    value.visitOrdinal === continuation.visitOrdinal &&
    value.retryOrdinal === continuation.retryOrdinal &&
    JSON.stringify(stableValue(value.pendingAction)) ===
      JSON.stringify(stableValue(continuation.pendingAction)) &&
    JSON.stringify(stableValue(value.execution)) ===
      JSON.stringify(stableValue(continuation.execution)) &&
    JSON.stringify(stableValue(value.cycles)) ===
      JSON.stringify(stableValue(continuation.cycles)) &&
    JSON.stringify(stableValue(value.visits)) ===
      JSON.stringify(stableValue(continuation.visits)) &&
    JSON.stringify(stableValue(value.decisionReceipts)) ===
      JSON.stringify(stableValue(continuation.decisionReceipts)) &&
    JSON.stringify(stableValue(value.artifactVersions)) ===
      JSON.stringify(stableValue(continuation.artifactVersions)) &&
    JSON.stringify(stableValue(value.artifactSelections)) ===
      JSON.stringify(stableValue(continuation.artifactSelections)) &&
    JSON.stringify(stableValue(value.currentArtifactVersions)) ===
      JSON.stringify(stableValue(continuation.currentArtifactVersions))
  );
}

async function runGeneratedJson<T>(
  packageRoot: string,
  scriptName: string,
  args: string[],
): Promise<T> {
  const result = await execFileAsync(
    process.execPath,
    [path.join(packageRoot, "scripts", scriptName), ...args],
    { cwd: packageRoot, env: { PATH: process.env.PATH } },
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

async function recoverFresh(
  packageRoot: string,
  location: WorkflowRunLocation,
): Promise<WorkflowContinuation> {
  const runtimeModule = pathToFileURL(
    path.join(packageRoot, "scripts", "workflow-runtime.mjs"),
  ).href;
  const script = `const module = await import(${JSON.stringify(runtimeModule)}); const value = await module.createWorkflowRuntime().recover(${JSON.stringify(location)}); console.log(JSON.stringify(value));`;
  const result = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd: packageRoot, env: { PATH: process.env.PATH } },
  );
  return JSON.parse(result.stdout) as WorkflowContinuation;
}

function machineSubmission(
  current: WorkflowContinuation,
  nodeId: string,
  evidence: Record<string, unknown>,
  artifacts?: Record<string, string>,
  artifactVersions?: Record<string, string>,
  routing?: Record<string, string>,
): WorkflowSubmission {
  return {
    actionId: current.pendingAction!.id,
    nodeId,
    status: "succeeded",
    summary: `Synthetic evidence for ${nodeId}.`,
    evidence,
    ...(artifacts ? { artifacts } : {}),
    ...(artifactVersions ? { artifactVersions } : {}),
    ...(routing ? { routing } : {}),
  };
}

function decisionSubmission(
  current: WorkflowContinuation,
  choiceId: string,
  overrides: Partial<Extract<WorkflowSubmission, { kind: "decision" }>> = {},
): Extract<WorkflowSubmission, { kind: "decision" }> {
  return {
    kind: "decision",
    actionId: current.pendingAction!.id,
    revision: current.revision,
    nodeId: current.currentNode!,
    cycleId: current.cycleId,
    attemptId: current.attemptId!,
    choiceId,
    reviewer: {
      subject: "phase3-reviewer",
      authorities: ["phase3:approve"],
    },
    inputs: { ticket: "PHASE3-CERT" },
    rationale: "The synthetic evidence supports this deterministic choice.",
    execution: current.execution,
    ...(current.pendingAction!.scope
      ? { scope: structuredClone(current.pendingAction!.scope) }
      : {}),
    ...overrides,
  };
}

async function startAndReachDecision(
  runtime: WorkflowRuntime,
  protocol: WorkflowProtocol,
  location: WorkflowRunLocation,
  runId: string,
  existingStarted?: WorkflowContinuation,
): Promise<AwaitingDecision> {
  const started =
    existingStarted ??
    (location.kind === "manual"
      ? await runtime.start({ protocol, location, runId })
      : await runtime.start({ protocol, location }));
  const prepare = nodeFor(protocol, "prepare")!;
  const prepareArtifacts = await materializeArtifacts(
    locationRoot(location),
    protocol,
    prepare,
    started.attemptId!,
  );
  let current = await runtime.submit(
    location,
    machineSubmission(
      started,
      "prepare",
      evidenceFor(protocol, prepare),
      prepareArtifacts,
    ),
  );
  const classify = nodeFor(protocol, "classify")!;
  current = await runtime.submit(
    location,
    machineSubmission(
      current,
      "classify",
      evidenceFor(protocol, classify),
      undefined,
      undefined,
      { branch: "review" },
    ),
  );
  if (current.disposition !== "await-user") {
    throw new Error("Synthetic fixture did not reach its decision Node");
  }
  return {
    started,
    awaiting: current,
    location,
    prepareArtifactPaths: prepareArtifacts,
  };
}

async function assertUnchanged(
  runtime: WorkflowRuntime,
  location: WorkflowRunLocation,
  before: WorkflowContinuation,
  operation: () => Promise<WorkflowContinuation>,
): Promise<boolean> {
  const trajectoryPath = path.join(
    locationRoot(location),
    ".comet",
    "trajectory.jsonl",
  );
  const trajectoryBefore = await fs.readFile(trajectoryPath, "utf8");
  let rejected = false;
  try {
    await operation();
  } catch {
    rejected = true;
  }
  const after = await runtime.recover(location);
  const unchanged = sameContinuation(before, after);
  const trajectoryAfter = await fs.readFile(trajectoryPath, "utf8");
  return rejected && unchanged && trajectoryBefore === trajectoryAfter;
}

function negativeCaseRecord(): Record<
  WorkflowRuntimePhase3NegativeCase,
  boolean
> {
  return Object.fromEntries(
    WORKFLOW_RUNTIME_PHASE3_NEGATIVE_CASES.map((name) => [name, false]),
  ) as Record<WorkflowRuntimePhase3NegativeCase, boolean>;
}

async function decisionNegatives(
  runtime: WorkflowRuntime,
  fixture: GeneratedFixture,
  root: string,
  negativeCases: Record<WorkflowRuntimePhase3NegativeCase, boolean>,
): Promise<void> {
  const location: WorkflowRunLocation = {
    kind: "manual",
    runRoot: path.join(root, "negative-decision"),
  };
  const awaiting = await startAndReachDecision(
    runtime,
    fixture.protocol,
    location,
    "phase3-negative-decision",
  );
  const base = decisionSubmission(awaiting.awaiting, "repeat");
  const cases: Array<
    [WorkflowRuntimePhase3NegativeCase, Partial<typeof base>]
  > = [
    ["stale-revision", { revision: awaiting.awaiting.revision - 1 }],
    ["unrelated-action", { actionId: "unrelated-action" }],
    ["wrong-node", { nodeId: "classify" }],
    ["wrong-cycle", { cycleId: "other-cycle" }],
    ["wrong-attempt", { attemptId: "other-attempt" }],
    ["invalid-choice", { choiceId: "invalid-choice" }],
    [
      "unauthorized-reviewer",
      {
        reviewer: {
          subject: "unauthorized-reviewer",
          authorities: ["phase3:approve"],
        },
      },
    ],
    ["missing-input", { inputs: {} }],
    ["missing-rationale", { rationale: undefined }],
  ];
  for (const [name, overrides] of cases) {
    negativeCases[name] = await assertUnchanged(
      runtime,
      location,
      awaiting.awaiting,
      () => runtime.submit(location, { ...base, ...overrides }),
    );
  }

  const staleScope = structuredClone(awaiting.awaiting.pendingAction!.scope!);
  staleScope.artifacts[0].contentHash = ZERO_HASH;
  negativeCases["stale-evidence-scope"] = await assertUnchanged(
    runtime,
    location,
    awaiting.awaiting,
    () =>
      runtime.submit(location, {
        ...base,
        scope: staleScope,
      }),
  );

  const reportPath = path.join(
    locationRoot(location),
    awaiting.prepareArtifactPaths["prepare.v1.run-report"],
  );
  const originalReport = await fs.readFile(reportPath, "utf8");
  await fs.writeFile(reportPath, "changed synthetic report\n", "utf8");
  let contentDriftRejected = false;
  try {
    await runtime.submit(location, base);
  } catch {
    contentDriftRejected = true;
  }
  await fs.writeFile(reportPath, originalReport, "utf8");
  negativeCases["content-drift"] =
    contentDriftRejected &&
    sameContinuation(awaiting.awaiting, await runtime.recover(location));

  const copiedLocation: WorkflowRunLocation = {
    kind: "manual",
    runRoot: path.join(root, "negative-copy"),
  };
  const copied = await startAndReachDecision(
    runtime,
    fixture.protocol,
    copiedLocation,
    "phase3-negative-copy",
  );
  negativeCases["cross-run-copy"] = await assertUnchanged(
    runtime,
    location,
    awaiting.awaiting,
    () =>
      runtime.submit(location, {
        ...base,
        scope: copied.awaiting.pendingAction!.scope,
      }),
  );

  const accepted = await runtime.submit(location, base);
  negativeCases["exact-replay"] = await assertUnchanged(
    runtime,
    location,
    accepted,
    () => runtime.submit(location, base),
  );
}

async function routeNegatives(
  runtime: WorkflowRuntime,
  fixture: GeneratedFixture,
  root: string,
  negativeCases: Record<WorkflowRuntimePhase3NegativeCase, boolean>,
): Promise<void> {
  const ambiguous = structuredClone(fixture.protocol);
  ambiguous.edges.splice(2, 0, {
    from: "classify",
    to: "rework",
    condition: "success",
    when: { field: "branch", equals: "review" },
  });
  ambiguous.routing!.transitions = structuredClone(ambiguous.edges);
  const ambiguousRunRoot = path.join(root, "negative-ambiguity");
  try {
    await runtime.start({
      protocol: ambiguous,
      runRoot: ambiguousRunRoot,
      runId: "phase3-negative-ambiguity",
    });
  } catch {
    let runWasCreated = true;
    try {
      await fs.access(path.join(ambiguousRunRoot, ".comet"));
    } catch {
      runWasCreated = false;
    }
    negativeCases["route-ambiguity"] = !runWasCreated;
  }

  const noMatch = structuredClone(fixture.protocol);
  noMatch.edges = noMatch.edges.filter(
    (edge) => !(edge.from === "classify" && edge.when === undefined),
  );
  noMatch.routing!.transitions = structuredClone(noMatch.edges);
  const location: WorkflowRunLocation = {
    kind: "manual",
    runRoot: path.join(root, "negative-no-match"),
  };
  const started = await runtime.start({
    protocol: noMatch,
    location,
    runId: "phase3-negative-no-match",
  });
  const prepare = nodeFor(noMatch, "prepare")!;
  const prepareArtifacts = await materializeArtifacts(
    locationRoot(location),
    noMatch,
    prepare,
    started.attemptId!,
  );
  let current = await runtime.submit(
    location,
    machineSubmission(
      started,
      "prepare",
      evidenceFor(noMatch, prepare),
      prepareArtifacts,
    ),
  );
  const classify = nodeFor(noMatch, "classify")!;
  current = await runtime.submit(
    location,
    machineSubmission(
      current,
      "classify",
      evidenceFor(noMatch, classify),
      undefined,
      undefined,
      { branch: "finish" },
    ),
  );
  const before = await runtime.recover(location);
  const trajectoryPath = path.join(
    locationRoot(location),
    ".comet",
    "trajectory.jsonl",
  );
  const trajectoryBefore = await fs.readFile(trajectoryPath, "utf8");
  negativeCases["route-no-match"] =
    current.disposition === "blocked" &&
    (await runtime.recover(location)).currentNode === "classify" &&
    sameContinuation(before, await runtime.recover(location)) &&
    trajectoryBefore === (await fs.readFile(trajectoryPath, "utf8"));
}

async function exhaustedCycleNegative(
  runtime: WorkflowRuntime,
  fixture: GeneratedFixture,
  root: string,
  negativeCases: Record<WorkflowRuntimePhase3NegativeCase, boolean>,
): Promise<void> {
  const protocol = structuredClone(fixture.protocol);
  protocol.cycles![0].maxInstances = 1;
  const location: WorkflowRunLocation = {
    kind: "manual",
    runRoot: path.join(root, "negative-budget"),
  };
  const awaiting = await startAndReachDecision(
    runtime,
    protocol,
    location,
    "phase3-negative-budget",
  );
  let current = await runtime.submit(
    location,
    decisionSubmission(awaiting.awaiting, "repeat"),
  );
  const rework = nodeFor(protocol, "rework")!;
  const before = current;
  const artifacts = await materializeArtifacts(
    locationRoot(location),
    protocol,
    rework,
    current.attemptId!,
  );
  current = await runtime.submit(
    location,
    machineSubmission(
      current,
      "rework",
      evidenceFor(protocol, rework),
      artifacts,
    ),
  );
  negativeCases["exhausted-cycle"] =
    current.disposition === "blocked" &&
    current.currentNode === before.currentNode &&
    current.pendingAction?.id === before.pendingAction?.id &&
    sameContinuation(before, await runtime.recover(location));
}

async function retryEvidence(
  runtime: WorkflowRuntime,
  fixture: GeneratedFixture,
  root: string,
): Promise<boolean> {
  const location: WorkflowRunLocation = {
    kind: "manual",
    runRoot: path.join(root, "retry"),
  };
  const started = await runtime.start({
    protocol: fixture.protocol,
    location,
    runId: "phase3-retry",
  });
  const retried = await runtime.submit(location, {
    actionId: started.pendingAction!.id,
    nodeId: "prepare",
    status: "failed",
    summary: "Synthetic retry probe failed once.",
  });
  return (
    retried.disposition === "continue" &&
    retried.attemptId === started.attemptId &&
    retried.visitOrdinal === started.visitOrdinal &&
    retried.retryOrdinal === 1
  );
}

async function completeThroughPublic(
  runtime: WorkflowRuntime,
  fixture: GeneratedFixture,
  location: WorkflowRunLocation,
  runId: string,
): Promise<PublicCompletionResult> {
  let current =
    location.kind === "manual"
      ? await runtime.start({ protocol: fixture.protocol, location, runId })
      : await runtime.start({ protocol: fixture.protocol, location });
  const trace = [current];
  while (current.pendingAction) {
    const node = nodeFor(fixture.protocol, current.currentNode);
    if (!node) throw new Error("Synthetic public run has no current Node");
    if (current.currentNode === "prepare" || current.currentNode === "rework") {
      const artifacts = await materializeArtifacts(
        locationRoot(location),
        fixture.protocol,
        node,
        current.attemptId!,
      );
      current = await runtime.submit(
        location,
        machineSubmission(
          current,
          node.id,
          evidenceFor(fixture.protocol, node),
          artifacts,
          current.currentNode === "rework"
            ? {
                "prepare.v1.run-report":
                  current.currentArtifactVersions["prepare.v1.run-report"],
              }
            : undefined,
        ),
      );
      trace.push(current);
    } else if (current.currentNode === "classify") {
      const blocked = await runtime.submit(
        location,
        machineSubmission(
          current,
          node.id,
          evidenceFor(fixture.protocol, node),
          undefined,
          undefined,
          { branch: "invalid" },
        ),
      );
      trace.push(blocked);
      if (blocked.disposition !== "blocked") {
        throw new Error("Synthetic parity route probe was not blocked");
      }
      current = await runtime.submit(
        location,
        machineSubmission(
          current,
          node.id,
          evidenceFor(fixture.protocol, node),
          undefined,
          undefined,
          { branch: "review" },
        ),
      );
      trace.push(current);
    } else if (current.currentNode === "review") {
      current = await runtime.submit(
        location,
        decisionSubmission(
          current,
          current.decisionReceipts.length === 0 ? "repeat" : "finish",
        ),
      );
      trace.push(current);
    } else {
      current = await runtime.submit(
        location,
        machineSubmission(
          current,
          node.id,
          evidenceFor(fixture.protocol, node),
        ),
      );
      trace.push(current);
    }
  }
  return { continuation: current, trace };
}

async function completeThroughGenerated(
  runtime: WorkflowRuntime,
  fixture: GeneratedFixture,
  packageRoot: string,
  location: WorkflowRunLocation,
): Promise<WorkflowContinuation> {
  let current = await runtime.recover(location);
  let attempts = 0;
  while (current.pendingAction) {
    attempts += 1;
    if (attempts > 12)
      throw new Error("Synthetic generated run exceeded bound");
    const node = nodeFor(fixture.protocol, current.currentNode);
    if (!node) throw new Error("Synthetic generated run has no current Node");
    if (current.currentNode === "prepare" || current.currentNode === "rework") {
      const artifacts = await materializeArtifacts(
        locationRoot(location),
        fixture.protocol,
        node,
        current.attemptId!,
      );
      const evidence = evidenceFor(fixture.protocol, node);
      current = await runGeneratedState(packageRoot, [
        "record",
        node.id,
        JSON.stringify({
          ...evidence,
          artifacts,
          ...(current.currentNode === "rework"
            ? {
                artifactVersions: {
                  "prepare.v1.run-report":
                    current.currentArtifactVersions["prepare.v1.run-report"],
                },
              }
            : {}),
        }),
        ...(location.kind === "manual"
          ? ["--run-root", location.runRoot]
          : ["--project", location.projectRoot, "--run-id", location.runId]),
        "--json",
      ]);
    } else if (current.currentNode === "classify") {
      current = await runGeneratedState(packageRoot, [
        "record",
        "classify",
        JSON.stringify({
          ...evidenceFor(fixture.protocol, node),
          routing: { branch: "review" },
        }),
        ...(location.kind === "manual"
          ? ["--run-root", location.runRoot]
          : ["--project", location.projectRoot, "--run-id", location.runId]),
        "--json",
      ]);
    } else if (current.currentNode === "review") {
      const response = decisionSubmission(
        current,
        current.decisionReceipts.length === 0 ? "repeat" : "finish",
      );
      current = await runGeneratedState(packageRoot, [
        "decide",
        "review",
        JSON.stringify(response),
        ...(location.kind === "manual"
          ? ["--run-root", location.runRoot]
          : ["--project", location.projectRoot, "--run-id", location.runId]),
        "--json",
      ]);
    } else {
      current = await runGeneratedState(packageRoot, [
        "record",
        node.id,
        JSON.stringify(evidenceFor(fixture.protocol, node)),
        ...(location.kind === "manual"
          ? ["--run-root", location.runRoot]
          : ["--project", location.projectRoot, "--run-id", location.runId]),
        "--json",
      ]);
    }
  }
  return current;
}

async function adapterSourceCheck(packageRoot: string): Promise<boolean> {
  const adapters = [
    "workflow-state.mjs",
    "workflow-guard.mjs",
    "workflow-handoff.mjs",
  ];
  const forbidden = [
    "resolveWorkflowNext",
    "resolveWorkflowTransition",
    "allocateCycle",
    "decisionReceipts.push",
    "first-incomplete",
    "reviewer-policy",
  ];
  for (const adapter of adapters) {
    const source = await fs.readFile(
      path.join(packageRoot, "scripts", adapter),
      "utf8",
    );
    if (forbidden.some((token) => source.includes(token))) return false;
  }
  return true;
}

async function generatedContractCheck(
  packageRoot: string,
  protocol: WorkflowProtocol,
): Promise<boolean> {
  const entry = await fs.readFile(path.join(packageRoot, "SKILL.md"), "utf8");
  const evalManifest = await fs.readFile(
    path.join(packageRoot, "comet", "eval.yaml"),
    "utf8",
  );
  const protocolDocument = await fs.readFile(
    path.join(packageRoot, "reference", "workflow-protocol.json"),
    "utf8",
  );
  return (
    entry.includes("Executable Node Order:") &&
    entry.includes("review-cycle") &&
    protocolDocument.includes("phase3-review") &&
    evalManifest.includes("workflow-runtime-certification") &&
    protocol.nodes.every((node) => entry.includes(node.id))
  );
}

function initialEvidence(
  generatedPackageHash: string,
): WorkflowRuntimePhase3CertificationEvidence {
  return {
    status: "failed",
    fixtureName: "phase3-certification-workflow",
    generatedPackageHash,
    evaluatedPackageHash: generatedPackageHash,
    fixturePackageHash: ZERO_HASH,
    identity: {
      protocolHash: ZERO_HASH,
      packageHash: ZERO_HASH,
      snapshotHash: ZERO_HASH,
      nodeToStep: {},
      capabilityVersion: 3,
      resolverHash: ZERO_HASH,
    },
    expectedVisitOrder: [
      "prepare",
      "classify",
      "review",
      "rework",
      "review",
      "finish",
    ],
    observedVisitOrder: [],
    runId: `phase3-${generatedPackageHash.slice(0, 12)}`,
    reverseRunId: `phase3-${generatedPackageHash.slice(0, 12)}-reverse`,
    manualRunId: "phase3-manual-parity",
    standaloneRunId: "phase3-manual-parity",
    recoveryCount: 0,
    dispositions: {
      continue: false,
      awaitUser: false,
      blocked: false,
      done: false,
    },
    recovery: {
      pendingMachine: false,
      awaitingDecision: false,
      acceptedBranch: false,
      afterScopedReceipt: false,
      betweenCycles: false,
      terminal: false,
      freshProcess: false,
    },
    branch: {
      conditional: false,
      selected: "",
      defaultRoute: false,
      terminalChoice: false,
    },
    cycle: {
      declared: false,
      repeatTransition: false,
      repeatedNodeVisits: 0,
      instances: 0,
      budgetRejected: false,
    },
    attempts: { rework: false, retryStable: false, uniqueVisits: false },
    artifacts: {
      attemptVersion: false,
      runVersion: false,
      carryForward: false,
      immutable: false,
    },
    decisions: {
      authorized: false,
      receiptCount: 0,
      scopeBound: false,
      replayRejected: false,
    },
    entryDirections: {
      generatedToPublic: false,
      publicToGenerated: false,
      manualStandalone: false,
    },
    negativeCases: negativeCaseRecord(),
    allNegativeCases: false,
    generatedAdaptersThin: false,
    identityReconciled: false,
    projectionsConsistent: false,
    sourceIntegrity: false,
    completed: false,
  };
}

export async function certifyPhase3Workflow(options: {
  generatedPackageHash: string;
}): Promise<Phase3CertificationResult> {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "comet-phase3-certification-"),
  );
  const evidence = initialEvidence(options.generatedPackageHash);
  const blockers: string[] = [];
  const negativeCases = evidence.negativeCases;
  try {
    const fixture = await createFixture(temporaryRoot);
    evidence.fixturePackageHash = fixture.packageHash;
    const runtime = createWorkflowRuntime();
    const primaryLocation: WorkflowRunLocation = {
      kind: "manual",
      runRoot: path.join(temporaryRoot, "primary-run"),
    };
    const primaryRunId = evidence.runId;
    const entryStarted = await runGeneratedState(fixture.packageRoot, [
      "init",
      "--run-root",
      primaryLocation.runRoot,
      "--run-id",
      primaryRunId,
      "--json",
    ]);
    evidence.identity = {
      ...entryStarted.execution,
      capabilityVersion: entryStarted.execution.capabilityVersion!,
      resolverHash: entryStarted.execution.resolverHash!,
    };
    evidence.runId = primaryRunId;
    evidence.generatedAdaptersThin = await adapterSourceCheck(
      fixture.packageRoot,
    );
    evidence.sourceIntegrity =
      /^[a-f0-9]{64}$/u.test(fixture.packageHash) &&
      !JSON.stringify(fixture.protocol).includes("raw_data") &&
      !JSON.stringify(fixture.protocol).includes("raw_skills");
    const guardIdentity = await runGeneratedJson<WorkflowExecutionIdentity>(
      fixture.packageRoot,
      "workflow-guard.mjs",
      ["verify", "--json"],
    );
    const guardEntry = await runGeneratedJson<WorkflowContinuation>(
      fixture.packageRoot,
      "workflow-guard.mjs",
      ["entry", "prepare", "--run-root", primaryLocation.runRoot, "--json"],
    );
    const initialHandoff = await runGeneratedJson<{
      execution: WorkflowExecutionIdentity;
      continuation: WorkflowContinuation | null;
    }>(fixture.packageRoot, "workflow-handoff.mjs", [
      "--run-root",
      primaryLocation.runRoot,
      "--json",
    ]);
    const initialProjection = await runGeneratedJson<Record<string, unknown>>(
      fixture.packageRoot,
      "workflow-state.mjs",
      ["status", "--run-root", primaryLocation.runRoot, "--json"],
    );
    evidence.projectionsConsistent =
      sameExecutionIdentity(guardIdentity, evidence.identity) &&
      sameContinuation(guardEntry, entryStarted) &&
      sameExecutionIdentity(initialHandoff.execution, evidence.identity) &&
      initialHandoff.continuation !== null &&
      sameContinuation(initialHandoff.continuation, entryStarted) &&
      projectionMatches(initialProjection, entryStarted) &&
      (await generatedContractCheck(fixture.packageRoot, fixture.protocol));
    evidence.entryDirections.generatedToPublic =
      entryStarted.disposition === "continue" &&
      entryStarted.currentNode === "prepare";
    evidence.dispositions.continue = entryStarted.disposition === "continue";

    const primaryRecovery = await runtime.recover(primaryLocation);
    const primaryFreshRecovery = await recoverFresh(
      fixture.packageRoot,
      primaryLocation,
    );
    evidence.recovery.pendingMachine =
      sameContinuation(entryStarted, primaryRecovery) &&
      sameContinuation(entryStarted, primaryFreshRecovery);
    evidence.recovery.freshProcess = evidence.recovery.pendingMachine;
    evidence.recoveryCount += 2;

    const primary = await startAndReachDecision(
      runtime,
      fixture.protocol,
      primaryLocation,
      primaryRunId,
      entryStarted,
    );
    evidence.dispositions.continue = true;
    evidence.dispositions.awaitUser =
      primary.awaiting.disposition === "await-user";
    const awaitingRecovery = await runtime.recover(primaryLocation);
    const awaitingFreshRecovery = await recoverFresh(
      fixture.packageRoot,
      primaryLocation,
    );
    evidence.recovery.awaitingDecision =
      sameContinuation(primary.awaiting, awaitingRecovery) &&
      sameContinuation(primary.awaiting, awaitingFreshRecovery);
    evidence.recovery.freshProcess =
      evidence.recovery.freshProcess &&
      sameContinuation(primary.awaiting, awaitingFreshRecovery);
    const awaitingGuard = await runGeneratedJson<WorkflowContinuation>(
      fixture.packageRoot,
      "workflow-guard.mjs",
      ["entry", "review", "--run-root", primaryLocation.runRoot, "--json"],
    );
    const awaitingProjection = await runGeneratedJson<Record<string, unknown>>(
      fixture.packageRoot,
      "workflow-state.mjs",
      ["next", "--run-root", primaryLocation.runRoot, "--json"],
    );
    const awaitingHandoff = await runGeneratedJson<{
      execution: WorkflowExecutionIdentity;
      continuation: WorkflowContinuation | null;
    }>(fixture.packageRoot, "workflow-handoff.mjs", [
      "--run-root",
      primaryLocation.runRoot,
      "--json",
    ]);
    evidence.projectionsConsistent =
      evidence.projectionsConsistent &&
      sameContinuation(awaitingGuard, primary.awaiting) &&
      projectionMatches(awaitingProjection, primary.awaiting) &&
      sameExecutionIdentity(awaitingHandoff.execution, evidence.identity) &&
      awaitingHandoff.continuation !== null &&
      sameContinuation(awaitingHandoff.continuation, primary.awaiting);
    evidence.recoveryCount += 2;
    evidence.recovery.acceptedBranch =
      primary.awaiting.currentNode === "review";
    const initialArtifactVersions = structuredClone(
      primary.awaiting.artifactVersions,
    );
    await decisionNegatives(runtime, fixture, temporaryRoot, negativeCases);
    await routeNegatives(runtime, fixture, temporaryRoot, negativeCases);
    await exhaustedCycleNegative(
      runtime,
      fixture,
      temporaryRoot,
      negativeCases,
    );
    evidence.attempts.retryStable = await retryEvidence(
      runtime,
      fixture,
      temporaryRoot,
    );

    const firstResponse = decisionSubmission(primary.awaiting, "repeat");
    let current = await runtime.submit(primaryLocation, firstResponse);
    const firstReceipt = current.decisionReceipts[0];
    evidence.decisions.authorized = Boolean(firstReceipt);
    evidence.decisions.scopeBound =
      Boolean(firstReceipt?.scope) &&
      JSON.stringify(stableValue(firstReceipt?.scope)) ===
        JSON.stringify(stableValue(primary.awaiting.pendingAction?.scope));
    evidence.decisions.replayRejected = negativeCases["exact-replay"];

    const rework = nodeFor(fixture.protocol, "rework")!;
    const afterReceiptRecovery = await runtime.recover(primaryLocation);
    const afterReceiptFreshRecovery = await recoverFresh(
      fixture.packageRoot,
      primaryLocation,
    );
    evidence.recovery.afterScopedReceipt =
      sameContinuation(current, afterReceiptRecovery) &&
      sameContinuation(current, afterReceiptFreshRecovery);
    evidence.recovery.betweenCycles = evidence.recovery.afterScopedReceipt;
    evidence.recovery.freshProcess =
      evidence.recovery.freshProcess &&
      sameContinuation(current, afterReceiptFreshRecovery);
    evidence.recoveryCount += 2;
    const reworkArtifacts = await materializeArtifacts(
      locationRoot(primaryLocation),
      fixture.protocol,
      rework,
      current.attemptId!,
    );
    const priorRunVersion =
      current.currentArtifactVersions["prepare.v1.run-report"];
    current = await runtime.submit(
      primaryLocation,
      machineSubmission(
        current,
        "rework",
        evidenceFor(fixture.protocol, rework),
        reworkArtifacts,
        { "prepare.v1.run-report": priorRunVersion },
      ),
    );
    const secondAwaiting = current;
    const betweenCycleRecovery = await runtime.recover(primaryLocation);
    const betweenCycleFreshRecovery = await recoverFresh(
      fixture.packageRoot,
      primaryLocation,
    );
    evidence.recovery.betweenCycles =
      secondAwaiting.cycles.length === 2 &&
      sameContinuation(secondAwaiting, betweenCycleRecovery) &&
      sameContinuation(secondAwaiting, betweenCycleFreshRecovery);
    evidence.recovery.freshProcess =
      evidence.recovery.freshProcess &&
      sameContinuation(secondAwaiting, betweenCycleFreshRecovery);
    evidence.recoveryCount += 2;
    current = await runtime.submit(
      primaryLocation,
      decisionSubmission(secondAwaiting, "finish"),
    );
    const finish = nodeFor(fixture.protocol, "finish")!;
    current = await runtime.submit(
      primaryLocation,
      machineSubmission(
        current,
        "finish",
        evidenceFor(fixture.protocol, finish),
      ),
    );
    const terminal = await runtime.recover(primaryLocation);
    const terminalFresh = await recoverFresh(
      fixture.packageRoot,
      primaryLocation,
    );
    evidence.recovery.terminal =
      current.disposition === "done" &&
      sameContinuation(current, terminal) &&
      sameContinuation(current, terminalFresh);
    evidence.recovery.freshProcess =
      evidence.recovery.freshProcess &&
      sameContinuation(current, terminalFresh);
    let replayAfterProgressRejected = false;
    try {
      await runtime.submit(primaryLocation, firstResponse);
    } catch {
      replayAfterProgressRejected = true;
    }
    negativeCases["exact-replay"] =
      negativeCases["exact-replay"] &&
      replayAfterProgressRejected &&
      sameContinuation(current, await runtime.recover(primaryLocation));
    evidence.decisions.replayRejected = negativeCases["exact-replay"];
    const terminalHandoff = await runGeneratedJson<{
      execution: WorkflowExecutionIdentity;
      continuation: WorkflowContinuation | null;
    }>(fixture.packageRoot, "workflow-handoff.mjs", [
      "--run-root",
      primaryLocation.runRoot,
      "--json",
    ]);
    const terminalProjection = await runGeneratedJson<Record<string, unknown>>(
      fixture.packageRoot,
      "workflow-state.mjs",
      ["status", "--run-root", primaryLocation.runRoot, "--json"],
    );
    evidence.projectionsConsistent =
      evidence.projectionsConsistent &&
      sameExecutionIdentity(terminalHandoff.execution, evidence.identity) &&
      terminalHandoff.continuation !== null &&
      sameContinuation(terminalHandoff.continuation, current) &&
      projectionMatches(terminalProjection, current);
    evidence.recoveryCount += 2;
    evidence.dispositions.done = current.disposition === "done";
    evidence.dispositions.blocked = Object.values(negativeCases).some(Boolean);
    evidence.cycle.declared = fixture.protocol.cycles?.length === 1;
    evidence.cycle.repeatTransition =
      fixture.protocol.cycles?.[0]?.repeatTransitions.some(
        (transition) =>
          transition.from === "rework" && transition.to === "review",
      ) ?? false;
    evidence.cycle.instances = current.cycles.length;
    evidence.cycle.repeatedNodeVisits = current.visits.filter(
      (visit) => visit.stepId === evidence.identity.nodeToStep.review,
    ).length;
    evidence.cycle.budgetRejected = negativeCases["exhausted-cycle"];
    evidence.attempts.rework = current.visits.some(
      (visit) => visit.stepId === evidence.identity.nodeToStep.rework,
    );
    evidence.attempts.uniqueVisits =
      new Set(current.visits.map((visit) => visit.attemptId)).size ===
      current.visits.length;
    evidence.artifacts.attemptVersion = current.artifactVersions.some(
      (version) => version.lifetime === "attempt",
    );
    evidence.artifacts.runVersion = current.artifactVersions.some(
      (version) => version.lifetime === "run",
    );
    evidence.artifacts.carryForward =
      current.artifactSelections.some(
        (selection) =>
          selection.artifactId === "prepare.v1.run-report" &&
          selection.versionId === priorRunVersion,
      ) &&
      current.currentArtifactVersions["prepare.v1.run-report"] ===
        priorRunVersion;
    evidence.artifacts.immutable =
      initialArtifactVersions.every((version) =>
        current.artifactVersions.some(
          (candidate) =>
            JSON.stringify(withoutTimestamps(candidate)) ===
            JSON.stringify(withoutTimestamps(version)),
        ),
      ) &&
      firstReceipt !== undefined &&
      JSON.stringify(withoutTimestamps(firstReceipt)) ===
        JSON.stringify(withoutTimestamps(current.decisionReceipts[0]));
    evidence.decisions.receiptCount = current.decisionReceipts.length;
    evidence.decisions.scopeBound =
      evidence.decisions.scopeBound &&
      Boolean(current.decisionReceipts[1]?.scope) &&
      JSON.stringify(stableValue(current.decisionReceipts[1]?.scope)) ===
        JSON.stringify(stableValue(secondAwaiting.pendingAction?.scope));
    evidence.branch.conditional = fixture.protocol.edges.some(
      (edge) => edge.from === "classify" && edge.when !== undefined,
    );
    evidence.branch.selected =
      current.visits
        .find((visit) => visit.stepId === evidence.identity.nodeToStep.classify)
        ?.outcomes.find((outcome) => outcome.status === "succeeded")?.routing
        ?.branch ?? "";
    evidence.branch.defaultRoute = fixture.protocol.edges.some(
      (edge) => edge.from === "classify" && edge.when === undefined,
    );
    evidence.branch.terminalChoice =
      fixture.protocol.nodes
        .find((node) => node.id === "review")
        ?.decision?.choices.some(
          (choice) => choice.id === "finish" && choice.to === "finish",
        ) === true &&
      fixture.protocol.edges.some(
        (edge) => edge.from === "finish" && edge.to === null,
      );
    evidence.expectedVisitOrder = [
      "prepare",
      "classify",
      "review",
      "rework",
      "review",
      "finish",
    ];
    const nodeByStep = new Map(
      Object.entries(evidence.identity.nodeToStep).map(([node, step]) => [
        step,
        node,
      ]),
    );
    evidence.observedVisitOrder = current.visits.map(
      (visit) => nodeByStep.get(visit.stepId) ?? visit.stepId,
    );
    evidence.identityReconciled =
      sameIdentity(entryStarted, primary.awaiting) &&
      sameIdentity(current, terminal);

    const reverseLocation: WorkflowRunLocation = {
      kind: "standalone",
      projectRoot: path.join(temporaryRoot, "reverse-project"),
      runId: evidence.reverseRunId,
    };
    const reverseStarted = await runtime.start({
      protocol: fixture.protocol,
      location: reverseLocation,
    });
    const reverseCompleted = await completeThroughGenerated(
      runtime,
      fixture,
      fixture.packageRoot,
      reverseLocation,
    );
    evidence.entryDirections.publicToGenerated =
      reverseStarted.disposition === "continue" &&
      reverseCompleted.disposition === "done";
    evidence.identityReconciled =
      evidence.identityReconciled &&
      sameIdentity(reverseStarted, reverseCompleted);

    const manualParityLocation: WorkflowRunLocation = {
      kind: "manual",
      runRoot: path.join(temporaryRoot, "parity-manual"),
    };
    const standaloneParityLocation: WorkflowRunLocation = {
      kind: "standalone",
      projectRoot: path.join(temporaryRoot, "parity-standalone"),
      runId: evidence.manualRunId,
    };
    const manualParity = await completeThroughPublic(
      runtime,
      fixture,
      manualParityLocation,
      evidence.manualRunId,
    );
    const standaloneParity = await completeThroughPublic(
      runtime,
      fixture,
      standaloneParityLocation,
      evidence.standaloneRunId,
    );
    evidence.entryDirections.manualStandalone =
      manualParity.continuation.disposition === "done" &&
      standaloneParity.continuation.disposition === "done" &&
      sameContinuation(
        manualParity.continuation,
        standaloneParity.continuation,
      ) &&
      manualParity.trace.length === standaloneParity.trace.length &&
      manualParity.trace.every((continuation, index) =>
        sameContinuation(continuation, standaloneParity.trace[index]),
      ) &&
      manualParity.trace.some(
        (continuation) => continuation.disposition === "blocked",
      );

    evidence.allNegativeCases = WORKFLOW_RUNTIME_PHASE3_NEGATIVE_CASES.every(
      (name) => negativeCases[name],
    );
    evidence.completed =
      evidence.observedVisitOrder.length ===
        evidence.expectedVisitOrder.length &&
      JSON.stringify(evidence.observedVisitOrder) ===
        JSON.stringify(evidence.expectedVisitOrder) &&
      evidence.dispositions.continue &&
      evidence.dispositions.awaitUser &&
      evidence.dispositions.blocked &&
      evidence.dispositions.done &&
      evidence.recovery.pendingMachine &&
      evidence.recovery.awaitingDecision &&
      evidence.recovery.acceptedBranch &&
      evidence.recovery.afterScopedReceipt &&
      evidence.recovery.betweenCycles &&
      evidence.recovery.terminal &&
      evidence.recovery.freshProcess &&
      evidence.branch.conditional &&
      evidence.branch.selected === "review" &&
      evidence.branch.defaultRoute &&
      evidence.branch.terminalChoice &&
      evidence.cycle.declared &&
      evidence.cycle.repeatTransition &&
      evidence.cycle.instances === 2 &&
      evidence.cycle.repeatedNodeVisits === 2 &&
      evidence.cycle.budgetRejected &&
      evidence.attempts.rework &&
      evidence.attempts.retryStable &&
      evidence.attempts.uniqueVisits &&
      evidence.artifacts.attemptVersion &&
      evidence.artifacts.runVersion &&
      evidence.artifacts.carryForward &&
      evidence.artifacts.immutable &&
      evidence.decisions.authorized &&
      evidence.decisions.receiptCount === 2 &&
      evidence.decisions.scopeBound &&
      evidence.decisions.replayRejected &&
      evidence.entryDirections.generatedToPublic &&
      evidence.entryDirections.publicToGenerated &&
      evidence.entryDirections.manualStandalone &&
      evidence.generatedAdaptersThin &&
      evidence.identityReconciled &&
      evidence.projectionsConsistent &&
      evidence.sourceIntegrity &&
      evidence.allNegativeCases;
    evidence.status = evidence.completed ? "certified" : "failed";
    if (!evidence.completed)
      blockers.push("Synthetic Phase 3 lifecycle evidence is incomplete");
  } catch (error) {
    blockers.push(
      `Synthetic Phase 3 certification failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
  return { evidence, blockers };
}
