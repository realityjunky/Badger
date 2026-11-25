import type { SkillSourceFile } from "../types.js";
import { canonicalHash } from "../util.js";
import {
  SEMANTIC_DOSSIER_TOPICS,
  type SemanticDossier,
  type SemanticTopic,
} from "./questionnaire.js";
import type { QuestionnaireTopic } from "./questionnaire-records.js";

const field = (
  key: string,
  label: string,
  topic: QuestionnaireTopic,
  required = false,
) => ({ key, label, topic, required });
const implementationFields = [
  field("responsibility", "Responsibility", "scope", true),
  field("inputs", "Inputs", "inputs", true),
  field("prerequisites", "Prerequisites", "prerequisites"),
  field("bindings", "Implementation bindings", "bindings"),
  field("requiredSkillCalls", "Required Skill calls", "requiredSkillCalls"),
  field("augmentations", "Augmentations", "augmentations"),
  field("outputSchemas", "Output schemas", "outputSchemas", true),
  field("completionEvidence", "Completion evidence", "completionEvidence"),
  field("guardrails", "Guardrails", "guardrails"),
  field("capabilities", "Capabilities", "capabilities"),
  field(
    "executableDisclosures",
    "Executable disclosures",
    "executableDisclosures",
  ),
  field(
    "recoveryPolicy",
    "Recovery and pending action evidence",
    "recoveryPolicy",
  ),
];
export const WORKING_DOSSIER_FIELDS = {
  workflow: [
    field("scope", "Scope", "scope", true),
    field("roles", "Roles", "scope", true),
    field("decisions", "Decisions", "decisions"),
    field("routes", "Routes", "routes"),
    field("boundedCycles", "Bounded cycles", "boundedCycles"),
    field("guardrails", "Workflow guardrails", "guardrails"),
    field("recoveryPolicy", "Workflow recovery", "recoveryPolicy"),
    field("finalization", "Finalization", "finalization"),
  ],
  skill: implementationFields,
  node: [
    ...implementationFields,
    field("trigger", "Trigger", "routes", true),
    field("nextDecision", "Next decision", "decisions"),
  ],
  interface: [
    field("artifact", "Exchanged artifact", "interfaces", true),
    field("shape", "Format and shape", "interfaces", true),
    field("validation", "Validation", "interfaces"),
    field("conditions", "Conditions", "interfaces"),
  ],
} as const;

export type DossierFieldScope = keyof typeof WORKING_DOSSIER_FIELDS;
export const DOSSIER_FIELD_STATES = [
  "source",
  "proposed",
  "decision",
  "missing",
  "conflict",
  "not-applicable",
] as const;
export type DossierFieldState = (typeof DOSSIER_FIELD_STATES)[number];
export interface DossierEvidence {
  skillId: string;
  hash: string;
  path: string;
  fileHash: string;
  startLine: number;
  endLine: number;
}
export interface DossierEvidenceChange {
  skillId: string;
  path: string;
  fromVersionHash: string;
  toVersionHash: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  status: "changed" | "removed" | "unpinned";
}
export interface ReviewedDossierAnswer {
  questionId: string;
  resolutionRevision: number;
  personId: string;
  revision: number;
}
export interface DossierFieldValue {
  state: DossierFieldState;
  value?: string;
  reason?: string;
  evidence?: DossierEvidence[];
  answers?: ReviewedDossierAnswer[];
}
export interface DossierOccurrence {
  label: string;
  skillId: string;
  hash: string;
  order: number;
  kind: "node" | "required-skill-call";
  parent?: string;
}
export interface DossierInterface {
  producer: string;
  consumer: string;
  status: "documented" | "proposed";
  producerEvidence: DossierEvidence[];
  consumerEvidence: DossierEvidence[];
}
export interface DossierRoute {
  from: string;
  to: string;
  kind: "next" | "optional" | "rework";
  condition?: string;
  maxVisits?: number;
}
export interface DossierFinding {
  fields: string[];
  consequence: string;
  evidence: DossierEvidence[];
}
export interface WorkingDossierContent {
  fields: Record<string, DossierFieldValue>;
  nodes: Record<string, DossierOccurrence>;
  interfaces: Record<string, DossierInterface>;
  routes?: Record<string, DossierRoute>;
  findings: Record<string, DossierFinding>;
}
export interface DossierPin {
  skillId: string;
  name: string;
  hash: string;
}
export interface DossierJobPin extends DossierPin {
  inventory: SkillSourceFile[];
}
export interface WorkingDossierRevision {
  revision: number;
  pinsHash: string;
  pins: DossierPin[];
  content: WorkingDossierContent;
}
export interface WorkingDossierEdit {
  revision: number;
  pinsHash: string;
  editId: string;
  fields?: Record<string, DossierFieldValue | null>;
  nodes?: Record<string, DossierOccurrence | null>;
  interfaces?: Record<string, DossierInterface | null>;
  routes?: Record<string, DossierRoute | null>;
  findings?: Record<string, DossierFinding | null>;
}
export interface DossierAnswerChoice extends ReviewedDossierAnswer {
  fields: string[];
  text: string;
  skill?: { name: string; versionHash: string };
}

export interface DossierRestatementChoice {
  id: string;
  text: string;
  answers: ReviewedDossierAnswer[];
}

export interface WorkingDossierView extends WorkingDossierRevision {
  available: boolean;
  legacy: boolean;
  editable: boolean;
  prompt: string | null;
  reviewUrl: string;
  savedRevision?: number;
  readiness: WorkingDossierReadiness[];
  reviewedAnswers: DossierAnswerChoice[];
  reviewedRestatements: DossierRestatementChoice[];
  questions: { id: string; text: string; state: string; fields: string[] }[];
  projection: ReturnType<typeof projectWorkingDossier>;
}

export interface WorkingDossierJob {
  workflow: {
    id: string;
    versionId: string;
    number: number;
    versionLabel: string;
    name: string;
    goal: string;
  };
  dossier: WorkingDossierRevision;
  pins: DossierJobPin[];
  fields: typeof WORKING_DOSSIER_FIELDS;
  schema: typeof WORKING_DOSSIER_EDIT_SCHEMA;
  reviewedAnswers: DossierAnswerChoice[];
  instructions: string;
  reviewUrl: string;
}

const identifier = {
  type: "string",
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
};
const fieldIdentifier = {
  type: "string",
  pattern:
    "^(workflow|skill|node|interface)/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/[A-Za-z][A-Za-z0-9]{0,49}$",
};
const digest = { type: "string", pattern: "^[a-f0-9]{64}$" };
const positiveInteger = {
  type: "integer",
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
};
const shortText = {
  type: "string",
  minLength: 1,
  maxLength: 4000,
  pattern: "\\S",
};
const object = (properties: Record<string, object>, required: string[]) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const array = (items: object, maxItems = 16) => ({
  type: "array",
  items,
  maxItems,
});
const evidence = array(
  object(
    {
      skillId: identifier,
      hash: digest,
      path: { ...shortText, maxLength: 1024 },
      fileHash: digest,
      startLine: positiveInteger,
      endLine: positiveInteger,
    },
    ["skillId", "hash", "path", "fileHash", "startLine", "endLine"],
  ),
);
const changes = (keys: object, values: object) => ({
  type: "object",
  propertyNames: keys,
  maxProperties: 500,
  additionalProperties: { anyOf: [values, { type: "null" }] },
});
export const WORKING_DOSSIER_EDIT_SCHEMA = object(
  {
    revision: { ...positiveInteger, minimum: 0 },
    pinsHash: digest,
    editId: identifier,
    fields: changes(
      fieldIdentifier,
      object(
        {
          state: { enum: DOSSIER_FIELD_STATES },
          value: shortText,
          reason: shortText,
          evidence,
          answers: array(
            object(
              {
                questionId: identifier,
                resolutionRevision: positiveInteger,
                personId: identifier,
                revision: positiveInteger,
              },
              ["questionId", "resolutionRevision", "personId", "revision"],
            ),
          ),
        },
        ["state"],
      ),
    ),
    nodes: changes(
      identifier,
      object(
        {
          label: { ...shortText, maxLength: 200 },
          skillId: identifier,
          hash: digest,
          order: { ...positiveInteger, minimum: 0 },
          kind: { enum: ["node", "required-skill-call"] },
          parent: identifier,
        },
        ["label", "skillId", "hash", "order", "kind"],
      ),
    ),
    interfaces: changes(
      identifier,
      object(
        {
          producer: identifier,
          consumer: identifier,
          status: { enum: ["documented", "proposed"] },
          producerEvidence: evidence,
          consumerEvidence: evidence,
        },
        [
          "producer",
          "consumer",
          "status",
          "producerEvidence",
          "consumerEvidence",
        ],
      ),
    ),
    routes: changes(
      identifier,
      object(
        {
          from: identifier,
          to: identifier,
          kind: { enum: ["next", "optional", "rework"] },
          condition: shortText,
          maxVisits: positiveInteger,
        },
        ["from", "to", "kind"],
      ),
    ),
    findings: changes(
      identifier,
      object(
        {
          fields: array(fieldIdentifier, 32),
          consequence: shortText,
          evidence,
        },
        ["fields", "consequence", "evidence"],
      ),
    ),
  },
  ["revision", "pinsHash", "editId"],
);

export const WORKING_DOSSIER_INSTRUCTIONS =
  "Read the workflow version, goal, field definitions and pin inventory supplied with this job. " +
  "Derive the participating Skills and their relationships from that inventory and their evidence. " +
  "Use these field IDs: workflow/workflow/<key>, skill/<skillId>/<key>, node/<occurrenceId>/<key>, interface/<interfaceId>/<key>. " +
  "Inspect each Skill's instructions, relevant references and scripts without executing them. " +
  "Fill the fields that affect authoring and cite the pinned file and lines. " +
  "Use Executable disclosures for script effects that matter to a recorded use of a Skill. Identify the action, what it affects, and any condition or approval the workflow must handle. Record uncertainties that need a Questionnaire decision as material findings. " +
  "Trace each handoff from a producer's output to a consumer's input. " +
  "Check formats, required values and conditions at both ends. Identify each distinct use of a Skill, including a review triggered by another stage, and the evidence needed to resume it. " +
  "Use a Node for independently resumable actions or describe its visit in a bounded Cycle. Use a Required Skill Call for work that contributes evidence at its parent Node's completion. " +
  "Use routes to show control transitions. Record optional route conditions and positive visit limits for bounded rework, with evidence or open decisions in Routes and Bounded cycles. " +
  "A single-Skill workflow can have zero cross-Skill interfaces. Combine evidence for the same decision and explain in one sentence why a material finding matters. " +
  "Leave unsupported values blank and name the decision or evidence needed. Label inferred connections explicitly. " +
  "Submit the partial dossier and return its review link. When continuing, read the latest revision and reviewed answers, change the affected fields, and cite the new evidence.";

export interface WorkingDossierReadiness {
  topic: QuestionnaireTopic;
  blockers: { id: string; message: string }[];
}

export function emptyWorkingDossier(): WorkingDossierContent {
  return { fields: {}, nodes: {}, interfaces: {}, findings: {} };
}

function changedEntries<T>(
  current: Record<string, T>,
  changes: Record<string, T | null> = {},
): Record<string, T> {
  return Object.fromEntries([
    ...Object.entries(current).filter(([id]) => !Object.hasOwn(changes, id)),
    ...Object.entries(changes).flatMap(([id, value]) =>
      value === null ? [] : [[id, value] as const],
    ),
  ]);
}

export function applyWorkingDossierEdit(
  current: WorkingDossierContent,
  edit: WorkingDossierEdit,
): WorkingDossierContent {
  return {
    fields: changedEntries(current.fields, edit.fields),
    nodes: changedEntries(current.nodes, edit.nodes),
    interfaces: changedEntries(current.interfaces, edit.interfaces),
    ...(current.routes || edit.routes
      ? { routes: changedEntries(current.routes ?? {}, edit.routes) }
      : {}),
    findings: changedEntries(current.findings, edit.findings),
  };
}

export function workingDossierCitations(
  content: WorkingDossierContent,
): DossierEvidence[] {
  return [
    ...Object.values(content.fields).flatMap((value) => value?.evidence ?? []),
    ...Object.values(content.interfaces).flatMap((edge) => [
      ...edge.producerEvidence,
      ...edge.consumerEvidence,
    ]),
    ...Object.values(content.findings).flatMap((finding) => finding.evidence),
  ];
}

function citesOccurrence(
  citation: DossierEvidence,
  occurrence: DossierOccurrence,
) {
  return (
    citation.skillId === occurrence.skillId && citation.hash === occurrence.hash
  );
}

function hasEndpointEvidence(
  edge: DossierInterface,
  producer: DossierOccurrence,
  consumer: DossierOccurrence,
) {
  return (
    edge.producerEvidence.every((citation) =>
      citesOccurrence(citation, producer),
    ) &&
    edge.consumerEvidence.every((citation) =>
      citesOccurrence(citation, consumer),
    ) &&
    (edge.status !== "documented" ||
      (edge.producerEvidence.length > 0 && edge.consumerEvidence.length > 0))
  );
}

/** Check the shape of edited meaning; existing citations can become stale. */
export function workingDossierEditFinding(
  content: WorkingDossierContent,
  edit: WorkingDossierEdit,
  pins: DossierPin[],
  reviewedAnswers: DossierAnswerChoice[],
): string | null {
  const owners = dossierFieldOwners(content, pins);
  const fields = new Set(
    owners.flatMap(({ scope, id }) =>
      WORKING_DOSSIER_FIELDS[scope].map(({ key }) =>
        dossierFieldId(scope, id, key),
      ),
    ),
  );
  const pinHashes = new Map(pins.map((pin) => [pin.skillId, pin.hash]));
  const reviewed = new Map(
    reviewedAnswers.map((answer) => [dossierAnswerKey(answer), answer.fields]),
  );
  const isPinned = (value: { skillId: string; hash: string }) =>
    pinHashes.get(value.skillId) === value.hash;
  for (const [id, value] of Object.entries(edit.fields ?? {})) {
    if (value === null) continue;
    if (!fields.has(id)) return `${id} is not a field of the current dossier`;
    const [scope, owner] = id.split("/");
    if (
      (value.state === "source" && (!value.value || !value.evidence?.length)) ||
      (value.state === "proposed" && (!value.value || !value.reason)) ||
      (value.state === "decision" &&
        (!value.value || (!value.reason && !value.answers?.length))) ||
      (["missing", "conflict", "not-applicable"].includes(value.state) &&
        (!value.reason || value.value !== undefined))
    )
      return `${id} needs a value, citations or a reason appropriate to its state`;
    if (
      value?.answers?.some(
        (answer) => !reviewed.get(dossierAnswerKey(answer))?.includes(id),
      )
    )
      return `${id} cites an answer revision that was not reviewed for this field`;
    if (value.state === "source" && ["skill", "node"].includes(scope)) {
      const occurrence = scope === "node" ? content.nodes[owner] : undefined;
      if (
        !value.evidence?.some((citation) =>
          occurrence
            ? citesOccurrence(citation, occurrence)
            : citation.skillId === owner,
        )
      )
        return `${id} needs evidence from its own pinned Skill`;
    }
  }
  const orders = new Set<number>();
  for (const [id, node] of Object.entries(content.nodes)) {
    if (
      (edit.nodes?.[id] && !isPinned(node)) ||
      (node.kind === "node" &&
        (node.parent !== undefined || orders.has(node.order))) ||
      (node.kind === "required-skill-call" &&
        (!node.parent ||
          !Object.hasOwn(content.nodes, node.parent) ||
          content.nodes[node.parent].kind !== "node"))
    )
      return `${id} needs a current pin and a unique Node order or a parent Node for its Required Skill Call`;
    if (node.kind === "node") orders.add(node.order);
  }
  for (const [id, edge] of Object.entries(content.interfaces)) {
    const producer =
      Object.hasOwn(content.nodes, edge.producer) &&
      content.nodes[edge.producer];
    const consumer =
      Object.hasOwn(content.nodes, edge.consumer) &&
      content.nodes[edge.consumer];
    if (!producer || !consumer)
      return `${id} needs a producer and consumer occurrence`;
    if (edit.interfaces?.[id]) {
      if (!isPinned(producer) || !isPinned(consumer))
        return `${id} needs both endpoints on current pins`;
      if (!hasEndpointEvidence(edge, producer, consumer))
        return `${id} needs correctly attributed evidence at each documented endpoint`;
    }
  }
  for (const [id, route] of Object.entries(content.routes ?? {})) {
    if (
      [route.from, route.to].some(
        (endpoint) =>
          !Object.hasOwn(content.nodes, endpoint) ||
          content.nodes[endpoint].kind !== "node",
      )
    )
      return `${id} needs two Node endpoints`;
    if (
      route.kind === "rework"
        ? !route.maxVisits || !route.condition
        : route.maxVisits !== undefined ||
          (route.kind === "optional" && !route.condition)
    )
      return `${id} needs an optional condition or bounded rework condition and visit limit`;
  }
  for (const [id, finding] of Object.entries(edit.findings ?? {})) {
    if (
      finding &&
      (!finding.evidence.length ||
        !finding.fields.length ||
        finding.fields.some((id) => !fields.has(id)))
    )
      return `${id} needs evidence linked to current dossier fields`;
  }
  return null;
}

export const dossierFieldId = (
  scope: DossierFieldScope,
  owner: string,
  key: string,
) => `${scope}/${owner}/${key}`;

export function dossierFieldOwners(
  content: WorkingDossierContent,
  pins: DossierPin[],
) {
  return [
    { scope: "workflow", id: "workflow", label: "Workflow" } as const,
    ...pins.map((pin) => ({
      scope: "skill" as const,
      id: pin.skillId,
      label: pin.name,
    })),
    ...orderedEntries(content.nodes).map(([id, node]) => ({
      scope: "node" as const,
      id,
      label: node.label,
    })),
    ...orderedEntries(content.interfaces).map(([id, edge]) => ({
      scope: "interface" as const,
      id,
      label: `${content.nodes[edge.producer]?.label ?? edge.producer} → ${content.nodes[edge.consumer]?.label ?? edge.consumer}`,
    })),
  ];
}

function orderedEntries<T>(record: Record<string, T>) {
  return Object.entries(record).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

export function dossierAnswerKey(answer: ReviewedDossierAnswer) {
  const { questionId, resolutionRevision, personId, revision } = answer;
  return `${questionId}/${resolutionRevision}/${personId}/${revision}`;
}

export function projectWorkingDossier(
  content: WorkingDossierContent,
  pins: DossierPin[],
  answers: DossierAnswerChoice[],
  evidenceChanges?: DossierEvidenceChange[],
) {
  const pinHashes = new Map(pins.map(({ skillId, hash }) => [skillId, hash]));
  const reviewed = new Map(
    answers.map((answer) => [dossierAnswerKey(answer), answer.fields]),
  );
  const stale = (ref: { skillId: string; hash: string }) =>
    pinHashes.get(ref.skillId) !== ref.hash;
  const fileKey = (skillId: string, hash: string, path: string) =>
    JSON.stringify([skillId, hash, path]);
  const changes = new Map(
    evidenceChanges?.map((change) => [
      fileKey(change.skillId, change.fromVersionHash, change.path),
      change,
    ]),
  );
  const citationKey = ({ skillId, hash, path }: DossierEvidence) =>
    fileKey(skillId, hash, path);
  const citationChanged = (citation: DossierEvidence) =>
    evidenceChanges === undefined
      ? stale(citation)
      : changes.has(citationKey(citation));
  const staleNodes = new Set(
    Object.entries(content.nodes)
      .filter(([, node]) => stale(node))
      .map(([id]) => id),
  );
  const staleEdges = new Set(
    Object.entries(content.interfaces)
      .filter(
        ([, edge]) =>
          [edge.producer, edge.consumer].some((id) => staleNodes.has(id)) ||
          !content.nodes[edge.producer] ||
          !content.nodes[edge.consumer] ||
          !hasEndpointEvidence(
            edge,
            content.nodes[edge.producer],
            content.nodes[edge.consumer],
          ) ||
          [...edge.producerEvidence, ...edge.consumerEvidence].some(
            citationChanged,
          ),
      )
      .map(([id]) => id),
  );
  const fields = dossierFieldOwners(content, pins).flatMap(
    ({ scope, id: owner, label }) =>
      WORKING_DOSSIER_FIELDS[scope].map((definition) => {
        const id = dossierFieldId(scope, owner, definition.key);
        const value = content.fields[id] ?? null;
        const edge = scope === "interface" ? content.interfaces[owner] : null;
        const citations = [
          ...(value?.evidence ?? []),
          ...(edge ? [...edge.producerEvidence, ...edge.consumerEvidence] : []),
        ];
        const changedFiles = [...new Set(citations.map(citationKey))].flatMap(
          (key) => {
            const change = changes.get(key);
            return change ? [change] : [];
          },
        );
        let blocker: string | null = null;
        if (
          value?.evidence?.some(citationChanged) ||
          (scope === "node" &&
            value?.state === "source" &&
            !value.evidence?.some((citation) =>
              citesOccurrence(citation, content.nodes[owner]),
            )) ||
          (scope === "node" && staleNodes.has(owner)) ||
          (scope === "interface" && staleEdges.has(owner))
        )
          blocker = "A cited pin or endpoint changed";
        else if (
          value?.answers?.some(
            (answer) => !reviewed.get(dossierAnswerKey(answer))?.includes(id),
          )
        )
          blocker = "A linked reviewed answer changed";
        else if (
          value?.state === "missing" ||
          value?.state === "conflict" ||
          (value?.state === "proposed" &&
            definition.required &&
            scope !== "interface")
        )
          blocker = value.reason ?? "Review the proposed interpretation";
        else if (!value && definition.required)
          blocker = `${definition.label} is required`;
        return {
          ...definition,
          id,
          scope,
          owner,
          ownerLabel: label,
          content: value,
          blocker,
          evidenceChanges: changedFiles,
        };
      }),
  );
  const currentFields = new Set(fields.map((entry) => entry.id));
  return {
    fields,
    removedFields: Object.keys(content.fields).filter(
      (id) => !currentFields.has(id),
    ),
    staleFindings: Object.entries(content.findings)
      .filter(
        ([, finding]) =>
          finding.evidence.some(citationChanged) ||
          finding.fields.some((field) => !currentFields.has(field)),
      )
      .map(([id]) => id),
  };
}

export interface ApprovedWorkingDossier extends WorkingDossierRevision {
  fields: typeof WORKING_DOSSIER_FIELDS;
  scriptEffects: {
    skillId: string;
    sourceHash: string;
    revision: number;
    hash: string;
  }[];
}

export function workingDossierSemantics(
  basis: ApprovedWorkingDossier,
  sources: SemanticDossier["sources"],
) {
  const { content, pins } = basis;
  const sourceFacts: SemanticDossier["sourceDerivedFacts"] = [];
  const topics = new Map<QuestionnaireTopic, SemanticTopic>();
  const summaries = new Map<string, SemanticTopic>();
  for (const owner of dossierFieldOwners(content, pins)) {
    for (const definition of WORKING_DOSSIER_FIELDS[owner.scope]) {
      const id = dossierFieldId(owner.scope, owner.id, definition.key);
      const value = content.fields[id];
      if (!value) continue;
      const evidence =
        value.state === "source" ? value.evidence?.[0] : undefined;
      const factIds = evidence ? [`field-${canonicalHash(id)}`] : [];
      const summary = value.value ?? value.reason ?? "";
      if (evidence)
        sourceFacts.push({
          id: factIds[0]!,
          statement: summary,
          sourceId: evidence.skillId,
          evidencePath: evidence.path,
        });
      summaries.set(id, { summary, factIds });
      const topic = topics.get(definition.topic) ?? {
        summary: "",
        factIds: [],
      };
      const label = value.state === "proposed" ? " (proposed)" : "";
      const line = `${owner.label} · ${definition.label}${label} — ${summary}`;
      topic.summary = topic.summary ? `${topic.summary}\n${line}` : line;
      topic.factIds.push(...factIds);
      topics.set(definition.topic, topic);
    }
  }
  const nodes = Object.entries(content.nodes)
    .filter(([, node]) => node.kind === "node")
    .sort(([, left], [, right]) => left.order - right.order)
    .map(([id, node]) => ({
      id,
      order: node.order,
      responsibility: summaries.get(
        dossierFieldId("node", id, "responsibility"),
      ) ?? { summary: "", factIds: [] },
    }));
  const upgradeSource = sources.find((source) =>
    source.roles.includes("upgrade-source"),
  );
  const recovery = content.fields["workflow/workflow/recoveryPolicy"]?.value;
  return {
    sourceFacts,
    semantics: {
      nodes,
      topics: Object.fromEntries(
        SEMANTIC_DOSSIER_TOPICS.map((topic) => [
          topic,
          topics.get(topic) ?? { summary: "No value recorded.", factIds: [] },
        ]),
      ),
      ...(upgradeSource && recovery
        ? { upgradeSource: { sourceId: upgradeSource.id, recovery } }
        : {}),
    },
  };
}
