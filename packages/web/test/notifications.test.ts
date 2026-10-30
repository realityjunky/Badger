import { afterEach, describe, expect, it, vi } from "vitest";
import { notificationRequest } from "../src/api/notifications.js";

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
