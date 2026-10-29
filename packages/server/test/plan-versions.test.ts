import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { TestService } from "../src/testing/index.js";
import {
  engineer,
  owner,
  observer,
  planningFixture,
  startPlanningService,
} from "./fixtures/planning.js";

let service: TestService;
afterEach(async () => service?.close());

it("derives and saves immutable canonical plan versions only from the currently approved dossier, with live kernel findings", async () => {
  service = await startPlanningService();
  const { call, base, dossier, approve } = await planningFixture(service);
  expect((await call(`${base}/plan`)).skeleton).toBeNull();
  await approve("dossier", owner);
  const { skeleton, dossierHash } = await call(`${base}/plan`);
  expect(dossierHash).toBe(dossier.hash);
  expect(skeleton).toMatchObject({
    goal: "Prepare a reviewed report.",
    skillCreatorIntent: "new-skill",
    defaultLocale: "en",
    workflow: {
      name: "report",
      goal: "Prepare a reviewed report.",
      customNodes: [{ id: "report" }],
    },
    skillSources: [{ name: "prepare", location: "skills/prepare" }],
  });
  const plan = structuredClone(skeleton);
  plan.workflow.customNodes[0].implementation.skill = "prepare";
  const invalid = await call(`${base}/plan/preview`, "POST", {
    plan: { ...plan, goal: "Changed meaning" },
    dossierHash,
  });
  expect(invalid.composition.findings).toContainEqual(
    expect.objectContaining({ path: "goal" }),
  );
  await call(
    `${base}/plan/save`,
    "POST",
    {
      plan: invalid.composition.snapshot.plan,
      dossierHash,
      confirmationHash: invalid.composition.hash,
      expectedVersionId: null,
    },
    engineer,
    409,
  );
  const { composition } = await call(`${base}/plan/preview`, "POST", {
    plan,
    dossierHash,
  });
  expect(composition.findings).toEqual([]);
  const body = {
    plan,
    dossierHash,
    confirmationHash: composition.hash,
    expectedVersionId: null,
  };
  const { version } = await call(
    `${base}/plan/save`,
    "POST",
    body,
    engineer,
    201,
  );
  expect(version.snapshot.dossierHash).toBe(dossier.hash);
  expect(version.hash).toBe(
    createHash("sha256").update(version.canonicalJson).digest("hex"),
  );
  expect(
    (
      await call(`${base}/plan/save`, "POST", {
        ...body,
        plan: Object.fromEntries(Object.entries(plan).reverse()),
      })
    ).version,
  ).toEqual(version);
  expect((await call(`${base}/plan`)).versions).toEqual([version]);
});

it("invalidates plan sign-off and cancels drafting when a dossier fact changes", async () => {
  service = await startPlanningService();
  const { call, base, approve, record, factContent } =
    await planningFixture(service);
  await approve("dossier", owner);
  const { skeleton: plan, dossierHash } = await call(`${base}/plan`);
  plan.workflow.customNodes[0].implementation.skill = "prepare";
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
      expectedVersionId: null,
    },
    engineer,
    201,
  );
  await approve("plan", owner);
  const { job } = await call(
    `${base}/drafting-jobs`,
    "POST",
    { kind: "draft-plan", confirmed: true },
    engineer,
    201,
  );
  const claimed = await call(`${base}/drafting-jobs/${job.id}/claim`, "POST", {
    revision: job.revision,
  });
  await call(`${base}/source-study/facts/${record.id}`, "PATCH", {
    ...factContent,
    revision: 1,
    statement: "Return a report with an additional safety review.",
  });
  expect(
    (await call(`${base}/gates/plan`)).confirmation.invalidatedAt,
  ).not.toBeNull();
  expect((await call(`${base}/plan`)).skeleton).toBeNull();
  await call(`${base}/gates/plan/preview`, "POST", {}, owner, 409);
  await call(
    `${base}/drafting-jobs/${job.id}/submit`,
    "POST",
    {
      leaseId: claimed.job.lease.id,
      contextHash: job.contextHash,
      result: { plan },
    },
    engineer,
    409,
  );
  expect((await call(`${base}/drafting-jobs/${job.id}`)).job.status).toBe(
    "cancelled",
  );
});

it("refuses concurrent plan edits and stale approval previews while preserving earlier versions", async () => {
  service = await startPlanningService();
  const { call, base, approve } = await planningFixture(service);
  await approve("dossier", owner);
  const { skeleton: plan, dossierHash } = await call(`${base}/plan`);
  plan.workflow.customNodes[0].implementation.skill = "prepare";
  const preview = async (plan: unknown) =>
    (await call(`${base}/plan/preview`, "POST", { plan, dossierHash }))
      .composition;
  const first = await preview(plan);
  const { version } = await call(
    `${base}/plan/save`,
    "POST",
    {
      plan,
      dossierHash,
      confirmationHash: first.hash,
      expectedVersionId: null,
    },
    engineer,
    201,
  );
  const { preview: gate } = await call(
    `${base}/gates/plan/preview`,
    "POST",
    {},
    owner,
  );
  await approve("plan", owner);
  const left = structuredClone(plan);
  left.workflow.customNodes[0].label = "Engineer A's edit";
  const right = structuredClone(plan);
  right.workflow.customNodes[0].label = "Engineer B's edit";
  const a = await preview(left),
    b = await preview(right);
  await call(
    `${base}/plan/save`,
    "POST",
    {
      plan: left,
      dossierHash,
      confirmationHash: a.hash,
      expectedVersionId: version.id,
    },
    engineer,
    201,
  );
  await call(
    `${base}/plan/save`,
    "POST",
    {
      plan: right,
      dossierHash,
      confirmationHash: b.hash,
      expectedVersionId: version.id,
    },
    engineer,
    409,
  );
  await call(
    `${base}/gates/plan/commit`,
    "POST",
    { confirmationHash: gate.confirmationHash, requestId: "stale-plan" },
    owner,
    409,
  );
  const view = await call(`${base}/plan`);
  expect(view.versions).toHaveLength(2);
  expect(view.versions[1]).toEqual(version);
  expect(view.confirmation.invalidatedAt).not.toBeNull();
});

it("keeps an Agent's plan as a suggestion until an Engineer reviews and accepts edited content", async () => {
  service = await startPlanningService();
  const { call, base, dossier, approve } = await planningFixture(service);
  await approve("dossier", owner);
  const { secret } = await call(
    "/me/tokens",
    "POST",
    { name: "Planner", scopes: ["engineer"] },
    engineer,
    201,
  );
  const jobs = `${base}/drafting-jobs`;
  const { job } = await call(
    jobs,
    "POST",
    { kind: "draft-plan", confirmed: true },
    engineer,
    201,
  );
  const claimed = await call(
    `${jobs}/${job.id}/claim`,
    "POST",
    { revision: job.revision },
    engineer,
    200,
    secret,
  );
  expect(claimed.contextBundle.planning.input.dossierHash).toBe(dossier.hash);
  const plan = claimed.contextBundle.planning.skeleton;
  plan.workflow.customNodes[0].implementation.skill = "prepare";
  const lease = { leaseId: claimed.job.lease.id, contextHash: job.contextHash };
  await call(
    `${jobs}/${job.id}/submit`,
    "POST",
    { ...lease, result: { questions: [] } },
    engineer,
    400,
    secret,
  );
  const { job: submitted } = await call(
    `${jobs}/${job.id}/submit`,
    "POST",
    { ...lease, result: { plan } },
    engineer,
    200,
    secret,
  );
  expect((await call(`${base}/plan`)).versions).toEqual([]);
  plan.workflow.customNodes[0].label = "Prepare the reviewed report";
  const decision = { revision: submitted.revision, plan };
  await call(
    `${jobs}/${job.id}/accept-preview`,
    "POST",
    decision,
    engineer,
    403,
    secret,
  );
  const { preview } = await call(
    `${jobs}/${job.id}/accept-preview`,
    "POST",
    decision,
  );
  const body = {
    ...decision,
    confirmed: true,
    confirmationHash: preview.confirmationHash,
    requestId: "accept-plan",
  };
  const accepted = await call(`${jobs}/${job.id}/accept`, "POST", body);
  expect(accepted.job.status).toBe("accepted");
  const view = await call(`${base}/plan`);
  expect(view.versions).toHaveLength(1);
  expect(view.versions[0].snapshot.plan.workflow.customNodes[0].label).toBe(
    "Prepare the reviewed report",
  );
  expect(view.confirmation).toBeNull();
  expect(await call(`${jobs}/${job.id}/accept`, "POST", body)).toEqual(
    accepted,
  );
  await call(`${base}/gates/plan/preview`, "POST", {}, engineer, 403, secret);
});

it("reserves hash-bound plan approval for the owner and supersedes it when the dossier is replaced, preserving history and retries", async () => {
  service = await startPlanningService();
  const { call, base, approve, semantics } = await planningFixture(service);
  await approve("dossier", owner);
  const { skeleton: plan, dossierHash } = await call(`${base}/plan`);
  plan.workflow.customNodes[0].implementation.skill = "prepare";
  const { composition } = await call(`${base}/plan/preview`, "POST", {
    plan,
    dossierHash,
  });
  const { version } = await call(
    `${base}/plan/save`,
    "POST",
    {
      plan,
      dossierHash,
      confirmationHash: composition.hash,
      expectedVersionId: null,
    },
    engineer,
    201,
  );
  await call(`${base}/gates/plan/preview`, "POST", {}, engineer, 403);
  await call(`${base}/gates/plan/preview`, "POST", {}, observer, 403);
  await call(`${base}/plan/preview`, "POST", { plan, dossierHash }, owner, 403);
  const approved = await approve("plan", owner);
  expect(approved.confirmation.boundHashes).toMatchObject({
    plan: version.hash,
    dossier: dossierHash,
  });
  const changed = {
    ...semantics,
    topics: {
      ...semantics.topics,
      inputs: {
        ...semantics.topics.inputs,
        summary: "Use only the agreed report scope.",
      },
    },
  };
  const { composition: next } = await call(
    `${base}/dossier/preview`,
    "POST",
    changed,
  );
  await call(
    `${base}/dossier/compose`,
    "POST",
    { ...changed, confirmationHash: next.hash },
    engineer,
    201,
  );
  const view = await call(`${base}/plan`);
  expect(view.currentVersionId).toBeNull();
  expect(view.versions).toEqual([version]);
  const history = await call(`${base}/gates/plan`);
  expect(history.confirmation.invalidatedAt).not.toBeNull();
  expect(
    (await call(`${base}/gates/plan/commit`, "POST", approved.body, owner))
      .confirmation,
  ).toEqual(approved.confirmation);
  await call(`${base}/gates/plan/preview`, "POST", {}, owner, 409);
  await call(
    `${base}/plan/save`,
    "POST",
    {
      plan,
      dossierHash,
      confirmationHash: composition.hash,
      expectedVersionId: version.id,
    },
    engineer,
    409,
  );
  for (const person of [engineer, owner]) {
    const inbox = await call("/me/inbox", "GET", undefined, person);
    expect(inbox.items).toContainEqual(
      expect.objectContaining({
        gate: "plan",
        kind: "gate-invalidated",
        state: "unread",
      }),
    );
  }
});
