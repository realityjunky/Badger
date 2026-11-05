import {
  Alert,
  Button,
  Form,
  Input,
  Popconfirm,
  Select,
  Space,
  Tag,
} from "antd";
import { useEffect, useState } from "react";
import {
  notificationRequest,
  isWeComUserId,
  type RobotChannel,
} from "../../api/notifications.js";
import { useI18n } from "../../i18n/I18nContext.js";

interface RobotValues {
  label: string;
  language: "en" | "zh";
  webhookUrl?: string;
  transport: "webhook" | "long-connection";
  botId?: string;
  botSecret?: string;
  recipientUserId?: string;
}

export function RobotChannelSettings({
  basePath,
  scope,
  scopeId,
  onChanged,
}: {
  basePath: string;
  scope: "groups" | "workflows";
  scopeId: string;
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const [channel, setChannel] = useState<RobotChannel | null>(null);
  const [inherited, setInherited] = useState<RobotChannel | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<
    "failed" | "robotConflict" | "testQueued" | "disconnected" | null
  >(null);
  // The server's reason, such as a setting the deployment still lacks.
  const [reason, setReason] = useState("");
  const refused = (result: { kind: string; message: string }) => {
    setNotice(result.kind === "conflict" ? "robotConflict" : "failed");
    setReason(result.message);
  };
  const [refresh, setRefresh] = useState(0);
  const [form] = Form.useForm<RobotValues>();
  const transport =
    Form.useWatch("transport", form) ?? channel?.transport ?? "long-connection";
  const keepSaved = channel?.transport === transport;
  const route = `/${scope}/${encodeURIComponent(scopeId)}/notifications/channel`;
  useEffect(() => {
    setLoaded(false);
  }, [basePath, route]);
  useEffect(() => {
    const controller = new AbortController();
    void notificationRequest<{
      channel: RobotChannel | null;
      inheritedChannel: RobotChannel | null;
    }>(basePath, route, "GET", undefined, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind !== "ok") {
        if (result.kind === "denied") setLoaded(false);
        refused(result);
        return;
      }
      setChannel(result.value.channel);
      setInherited(result.value.inheritedChannel);
      setLoaded(true);
      form.setFieldsValue({
        label: result.value.channel?.label ?? "",
        language:
          result.value.channel?.language ??
          result.value.inheritedChannel?.language ??
          "en",
        webhookUrl: "",
        transport: result.value.channel?.transport ?? "long-connection",
        botId: "",
        botSecret: "",
        recipientUserId: "",
      });
    });
    return () => controller.abort();
  }, [basePath, route, form, refresh]);
  return (
    <div>
      <p className="muted">{t("notifications.channelHelp")}</p>
      {inherited && (
        <p>
          {t("notifications.groupDefault")}: <Tag>{inherited.label}</Tag>
        </p>
      )}
      {notice && (
        <Alert
          showIcon
          type={
            notice === "testQueued" || notice === "disconnected"
              ? "success"
              : "error"
          }
          message={t(`notifications.${notice}`)}
          description={
            notice === "failed" || notice === "robotConflict"
              ? reason || undefined
              : undefined
          }
        />
      )}
      {!loaded ? (
        <Button
          onClick={() => {
            setNotice(null);
            setRefresh((value) => value + 1);
          }}
        >
          {t("workflow.reload")}
        </Button>
      ) : (
        <Form
          form={form}
          layout="vertical"
          disabled={busy}
          onFinish={async (values) => {
            setBusy(true);
            setNotice(null);
            const result = await notificationRequest<{ channel: RobotChannel }>(
              basePath,
              route,
              "PUT",
              {
                revision: channel?.revision ?? 0,
                label: values.label,
                language: values.language,
                transport: values.transport,
                confirmed: true,
                ...(values.transport === "webhook" && values.webhookUrl?.trim()
                  ? { webhookUrl: values.webhookUrl.trim() }
                  : {}),
                ...(values.transport === "long-connection"
                  ? {
                      ...(values.botId?.trim()
                        ? { botId: values.botId.trim() }
                        : {}),
                      ...(values.botSecret
                        ? { botSecret: values.botSecret }
                        : {}),
                      ...(values.recipientUserId?.trim()
                        ? { recipientUserId: values.recipientUserId.trim() }
                        : {}),
                    }
                  : {}),
              },
            );
            setBusy(false);
            if (result.kind === "ok") {
              setChannel(result.value.channel);
              setInherited(null);
              form.setFieldsValue({
                webhookUrl: "",
                botId: "",
                botSecret: "",
                recipientUserId: "",
              });
              setNotice("testQueued");
              onChanged?.();
            } else refused(result);
          }}
        >
          <Form.Item
            name="label"
            label={t("notifications.robotLabel")}
            rules={[{ required: true, whitespace: true, max: 80 }]}
          >
            <Input maxLength={80} />
          </Form.Item>
          <Form.Item
            name="transport"
            label={t("notifications.transport")}
            rules={[{ required: true }]}
          >
            <Select
              options={[
                {
                  value: "long-connection",
                  label: t("notifications.longConnection"),
                },
                { value: "webhook", label: t("notifications.webhook") },
              ]}
            />
          </Form.Item>
          {transport === "webhook" ? (
            <Form.Item
              name="webhookUrl"
              label={t("notifications.webhookUrl")}
              extra={keepSaved ? t("notifications.replaceWebhook") : undefined}
              rules={[{ required: !keepSaved }, { type: "url" }]}
              preserve={false}
            >
              <Input.Password
                autoComplete="off"
                placeholder={
                  channel?.transport === "webhook"
                    ? channel.webhookUrl
                    : undefined
                }
              />
            </Form.Item>
          ) : (
            <>
              <p className="muted">{t("notifications.longConnectionHelp")}</p>
              {keepSaved && (
                <p className="muted">{t("notifications.replaceCredentials")}</p>
              )}
              <Form.Item
                name="botId"
                label={t("notifications.botId")}
                rules={[
                  { required: !keepSaved, whitespace: true },
                  {
                    pattern: /^[a-zA-Z0-9_-]{1,128}$/u,
                    message: t("notifications.botIdInvalid"),
                  },
                ]}
                preserve={false}
              >
                <Input
                  autoComplete="off"
                  maxLength={128}
                  placeholder={keepSaved ? "••••••••" : undefined}
                />
              </Form.Item>
              <Form.Item
                name="botSecret"
                label={t("notifications.botSecret")}
                rules={[{ required: !keepSaved, whitespace: true, max: 512 }]}
                preserve={false}
              >
                <Input.Password
                  autoComplete="new-password"
                  maxLength={512}
                  placeholder={keepSaved ? "••••••••" : undefined}
                />
              </Form.Item>
              <Form.Item
                name="recipientUserId"
                label={t("notifications.recipientUserId")}
                extra={t("notifications.recipientHelp")}
                rules={[
                  { required: !keepSaved, whitespace: true },
                  {
                    validator: async (_rule, value: string | undefined) => {
                      if (value?.trim() && !isWeComUserId(value.trim()))
                        throw new Error(t("notifications.identityInvalid"));
                    },
                  },
                ]}
                preserve={false}
              >
                <Input
                  autoComplete="off"
                  maxLength={64}
                  placeholder={keepSaved ? "••••••••" : undefined}
                />
              </Form.Item>
            </>
          )}
          <Form.Item name="language" label={t("notifications.chatLanguage")}>
            <Select
              options={[
                { value: "en", label: t("language.en") },
                { value: "zh", label: t("language.zh") },
              ]}
            />
          </Form.Item>
          <Space wrap>
            <Button type="primary" htmlType="submit" loading={busy}>
              {t("notifications.saveAndTest")}
            </Button>
            {channel && (
              <Popconfirm
                title={t("notifications.disconnectConfirm")}
                onConfirm={async () => {
                  setBusy(true);
                  const result = await notificationRequest(
                    basePath,
                    route,
                    "DELETE",
                    { revision: channel.revision, confirmed: true },
                  );
                  setBusy(false);
                  if (result.kind === "ok") {
                    setNotice("disconnected");
                    setRefresh((value) => value + 1);
                    onChanged?.();
                  } else refused(result);
                }}
              >
                <Button danger disabled={busy}>
                  {t("notifications.disconnect")}
                </Button>
              </Popconfirm>
            )}
          </Space>
        </Form>
      )}
    </div>
  );
}
