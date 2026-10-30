import { withCertificationContext, type EvaluationSandbox } from "./sandbox.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { CreatorState, EvalReport, WorkflowProtocol } from "../types.js";
import { hashDirectory, atomicWrite } from "../util.js";
import { writeState } from "../factory/state.js";
import { toProjectRelativePath } from "../factory/project-paths.js";
import { certifyWorkflowRuntime } from "./workflow-runtime-certification.js";
import {
  authoringSessionGateway,
  readAuthoringPlan,
} from "../authoring/lifecycle.js";
import { crossValidateAuthoringPackage } from "../authoring/cross-validation.js";

export interface EvaluationOptions {
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
  let authoringCrossValidation: EvalReport["authoringCrossValidation"];
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
  const passed = checks.every((check) => check.passed);
  const report: EvalReport = {
    schemaVersion: 1,
    hash,
    passed,
    checks,
    ...(authoringCrossValidation ? { authoringCrossValidation } : {}),
    ...(runtime.evidence ? { runtime: runtime.evidence } : {}),
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
