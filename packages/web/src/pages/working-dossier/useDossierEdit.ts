import type {
  WorkingDossierEdit,
  WorkingDossierView,
} from "@realityjunky/badger";
import { useRef, useState } from "react";
import {
  QuestionnaireError,
  questionnaireRequest,
} from "../../api/questionnaire.js";
import { useI18n } from "../../i18n/I18nContext.js";
import type { EvidenceContext } from "./DossierEvidence.js";

export type DossierChanges = Omit<
  WorkingDossierEdit,
  "revision" | "pinsHash" | "editId"
>;

export function useDossierEdit(
  dossier: WorkingDossierView,
  context: EvidenceContext,
  onSaved: (view: WorkingDossierView) => void,
  onReload: () => Promise<void>,
) {
  const { t } = useI18n();
  const current = { revision: dossier.revision, pinsHash: dossier.pinsHash };
  const [base, setBase] = useState(current);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const pending = useRef<{ key: string; editId: string }>(null);
  const saving = useRef(false);
  const changed =
    base.revision !== current.revision || base.pinsHash !== current.pinsHash;
  const editable = dossier.available && dossier.editable;

  async function save(changes: DossierChanges) {
    if (changed || saving.current || !editable) return;
    const key = JSON.stringify({ ...base, ...changes });
    const editId =
      pending.current?.key === key
        ? pending.current.editId
        : crypto.randomUUID();
    pending.current = { key, editId };
    saving.current = true;
    setBusy(true);
    setFailure(undefined);
    try {
      onSaved(
        await questionnaireRequest<WorkingDossierView>(
          context.basePath,
          context.path,
          "PATCH",
          { ...base, editId, ...changes },
        ),
      );
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t("dossier.failed"));
      if (error instanceof QuestionnaireError && error.status === 409)
        await onReload();
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return {
    busy,
    changed,
    editable,
    failure,
    save,
    rebase: () => {
      setBase(current);
      setFailure(undefined);
    },
  };
}
