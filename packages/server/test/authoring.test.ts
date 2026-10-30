import { reportLaneOutput } from "./fixtures/authoring.js";
import { afterEach, expect, it } from "vitest";
import type { TestService } from "../src/testing/index.js";
import { engineer, startPlanningService } from "./fixtures/planning.js";
import { initializedFixture } from "./fixtures/packages.js";

let service: TestService;
afterEach(async () => service?.close());

async function generated() {
  service = await startPlanningService();
  const fixture = await initializedFixture(service);
  const { call, base, approve } = fixture;
  const before = await call(`${base}/package`);
  const { confirmation } = await approve("generation");
  await call(
    `${base}/package/generate`,
    "POST",
    {
      confirmed: true,
      confirmationHash: confirmation.confirmationHash,
      stateHash: before.currentStateHash,
      requestId: "generate-authoring",
    },
    engineer,
    202,
  );
  expect((await service.worker().runOnce())?.status).toBe("succeeded");
  return fixture;
}

it("offers only current Wave lanes as bounded Agent jobs and keeps submitted output out of the authoring session until acceptance", async () => {
  const { call, base } = await generated();
  const { jobs } = await call(
    `${base}/package/authoring-jobs`,
    "POST",
    { confirmed: true },
    engineer,
    201,
  );
  expect(jobs.map((j: any) => j.laneId)).toEqual([
    "script",
    "reference",
    "pause-points",
  ]);
  const script = jobs.find((j: any) => j.laneId === "script");
  const { secret } = await call(
    "/me/tokens",
    "POST",
    { name: "authoring", scopes: ["engineer"] },
    engineer,
    201,
  );
  const path = `${base}/drafting-jobs/${script.id}`;
  const claimed = await call(
    `${path}/claim`,
    "POST",
    { revision: script.revision },
    engineer,
    200,
    secret,
  );
  expect(claimed.contextBundle.authoring).toMatchObject({
    lane: "script",
    handoff: { capabilities: { writeCreatorState: false } },
  });
  expect(claimed.contextBundle.authoring.files.length).toBeGreaterThan(2);
  const laneOutput = {
    semanticDossierHash:
      claimed.contextBundle.authoring.plan.semanticDossierHash,
    lane: "script",
    status: "NEEDS_CONTEXT",
    summary: "Clarify report inputs.",
    action: {
      kind: "question",
      prompt: "Which report fields are mandatory?",
      requirement: "/nodes/0/responsibility",
    },
    claims: [],
    artifacts: [],
  };
  const { job: submitted } = await call(
    `${path}/submit`,
    "POST",
    {
      leaseId: claimed.job.lease.id,
      contextHash: claimed.job.contextHash,
      result: { laneOutput },
    },
    engineer,
    200,
    secret,
  );
  expect(
    (await call(`${base}/package/authoring`)).readiness.records.script,
  ).toBeUndefined();
  const decision = { revision: submitted.revision, laneOutput };
  const { preview } = await call(`${path}/accept-preview`, "POST", decision);
  await call(`${path}/accept`, "POST", {
    ...decision,
    confirmed: true,
    confirmationHash: preview.confirmationHash,
    requestId: "accept-script",
  });
  const view = await call(`${base}/package/authoring`);
  expect(view.readiness.records.script).toMatchObject({
    status: "NEEDS_CONTEXT",
    revision: 2,
  });
  expect(view.followUps).toContainEqual(
    expect.objectContaining({
      laneId: "script",
      questionId: expect.any(String),
    }),
  );
  await call(`${base}/package/assemble-preview`, "POST", {}, engineer, 409);
});

it("records accepted lanes in revision order, unlocks dependent jobs and review votes, then confirms assembly for the exact session", async () => {
  const { call, base } = await generated();
  const { secret } = await call(
    "/me/tokens",
    "POST",
    { name: "lanes", scopes: ["engineer"] },
    engineer,
    201,
  );
  const accepted: string[] = [];
  for (let wave = 0; wave < 3; wave++) {
    const { jobs } = await call(
      `${base}/package/authoring-jobs`,
      "POST",
      { confirmed: true },
      engineer,
      201,
    );
    expect(jobs.length).toBeGreaterThan(0);
    if (wave === 2)
      expect(jobs[0]).toMatchObject({
        kind: "review-vote",
        laneId: "skill-review",
      });
    for (const job of jobs) {
      const route = `${base}/drafting-jobs/${job.id}`;
      const claim = await call(
        `${route}/claim`,
        "POST",
        { revision: job.revision },
        engineer,
        200,
        secret,
      );
      const laneOutput = reportLaneOutput(claim.contextBundle);
      const { job: submitted } = await call(
        `${route}/submit`,
        "POST",
        {
          leaseId: claim.job.lease.id,
          contextHash: claim.job.contextHash,
          result: { laneOutput },
        },
        engineer,
        200,
        secret,
      );
      const decision = { revision: submitted.revision, laneOutput };
      const { preview } = await call(
        `${route}/accept-preview`,
        "POST",
        decision,
      );
      await call(`${route}/accept`, "POST", {
        ...decision,
        confirmed: true,
        confirmationHash: preview.confirmationHash,
        requestId: `accept-${job.laneId}`,
      });
      accepted.push(job.laneId);
      const view = await call(`${base}/package/authoring`);
      expect(view.readiness.records[job.laneId].revision).toBe(
        accepted.length + 1,
      );
    }
  }
  expect(accepted).toEqual([
    "script",
    "reference",
    "pause-points",
    "workflow-entry",
    "skill-core",
    "skill-review",
  ]);
  const { preview } = await call(
    `${base}/package/assemble-preview`,
    "POST",
    {},
  );
  await call(
    `${base}/package/assemble`,
    "POST",
    {
      confirmed: false,
      confirmationHash: preview.confirmationHash,
      requestId: "assembly",
    },
    engineer,
    400,
  );
  const result = await call(`${base}/package/assemble`, "POST", {
    confirmed: true,
    confirmationHash: preview.confirmationHash,
    requestId: "assembly",
  });
  expect(result.packageHash).toMatch(/^[a-f0-9]{64}$/u);
  const assembled = await call(`${base}/package`);
  expect(assembled.package.assembledHash).toBe(result.packageHash);
  expect((await call(`${base}/package/file?path=SKILL.md`)).text).toContain(
    "A topic change requires",
  );
  expect((await call(`${base}/package/file?path=SKILL.md`)).text).not.toContain(
    "AUTHORING PENDING",
  );
  expect((await call(`${base}/package/authoring`)).readiness.status).toBe(
    "assembled",
  );
  expect(
    await call(`${base}/package/assemble`, "POST", {
      confirmed: true,
      confirmationHash: preview.confirmationHash,
      requestId: "assembly",
    }),
  ).toEqual(result);
});

it("returns a rejected lane with its reason, turns BLOCKED into a linked repair job, and refuses Agent sign-off", async () => {
  const { call, base } = await generated();
  const { jobs } = await call(
    `${base}/package/authoring-jobs`,
    "POST",
    { confirmed: true },
    engineer,
    201,
  );
  const { secret } = await call(
    "/me/tokens",
    "POST",
    { name: "repair", scopes: ["engineer"] },
    engineer,
    201,
  );
  const first = jobs[0],
    route = `${base}/drafting-jobs/${first.id}`;
  const claim = await call(
    `${route}/claim`,
    "POST",
    { revision: first.revision },
    engineer,
    200,
    secret,
  );
  const laneOutput = {
    lane: first.laneId,
    status: "BLOCKED",
    semanticDossierHash: claim.contextBundle.authoring.plan.semanticDossierHash,
    claims: [],
    artifacts: [],
    summary: "The declared evidence cannot be produced.",
    action: {
      kind: "repair",
      prompt: "Repair the report evidence mapping.",
      requirement: "Match the approved report evidence.",
    },
  };
  const { job: submitted } = await call(
    `${route}/submit`,
    "POST",
    {
      leaseId: claim.job.lease.id,
      contextHash: claim.job.contextHash,
      result: { laneOutput },
    },
    engineer,
    200,
    secret,
  );
  await call(
    `${route}/accept-preview`,
    "POST",
    { revision: submitted.revision, laneOutput },
    engineer,
    403,
    secret,
  );
  const decision = {
    revision: submitted.revision,
    reason: "The missing evidence has not been identified.",
  };
  const { preview } = await call(`${route}/reject-preview`, "POST", decision);
  const rejected = await call(`${route}/reject`, "POST", {
    ...decision,
    confirmed: true,
    confirmationHash: preview.confirmationHash,
    requestId: "reject-lane",
  });
  expect(rejected.job).toMatchObject({
    status: "rejected",
    decision: { decision: { reason: decision.reason } },
  });
  expect(
    (await call(`${base}/package/authoring`)).readiness.records[first.laneId],
  ).toBeUndefined();
  const retry = (
    await call(
      `${base}/package/authoring-jobs`,
      "POST",
      { confirmed: true },
      engineer,
      201,
    )
  ).jobs[0];
  const retryRoute = `${base}/drafting-jobs/${retry.id}`;
  const retryClaim = await call(
    `${retryRoute}/claim`,
    "POST",
    { revision: retry.revision },
    engineer,
    200,
    secret,
  );
  const { job: blocked } = await call(
    `${retryRoute}/submit`,
    "POST",
    {
      leaseId: retryClaim.job.lease.id,
      contextHash: retryClaim.job.contextHash,
      result: { laneOutput },
    },
    engineer,
    200,
    secret,
  );
  const accepted = { revision: blocked.revision, laneOutput };
  const acceptedPreview = await call(
    `${retryRoute}/accept-preview`,
    "POST",
    accepted,
  );
  await call(`${retryRoute}/accept`, "POST", {
    ...accepted,
    confirmed: true,
    confirmationHash: acceptedPreview.preview.confirmationHash,
    requestId: "accept-blocked",
  });
  const view = await call(`${base}/package/authoring`);
  expect(view.followUps).toContainEqual(
    expect.objectContaining({
      laneId: first.laneId,
      repairJobId: expect.any(String),
      questionId: null,
    }),
  );
  expect(
    view.jobs.filter(
      (j: any) => j.laneId === first.laneId && j.status === "queued",
    ),
  ).toHaveLength(1);
});

it("keeps authoring unchanged after a failed acceptance transaction and replays the person's retry once", async () => {
  const { call, base } = await generated();
  const { jobs } = await call(
    `${base}/package/authoring-jobs`,
    "POST",
    { confirmed: true },
    engineer,
    201,
  );
  const route = `${base}/drafting-jobs/${jobs[0].id}`;
  const claim = await call(`${route}/claim`, "POST", {
    revision: jobs[0].revision,
  });
  const laneOutput = reportLaneOutput(claim.contextBundle);
  const { job } = await call(`${route}/submit`, "POST", {
    leaseId: claim.job.lease.id,
    contextHash: claim.job.contextHash,
    result: { laneOutput },
  });
  const decision = { revision: job.revision, laneOutput };
  const { preview } = await call(`${route}/accept-preview`, "POST", decision);
  const before = await call(`${base}/package`);
  const body = {
    ...decision,
    confirmed: true,
    confirmationHash: preview.confirmationHash,
    requestId: "accept-retry",
  };
  service.failNextTransaction("40001");
  await call(`${route}/accept`, "POST", body, engineer, 503);
  expect((await call(`${base}/package`)).currentStateHash).toBe(
    before.currentStateHash,
  );
  const accepted = await call(`${route}/accept`, "POST", body);
  expect(accepted.job.decision.authoringRevision).toBe(2);
  expect(await call(`${route}/accept`, "POST", body)).toEqual(accepted);
});
