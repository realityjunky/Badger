import { sha256, slug, stableValue } from "../util.js";
import type {
  AuthoringControlPlaneScript,
  AuthoringDag,
  AuthoringLaneId,
  AuthoringLaneProjection,
  AuthoringLaneProjectionOptions,
  AuthoringPlanDiagnostic,
  AuthoringProtocol,
  AuthoringProtocolProjection,
  AuthoringWaveId,
} from "./types.js";

export const AUTHORING_LANE_IDS = [
  "script",
  "reference",
  "pause-points",
  "workflow-entry",
  "skill-core",
  "skill-review",
] as const satisfies readonly AuthoringLaneId[];

export const AUTHORING_DAG = {
  wave1: ["script", "reference", "pause-points"],
  wave2: ["workflow-entry", "skill-core"],
  barrier: ["skill-review"],
} as const satisfies AuthoringDag;

export const AUTHORING_LANE_CLAIMS = {
  script: [
    "script:workflow-state",
    "script:workflow-guard",
    "script:workflow-handoff",
    "script:badger-plan",
    "script:badger-check",
    "script:badger-hook-guard",
  ],
  reference: [
    "reference:workflow-protocol",
    "reference:resolved-skills",
    "reference:composition-report",
    "reference:authoring-lanes",
  ],
  "pause-points": ["pause:decision-points", "pause:recovery"],
  "workflow-entry": ["workflow-entry"],
  "skill-core": [],
  "skill-review": ["review:skill-review"],
} as const satisfies Record<AuthoringLaneId, readonly string[]>;

const AUTHORING_LANE_BRIEFS: Record<AuthoringLaneId, string> = {
  script: "reference/subagents/script-author.md",
  reference: "reference/subagents/reference-author.md",
  "pause-points": "reference/subagents/pause-points-author.md",
  "workflow-entry": "reference/subagents/workflow-entry-author.md",
  "skill-core": "reference/subagents/skill-core-author.md",
  "skill-review": "reference/subagents/skill-reviewer.md",
};

export const AUTHORING_LANE_DEPENDENCIES: Record<
  AuthoringLaneId,
  readonly AuthoringLaneId[]
> = {
  script: [],
  reference: [],
  "pause-points": [],
  "workflow-entry": ["script"],
  "skill-core": ["script"],
  "skill-review": [
    "script",
    "reference",
    "pause-points",
    "workflow-entry",
    "skill-core",
  ],
};

const AUTHORING_PROTOCOL_CONTENT_LEAVES: Record<
  AuthoringLaneId,
  readonly string[]
> = {
  script: [],
  reference: [],
  "pause-points": ["reference/decision-points.md", "reference/recovery.md"],
  "workflow-entry": ["SKILL.md"],
  "skill-core": ["../<node-skill>/SKILL.md"],
  "skill-review": ["reference/skill-review.md"],
};

export const AUTHORING_CONTROL_PLANE_SCRIPTS = [
  {
    id: "workflow-state",
    role: "workflow-state",
    kind: "runtime-adapter",
    path: "scripts/workflow-state.mjs",
    claim: "script:workflow-state",
    authority: "WorkflowRuntime",
  },
  {
    id: "workflow-guard",
    role: "workflow-guard",
    kind: "runtime-adapter",
    path: "scripts/workflow-guard.mjs",
    claim: "script:workflow-guard",
    authority: "WorkflowRuntime",
  },
  {
    id: "workflow-handoff",
    role: "workflow-handoff",
    kind: "runtime-adapter",
    path: "scripts/workflow-handoff.mjs",
    claim: "script:workflow-handoff",
    authority: "WorkflowRuntime",
  },
  {
    id: "badger-plan",
    role: "badger-plan",
    kind: "plan",
    path: "scripts/badger-plan.mjs",
    claim: "script:badger-plan",
    authority: "Badger assembler",
  },
  {
    id: "badger-check",
    role: "badger-check",
    kind: "check",
    path: "scripts/badger-check.mjs",
    claim: "script:badger-check",
    authority: "Badger assembler",
  },
  {
    id: "badger-hook-guard",
    role: "badger-hook-guard",
    kind: "hook-guard",
    path: "scripts/badger-hook-guard.mjs",
    claim: "script:badger-hook-guard",
    authority: "Badger assembler",
  },
] as const satisfies readonly AuthoringControlPlaneScript[];

export const AUTHORING_DETERMINISTIC_BACKBONE = [
  "reference/workflow-protocol.json",
  "reference/resolved-skills.json",
  "reference/authoring-plan.json",
  "reference/authoring-lanes.json",
  "reference/composition-report.md",
  "reference/eval-manifest.json",
  "reference/package-inventory.json",
  "scripts/workflow-runtime.mjs",
  "scripts/workflow-state.mjs",
  "scripts/workflow-guard.mjs",
  "scripts/workflow-handoff.mjs",
  "scripts/badger-plan.mjs",
  "scripts/badger-check.mjs",
  "scripts/badger-hook-guard.mjs",
  "badger/skill.yaml",
  "badger/guardrails.yaml",
  "badger/checks.yaml",
  "badger/eval.yaml",
] as const;

export const AUTHORING_PROTOCOL = {
  schemaVersion: 1,
  description:
    "Deterministic authoring contract for /badger-create. The main session interprets this protocol, symmetric to how runtime scripts interpret workflow-protocol.json.",
  depth: {
    quick: { voters: 1, maxRounds: 1, evidenceSource: "llm-single" },
    full: { voters: 3, maxRounds: 4, evidenceSource: "llm-multivote" },
    dryThreshold: 2,
  },
  dag: AUTHORING_DAG,
  lanes: Object.fromEntries(
    AUTHORING_LANE_IDS.map((id) => [
      id,
      {
        brief: AUTHORING_LANE_BRIEFS[id],
        claims: [...AUTHORING_LANE_CLAIMS[id]],
        producesContentLeaves: [...AUTHORING_PROTOCOL_CONTENT_LEAVES[id]],
      },
    ]),
  ) as Record<
    AuthoringLaneId,
    {
      brief: string;
      claims: string[];
      producesContentLeaves: string[];
    }
  >,
  verify: {
    lenses: ["contract-fit", "usability", "evidence-trace", "self-consistency"],
    loopUntilDry: true,
  },
  merge: {
    deterministicBackbone: [...AUTHORING_DETERMINISTIC_BACKBONE],
    contentLeaves: [
      "SKILL.md",
      "../<node-skill>/SKILL.md",
      "reference/decision-points.md",
      "reference/recovery.md",
      "reference/skill-review.md",
    ],
  },
} satisfies AuthoringProtocol;

function waveForLane(
  lane: AuthoringLaneId,
  dag: AuthoringDag = AUTHORING_DAG,
): AuthoringWaveId {
  for (const wave of ["wave1", "wave2", "barrier"] as const) {
    if (dag[wave].includes(lane)) return wave;
  }
  throw new Error(`Authoring lane is not assigned to a wave: ${lane}`);
}

function concreteNodeSkillPath(workflowName: string, nodeId: string): string {
  return `../${slug(workflowName) || "workflow"}-${slug(nodeId) || "node"}/SKILL.md`;
}

function projectionDerivedClaims(
  lane: AuthoringLaneId,
  options: AuthoringLaneProjectionOptions,
): readonly string[] {
  if (options.derivedClaims) return [...options.derivedClaims];
  if (lane !== "skill-core" || !options.activeNodeIds) return [];
  return options.activeNodeIds.map(
    (nodeId) => `skill-core:node-skill:${nodeId}`,
  );
}

function projectionContentLeaves(
  lane: AuthoringLaneId,
  options: AuthoringLaneProjectionOptions,
): readonly string[] {
  if (options.laneContentLeaves?.[lane]) {
    return [...options.laneContentLeaves[lane]!];
  }
  if (options.contentLeaves) return [...options.contentLeaves];
  if (lane !== "skill-core" || !options.activeNodeIds) {
    return [...AUTHORING_PROTOCOL_CONTENT_LEAVES[lane]];
  }
  return options.activeNodeIds.map((nodeId) =>
    concreteNodeSkillPath(options.workflowName ?? "workflow", nodeId),
  );
}

export function authoringLaneIds(): readonly AuthoringLaneId[] {
  return [...AUTHORING_LANE_IDS];
}

export function authoringDag(): AuthoringDag {
  return {
    wave1: [...AUTHORING_DAG.wave1],
    wave2: [...AUTHORING_DAG.wave2],
    barrier: [...AUTHORING_DAG.barrier],
  };
}

export function authoringLanesForWave(
  wave: AuthoringWaveId,
): readonly AuthoringLaneId[] {
  return [...AUTHORING_DAG[wave]];
}

export function authoringLaneWave(lane: AuthoringLaneId): AuthoringWaveId {
  return waveForLane(lane);
}

export function authoringLaneBrief(lane: AuthoringLaneId): string {
  return AUTHORING_LANE_BRIEFS[lane];
}

export function authoringLaneProjection(
  lane: AuthoringLaneId,
  options: AuthoringLaneProjectionOptions = {},
): AuthoringLaneProjection {
  const derivedClaims = projectionDerivedClaims(lane, options);
  return {
    id: lane,
    wave: waveForLane(lane),
    dependencies: [...AUTHORING_LANE_DEPENDENCIES[lane]],
    brief: AUTHORING_LANE_BRIEFS[lane],
    claims: [...AUTHORING_LANE_CLAIMS[lane]],
    derivedClaims: [...derivedClaims],
    contentLeaves: [...projectionContentLeaves(lane, options)],
    producesContentLeaves: AUTHORING_PROTOCOL_CONTENT_LEAVES[lane].length > 0,
  };
}

export function authoringLaneClaims(
  lane: AuthoringLaneId,
  options: AuthoringLaneProjectionOptions = {},
): readonly string[] {
  return authoringLaneProjection(lane, options).claims;
}

export function authoringLaneDerivedClaims(
  lane: AuthoringLaneId,
  options: AuthoringLaneProjectionOptions = {},
): readonly string[] {
  return authoringLaneProjection(lane, options).derivedClaims;
}

export function authoringLaneClaimIds(
  lane: AuthoringLaneId,
  options: AuthoringLaneProjectionOptions = {},
): readonly string[] {
  const projection = authoringLaneProjection(lane, options);
  return [...projection.claims, ...projection.derivedClaims];
}

export function authoringLaneDependencies(
  lane: AuthoringLaneId,
): readonly AuthoringLaneId[] {
  return [...AUTHORING_LANE_DEPENDENCIES[lane]];
}

export function authoringLaneContentLeaves(
  lane: AuthoringLaneId,
  options: AuthoringLaneProjectionOptions = {},
): readonly string[] {
  return authoringLaneProjection(lane, options).contentLeaves;
}

export function authoringContentLeaves(
  options: AuthoringLaneProjectionOptions = {},
): readonly string[] {
  return [
    ...authoringLaneContentLeaves("workflow-entry", options),
    ...authoringLaneContentLeaves("skill-core", options),
    ...authoringLaneContentLeaves("pause-points", options),
    ...authoringLaneContentLeaves("skill-review", options),
  ];
}

export function authoringDependencyClosure(
  lanes: AuthoringLaneId | readonly AuthoringLaneId[],
): readonly AuthoringLaneId[] {
  const closure = new Set<AuthoringLaneId>(
    typeof lanes === "string" ? [lanes] : lanes,
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const lane of AUTHORING_LANE_IDS) {
      for (const dependency of AUTHORING_LANE_DEPENDENCIES[lane]) {
        if (closure.has(lane) && !closure.has(dependency)) {
          closure.add(dependency);
          changed = true;
        }
      }
    }
  }
  return AUTHORING_LANE_IDS.filter((lane) => closure.has(lane));
}

export function authoringAffectedLanes(
  lane: AuthoringLaneId,
): readonly AuthoringLaneId[] {
  const affected = new Set<AuthoringLaneId>([lane]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of AUTHORING_LANE_IDS) {
      if (
        !affected.has(candidate) &&
        AUTHORING_LANE_DEPENDENCIES[candidate].some((dependency) =>
          affected.has(dependency),
        )
      ) {
        affected.add(candidate);
        changed = true;
      }
    }
  }
  return AUTHORING_LANE_IDS.filter((candidate) => affected.has(candidate));
}

export function authoringDependentLanes(
  lane: AuthoringLaneId,
): readonly AuthoringLaneId[] {
  return authoringAffectedLanes(lane).filter((candidate) => candidate !== lane);
}

export function authoringContentLeafOwners(
  options: AuthoringLaneProjectionOptions = {},
): Readonly<Record<string, AuthoringLaneId>> {
  const owners: Record<string, AuthoringLaneId> = {};
  for (const lane of AUTHORING_LANE_IDS) {
    for (const contentLeaf of authoringLaneContentLeaves(lane, options)) {
      const packagePath = contentLeaf.startsWith("../")
        ? contentLeaf.slice(3)
        : contentLeaf;
      const previousOwner = owners[packagePath];
      if (previousOwner && previousOwner !== lane) {
        throw new Error(
          `Authoring content leaf has multiple owners: ${packagePath}`,
        );
      }
      owners[packagePath] = lane;
    }
  }
  return owners;
}

function protocolProjectionValue(
  protocol: AuthoringProtocol,
): Omit<AuthoringProtocolProjection, "hash"> {
  const lanes = Object.fromEntries(
    AUTHORING_LANE_IDS.map((lane) => {
      const definition = protocol.lanes[lane];
      return [
        lane,
        {
          id: lane,
          wave: waveForLane(lane, protocol.dag),
          dependencies: [...AUTHORING_LANE_DEPENDENCIES[lane]],
          brief: definition.brief,
          claims: [...definition.claims],
          derivedClaims: [],
          contentLeaves: [...definition.producesContentLeaves],
          producesContentLeaves: definition.producesContentLeaves.length > 0,
        } satisfies AuthoringLaneProjection,
      ];
    }),
  ) as unknown as Record<AuthoringLaneId, AuthoringLaneProjection>;
  return {
    schemaVersion: 1,
    description: protocol.description,
    depth: {
      quick: { ...protocol.depth.quick },
      full: { ...protocol.depth.full },
      dryThreshold: protocol.depth.dryThreshold,
    },
    dag: {
      wave1: [...protocol.dag.wave1],
      wave2: [...protocol.dag.wave2],
      barrier: [...protocol.dag.barrier],
    },
    lanes,
    verify: {
      lenses: [...protocol.verify.lenses],
      loopUntilDry: protocol.verify.loopUntilDry,
    },
    merge: {
      deterministicBackbone: [...protocol.merge.deterministicBackbone],
      contentLeaves: [...protocol.merge.contentLeaves],
    },
    controlPlaneScripts: AUTHORING_CONTROL_PLANE_SCRIPTS.map((script) => ({
      ...script,
    })),
    deterministicBackbone: [...AUTHORING_DETERMINISTIC_BACKBONE],
  };
}

export function hashAuthoringProtocol(
  value?:
    | AuthoringProtocol
    | AuthoringProtocolProjection
    | Omit<AuthoringProtocolProjection, "hash">,
): string {
  const projection = value
    ? "controlPlaneScripts" in value
      ? Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== "hash"),
        )
      : protocolProjectionValue(value)
    : protocolProjectionValue(AUTHORING_PROTOCOL);
  return sha256(JSON.stringify(stableValue(projection)));
}

export const AUTHORING_PROTOCOL_HASH = hashAuthoringProtocol();

export function authoringProtocolProjection(
  options: AuthoringLaneProjectionOptions = {},
): AuthoringProtocolProjection {
  const base = protocolProjectionValue(AUTHORING_PROTOCOL);
  const lanes = Object.fromEntries(
    AUTHORING_LANE_IDS.map((lane) => [
      lane,
      authoringLaneProjection(lane, options),
    ]),
  ) as Record<AuthoringLaneId, AuthoringLaneProjection>;
  const projection = { ...base, lanes };
  return { ...projection, hash: hashAuthoringProtocol(projection) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function matchesAuthoringSequence(
  left: unknown,
  right: readonly string[],
): boolean {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isAuthoringProtocolProjection(
  value: unknown,
): value is AuthoringProtocolProjection {
  return (
    isRecord(value) &&
    typeof value.hash === "string" &&
    isRecord(value.lanes) &&
    Array.isArray(value.controlPlaneScripts) &&
    Array.isArray(value.deterministicBackbone)
  );
}

function matchesStableValue(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))
  );
}

export function validateAuthoringProtocolProjection(
  value: unknown,
  options: AuthoringLaneProjectionOptions = {},
): AuthoringPlanDiagnostic[] {
  if (!isRecord(value)) {
    return [
      {
        code: "invalid-plan",
        message: "AuthoringProtocol projection must be an object",
      },
    ];
  }
  const expected = authoringProtocolProjection(options);
  const diagnostics: AuthoringPlanDiagnostic[] = [];
  if (value.schemaVersion !== 1) {
    diagnostics.push({
      code: "invalid-plan",
      message: "AuthoringProtocol projection.schemaVersion must be 1",
      path: "schemaVersion",
    });
  }
  if (value.hash !== expected.hash) {
    diagnostics.push({
      code: "invalid-hash",
      message: "AuthoringProtocol projection hash does not match its contract",
      path: "hash",
    });
  }
  if (!isRecord(value.dag)) {
    diagnostics.push({
      code: "invalid-dag",
      message: "AuthoringProtocol projection.dag must be an object",
      path: "dag",
    });
  } else {
    for (const wave of ["wave1", "wave2", "barrier"] as const) {
      if (!matchesAuthoringSequence(value.dag[wave], expected.dag[wave])) {
        diagnostics.push({
          code: "invalid-dag",
          message: `AuthoringProtocol projection.dag.${wave} is invalid`,
          path: `dag.${wave}`,
        });
      }
    }
  }
  if (!isRecord(value.lanes)) {
    diagnostics.push({
      code: "invalid-lane",
      message: "AuthoringProtocol projection.lanes must be an object",
      path: "lanes",
    });
  } else {
    const laneIds = Object.keys(value.lanes);
    if (!matchesAuthoringSequence(laneIds, authoringLaneIds())) {
      diagnostics.push({
        code: "lane-order",
        message: "AuthoringProtocol projection lanes are not canonical",
        path: "lanes",
      });
    }
    for (const laneId of authoringLaneIds()) {
      const lane = value.lanes[laneId];
      const expectedLane = expected.lanes[laneId];
      if (!isRecord(lane)) {
        diagnostics.push({
          code: "invalid-lane",
          message: `AuthoringProtocol projection lane ${laneId} is invalid`,
          path: `lanes.${laneId}`,
        });
        continue;
      }
      if (
        lane.id !== expectedLane.id ||
        lane.wave !== expectedLane.wave ||
        !matchesAuthoringSequence(lane.dependencies, expectedLane.dependencies)
      ) {
        diagnostics.push({
          code: "invalid-lane",
          message: `AuthoringProtocol projection lane ${laneId} contract is invalid`,
          path: `lanes.${laneId}`,
        });
      }
      if (!matchesAuthoringSequence(lane.claims, expectedLane.claims)) {
        diagnostics.push({
          code: "invalid-claims",
          message: `AuthoringProtocol projection lane ${laneId} claims are invalid`,
          path: `lanes.${laneId}.claims`,
        });
      }
      if (
        !matchesAuthoringSequence(
          lane.derivedClaims,
          expectedLane.derivedClaims,
        )
      ) {
        diagnostics.push({
          code: "invalid-claims",
          message: `AuthoringProtocol projection lane ${laneId} derived claims are invalid`,
          path: `lanes.${laneId}.derivedClaims`,
        });
      }
      if (
        !matchesAuthoringSequence(
          lane.contentLeaves,
          expectedLane.contentLeaves,
        ) ||
        lane.producesContentLeaves !== expectedLane.producesContentLeaves
      ) {
        diagnostics.push({
          code: "invalid-content-leaves",
          message: `AuthoringProtocol projection lane ${laneId} content leaves are invalid`,
          path: `lanes.${laneId}.contentLeaves`,
        });
      }
    }
  }
  if (
    !matchesStableValue(value.depth, expected.depth) ||
    !matchesStableValue(value.verify, expected.verify)
  ) {
    diagnostics.push({
      code: "invalid-verification",
      message: "AuthoringProtocol projection verification settings are invalid",
      path: "verify",
    });
  }
  if (
    !matchesStableValue(value.merge, expected.merge) ||
    !matchesStableValue(
      value.controlPlaneScripts,
      expected.controlPlaneScripts,
    ) ||
    !matchesStableValue(
      value.deterministicBackbone,
      expected.deterministicBackbone,
    )
  ) {
    diagnostics.push({
      code: "invalid-plan",
      message: "AuthoringProtocol projection merge contract is invalid",
      path: "merge",
    });
  }
  return diagnostics;
}

export function validateAuthoringProtocol(
  value: unknown,
): AuthoringPlanDiagnostic[] {
  if (isAuthoringProtocolProjection(value)) {
    return validateAuthoringProtocolProjection(value);
  }
  const diagnostics: AuthoringPlanDiagnostic[] = [];
  if (!isRecord(value)) {
    return [
      {
        code: "invalid-plan",
        message: "AuthoringProtocol must be an object",
      },
    ];
  }
  if (value.schemaVersion !== 1) {
    diagnostics.push({
      code: "invalid-plan",
      message: "AuthoringProtocol.schemaVersion must be 1",
      path: "schemaVersion",
    });
  }
  if (!isRecord(value.dag)) {
    diagnostics.push({
      code: "invalid-dag",
      message: "AuthoringProtocol.dag must be an object",
      path: "dag",
    });
  } else {
    for (const key of ["wave1", "wave2", "barrier"] as const) {
      if (!matchesAuthoringSequence(value.dag[key], AUTHORING_DAG[key])) {
        diagnostics.push({
          code: "invalid-dag",
          message: `AuthoringProtocol.dag.${key} does not match the canonical lane DAG`,
          path: `dag.${key}`,
        });
      }
    }
  }
  if (!isRecord(value.depth)) {
    diagnostics.push({
      code: "invalid-verification",
      message: "AuthoringProtocol.depth must be an object",
      path: "depth",
    });
  } else {
    for (const depth of ["quick", "full"] as const) {
      const settings = value.depth[depth];
      const expected = AUTHORING_PROTOCOL.depth[depth];
      if (
        !isRecord(settings) ||
        settings.voters !== expected.voters ||
        settings.maxRounds !== expected.maxRounds ||
        settings.evidenceSource !== expected.evidenceSource
      ) {
        diagnostics.push({
          code: "invalid-verification",
          message: `AuthoringProtocol.depth.${depth} does not match the canonical verification settings`,
          path: `depth.${depth}`,
        });
      }
    }
    if (value.depth.dryThreshold !== AUTHORING_PROTOCOL.depth.dryThreshold) {
      diagnostics.push({
        code: "invalid-verification",
        message: "AuthoringProtocol.depth.dryThreshold is invalid",
        path: "depth.dryThreshold",
      });
    }
  }
  if (!isRecord(value.lanes)) {
    diagnostics.push({
      code: "invalid-lane",
      message: "AuthoringProtocol.lanes must be an object",
      path: "lanes",
    });
  } else {
    const laneIds = Object.keys(value.lanes);
    for (const laneId of laneIds) {
      if (!(AUTHORING_LANE_IDS as readonly string[]).includes(laneId)) {
        diagnostics.push({
          code: "unknown-lane",
          message: `Unknown authoring lane: ${laneId}`,
          path: `lanes.${laneId}`,
        });
      }
    }
    const expectedLaneIds = [...AUTHORING_LANE_IDS];
    if (
      laneIds.length !== expectedLaneIds.length ||
      laneIds.some((laneId, index) => laneId !== expectedLaneIds[index])
    ) {
      diagnostics.push({
        code: "lane-order",
        message: "AuthoringProtocol lanes are not in canonical order",
        path: "lanes",
      });
    }
    for (const laneId of AUTHORING_LANE_IDS) {
      const lane = value.lanes[laneId];
      if (!isRecord(lane)) {
        diagnostics.push({
          code: "invalid-lane",
          message: `AuthoringProtocol lane ${laneId} must be an object`,
          path: `lanes.${laneId}`,
        });
        continue;
      }
      if (typeof lane.brief !== "string" || lane.brief.length === 0) {
        diagnostics.push({
          code: "invalid-lane",
          message: `AuthoringProtocol lane ${laneId} has an invalid brief`,
          path: `lanes.${laneId}.brief`,
        });
      }
      if (
        !matchesAuthoringSequence(lane.claims, AUTHORING_LANE_CLAIMS[laneId])
      ) {
        diagnostics.push({
          code: "invalid-claims",
          message: `AuthoringProtocol lane ${laneId} claims do not match the canonical contract`,
          path: `lanes.${laneId}.claims`,
        });
      }
      if (
        !matchesAuthoringSequence(
          lane.producesContentLeaves,
          AUTHORING_PROTOCOL_CONTENT_LEAVES[laneId],
        )
      ) {
        diagnostics.push({
          code: "invalid-content-leaves",
          message: `AuthoringProtocol lane ${laneId} content leaves do not match the canonical contract`,
          path: `lanes.${laneId}.producesContentLeaves`,
        });
      }
    }
  }
  if (!isRecord(value.verify)) {
    diagnostics.push({
      code: "invalid-verification",
      message: "AuthoringProtocol.verify must be an object",
      path: "verify",
    });
  } else {
    if (
      !matchesAuthoringSequence(
        value.verify.lenses,
        AUTHORING_PROTOCOL.verify.lenses,
      )
    ) {
      diagnostics.push({
        code: "invalid-verification",
        message:
          "AuthoringProtocol.verify.lenses do not match the canonical contract",
        path: "verify.lenses",
      });
    }
    if (value.verify.loopUntilDry !== AUTHORING_PROTOCOL.verify.loopUntilDry) {
      diagnostics.push({
        code: "invalid-verification",
        message: "AuthoringProtocol.verify.loopUntilDry is invalid",
        path: "verify.loopUntilDry",
      });
    }
  }
  if (!isRecord(value.merge)) {
    diagnostics.push({
      code: "invalid-plan",
      message: "AuthoringProtocol.merge must be an object",
      path: "merge",
    });
  } else {
    if (
      !matchesAuthoringSequence(
        value.merge.deterministicBackbone,
        AUTHORING_DETERMINISTIC_BACKBONE,
      )
    ) {
      diagnostics.push({
        code: "invalid-plan",
        message: "AuthoringProtocol.merge.deterministicBackbone is invalid",
        path: "merge.deterministicBackbone",
      });
    }
    if (
      !matchesAuthoringSequence(
        value.merge.contentLeaves,
        AUTHORING_PROTOCOL.merge.contentLeaves,
      )
    ) {
      diagnostics.push({
        code: "invalid-content-leaves",
        message: "AuthoringProtocol.merge.contentLeaves is invalid",
        path: "merge.contentLeaves",
      });
    }
  }
  return diagnostics;
}
