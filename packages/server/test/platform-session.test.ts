import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  startStubPlatform,
  startTestService,
  type StubPlatform,
  type StubPlatformUser,
  type TestService,
} from "../src/testing/index.js";

let service: TestService | undefined;
let platform: StubPlatform | undefined;

afterEach(async () => {
  await service?.close();
  service = undefined;
  await platform?.stop();
  platform = undefined;
});

const alice: StubPlatformUser = {
  id: "platform-alice",
  email: "alice@example.com",
  displayName: "Alice Ng",
};

async function startWithPlatform(
  options: {
    users?: Readonly<Record<string, StubPlatformUser>>;
    currentUserAuth?: "cookie" | "bearer";
    environment?: Readonly<Record<string, string | undefined>>;
  } = {},
): Promise<void> {
  platform = await startStubPlatform({
    users: options.users ?? { "token-alice": alice },
    cookieName: "platform_session",
    currentUserAuth: options.currentUserAuth,
  });
  service = await startTestService({
    mode: "service",
    environment: {
      BADGER_IDENTITY: "platform-session",
      BADGER_PLATFORM_URL: platform.url,
      BADGER_PLATFORM_SESSION_COOKIE: platform.cookieName,
      BADGER_PLATFORM_CURRENT_USER_PATH: platform.currentUserPath,
      BADGER_PLATFORM_ISSUER: "https://platform.example",
      ...options.environment,
    },
  });
}

function cookieFor(token: string): string {
  if (platform === undefined) {
    throw new Error("The stub platform is not started");
  }
  return `${platform.cookieName}=${token}`;
}

describe("signing in through the platform session", () => {
  it("signs in the person the platform names", async () => {
    await startWithPlatform();

    const response = await service?.request("/api/v1/me", {
      headers: { cookie: cookieFor("token-alice") },
    });

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      person: {
        id: expect.any(String),
        issuer: "https://platform.example",
        subject: "platform-alice",
        email: "alice@example.com",
        displayName: "Alice Ng",
        roles: [],
        groups: [],
      },
      credential: {
        kind: "session",
        id: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
      // The platform owns this session, so the dashboard offers no sign-out.
      signOut: false,
    });
  });

  it("presents the session as a bearer token to a platform that reads one", async () => {
    await startWithPlatform({
      currentUserAuth: "bearer",
      environment: { BADGER_PLATFORM_CURRENT_USER_AUTH: "bearer" },
    });

    const response = await service?.request("/api/v1/me", {
      headers: { cookie: cookieFor("token-alice") },
    });

    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      person: { subject: "platform-alice" },
    });
  });

  it("presents the session as a cookie unless configured otherwise", async () => {
    // A platform that reads only a bearer token does not see the cookie.
    await startWithPlatform({ currentUserAuth: "bearer" });

    const response = await service?.request("/api/v1/me", {
      headers: { cookie: cookieFor("token-alice") },
    });

    expect(response?.status).toBe(401);
    expect(platform?.currentUserRequests).toBe(1);
  });

  it("asks the platform about nothing when the request carries no session", async () => {
    await startWithPlatform();

    const response = await service?.request("/api/v1/me");

    expect(response?.status).toBe(401);
    expect(await response?.json()).toMatchObject({
      error: { code: "unauthenticated" },
    });
    expect(platform?.currentUserRequests).toBe(0);
  });

  it("does not sign in a session the platform does not know", async () => {
    await startWithPlatform();
    const ask = () =>
      service?.request("/api/v1/me", {
        headers: { cookie: cookieFor("token-not-issued") },
      });

    const first = await ask();
    const second = await ask();

    for (const response of [first, second]) {
      expect(response?.status).toBe(401);
      expect(await response?.json()).toMatchObject({
        error: { code: "unauthenticated" },
      });
    }
    // The platform's "no" is remembered as briefly as its "yes".
    expect(platform?.currentUserRequests).toBe(1);
  });

  it("refuses disabled and tombstoned platform accounts", async () => {
    await startWithPlatform({
      users: {
        "token-disabled": {
          id: "platform-dana",
          email: "dana@example.com",
          status: "disabled",
        },
        "token-tombstoned": {
          id: "platform-tom",
          email: "tom@example.com",
          status: "tombstoned",
        },
      },
    });

    for (const token of ["token-disabled", "token-tombstoned"]) {
      const response = await service?.request("/api/v1/me", {
        headers: { cookie: cookieFor(token) },
      });
      expect(response?.status, token).toBe(403);
      expect(await response?.json()).toMatchObject({
        error: { code: "denied" },
      });
    }
  });

  it("answers unavailable when the platform cannot be reached", async () => {
    await startWithPlatform();
    await platform?.stop();

    const response = await service?.request("/api/v1/me", {
      headers: { cookie: cookieFor("token-alice") },
    });

    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({
      error: { code: "unavailable" },
    });
  });

  it("answers unavailable when the platform fails, and remembers no failure", async () => {
    await startWithPlatform();
    platform?.setFailure(500);

    const failed = await service?.request("/api/v1/me", {
      headers: { cookie: cookieFor("token-alice") },
    });
    expect(failed?.status).toBe(503);
    expect(await failed?.json()).toMatchObject({
      error: { code: "unavailable" },
    });

    platform?.setFailure(null);
    const recovered = await service?.request("/api/v1/me", {
      headers: { cookie: cookieFor("token-alice") },
    });
    expect(recovered?.status).toBe(200);
  });

  it("remembers a validated session briefly, per token", async () => {
    await startWithPlatform({
      users: {
        "token-alice": alice,
        "token-robin": {
          id: "platform-robin",
          email: "robin@example.com",
        },
      },
      environment: { BADGER_PLATFORM_CACHE_SECONDS: "30" },
    });

    const ask = (token: string) =>
      service?.request("/api/v1/me", {
        headers: { cookie: cookieFor(token) },
      });

    expect((await ask("token-alice"))?.status).toBe(200);
    expect((await ask("token-alice"))?.status).toBe(200);
    expect(platform?.currentUserRequests).toBe(1);

    expect((await ask("token-robin"))?.status).toBe(200);
    expect(platform?.currentUserRequests).toBe(2);

    service?.clock.advance(31_000);
    expect((await ask("token-alice"))?.status).toBe(200);
    expect(platform?.currentUserRequests).toBe(3);
  });

  it("can require the platform's app grant", async () => {
    await startWithPlatform({
      users: {
        "token-granted": {
          id: "platform-granted",
          email: "granted@example.com",
          appGrants: ["badger"],
        },
        "token-ungranted": {
          id: "platform-ungranted",
          email: "ungranted@example.com",
        },
      },
      environment: { BADGER_PLATFORM_APP_GRANT: "badger" },
    });

    const granted = await service?.request("/api/v1/me", {
      headers: { cookie: cookieFor("token-granted") },
    });
    const ungranted = await service?.request("/api/v1/me", {
      headers: { cookie: cookieFor("token-ungranted") },
    });

    expect(granted?.status).toBe(200);
    expect(ungranted?.status).toBe(403);
    expect(await ungranted?.json()).toMatchObject({
      error: { code: "denied" },
    });
  });

  it("refuses a cookie-authenticated write from another origin", async () => {
    await startWithPlatform({
      environment: { BADGER_ALLOWED_ORIGINS: "https://badger.example" },
    });
    const headers = {
      host: "127.0.0.1",
      cookie: cookieFor("token-alice"),
    };

    const foreign = await service?.rawRequest({
      method: "POST",
      path: "/api/v1/me",
      headers: { ...headers, origin: "https://evil.example" },
    });
    const own = await service?.rawRequest({
      method: "POST",
      path: "/api/v1/me",
      headers: { ...headers, origin: "https://badger.example" },
    });

    expect(foreign?.status).toBe(403);
    expect(JSON.parse(foreign?.body ?? "{}")).toMatchObject({
      error: { code: "denied" },
    });
    // The same-origin write reaches Badger, which answers the method, not the origin.
    expect(own?.status).toBe(405);
  });
});

async function configurationError(
  environment: Readonly<Record<string, string>>,
  mode: "local" | "service" = "service",
): Promise<Error> {
  const outcome = await startTestService({
    mode,
    environment,
  }).then(
    (started) => {
      service = started;
      return null;
    },
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(Error);
  return outcome as Error;
}

const platformSettings = {
  BADGER_IDENTITY: "platform-session",
  BADGER_PLATFORM_URL: "http://platform.internal:8080",
  BADGER_PLATFORM_SESSION_COOKIE: "portal_session",
  BADGER_PLATFORM_CURRENT_USER_PATH: "/current-user",
  BADGER_PLATFORM_ISSUER: "https://platform.example",
};

describe("the platform session settings", () => {
  it("requires the platform's address, issuer, session cookie, and current-user path", async () => {
    for (const missing of [
      "BADGER_PLATFORM_URL",
      "BADGER_PLATFORM_ISSUER",
      "BADGER_PLATFORM_SESSION_COOKIE",
      "BADGER_PLATFORM_CURRENT_USER_PATH",
    ]) {
      const error = await configurationError({
        ...platformSettings,
        [missing]: "",
      });
      expect(error.name).toBe("ConfigurationError");
      expect(error.message).toContain(missing);
    }
  });

  it("presents the token only as a cookie or a bearer token", async () => {
    const error = await configurationError({
      ...platformSettings,
      BADGER_PLATFORM_CURRENT_USER_AUTH: "basic",
    });

    expect(error.name).toBe("ConfigurationError");
    expect(error.message).toContain("BADGER_PLATFORM_CURRENT_USER_AUTH");
  });

  it("is available to service deployments only", async () => {
    const error = await configurationError(platformSettings, "local");

    expect(error.name).toBe("ConfigurationError");
    expect(error.message).toMatch(/local single-user mode/u);
  });
});

describe("addresses the platform has verified", () => {
  const robin: StubPlatformUser = {
    id: "platform-robin",
    email: "robin@example.com",
  };

  async function startWithAddresses(
    users: Readonly<Record<string, StubPlatformUser>>,
    environment: Readonly<Record<string, string>> = {},
  ): Promise<void> {
    await startWithPlatform({
      users,
      environment: {
        BADGER_BOOTSTRAP_ADMINISTRATORS: "robin@example.com",
        BADGER_ALLOWED_ORIGINS: "http://localhost",
        ...environment,
      },
    });
  }

  async function inviteAliceAsAuditor(): Promise<Response> {
    if (service === undefined) {
      throw new Error("The service is not started");
    }
    return service.request("/api/v1/bindings", {
      method: "POST",
      headers: {
        cookie: cookieFor("token-robin"),
        origin: "http://localhost",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        scopeType: "organization",
        email: "alice@example.com",
        role: "Auditor",
      }),
    });
  }

  async function aliceRoles(token = "token-alice"): Promise<string[]> {
    const response = await service?.request("/api/v1/me", {
      headers: { cookie: cookieFor(token) },
    });
    expect(response?.status).toBe(200);
    return ((await response?.json()) as { person: { roles: string[] } }).person
      .roles;
  }

  it("applies no pending invitation to an address the platform calls unverified", async () => {
    await startWithAddresses({
      "token-robin": { ...robin, emailVerified: true },
      "token-alice": { ...alice, emailVerified: false },
    });

    expect((await inviteAliceAsAuditor()).status).toBe(201);
    expect(await aliceRoles()).toEqual([]);
  });

  it("treats an address as unverified when the platform's answer does not say", async () => {
    await startWithAddresses({ "token-robin": robin, "token-alice": alice });

    // Robin's address is listed as a bootstrap Administrator, but nothing
    // vouches for it, so Robin may not bind anyone.
    expect((await inviteAliceAsAuditor()).status).toBe(403);
  });

  it("trusts every address once the deployment says the platform verifies them", async () => {
    await startWithAddresses(
      { "token-robin": robin, "token-alice": alice },
      { BADGER_PLATFORM_EMAILS_VERIFIED: "true" },
    );

    expect((await inviteAliceAsAuditor()).status).toBe(201);
    expect(await aliceRoles()).toEqual(["Auditor"]);
  });

  it("lets the platform's own answer outweigh that declaration", async () => {
    await startWithAddresses(
      {
        "token-robin": robin,
        "token-alice": { ...alice, emailVerified: false },
      },
      { BADGER_PLATFORM_EMAILS_VERIFIED: "true" },
    );

    expect((await inviteAliceAsAuditor()).status).toBe(201);
    expect(await aliceRoles()).toEqual([]);
  });

  it("applies a waiting invitation once the platform verifies the address", async () => {
    await startWithAddresses({
      "token-robin": { ...robin, emailVerified: true },
      "token-alice": { ...alice, emailVerified: false },
      // A later session of the same platform user, after verification.
      "token-alice-verified": { ...alice, emailVerified: true },
    });

    expect(await aliceRoles()).toEqual([]);
    expect((await inviteAliceAsAuditor()).status).toBe(201);
    expect(await aliceRoles()).toEqual([]);

    expect(await aliceRoles("token-alice-verified")).toEqual(["Auditor"]);
  });
});

describe("the platform-administrator mapping", () => {
  const platformAdministrator: StubPlatformUser = {
    ...alice,
    isAdmin: true,
  };

  async function roles(): Promise<string[]> {
    const response = await service?.request("/api/v1/me", {
      headers: { cookie: cookieFor("token-alice") },
    });
    expect(response?.status).toBe(200);
    return ((await response?.json()) as { person: { roles: string[] } }).person
      .roles;
  }

  it("grants nothing by default, so platform rights are not workflow rights", async () => {
    await startWithPlatform({
      users: { "token-alice": platformAdministrator },
    });

    expect(await roles()).toEqual([]);
  });

  it("grants Administrator when the deployment switches the mapping on", async () => {
    await startWithPlatform({
      users: { "token-alice": platformAdministrator },
      environment: { BADGER_PLATFORM_ADMIN_MAPPING: "true" },
    });

    expect(await roles()).toEqual(["Administrator"]);
  });

  it("still grants nothing to a platform user who is not an administrator", async () => {
    await startWithPlatform({
      users: { "token-alice": alice },
      environment: { BADGER_PLATFORM_ADMIN_MAPPING: "true" },
    });

    expect(await roles()).toEqual([]);
  });

  it("lets a mapped Administrator personally confirm their upload without workflow bindings", async () => {
    await startWithPlatform({
      users: {
        "token-alice": platformAdministrator,
        "token-bob": {
          id: "platform-bob",
          email: "bob@example.com",
          emailVerified: true,
        },
      },
      environment: {
        BADGER_PLATFORM_ADMIN_MAPPING: "true",
        BADGER_BOOTSTRAP_ADMINISTRATORS: "bob@example.com",
        BADGER_ALLOWED_ORIGINS: "http://localhost",
      },
    });
    async function call(path: string, body?: unknown, token = "token-bob") {
      const response = await service!.request(`/api/v1${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          cookie: cookieFor(token),
          origin: "http://localhost",
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const value = await response.json();
      expect(response.ok, JSON.stringify(value)).toBe(true);
      return value;
    }
    const { group } = await call("/groups", { name: "Effects" });
    const { workflow, version } = await call("/workflows", {
      groupId: group.id,
      name: "mapped-uploader",
      goal: "Study source effects",
      intent: "new-skill",
      locale: "en",
    });
    const { skill } = await call(
      "/skills",
      { groupId: group.id, name: "example" },
      "token-alice",
    );
    const source = "printf example > output.txt\n";
    const files = [
      {
        path: "SKILL.md",
        content: Buffer.from(
          "---\nname: example\ndescription: A source fixture\n---\nRead scripts/run.sh.\n",
        ).toString("base64"),
      },
      {
        path: "scripts/run.sh",
        content: Buffer.from(source).toString("base64"),
      },
    ];
    const { preview: upload } = await call(
      `/skills/${skill.id}/upload-preview`,
      { files },
      "token-alice",
    );
    await call(
      `/skills/${skill.id}/versions`,
      { files, confirmed: true, expectedHash: upload.hash },
      "token-alice",
    );
    const base = `/workflows/${workflow.id}/versions/${version.id}`;
    const pin = { skillId: skill.id, hash: upload.hash };
    const effects = `/skills/${skill.id}/versions/${upload.hash}/effects`;
    await call(`${base}/pins`, pin);
    const { job } = await call(`${base}/drafting-jobs`, {
      kind: "source-study",
      skillId: skill.id,
      confirmed: true,
    });
    const claim = await call(`${base}/drafting-jobs/${job.id}/claim`, {
      revision: job.revision,
    });
    const row = {
      ...pin,
      path: "scripts/run.sh",
      effects: ["local-writes"],
      rationale: "The script creates output.txt.",
      evidence: [
        {
          ...pin,
          path: "scripts/run.sh",
          fileHash: createHash("sha256").update(source).digest("hex"),
          startLine: 1,
          endLine: 1,
        },
      ],
      conditionalBehavior: "",
      uncertainty: null,
    };
    const submitted = await call(`${base}/drafting-jobs/${job.id}/submit`, {
      leaseId: claim.job.lease.id,
      contextHash: job.contextHash,
      result: { facts: [], interfaces: [], scriptEffects: [row] },
    });
    const routed = await call(`${effects}/route`, {
      workflowVersionId: version.id,
      jobId: job.id,
      jobRevision: submitted.job.revision,
      revision: 0,
    });
    const panel = await call(effects, undefined, "token-alice");
    expect(panel).toMatchObject({ canReview: true, uploaderAvailable: true });
    const { review } = await call(
      effects,
      {
        revision: routed.review.revision,
        scripts: [{ ...row, reviewed: true, uncertaintyAnswer: "" }],
      },
      "token-alice",
    );
    const { preview } = await call(
      `${effects}/preview`,
      { revision: review.revision },
      "token-alice",
    );
    const confirmed = await call(
      `${effects}/confirm`,
      {
        confirmationHash: preview.confirmationHash,
        requestId: "mapped-uploader-confirmation",
      },
      "token-alice",
    );
    expect(confirmed.review).toMatchObject({
      kind: "confirmation",
      actorId: panel.uploadedBy,
    });
  });

  it("is refused with an identity adapter that is not the platform", async () => {
    for (const environment of [
      { BADGER_PLATFORM_ADMIN_MAPPING: "true" },
      { BADGER_IDENTITY: "none", BADGER_PLATFORM_ADMIN_MAPPING: "true" },
    ]) {
      await expect(
        startTestService({
          mode: "service",
          environment: {
            ...environment,
            BADGER_ALLOWED_HOSTNAMES: "localhost",
            BADGER_DATABASE_URL: "postgres://badger@harness.invalid/badger",
          },
        }),
      ).rejects.toThrow(/BADGER_PLATFORM_ADMIN_MAPPING/u);
    }
  });
});
