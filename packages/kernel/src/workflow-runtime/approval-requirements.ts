import type { ActionOutcome, WorkflowRuntimeState } from "../engine/types.js";
import type {
  NodeTemplate,
  OutputSchema,
  ArtifactSchema,
  WorkflowProtocol,
} from "../types.js";
import {
  currentWorkflowArtifactVersions,
  validateWorkflowArtifactVersion,
} from "./artifacts.js";

export function approvalRequirementProblems(
  nodes: readonly NodeTemplate[],
  schemas: readonly OutputSchema[],
): Array<{ nodeId: string; message: string }> {
  const artifacts = new Map<string, ArtifactSchema>(
    schemas.flatMap((schema) =>
      schema.artifacts.map(
        (artifact) => [`${schema.id}.${artifact.id}`, artifact] as const,
      ),
    ),
  );
  const active = nodes.filter((node) => !node.disabled);
  const problems: Array<{ nodeId: string; message: string }> = [];
  for (const node of active) {
    if (node.approvalRequirements === undefined) continue;
    const report = (message: string) =>
      problems.push({ nodeId: node.id, message: `${node.id}: ${message}` });
    const requirements = node.approvalRequirements;
    if (
      !Array.isArray(requirements) ||
      !requirements.length ||
      requirements.length > 32
    ) {
      report("approvalRequirements must list one to 32 scoped decisions");
      continue;
    }
    if (node === active[0])
      report("the entry Node cannot require a prior approval");
    const seen = new Set<string>();
    for (const requirement of requirements) {
      const reviewer = active.find(
        (candidate) =>
          candidate.kind === "decision" &&
          candidate.decision?.id === requirement?.decisionId,
      );
      const decision = reviewer?.decision;
      if (
        !requirement ||
        typeof requirement !== "object" ||
        Object.keys(requirement).some(
          (key) => !["decisionId", "choiceId", "artifacts"].includes(key),
        ) ||
        !decision ||
        reviewer === node ||
        seen.has(requirement.decisionId) ||
        !decision.choices.some((choice) => choice.id === requirement.choiceId)
      ) {
        report(
          "an approval must name an active prior Decision and its declared choice once",
        );
        continue;
      }
      seen.add(requirement.decisionId);
      if (
        !Array.isArray(requirement.artifacts) ||
        !requirement.artifacts.length ||
        requirement.artifacts.length > 32 ||
        new Set(requirement.artifacts).size !== requirement.artifacts.length ||
        requirement.artifacts.some(
          (id) =>
            !["run", "cycle"].includes(artifacts.get(id)?.lifetime ?? "") ||
            !decision.scope?.artifacts?.some(
              (entry) => entry.id === id && entry.required,
            ),
        )
      )
        report(
          `approval ${requirement.decisionId} requires declared Run or Cycle artifacts in the Decision's required scope`,
        );
    }
  }
  return problems;
}

/** Uses the runtime's verified outcome for the decision currently being committed. */
export async function workflowApprovalBlockers(
  runRoot: string,
  protocol: WorkflowProtocol,
  nodeToStep: Record<string, string>,
  nodeId: string | null,
  runtime?: Readonly<WorkflowRuntimeState>,
  outcome?: Readonly<ActionOutcome>,
): Promise<string[]> {
  const requirements = protocol.nodes.find(
    ({ id }) => id === nodeId,
  )?.approvalRequirements;
  if (!requirements) return [];
  const current = currentWorkflowArtifactVersions(runtime);
  const versions = new Map(
    runtime?.artifactVersions.map((version) => [version.id, version]),
  );
  const visits = new Map(
    runtime?.visits.map((visit) => [visit.stepId, visit.attemptId]),
  );
  if (runtime?.currentAttempt)
    visits.set(runtime.currentAttempt.stepId, runtime.currentAttempt.id);
  const receipts = new Map(
    runtime?.decisionReceipts.map((receipt) => [receipt.decisionId, receipt]),
  );
  const blockers: string[] = [];
  for (const { decisionId, choiceId, artifacts } of requirements) {
    const latest =
      outcome?.kind === "decision" && outcome.decisionId === decisionId
        ? outcome
        : receipts.get(decisionId);
    if (
      !latest ||
      latest.choiceId !== choiceId ||
      !latest.nodeId ||
      latest.attemptId !== visits.get(nodeToStep[latest.nodeId])
    ) {
      blockers.push(
        `Approval required for ${nodeId}: ${decisionId} must record ${choiceId} in the current Attempt`,
      );
      continue;
    }
    for (const artifactId of artifacts) {
      const version = versions.get(current[artifactId]);
      const approved = latest.scope?.artifacts.find(
        ({ id }) => id === artifactId,
      );
      if (
        !version ||
        !approved ||
        approved.versionId !== version.id ||
        approved.contentHash !== version.contentHash ||
        version.producer.attemptId !==
          visits.get(nodeToStep[version.producer.nodeId])
      ) {
        blockers.push(
          `Approval required for ${nodeId}: ${decisionId} must cover the current ${artifactId}`,
        );
        continue;
      }
      try {
        await validateWorkflowArtifactVersion(runRoot, protocol, version);
      } catch (error) {
        blockers.push(
          `Approval required for ${nodeId}: ${artifactId} has changed (${(error as Error).message})`,
        );
      }
    }
  }
  return blockers;
}
