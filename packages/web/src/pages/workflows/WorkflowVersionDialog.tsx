import { Button, Form, Input, Modal, Space } from "antd";
import { useState } from "react";
import type { WorkflowVersion, WriteResult } from "../../api/workflows.js";
import { useI18n } from "../../i18n/I18nContext.js";
import {
  availableSemanticVersion,
  isSemanticVersion,
} from "../../util/workflowVersion.js";
import { WorkflowNotice, type WriteFailure } from "./WorkflowDialog.js";

export function WorkflowVersionDialog({
  version,
  versions,
  onSubmit,
  onCancel,
  onReload,
}: {
  version: WorkflowVersion | null;
  versions: WorkflowVersion[];
  onSubmit(semanticVersion: string | null): Promise<WriteResult<unknown>>;
  onCancel(): void;
  onReload(): void;
}) {
  const { t, format } = useI18n();
  const [form] = Form.useForm<{ semanticVersion: string }>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const previous = versions.find(
    (entry) => entry.semanticVersion,
  )?.semanticVersion;
  const used = new Set(
    versions.flatMap((entry) =>
      entry.semanticVersion ? [entry.semanticVersion] : [],
    ),
  );
  const suggestions = Object.fromEntries(
    (["patch", "minor", "major"] as const).map((bump) => [
      bump,
      previous ? availableSemanticVersion(previous, bump, used) : null,
    ]),
  );
  const initial =
    version === null
      ? previous
        ? (suggestions.patch ?? "")
        : "0.1.0"
      : (version.semanticVersion ?? "");

  const submit = async ({ semanticVersion }: { semanticVersion: string }) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await onSubmit(semanticVersion.trim() || null);
      if (result.kind !== "ok") setFailure(result);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={t(
        version === null ? "workflow.newVersion" : "workflow.editVersionLabel",
      )}
      okText={t(version === null ? "workflow.newVersion" : "workflow.save")}
      cancelText={t("workflow.cancel")}
      onOk={() => form.submit()}
      onCancel={onCancel}
      confirmLoading={busy}
      closable={!busy}
      maskClosable={!busy}
      cancelButtonProps={{ disabled: busy }}
    >
      {failure && <WorkflowNotice failure={failure} onReload={onReload} />}
      <p>
        {t(
          version === null
            ? "workflow.newVersionConfirm"
            : "workflow.versionLabelEditHint",
        )}
      </p>
      <Form
        form={form}
        layout="vertical"
        initialValues={{ semanticVersion: initial }}
        onFinish={(values) => void submit(values)}
        disabled={busy}
      >
        <Form.Item
          name="semanticVersion"
          label={t("workflow.versionLabel")}
          extra={format("workflow.versionLabelHint", {
            number: version?.number ?? (versions[0]?.number ?? 0) + 1,
          })}
          rules={[
            {
              validator: async (_, input: string) => {
                const value = input.trim();
                if (value && !isSemanticVersion(value))
                  throw new Error(t("workflow.versionLabelInvalid"));
                if (
                  value &&
                  versions.some(
                    (entry) =>
                      entry.id !== version?.id &&
                      entry.semanticVersion === value,
                  )
                )
                  throw new Error(t("workflow.versionLabelDuplicate"));
              },
            },
          ]}
        >
          <Input
            placeholder="0.1.0"
            maxLength={64}
            autoComplete="off"
            allowClear
          />
        </Form.Item>
        {version === null && (
          <>
            <p className="muted">
              {previous
                ? format("workflow.versionBumpFrom", { version: previous })
                : t("workflow.versionBumpFirst")}
            </p>
            <Space wrap>
              {(["patch", "minor", "major"] as const).map((bump) => {
                const next = suggestions[bump] ?? null;
                return (
                  <Button
                    key={bump}
                    disabled={busy || next === null}
                    onClick={() => form.setFieldValue("semanticVersion", next)}
                  >
                    {t(`workflow.versionBump.${bump}`)}
                    {next ? ` · ${next}` : ""}
                  </Button>
                );
              })}
            </Space>
          </>
        )}
      </Form>
    </Modal>
  );
}
