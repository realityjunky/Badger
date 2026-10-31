import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { apiUrl } from "../app/paths.js";
import { useDemoMode } from "../app/DemoContext.js";

interface Notice {
  sequence: number;
  versionIds: string[];
  inbox: boolean;
}
const LiveUpdates = createContext({
  connected: false,
  notice: { sequence: 0, versionIds: [], inbox: true } as Notice,
});

/** A single per-person connection serves inboxes and every open record. */
export function LiveUpdatesProvider({
  basePath,
  children,
}: {
  basePath: string;
  children: ReactNode;
}) {
  const demoMode = useDemoMode();
  const [connected, setConnected] = useState(false);
  const [notice, setNotice] = useState<Notice>({
    sequence: 0,
    versionIds: [],
    inbox: true,
  });
  useEffect(() => {
    if (demoMode || typeof EventSource === "undefined") return;
    const stream = new EventSource(apiUrl(basePath, "/me/events"));
    stream.onopen = () => setConnected(true);
    stream.onerror = () => setConnected(false);
    const change = (event: MessageEvent<string>) => {
      try {
        const value = JSON.parse(event.data) as {
          versionIds?: unknown;
          inbox?: unknown;
        };
        if (
          !Array.isArray(value.versionIds) ||
          !value.versionIds.every((id) => typeof id === "string")
        )
          return;
        setNotice((previous) => ({
          sequence: previous.sequence + 1,
          versionIds: value.versionIds as string[],
          inbox: value.inbox === true,
        }));
      } catch {
        /* Reconnects and polling recover a malformed event. */
      }
    };
    stream.addEventListener("ready", change as EventListener);
    stream.addEventListener("change", change as EventListener);
    return () => stream.close();
  }, [basePath, demoMode]);
  return (
    <LiveUpdates.Provider value={{ connected, notice }}>
      {children}
    </LiveUpdates.Provider>
  );
}

export function useLiveUpdates() {
  return useContext(LiveUpdates);
}
