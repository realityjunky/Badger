import type { AnswerType } from "../../api/questionnaire.js";
import { useI18n } from "../../i18n/I18nContext.js";

/** Show the constraints a person is about to publish or use to answer. */
export function AnswerTypeDetails({
  type = { kind: "free-text" },
}: {
  type?: AnswerType;
}) {
  const { t } = useI18n();
  return (
    <div>
      <span>
        {t("questionnaire.answerType")}:{" "}
        {t(`questionnaire.answerType.${type.kind}`)}
      </span>
      {"options" in type && (
        <ul>
          {type.options.map((option) => (
            <li key={option}>{option}</li>
          ))}
        </ul>
      )}
      {type.kind === "number" && <span> · {type.unit}</span>}
      {type.kind === "table" && (
        <ul>
          {type.columns.map((column) => (
            <li key={column}>{column}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
