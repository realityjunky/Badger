import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeWorkflow } from "../src/workflow/contract.js";
import {
  crossValidateAuthoredGuidance,
  type AuthoredGuidanceDocument,
} from "../src/authoring/cross-validation.js";
import type { WorkflowInput } from "../src/types.js";
import { createWorkflowRuntime } from "../src/workflow-runtime/index.js";
import { readRunState } from "../src/engine/state.js";

function workflow(): ReturnType<typeof normalizeWorkflow>["protocol"] {
  const input: WorkflowInput = {
    kind: "workflow-kernel",
    name: "cross-validation-workflow",
    goal: "Validate authored guidance against runtime contracts.",
    customNodes: [
      {
        id: "review",
        label: "Review",
        kind: "decision",
        responsibility: "Review the prepared result.",
        implementation: {
          skill: "review-skill",
          operation: "default",
          scope: "main",
        },
        requiredSkillCalls: [
          {
            skill: "evidence-skill",
            operation: "require",
            scope: "main",
          },
        ],
        operations: ["require", "augment", "disable"],
        outputSchemas: ["review-output"],
        guardrails: [
          {
            id: "review-guard",
            label: "Review guard",
            validation: "semantic",
          },
        ],
        decision: {
          id: "review-decision",
          question: "Should the result be approved?",
          choices: [
            { id: "approve", label: "Approve", to: "finish" },
            { id: "reject", label: "Reject", to: "review" },
          ],
        },
      },
      {
        id: "finish",
        label: "Finish",
        kind: "action",
        responsibility: "Complete the workflow.",
        implementation: {
          skill: "finish-skill",
          operation: "default",
          scope: "main",
        },
        operations: ["require", "augment", "disable"],
        outputSchemas: [],
        guardrails: [],
      },
    ],
    outputSchemas: [
      {
        id: "review-output",
        description: "Reviewed result.",
        artifacts: [
          {
            id: "report",
            kind: "file",
            required: true,
            paths: ["reports/review.txt"],
            validations: ["artifact-exists"],
            lifetime: "run",
          },
        ],
        evidence: [{ id: "review-summary", required: true }],
      },
    ],
    routing: {
      transitions: [
        { from: "review", to: "finish", condition: "success" },
        { from: "review", to: "review", condition: "failure" },
        { from: "finish", to: null, condition: "success" },
      ],
      routes: [
        { id: "approved", nodeOrder: ["review", "finish"] },
        { id: "rejected", nodeOrder: ["review"] },
      ],
    },
  };
  return normalizeWorkflow(input).protocol;
}

function documents(overrides: Partial<Record<string, string>> = {}) {
  const defaults: Record<string, string> = {
    "cross-validation-workflow-review/SKILL.md": [
      "## Guidance",
      "### Required Skill Calls",
      "Required Skill Call: evidence-skill (require, main, guarded).",
      "### Evidence",
      "Output Schema: review-output.",
      "Guardrail: review-guard.",
      "### Recovery",
      "WorkflowRuntime owns recovery and persists the current Node.",
      "For output schema review-output, required artifact report and evidence review-summary are bound; select the exact accepted artifact version and content hash with producer identity.",
    ].join("\n"),
    "reference/decision-points.md": [
      "## Classification",
      "Decision: review-decision.",
      "Choice: approve -> finish.",
      "Choice: reject -> review.",
      "Route: approved.",
      "Route: rejected.",
      "Genuine user decision, automatic handling, stop condition, and manual handoff are distinct.",
    ].join("\n"),
    "reference/recovery.md": [
      "## Recovery",
      "Recovery Authority: WorkflowRuntime.",
      "Read persisted state in a fresh process and resume the current Node.",
      "Use exact accepted artifact versions, never an implicit latest artifact.",
    ].join("\n"),
  };
  return Object.entries({ ...defaults, ...overrides }).map(
    ([path, content]) => ({ path, content }) satisfies AuthoredGuidanceDocument,
  );
}

function linearWorkflow() {
  const input: WorkflowInput = {
    kind: "workflow-kernel",
    name: "route-invariance",
    goal: "Prove authored prose cannot select a runtime route.",
    customNodes: [
      {
        id: "prepare",
        label: "Prepare",
        kind: "action",
        responsibility: "Prepare the input.",
        implementation: {
          skill: "prepare-skill",
          operation: "default",
          scope: "main",
        },
        operations: ["require", "augment", "disable"],
        outputSchemas: [],
        guardrails: [],
      },
      {
        id: "finish",
        label: "Finish",
        kind: "action",
        responsibility: "Finish the workflow.",
        implementation: {
          skill: "finish-skill",
          operation: "default",
          scope: "main",
        },
        operations: ["require", "augment", "disable"],
        outputSchemas: [],
        guardrails: [],
      },
    ],
  };
  return normalizeWorkflow(input).protocol;
}

describe("authored guidance cross-validation", () => {
  it("accepts guidance that matches declared runtime semantics", () => {
    const result = crossValidateAuthoredGuidance({
      workflow: workflow(),
      documents: documents(),
    });
    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.authority).toBe("WorkflowProtocol");
  });

  it("rejects undeclared and contradictory runtime instructions", () => {
    const result = crossValidateAuthoredGuidance({
      workflow: workflow(),
      documents: documents({
        "cross-validation-workflow-review/SKILL.md": [
          "## Guidance",
          "Required Skill Call: invented-skill.",
          "Output Schema: invented-output.",
          "Guardrail: invented-guard.",
          "Warning: the agent owns recovery and writes Run state.",
          "Always use the latest artifact.",
          "NEXT: hidden-node.",
        ].join("\n"),
        "reference/decision-points.md": [
          "## Classification",
          "Choice: invented-choice -> hidden-node.",
          "Choice: approve -> review.",
          "Route: invented-route.",
        ].join("\n"),
      }),
    });

    expect(result.passed).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "missing-required-skill-call",
        "undeclared-skill-call",
        "missing-output-schema",
        "undeclared-output-schema",
        "missing-guardrail",
        "undeclared-guardrail",
        "alternate-recovery-authority",
        "direct-run-state-instruction",
        "implicit-latest-artifact",
        "hidden-exit",
        "undeclared-choice",
        "contradictory-transition",
        "undeclared-route",
      ]),
    );
  });

  it("ignores prohibitions that explain the runtime boundary", () => {
    const result = crossValidateAuthoredGuidance({
      workflow: workflow(),
      documents: documents({
        "reference/recovery.md": [
          "## Recovery",
          "Never let authored prose mutate Run state.",
          "Do not select the latest artifact.",
          "Never create a route absent from WorkflowProtocol.",
          "WorkflowRuntime remains the recovery authority.",
        ].join("\n"),
      }),
    });

    expect(result.findings.map((finding) => finding.code)).not.toEqual(
      expect.arrayContaining([
        "direct-run-state-instruction",
        "implicit-latest-artifact",
        "hidden-exit",
      ]),
    );
  });

  it("keeps committed runtime routing independent from authored prose", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-cross-validation-runtime-"),
    );
    try {
      const started = await createWorkflowRuntime().start({
        protocol: linearWorkflow(),
        runRoot: root,
        runId: "route-invariance-run",
      });
      await fs.writeFile(
        path.join(root, "SKILL.md"),
        "NEXT: hidden-node\nThe prose selects a different route.\n",
      );

      const completed = await createWorkflowRuntime().submit(root, {
        actionId: started.pendingAction!.id,
        nodeId: "prepare",
        status: "succeeded",
        summary: "Prepared the input.",
      });

      expect(completed.currentNode).toBe("finish");
      expect((await readRunState(root)).currentStep).toBe(
        completed.pendingAction!.stepId,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
