import { describe, expect, it } from "vitest";
import type { SaveOutcome } from "../src/preferences/api.js";
import {
  DEFAULT_PREFERENCES,
  type StoredPreferences,
} from "../src/preferences/model.js";
import { createPreferencesSaver } from "../src/preferences/saver.js";

interface PendingSave {
  request: StoredPreferences;
  answer(outcome: SaveOutcome | Error): void;
}

/** A saver whose service answers only when the test says so. */
function saverWithService(initial: StoredPreferences = DEFAULT_PREFERENCES) {
  const saves: PendingSave[] = [];
  const saver = createPreferencesSaver({
    initial,
    save: (request) =>
      new Promise<SaveOutcome>((resolve, reject) => {
        saves.push({
          request,
          answer: (outcome) =>
            outcome instanceof Error ? reject(outcome) : resolve(outcome),
        });
      }),
    onChange: () => {},
  });
  return { saver, saves };
}

/** Lets the saver react to the answer it was just given. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const stored = (changes: Partial<StoredPreferences>): StoredPreferences => ({
  ...DEFAULT_PREFERENCES,
  updatedAt: "2026-10-28T00:00:00.000Z",
  ...changes,
});

describe("saving personal preferences", () => {
  it("shows a change at once and reports it saved once the service stores it", async () => {
    const { saver, saves } = saverWithService();

    const done = saver.change({ theme: "dark" });
    expect(saver.view()).toMatchObject({
      preferences: { theme: "dark" },
      saveState: "saving",
    });
    expect(saves[0]?.request).toMatchObject({ theme: "dark", revision: 0 });

    saves[0]?.answer({
      kind: "saved",
      preferences: stored({ theme: "dark", revision: 1 }),
    });
    await done;
    expect(saver.view()).toMatchObject({
      preferences: { theme: "dark", revision: 1 },
      saveState: "saved",
    });
  });

  it("saves a change made during a save next, instead of losing it", async () => {
    const { saver, saves } = saverWithService();

    const done = saver.change({ fontScale: 110 });
    saver.change({ fontScale: 120 });
    expect(saves).toHaveLength(1);
    expect(saver.view().preferences.fontScale).toBe(120);

    saves[0]?.answer({
      kind: "saved",
      preferences: stored({ fontScale: 110, revision: 1 }),
    });
    await settle();
    expect(saver.view().preferences.fontScale).toBe(120);
    expect(saves[1]?.request).toMatchObject({ fontScale: 120, revision: 1 });

    saves[1]?.answer({
      kind: "saved",
      preferences: stored({ fontScale: 120, revision: 2 }),
    });
    await done;
    expect(saver.view()).toMatchObject({
      preferences: { fontScale: 120, revision: 2 },
      saveState: "saved",
    });
  });

  it("reports a save that never reached the service as failed, and keeps the change for the next save", async () => {
    const { saver, saves } = saverWithService();

    const failed = saver.change({ language: "zh" });
    saves[0]?.answer(new TypeError("Failed to fetch"));
    await failed;
    expect(saver.view()).toMatchObject({
      preferences: { language: "zh" },
      saveState: "failed",
    });

    const retried = saver.change({ theme: "light" });
    expect(saves[1]?.request).toMatchObject({
      language: "zh",
      theme: "light",
      revision: 0,
    });
    saves[1]?.answer({
      kind: "saved",
      preferences: stored({ language: "zh", theme: "light", revision: 1 }),
    });
    await retried;
    expect(saver.view().saveState).toBe("saved");
  });

  it("keeps another device's choices on a conflict and saves only this person's change over them", async () => {
    const { saver, saves } = saverWithService(stored({ revision: 1 }));

    const done = saver.change({ fontScale: 110 });
    saves[0]?.answer({
      kind: "conflict",
      preferences: stored({ theme: "dark", revision: 2 }),
    });
    await settle();
    expect(saves[1]?.request).toMatchObject({
      theme: "dark",
      fontScale: 110,
      revision: 2,
    });

    saves[1]?.answer({
      kind: "saved",
      preferences: stored({ theme: "dark", fontScale: 110, revision: 3 }),
    });
    await done;
    expect(saver.view()).toMatchObject({
      preferences: { theme: "dark", fontScale: 110, revision: 3 },
      saveState: "saved",
    });
  });

  it("stops with a failure when conflicts keep coming", async () => {
    const { saver, saves } = saverWithService();

    const done = saver.change({ theme: "dark" });
    for (let revision = 1; revision <= 3; revision += 1) {
      saves[revision - 1]?.answer({
        kind: "conflict",
        preferences: stored({ revision }),
      });
      await settle();
    }
    await done;

    expect(saves).toHaveLength(3);
    expect(saver.view()).toMatchObject({
      preferences: { theme: "dark", revision: 3 },
      saveState: "failed",
    });
  });

  it("keeps a newer saved revision when a slower first read arrives", async () => {
    const { saver, saves } = saverWithService();

    const done = saver.change({ theme: "dark" });
    saves[0]?.answer({
      kind: "saved",
      preferences: stored({ theme: "dark", revision: 4 }),
    });
    await done;
    saver.adopt(stored({ theme: "light", revision: 3 }));

    expect(saver.view().preferences).toMatchObject({
      theme: "dark",
      revision: 4,
    });
  });
});
