import { afterEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  startTestService,
  type TestService,
} from "@realityjunky/badger-server/testing";
import { createEngineerMcp } from "../src/index.js";

let service: TestService;
const clients: Client[] = [];
const folders: string[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const folder of folders.splice(0))
    await fs.rm(folder, { recursive: true, force: true });
  await service?.close();
});
async function request(route: string, method = "GET", body?: unknown) {
  const response = await service.request(`/api/v1${route}`, {
    method,
    headers: { origin: service.baseUrl, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  expect(response.ok, JSON.stringify(value)).toBe(true);
  return value;
}
async function connect(scopes = ["engineer"]) {
  const { secret } = await request("/me/tokens", "POST", {
    name: "Engineer Agent",
    scopes,
  });
  const server = createEngineerMcp({
    url: service.baseUrl,
    token: secret,
    agentHost: "Engineer Agent",
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "Engineer Agent", version: "1" });
  clients.push(client);
  await client.connect(a);
  return client;
}
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const response = await client.callTool({ name, arguments: args });
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  return JSON.parse((response.content as { text: string }[])[0].text);
}

it("offers the engineer profile and hands a claimed job's context and exact pinned files to a private local folder", async () => {
  service = await startTestService({ mode: "local" });
  const { group } = await request("/groups", "POST", { name: "Research" });
  const { workflow, version } = await request("/workflows", "POST", {
    groupId: group.id,
    name: "engineer-work",
    goal: "Draft questions",
    intent: "new-skill",
    locale: "en",
  });
  const context = { workflowId: workflow.id, versionId: version.id };
  const base = `/workflows/${workflow.id}/versions/${version.id}`;
  const { skill } = await request("/skills", "POST", {
    groupId: group.id,
    name: "storage",
  });
  const skillText =
    "---\nname: storage\ndescription: Storage guidance.\n---\n\n# Storage\nKeep samples cold.\n";
  const upload = {
    files: [
      { path: "SKILL.md", content: Buffer.from(skillText).toString("base64") },
    ],
    scripts: {},
  };
  const { preview } = await request(
    `/skills/${skill.id}/upload-preview`,
    "POST",
    upload,
  );
  await request(`/skills/${skill.id}/versions`, "POST", {
    ...upload,
    confirmed: true,
    expectedHash: preview.hash,
  });
  await request(`${base}/pins`, "POST", {
    skillId: skill.id,
    hash: preview.hash,
    purpose: "source",
  });
  const { round } = await request(`${base}/questionnaire/rounds`, "POST", {
    title: "Storage",
  });
  const { job } = await request(`${base}/drafting-jobs`, "POST", {
    kind: "draft-questions",
    roundId: round.id,
    confirmed: true,
  });
  const client = await connect();
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual(
    expect.arrayContaining([
      "whoami",
      "inbox",
      "list_jobs",
      "claim_job",
      "submit_job",
      "release_job",
      "questionnaire",
      "ledger",
      "readiness",
    ]),
  );
  expect((await client.listTools()).tools.map((t) => t.name)).not.toContain(
    "accept_job",
  );
  expect((await call(client, "list_jobs", context)).jobs).toEqual([
    expect.objectContaining({ id: job.id }),
  ]);
  const claimed = await call(client, "claim_job", {
    ...context,
    jobId: job.id,
    revision: job.revision,
  });
  folders.push(claimed.folder);
  expect(claimed).toMatchObject({
    kind: "draft-questions",
    roundId: round.id,
    parentQuestionId: null,
  });
  expect(
    JSON.parse(
      await fs.readFile(path.join(claimed.folder, "job.json"), "utf8"),
    ),
  ).toMatchObject({ id: job.id, kind: "draft-questions", roundId: round.id });
  if (process.platform !== "win32")
    expect((await fs.stat(claimed.folder)).mode & 0o777).toBe(0o700);
  const bundle = JSON.parse(
    await fs.readFile(path.join(claimed.folder, "context.json"), "utf8"),
  );
  expect(bundle.pins).toEqual([
    expect.objectContaining({ hash: preview.hash }),
  ]);
  expect(
    await fs.readFile(
      path.join(claimed.folder, "skills", skill.id, preview.hash, "SKILL.md"),
      "utf8",
    ),
  ).toBe(skillText);
  await fs.writeFile(
    path.join(claimed.folder, "result.json"),
    JSON.stringify({ questions: [] }),
  );
  expect(
    (
      await client.callTool({
        name: "submit_job",
        arguments: { ...context, jobId: job.id, folder: claimed.folder },
      })
    ).isError,
  ).toBe(true);
  const released = await call(client, "release_job", {
    ...context,
    jobId: job.id,
    folder: claimed.folder,
  });
  expect(released.job.status).toBe("queued");
  const next = await call(client, "claim_job", {
    ...context,
    jobId: job.id,
    revision: released.job.revision,
  });
  folders.push(next.folder);
  const result = {
    questions: [
      {
        text: "Which sample is used?",
        topic: "scope",
        targets: [{ kind: "workflow", id: workflow.id }],
        rationale: "Define the inputs.",
        evidence: [],
        assignees: [{ kind: "role", role: "Field expert" }],
        priority: 90,
      },
    ],
  };
  const resultFile = path.join(next.folder, "result.json");
  const sourceFile = path.join(next.folder, "suggestion.json");
  await fs.writeFile(sourceFile, JSON.stringify(result));
  await fs.symlink(sourceFile, resultFile);
  expect(
    (
      await client.callTool({
        name: "submit_job",
        arguments: { ...context, jobId: job.id, folder: next.folder },
      })
    ).isError,
  ).toBe(true);
  await fs.unlink(resultFile);
  await fs.writeFile(resultFile, JSON.stringify(result));
  const submitted = await call(client, "submit_job", {
    ...context,
    jobId: job.id,
    folder: next.folder,
  });
  expect(submitted.job.status).toBe("submitted");
  expect(submitted).toMatchObject({
    requiresPerson: true,
    dashboardUrl: `${service.baseUrl}/questionnaire?workflow=${workflow.id}&version=${version.id}&panel=suggestions`,
  });
  const dashboard = await call(client, "open_dashboard", {
    ...context,
    action: "review_suggestions",
  });
  expect(dashboard).toMatchObject({
    requiresPerson: true,
    url: submitted.dashboardUrl,
  });
  const suggestions = await request(`${base}/questionnaire`);
  expect(suggestions.suggestions).toEqual([
    expect.objectContaining({ id: job.id, result }),
  ]);
  expect(suggestions.questions).toEqual([]);
  expect((await call(client, "questionnaire", context)).questions).toEqual([]);
  expect(await call(client, "ledger", context)).toHaveProperty("handoff");
  expect(await call(client, "readiness", context)).toHaveProperty("readiness");
  await request(`${base}/pins/${skill.id}`, "DELETE", { revision: 1 });
  const cancelled = await request(`${base}/drafting-jobs/${job.id}`);
  expect(cancelled.job.status).toBe("cancelled");
  const expertScoped = await connect(["expert"]);
  expect(
    (await expertScoped.listTools()).tools.map((t) => t.name),
  ).not.toContain("claim_job");
});
