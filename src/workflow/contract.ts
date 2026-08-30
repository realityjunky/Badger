import type {
  Binding,
  BindingInput,
  NodeProtocol,
  NodeTemplate,
  OutputSchema,
  WorkflowInput,
  WorkflowProtocol,
  WorkflowProtocolCapabilities,
  WorkflowRoutingCondition,
  WorkflowRoutingField,
  NormalizedWorkflow,
  WorkflowRoute,
  WorkflowTransition,
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
    | "invalid-schema"
    | "unknown-transition-node"
    | "invalid-route";
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
    ...(node.optional !== undefined ? { optional: node.optional } : {}),
    operations: [...node.operations],
    outputSchemas: [...node.outputSchemas],
    guardrails: node.guardrails.map((item) => ({ ...item })),
  };
}

function activeNodeIds(nodes: NodeTemplate[]): Set<string> {
  return new Set(nodes.filter((node) => !node.disabled).map((node) => node.id));
}

function validateRouting(
  input: WorkflowInput,
  nodes: NodeTemplate[],
  findings: ValidationFinding[],
): void {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const activeIds = activeNodeIds(nodes);
  for (const transition of input.routing?.transitions ?? []) {
    if (
      !nodeIds.has(transition.from) ||
      (transition.to !== null && !nodeIds.has(transition.to))
    )
      findings.push({
        code: "unknown-transition-node",
        nodeId: transition.from,
        message: `Transition references an unknown Node: ${transition.from} -> ${transition.to ?? "(terminal)"}`,
      });
    if (typeof transition.when === "string" && !transition.when.trim())
      findings.push({
        code: "invalid-route",
        nodeId: transition.from,
        message: `${transition.from}: transition.when must not be empty`,
      });
  }
  for (const route of input.routing?.routes ?? []) {
    if (!route.id.trim() || route.nodeOrder.length === 0)
      findings.push({
        code: "invalid-route",
        message: "Each route requires an id and at least one Node",
      });
    const seen = new Set<string>();
    for (const nodeId of route.nodeOrder) {
      if (!activeIds.has(nodeId))
        findings.push({
          code: "invalid-route",
          nodeId,
          message: `${route.id}: route references a disabled or unknown Node ${nodeId}`,
        });
      if (seen.has(nodeId))
        findings.push({
          code: "invalid-route",
          nodeId,
          message: `${route.id}: Node ${nodeId} appears more than once`,
        });
      seen.add(nodeId);
    }
  }
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
  validateRouting(input, nodes, findings);
  return findings;
}

function defaultEdges(nodes: NodeProtocol[]): WorkflowProtocol["edges"] {
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

function routingFields(
  fields: WorkflowRoutingField[] | Record<string, string[]> | undefined,
): WorkflowRoutingField[] {
  if (!fields) return [];
  if (Array.isArray(fields)) return fields.map((field) => ({ ...field }));
  return Object.entries(fields).map(([id, values]) => ({
    id,
    values: [...values],
  }));
}

function routingCondition(
  condition: WorkflowRoutingCondition | undefined,
  fields: readonly WorkflowRoutingField[],
): WorkflowRoutingCondition | undefined {
  if (condition === undefined || typeof condition !== "string") {
    if (Array.isArray(condition)) {
      return condition.map((predicate) => ({ ...predicate }));
    }
    if (condition && typeof condition === "object") {
      if ("all" in condition) {
        return {
          all: condition.all.map((predicate) => ({ ...predicate })),
        };
      }
      return { ...condition };
    }
    return condition;
  }
  if (fields.length === 1) {
    const field = fields[0].id ?? fields[0].name;
    if (field) return { field, equals: condition };
  }
  return condition;
}

function phase3Enabled(input: WorkflowInput): boolean {
  return Boolean(
    input.capabilities?.version === 3 ||
    input.routing?.fields !== undefined ||
    input.routing?.routingFields !== undefined,
  );
}

function routingEdges(
  input: WorkflowInput,
  nodes: NodeProtocol[],
  phase3: boolean,
): WorkflowTransition[] {
  if (input.routing?.transitions?.length) {
    const fields = routingFields(
      input.routing.fields ?? input.routing.routingFields,
    );
    return input.routing.transitions.map((edge) => ({
      ...edge,
      ...(phase3 ? { when: routingCondition(edge.when, fields) } : {}),
    }));
  }
  return defaultEdges(nodes);
}

function protocolCapabilities(
  input: WorkflowInput,
  phase3: boolean,
): WorkflowProtocolCapabilities | undefined {
  if (!phase3) return undefined;
  const features = new Set(input.capabilities?.features ?? []);
  features.add("conditional-routing");
  features.add("revisioned-attempts");
  return {
    version: 3,
    features: [...features],
  };
}

function routeSummary(
  input: WorkflowInput,
  nodes: NodeProtocol[],
): WorkflowRoute[] {
  const schemasByNode = new Map(
    nodes.map((node) => [node.id, node.outputSchemas]),
  );
  const optionalSchemas = new Set(
    (input.outputSchemas ?? [])
      .filter((schema) => schema.optional)
      .map((schema) => schema.id),
  );
  if (input.routing?.routes?.length)
    return input.routing.routes.map((route) => ({
      ...route,
      nodeOrder: [...route.nodeOrder],
      requiredOutputSchemas: [
        ...new Set(
          route.nodeOrder.flatMap((nodeId) => schemasByNode.get(nodeId) ?? []),
        ),
      ],
    }));
  return [
    {
      id: "default",
      nodeOrder: nodes.filter((node) => !node.disabled).map((node) => node.id),
      requiredOutputSchemas: [
        ...new Set(
          nodes
            .filter((node) => !node.disabled && !node.optional)
            .flatMap((node) => node.outputSchemas)
            .filter((schemaId) => !optionalSchemas.has(schemaId)),
        ),
      ],
    },
  ];
}

function commonRequiredSchemas(routes: WorkflowRoute[]): string[] {
  const [first, ...rest] = routes;
  if (!first) return [];
  return (first.requiredOutputSchemas ?? []).filter((schemaId) =>
    rest.every((route) => route.requiredOutputSchemas?.includes(schemaId)),
  );
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
      ...(template.optional !== undefined
        ? { optional: template.optional }
        : {}),
    };
  });
  const outputSchemas = [...(input.outputSchemas ?? [])].map((schema) =>
    structuredClone(schema),
  );
  const phase3 = phase3Enabled(input);
  const edges = routingEdges(input, nodes, phase3);
  const routes = routeSummary(input, nodes);
  const protocol: WorkflowProtocol = {
    schemaVersion: 1,
    kind: "workflow-kernel",
    name: input.name,
    goal: input.goal,
    nodes,
    edges,
    outputSchemas,
    ...(protocolCapabilities(input, phase3)
      ? { capabilities: protocolCapabilities(input, phase3) }
      : {}),
    ...(phase3
      ? {
          routing: {
            transitions: structuredClone(edges),
            ...(input.routing?.fields !== undefined ||
            input.routing?.routingFields !== undefined
              ? {
                  fields: routingFields(
                    input.routing.fields ?? input.routing.routingFields,
                  ),
                }
              : {}),
            ...(input.routing?.routes
              ? { routes: structuredClone(input.routing.routes) }
              : {}),
          },
        }
      : {}),
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
        expectedNodeOrder: routes[0].nodeOrder,
        expectedRoutes: routes,
        requiredOutputSchemas: commonRequiredSchemas(routes),
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
