import { describe, expect, it } from "vitest";
import {
  normalizeWorkflow,
  validateWorkflow,
} from "../src/workflow/contract.js";
import type { WorkflowInput } from "../src/types.js";

function node(overrides: Partial<WorkflowInput["customNodes"][number]> = {}) {
  return {
    id: "prepare",
    label: "Prepare",
    kind: "action" as const,
    responsibility: "Prepare bounded inputs.",
    implementation: {
      skill: "primer-design",
      operation: "default" as const,
      scope: "main" as const,
    },
    operations: ["require", "augment", "disable"] as const,
    outputSchemas: ["prepare.v1"],
    guardrails: [],
    ...overrides,
  };
}

const schema = {
  id: "prepare.v1",
  description: "Prepared inputs.",
  artifacts: [
    {
      id: "manifest",
      kind: "file" as const,
      required: true,
      paths: ["manifest.tsv"],
      validations: ["artifact-exists" as const],
    },
  ],
  evidence: [{ id: "summary", required: true }],
};

describe("workflow-kernel contract", () => {
  it("normalizes custom Nodes and creates deterministic recovery edges", () => {
    const input: WorkflowInput = {
      kind: "workflow-kernel",
      name: "primer-workflow",
      goal: "Design primers.",
      customNodes: [node()],
      outputSchemas: [schema],
    };
    const normalized = normalizeWorkflow(input);
    expect(normalized.protocol.state.statePath).toBe(
      ".comet/runs/primer-workflow/state.json",
    );
    expect(normalized.protocol.edges).toEqual([
      { from: "prepare", to: null, condition: "success" },
      { from: "prepare", to: "prepare", condition: "failure" },
      { from: "prepare", to: "prepare", condition: "pause" },
    ]);
    expect(normalized.requiredSkills).toEqual(["primer-design"]);
  });

  it("rejects control overrides and orphan schemas", () => {
    const input: WorkflowInput = {
      kind: "workflow-kernel",
      name: "unsafe-workflow",
      goal: "Unsafe.",
      customNodes: [
        node({
          id: "control",
          kind: "control",
          operations: ["require", "augment"] as const,
        }),
      ],
      nodes: {
        control: {
          implementation: { skill: "replacement", operation: "override" },
        },
      },
      outputSchemas: [{ ...schema, id: "orphan.v1" }],
    };
    const findings = validateWorkflow(input);
    expect(findings.map((finding) => finding.code)).toContain(
      "control-node-override",
    );
    expect(findings.map((finding) => finding.code)).toContain(
      "orphan-output-schema",
    );
  });
});
