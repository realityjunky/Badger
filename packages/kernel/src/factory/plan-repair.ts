import type { FactoryPlan } from "../types.js";
import type {
  AuthoringLaneAction,
  AuthoringLaneFinding,
  AuthoringLaneId,
  AuthoringWaveId,
} from "../authoring/types.js";
import type { PlanConflict } from "./plan-reconciliation.js";
import {
  factoryPlanDraftSchema,
  type PlanCompositionInput,
} from "./plan-composition.js";

export interface PlanRepairReport {
  jobId: string;
  resultHash: string;
  lane: AuthoringLaneId;
  action: AuthoringLaneAction;
  findings: AuthoringLaneFinding[];
}
export interface PlanRepair {
  basisHash: string;
  packageId: string;
  wave: AuthoringWaveId;
  basePlan: { id: string; hash: string; plan: FactoryPlan };
  reports: PlanRepairReport[];
  recovery?: {
    draftIds: string[];
    startingPlan: FactoryPlan;
    conflicts: (PlanConflict & { draftId: string })[];
  };
}
export interface PlanRepairResolution {
  status: "addressed" | "already-covered" | "needs-evidence";
  explanation: string;
}
export function planRepairItems(repair: PlanRepair) {
  return [
    ...repair.reports.flatMap((report) =>
      (report.findings.length
        ? report.findings.map((finding) => finding.problem)
        : [report.action.requirement]
      ).map((description, index) => ({
        id: report.jobId + "/" + index,
        source: report.lane,
        description,
      })),
    ),
    ...(repair.recovery?.conflicts ?? []).map((conflict) => ({
      id: conflict.draftId + conflict.path,
      source: "reconciliation",
      description: conflict.path,
    })),
  ];
}
export function planRepairSchema(
  input: PlanCompositionInput,
  repair: PlanRepair,
) {
  const plan = factoryPlanDraftSchema(input);
  const itemIds = planRepairItems(repair).map((item) => item.id);
  return {
    ...plan,
    required: ["plan", "resolutions"],
    properties: {
      ...plan.properties,
      resolutions: {
        type: "object",
        required: itemIds,
        additionalProperties: false,
        properties: Object.fromEntries(
          itemIds.map((id) => [
            id,
            {
              type: "object",
              required: ["status", "explanation"],
              additionalProperties: false,
              properties: {
                status: {
                  enum: ["addressed", "already-covered", "needs-evidence"],
                },
                explanation: {
                  type: "string",
                  minLength: 1,
                  pattern: "\\S",
                  maxLength: 4000,
                },
              },
            },
          ]),
        ),
      },
    },
  };
}
