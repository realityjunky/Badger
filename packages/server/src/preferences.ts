import { recordAudit, type AuditChannel } from "./audit.js";
import type { Database, Queryable } from "./database/database.js";
import type { ServiceDependencies } from "./dependencies.js";
import type { Credential } from "./identity/identity.js";
import { toIsoString } from "./util.js";

export type Language = "en" | "zh";
export type ThemeChoice = "system" | "light" | "dark";

export const LANGUAGES: readonly Language[] = ["en", "zh"];
export const THEMES: readonly ThemeChoice[] = ["system", "light", "dark"];
export const MIN_FONT_SCALE = 90;
export const MAX_FONT_SCALE = 150;

/** What a person's dashboard looks and speaks like. */
export interface Preferences {
  language: Language;
  theme: ThemeChoice;
  /** A percentage: 100 is the base type size. */
  fontScale: number;
  railCollapsed: boolean;
}

/**
 * A person's saved preferences, or the defaults with revision 0 before they
 * have saved any. A write quotes the revision it read.
 */
export interface StoredPreferences extends Preferences {
  revision: number;
  updatedAt: string | null;
}

export const DEFAULT_PREFERENCES: Preferences = {
  language: "en",
  theme: "system",
  fontScale: 100,
  railCollapsed: false,
};

interface PreferencesRow {
  language: Language;
  theme: ThemeChoice;
  font_scale: number;
  rail_collapsed: boolean;
  revision: number;
  updated_at: Date | string;
}

const PREFERENCE_COLUMNS = `language, theme, font_scale, rail_collapsed,
       revision, updated_at`;

function toStoredPreferences(row: PreferencesRow): StoredPreferences {
  return {
    language: row.language,
    theme: row.theme,
    fontScale: row.font_scale,
    railCollapsed: row.rail_collapsed,
    revision: row.revision,
    updatedAt: toIsoString(row.updated_at),
  };
}

/** Reads one person's preferences; the defaults stand until they save. */
export async function readPreferences(
  database: Queryable,
  personId: string,
): Promise<StoredPreferences> {
  const rows = await database.query<PreferencesRow>(
    `select ${PREFERENCE_COLUMNS}
       from person_preferences
      where person_id = $1`,
    [personId],
  );
  const row = rows.rows[0];
  return row === undefined
    ? { ...DEFAULT_PREFERENCES, revision: 0, updatedAt: null }
    : toStoredPreferences(row);
}

export interface PreferencesInput {
  /** The revision the person read; 0 means they have saved none yet. */
  revision: number;
  preferences: Preferences;
}

export type PreferencesParseResult =
  { ok: true; value: PreferencesInput } | { ok: false; message: string };

const INPUT_KEYS = new Set([
  "revision",
  "language",
  "theme",
  "fontScale",
  "railCollapsed",
]);

/** Validates a preferences write. Unknown keys are refused, not ignored. */
export function parsePreferencesInput(body: unknown): PreferencesParseResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "The request body must be a JSON object" };
  }
  const input = body as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => !INPUT_KEYS.has(key));
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `Unknown preference ${unknown.join(", ")}`,
    };
  }

  const { revision, language, theme, fontScale, railCollapsed } = input;
  if (!Number.isInteger(revision) || (revision as number) < 0) {
    return { ok: false, message: "revision must be a whole number from 0" };
  }
  if (!LANGUAGES.includes(language as Language)) {
    return {
      ok: false,
      message: `language must be one of ${LANGUAGES.join(", ")}`,
    };
  }
  if (!THEMES.includes(theme as ThemeChoice)) {
    return { ok: false, message: `theme must be one of ${THEMES.join(", ")}` };
  }
  if (
    !Number.isInteger(fontScale) ||
    (fontScale as number) < MIN_FONT_SCALE ||
    (fontScale as number) > MAX_FONT_SCALE
  ) {
    return {
      ok: false,
      message: `fontScale must be a whole number from ${MIN_FONT_SCALE} to ${MAX_FONT_SCALE}`,
    };
  }
  if (typeof railCollapsed !== "boolean") {
    return { ok: false, message: "railCollapsed must be true or false" };
  }

  return {
    ok: true,
    value: {
      revision: revision as number,
      preferences: {
        language: language as Language,
        theme: theme as ThemeChoice,
        fontScale: fontScale as number,
        railCollapsed,
      },
    },
  };
}

export interface PreferencesWriteContext {
  personId: string;
  credential: Credential;
  channel: AuditChannel;
  requestId: string;
}

export type SavePreferencesResult =
  | { kind: "saved"; preferences: StoredPreferences }
  | { kind: "conflict"; preferences: StoredPreferences };

function samePreferences(left: Preferences, right: Preferences): boolean {
  return (
    left.language === right.language &&
    left.theme === right.theme &&
    left.fontScale === right.fontScale &&
    left.railCollapsed === right.railCollapsed
  );
}

/**
 * Saves a person's choices against the revision they read. A write that
 * quotes a stale revision changes nothing and returns what is stored, so two
 * devices cannot silently overwrite one another. The write and its audit
 * record commit together.
 */
export async function savePreferences(
  database: Database,
  dependencies: ServiceDependencies,
  context: PreferencesWriteContext,
  input: PreferencesInput,
): Promise<SavePreferencesResult> {
  return database.transaction(async (tx) => {
    const current = await readPreferences(tx, context.personId);
    if (current.revision !== input.revision) {
      return { kind: "conflict", preferences: current };
    }
    if (samePreferences(current, input.preferences)) {
      return { kind: "saved", preferences: current };
    }

    const revision = current.revision + 1;
    const now = dependencies.clock.now();
    const values = [
      input.preferences.language,
      input.preferences.theme,
      input.preferences.fontScale,
      input.preferences.railCollapsed,
      revision,
      now,
    ];

    const written =
      current.revision === 0
        ? await tx.query<PreferencesRow>(
            `insert into person_preferences (
               person_id, language, theme, font_scale, rail_collapsed,
               revision, created_at, updated_at
             ) values ($1, $2, $3, $4, $5, $6, $7, $7)
             on conflict (person_id) do nothing
             returning ${PREFERENCE_COLUMNS}`,
            [context.personId, ...values.slice(0, 4), revision, now],
          )
        : await tx.query<PreferencesRow>(
            `update person_preferences
                set language = $2, theme = $3, font_scale = $4,
                    rail_collapsed = $5, revision = $6, updated_at = $7
              where person_id = $1 and revision = $8
              returning ${PREFERENCE_COLUMNS}`,
            [
              context.personId,
              ...values.slice(0, 4),
              revision,
              now,
              current.revision,
            ],
          );

    const row = written.rows[0];
    if (row === undefined) {
      // A concurrent write moved the revision; report what is stored.
      return {
        kind: "conflict",
        preferences: await readPreferences(tx, context.personId),
      };
    }

    await recordAudit(tx, dependencies, {
      actor: { personId: context.personId, credential: context.credential },
      channel: context.channel,
      action: "person.preferences_updated",
      target: { type: "person", id: context.personId },
      before:
        current.revision === 0
          ? null
          : { revision: current.revision, hash: null },
      after: { revision, hash: null },
      reason: "Personal preferences saved",
      requestId: context.requestId,
    });

    return { kind: "saved", preferences: toStoredPreferences(row) };
  });
}
