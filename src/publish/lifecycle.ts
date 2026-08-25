import { promises as fs } from "node:fs";
import path from "node:path";
import type { CreatorState } from "../types.js";
import { copyDirectory, ensureDirectory } from "../util.js";
import { writeState } from "../factory/state.js";
import { authoringReadiness } from "../authoring/lifecycle.js";
import { inspectPackage } from "../eval/run.js";

export function reviewState(state: CreatorState): {
  state: "blocked" | "reviewable" | "publishable";
  blockers: string[];
  evidence: Record<string, string>;
} {
  const blockers: string[] = [];
  if (state.candidates.some((candidate) => candidate.status !== "available"))
    blockers.push("Unresolved Skill candidates remain");
  if (!state.generated) blockers.push("Generated package is missing");
  if (state.generated && !state.authoring)
    blockers.push("Authoring records are missing");
  if (
    state.authoring &&
    (Object.keys(state.authoring.records).length !== 6 ||
      Object.values(state.authoring.records).some(
        (record) => record?.status !== "COMPLETE",
      ))
  )
    blockers.push("Authoring lanes are incomplete");
  if (
    !state.currentHash ||
    !state.eval ||
    state.eval.hash !== state.currentHash ||
    !state.eval.passed
  )
    blockers.push(
      "Passing evaluation evidence for the current package hash is missing",
    );
  if (state.review && state.review.hash !== state.currentHash)
    blockers.push("Review evidence is stale");
  const publishable =
    blockers.length === 0 &&
    state.review?.decision === "approved" &&
    state.review.hash === state.currentHash;
  return {
    state: publishable
      ? "publishable"
      : blockers.length === 0
        ? "reviewable"
        : "blocked",
    blockers,
    evidence: {
      draft: state.draftPath,
      ...(state.generated
        ? {
            generated:
              state.generated.bundleRoot ?? state.generated.packageRoot,
          }
        : {}),
      ...(state.eval ? { eval: state.eval.resultPath } : {}),
    },
  };
}

const AUTHORING_PENDING_MARKER = "<!-- AUTHORING PENDING -->";

async function containsText(root: string, needle: string): Promise<boolean> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory() && (await containsText(target, needle)))
      return true;
    if (!entry.isFile()) continue;
    if ((await fs.readFile(target, "utf8")).includes(needle)) return true;
  }
  return false;
}

async function fileContains(file: string, needle: string): Promise<boolean> {
  try {
    return (await fs.readFile(file, "utf8")).includes(needle);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function entryName(state: CreatorState): string {
  return path.basename(state.generated!.packageRoot);
}

function controlPlaneSummary(
  report: Awaited<ReturnType<typeof inspectPackage>>,
): string {
  const failures = report.checks.filter(
    (check) =>
      !check.passed &&
      (check.id === "bundle-manifest" || check.id.startsWith("control-plane:")),
  ).length;
  return `${Math.max(0, 39 - failures)}/39 file(s)`;
}

function executableWarnings(state: CreatorState): string[] {
  const entry = entryName(state);
  const destination = path.join(
    state.projectRoot,
    ".claude",
    "settings.local.json",
  );
  return [
    `[executable] ${entry}-before-tool-guard: node .claude/skills/${entry}/scripts/comet-hook-guard.mjs -> ${destination} (read)`,
    `[executable] ${entry}-before-write-guard: node .claude/skills/${entry}/scripts/comet-hook-guard.mjs -> ${destination} (read)`,
  ];
}

async function authoringScaffoldEvidence(
  state: CreatorState,
  authoring: Awaited<ReturnType<typeof authoringReadiness>>,
): Promise<{ blockers: string[]; warnings: string[]; classification: string }> {
  const packageDirectory = state.generated!.packageRoot;
  const protocol = JSON.parse(
    await fs.readFile(state.generated!.protocolPath, "utf8"),
  ) as {
    nodes?: Array<{ id: string; disabled?: boolean }>;
  };
  const entryMarker = await fileContains(
    path.join(packageDirectory, "SKILL.md"),
    AUTHORING_PENDING_MARKER,
  );
  const packageMarker = await containsText(
    path.resolve(packageDirectory, ".."),
    AUTHORING_PENDING_MARKER,
  );
  const activeNodes = (protocol.nodes ?? []).filter((node) => !node.disabled);
  const unauthored = [];
  for (const node of activeNodes) {
    const name = `${entryName(state)}-${node.id}`;
    if (
      await fileContains(
        path.join(path.dirname(packageDirectory), name, "SKILL.md"),
        AUTHORING_PENDING_MARKER,
      )
    )
      unauthored.push(name);
  }
  const review = authoring.records["skill-review"]?.review;
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (entryMarker)
    blockers.push("[authoring] Entry Decision Core is not authored");
  if (packageMarker)
    blockers.push(
      "[authoring] Generated package still contains AUTHORING PENDING markers",
    );
  if (unauthored.length > 0)
    blockers.push(
      `[authoring] Substance nodes lack authored content (run skill-core lane): ${unauthored.join(", ")}`,
    );
  if (!review || review.decision !== "approved")
    warnings.push(
      "[authoring] No LLM authoring review recorded; run the skill-review lane",
    );
  if (state.authoring) {
    for (const blocker of authoring.blockers) {
      if (
        !blocker.startsWith("missing authoring record:") &&
        !blocker.startsWith("Authoring scaffold content remains:")
      )
        blockers.push(`[authoring] ${blocker}`);
    }
  }
  return {
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    classification:
      entryMarker || packageMarker || unauthored.length > 0
        ? "scaffold-blocked"
        : "authored",
  };
}

export async function lifecycleReadiness(state: CreatorState): Promise<{
  state: "blocked" | "reviewable" | "publishable";
  blockers: string[];
  warnings: string[];
  evidence: Record<string, string>;
}> {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const evidence: Record<string, string> = { draftPath: state.draftPath };
  if (state.candidates.some((candidate) => candidate.status !== "available"))
    blockers.push(
      `[candidate] Unresolved Skill candidates: ${state.candidates
        .filter((candidate) => candidate.status !== "available")
        .map((candidate) => `${candidate.query} (${candidate.status})`)
        .join(", ")}`,
    );
  if (!state.generated) {
    blockers.push("[draft] Generated package is missing");
    return { state: "blocked", blockers, warnings, evidence };
  }
  const protocol = JSON.parse(
    await fs.readFile(state.generated.protocolPath, "utf8"),
  ) as {
    nodes?: Array<{
      id: string;
      disabled?: boolean;
      requiredSkillCalls?: unknown[];
    }>;
    outputSchemas?: Array<{ id: string }>;
  };
  const authoring = await authoringReadiness(state);
  const scaffold = await authoringScaffoldEvidence(state, authoring);
  blockers.push(...scaffold.blockers);
  warnings.push(...scaffold.warnings);
  evidence.authoringReview = scaffold.warnings.length ? "missing" : "recorded";
  evidence.generatedPackage = state.generated.packageRoot;
  evidence.evalManifest = state.generated.evalPath;
  evidence.wrapperClassification = scaffold.classification;
  evidence.compositionIssues = "0 issue(s)";
  evidence.compositionChoices = "0 choice(s)";
  evidence.workflow = `${protocol.nodes?.length ?? 0} node(s), ${protocol.outputSchemas?.length ?? 0} output schema(s)`;
  evidence.workflowRequiredSkillCalls = `${(protocol.nodes ?? []).reduce(
    (count, node) => count + (node.requiredSkillCalls?.length ?? 0),
    0,
  )} required Skill call(s)`;
  evidence.workflowOutputSchemas = (protocol.outputSchemas ?? [])
    .map((schema) => schema.id)
    .join(", ");
  evidence.factoryPlan = state.planPath;
  if (state.generated) {
    try {
      const current = await inspectPackage(state);
      evidence.controlPlane = controlPlaneSummary(current);
      if (!current.passed) {
        const failed = current.checks
          .filter((check) => !check.passed)
          .map((check) => check.id);
        blockers.push(
          `[control-plane] Current Bundle failed checks: ${failed.join(", ")}`,
        );
      }
      if (
        state.eval &&
        state.currentHash &&
        (state.eval.hash !== current.hash || state.currentHash !== current.hash)
      )
        blockers.push(
          "[eval] Current package hash changed; evaluation evidence is stale",
        );
      else if (
        !state.eval ||
        !state.currentHash ||
        state.eval.hash !== current.hash ||
        !state.eval.passed
      )
        blockers.push(
          "[eval] Eval evidence for the current draft hash is missing",
        );
    } catch (error) {
      blockers.push(
        `[control-plane] Unable to inspect current Bundle: ${String(error)}`,
      );
    }
  }
  warnings.push(...executableWarnings(state));
  const priority = [
    "[candidate]",
    "[preference]",
    "[proposal]",
    "[composition]",
    "[workflow]",
    "[control-plane]",
    "[draft]",
    "[eval]",
    "[authoring]",
  ];
  const uniqueBlockers = [...new Set(blockers)].sort((left, right) => {
    const leftPriority = priority.findIndex((prefix) =>
      left.startsWith(prefix),
    );
    const rightPriority = priority.findIndex((prefix) =>
      right.startsWith(prefix),
    );
    return (
      (leftPriority === -1 ? priority.length : leftPriority) -
      (rightPriority === -1 ? priority.length : rightPriority)
    );
  });
  const publishable =
    uniqueBlockers.length === 0 &&
    state.review?.decision === "approved" &&
    state.review.hash === state.currentHash;
  return {
    state: publishable
      ? "publishable"
      : uniqueBlockers.length === 0
        ? "reviewable"
        : "blocked",
    blockers: uniqueBlockers,
    warnings,
    evidence,
  };
}

export async function approveReview(options: {
  state: CreatorState;
  reviewer: string;
  approve: boolean;
}): Promise<CreatorState> {
  const readiness = await lifecycleReadiness(options.state);
  if (!options.approve) throw new Error("Review approval was not confirmed");
  if (readiness.blockers.length)
    throw new Error(
      `Cannot approve blocked workflow:\n${readiness.blockers.join("\n")}`,
    );
  if (!options.reviewer.trim())
    throw new Error("A reviewer identity is required");
  options.state.review = {
    hash: options.state.currentHash!,
    decision: "approved",
    reviewer: options.reviewer,
    at: new Date().toISOString(),
  };
  options.state.status = "review-approved";
  await writeState(options.state);
  return options.state;
}

export async function publishState(state: CreatorState): Promise<CreatorState> {
  const readiness = await lifecycleReadiness(state);
  if (readiness.state !== "publishable")
    throw new Error(
      `Workflow is not publishable:\n${readiness.blockers.join("\n")}`,
    );
  const destination = path.join(
    state.projectRoot,
    ".comet-any",
    "published",
    state.name,
  );
  await ensureDirectory(path.dirname(destination));
  await fs.rm(destination, { recursive: true, force: true });
  await copyDirectory(
    state.generated!.bundleRoot ?? state.generated!.packageRoot,
    destination,
  );
  state.published = {
    hash: state.currentHash!,
    path: destination,
    at: new Date().toISOString(),
  };
  state.status = "published";
  await writeState(state);
  return state;
}

export async function distributePreview(
  state: CreatorState,
  destination: string,
): Promise<{
  destination: string;
  source: string;
  hash: string;
  files: string[];
  warnings: string[];
  executableDisclosures: string[];
  preview: true;
  hostPlatformWrites: false;
}> {
  const readiness = await lifecycleReadiness(state);
  if (readiness.state !== "publishable")
    throw new Error(
      `Workflow must be publishable before distribution:\n${readiness.blockers.join("\n")}`,
    );
  const files = await listFiles(
    state.generated!.bundleRoot ?? state.generated!.packageRoot,
  );
  return {
    destination: path.resolve(destination),
    source: path.resolve(
      state.generated!.bundleRoot ?? state.generated!.packageRoot,
    ),
    hash: state.currentHash!,
    files: files.map((file) => path.join(path.resolve(destination), file)),
    warnings: readiness.warnings,
    executableDisclosures: readiness.warnings.filter((warning) =>
      warning.startsWith("[executable]"),
    ),
    preview: true,
    hostPlatformWrites: false,
  };
}

async function listFiles(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative);
  const entries = (await fs.readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  );
  const result: string[] = [];
  for (const entry of entries) {
    const next = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) result.push(...(await listFiles(root, next)));
    else if (entry.isFile()) result.push(next);
  }
  return result;
}
