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
const other: TestPerson = { subject: "other", email: "other@example.com" };
let service: TestService;
afterEach(async () => service?.close());

function write(method: string, path: string, as: TestPerson, body: unknown) {
  return service.request(`/api/v1${path}`, {
    as,
    method,
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

async function json<T>(response: Promise<Response>, status = 200): Promise<T> {
  const result = await response;
  const body = await result.json();
  expect(result.status, JSON.stringify(body)).toBe(status);
  return body as T;
}

async function setup() {
  service = await startTestService({
    environment: {
      BADGER_BOOTSTRAP_ADMINISTRATORS: admin.email,
      BADGER_ALLOWED_ORIGINS: "http://localhost",
    },
  });
  const { group } = await json<{ group: { id: string } }>(
    write("POST", "/groups", admin, { name: "Research" }),
    201,
  );
  const { workflow, version } = await json<{
    workflow: { id: string };
    version: { id: string };
  }>(
    write("POST", "/workflows", admin, {
      groupId: group.id,
      name: "questionnaire",
      goal: "Understand the workflow.",
      intent: "new-skill",
      locale: "en",
    }),
    201,
  );
  for (const [person, role] of [
    [engineer, "Engineer"],
    [expert, "Field expert"],
    [other, "Observer"],
  ] as const) {
    await json(
      write("POST", "/bindings", admin, {
        scopeType: "workflow",
        scopeId: workflow.id,
        email: person.email,
        role,
      }),
      201,
    );
  }
  const { person } = await json<{ person: { id: string } }>(
    service.request("/api/v1/me", { as: expert }),
  );
  return {
    base: `/workflows/${workflow.id}/versions/${version.id}/questionnaire`,
    groupId: group.id,
    versionId: version.id,
    workflowId: workflow.id,
    expertId: person.id,
  };
}

function question(
  expertId: string,
  priority = 10,
  text = "How is the sample stored?",
) {
  return {
    text,
    topic: "scope",
    targets: [{ kind: "workflow", id: "workflow" }],
    rationale: "Choose the correct storage conditions.",
    evidence: [],
    assignees: [{ kind: "person", personId: expertId }],
    priority,
  };
}

describe("questionnaire rounds", () => {
  it("keeps draft revisions and publishes an ordered round against the reviewed hash", async () => {
    const { base, expertId } = await setup();
    const { round } = await json<{ round: { id: string; revision: number } }>(
      write("POST", `${base}/rounds`, engineer, { title: "Sample handling" }),
      201,
    );
    const path = `${base}/rounds/${round.id}`;
    const { question: low } = await json<{
      question: { id: string; revision: number };
    }>(write("POST", `${path}/questions`, engineer, question(expertId)), 201);
    const { question: high } = await json<{ question: { id: string } }>(
      write(
        "POST",
        `${path}/questions`,
        engineer,
        question(expertId, 90, "Which sample is accepted?"),
      ),
      201,
    );
    const { preview } = await json<{
      preview: {
        confirmationHash: string;
        questions: { id: string }[];
        revision: number;
      };
    }>(service.request(`/api/v1${path}/publish-preview`, { as: engineer }));
    expect(preview.questions.map((q) => q.id)).toEqual([high.id, low.id]);

    await json(
      write("PATCH", `${base}/questions/${low.id}`, engineer, {
        ...question(expertId, 10, "How cold is storage?"),
        revision: low.revision,
      }),
    );
    expect(
      (
        await write("POST", `${path}/publish`, engineer, {
          confirmationHash: preview.confirmationHash,
          confirmed: true,
        })
      ).status,
    ).toBe(409);
    const current = await json<{ preview: { confirmationHash: string } }>(
      service.request(`/api/v1${path}/publish-preview`, { as: engineer }),
    );
    await json(
      write("POST", `${path}/publish`, engineer, {
        confirmationHash: current.preview.confirmationHash,
        confirmed: true,
      }),
    );
    const view = await json<{
      rounds: { state: string }[];
      questions: { id: string; revisions: { text: string }[]; state: string }[];
    }>(service.request(`/api/v1${base}`, { as: engineer }));
    expect(view.rounds[0]?.state).toBe("published");
    expect(view.questions.map((q) => q.id)).toEqual([high.id, low.id]);
    expect(
      view.questions.find((q) => q.id === low.id)?.revisions.map((r) => r.text),
    ).toEqual(["How is the sample stored?", "How cold is storage?"]);
    expect(view.questions.every((q) => q.state === "open")).toBe(true);
    const inbox = await json<{ items: { kind: string; href: string }[] }>(
      service.request("/api/v1/me/inbox", { as: expert }),
    );
    expect(
      inbox.items
        .filter((i) => i.kind === "question-assigned")
        .map((i) => i.href)
        .sort(),
    ).toEqual(
      [
        `/questionnaire/questions/${low.id}`,
        `/questionnaire/questions/${high.id}`,
      ].sort(),
    );
  });

  it("autosaves private drafts in any language, submits a round atomically, and keeps submitted revisions", async () => {
    const { base, expertId } = await setup();
    const { round } = await json<{ round: { id: string } }>(
      write("POST", `${base}/rounds`, engineer, { title: "Storage" }),
      201,
    );
    const questions = [];
    for (const text of ["Which sample?", "Which temperature?"]) {
      const result = await json<{ question: { id: string; revision: number } }>(
        write(
          "POST",
          `${base}/rounds/${round.id}/questions`,
          engineer,
          question(expertId, 10, text),
        ),
        201,
      );
      questions.push(result.question);
    }
    const path = `${base}/rounds/${round.id}`;
    const { preview } = await json<{ preview: { confirmationHash: string } }>(
      service.request(`/api/v1${path}/publish-preview`, { as: engineer }),
    );
    await json(
      write("POST", `${path}/publish`, engineer, {
        confirmed: true,
        confirmationHash: preview.confirmationHash,
      }),
    );
    const drafts = [];
    for (const [index, q] of questions.entries()) {
      const { answer } = await json<{ answer: { revision: number } }>(
        write("PUT", `${base}/questions/${q.id}/answer`, expert, {
          revision: 0,
          questionRevision: q.revision,
          text: ["血浆", "4°C"][index],
        }),
      );
      drafts.push({
        questionId: q.id,
        questionRevision: q.revision,
        revision: answer.revision,
      });
    }
    const privateView = await json<{ answers: unknown[] }>(
      service.request(`/api/v1${base}`, { as: engineer }),
    );
    expect(privateView.answers).toEqual([]);
    const ownView = await json<{ answers: { text: string; state: string }[] }>(
      service.request(`/api/v1${base}`, { as: expert }),
    );
    expect(ownView.answers.map((a) => a.text).sort()).toEqual(["4°C", "血浆"]);
    expect(
      (await write("POST", `${path}/submit`, expert, { answers: [drafts[0]] }))
        .status,
    ).toBe(409);
    const stale = await write("POST", `${path}/submit`, expert, {
      answers: [drafts[0], { ...drafts[1], revision: 99 }],
    });
    expect(stale.status).toBe(409);
    expect(
      (
        await json<{ answers: unknown[] }>(
          service.request(`/api/v1${base}`, { as: engineer }),
        )
      ).answers,
    ).toEqual([]);
    await json(write("POST", `${path}/submit`, expert, { answers: drafts }));
    const submitted = await json<{
      answers: {
        text: string;
        state: string;
        channel: string;
        revision: number;
      }[];
      questions: { state: string }[];
    }>(service.request(`/api/v1${base}`, { as: engineer }));
    expect(submitted.answers.map((a) => a.text).sort()).toEqual([
      "4°C",
      "血浆",
    ]);
    expect(
      submitted.answers.every(
        (a) => a.state === "submitted" && a.channel === "web",
      ),
    ).toBe(true);
    expect(submitted.questions.every((q) => q.state === "answered")).toBe(true);
    const inbox = await json<{
      pendingCount: number;
      items: { state: string }[];
    }>(service.request("/api/v1/me/inbox", { as: expert }));
    expect(inbox.pendingCount).toBe(0);
    expect(inbox.items.every((i) => i.state === "done")).toBe(true);
    const q = questions[0];
    await json(
      write("PUT", `${base}/questions/${q.id}/answer`, expert, {
        revision: 2,
        questionRevision: q.revision,
        text: "血清",
      }),
    );
    // A new draft leaves the previous submission visible to the Engineer.
    expect(
      (
        await json<{ answers: { text: string }[] }>(
          service.request(`/api/v1${base}`, { as: engineer }),
        )
      ).answers.some((a) => a.text === "血浆"),
    ).toBe(true);
    await json(
      write("POST", `${base}/questions/${q.id}/submit`, expert, {
        revision: 3,
        questionRevision: q.revision,
      }),
    );
    const history = await json<{
      answers: {
        questionId: string;
        revisions: { text: string; channel: string }[];
      }[];
    }>(service.request(`/api/v1${base}`, { as: engineer }));
    expect(
      history.answers
        .find((a) => a.questionId === q.id)
        ?.revisions.map((r) => r.text),
    ).toEqual(["血浆", "血清"]);
  });

  it("applies a workflow round size limit only when one is configured", async () => {
    const { base, expertId } = await setup();
    const { round } = await json<{ round: { id: string } }>(
      write("POST", `${base}/rounds`, engineer, { title: "Batch" }),
      201,
    );
    for (let index = 0; index < 68; index++)
      await json(
        write(
          "POST",
          `${base}/rounds/${round.id}/questions`,
          engineer,
          question(expertId),
        ),
        201,
      );
    const path = `${base}/rounds/${round.id}/publish-preview`;
    await json(service.request(`/api/v1${path}`, { as: engineer }));
    await json(
      write("PUT", `${base}/settings`, engineer, {
        revision: 0,
        roundSizeLimit: 67,
      }),
    );
    expect(
      (await service.request(`/api/v1${path}`, { as: engineer })).status,
    ).toBe(409);
    expect(
      (
        await write("PUT", `${base}/settings`, engineer, {
          revision: 0,
          roundSizeLimit: null,
        })
      ).status,
    ).toBe(409);
    await json(
      write("PUT", `${base}/settings`, engineer, {
        revision: 1,
        roundSizeLimit: null,
      }),
    );
    const { preview } = await json<{
      preview: { confirmationHash: string; questions: unknown[] };
    }>(service.request(`/api/v1${path}`, { as: engineer }));
    expect(preview.questions).toHaveLength(68);
    await json(
      write("POST", `${base}/rounds/${round.id}/publish`, engineer, {
        confirmed: true,
        confirmationHash: preview.confirmationHash,
      }),
    );
  });

  it("streams changes for the signed-in person's visible records and reconnects with a fresh snapshot", async () => {
    const { base, versionId } = await setup();
    const controller = new AbortController();
    const response = await service.request("/api/v1/me/events", {
      as: engineer,
      signal: controller.signal,
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    let buffer = "";
    const next = async () => {
      while (!buffer.includes("\n\n")) {
        const { value, done } = await reader.read();
        if (done)
          throw new Error("Event stream ended before the change arrived");
        buffer += new TextDecoder().decode(value);
      }
      const end = buffer.indexOf("\n\n");
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      return event;
    };
    try {
      expect(await next()).toContain("event: ready");
      await json(
        write("POST", `${base}/rounds`, engineer, { title: "Live round" }),
        201,
      );
      const changed = await next();
      expect(changed).toContain("event: change");
      expect(changed).toContain(versionId);
      const stranger = { subject: "stranger" };
      const hidden = await service.request("/api/v1/me/events", {
        as: stranger,
      });
      const hiddenReader = hidden.body!.getReader();
      const first = new TextDecoder().decode((await hiddenReader.read()).value);
      expect(first).not.toContain(versionId);
      await hiddenReader.cancel();
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
    const reconnect = await service.request("/api/v1/me/events", {
      as: engineer,
    });
    const reconnectReader = reconnect.body!.getReader();
    expect(
      new TextDecoder().decode((await reconnectReader.read()).value),
    ).toContain("event: ready");
    await reconnectReader.cancel();
  });

  it("checks assignments and token scopes, and requires a new answer to a revised published question", async () => {
    const { base, expertId } = await setup();
    const { round } = await json<{ round: { id: string } }>(
      write("POST", `${base}/rounds`, engineer, { title: "Access" }),
      201,
    );
    const { question: q } = await json<{
      question: { id: string; revision: number };
    }>(
      write(
        "POST",
        `${base}/rounds/${round.id}/questions`,
        engineer,
        question(expertId),
      ),
      201,
    );
    expect(
      (
        await json<{ questions: unknown[] }>(
          service.request(`/api/v1${base}`, { as: expert }),
        )
      ).questions,
    ).toEqual([]);
    expect(
      (
        await write("PATCH", `${base}/questions/${q.id}`, other, {
          ...question(expertId),
          revision: 1,
        })
      ).status,
    ).toBe(403);
    const { secret: engineerToken } = await json<{ secret: string }>(
      write("POST", "/me/tokens", engineer, {
        name: "Engineer Agent",
        scopes: ["engineer"],
      }),
      201,
    );
    const { secret: expertToken } = await json<{ secret: string }>(
      write("POST", "/me/tokens", expert, {
        name: "Expert Agent",
        scopes: ["expert"],
      }),
      201,
    );
    const agent = (secret: string, method: string, body: unknown) => ({
      method,
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        "x-badger-agent-host": "lab-workbuddy",
      },
      body: JSON.stringify(body),
    });
    const { preview } = await json<{ preview: { confirmationHash: string } }>(
      service.request(`/api/v1${base}/rounds/${round.id}/publish-preview`, {
        as: engineer,
      }),
    );
    const publish = {
      confirmed: true,
      confirmationHash: preview.confirmationHash,
    };
    expect(
      (
        await service.request(
          `/api/v1${base}/rounds/${round.id}/publish`,
          agent(engineerToken, "POST", publish),
        )
      ).status,
    ).toBe(403);
    await json(
      write("POST", `${base}/rounds/${round.id}/publish`, engineer, publish),
    );
    const draft = { revision: 0, questionRevision: 1, text: "4°C" };
    expect(
      (await write("PUT", `${base}/questions/${q.id}/answer`, other, draft))
        .status,
    ).toBe(403);
    await json(write("PUT", `${base}/questions/${q.id}/answer`, expert, draft));
    expect(
      (await write("PUT", `${base}/questions/${q.id}/answer`, expert, draft))
        .status,
    ).toBe(409);
    await json(
      write("PATCH", `${base}/questions/${q.id}`, engineer, {
        ...question(expertId, 10, "How cold is plasma storage?"),
        revision: 1,
      }),
    );
    expect(
      (
        await write("POST", `${base}/questions/${q.id}/submit`, expert, {
          revision: 1,
          questionRevision: 1,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await service.request(
          `/api/v1${base}/questions/${q.id}`,
          agent(engineerToken, "PATCH", { ...question(expertId), revision: 2 }),
        )
      ).status,
    ).toBe(403);
    await json(
      service.request(
        `/api/v1${base}/questions/${q.id}/answer`,
        agent(expertToken, "PUT", {
          revision: 1,
          questionRevision: 2,
          text: "2–8°C",
        }),
      ),
    );
    await json(
      service.request(
        `/api/v1${base}/questions/${q.id}/submit`,
        agent(expertToken, "POST", { revision: 2, questionRevision: 2 }),
      ),
    );
    const view = await json<{
      answers: {
        channel: string;
        agentHost: string;
        questionRevision: number;
      }[];
    }>(service.request(`/api/v1${base}`, { as: engineer }));
    expect(view.answers).toMatchObject([
      { channel: "mcp", agentHost: "lab-workbuddy", questionRevision: 2 },
    ]);
  });

  it("publishes to current role assignees, including an invitation created after drafting", async () => {
    const { base, workflowId, expertId } = await setup();
    const invited = { subject: "invited", email: "invited@example.com" };
    const { round } = await json<{ round: { id: string } }>(
      write("POST", `${base}/rounds`, engineer, { title: "Team" }),
      201,
    );
    const { question: q } = await json<{ question: { id: string } }>(
      write("POST", `${base}/rounds/${round.id}/questions`, engineer, {
        ...question(expertId),
        assignees: [
          { kind: "role", role: "Field expert" },
          { kind: "role", role: "Workflow owner" },
        ],
      }),
      201,
    );
    await json(
      write("POST", "/bindings", admin, {
        scopeType: "workflow",
        scopeId: workflowId,
        email: invited.email,
        role: "Field expert",
      }),
      201,
    );
    const { preview } = await json<{ preview: { confirmationHash: string } }>(
      service.request(`/api/v1${base}/rounds/${round.id}/publish-preview`, {
        as: engineer,
      }),
    );
    await json(
      write("POST", `${base}/rounds/${round.id}/publish`, engineer, {
        confirmed: true,
        confirmationHash: preview.confirmationHash,
      }),
    );
    const inbox = await json<{ pendingQuestionCount: number }>(
      service.request("/api/v1/me/inbox", { as: invited }),
    );
    expect(inbox.pendingQuestionCount).toBe(1);
    for (const [index, person] of [expert, invited, admin].entries()) {
      await json(
        write("PUT", `${base}/questions/${q.id}/answer`, person, {
          revision: 0,
          questionRevision: 1,
          text: "Agreed.",
        }),
      );
      await json(
        write("POST", `${base}/questions/${q.id}/submit`, person, {
          revision: 1,
          questionRevision: 1,
        }),
      );
      const view = await json<{ questions: { state: string }[] }>(
        service.request(`/api/v1${base}`, { as: engineer }),
      );
      expect(view.questions[0]?.state).toBe(index === 2 ? "answered" : "open");
    }
  });

  it("links evidence to an actual pinned Skill file and preserves it in the question history", async () => {
    const { base, groupId, expertId } = await setup();
    const { skill } = await json<{ skill: { id: string } }>(
      write("POST", "/skills", admin, { groupId, name: "sample-guide" }),
      201,
    );
    const upload = {
      files: [
        {
          path: "SKILL.md",
          content: Buffer.from(
            "---\nname: sample-guide\ndescription: Sample guide\n---\n\nFollow the guide.\n",
          ).toString("base64"),
        },
        {
          path: "reference/guide.md",
          content: Buffer.from("Use plasma.\nStore at 4°C.\n").toString(
            "base64",
          ),
        },
      ],
    };
    const { preview } = await json<{ preview: { hash: string } }>(
      write("POST", `/skills/${skill.id}/upload-preview`, admin, upload),
    );
    await json(
      write("POST", `/skills/${skill.id}/versions`, admin, {
        ...upload,
        confirmed: true,
        expectedHash: preview.hash,
      }),
      201,
    );
    await json(
      write("POST", `${base.replace(/\/questionnaire$/u, "")}/pins`, engineer, {
        skillId: skill.id,
        hash: preview.hash,
      }),
      201,
    );
    const { round } = await json<{ round: { id: string } }>(
      write("POST", `${base}/rounds`, engineer, { title: "Evidence" }),
      201,
    );
    const evidence = [
      {
        skillId: skill.id,
        versionHash: preview.hash,
        path: "reference/guide.md",
        startLine: 1,
        endLine: 2,
      },
    ];
    await json(
      write("POST", `${base}/rounds/${round.id}/questions`, engineer, {
        ...question(expertId),
        evidence,
      }),
      201,
    );
    expect(
      (
        await write("POST", `${base}/rounds/${round.id}/questions`, engineer, {
          ...question(expertId),
          evidence: [{ ...evidence[0], path: "missing.md" }],
        })
      ).status,
    ).toBe(400);
    const view = await json<{
      questions: { revisions: { evidence: unknown[] }[] }[];
    }>(service.request(`/api/v1${base}`, { as: engineer }));
    expect(view.questions[0]?.revisions[0]?.evidence).toEqual(evidence);
  });
});
