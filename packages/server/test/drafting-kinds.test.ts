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

interface Pin {
  skillId: string;
  hash: string;
}
interface Job {
  id: string;
  revision: number;
  contextHash: string;
}
const encode = (text: string) => Buffer.from(text).toString("base64");

/** An immutable version of the fixture Skill; `notes` adds a file. */
async function uploadVersion(skillId: string, name: string, notes = "") {
  const files = [
    {
      path: "SKILL.md",
      content: encode(
        `---\nname: ${name}\ndescription: Source study fixture\n---\n${source}`,
      ),
    },
    { path: "reference/contract.md", content: encode(source) },
    ...(notes ? [{ path: "reference/notes.md", content: encode(notes) }] : []),
  ];
  const { preview } = await request(
    `/skills/${skillId}/upload-preview`,
    "POST",
    { files },
  );
  await request(
    `/skills/${skillId}/versions`,
    "POST",
    { files, confirmed: true, expectedHash: preview.hash },
    201,
  );
  return preview.hash as string;
}

async function pinSkill(
  base: string,
  groupId: string,
  name: string,
  notes = "",
): Promise<Pin> {
  const { skill } = await request(
    "/skills",
    "POST",
    { groupId, name },
    201,
    admin,
  );
  const pin = {
    skillId: skill.id,
    hash: await uploadVersion(skill.id, name, notes),
  };
  await request(`${base}/pins`, "POST", pin, 201);
  return pin;
}

async function setup(
  locale = "en",
  environment: Record<string, string> = {},
  notes = "",
) {
  service = await startTestService({
    environment: {
      BADGER_BOOTSTRAP_ADMINISTRATORS: admin.email,
      BADGER_ALLOWED_ORIGINS: "http://localhost",
      ...environment,
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
  const pins: Pin[] = [];
  for (const name of ["producer", "consumer"])
    pins.push(await pinSkill(base, group.id, name, notes));
  return {
    base,
    groupId: group.id as string,
    jobs: `${base}/drafting-jobs`,
    questionnaire: `${base}/questionnaire`,
    pins,
    secret,
    expertId: person.id,
  };
}

async function create(jobs: string, target: object): Promise<Job> {
  return (await request(jobs, "POST", { ...target, confirmed: true }, 201)).job;
}

async function claim(jobs: string, job: Job, secret: string) {
  return request(
    `${jobs}/${job.id}/claim`,
    "POST",
    { revision: job.revision },
    200,
    secret,
  );
}

async function jobStatus(jobs: string, job: Job) {
  return (await request(`${jobs}/${job.id}`)).job.status;
}

/** Each refusal names a result, its status, and the rule's message. */
async function submit(
  jobs: string,
  job: Job,
  secret: string,
  result: unknown,
  refusals: [unknown, number, RegExp][] = [],
  claimed?: { job: { lease: { id: string } } },
) {
  const lease = claimed ?? (await claim(jobs, job, secret));
  const body = {
    leaseId: lease.job.lease.id,
    contextHash: job.contextHash,
    result,
  };
  for (const [invalid, refusal, message] of [
    [{}, 400, /output schema/u],
    ...refusals,
  ] as const) {
    const { error } = await request(
      `${jobs}/${job.id}/submit`,
      "POST",
      { ...body, result: invalid },
      refusal,
      secret,
    );
    expect(error.message).toMatch(message);
  }
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

const citation = (pin: Pin, line = 2) => ({
  ...pin,
  path: "reference/contract.md",
  startLine: line,
  endLine: line,
  fileHash,
});
const studyOf = (pin: Pin) => ({
  facts: [
    {
      statement: "The producer writes samples.tsv.",
      evidence: [citation(pin)],
    },
  ],
  interfaces: [],
});

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
  const evidence = [citation(pins[0])];
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

async function publishQuestions(questionnaire: string, texts: string[]) {
  const { round } = await request(
    `${questionnaire}/rounds`,
    "POST",
    { title: "Contracts" },
    201,
  );
  const questions = [];
  for (const text of texts)
    questions.push(
      (
        await request(
          `${questionnaire}/rounds/${round.id}/questions`,
          "POST",
          { ...questionContent, text },
          201,
        )
      ).question,
    );
  const { preview } = await request(
    `${questionnaire}/rounds/${round.id}/publish-preview`,
  );
  await request(`${questionnaire}/rounds/${round.id}/publish`, "POST", {
    confirmed: true,
    confirmationHash: preview.confirmationHash,
  });
  return questions;
}

/** The expert saves and submits an answer to the question's revision. */
async function answer(
  questionnaire: string,
  question: { id: string; revision: number },
  revision: number,
  text: string,
) {
  await request(
    `${questionnaire}/questions/${question.id}/answer`,
    "PUT",
    { revision, questionRevision: question.revision, text },
    200,
    expert,
  );
  await request(
    `${questionnaire}/questions/${question.id}/submit`,
    "POST",
    { revision: revision + 1, questionRevision: question.revision },
    200,
    expert,
  );
}

async function answeredQuestion(questionnaire: string) {
  const [question] = await publishQuestions(questionnaire, [
    questionContent.text,
  ]);
  await answer(questionnaire, question, 0, "需要样本编号。");
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
    [{ text: " ", rationale: " " }, 400, /translated question/u],
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

const importOf = (pin: Pin, number = 1) => ({
  questions: [{ number, source: citation(pin, 3), question: questionContent }],
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
  const result = importOf(pins[0]);
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

it("keeps a claimed job when another Skill's study is accepted or an unrelated question is discussed or answered", async () => {
  const { jobs, questionnaire, pins, secret, expertId } = await setup();
  const [question, unrelated] = await publishQuestions(questionnaire, [
    questionContent.text,
    "Which file names are used?",
  ]);
  await answer(questionnaire, question, 0, "Sample identifiers.");
  const studied = await create(jobs, {
    kind: "source-study",
    skillId: pins[0].skillId,
  });
  const pending: [Job, object][] = [
    [
      await create(jobs, { kind: "source-study", skillId: pins[1].skillId }),
      studyOf(pins[1]),
    ],
    [
      await create(jobs, {
        kind: "translate-question",
        questionId: question.id,
        locale: "zh-CN",
      }),
      { text: "需要哪些列？", rationale: "确定表格约定。" },
    ],
    [
      await create(jobs, { kind: "restate-answer", questionId: question.id }),
      {
        facts: [
          {
            text: "The table requires sample identifiers.",
            answers: [{ personId: expertId, revision: 2 }],
          },
        ],
      },
    ],
  ];
  const claims = [];
  for (const [job] of pending) claims.push(await claim(jobs, job, secret));
  await accept(
    jobs,
    await submit(jobs, studied, secret, studyOf(pins[0])),
    studyOf(pins[0]),
  );
  await request(
    `${questionnaire}/questions/${unrelated.id}/comments`,
    "POST",
    { text: "Is this the same table?" },
    201,
    expert,
  );
  await answer(questionnaire, unrelated, 0, "samples.tsv");
  for (const [index, [job, result]] of pending.entries()) {
    expect(await jobStatus(jobs, job)).toBe("claimed");
    const submitted = await submit(
      jobs,
      job,
      secret,
      result,
      [],
      claims[index],
    );
    expect(submitted.status).toBe("submitted");
  }
});

it("cancels each kind when its own inputs change", async () => {
  const { base, jobs, questionnaire, pins } = await setup();
  const question = await answeredQuestion(questionnaire);
  const { round } = await request(
    `${questionnaire}/rounds`,
    "POST",
    { title: "Drafts" },
    201,
  );
  const job = {
    studyA: await create(jobs, {
      kind: "source-study",
      skillId: pins[0].skillId,
    }),
    studyB: await create(jobs, {
      kind: "source-study",
      skillId: pins[1].skillId,
    }),
    importB: await create(jobs, {
      kind: "import-open-questions",
      roundId: round.id,
      skillId: pins[1].skillId,
    }),
    translation: await create(jobs, {
      kind: "translate-question",
      questionId: question.id,
      locale: "zh-CN",
    }),
    restatement: await create(jobs, {
      kind: "restate-answer",
      questionId: question.id,
    }),
    followUps: await create(jobs, {
      kind: "draft-follow-ups",
      roundId: round.id,
      parentQuestionId: question.id,
    }),
  };
  const expected: Record<keyof typeof job, string> = {
    studyA: "queued",
    studyB: "queued",
    importB: "queued",
    translation: "queued",
    restatement: "queued",
    followUps: "queued",
  };
  const changes = async (cancelled: (keyof typeof job)[]) => {
    for (const name of cancelled) expected[name] = "cancelled";
    const current: Record<string, string> = {};
    for (const [name, value] of Object.entries(job))
      current[name] = await jobStatus(jobs, value);
    expect(current).toEqual(expected);
  };
  // A new submitted answer changes what restatements and follow-ups read.
  await answer(questionnaire, question, 2, "Also include the sequence.");
  await changes(["restatement", "followUps"]);
  // A new question revision is a new text to translate.
  await request(`${questionnaire}/questions/${question.id}`, "PATCH", {
    ...questionContent,
    text: "Which columns and types are required?",
    revision: 1,
  });
  await changes(["translation"]);
  // A Skill's new pinned version changes only the jobs that read that Skill.
  for (const [index, name] of ["producer", "consumer"].entries()) {
    const hash = await uploadVersion(pins[index].skillId, name, "Revised");
    await request(`${base}/pins`, "POST", {
      skillId: pins[index].skillId,
      hash,
      revision: 1,
    });
    await changes(index === 0 ? ["studyA"] : ["studyB", "importB"]);
  }
});

it("ships only the pinned Skill files a kind reads, within twice the upload limit", async () => {
  // Each Skill fits the upload limit; three exceed a claim's limit together.
  const notes = "x".repeat(500);
  const { base, groupId, jobs, questionnaire, pins, secret } = await setup(
    "en",
    { BADGER_UPLOAD_MAX_BYTES: "1000" },
    notes,
  );
  pins.push(await pinSkill(base, groupId, "reporter", notes));
  const question = await answeredQuestion(questionnaire);
  const { round } = await request(
    `${questionnaire}/rounds`,
    "POST",
    { title: "Drafts" },
    201,
  );
  for (const [target, pin] of [
    [{ kind: "source-study", skillId: pins[1].skillId }, pins[1]],
    [
      {
        kind: "import-open-questions",
        roundId: round.id,
        skillId: pins[2].skillId,
      },
      pins[2],
    ],
  ] as const) {
    const claimed = await claim(jobs, await create(jobs, target), secret);
    expect(claimed.skills).toEqual([
      { skillId: pin.skillId, versionHash: pin.hash },
    ]);
    expect(
      claimed.files
        .map((f: { skillId: string; path: string }) => `${f.skillId}/${f.path}`)
        .sort(),
    ).toEqual(
      ["SKILL.md", "reference/contract.md", "reference/notes.md"].map(
        (path) => `${pin.skillId}/${path}`,
      ),
    );
  }
  for (const target of [
    { kind: "translate-question", questionId: question.id, locale: "zh-CN" },
    { kind: "restate-answer", questionId: question.id },
  ]) {
    const claimed = await claim(jobs, await create(jobs, target), secret);
    expect(claimed).toMatchObject({ skills: [], files: [] });
    expect(claimed.contextBundle.pins).toHaveLength(3);
  }
  const drafting = await create(jobs, {
    kind: "draft-questions",
    roundId: round.id,
  });
  const { error } = await request(
    `${jobs}/${drafting.id}/claim`,
    "POST",
    { revision: drafting.revision },
    413,
    secret,
  );
  expect(error.message).toMatch(/claim byte limit/u);
  expect((await request(`${jobs}/${drafting.id}`)).job).toMatchObject({
    status: "queued",
    lease: null,
  });
});

it("refuses invented source evidence and rolls back every record in the accepted batch", async () => {
  const { base, jobs, pins, secret } = await setup();
  const { job } = await request(
    jobs,
    "POST",
    { kind: "source-study", skillId: pins[0].skillId, confirmed: true },
    201,
  );
  const result = {
    facts: [
      {
        statement: "The source writes samples.tsv.",
        evidence: [citation(pins[0])],
      },
      {
        statement: "This claim cites an invented hash.",
        evidence: [{ ...citation(pins[0]), fileHash: "0".repeat(64) }],
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
  await answer(questionnaire, question, 2, "Also include sequence.");
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
