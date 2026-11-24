import { Alert, Form, Input, Modal } from "antd";
import { useState } from "react";
import {
  saveSkillVersionLabel,
  SkillRequestError,
  type SkillVersion,
} from "../../api/skills.js";
import { readBasePath } from "../../app/paths.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { isRecord } from "../../util/records.js";
import { isSemanticVersion } from "../../util/workflowVersion.js";

export function VersionLabelDialog({
  version,
  onClose,
  onUpdated,
}: {
  version: SkillVersion;
  onClose(): void;
  onUpdated(version: SkillVersion): void;
}) {
  const { t, format } = useI18n();
  const [form] = Form.useForm<{ label: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit({ label }: { label: string }) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await saveSkillVersionLabel(
        readBasePath(document),
        version.skillId,
        version.hash,
        label.trim() || null,
        version.labelRevision,
      );
      onUpdated(result.version);
      onClose();
    } catch (failure) {
      if (failure instanceof SkillRequestError && failure.status === 409) {
        const current = isRecord(failure.payload)
          ? failure.payload["version"]
          : undefined;
        if (
          isRecord(current) &&
          typeof current["labelRevision"] === "number" &&
          (typeof current["label"] === "string" || current["label"] === null)
        ) {
          onUpdated({
            ...version,
            label: current["label"],
            labelRevision: current["labelRevision"],
          });
          setError(
            format("skills.labelChanged", {
              label: current["label"] ?? t("skills.unlabelled"),
            }),
          );
        } else {
          form.setFields([
            { name: "label", errors: [t("skills.labelDuplicate")] },
          ]);
        }
      } else {
        setError(
          failure instanceof Error ? failure.message : t("skills.failed"),
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={t("skills.editLabel")}
      onCancel={onClose}
      closable={!busy}
      keyboard={!busy}
      maskClosable={!busy}
      cancelButtonProps={{ disabled: busy }}
      confirmLoading={busy}
      onOk={() => form.submit()}
      okText={t("skills.saveLabel")}
      cancelText={t("common.cancel")}
    >
      <p>
        <code className="skills-hash">{version.hash}</code>
      </p>
      {error && <Alert type="error" showIcon title={error} />}
      <Form
        form={form}
        layout="vertical"
        initialValues={{ label: version.label ?? "" }}
        onFinish={(values) => void submit(values)}
        disabled={busy}
      >
        <Form.Item
          name="label"
          label={t("skills.versionLabel")}
          extra={t("skills.labelHint")}
          rules={[
            {
              validator: async (_, value: string) => {
                if (value.trim() && !isSemanticVersion(value.trim()))
                  throw new Error(t("skills.labelInvalid"));
              },
            },
          ]}
        >
          <Input maxLength={64} autoComplete="off" placeholder="1.2.3" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
