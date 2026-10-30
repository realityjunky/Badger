import { afterEach, expect, it } from "vitest";
import type { TestService } from "../src/testing/index.js";
import { assembledFixture } from "./fixtures/evaluations.js";
import { engineer, owner, startPlanningService } from "./fixtures/planning.js";

let service: TestService;
afterEach(async () => service?.close());

it("runs a confirmed Engineer evaluation as a progress-reporting worker job, retains reports, and notifies only its starter", async () => {
  service = await startPlanningService();
  const { call, base, assembled, secret, plan, planVersion } =
    await assembledFixture(service);
  const initial = await call(`${base}/evaluations`);
  expect(initial.reports).toEqual([]);
  expect(initial.readiness.runtime.state).toBe("blocked");
  const input = {
    confirmed: true,
    packageHash: assembled.packageHash,
    requestId: "evaluate-first",
  };
  await call(
    `${base}/evaluations`,
    "POST",
    { ...input, confirmed: false },
    engineer,
    400,
  );
  await call(`${base}/evaluations`, "POST", input, owner, 403);
  await call(`${base}/evaluations`, "POST", input, engineer, 403, secret);
  const { job } = await call(
    `${base}/evaluations`,
    "POST",
    input,
    engineer,
    202,
  );
  expect(job).toMatchObject({ kind: "evaluate", status: "queued" });
  expect(
    (await call(`${base}/evaluations`, "POST", input, engineer, 202)).job.id,
  ).toBe(job.id);
  const worker = service.worker();
  const claimed = await worker.claim();
  expect(claimed?.id).toBe(job.id);
  expect((await call(`${base}/evaluations`)).jobs[0].status).toBe("running");
  const processing = worker.process(claimed!);
  await expect
    .poll(
      async () => (await call(`${base}/evaluations`)).jobs[0].progress?.phase,
    )
    .toBeTruthy();
  const finished = await processing;
  expect(finished.status).toBe("succeeded");
  const first = await call(`${base}/evaluations`);
  expect(first.reports).toHaveLength(1);
  expect(first.reports[0]).toMatchObject({
    jobId: job.id,
    packageHash: assembled.packageHash,
    starterId: job.requesterId,
    report: {
      passed: true,
      hash: assembled.packageHash,
      authoringCrossValidation: { passed: true },
    },
  });
  expect(first.reports[0].durationMilliseconds).toBeGreaterThan(0);
  expect(
    Object.keys(first.reports[0].report.runtime.phase3.negativeCases).length,
  ).toBeGreaterThan(0);
  expect(first.readiness.runtime.state).toBe("ready");
  expect(first.passingReportId).toBe(first.reports[0].id);
  const inbox = (await call("/me/inbox")).items.filter(
    (item: any) => item.kind === "evaluation-finished",
  );
  expect(inbox).toHaveLength(1);
  expect(inbox[0].href).toContain("/evaluations?");
  expect(
    (await call("/me/inbox", "GET", undefined, owner)).items.some(
      (item: any) => item.kind === "evaluation-finished",
    ),
  ).toBe(false);
  const immutable = first.reports[0];
  await call(
    `${base}/evaluations`,
    "POST",
    { ...input, requestId: "evaluate-second" },
    engineer,
    202,
  );
  await service.worker().runOnce();
  const second = await call(`${base}/evaluations`);
  expect(second.reports).toHaveLength(2);
  expect(
    second.reports.find((report: any) => report.id === immutable.id),
  ).toEqual(immutable);
  expect((await call(`${base}/package`)).package.assembledHash).toBe(
    assembled.packageHash,
  );
  plan.workflow.customNodes[0].responsibility =
    "Prepare a report with a revised scope.";
  const { dossierHash } = await call(`${base}/plan`);
  const { composition } = await call(`${base}/plan/preview`, "POST", {
    plan,
    dossierHash,
  });
  await call(
    `${base}/plan/save`,
    "POST",
    {
      plan,
      dossierHash,
      confirmationHash: composition.hash,
      expectedVersionId: planVersion.id,
    },
    engineer,
    201,
  );
  const superseded = await call(`${base}/evaluations`);
  expect(superseded.passingReportId).toBeNull();
  expect(superseded.readiness.runtime.state).toBe("blocked");
  expect(superseded.reports).toEqual(second.reports);
}, 90_000);

it("refuses a mismatched package hash and cancels queued evaluations when an upstream Plan changes", async () => {
  service = await startPlanningService();
  const { call, base, assembled, plan, planVersion } =
    await assembledFixture(service);
  await call(
    `${base}/evaluations`,
    "POST",
    { confirmed: true, packageHash: "0".repeat(64), requestId: "wrong-hash" },
    engineer,
    409,
  );
  const { job } = await call(
    `${base}/evaluations`,
    "POST",
    {
      confirmed: true,
      packageHash: assembled.packageHash,
      requestId: "stale-evaluation",
    },
    engineer,
    202,
  );
  plan.workflow.customNodes[0].responsibility =
    "Prepare a report with its changed evidence scope.";
  const { dossierHash } = await call(`${base}/plan`);
  const { composition } = await call(`${base}/plan/preview`, "POST", {
    plan,
    dossierHash,
  });
  await call(
    `${base}/plan/save`,
    "POST",
    {
      plan,
      dossierHash,
      confirmationHash: composition.hash,
      expectedVersionId: planVersion.id,
    },
    engineer,
    201,
  );
  const view = await call(`${base}/evaluations`);
  expect(view.jobs.find((entry: any) => entry.id === job.id).status).toBe(
    "cancelled",
  );
  expect(view.currentPackageHash).toBeNull();
  expect(view.passingReportId).toBeNull();
  expect(await service.worker().runOnce()).toBeNull();
}, 60_000);

it("keeps reports, inbox, and committed package state atomic when a worker completion transaction fails", async () => {
  service = await startPlanningService();
  const { call, base, assembled } = await assembledFixture(service);
  const before = await call(`${base}/package`);
  await call(
    `${base}/evaluations`,
    "POST",
    {
      confirmed: true,
      packageHash: assembled.packageHash,
      requestId: "transaction-retry",
    },
    engineer,
    202,
  );
  const worker = service.worker();
  const claimed = await worker.claim();
  service.failNextTransaction("40001");
  await expect(worker.process(claimed!)).rejects.toThrow();
  expect((await call(`${base}/evaluations`)).reports).toEqual([]);
  expect(
    (await call("/me/inbox")).items.some(
      (item: any) => item.kind === "evaluation-finished",
    ),
  ).toBe(false);
  expect((await call(`${base}/package`)).currentStateHash).toBe(
    before.currentStateHash,
  );
  expect((await worker.process(claimed!)).status).toBe("succeeded");
  const completed = await call(`${base}/evaluations`);
  expect(completed.reports).toHaveLength(1);
  expect(completed.passingReportId).toBe(completed.reports[0].id);
  expect((await call(`${base}/package`)).currentStateHash).toBe(
    before.currentStateHash,
  );
}, 90_000);
