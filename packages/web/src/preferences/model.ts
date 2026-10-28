import { fontScaleFactor } from "../theme/tokens.js";
import { isRecord } from "../util/records.js";

export type Language = "en" | "zh";
export type ThemeChoice = "system" | "light" | "dark";

export interface Preferences {
  language: Language;
  theme: ThemeChoice;
  fontScale: number;
  railCollapsed: boolean;
}

/** What the service stores, including the revision a write must quote. */
export interface StoredPreferences extends Preferences {
  revision: number;
  updatedAt: string | null;
}

export const DEFAULT_PREFERENCES: StoredPreferences = {
  language: "en",
  theme: "system",
  fontScale: 100,
  railCollapsed: false,
  revision: 0,
  updatedAt: null,
};

export const LANGUAGES: readonly Language[] = ["en", "zh"];
export const THEMES: readonly ThemeChoice[] = ["system", "light", "dark"];
export const FONT_SCALE_STEP = 10;

/**
 * Reads the service's preferences payload defensively: a value this build
 * does not understand falls back rather than breaking the dashboard.
 */
export function parseStoredPreferences(
  value: unknown,
): StoredPreferences | null {
  if (!isRecord(value)) {
    return null;
  }
  const language = value["language"];
  const theme = value["theme"];
  const fontScale = value["fontScale"];
  const railCollapsed = value["railCollapsed"];
  const revision = value["revision"];
  const updatedAt = value["updatedAt"];
  if (
    !LANGUAGES.includes(language as Language) ||
    !THEMES.includes(theme as ThemeChoice) ||
    typeof fontScale !== "number" ||
    !Number.isFinite(fontScale) ||
    typeof railCollapsed !== "boolean" ||
    typeof revision !== "number" ||
    !Number.isInteger(revision) ||
    revision < 0 ||
    (updatedAt !== null && typeof updatedAt !== "string")
  ) {
    return null;
  }
  return {
    language: language as Language,
    theme: theme as ThemeChoice,
    fontScale: clampFontScale(fontScale),
    railCollapsed,
    revision,
    updatedAt,
  };
}

export function clampFontScale(scale: number): number {
  return Math.round(fontScaleFactor(scale) * 100);
}

/** The body a save sends: the choices plus the revision they were read at. */
export function preferencesWrite(
  preferences: StoredPreferences,
): Preferences & { revision: number } {
  return {
    language: preferences.language,
    theme: preferences.theme,
    fontScale: preferences.fontScale,
    railCollapsed: preferences.railCollapsed,
    revision: preferences.revision,
  };
}
