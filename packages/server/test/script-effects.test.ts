import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import {
  startTestService,
  type TestPerson,
  type TestService,
} from "../src/testing/index.js";

const admin: TestPerson = { subject: "admin", email: "admin@example.com" };
const engineer: TestPerson = {
  subject: "engineer",
  email: "engineer@example.com",
};
const uploader: TestPerson = {
  subject: "uploader",
  email: "uploader@example.com",
};
const script = "#!/bin/sh\nprintf example > output.txt\n";
let service: TestService;
afterEach(async () => service?.close());

async function call(
  path: string,
  method = "GET",
  body?: unknown,
  status = 200,
  as: TestPerson | string = engineer,
) {
  const response = await service.request(`/api/v1${path}`, {
    method,
    ...(typeof as === "string" ? {} : { as }),
    headers: {
      origin: "http://localhost",
      "content-type": "application/json",
      ...(typeof as === "string"
        ? {
            authorization: `Bearer ${as}`,
            "x-badger-agent-host": "Codex",
          }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(status);
  return value;
}

async function workflow(groupId: string, name: string) {
  const { workflow, version } = await call(
    "/workflows",
    "POST",
    {
      groupId,
      name,
      goal: "Study a script without executing it",
      intent: "new-skill",
      locale: "en",
    },
    201,
    admin,
  );
  await call(
    "/bindings",
    "POST",
    {
      scopeType: "workflow",
      scopeId: workflow.id,
      role: "Engineer",
      email: engineer.email,
    },
    201,
    admin,
  );
  return {
    workflow,
    version,
    base: `/workflows/${workflow.id}/versions/${version.id}`,
  };
}

async function setup() {
  service = await startTestService({
    environment: {
      BADGER_BOOTSTRAP_ADMINISTRATORS: admin.email,
      BADGER_ALLOWED_ORIGINS: "http://localhost",
      BADGER_LLM_CONFIG_FILE: "/retired-and-never-read.json",
      BADGER_LLM_KEY: "retired-configuration-is-ignored",
    },
  });
  const { group } = await call(
    "/groups",
    "POST",
    { name: "Research" },
    201,
    admin,
  );
  const own = await workflow(group.id, "uploader-library");
  const { binding: uploaderBinding } = await call(
    "/bindings",
    "POST",
    {
      scopeType: "workflow",
      scopeId: own.workflow.id,
      role: "Engineer",
      email: uploader.email,
    },
    201,
    admin,
  );
  const target = await workflow(group.id, "study-effects");
  const { skill } = await call(
    "/skills",
    "POST",
    { groupId: group.id, name: "example" },
    201,
    uploader,
  );
  const files = [
    {
      path: "SKILL.md",
      content: Buffer.from(
        "---\nname: example\ndescription: An effect fixture\n---\nRead scripts/run.sh.\n",
      ).toString("base64"),
    },
    { path: "scripts/run.sh", content: Buffer.from(script).toString("base64") },
  ];
  const { preview } = await call(
    `/skills/${skill.id}/upload-preview`,
    "POST",
    { files },
    200,
    uploader,
  );
  const { version } = await call(
    `/skills/${skill.id}/versions`,
    "POST",
    {
      files,
      confirmed: true,
      expectedHash: preview.hash,
    },
    201,
    uploader,
  );
  const pin = { skillId: skill.id, hash: version.hash };
  await call(`${target.base}/pins`, "POST", pin, 201);
  await service.runSourceCheckJobs();
  const { preview: sources } = await call(
    `${target.base}/gates/sources/preview`,
    "POST",
    {},
  );
  await call(`${target.base}/gates/sources/commit`, "POST", {
    confirmationHash: sources.confirmationHash,
    requestId: "confirm-sources",
  });
  const { secret } = await call(
    "/me/tokens",
    "POST",
    { name: "Study Agent", scopes: ["engineer"] },
    201,
  );
  const suggestion = {
    ...pin,
    path: "scripts/run.sh",
    effects: ["local-writes"],
    rationale: "The script creates output.txt.",
    evidence: [
      {
        ...pin,
        path: "scripts/run.sh",
        fileHash: createHash("sha256").update(script).digest("hex"),
        startLine: 2,
        endLine: 2,
      },
    ],
    conditionalBehavior: "",
    uncertainty: "Are temporary files also written?",
  };
  return {
    ...target,
    groupId: group.id,
    own,
    uploaderBinding,
    skill,
    sourceVersion: version,
    pin,
    files,
    secret,
    suggestion,
    effects: `/skills/${skill.id}/versions/${version.hash}/effects`,
  };
}

async function studyDraft(
  fixture: Awaited<ReturnType<typeof setup>>,
  effects = [fixture.suggestion],
  accept = true,
) {
  const jobs = `${fixture.base}/drafting-jobs`;
  const { job } = await call(
    jobs,
    "POST",
    { kind: "source-study", skillId: fixture.skill.id, confirmed: true },
    201,
  );
  const claim = await call(
    `${jobs}/${job.id}/claim`,
    "POST",
    { revision: job.revision },
    200,
    fixture.secret,
  );
  expect(claim.contextBundle.scriptEffectContract.schemaVersion).toBe(1);
  expect(claim.files).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: "scripts/run.sh",
        versionHash: fixture.pin.hash,
      }),
    ]),
  );
  const result = {
    facts: [
      {
        statement: "The script creates output.txt.",
        evidence: fixture.suggestion.evidence,
      },
    ],
    interfaces: [],
    scriptEffects: effects,
  };
  const { job: submitted } = await call(
    `${jobs}/${job.id}/submit`,
    "POST",
    {
      leaseId: claim.job.lease.id,
      contextHash: job.contextHash,
      result,
    },
    200,
    fixture.secret,
  );
  if (!accept) return submitted;
  const { preview } = await call(`${jobs}/${job.id}/accept-preview`, "POST", {
    revision: submitted.revision,
    ...result,
  });
  const accepted = await call(`${jobs}/${job.id}/accept`, "POST", {
    revision: submitted.revision,
    ...result,
    confirmed: true,
    confirmationHash: preview.confirmationHash,
    requestId: `accept-${job.id}`,
  });
  return accepted.job;
}

it.each(["submitted", "accepted"] as const)(
  "refuses routing a %s Source study draft after its study inputs change",
  async (status) => {
    const fixture = await setup();
    const job = await studyDraft(
      fixture,
      [fixture.suggestion],
      status === "accepted",
    );
    await call(
      `${fixture.base}/source-study/facts`,
      "POST",
      {
        statement: "Output is written in the current working directory.",
        evidence: fixture.suggestion.evidence,
      },
      201,
    );
    await call(
      `${fixture.effects}/route`,
      "POST",
      {
        workflowVersionId: fixture.version.id,
        jobId: job.id,
        jobRevision: job.revision,
        revision: 0,
      },
      409,
    );
    expect((await call(fixture.effects)).review).toBeNull();
  },
);

it("keeps useful facts acceptable after routing that job's effect section", async () => {
  const fixture = await setup();
  const job = await studyDraft(fixture, [fixture.suggestion], false);
  const routed = await call(`${fixture.effects}/route`, "POST", {
    workflowVersionId: fixture.version.id,
    jobId: job.id,
    jobRevision: job.revision,
    revision: 0,
  });
  expect(routed.review.kind).toBe("proposal");
  const path = `${fixture.base}/drafting-jobs/${job.id}`;
  expect((await call(path)).job.status).toBe("submitted");
  const { preview } = await call(`${path}/accept-preview`, "POST", {
    revision: job.revision,
    ...job.result,
  });
  const accepted = await call(`${path}/accept`, "POST", {
    revision: job.revision,
    ...job.result,
    confirmed: true,
    confirmationHash: preview.confirmationHash,
    requestId: "facts-after-effects-routed",
  });
  expect(accepted.job.status).toBe("accepted");
  expect((await call(`${fixture.base}/source-study`)).facts).toHaveLength(1);
  expect((await call(fixture.effects)).review).toEqual(routed.review);
});

it("routes a Source study draft to its non-expert uploader, confirms the corrected set, and reuses the version", async () => {
  const fixture = await setup();
  const job = await studyDraft(fixture);
  expect((await call(`${fixture.base}/source-study`)).facts).toHaveLength(1);
  await call(
    `${fixture.base}/gates/source-study/${fixture.skill.id}/preview`,
    "POST",
    {},
    409,
  );
  expect((await call(fixture.effects)).review).toBeNull();
  const routed = await call(`${fixture.effects}/route`, "POST", {
    workflowVersionId: fixture.version.id,
    jobId: job.id,
    jobRevision: job.revision,
    revision: 0,
  });
  expect(routed.review.kind).toBe("proposal");
  const waiting = await call(
    `/workflows/${fixture.workflow.id}/notifications/waiting`,
  );
  expect(waiting.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "script-effect-review",
        href: expect.stringContaining("/source-reviews/"),
      }),
    ]),
  );
  await call(fixture.base, "GET", undefined, 403, uploader);
  const inbox = await call("/me/inbox", "GET", undefined, 200, uploader);
  expect(inbox.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "script-effect-review",
        href: expect.stringContaining("/source-reviews/"),
      }),
    ]),
  );
  const current = await call(fixture.effects, "GET", undefined, 200, uploader);
  const rows = current.review.content.scripts.map((row: object) => ({
    ...row,
    reviewed: true,
    uncertaintyAnswer: "No; only output.txt is created.",
  }));
  const { review } = await call(
    fixture.effects,
    "POST",
    {
      revision: current.review.revision,
      scripts: rows,
    },
    200,
    uploader,
  );
  const { preview } = await call(
    `${fixture.effects}/preview`,
    "POST",
    { revision: review.revision },
    200,
    uploader,
  );
  await call(
    `${fixture.effects}/confirm`,
    "POST",
    {
      confirmationHash: preview.confirmationHash,
      requestId: "personal-confirmation",
    },
    403,
    admin,
  );
  const body = {
    confirmationHash: preview.confirmationHash,
    requestId: "personal-confirmation",
  };
  const confirmed = await call(
    `${fixture.effects}/confirm`,
    "POST",
    body,
    200,
    uploader,
  );
  expect(confirmed.review.kind).toBe("confirmation");
  expect(
    await call(`${fixture.effects}/confirm`, "POST", body, 200, uploader),
  ).toEqual(confirmed);
  expect(
    (await call("/me/inbox", "GET", undefined, 200, uploader)).items[0].state,
  ).toBe("done");
  const { preview: completion } = await call(
    `${fixture.base}/gates/source-study/${fixture.skill.id}/preview`,
    "POST",
    {},
  );
  await call(
    `${fixture.base}/gates/source-study/${fixture.skill.id}/commit`,
    "POST",
    {
      confirmationHash: completion.confirmationHash,
      requestId: "study-complete",
    },
  );
  expect((await call(`${fixture.base}/source-study`)).studies[0].studied).toBe(
    true,
  );
  const other = await workflow(fixture.groupId, "reuse-effects");
  await call(`${other.base}/pins`, "POST", fixture.pin, 201);
  const shared = await call(`${other.base}/source-study`);
  expect(shared.effects[0].review).toEqual(confirmed.review);
  expect(
    (await call("/me/inbox", "GET", undefined, 200, uploader)).items,
  ).toHaveLength(1);
});

it("leaves an unavailable uploader's review pending and exposes no retired provider endpoints", async () => {
  const fixture = await setup();
  const job = await studyDraft(fixture);
  await call(`${fixture.effects}/route`, "POST", {
    workflowVersionId: fixture.version.id,
    jobId: job.id,
    jobRevision: job.revision,
    revision: 0,
  });
  const own = await call(
    `/workflows/${fixture.own.workflow.id}`,
    "GET",
    undefined,
    200,
    admin,
  );
  const binding = own.bindings.find(
    (entry: { id: string }) => entry.id === fixture.uploaderBinding.id,
  );
  await call(
    `/bindings/${binding.id}`,
    "DELETE",
    { revision: binding.revision },
    200,
    admin,
  );
  const panel = await call(fixture.effects);
  expect(panel.uploaderAvailable).toBe(false);
  expect(panel.pendingReason).toMatch(
    /original uploader.*unavailable|no longer authorized/iu,
  );
  await call(fixture.effects, "GET", undefined, 404, uploader);
  await call(
    `${fixture.effects}/confirm`,
    "POST",
    { confirmationHash: "f".repeat(64), requestId: "proxy" },
    403,
    admin,
  );
  expect(
    (await call(fixture.effects)).history.map(
      (entry: { kind: string }) => entry.kind,
    ),
  ).toEqual(["proposal"]);
  for (const path of [
    "/admin/llm",
    "/admin/llm/test",
    "/admin/llm/reload",
    `/skills/${fixture.skill.id}/side-effect-suggestions`,
  ])
    await call(
      path,
      path === "/admin/llm" ? "GET" : "POST",
      path === "/admin/llm" ? undefined : {},
      path === "/admin/llm" ? 404 : 405,
      admin,
    );
});

it("keeps partial and uncertain drafts pending, refuses unsupported declarations, and conflicts on stale previews", async () => {
  const fixture = await setup();
  const job = await studyDraft(fixture, []);
  await call(`${fixture.effects}/route`, "POST", {
    workflowVersionId: fixture.version.id,
    jobId: job.id,
    jobRevision: job.revision,
    revision: 0,
  });
  await call(
    `${fixture.effects}/preview`,
    "POST",
    { revision: 1 },
    409,
    uploader,
  );
  const row = {
    ...fixture.suggestion,
    reviewed: true,
    uncertaintyAnswer: "Only output.txt is written.",
  };
  for (const scripts of [
    [{ ...row, effects: ["unknown"] }],
    [{ ...row, effects: ["none", "network"] }],
    [{ ...row, effects: ["network", "network"] }],
    [row, row],
    [{ ...row, path: "scripts/missing.sh" }],
    [{ ...row, hash: "e".repeat(64) }],
    [{ ...row, evidence: [{ ...row.evidence[0], fileHash: "e".repeat(64) }] }],
    [{ ...row, evidence: [{ ...row.evidence[0], endLine: 50 }] }],
    [{ ...row, evidence: [{ ...row.evidence[0], path: "missing.txt" }] }],
  ])
    await call(
      fixture.effects,
      "POST",
      { revision: 1, scripts },
      400,
      uploader,
    );
  await call(
    `${fixture.effects}/route`,
    "POST",
    {
      workflowVersionId: fixture.version.id,
      jobId: job.id,
      jobRevision: job.revision - 1,
      revision: 1,
    },
    409,
  );
  await call(
    fixture.effects,
    "POST",
    { revision: 1, scripts: [row] },
    403,
    engineer,
  );
  await call(
    fixture.effects,
    "POST",
    { revision: 1, scripts: [row] },
    403,
    fixture.secret,
  );
  const { secret: uploaderToken } = await call(
    "/me/tokens",
    "POST",
    { name: "Uploader Agent", scopes: ["engineer"] },
    201,
    uploader,
  );
  await call(
    `${fixture.effects}/confirm`,
    "POST",
    { confirmationHash: "f".repeat(64), requestId: "token" },
    403,
    uploaderToken,
  );
  const { review: clarification } = await call(
    `${fixture.effects}/clarify`,
    "POST",
    { revision: 1, note: "Please inspect temporary-file behavior." },
    200,
    uploader,
  );
  expect(clarification.kind).toBe("clarification");
  await call(
    `${fixture.effects}/preview`,
    "POST",
    { revision: clarification.revision },
    409,
    uploader,
  );
  const { review: uncertain } = await call(
    fixture.effects,
    "POST",
    {
      revision: clarification.revision,
      scripts: [{ ...row, uncertaintyAnswer: "" }],
    },
    200,
    uploader,
  );
  await call(
    `${fixture.effects}/preview`,
    "POST",
    { revision: uncertain.revision },
    409,
    uploader,
  );
  const { review } = await call(
    fixture.effects,
    "POST",
    { revision: uncertain.revision, scripts: [row] },
    200,
    uploader,
  );
  const citation = await call(
    `${fixture.effects}/evidence?path=scripts%2Frun.sh&fileHash=${row.evidence[0]!.fileHash}&startLine=2&endLine=2`,
    "GET",
    undefined,
    200,
    uploader,
  );
  expect(citation.lines).toEqual([
    { number: 2, text: "printf example > output.txt" },
  ]);
  const { preview } = await call(
    `${fixture.effects}/preview`,
    "POST",
    { revision: review.revision },
    200,
    uploader,
  );
  const { review: edited } = await call(
    fixture.effects,
    "POST",
    {
      revision: review.revision,
      scripts: [{ ...row, conditionalBehavior: "Always writes output.txt." }],
    },
    200,
    uploader,
  );
  await call(
    `${fixture.effects}/confirm`,
    "POST",
    { confirmationHash: preview.confirmationHash, requestId: "stale" },
    409,
    uploader,
  );
  await call(
    fixture.effects,
    "POST",
    { revision: review.revision, scripts: [row] },
    409,
    uploader,
  );
  const { preview: current } = await call(
    `${fixture.effects}/preview`,
    "POST",
    { revision: edited.revision },
    200,
    uploader,
  );
  const body = {
    confirmationHash: current.confirmationHash,
    requestId: "concurrent-confirmation",
  };
  const confirmations = await Promise.all([
    call(`${fixture.effects}/confirm`, "POST", body, 200, uploader),
    call(`${fixture.effects}/confirm`, "POST", body, 200, uploader),
  ]);
  expect(confirmations[1]).toEqual(confirmations[0]);
  expect(
    (await call(fixture.effects)).history.filter(
      (entry: { kind: string }) => entry.kind === "confirmation",
    ),
  ).toHaveLength(1);
  expect(
    (await call("/me/inbox", "GET", undefined, 200, uploader)).items.filter(
      (entry: { kind: string }) => entry.kind === "script-effect-review",
    ),
  ).toHaveLength(1);
});

it("binds plans and packages to confirmed revisions, invalidates corrections, and keeps new versions and other entries pending", async () => {
  const fixture = await setup();
  const job = await studyDraft(fixture);
  await call(`${fixture.effects}/route`, "POST", {
    workflowVersionId: fixture.version.id,
    jobId: job.id,
    jobRevision: job.revision,
    revision: 0,
  });
  const rows = [
    {
      ...fixture.suggestion,
      reviewed: true,
      uncertaintyAnswer: "Only output.txt is written.",
    },
  ];
  const { review } = await call(
    fixture.effects,
    "POST",
    { revision: 1, scripts: rows },
    200,
    uploader,
  );
  const { preview } = await call(
    `${fixture.effects}/preview`,
    "POST",
    { revision: review.revision },
    200,
    uploader,
  );
  const { review: confirmed } = await call(
    `${fixture.effects}/confirm`,
    "POST",
    {
      confirmationHash: preview.confirmationHash,
      requestId: "original-effects",
    },
    200,
    uploader,
  );
  const approve = async (gate: string, as = engineer) => {
    const { preview: gatePreview } = await call(
      `${fixture.base}/gates/${gate}/preview`,
      "POST",
      {},
      200,
      as,
    );
    return call(
      `${fixture.base}/gates/${gate}/commit`,
      "POST",
      {
        confirmationHash: gatePreview.confirmationHash,
        requestId: `gate-${gate.replaceAll("/", "-")}`,
      },
      200,
      as,
    );
  };
  await approve(`source-study/${fixture.skill.id}`);
  const study = await call(`${fixture.base}/source-study`);
  const { handoff } = await call(`${fixture.base}/questionnaire/ledger`);
  const topic = {
    summary: "Create output.txt from the example source.",
    factIds: [study.facts[0].id],
  };
  const semantics = {
    nodes: [{ id: "example", order: 0, responsibility: topic }],
    topics: Object.fromEntries(
      handoff.readiness
        .filter((entry: { topic: string }) => entry.topic !== "scope")
        .map((entry: { topic: string }) => [entry.topic, topic]),
    ),
  };
  const { composition: dossier } = await call(
    `${fixture.base}/dossier/preview`,
    "POST",
    semantics,
  );
  await call(
    `${fixture.base}/dossier/compose`,
    "POST",
    { ...semantics, confirmationHash: dossier.hash },
    201,
  );
  await approve("dossier", admin);
  const { skeleton: plan, dossierHash } = await call(`${fixture.base}/plan`);
  const binding = {
    skillId: fixture.skill.id,
    sourceHash: fixture.pin.hash,
    revision: confirmed.revision,
    hash: confirmed.hash,
  };
  expect(plan.skillSources[0].effectDeclaration).toEqual(binding);
  plan.workflow.customNodes[0].implementation.skill = "example";
  const { composition } = await call(`${fixture.base}/plan/preview`, "POST", {
    plan,
    dossierHash,
  });
  expect(composition.findings).toEqual([]);
  const { version: planVersion } = await call(
    `${fixture.base}/plan/save`,
    "POST",
    {
      plan,
      dossierHash,
      confirmationHash: composition.hash,
      expectedVersionId: null,
    },
    201,
  );
  await approve("plan", admin);
  const { confirmation: proposal } = await approve("proposal", admin);
  await call(
    `${fixture.base}/proposal/initialize`,
    "POST",
    {
      proposalHash: proposal.boundHashes.proposal,
      confirmed: true,
      requestId: "effect-initialize",
    },
    202,
  );
  expect((await service.worker().runOnce())?.status).toBe("succeeded");
  const before = await call(`${fixture.base}/package`);
  const { confirmation: generation } = await approve("generation");
  await call(
    `${fixture.base}/package/generate`,
    "POST",
    {
      confirmed: true,
      confirmationHash: generation.confirmationHash,
      stateHash: before.currentStateHash,
      requestId: "effect-generate",
    },
    202,
  );
  expect((await service.worker().runOnce())?.status).toBe("succeeded");
  const packaged = await call(
    `${fixture.base}/package/file?path=reference%2Fresolved-skills.json`,
  );
  expect(JSON.parse(packaged.text)[0].sources[0].effectDeclaration).toEqual(
    binding,
  );
  const { version: dedup } = await call(
    `/skills/${fixture.skill.id}/versions`,
    "POST",
    {
      files: fixture.files,
      confirmed: true,
      expectedHash: fixture.pin.hash,
    },
    200,
  );
  expect(dedup.uploadedBy).toBe(fixture.sourceVersion.uploadedBy);
  expect((await call(fixture.effects)).review).toEqual(confirmed);
  const nextFiles = [
    ...fixture.files,
    {
      path: "config.json",
      content: Buffer.from('{"mode":"new"}\n').toString("base64"),
    },
  ];
  const { preview: next } = await call(
    `/skills/${fixture.skill.id}/upload-preview`,
    "POST",
    { files: nextFiles },
    200,
    uploader,
  );
  await call(
    `/skills/${fixture.skill.id}/versions`,
    "POST",
    { files: nextFiles, confirmed: true, expectedHash: next.hash },
    201,
    uploader,
  );
  const nextReview = await call(
    `/skills/${fixture.skill.id}/versions/${next.hash}/effects`,
  );
  expect(nextReview.review).toBeNull();
  expect(nextReview.findings[0].code).toBe("SCRIPT_EFFECTS_PENDING");
  const { group } = await call(
    "/groups",
    "POST",
    { name: "Separate boundary" },
    201,
    admin,
  );
  const { skill } = await call(
    "/skills",
    "POST",
    { groupId: group.id, name: "example" },
    201,
    admin,
  );
  await call(
    `/skills/${skill.id}/versions`,
    "POST",
    { files: fixture.files, confirmed: true, expectedHash: fixture.pin.hash },
    201,
    admin,
  );
  expect(
    (
      await call(
        `/skills/${skill.id}/versions/${fixture.pin.hash}/effects`,
        "GET",
        undefined,
        200,
        admin,
      )
    ).review,
  ).toBeNull();
  await call(
    fixture.effects,
    "POST",
    {
      revision: confirmed.revision,
      scripts: [
        {
          ...rows[0],
          effects: ["local-writes", "network"],
          conditionalBehavior:
            "The invoked tool can contact a remote endpoint.",
        },
      ],
      note: "Correct the invoked tool's possible behavior.",
    },
    200,
    uploader,
  );
  expect((await call(`${fixture.base}/source-study`)).studies[0].studied).toBe(
    false,
  );
  expect(
    (await call(`${fixture.base}/gates/plan`)).confirmation.invalidatedAt,
  ).not.toBeNull();
  const plans = await call(`${fixture.base}/plan`);
  expect(plans.currentVersionId).toBeNull();
  expect(plans.versions[0].canonicalJson).toBe(planVersion.canonicalJson);
  const history = (await call(fixture.effects)).history;
  expect(
    history.find(
      (entry: { revision: number }) => entry.revision === confirmed.revision,
    ),
  ).toEqual(confirmed);
  await call(
    `${fixture.base}/gates/source-study/${fixture.skill.id}/preview`,
    "POST",
    {},
    409,
  );
  await call(`${fixture.base}/gates/plan/preview`, "POST", {}, 409, admin);
});
