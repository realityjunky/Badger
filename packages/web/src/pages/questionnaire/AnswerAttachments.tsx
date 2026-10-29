import { Alert, Button } from "antd";
import { useState } from "react";
import { apiUrl } from "../../app/paths.js";
import {
  questionnaireRequest,
  type AnswerAttachment,
  type QuestionnaireView,
} from "../../api/questionnaire.js";
import { useI18n } from "../../i18n/I18nContext.js";

export function AttachmentLinks({
  attachments,
  basePath,
  path,
}: {
  attachments: AnswerAttachment[];
  basePath: string;
  path: string;
}) {
  return (
    <ul className="answer-attachments">
      {attachments.map((file) => (
        <li key={file.id}>
          <a
            href={apiUrl(
              basePath,
              `${path}/attachments/${encodeURIComponent(file.id)}`,
            )}
            download={file.name}
          >
            {file.name}
          </a>{" "}
          <span className="muted">({Math.ceil(file.size / 1024)} KiB)</span>
        </li>
      ))}
    </ul>
  );
}

function encodeFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The file could not be read"));
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.readAsDataURL(file);
  });
}

/** File selection starts uploading. Each successful file joins the autosaved draft. */
export function AnswerAttachments({
  basePath,
  path,
  questionId,
  questionRevision,
  attachments,
  limits,
  disabled,
  onChange,
  onBusy,
}: {
  basePath: string;
  path: string;
  questionId: string;
  questionRevision: number;
  attachments: AnswerAttachment[];
  limits: QuestionnaireView["attachmentLimits"];
  disabled: boolean;
  onChange(attachments: AnswerAttachment[]): void;
  onBusy(busy: boolean): void;
}) {
  const { t } = useI18n();
  const [uploading, setUploading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const upload = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    onBusy(true);
    setFailure(null);
    let next = attachments;
    const failures: string[] = [];
    try {
      for (const file of files) {
        try {
          if (
            next.length >= limits.maxFiles ||
            file.size > limits.maxFileBytes ||
            next.reduce((sum, item) => sum + item.size, 0) + file.size >
              limits.maxAnswerBytes ||
            !limits.mediaTypes.includes(file.type)
          )
            throw new Error(t("questionnaire.attachmentLimits"));
          const { attachment } = await questionnaireRequest<{
            attachment: AnswerAttachment;
          }>(
            basePath,
            `${path}/questions/${encodeURIComponent(questionId)}/attachments`,
            "POST",
            {
              questionRevision,
              name: file.name,
              mediaType: file.type,
              contentBase64: await encodeFile(file),
            },
          );
          next = [...next, attachment];
          onChange(next);
        } catch (error) {
          failures.push(
            `${file.name}: ${error instanceof Error ? error.message : t("questionnaire.failed")}`,
          );
        }
      }
      if (failures.length) setFailure(failures.join("\n"));
    } finally {
      setUploading(false);
      onBusy(false);
    }
  };
  return (
    <section aria-labelledby="answer-attachments-label">
      <label
        className="field-label"
        id="answer-attachments-label"
        htmlFor="answer-files"
      >
        {t("questionnaire.attachments")}
      </label>
      <p className="muted" id="attachment-help">
        {t("questionnaire.attachmentLimits")} {t("questionnaire.noRealData")}
      </p>
      <input
        id="answer-files"
        type="file"
        multiple
        accept={limits.mediaTypes.join(",")}
        disabled={disabled || uploading}
        aria-describedby="attachment-help"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          void upload(files);
        }}
      />
      {uploading && <p role="status">{t("questionnaire.uploading")}</p>}
      {failure && <Alert type="error" showIcon message={failure} />}
      <AttachmentLinks
        attachments={attachments}
        basePath={basePath}
        path={path}
      />
      {attachments.map((file) => (
        <Button
          key={file.id}
          disabled={disabled || uploading}
          onClick={() =>
            onChange(attachments.filter((item) => item.id !== file.id))
          }
        >
          {t("common.remove")} {file.name}
        </Button>
      ))}
    </section>
  );
}
