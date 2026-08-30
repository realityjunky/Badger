import type { ActionOutcome } from "../engine/types.js";
import type {
  WorkflowProtocol,
  WorkflowRoutingCondition,
  WorkflowRoutingField,
  WorkflowRoutingPredicate,
  WorkflowTransition,
} from "../types.js";
import { sha256, stableValue } from "../util.js";

export interface RoutingFieldDefinition {
  id: string;
  values: string[];
}

export class WorkflowRouteResolutionError extends Error {
  readonly blockers: string[];

  constructor(message: string) {
    super(message);
    this.name = "WorkflowRouteResolutionError";
    this.blockers = [message];
  }
}

function fieldId(field: WorkflowRoutingField): string | undefined {
  if (!field || typeof field !== "object") return undefined;
  return field.id ?? field.name;
}

function fieldValues(field: WorkflowRoutingField): string[] | undefined {
  if (!field || typeof field !== "object") return undefined;
  return field.values ?? field.allowedValues;
}

export function routingFields(
  protocol: WorkflowProtocol,
): RoutingFieldDefinition[] {
  const fields = protocol.routing?.fields ?? protocol.routing?.routingFields;
  if (!fields) return [];
  if (Array.isArray(fields)) {
    return fields.map((field) => ({
      id: fieldId(field) ?? "",
      values: [...(fieldValues(field) ?? [])],
    }));
  }
  return Object.entries(fields).map(([id, values]) => {
    if (!Array.isArray(values)) {
      throw new Error(`Workflow routing field values are invalid: ${id}`);
    }
    return { id, values: [...values] };
  });
}

function predicate(value: unknown): WorkflowRoutingPredicate {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as { field?: unknown }).field !== "string" ||
    typeof (value as { equals?: unknown }).equals !== "string"
  ) {
    throw new Error(
      "Workflow route conditions must contain a field and exact scalar equals value",
    );
  }
  return {
    field: (value as { field: string }).field,
    equals: (value as { equals: string }).equals,
  };
}

export function routingPredicates(
  condition: WorkflowRoutingCondition,
  fields: readonly RoutingFieldDefinition[],
): WorkflowRoutingPredicate[] {
  if (typeof condition === "string") {
    if (fields.length === 1) {
      return [{ field: fields[0].id, equals: condition }];
    }
    const separator = condition.indexOf("=");
    if (separator > 0 && separator < condition.length - 1) {
      return [
        {
          field: condition.slice(0, separator),
          equals: condition.slice(separator + 1),
        },
      ];
    }
    if (fields.length !== 1) {
      throw new Error(
        "Workflow route text conditions require exactly one declared routing field",
      );
    }
  }
  if (Array.isArray(condition)) {
    if (condition.length === 0) {
      throw new Error("Workflow route conjunction must not be empty");
    }
    return condition.map(predicate);
  }
  if (!condition || typeof condition !== "object") {
    throw new Error("Workflow route condition must be an object or string");
  }
  if ("all" in condition) {
    if (!Array.isArray(condition.all) || condition.all.length === 0) {
      throw new Error("Workflow route conjunction must not be empty");
    }
    return condition.all.map(predicate);
  }
  return [predicate(condition)];
}

function fieldMap(
  fields: readonly RoutingFieldDefinition[],
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const field of fields) {
    if (
      !field.id ||
      !Array.isArray(field.values) ||
      field.values.length === 0 ||
      field.values.some((value) => typeof value !== "string")
    ) {
      throw new Error("Workflow routing fields require an id and values");
    }
    if (result.has(field.id)) {
      throw new Error(`Workflow routing field is duplicated: ${field.id}`);
    }
    const values = new Set(field.values);
    if (
      values.size !== field.values.length ||
      [...values].some((value) => !value)
    ) {
      throw new Error(`Workflow routing field has invalid values: ${field.id}`);
    }
    result.set(field.id, values);
  }
  return result;
}

function validatePredicates(
  transition: WorkflowTransition,
  fields: Map<string, Set<string>>,
): WorkflowRoutingPredicate[] | undefined {
  if (transition.when === undefined) return undefined;
  const predicates = routingPredicates(
    transition.when,
    [...fields].map(([id, values]) => ({
      id,
      values: [...values],
    })),
  );
  const seen = new Map<string, string>();
  for (const item of predicates) {
    const values = fields.get(item.field);
    if (!values) {
      throw new Error(
        `Workflow route condition references unknown routing field: ${item.field}`,
      );
    }
    if (!values.has(item.equals)) {
      throw new Error(
        `Workflow route condition references unknown value for ${item.field}: ${item.equals}`,
      );
    }
    const previous = seen.get(item.field);
    if (previous !== undefined && previous !== item.equals) {
      throw new Error(
        `Workflow route conjunction has conflicting values for field: ${item.field}`,
      );
    }
    seen.set(item.field, item.equals);
  }
  return predicates;
}

function predicatesOverlap(
  left: readonly WorkflowRoutingPredicate[],
  right: readonly WorkflowRoutingPredicate[],
): boolean {
  const rightValues = new Map(right.map((item) => [item.field, item.equals]));
  return left.every(
    (item) =>
      !rightValues.has(item.field) ||
      rightValues.get(item.field) === item.equals,
  );
}

function activeNodes(protocol: WorkflowProtocol): Set<string> {
  return new Set(
    protocol.nodes.filter((node) => !node.disabled).map((node) => node.id),
  );
}

function transitionsFrom(
  protocol: WorkflowProtocol,
  nodeId: string,
): WorkflowTransition[] {
  return protocol.edges.filter(
    (transition) =>
      transition.from === nodeId && transition.condition === "success",
  );
}

export function isRevisionedWorkflowProtocol(
  protocol: WorkflowProtocol,
): boolean {
  return Boolean(
    protocol.capabilities?.version === 3 ||
    protocol.routing?.fields !== undefined ||
    protocol.routing?.routingFields !== undefined,
  );
}

export function validateRevisionedWorkflow(protocol: WorkflowProtocol): void {
  const active = activeNodes(protocol);
  if (active.size === 0) return;
  const nodeIds = new Set(protocol.nodes.map((node) => node.id));
  const fields = fieldMap(routingFields(protocol));
  const predicatesByTransition = new Map<
    WorkflowTransition,
    WorkflowRoutingPredicate[]
  >();

  for (const transition of protocol.edges) {
    if (!nodeIds.has(transition.from)) {
      throw new Error(
        `Workflow Protocol transition references unknown Node: ${transition.from}`,
      );
    }
    if (transition.to !== null && !nodeIds.has(transition.to)) {
      throw new Error(
        `Workflow Protocol transition references unknown Node: ${transition.to}`,
      );
    }
    if (transition.to !== null && !active.has(transition.to)) {
      throw new Error(
        `Workflow Protocol transition targets disabled Node: ${transition.to}`,
      );
    }
    if (
      (transition.condition === "failure" ||
        transition.condition === "pause") &&
      transition.to !== transition.from
    ) {
      throw new Error(
        `Workflow Protocol ${transition.condition} transition from Node ${transition.from} must self-loop`,
      );
    }
    if (transition.condition !== "success" || transition.when === undefined) {
      continue;
    }
    const predicates = validatePredicates(transition, fields);
    if (predicates) predicatesByTransition.set(transition, predicates);
  }

  for (const nodeId of active) {
    const transitions = transitionsFrom(protocol, nodeId);
    const defaults = transitions.filter(
      (transition) => transition.when === undefined,
    );
    if (defaults.length > 1) {
      throw new Error(
        `Workflow Protocol has multiple default transitions from Node ${nodeId}`,
      );
    }
    const conditional = transitions.filter(
      (transition) => transition.when !== undefined,
    );
    for (let leftIndex = 0; leftIndex < conditional.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < conditional.length;
        rightIndex += 1
      ) {
        const left = predicatesByTransition.get(conditional[leftIndex]);
        const right = predicatesByTransition.get(conditional[rightIndex]);
        if (left && right && predicatesOverlap(left, right)) {
          throw new Error(
            `Workflow Protocol has ambiguous conditional transitions from Node ${nodeId}`,
          );
        }
      }
    }
  }

  const entry = protocol.nodes.find((node) => !node.disabled)?.id;
  if (!entry) return;
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) {
      throw new Error(
        "Workflow Protocol success route contains an undeclared cycle",
      );
    }
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const transition of transitionsFrom(protocol, nodeId)) {
      if (transition.to !== null) visit(transition.to);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  visit(entry);
  for (const node of protocol.nodes) {
    if (!node.disabled && !node.optional && !visited.has(node.id)) {
      throw new Error(
        `Workflow Protocol required Node is unreachable: ${node.id}`,
      );
    }
  }
  for (const nodeId of visited) {
    if (transitionsFrom(protocol, nodeId).length === 0) {
      throw new Error(
        `Workflow Protocol Node ${nodeId} has no success transition`,
      );
    }
  }
}

function validateRoutingValues(
  protocol: WorkflowProtocol,
  routing: Record<string, string> | undefined,
): Map<string, string> {
  const fields = fieldMap(routingFields(protocol));
  const values = new Map<string, string>();
  for (const [field, value] of Object.entries(routing ?? {})) {
    const allowed = fields.get(field);
    if (!allowed) {
      throw new WorkflowRouteResolutionError(
        `Route blocker: unknown routing field: ${field}`,
      );
    }
    if (!allowed.has(value)) {
      throw new WorkflowRouteResolutionError(
        `Route blocker: invalid routing value for ${field}: ${value}`,
      );
    }
    values.set(field, value);
  }
  return values;
}

export function resolveWorkflowNext(
  protocol: WorkflowProtocol,
  nodeId: string,
  outcome: ActionOutcome,
): string | null {
  const transitions = transitionsFrom(protocol, nodeId);
  const defaults = transitions.filter(
    (transition) => transition.when === undefined,
  );
  const values = validateRoutingValues(protocol, outcome.routing);
  const fields = routingFields(protocol);
  const matches = transitions.filter((transition) => {
    if (transition.when === undefined) return false;
    const predicates = routingPredicates(transition.when, fields);
    return predicates.every((item) => values.get(item.field) === item.equals);
  });
  if (matches.length > 1) {
    throw new WorkflowRouteResolutionError(
      `Route blocker: ambiguous success transitions from Node ${nodeId}`,
    );
  }
  const selected = matches[0] ?? defaults[0];
  if (!selected) {
    throw new WorkflowRouteResolutionError(
      `Route blocker: no matching success transition from Node ${nodeId}`,
    );
  }
  return selected.to;
}

export function resolverHash(protocol: WorkflowProtocol): string {
  return sha256(
    JSON.stringify(
      stableValue({
        capabilities: protocol.capabilities,
        routing: protocol.routing,
        edges: protocol.edges,
      }),
    ),
  );
}
