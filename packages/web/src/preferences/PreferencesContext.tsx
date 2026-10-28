import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  loadPerson,
  loadPreferences,
  savePreferencesRequest,
  type Person,
} from "./api.js";
import {
  DEFAULT_PREFERENCES,
  type Preferences,
  type StoredPreferences,
} from "./model.js";

export type SaveState = "idle" | "saving" | "saved" | "failed";

export interface PreferencesContextValue {
  preferences: StoredPreferences;
  person: Person | null;
  status: "loading" | "ready";
  saveState: SaveState;
  update(patch: Partial<Preferences>): void;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

/**
 * Holds the signed-in person's choices. Every change applies to the page at
 * once and is saved to the service; a failed save says so instead of
 * pretending the choice is stored.
 */
export function PreferencesProvider({
  basePath,
  children,
}: {
  basePath: string;
  children: ReactNode;
}) {
  const [preferences, setPreferences] =
    useState<StoredPreferences>(DEFAULT_PREFERENCES);
  const [person, setPerson] = useState<Person | null>(null);
  const [status, setStatus] = useState<"loading" | "ready">("loading");
  const [saveState, setSaveState] = useState<SaveState>("idle");

  const latest = useRef(preferences);
  const pending = useRef<StoredPreferences | null>(null);
  const saving = useRef(false);

  useEffect(() => {
    latest.current = preferences;
  }, [preferences]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void Promise.all([
      loadPreferences(basePath, controller.signal),
      loadPerson(basePath, controller.signal),
    ])
      .then(([loaded, signedIn]) => {
        if (!active) {
          return;
        }
        latest.current = loaded;
        setPreferences(loaded);
        setPerson(signedIn);
      })
      .catch(() => {
        // The defaults stand; the dashboard still opens.
      })
      .finally(() => {
        if (active) {
          setStatus("ready");
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [basePath]);

  const flush = useCallback(async () => {
    if (saving.current) {
      return;
    }
    saving.current = true;
    setSaveState("saving");
    let failed = false;
    let retries = 0;
    try {
      while (pending.current !== null) {
        const next = pending.current;
        pending.current = null;
        const outcome = await savePreferencesRequest(basePath, next);
        if (outcome.kind === "saved") {
          latest.current = outcome.preferences;
          setPreferences(outcome.preferences);
          retries = 0;
        } else if (outcome.kind === "conflict" && retries < 2) {
          // Keep the person's choice, adopt the stored revision, and retry.
          retries += 1;
          const reconciled: StoredPreferences = {
            ...latest.current,
            revision: outcome.preferences.revision,
            updatedAt: outcome.preferences.updatedAt,
          };
          latest.current = reconciled;
          pending.current = reconciled;
          setPreferences(reconciled);
        } else {
          failed = true;
          break;
        }
      }
    } finally {
      saving.current = false;
      if (failed) {
        setSaveState("failed");
      } else {
        setSaveState("saved");
      }
    }
  }, [basePath]);

  const update = useCallback(
    (patch: Partial<Preferences>) => {
      const next: StoredPreferences = { ...latest.current, ...patch };
      latest.current = next;
      pending.current = next;
      setPreferences(next);
      void flush();
    },
    [flush],
  );

  const value = useMemo<PreferencesContextValue>(
    () => ({ preferences, person, status, saveState, update }),
    [preferences, person, status, saveState, update],
  );

  return (
    <PreferencesContext.Provider value={value}>
      {children}
    </PreferencesContext.Provider>
  );
}

export function usePreferences(): PreferencesContextValue {
  const value = useContext(PreferencesContext);
  if (value === null) {
    throw new Error("usePreferences must be used inside PreferencesProvider");
  }
  return value;
}
