import { Button, Checkbox, Input, InputNumber, Radio, Space } from "antd";
import type { AnswerType, AnswerValue } from "../../api/questionnaire.js";
import { useI18n } from "../../i18n/I18nContext.js";

export function StructuredAnswerControl({
  type,
  value,
  disabled,
  onChange,
}: {
  type: AnswerType;
  value: AnswerValue;
  disabled: boolean;
  onChange(value: AnswerValue): void;
}) {
  const { t, format } = useI18n();
  if (type.kind === "single-choice")
    return (
      <Radio.Group
        aria-labelledby="answer-label"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <Space direction="vertical">
          {type.options.map((option) => (
            <Radio key={option} value={option}>
              {option}
            </Radio>
          ))}
        </Space>
      </Radio.Group>
    );
  if (type.kind === "multiple-choice")
    return (
      <Checkbox.Group
        aria-labelledby="answer-label"
        value={Array.isArray(value) ? (value as string[]) : []}
        disabled={disabled}
        onChange={(items) => onChange(items as string[])}
      >
        <Space direction="vertical">
          {type.options.map((option) => (
            <Checkbox key={option} value={option}>
              {option}
            </Checkbox>
          ))}
        </Space>
      </Checkbox.Group>
    );
  if (type.kind === "yes-no")
    return (
      <Radio.Group
        aria-labelledby="answer-label"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <Radio value={true}>{t("questionnaire.yes")}</Radio>
        <Radio value={false}>{t("questionnaire.no")}</Radio>
      </Radio.Group>
    );
  if (type.kind === "number")
    return (
      <Space>
        <InputNumber
          id="answer-box"
          value={typeof value === "number" ? value : null}
          disabled={disabled}
          aria-describedby="answer-unit"
          onChange={(number) => onChange(number)}
        />
        <span id="answer-unit">{type.unit}</span>
      </Space>
    );
  if (type.kind === "table") {
    const rows = (value ?? []) as string[][];
    return (
      <div className="structured-answer-table">
        <table aria-labelledby="answer-label">
          <thead>
            <tr>
              {type.columns.map((column) => (
                <th scope="col" key={column}>
                  {column}
                </th>
              ))}
              <th scope="col">{t("common.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {type.columns.map((column, col) => (
                  <td key={column}>
                    <Input
                      aria-label={format("questionnaire.tableCell", {
                        column,
                        row: index + 1,
                      })}
                      disabled={disabled}
                      value={row[col]}
                      maxLength={4000}
                      onChange={(event) =>
                        onChange(
                          rows.map((item, i) =>
                            i === index
                              ? item.map((cell, c) =>
                                  c === col ? event.target.value : cell,
                                )
                              : item,
                          ),
                        )
                      }
                    />
                  </td>
                ))}
                <td>
                  <Button
                    disabled={disabled}
                    aria-label={format("questionnaire.removeRow", {
                      row: index + 1,
                    })}
                    onClick={() => onChange(rows.filter((_, i) => i !== index))}
                  >
                    {t("common.remove")}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Button
          disabled={disabled || rows.length >= 100}
          onClick={() => onChange([...rows, type.columns.map(() => "")])}
        >
          {t("questionnaire.addRow")}
        </Button>
      </div>
    );
  }
  return <p className="muted">{t("questionnaire.fileAnswerHelp")}</p>;
}
