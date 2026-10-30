import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
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
  expect(response.status, JSON.stringify(value)).toBe(status);
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
