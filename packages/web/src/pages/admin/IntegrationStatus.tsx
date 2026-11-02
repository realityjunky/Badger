import { Alert, Button, Descriptions, Space, Tag } from "antd";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { read } from "../../api/workflows.js";
import { readBasePath } from "../../app/paths.js";
import { useI18n } from "../../i18n/I18nContext.js";

interface Integrations {
  identity: {
    kind: "local" | "none" | "platform-session" | "trusted-header" | "oidc";
    configured: boolean;
  };
  invitationEmail: { configured: boolean };
  notifications: { configured: boolean };
}

export function IntegrationStatus() {
  const { t } = useI18n();
  const basePath = readBasePath(document);
  const [status, setStatus] = useState<Integrations | null>(null);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setStatus(null);
    setFailed(false);
    void read<Integrations>(
      basePath,
      "/admin/integrations",
      controller.signal,
    ).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === "ok") setStatus(result.value);
      else setFailed(true);
    });
    return () => controller.abort();
  }, [basePath, refresh]);
  const configured = (ready: boolean) => (
    <Tag color={ready ? "success" : "default"}>
      {t(ready ? "integrations.configured" : "integrations.unconfigured")}
    </Tag>
  );
  return (
    <section>
      <p className="muted">{t("integrations.description")}</p>
      {failed ? (
        <Alert
          type="error"
          showIcon
          title={t("integrations.failed")}
          action={
            <Button onClick={() => setRefresh((value) => value + 1)}>
              {t("common.retry")}
            </Button>
          }
        />
      ) : status === null ? (
        <p role="status">{t("common.loading")}</p>
      ) : (
        <Descriptions
          column={1}
          bordered
          items={[
            {
              key: "identity",
              label: t("integrations.identity"),
              children: (
                <Space wrap>
                  {configured(status.identity.configured)}
                  <span>
                    {t(`integrations.identity.${status.identity.kind}`)}
                  </span>
                </Space>
              ),
            },
            {
              key: "email",
              label: t("integrations.email"),
              children: configured(status.invitationEmail.configured),
            },
            {
              key: "notifications",
              label: t("integrations.notifications"),
              children: (
                <Space wrap>
                  {configured(status.notifications.configured)}
                  <Link to="/settings/channels">
                    {t("integrations.groupSettings")}
                  </Link>
                  <Link to="/workflows">
                    {t("integrations.workflowSettings")}
                  </Link>
                </Space>
              ),
            },
          ]}
        />
      )}
      <p>
        {t("integrations.tokens")}{" "}
        <Link to="/settings/tokens">{t("settings.tokens.title")}</Link>
      </p>
    </section>
  );
}
