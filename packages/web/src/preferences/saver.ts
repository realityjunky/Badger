import type { SaveOutcome } from "./api.js";
import type { Preferences, StoredPreferences } from "./model.js";

export type SaveState = "idle" | "saving" | "saved" | "failed";

/** How many conflicts in a row one save rides out before it reports failure. */
const CONFLICT_RETRIES = 2;

export interface PreferencesView {
  preferences: StoredPreferences;
  saveState: SaveState;
}

export interface PreferencesSaver {
  /** What the page shows: the stored choices with unsaved changes applied. */
  view(): PreferencesView;
  /** Adopts what the service read, unless a save already stored a newer revision. */
  adopt(loaded: StoredPreferences): void;
  /** Applies a change at once and saves it; settles when nothing is left to save. */
  change(patch: Partial<Preferences>): Promise<void>;
}

/**
 * Saves a person's choices one request at a time. What the service answers
 * is the stored state, and the changes it has not stored yet stay applied
 * over it, so a change made during a save is saved next instead of lost. A
 * conflict means another device saved first: its choices stand, and only
 * this person's changes are applied over them and saved again. A save that
 * does not reach the service is reported as failed, never as saved, and its
 * changes wait for the next one.
 */
export function createPreferencesSaver(options: {
  initial: StoredPreferences;
  save(preferences: StoredPreferences): Promise<SaveOutcome>;
  onChange(view: PreferencesView): void;
}): PreferencesSaver {
  let stored = options.initial;
  // Changes the request in flight carries, and changes made since.
  let sending: Partial<Preferences> = {};
  let unsaved: Partial<Preferences> = {};
  let saveState: SaveState = "idle";
  let running: Promise<void> | null = null;

  const view = (): PreferencesView => ({
    preferences: { ...stored, ...sending, ...unsaved },
    saveState,
  });
  const publish = () => options.onChange(view());

  async function drain(): Promise<void> {
    try {
      let conflicts = 0;
      while (Object.keys(unsaved).length > 0) {
        sending = unsaved;
        unsaved = {};
        let outcome: SaveOutcome;
        try {
          outcome = await options.save({ ...stored, ...sending });
        } catch {
          outcome = { kind: "failed" };
        }
        if (outcome.kind !== "saved") {
          // Keep these changes, beneath any the person made since.
          unsaved = { ...sending, ...unsaved };
        }
        sending = {};
        if (outcome.kind === "failed") {
          saveState = "failed";
          return;
        }
        stored = outcome.preferences;
        if (outcome.kind === "conflict") {
          conflicts += 1;
          if (conflicts > CONFLICT_RETRIES) {
            saveState = "failed";
            return;
          }
        } else {
          conflicts = 0;
        }
        publish();
      }
      saveState = "saved";
    } finally {
      running = null;
      publish();
    }
  }

  return {
    view,
    adopt(loaded) {
      if (loaded.revision >= stored.revision) {
        stored = loaded;
        publish();
      }
    },
    change(patch) {
      unsaved = { ...unsaved, ...patch };
      if (running === null) {
        saveState = "saving";
        running = drain();
      }
      publish();
      return running;
    },
  };
}
