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

function write(method: string, route: string, as: TestPerson, body: unknown) {
  return service.request(`/api/v1${route}`, {
    as,
    method,
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}
async function json<T = Record<string, unknown>>(
  response: Promise<Response>,
  status = 200,
): Promise<T> {
  const result = await response;
  const value = await result.json();
  expect(result.status, JSON.stringify(value)).toBe(status);
  return value as T;
}
interface View {
  personId: string;
  questions: {
    id: string;
    state: string;
    revision: number;
    canAnswer: boolean;
    parentQuestionId: string | null;
  }[];
  resolutions: {
    id: string;
    questionId: string;
    kind: string;
    actorId: string;
    reason: string | null;
    childQuestionId: string | null;
  }[];
  facts: {
    id: string;
    text: string;
    locale: string;
    active: boolean;
    actorId: string;
    answers: { personId: string; revision: number }[];
    acknowledgements: { personId: string; decision: string }[];
    evidence: { fileHash: string }[];
  }[];
}
async function setup(locale = "en") {
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
      name: "resolutions",
      goal: "Agree storage.",
      intent: "new-skill",
      locale,
    }),
    201,
  );
  for (const [person, role] of [
    [engineer, "Engineer"],
    [expert, "Field expert"],
    [other, "Field expert"],
  ] as const) {
    const { binding } = await json<{
      binding: { id: string; revision: number };
    }>(
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
  const base = `/workflows/${workflow.id}/versions/${version.id}/questionnaire`;
  const content = {
    text: "How is plasma stored?",
    topic: "scope",
    targets: [{ kind: "workflow", id: workflow.id }],
    rationale: "Agree safe handling.",
    evidence: [],
    assignees: [{ kind: "person", personId: person.id }],
    priority: 80,
  };
  const { round } = await json<{ round: { id: string } }>(
    write("POST", `${base}/rounds`, engineer, { title: "Storage" }),
    201,
  );
  const { question } = await json<{ question: { id: string } }>(
    write("POST", `${base}/rounds/${round.id}/questions`, engineer, content),
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
  await json(
    write("PUT", `${base}/questions/${question.id}/answer`, expert, {
      revision: 0,
      questionRevision: 1,
      text: "血浆应在2–8°C保存。",
    }),
  );
  await json(
    write("POST", `${base}/questions/${question.id}/submit`, expert, {
      revision: 1,
      questionRevision: 1,
    }),
  );
  return {
    base,
    questionId: question.id,
    expertId: person.id,
    groupId: group.id,
    workflowId: workflow.id,
    versionId: version.id,
    content,
  };
}
async function resolve(
  base: string,
  id: string,
  input: Record<string, unknown>,
  requestId: string = crypto.randomUUID(),
) {
  const route = `${base}/questions/${id}`;
  const { preview } = await json<{ preview: { confirmationHash: string } }>(
    write("POST", `${route}/resolution-preview`, engineer, input),
  );
  return json(
    write("POST", `${route}/resolve`, engineer, {
      ...input,
      confirmed: true,
      confirmationHash: preview.confirmationHash,
      requestId,
    }),
  );
}
async function view(base: string, as = engineer) {
  return json<View>(service.request(`/api/v1${base}`, { as }));
}

describe("answer resolutions", () => {
  it("confirms exact answer revisions into facts in the workflow locale and lets only their author acknowledge them", async () => {
    const { base, questionId, expertId } = await setup("zh-CN");
    const input = {
      revision: 1,
      kind: "confirmed",
      facts: [
        {
          text: "血浆必须在2–8°C保存。",
          answers: [{ personId: expertId, revision: 2 }],
        },
      ],
    };
    const result = await resolve(base, questionId, input, "confirm-storage");
    const current = await view(base);
    expect(current.questions[0].state).toBe("confirmed");
    expect(current.resolutions[0]).toMatchObject({
      kind: "confirmed",
      actorId: current.personId,
    });
    expect(current.facts[0]).toMatchObject({
      text: "血浆必须在2–8°C保存。",
      locale: "zh-CN",
      active: true,
      actorId: current.personId,
      answers: [{ personId: expertId, revision: 2 }],
      acknowledgements: [],
    });
    const fact = current.facts[0];
    const path = `${base}/facts/${fact.id}`;
    expect(
      (
        await write("POST", `${path}/acknowledgement-preview`, other, {
          decision: "acknowledged",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await write("POST", `${path}/acknowledgement-preview`, admin, {
          decision: "acknowledged",
        })
      ).status,
    ).toBe(403);
    const { preview } = await json<{ preview: { confirmationHash: string } }>(
      write("POST", `${path}/acknowledgement-preview`, expert, {
        decision: "acknowledged",
      }),
    );
    const ack = {
      decision: "acknowledged",
      confirmed: true,
      confirmationHash: preview.confirmationHash,
      requestId: "ack-storage",
    };
    await json(write("POST", `${path}/acknowledge`, expert, ack));
    await json(write("POST", `${path}/acknowledge`, expert, ack));
    expect((await view(base)).facts[0].acknowledgements).toEqual([
      expect.objectContaining({ personId: expertId, decision: "acknowledged" }),
    ]);
    const replay = await json(
      write("POST", `${base}/questions/${questionId}/resolve`, engineer, {
        ...input,
        confirmed: true,
        confirmationHash: (result.resolution as { confirmationHash: string })
          .confirmationHash,
        requestId: "confirm-storage",
      }),
    );
    expect(replay).toEqual(result);
  });
  it("disputes a restatement, reopens the question and notifies the Engineer", async () => {
    const { base, questionId, expertId } = await setup();
    await resolve(base, questionId, {
      revision: 1,
      kind: "confirmed",
      facts: [
        {
          text: "Store plasma frozen.",
          answers: [{ personId: expertId, revision: 2 }],
        },
      ],
    });
    const fact = (await view(base)).facts[0];
    const path = `${base}/facts/${fact.id}`;
    const input = {
      decision: "disputed",
      reason: "I said refrigerated, not frozen.",
    };
    const { preview } = await json<{ preview: { confirmationHash: string } }>(
      write("POST", `${path}/acknowledgement-preview`, expert, input),
    );
    await json(
      write("POST", `${path}/acknowledge`, expert, {
        ...input,
        confirmed: true,
        confirmationHash: preview.confirmationHash,
        requestId: "dispute",
      }),
    );
    const reopened = await view(base, expert);
    expect(reopened.questions[0]).toMatchObject({
      state: "open",
      canAnswer: true,
    });
    expect(reopened.facts[0]).toMatchObject({
      active: false,
      acknowledgements: [
        expect.objectContaining({ decision: "disputed", reason: input.reason }),
      ],
    });
    const inbox = await json<{
      items: { kind: string; href: string; state: string }[];
    }>(service.request("/api/v1/me/inbox", { as: engineer }));
    expect(inbox.items).toContainEqual(
      expect.objectContaining({
        kind: "question-reopened",
        href: `/questionnaire/questions/${questionId}`,
        state: "unread",
      }),
    );
  });

  it("invalidates confirmed facts as soon as their answer changes and rejects stale sign-off", async () => {
    const { base, questionId, expertId } = await setup();
    await resolve(base, questionId, {
      revision: 1,
      kind: "confirmed",
      facts: [
        {
          text: "Store plasma refrigerated.",
          answers: [{ personId: expertId, revision: 2 }],
        },
      ],
    });
    const fact = (await view(base)).facts[0];
    const path = `${base}/facts/${fact.id}`;
    const { preview } = await json<{ preview: { confirmationHash: string } }>(
      write("POST", `${path}/acknowledgement-preview`, expert, {
        decision: "acknowledged",
      }),
    );
    await json(
      write("PUT", `${base}/questions/${questionId}/answer`, expert, {
        questionRevision: 1,
        revision: 2,
        text: "Use serum instead.",
      }),
    );
    expect((await view(base)).questions[0].state).toBe("needs-reconfirmation");
    expect((await view(base)).facts[0].active).toBe(false);
    expect(
      (
        await write("POST", `${path}/acknowledge`, expert, {
          decision: "acknowledged",
          confirmed: true,
          confirmationHash: preview.confirmationHash,
          requestId: "stale-ack",
        })
      ).status,
    ).toBe(409);
    const input = {
      revision: 1,
      kind: "confirmed",
      facts: [
        { text: "Use serum.", answers: [{ personId: expertId, revision: 4 }] },
      ],
    };
    expect(
      (
        await write(
          "POST",
          `${base}/questions/${questionId}/resolution-preview`,
          engineer,
          input,
        )
      ).status,
    ).toBe(409);
    await json(
      write("POST", `${base}/questions/${questionId}/submit`, expert, {
        questionRevision: 1,
        revision: 3,
      }),
    );
    expect((await view(base)).questions[0].state).toBe("needs-reconfirmation");
    await resolve(base, questionId, input);
    expect((await view(base)).facts.map((f) => f.active).sort()).toEqual([
      false,
      true,
    ]);
  });

  it("follows up in a published child round and records withdrawal and out-of-scope deferral", async () => {
    const { base, questionId, expertId, content } = await setup();
    await resolve(base, questionId, {
      revision: 1,
      kind: "followed-up",
      followUp: { ...content, text: "How long can it be stored?" },
    });
    const followed = await view(base);
    const child = followed.questions.find(
      (q) => q.parentQuestionId === questionId,
    )!;
    expect(child).toMatchObject({ state: "open" });
    expect(followed.resolutions[0]).toMatchObject({
      kind: "followed-up",
      childQuestionId: child.id,
      actorId: followed.personId,
    });
    await json(
      write("PUT", `${base}/questions/${child.id}/answer`, expert, {
        questionRevision: 1,
        revision: 0,
        text: "One day.",
      }),
    );
    await json(
      write("POST", `${base}/questions/${child.id}/submit`, expert, {
        questionRevision: 1,
        revision: 1,
      }),
    );
    expect(
      (
        await write(
          "POST",
          `${base}/questions/${child.id}/resolution-preview`,
          engineer,
          { revision: 1, kind: "deferred", deferredKind: "out-of-scope" },
        )
      ).status,
    ).toBe(400);
    await resolve(base, child.id, {
      revision: 1,
      kind: "deferred",
      deferredKind: "out-of-scope",
      reason: "Storage duration is outside this workflow.",
    });
    expect((await view(base)).resolutions).toContainEqual(
      expect.objectContaining({
        kind: "deferred",
        reason: "Storage duration is outside this workflow.",
      }),
    );
    // A separate question exercises withdrawal without mutating immutable resolutions.
    const { round } = await json<{ round: { id: string } }>(
      write("POST", `${base}/rounds`, engineer, { title: "Duplicate" }),
      201,
    );
    const { question } = await json<{ question: { id: string } }>(
      write("POST", `${base}/rounds/${round.id}/questions`, engineer, {
        ...content,
        assignees: [{ kind: "person", personId: expertId }],
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
    await json(
      write("PUT", `${base}/questions/${question.id}/answer`, expert, {
        questionRevision: 1,
        revision: 0,
        text: "Already answered.",
      }),
    );
    await json(
      write("POST", `${base}/questions/${question.id}/submit`, expert, {
        questionRevision: 1,
        revision: 1,
      }),
    );
    await resolve(base, question.id, {
      revision: 1,
      kind: "withdrawn",
      reason: "Duplicate question.",
    });
    expect((await view(base)).resolutions).toContainEqual(
      expect.objectContaining({
        kind: "withdrawn",
        reason: "Duplicate question.",
      }),
    );
  });

  it("shows Skill-internal deferrals in the Skill backlog without exposing unrelated workflows", async () => {
    const { base, questionId, groupId, workflowId, versionId } = await setup();
    const { skill } = await json<{ skill: { id: string } }>(
      write("POST", "/skills", admin, { groupId, name: "storage" }),
      201,
    );
    const files = [
      {
        path: "SKILL.md",
        content: Buffer.from(
          "---\nname: storage\ndescription: Storage rules\n---\nKeep cold.\n",
        ).toString("base64"),
      },
    ];
    const { preview } = await json<{ preview: { hash: string } }>(
      write("POST", `/skills/${skill.id}/upload-preview`, engineer, { files }),
    );
    await json(
      write("POST", `/skills/${skill.id}/versions`, engineer, {
        files,
        confirmed: true,
        expectedHash: preview.hash,
      }),
      201,
    );
    await json(
      write(
        "POST",
        `/workflows/${workflowId}/versions/${versionId}/pins`,
        engineer,
        { skillId: skill.id, hash: preview.hash, purpose: "source" },
      ),
      201,
    );
    await resolve(base, questionId, {
      revision: 1,
      kind: "deferred",
      deferredKind: "skill-internal",
      skillId: skill.id,
      reason: "The Skill must document its storage rules.",
    });
    const backlog = await json<{
      items: { questionId: string; reason: string }[];
    }>(service.request(`/api/v1/skills/${skill.id}/backlog`, { as: expert }));
    expect(backlog.items).toEqual([
      expect.objectContaining({
        questionId,
        reason: "The Skill must document its storage rules.",
      }),
    ]);
    const coworker: TestPerson = {
      subject: "coworker",
      email: "coworker@example.com",
    };
    const { workflow: unrelated } = await json<{ workflow: { id: string } }>(
      write("POST", "/workflows", admin, {
        groupId,
        name: "unrelated",
        goal: "Another workflow.",
        intent: "new-skill",
        locale: "en",
      }),
      201,
    );
    await json(
      write("POST", "/bindings", admin, {
        scopeType: "workflow",
        scopeId: unrelated.id,
        email: coworker.email,
        role: "Field expert",
      }),
      201,
    );
    const hidden = await json<{ items: unknown[] }>(
      service.request(`/api/v1/skills/${skill.id}/backlog`, { as: coworker }),
    );
    expect(hidden.items).toEqual([]);
    expect(
      (
        await service.request(`/api/v1/skills/${skill.id}/backlog`, {
          as: { subject: "stranger" },
        })
      ).status,
    ).toBe(404);
  });

  it("refuses Agent sign-off, missing confirmation and stale resolution previews", async () => {
    const { base, questionId, expertId } = await setup();
    const input = {
      revision: 1,
      kind: "confirmed",
      facts: [
        {
          text: "Keep plasma cold.",
          answers: [{ personId: expertId, revision: 2 }],
        },
      ],
    };
    const route = `${base}/questions/${questionId}`;
    const { preview } = await json<{ preview: { confirmationHash: string } }>(
      write("POST", `${route}/resolution-preview`, engineer, input),
    );
    expect(
      (
        await write("POST", `${route}/resolve`, expert, {
          ...input,
          confirmed: true,
          confirmationHash: preview.confirmationHash,
          requestId: "wrong-actor",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await write("POST", `${route}/resolve`, engineer, {
          ...input,
          confirmationHash: preview.confirmationHash,
          requestId: "missing-confirm",
        })
      ).status,
    ).toBe(400);
    for (const person of [engineer, expert]) {
      const { secret } = await json<{ secret: string }>(
        write("POST", "/me/tokens", person, {
          name: "Agent",
          scopes: ["engineer", "expert"],
        }),
        201,
      );
      const tokenRequest = (path: string, body: unknown) =>
        service.request(`/api/v1${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
            "x-badger-agent-host": "test-agent",
          },
          body: JSON.stringify(body),
        });
      expect(
        (
          await tokenRequest(`${route}/resolve`, {
            ...input,
            confirmed: true,
            confirmationHash: preview.confirmationHash,
            requestId: "agent-confirm",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await tokenRequest(`${base}/facts/missing/acknowledge`, {
            decision: "acknowledged",
            confirmed: true,
            confirmationHash: preview.confirmationHash,
            requestId: "agent-ack",
          })
        ).status,
      ).toBe(403);
    }
    await json(
      write("PUT", `${route}/answer`, expert, {
        revision: 2,
        questionRevision: 1,
        text: "Correction: use serum.",
      }),
    );
    await json(
      write("POST", `${route}/submit`, expert, {
        revision: 3,
        questionRevision: 1,
      }),
    );
    expect(
      (
        await write("POST", `${route}/resolve`, engineer, {
          ...input,
          confirmed: true,
          confirmationHash: preview.confirmationHash,
          requestId: "stale-preview",
        })
      ).status,
    ).toBe(409);
    expect((await view(base)).facts).toEqual([]);
  });

  it("requires every restated answer to acknowledge each of multiple facts", async () => {
    const { base, questionId, expertId, content } = await setup();
    const { person } = await json<{ person: { id: string } }>(
      service.request("/api/v1/me", { as: other }),
    );
    await json(
      write("PATCH", `${base}/questions/${questionId}`, engineer, {
        ...content,
        revision: 1,
        assignees: [{ kind: "role", role: "Field expert" }],
      }),
    );
    for (const actor of [expert, other]) {
      await json(
        write("PUT", `${base}/questions/${questionId}/answer`, actor, {
          revision: actor === expert ? 2 : 0,
          questionRevision: 2,
          text: "Refrigerate and use within a day.",
        }),
      );
      await json(
        write("POST", `${base}/questions/${questionId}/submit`, actor, {
          revision: actor === expert ? 3 : 1,
          questionRevision: 2,
        }),
      );
    }
    const answers = [
      { personId: expertId, revision: 4 },
      { personId: person.id, revision: 2 },
    ];
    await resolve(base, questionId, {
      revision: 2,
      kind: "confirmed",
      facts: [
        { text: "Refrigerate plasma.", answers },
        { text: "Use it within one day.", answers },
      ],
    });
    for (const fact of (await view(base)).facts) {
      for (const actor of [expert, other]) {
        const route = `${base}/facts/${fact.id}`;
        const { preview } = await json<{
          preview: { confirmationHash: string };
        }>(
          write("POST", `${route}/acknowledgement-preview`, actor, {
            decision: "acknowledged",
          }),
        );
        await json(
          write("POST", `${route}/acknowledge`, actor, {
            decision: "acknowledged",
            confirmed: true,
            confirmationHash: preview.confirmationHash,
            requestId: crypto.randomUUID(),
          }),
        );
      }
    }
    expect(
      (await view(base)).facts.every((f) => f.acknowledgements.length === 2),
    ).toBe(true);
    const inbox = await json<{ pendingCount: number }>(
      service.request("/api/v1/me/inbox", { as: expert }),
    );
    expect(inbox.pendingCount).toBe(0);
  });

  it("reopens confirmed questions when their evidence changes, preserving unchanged cited files", async () => {
    const {
      base,
      questionId,
      expertId,
      content,
      groupId,
      workflowId,
      versionId,
    } = await setup();
    const { skill } = await json<{ skill: { id: string } }>(
      write("POST", "/skills", admin, { groupId, name: "evidence" }),
      201,
    );
    const upload = async (guide: string, skillText = "Keep cold.") => {
      const files = [
        {
          path: "SKILL.md",
          content: Buffer.from(
            `---\nname: evidence\ndescription: Evidence\n---\n${skillText}\n`,
          ).toString("base64"),
        },
        {
          path: "reference/guide.md",
          content: Buffer.from(guide).toString("base64"),
        },
      ];
      const { preview } = await json<{ preview: { hash: string } }>(
        write("POST", `/skills/${skill.id}/upload-preview`, engineer, {
          files,
        }),
      );
      await json(
        write("POST", `/skills/${skill.id}/versions`, engineer, {
          files,
          confirmed: true,
          expectedHash: preview.hash,
        }),
        201,
      );
      return preview.hash;
    };
    const pinsPath = `/workflows/${workflowId}/versions/${versionId}/pins`;
    const hash = await upload("Store at 2–8°C.\n");
    await json(
      write("POST", pinsPath, engineer, {
        skillId: skill.id,
        hash,
        purpose: "source",
      }),
      201,
    );
    const evidence = [
      {
        skillId: skill.id,
        versionHash: hash,
        path: "reference/guide.md",
        startLine: 1,
        endLine: 1,
      },
    ];
    await json(
      write("PATCH", `${base}/questions/${questionId}`, engineer, {
        ...content,
        evidence,
        revision: 1,
      }),
    );
    await json(
      write("PUT", `${base}/questions/${questionId}/answer`, expert, {
        questionRevision: 2,
        revision: 2,
        text: "Use 2–8°C.",
      }),
    );
    await json(
      write("POST", `${base}/questions/${questionId}/submit`, expert, {
        questionRevision: 2,
        revision: 3,
      }),
    );
    const input = {
      revision: 2,
      kind: "confirmed",
      facts: [
        {
          text: "Store at 2–8°C.",
          answers: [{ personId: expertId, revision: 4 }],
        },
      ],
    };
    await resolve(base, questionId, input);
    expect((await view(base)).facts[0].evidence[0].fileHash).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    const unchangedEvidence = await upload(
      "Store at 2–8°C.\n",
      "Use storage guide.",
    );
    await json(
      write("POST", pinsPath, engineer, {
        skillId: skill.id,
        hash: unchangedEvidence,
        purpose: "source",
        revision: 1,
      }),
    );
    expect((await view(base)).questions[0].state).toBe("confirmed");
    const changedEvidence = await upload("Freeze immediately.\n");
    await json(
      write("POST", pinsPath, engineer, {
        skillId: skill.id,
        hash: changedEvidence,
        purpose: "source",
        revision: 2,
      }),
    );
    expect((await view(base)).questions[0].state).toBe("needs-reconfirmation");
    expect((await view(base)).facts[0].active).toBe(false);
    expect(
      (
        await write(
          "POST",
          `${base}/questions/${questionId}/resolution-preview`,
          engineer,
          input,
        )
      ).status,
    ).toBe(409);
    await json(
      write("PATCH", `${base}/questions/${questionId}`, engineer, {
        ...content,
        evidence: [{ ...evidence[0], versionHash: changedEvidence }],
        revision: 2,
      }),
    );
    expect((await view(base)).questions[0]).toMatchObject({
      state: "needs-reconfirmation",
      revision: 3,
    });
  });
  it("keeps retries bound to the workflow version that was reviewed", async () => {
    const { base, questionId, expertId, workflowId } = await setup();
    const input = {
      revision: 1,
      kind: "confirmed",
      facts: [
        {
          text: "Keep plasma cold.",
          answers: [{ personId: expertId, revision: 2 }],
        },
      ],
    };
    const { preview } = await json<{ preview: { confirmationHash: string } }>(
      write(
        "POST",
        `${base}/questions/${questionId}/resolution-preview`,
        engineer,
        input,
      ),
    );
    const commit = {
      ...input,
      confirmed: true,
      confirmationHash: preview.confirmationHash,
      requestId: "version-bound-resolution",
    };
    await json(
      write(
        "POST",
        `${base}/questions/${questionId}/resolve`,
        engineer,
        commit,
      ),
    );
    const fact = (await view(base)).facts[0];
    const { preview: ackPreview } = await json<{
      preview: { confirmationHash: string };
    }>(
      write(
        "POST",
        `${base}/facts/${fact.id}/acknowledgement-preview`,
        expert,
        { decision: "acknowledged" },
      ),
    );
    const ack = {
      decision: "acknowledged",
      confirmed: true,
      confirmationHash: ackPreview.confirmationHash,
      requestId: "version-bound-ack",
    };
    await json(
      write("POST", `${base}/facts/${fact.id}/acknowledge`, expert, ack),
    );
    const { workflow } = await json<{ workflow: { revision: number } }>(
      service.request(`/api/v1/workflows/${workflowId}`, { as: engineer }),
    );
    const { version } = await json<{ version: { id: string } }>(
      write("POST", `/workflows/${workflowId}/versions`, engineer, {
        revision: workflow.revision,
      }),
      201,
    );
    const wrong = `/workflows/${workflowId}/versions/${version.id}/questionnaire`;
    expect(
      (
        await write(
          "POST",
          `${wrong}/questions/${questionId}/resolve`,
          engineer,
          commit,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await write(
          "POST",
          `${wrong}/facts/${fact.id}/acknowledge`,
          expert,
          ack,
        )
      ).status,
    ).toBe(409);
  });
  it("revokes sign-off when an answering expert loses their expert role", async () => {
    const { base, questionId, expertId, workflowId } = await setup();
    await resolve(base, questionId, {
      revision: 1,
      kind: "confirmed",
      facts: [
        {
          text: "Keep plasma cold.",
          answers: [{ personId: expertId, revision: 2 }],
        },
      ],
    });
    const fact = (await view(base)).facts[0];
    await json(
      write("POST", "/bindings", admin, {
        scopeType: "workflow",
        scopeId: workflowId,
        email: expert.email,
        role: "Observer",
      }),
      201,
    );
    const { bindings } = await json<{
      bindings: {
        id: string;
        personId: string;
        role: string;
        revision: number;
      }[];
    }>(service.request(`/api/v1/workflows/${workflowId}`, { as: admin }));
    const binding = bindings.find(
      (b) => b.personId === expertId && b.role === "Field expert",
    )!;
    await json(
      write("DELETE", `/bindings/${binding.id}`, admin, {
        revision: binding.revision,
      }),
    );
    expect(
      (
        await write(
          "POST",
          `${base}/facts/${fact.id}/acknowledgement-preview`,
          expert,
          { decision: "acknowledged" },
        )
      ).status,
    ).toBe(403);
  });
  it("returns the original sign-off responses after either actor changes their display name", async () => {
    const { base, questionId, expertId } = await setup();
    const input = {
      revision: 1,
      kind: "confirmed",
      facts: [
        {
          text: "Keep plasma cold.",
          answers: [{ personId: expertId, revision: 2 }],
        },
      ],
    };
    const { preview } = await json<{ preview: { confirmationHash: string } }>(
      write(
        "POST",
        `${base}/questions/${questionId}/resolution-preview`,
        engineer,
        input,
      ),
    );
    const commit = {
      ...input,
      confirmed: true,
      confirmationHash: preview.confirmationHash,
      requestId: "rename-engineer",
    };
    const original = await json(
      write(
        "POST",
        `${base}/questions/${questionId}/resolve`,
        engineer,
        commit,
      ),
    );
    const renamed = { ...engineer, displayName: "A new Engineer name" };
    expect(
      await json(
        write(
          "POST",
          `${base}/questions/${questionId}/resolve`,
          renamed,
          commit,
        ),
      ),
    ).toEqual(original);
    const fact = (await view(base)).facts[0];
    const { preview: ackPreview } = await json<{
      preview: { confirmationHash: string };
    }>(
      write(
        "POST",
        `${base}/facts/${fact.id}/acknowledgement-preview`,
        expert,
        { decision: "acknowledged" },
      ),
    );
    const ack = {
      decision: "acknowledged",
      confirmed: true,
      confirmationHash: ackPreview.confirmationHash,
      requestId: "rename-expert",
    };
    const originalAck = await json(
      write("POST", `${base}/facts/${fact.id}/acknowledge`, expert, ack),
    );
    expect(
      await json(
        write(
          "POST",
          `${base}/facts/${fact.id}/acknowledge`,
          { ...expert, displayName: "A new expert name" },
          ack,
        ),
      ),
    ).toEqual(originalAck);
  });

  it("resolves current assignees' answers while retaining former assignees' history", async () => {
    const { base, questionId, content } = await setup();
    const { person } = await json<{ person: { id: string } }>(
      service.request("/api/v1/me", { as: other }),
    );
    await json(
      write("PATCH", `${base}/questions/${questionId}`, engineer, {
        ...content,
        revision: 1,
        assignees: [{ kind: "person", personId: person.id }],
      }),
    );
    await json(
      write("PUT", `${base}/questions/${questionId}/answer`, other, {
        revision: 0,
        questionRevision: 2,
        text: "Freeze it.",
      }),
    );
    await json(
      write("POST", `${base}/questions/${questionId}/submit`, other, {
        revision: 1,
        questionRevision: 2,
      }),
    );
    await resolve(base, questionId, {
      revision: 2,
      kind: "confirmed",
      facts: [
        {
          text: "Freeze plasma.",
          answers: [{ personId: person.id, revision: 2 }],
        },
      ],
    });
    expect((await view(base)).facts[0].answers).toEqual([
      { personId: person.id, revision: 2 },
    ]);
    const history = await json<{
      answers: { personId: string; eligibleForResolution: boolean }[];
    }>(service.request(`/api/v1${base}`, { as: engineer }));
    expect(history.answers).toHaveLength(2);
    expect(
      history.answers
        .filter((a) => a.eligibleForResolution)
        .map((a) => a.personId),
    ).toEqual([person.id]);
  });
  it("waits for newly added assignees before re-confirming a revised question", async () => {
    const { base, questionId, content, expertId } = await setup();
    await json(service.request("/api/v1/me", { as: other }));
    await resolve(base, questionId, {
      revision: 1,
      kind: "confirmed",
      facts: [
        {
          text: "Keep plasma cold.",
          answers: [{ personId: expertId, revision: 2 }],
        },
      ],
    });
    await json(
      write("PATCH", `${base}/questions/${questionId}`, engineer, {
        ...content,
        revision: 1,
        assignees: [{ kind: "role", role: "Field expert" }],
      }),
    );
    await json(
      write("PUT", `${base}/questions/${questionId}/answer`, expert, {
        revision: 2,
        questionRevision: 2,
        text: "Still keep it cold.",
      }),
    );
    await json(
      write("POST", `${base}/questions/${questionId}/submit`, expert, {
        revision: 3,
        questionRevision: 2,
      }),
    );
    expect((await view(base)).questions[0].state).toBe("needs-reconfirmation");
    expect(
      (
        await write(
          "POST",
          `${base}/questions/${questionId}/resolution-preview`,
          engineer,
          {
            revision: 2,
            kind: "confirmed",
            facts: [
              {
                text: "Keep plasma cold.",
                answers: [{ personId: expertId, revision: 4 }],
              },
            ],
          },
        )
      ).status,
    ).toBe(409);
  });
});
