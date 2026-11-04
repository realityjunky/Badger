import type { Language } from "./model.js";

/**
 * The central workspace's language key. Every same-origin surface shares it,
 * so Badger reads it at startup and follows it for the life of the page.
 */
export const PORTAL_LANGUAGE_KEY = "hugo_ai_portal_lang";

function isLanguage(value: unknown): value is Language {
  return value === "en" || value === "zh";
}

export function readPortalLanguage(): Language | null {
  try {
    const value = window.localStorage.getItem(PORTAL_LANGUAGE_KEY);
    return isLanguage(value) ? value : null;
  } catch {
    return null;
  }
}

export function writePortalLanguage(language: Language): void {
  try {
    window.localStorage.setItem(PORTAL_LANGUAGE_KEY, language);
  } catch {
    // A blocked storage area leaves Badger on its own preference.
  }
}

/** Calls `onChange` when another same-origin surface changes the language. */
export function subscribePortalLanguage(
  onChange: (language: Language) => void,
): () => void {
  const handler = (event: StorageEvent): void => {
    if (event.key === PORTAL_LANGUAGE_KEY && isLanguage(event.newValue)) {
      onChange(event.newValue);
    }
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}
