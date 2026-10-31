import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
  vi.restoreAllMocks();
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
it("delivers only a dashboard-attested gate answer on status and next, including after reconnect", async () => {
  const { publishedFixture, operator, decisionPlan } =
    await import("../../server/test/fixtures/runs.js");
  service = await startPlanningService();
  const f = await publishedFixture(service, decisionPlan);
  let holdRegistration = false;
  const connect = async () => {
    currentServer = createBadgerMcp({
      url: service.baseUrl,
      token: f.operatorToken,
      agentHost: "Planning Agent",
      profile: "operator",
      fetch: async (url, init) =>
        holdRegistration &&
        init.method === "POST" &&
        /\/runs\/[^/]+$/u.test(url)
          ? Response.json(
              { error: { message: "Registration unavailable" } },
              { status: 503 },
            )
          : fetch(url, init),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await currentServer.connect(b);
    client = new Client({ name: "gate-operator", version: "1" });
    await client.connect(a);
  };
  await connect();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-mcp-gate-"));
  // A gate whose Run the service has not registered yet has no answer yet.
  holdRegistration = true;
  const unregistered = { projectRoot: root, runId: "gate-unregistered" };
  await value("start", {
    ...unregistered,
    workflowId: f.workflow.id,
    publicationId: f.publication.id,
    packageHash: f.publication.packageHash,
    hostLabel: "Lab",
    confirmed: true,
  });
  for (const name of ["status", "next"])
    expect((await value(name, unregistered)).requiresPerson).toBe(true);
  holdRegistration = false;
  for (const name of ["status", "next"]) {
    const args = { projectRoot: root, runId: `gate-${name}` };
    const started = await value("start", {
      ...args,
      workflowId: f.workflow.id,
      publicationId: f.publication.id,
      packageHash: f.publication.packageHash,
      hostLabel: "Lab",
      confirmed: true,
    });
    expect(started.requiresPerson).toBe(true);
    const runId = started.runUrl.split("/").at(-1);
    const route = `/runs/${runId}`;
    await expect
      .poll(
        async () =>
          (await f.call(`${route}/gates`, "GET", undefined, operator)).gates
            .length,
      )
      .toBe(1);
    const { gates } = await f.call(
      `${route}/gates`,
      "GET",
      undefined,
      operator,
    );
    const gate = gates[0];
    const answer = {
      choiceId: "release",
      inputs: { ticket: "REL-66" },
      rationale: "The person reviewed release.",
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
        requestId: `answer-${name}`,
      },
      operator,
    );
    await client.close();
    await currentServer!.close();
    await connect();
    const [continued, repeated] = await Promise.all([
      value(name, args),
      value(name, args),
    ]);
    expect(continued.continuation.disposition).toBe("done");
    expect(repeated.continuation.revision).toBe(
      continued.continuation.revision,
    );
    expect(repeated.continuation.decisionReceipts).toHaveLength(1);
    expect(repeated.continuation.decisionReceipts[0].reviewer).toEqual(
      preview.submission.reviewer,
    );
  }
}, 60_000);

it("delivers manual-stop and finalization answers through WorkflowRuntime and asks again when finalization effects change", async () => {
  const { publishedFixture, operator, durableGatePlan } =
    await import("../../server/test/fixtures/runs.js");
  service = await startPlanningService();
  const f = await publishedFixture(service, durableGatePlan);
  await f.call(
    "/bindings",
    "POST",
    {
      scopeType: "workflow",
      scopeId: f.workflow.id,
      email: owner.email,
      role: "Operator",
    },
    admin,
    201,
  );
  currentServer = createBadgerMcp({
    url: service.baseUrl,
    token: f.operatorToken,
    agentHost: "Planning Agent",
    profile: "operator",
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await currentServer.connect(b);
  client = new Client({ name: "durable-gates", version: "1" });
  await client.connect(a);
  root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-mcp-durable-gates-"));
  for (const mode of ["manual-stop", "finalization"]) {
    service.clock.advance(61_000);
    const args = { projectRoot: root, runId: mode };
    const started = await value("start", {
      ...args,
      workflowId: f.workflow.id,
      publicationId: f.publication.id,
      packageHash: f.publication.packageHash,
      hostLabel: "Lab",
      confirmed: true,
    });
    const route = `/runs/${started.runUrl.split("/").at(-1)}`;
    let current = started.continuation;
    for (
      let attempt = 0;
      attempt < (mode === "manual-stop" ? 2 : 1);
      attempt++
    ) {
      const reply = await value("submit", {
        ...args,
        submission: {
          actionId: current.pendingAction.id,
          revision: current.revision,
          execution: current.execution,
          runId: current.runId,
          nodeId: current.currentNode,
          status: mode === "manual-stop" ? "failed" : "succeeded",
          summary: "Report checked.",
          evidence: { summary: "Reviewed the report." },
        },
      });
      current = reply.continuation;
    }
    expect(current.pendingAction.type).toBe("ask_user");
    expect(
      current.pendingAction[mode === "manual-stop" ? "repair" : "finalization"],
    ).toBeTruthy();
    const person = mode === "manual-stop" ? operator : owner;
    const answer = {
      choiceId: mode === "manual-stop" ? "stop" : "confirm",
      rationale: "Reviewed this exact pending action.",
    };
    const answerGate = async (
      requestId: string,
      choiceId = answer.choiceId,
    ) => {
      await expect
        .poll(
          async () =>
            (
              await f.call(`${route}/gates`, "GET", undefined, person)
            ).gates.filter((gate: any) => gate.state === "open").length,
        )
        .toBe(1);
      const gate = (
        await f.call(`${route}/gates`, "GET", undefined, person)
      ).gates.find((gate: any) => gate.state === "open");
      if (mode === "finalization")
        expect(gate.finalizationPreview.operations[0]).toMatchObject({
          kind: "write",
          target: "released.txt",
        });
      if (mode === "finalization")
        await f.call(
          `${route}/gates/${gate.id}/preview`,
          "POST",
          { ...answer, rationale: "x".repeat(257) },
          person,
          400,
        );
      if (mode === "manual-stop")
        await f.call(
          `${route}/gates/${gate.id}/preview`,
          "POST",
          { ...answer, choiceId, rationale: "x".repeat(257) },
          person,
          400,
        );
      const { preview } = await f.call(
        `${route}/gates/${gate.id}/preview`,
        "POST",
        { ...answer, choiceId },
        person,
      );
      await f.call(
        `${route}/gates/${gate.id}/answer`,
        "POST",
        {
          ...answer,
          choiceId,
          confirmed: true,
          confirmationHash: preview.confirmationHash,
          requestId,
        },
        person,
      );
      return gate;
    };
    if (mode === "manual-stop") {
      await answerGate("answer-retry", "retry-with-new-approach");
      const retried = await value("next", args);
      expect(retried.continuation.disposition).toBe("continue");
      const retry = retried.continuation;
      const failed = await value("submit", {
        ...args,
        submission: {
          actionId: retry.pendingAction.id,
          revision: retry.revision,
          runId: retry.runId,
          nodeId: retry.currentNode,
          execution: retry.execution,
          status: "failed",
          summary: "The repaired report still fails.",
          evidence: { summary: "Checked the repair." },
        },
      });
      expect(failed.continuation.pendingAction.type).toBe("ask_user");
      await expect
        .poll(
          async () =>
            (
              await f.call(`${route}/gates`, "GET", undefined, person)
            ).gates.filter((gate: any) => gate.state === "open").length,
        )
        .toBe(1);
      const nextGate = (
        await f.call(`${route}/gates`, "GET", undefined, person)
      ).gates.find((gate: any) => gate.state === "open");
      await f.call(
        `${route}/gates/${nextGate.id}/preview`,
        "POST",
        { ...answer, choiceId: "retry-with-new-approach" },
        person,
        400,
      );
    }
    const gate = await answerGate(`answer-${mode}`);
    if (mode === "finalization") {
      await fs.writeFile(
        path.join(root, "released.txt"),
        "changed after review\n",
      );
      const stale = await value("next", args);
      expect(stale.continuation.disposition).toBe("await-user");
      expect(await fs.readFile(path.join(root, "released.txt"), "utf8")).toBe(
        "changed after review\n",
      );
      expect((await answerGate("answer-refreshed-finalization")).id).not.toBe(
        gate.id,
      );
    }
    let continued;
    service.clock.advance(61_000);
    if (mode === "finalization") {
      const link = fs.link;
      let interrupted = false;
      const crash = vi
        .spyOn(fs, "link")
        .mockImplementation(async (from, to) => {
          if (!interrupted && String(to) === path.join(root, "released.txt")) {
            interrupted = true;
            throw new Error("Simulated interrupted finalization publication");
          }
          return link(from, to);
        });
      try {
        await client.callTool({ name: "next", arguments: args });
      } finally {
        crash.mockRestore();
      }
      expect(interrupted).toBe(true);
      continued = await value("recover", args);
    } else continued = await value("next", args);
    expect(continued.continuation.disposition).toBe(
      mode === "manual-stop" ? "blocked" : "done",
    );
    await expect
      .poll(
        async () => {
          const status = await value("status", args);
          const mirrored = (await f.call(route, "GET", undefined, operator))
            .run;
          return {
            revision: mirrored.projection?.revision,
            error: status.reporting.error,
          };
        },
        { timeout: 10_000 },
      )
      .toEqual({ revision: continued.continuation.revision, error: null });
    expect(
      (await f.call(route, "GET", undefined, operator)).run.integrityFindings,
    ).toEqual([]);
    if (mode === "finalization")
      expect(await fs.readFile(path.join(root, "released.txt"), "utf8")).toBe(
        "released\n",
      );
  }
}, 300_000);
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

it("mirrors a valid 257-outcome Cycle, keeps bounded observable summaries, and pages every original event after an outage and replay", async () => {
  const { publishedFixture, operator } =
    await import("../../server/test/fixtures/runs.js");
  service = await startPlanningService();
  const f = await publishedFixture(service, (plan) => {
    plan.workflow.routing = {
      fields: [{ id: "next", values: ["repeat", "finish"] }],
      transitions: [
        {
          from: "report",
          to: "report",
          condition: "success",
          when: { field: "next", equals: "repeat" },
        },
        {
          from: "report",
          to: null,
          condition: "success",
          when: { field: "next", equals: "finish" },
        },
      ],
    };
    plan.workflow.cycles = [
      {
        key: "reports",
        entry: "report",
        repeatTransitions: [{ from: "report", to: "report" }],
        maxInstances: 300,
      },
    ];
  });
  let outage = false;
  const server = createBadgerMcp({
    url: service.baseUrl,
    token: f.operatorToken,
    agentHost: "Long Run Agent",
    profile: "operator",
    fetch: async (url, init) =>
      outage
        ? Response.json(
            { error: { message: "Temporarily unavailable" } },
            { status: 503 },
          )
        : fetch(url, init),
  });
  currentServer = server;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  client = new Client({ name: "long-run", version: "1" });
  await client.connect(a);
  root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-mcp-long-run-"));
  const local = { projectRoot: root, runId: "long-run" };
  let current = (
    await value("start", {
      ...local,
      workflowId: f.workflow.id,
      publicationId: f.publication.id,
      packageHash: f.publication.packageHash,
      hostLabel: "Cycle host",
      confirmed: true,
    })
  ).continuation;
  const runtime = createWorkflowRuntime();
  const location = { kind: "standalone" as const, ...local };
  const originalStart = (await runtime.readReport(location))!.events[0];
  outage = true;
  for (let outcome = 1; outcome <= 257; outcome++) {
    current = (
      await value("submit", {
        ...local,
        submission: {
          actionId: current.pendingAction.id,
          revision: current.revision,
          execution: current.execution,
          runId: current.runId,
          nodeId: current.currentNode,
          status: "succeeded",
          summary: `Report ${outcome} checked.`,
          routing: { next: outcome === 257 ? "finish" : "repeat" },
        },
      })
    ).continuation;
  }
  expect(current.disposition).toBe("done");
  const original = (await runtime.readReport(location))!;
  expect(original.events).toHaveLength(515);
  expect(original.events[0]).toEqual(originalStart);
  const queueFile = path.join(
    root,
    ".badger/runs/long-run/.badger/mcp-queue.json",
  );
  outage = false;
  await value("status", local);
  await expect
    .poll(
      async () => {
        const queue = JSON.parse(await fs.readFile(queueFile, "utf8"));
        return {
          acknowledged: queue.lastAcknowledged,
          reporting: (await fs.readFile(queueFile, "utf8")).includes(
            "acknowledgedReportHash",
          ),
        };
      },
      { timeout: 15_000 },
    )
    .toEqual({ acknowledged: 515, reporting: true });
  const { runs } = await value("my_runs");
  expect(runs[0].projection).toMatchObject({
    status: "completed",
    currentNode: null,
    revision: current.revision,
    historySummary: { total: 257, returned: 256, omitted: 1 },
  });
  expect(runs[0].projection.history).toHaveLength(256);
  expect(runs[0].projection.history.at(-1).status).toBe("succeeded");
  const readEvents = async () => {
    const route = `/runs/${runs[0].id}`;
    const first = (await f.call(route, "GET", undefined, operator)).run;
    expect(first.eventsTruncated).toBe(true);
    expect(first.events).toHaveLength(500);
    const last = (
      await f.call(
        `${route}?afterSequence=${first.events.at(-1).sequence}`,
        "GET",
        undefined,
        operator,
      )
    ).run;
    expect(last.eventsTruncated).toBe(false);
    expect(last.events).toHaveLength(15);
    return [...first.events, ...last.events];
  };
  expect(await readEvents()).toEqual(original.events);
  await fs.unlink(queueFile);
  await value("status", local);
  await expect
    .poll(
      async () =>
        JSON.parse(await fs.readFile(queueFile, "utf8")).lastAcknowledged,
      { timeout: 15_000 },
    )
    .toBe(515);
  expect(await readEvents()).toEqual(original.events);
}, 120_000);

it("forgets denied Run access and capabilities until a fresh successful check, including across a later outage", async () => {
  const { publishedFixture } =
    await import("../../server/test/fixtures/runs.js");
  service = await startPlanningService();
  const f = await publishedFixture(service);
  type Failure = number | "identity" | "outage" | null;
  let accessFailure: Failure = null;
  let capabilityFailure: Failure = null;
  const server = createBadgerMcp({
    url: service.baseUrl,
    token: f.operatorToken,
    agentHost: "Authorization Agent",
    profile: "operator",
    fetch: async (url, init) => {
      const failure = url.includes("/runs/access?")
        ? accessFailure
        : url.endsWith("/me/mcp")
          ? capabilityFailure
          : null;
      if (failure === "outage") throw new TypeError("Service unreachable");
      if (failure === "identity")
        return Response.json({
          personId: "another-person",
          agentHost: "Authorization Agent",
        });
      if (typeof failure === "number")
        return Response.json(
          { error: { message: "Access refused" } },
          { status: failure },
        );
      return fetch(url, init);
    },
  });
  currentServer = server;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  client = new Client({ name: "authorization", version: "1" });
  await client.connect(a);
  root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-mcp-authorization-"));
  const local = { projectRoot: root, runId: "authorization-run" };
  const started = await value("start", {
    ...local,
    workflowId: f.workflow.id,
    publicationId: f.publication.id,
    packageHash: f.publication.packageHash,
    hostLabel: "Authorization host",
    confirmed: true,
  });
  const current = started.continuation;
  const submission = {
    actionId: current.pendingAction.id,
    revision: current.revision,
    execution: current.execution,
    runId: current.runId,
    nodeId: current.currentNode,
    status: "succeeded",
    summary: "Ready.",
    evidence: { summary: "Checked." },
  };
  for (const denial of [401, 403, 400, 500, "identity"] as const) {
    accessFailure = null;
    await value("next", local);
    accessFailure = denial;
    expect(
      (await client.callTool({ name: "next", arguments: local })).isError,
    ).toBe(true);
    accessFailure = "outage";
    for (const name of ["next", "submit", "recover"]) {
      const refused = await client.callTool({
        name,
        arguments: { ...local, ...(name === "submit" ? { submission } : {}) },
      });
      expect(refused.isError, JSON.stringify({ denial, name, refused })).toBe(
        true,
      );
    }
    accessFailure = null;
    await value("next", local);
    accessFailure = "outage";
    expect((await value("next", local)).continuation.revision).toBe(
      current.revision,
    );
  }
  accessFailure = null;
  for (const denial of [401, 403, 400, 500]) {
    capabilityFailure = null;
    await client.listTools();
    capabilityFailure = denial;
    await expect(client.listTools()).rejects.toThrow("Access refused");
    capabilityFailure = "outage";
    await expect(client.listTools()).rejects.toThrow("Cannot reach Badger");
    expect(
      (await client.callTool({ name: "next", arguments: local })).isError,
    ).toBe(true);
    capabilityFailure = null;
    await client.listTools();
    accessFailure = "outage";
    expect(
      (await client.callTool({ name: "next", arguments: local })).isError,
    ).toBe(true);
    accessFailure = null;
    await value("next", local);
    capabilityFailure = "outage";
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
      "next",
    );
    accessFailure = "outage";
    expect((await value("next", local)).continuation.revision).toBe(
      current.revision,
    );
    accessFailure = null;
  }
  capabilityFailure = "identity";
  await expect(client.listTools()).rejects.toThrow();
  capabilityFailure = "outage";
  await expect(client.listTools()).rejects.toThrow("Cannot reach Badger");
  for (const identity of [
    { url: service.baseUrl, agentHost: "Authorization Agent" },
    { url: service.baseUrl, agentHost: "Another Agent" },
    { url: "https://another-badger.example", agentHost: "Authorization Agent" },
  ]) {
    await client.close();
    await currentServer?.close();
    const fresh = createBadgerMcp({
      ...identity,
      token: f.operatorToken,
      profile: "operator",
      fetch: async (url) => {
        if (url.endsWith("/me/mcp"))
          return Response.json({ capabilities: { operateRuns: true } });
        throw new TypeError("Service unreachable");
      },
    });
    currentServer = fresh;
    const [a, b] = InMemoryTransport.createLinkedPair();
    await fresh.connect(b);
    client = new Client({ name: "fresh-authorization", version: "1" });
    await client.connect(a);
    const refused = await client.callTool({ name: "next", arguments: local });
    expect(refused.isError, JSON.stringify(identity)).toBe(true);
  }
}, 60_000);

it("treats a token rate limit as a pause rather than a denial, keeping local progress and reporting it afterwards", async () => {
  const { publishedFixture, operator } =
    await import("../../server/test/fixtures/runs.js");
  service = await startPlanningService();
  const f = await publishedFixture(service);
  let limited = false;
  let requests = 0;
  const server = createBadgerMcp({
    url: service.baseUrl,
    token: f.operatorToken,
    agentHost: "Rate Limited Agent",
    profile: "operator",
    fetch: async (url, init) => {
      requests++;
      return limited
        ? Response.json(
            {
              error: {
                code: "rejected",
                message:
                  "The personal access token rate limit is 60 requests per minute",
              },
            },
            { status: 429, headers: { "retry-after": "3" } },
          )
        : fetch(url, init);
    },
  });
  currentServer = server;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  client = new Client({ name: "rate-limited", version: "1" });
  await client.connect(a);
  root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-mcp-rate-limit-"));
  const local = { projectRoot: root, runId: "rate-limited" };
  const started = await value("start", {
    ...local,
    workflowId: f.workflow.id,
    publicationId: f.publication.id,
    packageHash: f.publication.packageHash,
    hostLabel: "Rate limited host",
    confirmed: true,
  });
  const route = `/runs/${started.runUrl.split("/").at(-1)}`;
  const mirrored = async () =>
    (await f.call(route, "GET", undefined, operator)).run;
  await expect
    .poll(async () => (await mirrored()).lastSequence)
    .toBe(
      (await createWorkflowRuntime().readReport({
        kind: "standalone",
        ...local,
      }))!.lastSequence,
    );
  limited = true;
  const current = (await value("next", local)).continuation;
  const done = await value("submit", {
    ...local,
    submission: {
      actionId: current.pendingAction.id,
      revision: current.revision,
      execution: current.execution,
      runId: current.runId,
      nodeId: current.currentNode,
      status: "succeeded",
      summary: "Reported during a rate limit.",
      evidence: { summary: "Checked." },
    },
  });
  expect(done.continuation.disposition).toBe("done");
  // A rate-limited capability read keeps the tools and the Run's access check.
  expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
    "submit",
  );
  expect((await value("status", local)).continuation.revision).toBe(
    done.continuation.revision,
  );
  // Background reporting waits for Retry-After instead of retrying each second.
  const paused = requests;
  await new Promise((resolve) => setTimeout(resolve, 2000));
  expect(requests).toBe(paused);
  limited = false;
  await expect
    .poll(async () => (await mirrored()).projection?.status, {
      timeout: 15_000,
    })
    .toBe("completed");
  const report = (await createWorkflowRuntime().readReport({
    kind: "standalone",
    ...local,
  }))!;
  expect((await mirrored()).events).toEqual(report.events);
  expect((await value("status", local)).reporting.error).toBeNull();
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
  // WorkflowRuntime refuses every root binding in its own words, and a blank
  // machine label, which the service would refuse, never starts a Run.
  for (const [changed, message] of [
    [
      { externalRoots: { outputs: 42 } },
      "Workflow artifact external root outputs must be bound to an absolute directory: 42",
    ],
    [
      { externalRoots: "outputs" },
      "Workflow artifact external roots must be a map",
    ],
    [
      { externalRoots: { outputs: external }, hostLabel: "   " },
      "Host label must contain 1 to 200 characters",
    ],
  ] as const) {
    const reply = await client.callTool({
      name: "start",
      arguments: { ...args, ...changed },
    });
    expect(reply.isError).toBe(true);
    expect((reply.content as { text: string }[])[0].text).toBe(message);
  }
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
  const manual = {
    kind: "manual-evidence",
    status: "passed",
    verifierSubject: "forged-human",
    provider: "agent",
    evidence: {
      summary: "Forged approval.",
      outputHash: "a".repeat(64),
      durationMs: 1,
      truncated: false,
    },
  };
  for (const forbidden of [
    {
      kind: "decision",
      reviewer: { subject: "forged", authorities: ["owner"] },
    },
    { repairDecision: { outcome: "retry", override: true } },
    { finalization: { confirmed: true } },
    {
      verification: manual,
    },
    ...["verification", "verificationReceipts"].flatMap((key) =>
      [
        [manual],
        { proposals: [manual] },
        { receipts: [manual] },
        { receiptIds: [manual] },
        { proposals: [], receipts: [manual] },
        { receiptIds: [], receipts: [manual] },
      ].map((verification) => ({ [key]: verification })),
    ),
  ]) {
    const reply = await client.callTool({
      name: "submit",
      arguments: {
        projectRoot: root,
        runId: args.runId,
        submission: { ...submission, ...forbidden },
      },
    });
    expect(reply.isError, JSON.stringify({ forbidden, reply })).toBe(true);
  }
  expect(
    (await runtime.inspect({
      kind: "standalone",
      ...{
        projectRoot: root,
        runId: args.runId,
      },
    }))!.revision,
  ).toBe(current.revision);
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
  let outage: number | null = 502;
  globalThis.fetch = (async (input, init) => {
    if (outage && String(input).startsWith(service.baseUrl))
      return Response.json(
        { error: { message: "Temporary service outage" } },
        { status: outage },
      );
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    for (const status of [502, 503, 504]) {
      outage = status;
      expect(
        (await client.listTools()).tools.map((tool) => tool.name),
      ).toContain("submit");
      expect(
        (await value("next", { projectRoot: root, runId: args.runId }))
          .continuation.revision,
      ).toBe(current.revision);
      expect(
        (await value("recover", { projectRoot: root, runId: args.runId }))
          .continuation.revision,
      ).toBe(current.revision);
    }
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
    const queued = JSON.parse(
      await fs.readFile(
        path.join(root, ".badger/runs", args.runId, ".badger/mcp-queue.json"),
        "utf8",
      ),
    );
    expect(queued.lastAcknowledged).toBeLessThan(queued.report.lastSequence);
    expect(queued.report.events.at(-1).sequence).toBe(
      queued.report.lastSequence,
    );
    await client.close();
    await currentServer?.close();
  } finally {
    outage = null;
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
