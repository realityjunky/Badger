import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWorkflowRuntime } from "@realityjunky/badger/workflow-runtime";
import { createBadgerMcp } from "../src/index.js";
import {
  admin,
  startPlanningService,
} from "../../server/test/fixtures/planning.js";
import {
  publishedFixture,
  operator,
  durableGatePlan,
} from "../../server/test/fixtures/runs.js";

let service: Awaited<ReturnType<typeof startPlanningService>>;
let client: Client;
let mcp: ReturnType<typeof createBadgerMcp>;
let root: string;
afterEach(async () => {
  vi.restoreAllMocks();
  await client?.close();
  await mcp?.close();
  await service?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

it("reconciles a flagged Run through recover and retries its durable outcome after reconnect", async () => {
  service = await startPlanningService();
  const f = await publishedFixture(service);
  root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-mcp-recovery-"));
  let holdEvents = true;
  let posts = 0;
  const connect = async () => {
    mcp = createBadgerMcp({
      url: service.baseUrl,
      token: f.operatorToken,
      agentHost: "Planning Agent",
      profile: "operator",
      fetch: async (url, init) => {
        if (init.method === "POST") posts++;
        return holdEvents && url.endsWith("/events")
          ? Response.json(
              { error: { message: "Mirror unavailable" } },
              { status: 503 },
            )
          : fetch(url, init);
      },
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await mcp.connect(b);
    client = new Client({ name: "recovery-operator", version: "1" });
    await client.connect(a);
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const reply = await client.callTool({ name, arguments: args });
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    return JSON.parse((reply.content as { text: string }[])[0].text);
  };
  await connect();
  const args = { projectRoot: root, runId: "recoverable" };
  const started = await call("start", {
    ...args,
    workflowId: f.workflow.id,
    publicationId: f.publication.id,
    packageHash: f.publication.packageHash,
    hostLabel: "Lab",
    confirmed: true,
  });
  const route = `/runs/${started.runUrl.split("/").at(-1)}`;
  await expect
    .poll(
      async () =>
        (await f.call("/me/runs", "GET", undefined, operator)).runs.length,
    )
    .toBe(1);
  const report = (await createWorkflowRuntime().readReport({
    kind: "standalone",
    ...args,
  }))!;
  expect(report.events.length).toBeGreaterThan(1);
  await f.call(
    `${route}/events`,
    "POST",
    { events: [report.events.at(-1)] },
    operator,
    409,
    f.operatorToken,
  );
  expect(
    (await f.call(route, "GET", undefined, operator)).run.needsRecovery,
  ).toBe(true);
  await call("recover", args);
  await client.close();
  await mcp.close();
  holdEvents = false;
  await connect();
  await call("status", args);
  await expect
    .poll(
      async () =>
        (await f.call(route, "GET", undefined, operator)).run.recovery?.outcome,
    )
    .toBe("settled");
  const run = (await f.call(route, "GET", undefined, operator)).run;
  expect(run.needsRecovery).toBe(false);
  expect(run.events).toEqual(report.events);
  expect(run.recovery.revision).toBe(started.continuation.revision);
  await call("status", args);
  expect(
    (await f.call(route, "GET", undefined, operator)).run.recovery,
  ).toEqual(run.recovery);
  const originalSkill = await fs.readFile(started.skillPath, "utf8");
  await fs.appendFile(
    started.skillPath,
    "\nChanged installed package bytes.\n",
  );
  await call("status", args);
  const findings = async () =>
    (await f.call(route, "GET", undefined, operator)).run.integrityFindings.map(
      (finding: any) => finding.code,
    );
  await expect.poll(findings).toContain("package-hash-mismatch");
  // Changed bytes are flagged, not refused: later progress is still mirrored.
  const current = (await call("next", args)).continuation;
  await call("submit", {
    ...args,
    submission: {
      actionId: current.pendingAction.id,
      revision: current.revision,
      runId: current.runId,
      nodeId: current.currentNode,
      execution: current.execution,
      status: "succeeded",
      summary: "Report prepared.",
      evidence: { summary: "Reviewed the report." },
    },
  });
  await expect
    .poll(
      async () =>
        (await f.call(route, "GET", undefined, operator)).run.projection
          ?.status,
    )
    .toBe("completed");
  expect(await findings()).toContain("package-hash-mismatch");
  // Once reported, the changed bytes are not posted again on every tick.
  const posted = posts;
  await new Promise((resolve) => setTimeout(resolve, 2500));
  expect(posts).toBe(posted);
  await fs.writeFile(started.skillPath, originalSkill);
  await client.close();
  await mcp.close();
  await connect();
  await call("status", args);
  await expect
    .poll(
      async () =>
        (await f.call(route, "GET", undefined, operator)).run.needsRecovery,
    )
    .toBe(false);
}, 60_000);

it("reports an interrupted kernel transition before recover and mirrors its settled outcome", async () => {
  service = await startPlanningService();
  const f = await publishedFixture(service, (plan) => {
    durableGatePlan(plan);
    delete plan.workflow.finalization;
    const durability = plan.workflow.capabilities.durability;
    durability.capabilities = ["revision-fences", "transition-journal"];
    delete durability.repair;
  });
  root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-mcp-interruption-"));
  let loseRecoveryReply = false;
  let recoveryPosts = 0;
  mcp = createBadgerMcp({
    url: service.baseUrl,
    token: f.operatorToken,
    agentHost: "Planning Agent",
    profile: "operator",
    fetch: async (url, init) => {
      if (url.endsWith("/recovery")) recoveryPosts++;
      const response = await fetch(url, init);
      if (
        loseRecoveryReply &&
        response.ok &&
        url.endsWith("/events") &&
        JSON.parse(String(init.body)).recoveries?.length
      ) {
        loseRecoveryReply = false;
        throw new Error("Lost the committed recovery response");
      }
      return response;
    },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await mcp.connect(b);
  client = new Client({ name: "interrupted-operator", version: "1" });
  await client.connect(a);
  const call = async (name: string, args: Record<string, unknown>) => {
    const reply = await client.callTool({ name, arguments: args });
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    return JSON.parse((reply.content as { text: string }[])[0].text);
  };
  const args = { projectRoot: root, runId: "interrupted" };
  const started = await call("start", {
    ...args,
    workflowId: f.workflow.id,
    publicationId: f.publication.id,
    packageHash: f.publication.packageHash,
    hostLabel: "Lab",
    confirmed: true,
  });
  const route = `/runs/${started.runUrl.split("/").at(-1)}`;
  await expect
    .poll(
      async () =>
        (await f.call(route, "GET", undefined, operator)).run.lastSequence,
    )
    .toBeGreaterThan(0);
  // Fail a filesystem publication after the kernel has durably prepared its
  // transition. Exercise the public runtime and MCP without internal test hooks.
  const originalRename = fs.rename;
  const publish = vi
    .spyOn(fs, "rename")
    .mockImplementation(async (from, to) => {
      if (
        String(to) ===
        path.join(root, ".badger/runs/interrupted/.badger/artifacts.json")
      )
        throw new Error("Simulated host crash");
      return originalRename(from, to);
    });
  const current = started.continuation;
  try {
    await expect(
      createWorkflowRuntime().submit(
        { kind: "standalone", ...args },
        {
          actionId: current.pendingAction.id,
          runId: current.runId,
          revision: current.revision,
          nodeId: current.currentNode,
          execution: current.execution,
          status: "succeeded",
          summary: "Report prepared.",
          evidence: { summary: "Reviewed the report." },
        },
      ),
    ).rejects.toThrow("Simulated host crash");
  } finally {
    publish.mockRestore();
  }
  expect((await call("status", args)).continuation.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "recovery-required" }),
    ]),
  );
  await expect
    .poll(
      async () =>
        (await f.call(route, "GET", undefined, operator)).run.needsRecovery,
    )
    .toBe(true);
  // The acknowledged notice is not posted again on every tick.
  const noticed = recoveryPosts;
  await new Promise((resolve) => setTimeout(resolve, 2500));
  expect(recoveryPosts).toBe(noticed);
  const artifactRecord = path.join(
    root,
    ".badger/runs/interrupted/.badger/artifacts.json",
  );
  const originalRecord = await fs
    .readFile(artifactRecord)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  await fs.writeFile(artifactRecord, "unknown after crash\n");
  const blocked = await call("recover", args);
  expect(
    blocked.continuation.findings.map((finding: any) => finding.code),
  ).toContain("recovery-required");
  await expect
    .poll(
      async () =>
        (await f.call(route, "GET", undefined, operator)).run.recovery?.outcome,
    )
    .toBe("blocked");
  if (originalRecord) await fs.writeFile(artifactRecord, originalRecord);
  else await fs.unlink(artifactRecord);
  loseRecoveryReply = true;
  const recovered = await call("recover", args);
  expect(
    recovered.continuation.findings.map((finding: any) => finding.code),
  ).not.toContain("recovery-required");
  await expect
    .poll(
      async () =>
        (await f.call(route, "GET", undefined, operator)).run.recovery?.outcome,
    )
    .toBe("settled");
  const run = (await f.call(route, "GET", undefined, operator)).run;
  expect(run.needsRecovery).toBe(false);
  await expect
    .poll(async () => (await call("status", args)).reporting.error, {
      timeout: 10_000,
    })
    .toBeNull();
  expect(
    (await f.call(route, "GET", undefined, operator)).run.needsRecovery,
  ).toBe(false);
  expect(run.continuation).toEqual(
    (await createWorkflowRuntime().readReport({ kind: "standalone", ...args }))!
      .continuation,
  );
  // A start that WorkflowRuntime committed before failing keeps its intent, so
  // a later call binds the Run.
  const startArgs = { projectRoot: root, runId: "interrupted-start" };
  const crashStart = vi
    .spyOn(fs, "rename")
    .mockImplementation(async (from, to) => {
      if (
        String(to) ===
        path.join(root, ".badger/runs/interrupted-start/.badger/run-state.json")
      )
        throw new Error("Simulated host crash");
      return originalRename(from, to);
    });
  let refused;
  try {
    refused = await client.callTool({
      name: "start",
      arguments: {
        ...startArgs,
        workflowId: f.workflow.id,
        publicationId: f.publication.id,
        packageHash: f.publication.packageHash,
        hostLabel: "Lab",
        confirmed: true,
      },
    });
  } finally {
    crashStart.mockRestore();
  }
  expect(refused.isError).toBe(true);
  expect(
    (await call("recover", startArgs)).continuation.findings.map(
      (finding: any) => finding.code,
    ),
  ).not.toContain("recovery-required");
  await expect
    .poll(async () =>
      (await f.call("/me/runs", "GET", undefined, operator)).runs.map(
        (run: any) => run.localRunId,
      ),
    )
    .toContain("interrupted-start");
}, 240_000);

it("settles a recovery notice whose interruption was cleared outside recover once the Run reports a healthy runtime", async () => {
  service = await startPlanningService();
  const f = await publishedFixture(service);
  root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-mcp-notice-"));
  const connect = async () => {
    mcp = createBadgerMcp({
      url: service.baseUrl,
      token: f.operatorToken,
      agentHost: "Planning Agent",
      profile: "operator",
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await mcp.connect(b);
    client = new Client({ name: "notice-operator", version: "1" });
    await client.connect(a);
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const reply = await client.callTool({ name, arguments: args });
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    return JSON.parse((reply.content as { text: string }[])[0].text);
  };
  await connect();
  const args = { projectRoot: root, runId: "noticed" };
  const started = await call("start", {
    ...args,
    workflowId: f.workflow.id,
    publicationId: f.publication.id,
    packageHash: f.publication.packageHash,
    hostLabel: "Lab",
    confirmed: true,
  });
  const registrationId = started.runUrl.split("/").at(-1);
  const route = `/runs/${registrationId}`;
  const report = (await createWorkflowRuntime().readReport({
    kind: "standalone",
    ...args,
  }))!;
  await expect
    .poll(
      async () =>
        (await f.call(route, "GET", undefined, operator)).run.lastSequence,
    )
    .toBe(report.lastSequence);
  await client.close();
  await mcp.close();
  // The MCP recorded an interruption that was then cleared outside its recover,
  // as by another process or the package's own state script.
  const recoveryFile = path.join(
    root,
    ".badger/runs/noticed/.badger/mcp-recovery.json",
  );
  await fs.writeFile(
    recoveryFile,
    JSON.stringify({
      required: true,
      noticeId: "external-notice",
      noticeHash: "0".repeat(64),
      requests: [],
    }) + "\n",
  );
  await connect();
  await call("status", args);
  const audit = async (action: string) =>
    (
      await f.call(
        `/audit-events?action=${action}&targetId=${registrationId}`,
        "GET",
        undefined,
        admin,
      )
    ).events;
  await expect
    .poll(async () => (await audit("run.recovery_notice_settled")).length, {
      timeout: 10_000,
    })
    .toBe(1);
  expect(await audit("run.recovery_required")).toHaveLength(1);
  expect(await audit("run.recovered")).toEqual([]);
  expect((await f.call(route, "GET", undefined, operator)).run).toMatchObject({
    needsRecovery: false,
    recovery: null,
  });
  await expect
    .poll(async () => JSON.parse(await fs.readFile(recoveryFile, "utf8")))
    .toEqual({ required: false, requests: [] });
  // A later recover binds no settled notice and leaves the Run healthy.
  await call("recover", args);
  await expect
    .poll(
      async () =>
        (await f.call(route, "GET", undefined, operator)).run.recovery
          ?.noticeId,
      { timeout: 10_000 },
    )
    .toBeNull();
  expect(
    (await f.call(route, "GET", undefined, operator)).run.needsRecovery,
  ).toBe(false);
}, 60_000);
