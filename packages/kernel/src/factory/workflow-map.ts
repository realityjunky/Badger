import type {
  FactoryPlan,
  NodeTemplate,
  OutputSchema,
  WorkflowInput,
  WorkflowTransition,
} from "../types.js";
import type {
  DossierPin,
  WorkingDossierContent,
  DossierRoute,
  WorkingDossierEdit,
} from "./working-dossier.js";
import { canonicalHash } from "../util.js";
import { normalizeWorkflow } from "../workflow/contract.js";

export type MappedNode = Pick<
  NodeTemplate,
  | "kind"
  | "outputSchemas"
  | "guardrails"
  | "decision"
  | "approvalRequirements"
  | "augmentations"
  | "satisfies"
  | "optional"
  | "disabled"
> & {
  operations?: NodeTemplate["operations"];
  binding?: Omit<NodeTemplate["implementation"], "skill">;
  callBindings?: Record<
    string,
    Omit<NonNullable<NodeTemplate["requiredSkillCalls"]>[number], "skill">
  >;
};
export interface WorkflowMapContract {
  nodes: Record<string, MappedNode>;
  outputSchemas: OutputSchema[];
  fields?: NonNullable<WorkflowInput["routing"]>["fields"];
  routes?: NonNullable<WorkflowInput["routing"]>["routes"];
  terminalTransitions?: (Omit<WorkflowTransition, "to"> & { order?: number })[];
  patches?: WorkflowInput["nodes"];
  cycles?: WorkflowInput["cycles"];
  capabilities?: WorkflowInput["capabilities"];
  finalization?: WorkflowInput["finalization"];
}
export interface MapHook {
  id: string;
  event: string;
  handler: string;
  field: string;
}

export type MapSymbol =
  "artifact" | "hook" | "pause" | "approval" | "guardrail";
export interface MapAnnotation {
  kind: MapSymbol;
  title: string;
  details: string[];
  fields: string[];
}
export function workflowMapAnnotations(
  content: WorkingDossierContent,
  historical?: WorkflowInput,
) {
  const nodes: Record<string, MappedNode> =
    content.contract?.nodes ??
    Object.fromEntries(
      (historical?.customNodes ?? []).map((node) => [node.id, node]),
    );
  const result: Record<string, MapAnnotation[]> = {};
  for (const [id, handoff] of Object.entries(content.interfaces)) {
    const field = "interface/" + id + "/artifact";
    result["interface/" + id] = [
      {
        kind: "artifact",
        title:
          content.fields[field]?.value ??
          [
            content.nodes[handoff.producer]?.label,
            content.nodes[handoff.consumer]?.label,
          ].join(" → "),
        details: [content.fields["interface/" + id + "/shape"]?.value].filter(
          (value): value is string => !!value,
        ),
        fields: [field],
      },
    ];
  }
  for (const [id, route] of Object.entries(content.routes ?? {})) {
    const incoming = nodes[route.to],
      outgoing = nodes[route.from],
      items: MapAnnotation[] = [];
    const decision = incoming?.decision;
    if (decision || route.outcome === "pause")
      items.push({
        kind: "pause",
        title: decision?.question ?? route.condition ?? route.to,
        details: decision?.choices.map((choice) => choice.label) ?? [],
        fields: ["node/" + route.to + "/nextDecision"],
      });
    for (const approval of incoming?.approvalRequirements ?? []) {
      const required = Object.values(nodes).find(
        (node) => node.decision?.id === approval.decisionId,
      )?.decision;
      items.push({
        kind: "approval",
        title:
          required?.choices.find((choice) => choice.id === approval.choiceId)
            ?.label ?? approval.choiceId,
        details: [
          approval.decisionId,
          ...(required?.reviewer?.authorities ?? []),
          ...approval.artifacts,
        ],
        fields: [
          "node/" + route.to + "/guardrails",
          ...(outgoing?.decision?.id === approval.decisionId
            ? ["node/" + route.from + "/nextDecision"]
            : []),
        ],
      });
    }
    for (const guard of incoming?.guardrails ?? [])
      items.push({
        kind: "guardrail",
        title: guard.label,
        details: [guard.id, guard.validation],
        fields: ["node/" + route.to + "/guardrails"],
      });
    for (const hook of route.hooks ?? [])
      items.push({
        kind: "hook",
        title: hook.event,
        details: [hook.handler],
        fields: [hook.field],
      });
    result["route/" + id] = items;
  }
  return result;
}

export function compileWorkflowMap(
  content: WorkingDossierContent,
  pins: DossierPin[],
  name: string,
  goal: string,
): FactoryPlan["workflow"] {
  const contract = content.contract;
  if (!contract)
    throw new Error("Supply the executable workflow mapping contract");
  const skillName = (id: string) => {
    const pin = pins.find((entry) => entry.skillId === id);
    if (!pin) throw new Error(`The map refers to an unpinned Skill: ${id}`);
    return pin.name;
  };
  const occurrences = Object.entries(content.nodes).sort(
    ([leftId, left], [rightId, right]) =>
      left.order - right.order ||
      (leftId < rightId ? -1 : leftId > rightId ? 1 : 0),
  );
  const customNodes = occurrences
    .filter(([, node]) => node.kind === "node")
    .map(([id, node]): NodeTemplate => {
      if (!Object.hasOwn(contract.nodes, id))
        throw new Error(`Map the executable behavior of ${id}`);
      const nodeContract = contract.nodes[id];
      const { binding, callBindings, operations, ...behavior } = nodeContract;
      return {
        ...behavior,
        id,
        label: node.label,
        responsibility:
          content.fields[`node/${id}/responsibility`]?.value ?? "",
        implementation: {
          operation: "default",
          scope: "main",
          ...binding,
          skill: skillName(node.skillId),
        },
        operations: operations ?? ["require", "augment", "override", "disable"],
        requiredSkillCalls: occurrences
          .filter(
            ([, call]) =>
              call.parent === id && call.kind === "required-skill-call",
          )
          .map(([callId, call]) => ({
            operation: "require",
            scope: "main",
            ...callBindings?.[callId],
            skill: skillName(call.skillId),
          })),
      };
    });
  for (const id of Object.keys(contract.nodes)) {
    if (!customNodes.some((node) => node.id === id))
      throw new Error(`Unknown mapped node ${id}`);
  }
  const ordered = Object.entries(content.routes ?? {})
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .filter(([, route]) => !route.diagramOnly)
    .map(([id, route]) => {
      if (
        route.kind === "optional" &&
        !route.when &&
        !contract.nodes[route.from]?.decision?.choices.some(
          (choice) =>
            (choice.to ?? choice.target ?? choice.transition) === route.to,
        )
      )
        throw new Error(
          `Map the executable condition for optional route ${id}`,
        );
      if (
        route.kind === "rework" &&
        !contract.cycles?.some(
          (cycle) =>
            cycle.maxInstances === route.maxVisits &&
            cycle.repeatTransitions.some(
              (edge) => edge.from === route.from && edge.to === route.to,
            ),
        )
      )
        throw new Error(`Map the bounded cycle for ${id}`);
      for (const hook of route.hooks ?? []) {
        const basis = content.fields[hook.field];
        if (!basis || !["source", "decision"].includes(basis.state))
          throw new Error(
            `Resolve evidence for hook ${hook.id} on route ${id}`,
          );
      }
      return {
        order: route.order ?? Number.MAX_SAFE_INTEGER,
        edge: {
          from: route.from,
          to: route.to as string | null,
          condition: route.outcome ?? "success",
          ...(route.when && { when: route.when }),
        },
      };
    });
  for (const { order, ...terminal } of contract.terminalTransitions ?? [])
    ordered.push({
      order: order ?? Number.MAX_SAFE_INTEGER,
      edge: { ...terminal, to: null },
    });
  const transitions = ordered
    .sort((a, b) => a.order - b.order)
    .map((entry) => entry.edge);
  if (
    customNodes.length > 1 &&
    !transitions.length &&
    !Object.values(content.routes ?? {}).some((edge) => edge.diagramOnly)
  )
    throw new Error("Map the routes between workflow nodes");
  return structuredClone({
    kind: "workflow-kernel",
    name,
    goal,
    customNodes,
    outputSchemas: contract.outputSchemas,
    ...(transitions.length && {
      routing: {
        transitions,
        ...(contract.fields && { fields: contract.fields }),
        ...(contract.routes && { routes: contract.routes }),
      },
    }),
    ...(contract.patches && { nodes: contract.patches }),
    ...(contract.cycles && { cycles: contract.cycles }),
    ...(contract.capabilities && { capabilities: contract.capabilities }),
    ...(contract.finalization && { finalization: contract.finalization }),
  });
}

export type WorkflowMapSeed = Pick<
  WorkingDossierEdit,
  "contract" | "nodes" | "routes" | "fields"
>;
/** Import only when recompilation reproduces the approved runtime protocol. */
export function workflowMapFromPlan(
  content: WorkingDossierContent,
  pins: DossierPin[],
  workflow: WorkflowInput,
  planHash: string,
): WorkflowMapSeed {
  const changed = structuredClone(content);
  const contract: WorkflowMapContract = {
    nodes: {},
    outputSchemas: workflow.outputSchemas ?? [],
    fields: workflow.routing?.fields ?? workflow.routing?.routingFields,
    routes: workflow.routing?.routes,
    cycles: workflow.cycles,
    capabilities: workflow.capabilities,
    patches: workflow.nodes,
    finalization: workflow.finalization,
  };
  const fields: WorkingDossierContent["fields"] = {};
  for (const node of workflow.customNodes) {
    const occurrence = changed.nodes[node.id];
    if (
      !occurrence ||
      pins.find((p) => p.skillId === occurrence.skillId)?.name !==
        node.implementation.skill
    )
      throw new Error("Reconcile the mapped Skill for " + node.id);
    occurrence.label = node.label;
    const field = `node/${node.id}/responsibility`;
    if (content.fields[field]?.value !== node.responsibility)
      fields[field] = {
        state: "decision",
        value: node.responsibility,
        reason: "Carried forward from approved Plan " + planHash,
      };
    const {
      id,
      implementation,
      requiredSkillCalls,
      label: _label,
      responsibility: _responsibility,
      ...behavior
    } = node;
    const { skill: _skill, ...binding } = implementation;
    const calls = Object.entries(changed.nodes)
      .filter(([, call]) => call.parent === id)
      .sort(([, a], [, b]) => a.order - b.order);
    const callBindings: NonNullable<MappedNode["callBindings"]> = {};
    for (const [i, call] of (requiredSkillCalls ?? []).entries()) {
      const mapped = calls[i];
      if (
        !mapped ||
        pins.find((p) => p.skillId === mapped[1].skillId)?.name !== call.skill
      )
        throw new Error("Reconcile required Skill calls for " + id);
      const { skill: _name, ...entry } = call;
      callBindings[mapped[0]] = entry;
    }
    contract.nodes[id] = { ...behavior, binding, callBindings };
  }
  const routes: Record<string, DossierRoute> = {};
  const previous = Object.entries(content.routes ?? {});
  const used = new Set<string>();
  for (const [order, edge] of (workflow.routing?.transitions ?? []).entries()) {
    if (edge.to === null) {
      const { to: _to, ...terminal } = edge;
      (contract.terminalTransitions ??= []).push({ ...terminal, order });
      continue;
    }
    const matching = previous.find(
      ([id, route]) =>
        !used.has(id) && route.from === edge.from && route.to === edge.to,
    );
    const id =
      matching?.[0] ??
      "transition-" + order + "-" + canonicalHash(edge).slice(0, 12);
    used.add(id);
    routes[id] = {
      ...(matching?.[1] ?? { kind: "next" }),
      from: edge.from,
      to: edge.to,
      outcome: edge.condition,
      when: edge.when,
      order,
    };
  }
  for (const [id, edge] of previous)
    if (!used.has(id)) routes[id] = { ...edge, diagramOnly: true };
  Object.assign(changed.fields, fields);
  Object.assign(changed, { contract, routes });
  const compiled = compileWorkflowMap(
    changed,
    pins,
    workflow.name,
    workflow.goal,
  );
  if (
    canonicalHash(normalizeWorkflow(compiled).protocol) !==
    canonicalHash(normalizeWorkflow(workflow).protocol)
  )
    throw new Error(
      "The map must reproduce the approved workflow protocol before it can be adopted.",
    );
  return { nodes: changed.nodes, fields, contract, routes };
}
