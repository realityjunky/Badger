import type {
  ActionOutcome,
  WorkflowCycleState,
  WorkflowCycleTransitionState,
  WorkflowRuntimeState,
} from "../engine/types.js";
import type {
  WorkflowCycleDefinition,
  WorkflowProtocol,
  WorkflowDecisionChoice,
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

export class WorkflowCycleBudgetError extends WorkflowRouteResolutionError {
  constructor(key: string, maxInstances: number) {
    super(
      `Cycle budget exhausted for ${key}: maximum ${maxInstances} instances reached`,
    );
    this.name = "WorkflowCycleBudgetError";
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

function decisionChoiceTarget(
  choice: WorkflowDecisionChoice,
): string | null | undefined {
  return choice.to !== undefined
    ? choice.to
    : choice.target !== undefined
      ? choice.target
      : choice.transition;
}

function decisionNode(
  protocol: WorkflowProtocol,
  nodeId: string,
): WorkflowProtocol["nodes"][number] | undefined {
  return protocol.nodes.find(
    (node) => node.id === nodeId && node.kind === "decision",
  );
}

export function routingFields(
  protocol: WorkflowProtocol,
): RoutingFieldDefinition[] {
  const fields = protocol.routing?.fields ?? protocol.routing?.routingFields;
  const declared = !fields
    ? []
    : Array.isArray(fields)
      ? fields.map((field) => ({
          id: fieldId(field) ?? "",
          values: [...(fieldValues(field) ?? [])],
        }))
      : Object.entries(fields).map(([id, values]) => {
          if (!Array.isArray(values)) {
            throw new Error(`Workflow routing field values are invalid: ${id}`);
          }
          return { id, values: [...values] };
        });
  const decisions = protocol.nodes
    .filter(
      (node) => !node.disabled && node.kind === "decision" && node.decision,
    )
    .map((node) => ({
      id: node.decision!.id,
      values: node.decision!.choices.map((choice) => choice.id),
    }));
  return [...declared, ...decisions];
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
  const declared = protocol.edges.filter(
    (transition) =>
      transition.from === nodeId && transition.condition === "success",
  );
  const node = decisionNode(protocol, nodeId);
  if (!node?.decision) return declared;
  const choices = node.decision.choices;
  if (declared.length > 0 && declared.length !== choices.length) {
    throw new Error(
      `Workflow Protocol decision Node ${nodeId} must have one transition per choice`,
    );
  }
  return choices.map((choice) => {
    const target = decisionChoiceTarget(choice);
    if (target === undefined || target === "") {
      throw new Error(
        `Workflow Protocol decision choice ${choice.id} has no transition target`,
      );
    }
    const matches = declared.filter((transition) => transition.to === target);
    if (declared.length > 0 && matches.length !== 1) {
      throw new Error(
        `Workflow Protocol decision choice ${choice.id} does not map to exactly one transition`,
      );
    }
    if (matches[0]?.when !== undefined) {
      throw new Error(
        `Workflow Protocol decision Node ${nodeId} must not use hidden conditional exits`,
      );
    }
    return {
      ...(matches[0] ?? {
        from: nodeId,
        to: target,
        condition: "success" as const,
      }),
      when: { field: node.decision!.id, equals: choice.id },
    };
  });
}

interface WorkflowCyclePlan {
  definition: WorkflowCycleDefinition;
  nodes: ReadonlySet<string>;
  repeatTransitions: ReadonlySet<string>;
}

interface WorkflowCycleAnalysis {
  plans: WorkflowCyclePlan[];
  ownerByNode: Map<string, WorkflowCyclePlan>;
  planByKey: Map<string, WorkflowCyclePlan>;
}

function transitionKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

function activeSuccessGraph(
  protocol: WorkflowProtocol,
): Map<string, WorkflowTransition[]> {
  const active = activeNodes(protocol);
  const activeIds = new Set(active);
  return new Map(
    [...active].map((nodeId) => [
      nodeId,
      transitionsFrom(protocol, nodeId).filter(
        (transition) => transition.to !== null && activeIds.has(transition.to),
      ),
    ]),
  );
}

function stronglyConnectedComponents(
  graph: ReadonlyMap<string, readonly WorkflowTransition[]>,
): string[][] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const connect = (nodeId: string): void => {
    indices.set(nodeId, nextIndex);
    lowLinks.set(nodeId, nextIndex);
    nextIndex += 1;
    stack.push(nodeId);
    onStack.add(nodeId);

    for (const transition of graph.get(nodeId) ?? []) {
      const target = transition.to!;
      if (!indices.has(target)) {
        connect(target);
        lowLinks.set(
          nodeId,
          Math.min(lowLinks.get(nodeId)!, lowLinks.get(target)!),
        );
      } else if (onStack.has(target)) {
        lowLinks.set(
          nodeId,
          Math.min(lowLinks.get(nodeId)!, indices.get(target)!),
        );
      }
    }

    if (lowLinks.get(nodeId) !== indices.get(nodeId)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== nodeId);
    components.push(component);
  };

  for (const nodeId of graph.keys()) {
    if (!indices.has(nodeId)) connect(nodeId);
  }
  return components;
}

function cyclicComponents(
  graph: ReadonlyMap<string, readonly WorkflowTransition[]>,
): Map<string, string[]> {
  const components = stronglyConnectedComponents(graph);
  const componentByNode = new Map<string, string[]>();
  for (const component of components) {
    const members = new Set(component);
    const cyclic =
      component.length > 1 ||
      (graph.get(component[0]) ?? []).some(
        (transition) => transition.to === component[0],
      );
    if (!cyclic) continue;
    for (const nodeId of members) componentByNode.set(nodeId, component);
  }
  return componentByNode;
}

function componentKey(component: readonly string[]): string {
  return [...component].sort().join("\u0000");
}

function hasCycleWithoutRepeats(
  graph: ReadonlyMap<string, readonly WorkflowTransition[]>,
  component: ReadonlySet<string>,
  repeatTransitions: ReadonlySet<string>,
): boolean {
  const reduced = new Map<string, WorkflowTransition[]>(
    [...component].map((nodeId) => [
      nodeId,
      (graph.get(nodeId) ?? []).filter(
        (transition) =>
          !repeatTransitions.has(transitionKey(nodeId, transition.to!)),
      ),
    ]),
  );
  return cyclicComponents(reduced).size > 0;
}

function cycleDefinitionError(
  definition: WorkflowCycleDefinition,
  message: string,
): Error {
  return new Error(`Workflow Protocol Cycle ${definition.key}: ${message}`);
}

function cycleAnalysis(protocol: WorkflowProtocol): WorkflowCycleAnalysis {
  const graph = activeSuccessGraph(protocol);
  const activeIds = new Set(graph.keys());
  const cyclicByNode = cyclicComponents(graph);
  const componentDefinitions = new Map<string, WorkflowCycleDefinition[]>();
  const plans: WorkflowCyclePlan[] = [];
  const planByKey = new Map<string, WorkflowCyclePlan>();

  for (const definition of protocol.cycles ?? []) {
    if (planByKey.has(definition.key)) {
      throw cycleDefinitionError(definition, "cycle key must be unique");
    }
    if (typeof definition.key !== "string" || definition.key.length === 0) {
      throw new Error("Workflow Protocol Cycle key must be a non-empty string");
    }
    if (!activeIds.has(definition.entry)) {
      throw cycleDefinitionError(
        definition,
        `entry Node is unknown or disabled: ${definition.entry}`,
      );
    }
    if (
      !Number.isSafeInteger(definition.maxInstances) ||
      definition.maxInstances < 1
    ) {
      throw cycleDefinitionError(
        definition,
        "maxInstances must be a finite positive integer",
      );
    }
    if (
      !Array.isArray(definition.repeatTransitions) ||
      definition.repeatTransitions.length === 0
    ) {
      throw cycleDefinitionError(
        definition,
        "repeatTransitions must be a non-empty array",
      );
    }
    const component = cyclicByNode.get(definition.entry);
    if (!component) {
      throw cycleDefinitionError(
        definition,
        "entry Node does not belong to a graph cycle",
      );
    }
    const componentId = componentKey(component);
    const declarations = componentDefinitions.get(componentId) ?? [];
    declarations.push(definition);
    componentDefinitions.set(componentId, declarations);

    const members = new Set(component);
    const repeats = new Set<string>();
    for (const repeat of definition.repeatTransitions) {
      if (
        !activeIds.has(repeat.from) ||
        !activeIds.has(repeat.to) ||
        !members.has(repeat.from) ||
        !members.has(repeat.to)
      ) {
        throw cycleDefinitionError(
          definition,
          `repeat transition is outside its cycle: ${repeat.from} -> ${repeat.to}`,
        );
      }
      const matches = (graph.get(repeat.from) ?? []).filter(
        (transition) => transition.to === repeat.to,
      );
      if (matches.length === 0) {
        throw cycleDefinitionError(
          definition,
          `repeat transition is not a declared success edge: ${repeat.from} -> ${repeat.to}`,
        );
      }
      if (matches.length > 1) {
        throw cycleDefinitionError(
          definition,
          `repeat transition is ambiguous: ${repeat.from} -> ${repeat.to}`,
        );
      }
      const key = transitionKey(repeat.from, repeat.to);
      if (repeats.has(key)) {
        throw cycleDefinitionError(
          definition,
          `repeat transition is duplicated: ${repeat.from} -> ${repeat.to}`,
        );
      }
      repeats.add(key);
    }
    if (hasCycleWithoutRepeats(graph, members, repeats)) {
      throw cycleDefinitionError(
        definition,
        "contains an unbounded path without a declared repeat transition",
      );
    }
    const plan: WorkflowCyclePlan = {
      definition,
      nodes: members,
      repeatTransitions: repeats,
    };
    plans.push(plan);
    planByKey.set(definition.key, plan);
  }

  for (const [nodeId, component] of cyclicByNode) {
    const definitions = componentDefinitions.get(componentKey(component)) ?? [];
    if (definitions.length === 0) {
      throw new Error(
        "Workflow Protocol success route contains an undeclared cycle",
      );
    }
    if (definitions.length > 1) {
      throw new Error(
        `Workflow Protocol has overlapping ambiguous Cycle ownership: ${componentKey(component)}`,
      );
    }
    const entry = definitions[0].entry;
    for (const incoming of graph) {
      if (component.includes(incoming[0])) continue;
      for (const transition of incoming[1]) {
        if (transition.to === nodeId && nodeId !== entry) {
          throw cycleDefinitionError(
            definitions[0],
            `cycle component must be entered through ${entry}`,
          );
        }
      }
    }
  }

  const workflowEntry = [...graph.keys()][0];
  for (const plan of plans) {
    if (
      workflowEntry &&
      plan.nodes.has(workflowEntry) &&
      plan.definition.entry !== workflowEntry
    ) {
      throw cycleDefinitionError(
        plan.definition,
        `workflow entry must be ${plan.definition.entry}`,
      );
    }
  }

  const ownerByNode = new Map<string, WorkflowCyclePlan>();
  for (const plan of plans) {
    for (const nodeId of plan.nodes) {
      if (ownerByNode.has(nodeId)) {
        throw new Error(
          `Workflow Protocol has overlapping ambiguous Cycle ownership: ${nodeId}`,
        );
      }
      ownerByNode.set(nodeId, plan);
    }
  }
  return { plans, ownerByNode, planByKey };
}

export function validateWorkflowCycles(protocol: WorkflowProtocol): void {
  cycleAnalysis(protocol);
}

export function validateWorkflowCycleState(
  protocol: WorkflowProtocol,
  runId: string,
  runtime: Readonly<WorkflowRuntimeState>,
): void {
  const analysis = cycleAnalysis(protocol);
  const seenIds = new Set<string>();
  const counts = new Map<string, number>();
  for (const cycle of runtime.cycles) {
    const plan = analysis.planByKey.get(cycle.key);
    if (!plan) {
      throw new Error(
        `WorkflowRuntime persisted Cycle is not declared: ${cycle.key}`,
      );
    }
    if (seenIds.has(cycle.id)) {
      throw new Error(
        `WorkflowRuntime persisted Cycle identity is duplicated: ${cycle.id}`,
      );
    }
    seenIds.add(cycle.id);
    const expectedOrdinal = (counts.get(cycle.key) ?? 0) + 1;
    if (cycle.instanceOrdinal !== expectedOrdinal) {
      throw new Error(
        `WorkflowRuntime persisted Cycle ordinal is invalid for ${cycle.key}`,
      );
    }
    if (cycle.instanceOrdinal > plan.definition.maxInstances) {
      throw new Error(
        `WorkflowRuntime persisted Cycle exceeds its budget: ${cycle.key}`,
      );
    }
    if (cycle.id !== cycleIdentity(runId, cycle.key, cycle.instanceOrdinal)) {
      throw new Error(
        `WorkflowRuntime persisted Cycle identity is invalid: ${cycle.key}`,
      );
    }
    counts.set(cycle.key, cycle.instanceOrdinal);
  }
  if (runtime.currentCycle && !seenIds.has(runtime.currentCycle.id)) {
    throw new Error(
      "WorkflowRuntime current Cycle is not present in the Cycle ledger",
    );
  }
  if (
    runtime.currentCycle &&
    (runtime.currentCycle.id !==
      cycleIdentity(
        runId,
        runtime.currentCycle.key,
        runtime.currentCycle.instanceOrdinal,
      ) ||
      !analysis.planByKey.has(runtime.currentCycle.key))
  ) {
    throw new Error("WorkflowRuntime current Cycle identity is invalid");
  }
}

export function workflowCycleOwnsNode(
  protocol: WorkflowProtocol,
  key: string,
  nodeId: string,
): boolean {
  return cycleAnalysis(protocol).planByKey.get(key)?.nodes.has(nodeId) ?? false;
}

function cycleIdentity(
  runId: string,
  key: string,
  instanceOrdinal: number,
): string {
  return `cycle-${sha256(`${runId}:${key}:${instanceOrdinal}`).slice(0, 24)}`;
}

function allocateCycle(
  runId: string,
  plan: WorkflowCyclePlan,
  cycles: readonly WorkflowCycleState[],
): WorkflowCycleState {
  const instanceOrdinal =
    cycles.filter((cycle) => cycle.key === plan.definition.key).length + 1;
  if (instanceOrdinal > plan.definition.maxInstances) {
    throw new WorkflowCycleBudgetError(
      plan.definition.key,
      plan.definition.maxInstances,
    );
  }
  return {
    id: cycleIdentity(runId, plan.definition.key, instanceOrdinal),
    key: plan.definition.key,
    instanceOrdinal,
  };
}

function copyCycleTransitionState(
  runtime: Readonly<WorkflowRuntimeState>,
): WorkflowCycleTransitionState {
  return {
    currentCycle: runtime.currentCycle
      ? structuredClone(runtime.currentCycle)
      : null,
    cycles: structuredClone(runtime.cycles ?? []),
  };
}

export function prepareWorkflowCycleEntry(
  protocol: WorkflowProtocol,
  runId: string,
  runtime: Readonly<WorkflowRuntimeState>,
  nodeId: string,
): WorkflowCycleTransitionState {
  const analysis = cycleAnalysis(protocol);
  const next = copyCycleTransitionState(runtime);
  const owner = analysis.ownerByNode.get(nodeId);
  if (next.currentCycle) {
    const activePlan = analysis.planByKey.get(next.currentCycle.key);
    if (!activePlan) {
      throw new Error(
        `WorkflowRuntime current Cycle is not declared: ${next.currentCycle.key}`,
      );
    }
    if (activePlan.nodes.has(nodeId)) return next;
    if (!owner) {
      next.currentCycle = null;
      return next;
    }
    if (nodeId !== owner.definition.entry) {
      throw cycleDefinitionError(
        owner.definition,
        `Node ${nodeId} cannot be entered except through ${owner.definition.entry}`,
      );
    }
    const allocated = allocateCycle(runId, owner, next.cycles);
    next.cycles.push(allocated);
    next.currentCycle = allocated;
    return next;
  }
  if (!owner) return next;
  if (nodeId !== owner.definition.entry) {
    throw cycleDefinitionError(
      owner.definition,
      `Node ${nodeId} cannot be entered without its entry Node`,
    );
  }
  const allocated = allocateCycle(runId, owner, next.cycles);
  next.cycles.push(allocated);
  next.currentCycle = allocated;
  return next;
}

export function resolveWorkflowCycleTransition(
  protocol: WorkflowProtocol,
  runId: string,
  runtime: Readonly<WorkflowRuntimeState>,
  transition: WorkflowTransition,
  nextNode: string | null,
): WorkflowCycleTransitionState {
  const analysis = cycleAnalysis(protocol);
  const next = copyCycleTransitionState(runtime);
  if (nextNode === null) {
    next.currentCycle = null;
    return next;
  }

  const owner = analysis.ownerByNode.get(nextNode);
  if (next.currentCycle) {
    const activePlan = analysis.planByKey.get(next.currentCycle.key);
    if (!activePlan) {
      throw new Error(
        `WorkflowRuntime current Cycle is not declared: ${next.currentCycle.key}`,
      );
    }
    if (
      activePlan.repeatTransitions.has(transitionKey(transition.from, nextNode))
    ) {
      const allocated = allocateCycle(runId, activePlan, next.cycles);
      next.cycles.push(allocated);
      next.currentCycle = allocated;
      return next;
    }
    if (activePlan.nodes.has(nextNode)) return next;
    if (!owner) {
      next.currentCycle = null;
      return next;
    }
    if (nextNode !== owner.definition.entry) {
      throw cycleDefinitionError(
        owner.definition,
        `Node ${nextNode} cannot be entered except through ${owner.definition.entry}`,
      );
    }
    const allocated = allocateCycle(runId, owner, next.cycles);
    next.cycles.push(allocated);
    next.currentCycle = allocated;
    return next;
  }

  if (!owner) return next;
  if (nextNode !== owner.definition.entry) {
    throw cycleDefinitionError(
      owner.definition,
      `Node ${nextNode} cannot be entered without its entry Node`,
    );
  }
  const allocated = allocateCycle(runId, owner, next.cycles);
  next.cycles.push(allocated);
  next.currentCycle = allocated;
  return next;
}

export function maxWorkflowIterations(protocol: WorkflowProtocol): number {
  if (!protocol.cycles?.length) return Math.max(protocol.nodes.length, 1);
  const analysis = cycleAnalysis(protocol);
  const cycleBudget = analysis.plans.reduce(
    (total, plan) => total + plan.definition.maxInstances,
    0,
  );
  const bound = Math.max(protocol.nodes.length, 1) * (cycleBudget + 1);
  return Number.isSafeInteger(bound) ? bound : Number.MAX_SAFE_INTEGER;
}

export function isRevisionedWorkflowProtocol(
  protocol: WorkflowProtocol,
): boolean {
  return Boolean(
    protocol.capabilities?.version === 3 ||
    protocol.routing?.fields !== undefined ||
    protocol.routing?.routingFields !== undefined ||
    protocol.nodes.some((node) => node.kind === "decision") ||
    protocol.cycles !== undefined,
  );
}

export function validateRevisionedWorkflow(protocol: WorkflowProtocol): void {
  const active = activeNodes(protocol);
  cycleAnalysis(protocol);
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

  for (const node of protocol.nodes.filter(
    (candidate) => candidate.kind === "decision",
  )) {
    if (!node.decision) {
      throw new Error(
        `Workflow Protocol decision Node ${node.id} is missing a definition`,
      );
    }
    for (const choice of node.decision.choices) {
      const target = decisionChoiceTarget(choice);
      if (target === undefined || (target !== null && !nodeIds.has(target))) {
        throw new Error(
          `Workflow Protocol decision choice ${choice.id} references unknown Node: ${target ?? "(missing)"}`,
        );
      }
      if (target !== null && !active.has(target)) {
        throw new Error(
          `Workflow Protocol decision choice ${choice.id} targets disabled Node: ${target}`,
        );
      }
    }
  }

  for (const nodeId of active) {
    const transitions = transitionsFrom(protocol, nodeId);
    if (decisionNode(protocol, nodeId)?.decision) continue;
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
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    for (const transition of transitionsFrom(protocol, nodeId)) {
      if (transition.to !== null) visit(transition.to);
    }
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
  return resolveWorkflowTransition(protocol, nodeId, outcome).next;
}

export function resolveWorkflowTransition(
  protocol: WorkflowProtocol,
  nodeId: string,
  outcome: ActionOutcome,
  runtime?: Readonly<WorkflowRuntimeState>,
  runId?: string,
): {
  next: string | null;
  transition: WorkflowTransition;
  workflowRuntime?: WorkflowCycleTransitionState;
} {
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
  return {
    next: selected.to,
    transition: selected,
    ...(runtime && runId
      ? {
          workflowRuntime: resolveWorkflowCycleTransition(
            protocol,
            runId,
            runtime,
            selected,
            selected.to,
          ),
        }
      : {}),
  };
}

export function resolverHash(protocol: WorkflowProtocol): string {
  return sha256(
    JSON.stringify(
      stableValue({
        capabilities: protocol.capabilities,
        routing: protocol.routing,
        edges: protocol.edges,
        cycles: protocol.cycles,
        decisions: protocol.nodes
          .filter((node) => node.kind === "decision")
          .map((node) => ({ id: node.id, decision: node.decision })),
      }),
    ),
  );
}
