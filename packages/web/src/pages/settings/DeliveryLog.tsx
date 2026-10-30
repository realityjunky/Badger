import { Alert, Collapse, Space, Tag } from "antd";
import { useEffect, useState } from "react";
import { notificationRequest, type Delivery } from "../../api/notifications.js";
import { useI18n } from "../../i18n/I18nContext.js";

/** Each post's robot, status, attempts, recipients, text, and safe error. */
export function DeliveryLog({ deliveries }: { deliveries: Delivery[] }) {
  const { t, locale } = useI18n();
  return (
    <>
      <h3>{t("notifications.deliveryLog")}</h3>
      {deliveries.length === 0 && (
        <p className="muted">{t("notifications.noDeliveries")}</p>
      )}
      <Collapse
        items={deliveries.map((delivery) => ({
          key: delivery.id,
          label: (
            <Space wrap>
              <span>{delivery.robotLabel}</span>
              <Tag>{t(`notifications.status.${delivery.status}`)}</Tag>
              <span>
                {t("notifications.attempts")}: {delivery.attempts}
              </span>
              <time>{new Date(delivery.createdAt).toLocaleString(locale)}</time>
            </Space>
          ),
          children: (
            <>
              <p>
                {delivery.recipients
                  .map(
                    (recipient) =>
                      `${recipient.name}: ${recipient.count} (${t(`notifications.mention.${recipient.mention}`)})`,
                  )
                  .join(", ")}
              </p>
              <pre>{delivery.content.text.content}</pre>
              {delivery.error && (
                <Alert type="error" message={delivery.error} />
              )}
            </>
          ),
        }))}
      />
    </>
  );
}

/** A Group default's posts, test posts included, polled like a workflow's log. */
export function GroupDeliveryLog({
  basePath,
  groupId,
  refresh,
}: {
  basePath: string;
  groupId: string;
  refresh: number;
}) {
  const { t } = useI18n();
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const update = async () => {
      const result = await notificationRequest<{ deliveries: Delivery[] }>(
        basePath,
        `/groups/${encodeURIComponent(groupId)}/notifications/deliveries`,
        "GET",
        undefined,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setFailed(result.kind !== "ok");
      if (result.kind === "ok") setDeliveries(result.value.deliveries);
    };
    void update();
    const timer = setInterval(() => {
      if (!document.hidden) void update();
    }, 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [basePath, groupId, refresh]);
  return (
    <>
      {failed && <Alert type="error" message={t("notifications.failed")} />}
      <DeliveryLog deliveries={deliveries} />
    </>
  );
}
