import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ElicitRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
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

/** Publishes one round with a question per entry, assigned to Field experts. */
async function publishQuestions(
  context: { workflowId: string; versionId: string },
  contents: { text?: string; answerType?: unknown }[],
) {
  await service.request("/api/v1/me", { as: expert });
  const base = `/workflows/${context.workflowId}/versions/${context.versionId}/questionnaire`;
  const { round } = await write("POST", `${base}/rounds`, {
    title: "Sample handling",
  });
  const questions = [];
  for (const { text = "How is the sample stored?", answerType } of contents) {
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
        ...(answerType === undefined ? {} : { answerType }),
      },
    );
    questions.push({
      questionId: question.id as string,
      questionRevision: question.revision as number,
    });
  }
  const previewed = await service.request(
    `/api/v1${base}/rounds/${round.id}/publish-preview`,
    { as: admin },
  );
  const { preview } = await previewed.json();
  await write("POST", `${base}/rounds/${round.id}/publish`, {
    confirmed: true,
    confirmationHash: preview.confirmationHash,
  });
  return { base, questions };
}

async function publishQuestion(
  context: { workflowId: string; versionId: string },
  text = "How is the sample stored?",
) {
  const { base, questions } = await publishQuestions(context, [{ text }]);
  return { ...questions[0]!, base };
}
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await service?.close();
  for (const folder of folders.splice(0))
    await fs.rm(folder, { recursive: true, force: true });
});

it("receives server answer instructions with the assignee's current revisions before saving their words", async () => {
  const { workflowId, versionId } = await setup();
  const context = { workflowId, versionId };
  const question = await publishQuestion(context);
  const { client } = await connect();
  const response = await call(client, "answer_context", {
    ...context,
    questionId: question.questionId,
  });
  const assistance = response.localFile
    ? JSON.parse(await fs.readFile(response.localFile, "utf8"))
    : response;
  expect(assistance).toMatchObject({
    answerRevision: 0,
    questionRevision: question.questionRevision,
    answer: null,
  });
  expect(assistance.prompt).toContain("never infer their answer");
  const saved = await call(client, "save_answer", {
    ...context,
    questionId: question.questionId,
    questionRevision: assistance.questionRevision,
    revision: assistance.answerRevision,
    text: "The sample stays frozen.",
  });
  expect(saved.answer).toMatchObject({
    state: "draft",
    text: "The sample stays frozen.",
  });
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

it("refuses a nested .git folder in every spelling the service refuses, before opening any local file or making an upload request", async () => {
  const { groupId } = await setup();
  const { skill } = await write("POST", "/skills", {
    groupId,
    name: "safe-upload",
  });
  const { client } = await connect();
  // Refresh permission discovery before observing these upload operations.
  await client.listTools();
  // Letter case, the trailing dots and spaces Windows trims, and the code
  // points HFS+ ignores.
  for (const name of [".git", ".GIT.", ".Git ", ".g\u200cit", ".gi\ufefft"]) {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "badger-mcp-git-"));
    folders.push(folder);
    await fs.writeFile(
      path.join(folder, "SKILL.md"),
      "---\nname: safe-upload\ndescription: Safe upload.\n---\n",
    );
    await fs.mkdir(path.join(folder, "z-repository", name), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(folder, "z-repository", name, "config"),
      "private history",
    );
    const opened = vi.spyOn(fs, "open");
    const requests = vi.spyOn(globalThis, "fetch");
    try {
      const result = await client.callTool({
        name: "upload_skill_version",
        arguments: { skillId: skill.id, folder },
      });
      expect(result).toMatchObject({
        isError: true,
        content: [
          expect.objectContaining({
            text: expect.stringContaining(
              `Upload path "z-repository/${name}" contains a .git folder; upload the Skill without its .git folder, for example from git archive output`,
            ),
          }),
        ],
      });
      expect(
        opened.mock.calls.filter(([target]) =>
          String(target).startsWith(`${folder}${path.sep}`),
        ),
      ).toEqual([]);
      expect(requests).not.toHaveBeenCalled();
    } finally {
      opened.mockRestore();
      requests.mockRestore();
    }
  }
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
  // The Agent learns the error kind and the revision to reload.
  expect(stale).toMatchObject({
    isError: true,
    content: [
      expect.objectContaining({
        text: expect.stringMatching(
          /^Badger 409 conflict: .+ \(currentRevision: 1\)$/u,
        ),
      }),
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
        "answer_context",
        "comment",
        "raise_concern",
        "save_answer",
        "save_suggestion_review",
        "submit_answer",
        "suggestion_review_context",
        "upload_attachment",
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

it("saves and submits every answer type, including an uploaded attachment, through the service's contract", async () => {
  const { workflowId, versionId } = await setup();
  const context = { workflowId, versionId };
  const cases: [unknown, Record<string, unknown>, unknown][] = [
    [{ kind: "free-text" }, { text: "Store at −80°C. 冷冻保存。" }, null],
    [
      { kind: "single-choice", options: ["Cold", "Frozen"] },
      { value: "Frozen" },
      "Frozen",
    ],
    [
      { kind: "multiple-choice", options: ["Cold", "Frozen"] },
      { value: ["Cold", "Frozen"] },
      ["Cold", "Frozen"],
    ],
    [{ kind: "yes-no" }, { value: false }, false],
    [{ kind: "number", unit: "°C" }, { value: -80 }, -80],
    [
      { kind: "table", columns: ["Sample", "Storage"] },
      { value: [["Plasma", "Frozen"]] },
      [["Plasma", "Frozen"]],
    ],
    [{ kind: "file" }, {}, null],
  ];
  const { base, questions } = await publishQuestions(
    context,
    cases.map(([answerType]) => ({ answerType })),
  );
  const { client } = await connect();
  const folder = await fs.mkdtemp(
    path.join(os.tmpdir(), "badger-mcp-attachment-"),
  );
  folders.push(folder);
  const csv = "sample,storage\nexample,frozen\n";
  const file = path.join(folder, "storage.csv");
  await fs.writeFile(file, csv);
  const fileQuestion = { ...context, ...questions.at(-1)! };
  const { attachment } = await call(client, "upload_attachment", {
    ...fileQuestion,
    file,
  });
  expect(attachment).toMatchObject({
    name: "storage.csv",
    mediaType: "text/csv",
    size: Buffer.byteLength(csv),
    hash: createHash("sha256").update(csv).digest("hex"),
  });
  const expected: Record<string, unknown> = {};
  for (const [index, [, payload, value]] of cases.entries()) {
    const question = { ...context, ...questions[index]! };
    const files =
      index === cases.length - 1 ? { attachments: [attachment.id] } : {};
    expect(
      await call(client, "save_answer", {
        ...question,
        revision: 0,
        ...payload,
        ...files,
      }),
    ).toMatchObject({ answer: { revision: 1, state: "draft", value } });
    await call(client, "submit_answer", { ...question, revision: 1 });
    expected[question.questionId] = {
      state: "submitted",
      channel: "mcp",
      value,
      attachments: index === cases.length - 1 ? [attachment] : [],
    };
  }
  const view = await (
    await service.request(`/api/v1${base}`, { as: admin })
  ).json();
  expect(
    Object.fromEntries(
      view.answers.map(
        (answer: {
          questionId: string;
          state: string;
          channel: string;
          value: unknown;
          attachments: unknown[];
        }) => [
          answer.questionId,
          {
            state: answer.state,
            channel: answer.channel,
            value: answer.value,
            attachments: answer.attachments,
          },
        ],
      ),
    ),
  ).toEqual(expected);
  const download = await service.request(
    `/api/v1${base}/attachments/${attachment.id}`,
    { as: admin },
  );
  expect(await download.text()).toBe(csv);
});

it("checks attachment assignment, revision, type, and size locally and sends nothing it refuses", async () => {
  const { workflowId, versionId } = await setup();
  const { questions } = await publishQuestions({ workflowId, versionId }, [
    { answerType: { kind: "file" } },
  ]);
  const question = { workflowId, versionId, ...questions[0]! };
  const folder = await fs.mkdtemp(
    path.join(os.tmpdir(), "badger-mcp-refused-"),
  );
  folders.push(folder);
  const local = (name: string) => path.join(folder, name);
  await fs.writeFile(local("large.txt"), Buffer.alloc(5 * 1024 * 1024 + 1, 65));
  await fs.writeFile(local("page.html"), "<p>Example</p>");
  await fs.writeFile(local("notes.bin"), "Example");
  await fs.writeFile(local("empty.txt"), "");
  await fs.writeFile(local("image.png"), "Not an image");
  await fs.symlink(local("page.html"), local("linked.txt"));
  const { client } = await connect();
  for (const [args, message] of [
    [{ file: local("large.txt") }, /limited to 5242880 bytes/u],
    [{ file: local("page.html") }, /allowed type/u],
    [{ file: local("notes.bin") }, /allowed type/u],
    [{ file: local("notes.bin"), mediaType: "text/html" }, /allowed type/u],
    [{ file: local("empty.txt") }, /nonempty/u],
    [{ file: local("linked.txt") }, /symbolic links/u],
    [
      {
        file: local("notes.bin"),
        mediaType: "text/plain",
        questionRevision: 2,
      },
      /currentRevision: 1/u,
    ],
  ] as const) {
    const refused = await client.callTool({
      name: "upload_attachment",
      arguments: { ...question, ...args },
    });
    expect(refused).toMatchObject({
      isError: true,
      content: [
        expect.objectContaining({ text: expect.stringMatching(message) }),
      ],
    });
  }
  const { client: observing } = await connect(observer);
  const hidden = await observing.callTool({
    name: "upload_attachment",
    arguments: {
      ...question,
      file: local("notes.bin"),
      mediaType: "text/plain",
    },
  });
  expect(hidden.isError).toBe(true);
  // The service still validates content against the declared type.
  const mislabeled = await client.callTool({
    name: "upload_attachment",
    arguments: { ...question, file: local("image.png") },
  });
  expect(mislabeled).toMatchObject({
    isError: true,
    content: [
      expect.objectContaining({ text: expect.stringMatching(/^Badger 400 /u) }),
    ],
  });
  const activity = await service.request(
    "/api/v1/audit-events?action=answer.attachment-uploaded",
    { as: admin },
  );
  expect((await activity.json()).events).toEqual([]);
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

it("refuses an Agent host that cannot travel as a header, naming only the setting", () => {
  for (const agentHost of ["张三的电脑", "", " ", "x".repeat(201), "lab\nhost"])
    expect(() =>
      createExpertMcp({
        url: "https://badger.example",
        token: "secret",
        agentHost,
      }),
    ).toThrow("BADGER_AGENT_HOST must be 1 to 200 printable ASCII characters");
  expect(() =>
    createExpertMcp({
      url: "https://badger.example",
      token: "secret",
      agentHost: "lab-workbuddy",
    }),
  ).not.toThrow();
});

it("reuses a recent capability read for calls and announces a changed tool list", async () => {
  const { workflowId, versionId, expertBinding } = await setup();
  const { questionId, questionRevision } = await publishQuestion({
    workflowId,
    versionId,
  });
  const { client, token } = await connect();
  const changed: unknown[] = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, (note) => {
    changed.push(note);
  });
  await client.listTools();
  for (let attempt = 0; attempt < 3; attempt += 1)
    expect(
      (await client.callTool({ name: "whoami", arguments: {} })).isError,
    ).not.toBe(true);
  const activity = await service.request(
    "/api/v1/audit-events?action=token.used&limit=100",
    { as: admin },
  );
  const { events } = (await activity.json()) as {
    events: { credentialId: string }[];
  };
  // One capability read for the list, then one request per call.
  expect(
    events.filter((event) => event.credentialId === token.id),
  ).toHaveLength(4);
  await write("DELETE", `/bindings/${expertBinding.id}`, {
    revision: expertBinding.revision,
  });
  // The recent read still lists save_answer; the service refuses the call,
  // and the fresh read that follows announces the shorter list.
  const refused = await client.callTool({
    name: "save_answer",
    arguments: {
      workflowId,
      versionId,
      questionId,
      questionRevision,
      revision: 0,
      text: "Keep frozen.",
    },
  });
  expect(refused.isError).toBe(true);
  await expect.poll(() => changed.length).toBe(1);
  expect(
    (await client.listTools()).tools.map((tool) => tool.name),
  ).not.toContain("save_answer");
});

it("refuses a redirect so the token never follows it to another host", async () => {
  const redirecting = http.createServer((_request, response) => {
    response.writeHead(302, { location: "https://elsewhere.example/" });
    response.end();
  });
  await new Promise<void>((resolve) =>
    redirecting.listen(0, "127.0.0.1", resolve),
  );
  try {
    const { port } = redirecting.address() as { port: number };
    const server = createExpertMcp({
      url: `http://127.0.0.1:${port}/team`,
      token: "secret-token",
      agentHost: "lab-workbuddy",
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: "Test Agent", version: "1.0.0" });
    clients.push(client);
    await client.connect(a);
    const result = await client.callTool({ name: "whoami", arguments: {} });
    expect(result.isError).toBe(true);
    const [content] = result.content as { text: string }[];
    expect(content.text).toContain("redirect");
    expect(content.text).not.toContain("secret-token");
  } finally {
    redirecting.close();
  }
});
