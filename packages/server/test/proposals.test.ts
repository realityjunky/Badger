import { afterEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { TestService } from "../src/testing/index.js";
import {
  admin,
  engineer,
  owner,
  observer,
  planningFixture,
  startPlanningService,
} from "./fixtures/planning.js";

let service: TestService;
afterEach(async () => service?.close());

async function approvedPlan() {
  const fixture = await planningFixture(service);
  const { call, base, approve } = fixture;
  await approve("dossier", owner);
  const { skeleton: plan, dossierHash } = await call(`${base}/plan`);
  plan.workflow.customNodes[0].implementation.skill = "prepare";
  const { composition } = await call(`${base}/plan/preview`, "POST", {
    plan,
    dossierHash,
  });
  const { version: planVersion } = await call(
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
  return { ...fixture, plan, planVersion };
}

it("previews the kernel proposal and source identities only for the current approved plan", async () => {
  service = await startPlanningService();
  const { call, base, approve, planVersion, skill } = await approvedPlan();
  expect((await call(`${base}/proposal`)).proposal).toBeNull();
  await approve("plan", owner);
  const view = await call(`${base}/proposal`);
  expect(view.planVersionHash).toBe(planVersion.hash);
  expect(view.proposal).toMatchObject({
    name: "report",
    goal: "Prepare a reviewed report.",
    canInitialize: true,
    blockers: [],
    sources: [
      {
        id: skill.id,
        name: "prepare",
        location: "skills/prepare",
        status: "available",
      },
    ],
  });
  expect(view.proposal.proposalHash).toMatch(/^[a-f0-9]{64}$/u);
  expect(view.proposal.sources[0].hash).toBe(
    planVersion.snapshot.plan.semanticDossier.sources[0].contentHash,
  );
  expect((await call(`${base}/proposal`)).proposal).toEqual(view.proposal);
});

it("binds the owner's proposal approval and initializes through a durable job", async () => {
  service = await startPlanningService();
  const { call, base, approve, planVersion } = await approvedPlan();
  await approve("plan", owner);
  const { proposal } = await call(`${base}/proposal`);
  const { confirmation } = await approve("proposal", owner);
  expect(confirmation.boundHashes).toMatchObject({
    plan: planVersion.hash,
    proposal: proposal.proposalHash,
  });
  const { job } = await call(
    `${base}/proposal/initialize`,
    "POST",
    {
      proposalHash: proposal.proposalHash,
      confirmed: true,
      requestId: "initialize-first",
    },
    engineer,
    202,
  );
  expect(job).toMatchObject({
    kind: "init",
    status: "queued",
    proposalHash: proposal.proposalHash,
  });
  expect((await call(`${base}/proposal`)).currentState).toBeNull();
  await service.worker().runOnce();
  const view = await call(`${base}/proposal`);
  expect(view.jobs[0]).toMatchObject({ id: job.id, status: "succeeded" });
  expect(view.currentState).toMatchObject({
    proposalHash: proposal.proposalHash,
    planVersionHash: planVersion.hash,
  });
  expect(view.currentState.hash).toMatch(/^[a-f0-9]{64}$/u);
  const detail = await call(base);
  expect(detail.version.stages).toContainEqual({
    id: "plan-proposal",
    state: "done",
  });
  expect(detail.version.stages).toContainEqual({
    id: "package",
    state: "active",
  });
});

it("invalidates proposal approval, notifies both roles, and cancels claimed initialization when the plan changes", async () => {
  service = await startPlanningService();
  const { call, base, approve, plan, planVersion } = await approvedPlan();
  await approve("plan", owner);
  const approved = await approve("proposal", owner);
  await call(
    `${base}/proposal/initialize`,
    "POST",
    {
      proposalHash: approved.confirmation.boundHashes.proposal,
      confirmed: true,
      requestId: "stale-init",
    },
    engineer,
    202,
  );
  const worker = service.worker();
  const claimed = await worker.claim();
  expect(claimed?.kind).toBe("init");
  plan.workflow.customNodes[0].label = "Reviewed report";
  const body = { plan, dossierHash: planVersion.snapshot.dossierHash };
  const { composition } = await call(`${base}/plan/preview`, "POST", body);
  await call(
    `${base}/plan/save`,
    "POST",
    {
      ...body,
      confirmationHash: composition.hash,
      expectedVersionId: planVersion.id,
    },
    engineer,
    201,
  );
  const history = await call(`${base}/gates/proposal`);
  expect(history.confirmation.invalidatedAt).not.toBeNull();
  expect(history.confirmation.invalidationReason).toContain("plan");
  expect(
    await call(`${base}/gates/proposal/commit`, "POST", approved.body, owner),
  ).toEqual({ confirmation: approved.confirmation });
  for (const as of [owner, engineer]) {
    const { items } = await call("/me/inbox", "GET", undefined, as);
    expect(items).toContainEqual(
      expect.objectContaining({
        gate: "proposal",
        kind: "gate-invalidated",
        href: `${base}#proposal`,
      }),
    );
  }
  expect((await worker.process(claimed!)).status).toBe("cancelled");
  expect((await call(`${base}/proposal`)).currentState).toBeNull();
  await call(`${base}/gates/proposal/preview`, "POST", {}, owner, 409);
});

it("requires the current state's exact hash for replacement and never lets queued replacements overwrite each other", async () => {
  service = await startPlanningService();
  const { call, base, approve } = await approvedPlan();
  await approve("plan", owner);
  const { proposal } = await call(`${base}/proposal`);
  const body = {
    proposalHash: proposal.proposalHash,
    confirmed: true,
    requestId: "first",
  };
  await call(`${base}/proposal/initialize`, "POST", body, engineer, 409);
  await approve("proposal", owner);
  const first = await call(
    `${base}/proposal/initialize`,
    "POST",
    body,
    engineer,
    202,
  );
  const abandoned = await service
    .worker("abandoned", { leaseMilliseconds: 1000 })
    .claim();
  expect(abandoned?.id).toBe(first.job.id);
  service.clock.advance(1001);
  expect((await service.worker("replacement-worker").runOnce())?.status).toBe(
    "succeeded",
  );
  const { currentState: state } = await call(`${base}/proposal`);
  expect((await service.worker("abandoned").process(abandoned!)).status).toBe(
    "succeeded",
  );
  const replay = await call(
    `${base}/proposal/initialize`,
    "POST",
    body,
    engineer,
    202,
  );
  expect(replay.job.id).toBe(first.job.id);
  await call(
    `${base}/proposal/initialize`,
    "POST",
    { ...body, requestId: "no-quote" },
    engineer,
    409,
  );
  await call(
    `${base}/proposal/initialize`,
    "POST",
    { ...body, requestId: "wrong-quote", replaceStateHash: "0".repeat(64) },
    engineer,
    409,
  );
  for (const requestId of ["replace-a", "replace-b"])
    await call(
      `${base}/proposal/initialize`,
      "POST",
      { ...body, requestId, replaceStateHash: state.hash },
      engineer,
      202,
    );
  expect((await service.worker().runOnce())?.status).toBe("succeeded");
  expect((await service.worker().runOnce())?.status).toBe("failed");
  const view = await call(`${base}/proposal`);
  expect(view.currentState.revision).toBe(2);
  expect(view.currentState.hash).not.toBe(state.hash);
  expect(view.jobs).toHaveLength(3);
  expect(
    view.jobs.find(
      (job: { requestId: string }) => job.requestId === "replace-b",
    ).error,
  ).toContain("Creator state changed");
});

it("reserves proposal sign-off and initialization for the responsible signed-in people", async () => {
  service = await startPlanningService();
  const { call, base, approve } = await approvedPlan();
  await approve("plan", owner);
  await call(`${base}/gates/proposal/preview`, "POST", {}, engineer, 403);
  await call(`${base}/gates/proposal/preview`, "POST", {}, observer, 403);
  const { secret } = await call(
    "/me/tokens",
    "POST",
    { name: "Proposal Agent", scopes: ["engineer"] },
    owner,
    201,
  );
  const { proposal } = await call(
    `${base}/proposal`,
    "GET",
    undefined,
    owner,
    200,
    secret,
  );
  await call(`${base}/gates/proposal/preview`, "POST", {}, owner, 403, secret);
  const approved = await approve("proposal", owner);
  await call(
    `${base}/gates/proposal/commit`,
    "POST",
    approved.body,
    owner,
    403,
    secret,
  );
  const body = {
    proposalHash: proposal.proposalHash,
    requestId: "denied",
    confirmed: true,
  };
  for (const as of [owner, observer])
    await call(`${base}/proposal/initialize`, "POST", body, as, 403);
  await call(`${base}/proposal/initialize`, "POST", body, owner, 403, secret);
  await call(
    `${base}/proposal/initialize`,
    "POST",
    { ...body, confirmed: false },
    engineer,
    400,
  );
  expect((await call(`${base}/proposal`)).jobs).toEqual([]);
});

it("shows kernel blockers and refuses stale approval and initialization after source files drift", async () => {
  service = await startPlanningService();
  const { call, base, approve, version } = await approvedPlan();
  await approve("plan", owner);
  const { preview } = await call(
    `${base}/gates/proposal/preview`,
    "POST",
    {},
    owner,
  );
  const approved = await approve("proposal", owner);
  const { job } = await call(
    `${base}/proposal/initialize`,
    "POST",
    {
      proposalHash: approved.confirmation.boundHashes.proposal,
      confirmed: true,
      requestId: "source-drift",
    },
    engineer,
    202,
  );
  await fs.writeFile(
    path.join(
      service.config.storage.workspaceDirectory,
      "workflow-versions",
      version.id,
      "skills/prepare/SKILL.md",
    ),
    "---\nname: prepare\ndescription: changed source\n---\n\nChanged report instructions.\n",
  );
  const view = await call(`${base}/proposal`);
  expect(view.proposal.canInitialize).toBe(false);
  expect(view.proposal.blockers).toContain(
    "Semantic dossier source identity is stale: prepare",
  );
  expect(view.proposal.proposalHash).not.toBe(
    approved.confirmation.boundHashes.proposal,
  );
  await call(`${base}/gates/proposal/preview`, "POST", {}, owner, 409);
  await call(
    `${base}/gates/proposal/commit`,
    "POST",
    {
      confirmationHash: preview.confirmationHash,
      requestId: "changed-preview",
    },
    owner,
    409,
  );
  expect((await service.worker().runOnce())?.status).toBe("cancelled");
  expect((await call(`${base}/proposal`)).jobs[0]).toMatchObject({
    id: job.id,
    status: "cancelled",
  });
  const { events } = await call(
    "/audit-events?action=workflow_initialization.cancelled",
    "GET",
    undefined,
    admin,
  );
  expect(events).toEqual([
    expect.objectContaining({
      targetId: job.id,
      channel: "worker",
      reason: "The approved proposal or its inputs changed",
    }),
  ]);
});

it("audits failed initializations and those an invalidation cancels, once per job", async () => {
  service = await startPlanningService();
  const { call, base, approve, plan, planVersion } = await approvedPlan();
  await approve("plan", owner);
  const { proposal } = await call(`${base}/proposal`);
  await approve("proposal", owner);
  const initialize = async (requestId: string, replaceStateHash?: string) =>
    (
      await call(
        `${base}/proposal/initialize`,
        "POST",
        {
          proposalHash: proposal.proposalHash,
          confirmed: true,
          requestId,
          ...(replaceStateHash ? { replaceStateHash } : {}),
        },
        engineer,
        202,
      )
    ).job;
  await initialize("first");
  await service.worker().runOnce();
  const { currentState: initialized } = await call(`${base}/proposal`);
  await initialize("replace-a", initialized.hash);
  const stale = await initialize("replace-b", initialized.hash);
  expect((await service.worker().runOnce())?.status).toBe("succeeded");
  expect((await service.worker().runOnce())?.status).toBe("failed");
  const { currentState: replaced } = await call(`${base}/proposal`);
  const running = await initialize("running", replaced.hash);
  const queued = await initialize("queued", replaced.hash);
  const worker = service.worker();
  const claimed = await worker.claim();
  expect(claimed?.id).toBe(running.id);
  plan.workflow.customNodes[0].label = "Reviewed report";
  const body = { plan, dossierHash: planVersion.snapshot.dossierHash };
  const { composition } = await call(`${base}/plan/preview`, "POST", body);
  await call(
    `${base}/plan/save`,
    "POST",
    {
      ...body,
      confirmationHash: composition.hash,
      expectedVersionId: planVersion.id,
    },
    engineer,
    201,
  );
  expect((await worker.process(claimed!)).status).toBe("cancelled");
  const audit = async (action: string) =>
    (
      await call(
        `/audit-events?action=workflow_initialization.${action}`,
        "GET",
        undefined,
        admin,
      )
    ).events;
  expect(await audit("failed")).toEqual([
    expect.objectContaining({
      targetType: "workflow_job",
      targetId: stale.id,
      channel: "worker",
      reason: expect.stringContaining("Creator state changed"),
    }),
  ]);
  const { person } = await call("/me", "GET", undefined, engineer);
  const cancelled = await audit("cancelled");
  expect(
    cancelled.map((event: { targetId: string }) => event.targetId).sort(),
  ).toEqual([running.id, queued.id].sort());
  for (const event of cancelled)
    expect(event).toMatchObject({
      targetType: "workflow_job",
      actorPersonId: person.id,
      channel: "web",
      reason: "A new plan version superseded the proposal",
    });
});

it("withdraws queued initialization once when a pin changes", async () => {
  service = await startPlanningService();
  const { call, base, approve, skill } = await approvedPlan();
  await approve("plan", owner);
  const approved = await approve("proposal", owner);
  const { job } = await call(
    `${base}/proposal/initialize`,
    "POST",
    {
      proposalHash: approved.confirmation.boundHashes.proposal,
      confirmed: true,
      requestId: "before-pin-change",
    },
    engineer,
    202,
  );
  await call(`${base}/pins/${skill.id}`, "DELETE", { revision: 1 });
  await service.runSourceCheckJobs();
  expect((await call(`${base}/proposal`)).jobs).toEqual([
    expect.objectContaining({ id: job.id, status: "cancelled" }),
  ]);
  const { events } = await call(
    "/audit-events?action=workflow_initialization.cancelled",
    "GET",
    undefined,
    admin,
  );
  expect(events).toEqual([
    expect.objectContaining({ targetId: job.id, channel: "web" }),
  ]);
});

it("rewrites a truncated materialized plan from its stored version", async () => {
  service = await startPlanningService();
  const { call, base, approve, version, planVersion } = await approvedPlan();
  await approve("plan", owner);
  const file = path.join(
    service.config.storage.workspaceDirectory,
    "workflow-versions",
    version.id,
    "plans",
    `${planVersion.hash}.json`,
  );
  const text = `${JSON.stringify(planVersion.snapshot.plan, null, 2)}\n`;
  // A crash mid-write leaves a prefix of the plan under its final name.
  const truncate = () =>
    fs.writeFile(file, text.slice(0, Math.floor(text.length / 2)));
  const { proposal } = await call(`${base}/proposal`);
  await truncate();
  expect((await call(`${base}/proposal`)).proposal).toEqual(proposal);
  expect(await fs.readFile(file, "utf8")).toBe(text);
  await approve("proposal", owner);
  await truncate();
  await call(
    `${base}/proposal/initialize`,
    "POST",
    {
      proposalHash: proposal.proposalHash,
      confirmed: true,
      requestId: "after-truncation",
    },
    engineer,
    202,
  );
  await truncate();
  expect((await service.worker().runOnce())?.status).toBe("succeeded");
  expect(await fs.readFile(file, "utf8")).toBe(text);
  expect(await fs.readdir(path.dirname(file))).toEqual([path.basename(file)]);
});

it("serves plan saves and initialization only to POST, so a read cannot skip the Origin rule", async () => {
  service = await startPlanningService();
  const { call, base, approve, plan, planVersion } = await approvedPlan();
  const read = (route: string, body: unknown) =>
    service.rawRequest({
      path: `/api/v1${base}/${route}`,
      as: engineer,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  plan.workflow.customNodes[0].label = "Saved by a read";
  const edit = { plan, dossierHash: planVersion.snapshot.dossierHash };
  const { composition } = await call(`${base}/plan/preview`, "POST", edit);
  const save = await read("plan/save", {
    ...edit,
    confirmationHash: composition.hash,
    expectedVersionId: planVersion.id,
  });
  expect(save.status).toBe(405);
  expect(save.headers.allow).toBe("POST");
  expect((await call(`${base}/plan`)).versions).toEqual([planVersion]);
  await approve("plan", owner);
  const approved = await approve("proposal", owner);
  const initialize = await read("proposal/initialize", {
    proposalHash: approved.confirmation.boundHashes.proposal,
    confirmed: true,
    requestId: "initialize-by-read",
  });
  expect(initialize.status).toBe(405);
  expect(initialize.headers.allow).toBe("POST");
  expect((await call(`${base}/proposal`)).jobs).toEqual([]);
});

it.each(["fact", "pin", "dossier"] as const)(
  "preserves initialized state while a changed %s invalidates its proposal",
  async (changed) => {
    service = await startPlanningService();
    const { call, base, approve, record, factContent, skill, semantics } =
      await approvedPlan();
    await approve("plan", owner);
    const approved = await approve("proposal", owner);
    await call(
      `${base}/proposal/initialize`,
      "POST",
      {
        proposalHash: approved.confirmation.boundHashes.proposal,
        confirmed: true,
        requestId: "initialize",
      },
      engineer,
      202,
    );
    await service.worker().runOnce();
    const { currentState } = await call(`${base}/proposal`);
    if (changed === "fact") {
      await call(`${base}/source-study/facts/${record.id}`, "PATCH", {
        ...factContent,
        revision: 1,
        statement: "Return an additionally reviewed report.",
      });
    } else if (changed === "pin") {
      await call(`${base}/pins/${skill.id}`, "DELETE", { revision: 1 });
      await service.runSourceCheckJobs();
    } else {
      const next = structuredClone(semantics);
      next.nodes[0].responsibility.summary = "Produce the reviewed report.";
      const { composition } = await call(
        `${base}/dossier/preview`,
        "POST",
        next,
      );
      await call(
        `${base}/dossier/compose`,
        "POST",
        { ...next, confirmationHash: composition.hash },
        engineer,
        201,
      );
    }
    expect(
      (await call(`${base}/gates/proposal`)).confirmation.invalidatedAt,
    ).not.toBeNull();
    expect((await call(`${base}/proposal`)).currentState).toEqual(currentState);
    await call(
      `${base}/proposal/initialize`,
      "POST",
      {
        proposalHash: approved.confirmation.boundHashes.proposal,
        replaceStateHash: currentState.hash,
        confirmed: true,
        requestId: "superseded",
      },
      engineer,
      409,
    );
  },
);

it("blocks service plans that redirect kernel artifact writes", async () => {
  service = await startPlanningService();
  const { call, base, approve, plan, planVersion } = await approvedPlan();
  plan.artifactRoot = "../../outside-service";
  const body = { plan, dossierHash: planVersion.snapshot.dossierHash };
  const { composition } = await call(`${base}/plan/preview`, "POST", body);
  await call(
    `${base}/plan/save`,
    "POST",
    {
      ...body,
      confirmationHash: composition.hash,
      expectedVersionId: planVersion.id,
    },
    engineer,
    201,
  );
  await approve("plan", owner);
  const view = await call(`${base}/proposal`);
  expect(view.proposal.canInitialize).toBe(false);
  await call(`${base}/gates/proposal/preview`, "POST", {}, owner, 409);
});
