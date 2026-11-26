import { Alert, Input, Modal, Radio, Space } from "antd";
import { useState } from "react";
import type {
  PlanReconciliation,
  PlanReconciliationPreview,
} from "../../api/drafting-jobs.js";
import { useI18n } from "../../i18n/I18nContext.js";

export function PlanConflicts({
  review,
  busy,
  failure,
  onClose,
  onReview,
}: {
  review: PlanReconciliationPreview;
  busy: boolean;
  failure: string | null;
  onClose(): void;
  onReview(choices: PlanReconciliation["choices"]): void;
}) {
  const { t } = useI18n();
  const [choices, setChoices] = useState<PlanReconciliation["choices"]>({});
  const display = (value: unknown) =>
    value === undefined
      ? t("plan.absent")
      : typeof value === "string"
        ? value
        : JSON.stringify(value, null, 2);
  return (
    <Modal
      open
      width={850}
      title={t("plan.reconcile")}
      okText={t("plan.reviewCombined")}
      confirmLoading={busy}
      closable={!busy}
      maskClosable={!busy}
      okButtonProps={{
        disabled: review.conflicts.some(
          ({ path }) => !Object.hasOwn(choices, path),
        ),
      }}
      onCancel={onClose}
      onOk={() => onReview(choices)}
    >
      <p>{t("plan.conflictsHelp")}</p>
      {review.conflicts.map(({ path, base, current, draft }) => {
        const choice = choices[path];
        return (
          <fieldset key={path} className="plan-conflict">
            <legend>
              <code>{path}</code>
            </legend>
            <details>
              <summary>{t("plan.startingValue")}</summary>
              <pre>{display(base)}</pre>
            </details>
            <Radio.Group
              name={path}
              value={typeof choice === "object" ? "custom" : choice}
              disabled={busy}
              onChange={(event) =>
                setChoices({
                  ...choices,
                  [path]:
                    event.target.value === "custom"
                      ? { text: display(current) }
                      : event.target.value,
                })
              }
            >
              <Space orientation="vertical">
                <Radio value="current">{t("plan.keepCurrent")}</Radio>
                <pre>{display(current)}</pre>
                <Radio value="draft">{t("plan.useDraft")}</Radio>
                <pre>{display(draft)}</pre>
                {typeof current === "string" && typeof draft === "string" && (
                  <Radio value="custom">{t("plan.combineText")}</Radio>
                )}
              </Space>
            </Radio.Group>
            {typeof choice === "object" && (
              <Input.TextArea
                aria-label={t("plan.combineText")}
                value={choice.text}
                disabled={busy}
                onChange={(event) =>
                  setChoices({
                    ...choices,
                    [path]: { text: event.target.value },
                  })
                }
              />
            )}
          </fieldset>
        );
      })}
      {failure && <Alert type="error" showIcon title={failure} />}
    </Modal>
  );
}
