import { Alert, Button, Input, Space } from "antd";
import { useState } from "react";
import type {
  WorkingDossierView,
  WorkflowMapContract,
} from "@realityjunky/badger";
import { useI18n } from "../../i18n/I18nContext.js";
import { useDossierEdit } from "./useDossierEdit.js";
import type { EvidenceContext } from "./DossierEvidence.js";

export function MapContractEditor({
  dossier,
  context,
  onSaved,
  onReload,
}: {
  dossier: WorkingDossierView;
  context: EvidenceContext;
  onSaved(view: WorkingDossierView): void;
  onReload(): Promise<void>;
}) {
  const { t } = useI18n();
  const editor = useDossierEdit(dossier, context, onSaved, onReload);
  const seed = dossier.approvedPlanSeed;
  const initial = dossier.content.contract ??
    seed?.edit?.contract ?? {
      nodes: Object.fromEntries(
        Object.entries(dossier.content.nodes)
          .filter(([, node]) => node.kind === "node")
          .map(([id]) => [
            id,
            { kind: "action", outputSchemas: [], guardrails: [] },
          ]),
      ),
      outputSchemas: [],
    };
  const [text, setText] = useState(() => JSON.stringify(initial, null, 2));
  const [invalid, setInvalid] = useState(false);
  async function save() {
    try {
      const contract = JSON.parse(text) as WorkflowMapContract;
      setInvalid(false);
      await editor.save({ ...seed?.edit, contract });
    } catch {
      setInvalid(true);
    }
  }
  return (
    <Space direction="vertical" className="workflow-map-editor">
      <label htmlFor="map-contract-edit">{t("mapping.contract")}</label>
      <Input.TextArea
        id="map-contract-edit"
        rows={15}
        readOnly={!editor.editable}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {(invalid || editor.failure) && (
        <Alert
          showIcon
          type="error"
          title={invalid ? t("mapping.invalid") : editor.failure}
        />
      )}
      {seed && (
        <p>
          {t("mapping.fromPlan")} <code>{seed.hash}</code>
        </p>
      )}
      {seed?.problem && <Alert showIcon type="warning" title={seed.problem} />}
      {editor.editable && (
        <Button
          loading={editor.busy}
          disabled={editor.changed}
          onClick={() => void save()}
        >
          {t(seed?.edit ? "mapping.adopt" : "mapping.save")}
        </Button>
      )}
    </Space>
  );
}
