import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
import {
  createPreferencesSaver,
  type PreferencesView,
  type SaveState,
} from "./saver.js";

export type { SaveState } from "./saver.js";

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
 * pretending the choice is stored (`saver.ts`).
 */
export function PreferencesProvider({
  basePath,
  children,
}: {
  basePath: string;
  children: ReactNode;
}) {
  const [view, setView] = useState<PreferencesView>({
    preferences: DEFAULT_PREFERENCES,
    saveState: "idle",
  });
  const [person, setPerson] = useState<Person | null>(null);
  const [status, setStatus] = useState<"loading" | "ready">("loading");

  const saver = useMemo(
    () =>
      createPreferencesSaver({
        initial: DEFAULT_PREFERENCES,
        save: (preferences) => savePreferencesRequest(basePath, preferences),
        onChange: setView,
      }),
    [basePath],
  );

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
        saver.adopt(loaded);
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
  }, [basePath, saver]);

  const update = useCallback(
    (patch: Partial<Preferences>) => {
      void saver.change(patch);
    },
    [saver],
  );

  const value = useMemo<PreferencesContextValue>(
    () => ({
      preferences: view.preferences,
      person,
      status,
      saveState: view.saveState,
      update,
    }),
    [view, person, status, update],
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
