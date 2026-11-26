import {
  certificationExecFile,
  withCertificationContext,
  type EvaluationSandbox,
} from "./sandbox.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  CreatorState,
  EvalReport,
  WorkflowProtocol,
  WorkflowMcpCertificationEvidence,
} from "../types.js";
import { hashDirectory, atomicWrite, sha256 } from "../util.js";
import { writeState } from "../factory/state.js";
import { toProjectRelativePath } from "../factory/project-paths.js";
import { certifyWorkflowRuntime } from "./workflow-runtime-certification.js";
import {
  createPackageSnapshot,
  type PackageSnapshot,
} from "../publish/package-snapshot.js";
import {
  authoringSessionGateway,
  readAuthoringPlan,
} from "../authoring/lifecycle.js";
import { crossValidateAuthoringPackage } from "../authoring/cross-validation.js";
import { authoringEvaluationObligations } from "../authoring/concerns.js";

export interface EvaluationOptions {
  /** Trusted host adapter, run inside the same bounded certification context. */
  certifyMcp?: (input: {
    packageRoot: string;
    protocol: WorkflowProtocol;
    generatedPackageHash: string;
    snapshot: PackageSnapshot;
  }) => Promise<WorkflowMcpCertificationEvidence>;
  sandbox?: EvaluationSandbox;
  /** Host-owned unique report destination, within the Project. */
  reportPath?: string;
  /** Service workers retain immutable reports without changing committed state. */
  persistState?: boolean;
  onProgress?: (phase: string) => void | Promise<void>;
}

export async function evaluatePackage(
  state: CreatorState,
  options: EvaluationOptions = {},
): Promise<EvalReport> {
  return withCertificationContext(options.sandbox, options.onProgress, () =>
    runEvaluation(state, options),
  );
}

async function runEvaluation(
  state: CreatorState,
  options: EvaluationOptions,
): Promise<EvalReport> {
  if (!state.generated)
    throw new Error("Generate the workflow package before evaluation");
  await options.onProgress?.("package-checks");
  const root = state.generated.packageRoot;
  const hash = await hashDirectory(root);
  const checks: EvalReport["checks"] = [];
  let mcp: WorkflowMcpCertificationEvidence | undefined;
  let authoringCrossValidation: EvalReport["authoringCrossValidation"];
  let obligations: ReturnType<typeof authoringEvaluationObligations> = [];
  const protocolPath = state.generated.protocolPath;
  const protocol = JSON.parse(
    await fs.readFile(protocolPath, "utf8"),
  ) as WorkflowProtocol;
  const entry = path.join(root, "SKILL.md");
  const entryContent = await fs.readFile(entry, "utf8").catch(() => "");
  checks.push({
    id: "entry-skill",
    passed: await exists(entry),
    detail: toProjectRelativePath(state.projectRoot, entry),
  });
  checks.push({
    id: "workflow-kernel",
    passed: protocol.kind === "workflow-kernel",
    detail: `kind=${protocol.kind ?? "(missing)"}`,
  });
  const active = (protocol.nodes ?? [])
    .filter((node) => !node.disabled)
    .map((node) => node.id);
  const routes = protocol.evals?.[0]?.expectedRoutes ?? [];
  const activeSet = new Set(active);
  const routeNodesValid = routes.every((route) =>
    route.nodeOrder.every((nodeId) => activeSet.has(nodeId)),
  );
  const routeEdgesValid = routes.every((route) =>
    route.nodeOrder
      .slice(0, -1)
      .every((nodeId, index) =>
        (protocol.edges ?? []).some(
          (edge) =>
            edge.from === nodeId &&
            edge.to === route.nodeOrder[index + 1] &&
            edge.condition === "success",
        ),
      ),
  );
  const legacyRouteValid =
    routes.length > 0 ||
    JSON.stringify(active) ===
      JSON.stringify(protocol.evals?.[0]?.expectedNodeOrder ?? []);
  checks.push({
    id: "route-conformance",
    passed: legacyRouteValid && routeNodesValid && routeEdgesValid,
    detail:
      routes.length > 0
        ? `routes=${routes.map((route) => route.id).join(",")}`
        : `nodes=${active.join(",")}`,
  });
  const entryOrderLine = entryContent
    .split(/\r?\n/u)
    .find((line) => line.startsWith("Executable Node Order:"));
  const entryOrder = entryOrderLine
    ? [...entryOrderLine.matchAll(/`([^`]+)`/gu)].map((match) => match[1])
    : [];
  const expectedOrder = protocol.evals?.[0]?.expectedNodeOrder ?? active;
  checks.push({
    id: "entry-route-conformance",
    passed:
      entryOrderLine !== undefined &&
      JSON.stringify(entryOrder) === JSON.stringify(expectedOrder),
    detail: `entry=${entryOrder.join(",")}`,
  });
  checks.push({
    id: "runtime-manifest",
    passed: await exists(state.generated.evalPath),
    detail: toProjectRelativePath(state.projectRoot, state.generated.evalPath),
  });
  if (state.authoring) {
    const authoringDecision = await authoringSessionGateway().decide({
      state,
      operation: "evaluate",
    });
    const authoring = authoringDecision.readiness;
    obligations = authoringEvaluationObligations(authoring.records);
    const assembled =
      authoringDecision.allowed &&
      authoring.status === "assembled" &&
      authoring.evidence.assembledPackage === hash;
    checks.push({
      id: "authoring-assembly",
      passed: assembled,
      detail: assembled
        ? "Authoring evidence and assembled package match the current hash"
        : authoring.blockers.join("; ") || "Current package is not assembled",
    });
    if (authoring.status !== "assembled") {
      checks.push({
        id: "authoring-runtime-cross-validation",
        passed: false,
        detail: "WorkflowProtocol cross-validation is deferred until assembly",
      });
    } else {
      try {
        const plan = await readAuthoringPlan(state);
        const crossValidation = await crossValidateAuthoringPackage({
          packageRoot: root,
          plan,
        });
        authoringCrossValidation = crossValidation;
        checks.push({
          id: "authoring-runtime-cross-validation",
          passed: crossValidation.passed,
          detail: crossValidation.passed
            ? `WorkflowProtocol-bound authored guidance validated (${crossValidation.crossValidationHash})`
            : crossValidation.findings
                .map((finding) => finding.message)
                .join("; "),
        });
      } catch (error) {
        checks.push({
          id: "authoring-runtime-cross-validation",
          passed: false,
          detail: `Unable to cross-validate authored guidance: ${String(error)}`,
        });
      }
    }
  }
  await options.onProgress?.("runtime-certification");
  const runtime = await certifyWorkflowRuntime({
    protocol,
    generatedPackageHash: hash,
    packageRoot: root,
  });
  checks.push({
    id: "workflow-runtime-certification",
    passed: runtime.blockers.length === 0,
    detail:
      runtime.blockers.length > 0
        ? runtime.blockers.join("; ")
        : "WorkflowRuntime completed generated compatibility and synthetic Phase 3 certification",
  });
  checks.push({
    id: "package-integrity",
    passed: (await hashDirectory(root)) === hash,
    detail: "Package bytes must remain unchanged during certification",
  });
  if (options.certifyMcp) {
    await options.onProgress?.("mcp-certification");
    try {
      mcp = await options.certifyMcp({
        packageRoot: root,
        protocol,
        generatedPackageHash: hash,
        snapshot: await createPackageSnapshot(
          root,
          state.generated.inventory ?? [],
        ),
      });
      const passed =
        mcp.authority === "BadgerMCP" &&
        mcp.mode === "mcp" &&
        mcp.generatedPackageHash === hash &&
        [
          mcp.evaluatedPackageStarted,
          mcp.completed,
          mcp.rootBindingRequired,
          mcp.refusedStartRegisteredNothing,
          mcp.receiptRootVerified,
          mcp.skippedNodeRefused,
          mcp.missingCompletionRefused,
          mcp.illegalRouteRefused,
          mcp.exhaustedCycleRefused,
        ].every((value) => value === true);
      checks.push({
        id: "mcp-runtime-certification",
        passed,
        // Only the start covers the evaluated package; every refusal and the
        // completed Run come from the certifier's synthetic package.
        detail: passed
          ? "Actual Badger MCP tools started the evaluated package with its external roots bound, and enforced Completion, routes, Cycles, and bound artifact roots on a synthetic certification package"
          : "Badger MCP certification evidence is incomplete",
      });
    } catch (error) {
      checks.push({
        id: "mcp-runtime-certification",
        passed: false,
        detail: `Badger MCP certification failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  if (obligations.some(({ check }) => check === "assembled-package-check")) {
    const relative = "scripts/badger-check.mjs";
    const script = path.join(root, relative);
    try {
      const inventoryEntry = state.generated.inventory?.find(
        (entry) => entry.path === relative && entry.owner === "auto",
      );
      if (
        !checks.find(({ id }) => id === "authoring-assembly")?.passed ||
        !inventoryEntry ||
        sha256(await fs.readFile(script)) !== inventoryEntry.sha256
      )
        throw new Error("The assembled package check script is unverified");
      const { stdout } = await certificationExecFile(
        process.execPath,
        [script],
        {
          cwd: root,
          env: { PATH: process.env.PATH },
          timeout: 15_000,
        },
      );
      checks.push({
        id: "assembled-package-check",
        passed: stdout.trim() === "badger-package-check-ok",
        detail: relative,
      });
    } catch {
      checks.push({
        id: "assembled-package-check",
        passed: false,
        detail: "The generated assembled package check did not pass",
      });
    }
  }
  for (const obligation of obligations)
    checks.push({
      id: obligation.id,
      passed: checks.some(
        ({ id, passed }) => id === obligation.check && passed,
      ),
      detail: `Required check ${obligation.check} for ${obligation.detail}`,
    });
  const passed = checks.every((check) => check.passed);
  const report: EvalReport = {
    schemaVersion: 1,
    hash,
    passed,
    checks,
    ...(authoringCrossValidation ? { authoringCrossValidation } : {}),
    ...(runtime.evidence ? { runtime: runtime.evidence } : {}),
    ...(mcp ? { mcp } : {}),
  };
  const resultPath =
    options.reportPath ??
    path.join(state.projectRoot, ".badger", "eval", `${state.name}.json`);
  toProjectRelativePath(state.projectRoot, resultPath);
  await options.onProgress?.("report");
  await atomicWrite(resultPath, JSON.stringify(report, null, 2) + "\n");
  state.currentHash = hash;
  state.eval = {
    hash,
    passed,
    resultPath,
    ...(authoringCrossValidation ? { authoringCrossValidation } : {}),
    ...(runtime.evidence ? { runtime: runtime.evidence } : {}),
  };
  state.status = passed ? "evaluated" : "generated";
  if (options.persistState !== false) await writeState(state);
  return report;
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}
