import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  startTestService,
  type TestService,
  type TestServiceOptions,
} from "../src/testing/index.js";

let service: TestService | undefined;

afterEach(async () => {
  await service?.close();
  service = undefined;
});

/** Starts a service that must fail, and returns why it failed. */
async function startFailing(options: TestServiceOptions): Promise<Error> {
  const outcome: unknown = await startTestService(options).then(
    (started) => {
      service = started;
      return undefined;
    },
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(Error);
  return outcome as Error;
}

async function refusal(
  options: TestServiceOptions,
  message: RegExp,
): Promise<void> {
  const error = await startFailing(options);
  expect(error.name).toBe("ConfigurationError");
  expect(error.message).toMatch(message);
}

describe("local single-user mode", () => {
  it("recognizes one implicit Administrator over loopback", async () => {
    service = await startTestService({ mode: "local" });

    const page = await service.request("/");

    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Local Administrator");
    expect(html).toContain("Role: Administrator");

    const me = await service.request("/api/v1/me");
    expect(await me.json()).toMatchObject({
      person: {
        email: "admin@badger.local",
        displayName: "Local Administrator",
        roles: ["Administrator"],
      },
      credential: { kind: "local-implicit", id: null },
    });
  });

  it("binds to loopback by default", async () => {
    service = await startTestService({
      mode: "local",
      environment: { BADGER_HOST: undefined },
    });

    expect(service.config.host).toBe("127.0.0.1");
    expect((await service.request("/")).status).toBe(200);
  });

  it("refuses a Host header that is not loopback", async () => {
    service = await startTestService({ mode: "local" });

    for (const host of ["badger.example", "127.lan.example"]) {
      const response = await service.rawRequest({
        path: "/",
        headers: { host },
      });
      expect(response.status, host).toBe(403);
    }
  });

  it("refuses a foreign Origin header", async () => {
    service = await startTestService({ mode: "local" });

    const response = await service.rawRequest({
      path: "/",
      headers: { host: "127.0.0.1", origin: "http://badger.example" },
    });

    expect(response.status).toBe(403);
  });

  it("accepts its own loopback Origin on the port it bound, and no other", async () => {
    service = await startTestService({ mode: "local" });
    const own = `http://127.0.0.1:${service.port}`;
    const other = `http://127.0.0.1:${service.port + 1}`;

    const accepted = await service.rawRequest({
      path: "/",
      headers: { host: `127.0.0.1:${service.port}`, origin: own },
    });
    const refused = await service.rawRequest({
      path: "/",
      headers: { host: `127.0.0.1:${service.port}`, origin: other },
    });

    expect(accepted.status).toBe(200);
    expect(refused.status).toBe(403);
  });

  it("allows the loopback origins it is given instead of its own", async () => {
    service = await startTestService({
      mode: "local",
      environment: { BADGER_ALLOWED_ORIGINS: "http://localhost:5173" },
    });

    const given = await service.rawRequest({
      path: "/",
      headers: { host: "localhost", origin: "http://localhost:5173" },
    });
    const own = await service.rawRequest({
      path: "/",
      headers: {
        host: "localhost",
        origin: `http://localhost:${service.port}`,
      },
    });

    expect(given.status).toBe(200);
    expect(own.status).toBe(403);
  });

  it("keeps its PGlite state on disk across restarts", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "badger-local-"));
    const dataDir = path.join(directory, "pglite");
    const local: TestServiceOptions = {
      mode: "local",
      environment: { BADGER_DATABASE_PATH: dataDir },
    };
    try {
      service = await startTestService(local);
      expect(service.config.database).toEqual({ kind: "pglite", dataDir });
      const first = (await (await service.request("/api/v1/me")).json()) as {
        person: { id: string };
      };
      await service.close();

      service = await startTestService(local);
      const again = (await (await service.request("/api/v1/me")).json()) as {
        person: { id: string };
      };
      const health = (await (await service.request("/health")).json()) as {
        migrations: { state: string };
      };

      expect(again.person.id).toBe(first.person.id);
      expect(health.migrations.state).toBe("applied");
    } finally {
      await service?.close();
      service = undefined;
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

describe("local mode settings", () => {
  it("refuses to bind beyond loopback", async () => {
    await refusal(
      { mode: "local", environment: { BADGER_HOST: "0.0.0.0" } },
      /binds to loopback only/u,
    );
    await refusal(
      { mode: "local", environment: { BADGER_HOST: "127.lan.example" } },
      /binds to loopback only/u,
    );
  });

  it("refuses hostnames and origins beyond loopback", async () => {
    await refusal(
      {
        mode: "local",
        environment: { BADGER_ALLOWED_HOSTNAMES: "badger.example" },
      },
      /loopback hostnames only/u,
    );
    await refusal(
      {
        mode: "local",
        environment: { BADGER_ALLOWED_ORIGINS: "https://badger.example" },
      },
      /loopback origins only/u,
    );
  });

  it("never reports secrets in an error message", async () => {
    const error = await startFailing({
      mode: "service",
      environment: {
        BADGER_IDENTITY: undefined,
        BADGER_DATABASE_URL: "postgres://badger:hunter2@db:5432/badger",
      },
    });

    expect(error.message).toMatch(/BADGER_IDENTITY/u);
    expect(String(error)).not.toContain("hunter2");
  });
});

describe("service mode settings", () => {
  it("requires an identity adapter, allowed hostnames, and a database", async () => {
    await refusal(
      { mode: "service", environment: { BADGER_IDENTITY: undefined } },
      /BADGER_IDENTITY/u,
    );
    await refusal(
      { mode: "service", environment: { BADGER_ALLOWED_HOSTNAMES: undefined } },
      /BADGER_ALLOWED_HOSTNAMES/u,
    );
    await refusal(
      { mode: "service", environment: { BADGER_DATABASE_URL: undefined } },
      /BADGER_DATABASE_URL/u,
    );
  });

  it("does not offer loopback identity to a service deployment", async () => {
    await refusal(
      { mode: "service", environment: { BADGER_IDENTITY: "local" } },
      /local single-user mode/u,
    );
  });

  it("refuses an identity adapter this build does not provide", async () => {
    await refusal(
      { mode: "service", environment: { BADGER_IDENTITY: "openid-connect" } },
      /openid-connect/u,
    );
  });

  it("refuses bootstrap Administrators that are not email addresses", async () => {
    await refusal(
      { environment: { BADGER_BOOTSTRAP_ADMINISTRATORS: "robin" } },
      /BADGER_BOOTSTRAP_ADMINISTRATORS/u,
    );
  });
});
