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
  type InboxItem,
  type InboxPage,
} from "../api/inbox.js";

interface InboxView {
  page: InboxPage;
  failed: boolean;
  busy: boolean;
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
  const [cursor, setCursor] = useState<string | null>(null);
  const sequence = useRef(0);
  const location = useLocation();
  const { notice } = useLiveUpdates();
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const value = await loadInbox(basePath, cursor);
      if (request === sequence.current) {
        setPage(value);
        setFailed(false);
      }
    } catch {
      if (request === sequence.current) setFailed(true);
    }
  }, [basePath, cursor]);

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
      await refresh();
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
        hasOlderPage: cursor !== null,
        refresh,
        mark,
        older: () => {
          if (page.nextCursor !== null) setCursor(page.nextCursor);
        },
        newest: () => setCursor(null),
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
