import type { FactoryProposal } from "../types.js";
import { sha256, slug, stableValue } from "../util.js";
import { createStandaloneWorkflowKernel } from "../workflow-kernel/foundation.js";
import {
  AUTHORING_COMPATIBILITY,
  AUTHORING_DAG,
  AUTHORING_LANE_CLAIMS,
  AUTHORING_LANE_DEPENDENCIES,
  AUTHORING_LANE_IDS,
  AUTHORING_PROTOCOL,
  AUTHORING_PROTOCOL_HASH,
  matchesAuthoringSequence,
  validateAuthoringProtocol,
} from "./protocol.js";
import type {
  AuthoringDepth,
  AuthoringLane,
  AuthoringPlan,
  AuthoringPlanDiagnostic,
  AuthoringPlanDiagnosticCode,
  AuthoringSourceEvidence,
  DeriveAuthoringPlanOptions,
} from "./types.js";

const hashPattern = /^[a-f0-9]{64}$/u;

export class AuthoringPlanValidationError extends Error {
  readonly diagnostics: AuthoringPlanDiagnostic[];

  constructor(diagnostics: AuthoringPlanDiagnostic[]) {
    super(
      diagnostics.length
        ? diagnostics.map((diagnostic) => diagnostic.message).join("\n")
        : "AuthoringPlan is invalid",
    );
    this.name = "AuthoringPlanValidationError";
    this.diagnostics = diagnostics;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function diagnostic(
  code: AuthoringPlanDiagnosticCode,
  message: string,
  path?: string,
): AuthoringPlanDiagnostic {
  return { code, message, ...(path ? { path } : {}) };
}

function concreteNodeSkillPath(workflowName: string, nodeId: string): string {
  const workflowSlug = slug(workflowName) || "workflow";
  const nodeSlug = slug(nodeId) || "node";
  return `../${workflowSlug}-${nodeSlug}/SKILL.md`;
}

function sourceEvidence(proposal: FactoryProposal): AuthoringSourceEvidence[] {
  return proposal.candidates.map((candidate) => ({
    query: candidate.query,
    preferenceIndex: candidate.preferenceIndex,
    status: candidate.status,
    sources: candidate.sources.map((source) => ({
      name: source.name,
      root: source.root,
      origin: source.origin,
      description: source.description,
      references: source.references.map((reference) => ({ ...reference })),
      scripts: source.scripts.map((script) => ({ ...script })),
      hash: source.hash,
    })),
  }));
}

function validateUpgradeSource(
  value: unknown,
  diagnostics: AuthoringPlanDiagnostic[],
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    diagnostics.push(
      diagnostic(
        "invalid-plan",
        "AuthoringPlan.upgradeSource must be an object",
        "upgradeSource",
      ),
    );
    return;
  }
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "badger-upgrade-source" ||
    typeof value.root !== "string" ||
    !hashPattern.test(String(value.hash)) ||
    !Array.isArray(value.files)
  ) {
    diagnostics.push(
      diagnostic(
        "invalid-plan",
        "AuthoringPlan.upgradeSource evidence is invalid",
        "upgradeSource",
      ),
    );
  }
}

function proposalDiagnostics(
  proposal: FactoryProposal,
): AuthoringPlanDiagnostic[] {
  if (!proposal || typeof proposal !== "object") {
    return [
      diagnostic("blocked-proposal", "AuthoringPlan requires a proposal"),
    ];
  }
  const diagnostics: AuthoringPlanDiagnostic[] = [];
  if (
    !proposal.canInitialize ||
    !Array.isArray(proposal.blockers) ||
    proposal.blockers.length > 0
  ) {
    diagnostics.push(
      diagnostic(
        "blocked-proposal",
        `AuthoringPlan requires an unblocked proposal: ${proposal.blockers?.join("; ") || "proposal is not confirmed"}`,
        "proposal",
      ),
    );
  }
  if (!proposal.workflow || proposal.workflow.kind !== "workflow-kernel") {
    diagnostics.push(
      diagnostic(
        "blocked-proposal",
        "AuthoringPlan requires a normalized workflow-kernel proposal",
        "proposal.workflow",
      ),
    );
  }
  return diagnostics;
}

function laneDefinitions(proposal: FactoryProposal): AuthoringLane[] {
  const contentLeavesByLane: Record<string, string[]> = {
    script: [],
    reference: [],
    "pause-points": ["reference/decision-points.md", "reference/recovery.md"],
    "workflow-entry": ["SKILL.md"],
    "skill-core": proposal.workflow.nodes
      .filter((node) => !node.disabled)
      .map((node) => concreteNodeSkillPath(proposal.name, node.id)),
    "skill-review": ["reference/skill-review.md"],
  };
  return AUTHORING_LANE_IDS.map((id) => ({
    id,
    dependencies: [...AUTHORING_LANE_DEPENDENCIES[id]],
    brief: AUTHORING_PROTOCOL.lanes[id].brief,
    claims: [...AUTHORING_LANE_CLAIMS[id]],
    derivedClaims:
      id === "skill-core"
        ? proposal.workflow.nodes
            .filter((node) => !node.disabled)
            .map((node) => `skill-core:node-skill:${node.id}`)
        : [],
    contentLeaves: [...contentLeavesByLane[id]],
    producesContentLeaves:
      AUTHORING_PROTOCOL.lanes[id].producesContentLeaves.length > 0,
  }));
}

function planForProposal(
  options: DeriveAuthoringPlanOptions,
  source: AuthoringSourceEvidence[],
): Omit<AuthoringPlan, "authoringPlanHash"> {
  const depth: AuthoringDepth = options.depth ?? "quick";
  const settings = AUTHORING_PROTOCOL.depth[depth];
  const lanes = laneDefinitions(options.proposal);
  const contentLeaves = [
    "SKILL.md",
    ...lanes.find((lane) => lane.id === "skill-core")!.contentLeaves,
    "reference/decision-points.md",
    "reference/recovery.md",
    "reference/skill-review.md",
  ];
  const workflowProtocolHash = sha256(
    JSON.stringify(options.proposal.workflow),
  );
  const sourceEvidenceValue = options.proposal.upgradeSource
    ? {
        candidates: source,
        upgradeSource: options.proposal.upgradeSource,
      }
    : source;
  return {
    schemaVersion: 1,
    kind: "authoring-plan",
    name: options.proposal.name,
    depth,
    protocolHash: AUTHORING_PROTOCOL_HASH,
    workflowProtocolHash,
    planHash: options.proposal.planHash,
    sourceEvidenceHash: sha256(
      JSON.stringify(stableValue(sourceEvidenceValue)),
    ),
    dag: {
      wave1: [...AUTHORING_DAG.wave1],
      wave2: [...AUTHORING_DAG.wave2],
      barrier: [...AUTHORING_DAG.barrier],
    },
    lanes,
    verify: {
      voters: settings.voters,
      lenses: [...AUTHORING_PROTOCOL.verify.lenses],
      maxRounds: settings.maxRounds,
      dryThreshold: AUTHORING_PROTOCOL.depth.dryThreshold,
      evidenceSource: settings.evidenceSource,
      loopUntilDry: AUTHORING_PROTOCOL.verify.loopUntilDry,
    },
    merge: {
      deterministicBackbone: [
        ...AUTHORING_PROTOCOL.merge.deterministicBackbone,
      ],
      contentLeaves,
    },
    sourceEvidence: source,
    ...(options.proposal.upgradeSource
      ? { upgradeSource: structuredClone(options.proposal.upgradeSource) }
      : {}),
    compatibility: structuredClone(AUTHORING_COMPATIBILITY),
  };
}

export function deriveAuthoringPlan(
  options: DeriveAuthoringPlanOptions,
): AuthoringPlan {
  if (options.depth !== undefined && !["quick", "full"].includes(options.depth))
    throw new AuthoringPlanValidationError([
      diagnostic(
        "invalid-plan",
        "AuthoringPlan.depth must be quick or full",
        "depth",
      ),
    ]);
  const proposalFindings = proposalDiagnostics(options.proposal);
  if (proposalFindings.length)
    throw new AuthoringPlanValidationError(proposalFindings);
  const source = sourceEvidence(options.proposal);
  const withoutHash = planForProposal(options, source);
  const plan: AuthoringPlan = {
    ...withoutHash,
    authoringPlanHash: sha256(JSON.stringify(stableValue(withoutHash))),
  };
  const diagnostics = validateAuthoringPlan(plan, { requireExtensions: true });
  if (diagnostics.length) throw new AuthoringPlanValidationError(diagnostics);
  return plan;
}

export type BuildAuthoringPlanOptions =
  | DeriveAuthoringPlanOptions
  | {
      projectRoot: string;
      name: string;
      depth?: AuthoringDepth;
    };

export async function buildAuthoringPlan(
  options: BuildAuthoringPlanOptions,
): Promise<AuthoringPlan> {
  if ("proposal" in options) return deriveAuthoringPlan(options);
  const kernel = createStandaloneWorkflowKernel({
    projectRoot: options.projectRoot,
  });
  const state = await kernel.readState(options.name);
  if (!state.confirmedProposal)
    throw new Error(
      `Creator state ${options.name} has no confirmed normalized proposal; rerun init with --confirm`,
    );
  return deriveAuthoringPlan({
    proposal: state.confirmedProposal,
    depth: options.depth,
  });
}

export const previewAuthoringPlan = buildAuthoringPlan;

function validHash(value: unknown): boolean {
  return typeof value === "string" && hashPattern.test(value);
}

function arrayOfStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function validateLaneArray(
  value: unknown,
  diagnostics: AuthoringPlanDiagnostic[],
  requireExtensions: boolean,
): value is AuthoringLane[] {
  if (!Array.isArray(value)) {
    diagnostics.push(
      diagnostic(
        "invalid-lane",
        "AuthoringPlan.lanes must be an array",
        "lanes",
      ),
    );
    return false;
  }
  const laneIds: string[] = [];
  const knownLaneIds = new Set<string>(AUTHORING_LANE_IDS);
  for (const [index, laneValue] of value.entries()) {
    const lanePath = `lanes[${index}]`;
    if (!isRecord(laneValue) || typeof laneValue.id !== "string") {
      diagnostics.push(
        diagnostic(
          "invalid-lane",
          `AuthoringPlan lane at index ${index} must have a string id`,
          lanePath,
        ),
      );
      continue;
    }
    const laneId = laneValue.id;
    laneIds.push(laneId);
    if (!knownLaneIds.has(laneId)) {
      diagnostics.push(
        diagnostic(
          "unknown-lane",
          `Unknown authoring lane: ${laneId}`,
          `${lanePath}.id`,
        ),
      );
    }
    if (laneIds.indexOf(laneId) !== laneIds.lastIndexOf(laneId)) {
      diagnostics.push(
        diagnostic(
          "duplicate-lane",
          `Duplicate authoring lane: ${laneId}`,
          `${lanePath}.id`,
        ),
      );
    }
    const expectedClaims =
      AUTHORING_LANE_CLAIMS[laneId as keyof typeof AUTHORING_LANE_CLAIMS];
    if (!arrayOfStrings(laneValue.claims)) {
      diagnostics.push(
        diagnostic(
          "invalid-claims",
          `AuthoringPlan lane ${laneId} claims must be an array`,
          `${lanePath}.claims`,
        ),
      );
    } else if (
      expectedClaims &&
      !matchesAuthoringSequence(laneValue.claims, expectedClaims)
    ) {
      diagnostics.push(
        diagnostic(
          "invalid-claims",
          `AuthoringPlan lane ${laneId} claims do not match the canonical contract`,
          `${lanePath}.claims`,
        ),
      );
    }
    if (requireExtensions && !arrayOfStrings(laneValue.contentLeaves)) {
      diagnostics.push(
        diagnostic(
          "invalid-content-leaves",
          `AuthoringPlan lane ${laneId} contentLeaves must be an array`,
          `${lanePath}.contentLeaves`,
        ),
      );
    }
    const expectedDependencies =
      AUTHORING_LANE_DEPENDENCIES[
        laneId as keyof typeof AUTHORING_LANE_DEPENDENCIES
      ];
    if (
      (requireExtensions && laneValue.dependencies === undefined) ||
      (laneValue.dependencies !== undefined &&
        (!arrayOfStrings(laneValue.dependencies) ||
          laneValue.dependencies.length !== expectedDependencies?.length ||
          laneValue.dependencies?.some(
            (dependency, dependencyIndex) =>
              dependency !== expectedDependencies?.[dependencyIndex],
          )))
    ) {
      diagnostics.push(
        diagnostic(
          "invalid-lane",
          `AuthoringPlan lane ${laneId} dependencies are invalid`,
          `${lanePath}.dependencies`,
        ),
      );
    }
    if (
      (requireExtensions || laneValue.brief !== undefined) &&
      (typeof laneValue.brief !== "string" || laneValue.brief.length === 0)
    ) {
      diagnostics.push(
        diagnostic(
          "invalid-lane",
          `AuthoringPlan lane ${laneId} brief is invalid`,
          `${lanePath}.brief`,
        ),
      );
    }
    if (requireExtensions && !arrayOfStrings(laneValue.derivedClaims)) {
      diagnostics.push(
        diagnostic(
          "invalid-claims",
          `AuthoringPlan lane ${laneId} derivedClaims must be an array`,
          `${lanePath}.derivedClaims`,
        ),
      );
    }
    if (typeof laneValue.producesContentLeaves !== "boolean") {
      diagnostics.push(
        diagnostic(
          "invalid-content-leaves",
          `AuthoringPlan lane ${laneId} producesContentLeaves must be a boolean`,
          `${lanePath}.producesContentLeaves`,
        ),
      );
    }
  }
  const expectedLaneIds = [...AUTHORING_LANE_IDS];
  if (
    laneIds.length !== expectedLaneIds.length ||
    laneIds.some((laneId, index) => laneId !== expectedLaneIds[index])
  ) {
    diagnostics.push(
      diagnostic(
        "lane-order",
        "AuthoringPlan lanes are not in canonical order",
        "lanes",
      ),
    );
  }
  return true;
}

function validateDag(
  value: unknown,
  diagnostics: AuthoringPlanDiagnostic[],
): void {
  if (!isRecord(value)) {
    diagnostics.push(
      diagnostic("invalid-dag", "AuthoringPlan.dag must be an object", "dag"),
    );
    return;
  }
  for (const key of ["wave1", "wave2", "barrier"] as const) {
    const expected = AUTHORING_DAG[key];
    if (
      !Array.isArray(value[key]) ||
      value[key].some((laneId) => typeof laneId !== "string")
    ) {
      diagnostics.push(
        diagnostic(
          "invalid-dag",
          `AuthoringPlan.dag.${key} must be a lane array`,
          `dag.${key}`,
        ),
      );
    } else if (
      value[key].length !== expected.length ||
      value[key].some((laneId, index) => laneId !== expected[index])
    ) {
      diagnostics.push(
        diagnostic(
          "invalid-dag",
          `AuthoringPlan.dag.${key} does not match the canonical lane DAG`,
          `dag.${key}`,
        ),
      );
    }
  }
}

export function validateAuthoringPlan(
  value: unknown,
  options: { requireExtensions?: boolean } = {},
): AuthoringPlanDiagnostic[] {
  const diagnostics: AuthoringPlanDiagnostic[] = [];
  if (!isRecord(value)) {
    return [diagnostic("invalid-plan", "AuthoringPlan must be an object")];
  }
  if (value.schemaVersion !== 1)
    diagnostics.push(
      diagnostic(
        "invalid-plan",
        "AuthoringPlan.schemaVersion must be 1",
        "schemaVersion",
      ),
    );
  if (value.kind !== undefined && value.kind !== "authoring-plan")
    diagnostics.push(
      diagnostic(
        "invalid-plan",
        "AuthoringPlan.kind must be authoring-plan",
        "kind",
      ),
    );
  if (typeof value.name !== "string" || value.name.length === 0)
    diagnostics.push(
      diagnostic(
        "invalid-plan",
        "AuthoringPlan.name must be a non-empty string",
        "name",
      ),
    );
  if (value.depth !== "quick" && value.depth !== "full")
    diagnostics.push(
      diagnostic(
        "invalid-plan",
        "AuthoringPlan.depth must be quick or full",
        "depth",
      ),
    );
  if (
    typeof value.protocolHash !== "string" ||
    value.protocolHash !== AUTHORING_PROTOCOL_HASH
  )
    diagnostics.push(
      diagnostic(
        "invalid-hash",
        "AuthoringPlan.protocolHash does not match the canonical AuthoringProtocol",
        "protocolHash",
      ),
    );
  validateDag(value.dag, diagnostics);
  validateUpgradeSource(value.upgradeSource, diagnostics);
  const requireExtensions = options.requireExtensions === true;
  validateLaneArray(value.lanes, diagnostics, requireExtensions);
  if (!isRecord(value.verify))
    diagnostics.push(
      diagnostic(
        "invalid-verification",
        "AuthoringPlan.verify must be an object",
        "verify",
      ),
    );
  else {
    const expectedLenses = AUTHORING_PROTOCOL.verify.lenses;
    if (
      !arrayOfStrings(value.verify.lenses) ||
      value.verify.lenses.length !== expectedLenses.length ||
      value.verify.lenses.some(
        (lens, lensIndex) => lens !== expectedLenses[lensIndex],
      )
    )
      diagnostics.push(
        diagnostic(
          "invalid-verification",
          "AuthoringPlan.verify.lenses do not match the canonical contract",
          "verify.lenses",
        ),
      );
    const depthSettings =
      value.depth === "quick" || value.depth === "full"
        ? AUTHORING_PROTOCOL.depth[value.depth]
        : undefined;
    if (
      depthSettings &&
      (value.verify.voters !== depthSettings.voters ||
        value.verify.maxRounds !== depthSettings.maxRounds ||
        value.verify.dryThreshold !== AUTHORING_PROTOCOL.depth.dryThreshold ||
        (requireExtensions &&
          (value.verify.evidenceSource !== depthSettings.evidenceSource ||
            value.verify.loopUntilDry !==
              AUTHORING_PROTOCOL.verify.loopUntilDry)))
    )
      diagnostics.push(
        diagnostic(
          "invalid-verification",
          "AuthoringPlan.verify does not match the selected depth",
          "verify",
        ),
      );
  }
  if (value.merge === undefined && !requireExtensions) return diagnostics;
  if (!isRecord(value.merge))
    diagnostics.push(
      diagnostic(
        "invalid-plan",
        "AuthoringPlan.merge must be an object",
        "merge",
      ),
    );
  else {
    if (
      !arrayOfStrings(value.merge.deterministicBackbone) ||
      value.merge.deterministicBackbone.length !==
        AUTHORING_PROTOCOL.merge.deterministicBackbone.length ||
      value.merge.deterministicBackbone.some(
        (item, itemIndex) =>
          item !== AUTHORING_PROTOCOL.merge.deterministicBackbone[itemIndex],
      )
    )
      diagnostics.push(
        diagnostic(
          "invalid-plan",
          "AuthoringPlan.merge.deterministicBackbone is invalid",
          "merge.deterministicBackbone",
        ),
      );
    if (!arrayOfStrings(value.merge.contentLeaves))
      diagnostics.push(
        diagnostic(
          "invalid-content-leaves",
          "AuthoringPlan.merge.contentLeaves must be an array",
          "merge.contentLeaves",
        ),
      );
    else if (
      !value.merge.contentLeaves.includes("SKILL.md") ||
      !value.merge.contentLeaves.includes("reference/decision-points.md") ||
      !value.merge.contentLeaves.includes("reference/recovery.md") ||
      !value.merge.contentLeaves.includes("reference/skill-review.md")
    )
      diagnostics.push(
        diagnostic(
          "invalid-content-leaves",
          "AuthoringPlan.merge.contentLeaves is incomplete",
          "merge.contentLeaves",
        ),
      );
  }
  if (requireExtensions) {
    for (const field of [
      "workflowProtocolHash",
      "planHash",
      "sourceEvidenceHash",
      "authoringPlanHash",
      "sourceEvidence",
      "compatibility",
    ]) {
      if (value[field] === undefined)
        diagnostics.push(
          diagnostic(
            "missing-extension",
            `AuthoringPlan.${field} is required for Badger previews`,
            field,
          ),
        );
    }
    if (value.workflowProtocolHash !== undefined) {
      if (!validHash(value.workflowProtocolHash))
        diagnostics.push(
          diagnostic(
            "invalid-hash",
            "AuthoringPlan.workflowProtocolHash must be a SHA-256 hash",
            "workflowProtocolHash",
          ),
        );
      else if (value.workflowProtocolHash === value.protocolHash)
        diagnostics.push(
          diagnostic(
            "identical-protocol-hashes",
            "AuthoringPlan protocolHash and workflowProtocolHash must identify different protocols",
            "workflowProtocolHash",
          ),
        );
    }
    for (const field of [
      "planHash",
      "sourceEvidenceHash",
      "authoringPlanHash",
    ]) {
      if (value[field] !== undefined && !validHash(value[field]))
        diagnostics.push(
          diagnostic(
            "invalid-hash",
            `AuthoringPlan.${field} must be a SHA-256 hash`,
            field,
          ),
        );
    }
    if (
      value.sourceEvidence !== undefined &&
      !Array.isArray(value.sourceEvidence)
    )
      diagnostics.push(
        diagnostic(
          "invalid-plan",
          "AuthoringPlan.sourceEvidence must be an array",
          "sourceEvidence",
        ),
      );
    if (!isRecord(value.compatibility))
      diagnostics.push(
        diagnostic(
          "invalid-plan",
          "AuthoringPlan.compatibility must be an object",
          "compatibility",
        ),
      );
  }
  return diagnostics;
}

export function assertValidAuthoringPlan(
  value: unknown,
  options: { requireExtensions?: boolean } = {},
): asserts value is AuthoringPlan {
  const diagnostics = validateAuthoringPlan(value, options);
  if (diagnostics.length) throw new AuthoringPlanValidationError(diagnostics);
}

export { AUTHORING_PROTOCOL_HASH };
