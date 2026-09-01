import type {
  Binding,
  NodeProtocol,
  WorkflowProtocol,
  WorkflowTransition,
} from "../types.js";
import type {
  GuardrailDefinition,
  RuntimePackageMetadata,
  RuntimeCompletionPlan,
  SkillDefinition,
  SkillPackage,
  SkillReference,
  SkillStep,
} from "../skill-runtime/types.js";
import { hashSkillPackage } from "../skill-runtime/snapshot.js";
import { validateSkillPackage } from "../skill-runtime/validate.js";
import { sha256, slug, stableValue } from "../util.js";
import type { WorkflowExecutionIdentity } from "./types.js";
import { createCompletionPlan } from "./completion.js";
import {
  isRevisionedWorkflowProtocol,
  maxWorkflowIterations,
  resolverHash,
  validateRevisionedWorkflow,
} from "./routing.js";
import { validateDecisionDefinition } from "../workflow/contract.js";
import { validateWorkflowDecisionScopeDefinition } from "./decision-scope.js";
import { WORKFLOW_FINDING_CATALOG_VERSION } from "./findings.js";
import {
  durabilityProfileForProtocol,
  normalizeWorkflowDurabilityProtocol,
} from "./durability.js";

interface CompiledWorkflow {
  package: SkillPackage;
  identity: WorkflowExecutionIdentity;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return Object.freeze(value);
}

function hashProtocol(protocol: WorkflowProtocol): string {
  return sha256(JSON.stringify(stableValue(protocol)));
}

function activeNodes(protocol: WorkflowProtocol): NodeProtocol[] {
  return protocol.nodes.filter((node) => !node.disabled);
}

function stepId(index: number, nodeId: string): string {
  return `node-${index + 1}-${nodeId}`;
}

function nodeSkillName(workflow: string, nodeId: string): string {
  return `${slug(workflow) || "workflow"}-${slug(nodeId) || "node"}`;
}

function nodeBindingSkills(node: NodeProtocol): string[] {
  return [
    node.implementation.skill,
    ...node.requiredSkillCalls.map((binding) => binding.skill),
    ...node.augmentations.map((binding) => binding.skill),
  ];
}

function compiledSkillIds(
  protocol: WorkflowProtocol,
  nodes: readonly NodeProtocol[],
): string[] {
  return [
    ...new Set([
      ...nodes.map((node) => nodeSkillName(protocol.name, node.id)),
      ...nodes.flatMap(nodeBindingSkills),
    ]),
  ];
}

function bindingIsValid(binding: Binding, nodeId: string, label: string): void {
  if (!binding || typeof binding !== "object") {
    throw new Error(`${nodeId}: ${label} must be an object`);
  }
  if (typeof binding.skill !== "string" || binding.skill.length === 0) {
    throw new Error(`${nodeId}: ${label} requires a Skill`);
  }
}

function validateProtocolShape(protocol: WorkflowProtocol): void {
  if (!protocol || typeof protocol !== "object") {
    throw new Error("Workflow Protocol must be an object");
  }
  if (protocol.schemaVersion !== 1 || protocol.kind !== "workflow-kernel") {
    throw new Error("Unsupported Workflow Protocol");
  }
  if (typeof protocol.name !== "string" || protocol.name.length === 0) {
    throw new Error("Workflow Protocol name is required");
  }
  if (typeof protocol.goal !== "string" || protocol.goal.length === 0) {
    throw new Error("Workflow Protocol goal is required");
  }
  if (!Array.isArray(protocol.nodes)) {
    throw new Error("Workflow Protocol nodes must be an array");
  }
  if (!Array.isArray(protocol.edges)) {
    throw new Error("Workflow Protocol edges must be an array");
  }
  if (!Array.isArray(protocol.outputSchemas)) {
    throw new Error("Workflow Protocol Output Schemas must be an array");
  }
  if (protocol.capabilities !== undefined) {
    if (
      !protocol.capabilities ||
      protocol.capabilities.version !== 3 ||
      !Array.isArray(protocol.capabilities.features) ||
      protocol.capabilities.features.some(
        (feature) =>
          feature !== "conditional-routing" &&
          feature !== "revisioned-attempts" &&
          feature !== "decision-nodes" &&
          feature !== "bounded-cycles" &&
          feature !== "versioned-artifacts",
      ) ||
      !protocol.capabilities.features.includes("conditional-routing") ||
      !protocol.capabilities.features.includes("revisioned-attempts")
    ) {
      throw new Error("Workflow Protocol capabilities are invalid");
    }
    if (
      protocol.cycles !== undefined &&
      !protocol.capabilities.features.includes("bounded-cycles")
    ) {
      throw new Error(
        "Workflow Protocol cycle declarations require bounded-cycles capability",
      );
    }
    if (protocol.capabilities.durability !== undefined) {
      durabilityProfileForProtocol(protocol);
    }
  } else if (protocol.cycles !== undefined) {
    throw new Error(
      "Workflow Protocol cycle declarations require versioned capabilities",
    );
  }
  const schemaIds = new Set<string>();
  const logicalArtifactIds = new Set<string>();
  for (const schema of protocol.outputSchemas) {
    if (
      !schema ||
      typeof schema !== "object" ||
      typeof schema.id !== "string" ||
      schema.id.length === 0 ||
      typeof schema.description !== "string" ||
      schema.description.length === 0 ||
      !Array.isArray(schema.artifacts) ||
      !Array.isArray(schema.evidence)
    ) {
      throw new Error(
        "Workflow Protocol Output Schemas must have ids, descriptions, artifacts, and evidence",
      );
    }
    if (schemaIds.has(schema.id)) {
      throw new Error(
        `Workflow Protocol has duplicate Output Schema: ${schema.id}`,
      );
    }
    schemaIds.add(schema.id);
    const artifactIds = new Set<string>();
    for (const artifact of schema.artifacts) {
      if (
        !artifact ||
        typeof artifact !== "object" ||
        typeof artifact.id !== "string" ||
        artifact.id.length === 0 ||
        typeof artifact.required !== "boolean" ||
        !Array.isArray(artifact.paths) ||
        artifact.paths.some(
          (artifactPath) => typeof artifactPath !== "string",
        ) ||
        !Array.isArray(artifact.validations) ||
        (artifact.lifetime !== undefined &&
          artifact.lifetime !== "attempt" &&
          artifact.lifetime !== "cycle" &&
          artifact.lifetime !== "run")
      ) {
        throw new Error(
          `Workflow Protocol Output Schema ${schema.id} has an invalid artifact`,
        );
      }
      if (artifactIds.has(artifact.id)) {
        throw new Error(
          `Workflow Protocol Output Schema ${schema.id} has duplicate artifact: ${artifact.id}`,
        );
      }
      artifactIds.add(artifact.id);
      const logicalArtifactId = `${schema.id}.${artifact.id}`;
      if (logicalArtifactIds.has(logicalArtifactId)) {
        throw new Error(
          `Workflow Protocol has duplicate logical artifact: ${logicalArtifactId}`,
        );
      }
      logicalArtifactIds.add(logicalArtifactId);
      if (
        artifact.lifetime !== undefined &&
        !protocol.capabilities?.features.includes("versioned-artifacts")
      ) {
        throw new Error(
          `Workflow Protocol artifact ${schema.id}.${artifact.id} requires versioned-artifacts capability`,
        );
      }
    }
    for (const evidence of schema.evidence) {
      if (
        !evidence ||
        typeof evidence !== "object" ||
        typeof evidence.id !== "string" ||
        evidence.id.length === 0 ||
        typeof evidence.required !== "boolean"
      ) {
        throw new Error(
          `Workflow Protocol Output Schema ${schema.id} has invalid evidence`,
        );
      }
    }
  }
  const nodeIds = new Set<string>();
  const decisionIds = new Set<string>();
  for (const node of protocol.nodes) {
    if (!node || typeof node !== "object") {
      throw new Error("Workflow Protocol Nodes must be objects");
    }
    if (typeof node.id !== "string" || node.id.length === 0) {
      throw new Error("Workflow Protocol Node id is required");
    }
    if (nodeIds.has(node.id)) {
      throw new Error(`Workflow Protocol has duplicate Node: ${node.id}`);
    }
    nodeIds.add(node.id);
    if (typeof node.disabled !== "boolean") {
      throw new Error(
        `Workflow Protocol Node ${node.id} disabled flag is invalid`,
      );
    }
    bindingIsValid(node.implementation, node.id, "implementation");
    if (!Array.isArray(node.requiredSkillCalls)) {
      throw new Error(
        `Workflow Protocol Node ${node.id} required Skill calls must be an array`,
      );
    }
    if (!Array.isArray(node.augmentations)) {
      throw new Error(
        `Workflow Protocol Node ${node.id} augmentations must be an array`,
      );
    }
    if (!Array.isArray(node.outputSchemas)) {
      throw new Error(
        `Workflow Protocol Node ${node.id} Output Schemas must be an array`,
      );
    }
    if (!Array.isArray(node.guardrails)) {
      throw new Error(
        `Workflow Protocol Node ${node.id} guardrails must be an array`,
      );
    }
    for (const binding of node.requiredSkillCalls) {
      bindingIsValid(binding, node.id, "required Skill call");
    }
    for (const binding of node.augmentations) {
      bindingIsValid(binding, node.id, "augmentation");
    }
    for (const guardrail of node.guardrails) {
      if (
        !guardrail ||
        typeof guardrail !== "object" ||
        typeof guardrail.id !== "string" ||
        guardrail.id.length === 0 ||
        typeof guardrail.label !== "string" ||
        guardrail.label.length === 0
      ) {
        throw new Error(
          `Workflow Protocol Node ${node.id} guardrail must have an id and label`,
        );
      }
    }
    for (const schemaId of node.outputSchemas) {
      if (!schemaIds.has(schemaId)) {
        throw new Error(
          `Workflow Protocol Node ${node.id} references missing Output Schema: ${schemaId}`,
        );
      }
    }
    if (node.kind === "decision") {
      validateDecisionDefinition(node.decision, node.id);
      const decisionId = node.decision!.id;
      if (decisionIds.has(decisionId)) {
        throw new Error(
          `Workflow Protocol has duplicate decision id: ${decisionId}`,
        );
      }
      decisionIds.add(decisionId);
    } else if (node.decision !== undefined) {
      throw new Error(
        `Workflow Protocol Node ${node.id} has a decision definition but is not a decision Node`,
      );
    }
  }
  for (const transition of protocol.edges) {
    if (!transition || typeof transition !== "object") {
      throw new Error("Workflow Protocol transitions must be objects");
    }
    if (typeof transition.from !== "string" || transition.from.length === 0) {
      throw new Error("Workflow Protocol transition source is required");
    }
    if (transition.to !== null && typeof transition.to !== "string") {
      throw new Error("Workflow Protocol transition target is invalid");
    }
    if (
      transition.condition !== "success" &&
      transition.condition !== "failure" &&
      transition.condition !== "pause"
    ) {
      throw new Error(
        `Workflow Protocol transition condition is unsupported: ${String(transition.condition)}`,
      );
    }
  }
  if (protocol.cycles !== undefined && !Array.isArray(protocol.cycles)) {
    throw new Error("Workflow Protocol cycles must be an array");
  }
  for (const cycle of protocol.cycles ?? []) {
    if (!cycle || typeof cycle !== "object") {
      throw new Error("Workflow Protocol Cycle declarations must be objects");
    }
    const cycleKeys = new Set([
      "key",
      "entry",
      "repeatTransitions",
      "maxInstances",
    ]);
    const unknown = Object.keys(cycle).find((key) => !cycleKeys.has(key));
    if (unknown) {
      throw new Error(`Workflow Protocol Cycle has unknown field: ${unknown}`);
    }
    if (typeof cycle.key !== "string" || cycle.key.length === 0) {
      throw new Error("Workflow Protocol Cycle key is required");
    }
    if (typeof cycle.entry !== "string" || cycle.entry.length === 0) {
      throw new Error(
        `Workflow Protocol Cycle ${cycle.key} entry Node is required`,
      );
    }
    if (!Array.isArray(cycle.repeatTransitions)) {
      throw new Error(
        `Workflow Protocol Cycle ${cycle.key} repeatTransitions must be an array`,
      );
    }
    if (!Number.isSafeInteger(cycle.maxInstances) || cycle.maxInstances < 1) {
      throw new Error(
        `Workflow Protocol Cycle ${cycle.key} maxInstances must be a finite positive integer`,
      );
    }
    for (const repeat of cycle.repeatTransitions) {
      if (
        !repeat ||
        typeof repeat !== "object" ||
        typeof repeat.from !== "string" ||
        typeof repeat.to !== "string"
      ) {
        throw new Error(
          `Workflow Protocol Cycle ${cycle.key} repeat transitions must name from and to Nodes`,
        );
      }
      const repeatKeys = new Set(["from", "to"]);
      const unknownRepeat = Object.keys(repeat).find(
        (key) => !repeatKeys.has(key),
      );
      if (unknownRepeat) {
        throw new Error(
          `Workflow Protocol Cycle ${cycle.key} repeat transition has unknown field: ${unknownRepeat}`,
        );
      }
    }
  }
}

function transitionFor(
  transitions: readonly WorkflowTransition[],
  from: string,
  condition: WorkflowTransition["condition"],
): WorkflowTransition | undefined {
  const matches = transitions.filter(
    (transition) =>
      transition.from === from && transition.condition === condition,
  );
  if (matches.length > 1) {
    throw new Error(
      `Unsupported Workflow Protocol: ambiguous ${condition} transitions from Node ${from}`,
    );
  }
  return matches[0];
}

function validateLinearRoute(protocol: WorkflowProtocol): NodeProtocol[] {
  const active = activeNodes(protocol);
  const activeIds = new Set(active.map((node) => node.id));
  const evaluation = protocol.evals?.[0];
  if ((protocol.evals?.length ?? 0) > 1) {
    throw new Error(
      "Unsupported Workflow Protocol: multiple evaluation routes are not supported",
    );
  }
  if ((evaluation?.expectedRoutes?.length ?? 0) > 1) {
    throw new Error(
      "Unsupported Workflow Protocol: ambiguous Workflow routes are not supported",
    );
  }
  const expectedOrder =
    evaluation?.expectedNodeOrder ??
    evaluation?.expectedRoutes?.[0]?.nodeOrder ??
    active.map((node) => node.id);
  if (!Array.isArray(expectedOrder)) {
    throw new Error(
      "Unsupported Workflow Protocol: expected Node order must be an array",
    );
  }
  if (new Set(expectedOrder).size !== expectedOrder.length) {
    throw new Error(
      "Unsupported Workflow Protocol: repeated Workflow Node visits are not supported",
    );
  }
  if (
    evaluation?.expectedRoutes?.[0] &&
    JSON.stringify(evaluation.expectedRoutes[0].nodeOrder) !==
      JSON.stringify(expectedOrder)
  ) {
    throw new Error(
      "Unsupported Workflow Protocol: route order does not match expected Node order",
    );
  }
  if (expectedOrder.some((nodeId) => !activeIds.has(nodeId))) {
    throw new Error(
      "Unsupported Workflow Protocol: route contains an unknown or disabled Node",
    );
  }
  if (expectedOrder.length !== active.length) {
    throw new Error(
      "Unsupported Workflow Protocol: active Nodes must use one declared linear route",
    );
  }
  const ordered = expectedOrder.map((nodeId) =>
    active.find((node) => node.id === nodeId)!,
  );
  const nodeById = new Map(protocol.nodes.map((node) => [node.id, node]));

  for (const transition of protocol.edges) {
    if (!nodeById.has(transition.from)) {
      throw new Error(
        `Unsupported Workflow Protocol: transition references unknown Node ${transition.from}`,
      );
    }
    if (transition.to !== null && !nodeById.has(transition.to)) {
      throw new Error(
        `Unsupported Workflow Protocol: transition references unknown Node ${transition.to}`,
      );
    }
    if (transition.when !== undefined) {
      throw new Error(
        `Unsupported Workflow Protocol: conditional transition from Node ${transition.from}`,
      );
    }
    if (!activeIds.has(transition.from)) continue;
    if (
      transition.condition !== "success" &&
      transition.to !== transition.from
    ) {
      throw new Error(
        `Unsupported Workflow Protocol: ${transition.condition} transition from Node ${transition.from} must self-loop`,
      );
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visitSuccessRoute = (nodeId: string): void => {
    if (visiting.has(nodeId)) {
      throw new Error(
        "Unsupported Workflow Protocol: success route contains a cycle",
      );
    }
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    const success = transitionFor(protocol.edges, nodeId, "success");
    if (success?.to !== null && success?.to !== undefined) {
      visitSuccessRoute(success.to);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const node of active) visitSuccessRoute(node.id);

  function nextActiveNode(
    nodeId: string,
    seen = new Set<string>(),
  ): string | null {
    if (seen.has(nodeId)) {
      throw new Error(
        "Unsupported Workflow Protocol: success route contains a cycle",
      );
    }
    seen.add(nodeId);
    const success = transitionFor(protocol.edges, nodeId, "success");
    if (!success) {
      throw new Error(
        `Unsupported Workflow Protocol: Node ${nodeId} has no success transition`,
      );
    }
    if (success.to === null) return null;
    const target = nodeById.get(success.to);
    if (!target) {
      throw new Error(
        `Unsupported Workflow Protocol: transition references unknown Node ${success.to}`,
      );
    }
    return target.disabled ? nextActiveNode(target.id, seen) : target.id;
  }

  for (const [index, node] of ordered.entries()) {
    const expectedNext = ordered[index + 1]?.id ?? null;
    if (nextActiveNode(node.id) !== expectedNext) {
      throw new Error(
        `Unsupported Workflow Protocol: success route from Node ${node.id} is not linear`,
      );
    }
  }
  return ordered;
}

function compileDefinition(
  protocol: WorkflowProtocol,
  nodes: readonly NodeProtocol[],
  linear: boolean,
): SkillDefinition {
  const steps: SkillStep[] = nodes.map((node, index) => ({
    id: stepId(index, node.id),
    action: {
      ...(node.decision
        ? {
            type: "ask_user" as const,
            decisionId: node.decision.id,
            question: node.decision.question,
            choices: node.decision.choices.map((choice) => ({
              id: choice.id,
              label: choice.label,
              ...(choice.inputs
                ? { requiredInputs: structuredClone(choice.inputs) }
                : {}),
            })),
            requiredInputs: structuredClone(
              node.decision.inputs ?? { type: "object" as const, fields: [] },
            ),
            rationale: {
              required: node.decision.rationale?.required ?? false,
            },
            reviewer: {
              subjects: [...(node.decision.reviewer?.subjects ?? [])],
              authorities: [...(node.decision.reviewer?.authorities ?? [])],
            },
          }
        : {
            type: "invoke_skill" as const,
            ref: nodeSkillName(protocol.name, node.id),
          }),
    },
    ...(linear && nodes[index + 1]
      ? { next: stepId(index + 1, nodes[index + 1].id) }
      : {}),
  }));
  if (steps.length === 0) {
    steps.push({
      id: "terminal-checkpoint",
      action: { type: "checkpoint" },
    });
  }
  const skills: SkillReference[] = compiledSkillIds(protocol, nodes).map(
    (id) => ({ id }),
  );
  return {
    apiVersion: "comet/v1alpha1",
    kind: "Skill",
    metadata: {
      name: protocol.name,
      version: "1.0.0",
      description: protocol.goal,
    },
    goal: {
      statement: protocol.goal,
      inputs: [],
      outputs: [],
      success: [],
    },
    orchestration: {
      mode: "deterministic",
      entry: steps[0].id,
      steps,
    },
    skills,
    agents: [],
    tools: [],
  };
}

function compileGuardrails(
  protocol: WorkflowProtocol,
  nodes: readonly NodeProtocol[],
): GuardrailDefinition {
  return {
    allowedSkills: compiledSkillIds(protocol, nodes),
    allowedAgents: [],
    allowedTools: [],
    maxIterations: maxWorkflowIterations(protocol),
    maxRetriesPerAction: 3,
    confirmationRequiredFor: [],
  };
}

function compileCompletionPlans(
  nodes: readonly NodeProtocol[],
): Record<string, RuntimeCompletionPlan> {
  return Object.fromEntries(
    nodes.map((node) => [node.id, createCompletionPlan(node)]),
  );
}

export async function compileWorkflow(
  protocol: WorkflowProtocol,
): Promise<CompiledWorkflow> {
  const executableProtocol = normalizeWorkflowDurabilityProtocol(protocol);
  validateProtocolShape(executableProtocol);
  validateWorkflowDecisionScopeDefinition(executableProtocol);
  const revisioned = isRevisionedWorkflowProtocol(executableProtocol);
  if (
    executableProtocol.capabilities?.durability?.capabilities.includes(
      "verified-checkpoints",
    ) &&
    !revisioned
  ) {
    throw new Error(
      "Workflow Protocol verified checkpoints require revisioned capabilities",
    );
  }
  if (revisioned && executableProtocol.capabilities?.version !== 3) {
    throw new Error(
      "Workflow Protocol revisioned capabilities are required for branch routing",
    );
  }
  if (revisioned) validateRevisionedWorkflow(executableProtocol);
  const nodes = revisioned
    ? activeNodes(executableProtocol)
    : validateLinearRoute(executableProtocol);
  const definition = compileDefinition(executableProtocol, nodes, !revisioned);
  const nodeToStep = Object.fromEntries(
    nodes.map((node, index) => [node.id, stepId(index, node.id)]),
  );
  const protocolHash = hashProtocol(executableProtocol);
  const runtime: RuntimePackageMetadata = {
    protocolHash,
    protocol: structuredClone(executableProtocol),
    nodeToStep: { ...nodeToStep },
    ...(revisioned
      ? {
          capabilityVersion: 3 as const,
          resolverHash: resolverHash(executableProtocol),
        }
      : {}),
    findingCatalogVersion: WORKFLOW_FINDING_CATALOG_VERSION,
    ...(executableProtocol.capabilities?.durability
      ? {
          durabilityProfile: durabilityProfileForProtocol(executableProtocol),
        }
      : {}),
    completionPlans: compileCompletionPlans(nodes),
  };
  const pkg: SkillPackage = {
    root: process.cwd(),
    packageKind: "runtime",
    runtime,
    definition,
    guardrails: compileGuardrails(executableProtocol, nodes),
    evals: [],
  };
  const packageErrors = validateSkillPackage(pkg);
  if (packageErrors.length > 0) {
    throw new Error(
      `Compiled WorkflowRuntime package is invalid:\n${packageErrors.map((error) => `  - ${error}`).join("\n")}`,
    );
  }
  const packageHash = await hashSkillPackage(pkg);
  return {
    package: deepFreeze(pkg),
    identity: {
      protocolHash,
      packageHash,
      snapshotHash: "",
      nodeToStep,
      ...(revisioned
        ? {
            capabilityVersion: 3 as const,
            resolverHash: resolverHash(executableProtocol),
          }
        : {}),
      findingCatalogVersion: WORKFLOW_FINDING_CATALOG_VERSION,
      ...(executableProtocol.capabilities?.durability
        ? {
            durabilityProfile: durabilityProfileForProtocol(executableProtocol),
          }
        : {}),
    },
  };
}
