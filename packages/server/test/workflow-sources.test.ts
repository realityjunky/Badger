import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  startTestService,
  type TestPerson,
  type TestService,
  type WorkflowJob,
} from "../src/testing/index.js";

const onPostgres = process.env["BADGER_TEST_DATABASE_URL"] !== undefined;
const SUPERSEDED = "A later pin change superseded this check";

const admin: TestPerson = { subject: "admin", email: "admin@example.com" };
const lead: TestPerson = { subject: "lead", email: "lead@example.com" };
const engineer: TestPerson = {
  subject: "engineer",
  email: "engineer@example.com",
};

let service: TestService;

afterEach(async () => {
  await service?.close();
});

function write(method: string, path: string, as: TestPerson, body: unknown) {
  return service.request(`/api/v1${path}`, {
    as,
    method,
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
    },
    body: JSON.stringify(body),
  });
}

interface VersionView {
  pins: { skillId: string; hash: string; purpose: string; revision: number }[];
  sourceCheck: {
    status: string;
    sources: { name: string; purpose: string; hash: string | null }[];
    blockers: string[];
    workspacePath: string | null;
  } | null;
  jobs: WorkflowJob[];
  version: { stages: { id: string; state: string }[] };
  capabilities: { managePins: boolean };
}

async function view(base: string, init: RequestInit & { as?: TestPerson }) {
  const response = await service.request(`/api/v1${base}`, init);
  expect(response.status).toBe(200);
  return (await response.json()) as VersionView;
}

function stage(body: VersionView, id: string): string | undefined {
  return body.version.stages.find((entry) => entry.id === id)?.state;
}

async function createSkill(groupId: string, name: string): Promise<string> {
  const response = await write("POST", "/skills", admin, { groupId, name });
  expect(response.status).toBe(201);
  return ((await response.json()) as { skill: { id: string } }).skill.id;
}

async function uploadVersion(
  skillId: string,
  name: string,
  guide = "Guide\n",
  as: TestPerson = engineer,
): Promise<string> {
  const content = {
    files: [
      {
        path: "SKILL.md",
        content: Buffer.from(
          `---\nname: ${name}\ndescription: Example source\n---\n\nUse the source.\n`,
        ).toString("base64"),
      },
      {
        path: "reference/guide.md",
        content: Buffer.from(guide).toString("base64"),
      },
    ],
  };
  const preview = await write(
    "POST",
    `/skills/${skillId}/upload-preview`,
    as,
    content,
  );
  expect(preview.status).toBe(200);
  const { preview: inspected } = (await preview.json()) as {
    preview: { hash: string };
  };
  const uploaded = await write("POST", `/skills/${skillId}/versions`, as, {
    ...content,
    confirmed: true,
    expectedHash: inspected.hash,
  });
  expect(uploaded.status).toBe(201);
  return inspected.hash;
}

async function setup(intent = "new-skill") {
  service = await startTestService({
    environment: {
      BADGER_BOOTSTRAP_ADMINISTRATORS: admin.email,
      BADGER_ALLOWED_ORIGINS: "http://localhost",
    },
  });
  const groupResponse = await write("POST", "/groups", admin, {
    name: "Research",
  });
  const { group } = (await groupResponse.json()) as { group: { id: string } };
  for (const person of [lead, engineer]) {
    const binding = await write("POST", "/bindings", admin, {
      scopeType: "group",
      scopeId: group.id,
      role: person === lead ? "Group lead" : "Member",
      email: person.email,
    });
    expect(binding.status).toBe(201);
  }
  const workflowResponse = await write("POST", "/workflows", lead, {
    groupId: group.id,
    name: "primer-designer",
    goal: "Build primers from reviewed sources.",
    intent,
    locale: "en",
  });
  expect(workflowResponse.status).toBe(201);
  const workflow = (await workflowResponse.json()) as {
    workflow: { id: string };
    version: { id: string };
  };
  const role = await write("POST", "/bindings", lead, {
    scopeType: "workflow",
    scopeId: workflow.workflow.id,
    role: "Engineer",
    email: engineer.email,
  });
  expect(role.status).toBe(201);
  const skillId = await createSkill(group.id, "primer-skill");
  const hash = await uploadVersion(skillId, "primer-skill");
  return {
    groupId: group.id,
    workflow: workflow.workflow,
    version: workflow.version,
    skill: { id: skillId },
    hash,
    base: `/workflows/${workflow.workflow.id}/versions/${workflow.version.id}`,
  };
}

describe("workflow Skill pins and source checks", () => {
  it("previews and confirms the exact source set and records the person's sign-off", async () => {
    const { skill, hash, base } = await setup();
    await write("POST", `${base}/pins`, engineer, { skillId: skill.id, hash });
    await service.runSourceCheckJobs();
    const previewResponse = await write(
      "POST",
      `${base}/gates/sources/preview`,
      engineer,
      {},
    );
    expect(previewResponse.status).toBe(200);
    const { preview } = (await previewResponse.json()) as {
      preview: {
        confirmationHash: string;
        boundHashes: Record<string, string>;
      };
    };
    expect(preview).toMatchObject({
      gate: "sources",
      effects: [
        { id: "sources", state: "done" },
        { id: "source-study", state: "active" },
      ],
      boundHashes: {
        pins: expect.any(String),
        sourceCheck: expect.any(String),
        workflowVersion: expect.any(String),
      },
    });
    const response = await write(
      "POST",
      `${base}/gates/sources/commit`,
      engineer,
      {
        confirmationHash: preview.confirmationHash,
        requestId: "confirm-sources-1",
      },
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      confirmation: {
        actorId: expect.any(String),
        confirmedAt: "2026-10-27T00:00:00.000Z",
        confirmationHash: preview.confirmationHash,
        boundHashes: preview.boundHashes,
        invalidatedAt: null,
      },
    });
    const current = await view(base, { as: engineer });
    expect(stage(current, "sources")).toBe("done");
    expect(stage(current, "source-study")).toBe("active");
    const audit = await service.request(
      "/api/v1/audit-events?action=gate.confirmed",
      { as: admin },
    );
    expect(await audit.json()).toMatchObject({
      events: [
        {
          actorEmail: engineer.email,
          occurredAt: "2026-10-27T00:00:00.000Z",
          after: { hash: preview.confirmationHash },
          requestId: "confirm-sources-1",
        },
      ],
    });
  });

  it("pins an immutable version, runs the worker check, and exposes inventory and blockers", async () => {
    const setupResult = await setup();
    const pin = await write(
      "POST",
      `/workflows/${setupResult.workflow.id}/versions/${setupResult.version.id}/pins`,
      engineer,
      { skillId: setupResult.skill.id, hash: setupResult.hash },
    );
    expect(pin.status).toBe(201);
    expect(await pin.json()).toMatchObject({
      pin: {
        skillId: setupResult.skill.id,
        hash: setupResult.hash,
        purpose: "source",
      },
      job: { status: "queued", requesterId: expect.any(String) },
    });

    const queued = await service.request(
      `/api/v1/workflows/${setupResult.workflow.id}/versions/${setupResult.version.id}`,
      { as: engineer },
    );
    const queuedBody = (await queued.json()) as {
      pins: { hash: string }[];
      sourceCheck: { status: string; blockers: string[] };
      jobs: { status: string; pinsHash: string }[];
      version: { stages: { id: string; state: string }[] };
    };
    expect(queuedBody).toMatchObject({
      pins: [{ hash: setupResult.hash }],
      sourceCheck: { status: "queued", blockers: [] },
      jobs: [{ status: "queued", pinsHash: expect.any(String) }],
    });
    expect(
      queuedBody.version.stages.find((stage) => stage.id === "sources"),
    ).toEqual({ id: "sources", state: "active" });
    expect(
      queuedBody.version.stages.find((stage) => stage.id === "source-study"),
    ).toEqual({ id: "source-study", state: "todo" });

    expect(await service.runSourceCheckJobs()).toBe(1);
    const checked = await service.request(
      `/api/v1/workflows/${setupResult.workflow.id}/versions/${setupResult.version.id}`,
      { as: engineer },
    );
    const checkedBody = (await checked.json()) as {
      sourceCheck: { status: string; sources: unknown[]; blockers: string[] };
      version: { stages: { id: string; state: string }[] };
      jobs: { outcome: unknown }[];
    };
    expect(checkedBody).toMatchObject({
      sourceCheck: {
        status: "passed",
        sources: [
          {
            name: "primer-skill",
            purpose: "source",
            status: "available",
            hash: setupResult.hash,
            inventory: [{ path: "SKILL.md" }, { path: "reference/guide.md" }],
          },
        ],
        blockers: [],
        workspacePath: `workflow-versions/${setupResult.version.id}`,
      },
      jobs: [{ status: "succeeded", startedAt: expect.any(String) }],
    });
    // A job keeps its status and blockers; the read model has the sources.
    expect(checkedBody.jobs[0]!.outcome).toEqual({
      status: "passed",
      blockers: [],
    });
    expect(
      checkedBody.version.stages.find((stage) => stage.id === "sources"),
    ).toEqual({ id: "sources", state: "active" });
  });

  it("closes ready inbox items on confirmation, then invalidates the gate and tells the Engineer and owner", async () => {
    const { skill, hash, base } = await setup();
    await write("POST", `${base}/pins`, engineer, { skillId: skill.id, hash });
    await service.runSourceCheckJobs();
    const inbox = async (as: TestPerson) => {
      const response = await service.request("/api/v1/me/inbox", { as });
      expect(response.status).toBe(200);
      return (await response.json()) as {
        items: {
          id: string;
          state: string;
          kind: string;
          revision: number;
          href: string;
        }[];
        unreadCount: number;
      };
    };
    const ready = await inbox(engineer);
    expect(ready).toMatchObject({
      unreadCount: 1,
      items: [{ kind: "gate-ready", state: "unread", href: `${base}#sources` }],
    });
    const read = await write(
      "PATCH",
      `/me/inbox/${ready.items[0]!.id}`,
      engineer,
      { state: "read", revision: ready.items[0]!.revision },
    );
    expect(read.status).toBe(200);
    expect((await inbox(engineer)).unreadCount).toBe(0);
    const preview = await write(
      "POST",
      `${base}/gates/sources/preview`,
      engineer,
      {},
    );
    const { preview: inspected } = (await preview.json()) as {
      preview: { confirmationHash: string };
    };
    const commit = {
      confirmationHash: inspected.confirmationHash,
      requestId: "first-confirmation",
    };
    const first = await write(
      "POST",
      `${base}/gates/sources/commit`,
      engineer,
      commit,
    );
    const original = await first.json();
    expect((await inbox(engineer)).items[0]!.state).toBe("done");
    service.clock.advance(1000);
    await write("DELETE", `${base}/pins/${skill.id}`, engineer, {
      revision: 1,
    });
    const gate = await service.request(`/api/v1${base}/gates/sources`, {
      as: engineer,
    });
    expect(await gate.json()).toMatchObject({
      confirmation: {
        invalidatedAt: "2026-10-27T00:00:01.000Z",
        boundHashes: expect.any(Object),
      },
    });
    expect(stage(await view(base, { as: engineer }), "source-study")).toBe(
      "invalidated",
    );
    for (const person of [engineer, lead]) {
      const notification = await inbox(person);
      expect(notification.unreadCount).toBe(1);
      expect(notification.items[0]).toMatchObject({
        kind: "gate-invalidated",
        state: "unread",
        href: `${base}#sources`,
      });
    }
    // A lost response is still replayable after its gate was invalidated.
    const replayed = await write(
      "POST",
      `${base}/gates/sources/commit`,
      engineer,
      commit,
    );
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toEqual(original);
    expect(stage(await view(base, { as: engineer }), "sources")).toBe("active");
  });

  it("requires an Engineer and reruns the check after unpinning", async () => {
    const setupResult = await setup();
    const path = `/workflows/${setupResult.workflow.id}/versions/${setupResult.version.id}/pins`;
    expect(
      (
        await write("POST", path, lead, {
          skillId: setupResult.skill.id,
          hash: setupResult.hash,
        })
      ).status,
    ).toBe(403);
    const pin = await write("POST", path, engineer, {
      skillId: setupResult.skill.id,
      hash: setupResult.hash,
    });
    const { pin: record } = (await pin.json()) as {
      pin: { revision: number };
    };
    expect(
      (
        await write("DELETE", `${path}/${setupResult.skill.id}`, engineer, {
          revision: record.revision + 1,
        })
      ).status,
    ).toBe(409);
    const removed = await write(
      "DELETE",
      `${path}/${setupResult.skill.id}`,
      engineer,
      { revision: record.revision },
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({
      removed: true,
      job: { status: "queued" },
    });
    // The pin's queued check was superseded, so only the latest one runs.
    expect(await service.runSourceCheckJobs()).toBe(1);
    const checked = await service.request(
      `/api/v1/workflows/${setupResult.workflow.id}/versions/${setupResult.version.id}/source-check`,
      { as: engineer },
    );
    expect(await checked.json()).toMatchObject({
      sourceCheck: {
        status: "blocked",
        blockers: ["Pin at least one Skill version before continuing"],
      },
    });
    const jobs = await service.request(`/api/v1${setupResult.base}/jobs`, {
      as: engineer,
    });
    expect(await jobs.json()).toMatchObject({
      jobs: [
        { status: "succeeded", outcome: { status: "blocked" } },
        { status: "cancelled", error: SUPERSEDED, outcome: null },
      ],
    });
  });

  it("replaces a pin only with the revision it read", async () => {
    const { skill, hash, base } = await setup();
    expect(
      (
        await write("POST", `${base}/pins`, engineer, {
          skillId: skill.id,
          hash,
        })
      ).status,
    ).toBe(201);
    const next = await uploadVersion(skill.id, "primer-skill", "Guide 2\n");

    const unquoted = await write("POST", `${base}/pins`, engineer, {
      skillId: skill.id,
      hash: next,
    });
    expect(unquoted.status).toBe(409);
    expect(await unquoted.json()).toMatchObject({
      error: { code: "conflict" },
      pin: { hash, revision: 1 },
    });
    expect(
      (
        await write("POST", `${base}/pins`, engineer, {
          skillId: skill.id,
          hash: next,
          revision: 2,
        })
      ).status,
    ).toBe(409);
    const replaced = await write("POST", `${base}/pins`, engineer, {
      skillId: skill.id,
      hash: next,
      revision: 1,
    });
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toMatchObject({
      pin: { hash: next, revision: 2 },
      job: { status: "queued" },
    });
    expect(
      (
        await write("POST", `${base}/pins`, engineer, {
          skillId: skill.id,
          hash: next,
          revision: 2,
        })
      ).status,
    ).toBe(409);

    expect(await service.runSourceCheckJobs()).toBe(1);
    const body = await view(base, { as: engineer });
    expect(body).toMatchObject({
      pins: [{ hash: next, revision: 2 }],
      sourceCheck: { status: "passed", sources: [{ hash: next }] },
      jobs: [{ status: "succeeded" }, { status: "cancelled" }],
    });
    const activity = await service.request(
      "/api/v1/audit-events?action=workflow_skill_pin.updated",
      { as: admin },
    );
    expect(await activity.json()).toMatchObject({
      events: [
        {
          targetLabel: `primer-skill · ${next}`,
          before: { revision: 1, hash },
          after: { revision: 2, hash: next },
        },
      ],
    });
  });

  it("rejects a source check that has not passed and conflicts on previews made before a pin change", async () => {
    const { skill, hash, base } = await setup();
    const previewPath = `${base}/gates/sources/preview`;
    const rejected = await write("POST", previewPath, engineer, {});
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      error: { code: "rejected" },
      findings: [
        {
          code: "SOURCE_CHECK_NOT_PASSED",
          severity: "error",
          requiredAction: "repair",
        },
      ],
    });
    await write("POST", `${base}/pins`, engineer, { skillId: skill.id, hash });
    expect((await write("POST", previewPath, engineer, {})).status).toBe(409);
    await service.runSourceCheckJobs();
    const { preview } = (await (
      await write("POST", previewPath, engineer, {})
    ).json()) as { preview: { confirmationHash: string } };
    await write("DELETE", `${base}/pins/${skill.id}`, engineer, {
      revision: 1,
    });
    const stale = await write(
      "POST",
      `${base}/gates/sources/commit`,
      engineer,
      {
        confirmationHash: preview.confirmationHash,
        requestId: "stale-preview",
      },
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "conflict" } });
    await service.runSourceCheckJobs();
    const blocked = await write("POST", previewPath, engineer, {});
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: "rejected" } });
    expect(
      (await service.request(`/api/v1${base}/gates/sources`, { as: engineer }))
        .status,
    ).toBe(200);
    expect(stage(await view(base, { as: engineer }), "sources")).toBe(
      "blocked",
    );
  });

  it("replays concurrent requests once and refuses to reuse their request ID for another confirmation", async () => {
    const { skill, hash, base } = await setup();
    await write("POST", `${base}/pins`, engineer, { skillId: skill.id, hash });
    await service.runSourceCheckJobs();
    const { preview } = (await (
      await write("POST", `${base}/gates/sources/preview`, engineer, {})
    ).json()) as { preview: { confirmationHash: string } };
    const body = {
      confirmationHash: preview.confirmationHash,
      requestId: "concurrent-confirmation",
    };
    const responses = await Promise.all(
      [1, 2, 3].map(() =>
        write("POST", `${base}/gates/sources/commit`, engineer, body),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200,
    ]);
    const results = await Promise.all(
      responses.map((response) => response.json()),
    );
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    const reused = await write(
      "POST",
      `${base}/gates/sources/commit`,
      engineer,
      { ...body, confirmationHash: "0".repeat(64) },
    );
    expect(reused.status).toBe(409);
    const audit = await service.request(
      "/api/v1/audit-events?action=gate.confirmed",
      { as: admin },
    );
    expect(((await audit.json()) as { events: unknown[] }).events).toHaveLength(
      1,
    );
    await write("DELETE", `${base}/pins/${skill.id}`, engineer, {
      revision: 1,
    });
    await write("POST", `${base}/pins`, engineer, { skillId: skill.id, hash });
    await service.runSourceCheckJobs();
    const { preview: changed } = (await (
      await write("POST", `${base}/gates/sources/preview`, engineer, {})
    ).json()) as { preview: { confirmationHash: string } };
    expect(changed.confirmationHash).not.toBe(preview.confirmationHash);
    const waitingInbox = await service.request("/api/v1/me/inbox", {
      as: engineer,
    });
    expect(await waitingInbox.json()).toMatchObject({
      pendingCount: 1,
      unreadCount: 2,
    });
    expect(
      (
        await write("POST", `${base}/gates/sources/commit`, engineer, {
          ...body,
          confirmationHash: changed.confirmationHash,
        })
      ).status,
    ).toBe(409);
    const replacement = await write(
      "POST",
      `${base}/gates/sources/commit`,
      engineer,
      {
        confirmationHash: changed.confirmationHash,
        requestId: "replacement-confirmation",
      },
    );
    expect(replacement.status).toBe(200);
    const { confirmation: next } = (await replacement.json()) as {
      confirmation: { id: string };
    };
    const history = await service.request(`/api/v1${base}/gates/sources`, {
      as: engineer,
    });
    expect(await history.json()).toMatchObject({
      confirmations: [
        { id: next.id, invalidatedAt: null },
        { supersededBy: next.id },
      ],
    });
    const inbox = await service.request("/api/v1/me/inbox", { as: engineer });
    const current = (await inbox.json()) as {
      items: { state: string }[];
      unreadCount: number;
    };
    expect(current.unreadCount).toBe(0);
    expect(current.items.every((item) => item.state === "done")).toBe(true);
  });

  it("reserves Sources sign-off for people with the Engineer role and keeps each inbox private", async () => {
    const { skill, hash, base } = await setup();
    await write("POST", `${base}/pins`, engineer, { skillId: skill.id, hash });
    await service.runSourceCheckJobs();
    const { preview } = (await (
      await write("POST", `${base}/gates/sources/preview`, engineer, {})
    ).json()) as { preview: { confirmationHash: string } };
    const commit = {
      confirmationHash: preview.confirmationHash,
      requestId: "person-only",
    };
    for (const action of ["preview", "commit"]) {
      const refused = await write(
        "POST",
        `${base}/gates/sources/${action}`,
        lead,
        action === "preview" ? {} : commit,
      );
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: { code: "denied" } });
    }
    const token = await write("POST", "/me/tokens", engineer, {
      name: "Agent",
      scopes: ["engineer"],
    });
    const { secret } = (await token.json()) as { secret: string };
    const headers = {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    };
    for (const action of ["preview", "commit"]) {
      const response = await service.request(
        `/api/v1${base}/gates/sources/${action}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(action === "preview" ? {} : commit),
        },
      );
      expect(response.status).toBe(403);
    }
    const inbox = await service.request("/api/v1/me/inbox", { as: engineer });
    const { items } = (await inbox.json()) as {
      items: { id: string; revision: number }[];
    };
    expect(
      (await service.request("/api/v1/me/inbox", { headers })).status,
    ).toBe(200);
    expect(
      (
        await write("PATCH", `/me/inbox/${items[0]!.id}`, lead, {
          state: "read",
          revision: 1,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await write("PATCH", `/me/inbox/${items[0]!.id}`, engineer, {
          state: "read",
          revision: 99,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await write("PATCH", `/me/inbox/${items[0]!.id}`, engineer, {
          state: "done",
          revision: 1,
        })
      ).status,
    ).toBe(400);
    const invalid = await write(
      "POST",
      `${base}/gates/sources/commit`,
      engineer,
      { ...commit, actorId: "someone-else" },
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "invalid" } });
    expect(
      (
        await service.request("/api/v1/me/inbox?cursor=made-up", {
          as: engineer,
        })
      ).status,
    ).toBe(400);
    expect(
      (await service.request("/api/v1/me/inbox?limit=0", { as: engineer }))
        .status,
    ).toBe(400);
  });

  it("retains a gate notification for an Engineer invited before their first sign-in", async () => {
    const { skill, hash, base, workflow } = await setup();
    const invited: TestPerson = {
      subject: "invited-engineer",
      email: "invited-engineer@example.com",
    };
    const binding = await write("POST", "/bindings", lead, {
      scopeType: "workflow",
      scopeId: workflow.id,
      role: "Engineer",
      email: invited.email,
    });
    expect(binding.status).toBe(201);
    await write("POST", `${base}/pins`, engineer, { skillId: skill.id, hash });
    await service.runSourceCheckJobs();
    const inbox = await service.request("/api/v1/me/inbox", { as: invited });
    expect(inbox.status).toBe(200);
    expect(await inbox.json()).toMatchObject({
      unreadCount: 1,
      items: [{ kind: "gate-ready", state: "unread" }],
    });
  });

  it("pins only the workflow group's Skill versions and serves only the listed methods", async () => {
    const { skill, base } = await setup();
    const other = await write("POST", "/groups", admin, { name: "Other" });
    const { group } = (await other.json()) as { group: { id: string } };
    const foreignId = await createSkill(group.id, "foreign-skill");
    const foreignHash = await uploadVersion(
      foreignId,
      "foreign-skill",
      "Guide\n",
      admin,
    );

    for (const body of [
      { skillId: foreignId, hash: foreignHash },
      { skillId: skill.id, hash: "0".repeat(64) },
    ]) {
      const response = await write("POST", `${base}/pins`, engineer, body);
      expect(response.status).toBe(404);
    }
    expect(
      (
        await write("POST", `${base}/pins`, engineer, {
          skillId: skill.id,
          hash: foreignHash,
          purpose: "upgrade-source",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await service.request(`/api/v1${base}/pins/${skill.id}`, {
          as: engineer,
        })
      ).status,
    ).toBe(405);
    expect(
      (await service.request(`/api/v1${base}/jobs/job-1`, { as: engineer }))
        .status,
    ).toBe(404);
    expect(
      (await write("POST", `${base}/source-check`, engineer, {})).status,
    ).toBe(405);
  });

  it("blocks an upgrade's Sources until its upgrade source is pinned", async () => {
    const { groupId, skill, hash, base } = await setup("upgrade-existing");
    await write("POST", `${base}/pins`, engineer, { skillId: skill.id, hash });
    await service.runSourceCheckJobs();
    let body = await view(base, { as: engineer });
    expect(body.sourceCheck).toMatchObject({
      status: "blocked",
      blockers: ["Pin the upgrade source before continuing"],
    });
    expect(stage(body, "sources")).toBe("blocked");

    const legacyId = await createSkill(groupId, "legacy-skill");
    const legacyHash = await uploadVersion(legacyId, "legacy-skill");
    const pinned = await write("POST", `${base}/pins`, engineer, {
      skillId: legacyId,
      hash: legacyHash,
      purpose: "upgrade-source",
    });
    expect(pinned.status).toBe(201);
    await service.runSourceCheckJobs();
    body = await view(base, { as: engineer });
    expect(body.sourceCheck).toMatchObject({ status: "passed", blockers: [] });
    expect(body.sourceCheck?.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "legacy-skill",
          purpose: "upgrade-source",
          hash: legacyHash,
        }),
        expect.objectContaining({ name: "primer-skill", purpose: "source" }),
      ]),
    );
    expect(stage(body, "sources")).toBe("active");

    const secondId = await createSkill(groupId, "second-legacy");
    const secondHash = await uploadVersion(secondId, "second-legacy");
    const taken = await write("POST", `${base}/pins`, engineer, {
      skillId: secondId,
      hash: secondHash,
      purpose: "upgrade-source",
    });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({
      pin: { skillId: legacyId, purpose: "upgrade-source" },
    });
  });

  it("runs one version's checks one at a time", async () => {
    const { skill, hash, base } = await setup();
    await write("POST", `${base}/pins`, engineer, { skillId: skill.id, hash });
    const first = service.worker("worker-a");
    const second = service.worker("worker-b");
    const claimed = await first.claim();
    expect(claimed).toMatchObject({ status: "running", workerId: "worker-a" });
    expect(await second.claim()).toBeNull();

    const next = await uploadVersion(skill.id, "primer-skill", "Guide 2\n");
    await write("POST", `${base}/pins`, engineer, {
      skillId: skill.id,
      hash: next,
      revision: 1,
    });
    // The new check waits for the running one, even on another worker.
    expect(await second.claim()).toBeNull();
    expect(await first.process(claimed!)).toMatchObject({
      status: "cancelled",
      error: SUPERSEDED,
    });
    expect(await second.runOnce()).toMatchObject({
      status: "succeeded",
      workerId: "worker-b",
    });
    const body = await view(base, { as: engineer });
    expect(body.sourceCheck).toMatchObject({
      status: "passed",
      sources: [{ hash: next }],
    });
    expect(stage(body, "sources")).toBe("active");
  });

  it("does not announce a superseded check when pins change away and back to the same content", async () => {
    const { skill, hash, base } = await setup();
    await write("POST", `${base}/pins`, engineer, { skillId: skill.id, hash });
    const worker = service.worker("superseded-worker");
    const claimed = await worker.claim();
    expect(claimed).not.toBeNull();
    const next = await uploadVersion(
      skill.id,
      "primer-skill",
      "Changed guide\n",
    );
    await write("POST", `${base}/pins`, engineer, {
      skillId: skill.id,
      hash: next,
      revision: 1,
    });
    await write("POST", `${base}/pins`, engineer, {
      skillId: skill.id,
      hash,
      revision: 2,
    });
    expect(await worker.process(claimed!)).toMatchObject({
      status: "cancelled",
      error: SUPERSEDED,
    });
    const inbox = await service.request("/api/v1/me/inbox", { as: engineer });
    expect(await inbox.json()).toMatchObject({ items: [], unreadCount: 0 });
    expect((await view(base, { as: engineer })).sourceCheck).toMatchObject({
      status: "queued",
    });
    expect(await service.runSourceCheckJobs()).toBe(1);
    const ready = await service.request("/api/v1/me/inbox", { as: engineer });
    expect(await ready.json()).toMatchObject({
      items: [{ kind: "gate-ready" }],
      unreadCount: 1,
    });
  });

  it("lets another worker take over a lapsed lease and ignores the late result", async () => {
    const { skill, hash, base } = await setup();
    await write("POST", `${base}/pins`, engineer, { skillId: skill.id, hash });
    const stopped = service.worker("worker-a");
    const claimed = await stopped.claim();
    expect(claimed).not.toBeNull();
    const successor = service.worker("worker-b");
    expect(await successor.claim()).toBeNull();

    service.clock.advance(60_001);
    expect(await successor.runOnce()).toMatchObject({
      id: claimed!.id,
      status: "succeeded",
      workerId: "worker-b",
    });
    // The first worker comes back and finishes; its result is not recorded.
    expect(await stopped.process(claimed!)).toMatchObject({
      status: "succeeded",
      workerId: "worker-b",
    });
    const body = await view(base, { as: engineer });
    expect(body.jobs).toEqual([
      expect.objectContaining({ id: claimed!.id, workerId: "worker-b" }),
    ]);
    expect(body.sourceCheck).toMatchObject({ status: "passed" });
  });

  it("records a failed check without showing storage paths", async () => {
    const { skill, hash, base } = await setup();
    await write("POST", `${base}/pins`, engineer, { skillId: skill.id, hash });
    await fs.rm(service.config.storage.blobDirectory, {
      recursive: true,
      force: true,
    });
    expect(await service.runSourceCheckJobs()).toBe(1);
    const body = await view(base, { as: engineer });
    expect(body.sourceCheck).toMatchObject({ status: "failed" });
    expect(stage(body, "sources")).toBe("active");
    const [job] = body.jobs;
    expect(job).toMatchObject({ status: "failed" });
    expect(job!.error).toContain("<blobs>");
    expect(job!.error).not.toContain(path.resolve(service.config.storage.root));
  });

  it("lets a token read the Sources stage but keeps pins with people", async () => {
    const { skill, hash, base } = await setup();
    const minted = await write("POST", "/me/tokens", engineer, {
      name: "Agent",
      scopes: ["engineer"],
    });
    const { secret } = (await minted.json()) as { secret: string };
    const bearer = { authorization: `Bearer ${secret}` };

    const body = await view(base, { headers: bearer });
    expect(body.capabilities.managePins).toBe(false);
    const refused = await service.request(`/api/v1${base}/pins`, {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ skillId: skill.id, hash }),
    });
    expect(refused.status).toBe(403);
    expect(
      (
        await service.request(`/api/v1${base}/source-check`, {
          headers: bearer,
        })
      ).status,
    ).toBe(200);
  });

  it.runIf(onPostgres)(
    "wakes a waiting worker on a new job and outlives Postgres ending its connection",
    async () => {
      const { skill, hash, base } = await setup();
      const worker = service.worker("listener", { pollMilliseconds: 60_000 });
      const listening = async () => {
        // A short wait opens the listener, so the next one hears the insert.
        const opened = new AbortController();
        setTimeout(() => opened.abort(), 300);
        await worker.waitForWork(opened.signal);
      };

      await listening();
      const woken = worker.waitForWork();
      await write("POST", `${base}/pins`, engineer, {
        skillId: skill.id,
        hash,
      });
      await woken;
      expect(await worker.runOnce()).toMatchObject({ status: "succeeded" });

      const dropped = worker.waitForWork();
      await service.interruptDatabase();
      await dropped;

      await listening();
      const again = worker.waitForWork();
      await write("DELETE", `${base}/pins/${skill.id}`, engineer, {
        revision: 1,
      });
      await again;
      expect(await worker.runOnce()).toMatchObject({ status: "succeeded" });
    },
    20_000,
  );
});
