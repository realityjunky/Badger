import type {
  FactoryPlan,
  PlanComposition,
  PlanSnapshot,
} from "@realityjunky/badger";
import type { GateConfirmation } from "./workflows.js";
export type { FactoryPlan, PlanComposition } from "@realityjunky/badger";

export interface PlanVersion {
  id: string;
  number: number;
  hash: string;
  canonicalJson: string;
  snapshot: PlanSnapshot;
  createdBy: string;
  createdAt: string;
}
export interface PlanView {
  versions: PlanVersion[];
  dossierHash: string | null;
  skeleton: FactoryPlan | null;
  currentVersionId: string | null;
  confirmation: GateConfirmation | null;
  confirmations?: GateConfirmation[];
}
export interface PlanPreview {
  composition: PlanComposition;
}
