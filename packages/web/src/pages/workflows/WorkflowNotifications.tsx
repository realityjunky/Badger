import { Alert, Button, Collapse, Input, Popconfirm } from "antd";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  copyReminderText,
  notificationRequest,
  type CopyReminder,
  type Delivery,
  type ReminderResult,
  type WaitingItem,
} from "../../api/notifications.js";
import { useI18n } from "../../i18n/I18nContext.js";
import { useLiveUpdates } from "../../live/LiveUpdatesContext.js";
import { DeliveryLog } from "../settings/DeliveryLog.js";
import { RobotChannelSettings } from "../settings/RobotChannelSettings.js";
import { WorkflowPanel } from "./WorkflowPanel.js";

export function WorkflowNotifications({
  basePath,
  workflowId,
  mayManage,
}: {
  basePath: string;
  workflowId: string;
  mayManage: boolean;
}) {
  const { t, locale } = useI18n();
  const { notice: live } = useLiveUpdates();
  const [items, setItems] = useState<WaitingItem[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [copy, setCopy] = useState<CopyReminder | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<
    | "failed"
    | "conflict"
    | "reminderQueued"
    | "reminderNotPosted"
    | "copied"
    | "copyFailed"
    | null
  >(null);
  // The server's reason for a refusal, shown under the notice.
  const [reason, setReason] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now());
  const route = `/workflows/${encodeURIComponent(workflowId)}/notifications`;
  // Written in the viewer's current language, linking from this page's origin.
  const copyText =
    copy === null
      ? null
      : copyReminderText(copy, locale, window.location.origin, basePath);
  useEffect(() => {
    const controller = new AbortController();
    const update = async () => {
      const results = await Promise.all([
        notificationRequest<{ items: WaitingItem[] }>(
          basePath,
          `${route}/waiting`,
          "GET",
          undefined,
          controller.signal,
        ),
        mayManage
          ? notificationRequest<{ deliveries: Delivery[] }>(
              basePath,
              `${route}/deliveries`,
              "GET",
              undefined,
              controller.signal,
            )
          : Promise.resolve(null),
      ]);
      if (controller.signal.aborted) return;
      if (results[0].kind === "ok") setItems(results[0].value.items);
      else {
        setNotice("failed");
        setReason(results[0].message);
      }
      if (results[1]?.kind === "ok") setDeliveries(results[1].value.deliveries);
      setNow(Date.now());
    };
    void update();
    const timer = setInterval(() => {
      if (!document.hidden) void update();
    }, 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [basePath, route, mayManage, refresh, live]);
  return (
    <WorkflowPanel
      title={t("notifications.title")}
      id="notifications"
      aria-labelledby="workflow-notifications-title"
      actions={
        <Button onClick={() => setRefresh((value) => value + 1)}>
          {t("workflow.reload")}
        </Button>
      }
    >
      {notice && (
        <Alert
          showIcon
          type={
            notice === "reminderQueued" || notice === "copied"
              ? "success"
              : notice === "reminderNotPosted"
                ? "warning"
                : "error"
          }
          message={t(`notifications.${notice}`)}
          description={
            notice === "failed" || notice === "conflict"
              ? reason || undefined
              : undefined
          }
        />
      )}
      <p>
        <Link to="/settings/robots">{t("robots.managePersonal")}</Link>
      </p>
      {mayManage && (
        <Collapse
          items={[
            {
              key: "legacy-robot",
              label: t("notifications.robotSettings"),
              children: (
                <RobotChannelSettings
                  basePath={basePath}
                  scope="workflows"
                  scopeId={workflowId}
                  onChanged={() => setRefresh((value) => value + 1)}
                />
              ),
            },
          ]}
        />
      )}
      <h3>{t("notifications.waiting")}</h3>
      {items.length === 0 && (
        <p className="muted">{t("notifications.nothingWaiting")}</p>
      )}
      <ul className="inbox-items">
        {items.map((item) => (
          <li key={item.id} className="inbox-item">
            <div>
              <Link to={item.href}>
                {t(`notifications.event.${item.kind}`)}
              </Link>
              <p className="muted">
                {item.recipients
                  .map((recipient) => `${recipient.name}: ${recipient.count}`)
                  .join(", ")}
              </p>
              {item.remindAfter &&
                new Date(item.remindAfter).getTime() > now && (
                  <p className="muted">
                    {t("notifications.hourlyLimit")}{" "}
                    {new Date(item.remindAfter).toLocaleString(locale)}
                  </p>
                )}
            </div>
            {item.canRemind && (
              <Popconfirm
                title={t("notifications.remindConfirm")}
                onConfirm={async () => {
                  setBusy(item.id);
                  setNotice(null);
                  const result = await notificationRequest<ReminderResult>(
                    basePath,
                    `${route}/remind`,
                    "POST",
                    { itemId: item.id, confirmed: true },
                  );
                  setBusy(null);
                  if (result.kind === "ok") {
                    setCopy(result.value.copy);
                    if (result.value.deliveryId) setNotice("reminderQueued");
                    else if (result.value.reminder === null)
                      setNotice("reminderNotPosted");
                    setRefresh((value) => value + 1);
                  } else {
                    setNotice(
                      result.kind === "conflict" ? "conflict" : "failed",
                    );
                    setReason(result.message);
                    setRefresh((value) => value + 1);
                  }
                }}
              >
                <Button
                  loading={busy === item.id}
                  disabled={
                    busy !== null ||
                    (item.remindAfter !== null &&
                      new Date(item.remindAfter).getTime() > now)
                  }
                >
                  {t("notifications.remind")}
                </Button>
              </Popconfirm>
            )}
          </li>
        ))}
      </ul>
      {copyText !== null && (
        <div>
          <label htmlFor="copy-reminder">
            {t("notifications.copyReminder")}
          </label>
          <Input.TextArea
            id="copy-reminder"
            readOnly
            value={copyText}
            autoSize
          />
          <Button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(copyText);
                setNotice("copied");
              } catch {
                setNotice("copyFailed");
              }
            }}
          >
            {t("notifications.copyReminder")}
          </Button>
        </div>
      )}
      {mayManage && <DeliveryLog deliveries={deliveries} />}
    </WorkflowPanel>
  );
}
