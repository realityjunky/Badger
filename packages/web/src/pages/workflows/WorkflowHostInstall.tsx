import { Alert, Button, Input, Modal, Radio, Space } from "antd";
import { useState } from "react";
import {
  hostPaths,
  localInstallCommand,
  localUninstallCommand,
  type AgentHost,
  type InstallScope,
} from "@realityjunky/badger-hosts/configuration";
import type { PublishedPackage } from "../../api/publications.js";
import { useI18n } from "../../i18n/I18nContext.js";

/** The browser prepares a local command; only the local adapter reads/writes a host. */
export function WorkflowHostInstall({
  workflowId,
  publication,
  deploymentUrl,
  onClose,
}: {
  workflowId: string;
  publication: PublishedPackage | null;
  deploymentUrl: string;
  onClose(): void;
}) {
  const { t } = useI18n();
  const [host, setHost] = useState<AgentHost>("claude");
  const [scope, setScope] = useState<InstallScope>("project");
  const [action, setAction] = useState<"install" | "uninstall">("install");
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  // A deployment URL the installer refuses, such as a plain-HTTP origin the
  // server allows, is explained instead of shown.
  let command = "";
  let failure: string | null = null;
  if (publication)
    try {
      command =
        action === "install"
          ? localInstallCommand({
              deploymentUrl,
              workflowId,
              publicationId: publication.id,
              packageHash: publication.packageHash,
              host,
              scope,
            })
          : localUninstallCommand({ workflowId, host, scope });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  const paths = hostPaths(host, scope);
  return (
    <Modal
      open={publication !== null}
      title={t("hosts.title")}
      onCancel={onClose}
      footer={<Button onClick={onClose}>{t("common.close")}</Button>}
      width={760}
      style={{ top: 24 }}
      styles={{
        body: { maxHeight: "calc(100dvh - 180px)", overflowY: "auto" },
      }}
      destroyOnHidden
    >
      <p>{t("hosts.localOnly")}</p>
      <p>
        {t("evaluation.hash")}:{" "}
        <code className="publication-hash">{publication?.packageHash}</code>
      </p>
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        <div className="field">
          <span className="field-label" id="host-action-label">
            {t("hosts.action")}
          </span>
          <Radio.Group
            aria-labelledby="host-action-label"
            value={action}
            onChange={(e) => {
              setAction(e.target.value as "install" | "uninstall");
              setCopy("idle");
            }}
            options={[
              { value: "install", label: t("hosts.install") },
              { value: "uninstall", label: t("hosts.uninstall") },
            ]}
          />
        </div>
        <div className="field">
          <span className="field-label" id="install-host-label">
            {t("mcp.host")}
          </span>
          <Radio.Group
            aria-labelledby="install-host-label"
            value={host}
            onChange={(e) => {
              setHost(e.target.value as AgentHost);
              setCopy("idle");
            }}
            options={[
              { value: "claude", label: "Claude Code" },
              { value: "codex", label: "Codex" },
              { value: "workbuddy", label: "WorkBuddy" },
            ]}
          />
        </div>
        <div className="field">
          <span className="field-label" id="install-scope-label">
            {t("hosts.scope")}
          </span>
          <Radio.Group
            aria-labelledby="install-scope-label"
            value={scope}
            onChange={(e) => {
              setScope(e.target.value as InstallScope);
              setCopy("idle");
            }}
            options={[
              { value: "project", label: t("hosts.project") },
              { value: "user", label: t("hosts.user") },
            ]}
          />
        </div>
        <p className="muted">
          {t("hosts.destination")}:{" "}
          <code>
            {scope === "user" ? "~/" : "./"}
            {paths.skills}/badger-{workflowId}
          </code>
          <br />
          {t("mcp.configuration")}:{" "}
          <code>
            {scope === "user" ? "~/" : "./"}
            {paths.configuration}
          </code>
        </p>
        <Alert
          type="info"
          showIcon
          title={t("hosts.prepare")}
          description={t("hosts.steps")}
        />
        {failure === null ? (
          <Input.TextArea
            readOnly
            rows={6}
            className="mcp-configuration"
            aria-label={t("hosts.command")}
            value={command}
          />
        ) : (
          <Alert type="error" showIcon title={failure} />
        )}
        <Button
          disabled={!command}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(command);
              setCopy("copied");
            } catch {
              setCopy("failed");
            }
          }}
        >
          {t("hosts.copy")}
        </Button>
        <p role="status">
          {copy === "idle"
            ? t("hosts.confirm")
            : t(copy === "copied" ? "hosts.copied" : "hosts.copyFailed")}
        </p>
      </Space>
    </Modal>
  );
}
