import { createHash } from "node:crypto";
/** A report author's independent example, submitted through the HTTP/MCP seam. */
export function reportLaneOutput(context: any) {
  const { lane, plan } = context.authoring;
  const definition = plan.lanes.find((l: any) => l.id === lane);
  const entry = `## Decision Core
### Automatic Node Detection
Read persisted state to identify the current Node. Match the user's request to its responsibility before loading the prepare Skill.
### Resume And Drift
Re-read the report and persisted state on resume; conversation history cannot establish completion. A topic change requires checking whether the report remains in scope.
### Decision Classification And Decision Points
Apply automatic handling for a deterministic retry. A user decision needs declared alternatives. A stop condition preserves its blocked reason. A manual handoff returns the missing report requirement to the owner.
### Red Flags
Do not advance with an empty report or assume a successful command establishes report quality.`;
  const node = `## Guidance
The report Node prepares a reviewed report using the declared implementation Skill ${plan.sourceEvidence[0].name}.
### Prerequisites
Read the persisted current Node and obtain the report inputs before beginning.
### Steps
1. Load ${plan.sourceEvidence[0].name} and produce a report for the confirmed scope.
2. Read the report and verify its statements against the input evidence.
3. Record evidence describing the observed report and why it meets the responsibility.
### Required Skill Calls
No additional Skill Calls are required.
### Evidence
Capture evidence for the completion summary; preserve the report's identity and the reasoning behind acceptance.
### Completion Reasoning
The report is complete when its claims can be checked and its scope matches the confirmed request.
### Red Flags
An empty document and unverified claims require repair before advancing.
### Recovery
On resume, read persisted state and re-enter this Node when the report evidence is incomplete.`;
  const decisions = `# Decision Points
## Classification
Classify interruptions against the protocol before involving the owner.
### Genuine User Decisions
A genuine user decision requires declared alternatives affecting the report's scope.
### Automatic Handling
Use automatic handling for a deterministic retry without inventing choices.
### Stop Conditions
A stop condition retains missing evidence and the required repair.
### Manual Handoffs
A manual handoff returns unresolved domain work to the person responsible. The declared route default follows the report Node. No runtime choices or extra routes are declared.`;
  const recovery = `# Recovery
## State First
WorkflowRuntime remains the recovery authority. In a fresh process read persisted state and the current Node before remembering earlier work.
## Resume Procedure
Follow the next step recorded by WorkflowRuntime and retain the report evidence for its producing Attempt.
## Drift Handling
When inputs changed, retain the blocked reason and repair the affected report. Never infer an unrecorded transition from conversation history.`;
  const review = `# Skill Review
## Contract Fit
The report guidance follows the declared responsibility, implementation and runtime authority.
## Usability
The author explains preparation, evidence and recovery without relying on conversation history.
## Strengths
The instructions preserve the separation between authored judgment and deterministic controls.
## Findings
No blocking findings remain. Verdict: approved; the report examples provide sufficient context for the intended author.`;
  const vote = {
    findings: [],
    id: "report-reviewer",
    inputHash: context.authoring.handoff.hashes.authoringInputHash,
    model: "review-fixture",
    passed: true,
    provider: "test-agent",
  };
  const voter = {
    ...vote,
    evidenceHash: createHash("sha256")
      .update(JSON.stringify(vote))
      .digest("hex"),
  };
  return {
    lane,
    status: "DONE",
    semanticDossierHash: plan.semanticDossierHash,
    claims: [...definition.claims, ...definition.derivedClaims].map(
      (id: string) => ({
        id,
        summary:
          "Checked the confirmed report responsibility and its documented evidence.",
      }),
    ),
    artifacts: definition.contentLeaves.map((path: string) => ({
      path,
      kind: "markdown",
      content:
        path === "SKILL.md"
          ? entry
          : path.endsWith("/SKILL.md")
            ? node
            : path.endsWith("decision-points.md")
              ? decisions
              : path.endsWith("recovery.md")
                ? recovery
                : review,
    })),
    ...(lane === "skill-review"
      ? {
          review: {
            passed: true,
            evidenceSource: "llm-single",
            voters: 1,
            inputHash: vote.inputHash,
            voterEvidence: [voter],
            lenses: plan.verify.lenses,
            rounds: 1,
            findings: [],
            reviewedAt: "2026-10-30T00:00:00.000Z",
          },
        }
      : {}),
  };
}
