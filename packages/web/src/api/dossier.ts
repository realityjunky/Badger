import type {
  DossierComposition,
  DossierSnapshot,
  QuestionnaireRecordHandoff,
} from "@realityjunky/badger";
import type { GateConfirmation } from "./workflows.js";
export type {
  DossierComposition,
  DossierSemantics,
  DossierSnapshot,
} from "@realityjunky/badger";

export interface DossierVersion {
  id: string;
  number: number;
  hash: string;
  canonicalJson: string;
  snapshot: DossierSnapshot;
  createdBy: string;
  createdAt: string;
}
export interface DossierView {
  versions: DossierVersion[];
  currentVersionId: string | null;
  confirmation: GateConfirmation | null;
  confirmations?: GateConfirmation[];
  handoff: QuestionnaireRecordHandoff;
}
export interface DossierPreview {
  composition: DossierComposition;
}
