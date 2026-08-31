import type {
  Binding,
  BindingInput,
  NodeProtocol,
  NodeTemplate,
  OutputSchema,
  WorkflowInput,
  WorkflowCycleDefinition,
  WorkflowProtocol,
  WorkflowProtocolCapabilities,
  WorkflowDecisionDefinition,
  WorkflowDecisionChoice,
  WorkflowDecisionScope,
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
    | "invalid-route"
    | "invalid-decision"
    | "invalid-cycle";
  message: string;
  nodeId?: string;
}

const idPattern = /^[a-z][a-z0-9-]{1,63}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function decisionChoiceTarget(
  choice: WorkflowDecisionChoice,
): string | null | undefined {
  return choice.to !== undefined
    ? choice.to
    : choice.target !== undefined
      ? choice.target
      : choice.transition;
}

function decisionScalarType(value: unknown): boolean {
  return value === "string" || value === "number" || value === "boolean";
}

function scalarMatchesType(value: unknown, type: string): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "number")
    return typeof value === "number" && Number.isFinite(value);
  return typeof value === "boolean";
}

function decisionInputErrors(schema: unknown, label: string): string[] {
  const errors: string[] = [];
  if (!isRecord(schema)) return [`${label} must be an object`];
  const schemaKeys = new Set(["type", "fields"]);
  const unknownSchemaKey = Object.keys(schema).find(
    (key) => !schemaKeys.has(key),
  );
  if (unknownSchemaKey) {
    errors.push(`${label} has unsupported field: ${unknownSchemaKey}`);
  }
  if (schema.type !== "object") {
    errors.push(`${label}.type must be object`);
  }
  if (!Array.isArray(schema.fields)) {
    errors.push(`${label}.fields must be an array`);
    return errors;
  }
  const ids = new Set<string>();
  for (const [index, field] of schema.fields.entries()) {
    const fieldLabel = `${label}.fields[${index}]`;
    if (!isRecord(field)) {
      errors.push(`${fieldLabel} must be an object`);
      continue;
    }
    const fieldKeys = new Set(["id", "type", "required", "values", "enum"]);
    const unknownFieldKey = Object.keys(field).find(
      (key) => !fieldKeys.has(key),
    );
    if (unknownFieldKey) {
      errors.push(`${fieldLabel} has unsupported field: ${unknownFieldKey}`);
    }
    if (typeof field.id !== "string" || field.id.length === 0) {
      errors.push(`${fieldLabel}.id must be a non-empty string`);
    } else if (ids.has(field.id)) {
      errors.push(`${label} has duplicate input field: ${field.id}`);
    } else {
      ids.add(field.id);
    }
    if (!decisionScalarType(field.type)) {
      errors.push(`${fieldLabel}.type must be string, number, or boolean`);
    }
    if (field.required !== undefined && typeof field.required !== "boolean") {
      errors.push(`${fieldLabel}.required must be a boolean`);
    }
    const values = field.values ?? field.enum;
    if (field.values !== undefined && field.enum !== undefined) {
      errors.push(`${fieldLabel} must use either values or enum, not both`);
    }
    if (values !== undefined) {
      if (!Array.isArray(values) || values.length === 0) {
        errors.push(`${fieldLabel}.values must be a non-empty array`);
      } else {
        const seenValues = new Set<string>();
        for (const value of values) {
          if (!scalarMatchesType(value, String(field.type))) {
            errors.push(
              `${fieldLabel}.values contains a value with the wrong type`,
            );
            continue;
          }
          const key = JSON.stringify(value);
          if (seenValues.has(key)) {
            errors.push(`${fieldLabel}.values must not contain duplicates`);
          }
          seenValues.add(key);
        }
      }
    }
  }
  return errors;
}

function decisionScopeErrors(scope: unknown, label: string): string[] {
  const errors: string[] = [];
  if (!isRecord(scope)) return [`${label} must be an object`];
  const scopeKeys = new Set(["artifacts", "evidence"]);
  const unknown = Object.keys(scope).find((key) => !scopeKeys.has(key));
  if (unknown) errors.push(`${label} has unsupported field: ${unknown}`);
  let entryCount = 0;
  for (const kind of ["artifacts", "evidence"] as const) {
    const entries = scope[kind];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) {
      errors.push(`${label}.${kind} must be an array`);
      continue;
    }
    const ids = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      const entryLabel = `${label}.${kind}[${index}]`;
      if (!isRecord(entry)) {
        errors.push(`${entryLabel} must be an object`);
        continue;
      }
      const unknownEntry = Object.keys(entry).find(
        (key) => key !== "id" && key !== "required",
      );
      if (unknownEntry) {
        errors.push(`${entryLabel} has unsupported field: ${unknownEntry}`);
      }
      if (typeof entry.id !== "string" || entry.id.length === 0) {
        errors.push(`${entryLabel}.id must be a non-empty string`);
      } else if (ids.has(entry.id)) {
        errors.push(`${label}.${kind} has duplicate entry: ${entry.id}`);
      } else {
        ids.add(entry.id);
      }
      if (entry.required !== undefined && typeof entry.required !== "boolean") {
        errors.push(`${entryLabel}.required must be a boolean`);
      }
      entryCount += 1;
    }
  }
  if (entryCount > 64) {
    errors.push(`${label} must not contain more than 64 entries`);
  }
  return errors;
}

function decisionErrors(decision: unknown, nodeId: string): string[] {
  const label = `Decision Node ${nodeId}`;
  const errors: string[] = [];
  if (!isRecord(decision)) return [`${label} requires a decision definition`];
  const keys = new Set([
    "id",
    "question",
    "choices",
    "inputs",
    "rationale",
    "reviewer",
    "scope",
  ]);
  const unknown = Object.keys(decision).find((key) => !keys.has(key));
  if (unknown) errors.push(`${label} has unsupported field: ${unknown}`);
  if (typeof decision.id !== "string" || decision.id.length === 0) {
    errors.push(`${label} id must be a non-empty string`);
  }
  if (typeof decision.question !== "string" || decision.question.length === 0) {
    errors.push(`${label} question must be a non-empty string`);
  }
  if (!Array.isArray(decision.choices) || decision.choices.length === 0) {
    errors.push(`${label} choices must be a non-empty array`);
  } else {
    const choiceIds = new Set<string>();
    const targets = new Set<string | null>();
    for (const [index, choice] of decision.choices.entries()) {
      const choiceLabel = `${label}.choices[${index}]`;
      if (!isRecord(choice)) {
        errors.push(`${choiceLabel} must be an object`);
        continue;
      }
      const choiceKeys = new Set([
        "id",
        "label",
        "to",
        "target",
        "transition",
        "inputs",
        "routing",
      ]);
      const unknownChoice = Object.keys(choice).find(
        (key) => !choiceKeys.has(key),
      );
      if (unknownChoice) {
        errors.push(`${choiceLabel} has unsupported field: ${unknownChoice}`);
      }
      if (typeof choice.id !== "string" || choice.id.length === 0) {
        errors.push(`${choiceLabel}.id must be a non-empty string`);
      } else if (choiceIds.has(choice.id)) {
        errors.push(`${label} has duplicate choice id: ${choice.id}`);
      } else {
        choiceIds.add(choice.id);
      }
      if (typeof choice.label !== "string" || choice.label.length === 0) {
        errors.push(`${choiceLabel}.label must be a non-empty string`);
      }
      const targetProperties = ["to", "target", "transition"].filter((key) =>
        Object.prototype.hasOwnProperty.call(choice, key),
      );
      if (targetProperties.length !== 1) {
        errors.push(
          `${choiceLabel} must declare exactly one transition target field`,
        );
      }
      const target = decisionChoiceTarget(
        choice as unknown as WorkflowDecisionChoice,
      );
      if (target === undefined || target === "") {
        errors.push(`${choiceLabel} requires a transition target`);
      } else if (targets.has(target)) {
        errors.push(`${label} has duplicate choice mapping to: ${target}`);
      } else {
        targets.add(target);
      }
      if (choice.inputs !== undefined) {
        errors.push(
          ...decisionInputErrors(choice.inputs, `${choiceLabel}.inputs`),
        );
      }
      if (choice.routing !== undefined) {
        if (!isRecord(choice.routing)) {
          errors.push(`${choiceLabel}.routing must be an object`);
        } else if (
          Object.entries(choice.routing).some(
            ([field, value]) =>
              field.length === 0 ||
              typeof value !== "string" ||
              value.length === 0,
          )
        ) {
          errors.push(`${choiceLabel}.routing must contain non-empty strings`);
        }
      }
    }
  }
  if (decision.inputs !== undefined) {
    errors.push(...decisionInputErrors(decision.inputs, `${label}.inputs`));
  }
  if (decision.rationale !== undefined) {
    if (!isRecord(decision.rationale)) {
      errors.push(`${label}.rationale must be an object`);
    } else if (
      Object.keys(decision.rationale).some((key) => key !== "required") ||
      (decision.rationale.required !== undefined &&
        typeof decision.rationale.required !== "boolean")
    ) {
      errors.push(`${label}.rationale.required must be a boolean`);
    }
  }
  if (decision.reviewer !== undefined) {
    if (!isRecord(decision.reviewer)) {
      errors.push(`${label}.reviewer must be an object`);
    } else {
      const reviewerKeys = new Set(["subjects", "authorities"]);
      const unknownReviewer = Object.keys(decision.reviewer).find(
        (key) => !reviewerKeys.has(key),
      );
      if (unknownReviewer) {
        errors.push(
          `${label}.reviewer has unsupported field: ${unknownReviewer}`,
        );
      }
      for (const key of ["subjects", "authorities"] as const) {
        const values = decision.reviewer[key];
        if (values === undefined) continue;
        if (
          !Array.isArray(values) ||
          values.length === 0 ||
          values.some(
            (value) => typeof value !== "string" || value.length === 0,
          )
        ) {
          errors.push(
            `${label}.reviewer.${key} must be a non-empty string array`,
          );
        } else if (new Set(values).size !== values.length) {
          errors.push(`${label}.reviewer.${key} must not contain duplicates`);
        }
      }
    }
  }
  if (decision.scope !== undefined) {
    errors.push(...decisionScopeErrors(decision.scope, `${label}.scope`));
  }
  return errors;
}

export function validateDecisionDefinition(
  decision: WorkflowDecisionDefinition | undefined,
  nodeId: string,
): void {
  const errors = decisionErrors(decision, nodeId);
  if (errors.length > 0) throw new Error(errors.join("\n"));
}

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
    ...(node.decision ? { decision: structuredClone(node.decision) } : {}),
  };
}

function cloneCycles(
  cycles: WorkflowCycleDefinition[] | undefined,
): WorkflowCycleDefinition[] | undefined {
  return cycles?.map((cycle) => ({
    ...cycle,
    repeatTransitions: cycle.repeatTransitions.map((transition) => ({
      ...transition,
    })),
  }));
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

function validateCycles(
  input: WorkflowInput,
  nodes: NodeTemplate[],
  findings: ValidationFinding[],
): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const keys = new Set<string>();
  for (const cycle of input.cycles ?? []) {
    const invalid = (message: string, nodeId?: string): void => {
      findings.push({ code: "invalid-cycle", message, nodeId });
    };
    if (!idPattern.test(cycle.key) || keys.has(cycle.key)) {
      invalid(`Invalid or duplicate Cycle key: ${cycle.key}`);
    }
    keys.add(cycle.key);
    const entry = byId.get(cycle.entry);
    if (!entry || entry.disabled) {
      invalid(
        `Cycle ${cycle.key} references an unknown or disabled entry Node: ${cycle.entry}`,
        cycle.entry,
      );
    }
    if (!Number.isSafeInteger(cycle.maxInstances) || cycle.maxInstances < 1) {
      invalid(
        `Cycle ${cycle.key} maxInstances must be a finite positive integer`,
      );
    }
    if (
      !Array.isArray(cycle.repeatTransitions) ||
      cycle.repeatTransitions.length === 0
    ) {
      invalid(`Cycle ${cycle.key} repeatTransitions must be non-empty`);
      continue;
    }
    const repeatKeys = new Set<string>();
    for (const repeat of cycle.repeatTransitions) {
      const from = byId.get(repeat.from);
      const to = byId.get(repeat.to);
      const repeatKey = `${repeat.from}\u0000${repeat.to}`;
      if (repeatKeys.has(repeatKey)) {
        invalid(
          `Cycle ${cycle.key} repeats the same transition: ${repeat.from} -> ${repeat.to}`,
          repeat.from,
        );
      }
      repeatKeys.add(repeatKey);
      if (!from || from.disabled || !to || to.disabled) {
        invalid(
          `Cycle ${cycle.key} references an unknown or disabled repeat Node: ${repeat.from} -> ${repeat.to}`,
          !from || from.disabled ? repeat.from : repeat.to,
        );
      }
    }
  }
}

function schemaIds(schemas: OutputSchema[]): Set<string> {
  return new Set(schemas.map((schema) => schema.id));
}

function declaredScopeIds(
  schemas: readonly OutputSchema[],
  kind: "artifacts" | "evidence",
): string[] {
  return schemas.flatMap((schema) =>
    schema[kind].map((entry) => `${schema.id}.${entry.id}`),
  );
}

function resolveDeclaredScopeId(
  requested: string,
  declared: readonly string[],
): string | null {
  if (declared.includes(requested)) return requested;
  const matches = declared.filter(
    (candidate) =>
      candidate.slice(candidate.lastIndexOf(".") + 1) === requested,
  );
  return matches.length === 1 ? matches[0] : null;
}

function validateDecisionScopes(
  nodes: readonly NodeTemplate[],
  schemas: readonly OutputSchema[],
  findings: ValidationFinding[],
): void {
  const declared = {
    artifacts: declaredScopeIds(schemas, "artifacts"),
    evidence: declaredScopeIds(schemas, "evidence"),
  } as const;
  for (const node of nodes) {
    for (const kind of ["artifacts", "evidence"] as const) {
      const seen = new Set<string>();
      for (const entry of node.decision?.scope?.[kind] ?? []) {
        const resolved = resolveDeclaredScopeId(entry.id, declared[kind]);
        if (!resolved) {
          findings.push({
            code: "invalid-decision",
            nodeId: node.id,
            message: `Decision Node ${node.id} scope ${kind} is not declared: ${entry.id}`,
          });
        } else if (seen.has(resolved)) {
          findings.push({
            code: "invalid-decision",
            nodeId: node.id,
            message: `Decision Node ${node.id} scope ${kind} has duplicate entry: ${resolved}`,
          });
        } else {
          seen.add(resolved);
        }
      }
    }
  }
}

function normalizeDecisionScope(
  scope: WorkflowDecisionScope,
  schemas: readonly OutputSchema[],
): WorkflowDecisionScope {
  const normalized: WorkflowDecisionScope = {};
  for (const kind of ["artifacts", "evidence"] as const) {
    const entries = scope[kind];
    if (!entries) continue;
    const declared = declaredScopeIds(schemas, kind);
    normalized[kind] = entries.map((entry) => ({
      id: resolveDeclaredScopeId(entry.id, declared) ?? entry.id,
      required: entry.required === true,
    }));
  }
  return normalized;
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
  const decisionIds = new Set<string>();
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
    if (node.kind === "decision") {
      const errors = decisionErrors(node.decision, node.id);
      if (node.decision?.id) {
        if (decisionIds.has(node.decision.id)) {
          errors.push(`Decision id is duplicated: ${node.decision.id}`);
        }
        decisionIds.add(node.decision.id);
      }
      for (const message of errors)
        findings.push({
          code: "invalid-decision",
          nodeId: node.id,
          message,
        });
    } else if (node.decision !== undefined) {
      findings.push({
        code: "invalid-decision",
        nodeId: node.id,
        message: `${node.id}: only decision Nodes may declare a decision definition`,
      });
    }
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
  const logicalArtifactIds = new Set<string>();
  for (const schema of input.outputSchemas ?? []) {
    if (!schema.id || !schema.description || !attached.has(schema.id))
      findings.push({
        code: "orphan-output-schema",
        message: `Output Schema ${schema.id || "(missing id)"} is not attached to a Node`,
      });
    const artifactIds = new Set<string>();
    for (const artifact of schema.artifacts) {
      if (!artifact.id || artifact.paths.length === 0)
        findings.push({
          code: "invalid-schema",
          message: `Output Schema ${schema.id} has an invalid artifact`,
        });
      if (artifactIds.has(artifact.id)) {
        findings.push({
          code: "invalid-schema",
          message: `Output Schema ${schema.id} has duplicate artifact: ${artifact.id}`,
        });
      }
      artifactIds.add(artifact.id);
      const logicalArtifactId = `${schema.id}.${artifact.id}`;
      if (logicalArtifactIds.has(logicalArtifactId)) {
        findings.push({
          code: "invalid-schema",
          message: `Workflow has duplicate logical artifact: ${logicalArtifactId}`,
        });
      }
      logicalArtifactIds.add(logicalArtifactId);
      if (
        artifact.lifetime !== undefined &&
        artifact.lifetime !== "attempt" &&
        artifact.lifetime !== "cycle" &&
        artifact.lifetime !== "run"
      ) {
        findings.push({
          code: "invalid-schema",
          message: `Output Schema ${schema.id}.${artifact.id} has an invalid lifetime`,
        });
      }
    }
  }
  validateDecisionScopes(nodes, input.outputSchemas ?? [], findings);
  validateRouting(input, nodes, findings);
  validateCycles(input, nodes, findings);
  return findings;
}

function defaultEdges(nodes: NodeProtocol[]): WorkflowProtocol["edges"] {
  return nodes.flatMap((node, index) => {
    const successEdges = node.decision
      ? node.decision.choices.map((choice) => ({
          from: node.id,
          to: decisionChoiceTarget(choice) ?? null,
          condition: "success" as const,
        }))
      : [
          {
            from: node.id,
            to: nodes[index + 1]?.id ?? null,
            condition: "success" as const,
          },
        ];
    return [
      ...successEdges,
      { from: node.id, to: node.id, condition: "failure" as const },
      { from: node.id, to: node.id, condition: "pause" as const },
    ];
  });
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
    input.routing?.routingFields !== undefined ||
    input.customNodes.some((node) => node.kind === "decision") ||
    input.cycles !== undefined ||
    input.capabilities?.durability !== undefined ||
    input.outputSchemas?.some((schema) =>
      schema.artifacts.some((artifact) => artifact.lifetime !== undefined),
    ),
  );
}

function versionedArtifactsEnabled(input: WorkflowInput): boolean {
  return Boolean(
    input.capabilities?.features.includes("versioned-artifacts") ||
    input.outputSchemas?.some((schema) =>
      schema.artifacts.some((artifact) => artifact.lifetime !== undefined),
    ),
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
  if (input.customNodes.some((node) => node.kind === "decision")) {
    features.add("decision-nodes");
  }
  if (input.cycles !== undefined) features.add("bounded-cycles");
  if (versionedArtifactsEnabled(input)) features.add("versioned-artifacts");
  return {
    version: 3,
    features: [...features],
    ...(input.capabilities?.durability
      ? { durability: structuredClone(input.capabilities.durability) }
      : {}),
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
    const node: NodeProtocol = {
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
    if (node.decision?.scope) {
      node.decision.scope = normalizeDecisionScope(
        node.decision.scope,
        input.outputSchemas ?? [],
      );
    }
    return node;
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
    ...(input.cycles ? { cycles: cloneCycles(input.cycles) } : {}),
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
