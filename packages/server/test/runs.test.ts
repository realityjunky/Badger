import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createWorkflowRuntime } from "@realityjunky/badger/workflow-runtime";
import type { TestService, TestPerson } from "../src/testing/index.js";
import {
  startPlanningService,
  engineer,
  observer,
  admin,
} from "./fixtures/planning.js";
import { publishedFixture, operator } from "./fixtures/runs.js";
let service: TestService;
let root: string;
afterEach(async () => {
  await service?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});
it("authorizes Run observation and operation, fixes registration identity, and validates ordered idempotent bounded reports", async () => {
  service = await startPlanningService();
  const f = await publishedFixture(service);
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
  root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-http-runs-"));
  const runtime = createWorkflowRuntime();
  const current = await runtime.start({
    protocol,
    location: { kind: "standalone", projectRoot: root, runId: "http-local" },
  });
  const report = (await runtime.readReport({
    kind: "standalone",
    projectRoot: root,
    runId: "http-local",
  }))!;
  const token = f.operatorToken;
  const route = "/runs/http-run";
  const registration = {
    workflowId: f.workflow.id,
    publicationId: f.publication.id,
    packageHash: f.publication.packageHash,
    localRunId: "http-local",
    hostLabel: "Lab server",
    testRun: false,
    execution: current.execution,
  };
  const get = (
    url: string,
    as: TestPerson = operator,
    secret?: string,
    status = 200,
  ) => f.call(url, "GET", undefined, as, status, secret);
  const post = (
    url: string,
    value: unknown,
    status = 200,
    as: TestPerson = operator,
    secret = token,
  ) => f.call(url, "POST", value, as, status, secret);
  await post(route, { ...registration, packageHash: "0".repeat(64) }, 409);
  await post(route, { ...registration, testRun: true }, 403);
  await Promise.all([post(route, registration), post(route, registration)]);
  for (const changed of [
    { hostLabel: "Other" },
    { localRunId: "another" },
    { execution: { ...current.execution, protocolHash: "0".repeat(64) } },
  ])
    await post(route, { ...registration, ...changed }, 409);
  await get(route, observer);
  await get(
    route,
    { subject: "stranger", email: "stranger@example.com" },
    undefined,
    403,
  );
  const { secret: expert } = await f.call(
    "/me/tokens",
    "POST",
    { name: "Wrong scope", scopes: ["expert"] },
    operator,
    201,
  );
  await get(route, operator, expert, 403);
  const { secret: engineerToken } = await f.call(
    "/me/tokens",
    "POST",
    { name: "Test runner", scopes: ["engineer"] },
    engineer,
    201,
  );
  await post(
    "/runs/engineer-test",
    { ...registration, testRun: false },
    403,
    engineer,
    engineerToken,
  );
  await post(
    "/runs/engineer-test",
    { ...registration, testRun: true },
    200,
    engineer,
    engineerToken,
  );
  expect((await get("/me/runs", engineer, engineerToken)).runs).toHaveLength(1);
  await get(`${route}/access`, engineer, engineerToken, 403);
  const payload = { ...report };
  await post(
    `${route}/events`,
    { ...payload, projection: { ...report.projection, visits: "unsafe" } },
    400,
  );
  for (const historySummary of [
    null,
    { total: 1, returned: 0, omitted: 0 },
    { total: 0, returned: 1, omitted: -1 },
  ])
    await post(
      `${route}/events`,
      { ...payload, projection: { ...report.projection, historySummary } },
      400,
    );
  await post(
    `${route}/events`,
    {
      ...payload,
      projection: {
        ...report.projection,
        artifactReceipts: [{ path: "invalid" }],
      },
    },
    400,
  );
  await post(
    `${route}/events`,
    { events: [{ ...report.events[0], sequence: 2 }] },
    409,
  );
  await post(
    `${route}/events`,
    { ...payload, lastSequence: report.lastSequence + 1 },
    409,
  );
  await post(
    `${route}/events`,
    {
      ...payload,
      projection: {
        ...report.projection,
        execution: { ...current.execution, packageHash: "0".repeat(64) },
      },
    },
    409,
  );
  await post(
    `${route}/events`,
    { ...payload, events: Array.from({ length: 65 }, () => report.events[0]) },
    400,
  );
  await post(`${route}/events`, {
    events: report.events,
    projection: report.projection,
    continuation: report.continuation,
    lastSequence: report.lastSequence,
  });
  await post(`${route}/events`, {
    events: report.events,
    projection: report.projection,
    continuation: report.continuation,
    lastSequence: report.lastSequence,
  });
  await post(
    `${route}/events`,
    { events: [{ ...report.events[0], data: { changed: true } }] },
    409,
  );
  const detail = (await get(route, operator)).run;
  expect(detail.events).toEqual(report.events);
  expect(detail.projection).toEqual(report.projection);
  expect(detail.lastSequence).toBe(report.lastSequence);
  expect(
    (await get(`${route}?afterSequence=${report.lastSequence}`)).run.events,
  ).toEqual([]);
  for (const cursor of ["-1", "1.5", "NaN", "9007199254740992"])
    await get(`${route}?afterSequence=${cursor}`, operator, undefined, 400);
  expect(
    (await get(`/workflows/${f.workflow.id}/runs`, observer)).runs,
  ).toHaveLength(2);
  // The URL does not bind another person's identity even with a valid scope.
  const other = {
    subject: "other-operator",
    email: "other-operator@example.com",
  };
  await f.call(
    "/bindings",
    "POST",
    {
      scopeType: "workflow",
      scopeId: f.workflow.id,
      email: other.email,
      role: "Operator",
    },
    admin,
    201,
  );
  const { secret: otherToken } = await f.call(
    "/me/tokens",
    "POST",
    { name: "Other", scopes: ["operator"] },
    other,
    201,
  );
  await post(`${route}/events`, { events: [] }, 403, other, otherToken);
  const audit = await f.call(
    "/audit-events?limit=100",
    "GET",
    undefined,
    admin,
  );
  expect(
    audit.events.filter(
      (event: any) =>
        event.action === "run.registered" && event.targetId === "http-run",
    ),
  ).toHaveLength(1);
}, 60_000);
