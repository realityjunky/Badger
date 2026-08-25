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

export async function lifecycleReadiness(state: CreatorState): Promise<{
  state: "blocked" | "reviewable" | "publishable";
  blockers: string[];
  warnings: string[];
  evidence: Record<string, string>;
}> {
  const baseline = reviewState(state);
  const blockers = [...baseline.blockers];
  const warnings: string[] = [];
  const evidence = { ...baseline.evidence };
  if (state.generated) {
    const authoring = await authoringReadiness(state);
    evidence.authoringPlan = authoring.evidence.plan ?? "";
    evidence.authoringRecords = authoring.evidence.records ?? "";
    for (const blocker of authoring.blockers)
      if (!blockers.includes(blocker)) blockers.push(blocker);
    warnings.push(...authoring.warnings);
    try {
      const current = await inspectPackage(state);
      evidence.currentBundleHash = current.hash;
      if (!current.passed) {
        const failed = current.checks
          .filter((check) => !check.passed)
          .map((check) => check.id);
        blockers.push(
          `Current Bundle failed Eval checks: ${failed.join(", ")}`,
        );
      }
      if (
        !state.eval ||
        !state.currentHash ||
        state.eval.hash !== current.hash ||
        state.currentHash !== current.hash
      )
        blockers.push(
          "Passing evaluation evidence for the current package hash is missing",
        );
    } catch (error) {
      blockers.push(`Unable to inspect current Bundle: ${String(error)}`);
    }
  }
  const uniqueBlockers = [...new Set(blockers)];
  const publishable =
    uniqueBlockers.length === 0 &&
    state.review?.decision === "approved" &&
    state.review.hash === evidence.currentBundleHash;
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
    hash: readiness.evidence.currentBundleHash ?? state.currentHash!,
    files: files.map((file) => path.join(path.resolve(destination), file)),
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
