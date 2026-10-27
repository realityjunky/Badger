import type { FactoryProposal } from "../types.js";
import {
  semanticDossierHash,
  validateSemanticDossier,
} from "../factory/questionnaire.js";
import { sha256, stableValue } from "../util.js";
import { createStandaloneWorkflowKernel } from "../workflow-kernel/foundation.js";
import {
  AUTHORING_PROTOCOL_HASH,
  authoringContentLeaves,
  authoringDag,
  authoringLaneClaims,
  authoringLaneIds,
  authoringLaneProjection,
  authoringLanesForWave,
  authoringLaneDependencies,
  matchesAuthoringSequence,
  authoringProtocolProjection,
  validateAuthoringProtocol,
} from "./protocol.js";
import type {
  AuthoringDepth,
  AuthoringLaneId,
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

function sourceEvidence(proposal: FactoryProposal): AuthoringSourceEvidence[] {
  return proposal.candidates.map((candidate) => ({
    name: candidate.name,
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
  const activeNodeIds = proposal.workflow.nodes
    .filter((node) => !node.disabled)
    .map((node) => node.id);
  return authoringLaneIds().map((id) => {
    const projection = authoringLaneProjection(id, {
      activeNodeIds,
      workflowName: proposal.name,
    });
    return {
      id: projection.id,
      dependencies: [...projection.dependencies],
      brief: projection.brief,
      claims: [...projection.claims],
      derivedClaims: [...projection.derivedClaims],
      contentLeaves: [...projection.contentLeaves],
      producesContentLeaves: projection.producesContentLeaves,
    };
  });
}

function planForProposal(
  options: DeriveAuthoringPlanOptions,
  source: AuthoringSourceEvidence[],
): Omit<AuthoringPlan, "authoringPlanHash"> {
  const depth: AuthoringDepth = options.depth ?? "quick";
  const protocol = authoringProtocolProjection();
  const settings = protocol.depth[depth];
  const lanes = laneDefinitions(options.proposal);
  const contentLeaves = [
    ...authoringContentLeaves({
      activeNodeIds: options.proposal.workflow.nodes
        .filter((node) => !node.disabled)
        .map((node) => node.id),
      workflowName: options.proposal.name,
    }),
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
    dag: authoringDag(),
    lanes,
    verify: {
      voters: settings.voters,
      lenses: [...protocol.verify.lenses],
      maxRounds: settings.maxRounds,
      dryThreshold: protocol.depth.dryThreshold,
      evidenceSource: settings.evidenceSource,
      loopUntilDry: protocol.verify.loopUntilDry,
    },
    merge: {
      deterministicBackbone: [...protocol.merge.deterministicBackbone],
      contentLeaves,
    },
    sourceEvidence: source,
    ...(options.proposal.upgradeSource
      ? { upgradeSource: structuredClone(options.proposal.upgradeSource) }
      : {}),
    ...(options.proposal.semanticDossier
      ? {
          semanticDossier: structuredClone(options.proposal.semanticDossier),
          semanticDossierHash: options.proposal.semanticDossierHash,
        }
      : {}),
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
  if (
    options.proposal.semanticDossierHash !== undefined &&
    options.proposal.semanticDossier === undefined
  ) {
    proposalFindings.push(
      diagnostic(
        "invalid-plan",
        "Semantic dossier identity requires its content",
        "proposal.semanticDossier",
      ),
    );
  }
  if (proposalFindings.length)
    throw new AuthoringPlanValidationError(proposalFindings);
  const source = sourceEvidence(options.proposal);
  const withoutHash = planForProposal(options, source);
  const plan: AuthoringPlan = {
    ...withoutHash,
    authoringPlanHash: sha256(JSON.stringify(stableValue(withoutHash))),
  };
  const diagnostics = validateAuthoringPlan(plan);
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
  const knownLaneIds = new Set<string>(authoringLaneIds());
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
    const canonicalLane = knownLaneIds.has(laneId)
      ? (laneId as AuthoringLaneId)
      : undefined;
    const expectedClaims = canonicalLane
      ? authoringLaneClaims(canonicalLane)
      : undefined;
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
    if (!arrayOfStrings(laneValue.contentLeaves)) {
      diagnostics.push(
        diagnostic(
          "invalid-content-leaves",
          `AuthoringPlan lane ${laneId} contentLeaves must be an array`,
          `${lanePath}.contentLeaves`,
        ),
      );
    }
    const expectedDependencies = canonicalLane
      ? authoringLaneDependencies(canonicalLane)
      : undefined;
    if (
      !arrayOfStrings(laneValue.dependencies) ||
      laneValue.dependencies.length !== expectedDependencies?.length ||
      laneValue.dependencies.some(
        (dependency, dependencyIndex) =>
          dependency !== expectedDependencies?.[dependencyIndex],
      )
    ) {
      diagnostics.push(
        diagnostic(
          "invalid-lane",
          `AuthoringPlan lane ${laneId} dependencies are invalid`,
          `${lanePath}.dependencies`,
        ),
      );
    }
    if (typeof laneValue.brief !== "string" || laneValue.brief.length === 0) {
      diagnostics.push(
        diagnostic(
          "invalid-lane",
          `AuthoringPlan lane ${laneId} brief is invalid`,
          `${lanePath}.brief`,
        ),
      );
    }
    if (!arrayOfStrings(laneValue.derivedClaims)) {
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
  const expectedLaneIds = [...authoringLaneIds()];
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
    const expected = authoringLanesForWave(key);
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
): AuthoringPlanDiagnostic[] {
  const diagnostics: AuthoringPlanDiagnostic[] = [];
  const protocol = authoringProtocolProjection();
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
    value.protocolHash !== protocol.hash
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
  validateLaneArray(value.lanes, diagnostics);
  if (!isRecord(value.verify))
    diagnostics.push(
      diagnostic(
        "invalid-verification",
        "AuthoringPlan.verify must be an object",
        "verify",
      ),
    );
  else {
    const expectedLenses = protocol.verify.lenses;
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
        ? protocol.depth[value.depth]
        : undefined;
    if (
      depthSettings &&
      (value.verify.voters !== depthSettings.voters ||
        value.verify.maxRounds !== depthSettings.maxRounds ||
        value.verify.dryThreshold !== protocol.depth.dryThreshold ||
        value.verify.evidenceSource !== depthSettings.evidenceSource ||
        value.verify.loopUntilDry !== protocol.verify.loopUntilDry)
    )
      diagnostics.push(
        diagnostic(
          "invalid-verification",
          "AuthoringPlan.verify does not match the selected depth",
          "verify",
        ),
      );
  }
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
        protocol.merge.deterministicBackbone.length ||
      value.merge.deterministicBackbone.some(
        (item, itemIndex) =>
          item !== protocol.merge.deterministicBackbone[itemIndex],
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
  for (const field of [
    "workflowProtocolHash",
    "planHash",
    "sourceEvidenceHash",
    "authoringPlanHash",
    "sourceEvidence",
  ]) {
    if (value[field] === undefined)
      diagnostics.push(
        diagnostic(
          "missing-field",
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
  for (const field of ["planHash", "sourceEvidenceHash", "authoringPlanHash"]) {
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
  if (
    value.semanticDossier !== undefined ||
    value.semanticDossierHash !== undefined
  ) {
    for (const finding of validateSemanticDossier(value.semanticDossier)) {
      diagnostics.push(
        diagnostic(
          "invalid-plan",
          finding.message,
          `semanticDossier.${finding.path}`,
        ),
      );
    }
    if (
      !validHash(value.semanticDossierHash) ||
      value.semanticDossierHash !== semanticDossierHash(value.semanticDossier)
    ) {
      diagnostics.push(
        diagnostic(
          "invalid-hash",
          "Semantic dossier hash does not match its content",
          "semanticDossierHash",
        ),
      );
    }
  }
  return diagnostics;
}

export function assertValidAuthoringPlan(
  value: unknown,
): asserts value is AuthoringPlan {
  const diagnostics = validateAuthoringPlan(value);
  if (diagnostics.length) throw new AuthoringPlanValidationError(diagnostics);
}

export { AUTHORING_PROTOCOL_HASH };
