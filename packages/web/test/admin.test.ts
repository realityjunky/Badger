import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ledGroupIds,
  mayChangeBinding,
  inviteByEmail,
  resendInvitation,
  type Group,
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
