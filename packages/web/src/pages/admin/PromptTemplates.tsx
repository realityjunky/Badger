import {
  Alert,
  Button,
  Collapse,
  Descriptions,
  Input,
  Modal,
  Space,
  Table,
  Tabs,
  Tag,
} from "antd";
import { useEffect, useState } from "react";
import {
  PROMPT_STAGES,
  type PromptTemplateSnapshot,
} from "@realityjunky/badger/prompts";
import { questionnaireRequest } from "../../api/questionnaire.js";
import { readBasePath } from "../../app/paths.js";
import { useI18n } from "../../i18n/I18nContext.js";

export function PromptTemplates() {
  const { t } = useI18n();
  const basePath = readBasePath(document);
  const [templates, setTemplates] = useState<PromptTemplateSnapshot[]>([]);
  const [guardrails, setGuardrails] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<PromptTemplateSnapshot | null>(null);
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState<{ confirmationHash: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<{
    template: PromptTemplateSnapshot;
    history: {
      revision: number;
      body: string;
      personId: string;
      createdAt: string;
    }[];
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void questionnaireRequest<{
      templates: PromptTemplateSnapshot[];
      guardrails: string;
    }>(
      basePath,
      "/admin/prompt-templates",
      "GET",
      undefined,
      controller.signal,
    ).then(
      (result) => {
        if (!controller.signal.aborted) {
          setTemplates(result.templates);
          setGuardrails(result.guardrails);
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setFailure(
            error instanceof Error ? error.message : t("prompts.failed"),
          );
      },
    );
    return () => controller.abort();
  }, [basePath, t, reload]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t("prompts.failed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label={t("prompts.title")}>
      <p>{t("prompts.description")}</p>
      <Button
        disabled={busy}
        onClick={() => {
          setFailure(null);
          setReload((value) => value + 1);
        }}
      >
        {t("workflow.reload")}
      </Button>
      {failure && <Alert type="error" title={failure} />}
      {saved && <Alert type="success" title={t("prompts.saved")} />}
      <Collapse
        items={[
          {
            key: "rules",
            label: t("prompts.guardrails"),
            children: (
              <>
                <p>{t("prompts.guardrailsHelp")}</p>
                <p style={{ whiteSpace: "pre-wrap" }}>{guardrails}</p>
              </>
            ),
          },
        ]}
      />
      {!templates.length && !failure && (
        <p role="status">{t("common.loading")}</p>
      )}
      <Tabs
        tabPosition="top"
        items={PROMPT_STAGES.map((stage) => ({
          key: stage,
          label: t(`prompts.stage.${stage}`),
          children: (
            <Table<PromptTemplateSnapshot>
              rowKey="id"
              pagination={false}
              scroll={{ x: 650 }}
              dataSource={templates.filter((entry) => entry.stage === stage)}
              columns={[
                {
                  title: t("prompts.title"),
                  dataIndex: "title",
                  render: (title: string, entry) => (
                    <>
                      <strong>{title}</strong>
                      <p>{entry.output}</p>
                    </>
                  ),
                },
                {
                  title: t("prompts.scenario"),
                  dataIndex: "scenario",
                  render: (scenario: PromptTemplateSnapshot["scenario"]) => (
                    <Tag>{t(`prompts.scenario.${scenario}`)}</Tag>
                  ),
                },
                {
                  title: t("prompts.audience"),
                  render: (_, entry) => entry.audience.join(", "),
                },
                { title: t("prompts.revision"), dataIndex: "revision" },
                {
                  title: t("common.actions"),
                  render: (_, entry) => (
                    <Space wrap>
                      <Button
                        onClick={() => {
                          setEditing(entry);
                          setBody(entry.body);
                          setPreview(null);
                          setSaved(false);
                          setFailure(null);
                        }}
                      >
                        {t("prompts.edit")}
                      </Button>
                      <Button
                        loading={busy}
                        onClick={() =>
                          void run(async () =>
                            setHistory(
                              await questionnaireRequest(
                                basePath,
                                `/admin/prompt-templates/${entry.id}/history`,
                              ),
                            ),
                          )
                        }
                      >
                        {t("prompts.history")}
                      </Button>
                    </Space>
                  ),
                },
              ]}
            />
          ),
        }))}
      />
      <Modal
        open={editing !== null}
        title={editing?.title}
        width={960}
        onCancel={() => {
          if (!busy) {
            setEditing(null);
            setPreview(null);
          }
        }}
        confirmLoading={busy}
        okText={t(preview ? "prompts.confirm" : "prompts.preview")}
        cancelText={t("common.cancel")}
        okButtonProps={{ disabled: !body.trim() || body === editing?.body }}
        onOk={() =>
          void run(async () => {
            if (!editing) return;
            const path = `/admin/prompt-templates/${editing.id}`;
            if (!preview) {
              setPreview(
                await questionnaireRequest(
                  basePath,
                  `${path}/preview`,
                  "POST",
                  { revision: editing.revision, body },
                ),
              );
              return;
            }
            const result = await questionnaireRequest<{
              template: PromptTemplateSnapshot;
            }>(basePath, path, "PUT", {
              revision: editing.revision,
              body,
              confirmed: true,
              confirmationHash: preview.confirmationHash,
            });
            setTemplates((current) =>
              current.map((entry) =>
                entry.id === result.template.id ? result.template : entry,
              ),
            );
            setEditing(null);
            setPreview(null);
            setSaved(true);
          })
        }
      >
        {editing && (
          <>
            <Descriptions
              column={1}
              items={[
                {
                  key: "context",
                  label: t("prompts.dependencies"),
                  children: editing.dependencies.join(" · "),
                },
                {
                  key: "output",
                  label: t("prompts.output"),
                  children: editing.output,
                },
                {
                  key: "roles",
                  label: t("prompts.audience"),
                  children: editing.audience.join(", "),
                },
              ]}
            />
            {preview && (
              <>
                <Alert type="info" title={t("prompts.confirmHelp")} />
                <Collapse
                  items={[
                    {
                      key: "previous",
                      label: `${t("prompts.revision")} ${editing.revision}`,
                      children: (
                        <p style={{ whiteSpace: "pre-wrap" }}>{editing.body}</p>
                      ),
                    },
                  ]}
                />
              </>
            )}
            <label className="field-label" htmlFor="prompt-template-body">
              {t("prompts.body")}
            </label>
            <Input.TextArea
              id="prompt-template-body"
              value={body}
              maxLength={30000}
              rows={18}
              readOnly={preview !== null}
              onChange={(event) => setBody(event.target.value)}
            />
            {preview && (
              <Button onClick={() => setPreview(null)}>
                {t("prompts.edit")}
              </Button>
            )}
          </>
        )}
        {failure && <Alert type="error" title={failure} />}
      </Modal>
      <Modal
        open={history !== null}
        title={t("prompts.history")}
        footer={null}
        width={900}
        onCancel={() => setHistory(null)}
      >
        {history?.history.length === 0 && <p>{t("prompts.noHistory")}</p>}
        <Collapse
          items={history?.history.map((entry) => ({
            key: entry.revision,
            label: `${t("prompts.revision")} ${entry.revision} · ${new Date(entry.createdAt).toLocaleString()}`,
            children: <p style={{ whiteSpace: "pre-wrap" }}>{entry.body}</p>,
          }))}
        />
      </Modal>
    </section>
  );
}
