import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
};

const robinAdministers = {
  environment: { BADGER_BOOTSTRAP_ADMINISTRATORS: "Robin@Example.com" },
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

    const me = await service.request("/api/v1/me");
    expect(me.status).toBe(401);
    expect(await me.json()).toMatchObject({
      error: { code: "unauthenticated" },
    });
  });

  it("reports who is signed in to the API, with the roles Badger grants", async () => {
    service = await startTestService(robinAdministers);

    const response = await service.request("/api/v1/me", { as: robin });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      person: {
        id: expect.any(String),
        issuer: "test-issuer",
        subject: "robin",
        email: "robin@example.com",
        displayName: "Robin Alvarez",
        roles: ["Administrator"],
        groups: [],
      },
      credential: { kind: "session", id: "test-session" },
      signOut: false,
    });
  });

  it("grants no role that the deployment has not configured", async () => {
    service = await startTestService();

    const response = await service.request("/api/v1/me", { as: robin });

    expect(await response.json()).toMatchObject({ person: { roles: [] } });
  });

  it("refuses a write to a read-only route before signing anyone in", async () => {
    service = await startTestService({
      environment: { BADGER_ALLOWED_ORIGINS: "http://localhost" },
    });

    const response = await service.request("/api/v1/me", {
      method: "PUT",
      as: alice,
      headers: { origin: "http://localhost" },
      body: "{}",
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(await response.json()).toMatchObject({ error: { code: "invalid" } });
  });

  it("names the methods a path serves when it refuses one", async () => {
    service = await startTestService({
      environment: { BADGER_ALLOWED_ORIGINS: "http://localhost" },
    });

    const group = await service.request("/api/v1/groups", {
      method: "PUT",
      headers: { origin: "http://localhost" },
    });
    expect(group.status).toBe(405);
    expect(group.headers.get("allow")).toBe("GET, HEAD, POST");

    const one = await service.request("/api/v1/groups/id-0001", {
      method: "POST",
      headers: { origin: "http://localhost" },
    });
    expect(one.status).toBe(405);
    expect(one.headers.get("allow")).toBe("PATCH");
  });

  it("serves the API under its version only", async () => {
    service = await startTestService();

    const response = await service.request("/api/me", { as: alice });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid" },
    });
  });

  it("answers a foreign Host header with a refusal", async () => {
    service = await startTestService();

    const response = await service.rawRequest({
      path: "/",
      headers: { host: "evil.example" },
    });

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({
      error: { code: "denied" },
    });
  });

  it("answers a foreign Origin header with a refusal", async () => {
    service = await startTestService();

    const response = await service.rawRequest({
      path: "/",
      headers: { host: "127.0.0.1", origin: "https://evil.example" },
    });

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({
      error: { code: "denied" },
    });
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

    const echoed = await service.request("/api/v1/me", {
      as: alice,
      headers: { "x-request-id": "request-42" },
    });
    expect(echoed.headers.get("x-request-id")).toBe("request-42");

    const generated = await service.request("/api/v1/me", { as: alice });
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
    expect(await response.json()).toMatchObject({
      error: { code: "unavailable" },
    });
  });

  it("serves no person page when no people-facing adapter is configured", async () => {
    service = await startTestService({ mode: "service" });

    expect((await service.request("/")).status).toBe(401);
    expect((await service.request("/api/v1/me")).status).toBe(401);
    expect((await service.request("/health")).status).toBe(200);
  });
});

describe("the in-process test harness", () => {
  it("starts with a fixed clock, fixed IDs, and temporary storage", async () => {
    service = await startTestService();

    expect(service.clock.now().toISOString()).toBe("2026-10-27T00:00:00.000Z");
    expect(service.ids.next()).toBe("id-0001");
    expect(service.ids.next()).toBe("id-0002");

    const { storage } = service.config;
    for (const directory of [
      storage.root,
      storage.blobDirectory,
      storage.workspaceDirectory,
      storage.runDirectory,
    ]) {
      expect((await fs.stat(directory)).isDirectory()).toBe(true);
    }
    expect(
      storage.root.startsWith(path.join(os.tmpdir(), "badger-test-")),
    ).toBe(true);
  });

  it("reports the database it runs on", async () => {
    service = await startTestService();

    expect(service.database.kind).toBe(
      process.env["BADGER_TEST_DATABASE_URL"] ? "postgres" : "pglite",
    );
  });
});
