import { Alert, Button, Modal } from "antd";
import { useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import {
  PROMPT_STAGES,
  type PromptTemplateSnapshot,
} from "@realityjunky/badger/prompts";
import { questionnaireRequest } from "../api/questionnaire.js";
import { readBasePath } from "../app/paths.js";
import { useI18n } from "../i18n/I18nContext.js";

export function StageReviewGuidance({ stage }: { stage: string }) {
  const { t } = useI18n();
  const parameters = useParams();
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  const workflowId = parameters.workflowId ?? query.get("workflow");
  const versionId = parameters.versionId ?? query.get("version");
  const [guidance, setGuidance] = useState<PromptTemplateSnapshot[] | null>(
    null,
  );
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (
    !workflowId ||
    !versionId ||
    !(PROMPT_STAGES as readonly string[]).includes(stage)
  )
    return null;
  return (
    <>
      <Button
        type="link"
        loading={busy}
        onClick={() => {
          setBusy(true);
          setFailure(null);
          void questionnaireRequest<{ guidance: PromptTemplateSnapshot[] }>(
            readBasePath(document),
            `/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(versionId)}/stage-prompts/${stage}`,
          )
            .then(
              (result) => setGuidance(result.guidance),
              (error: unknown) =>
                setFailure(
                  error instanceof Error ? error.message : t("prompts.failed"),
                ),
            )
            .finally(() => setBusy(false));
        }}
      >
        {t("prompts.stageGuide")}
      </Button>
      {failure && <Alert type="error" title={failure} />}
      <Modal
        open={guidance !== null}
        title={t("prompts.stageGuide")}
        footer={null}
        onCancel={() => setGuidance(null)}
      >
        {guidance?.map((entry) => (
          <section key={entry.id}>
            <h3>{entry.title}</h3>
            <p style={{ whiteSpace: "pre-wrap" }}>{entry.body}</p>
          </section>
        ))}
      </Modal>
    </>
  );
}
