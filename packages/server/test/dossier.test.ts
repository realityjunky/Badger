import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { reportLaneOutput } from "./fixtures/authoring.js";
import { planningRequest } from "./fixtures/planning.js";
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
const owner: TestPerson = { subject: "owner", email: "owner@example.com" };
const expert: TestPerson = { subject: "expert", email: "expert@example.com" };
let service: TestService;
afterEach(async () => service?.close());

async function call(
  route: string,
  method = "GET",
  body?: unknown,
  as = engineer,
  status = 200,
) {
  const response = await service.request(`/api/v1${route}`, {
    as,
    method,
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  expect(
    response.status,
    JSON.stringify(response.status === 500 ? service.logs.slice(-3) : value),
  ).toBe(status);
  return value;
}

async function setup() {
  service = await startTestService({
    environment: {
      BADGER_BOOTSTRAP_ADMINISTRATORS: admin.email,
      BADGER_ALLOWED_ORIGINS: "http://localhost",
    },
  });
  const { group } = await call(
    "/groups",
    "POST",
    { name: "Research" },
    admin,
    201,
  );
  const { workflow, version } = await call(
    "/workflows",
    "POST",
    {
      groupId: group.id,
      name: "report",
      goal: "Prepare a reviewed report.",
      intent: "new-skill",
      locale: "en",
    },
    admin,
    201,
  );
  for (const [person, role] of [
    [engineer, "Engineer"],
    [owner, "Workflow owner"],
    [expert, "Field expert"],
  ] as const)
    await call(
      "/bindings",
      "POST",
      {
        scopeType: "workflow",
        scopeId: workflow.id,
        email: person.email,
        role,
      },
      admin,
      201,
    );
  return {
    base: `/workflows/${workflow.id}/versions/${version.id}`,
    workflow,
    version,
    group,
  };
}

async function confirmedFact(base: string) {
  const root = `${base}/questionnaire`;
  const { person } = await call("/me", "GET", undefined, expert);
  const { person: author } = await call("/me");
  const { round } = await call(
    `${root}/rounds`,
    "POST",
    { title: "Report scope" },
    engineer,
    201,
  );
  const content = {
    text: "What does the report contain?",
    topic: "scope",
    targets: [{ kind: "workflow", id: "workflow" }],
    rationale: "Agree meaning.",
    evidence: [],
    assignees: [{ kind: "person", personId: person.id }],
    priority: 80,
  };
  const { question } = await call(
    `${root}/rounds/${round.id}/questions`,
    "POST",
    content,
    engineer,
    201,
  );
  const { preview } = await call(`${root}/rounds/${round.id}/publish-preview`);
  await call(`${root}/rounds/${round.id}/publish`, "POST", {
    confirmed: true,
    confirmationHash: preview.confirmationHash,
  });
  await call(
    `${root}/questions/${question.id}/answer`,
    "PUT",
    { revision: 0, questionRevision: 1, text: "A reviewed report." },
    expert,
  );
  await call(
    `${root}/questions/${question.id}/submit`,
    "POST",
    { revision: 1, questionRevision: 1 },
    expert,
  );
  const resolution = {
    revision: 1,
    kind: "confirmed",
    facts: [
      {
        text: "Return a reviewed report.",
        answers: [{ personId: person.id, revision: 2 }],
      },
    ],
  };
  const { preview: resolve } = await call(
    `${root}/questions/${question.id}/resolution-preview`,
    "POST",
    resolution,
  );
  await call(`${root}/questions/${question.id}/resolve`, "POST", {
    ...resolution,
    confirmed: true,
    confirmationHash: resolve.confirmationHash,
    requestId: "resolve-scope",
  });
  const { facts } = await call(root);
  const { preview: acknowledge } = await call(
    `${root}/facts/${facts[0].id}/acknowledgement-preview`,
    "POST",
    { decision: "acknowledged" },
    expert,
  );
  await call(
    `${root}/facts/${facts[0].id}/acknowledge`,
    "POST",
    {
      decision: "acknowledged",
      confirmed: true,
      confirmationHash: acknowledge.confirmationHash,
      requestId: "ack-scope",
    },
    expert,
  );
  return {
    factId: facts[0].id,
    expertId: person.id,
    engineerId: author.id,
    question,
    content,
  };
}

it("keeps one saved partial dossier across retries and refuses stale edits", async () => {
  const { base, group, version } = await setup();
  const { skill } = await call(
    "/skills",
    "POST",
    { groupId: group.id, name: "report-source" },
    admin,
    201,
  );
  const files = [
    {
      path: "SKILL.md",
      content: Buffer.from(
        "---\nname: report-source\ndescription: Report test\n---\n\nRead the report title.\n",
      ).toString("base64"),
    },
  ];
  const { preview } = await call(`/skills/${skill.id}/upload-preview`, "POST", {
    files,
  });
  await call(
    `/skills/${skill.id}/versions`,
    "POST",
    { files, confirmed: true, expectedHash: preview.hash },
    engineer,
    201,
  );
  await call(
    `${base}/pins`,
    "POST",
    { skillId: skill.id, hash: preview.hash },
    engineer,
    201,
  );
  await service.runSourceCheckJobs();
  const path = `${base}/working-dossier`;
  const first = await call(path);
  expect(first.available).toBe(true);
  expect(first.revision).toBe(0);
  expect(first.prompt.split("\n")[0]).toBe(
    "Study the pinned Skills for report version 0.1.0.",
  );
  const id = `skill/${skill.id}/inputs`;
  const edit = {
    editId: "first-source-edit",
    revision: first.revision,
    pinsHash: first.pinsHash,
    fields: {
      [id]: { state: "missing", reason: "Which title should be used?" },
    },
  };
  expect((await call(path, "PATCH", edit)).revision).toBe(1);
  const { label } = await call(base, "PATCH", {
    labelRevision: version.labelRevision,
    semanticVersion: "0.1.1",
  });
  const current = await call(path);
  expect(current.revision).toBe(1);
  expect(current.prompt.split("\n")[0]).toBe(
    "Study the pinned Skills for report version 0.1.1.",
  );
  expect(current.prompt).toContain("Omit both local path options by default.");
  expect(current.prompt).toContain(
    "Read the returned localPath for each file.",
  );
  expect((await call(`${path}/job`)).workflow).toMatchObject({
    number: version.number,
    versionId: version.id,
    versionLabel: "0.1.1",
  });
  expect(await call(path, "PATCH", edit)).toMatchObject({
    revision: 1,
    prompt: current.prompt,
  });
  await call(base, "PATCH", {
    labelRevision: label.labelRevision,
    semanticVersion: null,
  });
  const unlabelled = await call(path);
  expect(unlabelled.prompt.split("\n")[0]).toBe(
    "Study the pinned Skills for report version v1.",
  );
  await call(path, "PATCH", { ...edit, editId: "stale-edit" }, engineer, 409);
  await call(path, "PATCH", { ...edit, revision: 1 }, engineer, 409);
  await call(
    path,
    "PATCH",
    { ...edit, revision: 1, editId: "expert-edit" },
    expert,
    403,
  );
  const read = await call(path, "GET", undefined, expert);
  expect(
    read.projection.fields.find((field: { id: string }) => field.id === id),
  ).toMatchObject({
    blocker: "Which title should be used?",
  });
  const blocked = await call(
    `${base}/gates/dossier/preview`,
    "POST",
    {},
    owner,
    409,
  );
  expect(blocked.findings).toContainEqual(
    expect.objectContaining({
      message: expect.stringContaining("Which title should be used?"),
    }),
  );
});

it("builds from one mapped revision, stages one writer and an independent review, and fences stale builds", async () => {
  const { base, group, workflow } = await setup();
  const { skill } = await call(
    "/skills",
    "POST",
    { groupId: group.id, name: "report-source" },
    admin,
    201,
  );
  const body =
    "---\nname: report-source\ndescription: Produce a reviewed report\n---\n\nRecord a report.\n";
  const files = [
    { path: "SKILL.md", content: Buffer.from(body).toString("base64") },
  ];
  const { preview: upload } = await call(
    `/skills/${skill.id}/upload-preview`,
    "POST",
    { files },
  );
  await call(
    `/skills/${skill.id}/versions`,
    "POST",
    { files, expectedHash: upload.hash, confirmed: true },
    engineer,
    201,
  );
  await call(
    base + "/pins",
    "POST",
    { skillId: skill.id, hash: upload.hash },
    engineer,
    201,
  );
  await service.runSourceCheckJobs();
  const source = await call(base + "/gates/sources/preview", "POST", {});
  await call(base + "/gates/sources/commit", "POST", {
    confirmationHash: source.preview.confirmationHash,
    requestId: "pins",
  });
  const map = await call(base + "/working-dossier");
  const evidence = [
    {
      skillId: skill.id,
      hash: upload.hash,
      path: "SKILL.md",
      fileHash: createHash("sha256").update(body).digest("hex"),
      startLine: 6,
      endLine: 6,
    },
  ];
  const fields = Object.fromEntries(
    [
      ...map.projection.fields
        .filter((f: { required: boolean }) => f.required)
        .map((f: { id: string }) => f.id),
      "node/report/responsibility",
      "node/report/inputs",
      "node/report/outputSchemas",
      "node/report/trigger",
    ].map((id) => [
      id,
      { state: "source", value: "Prepare a reviewed report.", evidence },
    ]),
  );
  const edit = {
    revision: map.revision,
    pinsHash: map.pinsHash,
    editId: "mapped",
    fields,
    nodes: {
      report: {
        label: "Report",
        skillId: skill.id,
        hash: upload.hash,
        order: 0,
        kind: "node",
      },
    },
    contract: {
      nodes: {
        report: {
          kind: "action",
          outputSchemas: ["report.v1"],
          guardrails: [],
        },
      },
      outputSchemas: [
        {
          id: "report.v1",
          description: "Report results",
          artifacts: [],
          evidence: [{ id: "summary", required: true }],
        },
      ],
    },
  };
  await call(base + "/working-dossier", "PATCH", edit);
  const gate = base + "/gates/workflow-build";
  await call(gate + "/preview", "POST", {}, expert, 403);
  const last = await call(gate + "/preview", "POST", {});
  expect(last.plan.customNodes[0].implementation.skill).toBe("report-source");
  const submit = {
    confirmationHash: last.preview.confirmationHash,
    requestId: "build",
  };
  const built = await call(gate + "/commit", "POST", submit);
  expect(await call(gate + "/commit", "POST", submit)).toEqual(built);
  for (const stage of ["dossier", "plan", "proposal", "generation"])
    expect((await call(base + "/gates/" + stage)).confirmations).toEqual([]);
  const done = await service.worker().runOnce();
  expect(done?.error).toBeNull();
  expect(done?.status).toBe("succeeded");
  expect(
    (
      await call(
        base + "/package/authoring-jobs",
        "POST",
        { confirmed: true },
        engineer,
        201,
      )
    ).jobs,
  ).toEqual([]);
  const all = (await call(base + "/package/authoring")).jobs;
  expect(all.map((j: { laneId: string }) => j.laneId)).toEqual([
    "workflow-entry",
  ]);
  const { secret } = await call(
    "/me/tokens",
    "POST",
    { name: "Mapped agent", scopes: ["engineer"] },
    engineer,
    201,
  );
  const api = planningRequest(service);
  for (const lane of ["workflow-entry", "skill-review"]) {
    const job = (await call(base + "/package/authoring")).jobs.find(
      (entry: { laneId: string }) => entry.laneId === lane,
    );
    const path = base + "/drafting-jobs/" + job.id;
    let claim = await api(
      path + "/claim",
      "POST",
      { revision: job.revision },
      engineer,
      200,
      secret,
    );
    const bundle = claim.contextBundle;
    const result = {
      laneOutput: reportLaneOutput(bundle),
      ...(lane === "workflow-entry" && {
        nodeGuidance: reportLaneOutput({
          ...bundle,
          authoring: {
            ...bundle.authoring,
            lane: "skill-core",
            handoff: bundle.authoring.companion.handoff,
          },
        }),
      }),
    };
    if (result.nodeGuidance) {
      const problem = "Who can authorize recording the report?";
      const finding = {
        severity: "important",
        problem,
        disposition: {
          route: "question",
          subject: "Recording authority",
          target: "/topics/guardrails",
          authority: "Report owner",
          acceptance: problem,
        },
      };
      const { job: blocked } = await api(
        path + "/submit",
        "POST",
        {
          leaseId: claim.job.lease.id,
          contextHash: claim.job.contextHash,
          result: {
            ...result,
            nodeGuidance: {
              ...result.nodeGuidance,
              schemaVersion: 2,
              status: "BLOCKED",
              findings: [finding],
            },
          },
        },
        engineer,
        200,
        secret,
      );
      const submitted = (await call(base + "/package/authoring")).jobs;
      expect(submitted).toMatchObject([{ id: job.id, status: "submitted" }]);
      expect(submitted[0].staged).toBeFalsy();
      expect(
        (await call(base + "/package/findings")).observations,
      ).toMatchObject([
        {
          job_id: job.id,
          lane: "skill-core",
          current: true,
          finding: { problem },
        },
      ]);
      const refused = await call(
        path + "/accept-preview",
        "POST",
        { revision: blocked.revision },
        engineer,
        409,
      );
      expect(refused.error.message).toContain("Package → Findings");
      claim = await api(
        path + "/claim",
        "POST",
        { revision: blocked.revision },
        engineer,
        200,
        secret,
      );
    }
    await api(
      path + "/submit",
      "POST",
      {
        leaseId: claim.job.lease.id,
        contextHash: claim.job.contextHash,
        result,
      },
      engineer,
      200,
      secret,
    );
  }
  const candidate = (await call(base + "/package")).package.assembledHash;
  expect(candidate).toMatch(/^[a-f0-9]{64}$/);
  await call(base + "/review/approve-preview", "POST", {}, owner, 409);
  expect((await call(base + "/evaluations")).jobs).toEqual([
    expect.objectContaining({
      status: "queued",
      evaluationPackageHash: candidate,
    }),
  ]);
  const evaluation = await service.worker().runOnce();
  expect(evaluation?.status, JSON.stringify(evaluation?.outcome)).toBe(
    "succeeded",
  );
  const review = await call(base + "/review", "GET", undefined, owner);
  expect(review.behavior).toMatchObject({
    mapRevision: 1,
    changes: expect.arrayContaining(["Report"]),
  });
  for (const action of ["approve", "publish"]) {
    const { preview } = await call(
      base + "/review/" + action + "-preview",
      "POST",
      {},
      owner,
    );
    await call(
      base + "/review/" + action,
      "POST",
      {
        confirmed: true,
        confirmationHash: preview.confirmationHash,
        requestId: "mapped-" + action,
      },
      owner,
    );
  }
  await call(base + "/working-dossier", "PATCH", {
    ...edit,
    editId: "revised",
    revision: 1,
    fields: {
      ...fields,
      "node/report/responsibility": {
        state: "source",
        value: "Record report evidence.",
        evidence,
      },
    },
  });
  await call(
    gate + "/commit",
    "POST",
    { ...submit, requestId: "stale" },
    engineer,
    409,
  );
  expect((await call(base + "/package")).package.status).toBe("invalidated");
  expect(
    (
      await call(
        "/workflows/" + workflow.id + "/publications",
        "GET",
        undefined,
        owner,
      )
    ).publications[0].packageHash,
  ).toBe(candidate);
}, 60000);

function semantics(factId: string) {
  const topic = {
    summary: "Return the report; no additional behavior applies.",
    factIds: [factId],
  };
  return {
    nodes: [
      {
        id: "report",
        order: 0,
        responsibility: { summary: "Prepare the report.", factIds: [factId] },
      },
    ],
    topics: Object.fromEntries(
      [
        "inputs",
        "prerequisites",
        "bindings",
        "interfaces",
        "requiredSkillCalls",
        "augmentations",
        "outputSchemas",
        "completionEvidence",
        "decisions",
        "guardrails",
        "routes",
        "boundedCycles",
        "capabilities",
        "finalization",
        "executableDisclosures",
        "recoveryPolicy",
      ].map((name) => [name, topic]),
    ),
  };
}

describe("dossier versions", () => {
  it("refuses composition while the kernel's record readiness has blockers", async () => {
    const { base } = await setup();
    const { record } = await call(
      `${base}/questionnaire/inferences`,
      "POST",
      {
        topic: "interfaces",
        statement: "One report is sufficient.",
      },
      engineer,
      201,
    );
    const result = await call(
      `${base}/dossier/preview`,
      "POST",
      {},
      engineer,
      409,
    );
    expect(result.readiness).toContainEqual(
      expect.objectContaining({
        topic: "interfaces",
        ready: false,
        blockers: [
          {
            code: "unconfirmed-inference",
            record: { type: "inference", id: record.id, revision: 1 },
          },
        ],
      }),
    );
    expect((await call(`${base}/dossier`)).versions).toEqual([]);
  });

  it("composes one immutable canonical snapshot from acknowledged records and shows kernel validation findings", async () => {
    const { base } = await setup();
    const { factId, expertId, engineerId, question } =
      await confirmedFact(base);
    const input = semantics(factId);
    const invalid = await call(`${base}/dossier/preview`, "POST", {
      ...input,
      nodes: [],
    });
    expect(invalid.composition.findings).toContainEqual({
      path: "nodes",
      message: "At least one Node responsibility is required",
    });
    const { composition } = await call(
      `${base}/dossier/preview`,
      "POST",
      input,
    );
    expect(composition.findings).toEqual([]);
    expect(composition.hash).toBe(
      createHash("sha256").update(composition.canonicalJson).digest("hex"),
    );
    expect(JSON.parse(composition.canonicalJson)).toEqual(composition.snapshot);
    expect(composition.snapshot.dossier.workflow).toEqual({
      name: "report",
      goal: "Prepare a reviewed report.",
      intent: "new-skill",
      defaultLocale: "en",
    });
    expect(composition.snapshot.dossier.confirmedUserFacts).toEqual([
      {
        id: factId,
        statement: "Return a reviewed report.",
        provenance: {
          confirmedBy: engineerId,
          acknowledgedBy: expertId,
          answerRevisions: [
            { answerId: `${question.id}:${expertId}`, revision: 2 },
          ],
        },
      },
    ]);
    expect(composition.snapshot.ledger.items).toContainEqual(
      expect.objectContaining({
        record: { type: "confirmed-fact", id: factId, revision: 1 },
        relatedRecords: expect.arrayContaining([
          { type: "answer", id: `${question.id}:${expertId}`, revision: 2 },
        ]),
      }),
    );
    const { version } = await call(
      `${base}/dossier/compose`,
      "POST",
      { ...input, confirmationHash: composition.hash },
      engineer,
      201,
    );
    const replay = await call(`${base}/dossier/compose`, "POST", {
      topics: Object.fromEntries(Object.entries(input.topics).reverse()),
      nodes: input.nodes,
      confirmationHash: composition.hash,
    });
    expect(replay.version).toEqual(version);
    expect(
      (await call(`${base}/dossier`, "GET", undefined, owner)).versions,
    ).toEqual([version]);
    await call(
      `${base}/dossier/compose`,
      "POST",
      { ...input, nodes: [], confirmationHash: invalid.composition.hash },
      engineer,
      409,
    );
    expect((await call(`${base}/dossier`)).versions).toHaveLength(1);
  });

  it("lets the signed-in Workflow owner approve exactly the composed dossier hash", async () => {
    const { base } = await setup();
    const { factId } = await confirmedFact(base);
    const input = semantics(factId);
    const { composition } = await call(
      `${base}/dossier/preview`,
      "POST",
      input,
    );
    const { version } = await call(
      `${base}/dossier/compose`,
      "POST",
      { ...input, confirmationHash: composition.hash },
      engineer,
      201,
    );
    const inbox = await call("/me/inbox", "GET", undefined, owner);
    expect(inbox.items).toContainEqual(
      expect.objectContaining({
        gate: "dossier",
        kind: "gate-ready",
        state: "unread",
        href: expect.stringContaining("#dossier"),
      }),
    );
    await call(`${base}/gates/dossier/preview`, "POST", {}, engineer, 403);
    await call(`${base}/gates/dossier/preview`, "POST", {}, expert, 403);
    const { preview } = await call(
      `${base}/gates/dossier/preview`,
      "POST",
      {},
      owner,
    );
    expect(preview.boundHashes.dossier).toBe(version.hash);
    expect(preview.records).toContainEqual(
      expect.objectContaining({
        type: "dossier-version",
        id: version.id,
        hash: version.hash,
      }),
    );
    await call(
      `${base}/gates/dossier/commit`,
      "POST",
      { confirmationHash: "0".repeat(64), requestId: "approve-dossier" },
      owner,
      409,
    );
    const result = await call(
      `${base}/gates/dossier/commit`,
      "POST",
      {
        confirmationHash: preview.confirmationHash,
        requestId: "approve-dossier",
      },
      owner,
    );
    expect(result.confirmation.boundHashes.dossier).toBe(version.hash);
    expect(result.confirmation.actorId).toBe(
      (await call("/me", "GET", undefined, owner)).person.id,
    );
    expect(
      await call(
        `${base}/gates/dossier/commit`,
        "POST",
        {
          confirmationHash: preview.confirmationHash,
          requestId: "approve-dossier",
        },
        owner,
      ),
    ).toEqual(result);
    expect((await call(`${base}`)).version.stages).toContainEqual({
      id: "dossier",
      state: "done",
    });
    expect(
      (await call("/me/inbox", "GET", undefined, owner)).items
        .filter((i: { gate: string }) => i.gate === "dossier")
        .every((i: { state: string }) => i.state === "done"),
    ).toBe(true);
  });

  it("supersedes an approval atomically when a contained fact changes, preserves the artifact and replay, and notifies both responsible roles", async () => {
    const { base } = await setup();
    const { factId, question, content } = await confirmedFact(base);
    const input = semantics(factId);
    const { composition } = await call(
      `${base}/dossier/preview`,
      "POST",
      input,
    );
    const { version } = await call(
      `${base}/dossier/compose`,
      "POST",
      { ...input, confirmationHash: composition.hash },
      engineer,
      201,
    );
    const { preview } = await call(
      `${base}/gates/dossier/preview`,
      "POST",
      {},
      owner,
    );
    const commit = {
      confirmationHash: preview.confirmationHash,
      requestId: "approved-old-fact",
    };
    const approved = await call(
      `${base}/gates/dossier/commit`,
      "POST",
      commit,
      owner,
    );
    await call(`${base}/questionnaire/questions/${question.id}`, "PATCH", {
      ...content,
      revision: 1,
      text: "Which fields does the revised report contain?",
    });
    const { confirmation } = await call(`${base}/gates/dossier`);
    expect(confirmation).toEqual(
      expect.objectContaining({
        id: approved.confirmation.id,
        invalidatedAt: expect.any(String),
        invalidationReason: expect.stringContaining("records changed"),
      }),
    );
    expect(
      await call(`${base}/gates/dossier/commit`, "POST", commit, owner),
    ).toEqual(approved);
    const read = await call(`${base}/dossier`);
    expect(read.versions).toEqual([version]);
    expect(read.currentVersionId).toBeNull();
    expect((await call(base)).version.stages).toContainEqual({
      id: "dossier",
      state: "invalidated",
    });
    for (const person of [engineer, owner])
      expect(
        (await call("/me/inbox", "GET", undefined, person)).items,
      ).toContainEqual(
        expect.objectContaining({
          gate: "dossier",
          kind: "gate-invalidated",
          state: "unread",
        }),
      );
    const stale = await call(
      `${base}/gates/dossier/preview`,
      "POST",
      {},
      owner,
      409,
    );
    expect(stale.findings).toContainEqual(
      expect.objectContaining({ code: "DOSSIER_SUPERSEDED" }),
    );
  });

  it("selects an earlier dossier version again when its content is composed again, superseding the newer version's approval", async () => {
    const { base } = await setup();
    const { factId } = await confirmedFact(base);
    const compose = async (
      input: ReturnType<typeof semantics>,
      status = 201,
    ) => {
      const { composition } = await call(
        `${base}/dossier/preview`,
        "POST",
        input,
      );
      return (
        await call(
          `${base}/dossier/compose`,
          "POST",
          { ...input, confirmationHash: composition.hash },
          engineer,
          status,
        )
      ).version;
    };
    const approve = async (requestId: string) => {
      const { preview } = await call(
        `${base}/gates/dossier/preview`,
        "POST",
        {},
        owner,
      );
      return call(
        `${base}/gates/dossier/commit`,
        "POST",
        { confirmationHash: preview.confirmationHash, requestId },
        owner,
      );
    };
    const first = semantics(factId);
    const second = structuredClone(first);
    second.nodes[0].responsibility.summary =
      "Prepare and return the reviewed report.";
    const original = await compose(first);
    const replacement = await compose(second);
    const approved = await approve("approve-replacement");
    expect(approved.confirmation.boundHashes.dossier).toBe(replacement.hash);

    expect(await compose(first)).toEqual(original);
    const read = await call(`${base}/dossier`);
    expect(read.versions).toEqual([replacement, original]);
    expect(read).toMatchObject({
      headVersionId: original.id,
      currentVersionId: original.id,
    });
    const { confirmation } = await call(`${base}/gates/dossier`);
    expect(confirmation).toMatchObject({
      id: approved.confirmation.id,
      invalidationReason: expect.stringContaining("earlier dossier version"),
    });
    expect(confirmation.invalidatedAt).not.toBeNull();
    for (const person of [engineer, owner])
      expect(
        (await call("/me/inbox", "GET", undefined, person)).items,
      ).toContainEqual(
        expect.objectContaining({
          gate: "dossier",
          kind: "gate-invalidated",
          state: "unread",
        }),
      );
    expect(
      (await call("/me/inbox", "GET", undefined, owner)).items,
    ).toContainEqual(
      expect.objectContaining({
        gate: "dossier",
        kind: "gate-ready",
        state: "unread",
      }),
    );
    const { events } = await call(
      "/audit-events?action=dossier.reselected",
      "GET",
      undefined,
      admin,
    );
    expect(events).toEqual([
      expect.objectContaining({
        targetId: original.id,
        before: { revision: 2, hash: replacement.hash },
        after: { revision: 1, hash: original.hash },
      }),
    ]);

    const reapproved = await approve("approve-original-again");
    expect(reapproved.confirmation.boundHashes.dossier).toBe(original.hash);
    expect(
      (await call(`${base}/gates/dossier`)).confirmations.find(
        (c: { id: string }) => c.id === approved.confirmation.id,
      ).supersededBy,
    ).toBe(reapproved.confirmation.id);
    expect(await compose(first, 200)).toEqual(original);
    expect((await call(`${base}/gates/dossier`)).confirmation).toMatchObject({
      id: reapproved.confirmation.id,
      invalidatedAt: null,
    });
  });

  it("snapshots pinned source identities and evidence, supersedes on source fact changes, and requires a replacement approval", async () => {
    const { base, group } = await setup();
    const { skill } = await call(
      "/skills",
      "POST",
      { groupId: group.id, name: "prepare" },
      admin,
      201,
    );
    const text =
      "---\nname: prepare\ndescription: Prepare a report\n---\n\nReturn report text.\n";
    const files = [
      { path: "SKILL.md", content: Buffer.from(text).toString("base64") },
    ];
    const { preview: upload } = await call(
      `/skills/${skill.id}/upload-preview`,
      "POST",
      { files },
    );
    await call(
      `/skills/${skill.id}/versions`,
      "POST",
      { files, confirmed: true, expectedHash: upload.hash },
      engineer,
      201,
    );
    const pin = { skillId: skill.id, hash: upload.hash };
    await call(`${base}/pins`, "POST", pin, engineer, 201);
    await service.runSourceCheckJobs();
    async function confirm(gate: string, requestId: string, as = engineer) {
      const { preview } = await call(
        `${base}/gates/${gate}/preview`,
        "POST",
        {},
        as,
      );
      return call(
        `${base}/gates/${gate}/commit`,
        "POST",
        { confirmationHash: preview.confirmationHash, requestId },
        as,
      );
    }
    await confirm("sources", "sources");
    const content = {
      statement: "The Skill returns report text.",
      evidence: [
        {
          ...pin,
          path: "SKILL.md",
          startLine: 6,
          endLine: 6,
          fileHash: createHash("sha256").update(text).digest("hex"),
        },
      ],
    };
    const { record } = await call(
      `${base}/source-study/facts`,
      "POST",
      content,
      engineer,
      201,
    );
    await call(
      `${base}/dossier/preview`,
      "POST",
      semantics(record.id),
      engineer,
      409,
    );
    await confirm(`source-study/${skill.id}`, "study");
    const { composition } = await call(
      `${base}/dossier/preview`,
      "POST",
      semantics(record.id),
    );
    expect(composition.snapshot.dossier.sources).toEqual([
      expect.objectContaining({
        id: skill.id,
        name: "prepare",
        contentHash: upload.hash,
        location: "skills/prepare",
      }),
    ]);
    expect(composition.snapshot.dossier.sourceDerivedFacts).toEqual([
      {
        id: record.id,
        statement: content.statement,
        sourceId: skill.id,
        evidencePath: "SKILL.md",
      },
    ]);
    const { version } = await call(
      `${base}/dossier/compose`,
      "POST",
      { ...semantics(record.id), confirmationHash: composition.hash },
      engineer,
      201,
    );
    const first = await confirm("dossier", "first-dossier", owner);
    await call(`${base}/source-study/facts/${record.id}`, "PATCH", {
      ...content,
      statement: "The Skill returns a revised report.",
      revision: 1,
    });
    expect(
      (await call(`${base}/gates/dossier`)).confirmation.invalidatedAt,
    ).not.toBeNull();
    await confirm(`source-study/${skill.id}`, "study-again");
    const { composition: next } = await call(
      `${base}/dossier/preview`,
      "POST",
      semantics(record.id),
    );
    const { version: replacement } = await call(
      `${base}/dossier/compose`,
      "POST",
      { ...semantics(record.id), confirmationHash: next.hash },
      engineer,
      201,
    );
    expect(replacement.number).toBe(2);
    expect(replacement.hash).not.toBe(version.hash);
    const second = await confirm("dossier", "second-dossier", owner);
    const history = await call(`${base}/gates/dossier`);
    expect(
      history.confirmations.find(
        (c: { id: string }) => c.id === first.confirmation.id,
      ).supersededBy,
    ).toBe(second.confirmation.id);
    await call(`${base}/pins/${skill.id}`, "DELETE", { revision: 1 });
    expect(
      (await call(`${base}/gates/dossier`)).confirmation.invalidatedAt,
    ).not.toBeNull();
    expect((await call(`${base}/dossier`)).versions.at(-1)).toEqual(version);
  });

  it("refuses stale previews and caller-supplied facts, and keeps token readers from signing off", async () => {
    const { base, workflow } = await setup();
    const { factId } = await confirmedFact(base);
    const input = semantics(factId);
    await call(
      `${base}/dossier/preview`,
      "POST",
      { ...input, confirmedUserFacts: [] },
      engineer,
      400,
    );
    await call(`${base}/dossier/preview`, "POST", input, owner, 403);
    await call(`${base}/dossier/preview`, "POST", input, expert, 403);
    const { composition } = await call(
      `${base}/dossier/preview`,
      "POST",
      input,
    );
    await call(
      `${base}/dossier/compose`,
      "POST",
      { ...input, confirmationHash: composition.hash },
      engineer,
      201,
    );
    const { preview } = await call(
      `${base}/gates/dossier/preview`,
      "POST",
      {},
      owner,
    );
    const nextInput = {
      ...input,
      nodes: [
        {
          ...input.nodes[0],
          responsibility: {
            summary: "Prepare and return the reviewed report.",
            factIds: [factId],
          },
        },
      ],
    };
    const { composition: next } = await call(
      `${base}/dossier/preview`,
      "POST",
      nextInput,
    );
    const { version: latest } = await call(
      `${base}/dossier/compose`,
      "POST",
      { ...nextInput, confirmationHash: next.hash },
      engineer,
      201,
    );
    await call(
      `${base}/gates/dossier/commit`,
      "POST",
      {
        confirmationHash: preview.confirmationHash,
        requestId: "stale-approval",
      },
      owner,
      409,
    );
    expect((await call(`${base}/dossier`)).currentVersionId).toBe(latest.id);
    for (const person of [owner, engineer]) {
      const { secret } = await call(
        "/me/tokens",
        "POST",
        { name: "Agent", scopes: ["engineer"] },
        person,
        201,
      );
      const headers = {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        "x-badger-agent-host": "test-agent",
      };
      expect(
        (await service.request(`/api/v1${base}/dossier`, { headers })).status,
      ).toBe(200);
      for (const route of [
        "dossier/preview",
        "dossier/compose",
        "gates/dossier/preview",
        "gates/dossier/commit",
      ])
        expect(
          (
            await service.request(`/api/v1${base}/${route}`, {
              method: "POST",
              headers,
              body: JSON.stringify({}),
            })
          ).status,
        ).toBe(403);
    }
    await call(
      `${base}/dossier`,
      "GET",
      undefined,
      { subject: "outsider", email: "outsider@example.com" },
      403,
    );
    await call(
      base.replace(workflow.id, "other-workflow") + "/dossier",
      "GET",
      undefined,
      admin,
      404,
    );
    const { record } = await call(
      `${base}/questionnaire/assumptions`,
      "POST",
      { topic: "inputs", statement: "The report needs no inputs." },
      engineer,
      201,
    );
    const blocked = await call(
      `${base}/dossier/compose`,
      "POST",
      { ...nextInput, confirmationHash: next.hash },
      engineer,
      409,
    );
    expect(blocked.readiness).toContainEqual(
      expect.objectContaining({
        topic: "inputs",
        blockers: [
          {
            code: "unresolved-assumption",
            record: { type: "assumption", id: record.id, revision: 1 },
          },
        ],
      }),
    );
  });
});
