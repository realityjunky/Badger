import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyReminderText,
  isWeComUserId,
  notificationRequest,
  type CopyReminder,
} from "../src/api/notifications.js";

const copy: CopyReminder = {
  workflowName: "sample-workflow",
  event: "question-assigned",
  recipients: [
    { name: "Dr Lin", count: 2 },
    { name: "Dr\nWu", count: 1 },
  ],
  href: "/questionnaire/questions/q-1",
};

describe("the WeCom userid field", () => {
  it("accepts WeCom's characters, '@' included, after a leading letter or digit", () => {
    for (const value of ["lin", "lin.wei@lab-2_x", "7wu", "a".repeat(64)])
      expect(isWeComUserId(value), value).toBe(true);
  });

  it("refuses @all in any case, and anything WeCom would not issue", () => {
    for (const value of [
      "@all",
      "@ALL",
      "@All",
      "all",
      "ALL",
      "@lin",
      "_lin",
      "lin wei",
      "a".repeat(65),
      "",
    ])
      expect(isWeComUserId(value), value).toBe(false);
  });
});

describe("Copy reminder", () => {
  it("writes the viewer's language and links from the page's origin and base path", () => {
    expect(
      copyReminderText(copy, "en", "https://badger.example.com", "/badger"),
    ).toBe(
      [
        "Reminder · sample-workflow",
        "Questions waiting for answers",
        "Dr Lin: 2",
        "Dr Wu: 1",
        "https://badger.example.com/badger/questionnaire/questions/q-1",
      ].join("\n"),
    );
    expect(copyReminderText(copy, "zh", "http://localhost:4319", "/")).toBe(
      [
        "提醒 · sample-workflow",
        "问题等待回答",
        "Dr Lin: 2",
        "Dr Wu: 1",
        "http://localhost:4319/questionnaire/questions/q-1",
      ].join("\n"),
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the notification client", () => {
  it("carries the server's reason for a refusal", async () => {
    const reason =
      "This deployment must set BADGER_PUBLIC_URL before a robot can be saved";
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "conflict", message: reason },
            requestId: "request-1",
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);

    expect(
      await notificationRequest(
        "/badger",
        "/groups/g-1/notifications/channel",
        "PUT",
        { confirmed: true },
      ),
    ).toEqual({ kind: "conflict", message: reason });
    expect(fetch).toHaveBeenCalledWith(
      "/badger/api/v1/groups/g-1/notifications/channel",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("gives an empty reason when a refusal carries none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Bad gateway", { status: 502 })),
    );

    expect(await notificationRequest("/", "/me/notifications")).toEqual({
      kind: "failed",
      message: "",
    });
  });
});
