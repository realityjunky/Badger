import { Alert, Button, Collapse, Input, Radio } from "antd";
import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { readBasePath } from "../../app/paths.js";
import { documentationSearch } from "../../documentation/sections.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { hostSetupText } from "../../util/hostSetup.js";
import {
  renderMcpConfiguration,
  type AgentHost,
  type McpProfile,
} from "@realityjunky/badger-hosts/configuration";

export function McpSetup() {
  const { t } = useI18n();
  const location = useLocation();
  const [host, setHost] = useState<AgentHost>("claude");
  const [profile, setProfile] = useState<McpProfile>("auto");
  const [command, setCommand] = useState("badger-mcp");
  const [platform, setPlatform] = useState<"posix" | "win32">("posix");
  const [mcpCliPath, setMcpCliPath] = useState("");
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const base = readBasePath(document);
  const url = `${window.location.origin}${base === "/" ? "" : base}`;
  const { text: configuration, failure } =
    platform === "win32" || command.trim()
      ? hostSetupText(() =>
          renderMcpConfiguration(host, {
            deploymentUrl: url,
            profile,
            ...(platform === "win32" ? { platform, mcpCliPath } : { command }),
          }),
        )
      : { text: "", failure: null };

  return (
    <Collapse
      items={[
        {
          key: "mcp",
          label: t("mcp.title"),
          children: (
            <section className="mcp-setup" aria-label={t("mcp.title")}>
              <p className="muted">{t("mcp.instructions")}</p>
              <Link
                to={{
                  ...location,
                  search: documentationSearch(location.search, "mcp"),
                }}
              >
                {t("documentation.mcp.title")}
              </Link>
              <div className="field">
                <span className="field-label" id="mcp-profile-label">
                  {t("mcp.profile")}
                </span>
                <Radio.Group
                  aria-labelledby="mcp-profile-label"
                  value={profile}
                  onChange={(event) => {
                    setProfile(event.target.value as McpProfile);
                    setCopy("idle");
                  }}
                  options={(
                    ["auto", "engineer", "expert", "operator"] as const
                  ).map((value) => ({
                    value,
                    label: t(`mcp.profile.${value}`),
                  }))}
                />
              </div>
              <div className="field">
                <span className="field-label" id="mcp-host-label">
                  {t("mcp.host")}
                </span>
                <Radio.Group
                  aria-labelledby="mcp-host-label"
                  value={host}
                  onChange={(event) => {
                    setHost(event.target.value as AgentHost);
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
                <span className="field-label" id="mcp-platform-label">
                  {t("hosts.shell")}
                </span>
                <Radio.Group
                  aria-labelledby="mcp-platform-label"
                  value={platform}
                  onChange={(event) => {
                    setPlatform(event.target.value as "posix" | "win32");
                    setCopy("idle");
                  }}
                  options={[
                    { value: "posix", label: "macOS / Linux" },
                    { value: "win32", label: "Windows" },
                  ]}
                />
              </div>
              {platform === "win32" ? (
                <div className="field">
                  <label className="field-label" htmlFor="mcp-cli-path">
                    {t("hosts.mcpCliPath")}
                  </label>
                  <Input
                    id="mcp-cli-path"
                    value={mcpCliPath}
                    onChange={(event) => {
                      setMcpCliPath(event.target.value);
                      setCopy("idle");
                    }}
                  />
                </div>
              ) : (
                <div className="field">
                  <label className="field-label" htmlFor="mcp-command">
                    {t("mcp.command")}
                  </label>
                  <Input
                    id="mcp-command"
                    value={command}
                    onChange={(event) => {
                      setCommand(event.target.value);
                      setCopy("idle");
                    }}
                  />
                </div>
              )}
              {failure === null ? (
                <Input.TextArea
                  readOnly
                  aria-label={t("mcp.configuration")}
                  value={configuration}
                  rows={12}
                  className="mcp-configuration"
                />
              ) : (
                <Alert type="error" showIcon title={failure} />
              )}
              <div>
                <Button
                  disabled={!configuration}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(configuration);
                      setCopy("copied");
                    } catch {
                      setCopy("failed");
                    }
                  }}
                >
                  {t("mcp.copy")}
                </Button>
              </div>
              <p role="status">
                {copy === "idle"
                  ? t("mcp.destination")
                  : t(copy === "copied" ? "mcp.copied" : "mcp.copyFailed")}
              </p>
            </section>
          ),
        },
      ]}
    />
  );
}
