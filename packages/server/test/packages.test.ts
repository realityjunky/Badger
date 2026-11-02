import { afterEach, expect, it } from "vitest";
import type { TestService } from "../src/testing/index.js";
import {
  admin,
  engineer,
  observer,
  owner,
  startPlanningService,
} from "./fixtures/planning.js";
import { initializedFixture } from "./fixtures/packages.js";
import { assembledFixture } from "./fixtures/evaluations.js";

let service: TestService;
afterEach(async () => service?.close());

it("generates the confirmed scaffold as a job with a kernel authoring plan, source bundle, and MCP instructions", async () => {
  service = await startPlanningService();
  const { call, base, approve, planVersion } =
    await initializedFixture(service);
  const before = await call(`${base}/package`);
  expect(before.package).toBeNull();
  expect(before.canGenerate).toBe(true);
  const { confirmation } = await approve("generation");
  const { job } = await call(
    `${base}/package/generate`,
    "POST",
    {
      confirmed: true,
      confirmationHash: confirmation.confirmationHash,
      stateHash: before.currentStateHash,
      requestId: "generate-first",
    },
    engineer,
    202,
  );
  expect(job).toMatchObject({ kind: "generate", status: "queued" });
  expect((await call(`${base}/package`)).package).toBeNull();
  const finished = await service.worker().runOnce();
  expect(finished?.status, JSON.stringify(finished)).toBe("succeeded");
  const view = await call(`${base}/package`);
  expect(view.package).toMatchObject({
    generationJobId: job.id,
    status: "current",
    scaffoldHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    authoringPlan: { kind: "authoring-plan", lanes: expect.any(Array) },
  });
  expect(view.package.files).toContainEqual(
    expect.objectContaining({
      path: "scripts/workflow-state.mjs",
      owner: "auto",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    }),
  );
  const sourcePath = `sources/${planVersion.snapshot.plan.semanticDossier.sources[0].contentHash}/SKILL.md`;
  expect(view.package.files).toContainEqual(
    expect.objectContaining({ path: sourcePath, owner: "source" }),
  );
  expect(view.package.files).toContainEqual(
    expect.objectContaining({ owner: "authored" }),
  );
  const entry = await call(`${base}/package/file?path=SKILL.md`);
  expect(entry.text).toContain("Badger MCP Run tools");
  const source = await call(
    `${base}/package/file?path=${encodeURIComponent(sourcePath)}`,
  );
  expect(source.text).toContain("Return report text.");
  expect((await call(base)).version.stages).toContainEqual({
    id: "package",
    state: "active",
  });
});

it("requires a person's exact generation confirmation and refuses tokens, other roles, and stale state", async () => {
  service = await startPlanningService();
  const { call, base, approve } = await initializedFixture(service);
  const before = await call(`${base}/package`);
  const body = {
    confirmed: true,
    confirmationHash: "a".repeat(64),
    stateHash: before.currentStateHash,
    requestId: "unconfirmed",
  };
  await call(`${base}/package/generate`, "POST", body, engineer, 409);
  await call(
    `${base}/package/generate`,
    "POST",
    { ...body, confirmed: false },
    engineer,
    400,
  );
  for (const as of [owner, observer]) {
    await call(`${base}/gates/generation/preview`, "POST", {}, as, 403);
    await call(`${base}/package/generate`, "POST", body, as, 403);
  }
  const { secret } = await call(
    "/me/tokens",
    "POST",
    { name: "Engineer Agent", scopes: ["engineer"] },
    engineer,
    201,
  );
  await call(`${base}/package`, "GET", undefined, engineer, 200, secret);
  await call(
    `${base}/gates/generation/preview`,
    "POST",
    {},
    engineer,
    403,
    secret,
  );
  await call(`${base}/package/generate`, "POST", body, engineer, 403, secret);
  const { confirmation } = await approve("generation");
  await call(
    `${base}/package/generate`,
    "POST",
    {
      ...body,
      confirmationHash: confirmation.confirmationHash,
      stateHash: "b".repeat(64),
    },
    engineer,
    409,
  );
  const accepted = {
    ...body,
    confirmationHash: confirmation.confirmationHash,
    requestId: "confirmed",
  };
  const { job } = await call(
    `${base}/package/generate`,
    "POST",
    accepted,
    engineer,
    202,
  );
  expect(
    (await call(`${base}/package/generate`, "POST", accepted, engineer, 202))
      .job.id,
  ).toBe(job.id);
  await call(
    `${base}/package/generate`,
    "POST",
    { ...accepted, stateHash: "b".repeat(64) },
    engineer,
    409,
  );
  // A new explicit confirmation can retry the same state after a failed or
  // abandoned attempt, without forcing another proposal approval or init.
  const retried = await approve("generation");
  await call(
    `${base}/package/generate`,
    "POST",
    {
      ...accepted,
      confirmationHash: retried.confirmation.confirmationHash,
      requestId: "confirmed-again",
    },
    engineer,
    202,
  );
  expect((await service.worker().runOnce())?.status).toBe("cancelled");
  expect((await service.worker().runOnce())?.status).toBe("succeeded");
});

it("withdraws a claimed generation and its old package when the approved plan changes, and notifies its people", async () => {
  service = await startPlanningService();
  const { call, base, approve, plan, planVersion, workflow } =
    await initializedFixture(service);
  await call(
    "/bindings",
    "POST",
    {
      scopeType: "workflow",
      scopeId: workflow.id,
      email: "reviewer@example.com",
      role: "Workflow owner",
    },
    admin,
    201,
  );
  const queue = async (requestId: string) => {
    const { currentStateHash } = await call(`${base}/package`);
    const { confirmation } = await approve("generation");
    return call(
      `${base}/package/generate`,
      "POST",
      {
        confirmed: true,
        confirmationHash: confirmation.confirmationHash,
        stateHash: currentStateHash,
        requestId,
      },
      engineer,
      202,
    );
  };
  await queue("first-package");
  await service.worker().runOnce();
  const saved = (await call(`${base}/package`)).package;
  await queue("old-plan-package");
  const worker = service.worker();
  const claimed = await worker.claim();
  expect(claimed?.kind).toBe("generate");
  plan.workflow.customNodes[0].label = "Updated report";
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
  const invalidated = await call(`${base}/package`);
  expect(invalidated.canGenerate).toBe(false);
  expect(invalidated.package).toMatchObject({
    id: saved.id,
    status: "invalidated",
  });
  expect((await call(base)).version.stages).toContainEqual({
    id: "package",
    state: "invalidated",
  });
  for (const as of [
    engineer,
    owner,
    { subject: "reviewer", email: "reviewer@example.com" },
  ]) {
    expect(
      (await call("/me/inbox", "GET", undefined, as)).items,
    ).toContainEqual(
      expect.objectContaining({
        gate: "package",
        kind: "gate-invalidated",
        href: `${base}#package`,
      }),
    );
  }
  await call(`${base}/gates/generation/preview`, "POST", {}, engineer, 409);
  expect((await call(`${base}/package/file?path=SKILL.md`)).text).toContain(
    "Badger MCP Run tools",
  );
});

it("commits package bytes and state atomically and recovers a failed worker transaction", async () => {
  service = await startPlanningService();
  const { call, base, approve } = await initializedFixture(service);
  const before = await call(`${base}/package`);
  const { confirmation } = await approve("generation");
  await call(
    `${base}/package/generate`,
    "POST",
    {
      confirmed: true,
      confirmationHash: confirmation.confirmationHash,
      stateHash: before.currentStateHash,
      requestId: "retry-generation",
    },
    engineer,
    202,
  );
  const worker = service.worker();
  const job = await worker.claim();
  service.failNextTransaction("40001");
  await expect(worker.process(job!)).rejects.toThrow();
  expect(await call(`${base}/package`)).toMatchObject({
    currentStateHash: before.currentStateHash,
    package: null,
  });
  expect((await worker.process(job!)).status).toBe("succeeded");
  const view = await call(`${base}/package`);
  expect(view.package.scaffoldHash).toMatch(/^[a-f0-9]{64}$/u);
  await call(
    `${base}/package/file?path=..%2F..%2Fplans%2Fplan.json`,
    "GET",
    undefined,
    engineer,
    404,
  );
  const events = await call("/audit-events", "GET", undefined, admin);
  expect(
    events.events.filter(
      (event: { action: string }) =>
        event.action === "workflow_generation.succeeded",
    ),
  ).toHaveLength(1);
});

it("invalidates progressed Evaluation and Review stages when reinitialization withdraws the package", async () => {
  service = await startPlanningService();
  const { call, base, assembled, workflow } = await assembledFixture(service);
  const reviewer = { subject: "reviewer", email: "reviewer@example.com" };
  await call(
    "/bindings",
    "POST",
    {
      scopeType: "workflow",
      scopeId: workflow.id,
      email: reviewer.email,
      role: "Workflow owner",
    },
    admin,
    201,
  );
  await call(
    `${base}/evaluations`,
    "POST",
    {
      confirmed: true,
      packageHash: assembled.packageHash,
      requestId: "evaluate-before-reinitialization",
    },
    engineer,
    202,
  );
  expect((await service.worker().runOnce())?.status).toBe("succeeded");
  const { preview } = await call(
    `${base}/review/approve-preview`,
    "POST",
    {},
    reviewer,
  );
  await call(
    `${base}/review/approve`,
    "POST",
    {
      confirmed: true,
      confirmationHash: preview.confirmationHash,
      requestId: "approve-before-reinitialization",
    },
    reviewer,
  );
  const stages = async () =>
    Object.fromEntries(
      (await call(base)).version.stages.map(
        (stage: { id: string; state: string }) => [stage.id, stage.state],
      ),
    );
  expect(await stages()).toMatchObject({
    package: "done",
    evaluation: "done",
    "review-publication": "active",
  });
  const { proposal, currentState } = await call(`${base}/proposal`);
  await call(
    `${base}/proposal/initialize`,
    "POST",
    {
      proposalHash: proposal.proposalHash,
      confirmed: true,
      requestId: "reinitialize",
      replaceStateHash: currentState.hash,
    },
    engineer,
    202,
  );
  expect((await service.worker().runOnce())?.status).toBe("succeeded");
  expect((await call(`${base}/package`)).package.status).toBe("invalidated");
  expect(await stages()).toMatchObject({
    "plan-proposal": "done",
    package: "active",
    evaluation: "invalidated",
    "review-publication": "invalidated",
  });
}, 90_000);
