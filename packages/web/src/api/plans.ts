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
  canonicalJson: string | null;
  requiresRecomposition?: boolean;
  snapshot: PlanSnapshot;
  createdBy: string;
  createdAt: string;
}
export interface PlanView {
  versions: PlanVersion[];
  dossierHash: string | null;
  skeleton: FactoryPlan | null;
  /** The latest head's version, which an edit quotes as its base. */
  headVersionId: string | null;
  /** The head, while it is bound to the current approved dossier. */
  currentVersionId: string | null;
  confirmation: GateConfirmation | null;
  confirmations?: GateConfirmation[];
}
export interface PlanPreview {
  composition: PlanComposition;
}
