import { afterEach, describe, expect, it } from "vitest";
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
const expert: TestPerson = { subject: "expert", email: "expert@example.com" };
const observer: TestPerson = {
  subject: "observer",
  email: "observer@example.com",
};
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
      name: "ledger",
      goal: "Agree the workflow meaning.",
      intent: "new-skill",
      locale: "en",
    },
    admin,
    201,
  );
  for (const [person, role] of [
    [engineer, "Engineer"],
    [expert, "Field expert"],
    [observer, "Observer"],
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
  const { person } = await call("/me", "GET", undefined, expert);
  const base = `/workflows/${workflow.id}/versions/${version.id}`;
  return {
    base,
    questionnaire: `${base}/questionnaire`,
    workflow,
    version,
    group,
    expertId: person.id,
  };
}

async function round(base: string, expertId: string, topic = "interfaces") {
  const { round } = await call(
    `${base}/rounds`,
    "POST",
    { title: "Contracts" },
    engineer,
    201,
  );
  const content = {
    text: "Which columns does the consumer require?",
    topic,
    targets: [{ kind: "workflow", id: "workflow" }],
    rationale: "Agree the interface.",
    evidence: [],
    assignees: [{ kind: "person", personId: expertId }],
    priority: 80,
  };
  const { question } = await call(
    `${base}/rounds/${round.id}/questions`,
    "POST",
    content,
    engineer,
    201,
  );
  return { round, question, content };
}

async function publish(base: string, id: string) {
  const { preview } = await call(`${base}/rounds/${id}/publish-preview`);
  await call(`${base}/rounds/${id}/publish`, "POST", {
    confirmed: true,
    confirmationHash: preview.confirmationHash,
  });
  return preview.confirmationHash;
}

async function sign(
  base: string,
  resource: string,
  previewAction: string,
  action: string,
  input: unknown,
  as = engineer,
) {
  const { preview } = await call(
    `${base}/${resource}/${previewAction}`,
    "POST",
    input,
    as,
  );
  return call(
    `${base}/${resource}/${action}`,
    "POST",
    {
      ...(input as object),
      confirmed: true,
      confirmationHash: preview.confirmationHash,
      requestId: crypto.randomUUID(),
    },
    as,
  );
}

async function answer(base: string, id: string) {
  await call(
    `${base}/questions/${id}/answer`,
    "PUT",
    { revision: 0, questionRevision: 1, text: "Use sample_id and sequence." },
    expert,
  );
  await call(
    `${base}/questions/${id}/submit`,
    "POST",
    { revision: 1, questionRevision: 1 },
    expert,
  );
}

describe("the questionnaire ledger and readiness", () => {
  it("reports submitted answer revisions changed since a round while keeping private answer drafts hidden", async () => {
    const { questionnaire: base, expertId } = await setup();
    const first = await round(base, expertId);
    await publish(base, first.round.id);
    await answer(base, first.question.id);
    const later = await round(base, expertId, "inputs");
    await publish(base, later.round.id);
    await call(
      `${base}/questions/${first.question.id}/answer`,
      "PUT",
      {
        revision: 2,
        questionRevision: 1,
        text: "Private unsubmitted correction",
      },
      expert,
    );
    const privateView = await call(
      `${base}/ledger?sinceRound=${later.round.id}`,
      "GET",
      undefined,
      observer,
    );
    expect(JSON.stringify(privateView)).not.toContain(
      "Private unsubmitted correction",
    );
    expect(privateView.changes).toEqual({
      added: [],
      changed: [],
      resolved: [],
    });
    await call(
      `${base}/questions/${first.question.id}/submit`,
      "POST",
      { revision: 3, questionRevision: 1 },
      expert,
    );
    const changed = await call(
      `${base}/ledger?sinceRound=${later.round.id}`,
      "GET",
      undefined,
      observer,
    );
    expect(changed.changes.changed).toEqual([
      expect.objectContaining({
        before: expect.objectContaining({
          relatedRecords: [
            {
              type: "answer",
              id: `${first.question.id}:${expertId}`,
              revision: 2,
            },
          ],
        }),
        after: expect.objectContaining({
          relatedRecords: [
            {
              type: "answer",
              id: `${first.question.id}:${expertId}`,
              revision: 4,
            },
          ],
        }),
      }),
    ]);
  });

  it("keeps a disputed restatement visible until a new resolution replaces it", async () => {
    const { questionnaire: base, expertId } = await setup();
    const { round: batch, question } = await round(base, expertId);
    await publish(base, batch.id);
    await answer(base, question.id);
    const resolution = {
      revision: 1,
      kind: "confirmed",
      facts: [
        {
          text: "Use sample_id.",
          answers: [{ personId: expertId, revision: 2 }],
        },
      ],
    };
    await sign(
      base,
      `questions/${question.id}`,
      "resolution-preview",
      "resolve",
      resolution,
    );
    const fact = (await call(base)).facts[0];
    await sign(
      base,
      `facts/${fact.id}`,
      "acknowledgement-preview",
      "acknowledge",
      { decision: "disputed", reason: "The sequence column is also required." },
      expert,
    );
    let ledger = await call(`${base}/ledger`);
    expect(
      ledger.handoff.readiness
        .find((r: { topic: string }) => r.topic === "interfaces")
        .blockers.map((b: { code: string }) => b.code),
    ).toEqual(["unresolved-question", "dispute"]);
    await call(
      `${base}/questions/${question.id}/answer`,
      "PUT",
      { revision: 2, questionRevision: 1, text: "Use sample_id and sequence." },
      expert,
    );
    await call(
      `${base}/questions/${question.id}/submit`,
      "POST",
      { revision: 3, questionRevision: 1 },
      expert,
    );
    await sign(
      base,
      `questions/${question.id}`,
      "resolution-preview",
      "resolve",
      {
        ...resolution,
        facts: [
          {
            text: "Use sample_id and sequence.",
            answers: [{ personId: expertId, revision: 4 }],
          },
        ],
      },
    );
    const current = (await call(base)).facts.find(
      (f: { active: boolean }) => f.active,
    );
    await sign(
      base,
      `facts/${current.id}`,
      "acknowledgement-preview",
      "acknowledge",
      { decision: "acknowledged" },
      expert,
    );
    ledger = await call(`${base}/ledger`);
    const currentResolution = (await call(base)).resolutions.find(
      (r: { revision: number }) => r.revision === 2,
    );
    expect(
      ledger.handoff.ledger.confirmedUserFacts[0].relatedRecords,
    ).toContainEqual({
      type: "resolution",
      id: currentResolution.id,
      revision: 2,
    });
    expect(
      ledger.handoff.readiness.find(
        (r: { topic: string }) => r.topic === "interfaces",
      ).blockers,
    ).toEqual([]);
    expect(
      ledger.handoff.ledger.confirmedUserFacts.map(
        (i: { record: { id: string } }) => i.record.id,
      ),
    ).toEqual([current.id]);
  });

  it("binds linked draft revisions into the human resolution preview and refuses retroactive confirmation", async () => {
    const { questionnaire: base, expertId } = await setup();
    const { round: batch, question } = await round(base, expertId);
    const input = {
      topic: "interfaces",
      statement: "The consumer requires sample_id.",
      questionId: question.id,
    };
    const { record } = await call(
      `${base}/inferences`,
      "POST",
      input,
      engineer,
      201,
    );
    await publish(base, batch.id);
    await answer(base, question.id);
    const resolution = {
      revision: 1,
      kind: "confirmed",
      facts: [
        {
          text: input.statement,
          answers: [{ personId: expertId, revision: 2 }],
        },
      ],
    };
    const { preview } = await call(
      `${base}/questions/${question.id}/resolution-preview`,
      "POST",
      resolution,
    );
    await call(`${base}/inferences/${record.id}`, "PATCH", {
      ...input,
      statement: "The consumer requires score.",
      revision: 1,
    });
    await call(
      `${base}/questions/${question.id}/resolve`,
      "POST",
      {
        ...resolution,
        confirmed: true,
        confirmationHash: preview.confirmationHash,
        requestId: "stale-draft-preview",
      },
      engineer,
      409,
    );
    await sign(
      base,
      `questions/${question.id}`,
      "resolution-preview",
      "resolve",
      resolution,
    );
    await call(`${base}/inferences`, "POST", input, engineer, 409);
  });

  it("retains deferral resolutions without blocking and compares added, changed and resolved records to the published round", async () => {
    const { questionnaire: base, expertId, group } = await setup();
    const { round: batch, question } = await round(base, expertId);
    const { record: assumption } = await call(
      `${base}/assumptions`,
      "POST",
      {
        topic: "inputs",
        statement: "Samples arrive frozen.",
        questionId: null,
      },
      engineer,
      201,
    );
    const publicationHash = await publish(base, batch.id);
    await answer(base, question.id);
    await sign(
      base,
      `questions/${question.id}`,
      "resolution-preview",
      "resolve",
      {
        revision: 1,
        kind: "deferred",
        deferredKind: "out-of-scope",
        reason: "This contract belongs to a later workflow.",
      },
    );
    await call(`${base}/assumptions/${assumption.id}`, "PATCH", {
      revision: 1,
      topic: "inputs",
      statement: "Samples arrive refrigerated.",
      questionId: null,
    });
    const { record: inference } = await call(
      `${base}/inferences`,
      "POST",
      {
        topic: "inputs",
        statement: "Samples require cold storage.",
        questionId: null,
      },
      engineer,
      201,
    );
    const view = await call(`${base}/ledger?sinceRound=${batch.id}`);
    expect(view.handoff.deferredQuestions).toEqual([
      expect.objectContaining({
        record: { type: "question", id: question.id, revision: 1 },
        resolution: expect.objectContaining({
          kind: "deferred",
          reason: "This contract belongs to a later workflow.",
        }),
      }),
    ]);
    expect(
      view.handoff.readiness.find(
        (r: { topic: string }) => r.topic === "interfaces",
      ),
    ).toEqual({ topic: "interfaces", ready: true, blockers: [] });
    expect(
      view.changes.added.map((i: { record: { id: string } }) => i.record.id),
    ).toContain(inference.id);
    expect(view.changes.changed).toEqual([
      expect.objectContaining({
        before: expect.objectContaining({
          statement: "Samples arrive frozen.",
        }),
        after: expect.objectContaining({
          statement: "Samples arrive refrigerated.",
        }),
      }),
    ]);
    expect(view.changes.resolved).toEqual([
      expect.objectContaining({
        before: expect.objectContaining({ state: "open" }),
        after: expect.objectContaining({ state: "deferred" }),
      }),
    ]);
    // Retrying publication must preserve the original baseline.
    await call(`${base}/rounds/${batch.id}/publish`, "POST", {
      confirmed: true,
      confirmationHash: publicationHash,
    });
    expect(
      (await call(`${base}/ledger?sinceRound=${batch.id}`)).changes,
    ).toEqual(view.changes);
    const unrelated = await call(
      "/workflows",
      "POST",
      {
        groupId: group.id,
        name: "another",
        goal: "Another workflow.",
        intent: "new-skill",
        locale: "en",
      },
      admin,
      201,
    );
    await call(
      `/workflows/${unrelated.workflow.id}/versions/${unrelated.version.id}/questionnaire/ledger?sinceRound=${batch.id}`,
      "GET",
      undefined,
      admin,
      404,
    );
  });

  it("links source facts and blocks every topic until the pinned version has been studied", async () => {
    const { base, questionnaire, group } = await setup();
    const { skill } = await call(
      "/skills",
      "POST",
      { groupId: group.id, name: "contract-source" },
      admin,
      201,
    );
    const files = [
      {
        path: "SKILL.md",
        content: Buffer.from(
          "---\nname: contract-source\ndescription: Source contract\n---\n\nUse sample_id and sequence.\n",
        ).toString("base64"),
      },
    ];
    const { preview } = await call(
      `/skills/${skill.id}/upload-preview`,
      "POST",
      { files },
    );
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
    const inventory = await call(
      `/skills/${skill.id}/versions/${preview.hash}`,
    );
    const evidence = {
      skillId: skill.id,
      hash: preview.hash,
      path: "SKILL.md",
      startLine: 6,
      endLine: 6,
      fileHash: inventory.version.inventory[0].hash,
    };
    const { record } = await call(
      `${base}/source-study/facts`,
      "POST",
      { statement: "Use sample_id and sequence.", evidence: [evidence] },
      engineer,
      201,
    );
    const { handoff } = await call(`${questionnaire}/ledger`);
    expect(handoff.ledger.sourceDerivedFacts).toEqual([
      expect.objectContaining({
        record: { type: "source-fact", id: record.id, revision: 1 },
      }),
    ]);
    expect(handoff.readiness).toHaveLength(17);
    expect(
      handoff.readiness.every(
        (r: { ready: boolean; blockers: { code: string }[] }) =>
          !r.ready && r.blockers.some((b) => b.code === "unstudied-pin"),
      ),
    ).toBe(true);
    await service.runSourceCheckJobs();
    for (const gate of ["sources", `source-study/${skill.id}`]) {
      const { preview: gatePreview } = await call(
        `${base}/gates/${gate}/preview`,
        "POST",
        {},
      );
      await call(`${base}/gates/${gate}/commit`, "POST", {
        confirmationHash: gatePreview.confirmationHash,
        requestId: crypto.randomUUID(),
      });
    }
    const ready = await call(`${questionnaire}/ledger`);
    expect(ready.handoff.status).toBe("complete");
    expect(
      ready.handoff.readiness.every((r: { ready: boolean }) => r.ready),
    ).toBe(true);
  });

  it("requires every answering expert's acknowledgement before accepting a fact or its linked inference, and reopens on correction", async () => {
    const { questionnaire: base, expertId } = await setup();
    const { round: batch, question } = await round(base, expertId);
    await call(
      `${base}/inferences`,
      "POST",
      {
        topic: "interfaces",
        statement: "Use sample_id and sequence.",
        questionId: question.id,
      },
      engineer,
      201,
    );
    await publish(base, batch.id);
    await answer(base, question.id);
    await sign(
      base,
      `questions/${question.id}`,
      "resolution-preview",
      "resolve",
      {
        revision: 1,
        kind: "confirmed",
        facts: [
          {
            text: "Use sample_id and sequence.",
            answers: [{ personId: expertId, revision: 2 }],
          },
        ],
      },
    );
    const pending = await call(`${base}/ledger`);
    expect(pending.handoff.ledger.confirmedUserFacts).toEqual([]);
    expect(pending.handoff.ledger.agentInferences[0].state).toBe("draft");
    expect(
      pending.handoff.readiness
        .find((r: { topic: string }) => r.topic === "interfaces")
        .blockers.map((b: { code: string }) => b.code),
    ).toContain("pending-acknowledgement");
    const view = await call(base);
    const factId = view.facts[0].id;
    await sign(
      base,
      `facts/${factId}`,
      "acknowledgement-preview",
      "acknowledge",
      { decision: "acknowledged" },
      expert,
    );
    const accepted = await call(`${base}/ledger`);
    expect(accepted.handoff.ledger.confirmedUserFacts).toEqual([
      expect.objectContaining({
        record: { type: "confirmed-fact", id: factId, revision: 1 },
        state: "confirmed",
      }),
    ]);
    expect(accepted.handoff.ledger.agentInferences[0].state).toBe("confirmed");
    expect(accepted.handoff.status).toBe("complete");
    await call(
      `${base}/questions/${question.id}/answer`,
      "PUT",
      {
        revision: 2,
        questionRevision: 1,
        text: "Use sample_id, sequence and score.",
      },
      expert,
    );
    const corrected = await call(`${base}/ledger`);
    expect(corrected.handoff.ledger.confirmedUserFacts).toEqual([]);
    expect(corrected.handoff.ledger.agentInferences[0].state).toBe("draft");
    expect(corrected.handoff.status).toBe("incomplete");
  });
  it("keeps inferences and assumptions as revisioned drafts that callers cannot declare confirmed", async () => {
    const { questionnaire: base, expertId } = await setup();
    const { question } = await round(base, expertId);
    const input = {
      statement: "The consumer requires sample_id.",
      topic: "interfaces",
      questionId: question.id,
    };
    const { record: inference } = await call(
      `${base}/inferences`,
      "POST",
      input,
      engineer,
      201,
    );
    const { record: assumption } = await call(
      `${base}/assumptions`,
      "POST",
      { ...input, questionId: null },
      engineer,
      201,
    );
    const { handoff } = await call(`${base}/ledger`);
    expect(handoff.ledger.agentInferences).toEqual([
      expect.objectContaining({
        state: "draft",
        record: { type: "inference", id: inference.id, revision: 1 },
      }),
    ]);
    expect(handoff.ledger.unresolvedAssumptions).toHaveLength(1);
    expect(
      handoff.readiness
        .find((r: { topic: string }) => r.topic === "interfaces")
        .blockers.map((b: { code: string }) => b.code),
    ).toEqual([
      "unresolved-question",
      "unconfirmed-inference",
      "unresolved-assumption",
    ]);
    await call(
      `${base}/inferences`,
      "POST",
      { ...input, confirmed: true },
      engineer,
      400,
    );
    await call(`${base}/inferences`, "POST", input, expert, 403);
    await call(
      `${base}/inferences/${inference.id}`,
      "PATCH",
      { ...input, revision: 9 },
      engineer,
      409,
    );
    const updated = await call(`${base}/inferences/${inference.id}`, "PATCH", {
      ...input,
      statement: "The consumer requires sample_id and sequence.",
      revision: 1,
    });
    expect(updated.record.revision).toBe(2);
    const history = await call(`${base}/inferences/${inference.id}`);
    expect(
      history.revisions.map((r: { statement: string }) => r.statement),
    ).toEqual([
      input.statement,
      "The consumer requires sample_id and sequence.",
    ]);
    await call(`${base}/assumptions/${assumption.id}`, "DELETE", {
      revision: 1,
    });
    expect(
      (await call(`${base}/ledger`)).handoff.ledger.unresolvedAssumptions,
    ).toEqual([]);
  });

  it("derives the five parts and topic blockers through the kernel handoff without exposing draft questions to Observers", async () => {
    const { questionnaire: base, expertId } = await setup();
    const { round: batch, question } = await round(base, expertId);
    const { handoff } = await call(`${base}/ledger`);
    expect(Object.keys(handoff.ledger)).toEqual([
      "confirmedUserFacts",
      "sourceDerivedFacts",
      "agentInferences",
      "unresolvedAssumptions",
      "remainingQuestions",
    ]);
    expect(handoff).toMatchObject({
      kind: "badger-questionnaire-handoff",
      status: "incomplete",
    });
    expect(handoff.ledger.remainingQuestions).toEqual([
      expect.objectContaining({
        record: { type: "question", id: question.id, revision: 1 },
        topic: "interfaces",
      }),
    ]);
    expect(
      handoff.readiness.find(
        (r: { topic: string }) => r.topic === "interfaces",
      ),
    ).toMatchObject({
      ready: false,
      blockers: [
        expect.objectContaining({
          code: "unresolved-question",
          record: { type: "question", id: question.id, revision: 1 },
        }),
      ],
    });
    const hidden = await call(`${base}/ledger`, "GET", undefined, observer);
    expect(hidden.handoff.ledger.remainingQuestions).toEqual([]);
    expect(hidden.handoff.status).toBe(handoff.status);
    expect(
      hidden.handoff.readiness.find(
        (r: { topic: string }) => r.topic === "interfaces",
      ),
    ).toMatchObject({
      ready: false,
      blockers: [{ code: "unresolved-question", record: null }],
    });
    expect(JSON.stringify(hidden)).not.toContain(question.id);
    await publish(base, batch.id);
    const visible = await call(`${base}/ledger`, "GET", undefined, observer);
    expect(visible.handoff.ledger.remainingQuestions).toHaveLength(1);
    expect(
      (
        await service.request(`/api/v1${base}/ledger`, {
          as: { subject: "outsider", email: "outsider@example.com" },
        })
      ).status,
    ).toBe(403);
  });
});
