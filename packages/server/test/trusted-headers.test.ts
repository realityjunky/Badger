import { afterEach, describe, expect, it } from "vitest";
import { startTestService, type TestService } from "../src/testing/index.js";

let service: TestService | undefined;
afterEach(async () => {
  await service?.close();
  service = undefined;
});

const environment = {
  BADGER_IDENTITY: "trusted-header",
  BADGER_TRUSTED_HEADER_ISSUER: "https://identity.example",
  BADGER_TRUSTED_PROXY_ADDRESSES: "127.0.0.1",
};
const headers = {
  "x-badger-subject": "alice-id",
  "x-badger-email": "alice@example.com",
  "x-badger-name": "Alice Ng",
};

describe("signing in through trusted headers", () => {
  it("accepts identity only from a configured socket peer", async () => {
    service = await startTestService({ mode: "service", environment });
    const response = await service.request("/api/v1/me", { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      person: {
        issuer: "https://identity.example",
        subject: "alice-id",
        email: "alice@example.com",
        displayName: "Alice Ng",
        roles: [],
      },
      credential: { kind: "session", id: expect.any(String) },
    });
  });

  it("reads UTF-8 identity from the proxy and accepts personal access tokens beside it", async () => {
    service = await startTestService({
      mode: "service",
      environment: {
        ...environment,
        BADGER_ALLOWED_ORIGINS: "http://localhost",
      },
    });
    // Header bytes arrive as Latin-1; the proxy sent UTF-8.
    const name = Buffer.from("张三", "utf8").toString("latin1");
    const me = await service.request("/api/v1/me", {
      headers: { ...headers, "x-badger-name": name },
    });
    expect(await me.json()).toMatchObject({
      person: { displayName: "张三" },
      signOut: false,
    });
    const created = await service.request("/api/v1/me/tokens", {
      method: "POST",
      headers: {
        ...headers,
        "x-badger-name": name,
        origin: "http://localhost",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Expert Agent", scopes: ["expert"] }),
    });
    expect(created.status).toBe(201);
    const { secret } = await created.json();
    // The token decides, whatever identity headers come with it.
    const bearer = await service.request("/api/v1/me", {
      headers: {
        authorization: `Bearer ${secret}`,
        "x-badger-subject": "mallory-id",
        "x-badger-email": "mallory@example.com",
      },
    });
    expect(bearer.status).toBe(200);
    expect(await bearer.json()).toMatchObject({
      person: { subject: "alice-id", displayName: "张三" },
      credential: { kind: "token" },
    });
  });

  it("ignores forged identity and forwarded addresses from an untrusted peer", async () => {
    service = await startTestService({
      mode: "service",
      environment: {
        ...environment,
        BADGER_TRUSTED_PROXY_ADDRESSES: "192.0.2.10",
      },
    });
    const response = await service.request("/api/v1/me", {
      headers: {
        ...headers,
        "x-forwarded-for": "192.0.2.10",
        "x-real-ip": "192.0.2.10",
        forwarded: "for=192.0.2.10",
      },
    });
    expect(response.status).toBe(401);
  });

  it("matches an IPv4 proxy setting against a mapped peer on an IPv6 listener", async (context) => {
    try {
      service = await startTestService({
        mode: "service",
        environment: { ...environment, BADGER_HOST: "::" },
      });
    } catch (error) {
      if (
        error instanceof Error &&
        "syscall" in error &&
        error.syscall === "listen" &&
        "code" in error &&
        (error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL")
      ) {
        context.skip();
        return;
      }
      throw error;
    }

    // An IPv4 connection to the dual-stack listener arrives as ::ffff:127.0.0.1.
    const accepted = await fetch(`http://127.0.0.1:${service.port}/api/v1/me`, {
      headers,
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      person: { subject: "alice-id", displayName: "Alice Ng" },
    });
    // The harness's IPv6 loopback connection has peer ::1, outside the list.
    const refused = await service.request("/api/v1/me", { headers });
    expect(refused.status).toBe(401);
  });

  it("recognizes IPv4-mapped proxy addresses and configurable header names", async () => {
    service = await startTestService({
      mode: "service",
      environment: {
        ...environment,
        BADGER_TRUSTED_PROXY_ADDRESSES: "::ffff:127.0.0.1",
        BADGER_TRUSTED_HEADER_SUBJECT: "Remote-User",
        BADGER_TRUSTED_HEADER_EMAIL: "Remote-Email",
        BADGER_TRUSTED_HEADER_NAME: "Remote-Name",
      },
    });
    expect((await service.request("/api/v1/me", { headers })).status).toBe(401);
    const response = await service.request("/api/v1/me", {
      headers: {
        "remote-user": "alice-id",
        "remote-email": "alice@example.com",
        "remote-name": "Alice Ng",
      },
    });
    expect(response.status).toBe(200);
  });

  it("refuses missing or ambiguous identity headers", async () => {
    service = await startTestService({ mode: "service", environment });
    const candidates: Record<string, string>[] = [
      {},
      { "x-badger-subject": "alice-id" },
      { ...headers, "x-badger-subject": "alice-id, administrator" },
      { ...headers, "x-badger-email": "not-an-email" },
    ];
    for (const candidate of candidates) {
      expect(
        (await service.request("/api/v1/me", { headers: candidate })).status,
      ).toBe(401);
    }
  });

  it("resolves verified email bindings and keeps them with the external subject", async () => {
    service = await startTestService({
      mode: "service",
      environment: {
        ...environment,
        BADGER_TRUSTED_HEADER_EMAILS_VERIFIED: "true",
        BADGER_BOOTSTRAP_ADMINISTRATORS: "admin@example.com",
        BADGER_ALLOWED_ORIGINS: "https://badger.example",
      },
    });
    const invitation = await service.request("/api/v1/bindings", {
      method: "POST",
      headers: {
        "x-badger-subject": "admin",
        "x-badger-email": "admin@example.com",
        origin: "https://badger.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email: "alice@example.com",
        role: "Auditor",
        scopeType: "organization",
      }),
    });
    expect(invitation.status).toBe(201);
    const first = await (
      await service.request("/api/v1/me", { headers })
    ).json();
    expect(first.person.roles).toEqual(["Auditor"]);
    const changed = await (
      await service.request("/api/v1/me", {
        headers: { ...headers, "x-badger-email": "new@example.com" },
      })
    ).json();
    expect(changed.person.id).toBe(first.person.id);
    expect(changed.person.roles).toEqual(["Auditor"]);
    const impostor = await (
      await service.request("/api/v1/me", {
        headers: { ...headers, "x-badger-subject": "other-id" },
      })
    ).json();
    expect(impostor.person.roles).toEqual([]);
    const foreignWrite = await service.request("/api/v1/bindings", {
      method: "POST",
      headers: { ...headers, origin: "https://foreign.example" },
      body: "{}",
    });
    expect(foreignWrite.status).toBe(403);
  });

  it("does not grant bootstrap roles for email unless the proxy vouches for verification", async () => {
    service = await startTestService({
      mode: "service",
      environment: {
        ...environment,
        BADGER_BOOTSTRAP_ADMINISTRATORS: "alice@example.com",
      },
    });
    const response = await service.request("/api/v1/me", { headers });
    expect((await response.json()).person.roles).toEqual([]);
  });

  it.each([undefined, "proxy.example", "0.0.0.0/0"])(
    "fails startup without exact trusted proxy addresses (%s)",
    async (addresses) => {
      await expect(
        startTestService({
          mode: "service",
          environment: {
            ...environment,
            BADGER_TRUSTED_PROXY_ADDRESSES: addresses,
          },
        }),
      ).rejects.toThrow(/BADGER_TRUSTED_PROXY_ADDRESSES/u);
    },
  );
});
