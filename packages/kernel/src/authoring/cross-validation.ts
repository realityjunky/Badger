import { promises as fs } from "node:fs";
import path from "node:path";
import { packageRelativePath, sha256, slug, stableValue } from "../util.js";
import type {
  Binding,
  NodeProtocol,
  WorkflowProtocol,
  WorkflowRoute,
  WorkflowTransition,
} from "../types.js";
import {
  AUTHORING_CROSS_VALIDATION_CODES,
  AUTHORING_REVIEW_LENSES,
  type AuthoringCrossValidationCode,
  type AuthoringCrossValidationFinding,
  type AuthoringCrossValidationResult,
  type AuthoringFindingSeverity,
  type AuthoringPlan,
} from "./types.js";

export {
  AUTHORING_CROSS_VALIDATION_CODES,
  type AuthoringCrossValidationCode,
  type AuthoringCrossValidationFinding,
  type AuthoringCrossValidationResult,
};

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTIFIER = "[A-Za-z][A-Za-z0-9._-]*";
const GENERIC_EXIT_WORDS = new Set([
  "a",
  "an",
  "control",
  "current",
  "node",
  "person",
  "responsible",
  "step",
  "the",
  "user",
]);
const EMPTY_CONTRACT_REFERENCES = new Set(["empty", "none", "no"]);
const NEGATION =
  /\b(?:do\s+not|don't|never|must\s+not|cannot|can't|avoid|without|forbidden|prohibited|reject|rejects|not)\b/iu;
const DIRECT_STATE_REFERENCE =
  /\b(?:Run\s+state|currentNode|completedNodes|Decision\s+Receipt|Cycle|Attempt)\b/iu;
const DIRECT_STATE_ACTION =
  /\b(?:write|update|mutate|set|persist|create|allocate|advance|overwrite|delete|replace)s?\b/iu;

export interface AuthoredGuidanceDocument {
  path: string;
  content: string;
}

export interface CrossValidateAuthoredGuidanceOptions {
  workflow: WorkflowProtocol;
  documents: readonly AuthoredGuidanceDocument[];
  workflowProtocolHash?: string;
}

export interface CrossValidateAuthoringPackageOptions {
  packageRoot: string;
  plan: Pick<AuthoringPlan, "workflowProtocolHash" | "lanes">;
}

interface Mention {
  id: string;
  index: number;
  line: string;
}

interface TransitionMention extends Mention {
  target: string;
}

interface ChoiceDefinition {
  nodeId: string;
  targets: Set<string>;
}

interface PreparedDocument {
  path: string;
  content: string;
}

function cleanIdentifier(value: string): string {
  return value.replace(/[.,;:!?]+$/gu, "");
}

interface ProtocolIndex {
  activeNodes: NodeProtocol[];
  nodeIds: Set<string>;
  choices: Map<string, ChoiceDefinition>;
  decisions: Map<string, string>;
  routes: Map<string, WorkflowRoute>;
  transitions: WorkflowTransition[];
  requiredSkillCalls: Map<string, Set<string>>;
  outputSchemas: Map<string, Set<string>>;
  guardrails: Map<string, Set<string>>;
  allOutputSchemas: Set<string>;
  allGuardrails: Set<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedDocumentPath(value: string): string {
  let normalized = value.replaceAll("\\", "/");
  while (normalized.startsWith("../")) normalized = normalized.slice(3);
  return path.posix.normalize(normalized);
}

function lineFor(content: string, index: number): string {
  const start = content.lastIndexOf("\n", index - 1) + 1;
  const end = content.indexOf("\n", index);
  return content.slice(start, end === -1 ? content.length : end);
}

function isNegated(content: string, index: number): boolean {
  const line = lineFor(content, index);
  const lineStart = content.lastIndexOf("\n", index - 1) + 1;
  return NEGATION.test(line.slice(0, index - lineStart));
}

function semanticContent(content: string): string {
  const lines = content.split(/\r?\n/u);
  let fenceCharacter: "`" | "~" | undefined;
  let fenceLength = 0;
  return lines
    .map((line) => {
      const fence = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
      if (fence) {
        const character = fence[1]![0] as "`" | "~";
        if (!fenceCharacter) {
          fenceCharacter = character;
          fenceLength = fence[1]!.length;
        } else if (
          character === fenceCharacter &&
          fence[1]!.length >= fenceLength
        ) {
          fenceCharacter = undefined;
          fenceLength = 0;
        }
        return "";
      }
      return fenceCharacter ? "" : line;
    })
    .join("\n");
}

function mentions(content: string, expression: RegExp): Mention[] {
  return [...content.matchAll(expression)].map((match) => ({
    id: cleanIdentifier(match[1]!),
    index: match.index ?? 0,
    line: lineFor(content, match.index ?? 0),
  }));
}

function transitionMentions(
  content: string,
  expression: RegExp,
): TransitionMention[] {
  return [...content.matchAll(expression)].map((match) => ({
    id: cleanIdentifier(match[1]!),
    target: cleanIdentifier(match[2]!),
    index: match.index ?? 0,
    line: lineFor(content, match.index ?? 0),
  }));
}

function containsToken(content: string, token: string): boolean {
  return new RegExp(
    `(?:^|[^A-Za-z0-9_-])${token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:$|[^A-Za-z0-9_-])`,
    "iu",
  ).test(content);
}

function containsAllOnLine(
  content: string,
  tokens: readonly string[],
): boolean {
  return content
    .split(/\r?\n/u)
    .some((line) => tokens.every((token) => containsToken(line, token)));
}

function bindingContractTerms(binding: Binding): string[] {
  return [binding.operation, binding.scope, binding.enforcement];
}

function nodePath(workflow: WorkflowProtocol, node: NodeProtocol): string {
  return `${slug(workflow.name) || "workflow"}-${slug(node.id) || "node"}/SKILL.md`;
}

function nodeForDocument(
  workflow: WorkflowProtocol,
  documentPath: string,
): NodeProtocol | undefined {
  const normalized = normalizedDocumentPath(documentPath);
  return workflow.nodes
    .filter((node) => !node.disabled)
    .find((node) => {
      const expected = nodePath(workflow, node);
      return (
        normalized === expected ||
        normalized.endsWith(`-${slug(node.id) || "node"}/SKILL.md`)
      );
    });
}

function routeMap(workflow: WorkflowProtocol): Map<string, WorkflowRoute> {
  const routes = [
    ...(workflow.routing?.routes ?? []),
    ...workflow.evals.flatMap((evaluation) => evaluation.expectedRoutes ?? []),
  ];
  return new Map(routes.map((route) => [route.id, route]));
}

function protocolIndex(workflow: WorkflowProtocol): ProtocolIndex {
  const activeNodes = workflow.nodes.filter((node) => !node.disabled);
  const choices = new Map<string, ChoiceDefinition>();
  const decisions = new Map<string, string>();
  const requiredSkillCalls = new Map<string, Set<string>>();
  const outputSchemas = new Map<string, Set<string>>();
  const guardrails = new Map<string, Set<string>>();
  const allOutputSchemas = new Set<string>();
  const allGuardrails = new Set<string>();

  for (const node of activeNodes) {
    if (node.decision) {
      decisions.set(node.decision.id, node.id);
      for (const choice of node.decision.choices) {
        const targets = new Set<string>();
        for (const candidate of [choice.to, choice.target, choice.transition]) {
          if (typeof candidate === "string" && candidate.trim())
            targets.add(candidate);
        }
        if (choice.routing) {
          for (const target of Object.values(choice.routing)) {
            if (target.trim()) targets.add(target);
          }
        }
        choices.set(choice.id, { nodeId: node.id, targets });
      }
    }
    requiredSkillCalls.set(
      node.id,
      new Set((node.requiredSkillCalls ?? []).map((binding) => binding.skill)),
    );
    const schemas = new Set(node.outputSchemas ?? []);
    outputSchemas.set(node.id, schemas);
    for (const schema of schemas) allOutputSchemas.add(schema);
    const nodeGuardrails = new Set<string>();
    for (const guardrail of node.guardrails ?? []) {
      nodeGuardrails.add(guardrail.id);
      if (guardrail.verification?.id)
        nodeGuardrails.add(guardrail.verification.id);
      allGuardrails.add(guardrail.id);
      if (guardrail.verification?.id)
        allGuardrails.add(guardrail.verification.id);
    }
    guardrails.set(node.id, nodeGuardrails);
  }
  for (const evaluation of workflow.evals) {
    for (const schema of evaluation.requiredOutputSchemas)
      allOutputSchemas.add(schema);
    for (const route of evaluation.expectedRoutes ?? []) {
      for (const schema of route.requiredOutputSchemas ?? [])
        allOutputSchemas.add(schema);
    }
  }
  for (const schema of workflow.outputSchemas) allOutputSchemas.add(schema.id);

  return {
    activeNodes,
    nodeIds: new Set(activeNodes.map((node) => node.id)),
    choices,
    decisions,
    routes: routeMap(workflow),
    transitions: workflow.edges,
    requiredSkillCalls,
    outputSchemas,
    guardrails,
    allOutputSchemas,
    allGuardrails,
  };
}

function finding(
  code: AuthoringCrossValidationCode,
  pathValue: string,
  subject: string,
  message: string,
  options: {
    severity?: AuthoringFindingSeverity;
    lens?: AuthoringCrossValidationFinding["lens"];
    expected?: string;
    observed?: string;
  } = {},
): AuthoringCrossValidationFinding {
  return {
    code,
    severity: options.severity ?? "important",
    lens: options.lens ?? "contract-fit",
    path: pathValue,
    subject,
    message,
    ...(options.expected ? { expected: options.expected } : {}),
    ...(options.observed ? { observed: options.observed } : {}),
  };
}

function sortFindings(
  findings: readonly AuthoringCrossValidationFinding[],
): AuthoringCrossValidationFinding[] {
  return [...findings].sort((left, right) =>
    [left.path, left.code, left.subject, left.message]
      .join("\u0000")
      .localeCompare(
        [right.path, right.code, right.subject, right.message].join("\u0000"),
      ),
  );
}

function finalizeResult(
  workflowProtocolHash: string,
  checkedArtifacts: readonly string[],
  findings: readonly AuthoringCrossValidationFinding[],
): AuthoringCrossValidationResult {
  const orderedFindings = sortFindings(findings);
  const base = {
    schemaVersion: 1 as const,
    authority: "WorkflowProtocol" as const,
    workflowProtocolHash,
    checkedArtifacts: [...new Set(checkedArtifacts)].sort(),
    findings: orderedFindings,
    passed: !orderedFindings.some(
      (item) => item.severity === "critical" || item.severity === "important",
    ),
  };
  return {
    ...base,
    crossValidationHash: sha256(JSON.stringify(stableValue(base))),
  };
}

export function validateAuthoringCrossValidationResult(
  value: unknown,
): string[] {
  if (!isRecord(value))
    return ["authoring cross-validation evidence must be an object"];
  const findings: string[] = [];
  if (value.schemaVersion !== 1)
    findings.push("authoring cross-validation schemaVersion is invalid");
  if (value.authority !== "WorkflowProtocol")
    findings.push("authoring cross-validation authority is invalid");
  if (!HASH_PATTERN.test(String(value.workflowProtocolHash)))
    findings.push("authoring cross-validation workflowProtocolHash is invalid");
  if (!Array.isArray(value.checkedArtifacts)) {
    findings.push(
      "authoring cross-validation checkedArtifacts must be an array",
    );
  } else {
    for (const [index, artifact] of value.checkedArtifacts.entries()) {
      if (typeof artifact !== "string" || !artifact.trim())
        findings.push(
          `authoring cross-validation checkedArtifacts[${index}] is invalid`,
        );
    }
  }
  if (!Array.isArray(value.findings)) {
    findings.push("authoring cross-validation findings must be an array");
  } else {
    for (const [index, item] of value.findings.entries()) {
      if (!isRecord(item)) {
        findings.push(
          `authoring cross-validation findings[${index}] is invalid`,
        );
        continue;
      }
      if (
        !AUTHORING_CROSS_VALIDATION_CODES.includes(
          item.code as AuthoringCrossValidationCode,
        )
      )
        findings.push(
          `authoring cross-validation findings[${index}].code is invalid`,
        );
      if (
        !(["critical", "important", "minor"] as const).includes(
          item.severity as AuthoringFindingSeverity,
        )
      )
        findings.push(
          `authoring cross-validation findings[${index}].severity is invalid`,
        );
      if (
        !AUTHORING_REVIEW_LENSES.includes(
          item.lens as (typeof AUTHORING_REVIEW_LENSES)[number],
        )
      )
        findings.push(
          `authoring cross-validation findings[${index}].lens is invalid`,
        );
      for (const field of ["path", "subject", "message"] as const) {
        if (typeof item[field] !== "string" || !item[field].trim())
          findings.push(
            `authoring cross-validation findings[${index}].${field} is invalid`,
          );
      }
      for (const field of ["expected", "observed"] as const) {
        if (item[field] !== undefined && typeof item[field] !== "string")
          findings.push(
            `authoring cross-validation findings[${index}].${field} is invalid`,
          );
      }
    }
  }
  if (typeof value.passed !== "boolean")
    findings.push("authoring cross-validation passed is invalid");
  if (!HASH_PATTERN.test(String(value.crossValidationHash))) {
    findings.push("authoring cross-validation hash is invalid");
  } else {
    const { crossValidationHash: _crossValidationHash, ...withoutHash } = value;
    const expected = sha256(JSON.stringify(stableValue(withoutHash)));
    if (expected !== value.crossValidationHash)
      findings.push("authoring cross-validation hash does not match contents");
  }
  return [...new Set(findings)];
}

function withAdditionalFindings(
  result: AuthoringCrossValidationResult,
  findings: readonly AuthoringCrossValidationFinding[],
): AuthoringCrossValidationResult {
  return finalizeResult(result.workflowProtocolHash, result.checkedArtifacts, [
    ...result.findings,
    ...findings,
  ]);
}

function nodeCanReach(
  index: ProtocolIndex,
  nodeId: string,
  target: string,
): boolean {
  if (target === "done" || target === "null") {
    return index.transitions.some(
      (edge) => edge.from === nodeId && edge.to === null,
    );
  }
  if (index.nodeIds.has(target)) {
    return index.transitions.some(
      (edge) => edge.from === nodeId && edge.to === target,
    );
  }
  const route = index.routes.get(target);
  return route?.nodeOrder[0] === nodeId;
}

function isKnownRuntimeTarget(index: ProtocolIndex, target: string): boolean {
  if (index.nodeIds.has(target) || index.routes.has(target)) return true;
  if (target === "done" || target === "null") {
    return index.transitions.some((edge) => edge.to === null);
  }
  if (target === "manual") {
    return index.activeNodes.some((node) => node.kind === "handoff");
  }
  return false;
}

function isSpecificRuntimeTarget(target: string): boolean {
  return !GENERIC_EXIT_WORDS.has(target.toLocaleLowerCase());
}

function isConcreteContractReference(value: string): boolean {
  return !EMPTY_CONTRACT_REFERENCES.has(value.toLocaleLowerCase());
}

function documentContent(documents: readonly PreparedDocument[]): string {
  return documents.map((document) => document.content).join("\n");
}

function mentionPath(
  documents: readonly PreparedDocument[],
  mention: Mention,
  fallback: string,
): string {
  return (
    documents.find((document) => document.content.includes(mention.line))
      ?.path ?? fallback
  );
}

function validateProtocolReferences(
  workflow: WorkflowProtocol,
  documents: readonly PreparedDocument[],
  index: ProtocolIndex,
): AuthoringCrossValidationFinding[] {
  const findings: AuthoringCrossValidationFinding[] = [];
  const corpus = documentContent(documents);
  const choiceMentions = mentions(
    corpus,
    new RegExp(`\\bchoice\\s*[:=]\\s*\u0060?(${IDENTIFIER})\u0060?`, "giu"),
  );
  const decisionMentions = mentions(
    corpus,
    new RegExp(
      `\\bdecision\\s*(?:id\\s*)?[:=]\\s*\u0060?(${IDENTIFIER})\u0060?`,
      "giu",
    ),
  );
  const routeMentions = mentions(
    corpus,
    new RegExp(
      `\\b(?:route\\s*[:=]\\s*|declared\\s+route\\s+)\u0060?(${IDENTIFIER})\u0060?`,
      "giu",
    ),
  );
  const choiceTransitions = transitionMentions(
    corpus,
    new RegExp(
      `\\b(?:choice|option)\\s*[:=]\\s*\u0060?(${IDENTIFIER})\u0060?\\s*(?:->|=>|→|\\bto\\b)\\s*\u0060?(${IDENTIFIER})\u0060?`,
      "giu",
    ),
  );
  const routeTransitions = transitionMentions(
    corpus,
    new RegExp(
      `\\broute\\s*[:=]\\s*\u0060?(${IDENTIFIER})\u0060?\\s*(?:->|=>|→)\\s*\u0060?(${IDENTIFIER})\u0060?`,
      "giu",
    ),
  );
  const nextMentions = mentions(
    corpus,
    new RegExp(`\\bNEXT\\s*[:=]\\s*\u0060?(${IDENTIFIER})\u0060?`, "gu"),
  );
  const exitMentions = mentions(
    corpus,
    new RegExp(
      `\\b(?:exit|handoff)\\s*[:=]\\s*\u0060?(${IDENTIFIER})\u0060?`,
      "giu",
    ),
  );
  const directedExits = mentions(
    corpus,
    new RegExp(
      `\\b(?:skip|jump|go|return|handoff)\\s+(?:to|into)\\s+\u0060?(${IDENTIFIER})\u0060?`,
      "giu",
    ),
  );
  const skillMentions = mentions(
    corpus,
    new RegExp(
      `\\b(?:required\\s+)?skill(?:\\s+call)?\\s*[:=]\\s*\u0060?(${IDENTIFIER})\u0060?`,
      "giu",
    ),
  );
  const outputMentions = mentions(
    corpus,
    new RegExp(
      `\\boutput\\s+schema\\s*[:=]\\s*\u0060?(${IDENTIFIER})\u0060?`,
      "giu",
    ),
  );
  const guardrailMentions = mentions(
    corpus,
    new RegExp(`\\bguardrail\\s*[:=]\\s*\u0060?(${IDENTIFIER})\u0060?`, "giu"),
  );
  const choiceIds = new Set(
    choiceMentions
      .filter((mention) => !isNegated(corpus, mention.index))
      .map((mention) => mention.id),
  );
  const decisionIds = new Set(
    decisionMentions
      .filter((mention) => !isNegated(corpus, mention.index))
      .map((mention) => mention.id),
  );
  const routeIds = new Set(
    routeMentions
      .filter((mention) => !isNegated(corpus, mention.index))
      .map((mention) => mention.id),
  );

  for (const [decisionId] of index.decisions) {
    if (!decisionIds.has(decisionId)) {
      findings.push(
        finding(
          "missing-decision",
          "reference/decision-points.md",
          decisionId,
          `Authored guidance does not identify declared decision ${decisionId}.`,
          { lens: "evidence-trace", expected: decisionId },
        ),
      );
    }
  }
  for (const decisionId of decisionIds) {
    if (!index.decisions.has(decisionId)) {
      findings.push(
        finding(
          "undeclared-decision",
          "reference/decision-points.md",
          decisionId,
          `Authored guidance identifies undeclared decision ${decisionId}.`,
          {
            expected: "a decision declared by WorkflowProtocol",
            observed: decisionId,
          },
        ),
      );
    }
  }
  for (const [choiceId] of index.choices) {
    if (!choiceIds.has(choiceId)) {
      findings.push(
        finding(
          "missing-choice",
          "reference/decision-points.md",
          choiceId,
          `Authored guidance does not identify declared choice ${choiceId}.`,
          { lens: "evidence-trace", expected: choiceId },
        ),
      );
    }
  }
  for (const mention of choiceMentions) {
    if (isNegated(corpus, mention.index)) continue;
    if (!index.choices.has(mention.id)) {
      findings.push(
        finding(
          "undeclared-choice",
          mentionPath(documents, mention, "reference/decision-points.md"),
          mention.id,
          `Authored guidance references undeclared choice ${mention.id}.`,
          {
            expected: "a choice declared by WorkflowProtocol",
            observed: mention.id,
          },
        ),
      );
    }
  }
  for (const [routeId] of index.routes) {
    if (!routeIds.has(routeId)) {
      findings.push(
        finding(
          "missing-route",
          "reference/decision-points.md",
          routeId,
          `Authored guidance does not identify declared route ${routeId}.`,
          { lens: "evidence-trace", expected: routeId },
        ),
      );
    }
  }
  for (const mention of routeMentions) {
    if (isNegated(corpus, mention.index)) continue;
    if (!index.routes.has(mention.id)) {
      findings.push(
        finding(
          "undeclared-route",
          mentionPath(documents, mention, "reference/decision-points.md"),
          mention.id,
          `Authored guidance references undeclared route ${mention.id}.`,
          {
            expected: "a route declared by WorkflowProtocol",
            observed: mention.id,
          },
        ),
      );
    }
  }

  for (const mention of choiceTransitions) {
    if (isNegated(corpus, mention.index)) continue;
    const choice = index.choices.get(mention.id);
    if (!choice) continue;
    if (!isKnownRuntimeTarget(index, mention.target)) {
      findings.push(
        finding(
          "hidden-exit",
          mentionPath(documents, mention, "reference/decision-points.md"),
          mention.target,
          `Authored choice ${mention.id} points to undeclared runtime target ${mention.target}.`,
          {
            expected: [...index.nodeIds, ...index.routes.keys()]
              .sort()
              .join(", "),
            observed: mention.target,
          },
        ),
      );
    }
    if (!choice.targets.size || choice.targets.has(mention.target)) continue;
    findings.push(
      finding(
        "contradictory-transition",
        mentionPath(documents, mention, "reference/decision-points.md"),
        mention.id,
        `Authored choice ${mention.id} points to ${mention.target}, contradicting its declared transition.`,
        {
          expected: [...choice.targets].sort().join(", "),
          observed: mention.target,
        },
      ),
    );
  }
  for (const mention of routeTransitions) {
    if (isNegated(corpus, mention.index)) continue;
    const route = index.routes.get(mention.id);
    if (!route) continue;
    if (!isKnownRuntimeTarget(index, mention.target)) {
      findings.push(
        finding(
          "hidden-exit",
          mentionPath(documents, mention, "reference/decision-points.md"),
          mention.target,
          `Authored route ${mention.id} points to undeclared runtime target ${mention.target}.`,
          {
            expected: [...index.nodeIds, ...index.routes.keys()]
              .sort()
              .join(", "),
            observed: mention.target,
          },
        ),
      );
    }
    if (!route.nodeOrder.includes(mention.target)) {
      findings.push(
        finding(
          "contradictory-transition",
          mentionPath(documents, mention, "reference/decision-points.md"),
          mention.id,
          `Authored route ${mention.id} points to ${mention.target}, which is outside its declared node order.`,
          {
            expected: route.nodeOrder.join(" -> "),
            observed: mention.target,
          },
        ),
      );
    }
  }

  for (const mention of [...nextMentions, ...exitMentions, ...directedExits]) {
    if (isNegated(corpus, mention.index)) continue;
    if (!isSpecificRuntimeTarget(mention.id)) continue;
    if (!isKnownRuntimeTarget(index, mention.id)) {
      findings.push(
        finding(
          "hidden-exit",
          mentionPath(documents, mention, "SKILL.md"),
          mention.id,
          `Authored guidance introduces undeclared runtime exit ${mention.id}.`,
          {
            expected: [...index.nodeIds, ...index.routes.keys()]
              .sort()
              .join(", "),
            observed: mention.id,
          },
        ),
      );
    }
  }

  for (const document of documents) {
    const node = nodeForDocument(workflow, document.path);
    if (!node) continue;
    const nodeText = document.content;
    for (const mention of nextMentions) {
      if (!nodeText.includes(mention.line)) continue;
      if (isNegated(corpus, mention.index)) continue;
      if (
        isKnownRuntimeTarget(index, mention.id) &&
        !nodeCanReach(index, node.id, mention.id)
      ) {
        findings.push(
          finding(
            "contradictory-transition",
            document.path,
            node.id,
            `Authored guidance for ${node.id} names NEXT ${mention.id}, which is not a declared transition.`,
            {
              expected: index.transitions
                .filter((edge) => edge.from === node.id)
                .map((edge) => edge.to ?? "done")
                .sort()
                .join(", "),
              observed: mention.id,
            },
          ),
        );
      }
    }
  }

  for (const mention of [...exitMentions, ...directedExits]) {
    if (isNegated(corpus, mention.index)) continue;
    if (!isSpecificRuntimeTarget(mention.id)) continue;
    const document = documents.find((candidate) =>
      candidate.content.includes(mention.line),
    );
    const node = document
      ? nodeForDocument(workflow, document.path)
      : undefined;
    if (
      node &&
      isKnownRuntimeTarget(index, mention.id) &&
      !nodeCanReach(index, node.id, mention.id)
    ) {
      findings.push(
        finding(
          "contradictory-transition",
          document?.path ?? "SKILL.md",
          node.id,
          `Authored guidance for ${node.id} names ${mention.id}, which is not a declared outgoing transition.`,
          {
            expected: index.transitions
              .filter((edge) => edge.from === node.id)
              .map((edge) => edge.to ?? "done")
              .sort()
              .join(", "),
            observed: mention.id,
          },
        ),
      );
    }
  }

  for (const mention of skillMentions) {
    if (isNegated(corpus, mention.index)) continue;
    if (!isConcreteContractReference(mention.id)) continue;
    const declared = [...index.requiredSkillCalls.values()].some((skills) =>
      skills.has(mention.id),
    );
    if (!declared) {
      findings.push(
        finding(
          "undeclared-skill-call",
          mentionPath(documents, mention, "SKILL.md"),
          mention.id,
          `Authored guidance names undeclared Required Skill Call ${mention.id}.`,
          {
            expected: "a Required Skill Call declared by WorkflowProtocol",
            observed: mention.id,
          },
        ),
      );
    }
  }
  for (const mention of outputMentions) {
    if (isNegated(corpus, mention.index)) continue;
    if (!isConcreteContractReference(mention.id)) continue;
    if (!index.allOutputSchemas.has(mention.id)) {
      findings.push(
        finding(
          "undeclared-output-schema",
          mentionPath(documents, mention, "SKILL.md"),
          mention.id,
          `Authored guidance names undeclared Output Schema ${mention.id}.`,
          {
            expected: [...index.allOutputSchemas].sort().join(", "),
            observed: mention.id,
          },
        ),
      );
    }
  }
  for (const mention of guardrailMentions) {
    if (isNegated(corpus, mention.index)) continue;
    if (!isConcreteContractReference(mention.id)) continue;
    if (!index.allGuardrails.has(mention.id)) {
      findings.push(
        finding(
          "undeclared-guardrail",
          mentionPath(documents, mention, "SKILL.md"),
          mention.id,
          `Authored guidance names undeclared guardrail ${mention.id}.`,
          {
            expected: [...index.allGuardrails].sort().join(", "),
            observed: mention.id,
          },
        ),
      );
    }
  }

  return findings;
}

function validateNodeContracts(
  documents: readonly PreparedDocument[],
  index: ProtocolIndex,
  workflow: WorkflowProtocol,
): AuthoringCrossValidationFinding[] {
  const findings: AuthoringCrossValidationFinding[] = [];
  for (const node of index.activeNodes) {
    const document = documents.find(
      (candidate) => nodeForDocument(workflow, candidate.path)?.id === node.id,
    );
    const content = document?.content ?? "";
    const artifactPath = document?.path ?? nodePath(workflow, node);
    for (const binding of node.requiredSkillCalls) {
      const skill = binding.skill;
      if (!containsToken(content, skill)) {
        findings.push(
          finding(
            "missing-required-skill-call",
            artifactPath,
            `${node.id}:${skill}`,
            `Authored guidance omits Required Skill Call ${skill} for Node ${node.id}.`,
            { lens: "evidence-trace", expected: skill },
          ),
        );
      } else if (
        !containsAllOnLine(content, [skill, ...bindingContractTerms(binding)])
      ) {
        findings.push(
          finding(
            "incomplete-required-skill-call",
            artifactPath,
            `${node.id}:${skill}`,
            `Authored guidance does not preserve the operation, scope, and enforcement for Required Skill Call ${skill}.`,
            {
              lens: "contract-fit",
              expected: bindingContractTerms(binding).join(", "),
            },
          ),
        );
      }
    }
    for (const schema of index.outputSchemas.get(node.id) ?? []) {
      if (!containsAllOnLine(content, ["output schema", schema])) {
        findings.push(
          finding(
            "missing-output-schema",
            artifactPath,
            `${node.id}:${schema}`,
            `Authored guidance omits Output Schema ${schema} for Node ${node.id}.`,
            { lens: "evidence-trace", expected: schema },
          ),
        );
        continue;
      }
      const schemaDefinition = workflow.outputSchemas.find(
        (candidate) => candidate.id === schema,
      );
      const requiredFields = [
        ...(schemaDefinition?.artifacts ?? [])
          .filter((artifact) => artifact.required)
          .map((artifact) => artifact.id),
        ...(schemaDefinition?.evidence ?? [])
          .filter((evidence) => evidence.required)
          .map((evidence) => evidence.id),
      ];
      if (
        requiredFields.length > 0 &&
        !containsAllOnLine(content, [
          "output schema",
          schema,
          ...requiredFields,
        ])
      ) {
        findings.push(
          finding(
            "incomplete-output-schema",
            artifactPath,
            `${node.id}:${schema}`,
            `Authored guidance does not preserve required artifact and evidence fields for Output Schema ${schema}.`,
            {
              lens: "contract-fit",
              expected: requiredFields.join(", "),
            },
          ),
        );
      }
    }
    for (const guardrail of node.guardrails) {
      const guardrailReferences = [
        guardrail.id,
        ...(guardrail.verification?.id ? [guardrail.verification.id] : []),
      ];
      if (
        !guardrailReferences.some((reference) =>
          containsAllOnLine(content, ["guardrail", reference]),
        )
      ) {
        findings.push(
          finding(
            "missing-guardrail",
            artifactPath,
            `${node.id}:${guardrail.id}`,
            `Authored guidance omits guardrail ${guardrail.id} for Node ${node.id}.`,
            { lens: "evidence-trace", expected: guardrail.id },
          ),
        );
      }
      if (guardrail.verification) {
        const verificationKinds = Array.isArray(guardrail.verification.kind)
          ? guardrail.verification.kind
          : [guardrail.verification.kind];
        const verificationTerms = [
          guardrail.verification.role,
          ...verificationKinds,
        ];
        if (
          !containsAllOnLine(content, [guardrail.id, ...verificationTerms]) &&
          !(
            guardrail.verification.id &&
            containsAllOnLine(content, [
              guardrail.verification.id,
              ...verificationTerms,
            ])
          )
        ) {
          findings.push(
            finding(
              "incomplete-guardrail",
              artifactPath,
              `${node.id}:${guardrail.id}`,
              `Authored guidance does not preserve verification details for guardrail ${guardrail.id}.`,
              {
                lens: "contract-fit",
                expected: verificationTerms.join(", "),
              },
            ),
          );
        }
      }
    }
  }
  return findings;
}

function validateOwnership(
  documents: readonly PreparedDocument[],
  workflow: WorkflowProtocol,
  index: ProtocolIndex,
): AuthoringCrossValidationFinding[] {
  const findings: AuthoringCrossValidationFinding[] = [];
  const corpus = documentContent(documents);
  for (const document of documents) {
    const lines = document.content.split(/\r?\n/u);
    for (const line of lines) {
      const directState =
        DIRECT_STATE_REFERENCE.test(line) && DIRECT_STATE_ACTION.test(line);
      if (directState && !NEGATION.test(line)) {
        findings.push(
          finding(
            "direct-run-state-instruction",
            document.path,
            "WorkflowRuntime",
            "Authored guidance instructs a worker to mutate WorkflowRuntime Run state.",
            {
              severity: "critical",
              lens: "contract-fit",
              expected: "WorkflowRuntime owns Run state mutations",
              observed: line.trim(),
            },
          ),
        );
      }
    }
    for (const line of lines) {
      for (const match of line.matchAll(
        /\b(?:authoring|agent|provider|worker|caller|host|platform|application|system|adapter|router|orchestrator|controller|model|skill|operator|user|conversation\s+history|source\s+Skill)\b[^.!?\n]{0,60}\b(?:owns?|controls?|handles?|decides?|performs?)\b[^.!?\n]{0,40}\b(?:recovery|resume|state)\b/giu,
      )) {
        if (NEGATION.test(line.slice(0, match.index ?? 0))) continue;
        findings.push(
          finding(
            "alternate-recovery-authority",
            document.path,
            "WorkflowRuntime",
            "Authored guidance assigns recovery authority outside WorkflowRuntime.",
            {
              severity: "critical",
              expected: "WorkflowRuntime",
              observed: match[0].trim(),
            },
          ),
        );
      }
      for (const match of line.matchAll(
        /\b(?:recovery|resume|state)\b[^.!?\n]{0,50}\b(?:by|from|through)\b[^.!?\n]{0,30}\b(?:authoring|agent|provider|worker|caller|host|platform|application|system|adapter|router|orchestrator|controller|model|skill|operator|user|conversation\s+history|source\s+Skill)\b/giu,
      )) {
        if (NEGATION.test(line.slice(0, match.index ?? 0))) continue;
        findings.push(
          finding(
            "alternate-recovery-authority",
            document.path,
            "WorkflowRuntime",
            "Authored guidance assigns recovery authority outside WorkflowRuntime.",
            {
              severity: "critical",
              expected: "WorkflowRuntime",
              observed: match[0].trim(),
            },
          ),
        );
      }
      for (const match of line.matchAll(
        /\b(?:authoring|prose|agent|worker|provider)\b[^.!?\n]{0,60}\b(?:selects?|chooses?|decides?|determines?)\b[^.!?\n]{0,40}\b(?:route|transition|next\s+Node)\b/giu,
      )) {
        if (NEGATION.test(line.slice(0, match.index ?? 0))) continue;
        findings.push(
          finding(
            "alternate-route-authority",
            document.path,
            "WorkflowRuntime",
            "Authored guidance assigns route selection outside WorkflowRuntime.",
            {
              severity: "critical",
              expected: "WorkflowRuntime selects declared routes",
              observed: match[0].trim(),
            },
          ),
        );
      }
      for (const match of line.matchAll(
        /\b(?:route|transition|next\s+Node)\b[^.!?\n]{0,50}\b(?:by|from|through)\b[^.!?\n]{0,30}\b(?:authoring|prose|agent|worker|provider|host|platform|application|system|adapter|router|orchestrator|controller|model|skill|operator|user)\b/giu,
      )) {
        if (NEGATION.test(line.slice(0, match.index ?? 0))) continue;
        findings.push(
          finding(
            "alternate-route-authority",
            document.path,
            "WorkflowRuntime",
            "Authored guidance assigns route selection outside WorkflowRuntime.",
            {
              severity: "critical",
              expected: "WorkflowRuntime selects declared routes",
              observed: match[0].trim(),
            },
          ),
        );
      }
    }
  }

  const recoveryAuthorities = mentions(
    corpus,
    new RegExp(
      `\\brecovery\\s+authority\\s*[:=]\\s*\u0060?(${IDENTIFIER})\u0060?`,
      "giu",
    ),
  );
  for (const mention of recoveryAuthorities) {
    if (isNegated(corpus, mention.index)) continue;
    if (mention.id.toLocaleLowerCase() !== "workflowruntime") {
      findings.push(
        finding(
          "alternate-recovery-authority",
          "reference/recovery.md",
          "WorkflowRuntime",
          `Authored guidance declares ${mention.id} as recovery authority.`,
          {
            severity: "critical",
            expected: "WorkflowRuntime",
            observed: mention.id,
          },
        ),
      );
    }
  }

  const latestPattern =
    /\b(?:latest|newest|most\s+recent)\s+(?:artifact|version|output|result)\b/giu;
  for (const document of documents) {
    for (const match of document.content.matchAll(latestPattern)) {
      if (isNegated(document.content, match.index ?? 0)) continue;
      findings.push(
        finding(
          "implicit-latest-artifact",
          document.path,
          "artifact-selection",
          "Authored guidance selects an implicit latest artifact or version.",
          {
            severity: "critical",
            lens: "contract-fit",
            expected: "an exact accepted artifact version and content hash",
            observed: match[0],
          },
        ),
      );
    }
  }

  for (const node of workflow.nodes.filter(
    (candidate) => !candidate.disabled,
  )) {
    for (const schemaId of node.outputSchemas) {
      const schema = workflow.outputSchemas.find(
        (candidate) => candidate.id === schemaId,
      );
      if (!schema) continue;
      for (const artifact of schema.artifacts.filter(
        (candidate) => candidate.lifetime !== undefined,
      )) {
        const relevantDocuments = documents.filter(
          (document) =>
            containsToken(document.content, schema.id) ||
            containsToken(document.content, artifact.id),
        );
        const selectionText = relevantDocuments
          .flatMap((document) => document.content.split(/\r?\n/u))
          .filter(
            (line) =>
              containsToken(line, schema.id) ||
              containsToken(line, artifact.id),
          )
          .join("\n");
        const hasExactSelection =
          /\b(?:exact|accepted)\b[^\n.!?]{0,80}\b(?:version|hash)\b/iu.test(
            selectionText,
          );
        const hasProducerIdentity =
          /\b(?:producer|origin|provenance)\b[^\n.!?]{0,40}\b(?:identity|id|reference)\b/iu.test(
            selectionText,
          );
        if (!hasExactSelection || !hasProducerIdentity) {
          findings.push(
            finding(
              "artifact-selection-without-version",
              relevantDocuments[0]?.path ?? "reference/recovery.md",
              `${schema.id}.${artifact.id}`,
              `Authored guidance does not bind ${schema.id}.${artifact.id} to an exact accepted version, content hash, and producer identity.`,
              {
                lens: "evidence-trace",
                expected:
                  "exact accepted version, content hash, and producer identity",
              },
            ),
          );
        }
      }
    }
  }

  const recoveryDocument = documents.find(
    (document) =>
      normalizedDocumentPath(document.path) === "reference/recovery.md",
  );
  const recoveryAuthority =
    recoveryDocument &&
    (/\bRecovery\s+Authority\s*[:=]\s*\u0060?WorkflowRuntime\u0060?/iu.test(
      recoveryDocument.content,
    ) ||
      /\bWorkflowRuntime\b[^.!?\n]{0,60}\b(?:owns?|controls?|handles?|remains?|is)\b[^.!?\n]{0,30}\b(?:the\s+)?recovery\b/iu.test(
        recoveryDocument.content,
      ));
  if (!recoveryAuthority) {
    findings.push(
      finding(
        "missing-recovery-reference",
        "reference/recovery.md",
        "WorkflowRuntime",
        "Authored recovery guidance must identify WorkflowRuntime as the recovery authority.",
        { lens: "evidence-trace", expected: "WorkflowRuntime" },
      ),
    );
  }
  const durability = workflow.capabilities?.durability?.capabilities ?? [];
  const recoveryTerms: Array<[string, RegExp]> = [
    ["verification receipts", /verification\s+receipt/iu],
    ["repair policy", /repair\s+policy/iu],
    ["checkpoint", /checkpoint/iu],
    ["content snapshot", /content\s+snapshot/iu],
    ["finalization", /finalization/iu],
  ];
  for (const capability of durability) {
    const term = recoveryTerms.find(([label]) =>
      capability.replaceAll("-", " ").includes(label.replaceAll("-", " ")),
    );
    if (term && !term[1].test(corpus)) {
      findings.push(
        finding(
          "missing-recovery-reference",
          "reference/recovery.md",
          capability,
          `Authored recovery guidance omits the declared ${capability} recovery reference.`,
          { lens: "evidence-trace", expected: term[0] },
        ),
      );
    }
  }
  return findings;
}

function validateDocuments(
  workflow: WorkflowProtocol,
  documents: readonly AuthoredGuidanceDocument[],
  expectedWorkflowProtocolHash: string,
): AuthoringCrossValidationResult {
  const findings: AuthoringCrossValidationFinding[] = [];
  const prepared: PreparedDocument[] = [];
  const seen = new Set<string>();
  for (const document of documents) {
    const documentPath = normalizedDocumentPath(document.path);
    if (seen.has(documentPath)) {
      findings.push(
        finding(
          "duplicate-authored-document",
          documentPath,
          documentPath,
          `Authored guidance document is duplicated: ${documentPath}.`,
          { lens: "self-consistency" },
        ),
      );
      continue;
    }
    seen.add(documentPath);
    prepared.push({
      path: documentPath,
      content: semanticContent(document.content),
    });
  }
  const actualWorkflowProtocolHash = sha256(JSON.stringify(workflow));
  if (
    !HASH_PATTERN.test(expectedWorkflowProtocolHash) ||
    expectedWorkflowProtocolHash !== actualWorkflowProtocolHash
  ) {
    findings.push(
      finding(
        "workflow-protocol-hash-mismatch",
        "reference/workflow-protocol.json",
        "workflowProtocolHash",
        "Cross-validation input is not bound to the current WorkflowProtocol hash.",
        {
          severity: "critical",
          lens: "self-consistency",
          expected: actualWorkflowProtocolHash,
          observed: expectedWorkflowProtocolHash,
        },
      ),
    );
  }
  const index = protocolIndex(workflow);
  findings.push(...validateProtocolReferences(workflow, prepared, index));
  findings.push(...validateNodeContracts(prepared, index, workflow));
  findings.push(...validateOwnership(prepared, workflow, index));
  return finalizeResult(
    actualWorkflowProtocolHash,
    prepared.map((document) => document.path),
    findings,
  );
}

export function crossValidateAuthoredGuidance(
  options: CrossValidateAuthoredGuidanceOptions,
): AuthoringCrossValidationResult {
  if (
    !isRecord(options.workflow) ||
    options.workflow.kind !== "workflow-kernel" ||
    options.workflow.schemaVersion !== 1 ||
    !Array.isArray(options.workflow.nodes) ||
    !Array.isArray(options.workflow.edges) ||
    !Array.isArray(options.workflow.evals)
  ) {
    return finalizeResult(
      options.workflowProtocolHash ?? "0".repeat(64),
      options.documents.map((document) =>
        normalizedDocumentPath(document.path),
      ),
      [
        finding(
          "invalid-workflow-protocol",
          "reference/workflow-protocol.json",
          "WorkflowProtocol",
          "Cross-validation requires the current workflow-kernel protocol shape.",
          { severity: "critical", lens: "self-consistency" },
        ),
      ],
    );
  }
  return validateDocuments(
    options.workflow,
    options.documents,
    options.workflowProtocolHash ?? sha256(JSON.stringify(options.workflow)),
  );
}

function authoredSection(content: string, documentPath: string): string {
  const heading =
    documentPath === "SKILL.md"
      ? "Decision Core"
      : documentPath.endsWith("/SKILL.md")
        ? "Guidance"
        : undefined;
  if (!heading) return content;
  const headingPattern = new RegExp(`^##[ \\t]+${heading}[ \\t]*$`, "imu");
  const match = headingPattern.exec(content);
  if (!match) return content;
  const start = (match.index ?? 0) + match[0].length;
  const nextHeading = /^##\s+/mu.exec(content.slice(start));
  return content.slice(
    start,
    nextHeading ? start + nextHeading.index : undefined,
  );
}

function packageMissingFinding(
  documentPath: string,
): AuthoringCrossValidationFinding {
  return finding(
    "missing-authored-document",
    documentPath,
    documentPath,
    `Declared authored guidance document is missing: ${documentPath}.`,
    { lens: "evidence-trace" },
  );
}

export async function crossValidateAuthoringPackage(
  options: CrossValidateAuthoringPackageOptions,
): Promise<AuthoringCrossValidationResult> {
  const paths = options.plan.lanes.flatMap((lane) =>
    lane.contentLeaves.map((leaf) =>
      normalizedDocumentPath(packageRelativePath(leaf)),
    ),
  );
  const protocolPath = path.join(
    options.packageRoot,
    "reference",
    "workflow-protocol.json",
  );
  let workflow: WorkflowProtocol;
  try {
    workflow = JSON.parse(
      await fs.readFile(protocolPath, "utf8"),
    ) as WorkflowProtocol;
  } catch (error) {
    return finalizeResult(
      options.plan.workflowProtocolHash,
      [],
      [
        finding(
          "invalid-workflow-protocol",
          "reference/workflow-protocol.json",
          "WorkflowProtocol",
          `Generated WorkflowProtocol cannot be read: ${String(error)}.`,
          { severity: "critical", lens: "self-consistency" },
        ),
      ],
    );
  }
  const documents: AuthoredGuidanceDocument[] = [];
  const missing: AuthoringCrossValidationFinding[] = [];
  for (const documentPath of [...new Set(paths)].sort()) {
    try {
      const content = await fs.readFile(
        path.join(options.packageRoot, documentPath),
        "utf8",
      );
      documents.push({
        path: documentPath,
        content: authoredSection(content, documentPath),
      });
    } catch {
      missing.push(packageMissingFinding(documentPath));
    }
  }
  const result = crossValidateAuthoredGuidance({
    workflow,
    documents,
    workflowProtocolHash: options.plan.workflowProtocolHash,
  });
  return withAdditionalFindings(result, missing);
}
