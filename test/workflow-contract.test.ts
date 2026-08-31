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

  it("normalizes conditional routes and scopes required schemas per route", () => {
    const design = node({ id: "design", outputSchemas: ["design.v1"] });
    const pool = node({
      id: "pool",
      label: "Pool",
      implementation: {
        skill: "primer-pool-add",
        operation: "default",
        scope: "main",
      },
      outputSchemas: ["pool.v1"],
    });
    const optional = node({
      id: "optional-qc",
      label: "Optional QC",
      optional: true,
      outputSchemas: ["optional-qc.v1"],
    });
    const input: WorkflowInput = {
      kind: "workflow-kernel",
      name: "branched-primer-workflow",
      goal: "Design primers or add candidates to a pool.",
      customNodes: [design, optional, pool],
      routing: {
        transitions: [
          {
            from: "design",
            to: "optional-qc",
            condition: "success",
            when: "qc-enabled",
          },
          {
            from: "design",
            to: "pool",
            condition: "success",
            when: "add-to-pool",
          },
          { from: "optional-qc", to: "pool", condition: "success" },
          {
            from: "pool",
            to: "design",
            condition: "success",
            when: "start-another-cycle",
          },
          { from: "pool", to: null, condition: "success", when: "finish" },
        ],
        routes: [
          { id: "design-pool", nodeOrder: ["design", "pool"] },
          {
            id: "design-qc-pool",
            nodeOrder: ["design", "optional-qc", "pool"],
          },
        ],
      },
      outputSchemas: [
        { ...schema, id: "design.v1" },
        { ...schema, id: "pool.v1" },
        { ...schema, id: "optional-qc.v1", optional: true },
      ],
    };

    const protocol = normalizeWorkflow(input).protocol;
    expect(protocol.edges).toContainEqual({
      from: "pool",
      to: "design",
      condition: "success",
      when: "start-another-cycle",
    });
    expect(protocol.evals[0].expectedRoutes).toEqual([
      {
        id: "design-pool",
        nodeOrder: ["design", "pool"],
        requiredOutputSchemas: ["design.v1", "pool.v1"],
      },
      {
        id: "design-qc-pool",
        nodeOrder: ["design", "optional-qc", "pool"],
        requiredOutputSchemas: ["design.v1", "optional-qc.v1", "pool.v1"],
      },
    ]);
    expect(protocol.evals[0].requiredOutputSchemas).toEqual([
      "design.v1",
      "pool.v1",
    ]);
  });

  it("normalizes artifact lifetimes and rejects invalid declarations", () => {
    const versionedSchema = structuredClone(schema);
    versionedSchema.artifacts[0] = {
      ...versionedSchema.artifacts[0],
      lifetime: "run",
    } as (typeof versionedSchema.artifacts)[number];
    const input: WorkflowInput = {
      kind: "workflow-kernel",
      name: "artifact-contract-workflow",
      goal: "Version a declared artifact.",
      customNodes: [node()],
      outputSchemas: [versionedSchema],
    };

    const protocol = normalizeWorkflow(input).protocol;
    expect(protocol.capabilities).toEqual({
      version: 3,
      features: [
        "conditional-routing",
        "revisioned-attempts",
        "versioned-artifacts",
      ],
    });
    expect(protocol.outputSchemas[0].artifacts[0]).toMatchObject({
      id: "manifest",
      lifetime: "run",
    });

    const invalid = structuredClone(input) as unknown as WorkflowInput;
    invalid.outputSchemas![0].artifacts.push({
      ...invalid.outputSchemas![0].artifacts[0],
      lifetime: "forever",
    } as never);
    const findings = validateWorkflow(invalid);
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid-schema",
          message: expect.stringContaining("invalid lifetime"),
        }),
        expect.objectContaining({
          code: "invalid-schema",
          message: expect.stringContaining("duplicate artifact"),
        }),
      ]),
    );
  });
});
