import { promises as fs } from "node:fs";
import path from "node:path";
import type { CreatorState, EvalReport } from "../types.js";
import { hashDirectory, atomicWrite } from "../util.js";
import { writeState } from "../factory/state.js";

export async function evaluatePackage(
  state: CreatorState,
): Promise<EvalReport> {
  if (!state.generated)
    throw new Error("Generate the workflow package before evaluation");
  const root = state.generated.packageRoot;
  const hash = await hashDirectory(root);
  const checks: EvalReport["checks"] = [];
  const protocolPath = state.generated.protocolPath;
  const protocol = JSON.parse(await fs.readFile(protocolPath, "utf8")) as {
    kind?: string;
    nodes?: Array<{ id: string; disabled?: boolean }>;
    edges?: Array<{
      from: string;
      to: string | null;
      condition: "success" | "failure" | "pause";
      when?: string;
    }>;
    evals?: Array<{
      id: string;
      expectedNodeOrder?: string[];
      expectedRoutes?: Array<{
        id: string;
        nodeOrder: string[];
        requiredOutputSchemas?: string[];
      }>;
    }>;
  };
  const entry = path.join(root, "SKILL.md");
  checks.push({
    id: "entry-skill",
    passed: await exists(entry),
    detail: entry,
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
  const routeNodesValid = routes.every(
    (route) =>
      route.nodeOrder.length > 0 &&
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
  checks.push({
    id: "runtime-manifest",
    passed: await exists(state.generated.evalPath),
    detail: state.generated.evalPath,
  });
  const passed = checks.every((check) => check.passed);
  const report: EvalReport = { schemaVersion: 1, hash, passed, checks };
  const resultPath = path.join(
    state.projectRoot,
    ".comet-any",
    "eval",
    `${state.name}.json`,
  );
  await atomicWrite(resultPath, JSON.stringify(report, null, 2) + "\n");
  state.currentHash = hash;
  state.eval = { hash, passed, resultPath };
  state.status = passed ? "evaluated" : "generated";
  await writeState(state);
  return report;
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}
