import { afterEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  startTestService,
  type TestService,
  type TestPerson,
} from "@realityjunky/badger-server/testing";
import { createExpertMcp } from "../src/index.js";

let service: TestService;
const clients: Client[] = [];
const folders: string[] = [];
const admin: TestPerson = { subject: "admin", email: "admin@example.com" };
const expert: TestPerson = { subject: "expert", email: "expert@example.com" };
const observer: TestPerson = {
  subject: "observer",
  email: "observer@example.com",
};

async function write(method: string, path: string, body: unknown, as = admin) {
  const response = await service.request(`/api/v1${path}`, {
    as,
    method,
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  expect(response.ok, JSON.stringify(value)).toBe(true);
  return value;
}

async function setup() {
  service = await startTestService({
    environment: {
      BADGER_BOOTSTRAP_ADMINISTRATORS: admin.email,
      BADGER_ALLOWED_ORIGINS: "http://localhost",
    },
  });
  const { group } = await write("POST", "/groups", { name: "Research" });
  const { workflow, version } = await write("POST", "/workflows", {
    groupId: group.id,
    name: "expert-work",
    goal: "Capture expert knowledge.",
    intent: "new-skill",
    locale: "en",
  });
  await service.request("/api/v1/me", { as: expert });
  const bindings = [];
  for (const [person, role] of [
    [expert, "Field expert"],
    [observer, "Observer"],
  ] as const) {
    const { binding } = await write("POST", "/bindings", {
      scopeType: "workflow",
      scopeId: workflow.id,
      email: person.email,
      role,
    });
    bindings.push(binding);
  }
  return {
    workflowId: workflow.id as string,
    versionId: version.id as string,
    groupId: group.id as string,
    expertBinding: bindings[0],
  };
}

async function connect(as = expert, scopes = ["expert"], capabilities = {}) {
  const { secret, token } = await write(
    "POST",
    "/me/tokens",
    { name: "Test Agent", scopes },
    as,
  );
  const server = createExpertMcp({
    url: service.baseUrl,
    token: secret,
    agentHost: "Test Agent",
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client(
    { name: "Test Agent", version: "1.0.0" },
    { capabilities },
  );
  clients.push(client);
  await client.connect(a);
  return { client, token };
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0].text);
}

async function publishQuestion(
  context: { workflowId: string; versionId: string },
  text = "How is the sample stored?",
) {
  await service.request("/api/v1/me", { as: expert });
  const base = `/workflows/${context.workflowId}/versions/${context.versionId}/questionnaire`;
  const { round } = await write("POST", `${base}/rounds`, {
    title: "Sample handling",
  });
  const { question } = await write(
    "POST",
    `${base}/rounds/${round.id}/questions`,
    {
      text,
      topic: "scope",
      targets: [{ kind: "workflow", id: "workflow" }],
      rationale: "Capture the storage requirements.",
      evidence: [],
      assignees: [{ kind: "role", role: "Field expert" }],
      priority: 10,
    },
  );
  const previewed = await service.request(
    `/api/v1${base}/rounds/${round.id}/publish-preview`,
    { as: admin },
  );
  const { preview } = await previewed.json();
  await write("POST", `${base}/rounds/${round.id}/publish`, {
    confirmed: true,
    confirmationHash: preview.confirmationHash,
  });
  return {
    questionId: question.id as string,
    questionRevision: question.revision as number,
    base,
  };
}
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await service?.close();
  for (const folder of folders.splice(0))
    await fs.rm(folder, { recursive: true, force: true });
});

it("previews and uploads an immutable Skill version from a folder against the confirmed hash", async () => {
  const { groupId } = await setup();
  const { skill } = await write("POST", "/skills", {
    groupId,
    name: "storage",
  });
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "badger-mcp-skill-"));
  folders.push(folder);
  await fs.writeFile(
    path.join(folder, "SKILL.md"),
    "---\nname: storage\ndescription: Safe specimen storage.\n---\n\n# Storage\n",
  );
  await fs.mkdir(path.join(folder, "scripts"));
  await fs.writeFile(
    path.join(folder, "scripts", "check.py"),
    "print('storage')\n",
  );
  const { client } = await connect();
  const args = {
    skillId: skill.id,
    folder,
    scripts: { "scripts/check.py": ["none"] },
  };
  const { preview } = await call(client, "upload_skill_version", args);
  expect(preview.hash).toMatch(/^[a-f0-9]{64}$/u);
  const before = await service.request(`/api/v1/skills/${skill.id}/versions`, {
    as: expert,
  });
  expect(await before.json()).toEqual({ versions: [] });
  await fs.appendFile(
    path.join(folder, "SKILL.md"),
    "Updated after preview.\n",
  );
  const stale = await client.callTool({
    name: "upload_skill_version",
    arguments: { ...args, confirmed: true, expectedHash: preview.hash },
  });
  expect(stale.isError).toBe(true);
  const current = await call(client, "upload_skill_version", args);
  const uploaded = await call(client, "upload_skill_version", {
    ...args,
    confirmed: true,
    expectedHash: current.preview.hash,
  });
  expect(uploaded).toMatchObject({
    version: { skillId: skill.id, hash: current.preview.hash },
  });
  const versions = await service.request(
    `/api/v1/skills/${skill.id}/versions`,
    { as: expert },
  );
  expect(await versions.json()).toMatchObject({
    versions: [{ hash: current.preview.hash, origin: "upload" }],
  });
});

it("returns dashboard links for people-only actions and offers URL elicitation when supported", async () => {
  const { workflowId, versionId } = await setup();
  const { questionId } = await publishQuestion({ workflowId, versionId });
  const { client } = await connect(expert, ["expert"], {
    elicitation: { url: {} },
  });
  const elicited: unknown[] = [];
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    elicited.push(request.params);
    return { action: "accept" };
  });
  const link = await call(client, "open_dashboard", {
    workflowId,
    versionId,
    questionId,
    action: "acknowledge",
  });
  expect(link).toMatchObject({
    requiresPerson: true,
    url: `${service.baseUrl}/questionnaire/questions/${questionId}`,
  });
  expect(elicited).toEqual([
    expect.objectContaining({ mode: "url", url: link.url }),
  ]);
  const { client: fallback } = await connect();
  expect(
    await call(fallback, "open_dashboard", {
      workflowId,
      versionId,
      action: "approve",
    }),
  ).toMatchObject({
    requiresPerson: true,
    url: `${service.baseUrl}/workflows/${workflowId}/versions/${versionId}`,
  });
  const forbidden = await client.callTool({
    name: "acknowledge",
    arguments: { workflowId, versionId, questionId },
  });
  expect(forbidden.isError).toBe(true);
  const view = await service.request(
    `/api/v1/workflows/${workflowId}/versions/${versionId}/questionnaire`,
    { as: admin },
  );
  expect(await view.json()).toMatchObject({
    questions: [expect.objectContaining({ state: "open" })],
    answers: [],
  });
});

it("keeps large question content in resources and rechecks access before reading it", async () => {
  const { workflowId, versionId } = await setup();
  const text = "Detailed storage requirements. ".repeat(400);
  await publishQuestion({ workflowId, versionId }, text);
  const { client, token } = await connect();
  const result = await client.callTool({
    name: "my_questions",
    arguments: { workflowId, versionId },
  });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(8192);
  const contents = result.content as { type: string; uri: string }[];
  const link = contents.find((item) => item.type === "resource_link")!;
  expect(link).toBeDefined();
  const fallback = (result.content as { type: string; text?: string }[]).find(
    (item) => item.type === "text",
  )!;
  const local = JSON.parse(fallback.text!);
  const file = await fs.readFile(local.localFile, "utf8");
  expect(JSON.parse(file)).toMatchObject({
    questions: [expect.objectContaining({ text })],
  });
  if (process.platform !== "win32")
    expect((await fs.stat(local.localFile)).mode & 0o777).toBe(0o600);
  const resource = await client.readResource({ uri: link.uri });
  expect(resource.contents).toEqual([
    expect.objectContaining({
      mimeType: "application/json",
      text: expect.stringContaining(text),
    }),
  ]);
  expect((await client.listResources()).resources).toEqual([
    expect.objectContaining({ uri: link.uri }),
  ]);
  await write(
    "DELETE",
    `/me/tokens/${token.id}`,
    { revision: token.revision },
    expert,
  );
  await expect(client.readResource({ uri: link.uri })).rejects.toThrow(/401/u);
  await client.close();
  await expect
    .poll(() =>
      fs.access(local.localFile).then(
        () => true,
        () => false,
      ),
    )
    .toBe(false);
});

it("refuses stale answers, unassigned writes, and tools hidden after a role is removed", async () => {
  const { workflowId, versionId, expertBinding } = await setup();
  const { questionId, questionRevision } = await publishQuestion({
    workflowId,
    versionId,
  });
  const { client } = await connect();
  const args = {
    workflowId,
    versionId,
    questionId,
    questionRevision,
    revision: 0,
    text: "Keep frozen.",
  };
  await call(client, "save_answer", args);
  const stale = await client.callTool({ name: "save_answer", arguments: args });
  expect(stale).toMatchObject({
    isError: true,
    content: [
      expect.objectContaining({ text: expect.stringContaining("409") }),
    ],
  });
  const { client: otherClient } = await connect(observer);
  expect(
    (await otherClient.callTool({ name: "save_answer", arguments: args }))
      .isError,
  ).toBe(true);
  await write("DELETE", `/bindings/${expertBinding.id}`, {
    revision: expertBinding.revision,
  });
  expect(
    (await client.listTools()).tools.map((tool) => tool.name),
  ).not.toContain("save_answer");
  expect(
    (
      await client.callTool({
        name: "save_answer",
        arguments: { ...args, revision: 1 },
      })
    ).isError,
  ).toBe(true);
});

it("refuses symlinked files and oversized local folders before creating a Skill version", async () => {
  const { groupId } = await setup();
  const { skill } = await write("POST", "/skills", {
    groupId,
    name: "safe-upload",
  });
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "badger-mcp-safe-"));
  folders.push(folder);
  const source = "---\nname: safe-upload\ndescription: Safe upload.\n---\n";
  await fs.writeFile(path.join(folder, "SKILL.md"), source);
  await fs.symlink(
    path.join(folder, "SKILL.md"),
    path.join(folder, "linked.md"),
  );
  const { client } = await connect();
  const args = { skillId: skill.id, folder };
  const linked = await client.callTool({
    name: "upload_skill_version",
    arguments: args,
  });
  expect(linked).toMatchObject({
    isError: true,
    content: [
      expect.objectContaining({
        text: expect.stringMatching(/symbolic links/iu),
      }),
    ],
  });
  await fs.unlink(path.join(folder, "linked.md"));
  await fs.writeFile(
    path.join(folder, "too-large.bin"),
    Buffer.alloc(5 * 1024 * 1024 + 1),
  );
  const oversized = await client.callTool({
    name: "upload_skill_version",
    arguments: args,
  });
  expect(oversized.isError).toBe(true);
  const versions = await service.request(
    `/api/v1/skills/${skill.id}/versions`,
    { as: expert },
  );
  expect(await versions.json()).toEqual({ versions: [] });
});

it("starts the real stdio entry point using environment settings under a deployment prefix", async () => {
  service = await startTestService({
    mode: "local",
    environment: { BADGER_BASE_PATH: "/badger" },
  });
  const response = await service.request("/badger/api/v1/me/tokens", {
    method: "POST",
    headers: { "content-type": "application/json", origin: service.baseUrl },
    body: JSON.stringify({ name: "Stdio Agent", scopes: ["expert"] }),
  });
  expect(response.status).toBe(201);
  const { secret } = await response.json();
  const client = new Client({ name: "Stdio Agent", version: "1.0.0" });
  clients.push(client);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../dist/src/cli.js", import.meta.url))],
      env: {
        BADGER_URL: `${service.baseUrl}/badger`,
        BADGER_TOKEN: secret,
        BADGER_AGENT_HOST: "CLI fixture",
      },
    }),
  );
  expect(await call(client, "whoami")).toMatchObject({
    credential: { kind: "token", scopes: ["expert"] },
  });
  expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
    "raise_concern",
  );
  const localWrite = async (path: string, body: unknown) => {
    const response = await service.request(`/badger/api/v1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: service.baseUrl },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    expect(response.ok, JSON.stringify(value)).toBe(true);
    return value;
  };
  const { group } = await localWrite("/groups", { name: "Stdio team" });
  const { workflow, version } = await localWrite("/workflows", {
    groupId: group.id,
    name: "stdio-workflow",
    goal: "Capture long expert questions.",
    intent: "new-skill",
    locale: "en",
  });
  const base = `/workflows/${workflow.id}/versions/${version.id}/questionnaire`;
  const { round } = await localWrite(`${base}/rounds`, {
    title: "Long question",
  });
  const text = "Store cold. ".repeat(1000);
  await localWrite(`${base}/rounds/${round.id}/questions`, {
    text,
    topic: "scope",
    rationale: "Capture the user's requirements.",
    targets: [{ kind: "workflow", id: "workflow" }],
    evidence: [],
    assignees: [{ kind: "role", role: "Workflow owner" }],
    priority: 1,
  });
  const previewed = await service.request(
    `/badger/api/v1${base}/rounds/${round.id}/publish-preview`,
  );
  const { preview } = await previewed.json();
  await localWrite(`${base}/rounds/${round.id}/publish`, {
    confirmed: true,
    confirmationHash: preview.confirmationHash,
  });
  const result = await call(client, "my_questions", {
    workflowId: workflow.id,
    versionId: version.id,
  });
  expect(await fs.readFile(result.localFile, "utf8")).toContain(text);
  await client.close();
  await expect
    .poll(() =>
      fs.access(result.localFile).then(
        () => true,
        () => false,
      ),
    )
    .toBe(false);
});

it("filters the expert profile by current roles and token scopes", async () => {
  await setup();
  const base = ["inbox", "my_questions", "open_dashboard", "whoami"];
  for (const [person, scopes, writes] of [
    [
      expert,
      ["expert"],
      [
        "comment",
        "raise_concern",
        "save_answer",
        "submit_answer",
        "upload_skill_version",
      ],
    ],
    [expert, ["operator"], []],
    [observer, ["expert"], []],
  ] as const) {
    const { client } = await connect(person, [...scopes]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [...base, ...writes].sort(),
    );
    expect(tools.every((t) => (t.description?.length ?? 0) > 10)).toBe(true);
  }
});

it("reads assigned work and sends only the expert's answers, comments, and concerns through the service", async () => {
  const { workflowId, versionId } = await setup();
  const context = { workflowId, versionId };
  const question = await publishQuestion(context);
  const { client, token } = await connect();
  const inbox = await call(client, "inbox");
  expect(inbox.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ questionId: question.questionId }),
    ]),
  );
  const questions = await call(client, "my_questions", context);
  expect(questions.questions).toEqual([
    expect.objectContaining({
      id: question.questionId,
      text: "How is the sample stored?",
      revision: 1,
      answer: null,
    }),
  ]);
  const args = {
    ...context,
    questionId: question.questionId,
    questionRevision: question.questionRevision,
  };
  expect(
    await call(client, "save_answer", {
      ...args,
      revision: 0,
      text: "Store at −80°C. 冷冻保存。",
    }),
  ).toMatchObject({
    answer: {
      revision: 1,
      state: "draft",
      channel: "mcp",
      agentHost: "Test Agent",
    },
  });
  expect(
    await call(client, "submit_answer", { ...args, revision: 1 }),
  ).toMatchObject({
    answers: [
      { revision: 2, state: "submitted", text: "Store at −80°C. 冷冻保存。" },
    ],
  });
  expect(
    await call(client, "comment", {
      ...context,
      questionId: question.questionId,
      text: "Which tube should we use?",
    }),
  ).toMatchObject({ comment: { text: "Which tube should we use?" } });
  expect(
    await call(client, "raise_concern", {
      ...context,
      text: "Avoid repeated freeze-thaw cycles.",
    }),
  ).toMatchObject({
    concern: { text: "Avoid repeated freeze-thaw cycles.", state: "open" },
  });
  const view = await service.request(`/api/v1${question.base}`, { as: admin });
  expect(await view.json()).toMatchObject({
    answers: [
      expect.objectContaining({
        revision: 2,
        channel: "mcp",
        agentHost: "Test Agent",
      }),
    ],
    comments: [expect.objectContaining({ text: "Which tube should we use?" })],
  });
  const activity = await service.request(
    "/api/v1/audit-events?action=answer.submitted",
    { as: admin },
  );
  expect(await activity.json()).toMatchObject({
    events: [
      expect.objectContaining({ credentialId: token.id, channel: "mcp" }),
    ],
  });
});

it("identifies the token owner through an in-memory MCP client", async () => {
  service = await startTestService({ mode: "local" });
  const response = await service.request("/api/v1/me/tokens", {
    method: "POST",
    headers: { "content-type": "application/json", origin: service.baseUrl },
    body: JSON.stringify({ name: "Expert Agent", scopes: ["expert"] }),
  });
  expect(response.status).toBe(201);
  const { secret } = (await response.json()) as { secret: string };
  const server = createExpertMcp({
    url: service.baseUrl,
    token: secret,
    agentHost: "Test Agent",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "Test Agent", version: "1.0.0" });
  clients.push(client);
  await client.connect(clientTransport);
  const result = await client.callTool({ name: "whoami", arguments: {} });
  expect(result.isError).not.toBe(true);
  expect(result.content).toEqual([
    expect.objectContaining({
      type: "text",
      text: expect.stringContaining('"kind":"token"'),
    }),
  ]);
  expect(client.getInstructions()).toContain("Submit only what the user said");
});
