import { Alert, Button, Form, Input, Modal, Select } from "antd";
import { useState } from "react";
import type { Group } from "../../api/organization.js";
import type {
  Workflow,
  WorkflowFrame,
  WriteResult,
} from "../../api/workflows.js";
import { useI18n } from "../../i18n/I18nContext.js";

export type WriteFailure = Exclude<WriteResult<unknown>, { kind: "ok" }>;

export function WorkflowNotice({
  failure,
  onReload,
}: {
  failure: WriteFailure;
  onReload(): void;
}) {
  const { t, format } = useI18n();
  return (
    <Alert
      showIcon
      type={failure.kind === "conflict" ? "warning" : "error"}
      message={t(
        failure.kind === "conflict"
          ? "workflow.conflict"
          : "workflow.writeFailed",
      )}
      description={
        <>
          {failure.message && <p>{failure.message}</p>}
          {failure.currentRevision !== undefined && (
            <p>
              {format("workflow.currentRevision", {
                revision: failure.currentRevision,
              })}
            </p>
          )}
        </>
      }
      action={<Button onClick={onReload}>{t("workflow.reload")}</Button>}
    />
  );
}

export type WorkflowFormValues = WorkflowFrame & { groupId: string };

/** The workflow captured when opened supplies the revision, even after a conflict. */
export function WorkflowDialog({
  workflow,
  groups,
  onCancel,
  onSubmit,
  onReload,
}: {
  workflow: Workflow | null;
  groups: Group[];
  onCancel(): void;
  onSubmit(values: WorkflowFormValues): Promise<WriteResult<unknown>>;
  onReload(): void;
}) {
  const { t, locale } = useI18n();
  const [form] = Form.useForm<WorkflowFormValues>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const required = [{ required: true, message: t("workflow.required") }];

  const submit = async (values: WorkflowFormValues) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await onSubmit(values);
      if (result.kind !== "ok") setFailure(result);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={t(workflow === null ? "workflow.create" : "workflow.edit")}
      okText={t(workflow === null ? "workflow.create" : "workflow.save")}
      cancelText={t("workflow.cancel")}
      onOk={() => form.submit()}
      onCancel={onCancel}
      confirmLoading={busy}
      closable={!busy}
      maskClosable={!busy}
      cancelButtonProps={{ disabled: busy }}
    >
      {failure !== null && (
        <WorkflowNotice failure={failure} onReload={onReload} />
      )}
      <Form
        form={form}
        layout="vertical"
        className="workflow-frame-form"
        onFinish={(values) => void submit(values)}
        initialValues={
          workflow ?? {
            groupId: groups[0]?.id,
            intent: "new-skill",
            locale: locale === "zh" ? "zh-CN" : "en",
          }
        }
        disabled={busy}
        requiredMark
      >
        {workflow === null && (
          <Form.Item
            name="groupId"
            label={t("workflow.group")}
            rules={required}
          >
            <Select
              options={groups.map((group) => ({
                value: group.id,
                label: group.name,
              }))}
            />
          </Form.Item>
        )}
        <Form.Item
          name="name"
          label={t("workflow.name")}
          rules={required}
          extra={t("workflow.nameHint")}
        >
          <Input maxLength={64} autoComplete="off" />
        </Form.Item>
        <Form.Item name="goal" label={t("workflow.goal")} rules={required}>
          <Input.TextArea rows={3} maxLength={4000} />
        </Form.Item>
        <Form.Item name="intent" label={t("workflow.intent")} rules={required}>
          <Select
            options={[
              { value: "new-skill", label: t("workflow.intent.new") },
              {
                value: "upgrade-existing",
                label: t("workflow.intent.upgrade"),
              },
            ]}
          />
        </Form.Item>
        <Form.Item
          name="locale"
          label={t("workflow.locale")}
          rules={required}
          extra={t("workflow.localeHint")}
        >
          <Input maxLength={100} />
        </Form.Item>
        {workflow !== null && <p className="muted">{t("workflow.editHint")}</p>}
      </Form>
    </Modal>
  );
}
