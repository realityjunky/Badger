import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import { useLiveUpdates } from "../live/LiveUpdatesContext.js";
import {
  loadInbox,
  markInbox,
  EMPTY_INBOX_FILTERS,
  type InboxFilters,
  type InboxItem,
  type InboxPage,
} from "../api/inbox.js";

interface InboxView {
  page: InboxPage;
  failed: boolean;
  busy: boolean;
  loading: boolean;
  filters: InboxFilters;
  hasFilters: boolean;
  invalidDates: boolean;
  setFilters(filters: InboxFilters): void;
  hasOlderPage: boolean;
  refresh(): Promise<void>;
  mark(item: InboxItem): Promise<void>;
  older(): void;
  newest(): void;
}
const InboxContext = createContext<InboxView | null>(null);
const EMPTY: InboxPage = {
  items: [],
  unreadCount: 0,
  pendingCount: 0,
  pendingQuestionCount: 0,
  pendingGateCount: 0,
  nextCursor: null,
};

/** Polling also picks up worker and other people's changes while this tab is open. */
export function InboxProvider({
  basePath,
  children,
}: {
  basePath: string;
  children: ReactNode;
}) {
  const [page, setPage] = useState<InboxPage>(EMPTY);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [{ cursor, filters }, setQuery] = useState<{
    cursor: string | null;
    filters: InboxFilters;
  }>({ cursor: null, filters: EMPTY_INBOX_FILTERS });
  const invalidDates =
    filters.from !== "" && filters.to !== "" && filters.from > filters.to;
  const hasFilters =
    filters.workflowIds.length > 0 ||
    filters.states.length > 0 ||
    filters.from !== "" ||
    filters.to !== "";
  const sequence = useRef(0);
  const location = useLocation();
  const { notice } = useLiveUpdates();
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    if (invalidDates) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const value = await loadInbox(basePath, cursor, filters);
      if (request === sequence.current) {
        setPage(value);
        setFailed(false);
      }
    } catch {
      if (request === sequence.current) setFailed(true);
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, [basePath, cursor, filters, invalidDates]);
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;

  const changeQuery = (nextCursor: string | null, nextFilters = filters) => {
    if (nextCursor === cursor && nextFilters === filters) {
      void refresh();
      return;
    }
    sequence.current++;
    setPage((current) => ({ ...current, items: [], nextCursor: null }));
    setFailed(false);
    setLoading(true);
    setQuery({ cursor: nextCursor, filters: nextFilters });
  };

  useEffect(() => {
    if (notice.inbox) void refresh();
  }, [notice, refresh]);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 10_000);
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      sequence.current++;
    };
  }, [refresh, location.pathname]);

  const mark = async (item: InboxItem) => {
    if (busy) return;
    setBusy(true);
    try {
      await markInbox(basePath, item);
      await latestRefresh.current();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <InboxContext.Provider
      value={{
        page,
        failed,
        busy,
        loading,
        filters,
        hasFilters,
        invalidDates,
        setFilters: (value) => changeQuery(null, value),
        hasOlderPage: cursor !== null,
        refresh,
        mark,
        older: () => {
          if (page.nextCursor !== null) changeQuery(page.nextCursor);
        },
        newest: () => changeQuery(null),
      }}
    >
      {children}
    </InboxContext.Provider>
  );
}

export function useInbox(): InboxView {
  const value = useContext(InboxContext);
  if (value === null)
    throw new Error("useInbox must be used inside InboxProvider");
  return value;
}
