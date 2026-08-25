import { promises as fs } from "node:fs";
import path from "node:path";
import type { CreatorState } from "../types.js";
import { copyDirectory, ensureDirectory } from "../util.js";
import { writeState } from "../factory/state.js";

export function reviewState(state: CreatorState): {
  state: "blocked" | "reviewable" | "publishable";
  blockers: string[];
  evidence: Record<string, string>;
} {
  const blockers: string[] = [];
  if (state.candidates.some((candidate) => candidate.status !== "available"))
    blockers.push("Unresolved Skill candidates remain");
  if (!state.generated) blockers.push("Generated package is missing");
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

export async function approveReview(options: {
  state: CreatorState;
  reviewer: string;
  approve: boolean;
}): Promise<CreatorState> {
  const readiness = reviewState(options.state);
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
  const readiness = reviewState(state);
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
): Promise<{ destination: string; files: string[]; preview: true }> {
  const readiness = reviewState(state);
  if (readiness.state !== "publishable")
    throw new Error(
      `Workflow must be publishable before distribution:\n${readiness.blockers.join("\n")}`,
    );
  const files = await listFiles(
    state.generated!.bundleRoot ?? state.generated!.packageRoot,
  );
  return {
    destination: path.resolve(destination),
    files: files.map((file) => path.join(path.resolve(destination), file)),
    preview: true,
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
