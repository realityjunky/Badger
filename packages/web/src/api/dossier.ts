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
  /** The latest head's version: the one last composed or selected again. */
  headVersionId: string | null;
  /** The head, while the records it snapshots are unchanged. */
  currentVersionId: string | null;
  confirmation: GateConfirmation | null;
  confirmations?: GateConfirmation[];
  handoff: QuestionnaireRecordHandoff;
}
export interface DossierPreview {
  composition: DossierComposition;
}
