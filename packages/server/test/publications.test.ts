import { afterEach, expect, it } from "vitest";
import type { TestService } from "../src/testing/index.js";
import { assembledFixture } from "./fixtures/evaluations.js";
import {
  admin,
  engineer,
  owner,
  startPlanningService,
} from "./fixtures/planning.js";

const reviewer = { subject: "reviewer", email: "reviewer@example.com" };
const operator = { subject: "operator", email: "operator@example.com" };
let service: TestService;
afterEach(async () => service?.close());

async function fixture() {
  service = await startPlanningService();
  const value = await assembledFixture(service);
  for (const [person, role] of [
    [reviewer, "Reviewer"],
    [operator, "Operator"],
    [engineer, "Reviewer"],
  ] as const)
    await value.call(
      "/bindings",
      "POST",
      {
        scopeType: "workflow",
        scopeId: value.workflow.id,
        email: person.email,
        role,
      },
      admin,
      201,
    );
  return value;
}

it("shows composite readiness for the current assembled hash and requires a passing evaluation before human review", async () => {
  const { call, base, assembled, secret } = await fixture();
  const view = await call(`${base}/review`, "GET", undefined, reviewer);
  expect(view.currentPackageHash).toBe(assembled.packageHash);
  expect(view.readiness).toMatchObject({
    state: "blocked",
    authoring: { state: "ready" },
    runtime: { state: "blocked" },
    publication: { state: "blocked" },
  });
  expect(view.readiness.hashes.package).toBe(assembled.packageHash);
  await call(`${base}/review/approve-preview`, "POST", {}, reviewer, 409);
  await call(`${base}/review/approve-preview`, "POST", {}, owner, 403);
  await call(
    `${base}/review/approve-preview`,
    "POST",
    {},
    engineer,
    403,
    secret,
  );
});

it("requires independent human review and owner publication, and exposes immutable published bytes to authorized Operators", async () => {
  const { call, base, assembled, workflow, approve, secret } = await fixture();
  const authoringBefore = await call(`${base}/package`);
  await call(
    `${base}/evaluations`,
    "POST",
    {
      confirmed: true,
      packageHash: assembled.packageHash,
      requestId: "evaluate-review",
    },
    engineer,
    202,
  );
  expect((await service.worker().runOnce())?.status).toBe("succeeded");
  const ready = await call(`${base}/review`, "GET", undefined, reviewer);
  expect(ready.readiness.state).toBe("reviewable");
  await call(`${base}/review/approve-preview`, "POST", {}, engineer, 403);
  await call(`${base}/review/publish-preview`, "POST", {}, owner, 409);
  const { preview } = await call(
    `${base}/review/approve-preview`,
    "POST",
    {},
    reviewer,
  );
  const decision = {
    confirmed: true,
    confirmationHash: preview.confirmationHash,
    requestId: "approve-package",
  };
  await call(
    `${base}/review/approve`,
    "POST",
    { ...decision, confirmed: false },
    reviewer,
    400,
  );
  const approval = await call(
    `${base}/review/approve`,
    "POST",
    decision,
    reviewer,
  );
  expect(approval.confirmation.boundHashes.package).toBe(assembled.packageHash);
  expect(
    (await call(`${base}/review`, "GET", undefined, owner)).readiness.state,
  ).toBe("publishable");
  expect(
    (await call("/me/inbox", "GET", undefined, owner)).items,
  ).toContainEqual(
    expect.objectContaining({
      gate: "publication",
      kind: "gate-ready",
      href: `${base}#review-publication`,
    }),
  );
  await call(
    `${base}/evaluations`,
    "POST",
    {
      confirmed: true,
      packageHash: assembled.packageHash,
      requestId: "evaluate-approved-again",
    },
    engineer,
    202,
  );
  await service.worker().runOnce();
  expect(await call(`${base}/review`, "GET", undefined, owner)).toMatchObject({
    readiness: { state: "publishable" },
    passingReportId: ready.passingReportId,
  });
  await call(`${base}/review/publish-preview`, "POST", {}, reviewer, 403);
  const { preview: publication } = await call(
    `${base}/review/publish-preview`,
    "POST",
    {},
    owner,
  );
  const published = await call(
    `${base}/review/publish`,
    "POST",
    {
      confirmed: true,
      confirmationHash: publication.confirmationHash,
      requestId: "publish-package",
    },
    owner,
  );
  const route = `/workflows/${workflow.id}/publications`;
  const list = await call(route, "GET", undefined, operator);
  expect(list.publications).toHaveLength(1);
  expect(list.publications[0]).toMatchObject({
    id: published.confirmation.id,
    packageHash: assembled.packageHash,
    reviewId: approval.confirmation.id,
  });
  const bytes = await call(
    `${route}/${published.confirmation.id}/package`,
    "GET",
    undefined,
    operator,
  );
  expect(bytes.snapshot.packageHash).toBe(assembled.packageHash);
  expect(bytes.snapshot.inventory).toEqual(
    (await call(`${base}/package`)).package.files,
  );
  expect(
    Buffer.from(
      bytes.snapshot.files.find((f: { path: string }) => f.path === "SKILL.md")
        .content,
      "base64",
    ).toString(),
  ).toContain("report");
  const { secret: operatorToken } = await call(
    "/me/tokens",
    "POST",
    { name: "Operator", scopes: ["operator"] },
    operator,
    201,
  );
  expect(
    await call(
      `${route}/${published.confirmation.id}/package`,
      "GET",
      undefined,
      operator,
      200,
      operatorToken,
    ),
  ).toEqual(bytes);
  await call(
    `${route}/${published.confirmation.id}/package?packageHash=${"0".repeat(64)}`,
    "GET",
    undefined,
    operator,
    409,
    operatorToken,
  );
  expect(
    (await call(route, "GET", undefined, engineer, 200, secret)).publications,
  ).toHaveLength(1);
  await call(route, "GET", undefined, { subject: "outsider" }, 403);
  const { secret: unscoped } = await call(
    "/me/tokens",
    "POST",
    { name: "No Operator scope", scopes: ["expert"] },
    operator,
    201,
  );
  await call(route, "GET", undefined, operator, 403, unscoped);
  await call(
    `${base}/review/approve`,
    "POST",
    decision,
    operator,
    403,
    operatorToken,
  );
  const audit = await call(
    "/audit-events?action=workflow_package.published",
    "GET",
    undefined,
    admin,
  );
  expect(audit.events).toHaveLength(1);
  expect((await call(`${base}/package`)).currentStateHash).toBe(
    authoringBefore.currentStateHash,
  );
  const { confirmation: generation } = await approve("generation");
  await call(
    `${base}/package/generate`,
    "POST",
    {
      confirmed: true,
      confirmationHash: generation.confirmationHash,
      stateHash: authoringBefore.currentStateHash,
      requestId: "regenerate-published",
    },
    engineer,
    202,
  );
  await service.worker().runOnce();
  expect(
    (await call(`${base}/review`, "GET", undefined, reviewer)).readiness.state,
  ).toBe("blocked");
  await call(
    `${base}/review/approve`,
    "POST",
    { ...decision, requestId: "stale-approval" },
    reviewer,
    409,
  );
  await call(
    `${base}/review/publish`,
    "POST",
    {
      confirmed: true,
      confirmationHash: publication.confirmationHash,
      requestId: "stale-publication",
    },
    owner,
    409,
  );
  expect(
    await call(`${base}/review/approve`, "POST", decision, reviewer),
  ).toEqual(approval);
  expect(
    await call(
      `${base}/review/publish`,
      "POST",
      {
        confirmed: true,
        confirmationHash: publication.confirmationHash,
        requestId: "publish-package",
      },
      owner,
    ),
  ).toEqual(published);
  expect(
    (await call(`${base}/review`, "GET", undefined, reviewer)).reviews[0]
      .invalidatedAt,
  ).not.toBeNull();
  expect(
    await call(
      `${route}/${published.confirmation.id}/package`,
      "GET",
      undefined,
      operator,
    ),
  ).toEqual(bytes);
  expect(
    (await call(route, "GET", undefined, operator)).publications,
  ).toHaveLength(1);
  await call(`${base}/review/approve-preview`, "POST", {}, engineer, 403);
}, 60_000);

it("records a reasoned Administrator override and rolls back sign-off and publication without changing Authoring state", async () => {
  const { call, base, assembled, workflow } = await fixture();
  await call(
    `${base}/evaluations`,
    "POST",
    {
      confirmed: true,
      packageHash: assembled.packageHash,
      requestId: "evaluate-override",
    },
    engineer,
    202,
  );
  await service.worker().runOnce();
  const stateHash = (await call(`${base}/package`)).currentStateHash;
  await call(
    "/bindings",
    "POST",
    {
      scopeType: "organization",
      scopeId: null,
      email: engineer.email,
      role: "Administrator",
    },
    admin,
    201,
  );
  await call(`${base}/review/approve-preview`, "POST", {}, engineer, 403);
  await call(
    `${base}/review/approve-preview`,
    "POST",
    { overrideReason: "   " },
    engineer,
    400,
  );
  const reason =
    "Independent Reviewer unavailable; owner requested a documented emergency review.";
  const { preview } = await call(
    `${base}/review/approve-preview`,
    "POST",
    { overrideReason: reason },
    engineer,
  );
  const input = {
    confirmed: true,
    confirmationHash: preview.confirmationHash,
    requestId: "override-review",
    overrideReason: reason,
  };
  await call(
    `${base}/review/approve`,
    "POST",
    { ...input, overrideReason: "A different reason" },
    engineer,
    409,
  );
  service.failNextTransaction("40001");
  await call(`${base}/review/approve`, "POST", input, engineer, 503);
  const before = await call(`${base}/review`);
  expect(before.reviews).toEqual([]);
  expect(before.readiness.state).toBe("reviewable");
  await call(`${base}/review/approve`, "POST", input);
  const approved = await call(`${base}/review`);
  expect(approved.reviews[0]).toMatchObject({
    reviewerName: "engineer",
    overrideReason: reason,
  });
  const events = await call(
    "/audit-events?action=workflow_package.review_override",
    "GET",
    undefined,
    admin,
  );
  expect(events.events).toHaveLength(1);
  expect(events.events[0]).toMatchObject({
    reason,
    credentialKind: "session",
    channel: "web",
  });
  const { preview: publication } = await call(
    `${base}/review/publish-preview`,
    "POST",
    {},
    owner,
  );
  const publicationInput = {
    confirmed: true,
    confirmationHash: publication.confirmationHash,
    requestId: "override-publication",
  };
  service.failNextTransaction("40P01");
  await call(`${base}/review/publish`, "POST", publicationInput, owner, 503);
  expect(
    (
      await call(
        `/workflows/${workflow.id}/publications`,
        "GET",
        undefined,
        operator,
      )
    ).publications,
  ).toEqual([]);
  expect((await call(`${base}/review`)).readiness.state).toBe("publishable");
  const published = await call(
    `${base}/review/publish`,
    "POST",
    publicationInput,
    owner,
  );
  expect(
    (
      await call(
        `/workflows/${workflow.id}/publications`,
        "GET",
        undefined,
        operator,
      )
    ).publications[0].id,
  ).toBe(published.confirmation.id);
  expect((await call(`${base}/package`)).currentStateHash).toBe(stateHash);
});
