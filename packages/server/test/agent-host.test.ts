import { afterEach, expect, it } from "vitest";
import {
  startTestService,
  type TestPerson,
  type TestService,
} from "../src/testing/index.js";

const admin = { subject: "admin", email: "admin@example.com" };
const expert = { subject: "expert", email: "expert@example.com" };
const engineer = { subject: "engineer", email: "engineer@example.com" };
let service: TestService;
afterEach(async () => service?.close());

async function personRequest(
  route: string,
  method = "GET",
  body?: unknown,
  as: TestPerson = admin,
) {
  const response = await service.request(`/api/v1${route}`, {
    as,
    method,
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  expect(response.ok, JSON.stringify(value)).toBe(true);
  return value;
}

async function createToken(as: TestPerson, scope: string) {
  return personRequest(
    "/me/tokens",
    "POST",
    { name: "Agent", scopes: [scope] },
    as,
  );
}

async function setup() {
  service = await startTestService({
    environment: {
      BADGER_BOOTSTRAP_ADMINISTRATORS: admin.email,
      BADGER_ALLOWED_ORIGINS: "http://localhost",
    },
  });
  const { group } = await personRequest("/groups", "POST", {
    name: "Research",
  });
  const { workflow, version } = await personRequest("/workflows", "POST", {
    groupId: group.id,
    name: "agent-provenance",
    goal: "Record who contributed workflow knowledge.",
    intent: "new-skill",
    locale: "en",
  });
  for (const [person, role] of [
    [expert, "Field expert"],
    [engineer, "Engineer"],
  ] as const)
    await personRequest("/bindings", "POST", {
      scopeType: "workflow",
      scopeId: workflow.id,
      email: person.email,
      role,
    });
  const base = `/workflows/${workflow.id}/versions/${version.id}/questionnaire`;
  const { round } = await personRequest(`${base}/rounds`, "POST", {
    title: "Storage",
  });
  const { question } = await personRequest(
    `${base}/rounds/${round.id}/questions`,
    "POST",
    {
      text: "How is the sample stored?",
      topic: "scope",
      targets: [{ kind: "workflow", id: "workflow" }],
      rationale: "Agree the storage conditions.",
      evidence: [],
      assignees: [{ kind: "role", role: "Field expert" }],
      priority: 10,
    },
  );
  const { preview } = await personRequest(
    `${base}/rounds/${round.id}/publish-preview`,
  );
  await personRequest(`${base}/rounds/${round.id}/publish`, "POST", {
    confirmed: true,
    confirmationHash: preview.confirmationHash,
  });
  const token = await createToken(expert, "expert");
  return { base, question, group, token };
}

function tokenWrite(
  secret: string,
  route: string,
  body: unknown,
  host?: string,
) {
  return service.request(`/api/v1${route}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      ...(host === undefined ? {} : { "x-badger-agent-host": host }),
    },
    body: JSON.stringify(body),
  });
}

it("requires an Agent host before a token adds a comment", async () => {
  const { base, question, token } = await setup();
  const response = await tokenWrite(
    token.secret,
    `${base}/questions/${question.id}/comments`,
    { text: "Keep frozen." },
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: { message: expect.stringContaining("x-badger-agent-host") },
  });
});

it("records a token comment's Agent host with the person, token, and MCP channel", async () => {
  const { base, question, token } = await setup();
  const response = await tokenWrite(
    token.secret,
    `${base}/questions/${question.id}/comments`,
    { text: "Keep frozen." },
    "lab-workbuddy",
  );
  expect(response.status).toBe(201);
  const { comment } = await response.json();
  const { events } = await personRequest(
    `/audit-events?targetId=${comment.id}`,
  );
  const { person } = await personRequest("/me", "GET", undefined, expert);
  expect(events).toEqual([
    expect.objectContaining({
      actorPersonId: person.id,
      credentialKind: "token",
      credentialId: token.token.id,
      channel: "mcp",
      agentHost: "lab-workbuddy",
    }),
  ]);
});

it("requires and audits the Agent host for an expert token's concern", async () => {
  const { base, token } = await setup();
  const route = `${base}/concerns`;
  const body = { text: "Samples may thaw before arrival." };
  expect((await tokenWrite(token.secret, route, body)).status).toBe(400);
  const response = await tokenWrite(token.secret, route, body, "lab-workbuddy");
  expect(response.status).toBe(201);
  const { concern } = await response.json();
  const { events } = await personRequest(
    `/audit-events?targetId=${concern.id}`,
  );
  expect(events).toEqual([
    expect.objectContaining({
      action: "concern.raised",
      credentialId: token.token.id,
      agentHost: "lab-workbuddy",
    }),
  ]);
});

it("requires and audits the Agent host for a Skill version upload", async () => {
  const { group, token } = await setup();
  const { skill } = await personRequest("/skills", "POST", {
    groupId: group.id,
    name: "example",
  });
  const body = {
    files: [
      {
        path: "SKILL.md",
        content: Buffer.from(
          "---\nname: example\ndescription: Example Skill\n---\n\n# Example\n",
        ).toString("base64"),
      },
    ],
    scripts: {},
  };
  const previewResponse = await tokenWrite(
    token.secret,
    `/skills/${skill.id}/upload-preview`,
    body,
    "lab-workbuddy",
  );
  expect(previewResponse.status).toBe(200);
  const { preview } = await previewResponse.json();
  const confirmed = { ...body, confirmed: true, expectedHash: preview.hash };
  const route = `/skills/${skill.id}/versions`;
  expect((await tokenWrite(token.secret, route, confirmed)).status).toBe(400);
  expect(
    (await tokenWrite(token.secret, route, confirmed, "lab-workbuddy")).status,
  ).toBe(201);
  const { events } = await personRequest(
    "/audit-events?action=skill_version.uploaded",
  );
  expect(events).toEqual([
    expect.objectContaining({
      credentialId: token.token.id,
      agentHost: "lab-workbuddy",
      channel: "mcp",
    }),
  ]);
});

it("requires and audits the Agent host for an Engineer token's draft", async () => {
  const { base } = await setup();
  const token = await createToken(engineer, "engineer");
  const route = `${base}/inferences`;
  const body = {
    statement: "Samples are frozen on arrival.",
    topic: "scope",
    questionId: null,
  };
  expect((await tokenWrite(token.secret, route, body)).status).toBe(400);
  const response = await tokenWrite(
    token.secret,
    route,
    body,
    "engineer-laptop",
  );
  expect(response.status).toBe(201);
  const { record } = await response.json();
  const { events } = await personRequest(`/audit-events?targetId=${record.id}`);
  expect(events).toEqual([
    expect.objectContaining({
      action: "inference.drafted",
      credentialId: token.token.id,
      agentHost: "engineer-laptop",
    }),
  ]);
});

it.each(["", "   ", "x".repeat(201), "lab\tworkbuddy"])(
  "refuses a malformed Agent host on a token write: %j",
  async (host) => {
    const { base, token } = await setup();
    const response = await tokenWrite(
      token.secret,
      `${base}/concerns`,
      { text: "Keep frozen." },
      host,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining("x-badger-agent-host") },
    });
    const { events } = await personRequest(
      "/audit-events?action=concern.raised",
    );
    expect(events).toEqual([]);
  },
);

it("ignores an Agent host supplied by a signed-in person", async () => {
  const { base, question } = await setup();
  const response = await service.request(
    `/api/v1${base}/questions/${question.id}/comments`,
    {
      as: expert,
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
        "x-badger-agent-host": "spoofed-agent",
      },
      body: JSON.stringify({ text: "Keep frozen." }),
    },
  );
  expect(response.status).toBe(201);
  const { comment } = await response.json();
  const { events } = await personRequest(
    `/audit-events?targetId=${comment.id}`,
  );
  expect(events).toEqual([
    expect.objectContaining({
      credentialKind: "session",
      channel: "web",
      agentHost: null,
    }),
  ]);
});

function tokenRead(secret: string, route: string, host?: string) {
  return service.request(`/api/v1${route}`, {
    headers: {
      authorization: `Bearer ${secret}`,
      ...(host === undefined ? {} : { "x-badger-agent-host": host }),
    },
  });
}

it("refuses a token read without an Agent host, with the same message as a write", async () => {
  const { base, token } = await setup();
  const engineerToken = await createToken(engineer, "engineer");
  const drafting = base.replace(/\/questionnaire$/u, "/drafting-jobs");
  for (const [secret, route] of [
    [token.secret, "/me"],
    [token.secret, base],
    [engineerToken.secret, base],
    [engineerToken.secret, drafting],
  ]) {
    for (const host of [undefined, "lab\tworkbuddy"]) {
      const response = await tokenRead(secret, route, host);
      expect(response.status, route).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          code: "invalid",
          message:
            "x-badger-agent-host must contain 1 to 200 printable characters",
        },
      });
    }
    expect((await tokenRead(secret, route, "lab-workbuddy")).status).toBe(200);
  }
});

it("records the Agent host on token use", async () => {
  const { token } = await setup();
  expect((await tokenRead(token.secret, "/me")).status).toBe(400);
  expect((await tokenRead(token.secret, "/me", "lab-workbuddy")).status).toBe(
    200,
  );
  const { events } = await personRequest("/audit-events?action=token.used");
  // The refused request is still a use of the token, without a host.
  expect(
    events.map((event: { agentHost: string | null }) => event.agentHost),
  ).toEqual(["lab-workbuddy", null]);
});

it("records the Agent host when a token's questionnaire read requeues an expired drafting lease", async () => {
  const { base, token } = await setup();
  const engineerToken = await createToken(engineer, "engineer");
  const drafting = base.replace(/\/questionnaire$/u, "/drafting-jobs");
  const { round } = await personRequest(
    `${base}/rounds`,
    "POST",
    { title: "Follow-up" },
    engineer,
  );
  const { job } = await personRequest(
    drafting,
    "POST",
    { kind: "draft-questions", roundId: round.id, confirmed: true },
    engineer,
  );
  const claimed = await tokenWrite(
    engineerToken.secret,
    `${drafting}/${job.id}/claim`,
    { revision: job.revision },
    "engineer-laptop",
  );
  expect(claimed.status).toBe(200);
  service.clock.advance(30 * 60_000);
  const expiries = async () =>
    (await personRequest(`/audit-events?targetId=${job.id}`)).events.filter(
      (event: { action: string }) =>
        event.action === "drafting-job.lease-expired",
    );
  // A read without a host is refused before it reconciles, so it can never
  // record the requeue without one.
  expect((await tokenRead(engineerToken.secret, base)).status).toBe(400);
  expect(await expiries()).toEqual([]);
  expect((await tokenRead(token.secret, base, "lab-workbuddy")).status).toBe(
    200,
  );
  const read = await tokenRead(engineerToken.secret, base, "review-host");
  expect(read.status).toBe(200);
  expect(await expiries()).toEqual([
    expect.objectContaining({
      credentialKind: "token",
      credentialId: token.token.id,
      channel: "mcp",
      agentHost: "lab-workbuddy",
    }),
  ]);
});
