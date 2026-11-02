import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createWorkflowRuntime } from "@realityjunky/badger/workflow-runtime";
import { createBadgerMcp } from "../src/index.js";
import {
  admin,
  startPlanningService,
} from "../../server/test/fixtures/planning.js";
import {
  durableGatePlan,
  operator,
  publishedFixture,
} from "../../server/test/fixtures/runs.js";

let service: Awaited<ReturnType<typeof startPlanningService>>;
let root: string;
const clients: Client[] = [];
const servers: ReturnType<typeof createBadgerMcp>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await service?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  const reply = await client.callTool({ name, arguments: args });
  expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
  const value = JSON.parse((reply.content as { text: string }[])[0].text);
  return value.localFile
    ? JSON.parse(await fs.readFile(value.localFile, "utf8"))
    : value;
}

it("keeps events when a snapshot is refused, exposes its bound, and resends the full stream after a service restore", async () => {
  service = await startPlanningService();
  const f = await publishedFixture(service);
  root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-reporting-"));
  let rejectSnapshot = true;
  let restored = false;
  const restoredEvents: { sequence: number }[] = [];
  const gaps: number[] = [];
  const connect = async () => {
    const server = createBadgerMcp({
      url: service.baseUrl,
      token: f.operatorToken,
      agentHost: "Planning Agent",
      profile: "operator",
      fetch: async (url, init) => {
        if (init.method === "POST" && /\/runs\/[^/]+$/u.test(url) && restored)
          return Response.json({
            run: { lastSequence: restoredEvents.length },
          });
        if (init.method === "POST" && url.endsWith("/events")) {
          const body = JSON.parse(String(init.body));
          if (restored) {
            for (const event of body.events) {
              if (event.sequence > restoredEvents.length + 1) {
                gaps.push(event.sequence);
                return Response.json(
                  { error: { message: "Event sequence gap" } },
                  { status: 409 },
                );
              }
              if (event.sequence === restoredEvents.length + 1)
                restoredEvents.push(event);
            }
            return Response.json({ lastSequence: restoredEvents.length });
          }
          if (rejectSnapshot && body.projection) {
            body.projection.evidence = {
              oversized: { text: "x".repeat(1024 * 1024) },
            };
            return fetch(url, { ...init, body: JSON.stringify(body) });
          }
        }
        return fetch(url, init);
      },
    });
    servers.push(server);
    const client = new Client({ name: "reporting", version: "1" });
    clients.push(client);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    return client;
  };
  const client = await connect();
  const args = { projectRoot: root, runId: "reporting" };
  const started = await call(client, "start", {
    ...args,
    workflowId: f.workflow.id,
    publicationId: f.publication.id,
    packageHash: f.publication.packageHash,
    hostLabel: "Lab",
    confirmed: true,
  });
  const route = `/runs/${started.runUrl.split("/").at(-1)}`;
  const read = async () =>
    (await f.call(route, "GET", undefined, operator)).run;
  const report = (await createWorkflowRuntime().readReport({
    kind: "standalone",
    ...args,
  }))!;
  await expect
    .poll(async () => (await read()).lastSequence)
    .toBe(report.lastSequence);
  expect((await read()).projection).toBeNull();
  expect((await call(client, "status", args)).reporting.error).toContain(
    "maxBytes (1048576)",
  );
  rejectSnapshot = false;
  await call(client, "status", args);
  await expect.poll(async () => (await read()).projection).not.toBeNull();
  await client.close();
  await servers[0]!.close();
  restored = true;
  const reconnected = await connect();
  await call(reconnected, "status", args);
  await expect.poll(() => restoredEvents.length).toBe(report.lastSequence);
  expect(restoredEvents).toEqual(report.events);
  expect(gaps).toEqual([]);
  expect((await call(reconnected, "status", args)).reporting.error).toBeNull();
}, 90_000);

it("reports a finalization interrupted by a script while reporting and settles its new notice after external recovery", async () => {
  service = await startPlanningService();
  const f = await publishedFixture(service, (plan) => {
    durableGatePlan(plan);
    plan.workflow.finalization.confirmation.reviewer.authorities = ["operator"];
    const durability = plan.workflow.capabilities.durability;
    durability.capabilities = durability.capabilities.filter(
      (capability: string) => capability !== "repair-policy",
    );
    delete durability.repair;
  });
  root = await fs.mkdtemp(
    path.join(os.tmpdir(), "badger-inflight-finalization-"),
  );
  const args = { projectRoot: root, runId: "finalizing" };
  const target = { kind: "standalone" as const, ...args };
  const runtime = createWorkflowRuntime();
  let inject = false;
  let route = "";
  const connect = async () => {
    const server = createBadgerMcp({
      url: service.baseUrl,
      token: f.operatorToken,
      agentHost: "Planning Agent",
      profile: "operator",
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (inject && init.method === "POST" && /\/runs\/[^/]+$/u.test(url)) {
          inject = false;
          const current = (await runtime.inspect(target))!;
          await runtime.submit(target, {
            actionId: current.pendingAction!.id,
            runId: current.runId,
            revision: current.revision,
            execution: current.execution,
            nodeId: current.currentNode,
            status: "succeeded",
            summary: "Prepared by the local script.",
            evidence: { summary: "Checked the report." },
          });
          await f.call(
            `${route}/events`,
            "POST",
            await runtime.readReport(target),
            operator,
            200,
            f.operatorToken,
          );
          const { gates } = await f.call(
            `${route}/gates`,
            "GET",
            undefined,
            operator,
          );
          const gate = gates.find(
            (gate: { state: string }) => gate.state === "open",
          );
          const answer = {
            choiceId: "confirm",
            rationale: "Reviewed the exact finalization.",
          };
          const { preview } = await f.call(
            `${route}/gates/${gate.id}/preview`,
            "POST",
            answer,
            operator,
          );
          await f.call(
            `${route}/gates/${gate.id}/answer`,
            "POST",
            {
              ...answer,
              confirmed: true,
              confirmationHash: preview.confirmationHash,
              requestId: "external-finalization",
            },
            operator,
          );
          const { answer: accepted } = await f.call(
            `${route}/gate-answer`,
            "GET",
            undefined,
            operator,
            200,
            f.operatorToken,
          );
          const originalRename = fs.rename;
          let transactionWrites = 0;
          const crash = vi
            .spyOn(fs, "rename")
            .mockImplementation(async (from, to) => {
              if (
                String(to).endsWith("/.badger/finalization/transaction.json") &&
                ++transactionWrites === 2
              )
                throw new Error("Script interrupted finalization");
              return originalRename(from, to);
            });
          try {
            await expect(
              runtime.submit(target, accepted.submission),
            ).rejects.toThrow("Script interrupted finalization");
          } finally {
            crash.mockRestore();
          }
        }
        return response;
      },
    });
    servers.push(server);
    const client = new Client({ name: "finalization-report", version: "1" });
    clients.push(client);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    return client;
  };
  const first = await connect();
  const started = await call(first, "start", {
    ...args,
    workflowId: f.workflow.id,
    publicationId: f.publication.id,
    packageHash: f.publication.packageHash,
    hostLabel: "Lab",
    confirmed: true,
  });
  route = `/runs/${started.runUrl.split("/").at(-1)}`;
  const read = async () =>
    (await f.call(route, "GET", undefined, operator)).run;
  await expect.poll(async () => (await read()).lastSequence).toBeGreaterThan(0);
  await first.close();
  await servers[0]!.close();
  // A settled earlier notice must not become the identity of this interruption.
  await f.call(
    `${route}/recovery`,
    "POST",
    { required: true, requestId: "earlier-notice" },
    operator,
    200,
    f.operatorToken,
  );
  await f.call(
    `${route}/events`,
    "POST",
    {
      ...(await runtime.readReport(target)),
      settledNoticeId: "earlier-notice",
    },
    operator,
    200,
    f.operatorToken,
  );
  inject = true;
  const second = await connect();
  await call(second, "next", args);
  await expect
    .poll(async () => (await runtime.inspect(target))?.finalizationPending)
    .toBeTruthy();
  await expect
    .poll(async () => (await read()).continuation?.finalizationPending)
    .toBeTruthy();
  expect((await read()).needsRecovery).toBe(true);
  const recoveryFile = path.join(
    root,
    ".badger/runs/finalizing/.badger/mcp-recovery.json",
  );
  expect(JSON.parse(await fs.readFile(recoveryFile, "utf8")).noticeId).not.toBe(
    "earlier-notice",
  );
  await runtime.recover(target);
  await call(second, "next", args);
  await expect.poll(async () => (await read()).needsRecovery).toBe(false);
  expect((await read()).continuation.finalizationPending).toBeUndefined();
}, 240_000);

it("serializes reporting and recovery from two MCP processes on one Run root and names a stale queue lock", async () => {
  service = await startPlanningService();
  const f = await publishedFixture(service);
  root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-queue-processes-"));
  const connect = async () => {
    const client = new Client({ name: "queue-process", version: "1" });
    clients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve("dist/src/cli.js")],
        env: {
          BADGER_URL: service.baseUrl,
          BADGER_TOKEN: f.operatorToken,
          BADGER_AGENT_HOST: "Planning Agent",
          BADGER_MCP_PROFILE: "operator",
        },
      }),
    );
    return client;
  };
  const first = await connect();
  const args = { projectRoot: root, runId: "shared" };
  const started = await call(first, "start", {
    ...args,
    workflowId: f.workflow.id,
    publicationId: f.publication.id,
    packageHash: f.publication.packageHash,
    hostLabel: "Lab",
    confirmed: true,
  });
  const second = await connect();
  const route = `/runs/${started.runUrl.split("/").at(-1)}`;
  await Promise.all([
    call(first, "status", args),
    call(second, "recover", args),
  ]);
  await Promise.all([
    call(second, "status", args),
    call(first, "recover", args),
  ]);
  const recoveryFile = path.join(
    root,
    ".badger/runs/shared/.badger/mcp-recovery.json",
  );
  await expect
    .poll(
      async () =>
        (
          await f.call(
            "/audit-events?action=run.recovered",
            "GET",
            undefined,
            admin,
          )
        ).events.length,
    )
    .toBe(2);
  await expect
    .poll(
      async () =>
        JSON.parse(await fs.readFile(recoveryFile, "utf8")).requests.length,
    )
    .toBe(0);
  const report = (await createWorkflowRuntime().readReport({
    kind: "standalone",
    ...args,
  }))!;
  const run = (await f.call(route, "GET", undefined, operator)).run;
  expect(run.lastSequence).toBe(report.lastSequence);
  expect(run.events).toEqual(report.events);
  await first.close();
  await second.close();
  const lock = path.join(root, ".badger/runs/shared/.badger/mcp-queue.lock");
  await fs.writeFile(lock, JSON.stringify({ pid: 2147483647 }));
  const third = await connect();
  const status = await call(third, "status", args);
  expect(status.reporting.error).toContain(lock);
  expect(status.reporting.error).toContain(
    "delete the lock file only if no MCP process is using this Run",
  );
}, 90_000);
