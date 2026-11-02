import { Alert, Button, Checkbox, Form, Input } from "antd";
import { useEffect, useState } from "react";
import {
  isWeComUserId,
  notificationRequest,
  type NotificationEvent,
  type NotificationPreferences,
} from "../../api/notifications.js";
import { readBasePath } from "../../app/paths.js";
import { useI18n } from "../../i18n/I18nContext.js";

export function NotificationSettings({
  mode,
}: {
  mode: "events" | "identity";
}) {
  const { t } = useI18n();
  const basePath = readBasePath(document);
  const [current, setCurrent] = useState<NotificationPreferences | null>(null);
  const [events, setEvents] = useState<NotificationEvent[]>([]);
  const [notice, setNotice] = useState<"saved" | "failed" | "conflict" | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [form] = Form.useForm<NotificationPreferences>();
  useEffect(() => {
    setCurrent(null);
  }, [basePath]);
  useEffect(() => {
    const controller = new AbortController();
    void notificationRequest<{
      preferences: NotificationPreferences;
      events: NotificationEvent[];
    }>(basePath, "/me/notifications", "GET", undefined, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        if (result.kind === "ok") {
          setCurrent(result.value.preferences);
          setEvents(result.value.events);
          form.setFieldsValue(result.value.preferences);
        } else {
          if (result.kind === "denied") setCurrent(null);
          setNotice("failed");
        }
      },
    );
    return () => controller.abort();
  }, [basePath, form, refresh]);
  return (
    <section className="settings-panel">
      <p className="muted">
        {t(
          mode === "identity"
            ? "settings.channels.description"
            : "notifications.preferencesHelp",
        )}
      </p>
      {notice !== null && (
        <Alert
          showIcon
          type={notice === "saved" ? "success" : "error"}
          message={t(`notifications.${notice}`)}
          action={
            notice === "saved" ? undefined : (
              <Button
                onClick={() => {
                  setNotice(null);
                  setRefresh((value) => value + 1);
                }}
              >
                {t("workflow.reload")}
              </Button>
            )
          }
        />
      )}
      {current === null ? (
        <p role="status">{t("common.loading")}</p>
      ) : (
        <Form
          form={form}
          layout="vertical"
          disabled={saving}
          onFinish={async (values) => {
            setSaving(true);
            setNotice(null);
            const result = await notificationRequest<{
              preferences: NotificationPreferences;
            }>(basePath, "/me/notifications", "PUT", {
              ...current,
              ...values,
              wecomUserId:
                (values.wecomUserId ?? current.wecomUserId)?.trim() || null,
              mobile: (values.mobile ?? current.mobile)?.trim() || null,
            });
            setSaving(false);
            if (result.kind === "ok") {
              setCurrent(result.value.preferences);
              form.setFieldsValue(result.value.preferences);
              setNotice("saved");
            } else
              setNotice(result.kind === "conflict" ? "conflict" : "failed");
          }}
        >
          {mode === "identity" ? (
            <>
              <Form.Item
                name="wecomUserId"
                label={t("notifications.wecomUserId")}
                rules={[
                  {
                    validator: async (_rule, value: string | undefined) => {
                      if (value && !isWeComUserId(value))
                        throw new Error(t("notifications.identityInvalid"));
                    },
                  },
                ]}
              >
                <Input autoComplete="off" maxLength={64} />
              </Form.Item>
              <Form.Item
                name="mobile"
                label={t("notifications.mobile")}
                rules={[
                  {
                    pattern: /^\+?[0-9]{7,20}$/u,
                    message: t("notifications.identityInvalid"),
                  },
                ]}
              >
                <Input type="tel" autoComplete="tel" maxLength={21} />
              </Form.Item>
            </>
          ) : (
            <Form.Item
              name="mentionEvents"
              label={t("notifications.mentionEvents")}
            >
              <Checkbox.Group
                options={events.map((event) => ({
                  value: event,
                  label: t(`notifications.event.${event}`),
                }))}
              />
            </Form.Item>
          )}
          <Button type="primary" htmlType="submit" loading={saving}>
            {t("notifications.save")}
          </Button>
        </Form>
      )}
    </section>
  );
}
