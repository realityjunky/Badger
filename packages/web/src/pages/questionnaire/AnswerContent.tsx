import type { AnswerRevision, AnswerType } from "../../api/questionnaire.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { AttachmentLinks } from "./AnswerAttachments.js";

export function AnswerContent({
  answer,
  type,
  basePath,
  path,
}: {
  answer: Pick<AnswerRevision, "text" | "value" | "attachments">;
  type?: AnswerType;
  basePath: string;
  path: string;
}) {
  const { t } = useI18n();
  return (
    <>
      {type?.kind === "table" && Array.isArray(answer.value) ? (
        <div className="structured-answer-table">
          <table>
            <thead>
              <tr>
                {type.columns.map((column) => (
                  <th scope="col" key={column}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(answer.value as string[][]).map((row, index) => (
                <tr key={index}>
                  {row.map((cell, column) => (
                    <td key={column}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="questionnaire-text">
          {typeof answer.value === "boolean"
            ? t(answer.value ? "questionnaire.yes" : "questionnaire.no")
            : answer.text}
        </p>
      )}
      <AttachmentLinks
        attachments={answer.attachments ?? []}
        basePath={basePath}
        path={path}
      />
    </>
  );
}
