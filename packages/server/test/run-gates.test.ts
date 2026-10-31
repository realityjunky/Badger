import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createWorkflowRuntime } from "@realityjunky/badger/workflow-runtime";
import {
  startTestService,
  startStubWeComRobot,
  type StubWeComRobot,
  type TestService,
  type TestPerson,
} from "../src/testing/index.js";
import {
  startPlanningService,
  planningRequest,
  owner,
  observer,
  admin,
} from "./fixtures/planning.js";
import { publishedFixture, operator, decisionPlan } from "./fixtures/runs.js";

let service: TestService;
let root: string;
let robot: StubWeComRobot;
afterEach(async () => {
  await service?.close();
  await robot?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

it("opens a policy-routed Run gate, binds a person's answer and attestation, and closes its inbox exactly once", async () => {
  service = await startPlanningService();
  const f = await publishedFixture(service, decisionPlan);
  const invited: TestPerson = {
    subject: "invited-operator",
    email: "invited-operator@example.com",
  };
  await f.call(
    "/bindings",
    "POST",
    {
      scopeType: "workflow",
      scopeId: f.workflow.id,
      email: invited.email,
      role: "Operator",
    },
    admin,
    201,
  );
  const published = await f.call(
    `/workflows/${f.workflow.id}/publications/${f.publication.id}/package`,
  );
  const protocol = JSON.parse(
    Buffer.from(
      published.snapshot.files.find(
        (file: any) => file.path === "reference/workflow-protocol.json",
      ).content,
      "base64",
    ).toString("utf8"),
  );
  root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-run-gates-"));
  const runtime = createWorkflowRuntime();
  const location = {
    kind: "standalone" as const,
    projectRoot: root,
    runId: "gated",
  };
  const current = await runtime.start({ protocol, location });
  const route = "/runs/gated";
  const machine = (url: string, body: unknown) =>
    f.call(url, "POST", body, operator, 200, f.operatorToken);
  await machine(route, {
    workflowId: f.workflow.id,
    publicationId: f.publication.id,
    packageHash: f.publication.packageHash,
    localRunId: "gated",
    hostLabel: "Lab",
    testRun: false,
    execution: current.execution,
  });
  const report = await runtime.readReport(location);
  await machine(`${route}/events`, report);
  await machine(`${route}/events`, report);
  const read = (url: string, as: TestPerson = operator) =>
    f.call(url, "GET", undefined, as);
  const { gates } = await read(`${route}/gates`);
  expect(gates).toHaveLength(1);
  const gate = gates[0];
  expect(gate).toMatchObject({
    state: "open",
    canAnswer: true,
    revision: current.revision,
    actionId: current.pendingAction!.id,
  });
  const inbox = await read("/me/inbox");
  expect(
    (await read("/me/inbox", invited)).items.filter(
      (item: any) => item.href === "/runs/gated",
    ),
  ).toHaveLength(1);
  const { person } = await read("/me");
  expect(inbox.items.filter((i: any) => i.href === "/runs/gated")).toHaveLength(
    1,
  );
  expect((await read(`${route}/gates`, observer)).gates[0].canAnswer).toBe(
    false,
  );
  const answer = {
    choiceId: "release",
    inputs: { ticket: "REL-66" },
    rationale: "Reviewed the report.",
  };
  const endpoint = `${route}/gates/${gate.id}`;
  await f.call(`${endpoint}/preview`, "POST", answer, observer, 403);
  await f.call(`${endpoint}/preview`, "POST", answer, owner, 403);
  await f.call(
    `${endpoint}/preview`,
    "POST",
    answer,
    operator,
    403,
    f.operatorToken,
  );
  await f.call(
    `${endpoint}/preview`,
    "POST",
    {
      ...answer,
      reviewer: { subject: "forged", authorities: ["workflow-owner"] },
    },
    operator,
    400,
  );
  await f.call(
    `${endpoint}/preview`,
    "POST",
    { ...answer, inputs: {} },
    operator,
    400,
  );
  const { preview } = await f.call(
    `${endpoint}/preview`,
    "POST",
    answer,
    operator,
  );
  const commit = {
    ...answer,
    confirmed: true,
    confirmationHash: preview.confirmationHash,
    requestId: "answer-release",
  };
  await f.call(
    `${endpoint}/answer`,
    "POST",
    { ...commit, rationale: "Changed" },
    operator,
    409,
  );
  const result = await f.call(`${endpoint}/answer`, "POST", commit, operator);
  expect(result.answer).toMatchObject({
    actorId: person.id,
    submission: {
      kind: "decision",
      reviewer: { subject: person.id, authorities: ["operator"] },
      choiceId: "release",
      revision: current.revision,
    },
  });
  await f.call(
    "/bindings",
    "POST",
    {
      scopeType: "workflow",
      scopeId: f.workflow.id,
      email: operator.email,
      role: "Engineer",
    },
    admin,
    201,
  );
  expect(await f.call(`${endpoint}/answer`, "POST", commit, operator)).toEqual(
    result,
  );
  expect(
    (await read("/me/inbox")).items.find((i: any) => i.href === "/runs/gated")
      .state,
  ).toBe("done");
  const delivered = await f.call(
    `${route}/gate-answer`,
    "GET",
    undefined,
    operator,
    200,
    f.operatorToken,
  );
  expect(delivered.answer).toEqual(result.answer);
  const continued = await runtime.submit(location, delivered.answer.submission);
  expect(continued.disposition).toBe("done");
  const later = await runtime.readReport(location, report!.lastSequence);
  await machine(`${route}/events`, later);
  expect((await read(route)).run.integrityFindings).toEqual([]);
  expect((await read(`${route}/gates`)).gates[0].state).toBe("answered");
  const audit = await read("/audit-events?limit=100", admin);
  expect(
    audit.events.filter((e: any) => e.action === "run_gate.answered"),
  ).toHaveLength(1);
}, 60_000);

it("routes a named Workflow owner's gate to their inbox and team channel, and refuses an Agent's changed policy", async () => {
  robot = await startStubWeComRobot();
  service = await startTestService({
    notificationChannel: robot.channel,
    environment: {
      BADGER_BOOTSTRAP_ADMINISTRATORS: admin.email,
      BADGER_ALLOWED_ORIGINS: "http://localhost",
      BADGER_NOTIFICATION_KEY: "ab".repeat(32),
      BADGER_PUBLIC_URL: "https://badger.example.com",
    },
  });
  const call = planningRequest(service);
  const { person } = await call("/me", "GET", undefined, owner);
  const f = await publishedFixture(service, (plan) => {
    decisionPlan(plan, "workflow-owner");
    plan.workflow.customNodes[0].decision.reviewer.subjects = [person.id];
  });
  const { preferences, events } = await call(
    "/me/notifications",
    "GET",
    undefined,
    owner,
  );
  await call(
    "/me/notifications",
    "PUT",
    {
      revision: preferences.revision,
      wecomUserId: "owner-wecom",
      mobile: null,
      mentionEvents: events,
    },
    owner,
  );
  await call(
    `/workflows/${f.workflow.id}/notifications/channel`,
    "PUT",
    {
      revision: 0,
      label: "Run team",
      webhookUrl:
        "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-secret",
      language: "en",
      confirmed: true,
    },
    owner,
  );
  for (let count = 0; count < 5; count++) {
    await service.runNotificationJobs();
    service.clock.advance(3100);
  }
  const before = robot.requests.length;
  const published = await call(
    `/workflows/${f.workflow.id}/publications/${f.publication.id}/package`,
  );
  const protocol = JSON.parse(
    Buffer.from(
      published.snapshot.files.find(
        (file: any) => file.path === "reference/workflow-protocol.json",
      ).content,
      "base64",
    ).toString("utf8"),
  );
  root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-owner-gates-"));
  const runtime = createWorkflowRuntime();
  const location = {
    kind: "standalone" as const,
    projectRoot: root,
    runId: "owner-gate",
  };
  const current = await runtime.start({ protocol, location });
  const route = "/runs/owner-gate";
  const machine = (url: string, body: unknown, status = 200) =>
    call(url, "POST", body, operator, status, f.operatorToken);
  await machine(route, {
    workflowId: f.workflow.id,
    publicationId: f.publication.id,
    packageHash: f.publication.packageHash,
    localRunId: location.runId,
    hostLabel: "Lab",
    testRun: false,
    execution: current.execution,
  });
  const report = (await runtime.readReport(location))!;
  await machine(
    `${route}/events`,
    {
      ...report,
      continuation: {
        ...report.continuation,
        pendingAction: {
          ...report.continuation.pendingAction,
          reviewer: { authorities: ["operator"] },
        },
      },
    },
    409,
  );
  await machine(`${route}/events`, report);
  const ownerInbox = await call("/me/inbox", "GET", undefined, owner);
  expect(
    ownerInbox.items.filter((item: any) => item.href === route),
  ).toHaveLength(1);
  expect(
    (await call("/me/inbox", "GET", undefined, operator)).items.filter(
      (item: any) => item.href === route,
    ),
  ).toHaveLength(0);
  service.clock.advance(3100);
  await service.runNotificationJobs();
  expect(robot.requests.slice(before)).toHaveLength(1);
  expect(robot.requests.at(-1)!.message.text.mentioned_list).toEqual([
    "owner-wecom",
  ]);
  expect(robot.requests.at(-1)!.message.text.content).toContain(
    `https://badger.example.com${route}`,
  );
  const gate = (await call(`${route}/gates`, "GET", undefined, owner)).gates[0];
  const answer = {
    choiceId: "release",
    inputs: { ticket: "OWNER-66" },
    rationale: "Approved by the named owner.",
  };
  await call(
    `${route}/gates/${gate.id}/preview`,
    "POST",
    answer,
    operator,
    403,
  );
  const { preview } = await call(
    `${route}/gates/${gate.id}/preview`,
    "POST",
    answer,
    owner,
  );
  expect(preview.submission.reviewer).toEqual({
    subject: person.id,
    authorities: ["workflow-owner"],
  });
  await call(
    `${route}/gates/${gate.id}/answer`,
    "POST",
    {
      ...answer,
      confirmed: true,
      confirmationHash: preview.confirmationHash,
      requestId: "owner-answer",
    },
    owner,
  );
  expect((await runtime.submit(location, preview.submission)).disposition).toBe(
    "done",
  );
  await machine(`${route}/events`, await runtime.readReport(location));
  await call(`${route}/gates/${gate.id}/preview`, "POST", answer, owner, 409);
}, 60_000);
