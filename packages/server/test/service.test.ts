import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { anonymousIdentityAdapter } from "../src/identity/anonymous.js";
import {
  startTestService,
  type TestPerson,
  type TestService,
} from "../src/testing/index.js";

let service: TestService | undefined;

afterEach(async () => {
  await service?.close();
  service = undefined;
});

const alice: TestPerson = {
  subject: "alice",
  email: "alice@example.com",
  displayName: "Alice Ng",
};

const robin: TestPerson = {
  subject: "robin",
  email: "robin@example.com",
  displayName: "Robin Alvarez",
  administrator: true,
};

describe("the service's web page", () => {
  it("shows the signed-in person", async () => {
    service = await startTestService();

    const response = await service.request("/", { as: alice });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("Alice Ng");
    expect(html).toContain("alice@example.com");
    expect(html).toContain("No role assigned");
  });

  it("escapes what a person's profile contains", async () => {
    service = await startTestService();

    const response = await service.request("/", {
      as: {
        subject: "mallory",
        email: "mallory@example.com",
        displayName: "<script>alert(1)</script>",
      },
    });

    const html = await response.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("refuses a request without a person", async () => {
    service = await startTestService();

    const page = await service.request("/");
    expect(page.status).toBe(401);
    expect(await page.text()).toContain("Not signed in");

    const me = await service.request("/api/me");
    expect(me.status).toBe(401);
    expect(await me.json()).toMatchObject({
      error: { code: "unauthenticated" },
    });
  });

  it("reports who is signed in to the API", async () => {
    service = await startTestService();

    const response = await service.request("/api/me", { as: robin });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      person: {
        id: expect.any(String),
        issuer: "test-issuer",
        subject: "robin",
        email: "robin@example.com",
        displayName: "Robin Alvarez",
        roles: ["Administrator"],
      },
      credential: { kind: "session", id: "test-session" },
    });
  });

  it("answers a foreign Host header with a refusal", async () => {
    service = await startTestService();

    const response = await service.rawRequest({
      path: "/",
      headers: { host: "evil.example" },
    });

    expect(response.status).toBe(403);
    expect(response.body).not.toContain("Robin");
  });

  it("answers a foreign Origin header with a refusal", async () => {
    service = await startTestService();

    const response = await service.rawRequest({
      path: "/",
      headers: { host: "127.0.0.1", origin: "https://evil.example" },
    });

    expect(response.status).toBe(403);
  });

  it("answers an unsafe request without an Origin with a refusal", async () => {
    service = await startTestService();

    const response = await service.rawRequest({
      method: "POST",
      path: "/",
      headers: { host: "127.0.0.1" },
    });

    expect(response.status).toBe(403);
  });

  it("echoes the caller's request ID and generates one otherwise", async () => {
    service = await startTestService();

    const echoed = await service.request("/api/me", {
      as: alice,
      headers: { "x-request-id": "request-42" },
    });
    expect(echoed.headers.get("x-request-id")).toBe("request-42");

    const generated = await service.request("/api/me", { as: alice });
    expect(generated.headers.get("x-request-id")).toMatch(
      /^req-[0-9a-f-]{36}$/u,
    );
  });

  it("reports an unavailable identity provider without granting access", async () => {
    service = await startTestService({
      identity: {
        resolve: async () => ({
          kind: "unavailable",
          reason: "identity provider unreachable",
        }),
      },
    });

    const response = await service.request("/");

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("Alice");
  });

  it("serves no person page when no people-facing adapter is configured", async () => {
    service = await startTestService({ identity: anonymousIdentityAdapter });

    expect((await service.request("/")).status).toBe(401);
    expect((await service.request("/health")).status).toBe(200);
  });
});

describe("the in-process test harness", () => {
  it("starts with a fixed clock, fixed IDs, and temporary storage", async () => {
    service = await startTestService();

    expect(service.clock.now().toISOString()).toBe("2026-10-27T00:00:00.000Z");
    expect(service.ids.next()).toBe("id-0001");
    expect(service.ids.next()).toBe("id-0002");

    for (const directory of [
      service.storage.root,
      service.storage.blobDirectory,
      service.storage.workspaceDirectory,
      service.storage.runDirectory,
    ]) {
      await expect(fs.stat(directory)).resolves.toMatchObject({
        isDirectory: expect.any(Function),
      });
    }
    expect(service.storage.root.startsWith("/tmp/")).toBe(true);
  });

  it("reports the database it runs on", async () => {
    service = await startTestService();

    expect(service.database.kind).toBe(
      process.env["BADGER_TEST_DATABASE_URL"] ? "postgres" : "pglite",
    );
  });
});
