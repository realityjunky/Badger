import {
  Alert,
  Button,
  Card,
  Form,
  Modal,
  Popconfirm,
  Select,
  Space,
} from "antd";
import { useEffect, useState } from "react";
import {
  notificationRequest,
  type NotificationEvent,
  type PersonalRobot,
  type PersonalRobotRoute,
} from "../../api/notifications.js";
import { readBasePath } from "../../app/paths.js";
import { useI18n } from "../../i18n/I18nContext.js";

interface RouteOptions {
  routes: PersonalRobotRoute[];
  events: NotificationEvent[];
  groups: { id: string; name: string }[];
  workflows: { id: string; name: string }[];
}

export function PersonalRobotRoutes({
  robots,
  refresh,
  onChanged,
}: {
  robots: PersonalRobot[];
  refresh: number;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const basePath = readBasePath(document);
  const [options, setOptions] = useState<RouteOptions | null>(null);
  const [editing, setEditing] = useState<PersonalRobotRoute | null | undefined>(
    undefined,
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm<PersonalRobotRoute>();
  const scope = Form.useWatch("scopeType", form) ?? "all";
  useEffect(() => {
    const controller = new AbortController();
    void notificationRequest<RouteOptions>(
      basePath,
      "/me/robot-routes",
      "GET",
      undefined,
      controller.signal,
    ).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === "ok") setOptions(result.value);
      else setReason(result.message || t("notifications.failed"));
    });
    return () => controller.abort();
  }, [basePath, refresh, t]);
  return (
    <section>
      <h3>{t("robots.routes")}</h3>
      <p>{t("robots.routesHelp")}</p>
      <p className="muted">{t("robots.precedence")}</p>
      <p className="muted">{t("robots.noFallback")}</p>
      {reason && <Alert type="error" showIcon message={reason} />}
      <Button
        disabled={!options || busy}
        onClick={() => {
          setEditing(null);
          form.resetFields();
          form.setFieldsValue({ scopeType: "all", scopeId: "", robotId: null });
        }}
      >
        {t("robots.addRoute")}
      </Button>
      {options?.routes.length === 0 && <p>{t("robots.noRoutes")}</p>}
      <Space orientation="vertical" style={{ width: "100%" }}>
        {options?.routes.map((route) => {
          const scopeName =
            route.scopeType === "all"
              ? t("robots.scope.all")
              : ((route.scopeType === "group"
                  ? options.groups
                  : options.workflows
                ).find((choice) => choice.id === route.scopeId)?.name ??
                t("robots.unavailableScope"));
          const destination =
            robots.find((robot) => robot.id === route.robotId)?.label ??
            t("robots.inboxOnly");
          return (
            <Card
              key={route.id}
              title={t(`notifications.event.${route.event}`)}
            >
              <p>
                {scopeName} → {destination}
              </p>
              <Space wrap>
                <Button
                  onClick={() => {
                    setEditing(route);
                    form.resetFields();
                    form.setFieldsValue(route);
                  }}
                >
                  {t("robots.editRoute")}
                </Button>
                <Popconfirm
                  title={t("robots.deleteRouteConfirm")}
                  onConfirm={async () => {
                    setBusy(true);
                    const result = await notificationRequest(
                      basePath,
                      `/me/robot-routes/${encodeURIComponent(route.id)}`,
                      "DELETE",
                      { revision: route.revision, confirmed: true },
                    );
                    setBusy(false);
                    if (result.kind === "ok") onChanged();
                    else setReason(result.message || t("notifications.failed"));
                  }}
                >
                  <Button danger disabled={busy}>
                    {t("robots.remove")}
                  </Button>
                </Popconfirm>
              </Space>
            </Card>
          );
        })}
      </Space>
      <Modal
        open={editing !== undefined}
        title={t(editing ? "robots.editRoute" : "robots.addRoute")}
        onCancel={() => {
          setEditing(undefined);
          form.resetFields();
        }}
        onOk={() => form.submit()}
        okText={t("robots.save")}
        cancelText={t("common.cancel")}
        confirmLoading={busy}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          disabled={busy}
          onFinish={async (values) => {
            setBusy(true);
            const result = await notificationRequest(
              basePath,
              editing
                ? `/me/robot-routes/${encodeURIComponent(editing.id)}`
                : "/me/robot-routes",
              editing ? "PUT" : "POST",
              {
                event: values.event,
                scopeType: values.scopeType,
                scopeId: values.scopeType === "all" ? "" : values.scopeId,
                robotId: values.robotId,
                revision: editing?.revision ?? 0,
                confirmed: true,
              },
            );
            setBusy(false);
            if (result.kind === "ok") {
              setEditing(undefined);
              form.resetFields();
              setReason("");
              onChanged();
            } else setReason(result.message || t("notifications.failed"));
          }}
        >
          <Form.Item
            name="event"
            label={t("robots.event")}
            rules={[{ required: true }]}
          >
            <Select
              options={options?.events.map((event) => ({
                value: event,
                label: t(`notifications.event.${event}`),
              }))}
            />
          </Form.Item>
          <Form.Item
            name="scopeType"
            label={t("robots.scope")}
            rules={[{ required: true }]}
          >
            <Select
              onChange={() => form.setFieldValue("scopeId", undefined)}
              options={(["all", "group", "workflow"] as const).map((value) => ({
                value,
                label: t(`robots.scope.${value}`),
              }))}
            />
          </Form.Item>
          {scope !== "all" && (
            <Form.Item
              name="scopeId"
              label={t(
                scope === "group"
                  ? "robots.scope.group"
                  : "robots.scope.workflow",
              )}
              rules={[{ required: true }]}
            >
              <Select
                showSearch
                optionFilterProp="label"
                options={(scope === "group"
                  ? options?.groups
                  : options?.workflows
                )?.map((choice) => ({ value: choice.id, label: choice.name }))}
              />
            </Form.Item>
          )}
          <Form.Item name="robotId" label={t("robots.destination")}>
            <Select
              options={[
                { value: "", label: t("robots.inboxOnly") },
                ...robots.map((robot) => ({
                  value: robot.id,
                  label: robot.label,
                })),
              ]}
              value={form.getFieldValue("robotId") ?? ""}
              onChange={(value) => form.setFieldValue("robotId", value || null)}
            />
          </Form.Item>
          {reason && <Alert type="error" showIcon message={reason} />}
        </Form>
      </Modal>
    </section>
  );
}
