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

interface Preferences {
  language: string;
  theme: string;
  fontScale: number;
  railCollapsed: boolean;
  revision: number;
  updatedAt: string | null;
}

const administrator: TestPerson = {
  subject: "robin",
  email: "robin@example.com",
  displayName: "Robin Alvarez",
};

const WRITE_ORIGIN = "http://localhost";

const withAdministrator = {
  environment: {
    BADGER_BOOTSTRAP_ADMINISTRATORS: "robin@example.com",
    BADGER_ALLOWED_ORIGINS: WRITE_ORIGIN,
  },
};

async function readPreferences(
  person: TestPerson = alice,
): Promise<Preferences> {
  const response = await service?.request("/api/v1/me/preferences", {
    as: person,
  });
  expect(response?.status).toBe(200);
  const body = (await response?.json()) as { preferences: Preferences };
  return body.preferences;
}

async function savePreferences(
  body: unknown,
  person: TestPerson = alice,
): Promise<Response> {
  if (service === undefined) {
    throw new Error("The service is not running");
  }
  return service.request("/api/v1/me/preferences", {
    method: "PUT",
    as: person,
    headers: {
      "content-type": "application/json",
      origin: WRITE_ORIGIN,
    },
    body: JSON.stringify(body),
  });
}

interface AuditEventRecord {
  actorPersonId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  before: { revision: number | null; hash: string | null } | null;
  after: { revision: number | null; hash: string | null } | null;
  reason: string | null;
}

async function auditEvents(): Promise<AuditEventRecord[]> {
  const response = await service?.request("/api/v1/audit-events", {
    as: administrator,
  });
  expect(response?.status).toBe(200);
  return ((await response?.json()) as { events: AuditEventRecord[] }).events;
}

const darkChinese = {
  language: "zh",
  theme: "dark",
  fontScale: 120,
  railCollapsed: true,
};

const bob: TestPerson = {
  subject: "bob",
  email: "bob@example.com",
  displayName: "Bob Lin",
};

describe("personal preferences", () => {
  it("answers with the defaults before anything is saved", async () => {
    service = await startTestService();

    expect(await readPreferences()).toEqual({
      language: "en",
      theme: "system",
      fontScale: 100,
      railCollapsed: false,
      revision: 0,
      updatedAt: null,
    });
  });

  it("saves the choices and audits the write with its revisions", async () => {
    service = await startTestService(withAdministrator);

    const saved = await savePreferences({ ...darkChinese, revision: 0 });

    expect(saved.status).toBe(200);
    const savedBody = (await saved.json()) as { preferences: Preferences };
    expect(savedBody.preferences).toEqual({
      ...darkChinese,
      revision: 1,
      updatedAt: "2026-10-27T00:00:00.000Z",
    });
    expect(await readPreferences()).toEqual(savedBody.preferences);

    const written = (await auditEvents()).find(
      (event) => event.action === "person.preferences_updated",
    );
    expect(written).toMatchObject({
      targetType: "person_preferences",
      targetId: expect.any(String),
      before: null,
      after: { revision: 1, hash: null },
      reason: "Personal preferences saved",
    });
  });

  it("refuses a write that quotes a stale revision and shows what is stored", async () => {
    service = await startTestService(withAdministrator);
    await savePreferences({ ...darkChinese, revision: 0 });
    service.clock.advance(60_000);

    const stale = await savePreferences({
      ...darkChinese,
      language: "en",
      revision: 0,
    });

    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: { code: "conflict", message: expect.any(String) },
      requestId: expect.any(String),
      preferences: {
        ...darkChinese,
        revision: 1,
        updatedAt: "2026-10-27T00:00:00.000Z",
      },
    });
    expect(await readPreferences()).toEqual({
      ...darkChinese,
      revision: 1,
      updatedAt: "2026-10-27T00:00:00.000Z",
    });
  });

  it("keeps each person's choices to themselves", async () => {
    service = await startTestService(withAdministrator);
    await savePreferences({ ...darkChinese, revision: 0 });

    expect(await readPreferences(bob)).toEqual({
      language: "en",
      theme: "system",
      fontScale: 100,
      railCollapsed: false,
      revision: 0,
      updatedAt: null,
    });
  });

  it("refuses preferences that are not one of the offered choices", async () => {
    service = await startTestService(withAdministrator);

    const invalidBodies: unknown[] = [
      { ...darkChinese, revision: 0, language: "fr" },
      { ...darkChinese, revision: 0, theme: "sepia" },
      { ...darkChinese, revision: 0, fontScale: 89 },
      { ...darkChinese, revision: 0, fontScale: 151 },
      { ...darkChinese, revision: 0, fontScale: 100.5 },
      { ...darkChinese, revision: 0, railCollapsed: "yes" },
      { ...darkChinese, revision: -1 },
      { ...darkChinese },
      { ...darkChinese, revision: 0, accent: "blue" },
      [],
      "zh",
    ];

    for (const body of invalidBodies) {
      const response = await savePreferences(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "invalid" },
      });
    }
    expect(await readPreferences()).toMatchObject({ revision: 0 });
  });

  it("refuses a body that is not declared JSON or is too large", async () => {
    service = await startTestService(withAdministrator);
    if (service === undefined) {
      throw new Error("The service is not running");
    }

    const wrongType = await service.request("/api/v1/me/preferences", {
      method: "PUT",
      as: alice,
      headers: { "content-type": "text/plain", origin: WRITE_ORIGIN },
      body: JSON.stringify({ ...darkChinese, revision: 0 }),
    });
    expect(wrongType.status).toBe(400);

    const malformed = await service.request("/api/v1/me/preferences", {
      method: "PUT",
      as: alice,
      headers: { "content-type": "application/json", origin: WRITE_ORIGIN },
      body: "not json",
    });
    expect(malformed.status).toBe(400);

    const oversized = await service.request("/api/v1/me/preferences", {
      method: "PUT",
      as: alice,
      headers: { "content-type": "application/json", origin: WRITE_ORIGIN },
      body: JSON.stringify({
        ...darkChinese,
        revision: 0,
        pad: "x".repeat(20_000),
      }),
    });
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({
      error: { code: "invalid" },
    });
  });

  it("refuses preferences to a request without a person", async () => {
    service = await startTestService(withAdministrator);

    expect((await service.request("/api/v1/me/preferences")).status).toBe(401);
    expect(
      (
        await service.request("/api/v1/me/preferences", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            origin: WRITE_ORIGIN,
          },
          body: JSON.stringify({ ...darkChinese, revision: 0 }),
        })
      ).status,
    ).toBe(401);
  });
});
