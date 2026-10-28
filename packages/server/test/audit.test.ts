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

const administrator: TestPerson = {
  subject: "robin",
  email: "robin@example.com",
  displayName: "Robin Alvarez",
};

const withAdministrator = {
  environment: { BADGER_BOOTSTRAP_ADMINISTRATORS: "robin@example.com" },
};

interface AuditEventRecord {
  id: string;
  occurredAt: string;
  actorPersonId: string | null;
  credentialKind: string;
  credentialId: string | null;
  channel: string;
  action: string;
  targetType: string;
  targetId: string | null;
  before: { revision: number | null; hash: string | null } | null;
  after: { revision: number | null; hash: string | null } | null;
  reason: string | null;
  requestId: string;
}

interface AuditPage {
  events: AuditEventRecord[];
  nextCursor: string | null;
}

async function auditPage(query = ""): Promise<AuditPage> {
  const response = await service?.request(`/api/v1/audit-events${query}`, {
    as: administrator,
  });
  expect(response?.status).toBe(200);
  return (await response?.json()) as AuditPage;
}

async function auditEvents(): Promise<AuditEventRecord[]> {
  return (await auditPage()).events;
}

async function me(
  person: TestPerson,
  headers: Record<string, string> = {},
): Promise<{ person: { id: string } }> {
  const response = await service?.request("/api/v1/me", {
    as: person,
    headers,
  });
  expect(response?.status).toBe(200);
  return (await response?.json()) as { person: { id: string } };
}

describe("the audit trail", () => {
  it("records a first sign-in with the actor, credential, channel, target, revisions, reason, and request", async () => {
    service = await startTestService(withAdministrator);
    const alicePerson = await me(alice, { "x-request-id": "request-1" });

    const events = await auditEvents();
    const created = events.find(
      (event) => event.actorPersonId === alicePerson.person.id,
    );

    expect(created).toMatchObject({
      occurredAt: "2026-10-27T00:00:00.000Z",
      actorPersonId: alicePerson.person.id,
      credentialKind: "session",
      credentialId: "test-session",
      channel: "web",
      action: "person.created",
      targetType: "person",
      targetId: alicePerson.person.id,
      before: null,
      after: { revision: 1, hash: null },
      reason: "First sign-in",
      requestId: "request-1",
    });
    expect(created?.id).toMatch(/^id-\d{4}$/u);
  });

  it("records the request ID it generated for the caller", async () => {
    service = await startTestService(withAdministrator);
    const response = await service.request("/api/v1/me", { as: alice });
    const requestId = response.headers.get("x-request-id");
    expect(requestId).not.toBeNull();

    const events = await auditEvents();
    expect(events).toContainEqual(
      expect.objectContaining({ action: "person.created", requestId }),
    );
  });

  it("writes nothing when a sign-in changes nothing", async () => {
    service = await startTestService(withAdministrator);
    const first = await me(alice);
    await me(alice);

    const events = await auditEvents();
    const aliceEvents = events.filter(
      (event) => event.actorPersonId === first.person.id,
    );

    expect(aliceEvents).toHaveLength(1);
    expect(aliceEvents[0]?.action).toBe("person.created");
  });

  it("records a profile change with the revisions before and after", async () => {
    service = await startTestService(withAdministrator);
    const first = await me(alice);
    service.clock.advance(60_000);

    await me({
      subject: "alice",
      email: "alice@new.example",
      displayName: "Alice Ng (updated)",
    });

    const events = await auditEvents();
    const aliceEvents = events.filter(
      (event) => event.actorPersonId === first.person.id,
    );

    expect(aliceEvents).toHaveLength(2);
    const [updated, created] = aliceEvents;
    expect(updated).toMatchObject({
      occurredAt: "2026-10-27T00:01:00.000Z",
      action: "person.updated",
      targetType: "person",
      targetId: first.person.id,
      before: { revision: 1, hash: null },
      after: { revision: 2, hash: null },
      reason: "Profile changed at sign-in",
    });
    expect(created?.action).toBe("person.created");
  });

  it("pages through the audit log, newest first, with an opaque cursor", async () => {
    service = await startTestService(withAdministrator);
    for (const subject of ["ana", "ben", "cai"]) {
      await me({ subject });
      service.clock.advance(1_000);
    }

    const first = await auditPage("?limit=2");
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await auditPage(
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
    );

    const all = await auditEvents();
    expect(all).toHaveLength(4);
    expect([...first.events, ...second.events]).toEqual(all);
    expect(all.map((event) => event.occurredAt)).toEqual(
      [...all.map((event) => event.occurredAt)].sort().reverse(),
    );
    expect(second.nextCursor).toBeNull();
  });

  it("refuses a cursor it did not issue", async () => {
    service = await startTestService(withAdministrator);

    const response = await service.request(
      "/api/v1/audit-events?cursor=not-a-cursor",
      { as: administrator },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid" },
    });
  });

  it("refuses the audit log to a person who is not an Administrator", async () => {
    service = await startTestService(withAdministrator);

    const response = await service.request("/api/v1/audit-events", {
      as: alice,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "denied" },
    });
  });

  it("does not take a principal's word for being an Administrator", async () => {
    service = await startTestService();

    const response = await service.request("/api/v1/audit-events", {
      as: { ...administrator, administrator: true } as TestPerson,
    });

    expect(response.status).toBe(403);
  });

  it("refuses an audit page size out of range", async () => {
    service = await startTestService(withAdministrator);

    const response = await service.request("/api/v1/audit-events?limit=1000", {
      as: administrator,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid" },
    });
  });
});
