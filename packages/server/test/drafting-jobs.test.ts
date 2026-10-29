import { afterEach, expect, it } from "vitest";
import {
  startTestService,
  type TestService,
  type TestPerson,
} from "../src/testing/index.js";

const admin: TestPerson = { subject: "admin", email: "admin@example.com" };
const engineer: TestPerson = {
  subject: "engineer",
  email: "engineer@example.com",
};
const observer: TestPerson = {
  subject: "observer",
  email: "observer@example.com",
};
let service: TestService;
afterEach(async () => service?.close());

async function request(
  path: string,
  method = "GET",
  body?: unknown,
  token?: string,
  as = engineer,
  status = 200,
) {
  const response = await service.request(`/api/v1${path}`, {
    ...(token ? {} : { as }),
    method,
    headers: {
      origin: "http://localhost",
      "content-type": "application/json",
      ...(token
        ? {
            authorization: `Bearer ${token}`,
            "x-badger-agent-host": "Engineer Agent",
          }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  expect(
    response.status,
    JSON.stringify({
      value,
      logs: response.status === 500 ? service.logs : undefined,
    }),
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
  const { group } = await request(
    "/groups",
    "POST",
    { name: "Research" },
    undefined,
    admin,
    201,
  );
  const { workflow, version } = await request(
    "/workflows",
    "POST",
    {
      groupId: group.id,
      name: "drafting",
      goal: "Study the workflow",
      intent: "new-skill",
      locale: "en",
    },
    undefined,
    admin,
    201,
  );
  for (const [person, role] of [
    [engineer, "Engineer"],
    [observer, "Observer"],
    [admin, "Field expert"],
  ] as const)
    await request(
      "/bindings",
      "POST",
      {
        scopeType: "workflow",
        scopeId: workflow.id,
        email: person.email,
        role,
      },
      undefined,
      admin,
      201,
    );
  await request("/me", "GET", undefined, undefined, admin);
  const { secret, token } = await request(
    "/me/tokens",
    "POST",
    { name: "Engineer", scopes: ["engineer"] },
    undefined,
    engineer,
    201,
  );
  const questionnaire = `/workflows/${workflow.id}/versions/${version.id}/questionnaire`;
  const { round } = await request(
    `${questionnaire}/rounds`,
    "POST",
    { title: "Storage" },
    undefined,
    engineer,
    201,
  );
  return {
    base: `/workflows/${workflow.id}/versions/${version.id}/drafting-jobs`,
    questionnaire,
    secret: secret as string,
    token,
    round,
    workflow,
    version,
  };
}

const question = (text = "How is the sample stored?") => ({
  text,
  topic: "scope",
  targets: [{ kind: "workflow", id: "workflow" }],
  rationale: "Choose the storage requirements",
  evidence: [],
  assignees: [{ kind: "role", role: "Field expert" }],
  priority: 10,
});

it("keeps a drafted structured question and its submitted evidence through the drafting handoff", async () => {
  const { base, questionnaire, secret, round } = await setup();
  const { job } = await request(
    base,
    "POST",
    { kind: "draft-questions", roundId: round.id, confirmed: true },
    undefined,
    engineer,
    201,
  );
  const claimed = await request(
    `${base}/${job.id}/claim`,
    "POST",
    { revision: job.revision },
    secret,
  );
  const content = {
    ...question(),
    answerType: { kind: "single-choice", options: ["Cold", "Frozen"] },
  };
  const { job: submitted } = await request(
    `${base}/${job.id}/submit`,
    "POST",
    {
      leaseId: claimed.job.lease.id,
      contextHash: job.contextHash,
      result: { questions: [content] },
    },
    secret,
  );
  const decision = { revision: submitted.revision, questions: [content] };
  const { preview } = await request(
    `${base}/${job.id}/accept-preview`,
    "POST",
    decision,
  );
  await request(`${base}/${job.id}/accept`, "POST", {
    ...decision,
    confirmed: true,
    confirmationHash: preview.confirmationHash,
    requestId: "structured-draft",
  });
  const view = await request(questionnaire);
  expect(view.questions[0].answerType).toEqual(content.answerType);
  const { preview: publication } = await request(
    `${questionnaire}/rounds/${round.id}/publish-preview`,
  );
  await request(`${questionnaire}/rounds/${round.id}/publish`, "POST", {
    confirmed: true,
    confirmationHash: publication.confirmationHash,
  });
  const answerPath = `${questionnaire}/questions/${view.questions[0].id}`;
  const { attachment } = await request(
    `${answerPath}/attachments`,
    "POST",
    {
      questionRevision: 1,
      name: "example.txt",
      mediaType: "text/plain",
      contentBase64: Buffer.from("Example only").toString("base64"),
    },
    undefined,
    admin,
    201,
  );
  await request(
    `${answerPath}/answer`,
    "PUT",
    {
      revision: 0,
      questionRevision: 1,
      value: "Frozen",
      attachments: [attachment.id],
    },
    undefined,
    admin,
  );
  await request(
    `${answerPath}/submit`,
    "POST",
    { revision: 1, questionRevision: 1 },
    undefined,
    admin,
  );
  const { round: followUpRound } = await request(
    `${questionnaire}/rounds`,
    "POST",
    { title: "Follow-up examples" },
    undefined,
    engineer,
    201,
  );
  const { job: followUp } = await request(
    base,
    "POST",
    {
      kind: "draft-follow-ups",
      roundId: followUpRound.id,
      parentQuestionId: view.questions[0].id,
      confirmed: true,
    },
    undefined,
    engineer,
    201,
  );
  const followUpClaim = await request(
    `${base}/${followUp.id}/claim`,
    "POST",
    { revision: followUp.revision },
    secret,
  );
  expect(followUpClaim.contextBundle.answers[0]).toMatchObject({
    value: "Frozen",
    attachments: [attachment],
  });
});

it("keeps validated Agent output as suggestions until a person accepts the reviewed edits", async () => {
  const { base, questionnaire, secret, token, round } = await setup();
  const { job } = await request(
    base,
    "POST",
    { kind: "draft-questions", roundId: round.id, confirmed: true },
    undefined,
    engineer,
    201,
  );
  expect(job).toMatchObject({
    status: "queued",
    kind: "draft-questions",
    outputSchema: { type: "object" },
  });
  const claimed = await request(
    `${base}/${job.id}/claim`,
    "POST",
    { revision: job.revision },
    secret,
  );
  expect(claimed.job).toMatchObject({
    status: "claimed",
    contextHash: job.contextHash,
  });
  expect(claimed.contextBundle).toHaveProperty("questions");
  const submit = {
    leaseId: claimed.job.lease.id,
    contextHash: job.contextHash,
  };
  await request(
    `${base}/${job.id}/submit`,
    "POST",
    { ...submit, result: { questions: [{ text: "Incomplete" }] } },
    secret,
    engineer,
    400,
  );
  const { job: submitted } = await request(
    `${base}/${job.id}/submit`,
    "POST",
    { ...submit, result: { questions: [question()] } },
    secret,
  );
  expect(submitted.status).toBe("submitted");
  const view = await request(questionnaire);
  expect(view.questions).toEqual([]);
  expect(view.suggestions).toEqual([
    expect.objectContaining({
      id: job.id,
      result: { questions: [question()] },
    }),
  ]);
  const decision = {
    revision: submitted.revision,
    questions: [question("Which temperature is required?")],
  };
  await request(
    `${base}/${job.id}/accept-preview`,
    "POST",
    decision,
    secret,
    engineer,
    403,
  );
  const { preview } = await request(
    `${base}/${job.id}/accept-preview`,
    "POST",
    decision,
  );
  await request(
    `${base}/${job.id}/accept`,
    "POST",
    {
      ...decision,
      questions: [question("Unreviewed edit")],
      confirmed: true,
      confirmationHash: preview.confirmationHash,
      requestId: "job-decision",
    },
    undefined,
    engineer,
    409,
  );
  const confirmation = {
    ...decision,
    requestId: "job-decision",
    confirmed: true,
    confirmationHash: preview.confirmationHash,
  };
  const accepted = await request(
    `${base}/${job.id}/accept`,
    "POST",
    confirmation,
  );
  const after = await request(questionnaire);
  expect(after.questions).toEqual([
    expect.objectContaining({
      text: "Which temperature is required?",
      state: "draft",
    }),
  ]);
  expect(after.suggestions).toEqual([]);
  await request(
    `${questionnaire}/rounds`,
    "POST",
    { title: "Later inputs" },
    undefined,
    engineer,
    201,
  );
  expect(
    await request(`${base}/${job.id}/accept`, "POST", confirmation),
  ).toEqual(accepted);
  await request(
    `${base}/${job.id}/accept`,
    "POST",
    { ...confirmation, questions: [question("Different replay")] },
    undefined,
    engineer,
    409,
  );
  const inbox = await request("/me/inbox");
  expect(inbox.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "job-submitted",
        state: "done",
        href: expect.stringContaining("panel=suggestions"),
      }),
    ]),
  );
  const audit = await request(
    `/audit-events?targetId=${job.id}`,
    "GET",
    undefined,
    undefined,
    admin,
  );
  expect(audit.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        action: "drafting-job.claimed",
        credentialId: token.id,
        channel: "mcp",
        agentHost: "Engineer Agent",
      }),
      expect.objectContaining({
        action: "drafting-job.submitted",
        credentialId: token.id,
        agentHost: "Engineer Agent",
      }),
      expect.objectContaining({
        action: "drafting-job.accepted",
        channel: "web",
      }),
    ]),
  );
});

it("serializes competing claims, binds leases to the token and host, and requeues expired leases", async () => {
  const { base, secret, round } = await setup();
  const { job } = await request(
    base,
    "POST",
    { kind: "draft-questions", roundId: round.id, confirmed: true },
    undefined,
    engineer,
    201,
  );
  const claims = await Promise.all(
    [200, 409].map(() =>
      service.request(`/api/v1${base}/${job.id}/claim`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "x-badger-agent-host": "Engineer Agent",
          "content-type": "application/json",
        },
        body: JSON.stringify({ revision: job.revision }),
      }),
    ),
  );
  expect(claims.map((r) => r.status).sort()).toEqual([200, 409]);
  const { job: claimed } = await claims.find((r) => r.status === 200)!.json();
  const payload = { leaseId: claimed.lease.id, contextHash: job.contextHash };
  const { secret: another } = await request(
    "/me/tokens",
    "POST",
    { name: "Another Agent", scopes: ["engineer"] },
    undefined,
    engineer,
    201,
  );
  await request(
    `${base}/${job.id}/release`,
    "POST",
    payload,
    another,
    engineer,
    409,
  );
  const wrongHost = await service.request(`/api/v1${base}/${job.id}/release`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "x-badger-agent-host": "Other host",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  expect(wrongHost.status).toBe(409);
  service.clock.advance(30 * 60_000);
  await request(
    `${base}/${job.id}/submit`,
    "POST",
    { ...payload, result: { questions: [question()] } },
    secret,
    engineer,
    409,
  );
  const current = await request(`${base}/${job.id}`, "GET", undefined, secret);
  expect(current.job).toMatchObject({ status: "queued", lease: null });
  const reclaimed = await request(
    `${base}/${job.id}/claim`,
    "POST",
    { revision: current.job.revision },
    another,
  );
  expect(reclaimed.job.lease.id).not.toBe(claimed.lease.id);
  await request(
    `${base}/${job.id}/submit`,
    "POST",
    { ...payload, result: { questions: [question()] } },
    secret,
    engineer,
    409,
  );
  const released = await request(
    `${base}/${job.id}/release`,
    "POST",
    { leaseId: reclaimed.job.lease.id, contextHash: job.contextHash },
    another,
  );
  expect(released.job.status).toBe("queued");
});

it("cancels queued, claimed, and submitted jobs when questionnaire inputs change, including a stale submission", async () => {
  const { base, questionnaire, secret, round } = await setup();
  const jobs = [];
  for (let i = 0; i < 3; i++)
    jobs.push(
      (
        await request(
          base,
          "POST",
          { kind: "draft-questions", roundId: round.id, confirmed: true },
          undefined,
          engineer,
          201,
        )
      ).job,
    );
  const claimed = [];
  for (const job of jobs.slice(1))
    claimed.push(
      (
        await request(
          `${base}/${job.id}/claim`,
          "POST",
          { revision: job.revision },
          secret,
        )
      ).job,
    );
  await request(
    `${base}/${jobs[2].id}/submit`,
    "POST",
    {
      leaseId: claimed[1].lease.id,
      contextHash: jobs[2].contextHash,
      result: { questions: [question()] },
    },
    secret,
  );
  await request(
    `${questionnaire}/rounds`,
    "POST",
    { title: "New inputs" },
    undefined,
    engineer,
    201,
  );
  const stale = await request(
    `${base}/${jobs[1].id}/submit`,
    "POST",
    {
      leaseId: claimed[0].lease.id,
      contextHash: jobs[1].contextHash,
      result: { questions: [question()] },
    },
    secret,
    engineer,
    409,
  );
  expect(stale.job.status).toBe("cancelled");
  expect(
    (await request(base, "GET", undefined, secret)).jobs.map(
      (j: { status: string }) => j.status,
    ),
  ).toEqual(["cancelled", "cancelled", "cancelled"]);
  expect((await request(questionnaire)).suggestions).toEqual([]);
  const inbox = await request("/me/inbox");
  expect(
    inbox.items.find((i: { kind: string }) => i.kind === "job-submitted").state,
  ).toBe("done");
});

it("filters roles and scopes and lets only a person discard reviewed suggestions", async () => {
  const { base, questionnaire, secret, round } = await setup();
  await request(base, "GET", undefined, undefined, observer, 403);
  await request(
    `${questionnaire}/rounds`,
    "POST",
    { title: "Bypass" },
    secret,
    engineer,
    403,
  );
  await request(
    `${questionnaire}/rounds/${round.id}/questions`,
    "POST",
    question(),
    secret,
    engineer,
    403,
  );
  await request(
    base,
    "POST",
    { kind: "draft-questions", roundId: round.id, confirmed: true },
    secret,
    engineer,
    403,
  );
  const { secret: expertScope } = await request(
    "/me/tokens",
    "POST",
    { name: "Expert scope", scopes: ["expert"] },
    undefined,
    engineer,
    201,
  );
  await request(base, "GET", undefined, expertScope, engineer, 403);
  const { job } = await request(
    base,
    "POST",
    { kind: "draft-questions", roundId: round.id, confirmed: true },
    undefined,
    engineer,
    201,
  );
  const claimed = (
    await request(
      `${base}/${job.id}/claim`,
      "POST",
      { revision: job.revision },
      secret,
    )
  ).job;
  const submitted = (
    await request(
      `${base}/${job.id}/submit`,
      "POST",
      {
        leaseId: claimed.lease.id,
        contextHash: job.contextHash,
        result: { questions: [question()] },
      },
      secret,
    )
  ).job;
  expect(
    (await request(questionnaire, "GET", undefined, undefined, observer))
      .suggestions,
  ).toEqual([]);
  const decision = {
    revision: submitted.revision,
    reason: "The question is already covered",
  };
  const { preview } = await request(
    `${base}/${job.id}/reject-preview`,
    "POST",
    decision,
  );
  await request(
    `${base}/${job.id}/reject`,
    "POST",
    {
      ...decision,
      confirmed: true,
      confirmationHash: preview.confirmationHash,
      requestId: "job-decision",
    },
    secret,
    engineer,
    403,
  );
  const rejected = await request(`${base}/${job.id}/reject`, "POST", {
    ...decision,
    confirmed: true,
    confirmationHash: preview.confirmationHash,
    requestId: "job-decision",
  });
  expect(rejected.job.status).toBe("rejected");
  expect((await request(questionnaire)).questions).toEqual([]);
});

it("accepts follow-ups as child drafts while publication and parent resolution remain human actions", async () => {
  const { base, questionnaire, secret, round } = await setup();
  const { question: parent } = await request(
    `${questionnaire}/rounds/${round.id}/questions`,
    "POST",
    question(),
    undefined,
    engineer,
    201,
  );
  const publication = await request(
    `${questionnaire}/rounds/${round.id}/publish-preview`,
  );
  await request(`${questionnaire}/rounds/${round.id}/publish`, "POST", {
    confirmed: true,
    confirmationHash: publication.preview.confirmationHash,
  });
  const { round: next } = await request(
    `${questionnaire}/rounds`,
    "POST",
    { title: "Follow-ups" },
    undefined,
    engineer,
    201,
  );
  const { job } = await request(
    base,
    "POST",
    {
      kind: "draft-follow-ups",
      roundId: next.id,
      parentQuestionId: parent.id,
      confirmed: true,
    },
    undefined,
    engineer,
    201,
  );
  await request(
    `${questionnaire}/questions/${parent.id}/answer`,
    "PUT",
    {
      revision: 0,
      questionRevision: parent.revision,
      text: "Private unsubmitted answer",
    },
    undefined,
    admin,
  );
  const claim = await request(
    `${base}/${job.id}/claim`,
    "POST",
    { revision: job.revision },
    secret,
  );
  expect(JSON.stringify(claim.contextBundle)).not.toContain(
    "Private unsubmitted answer",
  );
  const claimed = claim.job;
  const submitted = (
    await request(
      `${base}/${job.id}/submit`,
      "POST",
      {
        leaseId: claimed.lease.id,
        contextHash: job.contextHash,
        result: { questions: [question("For how long?")] },
      },
      secret,
    )
  ).job;
  const decision = {
    revision: submitted.revision,
    questions: submitted.result.questions,
  };
  const { preview } = await request(
    `${base}/${job.id}/accept-preview`,
    "POST",
    decision,
  );
  await request(`${base}/${job.id}/accept`, "POST", {
    ...decision,
    confirmed: true,
    confirmationHash: preview.confirmationHash,
    requestId: "job-decision",
  });
  const view = await request(questionnaire);
  expect(view.questions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        parentQuestionId: parent.id,
        state: "draft",
        text: "For how long?",
      }),
      expect.objectContaining({ id: parent.id, state: "open" }),
    ]),
  );
});

it.runIf(process.env["BADGER_TEST_DATABASE_URL"] !== undefined)(
  "serializes a person's decisions alongside workflow writes without deadlocking foreign-key checks",
  async () => {
    const { base, questionnaire, secret, round } = await setup();
    for (let attempt = 0; attempt < 3; attempt++) {
      const { job } = await request(
        base,
        "POST",
        { kind: "draft-questions", roundId: round.id, confirmed: true },
        undefined,
        engineer,
        201,
      );
      const { job: claim } = await request(
        `${base}/${job.id}/claim`,
        "POST",
        { revision: job.revision },
        secret,
      );
      const { job: submitted } = await request(
        `${base}/${job.id}/submit`,
        "POST",
        {
          leaseId: claim.lease.id,
          contextHash: job.contextHash,
          result: { questions: [question()] },
        },
        secret,
      );
      const decision = {
        revision: submitted.revision,
        questions: submitted.result.questions,
      };
      const { preview } = await request(
        `${base}/${job.id}/accept-preview`,
        "POST",
        decision,
      );
      const [draft, accept] = await Promise.all([
        service.request(
          `/api/v1${questionnaire}/rounds/${round.id}/questions`,
          {
            as: engineer,
            method: "POST",
            headers: {
              origin: "http://localhost",
              "content-type": "application/json",
            },
            body: JSON.stringify(question(`Concurrent draft ${attempt}`)),
          },
        ),
        service.request(`/api/v1${base}/${job.id}/accept`, {
          as: engineer,
          method: "POST",
          headers: {
            origin: "http://localhost",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ...decision,
            requestId: `concurrent-decision-${attempt}`,
            confirmed: true,
            confirmationHash: preview.confirmationHash,
          }),
        }),
      ]);
      expect(draft.status, JSON.stringify(await draft.json())).toBe(201);
      expect([200, 409], JSON.stringify(await accept.json())).toContain(
        accept.status,
      );
    }
  },
);
