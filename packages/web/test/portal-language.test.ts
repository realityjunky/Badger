import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PORTAL_LANGUAGE_KEY,
  readPortalLanguage,
  subscribePortalLanguage,
  writePortalLanguage,
} from "../src/preferences/portalLanguage.js";

type StorageListener = (event: StorageEvent) => void;

/** A window just wide enough for the portal-language bridge. */
function stubWindow() {
  const values = new Map<string, string>();
  const listeners = new Set<StorageListener>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
    addEventListener: (type: string, listener: StorageListener) => {
      if (type === "storage") listeners.add(listener);
    },
    removeEventListener: (type: string, listener: StorageListener) => {
      if (type === "storage") listeners.delete(listener);
    },
  });
  return {
    values,
    emit: (key: string, newValue: string | null) => {
      for (const listener of listeners) {
        listener({ key, newValue } as StorageEvent);
      }
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("portal language bridge", () => {
  it("reads only the shared key's en and zh values", () => {
    const { values } = stubWindow();
    expect(readPortalLanguage()).toBeNull();
    values.set(PORTAL_LANGUAGE_KEY, "zh");
    expect(readPortalLanguage()).toBe("zh");
    values.set(PORTAL_LANGUAGE_KEY, "fr");
    expect(readPortalLanguage()).toBeNull();
  });

  it("writes the shared key", () => {
    const { values } = stubWindow();
    writePortalLanguage("zh");
    expect(values.get(PORTAL_LANGUAGE_KEY)).toBe("zh");
  });

  it("notifies on the shared key and stops after unsubscribe", () => {
    const { emit } = stubWindow();
    const seen: string[] = [];
    const unsubscribe = subscribePortalLanguage((language) =>
      seen.push(language),
    );

    emit(PORTAL_LANGUAGE_KEY, "zh");
    emit("primevo_lang", "en");
    emit(PORTAL_LANGUAGE_KEY, "fr");
    emit(PORTAL_LANGUAGE_KEY, "en");
    unsubscribe();
    emit(PORTAL_LANGUAGE_KEY, "zh");

    expect(seen).toEqual(["zh", "en"]);
  });
});
