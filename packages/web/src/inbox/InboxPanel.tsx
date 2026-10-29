import { Alert, Button, Space, Tag } from "antd";
import { useEffect, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import { useI18n } from "../i18n/I18nContext.js";
import { useInbox } from "./InboxContext.js";

export function InboxPanel() {
  const { page, failed, busy, mark, refresh, older, newest, hasOlderPage } =
    useInbox();
  const { t, format, locale } = useI18n();
  const location = useLocation();
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (location.hash === "#inbox")
      section.current?.scrollIntoView({ block: "start" });
  }, [location.key, location.hash, page.items.length]);
  if (page.items.length === 0 && !failed && !hasOlderPage) return null;
  return (
    <section
      ref={section}
      id="inbox"
      className="workflow-panel inbox-panel"
      aria-labelledby="inbox-title"
    >
      <div className="workflow-card-heading">
        <h2 id="inbox-title">{t("inbox.title")}</h2>
        <Button onClick={() => void refresh()}>{t("workflow.reload")}</Button>
      </div>
      {failed && <Alert type="error" showIcon message={t("inbox.failed")} />}
      <ul className="inbox-items">
        {page.items.map((item) => (
          <li key={item.id} className={`inbox-item inbox-item-${item.state}`}>
            <div>
              <Link
                to={item.href}
                onClick={() => {
                  if (item.state === "unread") void mark(item);
                }}
              >
                {format(
                  item.kind === "restatement-ready"
                    ? "inbox.restatementReady"
                    : item.kind === "question-reopened"
                      ? "inbox.questionReopened"
                      : item.kind === "question-assigned"
                        ? "inbox.questionAssigned"
                        : item.kind === "gate-ready"
                          ? "inbox.gateReady"
                          : "inbox.gateInvalidated",
                  { name: item.workflowName, number: item.versionNumber },
                )}
                {item.questionText !== null && ` · ${item.questionText}`}
              </Link>
              <p className="muted">
                {new Date(item.createdAt).toLocaleString(locale)}
              </p>
            </div>
            <Space wrap>
              <Tag>{t(`inbox.state.${item.state}`)}</Tag>
              {item.state !== "done" && (
                <Button disabled={busy} onClick={() => void mark(item)}>
                  {t(
                    item.state === "unread"
                      ? "inbox.markRead"
                      : "inbox.markUnread",
                  )}
                </Button>
              )}
            </Space>
          </li>
        ))}
      </ul>
      <Space wrap>
        {hasOlderPage && <Button onClick={newest}>{t("inbox.newest")}</Button>}
        {page.nextCursor !== null && (
          <Button onClick={older}>{t("inbox.older")}</Button>
        )}
      </Space>
    </section>
  );
}
