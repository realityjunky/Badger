import {
  Alert,
  Button,
  Drawer,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Tag,
} from "antd";
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  questionnaireRequest,
  type QuestionnaireView,
} from "../../api/questionnaire.js";
import type { LedgerDraft, LedgerTopic } from "../../api/ledger.js";
import { useI18n } from "../../i18n/I18nContext.js";

export interface LedgerDraftEditor {
  kind: LedgerDraft["kind"];
  record?: LedgerDraft;
}
export interface LedgerDraftHistoryView {
  record: LedgerDraft;
  revisions: LedgerDraft[];
}
interface DraftProps {
  basePath: string;
  path: string;
  view: QuestionnaireView;
  onClose(): void;
  onChanged(): Promise<unknown>;
}

export function LedgerDraftDialog({
  basePath,
  path,
  view,
  editor,
  topics,
  onClose,
  onChanged,
}: DraftProps & {
  editor: LedgerDraftEditor;
  topics: { topic: LedgerTopic }[];
}) {
  const { t } = useI18n();
  const [statement, setStatement] = useState(editor.record?.statement ?? "");
  const [topic, setTopic] = useState<LedgerTopic>(
    editor.record?.topic ?? "scope",
  );
  const [questionId, setQuestionId] = useState<string | null>(
    editor.record?.questionId ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : t("questionnaire.failed"),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      title={t(
        editor?.record
          ? "ledger.edit"
          : editor?.kind === "assumption"
            ? "ledger.addAssumption"
            : "ledger.addInference",
      )}
      okText={t("ledger.save")}
      cancelText={t("common.cancel")}
      confirmLoading={busy}
      okButtonProps={{ disabled: !statement.trim() }}
      onCancel={() => {
        if (!busy) onClose();
      }}
      onOk={() =>
        void run(async () => {
          const resource =
            editor!.kind === "inference" ? "inferences" : "assumptions";
          await questionnaireRequest(
            basePath,
            `${path}/${resource}${editor!.record ? `/${encodeURIComponent(editor!.record.id)}` : ""}`,
            editor!.record ? "PATCH" : "POST",
            {
              statement,
              topic,
              questionId,
              ...(editor!.record ? { revision: editor!.record.revision } : {}),
            },
          );
          onClose();
          await onChanged();
        })
      }
    >
      {failure && <Alert type="error" title={failure} />}
      <p>{t("ledger.draftHelp")}</p>
      <label className="field-label" htmlFor="ledger-statement">
        {t("study.statement")}
      </label>
      <Input.TextArea
        id="ledger-statement"
        value={statement}
        onChange={(e) => setStatement(e.target.value)}
        maxLength={20000}
        autoSize={{ minRows: 3, maxRows: 10 }}
        disabled={busy}
      />
      <label className="field-label" htmlFor="ledger-topic">
        {t("questionnaire.topic")}
      </label>
      <Select
        id="ledger-topic"
        className="questionnaire-version"
        value={topic}
        disabled={busy}
        options={topics.map((r) => ({
          value: r.topic,
          label: t(`questionnaire.topic.${r.topic}`),
        }))}
        onChange={(next) => {
          setTopic(next);
          setQuestionId(null);
        }}
      />
      <label className="field-label" htmlFor="ledger-question">
        {t("ledger.confirmingQuestion")}
      </label>
      <Select
        id="ledger-question"
        className="questionnaire-version"
        allowClear
        value={questionId ?? undefined}
        disabled={busy}
        options={view.questions
          .filter(
            (q) =>
              q.topic === topic &&
              (!q.resolvedAt || q.id === editor?.record?.questionId),
          )
          .map((q) => ({ value: q.id, label: q.text }))}
        onChange={(id) => setQuestionId(id ?? null)}
      />
    </Modal>
  );
}

export function LedgerDraftHistory({
  basePath,
  path,
  view,
  inspector,
  onClose,
  onChanged,
  onEdit,
}: DraftProps & {
  inspector: LedgerDraftHistoryView;
  onEdit(record: LedgerDraft): void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : t("questionnaire.failed"),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Drawer open onClose={() => onClose()} title={t("ledger.history")}>
      {failure && <Alert type="error" title={failure} />}
      {inspector?.revisions.map((r) => (
        <article className="questionnaire-record" key={r.revision}>
          <h3>
            {t("ledger.recordRevision")} {r.revision}
          </h3>
          <p>{r.statement}</p>
          <Tag>
            {t(
              r.status === "retired"
                ? "ledger.state.retired"
                : "ledger.state.draft",
            )}
          </Tag>
          {r.questionId && (
            <Link
              to={`/questionnaire/questions/${encodeURIComponent(r.questionId)}`}
            >
              {t("ledger.confirmingQuestion")}
            </Link>
          )}
        </article>
      ))}
      {inspector &&
        view.capabilities.compose &&
        inspector.record.status === "active" && (
          <Space wrap>
            <Button disabled={busy} onClick={() => onEdit(inspector.record)}>
              {t("ledger.edit")}
            </Button>
            <Popconfirm
              title={t(
                inspector.record.kind === "inference"
                  ? "ledger.retireInferenceConfirm"
                  : "ledger.retireAssumptionConfirm",
              )}
              description={t("ledger.retireHint")}
              okText={t("ledger.retire")}
              cancelText={t("common.cancel")}
              disabled={busy}
              onConfirm={() =>
                run(async () => {
                  await questionnaireRequest(
                    basePath,
                    `${path}/${inspector.record.kind === "inference" ? "inferences" : "assumptions"}/${encodeURIComponent(inspector.record.id)}`,
                    "DELETE",
                    { revision: inspector.record.revision },
                  );
                  onClose();
                  await onChanged();
                })
              }
            >
              <Button danger disabled={busy}>
                {t("ledger.retire")}
              </Button>
            </Popconfirm>
          </Space>
        )}
    </Drawer>
  );
}
