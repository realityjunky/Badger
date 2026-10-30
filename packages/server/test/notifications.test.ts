import { afterEach, describe, expect, it } from "vitest";
import {
  startTestService,
  startStubWeComRobot,
  startStubHttpsProxy,
  type StubWeComRobot,
  type TestPerson,
  type TestService,
} from "../src/testing/index.js";

const admin: TestPerson = { subject: "admin", email: "admin@example.com" };
const owner: TestPerson = { subject: "owner", email: "owner@example.com" };
const expert: TestPerson = {
  subject: "expert",
  email: "expert@example.com",
  displayName: "Dr Lin",
};
const engineer: TestPerson = {
  subject: "engineer",
  email: "engineer@example.com",
};
const webhookUrl =
  "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-secret";
let service: TestService;
let robot: StubWeComRobot;
afterEach(async () => {
  await service?.close();
  await robot?.close();
});

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  as = admin,
  status = 200,
): Promise<T> {
  const response = await service.request(`/api/v1${path}`, {
    as,
    method,
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  expect(
    response.status,
    JSON.stringify({
      result,
      logs: response.status === 500 ? service.logs : [],
    }),
  ).toBe(status);
  return result as T;
}

async function setup(
  options: { realChannel?: boolean; environment?: Record<string, string> } = {},
) {
  robot = await startStubWeComRobot();
  service = await startTestService({
    notificationChannel: options.realChannel ? undefined : robot.channel,
    environment: {
      BADGER_BOOTSTRAP_ADMINISTRATORS: admin.email,
      BADGER_ALLOWED_ORIGINS: "http://localhost",
      BADGER_NOTIFICATION_KEY: "ab".repeat(32),
      BADGER_PUBLIC_URL: "https://badger.example.com",
      ...options.environment,
    },
  });
  const { group } = await call<{ group: { id: string } }>(
    "POST",
    "/groups",
    { name: "Research" },
    admin,
    201,
  );
  const { workflow, version } = await call<{
    workflow: { id: string };
    version: { id: string };
  }>(
    "POST",
    "/workflows",
    {
      groupId: group.id,
      name: "sample-workflow",
      goal: "Understand sample handling.",
      intent: "new-skill",
      locale: "en",
    },
    admin,
    201,
  );
  for (const [person, role] of [
    [owner, "Workflow owner"],
    [engineer, "Engineer"],
    [expert, "Field expert"],
  ] as const) {
    await call(
      "POST",
      "/bindings",
      {
        scopeType: "workflow",
        scopeId: workflow.id,
        email: person.email,
        role,
      },
      admin,
      201,
    );
    await call("GET", "/me", undefined, person);
  }
  return { workflowId: workflow.id, versionId: version.id, groupId: group.id };
}

async function publishRound(workflowId: string, versionId: string) {
  const base = `/workflows/${workflowId}/versions/${versionId}/questionnaire`;
  const { round } = await call<{ round: { id: string } }>(
    "POST",
    `${base}/rounds`,
    { title: "Private study" },
    engineer,
    201,
  );
  const questions = [];
  for (const text of ["PRIVATE QUESTION A", "PRIVATE QUESTION B"]) {
    const { question } = await call<{
      question: { id: string; revision: number };
    }>(
      "POST",
      `${base}/rounds/${round.id}/questions`,
      {
        text,
        topic: "scope",
        targets: [{ kind: "workflow", id: workflowId }],
        rationale: "PRIVATE RATIONALE",
        evidence: [],
        assignees: [{ kind: "role", role: "Field expert" }],
        priority: 10,
      },
      engineer,
      201,
    );
    questions.push(question);
  }
  const { preview } = await call<{ preview: { confirmationHash: string } }>(
    "GET",
    `${base}/rounds/${round.id}/publish-preview`,
    undefined,
    engineer,
  );
  await call(
    "POST",
    `${base}/rounds/${round.id}/publish`,
    { confirmed: true, confirmationHash: preview.confirmationHash },
    engineer,
  );
  return { base, questions };
}

describe("WeCom notification channels", () => {
  it("drops a removed expert from queued mentions and reminder recipients", async () => {
    const { workflowId, versionId } = await setup();
    const { binding } = await call<{
      binding: { id: string; revision: number };
    }>(
      "POST",
      "/bindings",
      {
        scopeType: "workflow",
        scopeId: workflowId,
        email: expert.email,
        role: "Observer",
      },
      admin,
      201,
    );
    await call(
      "PUT",
      `/workflows/${workflowId}/notifications/channel`,
      {
        revision: 0,
        label: "Research",
        webhookUrl,
        language: "en",
        confirmed: true,
      },
      owner,
    );
    await service.runNotificationJobs();
    await publishRound(workflowId, versionId);
    expect(await service.runNotificationJobs()).toBe(0);
    const detail = await call<{
      bindings: { id: string; revision: number; role: string; email: string }[];
    }>("GET", `/workflows/${workflowId}`);
    const expertBinding = detail.bindings.find(
      (entry) => entry.role === "Field expert" && entry.email === expert.email,
    )!;
    await call("DELETE", `/bindings/${expertBinding.id}`, {
      revision: expertBinding.revision,
    });
    await call("DELETE", `/bindings/${binding.id}`, {
      revision: binding.revision,
    });
    const { items } = await call<{ items: unknown[] }>(
      "GET",
      `/workflows/${workflowId}/notifications/waiting`,
      undefined,
      owner,
    );
    expect(items).toEqual([]);
    service.clock.advance(3100);
    expect(await service.runNotificationJobs()).toBe(0);
    expect(robot.requests).toHaveLength(1);
    const { deliveries } = await call<{ deliveries: { status: string }[] }>(
      "GET",
      `/workflows/${workflowId}/notifications/deliveries`,
      undefined,
      owner,
    );
    expect(deliveries.some((entry) => entry.status === "cancelled")).toBe(true);
  });
  it("notifies Engineers for an Agent-submitted answer and preserves a dual-role person's pending resolution", async () => {
    const { workflowId, versionId } = await setup();
    await call(
      "POST",
      "/bindings",
      {
        scopeType: "workflow",
        scopeId: workflowId,
        email: expert.email,
        role: "Engineer",
      },
      admin,
      201,
    );
    const { questions, base } = await publishRound(workflowId, versionId);
    const { secret } = await call<{ secret: string }>(
      "POST",
      "/me/tokens",
      { name: "Expert Agent", scopes: ["expert"] },
      expert,
      201,
    );
    const q = questions[0]!;
    const agent = async (method: string, path: string, body: unknown) => {
      const response = await service.request(`/api/v1${path}`, {
        method,
        headers: {
          authorization: `Bearer ${secret}`,
          "x-badger-agent-host": "test-host",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    const { answer } = (await agent("PUT", `${base}/questions/${q.id}/answer`, {
      revision: 0,
      questionRevision: q.revision,
      text: "PRIVATE AGENT ANSWER",
    })) as { answer: { revision: number } };
    await agent("POST", `${base}/questions/${q.id}/submit`, {
      revision: answer.revision,
      questionRevision: q.revision,
    });
    const mine = await call<{
      items: { kind: string; state: string; questionId: string }[];
    }>("GET", "/me/inbox", undefined, expert);
    expect(
      mine.items.find(
        (item) => item.kind === "answer-submitted" && item.questionId === q.id,
      )?.state,
    ).toBe("unread");
    const denied = await service.request(
      `/api/v1/workflows/${workflowId}/notifications/remind`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          itemId: mine.items[0]!.questionId,
          confirmed: true,
        }),
      },
    );
    expect(denied.status).toBe(403);
  });
  it("uses the deployment HTTPS proxy without exposing its URL in logs or deliveries", async () => {
    const proxy = await startStubHttpsProxy();
    try {
      const { workflowId } = await setup({
        realChannel: true,
        environment: { HTTPS_PROXY: proxy.url, NO_PROXY: "", HTTP_PROXY: "" },
      });
      await call(
        "PUT",
        `/workflows/${workflowId}/notifications/channel`,
        {
          revision: 0,
          label: "Research",
          webhookUrl,
          language: "en",
          confirmed: true,
        },
        owner,
      );
      expect(await service.runNotificationJobs()).toBe(1);
      expect(proxy.targets).toEqual(["qyapi.weixin.qq.com:443"]);
      const { deliveries } = await call<{
        deliveries: { status: string; error: string }[];
      }>(
        "GET",
        `/workflows/${workflowId}/notifications/deliveries`,
        undefined,
        owner,
      );
      expect(deliveries).toMatchObject([
        { status: "retry", error: "WeCom connection or response failed" },
      ]);
      expect(JSON.stringify({ deliveries, logs: service.logs })).not.toContain(
        "test-secret",
      );
      expect(JSON.stringify({ deliveries, logs: service.logs })).not.toContain(
        proxy.url,
      );
    } finally {
      await proxy.close();
    }
  });
  it("paces the same robot across workers and workflows and records terminal API failures", async () => {
    const { workflowId, groupId } = await setup();
    await call("PUT", `/groups/${groupId}/notifications/channel`, {
      revision: 0,
      label: "Department",
      webhookUrl,
      language: "zh",
      confirmed: true,
    });
    await call(
      "PUT",
      `/workflows/${workflowId}/notifications/channel`,
      {
        revision: 0,
        label: "Workflow",
        webhookUrl: webhookUrl.replace("test-secret", "%74est-secret"),
        language: "en",
        confirmed: true,
      },
      owner,
    );
    const concurrent = await Promise.all([
      service.runNotificationJobs(),
      service.runNotificationJobs(),
    ]);
    expect(concurrent.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(robot.requests).toHaveLength(1);
    service.clock.advance(3099);
    expect(await service.runNotificationJobs()).toBe(0);
    service.clock.advance(1);
    robot.setFailure(200, 93000);
    expect(await service.runNotificationJobs()).toBe(1);
    for (const wait of [3100, 6200, 12400, 24800]) {
      service.clock.advance(wait);
      expect(await service.runNotificationJobs()).toBe(1);
    }
    const { deliveries } = await call<{
      deliveries: { status: string; attempts: number; error: string }[];
    }>(
      "GET",
      `/workflows/${workflowId}/notifications/deliveries`,
      undefined,
      owner,
    );
    expect(deliveries).toMatchObject([
      { status: "failed", attempts: 5, error: "WeCom error 93000" },
    ]);
    service.clock.advance(3_600_000);
    expect(await service.runNotificationJobs()).toBe(0);
    expect(JSON.stringify(service.logs)).not.toContain("remote response");
  });
  it("uses a Group default, lets the workflow override it, and preserves in-app items for mention opt-outs", async () => {
    const { workflowId, versionId, groupId } = await setup();
    const lead = { subject: "lead", email: "lead@example.com" };
    await call(
      "POST",
      "/bindings",
      {
        scopeType: "group",
        scopeId: groupId,
        email: lead.email,
        role: "Group lead",
      },
      admin,
      201,
    );
    await call("GET", "/me", undefined, lead);
    await call(
      "PUT",
      `/groups/${groupId}/notifications/channel`,
      {
        revision: 0,
        label: "Department",
        webhookUrl,
        language: "zh",
        confirmed: true,
      },
      lead,
    );
    const inherited = await call<{ inheritedChannel: { label: string } }>(
      "GET",
      `/workflows/${workflowId}/notifications/channel`,
      undefined,
      owner,
    );
    expect(inherited.inheritedChannel.label).toBe("Department");
    await call(
      "PUT",
      "/me/notifications",
      { revision: 0, wecomUserId: "lin", mobile: null, mentionEvents: [] },
      expert,
    );
    await service.runNotificationJobs();
    await publishRound(workflowId, versionId);
    service.clock.advance(3100);
    expect(await service.runNotificationJobs()).toBe(0);
    const inbox = await call<{ items: unknown[] }>(
      "GET",
      "/me/inbox",
      undefined,
      expert,
    );
    expect(inbox.items).toHaveLength(2);
    const ownRoute = `/workflows/${workflowId}/notifications/channel`;
    await call(
      "PUT",
      ownRoute,
      {
        revision: 0,
        label: "Workflow chat",
        webhookUrl: webhookUrl.replace("test-secret", "other-secret"),
        language: "en",
        confirmed: true,
      },
      owner,
    );
    expect(await service.runNotificationJobs()).toBe(1);
    expect(robot.requests.at(-1)!.key).toBe("other-secret");
    await call("DELETE", ownRoute, { revision: 1, confirmed: true }, owner);
    const restored = await call<{
      channel: null;
      inheritedChannel: { label: string };
    }>("GET", ownRoute, undefined, owner);
    expect(restored.channel).toBeNull();
    expect(restored.inheritedChannel.label).toBe("Department");
  });
  it("audits reminders from the requester, owner or administrator and offers copy text without a robot", async () => {
    const { workflowId, versionId } = await setup();
    const { questions, base } = await publishRound(workflowId, versionId);
    const route = `/workflows/${workflowId}/notifications/waiting`;
    const { items } = await call<{
      items: {
        id: string;
        questionId: string;
        canRemind: boolean;
        href: string;
      }[];
    }>("GET", route, undefined, engineer);
    const item = items.find((entry) => entry.questionId === questions[0]!.id)!;
    expect(item.canRemind).toBe(true);
    const reminderRoute = `/workflows/${workflowId}/notifications/remind`;
    await call(
      "POST",
      reminderRoute,
      { itemId: item.id, confirmed: true },
      expert,
      403,
    );
    const reminder = await call<{
      reminder: { id: string; recipients: { name: string }[] };
      copyText: string;
      deliveryId: string | null;
    }>("POST", reminderRoute, { itemId: item.id, confirmed: true }, engineer);
    expect(reminder.deliveryId).toBeNull();
    expect(reminder.copyText).toContain("Dr Lin");
    expect(reminder.copyText).toContain(item.href);
    expect(reminder.copyText).not.toContain("PRIVATE");
    expect(await service.runNotificationJobs()).toBe(0);
    await call(
      "POST",
      reminderRoute,
      { itemId: item.id, confirmed: true },
      owner,
      409,
    );
    service.clock.advance(3_600_000);
    await call(
      "PUT",
      `/workflows/${workflowId}/notifications/channel`,
      {
        revision: 0,
        label: "Research chat",
        webhookUrl,
        language: "en",
        confirmed: true,
      },
      owner,
    );
    const posted = await call<{ deliveryId: string }>(
      "POST",
      reminderRoute,
      { itemId: item.id, confirmed: true },
      owner,
    );
    expect(posted.deliveryId).toEqual(expect.any(String));
    expect(await service.runNotificationJobs()).toBe(1);
    service.clock.advance(3100);
    expect(await service.runNotificationJobs()).toBe(1);
    expect(robot.requests.at(-1)!.message.text.content).toContain("Reminder");
    const { events } = await call<{
      events: { action: string; targetId: string; reason: string | null }[];
    }>("GET", "/audit-events?action=reminder.created");
    expect(
      events.some(
        (event) =>
          event.action === "reminder.created" &&
          event.targetId === reminder.reminder.id &&
          event.reason?.includes("Dr Lin"),
      ),
    ).toBe(true);
    const q = questions[0]!;
    const { answer } = await call<{ answer: { revision: number } }>(
      "PUT",
      `${base}/questions/${q.id}/answer`,
      { revision: 0, questionRevision: q.revision, text: "PRIVATE ANSWER" },
      expert,
    );
    await call(
      "POST",
      `${base}/questions/${q.id}/submit`,
      { revision: answer.revision, questionRevision: q.revision },
      expert,
    );
    service.clock.advance(3_600_000);
    await call(
      "POST",
      reminderRoute,
      { itemId: item.id, confirmed: true },
      admin,
      409,
    );
  });
  it("keeps failed delivery out of the questionnaire transaction and retries with backoff", async () => {
    const { workflowId, versionId } = await setup();
    await call(
      "PUT",
      `/workflows/${workflowId}/notifications/channel`,
      {
        revision: 0,
        label: "Research chat",
        webhookUrl,
        language: "en",
        confirmed: true,
      },
      owner,
    );
    robot.setFailure(429, 0, 10);
    expect(await service.runNotificationJobs()).toBe(1);
    const { questions, base } = await publishRound(workflowId, versionId);
    const inbox = await call<{ items: { kind: string; state: string }[] }>(
      "GET",
      "/me/inbox",
      undefined,
      expert,
    );
    expect(
      inbox.items.filter((item) => item.kind === "question-assigned"),
    ).toHaveLength(2);
    service.clock.advance(3100);
    expect(await service.runNotificationJobs()).toBe(0);
    expect(robot.requests).toHaveLength(1);
    const firstQuestion = questions[0]!;
    const { answer } = await call<{ answer: { revision: number } }>(
      "PUT",
      `${base}/questions/${firstQuestion.id}/answer`,
      {
        revision: 0,
        questionRevision: firstQuestion.revision,
        text: "PRIVATE ANSWER",
      },
      expert,
    );
    await call(
      "POST",
      `${base}/questions/${firstQuestion.id}/submit`,
      { revision: answer.revision, questionRevision: firstQuestion.revision },
      expert,
    );
    const engineerInbox = await call<{
      items: { kind: string; questionId: string }[];
    }>("GET", "/me/inbox", undefined, engineer);
    expect(
      engineerInbox.items.some(
        (item) =>
          item.kind === "answer-submitted" &&
          item.questionId === firstQuestion.id,
      ),
    ).toBe(true);
    service.clock.advance(3099);
    expect(await service.runNotificationJobs()).toBe(0);
    service.clock.advance(3801);
    robot.setFailure(null);
    expect(await service.runNotificationJobs()).toBe(1);
    const { deliveries } = await call<{
      deliveries: { status: string; attempts: number; error: string | null }[];
    }>(
      "GET",
      `/workflows/${workflowId}/notifications/deliveries`,
      undefined,
      owner,
    );
    expect(
      deliveries.some(
        (delivery) => delivery.status === "sent" && delivery.attempts === 2,
      ),
    ).toBe(true);
    expect(JSON.stringify(deliveries)).not.toContain("PRIVATE");
    expect(JSON.stringify(service.logs)).not.toContain("test-secret");
  });
  it("posts once for a published round with userid, mobile and plain-name recipients, counts, and no record content", async () => {
    const { workflowId, versionId } = await setup();
    const mobileExpert = {
      subject: "mobile",
      email: "mobile@example.com",
      displayName: "Dr Wu",
    };
    const plainExpert = {
      subject: "plain",
      email: "plain@example.com",
      displayName: "Dr Chen",
    };
    for (const person of [mobileExpert, plainExpert]) {
      await call(
        "POST",
        "/bindings",
        {
          scopeType: "workflow",
          scopeId: workflowId,
          email: person.email,
          role: "Field expert",
        },
        admin,
        201,
      );
      await call("GET", "/me", undefined, person);
    }
    await call(
      "PUT",
      "/me/notifications",
      {
        revision: 0,
        wecomUserId: "lin",
        mobile: null,
        mentionEvents: ["question-assigned"],
      },
      expert,
    );
    await call(
      "PUT",
      "/me/notifications",
      {
        revision: 0,
        wecomUserId: null,
        mobile: "13800000000",
        mentionEvents: ["question-assigned"],
      },
      mobileExpert,
    );
    await call(
      "PUT",
      `/workflows/${workflowId}/notifications/channel`,
      {
        revision: 0,
        label: "Research chat",
        webhookUrl,
        language: "en",
        confirmed: true,
      },
      owner,
    );
    expect(await service.runNotificationJobs()).toBe(1);
    await publishRound(workflowId, versionId);
    expect(await service.runNotificationJobs()).toBe(0);
    service.clock.advance(3100);
    expect(await service.runNotificationJobs()).toBe(1);
    expect(robot.requests).toHaveLength(2);
    const post = robot.requests[1]!.message;
    expect(post.text.mentioned_list).toEqual(["lin"]);
    expect(post.text.mentioned_mobile_list).toEqual(["13800000000"]);
    expect(post.text.content).toContain("Dr Lin: 2");
    expect(post.text.content).toContain("Dr Wu: 2");
    expect(post.text.content).toContain("Dr Chen: 2");
    expect(post.text.content).toContain("sample-workflow");
    expect(post.text.content).toContain("https://badger.example.com/");
    expect(JSON.stringify(post)).not.toContain("PRIVATE");
    expect(Buffer.byteLength(post.text.content)).toBeLessThanOrEqual(2048);
    const { deliveries } = await call<{
      deliveries: { status: string; attempts: number; recipients: unknown[] }[];
    }>(
      "GET",
      `/workflows/${workflowId}/notifications/deliveries`,
      undefined,
      owner,
    );
    expect(deliveries).toHaveLength(2);
    expect(
      deliveries.every(
        (delivery) => delivery.status === "sent" && delivery.attempts === 1,
      ),
    ).toBe(true);
    await call(
      "GET",
      `/workflows/${workflowId}/notifications/deliveries`,
      undefined,
      engineer,
      403,
    );
    expect(JSON.stringify(deliveries)).not.toContain("test-secret");
  });
  it("saves each person's mention identity and event choices with conflict protection", async () => {
    await setup();
    const initial = await call<{
      preferences: { revision: number; mentionEvents: string[] };
    }>("GET", "/me/notifications", undefined, expert);
    expect(initial.preferences.revision).toBe(0);
    expect(initial.preferences.mentionEvents).toContain("question-assigned");
    const saved = await call<{
      preferences: {
        revision: number;
        wecomUserId: string | null;
        mobile: string | null;
        mentionEvents: string[];
      };
    }>(
      "PUT",
      "/me/notifications",
      {
        revision: 0,
        wecomUserId: "lin",
        mobile: "+8613800000000",
        mentionEvents: ["question-assigned"],
      },
      expert,
    );
    expect(saved.preferences).toMatchObject({
      revision: 1,
      wecomUserId: "lin",
      mobile: "+8613800000000",
      mentionEvents: ["question-assigned"],
    });
    await call(
      "PUT",
      "/me/notifications",
      { revision: 0, wecomUserId: "wrong", mobile: null, mentionEvents: [] },
      expert,
      409,
    );
    await call(
      "PUT",
      "/me/notifications",
      { revision: 1, wecomUserId: "@all", mobile: null, mentionEvents: [] },
      expert,
      400,
    );
    await call(
      "PUT",
      "/me/notifications",
      {
        revision: 1,
        wecomUserId: null,
        mobile: null,
        mentionEvents: ["bogus"],
      },
      expert,
      400,
    );
    const other = await call<{ preferences: { wecomUserId: string | null } }>(
      "GET",
      "/me/notifications",
      undefined,
      owner,
    );
    expect(other.preferences.wecomUserId).toBeNull();
  });
  it("lets the owner save a masked robot and queues a test delivery without exposing its secret", async () => {
    const { workflowId } = await setup();
    const route = `/workflows/${workflowId}/notifications/channel`;
    const saved = await call<{
      channel: { label: string; webhookUrl: string; revision: number };
      testDeliveryId: string;
    }>(
      "PUT",
      route,
      {
        revision: 0,
        label: "Research chat",
        webhookUrl,
        language: "zh",
        confirmed: true,
      },
      owner,
    );
    expect(saved.channel).toMatchObject({
      label: "Research chat",
      webhookUrl: "••••••••",
      revision: 1,
    });
    expect(saved.testDeliveryId).toEqual(expect.any(String));
    expect(
      JSON.stringify(await call("GET", route, undefined, owner)),
    ).not.toContain("test-secret");
    await call("GET", route, undefined, expert, 403);
    await call(
      "PUT",
      route,
      {
        revision: 1,
        label: "Other",
        webhookUrl,
        language: "en",
        confirmed: true,
      },
      engineer,
      403,
    );
    await call(
      "PUT",
      route,
      {
        revision: 0,
        label: "Other",
        webhookUrl,
        language: "en",
        confirmed: true,
      },
      owner,
      409,
    );
    expect(JSON.stringify(service.logs)).not.toContain("test-secret");
  });
});
