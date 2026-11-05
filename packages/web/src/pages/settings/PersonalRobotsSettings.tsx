import {
  Alert,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Tag,
} from "antd";
import { useEffect, useState } from "react";
import {
  isWeComUserId,
  notificationRequest,
  type Delivery,
  type PersonalRobot,
} from "../../api/notifications.js";
import { readBasePath } from "../../app/paths.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { DeliveryLog } from "./DeliveryLog.js";
import { PersonalRobotRoutes } from "./PersonalRobotRoutes.js";

interface RobotValues {
  label: string;
  language: "en" | "zh";
  enabled: boolean;
  repliesEnabled: boolean;
  botId?: string;
  botSecret?: string;
  recipientUserId?: string;
}

export function PersonalRobotsSettings() {
  const { t, locale } = useI18n();
  const basePath = readBasePath(document);
  const [robots, setRobots] = useState<PersonalRobot[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<PersonalRobot | null | undefined>(
    undefined,
  );
  const [link, setLink] = useState<{
    label: string;
    command: string;
    expiresAt: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [form] = Form.useForm<RobotValues>();
  useEffect(() => {
    const controller = new AbortController();
    const update = async () => {
      const [registry, log] = await Promise.all([
        notificationRequest<{
          robots: PersonalRobot[];
          missingSettings: string[];
        }>(basePath, "/me/robots", "GET", undefined, controller.signal),
        notificationRequest<{ deliveries: Delivery[] }>(
          basePath,
          "/me/robot-deliveries",
          "GET",
          undefined,
          controller.signal,
        ),
      ]);
      if (controller.signal.aborted) return;
      if (registry.kind === "ok") {
        setRobots(registry.value.robots);
        setMissing(registry.value.missingSettings);
        setLoaded(true);
      } else setReason(registry.message || t("notifications.failed"));
      if (log.kind === "ok") setDeliveries(log.value.deliveries);
      else setReason(log.message || t("notifications.failed"));
    };
    void update();
    const timer = setInterval(() => {
      if (!document.hidden) void update();
    }, 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [basePath, refresh, t]);
  const changed = () => setRefresh((value) => value + 1);
  const save = async (robot: PersonalRobot | null, values: RobotValues) => {
    setBusy(true);
    setReason("");
    const result = await notificationRequest<{
      robot: PersonalRobot;
      linkCommand: string | null;
      linkExpiresAt: string | null;
    }>(
      basePath,
      robot === null
        ? "/me/robots"
        : `/me/robots/${encodeURIComponent(robot.id)}`,
      robot === null ? "POST" : "PUT",
      {
        revision: robot?.revision ?? 0,
        confirmed: true,
        label: values.label,
        language: values.language,
        enabled: values.enabled,
        repliesEnabled: values.repliesEnabled,
        ...(values.botId?.trim() ? { botId: values.botId.trim() } : {}),
        ...(values.botSecret ? { botSecret: values.botSecret } : {}),
        ...(values.recipientUserId?.trim()
          ? { recipientUserId: values.recipientUserId.trim() }
          : {}),
      },
    );
    setBusy(false);
    if (result.kind !== "ok") {
      setReason(result.message || t("notifications.failed"));
      return;
    }
    setEditing(undefined);
    form.resetFields();
    setNotice(t("robots.saved"));
    setLink(
      result.value.linkCommand === null
        ? null
        : {
            label: result.value.robot.label,
            command: result.value.linkCommand,
            expiresAt: result.value.linkExpiresAt!,
          },
    );
    changed();
  };
  return (
    <section className="settings-panel">
      <h2>{t("robots.title")}</h2>
      <p className="muted">{t("robots.help")}</p>
      <p className="muted">{t("robots.cliHelp")}</p>
      {missing.length > 0 && (
        <Alert
          showIcon
          type="warning"
          message={t("robots.deploymentMissing")}
          description={missing.join(", ")}
        />
      )}
      {reason && (
        <Alert
          showIcon
          type="error"
          message={reason}
          action={
            <Button
              onClick={() => {
                setReason("");
                changed();
              }}
            >
              {t("common.retry")}
            </Button>
          }
        />
      )}
      {notice && <p role="status">{notice}</p>}
      {link && (
        <Alert
          showIcon
          type="info"
          message={`${t("robots.linkChat")}: ${link.label}`}
          description={
            <>
              <p>{t("robots.linkHelp")}</p>
              <Input
                readOnly
                aria-label={t("robots.linkCommand")}
                value={link.command}
              />
              <p>
                {t("robots.expires")}:{" "}
                {new Date(link.expiresAt).toLocaleString(locale)}
              </p>
            </>
          }
        />
      )}
      <Button
        type="primary"
        disabled={busy || !loaded || missing.length > 0}
        onClick={() => {
          setEditing(null);
          form.resetFields();
          form.setFieldsValue({
            label: "",
            language: locale,
            enabled: true,
            repliesEnabled: false,
          });
        }}
      >
        {t("robots.add")}
      </Button>
      {!loaded ? (
        <p role="status">{t("common.loading")}</p>
      ) : robots.length === 0 ? (
        <p>{t("robots.empty")}</p>
      ) : (
        <Space orientation="vertical" style={{ width: "100%" }}>
          {robots.map((robot) => (
            <Card key={robot.id} title={robot.label}>
              <Space wrap>
                <Tag>
                  {t(
                    robot.suspended
                      ? "robots.suspended"
                      : !robot.enabled
                        ? "robots.paused"
                        : !robot.verified
                          ? "robots.unlinked"
                          : "robots.linked",
                  )}
                </Tag>
                <Tag>{t(`robots.connection.${robot.connectionState}`)}</Tag>
                <span>
                  {t(
                    robot.repliesEnabled
                      ? "robots.repliesOn"
                      : "robots.repliesOff",
                  )}
                </span>
              </Space>
              <Space wrap>
                <Button
                  disabled={busy}
                  onClick={() => {
                    setEditing(robot);
                    form.resetFields();
                    form.setFieldsValue({
                      ...robot,
                      botId: "",
                      botSecret: "",
                      recipientUserId: "",
                    });
                  }}
                >
                  {t("robots.edit")}
                </Button>
                <Button
                  disabled={busy || robot.suspended}
                  onClick={() =>
                    void save(robot, { ...robot, enabled: !robot.enabled })
                  }
                >
                  {t(robot.enabled ? "robots.pause" : "robots.resume")}
                </Button>
                {!robot.verified && (
                  <Button
                    disabled={busy || !robot.enabled || robot.suspended}
                    onClick={() =>
                      void save(robot, {
                        label: robot.label,
                        language: robot.language,
                        enabled: robot.enabled,
                        repliesEnabled: robot.repliesEnabled,
                      })
                    }
                  >
                    {t("robots.linkChat")}
                  </Button>
                )}
                <Popconfirm
                  title={t("robots.testConfirm")}
                  onConfirm={async () => {
                    setBusy(true);
                    const result = await notificationRequest(
                      basePath,
                      `/me/robots/${encodeURIComponent(robot.id)}/test`,
                      "POST",
                      { revision: robot.revision, confirmed: true },
                    );
                    setBusy(false);
                    if (result.kind === "ok") {
                      setNotice(t("robots.testQueued"));
                      changed();
                    } else
                      setReason(result.message || t("notifications.failed"));
                  }}
                >
                  <Button
                    disabled={
                      busy ||
                      !robot.verified ||
                      !robot.enabled ||
                      robot.suspended
                    }
                  >
                    {t("robots.test")}
                  </Button>
                </Popconfirm>
                <Popconfirm
                  title={t("robots.removeConfirm")}
                  onConfirm={async () => {
                    setBusy(true);
                    const result = await notificationRequest(
                      basePath,
                      `/me/robots/${encodeURIComponent(robot.id)}`,
                      "DELETE",
                      { revision: robot.revision, confirmed: true },
                    );
                    setBusy(false);
                    if (result.kind === "ok") {
                      setNotice(t("robots.removed"));
                      changed();
                    } else
                      setReason(result.message || t("notifications.failed"));
                  }}
                >
                  <Button danger disabled={busy}>
                    {t("robots.remove")}
                  </Button>
                </Popconfirm>
              </Space>
            </Card>
          ))}
        </Space>
      )}
      <Modal
        open={editing !== undefined}
        title={t(editing ? "robots.edit" : "robots.add")}
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
          onFinish={(values) => void save(editing ?? null, values)}
        >
          <Form.Item
            name="label"
            label={t("notifications.robotLabel")}
            rules={[{ required: true, whitespace: true, max: 80 }]}
          >
            <Input maxLength={80} />
          </Form.Item>
          <p>{t("robots.credentialsHelp")}</p>
          {editing && (
            <p className="muted">{t("notifications.replaceCredentials")}</p>
          )}
          <Form.Item
            name="botId"
            label={t("notifications.botId")}
            rules={[
              { required: editing === null, whitespace: true },
              {
                pattern: /^[a-zA-Z0-9_-]{1,128}$/u,
                message: t("notifications.botIdInvalid"),
              },
            ]}
          >
            <Input
              autoComplete="off"
              maxLength={128}
              placeholder={editing ? "••••••••" : undefined}
            />
          </Form.Item>
          <Form.Item
            name="botSecret"
            label={t("notifications.botSecret")}
            rules={[{ required: editing === null, whitespace: true, max: 512 }]}
          >
            <Input.Password
              autoComplete="new-password"
              maxLength={512}
              placeholder={editing ? "••••••••" : undefined}
            />
          </Form.Item>
          <Form.Item
            name="recipientUserId"
            label={t("notifications.recipientUserId")}
            extra={t("notifications.recipientHelp")}
            rules={[
              { required: editing === null, whitespace: true },
              {
                validator: async (_rule, value: string | undefined) => {
                  if (value?.trim() && !isWeComUserId(value.trim()))
                    throw new Error(t("notifications.identityInvalid"));
                },
              },
            ]}
          >
            <Input
              maxLength={64}
              autoComplete="off"
              placeholder={editing ? "••••••••" : undefined}
            />
          </Form.Item>
          <Form.Item
            name="language"
            label={t("notifications.chatLanguage")}
            rules={[{ required: true }]}
          >
            <Select
              options={[
                { value: "en", label: t("language.en") },
                { value: "zh", label: t("language.zh") },
              ]}
            />
          </Form.Item>
          <Form.Item name="enabled" valuePropName="checked">
            <Checkbox>{t("robots.enabled")}</Checkbox>
          </Form.Item>
          <Form.Item name="repliesEnabled" valuePropName="checked">
            <Checkbox>{t("robots.repliesEnabled")}</Checkbox>
          </Form.Item>
          <p className="muted">{t("robots.capabilitiesHelp")}</p>
          {reason && <Alert type="error" showIcon message={reason} />}
        </Form>
      </Modal>
      <PersonalRobotRoutes
        robots={robots}
        refresh={refresh}
        onChanged={changed}
      />
      <DeliveryLog deliveries={deliveries} />
    </section>
  );
}
