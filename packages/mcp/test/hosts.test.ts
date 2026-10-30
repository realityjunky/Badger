import { afterEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  startTestService,
  type TestService,
} from "@realityjunky/badger-server/testing";
import { createBadgerMcp } from "../src/index.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashDirectory } from "@realityjunky/badger";
// These fixtures contain only public HTTP actions and independent authored examples.
import { assembledFixture } from "../../server/test/fixtures/evaluations.js";
import {
  admin,
  engineer,
  owner,
  startPlanningService,
} from "../../server/test/fixtures/planning.js";
let service: TestService | Awaited<ReturnType<typeof startPlanningService>>;
let client: Client;
const folders: string[] = [];
afterEach(async () => {
  await client?.close();
  await service?.close();
  for (const folder of folders.splice(0))
    await fs.rm(folder, { recursive: true, force: true });
});
it("offers only published workflow installation tools to an Operator token and keeps human sign-off in the dashboard", async () => {
  service = await startTestService({ mode: "local" });
  const response = await service.request("/api/v1/me/tokens", {
    method: "POST",
    headers: { origin: service.baseUrl, "content-type": "application/json" },
    body: JSON.stringify({ name: "Local operator", scopes: ["operator"] }),
  });
  const { secret } = await response.json();
  const server = createBadgerMcp({
    url: service.baseUrl,
    token: secret,
    agentHost: "Test Operator",
    profile: "operator",
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  client = new Client({ name: "Operator", version: "1" });
  await client.connect(a);
  const names = (await client.listTools()).tools.map((t) => t.name);
  expect(names).toContain("list_published_workflows");
  expect(names).toContain("install_workflow");
  expect(names).toContain("uninstall_workflow");
  expect(names).not.toContain("claim_job");
  expect(names).not.toContain("submit_answer");
  expect(names).not.toContain("publish");
  const listed = await client.callTool({
    name: "list_published_workflows",
    arguments: {},
  });
  expect(listed.isError).not.toBe(true);
  expect(JSON.parse((listed.content as { text: string }[])[0].text)).toEqual({
    workflows: [],
  });
});

it("installs and removes a real service publication through the local MCP client after exact preview confirmation", async () => {
  service = await startPlanningService();
  const fixture = await assembledFixture(service);
  const reviewer = { subject: "reviewer", email: "reviewer@example.com" };
  const operator = { subject: "operator", email: "operator@example.com" };
  for (const [as, role] of [
    [reviewer, "Reviewer"],
    [operator, "Operator"],
  ] as const)
    await fixture.call(
      "/bindings",
      "POST",
      {
        scopeType: "workflow",
        scopeId: fixture.workflow.id,
        email: as.email,
        role,
      },
      admin,
      201,
    );
  await fixture.call(
    `${fixture.base}/evaluations`,
    "POST",
    {
      confirmed: true,
      packageHash: fixture.assembled.packageHash,
      requestId: "host-evaluate",
    },
    engineer,
    202,
  );
  await service.worker().runOnce();
  for (const [action, as] of [
    ["approve", reviewer],
    ["publish", owner],
  ] as const) {
    const { preview } = await fixture.call(
      `${fixture.base}/review/${action}-preview`,
      "POST",
      {},
      as,
    );
    await fixture.call(
      `${fixture.base}/review/${action}`,
      "POST",
      {
        confirmed: true,
        confirmationHash: preview.confirmationHash,
        requestId: `host-${action}`,
      },
      as,
    );
  }
  const { publications } = await fixture.call(
    `/workflows/${fixture.workflow.id}/publications`,
    "GET",
    undefined,
    operator,
  );
  const publication = publications[0];
  const { secret } = await fixture.call(
    "/me/tokens",
    "POST",
    { name: "Operator host", scopes: ["operator"] },
    operator,
    201,
  );
  const server = createBadgerMcp({
    url: service.baseUrl,
    token: secret,
    agentHost: "Operator host",
    profile: "operator",
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  client = new Client({ name: "Operator", version: "1" });
  await client.connect(a);
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "badger-mcp-host-test-"),
  );
  folders.push(root);
  const projectRoot = path.join(root, "project");
  const homeRoot = path.join(root, "home");
  await fs.mkdir(projectRoot);
  await fs.mkdir(homeRoot);
  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    let value = JSON.parse((result.content as { text: string }[])[0].text);
    if (value.localFile)
      value = JSON.parse(await fs.readFile(value.localFile, "utf8"));
    return value;
  }
  const listed = await call("list_published_workflows", {});
  expect(listed.workflows[0].publications[0].packageHash).toBe(
    publication.packageHash,
  );
  const args = {
    workflowId: fixture.workflow.id,
    publicationId: publication.id,
    packageHash: publication.packageHash,
    command: process.execPath,
    args: [path.resolve("dist/src/cli.js")],
    target: { host: "workbuddy", scope: "project", projectRoot, homeRoot },
  };
  const preview = await call("install_workflow", args);
  expect(preview.requiresLocalConfirmation).toBe(true);
  expect((await fs.stat(preview.previewFile)).mode & 0o777).toBe(0o600);
  await expect(fs.stat(preview.preview.packageDirectory)).rejects.toThrow();
  const refused = await client.callTool({
    name: "install_workflow",
    arguments: {
      workflowId: fixture.workflow.id,
      previewId: preview.previewId,
      digest: "0".repeat(64),
      confirmed: true,
    },
  });
  expect(refused.isError).toBe(true);
  await call("install_workflow", {
    workflowId: fixture.workflow.id,
    previewId: preview.previewId,
    digest: preview.preview.digest,
    confirmed: true,
  });
  expect(await hashDirectory(preview.preview.packageDirectory)).toBe(
    publication.packageHash,
  );
  const config = await fs.readFile(path.join(projectRoot, ".mcp.json"), "utf8");
  expect(JSON.parse(config).mcpServers.badger).toMatchObject({
    command: process.execPath,
    args: [path.resolve("dist/src/cli.js")],
  });
  expect(config).toContain("${BADGER_TOKEN}");
  expect(config).not.toContain(secret);
  const removal = await call("uninstall_workflow", {
    workflowId: fixture.workflow.id,
    target: args.target,
  });
  await call("uninstall_workflow", {
    workflowId: fixture.workflow.id,
    previewId: removal.previewId,
    digest: removal.preview.digest,
    confirmed: true,
  });
  await expect(fs.stat(preview.preview.packageDirectory)).rejects.toThrow();
  const uncommitted = await call("install_workflow", args);
  await client.close();
  await expect(fs.stat(uncommitted.previewFile)).rejects.toThrow();
  expect(
    (
      await fixture.call(
        `/workflows/${fixture.workflow.id}/publications`,
        "GET",
        undefined,
        operator,
      )
    ).publications,
  ).toHaveLength(1);
}, 60_000);
