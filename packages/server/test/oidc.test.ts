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

async function begin(returnTo?: string, prefix = "/badger", cookie?: string) {
  const query =
    returnTo === undefined ? "" : `?${new URLSearchParams({ returnTo })}`;
  const login = await service!.request(`${prefix}/auth/oidc/login${query}`, {
    redirect: "manual",
    headers: cookie === undefined ? undefined : { cookie },
  });
  expect(login.status).toBe(303);
  const authorizationUrl = new URL(login.headers.get("location")!);
  expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
    `https://badger.example${prefix}/auth/oidc/callback`,
  );
  const flowCookie = login.headers
    .getSetCookie()
    .find((cookie) => !cookie.includes("Max-Age=0;"))!
    .split(";")[0];
  const authorization = await fetch(authorizationUrl, { redirect: "manual" });
  expect(authorization.status).toBe(302);
  const callback = new URL(authorization.headers.get("location")!);
  return {
    flowCookie,
    setCookies: login.headers.getSetCookie(),
    callback,
    completePath: `${prefix}/auth/oidc/complete${callback.search}`,
  };
}

function rememberCookies(jar: Map<string, string>, cookies: readonly string[]) {
  for (const cookie of cookies) {
    const pair = cookie.split(";")[0];
    const name = pair.slice(0, pair.indexOf("="));
    if (cookie.includes("Max-Age=0;")) jar.delete(name);
    else jar.set(name, pair);
  }
}

/** A finished flow's cookie, cleared: a failed completion sets no other. */
function clearedFlowCookie(flow: { flowCookie: string }) {
  return `${flow.flowCookie.split("=")[0]}=; Path=/badger; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
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
  it("keeps at most three browser flows and drops the oldest cookie on a fourth start", async () => {
    const app = await start();
    const jar = new Map<string, string>();
    const tabs = [];
    for (let index = 0; index < 4; index += 1) {
      const tab = await begin(
        undefined,
        "/badger",
        [...jar.values()].join("; "),
      );
      tabs.push(tab);
      for (const cookie of tab.setCookies) {
        expect(cookie).toContain("; Path=/badger;");
        expect(cookie).toContain("; HttpOnly; Secure; SameSite=Strict");
        expect(cookie).not.toContain("Domain=");
      }
      rememberCookies(jar, tab.setCookies);
      expect(jar.size).toBeLessThanOrEqual(3);
    }
    expect(jar.has(tabs[0].flowCookie.split("=")[0])).toBe(false);
    const dropped = await app.request(tabs[0].completePath, {
      redirect: "manual",
      headers: { cookie: [...jar.values()].join("; ") },
    });
    expect(dropped.status).toBe(400);
    for (const tab of tabs.slice(1)) {
      const completed = await app.request(tab.completePath, {
        redirect: "manual",
        headers: { cookie: [...jar.values()].join("; ") },
      });
      expect(completed.status).toBe(303);
      rememberCookies(jar, completed.headers.getSetCookie());
    }
    expect([...jar.keys()]).toEqual(["badger_session"]);
  });

  it("clears a failed tab's flow cookie, so its retry keeps the other tabs' sign-ins", async () => {
    const app = await start();
    const jar = new Map<string, string>();
    const cookies = () => [...jar.values()].join("; ");
    const tabs = [];
    for (let index = 0; index < 3; index += 1) {
      const tab = await begin(undefined, "/badger", cookies());
      rememberCookies(jar, tab.setCookies);
      tabs.push(tab);
    }
    provider!.setClaims({ sub: "" });
    const failed = await app.request(tabs[2].completePath, {
      redirect: "manual",
      headers: { cookie: cookies() },
    });
    expect(failed.status).toBe(400);
    expect(failed.headers.getSetCookie()).toEqual([clearedFlowCookie(tabs[2])]);
    rememberCookies(jar, failed.headers.getSetCookie());
    provider!.setClaims({});
    const retry = await begin(undefined, "/badger", cookies());
    rememberCookies(jar, retry.setCookies);
    for (const tab of [tabs[0], tabs[1], retry]) {
      const completed = await app.request(tab.completePath, {
        redirect: "manual",
        headers: { cookie: cookies() },
      });
      expect(completed.status).toBe(303);
      rememberCookies(jar, completed.headers.getSetCookie());
    }
    expect([...jar.keys()]).toEqual(["badger_session"]);
  });

  it("leaves other transactions intact when a cookie token does not match the callback state", async () => {
    const app = await start();
    const first = await begin();
    const second = await begin();
    const wrongToken = `${first.flowCookie.split("=")[0]}=${second.flowCookie.split("=")[1]}`;
    const failed = await app.request(first.completePath, {
      redirect: "manual",
      headers: { cookie: wrongToken },
    });
    expect(failed.status).toBe(400);
    for (const flow of [first, second]) {
      const completed = await app.request(flow.completePath, {
        redirect: "manual",
        headers: { cookie: flow.flowCookie },
      });
      expect(completed.status).toBe(303);
    }
  });

  it.each([
    { name: "older tab first", order: [0, 1] },
    { name: "newer tab first", order: [1, 0] },
  ])(
    "completes two pending sign-ins in one browser: $name",
    async ({ order }) => {
      const app = await start();
      const jar = new Map<string, string>();
      const first = await begin("/badger/my-work?tab=first");
      rememberCookies(jar, first.setCookies);
      const second = await begin(
        "/badger/settings/tokens?tab=second",
        "/badger",
        [...jar.values()].join("; "),
      );
      rememberCookies(jar, second.setCookies);
      const tabs = [first, second];
      for (const index of order) {
        const completed = await app.request(tabs[index].completePath, {
          redirect: "manual",
          headers: { cookie: [...jar.values()].join("; ") },
        });
        expect(completed.status).toBe(303);
        expect(completed.headers.get("location")).toBe(
          index === 0
            ? "/badger/my-work?tab=first"
            : "/badger/settings/tokens?tab=second",
        );
        rememberCookies(jar, completed.headers.getSetCookie());
      }
      expect([...jar.keys()]).toEqual(["badger_session"]);
    },
  );

  it("evicts the oldest pending sign-in without refusing a newer start", async () => {
    const app = await start({ BADGER_OIDC_MAX_PENDING_SIGN_INS: "2" });
    const oldest = await begin();
    app.clock.advance(1_000);
    const retained = await begin();
    app.clock.advance(1_000);
    const newest = await begin("/badger/my-work?view=inbox");

    const evicted = await app.request(oldest.completePath, {
      redirect: "manual",
      headers: { cookie: oldest.flowCookie },
    });
    expect(evicted.status).toBe(400);
    expect(await evicted.text()).toContain("Sign-in is invalid or expired.");
    expect(app.logs).toContainEqual(
      expect.objectContaining({
        event: "oidc.sign-in-failed",
        stage: "callback",
        outcome: "invalid",
      }),
    );

    for (const flow of [retained, newest]) {
      const completed = await app.request(flow.completePath, {
        redirect: "manual",
        headers: { cookie: flow.flowCookie },
      });
      expect(completed.status).toBe(303);
      if (flow === newest)
        expect(completed.headers.get("location")).toBe(
          "/badger/my-work?view=inbox",
        );
    }
  });

  it("logs evictions at most once a minute, writing each minute's count when it ends", async () => {
    const app = await start({ BADGER_OIDC_MAX_PENDING_SIGN_INS: "1" });
    const evictions = () =>
      app.logs.filter((entry) => entry["event"] === "oidc.sign-ins-evicted");
    const entry = (evictedCount: number) => ({
      level: "info",
      event: "oidc.sign-ins-evicted",
      evictedCount,
    });
    await begin();
    expect(evictions()).toEqual([]);
    await begin();
    expect(evictions()).toEqual([entry(1)]);
    await begin();
    await begin();
    app.clock.advance(59_999);
    expect(evictions()).toEqual([entry(1)]);
    // The burst's count is written when its minute ends, with no later start.
    app.clock.advance(1);
    expect(evictions()).toEqual([entry(1), entry(2)]);
    // A minute without evictions writes nothing; the next eviction is
    // written at once.
    app.clock.advance(60_000);
    expect(evictions()).toEqual([entry(1), entry(2)]);
    const newest = await begin();
    expect(evictions()).toEqual([entry(1), entry(2), entry(1)]);
    const completed = await app.request(newest.completePath, {
      redirect: "manual",
      headers: { cookie: newest.flowCookie },
    });
    expect(completed.status).toBe(303);
    // Closing the service stops the minute's timer.
    await begin();
    await begin();
    await app.close();
    app.clock.advance(60_000);
    expect(evictions()).toEqual([entry(1), entry(2), entry(1)]);
  });

  it("refuses no concurrent start and keeps only the cap once the starts in flight finish", async () => {
    const app = await start({ BADGER_OIDC_MAX_PENDING_SIGN_INS: "2" });
    // `begin` checks that each start redirects to the provider.
    const burst = await Promise.all(Array.from({ length: 8 }, () => begin()));
    // Every burst start has committed, so the next start evicts all but the
    // newest two.
    const newest = await begin();
    const statuses = [];
    for (const flow of [...burst, newest]) {
      const completed = await app.request(flow.completePath, {
        redirect: "manual",
        headers: { cookie: flow.flowCookie },
      });
      statuses.push(completed.status);
    }
    expect(statuses.filter((status) => status === 303)).toHaveLength(2);
    expect(statuses.filter((status) => status === 400)).toHaveLength(7);
    expect(statuses.at(-1)).toBe(303);
  });

  it.skipIf(!onPostgres)(
    "keeps a signed-in request prompt during a burst of starts at the cap",
    async () => {
      const app = await start();
      const { cookie } = await signIn();
      const login = () =>
        app.request("/badger/auth/oidc/login", { redirect: "manual" });
      const statuses = new Set<number>();
      // Fill the table to the default cap of 10,000 pending sign-ins.
      for (let started = 0; started < 10_000; started += 100)
        for (const response of await Promise.all(
          Array.from({ length: 100 }, login),
        ))
          statuses.add(response.status);
      const burst = Array.from({ length: 500 }, login);
      const before = performance.now();
      const me = await app.request("/badger/api/v1/me", {
        headers: { cookie },
      });
      const elapsed = performance.now() - before;
      for (const response of await Promise.all(burst))
        statuses.add(response.status);
      expect(me.status).toBe(200);
      expect([...statuses]).toEqual([303]);
      // About 0.4 s here. Starts that waited on one another, each sorting
      // the whole table, held every pooled connection and kept it waiting
      // 11 s; the fill alone took over two minutes.
      expect(elapsed).toBeLessThan(3_000);
    },
    // The fill and burst take about 8 s; the timeout leaves room on a busy host.
    60_000,
  );

  it("accepts the maximum pending sign-in setting", async () => {
    await start({ BADGER_OIDC_MAX_PENDING_SIGN_INS: "100000" });
    await signIn();
  });

  it("returns to the requested dashboard page and query after signing in", async () => {
    const app = await start();
    const destination = "/badger/my-work?view=inbox&item=gate%2F123";
    const page = await app.request(destination);
    expect(page.status).toBe(401);
    expect(await page.text()).toContain(
      `/badger/auth/oidc/login?${new URLSearchParams({ returnTo: destination })}`,
    );
    const flow = await begin(destination);
    expect(flow.flowCookie).not.toContain("returnTo");
    expect(flow.callback.searchParams.get("state")).not.toContain(destination);
    const completed = await app.request(flow.completePath, {
      redirect: "manual",
      headers: { cookie: flow.flowCookie },
    });
    expect(completed.status).toBe(303);
    expect(completed.headers.get("location")).toBe(destination);
  });

  it.each([
    "https://evil.example/path",
    "https://badger.example/badger/my-work",
    "//evil.example/path",
    "/\\evil.example/path",
    "/badger\\my-work",
    "/another-app/my-work",
    "/badger-other/my-work",
    "/badger/../another-app",
    "/badger/%2e%2e/another-app",
    "/badger/my-work\r\nlocation:https://evil.example",
    // A proxy that decodes the path before routing it would leave Badger.
    "/badger/..%2Fother-app/x",
    "/badger/..%2fother-app/x",
    "/badger/%2e%2e%2fother-app/x",
    "/badger/%2E%2E%2Fother-app/x",
    "/badger/.%2E/other-app/x",
    "/badger/..%5Cother-app/x",
    "/badger/%2e%2e%5cother-app/x",
    "/badger/my-work%2F%2Fevil.example",
    "/badger/..%252Fother-app/x",
    "/badger/%c0%ae%c0%ae%2fother-app/x",
    "/badger/%zz/my-work",
    "/badger/my-work%00",
  ])(
    "falls back to My work for an unsafe return path: %s",
    async (returnTo) => {
      const app = await start();
      const flow = await begin(returnTo);
      const completed = await app.request(flow.completePath, {
        redirect: "manual",
        headers: { cookie: flow.flowCookie },
      });
      expect(completed.status).toBe(303);
      expect(completed.headers.get("location")).toBe("/badger/");
    },
  );

  it.each([
    {
      name: "an encoded name and query",
      returnTo: "/badger/skills/%E4%B8%AD?file=reference%2Fnotes.md",
      location: "/badger/skills/%E4%B8%AD?file=reference%2Fnotes.md",
    },
    {
      name: "2,048 bytes",
      returnTo: `/badger/my-work?note=${"a".repeat(2027)}`,
      location: `/badger/my-work?note=${"a".repeat(2027)}`,
    },
    {
      name: "2,049 bytes",
      returnTo: `/badger/my-work?note=${"a".repeat(2028)}`,
      location: "/badger/",
    },
    {
      name: "over 2,048 bytes once percent-encoded",
      returnTo: `/badger/${"{".repeat(700)}`,
      location: "/badger/",
    },
  ])(
    "keeps a return path of at most 2,048 bytes: $name",
    async ({ returnTo, location }) => {
      const app = await start();
      const flow = await begin(returnTo);
      const completed = await app.request(flow.completePath, {
        redirect: "manual",
        headers: { cookie: flow.flowCookie },
      });
      expect(completed.status).toBe(303);
      expect(completed.headers.get("location")).toBe(location);
    },
  );

  it("refuses a return path that normalizes to a network-path URL at the root base path", async () => {
    const app = await start({
      BADGER_BASE_PATH: "/",
      BADGER_PUBLIC_URL: "https://badger.example",
    });
    const flow = await begin("/.//evil.example/path", "");
    const completed = await app.request(flow.completePath, {
      redirect: "manual",
      headers: { cookie: flow.flowCookie },
    });
    expect(completed.status).toBe(303);
    expect(completed.headers.get("location")).toBe("/");
  });

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
        const destination = "/badger/settings/tokens?from=inbox";
        const flow = await begin(destination);
        const completed = await second.request(flow.completePath, {
          redirect: "manual",
          headers: { cookie: flow.flowCookie },
        });
        expect(completed.status).toBe(303);
        expect(completed.headers.get("location")).toBe(destination);
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

  it("reports a held discovery request as unavailable after the configured timeout", async () => {
    const app = await start({ BADGER_OIDC_TIMEOUT_SECONDS: "1" });
    provider!.setEndpointHeld("/.well-known/openid-configuration");
    const before = performance.now();
    const failed = await app.request("/badger/auth/oidc/login", {
      redirect: "manual",
    });
    // The 1 s setting, not the 3 s default, ended the wait.
    const elapsed = performance.now() - before;
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(3_000);
    expect(failed.status).toBe(503);
    expect(await failed.text()).toContain(
      "The identity provider is unavailable",
    );
    expect(
      app.logs.filter((entry) => entry["event"] === "oidc.sign-in-failed"),
    ).toEqual([
      expect.objectContaining({
        level: "error",
        stage: "login",
        outcome: "unavailable",
        reason: expect.stringMatching(/^discovery: .*timeout/iu),
      }),
    ]);
  });

  it("reports a held token request as unavailable after the configured timeout", async () => {
    const app = await start({ BADGER_OIDC_TIMEOUT_SECONDS: "1" });
    const flow = await begin();
    provider!.setEndpointHeld("/token");
    const before = performance.now();
    const failed = await app.request(flow.completePath, {
      headers: { cookie: flow.flowCookie },
      redirect: "manual",
    });
    const elapsed = performance.now() - before;
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(3_000);
    expect(failed.status).toBe(503);
    expect(await failed.text()).toContain(
      "The identity provider is unavailable",
    );
    expect(
      app.logs.filter((entry) => entry["event"] === "oidc.sign-in-failed"),
    ).toEqual([
      expect.objectContaining({
        level: "error",
        stage: "callback",
        outcome: "unavailable",
        reason: expect.stringMatching(/^callback: .*timeout/iu),
      }),
    ]);
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
    // A person reads the failure in the browser and can start again.
    expect(exchange.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    const page = await exchange.text();
    expect(page).toContain("The identity provider is unavailable");
    expect(page).toContain(
      '<a href="/badger/auth/oidc/login">Sign in again</a>',
    );
    // The operator's log says why, at each stage.
    expect(
      app.logs.filter((entry) => entry["event"] === "oidc.sign-in-failed"),
    ).toEqual([
      expect.objectContaining({
        level: "error",
        stage: "login",
        outcome: "unavailable",
        reason: expect.stringMatching(/^discovery: .*status code/u),
      }),
      expect.objectContaining({
        level: "error",
        stage: "callback",
        outcome: "unavailable",
        reason: expect.stringMatching(/^callback: /u),
      }),
    ]);
    expect(JSON.stringify(app.logs)).not.toContain(provider!.clientSecret);
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

  it("lets a deployment declare emails verified for providers that send no claim, while a sent claim still decides", async () => {
    const roles = async (cookie: string) =>
      (
        await (
          await service!.request("/badger/api/v1/me", { headers: { cookie } })
        ).json()
      ).person.roles;
    await start({ BADGER_BOOTSTRAP_ADMINISTRATORS: "alice@example.com" });
    provider!.setClaims({ email_verified: undefined });
    expect(await roles((await signIn()).cookie)).toEqual([]);
    await service!.close();
    await provider!.stop();
    await start({
      BADGER_BOOTSTRAP_ADMINISTRATORS: "alice@example.com",
      BADGER_OIDC_EMAILS_VERIFIED: "true",
    });
    provider!.setClaims({
      sub: "bob-id",
      email: "alice@example.com",
      email_verified: false,
    });
    expect(await roles((await signIn()).cookie)).toEqual([]);
    provider!.setClaims({ email_verified: undefined });
    expect(await roles((await signIn()).cookie)).toEqual(["Administrator"]);
  });

  it("keeps every live session on the profile the provider proved last", async () => {
    const app = await start({
      BADGER_BOOTSTRAP_ADMINISTRATORS: "alice@example.com",
    });
    const laptop = await signIn();
    provider!.setClaims({ name: "Alice Renamed" });
    const phone = await signIn();
    for (const cookie of [laptop.cookie, phone.cookie, laptop.cookie]) {
      const me = await (
        await app.request("/badger/api/v1/me", { headers: { cookie } })
      ).json();
      expect(me.person.displayName).toBe("Alice Renamed");
      expect(me.signOut).toBe(true);
    }
    const updates = await (
      await app.request("/badger/api/v1/audit-events?action=person.updated", {
        headers: { cookie: laptop.cookie },
      })
    ).json();
    expect(updates.events).toHaveLength(1);
  });

  it("accepts a personal access token beside the browser session", async () => {
    const app = await start();
    const { cookie } = await signIn();
    const created = await app.request("/badger/api/v1/me/tokens", {
      method: "POST",
      headers: {
        cookie,
        origin: "https://badger.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Expert Agent", scopes: ["expert"] }),
    });
    expect(created.status).toBe(201);
    const { secret } = await created.json();
    const me = await app.request("/badger/api/v1/me", {
      headers: {
        authorization: `Bearer ${secret}`,
        "x-badger-agent-host": "test-agent",
      },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      person: { subject: "alice-id" },
      credential: { kind: "token" },
      signOut: false,
    });
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
    expect(response.headers.getSetCookie()).toEqual([clearedFlowCookie(flow)]);
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
    expect(response.headers.getSetCookie()).toEqual([clearedFlowCookie(flow)]);
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
    { BADGER_OIDC_MAX_PENDING_SIGN_INS: "0" },
    { BADGER_OIDC_MAX_PENDING_SIGN_INS: "-1" },
    { BADGER_OIDC_MAX_PENDING_SIGN_INS: "1.5" },
    { BADGER_OIDC_MAX_PENDING_SIGN_INS: "100001" },
    { BADGER_OIDC_MAX_PENDING_SIGN_INS: "1000000" },
    { BADGER_OIDC_MAX_PENDING_SIGN_INS: "many" },
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
      expect(response.headers.getSetCookie()).toEqual([
        clearedFlowCookie(flow),
      ]);
    },
  );
});
