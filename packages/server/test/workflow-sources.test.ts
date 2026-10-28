import { afterEach, describe, expect, it } from "vitest";
import {
  startTestService,
  type TestPerson,
  type TestService,
} from "../src/testing/index.js";

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

async function setup() {
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
    intent: "new-skill",
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
  const skillResponse = await write("POST", "/skills", admin, {
    groupId: group.id,
    name: "primer-skill",
  });
  expect(skillResponse.status).toBe(201);
  const { skill } = (await skillResponse.json()) as { skill: { id: string } };
  const content = {
    files: [
      {
        path: "SKILL.md",
        content: Buffer.from(
          "---\nname: primer-skill\ndescription: Example source\n---\n\nUse the source.\n",
        ).toString("base64"),
      },
      {
        path: "reference/guide.md",
        content: Buffer.from("Guide\n").toString("base64"),
      },
    ],
  };
  const preview = await write(
    "POST",
    `/skills/${skill.id}/upload-preview`,
    engineer,
    content,
  );
  expect(preview.status).toBe(200);
  const { preview: inspected } = (await preview.json()) as {
    preview: { hash: string };
  };
  const uploaded = await write(
    "POST",
    `/skills/${skill.id}/versions`,
    engineer,
    { ...content, confirmed: true, expectedHash: inspected.hash },
  );
  expect(uploaded.status).toBe(201);
  return {
    workflow: workflow.workflow,
    version: workflow.version,
    skill,
    hash: inspected.hash,
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
      jobs: unknown[];
    };
    expect(checkedBody).toMatchObject({
      sourceCheck: {
        status: "passed",
        sources: [
          {
            name: "primer-skill",
            status: "available",
            hash: setupResult.hash,
            inventory: [{ path: "SKILL.md" }, { path: "reference/guide.md" }],
          },
        ],
        blockers: [],
      },
      jobs: [{ status: "succeeded", outcome: { status: "passed" } }],
    });
    expect(
      checkedBody.version.stages.find((stage) => stage.id === "sources"),
    ).toEqual({ id: "sources", state: "done" });
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
    expect(await service.runSourceCheckJobs()).toBe(2);
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
  });
});
