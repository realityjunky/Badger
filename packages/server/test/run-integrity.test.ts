import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createWorkflowRuntime } from "@realityjunky/badger/workflow-runtime";
import { prepareWorkflowGateAnswer } from "@realityjunky/badger/workflow-runtime";
import type { TestService } from "../src/testing/index.js";
import { startPlanningService, admin, observer } from "./fixtures/planning.js";
import { publishedFixture, operator, decisionPlan } from "./fixtures/runs.js";

let service: TestService;
let root: string;
afterEach(async () => {
  await service?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  service = await startPlanningService();
  const f = await publishedFixture(service, decisionPlan);
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
  root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-run-integrity-"));
  const runtime = createWorkflowRuntime();
  const location = {
    kind: "standalone" as const,
    projectRoot: root,
    runId: "integrity",
  };
  const current = await runtime.start({ protocol, location });
  const route = "/runs/integrity";
  const post = (body: unknown, status = 200) =>
    f.call(`${route}/events`, "POST", body, operator, status, f.operatorToken);
  await f.call(
    route,
    "POST",
    {
      workflowId: f.workflow.id,
      publicationId: f.publication.id,
      packageHash: f.publication.packageHash,
      localRunId: location.runId,
      hostLabel: "Lab",
      testRun: false,
      execution: current.execution,
    },
    operator,
    200,
    f.operatorToken,
  );
  const read = async () =>
    (await f.call(route, "GET", undefined, observer)).run;
  return { ...f, runtime, location, current, route, post, read };
}

it("keeps a refused event gap visible and audited until the missing events arrive", async () => {
  const f = await fixture();
  const report = (await f.runtime.readReport(f.location))!;
  const payload = { events: [{ ...report.events[0], sequence: 3 }] };
  await f.post(payload, 409);
  await f.post(payload, 409);
  expect(await f.read()).toMatchObject({
    lastSequence: 0,
    events: [],
    needsRecovery: true,
    integrityFindings: [
      { code: "event-sequence-gap", evidence: { expected: 1, received: 3 } },
    ],
  });
  const audit = await f.call(
    "/audit-events?action=run.integrity_detected",
    "GET",
    undefined,
    admin,
  );
  expect(audit.events).toHaveLength(1);
  expect(audit.events[0]).toMatchObject({
    targetType: "run",
    targetId: "integrity",
    channel: "mcp",
    agentHost: "Planning Agent",
  });
  await f.post(report);
  // Sequence 3 was reported missing; a shorter valid prefix cannot settle it.
  if (report.lastSequence < 3)
    expect((await f.read()).needsRecovery).toBe(true);
  await f.runtime.submit(
    f.location,
    prepareWorkflowGateAnswer(
      f.current,
      {
        choiceId: "release",
        inputs: { ticket: "REL-67" },
        rationale: "Local review.",
      },
      { subject: "local", authorities: ["operator"] },
    ),
  );
  await f.post(await f.runtime.readReport(f.location));
  expect(
    (await f.read()).integrityFindings.map((finding: any) => finding.code),
  ).not.toContain("event-sequence-gap");
}, 60_000);

it("flags an unattested local decision without losing its immutable event evidence", async () => {
  const f = await fixture();
  await f.post(await f.runtime.readReport(f.location));
  await f.runtime.submit(
    f.location,
    prepareWorkflowGateAnswer(
      f.current,
      {
        choiceId: "release",
        inputs: { ticket: "REL-67" },
        rationale: "Local-only review.",
      },
      { subject: "claimed-reviewer", authorities: ["operator"] },
    ),
  );
  const report = await f.runtime.readReport(f.location);
  await f.post(report);
  await f.post(report);
  expect(await f.read()).toMatchObject({
    needsRecovery: true,
    integrityFindings: [{ code: "unattested-decision" }],
    events: report!.events,
  });
  // A successful local recover cannot invent the missing person's sign-off.
  await f.runtime.recover(f.location);
  await f.post({
    ...report,
    recoveries: [{ requestId: "unattested-recovery", noticeId: null }],
  });
  expect(await f.read()).toMatchObject({
    needsRecovery: true,
    recovery: { outcome: "blocked" },
  });
}, 60_000);

it("requires an explicit recovery outcome to settle a reported interruption and denies other people and hosts", async () => {
  const f = await fixture();
  const report = await f.runtime.readReport(f.location);
  await f.post(report);
  await f.call(
    `${f.route}/recovery`,
    "POST",
    { required: true, requestId: "notice-1" },
    observer,
    403,
  );
  await f.call(
    `${f.route}/recovery`,
    "POST",
    { required: true, requestId: "notice-1" },
    operator,
    403,
  );
  await f.call(
    `${f.route}/recovery`,
    "POST",
    { required: true, requestId: "notice-1" },
    operator,
    200,
    f.operatorToken,
  );
  await f.post(report);
  expect((await f.read()).needsRecovery).toBe(true);
  await f.call(
    `${f.route}/recovery`,
    "POST",
    { required: false },
    operator,
    400,
    f.operatorToken,
  );
  await f.post({
    ...report,
    recoveries: [{ requestId: "explicit-recovery", noticeId: "notice-1" }],
  });
  expect(await f.read()).toMatchObject({
    needsRecovery: false,
    recovery: { outcome: "settled" },
  });
  await f.call(
    `${f.route}/recovery`,
    "POST",
    { required: true, requestId: "notice-1" },
    operator,
    200,
    f.operatorToken,
  );
  await f.post({
    ...report,
    recoveries: [{ requestId: "explicit-recovery", noticeId: "notice-1" }],
  });
  expect((await f.read()).needsRecovery).toBe(false);
  await f.call(
    `${f.route}/recovery`,
    "POST",
    { required: true, requestId: "notice-2" },
    operator,
    200,
    f.operatorToken,
  );
  await f.post({
    ...report,
    recoveries: [{ requestId: "explicit-recovery", noticeId: "notice-1" }],
  });
  expect((await f.read()).needsRecovery).toBe(true);
  await f.post({
    ...report,
    recoveries: [{ requestId: "delayed-first-delivery", noticeId: "notice-1" }],
  });
  expect((await f.read()).needsRecovery).toBe(true);
  await f.post({
    ...report,
    recoveries: [
      { requestId: "new-interruption-recovery", noticeId: "notice-2" },
    ],
  });
  expect((await f.read()).needsRecovery).toBe(false);
  const settled = (await f.read()).recovery;
  await f.call(
    `${f.route}/recovery`,
    "POST",
    {
      required: true,
      requestId: "notice-2",
      revision: f.current.revision,
      recoveries: [{ requestId: "late-blocked-outcome", noticeId: "notice-2" }],
    },
    operator,
    200,
    f.operatorToken,
  );
  expect(await f.read()).toMatchObject({
    needsRecovery: false,
    recovery: settled,
  });
}, 60_000);

it("keeps a package mismatch after refusal and settles recovery only with the bound execution", async () => {
  const f = await fixture();
  const report = (await f.runtime.readReport(f.location))!;
  await f.post(report);
  await f.call(
    "/runs/changed-before-registration",
    "POST",
    {
      workflowId: f.workflow.id,
      publicationId: f.publication.id,
      packageHash: f.publication.packageHash,
      observedPackageHash: "0".repeat(64),
      execution: f.current.execution,
      localRunId: f.location.runId,
      hostLabel: "Lab",
      testRun: false,
    },
    operator,
    200,
    f.operatorToken,
  );
  expect(
    (
      await f.call(
        "/runs/changed-before-registration",
        "GET",
        undefined,
        observer,
      )
    ).run,
  ).toMatchObject({
    needsRecovery: true,
    integrityFindings: [{ code: "package-hash-mismatch" }],
  });
  await f.post(
    {
      ...report,
      projection: {
        ...report.projection,
        execution: {
          ...report.projection.execution,
          packageHash: "0".repeat(64),
        },
      },
    },
    409,
  );
  expect(await f.read()).toMatchObject({
    needsRecovery: true,
    integrityFindings: [{ code: "package-hash-mismatch" }],
    projection: report.projection,
  });
  await f.post({
    ...report,
    recoveries: [{ requestId: "restored-package", noticeId: null }],
  });
  await f.post({
    ...report,
    recoveries: [{ requestId: "restored-package", noticeId: null }],
  });
  expect(await f.read()).toMatchObject({
    needsRecovery: false,
    integrityFindings: [],
    recovery: { outcome: "settled", requestId: "restored-package" },
  });
  const auditor = { subject: "auditor", email: "auditor@example.com" };
  await f.call(
    "/bindings",
    "POST",
    { scopeType: "organization", role: "Auditor", email: auditor.email },
    admin,
    201,
  );
  expect(
    (await f.call(f.route, "GET", undefined, auditor)).run.recovery.outcome,
  ).toBe("settled");
  for (const action of [
    "run.integrity_detected",
    "run.integrity_resolved",
    "run.recovered",
  ])
    expect(
      (
        await f.call(
          `/audit-events?action=${action}&targetId=integrity`,
          "GET",
          undefined,
          auditor,
        )
      ).events,
    ).toHaveLength(1);
  await f.call(`${f.route}/events`, "POST", report, auditor, 403);
}, 60_000);

it("flags changed installed bytes without refusing later reports, and keeps the finding until the bound bytes return", async () => {
  const f = await fixture();
  const register = (observedPackageHash: string | null) =>
    f.call(
      f.route,
      "POST",
      {
        workflowId: f.workflow.id,
        publicationId: f.publication.id,
        packageHash: f.publication.packageHash,
        observedPackageHash,
        execution: f.current.execution,
        localRunId: f.location.runId,
        hostLabel: "Lab",
        testRun: false,
      },
      operator,
      200,
      f.operatorToken,
    );
  const changed = {
    code: "package-hash-mismatch",
    evidence: {
      expectedPackageHash: f.publication.packageHash,
      observedPackageHash: "0".repeat(64),
    },
  };
  await register("0".repeat(64));
  await register("0".repeat(64));
  expect(await f.read()).toMatchObject({
    needsRecovery: true,
    integrityFindings: [changed],
  });
  // Events, the snapshot, and a new gate still arrive; reports keep the finding.
  const report = (await f.runtime.readReport(f.location))!;
  await f.post(report);
  await f.post(report);
  expect(await f.read()).toMatchObject({
    lastSequence: report.lastSequence,
    events: report.events,
    projection: report.projection,
    needsRecovery: true,
    integrityFindings: [changed],
  });
  expect(
    (await f.call(`${f.route}/gates`, "GET", undefined, operator)).gates,
  ).toMatchObject([{ state: "open", actionId: f.current.pendingAction!.id }]);
  await register(null);
  expect((await f.read()).integrityFindings).toMatchObject([
    { evidence: { observedPackageHash: null } },
  ]);
  await register(f.publication.packageHash);
  expect(await f.read()).toMatchObject({
    needsRecovery: false,
    integrityFindings: [],
  });
  const audit = async (action: string) =>
    (
      await f.call(
        `/audit-events?action=${action}&targetId=integrity`,
        "GET",
        undefined,
        admin,
      )
    ).events;
  expect(await audit("run.integrity_detected")).toHaveLength(2);
  expect(await audit("run.integrity_resolved")).toHaveLength(1);
}, 60_000);
