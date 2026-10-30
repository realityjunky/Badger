import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBadgerMcp } from "../src/index.js";
import { createWorkflowRuntime } from "@realityjunky/badger/workflow-runtime";
import { assembledFixture } from "../../server/test/fixtures/evaluations.js";
import {
  admin,
  engineer,
  owner,
  startPlanningService,
} from "../../server/test/fixtures/planning.js";
let service: Awaited<ReturnType<typeof startPlanningService>>;
let client: Client;
let currentServer: ReturnType<typeof createBadgerMcp> | undefined;
let root: string;
afterEach(async () => {
  await client?.close();
  await currentServer?.close();
  await service?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});
async function value(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  let v = JSON.parse((result.content as { text: string }[])[0].text);
  if (v.localFile) v = JSON.parse(await fs.readFile(v.localFile, "utf8"));
  return v;
}
it("runs a verified publication through actual MCP tools and mirrors ordered events and fixed person/host identity", async () => {
  service = await startPlanningService();
  const f = await assembledFixture(service);
  const operator = { subject: "operator", email: "operator@example.com" };
  const reviewer = { subject: "reviewer", email: "reviewer@example.com" };
  for (const [person, role] of [
    [operator, "Operator"],
    [reviewer, "Reviewer"],
  ] as const)
    await f.call(
      "/bindings",
      "POST",
      {
        scopeType: "workflow",
        scopeId: f.workflow.id,
        email: person.email,
        role,
      },
      admin,
      201,
    );
  await f.call(
    `${f.base}/evaluations`,
    "POST",
    {
      confirmed: true,
      packageHash: f.assembled.packageHash,
      requestId: "operator-eval",
    },
    engineer,
    202,
  );
  await service.worker().runOnce();
  const evalView = await f.call(`${f.base}/evaluations`);
  expect(
    evalView.reports[0].report.passed,
    JSON.stringify(evalView.reports[0].report),
  ).toBe(true);
  for (const [action, person] of [
    ["approve", reviewer],
    ["publish", owner],
  ] as const) {
    const { preview } = await f.call(
      `${f.base}/review/${action}-preview`,
      "POST",
      {},
      person,
    );
    await f.call(
      `${f.base}/review/${action}`,
      "POST",
      {
        confirmed: true,
        confirmationHash: preview.confirmationHash,
        requestId: `operator-${action}`,
      },
      person,
    );
  }
  const { publications } = await f.call(
    `/workflows/${f.workflow.id}/publications`,
    "GET",
    undefined,
    operator,
  );
  const publication = publications[0];
  const { secret } = await f.call(
    "/me/tokens",
    "POST",
    { name: "Operator", scopes: ["operator"] },
    operator,
    201,
  );
  const server = createBadgerMcp({
    url: service.baseUrl,
    token: secret,
    agentHost: "Test Agent",
    profile: "operator",
  });
  currentServer = server;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  client = new Client({ name: "operator", version: "1" });
  await client.connect(a);
  const tools = (await client.listTools()).tools;
  expect(tools.map((t) => t.name)).toEqual(
    expect.arrayContaining([
      "start",
      "next",
      "submit",
      "status",
      "recover",
      "my_runs",
    ]),
  );
  expect(
    tools.find((t) => t.name === "submit")!.inputSchema.properties,
  ).not.toHaveProperty("reviewer");
  root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-mcp-runs-"));
  const identity = {
    workflowId: f.workflow.id,
    publicationId: publication.id,
    packageHash: publication.packageHash,
  };
  const requirements = await value("status", {
    ...identity,
    projectRoot: root,
    runId: "run-one",
  });
  expect(requirements.startRequirements).toEqual({ externalRoots: [] });
  const started = await value("start", {
    ...identity,
    projectRoot: root,
    runId: "run-one",
    hostLabel: "Lab workstation",
    confirmed: true,
  });
  expect(started.continuation.currentNode).toBe("report");
  expect(started.skillPath).toMatch(/report-report[\\/]SKILL\.md$/u);
  expect(started.continuation.completion).toBeTruthy();
  const runtime = createWorkflowRuntime();
  const location = {
    kind: "standalone" as const,
    projectRoot: root,
    runId: "run-one",
  };
  const next = await value("next", { projectRoot: root, runId: "run-one" });
  expect(next.continuation).toEqual(await runtime.inspect(location));
  const human = await client.callTool({
    name: "submit",
    arguments: {
      projectRoot: root,
      runId: "run-one",
      submission: {
        kind: "decision",
        reviewer: { subject: "forged", authorities: ["owner"] },
      },
    },
  });
  expect(human.isError).toBe(true);
  const current = next.continuation;
  const submission = {
    actionId: current.pendingAction.id,
    revision: current.revision,
    runId: current.runId,
    nodeId: current.currentNode,
    execution: current.execution,
    status: "succeeded",
    summary: "Report prepared.",
    evidence: { summary: "Reviewed the report." },
  };
  const done = await value("submit", {
    projectRoot: root,
    runId: "run-one",
    submission,
  });
  expect(done.continuation.disposition).toBe("done");
  for (let attempt = 0; attempt < 30; attempt++) {
    const my = await value("my_runs");
    if (my.runs[0]?.projection?.status === "completed") break;
    await new Promise((r) => setTimeout(r, 30));
  }
  const { runs } = await value("my_runs");
  expect(
    runs,
    JSON.stringify({
      status: await value("status", { projectRoot: root, runId: "run-one" }),
      logs: service.logs.filter((v: any) => v.level === "error"),
    }),
  ).toHaveLength(1);
  expect(runs[0]).toMatchObject({
    hostLabel: "Lab workstation",
    agentHost: "Test Agent",
    packageHash: publication.packageHash,
    publicationId: publication.id,
    projection: { status: "completed", currentNode: null },
  });
  const detail = await f.call(
    `/runs/${runs[0].id}`,
    "GET",
    undefined,
    operator,
  );
  const report = (await runtime.readReport(location))!;
  expect(detail.run.events).toEqual(report.events);
  expect(detail.run.projection).toEqual(report.projection);
  expect(detail.run.events.map((e: any) => e.sequence)).toEqual(
    report.events.map((e) => e.sequence),
  );
  expect(
    (
      await f.call(
        `/workflows/${f.workflow.id}/runs`,
        "GET",
        undefined,
        operator,
      )
    ).runs,
  ).toHaveLength(1);
}, 60_000);

it("forwards external-root requirements/refusals, keeps local progress during an outage, and reconciles a lost queue from kernel events", async () => {
  const { publishedFixture, receiptPlan, operator } =
    await import("../../server/test/fixtures/runs.js");
  service = await startPlanningService();
  const f = await publishedFixture(service, receiptPlan);
  const connect = async (
    token = f.operatorToken,
    agentHost = "Receipt Agent",
  ) => {
    const server = createBadgerMcp({
      url: service.baseUrl,
      token,
      agentHost,
      profile: "operator",
    });
    currentServer = server;
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    client = new Client({ name: "receipts", version: "1" });
    await client.connect(a);
  };
  await connect();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-mcp-receipts-"));
  const external = path.join(root, "outputs");
  await fs.mkdir(external);
  const args = {
    workflowId: f.workflow.id,
    publicationId: f.publication.id,
    packageHash: f.publication.packageHash,
    projectRoot: root,
    runId: "receipt-run",
    hostLabel: "Analysis server",
    confirmed: true,
  };
  const runtime = createWorkflowRuntime();
  const protocol = JSON.parse(
    Buffer.from(
      (
        await f.call(
          `/workflows/${f.workflow.id}/publications/${f.publication.id}/package`,
        )
      ).snapshot.files.find(
        (file: any) => file.path === "reference/workflow-protocol.json",
      ).content,
      "base64",
    ).toString("utf8"),
  );
  const before = await value("status", {
    projectRoot: root,
    runId: args.runId,
    ...{
      workflowId: args.workflowId,
      publicationId: args.publicationId,
      packageHash: args.packageHash,
    },
  });
  await expect(fs.stat(path.join(root, ".badger"))).rejects.toThrow();
  expect(before.startRequirements).toEqual(
    await runtime.startRequirements(protocol),
  );
  expect(before.startRequirements.externalRoots[0]).toMatchObject({
    name: "outputs",
    description: "The shared folder for analysis results.",
    artifacts: [{ nodeId: "report", artifactId: "report.v1.result" }],
  });
  const refused = await client.callTool({ name: "start", arguments: args });
  expect(refused.isError).toBe(true);
  expect((refused.content as { text: string }[])[0].text).toBe(
    "Workflow artifact external root outputs needs a directory when the Run starts: The shared folder for analysis results.",
  );
  expect(
    (
      await f.call(
        `/workflows/${f.workflow.id}/runs`,
        "GET",
        undefined,
        operator,
      )
    ).runs,
  ).toEqual([]);
  await expect(
    fs.stat(path.join(root, ".badger/runs", args.runId)),
  ).rejects.toThrow();
  const started = await value("start", {
    ...args,
    externalRoots: { outputs: external },
  });
  expect(started.continuation.receiptOutputs[0].root).toEqual({
    name: "outputs",
    path: external,
  });
  const current = started.continuation;
  const submission = {
    actionId: current.pendingAction.id,
    revision: current.revision,
    execution: current.execution,
    runId: current.runId,
    nodeId: current.currentNode,
    status: "succeeded",
    summary: "Produced report.",
    evidence: { summary: "Reviewed synthetic output." },
  };
  for (const forbidden of [
    {
      kind: "decision",
      reviewer: { subject: "forged", authorities: ["owner"] },
    },
    { repairDecision: { outcome: "retry", override: true } },
    { finalization: { confirmed: true } },
    {
      verification: {
        kind: "manual-evidence",
        status: "passed",
        verifierSubject: "forged",
      },
    },
  ]) {
    const reply = await client.callTool({
      name: "submit",
      arguments: {
        projectRoot: root,
        runId: args.runId,
        submission: { ...submission, ...forbidden },
      },
    });
    expect(reply.isError, JSON.stringify(reply)).toBe(true);
  }
  for (const name of ["next", "status", "submit", "recover"]) {
    const reply = await client.callTool({
      name,
      arguments: {
        projectRoot: root,
        runId: args.runId,
        externalRoots: { outputs: external },
        ...(name === "submit" ? { submission } : {}),
      },
    });
    expect(reply.isError).toBe(true);
  }
  const missing = await value("submit", {
    projectRoot: root,
    runId: args.runId,
    submission,
  });
  expect(missing.continuation.blockers.join("; ")).toContain(
    "Missing Output Schema artifacts",
  );
  await fs.writeFile(
    path.join(external, "result.bin"),
    "Synthetic report output.",
  );
  const originalFetch = globalThis.fetch;
  let outage = true;
  globalThis.fetch = (async (input, init) => {
    if (outage && String(input).startsWith(service.baseUrl))
      throw new TypeError("Simulated outage");
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    const done = await value("submit", {
      projectRoot: root,
      runId: args.runId,
      submission,
    });
    expect(done.continuation.disposition).toBe("done");
    expect(
      done.continuation.visits[0].outcomes[0].evidence.artifactReceipts[0].root,
    ).toEqual({ name: "outputs", path: external });
    expect(
      done.continuation.visits[0].outcomes[0].evidence.artifactReceipts[0]
        .producer.attemptId,
    ).toBe(current.attemptId);
    await client.close();
    await currentServer?.close();
  } finally {
    outage = false;
    globalThis.fetch = originalFetch;
  }
  const queueFile = path.join(
    root,
    ".badger/runs",
    args.runId,
    ".badger/mcp-queue.json",
  );
  await fs.unlink(queueFile); // Crash window: local commit exists, queue write was lost.
  await connect();
  await value("status", { projectRoot: root, runId: args.runId });
  let mirrored: any;
  for (let attempt = 0; attempt < 30; attempt++) {
    const my = await value("my_runs");
    mirrored = my.runs[0];
    if (mirrored?.projection?.status === "completed") break;
    await new Promise((r) => setTimeout(r, 40));
  }
  expect(mirrored?.projection.status).toBe("completed");
  const detail = await f.call(
    `/runs/${mirrored.id}`,
    "GET",
    undefined,
    operator,
  );
  expect(detail.run.events).toEqual(
    (await runtime.readReport({
      kind: "standalone",
      projectRoot: root,
      runId: args.runId,
    }))!.events,
  );
  expect(
    detail.run.projection.visits[0].outcomes[0].evidence.artifactReceipts[0],
  ).toMatchObject({
    root: { name: "outputs", path: external },
    producer: { attemptId: current.attemptId },
  });
  const queue = JSON.parse(await fs.readFile(queueFile, "utf8"));
  expect(queue.identity).not.toHaveProperty("token");
  expect(await fs.readFile(queueFile, "utf8")).not.toContain(f.operatorToken);
  // A queue redirected outside the Run root cannot be used or overwritten.
  await client.close();
  await currentServer?.close();
  const decoy = path.join(root, "decoy.json");
  await fs.writeFile(decoy, "untouched");
  await fs.unlink(queueFile);
  await fs.symlink(decoy, queueFile);
  await connect();
  const unsafe = await client.callTool({
    name: "status",
    arguments: { projectRoot: root, runId: args.runId },
  });
  expect(unsafe.isError, JSON.stringify(unsafe)).toBe(true);
  expect(await fs.readFile(decoy, "utf8")).toBe("untouched");
}, 60_000);
