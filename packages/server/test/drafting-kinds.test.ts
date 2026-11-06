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
    workflowId: workflow.id as string,
    versionId: version.id as string,
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

it("shares saved source-study edits with Field experts and binds Engineer decisions to the latest saved review", async () => {
  const { base, jobs, questionnaire, pins, secret, expertId } = await setup();
  const job = await create(jobs, {
    kind: "source-study",
    skillId: pins[0].skillId,
  });
  const original = studyOf(pins[0]);
  const submitted = await submit(jobs, job, secret, original);
  const originalHash = submitted.resultHash;
  expect(submitted.review).toBeNull();
  expect(
    await request(questionnaire, "GET", undefined, 200, expert),
  ).toMatchObject({
    capabilities: { compose: false, reviewSuggestions: true },
    suggestions: [{ id: job.id }],
  });
  expect(await request(jobs, "GET", undefined, 200, expert)).toMatchObject({
    jobs: [{ id: job.id, result: original }],
  });
  for (const action of [
    "claim",
    "submit",
    "release",
    "accept-preview",
    "accept",
    "reject-preview",
    "reject",
  ])
    await request(`${jobs}/${job.id}/${action}`, "POST", {}, 403, expert);
  await request(
    jobs,
    "POST",
    { kind: "source-study", skillId: pins[0].skillId, confirmed: true },
    403,
    expert,
  );
  await request(
    `${jobs}/${job.id}/review`,
    "POST",
    { revision: submitted.revision, result: original },
    403,
    secret,
  );
  const expertToken = await request(
    "/me/tokens",
    "POST",
    { name: "Expert Agent", scopes: ["expert"] },
    201,
    expert,
  );
  await request(jobs, "GET", undefined, 403, expertToken.secret);
  await request(
    `${jobs}/${job.id}/review`,
    "POST",
    { revision: submitted.revision, result: original },
    403,
    expertToken.secret,
  );
  await request(
    `${jobs}/${job.id}/review`,
    "POST",
    { revision: submitted.revision, result: {} },
    400,
    expert,
  );

  const result = {
    ...original,
    facts: [{ ...original.facts[0], statement: "生产者输出 samples.tsv。" }],
  };
  const { job: saved } = await request(
    `${jobs}/${job.id}/review`,
    "POST",
    { revision: submitted.revision, result },
    200,
    expert,
  );
  expect(saved).toMatchObject({
    revision: submitted.revision + 1,
    status: "submitted",
    result: original,
    resultHash: originalHash,
    review: { result, personId: expertId, revision: submitted.revision + 1 },
  });
  expect(await request(`${jobs}/${job.id}`)).toMatchObject({ job: saved });
  expect(await request(`${base}/source-study`)).toMatchObject({
    facts: [],
    interfaces: [],
  });
  await request(
    `${jobs}/${job.id}/review`,
    "POST",
    { revision: submitted.revision, result: original },
    409,
  );

  const competing = ["工程师修改", "领域专家修改"].map((statement) => ({
    ...result,
    facts: [{ ...result.facts[0], statement }],
  }));
  const responses = await Promise.all(
    competing.map((edit, index) =>
      service.request(`/api/v1${jobs}/${job.id}/review`, {
        as: index === 0 ? engineer : expert,
        method: "POST",
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
        },
        body: JSON.stringify({ revision: saved.revision, result: edit }),
      }),
    ),
  );
  expect(responses.map((response) => response.status).sort()).toEqual([
    200, 409,
  ]);
  const { job: current } = await request(`${jobs}/${job.id}`);
  expect(current.resultHash).toBe(originalHash);
  const { preview } = await request(
    `${jobs}/${job.id}/accept-preview`,
    "POST",
    { revision: current.revision, ...current.review.result },
  );
  const finalEdit = {
    ...result,
    facts: [
      {
        ...result.facts[0],
        statement: "输出表 samples.tsv 必须包含 sample_id 列。",
      },
    ],
  };
  const { job: final } = await request(
    `${jobs}/${job.id}/review`,
    "POST",
    { revision: current.revision, result: finalEdit },
    200,
    expert,
  );
  await request(
    `${jobs}/${job.id}/accept`,
    "POST",
    {
      revision: preview.revision,
      ...preview.decision,
      confirmationHash: preview.confirmationHash,
      confirmed: true,
      requestId: crypto.randomUUID(),
    },
    409,
  );
  await request(
    `${jobs}/${job.id}/accept-preview`,
    "POST",
    { revision: final.revision, ...original },
    409,
  );
  await accept(jobs, final, final.review.result);
  const study = await request(`${base}/source-study`);
  expect(study.facts).toHaveLength(1);
  expect(study.facts[0].content).toEqual(finalEdit.facts[0]);
  await request(
    `${jobs}/${job.id}/review`,
    "POST",
    { revision: final.revision + 1, result: original },
    409,
    expert,
  );
  const audit = await request(
    "/audit-events?action=drafting-job.review-saved",
    "GET",
    undefined,
    200,
    admin,
  );
  expect(audit.events).toHaveLength(3);
  expect(
    audit.events.every(
      (event: { targetId: string }) => event.targetId === job.id,
    ),
  ).toBe(true);
});

it("limits suggestion editing to people assigned as Engineer or Field expert in that workflow", async () => {
  const { jobs, workflowId, pins, secret } = await setup();
  const readers = ["Workflow owner", "Observer", "Field expert"] as const;
  const outsiders = readers.map((role, index) => ({
    subject: `reader-${index}`,
    email: `reader-${index}@example.com`,
    role,
  }));
  for (const reader of outsiders) {
    if (reader.role !== "Field expert")
      await request(
        "/bindings",
        "POST",
        {
          scopeType: "workflow",
          scopeId: workflowId,
          email: reader.email,
          role: reader.role,
        },
        201,
        admin,
      );
  }
  const job = await create(jobs, {
    kind: "source-study",
    skillId: pins[0].skillId,
  });
  const submitted = await submit(jobs, job, secret, studyOf(pins[0]));
  for (const reader of outsiders) {
    await request(jobs, "GET", undefined, 403, reader);
    await request(
      `${jobs}/${job.id}/review`,
      "POST",
      { revision: submitted.revision, result: submitted.result },
      403,
      reader,
    );
  }
  await request(
    `${jobs}/${job.id}/review`,
    "POST",
    { revision: submitted.revision, result: submitted.result },
    200,
    admin,
  );
});

it("accepts per-Skill facts and refuses cross-Skill interfaces and evidence outside the target Skill", async () => {
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
    interfaces: [],
  };
  const submitted = await submit(jobs, job, secret, result, [
    ...[pins[0], pins[1]].map((consumer): [unknown, number, RegExp] => [
      {
        ...result,
        interfaces: [
          {
            producer: pins[0],
            consumer,
            artifact: "samples.tsv",
            columns: ["sample_id"],
            naming: "samples.tsv",
            validation: "sample_id is required",
            evidence,
          },
        ],
      },
      400,
      /output schema/u,
    ]),
    [
      {
        ...result,
        facts: [{ ...result.facts[0], evidence: [citation(pins[1])] }],
      },
      400,
      /exact pinned Skill/u,
    ],
    [
      {
        ...result,
        facts: [
          { ...result.facts[0], evidence: [{ ...evidence[0], note: "" }] },
        ],
      },
      400,
      /facts\/0\/evidence\/0 must NOT have additional properties/u,
    ],
  ]);
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
  expect(study.interfaces).toHaveLength(0);
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

it("restricts the template catalog to signed-in Administrators and binds edits to reviewed revisions", async () => {
  const { secret, base } = await setup();
  expect(
    await request(
      `${base}/stage-prompts/questionnaire`,
      "GET",
      undefined,
      200,
      expert,
    ),
  ).toMatchObject({ guidance: [{ id: "questionnaire-signoff" }] });
  await request(
    `${base}/stage-prompts/source-study`,
    "GET",
    undefined,
    403,
    expert,
  );
  for (const actor of [engineer, expert, secret])
    await request("/admin/prompt-templates", "GET", undefined, 403, actor);
  const catalog = await request(
    "/admin/prompt-templates",
    "GET",
    undefined,
    200,
    admin,
  );
  expect(
    new Set(
      catalog.templates.map((template: { stage: string }) => template.stage),
    ).size,
  ).toBe(8);
  expect(
    new Set(
      catalog.templates.map(
        (template: { scenario: string }) => template.scenario,
      ),
    ),
  ).toEqual(new Set(["agent-draft", "agent-assist", "human-review"]));
  expect(
    catalog.templates.map((template: { id: string }) => template.id),
  ).not.toContain("suggestion-review");
  for (const suffix of ["", "/history"])
    await request(
      `/admin/prompt-templates/suggestion-review${suffix}`,
      "GET",
      undefined,
      404,
      admin,
    );
  const template = catalog.templates.find(
    (entry: { id: string }) => entry.id === "draft-questions",
  );
  const path = `/admin/prompt-templates/${template.id}`;
  const body = `${template.body}\n\nAsk for explicit units when relevant.`;
  const draft = { revision: template.revision, body };
  await request(
    path,
    "PUT",
    { ...draft, confirmed: true, confirmationHash: "wrong" },
    409,
    admin,
  );
  const preview = await request(`${path}/preview`, "POST", draft, 200, admin);
  await request(
    path,
    "PUT",
    {
      ...draft,
      body: `${body} Changed.`,
      confirmed: true,
      confirmationHash: preview.confirmationHash,
    },
    409,
    admin,
  );
  const saved = await request(
    path,
    "PUT",
    { ...draft, confirmed: true, confirmationHash: preview.confirmationHash },
    200,
    admin,
  );
  expect(saved.template).toMatchObject({ revision: 1, body });
  expect(saved.template.hash).not.toBe(template.hash);
  await request(`${path}/preview`, "POST", draft, 409, admin);
  const history = await request(
    `${path}/history`,
    "GET",
    undefined,
    200,
    admin,
  );
  expect(history.history).toMatchObject([{ revision: 1, body }]);
  await request(
    path,
    "PUT",
    { ...draft, confirmed: true, confirmationHash: preview.confirmationHash },
    403,
    engineer,
  );
});

it.each(["en", "zh-CN"])(
  "uses the frozen %s workflow locale for both source-study jobs independently of interface and future-frame settings",
  async (locale) => {
    const { workflowId, jobs, pins, secret } = await setup(locale);
    const { preferences } = await request("/me/preferences");
    await request("/me/preferences", "PUT", {
      revision: preferences.revision,
      language: locale === "zh-CN" ? "en" : "zh",
      theme: preferences.theme,
      fontScale: preferences.fontScale,
      railCollapsed: preferences.railCollapsed,
    });
    const { workflow } = await request(`/workflows/${workflowId}`);
    await request(
      `/workflows/${workflowId}`,
      "PATCH",
      {
        name: workflow.name,
        goal: workflow.goal,
        intent: workflow.intent,
        locale: locale === "zh-CN" ? "en" : "zh-CN",
        revision: workflow.revision,
      },
      200,
      admin,
    );
    for (const pin of pins) {
      const job = await create(jobs, {
        kind: "source-study",
        skillId: pin.skillId,
      });
      const dispatch = await request(`${jobs}/${job.id}/prompt`);
      expect(dispatch.job.outputLocale).toBe(locale);
      expect(dispatch.prompt).toContain(`Output locale: "${locale}"`);
      const claimed = await claim(jobs, job, secret);
      expect(claimed.contextBundle.version.locale).toBe(locale);
      expect(claimed.job.outputLocale).toBe(locale);
      expect(claimed.instructions).toContain(`"outputLocale": "${locale}"`);
      expect(claimed.instructions).toContain(
        "Write every generated user-facing narrative field in this language",
      );
      expect(claimed.instructions).toContain(
        "Preserve exact schema keys and enum values",
      );
    }
  },
);

it("keeps an explicit translation target separate from the workflow locale", async () => {
  const { jobs, questionnaire, secret } = await setup("zh-CN");
  const question = await answeredQuestion(questionnaire);
  const job = await create(jobs, {
    kind: "translate-question",
    questionId: question.id,
    locale: "en",
  });
  const dispatch = await request(`${jobs}/${job.id}/prompt`);
  expect(dispatch.job.outputLocale).toBe("en");
  expect(dispatch.prompt).toContain('Output locale: "en"');
  const claimed = await claim(jobs, job, secret);
  expect(claimed.contextBundle.version.locale).toBe("zh-CN");
  expect(claimed.instructions).toContain('"outputLocale": "en"');
});

it("provides the bound output-language instruction without changing a saved template snapshot", async () => {
  const { jobs, pins, secret } = await setup("zh-CN");
  const path = "/admin/prompt-templates/source-study";
  const body =
    "Read the supplied Skill files and submit evidence-backed facts.";
  const { confirmationHash } = await request(
    `${path}/preview`,
    "POST",
    { revision: 0, body },
    200,
    admin,
  );
  await request(
    path,
    "PUT",
    { revision: 0, body, confirmed: true, confirmationHash },
    200,
    admin,
  );
  const job = await create(jobs, {
    kind: "source-study",
    skillId: pins[0].skillId,
  });
  const before = await request(`${jobs}/${job.id}/prompt`);
  const claimed = await claim(jobs, job, secret);
  expect(claimed.contextBundle.promptTemplate).toEqual(before.template);
  expect(claimed.contextBundle.promptTemplate.body).toBe(body);
  expect(claimed.job.contextHash).toBe(job.contextHash);
  expect(claimed.instructions).toContain('Output locale: "zh-CN"');
  expect(claimed.instructions).toContain("For zh-CN, use Simplified Chinese");
});

it("delivers the queued template snapshot through dispatch and claim even after an Administrator edits the default", async () => {
  const { jobs, pins, secret } = await setup();
  const job = await create(jobs, {
    kind: "source-study",
    skillId: pins[0].skillId,
  });
  const before = await request(`${jobs}/${job.id}/prompt`);
  expect(before.prompt.length).toBeLessThan(1600);
  expect(before.prompt).toContain(job.id);
  expect(before.prompt).toContain(job.contextHash);
  expect(before.prompt).toContain("claim_job");
  expect(before.prompt).toContain("instructions.md");
  expect(before.prompt).not.toContain(before.template.body);
  expect(before.prompt).not.toContain("Study source contracts");
  expect(before.prompt).not.toContain("outputSchema");
  const path = "/admin/prompt-templates/source-study";
  const body = `${before.template.body}\n\nCheck whether columns have explicit units.`;
  const preview = await request(
    `${path}/preview`,
    "POST",
    { revision: 0, body },
    200,
    admin,
  );
  await request(
    path,
    "PUT",
    {
      revision: 0,
      body,
      confirmed: true,
      confirmationHash: preview.confirmationHash,
    },
    200,
    admin,
  );
  const claimed = await claim(jobs, job, secret);
  expect(claimed.contextBundle.promptTemplate).toEqual(before.template);
  expect(claimed.instructions).toContain("This job is already claimed");
  expect(claimed.instructions).toContain(
    "Do not generate interfaces between Skills",
  );
  expect(claimed.instructions).toContain("Study source contracts");
  expect(claimed.instructions).toContain("outputSchema");
  expect(claimed.instructions).not.toContain(
    "Check whether columns have explicit units.",
  );
  expect(claimed.instructions).toContain(
    "Signed-in people accept or discard suggestions",
  );
  expect(claimed.skills).toHaveLength(1);
  const next = await create(jobs, {
    kind: "source-study",
    skillId: pins[0].skillId,
  });
  const nextPrompt = await request(`${jobs}/${next.id}/prompt`);
  expect(nextPrompt).toMatchObject({
    template: { revision: 1, body },
  });
  expect(nextPrompt.prompt.length).toBeLessThan(1600);
  expect(nextPrompt.prompt).not.toContain(body);
  const nextClaimed = await claim(jobs, next, secret);
  expect(nextClaimed.instructions).toContain(body);
});

it("queues a context-bound questionnaire job with a new round and invalidates it when source evidence changes", async () => {
  const { base, jobs, questionnaire, pins, secret } = await setup();
  const study = await create(jobs, {
    kind: "source-study",
    skillId: pins[0].skillId,
  });
  const result = studyOf(pins[0]);
  await accept(jobs, await submit(jobs, study, secret, result), result);
  const { round, job } = await request(
    `${questionnaire}/rounds`,
    "POST",
    { title: "Workflow interfaces", draftQuestions: true },
    201,
  );
  expect(round.state).toBe("draft");
  expect(job).toMatchObject({
    kind: "draft-questions",
    roundId: round.id,
    status: "queued",
  });
  const claimed = await claim(jobs, job, secret);
  expect(claimed.skills).toHaveLength(2);
  expect(claimed.contextBundle.sourceStudy.facts).toHaveLength(1);
  expect(claimed.instructions).toContain(
    "Compare producer outputs against consumer inputs",
  );
  expect(claimed.instructions).toContain("citing both sides");
  expect(claimed.contextBundle.questions).toEqual([]);
  await request(
    `${base}/source-study/facts`,
    "POST",
    { statement: "The target requires units.", evidence: [citation(pins[0])] },
    201,
  );
  expect(await jobStatus(jobs, job)).toBe("cancelled");
});

it("reserves suggestion review for signed-in people and removes Agent review prompts", async () => {
  const { jobs, pins, secret, base } = await setup();
  const job = await create(jobs, {
    kind: "source-study",
    skillId: pins[0].skillId,
  });
  const submitted = await submit(jobs, job, secret, studyOf(pins[0]));
  const expertToken = await request(
    "/me/tokens",
    "POST",
    { name: "Expert Agent", scopes: ["expert"] },
    201,
    expert,
  );
  const administratorToken = await request(
    "/me/tokens",
    "POST",
    { name: "Administrator Agent", scopes: ["engineer", "expert"] },
    201,
    admin,
  );
  const result = {
    ...submitted.result,
    facts: [
      {
        ...submitted.result.facts[0],
        statement: "The output is a sample table.",
      },
    ],
  };
  for (const token of [secret, expertToken.secret, administratorToken.secret]) {
    expect(
      await request("/me/mcp", "GET", undefined, 200, token),
    ).toMatchObject({ capabilities: { reviewSuggestions: false } });
    for (const revision of [submitted.revision, submitted.revision - 1])
      await request(
        `${jobs}/${job.id}/review`,
        "POST",
        { revision, result },
        403,
        token,
      );
    await request(
      `${jobs}/${job.id}/review-context`,
      "GET",
      undefined,
      403,
      token,
    );
  }
  for (const actor of [engineer, expert, admin])
    await request(
      `${jobs}/${job.id}/review-context`,
      "GET",
      undefined,
      404,
      actor,
    );
  expect(await request(`${jobs}/${job.id}`)).toMatchObject({ job: submitted });
  expect((await request(`${base}/source-study`)).facts).toEqual([]);
});

it("preserves source-study jobs and reviewed confirmation hashes across version label edits", async () => {
  const { base, jobs, pins, secret } = await setup();
  await service.runSourceCheckJobs();
  const { preview: sources } = await request(
    `${base}/gates/sources/preview`,
    "POST",
    {},
  );
  const before = (await request(base)).version;
  await request(base, "PATCH", { labelRevision: 0, semanticVersion: "0.1.0" });
  expect((await request(base)).version).toEqual({
    ...before,
    semanticVersion: "0.1.0",
    labelRevision: 1,
  });
  await request(`${base}/gates/sources/commit`, "POST", {
    confirmationHash: sources.confirmationHash,
    requestId: crypto.randomUUID(),
  });
  const job = await create(jobs, {
    kind: "source-study",
    skillId: pins[0].skillId,
  });
  await request(base, "PATCH", { labelRevision: 1, semanticVersion: "0.2.0" });
  expect((await request(`${jobs}/${job.id}`)).job).toMatchObject({
    status: "queued",
    contextHash: job.contextHash,
    revision: job.revision,
  });
  const claimed = await claim(jobs, job, secret);
  await request(base, "PATCH", { labelRevision: 2, semanticVersion: "0.3.0" });
  const result = studyOf(pins[0]);
  const submitted = await submit(jobs, job, secret, result, [], claimed);
  const decision = { revision: submitted.revision, ...result };
  const { preview } = await request(
    `${jobs}/${job.id}/accept-preview`,
    "POST",
    decision,
  );
  await request(base, "PATCH", { labelRevision: 3, semanticVersion: "1.0.0" });
  const { job: accepted } = await request(`${jobs}/${job.id}/accept`, "POST", {
    ...decision,
    confirmed: true,
    confirmationHash: preview.confirmationHash,
    requestId: crypto.randomUUID(),
  });
  expect(accepted.status).toBe("accepted");
  expect((await request(`${base}/source-study`)).facts).toHaveLength(1);
  expect((await request(base)).sourceGate).toMatchObject({
    confirmationHash: sources.confirmationHash,
    invalidatedAt: null,
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

it("provides answer prompts only to current assignees and includes only their own private draft", async () => {
  const { workflowId, questionnaire, secret } = await setup();
  const second = {
    subject: "second-expert",
    email: "second-expert@example.com",
  };
  await request(
    "/bindings",
    "POST",
    {
      scopeType: "workflow",
      scopeId: workflowId,
      email: second.email,
      role: "Field expert",
    },
    201,
    admin,
  );
  const [question] = await publishQuestions(questionnaire, [
    "Which units are required?",
  ]);
  await request(
    `${questionnaire}/questions/${question.id}/answer`,
    "PUT",
    {
      revision: 0,
      questionRevision: question.revision,
      text: "Private units draft",
    },
    200,
    expert,
  );
  const token = await request(
    "/me/tokens",
    "POST",
    { name: "Answer assistant", scopes: ["expert"] },
    201,
    expert,
  );
  const path = `${questionnaire}/questions/${question.id}/prompt`;
  const context = await request(path, "GET", undefined, 200, token.secret);
  expect(context).toMatchObject({
    questionRevision: question.revision,
    answerRevision: 1,
    answer: { state: "draft", text: "Private units draft" },
  });
  expect(context.prompt).toContain("never infer their answer");
  const another = await request(path, "GET", undefined, 200, second);
  expect(another.answer).toBeNull();
  expect(JSON.stringify(another)).not.toContain("Private units draft");
  await request(path, "GET", undefined, 403, secret);
});

it("allows an assigned Engineer to draft and send their own answer through MCP while sign-offs stay manual", async () => {
  const { questionnaire, secret } = await setup();
  const { round } = await request(
    `${questionnaire}/rounds`,
    "POST",
    { title: "Engineering decisions" },
    201,
  );
  const { question } = await request(
    `${questionnaire}/rounds/${round.id}/questions`,
    "POST",
    { ...questionContent, assignees: [{ kind: "role", role: "Engineer" }] },
    201,
  );
  const { preview } = await request(
    `${questionnaire}/rounds/${round.id}/publish-preview`,
  );
  await request(`${questionnaire}/rounds/${round.id}/publish`, "POST", {
    confirmed: true,
    confirmationHash: preview.confirmationHash,
  });
  const context = await request(
    `${questionnaire}/questions/${question.id}/prompt`,
    "GET",
    undefined,
    200,
    secret,
  );
  expect(context.answerRevision).toBe(0);
  const { answer } = await request(
    `${questionnaire}/questions/${question.id}/answer`,
    "PUT",
    {
      revision: 0,
      questionRevision: question.revision,
      text: "Use the agreed table schema.",
    },
    200,
    secret,
  );
  await request(
    `${questionnaire}/questions/${question.id}/submit`,
    "POST",
    { revision: answer.revision, questionRevision: question.revision },
    200,
    secret,
  );
  await request(
    `${questionnaire}/questions/${question.id}/resolve`,
    "POST",
    {},
    403,
    secret,
  );
});

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
    [
      { text: "x".repeat(1024 * 1024), rationale: "Over the result limit" },
      413,
      /exceeds 1 MiB/u,
    ],
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
  const submitted = await submit(jobs, job, secret, result, [
    [
      {
        questions: [
          ...result.questions,
          {
            ...result.questions[0],
            question: { ...questionContent, text: "Which columns again?" },
          },
        ],
      },
      400,
      /Import each source question number once per file/u,
    ],
  ]);
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

it("carries accepted translations and import provenance into a new workflow version with origin links", async () => {
  const { workflowId, versionId, jobs, questionnaire, pins, secret } =
    await setup();
  const question = await answeredQuestion(questionnaire);
  const { job: translation } = await request(
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
  const translated = { text: "需要哪些列？", rationale: "确定表格约定。" };
  await accept(
    jobs,
    await submit(jobs, translation, secret, translated),
    translated,
  );
  const { round } = await request(
    `${questionnaire}/rounds`,
    "POST",
    { title: "Imported questions" },
    201,
  );
  const { job: imports } = await request(
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
  const source = {
    ...pins[0],
    path: "reference/contract.md",
    startLine: 3,
    endLine: 3,
    fileHash,
  };
  const imported = {
    questions: [{ number: 1, source, question: questionContent }],
  };
  await accept(jobs, await submit(jobs, imports, secret, imported), imported);
  const before = await request(questionnaire);
  const original = (id: string) =>
    before.questions.find((q: { id: string }) => q.id === id);
  const importedId = before.questions.find(
    (q: { source: unknown }) => q.source !== null,
  ).id;

  const { workflow } = await request(`/workflows/${workflowId}`);
  const { version } = await request(
    `/workflows/${workflowId}/versions`,
    "POST",
    { revision: workflow.revision },
    201,
  );
  const inherited = await request(
    `/workflows/${workflowId}/versions/${version.id}/questionnaire`,
  );
  const copy = (id: string) =>
    inherited.questions.find(
      (q: { origin: { recordId: string } }) => q.origin.recordId === id,
    );
  const [earlier] = original(question.id).translations;
  expect(copy(question.id).translations).toHaveLength(1);
  const [carried] = copy(question.id).translations;
  expect(carried).toEqual({
    ...earlier,
    id: carried.id,
    questionId: copy(question.id).id,
    origin: { workflowVersionId: versionId, recordId: earlier.id, revision: 1 },
  });
  expect(carried.id).not.toBe(earlier.id);
  expect(copy(importedId).source).toEqual({
    ...original(importedId).source,
    origin: { workflowVersionId: versionId, recordId: importedId, revision: 1 },
  });
  expect(original(question.id).translations[0].origin).toBeNull();
  expect(original(importedId).source.origin).toBeNull();
});

it("imports a numbered source question into a workflow version only once", async () => {
  const { jobs, questionnaire, pins, secret } = await setup();
  const { round } = await request(
    `${questionnaire}/rounds`,
    "POST",
    { title: "Imported questions" },
    201,
  );
  const target = {
    kind: "import-open-questions",
    roundId: round.id,
    skillId: pins[0].skillId,
  };
  const first = await create(jobs, target);
  const second = await create(jobs, target);
  const result = importOf(pins[0]);
  await accept(jobs, await submit(jobs, first, secret, result), result);
  // The accepted import is an input of every pending import from that Skill.
  expect(await jobStatus(jobs, second)).toBe("cancelled");
  const again = await create(jobs, target);
  const submitted = await submit(jobs, again, secret, result);
  const { error, questionId } = await request(
    `${jobs}/${again.id}/accept-preview`,
    "POST",
    { revision: submitted.revision, ...result },
    409,
  );
  expect(error.message).toBe(
    "Question 1 of reference/contract.md is already imported into this workflow version",
  );
  const view = await request(questionnaire);
  expect(view.questions).toEqual([
    expect.objectContaining({ id: questionId, source: expect.anything() }),
  ]);
  const other = importOf(pins[0], 2);
  await accept(
    jobs,
    await submit(jobs, await create(jobs, target), secret, other),
    other,
  );
  expect((await request(questionnaire)).questions).toHaveLength(2);
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
