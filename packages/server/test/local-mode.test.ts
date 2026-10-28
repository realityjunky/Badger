import { afterEach, describe, expect, it } from "vitest";
import { ConfigurationError, loadConfig } from "../src/config.js";
import { startTestService, type TestService } from "../src/testing/index.js";

let service: TestService | undefined;

afterEach(async () => {
  await service?.close();
  service = undefined;
});

describe("local single-user mode", () => {
  it("recognizes one implicit Administrator over loopback", async () => {
    service = await startTestService({ mode: "local" });

    const page = await service.request("/");

    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Local Administrator");
    expect(html).toContain("Administrator");

    const me = await service.request("/api/me");
    expect(await me.json()).toMatchObject({
      person: {
        email: "admin@badger.local",
        displayName: "Local Administrator",
        roles: ["Administrator"],
      },
    });
  });

  it("refuses a Host header that is not loopback", async () => {
    service = await startTestService({ mode: "local" });

    const response = await service.rawRequest({
      path: "/",
      headers: { host: "badger.example" },
    });

    expect(response.status).toBe(403);
  });

  it("refuses a foreign Origin header", async () => {
    service = await startTestService({ mode: "local" });

    const response = await service.rawRequest({
      path: "/",
      headers: { host: "127.0.0.1", origin: "http://badger.example" },
    });

    expect(response.status).toBe(403);
  });

  it("accepts its own loopback Origin", async () => {
    service = await startTestService({ mode: "local" });

    const response = await service.rawRequest({
      path: "/",
      headers: { host: "127.0.0.1", origin: "http://127.0.0.1:8787" },
    });

    expect(response.status).toBe(200);
  });
});

describe("local mode configuration", () => {
  it("binds to loopback by default", () => {
    const config = loadConfig({ BADGER_MODE: "local" });

    expect(config.host).toBe("127.0.0.1");
    expect(config.mode).toBe("local");
    expect(config.identity.kind).toBe("local");
  });

  it("refuses to bind beyond loopback", () => {
    expect(() =>
      loadConfig({ BADGER_MODE: "local", BADGER_HOST: "0.0.0.0" }),
    ).toThrow(ConfigurationError);
    expect(() =>
      loadConfig({ BADGER_MODE: "local", BADGER_HOST: "0.0.0.0" }),
    ).toThrow(/loopback/u);
  });

  it("takes PGlite on disk unless a database URL is given", () => {
    const local = loadConfig({ BADGER_MODE: "local" });
    expect(local.database).toEqual({
      kind: "pglite",
      dataDir: ".badger/pglite",
    });

    const postgres = loadConfig({
      BADGER_MODE: "local",
      BADGER_DATABASE_URL: "postgres://badger:secret@127.0.0.1:5432/badger",
    });
    expect(postgres.database).toEqual({
      kind: "postgres",
      url: "postgres://badger:secret@127.0.0.1:5432/badger",
    });
  });

  it("never reports secrets in an error message", () => {
    try {
      loadConfig({
        BADGER_MODE: "service",
        BADGER_DATABASE_URL: "postgres://badger:hunter2@db:5432/badger",
      });
      expect.unreachable("service mode without an identity adapter must fail");
    } catch (error) {
      expect(String(error)).not.toContain("hunter2");
    }
  });
});

describe("service mode configuration", () => {
  it("requires an explicit identity adapter and allowed hosts", () => {
    expect(() => loadConfig({ BADGER_MODE: "service" })).toThrow(
      ConfigurationError,
    );

    const config = loadConfig({
      BADGER_MODE: "service",
      BADGER_IDENTITY: "none",
      BADGER_ALLOWED_HOSTNAMES: "badger.example",
      BADGER_DATABASE_URL: "postgres://badger:badger@db:5432/badger",
    });
    expect(config.mode).toBe("service");
    expect(config.allowedHostnames).toEqual(["badger.example"]);
    expect(config.identity).toEqual({ kind: "none" });

    expect(() =>
      loadConfig({
        BADGER_MODE: "service",
        BADGER_IDENTITY: "none",
        BADGER_DATABASE_URL: "postgres://badger:badger@db:5432/badger",
      }),
    ).toThrow(/BADGER_ALLOWED_HOSTNAMES/u);
  });

  it("does not offer loopback identity to a service deployment", () => {
    expect(() =>
      loadConfig({
        BADGER_MODE: "service",
        BADGER_IDENTITY: "local",
        BADGER_ALLOWED_HOSTNAMES: "badger.example",
        BADGER_DATABASE_URL: "postgres://badger:badger@db:5432/badger",
      }),
    ).toThrow(/local single-user mode/u);
  });

  it("refuses an identity adapter this build does not provide", () => {
    expect(() =>
      loadConfig({ BADGER_MODE: "service", BADGER_IDENTITY: "openid-connect" }),
    ).toThrow(/openid-connect/u);
  });
});
