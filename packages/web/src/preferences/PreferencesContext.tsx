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
  type Language,
  type Preferences,
  type StoredPreferences,
} from "./model.js";
import {
  readPortalLanguage,
  subscribePortalLanguage,
  writePortalLanguage,
} from "./portalLanguage.js";
import {
  createPreferencesSaver,
  type PreferencesView,
  type SaveState,
} from "./saver.js";
import { useDemoMode } from "../app/DemoContext.js";

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
  const demoMode = useDemoMode();
  const [view, setView] = useState<PreferencesView>({
    preferences: DEFAULT_PREFERENCES,
    saveState: "idle",
  });
  const [person, setPerson] = useState<Person | null>(null);
  const [status, setStatus] = useState<"loading" | "ready">("loading");
  // The central workspace is the outer layer. Its language, when present,
  // wins over the server preference for the life of this page.
  const [portalLanguage, setPortalLanguage] = useState<Language | null>(() =>
    readPortalLanguage(),
  );

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
        // Nothing above Badger has chosen yet: publish the saved preference so
        // the workspace and the other same-origin surfaces agree on it.
        if (readPortalLanguage() === null) {
          writePortalLanguage(loaded.language);
          setPortalLanguage(loaded.language);
        }
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

  useEffect(() => subscribePortalLanguage(setPortalLanguage), []);

  const update = useCallback(
    (patch: Partial<Preferences>) => {
      if (patch.language !== undefined) {
        // A choice made inside Badger is also made for every other surface.
        writePortalLanguage(patch.language);
        setPortalLanguage(patch.language);
      }
      if (demoMode) {
        setView((current) => ({
          preferences: { ...current.preferences, ...patch },
          saveState: "idle",
        }));
      } else {
        void saver.change(patch);
      }
    },
    [saver, demoMode],
  );

  const preferences = useMemo<StoredPreferences>(
    () =>
      portalLanguage === null
        ? view.preferences
        : { ...view.preferences, language: portalLanguage },
    [view.preferences, portalLanguage],
  );

  const value = useMemo<PreferencesContextValue>(
    () => ({
      preferences,
      person,
      status,
      saveState: view.saveState,
      update,
    }),
    [preferences, person, status, update],
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
