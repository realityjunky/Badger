import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_INBOX_FILTERS, loadInbox } from "../src/api/inbox.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("inbox filters", () => {
  it("sends combined workflow and status choices alongside the page cursor and deployment prefix", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ items: [] }),
    );
    vi.stubGlobal("fetch", request);
    await loadInbox("/badger", "opaque cursor", {
      ...EMPTY_INBOX_FILTERS,
      workflowIds: ["workflow/one", "workflow-two"],
      states: ["unread", "read"],
    });
    const url = new URL(
      String(request.mock.calls[0]![0]),
      "https://badger.example.com",
    );
    expect(url.pathname).toBe("/badger/api/v1/me/inbox");
    expect(url.searchParams.getAll("workflowId")).toEqual([
      "workflow/one",
      "workflow-two",
    ]);
    expect(url.searchParams.getAll("state")).toEqual(["unread", "read"]);
    expect(url.searchParams.get("cursor")).toBe("opaque cursor");
    expect(url.searchParams.has("createdFrom")).toBe(false);
    expect(url.searchParams.has("createdBefore")).toBe(false);
  });

  it.each([
    ["2026-03-08", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"],
    ["2026-11-01", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"],
  ])(
    "includes the entire local date %s across daylight-saving changes",
    async (date, from, before) => {
      vi.stubEnv("TZ", "America/New_York");
      const request = vi.fn<typeof fetch>(async () =>
        Response.json({ items: [] }),
      );
      vi.stubGlobal("fetch", request);
      await loadInbox("/", null, {
        ...EMPTY_INBOX_FILTERS,
        from: date,
        to: date,
      });
      const url = new URL(
        String(request.mock.calls[0]![0]),
        "https://badger.example.com",
      );
      expect(url.searchParams.get("createdFrom")).toBe(from);
      expect(url.searchParams.get("createdBefore")).toBe(before);
    },
  );
});
