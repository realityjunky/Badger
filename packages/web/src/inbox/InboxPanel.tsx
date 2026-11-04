import { Alert, Button, Input, Select, Space, Tag } from "antd";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { EMPTY_INBOX_FILTERS } from "../api/inbox.js";
import { loadWorkflows, type WorkflowCatalog } from "../api/workflows.js";
import { readBasePath } from "../app/paths.js";
import { useI18n } from "../i18n/I18nContext.js";
import { useLiveUpdates } from "../live/LiveUpdatesContext.js";
import { useInbox } from "./InboxContext.js";
import { useDemoMode } from "../app/DemoContext.js";

export function InboxPanel() {
  const demoMode = useDemoMode();
  const {
    page,
    failed,
    busy,
    loading,
    filters,
    hasFilters,
    invalidDates,
    setFilters,
    mark,
    refresh,
    older,
    newest,
    hasOlderPage,
  } = useInbox();
  const { t, format, locale } = useI18n();
  const { notice } = useLiveUpdates();
  const location = useLocation();
  const section = useRef<HTMLElement>(null);
  const basePath = readBasePath(document);
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void loadWorkflows(basePath, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setCatalog(result.kind === "ok" ? result.value : null);
      setCatalogFailed(result.kind !== "ok");
    });
    return () => controller.abort();
  }, [basePath, notice, reload]);

  useEffect(() => {
    if (location.hash === "#inbox")
      section.current?.scrollIntoView({ block: "start" });
  }, [location.key, location.hash, page.items.length]);
  return (
    <section
      ref={section}
      id="inbox"
      className="workflow-panel inbox-panel"
      aria-labelledby="inbox-title"
    >
      <div className="workflow-card-heading">
        <h2 id="inbox-title">{t("inbox.title")}</h2>
        <Button
          loading={loading}
          onClick={() => {
            void refresh();
            setReload((current) => current + 1);
          }}
        >
          {t("workflow.reload")}
        </Button>
      </div>
      <div
        className="inbox-filters"
        role="group"
        aria-label={t("inbox.filters.title")}
      >
        <div className="inbox-filter inbox-filter-workflows">
          <label htmlFor="inbox-workflows">
            {t("inbox.filters.workflows")}
          </label>
          <Select
            id="inbox-workflows"
            mode="multiple"
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder={t("inbox.filters.allWorkflows")}
            value={filters.workflowIds}
            loading={catalog === null && !catalogFailed}
            options={(catalog?.workflows ?? []).map((workflow) => ({
              value: workflow.id,
              label: `${workflow.name} · ${workflow.groupName}`,
            }))}
            onChange={(workflowIds: string[]) =>
              setFilters({ ...filters, workflowIds })
            }
          />
        </div>
        <div className="inbox-filter inbox-filter-status">
          <label htmlFor="inbox-status">{t("inbox.filters.status")}</label>
          <Select
            id="inbox-status"
            mode="multiple"
            allowClear
            placeholder={t("inbox.filters.allStatuses")}
            value={filters.states}
            options={(["unread", "read", "done"] as const).map((value) => ({
              value,
              label: t(`inbox.state.${value}`),
            }))}
            onChange={(states) => setFilters({ ...filters, states })}
          />
        </div>
        <div className="inbox-filter">
          <label htmlFor="inbox-from">{t("inbox.filters.from")}</label>
          <Input
            id="inbox-from"
            type="date"
            value={filters.from}
            max={filters.to || undefined}
            status={invalidDates ? "error" : undefined}
            aria-invalid={invalidDates}
            aria-describedby={invalidDates ? "inbox-date-error" : undefined}
            onChange={(event) =>
              setFilters({ ...filters, from: event.target.value })
            }
          />
        </div>
        <div className="inbox-filter">
          <label htmlFor="inbox-to">{t("inbox.filters.to")}</label>
          <Input
            id="inbox-to"
            type="date"
            value={filters.to}
            min={filters.from || undefined}
            status={invalidDates ? "error" : undefined}
            aria-invalid={invalidDates}
            aria-describedby={invalidDates ? "inbox-date-error" : undefined}
            onChange={(event) =>
              setFilters({ ...filters, to: event.target.value })
            }
          />
        </div>
        <Button
          disabled={!hasFilters}
          onClick={() => setFilters(EMPTY_INBOX_FILTERS)}
        >
          {t("inbox.filters.clear")}
        </Button>
      </div>
      <p className="muted">{t("inbox.filters.hint")}</p>
      {invalidDates && (
        <Alert
          id="inbox-date-error"
          type="error"
          showIcon
          message={t("inbox.filters.invalidDates")}
        />
      )}
      {catalogFailed && (
        <Alert
          type="error"
          showIcon
          message={t("inbox.filters.workflowsFailed")}
        />
      )}
      {failed && <Alert type="error" showIcon message={t("inbox.failed")} />}
      {page.items.length === 0 && !failed && !invalidDates && (
        <p className="muted" role="status">
          {t(
            loading
              ? "inbox.loading"
              : hasFilters
                ? "inbox.noMatches"
                : "inbox.empty",
          )}
        </p>
      )}
      <ul className="inbox-items" aria-busy={loading}>
        {page.items.map((item) => (
          <li key={item.id} className={`inbox-item inbox-item-${item.state}`}>
            <div>
              <Link
                to={item.href}
                onClick={() => {
                  if (!demoMode && item.state === "unread") void mark(item);
                }}
              >
                {format(
                  item.kind === "script-effect-review"
                    ? "inbox.scriptEffectReview"
                    : item.kind === "evaluation-finished"
                      ? "inbox.evaluationFinished"
                      : item.kind === "answer-submitted"
                        ? "inbox.answerSubmitted"
                        : item.kind === "job-submitted"
                          ? "inbox.jobSubmitted"
                          : item.kind === "concern-raised"
                            ? "inbox.concernRaised"
                            : item.kind === "restatement-ready"
                              ? "inbox.restatementReady"
                              : item.kind === "question-reopened"
                                ? "inbox.questionReopened"
                                : item.kind === "question-assigned"
                                  ? "inbox.questionAssigned"
                                  : item.kind === "gate-ready"
                                    ? item.gate.startsWith("run:")
                                      ? "inbox.runGateReady"
                                      : item.gate === "publication"
                                        ? "inbox.publicationReady"
                                        : item.gate === "dossier"
                                          ? "inbox.dossierReady"
                                          : item.gate === "plan"
                                            ? "inbox.planReady"
                                            : item.gate === "proposal"
                                              ? "inbox.proposalReady"
                                              : "inbox.gateReady"
                                    : item.gate === "publication"
                                      ? "inbox.publicationInvalidated"
                                      : item.gate === "package"
                                        ? "inbox.packageInvalidated"
                                        : item.gate === "generation"
                                          ? "inbox.generationInvalidated"
                                          : item.gate === "dossier"
                                            ? "inbox.dossierInvalidated"
                                            : item.gate === "plan"
                                              ? "inbox.planInvalidated"
                                              : item.gate === "proposal"
                                                ? "inbox.proposalInvalidated"
                                                : "inbox.gateInvalidated",
                  {
                    name: item.workflowName,
                    number: item.semanticVersion ?? item.versionNumber,
                  },
                )}
                {item.questionText !== null && ` · ${item.questionText}`}
                {item.concernText !== null && ` · ${item.concernText}`}
              </Link>
              <p className="muted">
                {new Date(item.createdAt).toLocaleString(locale)}
              </p>
            </div>
            <Space wrap>
              <Tag>{t(`inbox.state.${item.state}`)}</Tag>
              {item.state !== "done" && (
                <Button
                  disabled={busy || demoMode}
                  onClick={() => void mark(item)}
                >
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
        {hasOlderPage && (
          <Button disabled={loading} onClick={newest}>
            {t("inbox.newest")}
          </Button>
        )}
        {page.nextCursor !== null && (
          <Button disabled={loading} onClick={older}>
            {t("inbox.older")}
          </Button>
        )}
      </Space>
    </section>
  );
}
