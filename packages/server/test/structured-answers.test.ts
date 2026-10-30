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

function call(method: string, path: string, body?: unknown, as = engineer) {
  return service.request(`/api/v1${path}`, {
    method,
    as,
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function json(request: Promise<Response>, status = 200) {
  const response = await request;
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
  const { group } = await json(
    call("POST", "/groups", { name: "Research" }, admin),
    201,
  );
  const { workflow, version } = await json(
    call(
      "POST",
      "/workflows",
      {
        groupId: group.id,
        name: "structured",
        goal: "Agree storage conditions.",
        intent: "new-skill",
        locale: "en",
      },
      admin,
    ),
    201,
  );
  for (const [person, role] of [
    [engineer, "Engineer"],
    [expert, "Field expert"],
    [observer, "Observer"],
  ] as const)
    await json(
      call(
        "POST",
        "/bindings",
        {
          scopeType: "workflow",
          scopeId: workflow.id,
          email: person.email,
          role,
        },
        admin,
      ),
      201,
    );
  const { person } = await json(call("GET", "/me", undefined, expert));
  const base = `/workflows/${workflow.id}/versions/${version.id}/questionnaire`;
  const { round } = await json(
    call("POST", `${base}/rounds`, { title: "Storage" }),
    201,
  );
  const content = {
    text: "Which storage conditions?",
    topic: "scope",
    targets: [{ kind: "workflow", id: workflow.id }],
    rationale: "Preserve samples.",
    evidence: [],
    assignees: [{ kind: "role", role: "Field expert" }],
    priority: 10,
  };
  const create = async (answerType: unknown) =>
    (
      await json(
        call("POST", `${base}/rounds/${round.id}/questions`, {
          ...content,
          answerType,
        }),
        201,
      )
    ).question;
  const publish = async () => {
    const { preview } = await json(
      call("GET", `${base}/rounds/${round.id}/publish-preview`),
    );
    await json(
      call("POST", `${base}/rounds/${round.id}/publish`, {
        confirmed: true,
        confirmationHash: preview.confirmationHash,
      }),
    );
  };
  const save = (questionId: string, body: unknown) =>
    call(
      "PUT",
      `${base}/questions/${questionId}/answer`,
      { revision: 0, questionRevision: 1, ...(body as object) },
      expert,
    );
  const submit = (questionId: string, revision = 1) =>
    call(
      "POST",
      `${base}/questions/${questionId}/submit`,
      { revision, questionRevision: 1 },
      expert,
    );
  return {
    base,
    round,
    content,
    create,
    publish,
    save,
    submit,
    expertId: person.id,
  };
}

describe("structured answers", () => {
  it("lets an assigned expert's Agent attach evidence while preserving token scopes and answer channel", async () => {
    const { base, create, publish } = await setup();
    const question = await create({ kind: "yes-no" });
    await publish();
    const { secret } = await json(
      call(
        "POST",
        "/me/tokens",
        { name: "Expert Agent", scopes: ["expert"] },
        expert,
      ),
      201,
    );
    const agent = (method: string, path: string, body?: unknown) =>
      service.request(`/api/v1${path}`, {
        method,
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          "x-badger-agent-host": "example-host",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const { attachment } = await json(
      agent("POST", `${base}/questions/${question.id}/attachments`, {
        questionRevision: 1,
        name: "example.json",
        mediaType: "application/json",
        contentBase64: Buffer.from('{"example":true}').toString("base64"),
      }),
      201,
    );
    await json(
      agent("PUT", `${base}/questions/${question.id}/answer`, {
        revision: 0,
        questionRevision: 1,
        value: false,
        attachments: [attachment.id],
      }),
    );
    const { answers } = await json(
      agent("POST", `${base}/questions/${question.id}/submit`, {
        revision: 1,
        questionRevision: 1,
      }),
    );
    expect(answers[0]).toMatchObject({
      value: false,
      channel: "mcp",
      agentHost: "example-host",
      attachments: [attachment],
    });
    const { secret: wrongScope } = await json(
      call(
        "POST",
        "/me/tokens",
        { name: "Engineer Agent", scopes: ["engineer"] },
        engineer,
      ),
      201,
    );
    const denied = await service.request(
      `/api/v1${base}/questions/${question.id}/attachments`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${wrongScope}`,
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    expect(denied.status).toBe(403);
  });
  it("validates a single choice on the server and preserves its submitted revision", async () => {
    const { base, create, publish, save, submit } = await setup();
    const question = await create({
      kind: "single-choice",
      options: ["Cold", "Frozen"],
    });
    await publish();
    await json(save(question.id, { value: "Ambient" }), 400);
    const { answer } = await json(save(question.id, { value: "Frozen" }));
    expect(answer.value).toBe("Frozen");
    await json(submit(question.id));
    const view = await json(call("GET", base));
    expect(view.questions[0].answerType).toEqual({
      kind: "single-choice",
      options: ["Cold", "Frozen"],
    });
    expect(view.answers[0].value).toBe("Frozen");
    expect(
      view.answers[0].revisions.map((r: { value: unknown }) => r.value),
    ).toEqual(["Frozen"]);
    const own = await json(call("GET", base, undefined, expert));
    expect(
      own.answers[0].revisions.map((r: { value: unknown }) => r.value),
    ).toEqual(["Frozen", "Frozen"]);
  });

  it.each([
    [{ kind: "free-text" }, { text: "冷冻保存" }, { text: 42 }, null],
    [
      { kind: "multiple-choice", options: ["Cold", "Frozen"] },
      { value: ["Cold", "Frozen"] },
      { value: ["Cold", "Cold"] },
      ["Cold", "Frozen"],
    ],
    [{ kind: "yes-no" }, { value: false }, { value: "no" }, false],
    [{ kind: "number", unit: "°C" }, { value: 0 }, { value: "0" }, 0],
    [
      { kind: "table", columns: ["Sample", "Storage"] },
      { value: [["血液", "Frozen"]] },
      { value: [["血液"]] },
      [["血液", "Frozen"]],
    ],
  ])(
    "validates and submits %j without requiring free text",
    async (type, valid, invalid, expected) => {
      const { base, create, publish, save, submit } = await setup();
      const question = await create(type);
      await publish();
      await json(save(question.id, invalid), 400);
      await json(save(question.id, valid));
      await json(submit(question.id));
      const view = await json(call("GET", base));
      expect(view.answers[0].value).toEqual(expected);
      expect(view.answers[0].state).toBe("submitted");
    },
  );

  it("stores an attachment privately, submits a file answer, and binds its receipt into facts", async () => {
    const { base, create, publish, save, submit, expertId } = await setup();
    const question = await create({ kind: "file" });
    await publish();
    const uploadPath = `${base}/questions/${question.id}/attachments`;
    const upload = {
      questionRevision: 1,
      name: "Expert's storage.txt",
      mediaType: "text/plain",
      contentBase64: Buffer.from("Frozen storage").toString("base64"),
    };
    await json(call("POST", uploadPath, upload, observer), 403);
    const { attachment } = await json(
      call("POST", uploadPath, upload, expert),
      201,
    );
    expect(attachment).toMatchObject({
      name: "Expert's storage.txt",
      size: 14,
      hash: "4af5e90280eaf303ffeaefb62ffbe154be0899a5b472c7f3a24f5183e67a6cdf",
    });
    const audit = await json(
      call(
        "GET",
        "/audit-events?action=answer.attachment-uploaded",
        undefined,
        admin,
      ),
    );
    expect(audit.events).toEqual([
      expect.objectContaining({
        targetType: "attachment",
        targetId: attachment.id,
        after: { revision: 1, hash: attachment.hash },
      }),
    ]);
    const filePath = `${base}/attachments/${attachment.id}`;
    expect((await call("GET", filePath)).status).toBe(404);
    await json(save(question.id, { attachments: [attachment.id] }));
    await json(submit(question.id));
    const download = await call("GET", filePath);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain(
      "attachment;",
    );
    expect(download.headers.get("content-disposition")).toContain(
      "Expert%27s%20storage.txt",
    );
    expect(await download.text()).toBe("Frozen storage");
    const input = {
      revision: 1,
      kind: "confirmed",
      facts: [
        {
          text: "Use frozen storage.",
          answers: [{ personId: expertId, revision: 2 }],
        },
      ],
    };
    const { preview } = await json(
      call(
        "POST",
        `${base}/questions/${question.id}/resolution-preview`,
        input,
      ),
    );
    expect(preview.answers[0].attachments).toEqual([attachment]);
    await json(
      call("POST", `${base}/questions/${question.id}/resolve`, {
        ...input,
        confirmed: true,
        confirmationHash: preview.confirmationHash,
        requestId: "confirm-file",
      }),
    );
    const view = await json(call("GET", base));
    expect(view.facts[0].attachments).toEqual([attachment]);
    await json(save(question.id, { revision: 2, attachments: [] }));
    const corrected = await json(call("GET", base));
    expect(corrected.questions[0].state).toBe("needs-reconfirmation");
    expect(corrected.facts[0].active).toBe(false);
    expect((await call("GET", filePath)).status).toBe(200);
  });

  it("refuses malformed composer schemas before storing a question", async () => {
    const { base, round, content } = await setup();
    for (const answerType of [
      { kind: "single-choice", options: ["Only"] },
      { kind: "multiple-choice", options: ["Cold", "Cold"] },
      { kind: "single-choice", options: ["Cold", " Cold "] },
      { kind: "yes-no", options: ["Yes", "No"] },
      { kind: "number", unit: " " },
      { kind: "number", unit: "°C", minimum: 0 },
      { kind: "table", columns: [] },
      { kind: "table", columns: ["Sample", "Sample"] },
      { kind: "unsupported" },
    ])
      await json(
        call("POST", `${base}/rounds/${round.id}/questions`, {
          ...content,
          answerType,
        }),
        400,
      );
    const view = await json(call("GET", base));
    expect(view.questions).toEqual([]);
  });

  it("allows incomplete drafts but submits a round atomically only when every value is complete", async () => {
    const { base, round, create, publish, save } = await setup();
    const choice = await create({
      kind: "multiple-choice",
      options: ["Cold", "Frozen"],
    });
    const table = await create({
      kind: "table",
      columns: ["Sample", "Storage"],
    });
    await publish();
    await json(save(choice.id, { value: ["Frozen"] }));
    await json(save(table.id, { value: [["Sample", ""]] }));
    const submit = () =>
      call(
        "POST",
        `${base}/rounds/${round.id}/submit`,
        {
          answers: [
            { questionId: choice.id, revision: 1, questionRevision: 1 },
            { questionId: table.id, revision: 1, questionRevision: 1 },
          ],
        },
        expert,
      );
    await json(submit(), 400);
    const view = await json(call("GET", base));
    expect(view.answers).toEqual([]);
    const own = await json(call("GET", base, undefined, expert));
    expect(
      own.answers.every(
        (answer: { state: string }) => answer.state === "draft",
      ),
    ).toBe(true);
  });

  it("enforces file size, type, count and ownership through the API", async () => {
    const { base, create, publish, save, submit } = await setup();
    const question = await create({ kind: "file" });
    const otherQuestion = await create({ kind: "file" });
    await publish();
    await json(save(question.id, { attachments: [] }));
    await json(submit(question.id), 400);
    const path = `${base}/questions/${question.id}/attachments`;
    const input = {
      questionRevision: 1,
      name: "example.txt",
      mediaType: "text/plain",
      contentBase64: Buffer.from("Example").toString("base64"),
    };
    for (const override of [
      { name: "../escape.txt" },
      { name: "nested/example.txt" },
      { mediaType: "text/html" },
      { mediaType: "application/pdf" },
      { mediaType: "image/png" },
      { mediaType: "application/json" },
      { contentBase64: "%%%" },
      { contentBase64: "" },
      { contentBase64: Buffer.from([0, 1, 2]).toString("base64") },
    ])
      await json(call("POST", path, { ...input, ...override }, expert), 400);
    await json(
      call("POST", path, { ...input, questionRevision: 2 }, expert),
      409,
    );
    await json(
      call(
        "POST",
        path,
        {
          ...input,
          contentBase64: Buffer.alloc(5 * 1024 * 1024 + 1, 65).toString(
            "base64",
          ),
        },
        expert,
      ),
      413,
    );
    const files = [];
    for (let i = 0; i < 5; i++) {
      const { attachment } = await json(
        call(
          "POST",
          path,
          {
            ...input,
            name: `${i}.txt`,
            contentBase64: Buffer.alloc(5 * 1024 * 1024, 65).toString("base64"),
          },
          expert,
        ),
        201,
      );
      files.push(attachment.id);
    }
    await json(save(question.id, { revision: 1, attachments: files }), 400);
    await json(
      save(question.id, { revision: 1, attachments: files.slice(0, 4) }),
    );
    await json(save(otherQuestion.id, { attachments: [files[0]] }), 400);
    await json(
      save(otherQuestion.id, {
        attachments: Array.from({ length: 9 }, (_, i) => `file-${i}`),
      }),
      400,
    );
    await json(
      save(otherQuestion.id, { attachments: [files[0], files[0]] }),
      400,
    );
    await json(
      call(
        "PUT",
        `${base}/questions/${question.id}/answer`,
        { revision: 0, questionRevision: 1, attachments: [files[0]] },
        observer,
      ),
      403,
    );
  });

  it("revalidates structured answers after the Engineer revises their schema", async () => {
    const { base, content, create, publish, save, submit } = await setup();
    const question = await create({ kind: "number", unit: "°C" });
    await publish();
    await json(save(question.id, { value: -20 }));
    await json(submit(question.id));
    await json(
      call("PATCH", `${base}/questions/${question.id}`, {
        ...content,
        revision: 1,
        answerType: { kind: "single-choice", options: ["Cold", "Frozen"] },
      }),
    );
    await json(
      call(
        "POST",
        `${base}/questions/${question.id}/submit`,
        { revision: 2, questionRevision: 2 },
        expert,
      ),
      409,
    );
    await json(
      save(question.id, { revision: 2, questionRevision: 2, value: -20 }),
      400,
    );
    await json(
      save(question.id, { revision: 2, questionRevision: 2, value: "Frozen" }),
    );
    const view = await json(call("GET", base, undefined, expert));
    expect(
      view.answers[0].revisions.map(
        (answer: { value: unknown }) => answer.value,
      ),
    ).toEqual([-20, -20, "Frozen"]);
    expect(view.questions[0].revisions[0].answerType).toEqual({
      kind: "number",
      unit: "°C",
    });
  });
});
