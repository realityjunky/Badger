import { describe, expect, it } from "vitest";
import {
  ledGroupIds,
  mayChangeBinding,
  type Group,
} from "../src/api/organization.js";

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
