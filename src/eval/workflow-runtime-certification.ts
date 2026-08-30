import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type {
  NodeProtocol,
  OutputSchema,
  WorkflowProtocol,
  WorkflowRuntimeCertificationEvidence,
} from "../types.js";
import { createCompletionPlan } from "../workflow-runtime/completion.js";
import { createWorkflowRuntime } from "../workflow-runtime/public.js";
import type {
  WorkflowContinuation,
  WorkflowExecutionIdentity,
  WorkflowRunLocation,
} from "../workflow-runtime/public.js";
import { stableValue } from "../util.js";

const execFileAsync = promisify(execFile);

export interface WorkflowRuntimeCertificationResult {
  evidence?: WorkflowRuntimeCertificationEvidence;
  blockers: string[];
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameContinuation(
  left: WorkflowContinuation,
  right: WorkflowContinuation,
): boolean {
  return (
    left.disposition === right.disposition &&
    left.runId === right.runId &&
    left.currentNode === right.currentNode &&
    JSON.stringify(stableValue(left.pendingAction)) ===
      JSON.stringify(stableValue(right.pendingAction)) &&
    JSON.stringify(stableValue(left.execution)) ===
      JSON.stringify(stableValue(right.execution)) &&
    sameStrings(left.blockers, right.blockers)
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

function cleanEnvironment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH };
}

async function runGeneratedJson<T>(
  packageRoot: string,
  scriptName: string,
  args: string[],
): Promise<T> {
  const script = path.join(packageRoot, "scripts", scriptName);
  const result = await execFileAsync(process.execPath, [script, ...args], {
    cwd: packageRoot,
    env: cleanEnvironment(),
  });
  return JSON.parse(result.stdout) as T;
}

async function runGeneratedState(
  packageRoot: string,
  args: string[],
): Promise<WorkflowContinuation> {
  return runGeneratedJson<WorkflowContinuation>(
    packageRoot,
    "workflow-state.mjs",
    args,
  );
}

async function recoverInFreshProcess(
  packageRoot: string,
  location: WorkflowRunLocation,
): Promise<WorkflowContinuation> {
  const runtimeAsset = path.join(
    packageRoot,
    "scripts",
    "workflow-runtime.mjs",
  );
  const runtimeModule = pathToFileURL(runtimeAsset).href;
  const script = `const runtimeModule = await import(${JSON.stringify(runtimeModule)}); const continuation = await runtimeModule.createWorkflowRuntime().recover(${JSON.stringify(location)}); console.log(JSON.stringify(continuation));`;
  const result = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd: packageRoot, env: cleanEnvironment() },
  );
  return JSON.parse(result.stdout) as WorkflowContinuation;
}

function declaredNodeOrder(protocol: WorkflowProtocol): string[] {
  return [
    ...(protocol.evals[0]?.expectedNodeOrder ??
      protocol.nodes.filter((node) => !node.disabled).map((node) => node.id)),
  ];
}

function schemaFor(protocol: WorkflowProtocol, schemaId: string): OutputSchema {
  const schema = protocol.outputSchemas.find((item) => item.id === schemaId);
  if (!schema) throw new Error(`Missing Output Schema: ${schemaId}`);
  return schema;
}

function certificationEvidence(
  protocol: WorkflowProtocol,
  node: NodeProtocol,
): Record<string, unknown> {
  const plan = createCompletionPlan(node);
  const completedChecks = [
    ...plan.requiredSkillCalls,
    ...plan.enforcedAugmentations,
    ...plan.guardrails,
  ];
  const schemaEvidence: Record<string, string> = {};
  for (const schemaId of plan.outputSchemas) {
    const schema = schemaFor(protocol, schemaId);
    for (const field of schema.evidence) {
      if (!field.required) continue;
      schemaEvidence[`${schema.id}.${field.id}`] = "certified";
    }
  }
  return {
    summary: `Certified ${node.id}.`,
    completedChecks,
    schemaEvidence,
  };
}

function artifactPath(pattern: string): string {
  const normalized = pattern.trim().replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    /^(?:~|[\\/])/u.test(normalized) ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`Certification artifact path is unsafe: ${pattern}`);
  }
  return segments
    .map((segment) => segment.replaceAll("*", "certification"))
    .join("/");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function materializeArtifacts(
  runRoot: string,
  protocol: WorkflowProtocol,
  node: NodeProtocol,
): Promise<void> {
  for (const schemaId of node.outputSchemas) {
    const schema = schemaFor(protocol, schemaId);
    for (const artifact of schema.artifacts) {
      if (!artifact.required) continue;
      const pattern = artifact.paths[0];
      if (!pattern) {
        throw new Error(
          `Certification artifact has no path: ${schema.id}.${artifact.id}`,
        );
      }
      const relative = artifactPath(pattern);
      const target = path.resolve(runRoot, ...relative.split("/"));
      if (!isWithin(runRoot, target)) {
        throw new Error(
          `Certification artifact escapes the Run root: ${pattern}`,
        );
      }
      if (artifact.kind === "directory") {
        await fs.mkdir(target, { recursive: true });
      } else {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, "WorkflowRuntime certification artifact\n");
      }
    }
  }
}

async function completeThroughGeneratedAdapter(options: {
  packageRoot: string;
  protocol: WorkflowProtocol;
  runRoot: string;
  runId: string;
  identity: WorkflowExecutionIdentity;
}): Promise<{
  continuation: WorkflowContinuation;
  identityConsistent: boolean;
}> {
  let current = await createWorkflowRuntime().start({
    protocol: options.protocol,
    runRoot: options.runRoot,
    runId: options.runId,
  });
  let identityConsistent = sameExecutionIdentity(
    current.execution,
    options.identity,
  );
  let iterations = 0;
  while (current.pendingAction) {
    iterations += 1;
    if (iterations > Object.keys(options.identity.nodeToStep).length + 1) {
      throw new Error("Generated adapter did not reach terminal completion");
    }
    if (current.currentNode) {
      const node = options.protocol.nodes.find(
        (candidate) => candidate.id === current.currentNode,
      );
      if (!node)
        throw new Error(`Missing Workflow Node: ${current.currentNode}`);
      await materializeArtifacts(options.runRoot, options.protocol, node);
      current = await runGeneratedState(options.packageRoot, [
        "record",
        current.currentNode,
        JSON.stringify(certificationEvidence(options.protocol, node)),
        "--run-root",
        options.runRoot,
        "--json",
      ]);
    } else {
      current = await runGeneratedState(options.packageRoot, [
        "record",
        "checkpoint",
        JSON.stringify({ summary: "Certified terminal checkpoint." }),
        "--run-root",
        options.runRoot,
        "--json",
      ]);
    }
    identityConsistent =
      identityConsistent &&
      sameExecutionIdentity(current.execution, options.identity);
  }
  return { continuation: current, identityConsistent };
}

function certificationFailure(error: unknown): string {
  return `WorkflowRuntime certification failed: ${
    error instanceof Error ? error.message : String(error)
  }`;
}

export async function certifyWorkflowRuntime(options: {
  protocol: WorkflowProtocol;
  generatedPackageHash: string;
  packageRoot: string;
}): Promise<WorkflowRuntimeCertificationResult> {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "comet-workflow-runtime-certification-"),
  );
  const runRoot = path.join(temporaryRoot, "run");
  const reverseRunRoot = path.join(temporaryRoot, "reverse-run");
  const location: WorkflowRunLocation = { kind: "manual", runRoot };
  const runId = `certification-${options.generatedPackageHash.slice(0, 16)}`;
  const reverseRunId = `${runId}-reverse`;
  let recoveryCount = 0;
  let recovered = true;
  let current: WorkflowContinuation | undefined;
  let evidence: WorkflowRuntimeCertificationEvidence | undefined;

  try {
    const entryStarted = await runGeneratedState(options.packageRoot, [
      "init",
      "--run-root",
      runRoot,
      "--run-id",
      runId,
      "--json",
    ]);
    const declared = declaredNodeOrder(options.protocol);
    const compiled = Object.keys(entryStarted.execution.nodeToStep);
    const observed: string[] = [];
    evidence = {
      authority: "WorkflowRuntime",
      generatedPackageHash: options.generatedPackageHash,
      identity: structuredClone(entryStarted.execution),
      declaredNodeOrder: declared,
      compiledNodeOrder: compiled,
      observedNodeOrder: observed,
      runId,
      reverseRunId,
      recoveryCount: 0,
      recovered: false,
      completed: false,
      identityConsistent: true,
      guardVerified: false,
      handoffConsistent: false,
      entryAdapterStarted:
        entryStarted.disposition === "continue" &&
        entryStarted.runId === runId &&
        Boolean(entryStarted.pendingAction),
      compatibilityAdapterResumed: false,
      freshProcessRecovered: false,
      publicRuntimeCompleted: false,
      reverseAdapterCompleted: false,
    };
    let identityConsistent = true;

    const guardVerification = await runGeneratedJson<WorkflowExecutionIdentity>(
      options.packageRoot,
      "workflow-guard.mjs",
      ["verify", "--json"],
    );
    evidence.guardVerified = sameExecutionIdentity(
      guardVerification,
      evidence.identity,
    );

    const handoff = await runGeneratedJson<{
      execution: WorkflowExecutionIdentity;
      continuation: WorkflowContinuation | null;
    }>(options.packageRoot, "workflow-handoff.mjs", [
      "--run-root",
      runRoot,
      "--json",
    ]);
    evidence.handoffConsistent =
      sameExecutionIdentity(handoff.execution, evidence.identity) &&
      handoff.continuation !== null &&
      sameContinuation(entryStarted, handoff.continuation);

    const compatibilityResume = await runGeneratedState(options.packageRoot, [
      "resume",
      "--run-root",
      runRoot,
      "--json",
    ]);
    evidence.compatibilityAdapterResumed = sameContinuation(
      entryStarted,
      compatibilityResume,
    );

    const freshProcess = await recoverInFreshProcess(
      options.packageRoot,
      location,
    );
    evidence.freshProcessRecovered = sameContinuation(
      entryStarted,
      freshProcess,
    );
    recoveryCount += 1;
    recovered = evidence.freshProcessRecovered;

    current = await createWorkflowRuntime().resume(location);
    identityConsistent =
      identityConsistent &&
      sameExecutionIdentity(current.execution, evidence.identity);
    recovered = recovered && sameContinuation(entryStarted, current);

    while (current.pendingAction) {
      if (current.disposition !== "continue") {
        throw new Error(
          `Expected a continuing pending action, received ${current.disposition}`,
        );
      }
      const restored = await createWorkflowRuntime().recover(location);
      recoveryCount += 1;
      recovered = recovered && sameContinuation(current, restored);
      if (current.currentNode) {
        observed.push(current.currentNode);
        const node = options.protocol.nodes.find(
          (candidate) => candidate.id === current!.currentNode,
        );
        if (!node)
          throw new Error(`Missing Workflow Node: ${current.currentNode}`);
        await materializeArtifacts(runRoot, options.protocol, node);
        const next = await createWorkflowRuntime().submit(location, {
          actionId: current.pendingAction.id,
          nodeId: current.currentNode,
          status: "succeeded",
          summary: `Certified ${current.currentNode}.`,
          evidence: certificationEvidence(options.protocol, node),
        });
        identityConsistent =
          identityConsistent &&
          JSON.stringify(stableValue(next.execution)) ===
            JSON.stringify(stableValue(evidence.identity));
        current = next;
      } else {
        const next = await createWorkflowRuntime().submit(location, {
          actionId: current.pendingAction.id,
          status: "succeeded",
          summary: "Certified terminal checkpoint.",
        });
        identityConsistent =
          identityConsistent &&
          JSON.stringify(stableValue(next.execution)) ===
            JSON.stringify(stableValue(evidence.identity));
        current = next;
      }
    }

    const terminal = await createWorkflowRuntime().recover(location);
    recoveryCount += 1;
    recovered = recovered && sameContinuation(current, terminal);
    evidence.observedNodeOrder = observed;
    evidence.recoveryCount = recoveryCount;
    evidence.recovered = recovered;
    evidence.completed =
      current.disposition === "done" && terminal.disposition === "done";
    evidence.publicRuntimeCompleted = evidence.completed;
    evidence.identityConsistent = identityConsistent;

    const reverse = await completeThroughGeneratedAdapter({
      packageRoot: options.packageRoot,
      protocol: options.protocol,
      runRoot: reverseRunRoot,
      runId: reverseRunId,
      identity: evidence.identity,
    });
    evidence.reverseAdapterCompleted =
      reverse.continuation.disposition === "done";
    evidence.identityConsistent =
      evidence.identityConsistent && reverse.identityConsistent;

    const blockers: string[] = [];
    if (!sameStrings(declared, compiled)) {
      blockers.push("Declared Node order does not match compiled Node order");
    }
    if (!sameStrings(compiled, observed)) {
      blockers.push("Compiled Node order does not match observed Node order");
    }
    if (evidence.identity.packageHash !== evidence.identity.snapshotHash) {
      blockers.push("Compiled package hash does not match snapshot hash");
    }
    if (!evidence.recovered) {
      blockers.push(
        "WorkflowRuntime recovery did not reproduce the continuation",
      );
    }
    if (!evidence.completed) {
      blockers.push(
        "WorkflowRuntime certification did not reach terminal completion",
      );
    }
    if (!evidence.identityConsistent) {
      blockers.push(
        "WorkflowRuntime execution identity changed during certification",
      );
    }
    if (!evidence.guardVerified) {
      blockers.push("Generated guard identity did not match the Run identity");
    }
    if (!evidence.handoffConsistent) {
      blockers.push("Generated handoff did not match the Run identity");
    }
    if (!evidence.entryAdapterStarted) {
      blockers.push("Generated entry adapter did not start the Run");
    }
    if (!evidence.compatibilityAdapterResumed) {
      blockers.push("Generated compatibility adapter did not resume the Run");
    }
    if (!evidence.freshProcessRecovered) {
      blockers.push("Fresh-process WorkflowRuntime recovery did not match");
    }
    if (!evidence.publicRuntimeCompleted) {
      blockers.push("Public WorkflowRuntime did not complete the entry Run");
    }
    if (!evidence.reverseAdapterCompleted) {
      blockers.push("Generated adapter did not complete a public-runtime Run");
    }
    return { evidence, blockers };
  } catch (error) {
    return {
      ...(evidence ? { evidence } : {}),
      blockers: [certificationFailure(error)],
    };
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}
