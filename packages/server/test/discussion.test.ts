import { afterEach, describe, expect, it } from "vitest";
import {
  startTestService,
  type TestPerson,
  type TestService,
} from "../src/testing/index.js";

const admin = { subject: "admin", email: "admin@example.com" };
const engineer = { subject: "engineer", email: "engineer@example.com" };
const expert = { subject: "expert", email: "expert@example.com" };
const observer = { subject: "observer", email: "observer@example.com" };
let service: TestService;
afterEach(async () => service?.close());

async function call<T>(
  method: string,
  path: string,
  as: TestPerson = engineer,
  body?: unknown,
  status = 200,
): Promise<T> {
  const response = await service.request(`/api/v1${path}`, {
    as,
    method,
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(status);
  return value as T;
}

async function bind(workflowId: string, person: TestPerson, role: string) {
  return call<{ binding: { id: string; revision: number } }>(
    "POST",
    "/bindings",
    admin,
    { scopeType: "workflow", scopeId: workflowId, email: person.email, role },
    201,
  );
}
const questionContent = {
  text: "How is the sample stored?",
  topic: "scope",
  targets: [{ kind: "workflow", id: "workflow" }],
  rationale: "Agree the storage conditions.",
  evidence: [],
  assignees: [{ kind: "role", role: "Field expert" }],
  priority: 10,
};
async function setup() {
  service = await startTestService({
    environment: {
      BADGER_BOOTSTRAP_ADMINISTRATORS: admin.email,
      BADGER_ALLOWED_ORIGINS: "http://localhost",
    },
  });
  const { group } = await call<{ group: { id: string } }>(
    "POST",
    "/groups",
    admin,
    { name: "Research" },
    201,
  );
  const { workflow, version } = await call<{
    workflow: { id: string };
    version: { id: string };
  }>(
    "POST",
    "/workflows",
    admin,
    {
      groupId: group.id,
      name: "discussion",
      goal: "Agree sample handling.",
      intent: "new-skill",
      locale: "en",
    },
    201,
  );
  for (const [person, role] of [
    [engineer, "Engineer"],
    [expert, "Field expert"],
    [observer, "Observer"],
  ] as const)
    await bind(workflow.id, person, role);
  const base = `/workflows/${workflow.id}/versions/${version.id}/questionnaire`;
  const { round } = await call<{ round: { id: string } }>(
    "POST",
    `${base}/rounds`,
    engineer,
    { title: "Storage" },
    201,
  );
  const { question } = await call<{ question: { id: string } }>(
    "POST",
    `${base}/rounds/${round.id}/questions`,
    engineer,
    questionContent,
    201,
  );
  const { preview } = await call<{ preview: { confirmationHash: string } }>(
    "GET",
    `${base}/rounds/${round.id}/publish-preview`,
  );
  await call("POST", `${base}/rounds/${round.id}/publish`, engineer, {
    confirmed: true,
    confirmationHash: preview.confirmationHash,
  });
  return {
    base,
    questionId: question.id,
    workflowId: workflow.id,
    versionId: version.id,
    groupId: group.id,
  };
}

interface Comment {
  id: string;
  questionId: string;
  personId: string;
  personName: string;
  text: string;
  revision: number;
  revisions: {
    text: string;
    revision: number;
    actorId: string;
    createdAt: string;
  }[];
}

describe("question threads", () => {
  it("enforces additive workflow roles, author-only edits, and private draft threads", async () => {
    const { base, questionId, workflowId } = await setup();
    const { comment } = await call<{ comment: Comment }>(
      "POST",
      `${base}/questions/${questionId}/comments`,
      expert,
      { text: "From the expert" },
      201,
    );
    for (const role of [
      "Workflow owner",
      "Engineer",
      "Field expert",
      "Operator",
      "Observer",
    ]) {
      const person = {
        subject: role,
        email: `matrix-${role.replaceAll(" ", "")}@example.com`,
      };
      await bind(workflowId, person, role);
      const allowed = role !== "Observer";
      const view = await call<{
        capabilities: {
          comment: boolean;
          raiseConcern: boolean;
          resolveConcern: boolean;
        };
      }>("GET", base, person);
      expect(view.capabilities).toMatchObject({
        comment: allowed,
        raiseConcern: role === "Field expert",
        resolveConcern: role === "Engineer",
      });
      await call(
        "POST",
        `${base}/questions/${questionId}/comments`,
        person,
        { text: `Comment from ${role}` },
        allowed ? 201 : 403,
      );
      await call(
        "PATCH",
        `${base}/comments/${comment.id}`,
        person,
        { revision: 1, text: "Someone else's edit" },
        403,
      );
      await call(
        "POST",
        `${base}/concerns`,
        person,
        { text: `Concern from ${role}` },
        role === "Field expert" ? 201 : 403,
      );
    }
    await bind(workflowId, observer, "Workflow owner");
    await call(
      "POST",
      `${base}/questions/${questionId}/comments`,
      observer,
      { text: "An Observer also holding Workflow owner may comment" },
      201,
    );
    const { round } = await call<{ round: { id: string } }>(
      "POST",
      `${base}/rounds`,
      engineer,
      { title: "Unpublished" },
      201,
    );
    const draft = await call<{ question: { id: string } }>(
      "POST",
      `${base}/rounds/${round.id}/questions`,
      engineer,
      questionContent,
      201,
    );
    await call(
      "POST",
      `${base}/questions/${draft.question.id}/comments`,
      engineer,
      { text: "Private draft discussion" },
      201,
    );
    await call(
      "POST",
      `${base}/questions/${draft.question.id}/comments`,
      expert,
      { text: "Should not be written" },
      404,
    );
    const expertView = await call<{ comments: Comment[] }>("GET", base, expert);
    expect(
      expertView.comments.some((c) => c.text === "Private draft discussion"),
    ).toBe(false);
    const outsider = { subject: "outsider", email: "outsider@example.com" };
    await call(
      "POST",
      `${base}/questions/${questionId}/comments`,
      outsider,
      { text: "Outside the workflow" },
      403,
    );
    await call("GET", base, outsider, undefined, 403);
    await call(
      "POST",
      `${base}/questions/${questionId}/comments`,
      expert,
      { text: " " },
      400,
    );
    await call(
      "POST",
      `${base}/questions/${questionId}/comments`,
      expert,
      { text: "Valid", personId: comment.personId },
      400,
    );
    const auditor = { subject: "auditor", email: "auditor@example.com" };
    await call(
      "POST",
      "/bindings",
      admin,
      {
        scopeType: "organization",
        scopeId: null,
        email: auditor.email,
        role: "Auditor",
      },
      201,
    );
    await call("GET", base, auditor);
    await call(
      "POST",
      `${base}/questions/${questionId}/comments`,
      auditor,
      { text: "Read access alone is insufficient" },
      403,
    );
    await call(
      "POST",
      `${base}/questions/${questionId}/comments`,
      admin,
      { text: "Administrator override" },
      201,
    );
  });

  it("keeps a chronological thread and every edit, without overwriting a concurrent edit", async () => {
    const { base, questionId } = await setup();
    const { comment } = await call<{ comment: Comment }>(
      "POST",
      `${base}/questions/${questionId}/comments`,
      expert,
      { text: "冷藏运输。" },
      201,
    );
    const { comment: reply } = await call<{ comment: Comment }>(
      "POST",
      `${base}/questions/${questionId}/comments`,
      engineer,
      { text: "Is 4°C required?" },
      201,
    );
    await call("PATCH", `${base}/comments/${comment.id}`, expert, {
      revision: 1,
      text: "冷藏运输，4°C。",
    });
    await call(
      "PATCH",
      `${base}/comments/${comment.id}`,
      expert,
      {
        revision: 1,
        text: "An obsolete edit",
      },
      409,
    );
    const view = await call<{ comments: Comment[] }>("GET", base, observer);
    expect(view.comments.map((c) => [c.id, c.text])).toEqual([
      [comment.id, "冷藏运输，4°C。"],
      [reply.id, "Is 4°C required?"],
    ]);
    expect(
      view.comments[0]?.revisions.map((r) => [r.revision, r.text]),
    ).toEqual([
      [1, "冷藏运输。"],
      [2, "冷藏运输，4°C。"],
    ]);
    expect(
      view.comments[0]?.revisions.every((r) => r.actorId === comment.personId),
    ).toBe(true);
  });
});

interface Concern {
  id: string;
  text: string;
  personId: string;
  revision: number;
  state: "open" | "question" | "fact-source" | "declined";
  resolution: null | {
    outcome: string;
    reason: string | null;
    questionId: string | null;
    actorId: string;
    createdAt: string;
  };
}

describe("expert concerns", () => {
  it("keeps comments, concerns, and converted questions inside their workflow version", async () => {
    const { base, questionId, workflowId, groupId } = await setup();
    const { comment } = await call<{ comment: Comment }>(
      "POST",
      `${base}/questions/${questionId}/comments`,
      expert,
      { text: "Version-specific evidence" },
      201,
    );
    const { concern } = await call<{ concern: Concern }>(
      "POST",
      `${base}/concerns`,
      expert,
      { text: "Version-specific concern" },
      201,
    );
    const second = await call<{
      workflow: { id: string };
      version: { id: string };
    }>(
      "POST",
      "/workflows",
      admin,
      {
        groupId,
        name: "other-workflow",
        goal: "A separate workflow.",
        intent: "new-skill",
        locale: "en",
      },
      201,
    );
    const otherBase = `/workflows/${second.workflow.id}/versions/${second.version.id}/questionnaire`;
    await call(
      "POST",
      `${otherBase}/questions/${questionId}/comments`,
      admin,
      { text: "Foreign question" },
      404,
    );
    await call(
      "PATCH",
      `${otherBase}/comments/${comment.id}`,
      admin,
      { text: "Foreign comment", revision: 1 },
      404,
    );
    await call(
      "POST",
      `${otherBase}/concerns/${concern.id}/resolve-preview`,
      admin,
      { outcome: "fact-source", revision: 1 },
      404,
    );
    const { round } = await call<{ round: { id: string } }>(
      "POST",
      `${otherBase}/rounds`,
      admin,
      { title: "Other round" },
      201,
    );
    await call(
      "POST",
      `${base}/concerns/${concern.id}/resolve-preview`,
      engineer,
      {
        outcome: "question",
        revision: 1,
        roundId: round.id,
        question: questionContent,
      },
      404,
    );
    const outsider = { subject: "outsider", email: "outsider@example.com" };
    await call(
      "GET",
      `/questionnaire/concerns/${concern.id}`,
      outsider,
      undefined,
      403,
    );
    await call(
      "GET",
      `/workflows/${workflowId}/versions/${second.version.id}/questionnaire`,
      admin,
      undefined,
      404,
    );
    const view = await call<{ comments: Comment[]; concerns: Concern[] }>(
      "GET",
      otherBase,
      admin,
    );
    expect(view.comments).toEqual([]);
    expect(view.concerns).toEqual([]);
  });

  it("allows Agents to contribute within current roles and scopes, but reserves concern decisions for signed-in people", async () => {
    const { base, questionId, workflowId } = await setup();
    const agent = async (as: TestPerson, scope: string) => {
      const { secret } = await call<{ secret: string }>(
        "POST",
        "/me/tokens",
        as,
        { name: "Discussion Agent", scopes: [scope] },
        201,
      );
      return async (
        method: string,
        path: string,
        body: unknown,
        status: number,
      ) => {
        const response = await service.request(`/api/v1${path}`, {
          method,
          headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
            "x-badger-agent-host": "discussion-agent",
          },
          body: JSON.stringify(body),
        });
        const value = await response.json();
        expect(response.status, JSON.stringify(value)).toBe(status);
        return value;
      };
    };
    const expertAgent = await agent(expert, "expert");
    const engineerAgent = await agent(engineer, "engineer");
    const operatorAgent = await agent(expert, "operator");
    const observerAgent = await agent(observer, "expert");
    const { concern } = (await expertAgent(
      "POST",
      `${base}/concerns`,
      { text: "The expert supplied this concern through an Agent." },
      201,
    )) as { concern: Concern };
    const { comment } = (await expertAgent(
      "POST",
      `${base}/questions/${questionId}/comments`,
      { text: "The expert's comment" },
      201,
    )) as { comment: Comment };
    await expertAgent(
      "PATCH",
      `${base}/comments/${comment.id}`,
      { revision: 1, text: "The expert's corrected comment" },
      200,
    );
    await engineerAgent(
      "POST",
      `${base}/concerns`,
      { text: "Wrong scope" },
      403,
    );
    await operatorAgent(
      "POST",
      `${base}/concerns`,
      { text: "Wrong scope" },
      403,
    );
    await operatorAgent(
      "POST",
      `${base}/questions/${questionId}/comments`,
      { text: "Wrong scope" },
      403,
    );
    await operatorAgent(
      "PATCH",
      `${base}/comments/${comment.id}`,
      { revision: 2, text: "Wrong scope" },
      403,
    );
    await engineerAgent(
      "POST",
      `${base}/questions/${questionId}/comments`,
      { text: "The engineer's comment" },
      201,
    );
    await observerAgent(
      "POST",
      `${base}/concerns`,
      { text: "Wrong role" },
      403,
    );
    await observerAgent(
      "POST",
      `${base}/questions/${questionId}/comments`,
      { text: "Wrong role" },
      403,
    );
    const decision = { revision: 1, outcome: "fact-source" };
    const { preview } = await call<{ preview: { confirmationHash: string } }>(
      "POST",
      `${base}/concerns/${concern.id}/resolve-preview`,
      engineer,
      decision,
    );
    for (const invoke of [expertAgent, engineerAgent]) {
      await invoke(
        "POST",
        `${base}/concerns/${concern.id}/resolve-preview`,
        decision,
        403,
      );
      await invoke(
        "POST",
        `${base}/concerns/${concern.id}/resolve`,
        {
          ...decision,
          confirmed: true,
          confirmationHash: preview.confirmationHash,
        },
        403,
      );
    }
    const temporary = { subject: "temporary", email: "temporary@example.com" };
    await call("GET", "/me", temporary);
    const { binding } = await bind(workflowId, temporary, "Field expert");
    const temporaryAgent = await agent(temporary, "expert");
    await call("DELETE", `/bindings/${binding.id}`, admin, {
      revision: binding.revision,
    });
    await temporaryAgent(
      "POST",
      `${base}/questions/${questionId}/comments`,
      { text: "Revoked role" },
      403,
    );
    await temporaryAgent(
      "POST",
      `${base}/concerns`,
      { text: "Revoked role" },
      403,
    );
  });

  it("binds confirmation to the whole decision and the draft round, with no partial outcome on failure", async () => {
    const { base } = await setup();
    const { concern } = await call<{ concern: Concern }>(
      "POST",
      `${base}/concerns`,
      expert,
      { text: "The freezer may fail." },
      201,
    );
    const path = `${base}/concerns/${concern.id}`;
    await call(
      "POST",
      `${path}/resolve-preview`,
      engineer,
      { revision: 1, outcome: "declined", reason: " " },
      400,
    );
    for (const person of [expert, observer])
      await call(
        "POST",
        `${path}/resolve-preview`,
        person,
        { revision: 1, outcome: "fact-source" },
        403,
      );
    const decision = {
      revision: 1,
      outcome: "declined",
      reason: "Outside this workflow's scope.",
    };
    const { preview } = await call<{ preview: { confirmationHash: string } }>(
      "POST",
      `${path}/resolve-preview`,
      engineer,
      decision,
    );
    await call(
      "POST",
      `${path}/resolve`,
      engineer,
      { ...decision, confirmationHash: preview.confirmationHash },
      400,
    );
    await call(
      "POST",
      `${path}/resolve`,
      engineer,
      {
        ...decision,
        outcome: "fact-source",
        reason: undefined,
        confirmed: true,
        confirmationHash: preview.confirmationHash,
      },
      409,
    );
    await call(
      "POST",
      `${path}/resolve`,
      engineer,
      {
        ...decision,
        reason: "A different reason",
        confirmed: true,
        confirmationHash: preview.confirmationHash,
      },
      409,
    );
    const { round } = await call<{ round: { id: string } }>(
      "POST",
      `${base}/rounds`,
      engineer,
      { title: "Follow-up" },
      201,
    );
    const questionDecision = {
      revision: 1,
      outcome: "question",
      roundId: round.id,
      question: questionContent,
    };
    // The question's own checks run before sign-off, not only at the commit.
    await call(
      "POST",
      `${path}/resolve-preview`,
      engineer,
      {
        ...questionDecision,
        question: {
          ...questionContent,
          evidence: [
            {
              skillId: "unpinned",
              versionHash: "0".repeat(64),
              path: "SKILL.md",
              startLine: 1,
              endLine: 1,
            },
          ],
        },
      },
      400,
    );
    const questionPreview = await call<{
      preview: { confirmationHash: string };
    }>("POST", `${path}/resolve-preview`, engineer, questionDecision);
    await call(
      "POST",
      `${base}/rounds/${round.id}/questions`,
      engineer,
      questionContent,
      201,
    );
    await call(
      "POST",
      `${path}/resolve`,
      engineer,
      {
        ...questionDecision,
        confirmed: true,
        confirmationHash: questionPreview.preview.confirmationHash,
      },
      409,
    );
    const view = await call<{ concerns: Concern[]; questions: unknown[] }>(
      "GET",
      base,
    );
    expect(view.concerns[0]).toMatchObject({ state: "open", resolution: null });
    expect(view.questions).toHaveLength(2);
    // A decision without a question is independent of other round edits.
    await call("POST", `${path}/resolve`, engineer, {
      ...decision,
      confirmed: true,
      confirmationHash: preview.confirmationHash,
    });
    const audit = await call<{
      events: {
        action: string;
        reason: string;
        actor: { personId: string };
        before: { revision: number };
        after: { revision: number };
      }[];
    }>("GET", `/audit-events?targetId=${concern.id}`, admin);
    expect(audit.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "concern.resolved",
          reason: decision.reason,
          before: expect.objectContaining({ revision: 1 }),
          after: expect.objectContaining({ revision: 2 }),
        }),
      ]),
    );
  });

  it("lets the Engineer confirm each of the three outcomes, retaining the source and closing its inbox items", async () => {
    const { base } = await setup();
    const { round } = await call<{ round: { id: string } }>(
      "POST",
      `${base}/rounds`,
      engineer,
      { title: "Follow-up concerns" },
      201,
    );
    const decisions = [
      { outcome: "question", roundId: round.id, question: questionContent },
      { outcome: "fact-source" },
      { outcome: "declined", reason: "Handled by the instrument's own Skill." },
    ];
    for (const decision of decisions) {
      const { concern } = await call<{ concern: Concern }>(
        "POST",
        `${base}/concerns`,
        expert,
        { text: `Unprompted evidence for ${decision.outcome}` },
        201,
      );
      const body = { ...decision, revision: concern.revision };
      const { preview } = await call<{ preview: { confirmationHash: string } }>(
        "POST",
        `${base}/concerns/${concern.id}/resolve-preview`,
        engineer,
        body,
      );
      await call("POST", `${base}/concerns/${concern.id}/resolve`, engineer, {
        ...body,
        confirmed: true,
        confirmationHash: preview.confirmationHash,
      });
      const view = await call<{
        concerns: Concern[];
        questions: { id: string; text: string; state: string }[];
      }>("GET", base);
      const resolved = view.concerns.find((c) => c.id === concern.id)!;
      expect(resolved).toMatchObject({
        text: concern.text,
        revision: 2,
        state: decision.outcome,
        resolution: {
          outcome: decision.outcome,
          reason: decision.reason ?? null,
        },
      });
      if (decision.outcome === "question") {
        expect(
          view.questions.find((q) => q.id === resolved.resolution?.questionId),
        ).toMatchObject({ text: questionContent.text, state: "draft" });
      } else expect(resolved.resolution?.questionId).toBeNull();
      const inbox = await call<{
        items: { concernId: string; state: string }[];
      }>("GET", "/me/inbox");
      expect(
        inbox.items
          .filter((i) => i.concernId === concern.id)
          .map((i) => i.state),
      ).toEqual(["done"]);
      await call(
        "POST",
        `${base}/concerns/${concern.id}/resolve`,
        engineer,
        {
          ...body,
          confirmed: true,
          confirmationHash: preview.confirmationHash,
        },
        409,
      );
    }
  });

  it("keeps an unprompted concern and delivers its own deep link to every Engineer, including invitations", async () => {
    const { base, workflowId, versionId } = await setup();
    const invited = { subject: "invited", email: "invited@example.com" };
    await bind(workflowId, invited, "Engineer");
    const { concern } = await call<{ concern: Concern }>(
      "POST",
      `${base}/concerns`,
      expert,
      { text: "What if the cold chain fails?" },
      201,
    );
    expect(concern).toMatchObject({
      state: "open",
      revision: 1,
      resolution: null,
    });
    const second = await call<{ concern: Concern }>(
      "POST",
      `${base}/concerns`,
      expert,
      { text: "The instrument may be offline." },
      201,
    );
    const view = await call<{ concerns: Concern[] }>("GET", base, observer);
    expect(view.concerns.map((c) => c.text).sort()).toEqual([
      "The instrument may be offline.",
      "What if the cold chain fails?",
    ]);
    for (const recipient of [engineer, invited]) {
      const inbox = await call<{
        items: {
          kind: string;
          concernId: string;
          concernText: string;
          href: string;
        }[];
        pendingCount: number;
        pendingGateCount: number;
      }>("GET", "/me/inbox", recipient);
      expect(inbox.pendingCount).toBe(2);
      expect(inbox.pendingGateCount).toBe(0);
      expect(inbox.items.filter((i) => i.kind === "concern-raised")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            concernId: concern.id,
            concernText: concern.text,
            href: `/questionnaire/concerns/${concern.id}`,
          }),
          expect.objectContaining({ concernId: second.concern.id }),
        ]),
      );
    }
    expect(
      await call("GET", `/questionnaire/concerns/${concern.id}`, expert),
    ).toEqual({ workflowId, versionId });
    const expertInbox = await call<{ items: { kind: string }[] }>(
      "GET",
      "/me/inbox",
      expert,
    );
    expect(expertInbox.items.some((i) => i.kind === "concern-raised")).toBe(
      false,
    );
  });
});
