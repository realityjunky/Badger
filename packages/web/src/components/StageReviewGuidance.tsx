import { CommentOutlined } from "@ant-design/icons";
import { Alert, Button, Modal, Popover, Spin } from "antd";
import { useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import {
  PROMPT_STAGES,
  type PromptTemplateSnapshot,
} from "@realityjunky/badger/prompts";
import { questionnaireRequest } from "../api/questionnaire.js";
import { readBasePath } from "../app/paths.js";
import { useI18n } from "../i18n/I18nContext.js";

export function StageReviewGuidance({
  stage,
  subject,
}: {
  stage: string;
  subject?: { workflowId: string; versionId: string };
}) {
  const { t } = useI18n();
  const parameters = useParams();
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  const workflowId =
    subject?.workflowId ?? parameters.workflowId ?? query.get("workflow");
  const versionId =
    subject?.versionId ?? parameters.versionId ?? query.get("version");
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
  const load = () => {
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
  };
  const content = guidance?.map((entry) => (
    <section key={entry.id}>
      <h3>{entry.title}</h3>
      <p style={{ whiteSpace: "pre-wrap" }}>{entry.body}</p>
    </section>
  ));
  if (subject)
    return (
      <Popover
        title={t("prompts.stageGuide")}
        placement="bottomRight"
        trigger={["hover", "focus", "click"]}
        onOpenChange={(open) => {
          if (open && !busy) load();
        }}
        content={
          <div className="questionnaire-guidance">
            {failure ? (
              <Alert type="error" title={failure} />
            ) : busy ? (
              <Spin aria-label={t("common.loading")} />
            ) : guidance?.length ? (
              content
            ) : (
              t("prompts.noStageGuidance")
            )}
          </div>
        }
      >
        <Button
          type="text"
          aria-label={t("prompts.stageGuide")}
          icon={<CommentOutlined aria-hidden="true" />}
        />
      </Popover>
    );
  return (
    <>
      <Button type="link" loading={busy} onClick={load}>
        {t("prompts.stageGuide")}
      </Button>
      {failure && <Alert type="error" title={failure} />}
      <Modal
        open={guidance !== null}
        title={t("prompts.stageGuide")}
        footer={null}
        onCancel={() => setGuidance(null)}
      >
        {content}
      </Modal>
    </>
  );
}
