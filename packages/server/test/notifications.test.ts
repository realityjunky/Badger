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
  options: {
    realChannel?: boolean;
    environment?: Record<string, string | undefined>;
  } = {},
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

async function saveMentions(
  person: TestPerson,
  wecomUserId: string | null,
  mobile: string | null,
) {
  const { preferences, events } = await call<{
    preferences: { revision: number };
    events: string[];
  }>("GET", "/me/notifications", undefined, person);
  await call(
    "PUT",
    "/me/notifications",
    {
      revision: preferences.revision,
      wecomUserId,
      mobile,
      mentionEvents: events,
    },
    person,
  );
}

describe("WeCom notification channels", () => {
  it("keeps mention identifiers and invitation addresses out of Remind, the delivery log, and posts", async () => {
    const { workflowId, versionId } = await setup();
    const invitation = "pending.expert@example.com";
    await call(
      "POST",
      "/bindings",
      {
        scopeType: "workflow",
        scopeId: workflowId,
        email: invitation,
        role: "Field expert",
      },
      admin,
      201,
    );
    await saveMentions(engineer, "eng-wecom-7", "13900000007");
    await saveMentions(expert, null, "13900000008");
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
    const { base } = await publishRound(workflowId, versionId);
    service.clock.advance(3100);
    expect(await service.runNotificationJobs()).toBe(1);
    const round = robot.requests.at(-1)!.message;
    expect(round.text.content).toContain("Invited person: 2");
    expect(round.text.mentioned_mobile_list).toEqual(["13900000008"]);
    expect(JSON.stringify(round)).not.toContain(invitation);

    // A Field expert who raised a concern is its requester and may Remind
    // the Engineers, but never learns how the chat mentions them.
    await call(
      "POST",
      `${base}/concerns`,
      { text: "PRIVATE CONCERN" },
      expert,
      201,
    );
    const { items } = await call<{
      items: {
        id: string;
        kind: string;
        canRemind: boolean;
        recipients: unknown[];
      }[];
    }>(
      "GET",
      `/workflows/${workflowId}/notifications/waiting`,
      undefined,
      expert,
    );
    const concern = items.find((item) => item.kind === "concern-raised")!;
    expect(concern.canRemind).toBe(true);
    const reminded = await call<{
      reminder: { recipients: unknown[] };
    }>(
      "POST",
      `/workflows/${workflowId}/notifications/remind`,
      { itemId: concern.id, confirmed: true },
      expert,
    );
    expect(reminded.reminder.recipients).toEqual([
      { name: "engineer", count: 1 },
    ]);
    const identifiers = [
      "eng-wecom-7",
      "13900000007",
      "13900000008",
      invitation,
    ];
    for (const identifier of identifiers) {
      expect(JSON.stringify({ items, reminded })).not.toContain(identifier);
    }
    // The reminder queued first; the concern's own post follows it.
    for (let post = 0; post < 2; post++) {
      service.clock.advance(3100);
      expect(await service.runNotificationJobs()).toBe(1);
      expect(robot.requests.at(-1)!.message.text.mentioned_list).toEqual([
        "eng-wecom-7",
      ]);
    }

    const { deliveries } = await call<{
      deliveries: {
        recipients: unknown[];
        content: { text: Record<string, unknown> };
      }[];
    }>(
      "GET",
      `/workflows/${workflowId}/notifications/deliveries`,
      undefined,
      owner,
    );
    expect(deliveries.map((delivery) => delivery.recipients)).toEqual([
      [{ name: "engineer", count: 1, mention: "userid" }],
      [{ name: "engineer", count: 1, mention: "userid" }],
      [
        { name: "Dr Lin", count: 2, mention: "mobile" },
        { name: "Invited person", count: 2, mention: "name" },
      ],
      [],
    ]);
    for (const delivery of deliveries)
      expect(Object.keys(delivery.content.text)).toEqual(["content"]);
    for (const identifier of identifiers)
      expect(JSON.stringify(deliveries)).not.toContain(identifier);
  });
  it("shows a Group default's posts and failures to that Group's leads and Administrators", async () => {
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
    robot.setFailure(200, 93000);
    await call(
      "PUT",
      `/groups/${groupId}/notifications/channel`,
      {
        revision: 0,
        label: "Department",
        webhookUrl,
        language: "en",
        confirmed: true,
      },
      lead,
    );
    expect(await service.runNotificationJobs()).toBe(1);
    const route = `/groups/${groupId}/notifications/deliveries`;
    const failed = await call<{ deliveries: unknown[] }>(
      "GET",
      route,
      undefined,
      lead,
    );
    expect(failed.deliveries).toMatchObject([
      {
        robotLabel: "Department",
        recipients: [],
        content: { text: { content: "Badger: group robot connection test." } },
        status: "retry",
        attempts: 1,
        error: "WeCom error 93000",
      },
    ]);
    expect(
      (await call<{ deliveries: unknown[] }>("GET", route)).deliveries,
    ).toEqual(failed.deliveries);
    await call("GET", route, undefined, owner, 403);
    const { secret } = await call<{ secret: string }>(
      "POST",
      "/me/tokens",
      { name: "Lead Agent", scopes: ["engineer"] },
      lead,
      201,
    );
    const token = await service.request(`/api/v1${route}`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(token.status).toBe(403);

    // The workflow's own posts through the Group default appear in both logs.
    robot.setFailure(null);
    await publishRound(workflowId, versionId);
    for (let post = 0; post < 2; post++) {
      service.clock.advance(3100);
      expect(await service.runNotificationJobs()).toBe(1);
    }
    const group = await call<{
      deliveries: { status: string; recipients: unknown[] }[];
    }>("GET", route, undefined, lead);
    expect(group.deliveries).toMatchObject([
      {
        status: "sent",
        recipients: [{ name: "Dr Lin", count: 2, mention: "name" }],
      },
      { status: "sent", recipients: [], attempts: 2 },
    ]);
    const workflow = await call<{ deliveries: unknown[] }>(
      "GET",
      `/workflows/${workflowId}/notifications/deliveries`,
      undefined,
      owner,
    );
    expect(workflow.deliveries).toEqual([group.deliveries[0]]);
  });
  it("waits out the robot's rate-limit window without spending the retries meant for failures", async () => {
    const { workflowId } = await setup();
    robot.setFailure(200, 45009);
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
    // WeCom's 45009 carries no Retry-After; its window is one minute.
    for (let attempt = 2; attempt <= 7; attempt++) {
      service.clock.advance(59_999);
      expect(await service.runNotificationJobs()).toBe(0);
      service.clock.advance(1);
      expect(await service.runNotificationJobs()).toBe(1);
    }
    const log = async () =>
      (
        await call<{
          deliveries: { status: string; attempts: number; error: string }[];
        }>(
          "GET",
          `/workflows/${workflowId}/notifications/deliveries`,
          undefined,
          owner,
        )
      ).deliveries;
    expect(await log()).toMatchObject([
      { status: "retry", attempts: 7, error: "WeCom error 45009" },
    ]);
    // Ordinary failures still get all five of their attempts.
    robot.setFailure(200, 93000);
    service.clock.advance(60_000);
    expect(await service.runNotificationJobs()).toBe(1);
    for (const wait of [3100, 6200, 12400]) {
      service.clock.advance(wait);
      expect(await service.runNotificationJobs()).toBe(1);
    }
    expect(await log()).toMatchObject([
      { status: "retry", attempts: 11, error: "WeCom error 93000" },
    ]);
    service.clock.advance(24800);
    expect(await service.runNotificationJobs()).toBe(1);
    expect(await log()).toMatchObject([
      { status: "failed", attempts: 12, error: "WeCom error 93000" },
    ]);
    expect(robot.requests).toHaveLength(12);
  });
  it("ends a post that stays rate limited for an hour", async () => {
    const { workflowId } = await setup();
    robot.setFailure(200, 45009);
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
    for (let attempt = 1; attempt <= 60; attempt++) {
      expect(await service.runNotificationJobs()).toBe(1);
      service.clock.advance(60_000);
    }
    expect(await service.runNotificationJobs()).toBe(0);
    const { deliveries } = await call<{ deliveries: unknown[] }>(
      "GET",
      `/workflows/${workflowId}/notifications/deliveries`,
      undefined,
      owner,
    );
    expect(deliveries).toMatchObject([
      { status: "failed", attempts: 60, error: "WeCom error 45009" },
    ]);
  });
  it("refuses a robot until the deployment has what posts need, naming what is missing", async () => {
    for (const [index, [missing, present]] of [
      ["BADGER_PUBLIC_URL", "BADGER_NOTIFICATION_KEY"],
      ["BADGER_NOTIFICATION_KEY", "BADGER_PUBLIC_URL"],
    ].entries()) {
      if (index > 0) {
        await service.close();
        await robot.close();
      }
      const { workflowId } = await setup({
        environment: { [missing!]: undefined },
      });
      const refused = await call<{ error: { message: string } }>(
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
        409,
      );
      expect(refused.error.message).toContain(missing);
      expect(refused.error.message).not.toContain(present);
    }
  });
  it("records a worker's missing or unusable settings in the delivery log instead of leaving posts queued", async () => {
    const { workflowId, versionId } = await setup();
    const save = (revision: number) =>
      call(
        "PUT",
        `/workflows/${workflowId}/notifications/channel`,
        {
          revision,
          label: "Research chat",
          webhookUrl,
          language: "en",
          confirmed: true,
        },
        owner,
      );
    const log = async () =>
      (
        await call<{
          deliveries: { status: string; attempts: number; error: string }[];
        }>(
          "GET",
          `/workflows/${workflowId}/notifications/deliveries`,
          undefined,
          owner,
        )
      ).deliveries;
    await save(0);
    // Without BADGER_PUBLIC_URL a worker cannot link a post, so it posts
    // nothing, the test post included, and each attempt says why.
    const withoutUrl = { environment: { BADGER_PUBLIC_URL: undefined } };
    expect(await service.runNotificationJobs(withoutUrl)).toBe(1);
    await publishRound(workflowId, versionId);
    expect(await service.runNotificationJobs(withoutUrl)).toBe(1);
    const lacksUrl = "Worker lacks BADGER_PUBLIC_URL";
    expect(await log()).toMatchObject([
      { status: "retry", attempts: 1, error: lacksUrl },
      { status: "retry", attempts: 1, error: lacksUrl },
    ]);
    for (const wait of [3100, 6200, 12400, 24800]) {
      service.clock.advance(wait);
      expect(await service.runNotificationJobs(withoutUrl)).toBe(2);
    }
    expect(await log()).toMatchObject([
      { status: "failed", attempts: 5, error: lacksUrl },
      { status: "failed", attempts: 5, error: lacksUrl },
    ]);
    // Without the key, or with another one, a worker cannot read the webhook,
    // but a worker with its settings still sends the post.
    await save(1);
    expect(
      await service.runNotificationJobs({
        environment: { BADGER_NOTIFICATION_KEY: undefined },
      }),
    ).toBe(1);
    expect((await log())[0]).toMatchObject({
      status: "retry",
      attempts: 1,
      error: "Worker lacks BADGER_NOTIFICATION_KEY",
    });
    service.clock.advance(3100);
    expect(
      await service.runNotificationJobs({
        environment: { BADGER_NOTIFICATION_KEY: "cd".repeat(32) },
      }),
    ).toBe(1);
    expect((await log())[0]).toMatchObject({
      status: "retry",
      attempts: 2,
      error: "Worker cannot decrypt the robot with its BADGER_NOTIFICATION_KEY",
    });
    expect(robot.requests).toHaveLength(0);
    service.clock.advance(6200);
    expect(await service.runNotificationJobs()).toBe(1);
    expect((await log())[0]).toMatchObject({
      status: "sent",
      attempts: 3,
      error: null,
    });
    expect(robot.requests).toHaveLength(1);
    expect(
      service.logs.filter(
        (entry) =>
          entry.event === "worker.notification-settings" &&
          entry.level === "error",
      ),
    ).toHaveLength(12);
    expect(JSON.stringify(service.logs)).not.toContain("test-secret");
  });
  it("offers copy text without recording a reminder or starting the hour when a post would reach nobody", async () => {
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
    expect(await service.runNotificationJobs()).toBe(1);
    // The only person waiting has turned chat mentions off for every event.
    await call(
      "PUT",
      "/me/notifications",
      { revision: 0, wecomUserId: "lin", mobile: null, mentionEvents: [] },
      expert,
    );
    const { questions } = await publishRound(workflowId, versionId);
    const waiting = async () =>
      (
        await call<{
          items: {
            id: string;
            questionId: string;
            href: string;
            remindAfter: string | null;
          }[];
        }>(
          "GET",
          `/workflows/${workflowId}/notifications/waiting`,
          undefined,
          engineer,
        )
      ).items.find((entry) => entry.questionId === questions[0]!.id)!;
    const item = await waiting();
    for (let click = 0; click < 2; click++) {
      const reminded = await call(
        "POST",
        `/workflows/${workflowId}/notifications/remind`,
        { itemId: item.id, confirmed: true },
        engineer,
      );
      expect(reminded).toEqual({
        reminder: null,
        deliveryId: null,
        remindAfter: null,
        copy: {
          workflowName: "sample-workflow",
          event: "question-assigned",
          recipients: [{ name: "Dr Lin", count: 1 }],
          href: item.href,
        },
      });
    }
    expect((await waiting()).remindAfter).toBeNull();
    const { events } = await call<{ events: unknown[] }>(
      "GET",
      "/audit-events?action=reminder.created",
    );
    expect(events).toEqual([]);
    service.clock.advance(3100);
    expect(await service.runNotificationJobs()).toBe(0);
    expect(robot.requests).toHaveLength(1);
  });
  it("keeps one reminder an hour when two people remind the same item at once", async () => {
    const { workflowId, versionId } = await setup();
    const { questions } = await publishRound(workflowId, versionId);
    const { items } = await call<{
      items: { id: string; questionId: string }[];
    }>(
      "GET",
      `/workflows/${workflowId}/notifications/waiting`,
      undefined,
      engineer,
    );
    const item = items.find((entry) => entry.questionId === questions[0]!.id)!;
    const clicks = await Promise.all(
      [engineer, owner].map((person) =>
        service.request(
          `/api/v1/workflows/${workflowId}/notifications/remind`,
          {
            as: person,
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "http://localhost",
            },
            body: JSON.stringify({ itemId: item.id, confirmed: true }),
          },
        ),
      ),
    );
    expect(clicks.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const { events } = await call<{ events: unknown[] }>(
      "GET",
      "/audit-events?action=reminder.created",
    );
    expect(events).toHaveLength(1);
  });
  it("returns Copy reminder's parts for the dashboard to compose without BADGER_PUBLIC_URL", async () => {
    const { workflowId, versionId } = await setup({
      environment: {
        BADGER_PUBLIC_URL: undefined,
        BADGER_NOTIFICATION_KEY: undefined,
      },
    });
    const { questions } = await publishRound(workflowId, versionId);
    const { items } = await call<{
      items: { id: string; questionId: string; href: string }[];
    }>(
      "GET",
      `/workflows/${workflowId}/notifications/waiting`,
      undefined,
      engineer,
    );
    const item = items.find((entry) => entry.questionId === questions[0]!.id)!;
    const reminded = await call<Record<string, unknown>>(
      "POST",
      `/workflows/${workflowId}/notifications/remind`,
      { itemId: item.id, confirmed: true },
      engineer,
    );
    // The page's origin and base path, and the viewer's language, make the text.
    expect(reminded).toMatchObject({
      reminder: { recipients: [{ name: "Dr Lin", count: 1 }] },
      deliveryId: null,
      copy: {
        workflowName: "sample-workflow",
        event: "question-assigned",
        recipients: [{ name: "Dr Lin", count: 1 }],
        href: `/questionnaire/questions/${questions[0]!.id}`,
      },
    });
    expect(reminded).not.toHaveProperty("copyText");
    await call(
      "POST",
      `/workflows/${workflowId}/notifications/remind`,
      { itemId: item.id, confirmed: true },
      owner,
      409,
    );
  });
  it("audits which robot a channel posts through, without the webhook", async () => {
    const { workflowId } = await setup();
    const route = `/workflows/${workflowId}/notifications/channel`;
    const save = (revision: number, label: string, url?: string) =>
      call(
        "PUT",
        route,
        {
          revision,
          label,
          ...(url === undefined ? {} : { webhookUrl: url }),
          language: "en",
          confirmed: true,
        },
        owner,
      );
    await save(0, "Research chat", webhookUrl);
    await save(1, "Renamed chat");
    await save(
      2,
      "Renamed chat",
      webhookUrl.replace("test-secret", "other-secret"),
    );
    await call("DELETE", route, { revision: 3, confirmed: true }, owner);
    const { events } = await call<{
      events: {
        action: string;
        before: { revision: number; hash: string } | null;
        after: { revision: number; hash: string } | null;
      }[];
    }>("GET", "/audit-events?targetType=notification_channel");
    const [disconnected, swapped, renamed, connected] = events;
    expect(events.map((event) => event.action)).toEqual([
      "notification_channel.disconnected",
      "notification_channel.saved",
      "notification_channel.saved",
      "notification_channel.saved",
    ]);
    const first = connected!.after!.hash;
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(connected!.before).toBeNull();
    // A label edit keeps the robot; a new webhook is a different robot.
    expect(renamed!.before).toEqual({ revision: 1, hash: first });
    expect(renamed!.after).toEqual({ revision: 2, hash: first });
    expect(swapped!.before).toEqual({ revision: 2, hash: first });
    expect(swapped!.after!.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(swapped!.after!.hash).not.toBe(first);
    expect(disconnected!.before).toEqual(swapped!.after);
    expect(JSON.stringify(events)).not.toContain("secret");
  });
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
      copy: unknown;
      deliveryId: string | null;
    }>("POST", reminderRoute, { itemId: item.id, confirmed: true }, engineer);
    expect(reminder.deliveryId).toBeNull();
    expect(reminder.copy).toEqual({
      workflowName: "sample-workflow",
      event: "question-assigned",
      recipients: [{ name: "Dr Lin", count: 1 }],
      href: item.href,
    });
    expect(JSON.stringify(reminder)).not.toContain("PRIVATE");
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
    // Retry-After cannot cut the robot's one-minute rate-limit window short.
    expect(await service.runNotificationJobs()).toBe(0);
    service.clock.advance(50_000);
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
    // "@all" mentions the whole chat, so no letter case of it is a userid.
    for (const wecomUserId of ["@all", "@ALL", "@All", "ALL", "@lin"])
      await call(
        "PUT",
        "/me/notifications",
        { revision: 1, wecomUserId, mobile: null, mentionEvents: [] },
        expert,
        400,
      );
    // WeCom userids may contain "@" after a leading letter or digit.
    const withAt = await call<{ preferences: { wecomUserId: string } }>(
      "PUT",
      "/me/notifications",
      {
        revision: 1,
        wecomUserId: "lin.wei@lab-2_x",
        mobile: null,
        mentionEvents: ["question-assigned"],
      },
      expert,
    );
    expect(withAt.preferences.wecomUserId).toBe("lin.wei@lab-2_x");
    await call(
      "PUT",
      "/me/notifications",
      {
        revision: 2,
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
