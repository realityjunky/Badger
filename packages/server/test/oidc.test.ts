import { afterEach, describe, expect, it } from "vitest";
import {
  startStubOidcProvider,
  startTestService,
  type StubOidcProvider,
  type TestService,
} from "../src/testing/index.js";

let service: TestService | undefined;
let provider: StubOidcProvider | undefined;
const onPostgres = process.env["BADGER_TEST_DATABASE_URL"] !== undefined;
afterEach(async () => {
  await service?.close();
  service = undefined;
  await provider?.stop();
  provider = undefined;
});

async function start(environment: Record<string, string | undefined> = {}) {
  provider = await startStubOidcProvider();
  service = await startTestService({
    mode: "service",
    environment: {
      BADGER_IDENTITY: "oidc",
      BADGER_BASE_PATH: "/badger",
      BADGER_PUBLIC_URL: "https://badger.example/badger",
      BADGER_ALLOWED_ORIGINS: "https://badger.example",
      BADGER_OIDC_ISSUER: provider.issuer,
      BADGER_OIDC_CLIENT_ID: provider.clientId,
      BADGER_OIDC_CLIENT_SECRET: provider.clientSecret,
      ...environment,
    },
  });
  return service;
}

async function begin() {
  const login = await service!.request("/badger/auth/oidc/login", {
    redirect: "manual",
  });
  expect(login.status).toBe(303);
  const authorizationUrl = new URL(login.headers.get("location")!);
  expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
    "https://badger.example/badger/auth/oidc/callback",
  );
  const flowCookie = login.headers.getSetCookie()[0].split(";")[0];
  const authorization = await fetch(authorizationUrl, { redirect: "manual" });
  expect(authorization.status).toBe(302);
  const callback = new URL(authorization.headers.get("location")!);
  return {
    flowCookie,
    callback,
    completePath: `/badger/auth/oidc/complete${callback.search}`,
  };
}

async function signIn() {
  const flow = await begin();
  const response = await service!.request(flow.completePath, {
    redirect: "manual",
    headers: { cookie: flow.flowCookie },
  });
  expect(response.status).toBe(303);
  return {
    response,
    cookie: response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("badger_session="))!
      .split(";")[0],
  };
}

describe("OpenID Connect sign-in", () => {
  it("records session issuance and logout in Activity even when the person's profile is unchanged", async () => {
    const app = await start({
      BADGER_BOOTSTRAP_ADMINISTRATORS: "alice@example.com",
    });
    const first = await signIn();
    const second = await signIn();
    const me = await (
      await app.request("/badger/api/v1/me", {
        headers: { cookie: second.cookie },
      })
    ).json();
    const activity = async (action: string) => {
      const response = await app.request(
        `/badger/api/v1/audit-events?action=${action}`,
        { headers: { cookie: first.cookie } },
      );
      expect(response.status).toBe(200);
      return (await response.json()).events as Record<string, unknown>[];
    };
    const created = await activity("session.created");
    expect(created).toHaveLength(2);
    expect(created).toContainEqual(
      expect.objectContaining({
        actorPersonId: me.person.id,
        credentialKind: "session",
        credentialId: me.credential.id,
        channel: "web",
        targetType: "session",
        targetId: me.credential.id,
        before: null,
        after: { revision: null, hash: me.credential.id },
        reason: "OpenID Connect sign-in",
        requestId: second.response.headers.get("x-request-id"),
      }),
    );
    const logout = () =>
      app.request("/badger/auth/logout", {
        method: "POST",
        redirect: "manual",
        headers: {
          cookie: second.cookie,
          origin: "https://badger.example",
          "x-request-id": "session-logout",
        },
      });
    expect((await logout()).status).toBe(303);
    expect((await logout()).status).toBe(303);
    const revoked = await activity("session.revoked");
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({
      actorPersonId: me.person.id,
      credentialKind: "session",
      credentialId: me.credential.id,
      channel: "web",
      targetType: "session",
      targetId: me.credential.id,
      before: { revision: null, hash: me.credential.id },
      after: null,
      reason: "Signed out",
      requestId: "session-logout",
    });
    expect(JSON.stringify([...created, ...revoked])).not.toContain(
      second.cookie.split("=")[1],
    );
  });

  it.skipIf(!onPostgres)(
    "shares transactions and sessions across server instances",
    async () => {
      const first = await start();
      if (first.config.database.kind !== "postgres")
        throw new Error("This test needs Postgres");
      const second = await startTestService({
        mode: "service",
        environment: {
          BADGER_DATABASE_URL: first.config.database.url,
          BADGER_IDENTITY: "oidc",
          BADGER_BASE_PATH: "/badger",
          BADGER_PUBLIC_URL: "https://badger.example/badger",
          BADGER_OIDC_ISSUER: provider!.issuer,
          BADGER_OIDC_CLIENT_ID: provider!.clientId,
          BADGER_OIDC_CLIENT_SECRET: provider!.clientSecret,
        },
      });
      try {
        const flow = await begin();
        const completed = await second.request(flow.completePath, {
          redirect: "manual",
          headers: { cookie: flow.flowCookie },
        });
        expect(completed.status).toBe(303);
        const cookie = completed.headers
          .getSetCookie()
          .find((value) => value.startsWith("badger_session="))!
          .split(";")[0];
        const me = await first.request("/badger/api/v1/me", {
          headers: { cookie },
        });
        expect(me.status).toBe(200);
        expect((await me.json()).person.subject).toBe("alice-id");
        const replay = await first.request(flow.completePath, {
          redirect: "manual",
          headers: { cookie: flow.flowCookie },
        });
        expect(replay.status).toBe(400);
      } finally {
        await second.close();
      }
    },
  );

  it("exchanges a code with PKCE and issues a Strict Badger session under the base path", async () => {
    const app = await start();
    const page = await app.request("/badger/");
    expect(await page.text()).toContain("/badger/auth/oidc/login");
    const flow = await begin();
    const landing = await app.request(
      `${flow.callback.pathname}${flow.callback.search}`,
      { redirect: "manual" },
    );
    expect(landing.status).toBe(200);
    expect(await landing.text()).toContain("/badger/auth/oidc/complete?");
    const completed = await app.request(flow.completePath, {
      redirect: "manual",
      headers: { cookie: flow.flowCookie },
    });
    expect(completed.status).toBe(303);
    expect(completed.headers.get("location")).toBe("/badger/");
    const session = completed.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("badger_session="))!;
    expect(session).toContain("HttpOnly");
    expect(session).toContain("Secure");
    expect(session).toContain("SameSite=Strict");
    expect(session).toContain("Path=/badger");
    expect(session).not.toContain("Domain=");
    const me = await app.request("/badger/api/v1/me", {
      headers: { cookie: session.split(";")[0] },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      person: {
        issuer: provider!.issuer,
        subject: "alice-id",
        email: "alice@example.com",
        displayName: "Alice Ng",
        roles: [],
      },
      credential: {
        kind: "session",
        id: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
  });

  it("reports provider outages as unavailable, including during the code exchange", async () => {
    const app = await start();
    provider!.setFailure(503);
    const failed = await app.request("/badger/auth/oidc/login", {
      redirect: "manual",
    });
    expect(failed.status).toBe(503);
    expect(failed.headers.getSetCookie()).toEqual([]);
    provider!.setFailure(null);
    const flow = await begin();
    await provider!.stop();
    const exchange = await app.request(flow.completePath, {
      headers: { cookie: flow.flowCookie },
      redirect: "manual",
    });
    expect(exchange.status).toBe(503);
    expect(await exchange.json()).toMatchObject({
      error: { code: "unavailable" },
    });
  });

  it("resolves verified email bindings on first sign-in and keeps them with issuer and subject", async () => {
    const app = await start({
      BADGER_BOOTSTRAP_ADMINISTRATORS: "admin@example.com",
    });
    provider!.setClaims({ sub: "admin-id", email: "admin@example.com" });
    const admin = await signIn();
    const invitation = await app.request("/badger/api/v1/bindings", {
      method: "POST",
      headers: {
        cookie: admin.cookie,
        origin: "https://badger.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email: "alice@example.com",
        scopeType: "organization",
        role: "Auditor",
      }),
    });
    expect(invitation.status).toBe(201);
    provider!.setClaims({ email_verified: false });
    const unverified = await signIn();
    const before = await (
      await app.request("/badger/api/v1/me", {
        headers: { cookie: unverified.cookie },
      })
    ).json();
    expect(before.person.roles).toEqual([]);
    provider!.setClaims({});
    const alice = await signIn();
    const first = await (
      await app.request("/badger/api/v1/me", {
        headers: { cookie: alice.cookie },
      })
    ).json();
    expect(first.person.roles).toEqual(["Auditor"]);
    provider!.setClaims({ email: "alice.new@example.com" });
    const changed = await signIn();
    const after = await (
      await app.request("/badger/api/v1/me", {
        headers: { cookie: changed.cookie },
      })
    ).json();
    expect(after.person.id).toBe(first.person.id);
    expect(after.person.roles).toEqual(["Auditor"]);
    provider!.setClaims({ sub: "impostor" });
    const other = await signIn();
    expect(
      (
        await (
          await app.request("/badger/api/v1/me", {
            headers: { cookie: other.cookie },
          })
        ).json()
      ).person.roles,
    ).toEqual([]);
  });

  it("binds a single-use, expiring authorization transaction to its browser", async () => {
    const app = await start();
    const flow = await begin();
    const withoutCookie = await app.request(flow.completePath, {
      redirect: "manual",
    });
    expect(withoutCookie.status).toBe(400);
    const secondBrowser = await begin();
    const mismatched = await app.request(flow.completePath, {
      headers: { cookie: secondBrowser.flowCookie },
      redirect: "manual",
    });
    expect(mismatched.status).toBe(400);
    const success = await app.request(flow.completePath, {
      headers: { cookie: flow.flowCookie },
      redirect: "manual",
    });
    expect(success.status).toBe(303);
    const replay = await app.request(flow.completePath, {
      headers: { cookie: flow.flowCookie },
      redirect: "manual",
    });
    expect(replay.status).toBe(400);
    const expiring = await begin();
    app.clock.advance(601_000);
    expect(
      (
        await app.request(expiring.completePath, {
          headers: { cookie: expiring.flowCookie },
          redirect: "manual",
        })
      ).status,
    ).toBe(400);
  });

  it.each([
    { iss: "https://another-issuer.example" },
    { aud: "another-client" },
    { nonce: "another-nonce" },
    { exp: 1 },
    { sub: "" },
    { email: "invalid-address" },
  ])("refuses invalid ID token claims (%j)", async (claims) => {
    const app = await start();
    provider!.setClaims(claims);
    const flow = await begin();
    const response = await app.request(flow.completePath, {
      headers: { cookie: flow.flowCookie },
      redirect: "manual",
    });
    expect(response.status).toBe(400);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect((await app.request("/badger/api/v1/me")).status).toBe(401);
  });

  it("validates the ID token signature", async () => {
    const app = await start();
    provider!.setInvalidSignature(true);
    const flow = await begin();
    const response = await app.request(flow.completePath, {
      headers: { cookie: flow.flowCookie },
      redirect: "manual",
    });
    expect(response.status).toBe(400);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("expires sessions and revokes logout sessions without accepting foreign-origin writes", async () => {
    const app = await start({
      BADGER_SESSION_SECONDS: "60",
      BADGER_SESSION_COOKIE: "company_badger",
    });
    const flow = await begin();
    const login = await app.request(flow.completePath, {
      headers: { cookie: flow.flowCookie },
      redirect: "manual",
    });
    expect(login.status).toBe(303);
    const cookie = login.headers
      .getSetCookie()
      .find((value) => value.startsWith("company_badger="))!
      .split(";")[0];
    expect(
      (await app.request("/badger/api/v1/me", { headers: { cookie } })).status,
    ).toBe(200);
    for (const origin of [undefined, "https://foreign.example"]) {
      const headers: Record<string, string> = { cookie };
      if (origin !== undefined) headers.origin = origin;
      expect(
        (
          await app.request("/badger/auth/logout", {
            method: "POST",
            headers,
            redirect: "manual",
          })
        ).status,
      ).toBe(403);
    }
    const logout = await app.request("/badger/auth/logout", {
      method: "POST",
      headers: { cookie, origin: "https://badger.example" },
      redirect: "manual",
    });
    expect(logout.status).toBe(303);
    expect(logout.headers.getSetCookie()[0]).toContain("Max-Age=0");
    expect(
      (await app.request("/badger/api/v1/me", { headers: { cookie } })).status,
    ).toBe(401);
    const next = await begin();
    const newLogin = await app.request(next.completePath, {
      headers: { cookie: next.flowCookie },
      redirect: "manual",
    });
    const nextCookie = newLogin.headers
      .getSetCookie()
      .find((value) => value.startsWith("company_badger="))!
      .split(";")[0];
    expect(nextCookie).not.toBe(cookie);
    app.clock.advance(60_000);
    expect(
      (
        await app.request("/badger/api/v1/me", {
          headers: { cookie: nextCookie },
        })
      ).status,
    ).toBe(401);
  });

  it.each([
    { BADGER_OIDC_ISSUER: "http://identity.example" },
    { BADGER_OIDC_ISSUER: "https://identity.example?query=1" },
    { BADGER_PUBLIC_URL: "https://badger.example/wrong-path" },
    { BADGER_OIDC_CLIENT_SECRET: undefined },
    { BADGER_SESSION_COOKIE: "bad cookie" },
    { BADGER_SESSION_COOKIE: "__Host-badger" },
    {
      BADGER_SESSION_COOKIE: "platform_cookie",
      BADGER_PLATFORM_SESSION_COOKIE: "platform_cookie",
    },
    { BADGER_SESSION_SECONDS: "0" },
  ])("refuses unsafe or incomplete OIDC settings (%j)", async (settings) => {
    await expect(start(settings)).rejects.toThrow();
  });

  it("keeps bearer authentication independent and never accepts bearer credentials on browser sign-in routes", async () => {
    const app = await start();
    const loggedIn = await signIn();
    const headers = {
      cookie: loggedIn.cookie,
      authorization: "Bearer not-a-badger-token",
    };
    expect((await app.request("/badger/api/v1/me", { headers })).status).toBe(
      401,
    );
    expect(
      (
        await app.request("/badger/auth/oidc/login", {
          headers,
          redirect: "manual",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request("/badger/api/v1/me", {
          headers: { cookie: loggedIn.cookie },
        })
      ).status,
    ).toBe(200);
  });

  it.each(["/token", "/jwks"])(
    "treats a non-JSON provider failure at %s as unavailable",
    async (endpoint) => {
      const app = await start();
      const flow = await begin();
      provider!.setEndpointFailure(endpoint, 502, "Bad gateway");
      const response = await app.request(flow.completePath, {
        redirect: "manual",
        headers: { cookie: flow.flowCookie },
      });
      expect(response.status).toBe(503);
      expect(response.headers.getSetCookie()).toEqual([]);
    },
  );
});
