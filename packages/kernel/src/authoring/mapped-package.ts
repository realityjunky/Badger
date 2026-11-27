import { promises as fs } from "node:fs";
import path from "node:path";
import type { CreatorState, WorkflowProtocol } from "../types.js";
import { sha256 } from "../util.js";
import { recordAuthoring } from "./lifecycle.js";
import { AUTHORING_CONTROL_PLANE_SCRIPTS } from "./protocol.js";
import type { AuthoringLaneOutput, AuthoringPlan } from "./types.js";

function mapGuides(protocol: WorkflowProtocol, state: CreatorState) {
  const mapped =
    state.confirmedProposal!.semanticDossier!.workingDossier!.content;
  const decisions = protocol.nodes
    .filter((node) => !node.disabled && node.decision)
    .map((node) => {
      const decision = node.decision!;
      return [
        `### ${node.label}`,
        `Decision: ${decision.id}`,
        decision.question,
        ...decision.choices.map(
          (choice) =>
            `- Choice: ${choice.id} — ${choice.label} → ${choice.to ?? choice.target ?? choice.transition ?? "completion"}`,
        ),
        ...[
          ...(decision.scope?.artifacts ?? []),
          ...(decision.scope?.evidence ?? []),
        ].map((item) => `- Review ${item.id}`),
      ].join("\n");
    });
  const routes = [
    ...new Set([
      ...(protocol.routing?.routes ?? []).map((route) => route.id),
      ...protocol.evals.flatMap(
        (evaluation) =>
          evaluation.expectedRoutes?.map((route) => route.id) ?? [],
      ),
    ]),
  ];
  const guards = protocol.nodes.flatMap((node) =>
    node.guardrails.map(
      (guard) => `- ${node.id}: ${guard.id} — ${guard.label}`,
    ),
  );
  const decisionsText = [
    "# Decision Points",
    "## Classification",
    "WorkflowRuntime follows the mapped transitions. Classify an interruption as a genuine user decision, automatic handling, a stop condition or a manual handoff.",
    "## Genuine User Decisions",
    ...decisions,
    ...(decisions.length
      ? []
      : ["The mapped workflow declares no human decision nodes."]),
    "## Automatic Handling",
    "Follow the applicable transition when the current node completes.",
    ...routes.map((route) => "Route: " + route),
    "## Stop Conditions",
    "Keep the action pending when its required evidence or authorization is unavailable.",
    ...guards,
    "## Manual Handoffs",
    "Return control to the responsible person when the runtime reports a manual handoff.",
    ...Object.values(mapped.interfaces).map(
      (edge) => `- ${edge.producer} → ${edge.consumer}`,
    ),
  ].join("\n\n");
  const recovery = [
    "# Recovery",
    "## State First",
    "WorkflowRuntime owns recovery. In a fresh process inspect persisted state, the current Node, and the pending action before continuing.",
    "## Resume Procedure",
    "Use the next step returned by the runtime for that attempt. Preserve its blocked reason and check the specified evidence before resuming.",
    ...Object.entries(mapped.fields)
      .filter(([id, value]) => id.endsWith("/recoveryPolicy") && value.value)
      .map(([id, value]) => `- ${id}: ${value.value}`),
    "## Drift Handling",
    "Recheck the approval scope when an artifact version changes. Resume from verified state and retain the original evidence for the earlier attempt.",
    ...(protocol.capabilities?.durability?.capabilities ?? []).map(
      (capability) => "- " + capability.replaceAll("-", " "),
    ),
  ].join("\n\n");
  return [
    {
      path: "reference/decision-points.md",
      kind: "markdown",
      content: decisionsText,
    },
    { path: "reference/recovery.md", kind: "markdown", content: recovery },
  ];
}

export async function recordMappedReferences(
  state: CreatorState,
  plan: AuthoringPlan,
) {
  const generated = state.generated!,
    protocol = state.confirmedProposal!.workflow;
  const sources = plan.semanticDossier!.sources.map(
    (source) => source.name + " " + source.contentHash,
  );
  const referencePaths: Record<string, string> = {
    "reference:workflow-protocol": "reference/workflow-protocol.json",
    "reference:resolved-skills": "reference/resolved-skills.json",
    "reference:composition-report": "reference/composition-report.md",
    "reference:authoring-lanes": "reference/authoring-lanes.json",
  };
  for (const lane of ["script", "reference", "pause-points"] as const) {
    const definition = plan.lanes.find((candidate) => candidate.id === lane)!;
    const artifacts = lane === "pause-points" ? mapGuides(protocol, state) : [];
    const claims = await Promise.all(
      definition.claims.map(async (id) => {
        if (lane === "pause-points") {
          const artifact = artifacts.find(
            (item) =>
              item.path === "reference/" + id.slice("pause:".length) + ".md",
          )!;
          return {
            id,
            summary: "Generated from the frozen workflow map.",
            evidence: [artifact.path + " " + sha256(artifact.content)],
          };
        }
        const file =
          lane === "script"
            ? AUTHORING_CONTROL_PLANE_SCRIPTS.find(
                (script) => script.claim === id,
              )!.path
            : referencePaths[id];
        const digest = sha256(
          await fs.readFile(path.join(generated.packageRoot, file), "utf8"),
        );
        if (
          !generated.inventory?.some(
            (entry) => entry.path === file && entry.sha256 === digest,
          )
        )
          throw new Error(
            "The generated file differs from its inventory: " + file,
          );
        return {
          id,
          paths: [file],
          summary: "Verified the generated file against the package inventory.",
          evidence: [
            file + " " + digest,
            ...(id === "reference:resolved-skills" ? sources : []),
          ],
        };
      }),
    );
    const record: AuthoringLaneOutput = {
      lane,
      status: "DONE",
      dispatchMode: "workflow-map",
      semanticDossierHash: plan.semanticDossierHash,
      claims,
      artifacts,
    };
    await recordAuthoring({
      state,
      lane,
      record,
      expectedRevision: state.authoring!.revision,
      confirmed: true,
    });
  }
}
