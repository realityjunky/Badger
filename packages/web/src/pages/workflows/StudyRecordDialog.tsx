import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
} from "antd";
import { useState } from "react";
import {
  saveRecord,
  studyPath,
  type SourceEvidence,
  type StudyRecord,
} from "../../api/source-study.js";
import type { WorkflowVersionDetail } from "../../api/workflows.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { WorkflowNotice, type WriteFailure } from "./WorkflowDialog.js";

interface EvidenceInput {
  skillId: string;
  path: string;
  startLine: number;
  endLine: number;
}
interface Values {
  statement: string;
  producer: string;
  consumer: string;
  artifact: string;
  columns: string;
  naming: string;
  validation: string;
  evidence: EvidenceInput[];
}
export function StudyRecordDialog({
  basePath,
  detail,
  kind,
  previous,
  onCancel,
  onChanged,
}: {
  basePath: string;
  detail: WorkflowVersionDetail;
  kind: StudyRecord["kind"];
  previous?: StudyRecord;
  onCancel(): void;
  onChanged(): void;
}) {
  const { t } = useI18n();
  const [form] = Form.useForm<Values>();
  const evidence = Form.useWatch("evidence", form) ?? [];
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const required = [{ required: true, message: t("workflow.required") }];
  const pins = detail.pins;
  const options = pins.map((pin) => ({
    value: pin.skillId,
    label: `${pin.skillName} · ${pin.hash.slice(0, 12)}`,
  }));
  const files = (skillId?: string) => {
    const pin = pins.find((p) => p.skillId === skillId);
    return (
      detail.sourceCheck?.sources.find(
        (source) => source.name === pin?.skillName && source.hash === pin?.hash,
      )?.inventory ?? []
    );
  };
  const content = previous?.content;
  const currentSkill = (ref: { skillId: string; hash: string }) =>
    pins.find((pin) => pin.skillId === ref.skillId && pin.hash === ref.hash)
      ?.skillId;
  const initialValues = {
    ...content,
    ...(content && "producer" in content
      ? {
          producer: currentSkill(content.producer),
          consumer: currentSkill(content.consumer),
          columns: content.columns.join("\n"),
        }
      : {}),
    // Editing old evidence must not silently adopt a replacement pin's hash.
    evidence: content?.evidence.map((citation) => {
      const skillId = currentSkill(citation);
      return {
        ...citation,
        skillId,
        path: skillId === undefined ? undefined : citation.path,
      };
    }) ?? [{ skillId: pins[0]?.skillId, startLine: 1, endLine: 1 }],
  };
  async function submit(values: Values) {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const citations: SourceEvidence[] = values.evidence.map((entry) => {
        const pin = pins.find((p) => p.skillId === entry.skillId)!;
        const file = files(entry.skillId).find(
          (file) => file.path === entry.path,
        )!;
        return {
          skillId: pin.skillId,
          hash: pin.hash,
          path: file.path,
          fileHash: file.hash,
          startLine: entry.startLine,
          endLine: entry.endLine,
        };
      });
      const ref = (id: string) => {
        const pin = pins.find((p) => p.skillId === id)!;
        return { skillId: pin.skillId, hash: pin.hash };
      };
      const result = await saveRecord(
        basePath,
        studyPath(detail.workflow.id, detail.version.id),
        kind,
        kind === "fact"
          ? { statement: values.statement, evidence: citations }
          : {
              producer: ref(values.producer),
              consumer: ref(values.consumer),
              artifact: values.artifact,
              columns: (values.columns ?? "")
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
              naming: values.naming,
              validation: values.validation,
              evidence: citations,
            },
        previous,
      );
      if (result.kind === "ok") {
        onCancel();
        onChanged();
      } else setFailure(result);
    } catch {
      setFailure({ kind: "failed", message: t("study.inventoryChanged") });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      width={760}
      title={t(
        kind === "fact"
          ? previous === undefined
            ? "study.addFact"
            : "study.editFact"
          : previous === undefined
            ? "study.addInterface"
            : "study.editInterface",
      )}
      okText={t("workflow.save")}
      cancelText={t("workflow.cancel")}
      onOk={() => form.submit()}
      onCancel={onCancel}
      confirmLoading={busy}
      closable={!busy}
      maskClosable={false}
      cancelButtonProps={{ disabled: busy }}
    >
      {failure !== null && (
        <WorkflowNotice failure={failure} onReload={onChanged} />
      )}
      {previous?.stale && <Alert type="warning" title={t("study.staleHint")} />}
      <Form
        form={form}
        layout="vertical"
        initialValues={initialValues}
        onFinish={(values) => void submit(values)}
        onFinishFailed={({ errorFields }) => {
          if (errorFields[0] !== undefined)
            form.scrollToField(errorFields[0].name, { focus: true });
        }}
      >
        {kind === "fact" ? (
          <Form.Item
            name="statement"
            label={t("study.statement")}
            rules={required}
          >
            <Input.TextArea rows={3} maxLength={8000} />
          </Form.Item>
        ) : (
          <>
            <div className="study-form-grid">
              <Form.Item
                name="producer"
                label={t("study.producer")}
                rules={required}
              >
                <Select options={options} />
              </Form.Item>
              <Form.Item
                name="consumer"
                label={t("study.consumer")}
                rules={required}
              >
                <Select options={options} />
              </Form.Item>
            </div>
            <Form.Item
              name="artifact"
              label={t("study.artifact")}
              rules={required}
            >
              <Input maxLength={4000} />
            </Form.Item>
            <Form.Item
              name="columns"
              label={t("study.columns")}
              extra={t("study.columnsHint")}
            >
              <Input.TextArea rows={2} />
            </Form.Item>
            <Form.Item name="naming" label={t("study.naming")} rules={required}>
              <Input.TextArea rows={2} maxLength={4000} />
            </Form.Item>
            <Form.Item
              name="validation"
              label={t("study.validation")}
              rules={required}
            >
              <Input.TextArea rows={2} maxLength={4000} />
            </Form.Item>
          </>
        )}
        <Form.List name="evidence">
          {(fields, { add, remove }) => (
            <>
              {fields.map(({ key, name, ...rest }) => (
                <fieldset className="study-citation-form" key={key}>
                  <legend>
                    {t("study.evidence")} {name + 1}
                  </legend>
                  <div className="study-form-grid">
                    <Form.Item
                      {...rest}
                      name={[name, "skillId"]}
                      label={t("study.skill")}
                      rules={required}
                    >
                      <Select
                        options={options}
                        onChange={() =>
                          form.setFieldValue(
                            ["evidence", name, "path"],
                            undefined,
                          )
                        }
                      />
                    </Form.Item>
                    <Form.Item
                      {...rest}
                      name={[name, "path"]}
                      label={t("study.path")}
                      rules={required}
                    >
                      <Select
                        showSearch
                        options={files(evidence[name]?.skillId).map((file) => ({
                          value: file.path,
                          label: file.path,
                        }))}
                      />
                    </Form.Item>
                    <Form.Item
                      {...rest}
                      name={[name, "startLine"]}
                      label={t("study.startLine")}
                      rules={required}
                    >
                      <InputNumber min={1} precision={0} />
                    </Form.Item>
                    <Form.Item
                      {...rest}
                      name={[name, "endLine"]}
                      label={t("study.endLine")}
                      rules={[
                        ...required,
                        {
                          validator: async (_, value) => {
                            if (
                              value < evidence[name]?.startLine ||
                              value - evidence[name]?.startLine >= 1000
                            )
                              throw new Error(t("study.lineRange"));
                          },
                        },
                      ]}
                    >
                      <InputNumber min={1} precision={0} />
                    </Form.Item>
                  </div>
                  <Space wrap>
                    <code className="study-hash">
                      {
                        files(evidence[name]?.skillId).find(
                          (file) => file.path === evidence[name]?.path,
                        )?.hash
                      }
                    </code>
                    {fields.length > 1 && (
                      <Button danger onClick={() => remove(name)}>
                        {t("study.removeEvidence")}
                      </Button>
                    )}
                  </Space>
                </fieldset>
              ))}
              <Button
                disabled={fields.length >= 50}
                onClick={() =>
                  add({ skillId: pins[0]?.skillId, startLine: 1, endLine: 1 })
                }
              >
                {t("study.addEvidence")}
              </Button>
            </>
          )}
        </Form.List>
      </Form>
    </Modal>
  );
}
