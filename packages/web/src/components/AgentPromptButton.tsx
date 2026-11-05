import { Alert, Button, Input, Modal, Space } from "antd";
import { useState } from "react";
import { questionnaireRequest } from "../api/questionnaire.js";
import { normalizeBasePath } from "../app/paths.js";
import { useI18n } from "../i18n/I18nContext.js";

export function AgentPromptButton({
  basePath,
  path,
  label,
  beforeCopy,
  disabled = false,
}: {
  basePath: string;
  path: string;
  label?: string;
  beforeCopy?(): Promise<unknown>;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const copy = async () => {
    setBusy(true);
    setFailure(null);
    setCopied(false);
    try {
      await beforeCopy?.();
      const result = await questionnaireRequest<{ prompt: string }>(
        basePath,
        path,
      );
      const base = normalizeBasePath(basePath);
      const text = `Use the connected Badger MCP for deployment ${window.location.origin}${base === "/" ? "" : base}.\n\n${result.prompt}`;
      setPrompt(text);
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
      } catch {
        setCopied(false);
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t("prompts.failed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button loading={busy} disabled={disabled} onClick={() => void copy()}>
        {label ?? t("prompts.copy")}
      </Button>
      {failure && <Alert type="error" title={failure} />}
      <Modal
        open={prompt !== null}
        title={t("prompts.show")}
        width={840}
        footer={null}
        onCancel={() => setPrompt(null)}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <p role="status">
            {copied ? t("prompts.copied") : t("prompts.manualCopy")}
          </p>
          <Input.TextArea
            aria-label={t("prompts.show")}
            readOnly
            value={prompt ?? ""}
            rows={18}
            onFocus={(event) => event.currentTarget.select()}
          />
        </Space>
      </Modal>
    </>
  );
}
