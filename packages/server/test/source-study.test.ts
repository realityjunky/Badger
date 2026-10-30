import { createHash } from "node:crypto";
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
const observer: TestPerson = {
  subject: "observer",
  email: "observer@example.com",
};
const guide =
  "# Output contract\nWrite samples.tsv.\nColumns: sample_id, sequence.\n";
const fileHash = createHash("sha256").update(guide).digest("hex");
let service: TestService;
afterEach(async () => {
  await service?.close();
});

function write(method: string, path: string, body: unknown, as = engineer) {
  return service.request(`/api/v1${path}`, {
    method,
    as,
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function read(path: string, as = engineer) {
  const response = await service.request(`/api/v1${path}`, { as });
  expect(response.status).toBe(200);
  return response.json();
}
async function setup(names = ["producer-skill", "consumer-skill"]) {
  service = await startTestService({
    environment: {
      BADGER_BOOTSTRAP_ADMINISTRATORS: admin.email,
      BADGER_ALLOWED_ORIGINS: "http://localhost",
    },
  });
  const { group } = await (
    await write("POST", "/groups", { name: "Research" }, admin)
  ).json();
  const { workflow, version } = await (
    await write(
      "POST",
      "/workflows",
      {
        groupId: group.id,
        name: "study-workflow",
        goal: "Study the source contracts.",
        intent: "new-skill",
        locale: "en",
      },
      admin,
    )
  ).json();
  for (const [person, role] of [
    [engineer, "Engineer"],
    [observer, "Observer"],
  ] as const) {
    expect(
      (
        await write(
          "POST",
          "/bindings",
          {
            scopeType: "workflow",
            scopeId: workflow.id,
            role,
            email: person.email,
          },
          admin,
        )
      ).status,
    ).toBe(201);
  }
  const pins = [];
  for (const name of names) {
    const { skill } = await (
      await write("POST", "/skills", { groupId: group.id, name }, admin)
    ).json();
    const files = [
      {
        path: "SKILL.md",
        content: Buffer.from(
          `---\nname: ${name}\ndescription: Source study fixture\n---\n\nRead reference/guide.md.\n`,
        ).toString("base64"),
      },
      {
        path: "reference/guide.md",
        content: Buffer.from(guide).toString("base64"),
      },
    ];
    const { preview } = await (
      await write("POST", `/skills/${skill.id}/upload-preview`, { files })
    ).json();
    expect(
      (
        await write("POST", `/skills/${skill.id}/versions`, {
          files,
          confirmed: true,
          expectedHash: preview.hash,
        })
      ).status,
    ).toBe(201);
    pins.push({ skillId: skill.id, hash: preview.hash });
  }
  const base = `/workflows/${workflow.id}/versions/${version.id}`;
  for (const pin of pins)
    expect((await write("POST", `${base}/pins`, pin)).status).toBe(201);
  await service.runSourceCheckJobs();
  const { preview } = await (
    await write("POST", `${base}/gates/sources/preview`, {})
  ).json();
  expect(
    (
      await write("POST", `${base}/gates/sources/commit`, {
        confirmationHash: preview.confirmationHash,
        requestId: "confirm-sources",
      })
    ).status,
  ).toBe(200);
  const evidence = {
    ...pins[0],
    path: "reference/guide.md",
    startLine: 2,
    endLine: 3,
    fileHash,
  };
  return { base, pins, evidence };
}

describe("source study through the service", () => {
  it("blocks an interface whose uncited consumer is no longer pinned", async () => {
    const { base, pins, evidence } = await setup();
    const created = await write("POST", `${base}/source-study/interfaces`, {
      producer: pins[0],
      consumer: pins[1],
      artifact: "samples.tsv",
      columns: ["sample_id", "sequence"],
      naming: "One table per batch.",
      validation: "Both columns must be present.",
      evidence: [evidence],
    });
    expect(created.status).toBe(201);
    expect(
      (
        await write("DELETE", `${base}/pins/${pins[1].skillId}`, {
          revision: 1,
        })
      ).status,
    ).toBe(200);
    const study = await read(`${base}/source-study`);
    expect(study.interfaces[0]).toMatchObject({
      stale: true,
      evidenceChanges: [],
    });
    const response = await write(
      "POST",
      `${base}/gates/source-study/${pins[0].skillId}/preview`,
      {},
    );
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).toContain(
      "SOURCE_STUDY_EVIDENCE_STALE",
    );
  });
  it("records a source-derived fact and lets a workflow Observer open the exact cited lines", async () => {
    const { base, evidence } = await setup();
    const response = await write("POST", `${base}/source-study/facts`, {
      statement:
        "The producer writes a table with sample_id and sequence columns.",
      evidence: [evidence],
    });
    expect(response.status).toBe(201);
    const { record } = await response.json();
    expect(record).toMatchObject({
      kind: "fact",
      revision: 1,
      status: "active",
      content: { evidence: [evidence] },
    });
    expect(await read(`${base}/source-study`, observer)).toMatchObject({
      facts: [record],
      interfaces: [],
      studies: [
        expect.objectContaining({ studied: false }),
        expect.objectContaining({ studied: false }),
      ],
    });
    expect(
      await read(
        `${base}/source-study/facts/${record.id}/evidence/0?revision=1`,
        observer,
      ),
    ).toMatchObject({
      evidence,
      lines: [
        { number: 2, text: "Write samples.tsv." },
        { number: 3, text: "Columns: sample_id, sequence." },
      ],
    });
  });

  it("keeps fact revisions and retirement, refuses stale edits, and audits each write", async () => {
    const { base, evidence } = await setup();
    const body = {
      statement: "The output is samples.tsv.",
      evidence: [evidence],
    };
    const { record: first } = await (
      await write("POST", `${base}/source-study/facts`, body)
    ).json();
    const path = `${base}/source-study/facts/${first.id}`;
    const edited = await write("PATCH", path, {
      ...body,
      statement: "The output has two columns.",
      revision: 1,
    });
    expect(edited.status).toBe(200);
    const { record: second } = await edited.json();
    expect(second).toMatchObject({ id: first.id, revision: 2 });
    const stale = await write("PATCH", path, { ...body, revision: 1 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: "conflict" },
      record: second,
    });
    expect((await write("DELETE", path, { revision: 2 })).status).toBe(200);
    const history = await read(path);
    expect(history.record).toMatchObject({ revision: 3, status: "retired" });
    expect(history.revisions).toMatchObject([
      { revision: 1, status: "active", content: body },
      {
        revision: 2,
        status: "active",
        content: { statement: "The output has two columns." },
      },
      { revision: 3, status: "retired" },
    ]);
    expect(await read(`${path}/evidence/0?revision=1`, observer)).toMatchObject(
      { evidence },
    );
    const audit = await read("/audit-events?targetType=source_fact", admin);
    expect(
      audit.events.map((event: { action: string }) => event.action).sort(),
    ).toEqual([
      "source_fact.created",
      "source_fact.retired",
      "source_fact.updated",
    ]);
    expect(audit.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorEmail: engineer.email,
          before: { revision: 1, hash: expect.any(String) },
          after: { revision: 2, hash: expect.any(String) },
        }),
      ]),
    );
  });

  it("revisions an interface independently and binds each studied pin to its reviewed records", async () => {
    const { base, pins, evidence } = await setup();
    const content = {
      producer: pins[0],
      consumer: pins[1],
      artifact: "samples.tsv",
      columns: ["sample_id", "sequence"],
      naming: "One samples.tsv per batch.",
      validation: "Both columns must be present.",
      evidence: [evidence],
    };
    const created = await write(
      "POST",
      `${base}/source-study/interfaces`,
      content,
    );
    expect(created.status).toBe(201);
    const { record } = await created.json();
    expect(record).toMatchObject({ kind: "interface", revision: 1, content });
    async function preview(skillId: string) {
      const response = await write(
        "POST",
        `${base}/gates/source-study/${skillId}/preview`,
        {},
      );
      expect(response.status).toBe(200);
      return (await response.json()).preview;
    }
    async function confirm(skillId: string, requestId: string) {
      const review = await preview(skillId);
      const response = await write(
        "POST",
        `${base}/gates/source-study/${skillId}/commit`,
        { confirmationHash: review.confirmationHash, requestId },
      );
      expect(response.status).toBe(200);
      return response.json();
    }
    const first = await confirm(pins[0].skillId, "study-producer");
    let study = await read(`${base}/source-study`);
    expect(
      study.studies.find(
        (s: { skillId: string }) => s.skillId === pins[0].skillId,
      ),
    ).toMatchObject({
      studied: true,
      confirmation: { actorId: first.confirmation.actorId, revision: 1 },
    });
    expect((await read(base)).version.stages).toContainEqual({
      id: "source-study",
      state: "active",
    });
    const oldPreview = await preview(pins[1].skillId);
    const updated = await write(
      "PATCH",
      `${base}/source-study/interfaces/${record.id}`,
      {
        ...content,
        naming: "Use the batch name as the file stem.",
        revision: 1,
      },
    );
    expect(updated.status).toBe(200);
    const stale = await write(
      "POST",
      `${base}/gates/source-study/${pins[1].skillId}/commit`,
      {
        confirmationHash: oldPreview.confirmationHash,
        requestId: "stale-study",
      },
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "conflict" } });
    expect(
      (await read(`${base}/source-study`)).studies.every(
        (s: { studied: boolean }) => !s.studied,
      ),
    ).toBe(true);
    // A retry recovers the original response even after the interface changed.
    const replay = await write(
      "POST",
      `${base}/gates/source-study/${pins[0].skillId}/commit`,
      {
        confirmationHash: first.confirmation.confirmationHash,
        requestId: "study-producer",
      },
    );
    expect(await replay.json()).toEqual(first);
    await confirm(pins[0].skillId, "study-producer-again");
    await confirm(pins[1].skillId, "study-consumer");
    const done = await read(base);
    expect(done.version.stages).toEqual(
      expect.arrayContaining([
        { id: "source-study", state: "done" },
        { id: "questionnaire", state: "active" },
      ]),
    );
    expect(
      (
        await write("DELETE", `${base}/source-study/interfaces/${record.id}`, {
          revision: 2,
        })
      ).status,
    ).toBe(200);
    const reopened = await read(base);
    expect(reopened.version.stages).toEqual(
      expect.arrayContaining([
        { id: "source-study", state: "active" },
        { id: "questionnaire", state: "invalidated" },
      ]),
    );
    expect(
      (await read(`${base}/source-study/interfaces/${record.id}`)).revisions,
    ).toHaveLength(3);
    const audit = await read(
      "/audit-events?targetType=source_interface",
      admin,
    );
    expect(
      audit.events.map((e: { action: string }) => e.action).sort(),
    ).toEqual([
      "source_interface.created",
      "source_interface.retired",
      "source_interface.updated",
    ]);
  });

  it("refuses forged evidence and reserves record writes and study sign-off for people with the Engineer role", async () => {
    const { base, pins, evidence } = await setup();
    const body = {
      statement: "The output has a schema.",
      evidence: [evidence],
    };
    for (const [citation, status] of [
      [{ ...evidence, fileHash: "0".repeat(64) }, 409],
      [{ ...evidence, hash: "0".repeat(64) }, 409],
      [{ ...evidence, path: "../reference/guide.md" }, 400],
      [{ ...evidence, startLine: 0 }, 400],
      [{ ...evidence, endLine: 4 }, 400],
    ] as const) {
      expect(
        (
          await write("POST", `${base}/source-study/facts`, {
            ...body,
            evidence: [citation],
          })
        ).status,
      ).toBe(status);
    }
    expect(
      (await write("POST", `${base}/source-study/facts`, body, observer))
        .status,
    ).toBe(403);
    const outsider = { subject: "outsider", email: "outsider@example.com" };
    expect(
      (await service.request(`/api/v1${base}/source-study`, { as: outsider }))
        .status,
    ).toBe(403);
    const { secret } = await (
      await write("POST", "/me/tokens", {
        name: "Study Agent",
        scopes: ["engineer"],
      })
    ).json();
    const bearer = {
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
    };
    expect(
      (await service.request(`/api/v1${base}/source-study`, bearer)).status,
    ).toBe(200);
    for (const path of [
      `${base}/source-study/facts`,
      `${base}/gates/source-study/${pins[0].skillId}/preview`,
      `${base}/gates/source-study/${pins[0].skillId}/commit`,
    ]) {
      expect(
        (
          await service.request(`/api/v1${path}`, {
            ...bearer,
            method: "POST",
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(403);
    }
    expect((await read(`${base}/source-study`)).facts).toEqual([]);
    const { record } = await (
      await write("POST", `${base}/source-study/facts`, body)
    ).json();
    const path = `${base}/source-study/facts/${record.id}`;
    for (const method of ["PATCH", "DELETE"])
      expect(
        (await write(method, path, { ...body, revision: 1 }, observer)).status,
      ).toBe(403);
    expect(
      (
        await service.request(`/api/v1${path}/evidence/0?revision=1`, {
          as: outsider,
        })
      ).status,
    ).toBe(403);
  });

  it("requires Sources confirmation and reopens study when pins change, retaining historical evidence", async () => {
    const { base, pins, evidence } = await setup();
    const { record } = await (
      await write("POST", `${base}/source-study/facts`, {
        statement: "Writes samples.tsv.",
        evidence: [evidence],
      })
    ).json();
    const gatePath = `${base}/gates/source-study/${pins[0].skillId}`;
    const { preview } = await (
      await write("POST", `${gatePath}/preview`, {})
    ).json();
    expect(
      (
        await write("POST", `${gatePath}/commit`, {
          confirmationHash: preview.confirmationHash,
          requestId: "study-original",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await write("DELETE", `${base}/pins/${pins[0].skillId}`, {
          revision: 1,
        })
      ).status,
    ).toBe(200);
    const missing = await write("POST", `${gatePath}/preview`, {});
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({
      error: { code: "rejected" },
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "SOURCE_SET_NOT_CONFIRMED" }),
        expect.objectContaining({ code: "SKILL_VERSION_NOT_PINNED" }),
      ]),
    });
    expect((await read(`${base}/source-study`)).facts[0]).toMatchObject({
      id: record.id,
      stale: true,
    });
    expect(
      await read(
        `${base}/source-study/facts/${record.id}/evidence/0?revision=1`,
      ),
    ).toMatchObject({ evidence });
    expect((await write("POST", `${base}/pins`, pins[0])).status).toBe(201);
    await service.runSourceCheckJobs();
    const { preview: sources } = await (
      await write("POST", `${base}/gates/sources/preview`, {})
    ).json();
    await write("POST", `${base}/gates/sources/commit`, {
      confirmationHash: sources.confirmationHash,
      requestId: "sources-again",
    });
    expect(
      (await read(`${base}/source-study`)).studies.every(
        (s: { studied: boolean }) => !s.studied,
      ),
    ).toBe(true);
  });

  it("keeps Questionnaire closed while an active record cites only an unpinned Skill version", async () => {
    const { base, pins } = await setup([
      "producer-skill",
      "consumer-skill",
      "dropped-skill",
    ]);
    const { record } = await (
      await write("POST", `${base}/source-study/facts`, {
        statement: "The dropped Skill writes samples.tsv.",
        evidence: [
          {
            ...pins[2],
            path: "reference/guide.md",
            startLine: 2,
            endLine: 2,
            fileHash,
          },
        ],
      })
    ).json();
    expect(
      (
        await write("DELETE", `${base}/pins/${pins[2].skillId}`, {
          revision: 1,
        })
      ).status,
    ).toBe(200);
    await service.runSourceCheckJobs();
    const { preview: sources } = await (
      await write("POST", `${base}/gates/sources/preview`, {})
    ).json();
    expect(
      (
        await write("POST", `${base}/gates/sources/commit`, {
          confirmationHash: sources.confirmationHash,
          requestId: "sources-without-dropped",
        })
      ).status,
    ).toBe(200);
    async function study(skillId: string) {
      return write("POST", `${base}/gates/source-study/${skillId}/preview`, {});
    }
    const first = await (await study(pins[0].skillId)).json();
    expect(
      (
        await write(
          "POST",
          `${base}/gates/source-study/${pins[0].skillId}/commit`,
          {
            confirmationHash: first.preview.confirmationHash,
            requestId: "study-producer",
          },
        )
      ).status,
    ).toBe(200);

    const last = await study(pins[1].skillId);
    expect(last.status).toBe(409);
    expect(await last.json()).toMatchObject({
      error: { code: "rejected" },
      findings: [
        expect.objectContaining({ code: "SOURCE_STUDY_EVIDENCE_STALE" }),
      ],
    });
    expect(
      (
        await write("DELETE", `${base}/source-study/facts/${record.id}`, {
          revision: 1,
        })
      ).status,
    ).toBe(200);
    const ready = await study(pins[1].skillId);
    expect(ready.status).toBe(200);
    expect(
      (
        await write(
          "POST",
          `${base}/gates/source-study/${pins[1].skillId}/commit`,
          {
            confirmationHash: (await ready.json()).preview.confirmationHash,
            requestId: "study-consumer",
          },
        )
      ).status,
    ).toBe(200);
    expect((await read(base)).version.stages).toEqual(
      expect.arrayContaining([
        { id: "source-study", state: "done" },
        { id: "questionnaire", state: "active" },
      ]),
    );
  });
});
