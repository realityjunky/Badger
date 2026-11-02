import { afterEach, expect, it } from "vitest";
import {
  startTestService,
  type TestPerson,
  type TestService,
} from "../src/testing/index.js";

const admin: TestPerson = { subject: "admin", email: "admin@example.com" };
const engineer: TestPerson = {
  subject: "engineer",
  email: "engineer@example.com",
};
const reader: TestPerson = { subject: "reader", email: "reader@example.com" };
const outsider: TestPerson = {
  subject: "outsider",
  email: "outsider@example.com",
};
let service: TestService;
afterEach(async () => service?.close());

async function write(path: string, body: unknown) {
  const response = await service.request(`/api/v1${path}`, {
    method: "POST",
    as: admin,
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(
    201,
  );
  return response.json();
}

async function setup() {
  service = await startTestService({
    environment: {
      BADGER_BOOTSTRAP_ADMINISTRATORS: admin.email,
      BADGER_ALLOWED_ORIGINS: "http://localhost",
    },
  });
  const { group } = await write("/groups", { name: "Primer team" });
  const { group: otherGroup } = await write("/groups", {
    name: "Private team",
  });
  const frame = { goal: "Primer design", intent: "new-skill", locale: "en" };
  const { workflow, version } = await write("/workflows", {
    groupId: group.id,
    name: "primer-public",
    ...frame,
  });
  const { workflow: privateWorkflow } = await write("/workflows", {
    groupId: otherGroup.id,
    name: "primer-private",
    ...frame,
  });
  await write("/skills", { groupId: group.id, name: "primer-source" });
  await write("/skills", { groupId: otherGroup.id, name: "primer-secret" });
  for (const [person, role] of [
    [engineer, "Engineer"],
    [reader, "Observer"],
  ] as const) {
    await write("/bindings", {
      email: person.email,
      role,
      scopeType: "workflow",
      scopeId: workflow.id,
    });
  }
  const base = `/workflows/${workflow.id}/versions/${version.id}/questionnaire`;
  const question = {
    text: "Primer published question",
    topic: "scope",
    targets: [{ kind: "workflow", id: "workflow" }],
    rationale: "Understand primers",
    evidence: [],
    assignees: [{ kind: "role", role: "Workflow owner" }],
    priority: 10,
  };
  const { round } = await write(`${base}/rounds`, {
    title: "Primer questions",
  });
  await write(`${base}/rounds/${round.id}/questions`, question);
  const previewResponse = await service.request(
    `/api/v1${base}/rounds/${round.id}/publish-preview`,
    { as: admin },
  );
  const { preview } = await previewResponse.json();
  const published = await service.request(
    `/api/v1${base}/rounds/${round.id}/publish`,
    {
      method: "POST",
      as: admin,
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        confirmationHash: preview.confirmationHash,
        confirmed: true,
      }),
    },
  );
  expect(published.status).toBe(200);
  const { round: draftRound } = await write(`${base}/rounds`, {
    title: "Draft",
  });
  await write(`${base}/rounds/${draftRound.id}/questions`, {
    ...question,
    text: "Primer confidential draft",
  });
  return { group, workflow, version, otherGroup, privateWorkflow };
}

async function search(as: TestPerson, parameters = "q=primer") {
  const response = await service.request(`/api/v1/search?${parameters}`, {
    as,
  });
  expect(response.status).toBe(200);
  return (await response.json()).results as {
    kind: string;
    label: string;
    href: string;
  }[];
}

it("searches authorized workflows, Skills and published questions while retaining draft privacy", async () => {
  const { workflow } = await setup();
  const results = await search(reader);
  expect(results.map((result) => result.label).sort()).toEqual([
    "Primer published question",
    "primer-public",
    "primer-source",
  ]);
  expect(results.find((result) => result.kind === "workflow")?.href).toBe(
    `/workflows/${workflow.id}`,
  );
  expect((await search(engineer)).map((result) => result.label)).toContain(
    "Primer confidential draft",
  );
  expect((await search(admin)).map((result) => result.label)).toContain(
    "primer-private",
  );
  expect(await search(outsider)).toEqual([]);
});

it("keeps search filters authorized, treats wildcard characters literally and bounds the query", async () => {
  const { group, workflow, version, otherGroup, privateWorkflow } =
    await setup();
  expect(await search(reader, `q=primer&group=${otherGroup.id}`)).toEqual([]);
  expect(
    await search(reader, `q=primer&workflow=${privateWorkflow.id}`),
  ).toEqual([]);
  expect(
    await search(reader, `q=primer&workflow=${workflow.id}&version=missing`),
  ).toEqual([]);
  expect(
    (
      await search(
        reader,
        `q=primer&group=${group.id}&workflow=${workflow.id}&version=${version.id}`,
      )
    ).length,
  ).toBe(3);
  expect(await search(admin, "q=%25")).toEqual([]);
  expect(await search(admin, "q=")).toEqual([]);
  expect(
    (
      await service.request(`/api/v1/search?q=primer&version=${version.id}`, {
        as: admin,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await service.request(`/api/v1/search?q=${"x".repeat(201)}`, {
        as: admin,
      })
    ).status,
  ).toBe(400);
});

it("shows deployment integration status only to organization readers and returns no configuration secrets", async () => {
  await setup();
  const response = await service.request("/api/v1/admin/integrations", {
    as: admin,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    identity: { kind: "none", configured: false },
    invitationEmail: { configured: false },
    notifications: { configured: false },
  });
  expect(
    (await service.request("/api/v1/admin/integrations", { as: reader }))
      .status,
  ).toBe(403);
});
