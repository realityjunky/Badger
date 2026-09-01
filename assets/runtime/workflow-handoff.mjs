#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectWorkflowRun,
  projectWorkflowHandoff,
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
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
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
    throw new Error(`Unknown option: ${argument}`);
  }
  return options;
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

function printSummary(handoff) {
  console.log(`WORKFLOW: ${handoff.workflow.name}`);
  console.log(`PROTOCOL: ${handoff.workflow.protocolHash}`);
  console.log(
    `CONTINUATION: ${handoff.continuation?.disposition ?? "not-started"}`,
  );
  for (const finding of handoff.findings ?? []) {
    console.log(`FINDING: ${JSON.stringify(finding)}`);
  }
  if (handoff.findingSummary?.truncated) {
    console.log(`FINDING_SUMMARY: ${JSON.stringify(handoff.findingSummary)}`);
  }
  for (const node of handoff.nodes) {
    console.log(`NODE: ${node.id} (${node.kind})`);
  }
  for (const version of handoff.artifactVersions ?? []) {
    console.log(`ARTIFACT: ${version.artifactId}@${version.id}`);
  }
  for (const receipt of handoff.verificationReceipts ?? []) {
    console.log(
      `VERIFICATION: ${receipt.receiptId} (${receipt.receiptKind}/${receipt.status})`,
    );
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const target = resolveTarget(options);
  const handoff = await projectWorkflowHandoff(
    await readProtocol(),
    await inspectWorkflowRun(target),
  );
  if (options.json) console.log(JSON.stringify(handoff, null, 2));
  else printSummary(handoff);
}

main().catch((error) => {
  if (error && typeof error === "object" && error.finding) {
    console.error(`FINDING: ${JSON.stringify(error.finding)}`);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
