import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFERENCES,
  parseStoredPreferences,
  preferencesWrite,
} from "../src/preferences/model.js";
import { apiUrl, normalizeBasePath } from "../src/app/paths.js";

describe("personal preferences", () => {
  it("starts from #24's defaults", () => {
    expect(DEFAULT_PREFERENCES).toEqual({
      language: "en",
      theme: "system",
      fontScale: 100,
      railCollapsed: false,
      revision: 0,
      updatedAt: null,
    });
  });

  it("reads the service's payload, clamping a stray font scale", () => {
    expect(
      parseStoredPreferences({
        language: "zh",
        theme: "dark",
        fontScale: 200,
        railCollapsed: true,
        revision: 4,
        updatedAt: "2026-10-27T00:00:00.000Z",
      }),
    ).toEqual({
      language: "zh",
      theme: "dark",
      fontScale: 150,
      railCollapsed: true,
      revision: 4,
      updatedAt: "2026-10-27T00:00:00.000Z",
    });
  });

  it("refuses a payload it does not understand", () => {
    for (const value of [
      null,
      [],
      "zh",
      {
        language: "fr",
        theme: "dark",
        fontScale: 100,
        railCollapsed: false,
        revision: 1,
        updatedAt: null,
      },
      {
        language: "zh",
        theme: "sepia",
        fontScale: 100,
        railCollapsed: false,
        revision: 1,
        updatedAt: null,
      },
      {
        language: "zh",
        theme: "dark",
        fontScale: "big",
        railCollapsed: false,
        revision: 1,
        updatedAt: null,
      },
      {
        language: "zh",
        theme: "dark",
        fontScale: 100,
        railCollapsed: "no",
        revision: 1,
        updatedAt: null,
      },
      {
        language: "zh",
        theme: "dark",
        fontScale: 100,
        railCollapsed: false,
        revision: -1,
        updatedAt: null,
      },
    ]) {
      expect(parseStoredPreferences(value), JSON.stringify(value)).toBeNull();
    }
  });

  it("quotes the revision it read when saving", () => {
    expect(
      preferencesWrite({
        language: "zh",
        theme: "dark",
        fontScale: 120,
        railCollapsed: true,
        revision: 3,
        updatedAt: "2026-10-27T00:00:00.000Z",
      }),
    ).toEqual({
      language: "zh",
      theme: "dark",
      fontScale: 120,
      railCollapsed: true,
      revision: 3,
    });
  });
});

describe("the deployment's base path", () => {
  it("normalizes what the server injects", () => {
    expect(normalizeBasePath("/")).toBe("/");
    expect(normalizeBasePath("")).toBe("/");
    expect(normalizeBasePath(null)).toBe("/");
    expect(normalizeBasePath("/badger")).toBe("/badger");
    expect(normalizeBasePath("/badger/")).toBe("/badger");
    expect(normalizeBasePath("badger")).toBe("/badger");
  });

  it("builds API addresses under the base path", () => {
    expect(apiUrl("/", "/me/preferences")).toBe("/api/v1/me/preferences");
    expect(apiUrl("/badger", "/me/preferences")).toBe(
      "/badger/api/v1/me/preferences",
    );
    expect(apiUrl("/badger/", "me")).toBe("/badger/api/v1/me");
  });
});
