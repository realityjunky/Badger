import { Alert, Modal } from "antd";
import { useState } from "react";
import {
  questionnaireRequest,
  type ConcernResolutionPreview,
  type ConcernResolutionResult,
} from "../../api/questionnaire.js";
import { useI18n } from "../../i18n/I18nContext.js";

export function ConcernResolutionDialog({
  basePath,
  path,
  preview,
  onCommitted,
  onCancel,
}: {
  basePath: string;
  path: string;
  preview: ConcernResolutionPreview;
  onCommitted(result: ConcernResolutionResult): void;
  onCancel(): void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { decision, concern } = preview;
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await questionnaireRequest<ConcernResolutionResult>(
        basePath,
        `${path}/concerns/${encodeURIComponent(concern.id)}/resolve`,
        "POST",
        {
          ...decision,
          confirmed: true,
          confirmationHash: preview.confirmationHash,
        },
      );
      onCommitted(result);
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : t("questionnaire.failed"),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={t("questionnaire.reviewResolution")}
      okText={t("questionnaire.confirmResolution")}
      cancelText={t("common.cancel")}
      confirmLoading={busy}
      onCancel={() => {
        if (!busy) onCancel();
      }}
      onOk={() => void confirm()}
    >
      {failure && <Alert type="error" showIcon message={failure} />}
      <p className="questionnaire-text">{concern.text}</p>
      <p>
        <strong>{t(`questionnaire.outcome.${decision.outcome}`)}</strong>
      </p>
      {decision.outcome === "declined" && (
        <p className="questionnaire-text">{decision.reason}</p>
      )}
      {decision.outcome === "fact-source" && (
        <p>{t("questionnaire.factSourceHelp")}</p>
      )}
      {decision.outcome === "question" && (
        <>
          <p>{t("questionnaire.draftQuestionHelp")}</p>
          <h3>{decision.question.text}</h3>
          <p className="questionnaire-text">{decision.question.rationale}</p>
        </>
      )}
    </Modal>
  );
}
