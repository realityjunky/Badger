import { describe, expect, it } from "vitest";
import { groupWorkflowBindings } from "../src/pages/workflows/team.js";
import type { WorkflowBinding } from "../src/api/workflows.js";

function binding(
  id: string,
  overrides: Partial<WorkflowBinding> = {},
): WorkflowBinding {
  return {
    id,
    email: "person@example.com",
    displayName: "Person",
    personId: "person-1",
    role: "Engineer",
    pending: false,
    revision: 1,
    ...overrides,
  };
}

describe("workflow team members", () => {
  it("groups roles for one person while keeping each binding", () => {
    const engineer = binding("engineer");
    const expert = binding("expert", {
      email: "updated@example.com",
      role: "Field expert",
      revision: 3,
    });
    const members = groupWorkflowBindings([
      engineer,
      binding("observer", {
        personId: "person-2",
        email: "observer@example.com",
        displayName: "Observer",
        role: "Observer",
      }),
      expert,
    ]);

    expect(members).toHaveLength(2);
    expect(members[0]?.bindings).toEqual([engineer, expert]);
    expect(members[1]?.bindings.map((entry) => entry.role)).toEqual([
      "Observer",
    ]);
  });

  it("groups pending invitations by normalized email", () => {
    const members = groupWorkflowBindings([
      binding("one", {
        personId: null,
        email: "Invitee@Example.com",
        pending: true,
      }),
      binding("two", {
        personId: null,
        email: "invitee@example.com",
        role: "Observer",
        pending: true,
      }),
    ]);

    expect(members).toHaveLength(1);
    expect(members[0]?.bindings).toHaveLength(2);
  });

  it("keeps different people and pending invitations separate even with the same email", () => {
    const members = groupWorkflowBindings([
      binding("engineer"),
      binding("observer", { personId: "person-2", role: "Observer" }),
      binding("invitation", { personId: null, pending: true }),
    ]);

    expect(members).toHaveLength(3);
    expect(members.map((member) => member.bindings.length)).toEqual([1, 1, 1]);
  });
});
