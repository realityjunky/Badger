import type {
  Binding,
  BindingInput,
  NodeProtocol,
  NodeTemplate,
  OutputSchema,
  WorkflowInput,
  WorkflowProtocol,
  NormalizedWorkflow,
} from "../types.js";

export interface ValidationFinding {
  code:
    | "invalid-name"
    | "duplicate-node"
    | "unknown-node"
    | "unsupported-operation"
    | "control-node-override"
    | "producer-missing-output-schema"
    | "missing-output-schema"
    | "orphan-output-schema"
    | "invalid-schema";
  message: string;
  nodeId?: string;
}

const idPattern = /^[a-z][a-z0-9-]{1,63}$/u;

function binding(
  input: BindingInput,
  operation: Binding["operation"],
): Binding {
  const normalizedOperation = input.operation ?? operation;
  const scope = input.scope ?? "main";
  const enforcement =
    input.enforcement ??
    (scope === "handoff"
      ? "handoff-guarded"
      : normalizedOperation === "augment"
        ? "advisory"
        : "guarded");
  return {
    skill: input.skill,
    operation: normalizedOperation,
    scope,
    enforcement,
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

function cloneNode(node: NodeTemplate): NodeTemplate {
  return {
    ...node,
    implementation: { ...node.implementation },
    ...(node.requiredSkillCalls
      ? {
          requiredSkillCalls: node.requiredSkillCalls.map((item) => ({
            ...item,
          })),
        }
      : {}),
    ...(node.augmentations
      ? { augmentations: node.augmentations.map((item) => ({ ...item })) }
      : {}),
    ...(node.satisfies ? { satisfies: [...node.satisfies] } : {}),
    operations: [...node.operations],
    outputSchemas: [...node.outputSchemas],
    guardrails: node.guardrails.map((item) => ({ ...item })),
  };
}

function schemaIds(schemas: OutputSchema[]): Set<string> {
  return new Set(schemas.map((schema) => schema.id));
}

export function validateWorkflow(input: WorkflowInput): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  if (!idPattern.test(input.name))
    findings.push({
      code: "invalid-name",
      message: "workflow.name must use lowercase letters, digits, and hyphens",
    });
  if (!input.goal.trim())
    findings.push({
      code: "invalid-name",
      message: "workflow.goal must not be empty",
    });
  const nodes = input.customNodes ?? [];
  const byId = new Map<string, NodeTemplate>();
  for (const node of nodes) {
    if (byId.has(node.id))
      findings.push({
        code: "duplicate-node",
        nodeId: node.id,
        message: `Duplicate Workflow Node: ${node.id}`,
      });
    byId.set(node.id, node);
    if (!idPattern.test(node.id))
      findings.push({
        code: "invalid-name",
        nodeId: node.id,
        message: `Invalid Workflow Node id: ${node.id}`,
      });
    if (!node.responsibility.trim())
      findings.push({
        code: "invalid-name",
        nodeId: node.id,
        message: `${node.id}: responsibility is required`,
      });
    const checkOperation = (
      skill: string,
      operation: string | undefined,
      label: string,
    ) => {
      if (
        operation &&
        operation !== "default" &&
        !node.operations.includes(operation as never)
      ) {
        findings.push({
          code: "unsupported-operation",
          nodeId: node.id,
          message: `${node.id}: ${label} cannot use ${operation} (skill ${skill})`,
        });
      }
    };
    checkOperation(
      node.implementation.skill,
      node.implementation.operation,
      "implementation",
    );
    for (const item of node.requiredSkillCalls ?? [])
      checkOperation(
        item.skill,
        item.operation ?? "require",
        "required Skill call",
      );
    for (const item of node.augmentations ?? [])
      checkOperation(item.skill, item.operation ?? "augment", "augmentation");
  }
  for (const [nodeId, patch] of Object.entries(input.nodes ?? {})) {
    const node = byId.get(nodeId);
    if (!node) {
      findings.push({
        code: "unknown-node",
        nodeId,
        message: `Unknown Workflow Node: ${nodeId}`,
      });
      continue;
    }
    if (patch.disabled && node.kind !== "guardrail" && node.kind !== "action") {
      findings.push({
        code: "control-node-override",
        nodeId,
        message: `${nodeId}: only action and guardrail Nodes may be disabled`,
      });
    }
    if (
      patch.implementation?.operation === "override" &&
      node.kind === "control"
    ) {
      findings.push({
        code: "control-node-override",
        nodeId,
        message: `${nodeId}: control Nodes cannot be overridden`,
      });
    }
    if (
      patch.implementation?.operation === "override" &&
      node.kind === "producer"
    ) {
      const missing = node.outputSchemas.filter(
        (schema) => !(patch.satisfies ?? []).includes(schema),
      );
      if (missing.length)
        findings.push({
          code: "producer-missing-output-schema",
          nodeId,
          message: `${nodeId}: producer override must satisfy ${missing.join(", ")}`,
        });
    }
    for (const schema of patch.outputSchemas ?? []) {
      if (!schemaIds(input.outputSchemas ?? []).has(schema))
        findings.push({
          code: "missing-output-schema",
          nodeId,
          message: `${nodeId}: undefined Output Schema ${schema}`,
        });
    }
  }
  const attached = new Set(nodes.flatMap((node) => node.outputSchemas));
  for (const [nodeId, patch] of Object.entries(input.nodes ?? {})) {
    if (byId.has(nodeId))
      for (const schema of patch.outputSchemas ?? []) attached.add(schema);
  }
  for (const schema of input.outputSchemas ?? []) {
    if (!schema.id || !schema.description || !attached.has(schema.id))
      findings.push({
        code: "orphan-output-schema",
        message: `Output Schema ${schema.id || "(missing id)"} is not attached to a Node`,
      });
    for (const artifact of schema.artifacts) {
      if (!artifact.id || artifact.paths.length === 0)
        findings.push({
          code: "invalid-schema",
          message: `Output Schema ${schema.id} has an invalid artifact`,
        });
    }
  }
  return findings;
}

function edges(nodes: NodeProtocol[]): WorkflowProtocol["edges"] {
  return nodes.flatMap((node, index) => [
    {
      from: node.id,
      to: nodes[index + 1]?.id ?? null,
      condition: "success" as const,
    },
    { from: node.id, to: node.id, condition: "failure" as const },
    { from: node.id, to: node.id, condition: "pause" as const },
  ]);
}

export function normalizeWorkflow(input: WorkflowInput): NormalizedWorkflow {
  const findings = validateWorkflow(input);
  if (findings.length)
    throw new Error(findings.map((finding) => finding.message).join("\n"));
  const patches = input.nodes ?? {};
  const nodes = (input.customNodes ?? []).map((template): NodeProtocol => {
    const patch = patches[template.id] ?? {};
    return {
      ...cloneNode(template),
      implementation: binding(
        patch.implementation ?? template.implementation,
        patch.implementation ? "override" : "default",
      ),
      requiredSkillCalls: [
        ...(template.requiredSkillCalls ?? []),
        ...(patch.requiredSkillCalls ?? []),
      ].map((item) => binding(item, "require")),
      augmentations: [
        ...(template.augmentations ?? []),
        ...(patch.augmentations ?? []),
      ].map((item) => binding(item, "augment")),
      outputSchemas: [
        ...new Set([
          ...(template.outputSchemas ?? []),
          ...(patch.outputSchemas ?? []),
        ]),
      ],
      satisfies: [
        ...new Set([...(template.satisfies ?? []), ...(patch.satisfies ?? [])]),
      ],
      disabled: patch.disabled ?? template.disabled ?? false,
    };
  });
  const outputSchemas = [...(input.outputSchemas ?? [])].map((schema) =>
    structuredClone(schema),
  );
  const protocol: WorkflowProtocol = {
    schemaVersion: 1,
    kind: "workflow-kernel",
    name: input.name,
    goal: input.goal,
    nodes,
    edges: edges(nodes),
    outputSchemas,
    state: {
      kind: "workflow-run",
      statePath: `.comet/runs/${input.name}/state.json`,
      currentNodeField: "currentNode",
      completedNodesField: "completedNodes",
      evidenceField: "evidence",
    },
    evals: [
      {
        id: "workflow-route-conformance",
        expectedNodeOrder: nodes
          .filter((node) => !node.disabled)
          .map((node) => node.id),
        requiredOutputSchemas: [
          ...new Set(nodes.flatMap((node) => node.outputSchemas)),
        ],
      },
    ],
  };
  const requiredSkills = [
    ...new Set(
      nodes.flatMap((node) => [
        node.implementation.skill,
        ...node.requiredSkillCalls.map((item) => item.skill),
        ...node.augmentations.map((item) => item.skill),
      ]),
    ),
  ];
  return {
    input: structuredClone(input),
    protocol,
    requiredSkills,
    sourceSkills: [...new Set(nodes.map((node) => node.implementation.skill))],
  };
}
