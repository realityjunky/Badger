import { createHash } from "node:crypto";
import { expect } from "vitest";
import {
  startTestService,
  type TestPerson,
  type TestService,
} from "../../src/testing/index.js";

export const admin: TestPerson = {
  subject: "admin",
  email: "admin@example.com",
};
export const engineer: TestPerson = {
  subject: "engineer",
  email: "engineer@example.com",
};
export const owner: TestPerson = {
  subject: "owner",
  email: "owner@example.com",
};
export const observer: TestPerson = {
  subject: "observer",
  email: "observer@example.com",
};

export function planningRequest(service: TestService) {
  return async (
    path: string,
    method = "GET",
    body?: unknown,
    as = engineer,
    status = 200,
    token?: string,
  ) => {
    const response = await service.request(`/api/v1${path}`, {
      ...(token ? {} : { as }),
      method,
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
        ...(token
          ? {
              authorization: `Bearer ${token}`,
              "x-badger-agent-host": "Planning Agent",
            }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
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
  };
}

export async function startPlanningService() {
  return startTestService({
    environment: {
      BADGER_BOOTSTRAP_ADMINISTRATORS: admin.email,
      BADGER_ALLOWED_ORIGINS: "http://localhost",
    },
  });
}

export async function planningFixture(service: TestService) {
  const call = planningRequest(service);
  const { group } = await call(
    "/groups",
    "POST",
    { name: "Research" },
    admin,
    201,
  );
  const { workflow, version } = await call(
    "/workflows",
    "POST",
    {
      groupId: group.id,
      name: "report",
      goal: "Prepare a reviewed report.",
      intent: "new-skill",
      locale: "zh",
    },
    admin,
    201,
  );
  for (const [person, role] of [
    [engineer, "Engineer"],
    [owner, "Workflow owner"],
    [observer, "Observer"],
  ] as const)
    await call(
      "/bindings",
      "POST",
      {
        scopeType: "workflow",
        scopeId: workflow.id,
        email: person.email,
        role,
      },
      admin,
      201,
    );
  const base = `/workflows/${workflow.id}/versions/${version.id}`;
  const { skill } = await call(
    "/skills",
    "POST",
    { groupId: group.id, name: "prepare" },
    admin,
    201,
  );
  const text =
    "---\nname: prepare\ndescription: Prepare a report\n---\n\nReturn report text.\n";
  const files = [
    { path: "SKILL.md", content: Buffer.from(text).toString("base64") },
  ];
  const { preview: upload } = await call(
    `/skills/${skill.id}/upload-preview`,
    "POST",
    { files },
  );
  await call(
    `/skills/${skill.id}/versions`,
    "POST",
    { files, confirmed: true, expectedHash: upload.hash },
    engineer,
    201,
  );
  await call(
    `${base}/pins`,
    "POST",
    { skillId: skill.id, hash: upload.hash },
    engineer,
    201,
  );
  await service.runSourceCheckJobs();
  const approve = async (gate: string, as = engineer) => {
    const { preview } = await call(
      `${base}/gates/${gate}/preview`,
      "POST",
      {},
      as,
    );
    const body = {
      confirmationHash: preview.confirmationHash,
      requestId: crypto.randomUUID(),
    };
    return {
      ...(await call(`${base}/gates/${gate}/commit`, "POST", body, as)),
      body,
    };
  };
  await approve("sources");
  const factContent = {
    statement: "Return a reviewed report.",
    evidence: [
      {
        skillId: skill.id,
        hash: upload.hash,
        path: "SKILL.md",
        startLine: 6,
        endLine: 6,
        fileHash: createHash("sha256").update(text).digest("hex"),
      },
    ],
  };
  const { record } = await call(
    `${base}/source-study/facts`,
    "POST",
    factContent,
    engineer,
    201,
  );
  await approve(`source-study/${skill.id}`);
  const { handoff } = await call(`${base}/questionnaire/ledger`);
  const topic = {
    summary: "Return a report; no additional behavior applies.",
    factIds: [record.id],
  };
  const semantics = {
    nodes: [{ id: "report", order: 0, responsibility: topic }],
    topics: Object.fromEntries(
      handoff.readiness
        .filter((r: { topic: string }) => r.topic !== "scope")
        .map((r: { topic: string }) => [r.topic, topic]),
    ),
  };
  const { composition } = await call(
    `${base}/dossier/preview`,
    "POST",
    semantics,
  );
  const { version: dossier } = await call(
    `${base}/dossier/compose`,
    "POST",
    { ...semantics, confirmationHash: composition.hash },
    engineer,
    201,
  );
  return {
    call,
    base,
    workflow,
    version,
    dossier,
    semantics,
    approve,
    skill,
    record,
    factContent,
  };
}
