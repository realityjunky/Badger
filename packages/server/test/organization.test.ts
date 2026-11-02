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

const ORIGIN = "http://localhost";

const robin: TestPerson = {
  subject: "robin",
  email: "robin@example.com",
  displayName: "Robin Alvarez",
};

const alice: TestPerson = {
  subject: "alice",
  email: "alice@example.com",
  displayName: "Alice Ng",
};

const bob: TestPerson = {
  subject: "bob",
  email: "bob@example.com",
  displayName: "Bob Lin",
};

const carol: TestPerson = {
  subject: "carol",
  email: "carol@example.com",
  displayName: "Carol Wu",
};

const robinAdministers = {
  environment: {
    BADGER_BOOTSTRAP_ADMINISTRATORS: "robin@example.com",
    BADGER_ALLOWED_ORIGINS: ORIGIN,
  },
};

interface Binding {
  id: string;
  email: string;
  personId: string | null;
  pending: boolean;
  scopeType: "organization" | "group";
  scopeId: string | null;
  role: string;
  revision: number;
  createdAt: string;
}

interface Me {
  person: {
    id: string;
    email: string;
    roles: string[];
    groups: { id: string; name: string; role: string }[];
  };
}

async function me(person: TestPerson, email?: string): Promise<Me> {
  const response = await service?.request("/api/v1/me", {
    as: email === undefined ? person : { ...person, email },
  });
  expect(response?.status).toBe(200);
  return (await response?.json()) as Me;
}

async function write(
  method: string,
  path: string,
  person: TestPerson,
  body: unknown,
): Promise<Response> {
  if (service === undefined) {
    throw new Error("The service is not running");
  }
  return service.request(path, {
    method,
    as: person,
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  });
}

async function invite(
  person: TestPerson,
  body: {
    email: string;
    role: string;
    scopeType?: "organization" | "group";
    scopeId?: string;
    overrideReason?: string;
  },
): Promise<Response> {
  return write("POST", "/api/v1/bindings", person, {
    scopeType: "organization",
    ...body,
  });
}

describe("bindings by email", () => {
  it("applies an email binding at the person's first sign-in, then follows their subject", async () => {
    service = await startTestService(robinAdministers);

    const invited = await invite(robin, {
      email: "bob@example.com",
      role: "Auditor",
    });
    expect(invited.status).toBe(201);
    const invitation = ((await invited.json()) as { binding: Binding }).binding;
    expect(invitation).toMatchObject({
      email: "bob@example.com",
      personId: null,
      pending: true,
      scopeType: "organization",
      scopeId: null,
      role: "Auditor",
      revision: 1,
    });

    // Bob has never signed in, so the binding is a pending invitation.
    const before = await me(robin);
    expect(before.person.roles).toEqual(["Administrator"]);

    const first = await me(bob);
    expect(first.person.roles).toEqual(["Auditor"]);

    // The invitation is no longer pending: it now follows Bob's subject, so a
    // changed address at the provider moves no binding.
    const changed = await me(bob, "bob.new@example.com");
    expect(changed.person.id).toBe(first.person.id);
    expect(changed.person.roles).toEqual(["Auditor"]);

    const invitations = await service.request("/api/v1/invitations", {
      as: robin,
    });
    expect(invitations.status).toBe(200);
    expect(await invitations.json()).toEqual({ invitations: [] });

    const events = await service.request(
      "/api/v1/audit-events?action=role_binding.resolved",
      { as: robin },
    );
    expect(events.status).toBe(200);
    const resolved = (
      (await events.json()) as {
        events: { action: string; targetType: string; reason: string }[];
      }
    ).events;
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      action: "role_binding.resolved",
      targetType: "role_binding",
      reason: "Email binding applied at sign-in with a verified address",
    });
  });

  it("binds a person who has already signed in to the role at once", async () => {
    service = await startTestService(robinAdministers);
    await me(alice);

    const invited = await invite(robin, {
      email: "alice@example.com",
      role: "Auditor",
    });

    expect(invited.status).toBe(201);
    expect(
      ((await invited.json()) as { binding: Binding }).binding,
    ).toMatchObject({ pending: false, personId: expect.any(String) });
    expect((await me(alice)).person.roles).toEqual(["Auditor"]);
  });

  it("applies a waiting invitation to the person who moves to its address", async () => {
    service = await startTestService(robinAdministers);
    const first = await me(alice);

    await invite(robin, { email: "alice.new@example.com", role: "Auditor" });

    // The person still matches on issuer and subject; the invitation was for
    // whoever verifiably holds the address, as a binding made after the move
    // would have been.
    const changed = await me(alice, "alice.new@example.com");
    expect(changed.person.id).toBe(first.person.id);
    expect(changed.person.roles).toEqual(["Auditor"]);
  });

  it("keeps a person's bindings when their address changes", async () => {
    service = await startTestService(robinAdministers);
    await invite(robin, { email: "alice@example.com", role: "Auditor" });
    expect((await me(alice)).person.roles).toEqual(["Auditor"]);

    const moved = await me(alice, "alice.moved@example.com");
    expect(moved.person.roles).toEqual(["Auditor"]);

    // Someone new who signs in with the old address inherits nothing.
    const newcomer = await service.request("/api/v1/me", {
      as: { subject: "someone-else", email: "alice@example.com" },
    });
    expect(await newcomer.json()).toMatchObject({ person: { roles: [] } });
  });

  it("does not apply an invitation to an address the provider has not verified", async () => {
    service = await startTestService(robinAdministers);
    await invite(robin, { email: "bob@example.com", role: "Auditor" });

    const unverified = await service.request("/api/v1/me", {
      as: { ...bob, emailVerified: false },
    });

    expect(unverified.status).toBe(200);
    expect(await unverified.json()).toMatchObject({
      person: { roles: [] },
    });
  });

  it("refuses a role binding to a person who may not manage the scope", async () => {
    service = await startTestService(robinAdministers);

    const denied = await invite(alice, {
      email: "bob@example.com",
      role: "Auditor",
    });

    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "denied" } });
  });

  it("refuses a role that does not belong to the scope", async () => {
    service = await startTestService(robinAdministers);

    for (const [scopeType, role] of [
      ["organization", "Member"],
      ["organization", "Group lead"],
      ["organization", "Workflow owner"],
    ] as const) {
      const response = await invite(robin, {
        email: "bob@example.com",
        role,
        scopeType,
      });
      expect(response.status, role).toBe(400);
    }
  });
});

interface Group {
  id: string;
  name: string;
  parentId: string | null;
  revision: number;
}

async function createGroup(
  person: TestPerson,
  body: { name: string; parentId?: string | null },
): Promise<Response> {
  return write("POST", "/api/v1/groups", person, body);
}

async function groups(person: TestPerson): Promise<Group[]> {
  const response = await service?.request("/api/v1/groups", { as: person });
  expect(response?.status).toBe(200);
  return ((await response?.json()) as { groups: Group[] }).groups;
}

async function group(person: TestPerson, name: string): Promise<Group> {
  const found = (await groups(person)).find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`No group named ${name}`);
  }
  return found;
}

describe("nested groups", () => {
  it("lets an Administrator create nested groups and keeps names unique among siblings", async () => {
    service = await startTestService(robinAdministers);

    const rootResponse = await createGroup(robin, { name: "Research" });
    expect(rootResponse.status).toBe(201);
    const root = ((await rootResponse.json()) as { group: Group }).group;
    expect(root).toMatchObject({
      name: "Research",
      parentId: null,
      revision: 1,
    });

    const childResponse = await createGroup(robin, {
      name: "Assays",
      parentId: root.id,
    });
    expect(childResponse.status).toBe(201);
    expect(
      ((await childResponse.json()) as { group: Group }).group,
    ).toMatchObject({
      name: "Assays",
      parentId: root.id,
    });

    const duplicate = await createGroup(robin, { name: "research" });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({
      error: { code: "conflict" },
    });

    expect((await groups(robin)).map((entry) => entry.name)).toEqual([
      "Assays",
      "Research",
    ]);
    expect(await groups(alice)).toEqual([]);
  });

  it("refuses a group to a person who is not an Administrator", async () => {
    service = await startTestService(robinAdministers);

    const denied = await createGroup(alice, { name: "Research" });

    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "denied" } });
  });

  it("refuses a move that would put a group inside itself", async () => {
    service = await startTestService(robinAdministers);
    const root = (
      (await (await createGroup(robin, { name: "Research" })).json()) as {
        group: Group;
      }
    ).group;
    const child = (
      (await (
        await createGroup(robin, {
          name: "Assays",
          parentId: root.id,
        })
      ).json()) as { group: Group }
    ).group;

    const cycle = await write("PATCH", `/api/v1/groups/${root.id}`, robin, {
      revision: root.revision,
      parentId: child.id,
    });

    expect(cycle.status).toBe(409);
    expect(await cycle.json()).toMatchObject({ error: { code: "rejected" } });
  });

  it("moves a group under another on a quoted revision", async () => {
    service = await startTestService(robinAdministers);
    const research = (
      (await (await createGroup(robin, { name: "Research" })).json()) as {
        group: Group;
      }
    ).group;
    const clinical = (
      (await (await createGroup(robin, { name: "Clinical" })).json()) as {
        group: Group;
      }
    ).group;

    const moved = await write("PATCH", `/api/v1/groups/${research.id}`, robin, {
      revision: research.revision,
      parentId: clinical.id,
    });

    expect(moved.status).toBe(200);
    expect(((await moved.json()) as { group: Group }).group).toMatchObject({
      parentId: clinical.id,
      revision: 2,
    });

    const stale = await write("PATCH", `/api/v1/groups/${research.id}`, robin, {
      revision: 1,
      name: "Renamed",
    });
    expect(stale.status).toBe(409);
  });
});

interface Member {
  person: { id: string; email: string; displayName: string };
  organizationRoles: string[];
  groups: { id: string; name: string; role: string }[];
}

async function members(person: TestPerson): Promise<Member[]> {
  const response = await service?.request("/api/v1/members", { as: person });
  expect(response?.status).toBe(200);
  return ((await response?.json()) as { members: Member[] }).members;
}

describe("group roles and inheritance", () => {
  it("lets a Group lead manage members in the group and its children, not outside it", async () => {
    service = await startTestService(robinAdministers);
    const research = (
      (await (await createGroup(robin, { name: "Research" })).json()) as {
        group: Group;
      }
    ).group;
    const assays = (
      (await (
        await createGroup(robin, {
          name: "Assays",
          parentId: research.id,
        })
      ).json()) as { group: Group }
    ).group;
    const clinical = (
      (await (await createGroup(robin, { name: "Clinical" })).json()) as {
        group: Group;
      }
    ).group;
    await invite(robin, {
      email: alice.email ?? "",
      role: "Group lead",
      scopeType: "group",
      scopeId: research.id,
    });
    await me(alice);

    // The binding on Research reaches into Assays.
    const inherited = await invite(alice, {
      email: "bob@example.com",
      role: "Member",
      scopeType: "group",
      scopeId: assays.id,
    });
    expect(inherited.status).toBe(201);
    expect(await me(bob)).toMatchObject({
      person: {
        groups: [{ id: assays.id, name: "Assays", role: "Member" }],
      },
    });

    // It grants nothing on a sibling group or on the Organization.
    const outside = await invite(alice, {
      email: "carol@example.com",
      role: "Member",
      scopeType: "group",
      scopeId: clinical.id,
    });
    expect(outside.status).toBe(403);
    const organization = await invite(alice, {
      email: "carol@example.com",
      role: "Auditor",
    });
    expect(organization.status).toBe(403);

    // A Member holds no management capability.
    const memberDenied = await invite(bob, {
      email: "carol@example.com",
      role: "Member",
      scopeType: "group",
      scopeId: assays.id,
    });
    expect(memberDenied.status).toBe(403);

    // The Group lead cannot change the group itself; an Administrator can.
    const rename = await write(
      "PATCH",
      `/api/v1/groups/${research.id}`,
      alice,
      {
        revision: research.revision,
        name: "R&D",
      },
    );
    expect(rename.status).toBe(403);
  });

  it("lists members and pending invitations for the groups a Group lead manages", async () => {
    service = await startTestService(robinAdministers);
    const research = (
      (await (await createGroup(robin, { name: "Research" })).json()) as {
        group: Group;
      }
    ).group;
    const clinical = (
      (await (await createGroup(robin, { name: "Clinical" })).json()) as {
        group: Group;
      }
    ).group;
    await invite(robin, {
      email: alice.email ?? "",
      role: "Group lead",
      scopeType: "group",
      scopeId: research.id,
    });
    await invite(robin, {
      email: "dana@example.com",
      role: "Member",
      scopeType: "group",
      scopeId: research.id,
    });
    await invite(robin, {
      email: "erin@example.com",
      role: "Member",
      scopeType: "group",
      scopeId: clinical.id,
    });
    await me(alice);

    const all = await members(robin);
    expect(all.map((entry) => entry.person.email).sort()).toEqual([
      "alice@example.com",
      "robin@example.com",
    ]);
    const robinMember = all.find(
      (entry) => entry.person.email === "robin@example.com",
    );
    expect(robinMember?.organizationRoles).toEqual(["Administrator"]);

    const invitationResponse = await service.request("/api/v1/invitations", {
      as: alice,
    });
    expect(invitationResponse.status).toBe(200);
    const invitations = (
      (await invitationResponse.json()) as {
        invitations: {
          email: string;
          scopeName: string | null;
          role: string;
        }[];
      }
    ).invitations;
    expect(invitations).toEqual([
      expect.objectContaining({
        email: "dana@example.com",
        scopeName: "Research",
        role: "Member",
      }),
    ]);

    const led = await members(alice);
    expect(led.map((entry) => entry.person.email).sort()).toEqual([
      "alice@example.com",
    ]);
  });

  it("shows a child Group lead the members bound above their group", async () => {
    service = await startTestService(robinAdministers);
    const research = (
      (await (await createGroup(robin, { name: "Research" })).json()) as {
        group: Group;
      }
    ).group;
    const assays = (
      (await (
        await createGroup(robin, {
          name: "Assays",
          parentId: research.id,
        })
      ).json()) as { group: Group }
    ).group;
    await invite(robin, {
      email: "bob@example.com",
      role: "Member",
      scopeType: "group",
      scopeId: research.id,
    });
    await invite(robin, {
      email: alice.email ?? "",
      role: "Group lead",
      scopeType: "group",
      scopeId: assays.id,
    });
    await invite(robin, {
      email: "dana@example.com",
      role: "Member",
      scopeType: "group",
      scopeId: research.id,
    });
    await me(bob);
    await me(alice);

    const led = await members(alice);
    const bobEntry = led.find(
      (entry) => entry.person.email === "bob@example.com",
    );
    expect(bobEntry).toMatchObject({
      groups: [{ id: research.id, name: "Research", role: "Member" }],
    });

    const invitationResponse = await service.request("/api/v1/invitations", {
      as: alice,
    });
    expect(invitationResponse.status).toBe(200);
    expect(
      (
        (await invitationResponse.json()) as {
          invitations: { email: string; scopeName: string | null }[];
        }
      ).invitations,
    ).toEqual([
      expect.objectContaining({
        email: "dana@example.com",
        scopeName: "Research",
      }),
    ]);
  });

  it("refuses members and invitations to a Member", async () => {
    service = await startTestService(robinAdministers);
    const research = (
      (await (await createGroup(robin, { name: "Research" })).json()) as {
        group: Group;
      }
    ).group;
    await invite(robin, {
      email: "bob@example.com",
      role: "Member",
      scopeType: "group",
      scopeId: research.id,
    });
    await me(bob);

    for (const path of ["/api/v1/members", "/api/v1/invitations"]) {
      const response = await service.request(path, { as: bob });
      expect(response.status, path).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: "denied" },
      });
    }
  });
});

describe("recorded overrides", () => {
  it("blocks an Administrator from granting themselves a role unless the reason is recorded", async () => {
    service = await startTestService(robinAdministers);

    const blocked = await invite(robin, {
      email: "robin@example.com",
      role: "Auditor",
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      error: { code: "rejected" },
    });

    const overridden = await invite(robin, {
      email: "robin@example.com",
      role: "Auditor",
      overrideReason: "Cover while the auditor is on leave",
    });
    expect(overridden.status).toBe(201);
    expect((await me(robin)).person.roles).toEqual([
      "Administrator",
      "Auditor",
    ]);

    const events = await service.request(
      "/api/v1/audit-events?action=role_binding.granted",
      { as: robin },
    );
    const granted = (
      (await events.json()) as {
        events: { reason: string; actorDisplayName: string | null }[];
      }
    ).events;
    expect(granted).toEqual([
      expect.objectContaining({
        reason: "Override: Cover while the auditor is on leave",
        actorDisplayName: "Robin Alvarez",
      }),
    ]);
  });

  it("does not let a person who is not an Administrator override the block", async () => {
    service = await startTestService(robinAdministers);
    await me(alice);

    const denied = await invite(alice, {
      email: "alice@example.com",
      role: "Auditor",
      overrideReason: "I would like to audit",
    });

    expect(denied.status).toBe(403);
  });
});

describe("addresses the provider has verified", () => {
  it("never binds a person whose copy of the address is unverified", async () => {
    service = await startTestService(robinAdministers);
    // Carol signs in claiming Bob's address, which her provider has not
    // verified.
    const claimant = {
      ...carol,
      email: "bob@example.com",
      emailVerified: false,
    };
    await me(claimant);

    const invited = await invite(robin, {
      email: "bob@example.com",
      role: "Auditor",
    });
    expect(invited.status).toBe(201);
    expect(
      ((await invited.json()) as { binding: Binding }).binding,
    ).toMatchObject({ pending: true, personId: null });
    expect((await me(claimant)).person.roles).toEqual([]);

    // The person who verifiably holds the address receives it.
    expect((await me(bob)).person.roles).toEqual(["Auditor"]);
  });

  it("grants a bootstrap Administrator address only once it is verified", async () => {
    service = await startTestService(robinAdministers);

    const unverified = { ...robin, emailVerified: false };
    expect((await me(unverified)).person.roles).toEqual([]);
    expect((await createGroup(unverified, { name: "Research" })).status).toBe(
      403,
    );

    expect((await me(robin)).person.roles).toEqual(["Administrator"]);
  });
});

describe("binding requests the service refuses", () => {
  it("refuses a binding to a group that does not exist", async () => {
    service = await startTestService(robinAdministers);

    const response = await invite(robin, {
      email: "bob@example.com",
      role: "Member",
      scopeType: "group",
      scopeId: "no-such-group",
    });

    expect(response.status).toBe(400);
  });

  it("refuses an override reason where nothing is overridden", async () => {
    service = await startTestService(robinAdministers);

    const response = await invite(robin, {
      email: "bob@example.com",
      role: "Auditor",
      overrideReason: "Just because",
    });

    expect(response.status).toBe(400);
    const events = await service.request(
      "/api/v1/audit-events?targetType=role_binding",
      { as: robin },
    );
    expect(
      ((await events.json()) as { events: unknown[] }).events,
    ).toHaveLength(0);
  });
});

async function createdGroup(body: {
  name: string;
  parentId?: string | null;
}): Promise<Group> {
  const response = await createGroup(robin, body);
  expect(response.status).toBe(201);
  return ((await response.json()) as { group: Group }).group;
}

async function bound(
  person: TestPerson,
  body: Parameters<typeof invite>[1],
): Promise<Binding> {
  const response = await invite(person, body);
  expect(response.status).toBe(201);
  return ((await response.json()) as { binding: Binding }).binding;
}

function remove(
  person: TestPerson,
  binding: Pick<Binding, "id" | "revision">,
): Promise<Response> {
  return write("DELETE", `/api/v1/bindings/${binding.id}`, person, {
    revision: binding.revision,
  });
}

describe("removing role bindings", () => {
  it("lets a Group lead remove bindings in and below their group, and records it", async () => {
    service = await startTestService(robinAdministers);
    const research = await createdGroup({ name: "Research" });
    const assays = await createdGroup({
      name: "Assays",
      parentId: research.id,
    });
    await bound(robin, {
      email: "alice@example.com",
      role: "Group lead",
      scopeType: "group",
      scopeId: research.id,
    });
    await me(alice);
    await me(bob);
    const member = await bound(alice, {
      email: "bob@example.com",
      role: "Member",
      scopeType: "group",
      scopeId: assays.id,
    });

    const removed = await remove(alice, member);

    expect(removed.status).toBe(200);
    expect((await me(bob)).person.groups).toEqual([]);
    const events = await service.request(
      `/api/v1/audit-events?action=role_binding.removed&targetId=${member.id}`,
      { as: robin },
    );
    expect(
      ((await events.json()) as { events: unknown[] }).events,
    ).toMatchObject([
      {
        action: "role_binding.removed",
        actorEmail: "alice@example.com",
        targetType: "role_binding",
        targetId: member.id,
        // The binding is gone, but the entry still says what it was.
        targetLabel: "Member · Assays · bob@example.com",
        channel: "web",
      },
    ]);
  });

  it("refuses removal outside the Group lead's groups and to Members", async () => {
    service = await startTestService(robinAdministers);
    const research = await createdGroup({ name: "Research" });
    const assays = await createdGroup({
      name: "Assays",
      parentId: research.id,
    });
    await bound(robin, {
      email: "alice@example.com",
      role: "Group lead",
      scopeType: "group",
      scopeId: assays.id,
    });
    await me(alice);
    const above = await bound(robin, {
      email: "bob@example.com",
      role: "Member",
      scopeType: "group",
      scopeId: research.id,
    });
    const organization = await bound(robin, {
      email: "carol@example.com",
      role: "Auditor",
    });
    const beside = await bound(alice, {
      email: "carol@example.com",
      role: "Member",
      scopeType: "group",
      scopeId: assays.id,
    });
    await me(bob);

    // A lead of the child group manages nothing above it.
    expect((await remove(alice, above)).status).toBe(403);
    expect((await remove(alice, organization)).status).toBe(403);
    // A Member of the parent manages nothing at all.
    expect((await remove(bob, beside)).status).toBe(403);
  });

  it("refuses a stale revision and an unknown binding", async () => {
    service = await startTestService(robinAdministers);
    const binding = await bound(robin, {
      email: "bob@example.com",
      role: "Auditor",
    });
    // Bob's first sign-in resolves the invitation, which moves its revision.
    await me(bob);

    const stale = await remove(robin, binding);
    expect(stale.status).toBe(409);
    expect(
      ((await stale.json()) as { binding: Binding }).binding,
    ).toMatchObject({ id: binding.id, revision: binding.revision + 1 });

    const current = await remove(robin, {
      id: binding.id,
      revision: binding.revision + 1,
    });
    expect(current.status).toBe(200);
    expect((await remove(robin, binding)).status).toBe(404);
  });
});

describe("an Auditor", () => {
  it("reads everything and changes nothing", async () => {
    service = await startTestService(robinAdministers);
    const research = await createdGroup({ name: "Research" });
    await bound(robin, { email: "alice@example.com", role: "Auditor" });
    const binding = await bound(robin, {
      email: "bob@example.com",
      role: "Member",
      scopeType: "group",
      scopeId: research.id,
    });
    expect((await me(alice)).person.roles).toEqual(["Auditor"]);

    for (const path of [
      "/api/v1/groups",
      "/api/v1/members",
      "/api/v1/invitations",
      "/api/v1/audit-events",
    ]) {
      const read = await service.request(path, { as: alice });
      expect(read.status, path).toBe(200);
    }

    expect((await createGroup(alice, { name: "Audit" })).status).toBe(403);
    expect(
      (
        await write("PATCH", `/api/v1/groups/${research.id}`, alice, {
          revision: research.revision,
          name: "Renamed",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await invite(alice, {
          email: "carol@example.com",
          role: "Member",
          scopeType: "group",
          scopeId: research.id,
        })
      ).status,
    ).toBe(403);
    expect((await remove(alice, binding)).status).toBe(403);
  });
});
