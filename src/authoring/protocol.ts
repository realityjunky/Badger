import { sha256 } from "../util.js";
import type {
  AuthoringCompatibility,
  AuthoringControlPlaneScript,
  AuthoringDag,
  AuthoringLaneId,
  AuthoringPlanDiagnostic,
  AuthoringProtocol,
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
    "script:comet-plan",
    "script:comet-check",
    "script:comet-hook-guard",
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
    upstreamRole: "workflow-state",
    kind: "runtime-adapter",
    path: "scripts/workflow-state.mjs",
    claim: "script:workflow-state",
    authority: "WorkflowRuntime",
  },
  {
    id: "workflow-guard",
    role: "workflow-guard",
    upstreamRole: "workflow-guard",
    kind: "runtime-adapter",
    path: "scripts/workflow-guard.mjs",
    claim: "script:workflow-guard",
    authority: "WorkflowRuntime",
  },
  {
    id: "workflow-handoff",
    role: "workflow-handoff",
    upstreamRole: "workflow-handoff",
    kind: "runtime-adapter",
    path: "scripts/workflow-handoff.mjs",
    claim: "script:workflow-handoff",
    authority: "WorkflowRuntime",
  },
  {
    id: "badger-plan",
    role: "badger-plan",
    upstreamRole: "comet-plan",
    kind: "plan",
    path: "scripts/badger-plan.mjs",
    claim: "script:comet-plan",
    authority: "Badger assembler",
  },
  {
    id: "badger-check",
    role: "badger-check",
    upstreamRole: "comet-check",
    kind: "check",
    path: "scripts/badger-check.mjs",
    claim: "script:comet-check",
    authority: "Badger assembler",
  },
  {
    id: "badger-hook-guard",
    role: "badger-hook-guard",
    upstreamRole: "comet-hook-guard",
    kind: "hook-guard",
    path: "scripts/badger-hook-guard.mjs",
    claim: "script:comet-hook-guard",
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
    "Deterministic authoring contract for /comet-any. The main session interprets this protocol, symmetric to how runtime scripts interpret workflow-protocol.json. The backend (domains/bundle/authoring.ts) mirrors these constants.",
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

export function hashAuthoringProtocol(): string {
  return sha256(
    JSON.stringify({
      schemaVersion: 1,
      dag: AUTHORING_DAG,
      lanes: AUTHORING_LANE_CLAIMS,
      controlPlaneScripts: AUTHORING_CONTROL_PLANE_SCRIPTS,
      deterministicBackbone: AUTHORING_DETERMINISTIC_BACKBONE,
    }),
  );
}

export const AUTHORING_PROTOCOL_HASH = hashAuthoringProtocol();

/** Canonical lane-contract projections for all authoring consumers. */
export function authoringLaneClaims(lane: AuthoringLaneId): readonly string[] {
  return AUTHORING_LANE_CLAIMS[lane];
}

export function authoringLaneDependencies(lane: AuthoringLaneId): readonly AuthoringLaneId[] {
  return AUTHORING_LANE_DEPENDENCIES[lane];
}

export function authoringLaneContentLeaves(lane: AuthoringLaneId): readonly string[] {
  return AUTHORING_PROTOCOL.lanes[lane].producesContentLeaves;
}

export const AUTHORING_COMPATIBILITY: AuthoringCompatibility = {
  officialRevision: "99fd7495f8b9217efbaae3a46d885f6fa7f4102a",
  officialVersion: "0.4.0-beta.19",
  knownUpstreamInconsistencies: [
    {
      id: "skill-core-claims",
      detail:
        "The upstream protocol declares no skill-core claims while the skill-core brief requires one node-skill claim for every active Node.",
    },
    {
      id: "script-claim-scope",
      detail:
        "The upstream protocol declares six script claims while the script brief explicitly requires only the three workflow adapter claims.",
    },
    {
      id: "content-leaf-shape",
      detail:
        "The upstream protocol lists content-leaf paths while the upstream TypeScript AuthoringPlan summarizes them as a boolean producesContentLeaves field.",
    },
  ],
  badgerExtensions: [
    {
      id: "workflow-protocol-hash",
      detail:
        "Badger records the normalized executable WorkflowProtocol hash separately from the AuthoringProtocol hash.",
    },
    {
      id: "source-evidence-hash",
      detail:
        "Badger records a hash of resolved Skill source and reference evidence for later freshness checks.",
    },
    {
      id: "concrete-node-content-leaves",
      detail:
        "Badger expands the upstream node-skill content-leaf placeholder using active normalized Node identities.",
    },
    {
      id: "authoring-plan-hash",
      detail:
        "Badger records a canonical hash of the derived AuthoringPlan for future authoring-input binding.",
    },
    {
      id: "control-plane-naming",
      detail:
        "Badger preserves the upstream plan, check, and hook roles while emitting them as badger-plan, badger-check, and badger-hook-guard scripts.",
    },
  ],
};

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

export function validateAuthoringProtocol(
  value: unknown,
): AuthoringPlanDiagnostic[] {
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
