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
  type RobotChannel,
} from "../../api/notifications.js";
import { useI18n } from "../../i18n/I18nContext.js";

interface RobotValues {
  label: string;
  language: "en" | "zh";
  webhookUrl?: string;
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
                confirmed: true,
                ...(values.webhookUrl?.trim()
                  ? { webhookUrl: values.webhookUrl.trim() }
                  : {}),
              },
            );
            setBusy(false);
            if (result.kind === "ok") {
              setChannel(result.value.channel);
              setInherited(null);
              form.setFieldValue("webhookUrl", "");
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
            name="webhookUrl"
            label={t("notifications.webhookUrl")}
            extra={channel ? t("notifications.replaceWebhook") : undefined}
            rules={[{ required: channel === null }, { type: "url" }]}
          >
            <Input.Password
              autoComplete="off"
              placeholder={channel?.webhookUrl}
            />
          </Form.Item>
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
