import { Alert, Button, Input, Select, Space, Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import { useCallback, useEffect, useState } from "react";
import {
  EMPTY_FILTERS,
  loadActivity,
  type ActivityFilters,
  type AuditEvent,
} from "../api/organization.js";
import { readBasePath } from "../app/paths.js";
import { PageHeader } from "../components/PageHeader.js";
import { useI18n } from "../i18n/I18nContext.js";

type State =
  | { kind: "loading" }
  | { kind: "denied" }
  | { kind: "failed" }
  | {
      kind: "ready";
      events: AuditEvent[];
      nextCursor: string | null;
      loadingMore: boolean;
    };

const CHANNELS = ["web", "mcp", "worker"];

/** Every recorded action, with the filters an Auditor checks it by. */
export function ActivityPage() {
  const { t } = useI18n();
  const basePath = readBasePath(document);
  const [draft, setDraft] = useState<ActivityFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<ActivityFilters>(EMPTY_FILTERS);
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(
    async (filters: ActivityFilters, signal?: AbortSignal) => {
      setState({ kind: "loading" });
      const loaded = await loadActivity(basePath, filters, null, signal);
      if (signal?.aborted === true) {
        return;
      }
      setState(
        loaded.kind === "ok"
          ? {
              kind: "ready",
              events: loaded.value.events,
              nextCursor: loaded.value.nextCursor,
              loadingMore: false,
            }
          : { kind: loaded.kind },
      );
    },
    [basePath],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(applied, controller.signal);
    return () => controller.abort();
  }, [applied, load]);

  const loadMore = async (): Promise<void> => {
    if (state.kind !== "ready" || state.nextCursor === null) {
      return;
    }
    setState({ ...state, loadingMore: true });
    const loaded = await loadActivity(basePath, applied, state.nextCursor);
    if (loaded.kind === "ok") {
      setState({
        kind: "ready",
        events: [...state.events, ...loaded.value.events],
        nextCursor: loaded.value.nextCursor,
        loadingMore: false,
      });
    } else {
      setState({ kind: loaded.kind });
    }
  };

  const columns: TableColumnsType<AuditEvent> = [
    {
      title: t("activity.time"),
      key: "time",
      render: (_, event) =>
        new Date(event.occurredAt).toLocaleString(
          document.documentElement.lang === "zh-CN" ? "zh-CN" : "en-GB",
        ),
    },
    {
      title: t("activity.actor"),
      key: "actor",
      render: (_, event) =>
        event.actorDisplayName ??
        event.actorEmail ??
        event.actorPersonId ??
        "—",
    },
    { title: t("activity.action"), dataIndex: "action", key: "action" },
    {
      title: t("activity.target"),
      key: "target",
      render: (_, event) => {
        const reference =
          event.targetId === null
            ? event.targetType
            : `${event.targetType} · ${event.targetId}`;
        return event.targetLabel === null ? (
          reference
        ) : (
          <>
            <div>{event.targetLabel}</div>
            <div className="muted">{reference}</div>
          </>
        );
      },
    },
    {
      title: t("activity.channel"),
      key: "channel",
      render: (_, event) => (
        <>
          <Tag>{event.channel}</Tag>
          {event.agentHost && <div>{event.agentHost}</div>}
          {event.credentialId && (
            <div className="muted">{event.credentialId}</div>
          )}
        </>
      ),
    },
    {
      title: t("activity.reason"),
      key: "reason",
      render: (_, event) => event.reason ?? "—",
    },
  ];

  return (
    <div className="page" data-testid="page-activity">
      <PageHeader
        title={t("page.activity.title")}
        description={t("page.activity.description")}
      />
      <Space wrap style={{ marginBottom: 16 }}>
        <Input
          aria-label={t("activity.filterActor")}
          placeholder={t("activity.filterActor")}
          value={draft.actorEmail}
          onChange={(event) =>
            setDraft({ ...draft, actorEmail: event.target.value })
          }
        />
        <Input
          aria-label={t("activity.filterAction")}
          placeholder={t("activity.filterAction")}
          value={draft.action}
          onChange={(event) =>
            setDraft({ ...draft, action: event.target.value })
          }
        />
        <Input
          aria-label={t("activity.filterTarget")}
          placeholder={t("activity.filterTarget")}
          value={draft.targetType}
          onChange={(event) =>
            setDraft({ ...draft, targetType: event.target.value })
          }
        />
        <Input
          aria-label={t("activity.filterFrom")}
          style={{ minWidth: 160 }}
          type="datetime-local"
          value={draft.from}
          onChange={(event) => setDraft({ ...draft, from: event.target.value })}
        />
        <Input
          aria-label={t("activity.filterTo")}
          style={{ minWidth: 160 }}
          type="datetime-local"
          value={draft.to}
          onChange={(event) => setDraft({ ...draft, to: event.target.value })}
        />
        <Select
          aria-label={t("activity.filterChannel")}
          style={{ minWidth: 160 }}
          value={draft.channel === "" ? undefined : draft.channel}
          allowClear
          placeholder={t("activity.allChannels")}
          onChange={(value) => setDraft({ ...draft, channel: value ?? "" })}
          options={CHANNELS.map((channel) => ({
            value: channel,
            label: channel,
          }))}
        />
        <Button type="primary" onClick={() => setApplied(draft)}>
          {t("activity.apply")}
        </Button>
        <Button
          onClick={() => {
            setDraft(EMPTY_FILTERS);
            setApplied(EMPTY_FILTERS);
          }}
        >
          {t("common.clear")}
        </Button>
      </Space>

      {state.kind === "loading" && (
        <p className="muted">{t("common.loading")}</p>
      )}
      {state.kind === "denied" && (
        <p className="empty-state" data-testid="activity-denied">
          {t("activity.denied")}
        </p>
      )}
      {state.kind === "failed" && (
        <Alert type="error" showIcon message={t("activity.failed")} />
      )}
      {state.kind === "ready" && (
        <>
          {state.events.length === 0 ? (
            <p className="empty-state" data-testid="activity-empty">
              {t("activity.empty")}
            </p>
          ) : (
            <div data-testid="activity-table">
              <Table<AuditEvent>
                rowKey="id"
                dataSource={state.events}
                columns={columns}
                pagination={false}
                size="small"
              />
            </div>
          )}
          {state.nextCursor !== null && (
            <Button
              style={{ marginTop: 16 }}
              loading={state.loadingMore}
              onClick={() => void loadMore()}
            >
              {t("activity.loadMore")}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
