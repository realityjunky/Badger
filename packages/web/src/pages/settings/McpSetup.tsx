import { Button, Collapse, Input, Radio } from "antd";
import { useState } from "react";
import { readBasePath } from "../../app/paths.js";
import { useI18n } from "../../i18n/I18nContext.js";

export function McpSetup() {
  const { t } = useI18n();
  const [host, setHost] = useState("claude");
  const [profile, setProfile] = useState("auto");
  const [command, setCommand] = useState("badger-mcp");
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const base = readBasePath(document);
  const url = `${window.location.origin}${base === "/" ? "" : base}`;
  // Claude Code expands ${VAR} in .mcp.json, a file teams often commit, so
  // its configuration reads the token from the environment instead.
  const env = {
    BADGER_URL: url,
    BADGER_MCP_PROFILE: profile,
    BADGER_TOKEN:
      host === "claude" ? "${BADGER_TOKEN}" : "<YOUR_PERSONAL_ACCESS_TOKEN>",
  };
  const configuration =
    host === "codex"
      ? `[mcp_servers.badger]\ncommand = ${JSON.stringify(command)}\nargs = []\n\n[mcp_servers.badger.env]\nBADGER_URL = ${JSON.stringify(env.BADGER_URL)}\nBADGER_TOKEN = ${JSON.stringify(env.BADGER_TOKEN)}\nBADGER_MCP_PROFILE = ${JSON.stringify(profile)}\n`
      : JSON.stringify(
          { mcpServers: { badger: { type: "stdio", command, args: [], env } } },
          null,
          2,
        );

  return (
    <Collapse
      items={[
        {
          key: "mcp",
          label: t("mcp.title"),
          children: (
            <section className="mcp-setup" aria-label={t("mcp.title")}>
              <p className="muted">{t("mcp.instructions")}</p>
              <div className="field">
                <span className="field-label" id="mcp-profile-label">
                  {t("mcp.profile")}
                </span>
                <Radio.Group
                  aria-labelledby="mcp-profile-label"
                  value={profile}
                  onChange={(event) => {
                    setProfile(event.target.value as string);
                    setCopy("idle");
                  }}
                  options={(["auto", "engineer", "expert"] as const).map(
                    (value) => ({ value, label: t(`mcp.profile.${value}`) }),
                  )}
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
                    setHost(event.target.value as string);
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
              <Input.TextArea
                readOnly
                aria-label={t("mcp.configuration")}
                value={configuration}
                rows={12}
                className="mcp-configuration"
              />
              <div>
                <Button
                  disabled={!command.trim()}
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
