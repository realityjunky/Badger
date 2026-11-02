import { afterEach, describe, expect, it } from "vitest";
import {
  startTestService,
  type TestPerson,
  type TestService,
} from "../src/testing/index.js";

const admin: TestPerson = { subject: "admin", email: "admin@example.com" };
const lead: TestPerson = { subject: "lead", email: "lead@example.com" };
const engineer: TestPerson = {
  subject: "engineer",
  email: "engineer@example.com",
};
const outsider: TestPerson = {
  subject: "outsider",
  email: "outsider@example.com",
};
let service: TestService;

afterEach(async () => {
  await service?.close();
});

function write(method: string, path: string, as: TestPerson, body: unknown) {
  return service.request(`/api/v1${path}`, {
    as,
    method,
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

async function setup() {
  service = await startTestService({
    environment: {
      BADGER_BOOTSTRAP_ADMINISTRATORS: "admin@example.com",
      BADGER_ALLOWED_ORIGINS: "http://localhost",
    },
  });
  const created = await write("POST", "/groups", admin, { name: "Research" });
  expect(created.status).toBe(201);
  const { group } = (await created.json()) as { group: { id: string } };
  const bound = await write("POST", "/bindings", admin, {
    scopeType: "group",
    scopeId: group.id,
    role: "Group lead",
    email: lead.email,
  });
  expect(bound.status).toBe(201);
  return group;
}

const frame = {
  name: "primer-designer",
  goal: "Design primers from the reviewed source Skills.",
  intent: "new-skill",
  locale: "en",
};

interface Workflow {
  id: string;
  groupId: string;
  name: string;
  revision: number;
}
interface Version {
  id: string;
  number: number;
  revision: number;
  stages: { id: string; state: string }[];
}
interface Binding {
  id: string;
  revision: number;
  role: string;
  pending: boolean;
}

function assign(
  workflowId: string,
  as: TestPerson,
  email: string,
  role: string,
) {
  return write("POST", "/bindings", as, {
    scopeType: "workflow",
    scopeId: workflowId,
    email,
    role,
  });
}

async function createWorkflow(groupId: string, as = lead) {
  const response = await write("POST", "/workflows", as, { groupId, ...frame });
  expect(response.status).toBe(201);
  return (await response.json()) as { workflow: Workflow; version: Version };
}

describe("workflows and versions", () => {
  it("lets a Group lead create a workflow with its first version and eight stages", async () => {
    const group = await setup();
    const { workflow, version } = await createWorkflow(group.id);

    expect(workflow).toMatchObject({
      groupId: group.id,
      ...frame,
      revision: 1,
    });
    expect(version).toMatchObject({ number: 1, revision: 1, ...frame });
    expect(version.stages).toEqual([
      { id: "sources", state: "active" },
      { id: "source-study", state: "todo" },
      { id: "questionnaire", state: "todo" },
      { id: "dossier", state: "todo" },
      { id: "plan-proposal", state: "todo" },
      { id: "package", state: "todo" },
      { id: "evaluation", state: "todo" },
      { id: "review-publication", state: "todo" },
    ]);

    const catalog = await service.request("/api/v1/workflows", { as: lead });
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({
      workflows: [{ id: workflow.id }],
    });
    const read = await service.request(
      `/api/v1/workflows/${workflow.id}/versions/${version.id}`,
      { as: lead },
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ version });
  });

  it("lets a Workflow owner assign several roles to one person and remove a quoted binding", async () => {
    const group = await setup();
    const { workflow } = await createWorkflow(group.id);
    expect(
      (await assign(workflow.id, lead, outsider.email!, "Workflow owner"))
        .status,
    ).toBe(201);
    const assigned = await assign(
      workflow.id,
      outsider,
      engineer.email!,
      "Engineer",
    );
    expect(assigned.status).toBe(201);
    const { binding } = (await assigned.json()) as { binding: Binding };
    expect(binding).toMatchObject({ pending: true, revision: 1 });
    expect(
      (await assign(workflow.id, outsider, engineer.email!, "Field expert"))
        .status,
    ).toBe(201);

    const read = await service.request(`/api/v1/workflows/${workflow.id}`, {
      as: engineer,
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      capabilities: { read: true, manageRoles: false, createVersion: true },
    });

    // First verified sign-in resolved the invitation and advanced its revision.
    const stale = await write("DELETE", `/bindings/${binding.id}`, outsider, {
      revision: binding.revision,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: "conflict" },
      binding: { revision: 2 },
    });
    expect(
      (
        await write("DELETE", `/bindings/${binding.id}`, outsider, {
          revision: 2,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await service.request(`/api/v1/workflows/${workflow.id}`, {
          as: engineer,
        })
      ).status,
    ).toBe(200);
  });

  it("keeps version frames stable and rejects stale edits and simultaneous new versions", async () => {
    const group = await setup();
    const { workflow, version } = await createWorkflow(group.id);
    const changed = await write("PATCH", `/workflows/${workflow.id}`, lead, {
      revision: 1,
      goal: "A revised goal for the next version.",
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({
      workflow: { revision: 2, goal: "A revised goal for the next version." },
    });
    const stale = await write("PATCH", `/workflows/${workflow.id}`, lead, {
      revision: 1,
      name: "another-name",
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: "conflict" },
      workflow: { revision: 2, name: frame.name },
    });
    expect(
      (await assign(workflow.id, lead, engineer.email!, "Engineer")).status,
    ).toBe(201);
    const starts = await Promise.all([
      write("POST", `/workflows/${workflow.id}/versions`, engineer, {
        revision: 2,
      }),
      write("POST", `/workflows/${workflow.id}/versions`, engineer, {
        revision: 2,
      }),
    ]);
    expect(starts.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    const current = starts.find((response) => response.status === 409)!;
    expect(await current.json()).toMatchObject({ workflow: { revision: 3 } });
    const versions = await service.request(
      `/api/v1/workflows/${workflow.id}/versions`,
      { as: engineer },
    );
    expect(await versions.json()).toMatchObject({
      versions: [
        {
          number: 2,
          goal: "A revised goal for the next version.",
          revision: 1,
        },
        { id: version.id, number: 1, goal: frame.goal, revision: 1 },
      ],
    });
  });
});

describe("workflow capabilities at the HTTP seam", () => {
  it("rejects the retired Reviewer role", async () => {
    const group = await setup();
    const { workflow } = await createWorkflow(group.id);
    expect(
      (await assign(workflow.id, lead, outsider.email!, "Reviewer")).status,
    ).toBe(400);
  });

  it.each([
    ["Workflow owner", true, false],
    ["Engineer", false, true],
    ["Field expert", false, false],
    ["Operator", false, false],
    ["Observer", false, false],
  ])(
    "enforces %s capabilities without granting a Group role",
    async (role, manages, startsVersions) => {
      const group = await setup();
      const { workflow, version } = await createWorkflow(group.id);
      const assigned = await assign(
        workflow.id,
        lead,
        outsider.email!,
        role as string,
      );
      expect(assigned.status).toBe(201);
      const { binding } = (await assigned.json()) as { binding: Binding };
      const read = await service.request(`/api/v1/workflows/${workflow.id}`, {
        as: outsider,
      });
      expect(read.status).toBe(200);
      const detail = await read.json();
      expect(detail).toMatchObject({
        groupMembers: manages
          ? [{ email: lead.email, displayName: lead.subject }]
          : [],
        capabilities: {
          read: true,
          editWorkflow: manages,
          manageRoles: manages,
          createVersion: startsVersions,
          publish: manages,
        },
      });
      expect(detail.capabilities).not.toHaveProperty("approvePackage");
      expect(
        (
          await service.request(
            `/api/v1/workflows/${workflow.id}/versions/${version.id}`,
            { as: outsider },
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await write("POST", "/workflows", outsider, {
            ...frame,
            name: "other-workflow",
            groupId: group.id,
          })
        ).status,
      ).toBe(403);
      expect(
        (await assign(workflow.id, outsider, engineer.email!, "Observer"))
          .status,
      ).toBe(manages ? 201 : 403);
      expect(
        (
          await write("PATCH", `/workflows/${workflow.id}`, outsider, {
            revision: 1,
            goal: "Changed.",
          })
        ).status,
      ).toBe(manages ? 200 : 403);
      expect(
        (
          await write("POST", `/workflows/${workflow.id}/versions`, outsider, {
            revision: manages ? 2 : 1,
          })
        ).status,
      ).toBe(startsVersions ? 201 : 403);
      const catalog = await service.request("/api/v1/workflows", {
        as: outsider,
      });
      expect(await catalog.json()).toMatchObject({
        workflows: [{ id: workflow.id }],
        createGroups: [],
      });
      expect(
        (
          await write("DELETE", `/bindings/${binding.id}`, outsider, {
            revision: 2,
          })
        ).status,
      ).toBe(manages ? 200 : 403);
    },
  );

  it("inherits Group access downward and isolates workflow roles and versions", async () => {
    const group = await setup();
    const childResponse = await write("POST", "/groups", admin, {
      name: "Assays",
      parentId: group.id,
    });
    const { group: child } = (await childResponse.json()) as {
      group: { id: string };
    };
    const { workflow, version } = await createWorkflow(child.id);
    const otherResponse = await write("POST", "/groups", admin, {
      name: "Clinical",
    });
    const { group: other } = (await otherResponse.json()) as {
      group: { id: string };
    };
    const sibling = await createWorkflow(other.id, admin);
    expect(
      (
        await write("POST", "/workflows", lead, {
          ...frame,
          groupId: other.id,
          name: "outside-group",
        })
      ).status,
    ).toBe(403);
    await write("POST", "/bindings", lead, {
      scopeType: "group",
      scopeId: group.id,
      role: "Member",
      email: engineer.email,
    });
    expect(
      (
        await service.request(`/api/v1/workflows/${workflow.id}`, {
          as: engineer,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await service.request(`/api/v1/workflows/${sibling.workflow.id}`, {
          as: engineer,
        })
      ).status,
    ).toBe(403);
    expect(
      (await assign(workflow.id, admin, outsider.email!, "Observer")).status,
    ).toBe(201);
    expect(
      (
        await service.request(`/api/v1/workflows/${workflow.id}`, {
          as: outsider,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await service.request(
          `/api/v1/workflows/${sibling.workflow.id}/versions/${sibling.version.id}`,
          { as: outsider },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await service.request(
          `/api/v1/workflows/${workflow.id}/versions/${sibling.version.id}`,
          { as: lead },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await service.request(
          `/api/v1/workflows/${workflow.id}/versions/${version.id}`,
          { as: lead },
        )
      ).status,
    ).toBe(200);
    const catalog = await service.request("/api/v1/workflows", {
      as: outsider,
    });
    expect(await catalog.json()).toMatchObject({
      workflows: [{ id: workflow.id }],
    });
    expect(
      (
        (await (
          await service.request("/api/v1/workflows", { as: outsider })
        ).json()) as { workflows: unknown[] }
      ).workflows,
    ).toHaveLength(1);
  });

  it("lets Auditors read all workflows while keeping every write denied", async () => {
    const group = await setup();
    const { workflow } = await createWorkflow(group.id);
    await write("POST", "/bindings", admin, {
      scopeType: "organization",
      email: outsider.email,
      role: "Auditor",
    });
    const read = await service.request(`/api/v1/workflows/${workflow.id}`, {
      as: outsider,
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      groupMembers: [],
      capabilities: {
        read: true,
        editWorkflow: false,
        manageRoles: false,
        createVersion: false,
      },
    });
    expect(
      (await assign(workflow.id, outsider, engineer.email!, "Engineer")).status,
    ).toBe(403);
    expect(
      (
        await write("PATCH", `/workflows/${workflow.id}`, outsider, {
          revision: 1,
          name: "renamed-workflow",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await write("POST", `/workflows/${workflow.id}/versions`, outsider, {
          revision: 1,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await write("POST", "/workflows", outsider, {
          ...frame,
          groupId: group.id,
        })
      ).status,
    ).toBe(403);
  });
});

describe("workflow group member suggestions", () => {
  it("offers registered direct and inherited members only to role managers", async () => {
    const group = await setup();
    const childResponse = await write("POST", "/groups", admin, {
      name: "Assays",
      parentId: group.id,
    });
    const { group: child } = (await childResponse.json()) as {
      group: { id: string };
    };
    const siblingResponse = await write("POST", "/groups", admin, {
      name: "Clinical",
      parentId: group.id,
    });
    const { group: sibling } = (await siblingResponse.json()) as {
      group: { id: string };
    };
    const descendantResponse = await write("POST", "/groups", admin, {
      name: "Sequencing",
      parentId: child.id,
    });
    const { group: descendant } = (await descendantResponse.json()) as {
      group: { id: string };
    };
    const { workflow } = await createWorkflow(child.id);
    const direct = {
      subject: "direct",
      email: "direct@example.com",
      displayName: "Direct member",
    };
    const inherited = { ...engineer, displayName: "Ancestor member" };
    const nested = { subject: "nested", email: "nested@example.com" };
    const owner = { subject: "owner", email: "owner@example.com" };
    for (const [scopeId, person] of [
      [group.id, inherited],
      [group.id, direct],
      [child.id, direct],
      [sibling.id, outsider],
      [descendant.id, nested],
    ] as const) {
      expect(
        (
          await write("POST", "/bindings", admin, {
            scopeType: "group",
            scopeId,
            role: "Member",
            email: person.email,
          })
        ).status,
      ).toBe(201);
      expect((await service.request("/api/v1/me", { as: person })).status).toBe(
        200,
      );
    }
    await write("POST", "/bindings", admin, {
      scopeType: "group",
      scopeId: child.id,
      role: "Member",
      email: "pending@example.com",
    });
    const renamed = { ...inherited, email: "renamed@example.com" };
    await service.request("/api/v1/me", { as: renamed });
    expect(
      (await assign(workflow.id, lead, owner.email, "Workflow owner")).status,
    ).toBe(201);
    for (const manager of [admin, lead, owner]) {
      const response = await service.request(
        `/api/v1/workflows/${workflow.id}`,
        { as: manager },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        capabilities: { manageRoles: true },
        groupMembers: [
          {
            id: expect.any(String),
            email: renamed.email,
            displayName: inherited.displayName,
          },
          {
            id: expect.any(String),
            email: direct.email,
            displayName: direct.displayName,
          },
          {
            id: expect.any(String),
            email: lead.email,
            displayName: lead.subject,
          },
        ],
      });
    }
    expect(
      (await service.request("/api/v1/members", { as: owner })).status,
    ).toBe(403);
    const reader = await service.request(`/api/v1/workflows/${workflow.id}`, {
      as: direct,
    });
    expect(await reader.json()).toMatchObject({
      capabilities: { manageRoles: false },
      groupMembers: [],
    });
    const assigned = await assign(workflow.id, owner, direct.email, "Observer");
    expect(assigned.status).toBe(201);
    expect(await assigned.json()).toMatchObject({
      binding: { email: direct.email, pending: false },
    });
  });
});

describe("workflow input and invitations", () => {
  it("assigns the creator's identity as owner even when their email is unverified", async () => {
    const group = await setup();
    const unverifiedAdministrator = { ...admin, emailVerified: false };
    // A Group lead binding already follows this identity after verification.
    const bound = await write("POST", "/bindings", admin, {
      scopeType: "group",
      scopeId: group.id,
      email: admin.email,
      role: "Group lead",
    });
    expect(bound.status).toBe(201);
    const { workflow } = await createWorkflow(
      group.id,
      unverifiedAdministrator,
    );
    const read = await service.request(`/api/v1/workflows/${workflow.id}`, {
      as: unverifiedAdministrator,
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      bindings: [
        expect.objectContaining({
          role: "Workflow owner",
          pending: false,
          email: admin.email,
        }),
      ],
    });
  });

  it("limits managed workflow members and invitations to led Groups, excluding ancestors", async () => {
    const group = await setup();
    const { workflow: parentWorkflow } = await createWorkflow(group.id);
    const childResponse = await write("POST", "/groups", admin, {
      name: "Assays",
      parentId: group.id,
    });
    const { group: child } = (await childResponse.json()) as {
      group: { id: string };
    };
    const { workflow: childWorkflow } = await createWorkflow(child.id);
    await write("POST", "/bindings", lead, {
      scopeType: "group",
      scopeId: child.id,
      role: "Group lead",
      email: engineer.email,
    });
    expect(
      (await assign(parentWorkflow.id, lead, outsider.email!, "Observer"))
        .status,
    ).toBe(201);
    expect(
      (await assign(childWorkflow.id, lead, outsider.email!, "Observer"))
        .status,
    ).toBe(201);
    const pending = await service.request("/api/v1/invitations", {
      as: engineer,
    });
    expect(pending.status).toBe(200);
    expect(
      ((await pending.json()) as { invitations: unknown[] }).invitations,
    ).toEqual([
      expect.objectContaining({
        scopeType: "workflow",
        scopeId: childWorkflow.id,
        email: outsider.email,
      }),
    ]);
    await service.request(`/api/v1/workflows/${childWorkflow.id}`, {
      as: outsider,
    });
    const members = await service.request("/api/v1/members", { as: engineer });
    expect(members.status).toBe(200);
    const resolved = (
      (await members.json()) as {
        members: { person: { email: string }; bindings: unknown[] }[];
      }
    ).members;
    expect(
      resolved.find((member) => member.person.email === outsider.email)
        ?.bindings,
    ).toEqual([
      expect.objectContaining({
        scopeType: "workflow",
        scopeId: childWorkflow.id,
        role: "Observer",
      }),
    ]);
  });

  it("uses the kernel's name rules and refuses malformed frames and client stage changes", async () => {
    const group = await setup();
    for (const name of [
      "a",
      "0workflow",
      "Uppercase",
      "has_underscore",
      "../escape",
      " spaced ",
      "a".repeat(65),
    ]) {
      expect(
        (
          await write("POST", "/workflows", lead, {
            ...frame,
            groupId: group.id,
            name,
          })
        ).status,
        name,
      ).toBe(400);
    }
    for (const patch of [
      { goal: " " },
      { intent: "upgrade" },
      { locale: "not_a_locale" },
      { stages: [] },
      { ownerId: "forged" },
    ]) {
      expect(
        (
          await write("POST", "/workflows", lead, {
            ...frame,
            groupId: group.id,
            ...patch,
          })
        ).status,
      ).toBe(400);
    }
    const valid = await write("POST", "/workflows", lead, {
      ...frame,
      groupId: group.id,
      name: "a".repeat(64),
      intent: "upgrade-existing",
      locale: "zh-cn",
    });
    expect(valid.status).toBe(201);
    expect(await valid.json()).toMatchObject({
      workflow: { intent: "upgrade-existing", locale: "zh-CN" },
    });
    const { workflow } = await createWorkflow(group.id);
    expect(
      (await write("POST", "/workflows", lead, { ...frame, groupId: group.id }))
        .status,
    ).toBe(409);
    for (const revision of [undefined, 0, -1, 1.5, "1"]) {
      expect(
        (
          await write("PATCH", `/workflows/${workflow.id}`, lead, {
            revision,
            goal: "Changed.",
          })
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await write("PATCH", `/workflows/${workflow.id}`, lead, {
          revision: 1,
          stages: { sources: "done" },
        })
      ).status,
    ).toBe(400);
    expect(
      (await assign(workflow.id, lead, outsider.email!, "Administrator"))
        .status,
    ).toBe(400);
  });

  it("resolves invitations separately per workflow, follows identities, and revokes at the next request", async () => {
    const group = await setup();
    const { workflow } = await createWorkflow(group.id);
    const otherResponse = await write("POST", "/workflows", lead, {
      ...frame,
      name: "second-workflow",
      groupId: group.id,
    });
    const { workflow: other } = (await otherResponse.json()) as {
      workflow: Workflow;
    };
    const granted = await assign(
      workflow.id,
      lead,
      outsider.email!,
      "Observer",
    );
    const { binding } = (await granted.json()) as { binding: Binding };
    expect(
      (await assign(other.id, lead, outsider.email!, "Observer")).status,
    ).toBe(201);
    expect(
      (
        await service.request(`/api/v1/workflows/${workflow.id}`, {
          as: { ...outsider, emailVerified: false },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await service.request(`/api/v1/workflows/${workflow.id}`, {
          as: outsider,
        })
      ).status,
    ).toBe(200);
    const moved = { ...outsider, email: "moved@example.com" };
    expect(
      (await service.request(`/api/v1/workflows/${workflow.id}`, { as: moved }))
        .status,
    ).toBe(200);
    expect(
      (
        await service.request(`/api/v1/workflows/${workflow.id}`, {
          as: { subject: "replacement", email: outsider.email },
        })
      ).status,
    ).toBe(403);
    expect(
      (await write("DELETE", `/bindings/${binding.id}`, lead, { revision: 2 }))
        .status,
    ).toBe(200);
    expect(
      (await service.request(`/api/v1/workflows/${workflow.id}`, { as: moved }))
        .status,
    ).toBe(403);
    expect(
      (await service.request(`/api/v1/workflows/${other.id}`, { as: moved }))
        .status,
    ).toBe(200);
    const events = await service.request(
      `/api/v1/audit-events?targetId=${binding.id}`,
      { as: admin },
    );
    expect(await events.json()).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({
          action: "role_binding.removed",
          targetLabel: `Observer · ${frame.name} · ${outsider.email}`,
        }),
        expect.objectContaining({ action: "role_binding.resolved" }),
        expect.objectContaining({ action: "role_binding.invited" }),
      ]),
    });
  });
});
