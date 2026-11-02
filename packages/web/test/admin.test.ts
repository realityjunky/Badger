import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ledGroupIds,
  mayChangeBinding,
  inviteByEmail,
  resendInvitation,
  changeGroupRole,
  groupBindings,
  type Group,
  type Member,
} from "../src/api/organization.js";

afterEach(() => vi.unstubAllGlobals());

it.each(["sent", "failed", "not-configured"])(
  "preserves the invitation's %s delivery result",
  async (status) => {
    const fetcher = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ invitationDelivery: { status } }), {
          status: 201,
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(
      await inviteByEmail("/badger", {
        email: "person@example.com",
        role: "Member",
        scopeType: "group",
        scopeId: "group-1",
      }),
    ).toEqual({ kind: "ok", invitationDelivery: { status } });
    expect(await resendInvitation("/badger", "binding-1", 3)).toEqual({
      kind: "ok",
      invitationDelivery: { status },
    });
    expect(fetcher).toHaveBeenLastCalledWith(
      "/badger/api/v1/bindings/binding-1/invitation-email",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ revision: 3 }),
      }),
    );
  },
);

function group(id: string, parentId: string | null = null): Group {
  return { id, name: id, parentId, revision: 1 };
}

const tree = [
  group("research"),
  group("assays", "research"),
  group("sequencing", "assays"),
  group("clinical"),
];

it("keeps group membership scoped to direct and ancestor grants", () => {
  const member: Member = {
    person: {
      id: "person",
      email: "person@example.com",
      displayName: "Person",
    },
    organizationRoles: [],
    groups: [],
    bindings: [
      {
        id: "root",
        role: "Member",
        revision: 1,
        scopeType: "group",
        scopeId: "research",
        scopeName: "Research",
      },
      {
        id: "own",
        role: "Group lead",
        revision: 2,
        scopeType: "group",
        scopeId: "assays",
        scopeName: "Assays",
      },
      {
        id: "other",
        role: "Member",
        revision: 1,
        scopeType: "group",
        scopeId: "clinical",
        scopeName: "Clinical",
      },
      {
        id: "workflow",
        role: "Engineer",
        revision: 1,
        scopeType: "workflow",
        scopeId: "sequencing",
        scopeName: "Workflow",
      },
    ],
  };
  expect(
    groupBindings(member, "sequencing", tree).map((binding) => binding.id),
  ).toEqual(["root", "own"]);
  expect(
    groupBindings(member, "clinical", tree).map((binding) => binding.id),
  ).toEqual(["other"]);
});

it("changes the reviewed binding by identity and preserves a revision conflict", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ error: { code: "conflict" } }), {
      status: 409,
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  expect(
    await changeGroupRole(
      "/badger",
      {
        id: "binding/1",
        revision: 3,
        role: "Member",
        scopeType: "group",
        scopeId: "group",
        scopeName: "Group",
      },
      "Group lead",
    ),
  ).toEqual({ kind: "conflict" });
  expect(fetcher).toHaveBeenCalledWith(
    "/badger/api/v1/bindings/binding%2F1",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ role: "Group lead", revision: 3 }),
    }),
  );
});

describe("the groups a person leads", () => {
  it("reach every group inside a led group, and nothing beside or above it", () => {
    const led = ledGroupIds(
      [
        { id: "assays", role: "Group lead" },
        { id: "clinical", role: "Member" },
      ],
      tree,
    );

    expect([...led].sort()).toEqual(["assays", "sequencing"]);
  });
});

describe("offering a change to a binding", () => {
  const led = new Set(["assays", "sequencing"]);

  it("offers an Administrator every binding", () => {
    expect(
      mayChangeBinding({ scopeType: "organization", scopeId: null }, true, led),
    ).toBe(true);
  });

  it("offers a Group lead only the bindings on groups they lead", () => {
    expect(
      mayChangeBinding(
        { scopeType: "group", scopeId: "sequencing" },
        false,
        led,
      ),
    ).toBe(true);
    expect(
      mayChangeBinding({ scopeType: "group", scopeId: "research" }, false, led),
    ).toBe(false);
    expect(
      mayChangeBinding(
        { scopeType: "organization", scopeId: null },
        false,
        led,
      ),
    ).toBe(false);
  });
});
