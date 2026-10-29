import { readProtectedProjectFile } from "../engine/protected-project-path.js";
import { RaceSafeReadError } from "../engine/race-safe-read.js";
import type {
  ArtifactSchema,
  NodeProtocol,
  OutputSchema,
  WorkflowProtocol,
  WorkflowArtifactProducer,
  WorkflowArtifactReceipt,
} from "../types.js";
import type { RuntimeCompletionPlan } from "../skill-runtime/types.js";
import {
  matchingWorkflowArtifactPaths,
  workflowArtifactExpectedKind,
} from "./artifacts.js";
import type { WorkflowSubmission } from "./types.js";
import {
  artifactStorageRoot,
  captureArtifactReceipt,
} from "./artifact-receipts.js";

export interface WorkflowCompletionValidation {
  blockers: string[];
  artifactReceipts: WorkflowArtifactReceipt[];
}

interface WorkflowCompletionContext {
  satisfiedGuardrails?: ReadonlySet<string>;
  /** The directories this Run bound to the declared external roots. */
  externalRoots?: Readonly<Record<string, string>>;
  producer?: WorkflowArtifactProducer;
  attemptStartedAt?: number;
  selectedReceipts?: readonly WorkflowArtifactReceipt[];
}

const ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;

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

async function artifactExists(
  runRoot: string,
  schema: OutputSchema,
  artifact: ArtifactSchema,
): Promise<boolean> {
  let found = false;
  for (const artifactPath of artifact.paths) {
    const label = `Output Schema artifact ${schema.id}.${artifact.id}`;
    const matches = await matchingWorkflowArtifactPaths(
      runRoot,
      artifactPath,
      workflowArtifactExpectedKind(artifact),
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
  satisfiedGuardrails: ReadonlySet<string> = new Set(),
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
        !satisfiedGuardrails.has(key) &&
        !hasEvidence(
          evidence,
          [key, guardrailByKey.get(key)?.id ?? key],
          ["guardrails"],
        ),
    )
    .map((key) => key);
}

export async function validateSuccessfulSubmission(
  runRoot: string,
  protocol: WorkflowProtocol,
  node: NodeProtocol,
  plan: RuntimeCompletionPlan,
  submission: WorkflowSubmission,
  context: WorkflowCompletionContext = {},
): Promise<WorkflowCompletionValidation> {
  const {
    externalRoots,
    producer,
    attemptStartedAt,
    selectedReceipts,
    satisfiedGuardrails = new Set<string>(),
  } = context;
  const artifactReceipts: WorkflowArtifactReceipt[] = [];
  if (submission.kind === "decision") return { blockers: [], artifactReceipts };
  const evidence = submission.evidence ?? {};
  const blockers: string[] = [];

  for (const schemaId of plan.outputSchemas) {
    const schema = schemaFor(protocol, schemaId);
    for (const artifact of schema.artifacts) {
      if (artifact.verification === "receipt") {
        try {
          if (!producer)
            throw new Error("Artifact receipt requires a current Attempt");
          if (
            artifact.requireCurrentAttempt &&
            attemptStartedAt === undefined
          ) {
            throw new Error(
              "Artifact receipt requires persisted Attempt start evidence",
            );
          }
          if (selectedReceipts !== undefined) {
            const selected = selectedReceipts.filter(
              (receipt) => receipt.artifactId === `${schema.id}.${artifact.id}`,
            );
            if (artifact.required && selected.length === 0) {
              throw new Error(
                "Artifact receipt requires an explicit update or version",
              );
            }
            if (
              artifact.requireCurrentAttempt &&
              selected.some(
                (receipt) => receipt.producer.attemptId !== producer.attemptId,
              )
            ) {
              throw new Error(
                `Workflow artifact ${schema.id}.${artifact.id} is stale for this Attempt`,
              );
            }
            if (artifactReceipts.length + selected.length > 256) {
              throw new Error(
                "Output Schema artifacts exceed 256 receipts per Completion",
              );
            }
            artifactReceipts.push(
              ...selected.map((receipt) => structuredClone(receipt)),
            );
            continue;
          }
          const storageRoot = artifactStorageRoot(
            runRoot,
            externalRoots,
            schema,
            artifact,
          );
          const matches = new Set<string>();
          for (const pattern of artifact.paths) {
            for (const match of await matchingWorkflowArtifactPaths(
              storageRoot,
              pattern,
              workflowArtifactExpectedKind(artifact),
              `Workflow artifact ${schema.id}.${artifact.id}`,
            )) {
              matches.add(match);
              if (artifactReceipts.length + matches.size > 256) {
                throw new Error(
                  "Output Schema artifacts exceed 256 receipts per Completion",
                );
              }
            }
          }
          if (artifact.required && matches.size === 0) {
            blockers.push(
              `Missing Output Schema artifacts: ${schema.id}.${artifact.id}`,
            );
          }
          for (const relativePath of matches) {
            artifactReceipts.push(
              await captureArtifactReceipt({
                storageRoot,
                ...(artifact.root !== undefined
                  ? { rootName: artifact.root }
                  : {}),
                relativePath,
                artifactId: `${schema.id}.${artifact.id}`,
                producer,
                ...(artifact.requireCurrentAttempt ? { attemptStartedAt } : {}),
              }),
            );
          }
        } catch (error) {
          blockers.push(
            `Workflow artifact ${schema.id}.${artifact.id} receipt verification failed: ${(error as Error).message}`,
          );
        }
        continue;
      }
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
  for (const key of missingGuardrailEvidence(
    node,
    plan,
    evidence,
    satisfiedGuardrails,
  )) {
    blockers.push(`Missing guardrail evidence: ${key}`);
  }

  return { blockers, artifactReceipts };
}
