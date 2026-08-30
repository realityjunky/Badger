import { promises as fs } from "node:fs";
import path from "node:path";
import {
  inspectProtectedProjectPath,
  readProtectedProjectFile,
} from "../engine/protected-project-path.js";
import { RaceSafeReadError } from "../engine/race-safe-read.js";
import type {
  ArtifactSchema,
  NodeProtocol,
  OutputSchema,
  WorkflowProtocol,
} from "../types.js";
import type { RuntimeCompletionPlan } from "../skill-runtime/types.js";
import type { WorkflowSubmission } from "./types.js";

const ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_BLOCKERS = 32;
const MAX_BLOCKER_LENGTH = 512;

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function createCompletionPlan(
  node: NodeProtocol,
): RuntimeCompletionPlan {
  return {
    nodeId: node.id,
    outputSchemas: [...node.outputSchemas],
    requiredSkillCalls: unique(
      node.requiredSkillCalls.map(
        (binding) => `required-skill:${node.id}.${binding.skill}`,
      ),
    ),
    enforcedAugmentations: unique(
      node.augmentations
        .filter((binding) => binding.enforcement !== "advisory")
        .map((binding) => `augmentation:${node.id}.${binding.skill}`),
    ),
    guardrails: unique(
      node.guardrails.map(
        (guardrail) => `guardrail:${node.id}.${guardrail.id}`,
      ),
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function includesEvidence(value: unknown, keys: readonly string[]): boolean {
  if (Array.isArray(value)) {
    return value.some(
      (item) => typeof item === "string" && keys.includes(item),
    );
  }
  if (!isRecord(value)) return false;
  return keys.some((key) => hasOwn(value, key));
}

function hasEvidence(
  evidence: Record<string, unknown>,
  keys: readonly string[],
  containers: readonly string[] = [],
): boolean {
  if (keys.some((key) => hasOwn(evidence, key))) return true;
  for (const container of containers) {
    if (includesEvidence(evidence[container], keys)) return true;
  }
  return includesEvidence(evidence.completedChecks, keys);
}

function schemaFor(protocol: WorkflowProtocol, schemaId: string): OutputSchema {
  const schema = protocol.outputSchemas.find((item) => item.id === schemaId);
  if (!schema) {
    throw new Error(`WorkflowRuntime Output Schema is missing: ${schemaId}`);
  }
  return schema;
}

function expectedArtifactKind(artifact: ArtifactSchema): "file" | "directory" {
  return artifact.kind === "directory" ? "directory" : "file";
}

function artifactPatternSegments(value: string, label: string): string[] {
  const normalized = value.trim().replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    /^(?:~|[\\/])/u.test(normalized)
  ) {
    throw new Error(`${label} must be relative to the Run root`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`${label} must stay inside the Run root`);
  }
  if (segments.some((segment) => segment.length === 0 || segment === ".")) {
    throw new Error(`${label} must not contain empty or dot path segments`);
  }
  return segments;
}

function patternMatcher(pattern: string): RegExp {
  return new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&"))
      .join(".*")}$`,
    "u",
  );
}

async function rootForPattern(runRoot: string, label: string): Promise<string> {
  const stat = await fs.lstat(runRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} Run root must be a real directory`);
  }
  return path.resolve(runRoot);
}

async function matchingArtifactPaths(
  runRoot: string,
  artifactPath: string,
  expected: "file" | "directory",
  label: string,
): Promise<string[]> {
  const segments = artifactPatternSegments(artifactPath, label);
  const root = await rootForPattern(runRoot, label);

  async function walk(relative: string, index: number): Promise<string[]> {
    if (index >= segments.length) {
      const inspection = await inspectProtectedProjectPath(runRoot, relative, {
        label,
        expected,
      });
      return inspection.exists ? [relative] : [];
    }

    const current = relative.length === 0 ? root : path.join(root, relative);
    if (relative.length > 0) {
      const inspection = await inspectProtectedProjectPath(runRoot, relative, {
        label,
        expected: "directory",
      });
      if (!inspection.exists) return [];
    }

    const segment = segments[index];
    if (!segment.includes("*")) {
      return walk(
        relative.length === 0 ? segment : path.posix.join(relative, segment),
        index + 1,
      );
    }

    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return [];
      throw error;
    }
    const matcher = patternMatcher(segment);
    const matches: string[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error(
          `${label} crosses a symbolic link or junction at ${path.join(current, entry.name)}`,
        );
      }
      if (!matcher.test(entry.name)) continue;
      const next =
        relative.length === 0
          ? entry.name
          : path.posix.join(relative, entry.name);
      matches.push(...(await walk(next, index + 1)));
    }
    return matches;
  }

  return walk("", 0);
}

async function artifactExists(
  runRoot: string,
  schema: OutputSchema,
  artifact: ArtifactSchema,
): Promise<boolean> {
  let found = false;
  for (const artifactPath of artifact.paths) {
    const label = `Output Schema artifact ${schema.id}.${artifact.id}`;
    const matches = await matchingArtifactPaths(
      runRoot,
      artifactPath,
      expectedArtifactKind(artifact),
      label,
    );
    if (matches.length === 0) continue;
    found = true;
    if (artifact.kind !== "directory") {
      for (const match of matches) {
        try {
          await readProtectedProjectFile(runRoot, match, ARTIFACT_MAX_BYTES, {
            label,
          });
        } catch (error) {
          if (error instanceof RaceSafeReadError) {
            throw new RaceSafeReadError(
              error.reason,
              `${label}: ${error.message}`,
              { cause: error },
            );
          }
          throw error;
        }
      }
    }
  }
  return found;
}

function missingSchemaEvidence(
  schema: OutputSchema,
  evidence: Record<string, unknown>,
): string[] {
  return schema.evidence
    .filter((field) => field.required)
    .filter(
      (field) =>
        !hasEvidence(
          evidence,
          [field.id, `${schema.id}.${field.id}`],
          ["schemaEvidence"],
        ),
    )
    .map((field) => `${schema.id}.${field.id}`);
}

function missingGuardrailEvidence(
  node: NodeProtocol,
  plan: RuntimeCompletionPlan,
  evidence: Record<string, unknown>,
): string[] {
  const guardrailByKey = new Map(
    node.guardrails.map((guardrail) => [
      `guardrail:${node.id}.${guardrail.id}`,
      guardrail,
    ]),
  );
  return plan.guardrails
    .filter(
      (key) =>
        !hasEvidence(
          evidence,
          [key, guardrailByKey.get(key)?.id ?? key],
          ["guardrails"],
        ),
    )
    .map((key) => key);
}

export function boundBlockers(blockers: readonly string[]): string[] {
  return unique(
    blockers
      .slice(0, MAX_BLOCKERS)
      .map((blocker) =>
        blocker.length > MAX_BLOCKER_LENGTH
          ? `${blocker.slice(0, MAX_BLOCKER_LENGTH - 1)}…`
          : blocker,
      ),
  );
}

export async function validateSuccessfulSubmission(
  runRoot: string,
  protocol: WorkflowProtocol,
  node: NodeProtocol,
  plan: RuntimeCompletionPlan,
  submission: WorkflowSubmission,
): Promise<string[]> {
  if (submission.kind === "decision") return [];
  const evidence = submission.evidence ?? {};
  const blockers: string[] = [];

  for (const schemaId of plan.outputSchemas) {
    const schema = schemaFor(protocol, schemaId);
    for (const artifact of schema.artifacts) {
      if (!artifact.required) continue;
      let exists = false;
      try {
        exists = await artifactExists(runRoot, schema, artifact);
      } catch (error) {
        if (error instanceof RaceSafeReadError) {
          blockers.push(
            `Invalid Output Schema artifact ${schema.id}.${artifact.id}: ${error.message}`,
          );
          continue;
        }
        throw error;
      }
      if (!exists) {
        blockers.push(
          `Missing Output Schema artifacts: ${schema.id}.${artifact.id}`,
        );
      }
    }
    for (const field of missingSchemaEvidence(schema, evidence)) {
      blockers.push(`Missing Output Schema evidence: ${field}`);
    }
  }

  for (const key of plan.requiredSkillCalls) {
    if (!hasEvidence(evidence, [key], ["requiredSkillCalls"])) {
      blockers.push(`Missing required Skill evidence: ${key}`);
    }
  }
  for (const key of plan.enforcedAugmentations) {
    if (!hasEvidence(evidence, [key], ["augmentations"])) {
      blockers.push(`Missing augmentation evidence: ${key}`);
    }
  }
  for (const key of missingGuardrailEvidence(node, plan, evidence)) {
    blockers.push(`Missing guardrail evidence: ${key}`);
  }

  return boundBlockers(blockers);
}
