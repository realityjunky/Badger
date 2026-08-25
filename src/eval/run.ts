import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { CreatorState, EvalReport } from "../types.js";
import { hashDirectory, atomicWrite } from "../util.js";
import { writeState } from "../factory/state.js";

export async function evaluatePackage(
  state: CreatorState,
): Promise<EvalReport> {
  if (!state.generated)
    throw new Error("Generate the workflow package before evaluation");
  const root = state.generated.bundleRoot ?? state.generated.packageRoot;
  const packageRoot = state.generated.packageRoot;
  const hash = await hashDirectory(root);
  const checks: EvalReport["checks"] = [];
  const protocolPath = state.generated.protocolPath;
  const protocol = JSON.parse(await fs.readFile(protocolPath, "utf8")) as {
    kind?: string;
    nodes?: Array<{ id: string; disabled?: boolean }>;
    edges?: unknown[];
    evals?: Array<{ id: string; expectedNodeOrder?: string[] }>;
  };
  const entry = path.join(packageRoot, "SKILL.md");
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
  checks.push({
    id: "bundle-manifest",
    passed: await bundleManifestIsValid(root, packageRoot, protocol),
    detail: path.join(root, "bundle.yaml"),
  });
  for (const relative of requiredControlPlaneFiles(protocol, packageRoot)) {
    checks.push({
      id: `control-plane:${relative}`,
      passed: await exists(path.join(packageRoot, relative)),
      detail: path.join(packageRoot, relative),
    });
  }
  const active = (protocol.nodes ?? [])
    .filter((node) => !node.disabled)
    .map((node) => node.id);
  checks.push({
    id: "route-conformance",
    passed:
      JSON.stringify(active) ===
      JSON.stringify(protocol.evals?.[0]?.expectedNodeOrder ?? []),
    detail: `nodes=${active.join(",")}`,
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

function requiredControlPlaneFiles(
  protocol: {
    nodes?: Array<{ id: string; disabled?: boolean }>;
  },
  packageRoot: string,
): string[] {
  const activeNodes = (protocol.nodes ?? [])
    .filter((node) => !node.disabled)
    .map((node) => `${path.basename(packageRoot)}-${node.id}`);
  return [
    `../../rules/${path.basename(packageRoot)}-orchestration.md`,
    `../../hooks/${path.basename(packageRoot)}-before-write-guard.yaml`,
    `../../hooks/${path.basename(packageRoot)}-before-tool-guard.yaml`,
    "reference/resolved-skills.json",
    "reference/workflow-protocol.json",
    "reference/decision-points.md",
    "reference/recovery.md",
    "reference/authoring-lanes.json",
    "reference/skill-review.md",
    "reference/composition-report.md",
    "reference/subagents/script-author.md",
    "scripts/comet-plan.mjs",
    "scripts/comet-check.mjs",
    "scripts/comet-hook-guard.mjs",
    "scripts/workflow-state.mjs",
    "scripts/workflow-guard.mjs",
    "scripts/workflow-handoff.mjs",
    "comet/skill.yaml",
    "comet/guardrails.yaml",
    "comet/checks.yaml",
    "comet/eval.yaml",
    ...activeNodes.map((name) => `../${name}/SKILL.md`),
  ];
}

async function bundleManifestIsValid(
  bundleRoot: string,
  packageRoot: string,
  protocol: { nodes?: Array<{ id: string; disabled?: boolean }> },
): Promise<boolean> {
  try {
    const manifest = parse(
      await fs.readFile(path.join(bundleRoot, "bundle.yaml"), "utf8"),
    ) as {
      apiVersion?: string;
      kind?: string;
      skills?: Array<{ id?: string; path?: string; visibility?: string }>;
      resources?: {
        rules?: Array<Record<string, unknown>>;
        hooks?: Array<Record<string, unknown>>;
        references?: string[];
        scripts?: Array<Record<string, unknown>>;
      };
      platforms?: {
        requires?: string[];
        optional?: string[];
        overrides?: unknown[];
      };
      engine?: { enabled?: boolean };
    };
    const activeNodes = (protocol.nodes ?? []).filter((node) => !node.disabled);
    const entryName = path.basename(packageRoot);
    const packageRelative = path.relative(bundleRoot, packageRoot);
    if (
      !packageRelative ||
      packageRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(packageRelative)
    )
      return false;
    const skills = manifest.skills ?? [];
    const expectedInternal = activeNodes.map((node) => ({
      id: `${entryName}-${node.id}`,
      path: `skills/${entryName}-${node.id}`,
      visibility: "internal",
    }));
    const expectedRules = [
      {
        id: `${entryName}-orchestration`,
        path: `rules/${entryName}-orchestration.md`,
        mode: "always",
        required: true,
      },
    ];
    const expectedHooks = [
      {
        id: `${entryName}-before-write-guard`,
        path: `hooks/${entryName}-before-write-guard.yaml`,
      },
      {
        id: `${entryName}-before-tool-guard`,
        path: `hooks/${entryName}-before-tool-guard.yaml`,
      },
    ];
    const expectedReferences = [
      `skills/${entryName}/reference/resolved-skills.json`,
      `skills/${entryName}/reference/workflow-protocol.json`,
      `skills/${entryName}/reference/decision-points.md`,
      `skills/${entryName}/reference/recovery.md`,
      `skills/${entryName}/reference/authoring-lanes.json`,
      `skills/${entryName}/reference/skill-review.md`,
      `skills/${entryName}/reference/composition-report.md`,
      `skills/${entryName}/reference/subagents/script-author.md`,
    ];
    const expectedScripts = [
      ["comet-plan", "write"],
      ["comet-check", "read"],
      ["comet-hook-guard", "read"],
      ["workflow-state", "write"],
      ["workflow-guard", "read"],
      ["workflow-handoff", "read"],
    ].map(([id, sideEffect]) => ({
      id,
      path: `skills/${entryName}/scripts/${id}.mjs`,
      sideEffect,
      runtime: "node",
    }));
    const structureValid =
      manifest.apiVersion === "comet/v1alpha1" &&
      manifest.kind === "SkillBundle" &&
      JSON.stringify(skills) ===
        JSON.stringify([
          { id: entryName, path: `skills/${entryName}`, visibility: "entry" },
          ...expectedInternal,
        ]) &&
      JSON.stringify(manifest.resources?.rules ?? []) ===
        JSON.stringify(expectedRules) &&
      JSON.stringify(manifest.resources?.hooks ?? []) ===
        JSON.stringify(expectedHooks) &&
      JSON.stringify(manifest.resources?.references ?? []) ===
        JSON.stringify(expectedReferences) &&
      JSON.stringify(manifest.resources?.scripts ?? []) ===
        JSON.stringify(expectedScripts) &&
      JSON.stringify(manifest.platforms?.requires ?? []) ===
        JSON.stringify(["skills", "scripts", "rules", "hooks", "references"]) &&
      JSON.stringify(manifest.platforms?.optional ?? []) ===
        JSON.stringify([]) &&
      JSON.stringify(manifest.platforms?.overrides ?? []) ===
        JSON.stringify([]) &&
      manifest.engine?.enabled === false;
    if (!structureValid) return false;
    for (const hook of expectedHooks) {
      const document = parse(
        await fs.readFile(path.join(bundleRoot, hook.path), "utf8"),
      ) as Record<string, unknown>;
      const expectedEvent = hook.id.endsWith("before-write-guard")
        ? "before_write"
        : "before_tool";
      const expectedMatcher =
        expectedEvent === "before_write" ? "Write|Edit" : "*";
      if (
        document.event !== expectedEvent ||
        document.matcher !== expectedMatcher ||
        document.script !== "comet-hook-guard" ||
        document.failure !== "block" ||
        document.requiresConfirmation !== false
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}
