import { Alert, Button, Form, Input, Modal, Select, Space } from "antd";
import { useRef, useState } from "react";
import type {
  DossierComposition,
  DossierPreview,
  DossierSemantics,
  DossierView,
} from "../../api/dossier.js";
import { questionnaireRequest } from "../../api/questionnaire.js";
import type { WorkflowVersionDetail } from "../../api/workflows.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { DossierContent } from "./DossierContent.js";

export function DossierComposer({
  basePath,
  path,
  detail,
  view,
  onClose,
  onComposed,
}: {
  basePath: string;
  path: string;
  detail: WorkflowVersionDetail;
  view: DossierView;
  onClose(): void;
  onComposed(): void;
}) {
  const { t } = useI18n();
  const [form] = Form.useForm<DossierSemantics>();
  const [review, setReview] = useState<DossierComposition | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const errorSummary = useRef<HTMLDivElement>(null);
  const topics = view.handoff.readiness.filter((r) => r.topic !== "scope");
  const latest = view.versions[0]?.snapshot.dossier;
  const initial = latest
    ? {
        topics: latest.topics,
        nodes: latest.nodes,
        ...(latest.upgradeSource
          ? { upgradeSource: latest.upgradeSource }
          : {}),
      }
    : {
        topics: Object.fromEntries(
          topics.map((r) => [r.topic, { summary: "", factIds: [] }]),
        ),
        nodes: [
          { id: "", order: 0, responsibility: { summary: "", factIds: [] } },
        ],
      };
  const facts = view.handoff.items
    .filter(
      (i) =>
        (i.record.type === "confirmed-fact" && i.state === "confirmed") ||
        (["source-fact", "source-interface"].includes(i.record.type) &&
          i.state === "source") ||
        (i.record.type === "inference" && i.state === "confirmed"),
    )
    .map((i) => ({ value: i.record.id, label: i.statement }));
  const required = [{ required: true, message: t("questionnaire.required") }];
  const valid = review !== null && review.findings.length === 0;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t("dossier.failed"));
      requestAnimationFrame(() => errorSummary.current?.focus());
    } finally {
      setBusy(false);
    }
  }
  async function preview() {
    const values = await form.validateFields();
    const result = await questionnaireRequest<DossierPreview>(
      basePath,
      `${path}/preview`,
      "POST",
      {
        ...values,
        nodes: values.nodes.map((node, order) => ({ ...node, order })),
      },
    );
    setReview(result.composition);
    if (result.composition.findings.length)
      requestAnimationFrame(() => errorSummary.current?.focus());
  }
  async function compose() {
    if (!valid) return;
    const { nodes, topics, upgradeSource } = review.snapshot.dossier;
    await questionnaireRequest(basePath, `${path}/compose`, "POST", {
      nodes,
      topics,
      ...(upgradeSource ? { upgradeSource } : {}),
      confirmationHash: review.hash,
    });
    onComposed();
  }
  return (
    <Modal
      open
      width={900}
      title={t("dossier.compose")}
      onCancel={() => {
        if (!busy) onClose();
      }}
      closable={!busy}
      maskClosable={!busy}
      footer={
        <Space wrap>
          <Button disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          {valid ? (
            <>
              <Button disabled={busy} onClick={() => setReview(null)}>
                {t("dossier.edit")}
              </Button>
              <Button
                type="primary"
                loading={busy}
                onClick={() => void run(compose)}
              >
                {t("dossier.composeVersion")}
              </Button>
            </>
          ) : (
            <Button
              type="primary"
              loading={busy}
              onClick={() => void run(preview)}
            >
              {t("dossier.reviewComposition")}
            </Button>
          )}
        </Space>
      }
    >
      <div ref={errorSummary} tabIndex={-1}>
        {failure && <Alert type="error" showIcon title={failure} />}
        {review && review.findings.length > 0 && (
          <Alert
            type="error"
            showIcon
            title={t("dossier.findings")}
            description={
              <ul>
                {review.findings.map((finding) => (
                  <li key={`${finding.path}:${finding.message}`}>
                    {finding.path}: {finding.message}
                  </li>
                ))}
              </ul>
            }
          />
        )}
      </div>
      {valid ? (
        <DossierContent
          snapshot={review.snapshot}
          hash={review.hash}
          canonicalJson={review.canonicalJson}
          workflowId={detail.workflow.id}
        />
      ) : (
        <>
          <p>{t("dossier.composeHelp")}</p>
          <Form
            form={form}
            layout="vertical"
            initialValues={initial}
            disabled={busy}
            onValuesChange={() => setReview(null)}
          >
            <h3>{t("dossier.topics")}</h3>
            {topics.map(({ topic }) => (
              <div className="dossier-topic-editor" key={topic}>
                <Form.Item
                  name={["topics", topic, "summary"]}
                  label={`${t(`questionnaire.topic.${topic}`)} ${t("dossier.summary")}`}
                  rules={required}
                >
                  <Input.TextArea
                    autoSize={{ minRows: 2, maxRows: 8 }}
                    maxLength={20000}
                  />
                </Form.Item>
                <Form.Item
                  name={["topics", topic, "factIds"]}
                  label={`${t(`questionnaire.topic.${topic}`)} ${t("dossier.supportingFacts")}`}
                  rules={required}
                >
                  <Select
                    mode="multiple"
                    options={facts}
                    optionFilterProp="label"
                  />
                </Form.Item>
              </div>
            ))}
            <h3>{t("dossier.nodes")}</h3>
            <Form.List name="nodes">
              {(fields, { add, remove }) => (
                <>
                  {fields.map((field) => (
                    <div className="dossier-topic-editor" key={field.key}>
                      <Form.Item
                        name={[field.name, "id"]}
                        label={t("dossier.nodeId")}
                        rules={required}
                      >
                        <Input maxLength={200} />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, "responsibility", "summary"]}
                        label={t("dossier.responsibility")}
                        rules={required}
                      >
                        <Input.TextArea autoSize={{ minRows: 2, maxRows: 8 }} />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, "responsibility", "factIds"]}
                        label={t("dossier.supportingFacts")}
                        rules={required}
                      >
                        <Select
                          mode="multiple"
                          options={facts}
                          optionFilterProp="label"
                        />
                      </Form.Item>
                      <Button onClick={() => remove(field.name)}>
                        {t("dossier.removeNode")}
                      </Button>
                    </div>
                  ))}
                  <Button
                    onClick={() =>
                      add({
                        id: "",
                        responsibility: { summary: "", factIds: [] },
                      })
                    }
                  >
                    {t("dossier.addNode")}
                  </Button>
                </>
              )}
            </Form.List>
            {detail.version.intent === "upgrade-existing" && (
              <>
                <Form.Item
                  name={["upgradeSource", "sourceId"]}
                  label={t("dossier.upgradeSource")}
                  rules={required}
                >
                  <Select
                    options={detail.pins
                      .filter((p) => p.purpose === "upgrade-source")
                      .map((p) => ({ value: p.skillId, label: p.skillName }))}
                  />
                </Form.Item>
                <Form.Item
                  name={["upgradeSource", "recovery"]}
                  label={t("dossier.recovery")}
                  rules={required}
                >
                  <Input.TextArea />
                </Form.Item>
              </>
            )}
          </Form>
        </>
      )}
    </Modal>
  );
}
