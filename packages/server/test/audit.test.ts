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
  administrator: true,
};

interface AuditEventRecord {
  id: string;
  occurredAt: string;
  actorPersonId: string;
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

async function auditEvents(limit = 50): Promise<AuditEventRecord[]> {
  const response = await service?.request(`/api/audit-events?limit=${limit}`, {
    as: administrator,
  });
  expect(response?.status).toBe(200);
  return ((await response?.json()) as { events: AuditEventRecord[] }).events;
}

async function me(
  person: TestPerson,
  headers: Record<string, string> = {},
): Promise<{ person: { id: string } }> {
  const response = await service?.request("/api/me", { as: person, headers });
  expect(response?.status).toBe(200);
  return (await response?.json()) as { person: { id: string } };
}

describe("the audit trail", () => {
  it("records a first sign-in with the actor, credential, channel, target, boundaries, reason, and request", async () => {
    service = await startTestService();
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
    service = await startTestService();
    const response = await service.request("/api/me", { as: alice });
    const requestId = response.headers.get("x-request-id");
    expect(requestId).not.toBeNull();

    const events = await auditEvents();
    expect(events).toContainEqual(
      expect.objectContaining({ action: "person.created", requestId }),
    );
  });

  it("writes nothing when a sign-in changes nothing", async () => {
    service = await startTestService();
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
    service = await startTestService();
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

  it("refuses the audit log to a person who is not an Administrator", async () => {
    service = await startTestService();

    const response = await service.request("/api/audit-events", { as: alice });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "denied" },
    });
  });

  it("refuses an audit page size out of range", async () => {
    service = await startTestService();

    const response = await service.request("/api/audit-events?limit=1000", {
      as: administrator,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid" },
    });
  });
});
