#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWorkflowRuntime,
  projectWorkflowState,
  writeWorkflowStateProjection,
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
  const options = { confirmations: [] };
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
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--rebuild") {
      options.rebuild = true;
      continue;
    }
    if (argument === "--confirm") {
      options.confirmations.push(requiredOptionValue(argv, index, "--confirm"));
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

function isMissingRun(error) {
  return (
    error &&
    typeof error === "object" &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

async function readProtocol() {
  return JSON.parse(await fs.readFile(protocolPath, "utf8"));
}

async function readProjection(target) {
  try {
    return await projectWorkflowState(target);
  } catch (error) {
    if (isMissingRun(error)) return null;
    throw error;
  }
}

async function syncProjection(target, projection) {
  if (projection) await writeWorkflowStateProjection(target, projection);
  return projection;
}

function requireProjectionConfirmation(options) {
  if (options.rebuild && !options.confirmations.includes("legacy-state")) {
    throw new Error(
      "Rebuilding the legacy state projection requires --confirm legacy-state.",
    );
  }
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printPendingAction(value) {
  if (value.pendingAction.type === "checkpoint") {
    console.log("NEXT: checkpoint");
    console.log(`ACTION: ${value.pendingAction.id}`);
    console.log("TYPE: checkpoint");
    return;
  }
  console.log("NEXT: auto");
  if (value.currentNode) console.log(`NODE: ${value.currentNode}`);
  if (value.pendingAction.ref) console.log(`SKILL: ${value.pendingAction.ref}`);
  console.log(`ACTION: ${value.pendingAction.id}`);
}

function printNext(value) {
  if (value.disposition === "done" || value.status === "completed") {
    console.log("NEXT: done");
    return;
  }
  if (value.disposition === "blocked" || value.status === "blocked") {
    console.log("NEXT: blocked");
    if (value.pendingAction) printPendingAction(value);
    for (const blocker of value.blockers ?? [])
      console.log(`REASON: ${blocker}`);
    return;
  }
  if (!value.pendingAction) {
    console.log("NEXT: unavailable");
    for (const blocker of value.blockers ?? [])
      console.log(`REASON: ${blocker}`);
    return;
  }
  printPendingAction(value);
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

function submissionSummary(evidence, raw, nodeId) {
  if (typeof evidence.summary === "string" && evidence.summary.length > 0) {
    return evidence.summary;
  }
  if (raw.trim().length > 0) return raw.trim();
  return `Evidence recorded for ${nodeId}.`;
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

function ensureCurrentNode(nodeArgument, projection) {
  const pending = projection.pendingAction;
  const currentNode = projection.currentNode;
  if (!nodeArgument) throw new Error("record requires a Node id.");
  if (
    (currentNode &&
      (nodeArgument === currentNode || nodeArgument === pending?.ref)) ||
    (!currentNode &&
      pending?.type === "checkpoint" &&
      nodeArgument === "checkpoint")
  ) {
    return currentNode;
  }
  throw new Error(
    `record must target the current Workflow Node: ${currentNode ?? "(checkpoint)"}`,
  );
}

async function main() {
  const { positionals, options } = parseArguments(process.argv.slice(2));
  const command = positionals.shift() ?? "status";
  const nodeArgument = positionals.shift();
  const evidenceRaw = positionals.join(" ");
  const target = resolveTarget(options);
  const protocol = await readProtocol();

  if (command === "status") {
    requireProjectionConfirmation(options);
    const projection = await readProjection(target);
    if (options.rebuild) await syncProjection(target, projection);
    if (options.json) {
      printJson(projection ?? { status: "not-started" });
    } else {
      printJson(projection ?? { status: "not-started" });
    }
    return;
  }

  if (command === "init") {
    const runtime = createWorkflowRuntime();
    const startOptions = {
      protocol,
      location: target,
      confirmations: options.confirmations,
      ...(typeof target === "string" && options.runid
        ? { runId: options.runid }
        : {}),
    };
    const continuation = await runtime.start(startOptions);
    await syncProjection(target, await readProjection(target));
    if (options.json) printJson(continuation);
    else printNext(continuation);
    return;
  }

  if (command === "resume") {
    const continuation = await createWorkflowRuntime().resume(target, {
      confirmations: options.confirmations,
    });
    await syncProjection(target, await readProjection(target));
    if (options.json) printJson(continuation);
    else printNext(continuation);
    return;
  }

  if (command === "next") {
    requireProjectionConfirmation(options);
    const projection = await readProjection(target);
    if (!projection) {
      throw new Error(
        "Missing workflow state. Run workflow-state.mjs init first.",
      );
    }
    if (options.rebuild) await syncProjection(target, projection);
    if (options.json) printJson(projection);
    else printNext(projection);
    return;
  }

  if (command === "record") {
    const projection = await readProjection(target);
    if (!projection) {
      throw new Error(
        "Missing workflow state. Run workflow-state.mjs init first.",
      );
    }
    if (!projection.pendingAction) {
      throw new Error(`Run is ${projection.status}`);
    }
    const nodeId = ensureCurrentNode(nodeArgument, projection);
    const evidence = parseEvidence(evidenceRaw);
    const submission = {
      actionId: projection.pendingAction.id,
      status: "succeeded",
      summary: submissionSummary(evidence, evidenceRaw, nodeId ?? "checkpoint"),
      evidence,
      ...(submissionRouting(evidence)
        ? { routing: submissionRouting(evidence) }
        : {}),
      ...(nodeId ? { nodeId } : {}),
    };
    const continuation = await createWorkflowRuntime().submit(
      target,
      submission,
    );
    await syncProjection(target, await readProjection(target));
    if (options.json) {
      printJson(continuation);
    } else {
      if (nodeId) console.log(`EVIDENCE: ${nodeId}`);
      printNext(continuation);
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
