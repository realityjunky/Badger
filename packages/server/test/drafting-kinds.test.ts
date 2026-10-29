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
const expert: TestPerson = { subject: "expert", email: "expert@example.com" };
const source =
  "# Contract\nWrite samples.tsv.\n1. Which columns are required?\n";
const fileHash = createHash("sha256").update(source).digest("hex");
let service: TestService;
afterEach(async () => service?.close());

async function request(
  path: string,
  method = "GET",
  body?: unknown,
  status = 200,
  as: TestPerson | string = engineer,
) {
  const response = await service.request(`/api/v1${path}`, {
    ...(typeof as === "string" ? {} : { as }),
    method,
    headers: {
      origin: "http://localhost",
      "content-type": "application/json",
      ...(typeof as === "string"
        ? { authorization: `Bearer ${as}`, "x-badger-agent-host": "Codex" }
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

async function setup(locale = "en") {
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
    201,
    admin,
  );
  const { workflow, version } = await request(
    "/workflows",
    "POST",
    {
      groupId: group.id,
      name: "drafting-kinds",
      goal: "Study source contracts",
      intent: "new-skill",
      locale,
    },
    201,
    admin,
  );
  for (const [person, role] of [
    [engineer, "Engineer"],
    [expert, "Field expert"],
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
      201,
      admin,
    );
  const { person } = await request("/me", "GET", undefined, 200, expert);
  const { secret } = await request(
    "/me/tokens",
    "POST",
    {
      name: "Drafting Agent",
      scopes: ["engineer"],
    },
    201,
  );
  const base = `/workflows/${workflow.id}/versions/${version.id}`;
  const pins = [];
  for (const name of ["producer", "consumer"]) {
    const { skill } = await request(
      "/skills",
      "POST",
      { groupId: group.id, name },
      201,
      admin,
    );
    const files = [
      {
        path: "SKILL.md",
        content: Buffer.from(
          `---\nname: ${name}\ndescription: Source study fixture\n---\n${source}`,
        ).toString("base64"),
      },
      {
        path: "reference/contract.md",
        content: Buffer.from(source).toString("base64"),
      },
    ];
    const { preview } = await request(
      `/skills/${skill.id}/upload-preview`,
      "POST",
      { files },
    );
    await request(
      `/skills/${skill.id}/versions`,
      "POST",
      {
        files,
        confirmed: true,
        expectedHash: preview.hash,
      },
      201,
    );
    const pin = { skillId: skill.id, hash: preview.hash };
    await request(`${base}/pins`, "POST", pin, 201);
    pins.push(pin);
  }
  return {
    base,
    jobs: `${base}/drafting-jobs`,
    questionnaire: `${base}/questionnaire`,
    pins,
    secret,
    expertId: person.id,
  };
}

async function submit(
  jobs: string,
  job: { id: string; revision: number; contextHash: string },
  secret: string,
  result: unknown,
  invalidResults: unknown[] = [],
) {
  const claimed = await request(
    `${jobs}/${job.id}/claim`,
    "POST",
    { revision: job.revision },
    200,
    secret,
  );
  const body = {
    leaseId: claimed.job.lease.id,
    contextHash: job.contextHash,
    result,
  };
  for (const invalid of [{}, ...invalidResults])
    await request(
      `${jobs}/${job.id}/submit`,
      "POST",
      { ...body, result: invalid },
      400,
      secret,
    );
  const { job: submitted } = await request(
    `${jobs}/${job.id}/submit`,
    "POST",
    body,
    200,
    secret,
  );
  return submitted;
}

async function accept(
  jobs: string,
  job: { id: string; revision: number },
  result: object,
  status = 200,
) {
  const decision = { revision: job.revision, ...result };
  const { preview } = await request(
    `${jobs}/${job.id}/accept-preview`,
    "POST",
    decision,
  );
  const body = {
    ...decision,
    confirmed: true,
    confirmationHash: preview.confirmationHash,
    requestId: crypto.randomUUID(),
  };
  const response = await request(
    `${jobs}/${job.id}/accept`,
    "POST",
    body,
    status,
  );
  if (status === 200)
    expect(await request(`${jobs}/${job.id}/accept`, "POST", body)).toEqual(
      response,
    );
  return response;
}

it("accepts a source study as revisioned facts and interfaces with evidence from the pinned files", async () => {
  const { base, jobs, pins, secret } = await setup();
  const { job } = await request(
    jobs,
    "POST",
    { kind: "source-study", skillId: pins[0].skillId, confirmed: true },
    201,
  );
  expect(job.roundId).toBeNull();
  expect(job.outputSchema.required).toEqual(["facts", "interfaces"]);
  const evidence = [
    {
      ...pins[0],
      path: "reference/contract.md",
      startLine: 2,
      endLine: 2,
      fileHash,
    },
  ];
  const result = {
    facts: [{ statement: "The producer writes samples.tsv.", evidence }],
    interfaces: [
      {
        producer: pins[0],
        consumer: pins[1],
        artifact: "samples.tsv",
        columns: ["sample_id"],
        naming: "samples.tsv",
        validation: "A table with a sample_id column",
        evidence,
      },
    ],
  };
  const submitted = await submit(jobs, job, secret, result);
  expect(await request(`${base}/source-study`)).toMatchObject({
    facts: [],
    interfaces: [],
  });
  await request(
    `${jobs}/${job.id}/accept-preview`,
    "POST",
    { revision: submitted.revision, ...result },
    403,
    secret,
  );
  const { job: accepted } = await accept(jobs, submitted, result);
  expect(accepted.status).toBe("accepted");
  const study = await request(`${base}/source-study`);
  expect(study.facts).toHaveLength(1);
  expect(study.interfaces).toHaveLength(1);
  expect(study.facts[0]).toMatchObject({
    revision: 1,
    content: result.facts[0],
  });
  expect(
    await request(
      `${base}/source-study/facts/${study.facts[0].id}/evidence/0?revision=1`,
    ),
  ).toMatchObject({
    evidence: evidence[0],
    lines: [{ number: 2, text: "Write samples.tsv." }],
  });
});

const questionContent = {
  text: "Which columns are required?",
  topic: "scope",
  targets: [{ kind: "workflow", id: "workflow" }],
  rationale: "Agree the table contract",
  evidence: [],
  assignees: [{ kind: "role", role: "Field expert" }],
  priority: 80,
};

async function answeredQuestion(questionnaire: string) {
  const { round } = await request(
    `${questionnaire}/rounds`,
    "POST",
    { title: "Contracts" },
    201,
  );
  const { question } = await request(
    `${questionnaire}/rounds/${round.id}/questions`,
    "POST",
    questionContent,
    201,
  );
  const { preview } = await request(
    `${questionnaire}/rounds/${round.id}/publish-preview`,
  );
  await request(`${questionnaire}/rounds/${round.id}/publish`, "POST", {
    confirmed: true,
    confirmationHash: preview.confirmationHash,
  });
  await request(
    `${questionnaire}/questions/${question.id}/answer`,
    "PUT",
    { revision: 0, questionRevision: 1, text: "需要样本编号。" },
    200,
    expert,
  );
  await request(
    `${questionnaire}/questions/${question.id}/submit`,
    "POST",
    { revision: 1, questionRevision: 1 },
    200,
    expert,
  );
  return question;
}

it("accepts a restatement in the workflow locale with exact answer links and waits for the answering expert's acknowledgement", async () => {
  const { jobs, questionnaire, secret, expertId } = await setup("zh-CN");
  const question = await answeredQuestion(questionnaire);
  const { job } = await request(
    jobs,
    "POST",
    { kind: "restate-answer", questionId: question.id, confirmed: true },
    201,
  );
  const result = {
    facts: [
      {
        text: "输出表必须包含样本编号。",
        answers: [{ personId: expertId, revision: 2 }],
      },
    ],
  };
  const submitted = await submit(jobs, job, secret, result);
  expect((await request(questionnaire)).facts).toEqual([]);
  await accept(jobs, submitted, result);
  const view = await request(questionnaire);
  expect(view.questions[0].state).toBe("confirmed");
  expect(view.facts).toHaveLength(1);
  expect(view.facts[0]).toMatchObject({
    ...result.facts[0],
    locale: "zh-CN",
    acknowledgements: [],
  });
  const fact = view.facts[0];
  expect(
    (await request("/me/inbox", "GET", undefined, 200, expert)).items,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "restatement-ready",
        questionId: question.id,
      }),
    ]),
  );
  const route = `${questionnaire}/facts/${fact.id}`;
  const { preview } = await request(
    `${route}/acknowledgement-preview`,
    "POST",
    { decision: "acknowledged" },
    200,
    expert,
  );
  await request(
    `${route}/acknowledge`,
    "POST",
    {
      decision: "acknowledged",
      confirmed: true,
      confirmationHash: preview.confirmationHash,
      requestId: "acknowledge-restatement",
    },
    200,
    expert,
  );
  expect((await request(questionnaire)).facts[0].acknowledgements).toEqual([
    expect.objectContaining({ personId: expertId, decision: "acknowledged" }),
  ]);
});

it("attaches an accepted translation to the exact question revision and preserves it after an edit", async () => {
  const { jobs, questionnaire, secret } = await setup();
  const question = await answeredQuestion(questionnaire);
  const { job } = await request(
    jobs,
    "POST",
    {
      kind: "translate-question",
      questionId: question.id,
      locale: "zh-CN",
      confirmed: true,
    },
    201,
  );
  const result = { text: "需要哪些列？", rationale: "确定表格约定。" };
  const submitted = await submit(jobs, job, secret, result, [
    { text: " ", rationale: " " },
  ]);
  expect((await request(questionnaire)).questions[0].translations).toEqual([]);
  await accept(jobs, submitted, result);
  const accepted = (await request(questionnaire)).questions[0];
  expect(accepted.revision).toBe(1);
  expect(accepted.text).toBe(questionContent.text);
  expect(accepted.translations).toEqual([
    expect.objectContaining({
      questionRevision: 1,
      locale: "zh-CN",
      ...result,
    }),
  ]);
  await request(`${questionnaire}/questions/${question.id}`, "PATCH", {
    ...questionContent,
    text: "Which columns and types are required?",
    revision: 1,
  });
  const revised = (await request(questionnaire)).questions[0];
  expect(revised.revision).toBe(2);
  expect(revised.translations).toEqual(accepted.translations);
});

it("imports numbered open questions only on acceptance and keeps the Skill version and source number", async () => {
  const { jobs, questionnaire, pins, secret } = await setup();
  const { round } = await request(
    `${questionnaire}/rounds`,
    "POST",
    { title: "Imported questions" },
    201,
  );
  const { job } = await request(
    jobs,
    "POST",
    {
      kind: "import-open-questions",
      roundId: round.id,
      skillId: pins[0].skillId,
      confirmed: true,
    },
    201,
  );
  const result = {
    questions: [
      {
        number: 1,
        source: {
          ...pins[0],
          path: "reference/contract.md",
          startLine: 3,
          endLine: 3,
          fileHash,
        },
        question: questionContent,
      },
    ],
  };
  const submitted = await submit(jobs, job, secret, result);
  expect((await request(questionnaire)).questions).toEqual([]);
  await accept(jobs, submitted, result);
  const imported = (await request(questionnaire)).questions[0];
  expect(imported).toMatchObject({
    state: "draft",
    text: questionContent.text,
    source: { number: 1, ...result.questions[0].source, questionRevision: 1 },
    evidence: [
      {
        skillId: pins[0].skillId,
        versionHash: pins[0].hash,
        path: "reference/contract.md",
        startLine: 3,
        endLine: 3,
      },
    ],
  });
  expect(
    (await request(questionnaire, "GET", undefined, 200, expert)).questions,
  ).toEqual([]);
});

it("refuses invented source evidence and rolls back every record in the accepted batch", async () => {
  const { base, jobs, pins, secret } = await setup();
  const { job } = await request(
    jobs,
    "POST",
    { kind: "source-study", skillId: pins[0].skillId, confirmed: true },
    201,
  );
  const citation = {
    ...pins[0],
    path: "reference/contract.md",
    startLine: 2,
    endLine: 2,
    fileHash,
  };
  const result = {
    facts: [
      { statement: "The source writes samples.tsv.", evidence: [citation] },
      {
        statement: "This claim cites an invented hash.",
        evidence: [{ ...citation, fileHash: "0".repeat(64) }],
      },
    ],
    interfaces: [],
  };
  const submitted = await submit(jobs, job, secret, result);
  await accept(jobs, submitted, result, 409);
  expect(await request(`${base}/source-study`)).toMatchObject({
    facts: [],
    interfaces: [],
  });
  expect((await request(`${jobs}/${job.id}`)).job.status).toBe("submitted");
});

it("refuses restatements of old answer revisions and cancels a draft when a new answer is submitted", async () => {
  const { jobs, questionnaire, secret, expertId } = await setup();
  const question = await answeredQuestion(questionnaire);
  const { job } = await request(
    jobs,
    "POST",
    { kind: "restate-answer", questionId: question.id, confirmed: true },
    201,
  );
  const result = {
    facts: [
      {
        text: "The table requires sample_id.",
        answers: [{ personId: expertId, revision: 1 }],
      },
    ],
  };
  const submitted = await submit(jobs, job, secret, result);
  await request(
    `${jobs}/${job.id}/accept-preview`,
    "POST",
    { revision: submitted.revision, ...result },
    409,
  );
  await request(
    `${questionnaire}/questions/${question.id}/answer`,
    "PUT",
    { revision: 2, questionRevision: 1, text: "Also include sequence." },
    200,
    expert,
  );
  await request(
    `${questionnaire}/questions/${question.id}/submit`,
    "POST",
    { revision: 3, questionRevision: 1 },
    200,
    expert,
  );
  await request(
    `${jobs}/${job.id}/accept-preview`,
    "POST",
    { revision: submitted.revision, ...result },
    409,
  );
  expect((await request(`${jobs}/${job.id}`)).job.status).toBe("cancelled");
  expect((await request(questionnaire)).facts).toEqual([]);
});

it("rejects request fields that belong to a different drafting kind", async () => {
  const { jobs, pins } = await setup();
  await request(
    jobs,
    "POST",
    {
      kind: "source-study",
      skillId: pins[0].skillId,
      roundId: "unrelated-round",
      confirmed: true,
    },
    400,
  );
});
