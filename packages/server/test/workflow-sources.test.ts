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
