import { afterEach, describe, expect, it } from "vitest";
import type { TestService } from "../src/testing/index.js";
import {
  engineer,
  owner,
  planningFixture,
  startPlanningService,
} from "./fixtures/planning.js";

let service: TestService;
afterEach(async () => service?.close());

type Fixture = Awaited<ReturnType<typeof planningFixture>>;

async function uploadSkill(
  call: Fixture["call"],
  skillId: string,
  files: { path: string; content: string }[],
): Promise<{ hash: string }> {
  const { preview } = await call(`/skills/${skillId}/upload-preview`, "POST", {
    files,
  });
  await call(
    `/skills/${skillId}/versions`,
    "POST",
    {
      files,
      confirmed: true,
      expectedHash: preview.hash,
    },
    engineer,
    201,
  );
  return preview;
}

/** The owner's question in its own published round. */
async function publishedQuestion(fixture: Fixture, evidence: unknown[] = []) {
  const { call, base } = fixture;
  const root = `${base}/questionnaire`;
  const { person } = await call("/me", "GET", undefined, owner);
  const { round } = await call(
    `${root}/rounds`,
    "POST",
    { title: "Report details" },
    engineer,
    201,
  );
  const content = {
    text: "What report is required?",
    topic: "outputSchemas",
    targets: [{ kind: "workflow", id: "report" }],
    rationale: "Agree the report.",
    evidence,
    assignees: [{ kind: "person", personId: person.id }],
    priority: 80,
  };
  const { question } = await call(
    `${root}/rounds/${round.id}/questions`,
    "POST",
    content,
    engineer,
    201,
  );
  const { preview } = await call(`${root}/rounds/${round.id}/publish-preview`);
  await call(`${root}/rounds/${round.id}/publish`, "POST", {
    confirmed: true,
    confirmationHash: preview.confirmationHash,
  });
  return { question, content, person };
}

/** A published question with the owner's submitted answer and attachment. */
async function answeredQuestion(fixture: Fixture, evidence: unknown[] = []) {
  const { call, base } = fixture;
  const root = `${base}/questionnaire`;
  const { question, content, person } = await publishedQuestion(
    fixture,
    evidence,
  );
  const { attachment } = await call(
    `${root}/questions/${question.id}/attachments`,
    "POST",
    {
      questionRevision: 1,
      name: "report.txt",
      mediaType: "text/plain",
      contentBase64: Buffer.from("Reviewed report.").toString("base64"),
    },
    owner,
    201,
  );
  await call(
    `${root}/questions/${question.id}/answer`,
    "PUT",
    {
      revision: 0,
      questionRevision: 1,
      text: "A reviewed report.",
      attachments: [attachment.id],
    },
    owner,
  );
  await call(
    `${root}/questions/${question.id}/submit`,
    "POST",
    { revision: 1, questionRevision: 1 },
    owner,
  );
  return { question, content, person, attachment };
}

async function confirmedQuestion(fixture: Fixture, evidence: unknown[] = []) {
  const { call, base } = fixture;
  const root = `${base}/questionnaire`;
  const { question, person, attachment } = await answeredQuestion(
    fixture,
    evidence,
  );
  const input = {
    revision: 1,
    kind: "confirmed",
    facts: [
      {
        text: "Return a reviewed report.",
        answers: [{ personId: person.id, revision: 2 }],
      },
    ],
  };
  const { preview: resolution } = await call(
    `${root}/questions/${question.id}/resolution-preview`,
    "POST",
    input,
  );
  await call(`${root}/questions/${question.id}/resolve`, "POST", {
    ...input,
    confirmed: true,
    confirmationHash: resolution.confirmationHash,
    requestId: crypto.randomUUID(),
  });
  const { facts } = await call(root);
  const fact = facts.find(
    (f: { questionId: string }) => f.questionId === question.id,
  );
  const { preview: ack } = await call(
    `${root}/facts/${fact.id}/acknowledgement-preview`,
    "POST",
    { decision: "acknowledged" },
    owner,
  );
  await call(
    `${root}/facts/${fact.id}/acknowledge`,
    "POST",
    {
      decision: "acknowledged",
      confirmed: true,
      confirmationHash: ack.confirmationHash,
      requestId: crypto.randomUUID(),
    },
    owner,
  );
  return { question, fact, attachment };
}

describe("Skill and workflow version changes", () => {
  it("flags only changed cited files and preserves superseded dossier approval", async () => {
    service = await startPlanningService();
    const { call, base, skill, record, factContent, approve, dossier } =
      await planningFixture(service);
    const { confirmation } = await approve("dossier", owner);
    const upload = async (text: string) => {
      const files = [
        { path: "SKILL.md", content: Buffer.from(text).toString("base64") },
        {
          path: "reference/other.md",
          content: Buffer.from("Unrelated.").toString("base64"),
        },
      ];
      return (await uploadSkill(call, skill.id, files)).hash;
    };
    const unchanged = await upload(
      "---\nname: prepare\ndescription: Prepare a report\n---\n\nReturn report text.\n",
    );
    await call(`${base}/pins`, "POST", {
      skillId: skill.id,
      hash: unchanged,
      revision: 1,
    });
    const study = await call(`${base}/source-study`);
    expect(study.facts[0]).toMatchObject({
      id: record.id,
      stale: false,
      evidenceChanges: [],
    });

    const changed = await upload(
      "---\nname: prepare\ndescription: Prepare a report\n---\n\nReturn a signed report.\n",
    );
    await call(`${base}/pins`, "POST", {
      skillId: skill.id,
      hash: changed,
      revision: 2,
    });
    const flagged = await call(`${base}/source-study`);
    expect(flagged.facts[0]).toMatchObject({
      id: record.id,
      stale: true,
      evidenceChanges: [
        {
          skillId: skill.id,
          path: "SKILL.md",
          fromVersionHash: factContent.evidence[0].hash,
          toVersionHash: changed,
          beforeHash: factContent.evidence[0].fileHash,
          status: "changed",
        },
      ],
    });
    const history = await call(`${base}/dossier`);
    expect(history.versions[0]).toMatchObject({
      id: dossier.id,
      hash: dossier.hash,
    });
    const gate = await call(`${base}/gates/dossier`);
    expect(gate.confirmations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: confirmation.id,
          invalidatedAt: expect.any(String),
        }),
      ]),
    );
  });

  it("reopens deferred questions with changed citations even when they have no facts", async () => {
    service = await startPlanningService();
    const { call, base, skill, factContent } = await planningFixture(service);
    const root = `${base}/questionnaire`;
    const { person } = await call("/me", "GET", undefined, owner);
    const { round } = await call(
      `${root}/rounds`,
      "POST",
      { title: "Source review" },
      engineer,
      201,
    );
    const { hash, fileHash: _fileHash, ...citation } = factContent.evidence[0];
    const { question } = await call(
      `${root}/rounds/${round.id}/questions`,
      "POST",
      {
        text: "Which signature is required?",
        topic: "outputSchemas",
        targets: [{ kind: "workflow", id: "report" }],
        rationale: "Check the source contract.",
        evidence: [{ ...citation, versionHash: hash }],
        assignees: [{ kind: "person", personId: person.id }],
        priority: 80,
      },
      engineer,
      201,
    );
    const { preview } = await call(
      `${root}/rounds/${round.id}/publish-preview`,
    );
    await call(`${root}/rounds/${round.id}/publish`, "POST", {
      confirmed: true,
      confirmationHash: preview.confirmationHash,
    });
    await call(
      `${root}/questions/${question.id}/answer`,
      "PUT",
      { revision: 0, questionRevision: 1, text: "No signature needed." },
      owner,
    );
    await call(
      `${root}/questions/${question.id}/submit`,
      "POST",
      { revision: 1, questionRevision: 1 },
      owner,
    );
    const decision = {
      revision: 1,
      kind: "deferred",
      deferredKind: "out-of-scope",
      reason: "The source specifies no signature.",
    };
    const { preview: resolution } = await call(
      `${root}/questions/${question.id}/resolution-preview`,
      "POST",
      decision,
    );
    await call(`${root}/questions/${question.id}/resolve`, "POST", {
      ...decision,
      confirmed: true,
      confirmationHash: resolution.confirmationHash,
      requestId: "defer-signature",
    });
    const files = [
      {
        path: "SKILL.md",
        content: Buffer.from(
          "---\nname: prepare\ndescription: Prepare a report\n---\n\nReturn a signed report.\n",
        ).toString("base64"),
      },
    ];
    const upload = await uploadSkill(call, skill.id, files);
    await call(`${base}/pins`, "POST", {
      skillId: skill.id,
      hash: upload.hash,
      revision: 1,
    });
    const view = await call(root);
    expect(view.questions[0]).toMatchObject({
      id: question.id,
      state: "needs-reconfirmation",
      resolvedAt: null,
      evidenceChanges: [
        {
          path: "SKILL.md",
          fromVersionHash: hash,
          toVersionHash: upload.hash,
          status: "changed",
        },
      ],
    });
    expect(view.resolutions).toHaveLength(1);
    expect(view.resolutions[0]).toMatchObject({
      kind: "deferred",
      reason: decision.reason,
    });
    const { workflow } = await call(`/workflows/${view.workflow.id}`);
    const { version } = await call(
      `/workflows/${workflow.id}/versions`,
      "POST",
      { revision: workflow.revision },
      engineer,
      201,
    );
    const inherited = await call(
      `/workflows/${workflow.id}/versions/${version.id}/questionnaire`,
    );
    expect(inherited.questions[0]).toMatchObject({
      state: "needs-reconfirmation",
      evidenceChanges: [{ status: "changed" }],
    });
    expect(inherited.resolutions[0]).toMatchObject({
      kind: "deferred",
      origin: { recordId: view.resolutions[0].id },
    });
  });

  it("keeps records citing unchanged files confirmed across a re-pin and accepts those citations in edits and follow-ups", async () => {
    service = await startPlanningService();
    const fixture = await planningFixture(service);
    const { call, base, skill } = fixture;
    const root = `${base}/questionnaire`;
    const instructions =
      "---\nname: prepare\ndescription: Prepare a report\n---\n\nReturn report text.\n";
    const upload = async (text: string) =>
      (
        await uploadSkill(call, skill.id, [
          { path: "SKILL.md", content: Buffer.from(text).toString("base64") },
          {
            path: "reference/other.md",
            content: Buffer.from("Unrelated.").toString("base64"),
          },
        ])
      ).hash;
    const first = await upload(instructions);
    await call(`${base}/pins`, "POST", {
      skillId: skill.id,
      hash: first,
      revision: 1,
    });
    const cite = (path: string) => ({
      skillId: skill.id,
      versionHash: first,
      path,
      startLine: 1,
      endLine: 1,
    });
    const unchanged = await confirmedQuestion(fixture, [
      cite("reference/other.md"),
    ]);
    const changed = await confirmedQuestion(fixture, [cite("SKILL.md")]);
    const parent = await answeredQuestion(fixture, [
      cite("reference/other.md"),
    ]);
    const open = await publishedQuestion(fixture, [cite("reference/other.md")]);
    const second = await upload(
      instructions.replace("report text", "a signed report"),
    );
    await call(`${base}/pins`, "POST", {
      skillId: skill.id,
      hash: second,
      revision: 2,
    });

    const view = await call(root);
    const question = (id: string) =>
      view.questions.find((q: { id: string }) => q.id === id);
    expect(question(unchanged.question.id)).toMatchObject({
      state: "confirmed",
      evidenceChanges: [],
    });
    expect(
      view.facts.find((f: { id: string }) => f.id === unchanged.fact.id),
    ).toMatchObject({
      active: true,
      evidenceChanges: [],
      acknowledgements: [expect.objectContaining({ decision: "acknowledged" })],
    });
    expect(question(changed.question.id)).toMatchObject({
      state: "needs-reconfirmation",
      evidenceChanges: [{ path: "SKILL.md", status: "changed" }],
    });
    expect(question(parent.question.id).state).toBe("answered");

    // An unaffected question keeps its earlier citation through an edit.
    const { question: edited } = await call(
      `${root}/questions/${open.question.id}`,
      "PATCH",
      {
        ...open.content,
        text: "Which reviewed report is required?",
        revision: 1,
      },
    );
    expect(edited).toMatchObject({
      revision: 2,
      evidence: [cite("reference/other.md")],
      evidenceChanges: [],
    });

    // The preview validates a follow-up's citations before anyone signs off.
    const followUp = (evidence: unknown[]) => ({
      revision: 1,
      kind: "followed-up",
      reason: "Ask which reviewer signs.",
      followUp: {
        ...parent.content,
        text: "Who reviews the report?",
        evidence,
      },
    });
    for (const evidence of [[cite("SKILL.md")], [cite("reference/missing.md")]])
      await call(
        `${root}/questions/${parent.question.id}/resolution-preview`,
        "POST",
        followUp(evidence),
        engineer,
        400,
      );
    const input = followUp(parent.content.evidence);
    const { preview } = await call(
      `${root}/questions/${parent.question.id}/resolution-preview`,
      "POST",
      input,
    );
    const { resolution } = await call(
      `${root}/questions/${parent.question.id}/resolve`,
      "POST",
      {
        ...input,
        confirmed: true,
        confirmationHash: preview.confirmationHash,
        requestId: "follow-up-after-repin",
      },
    );
    const child = (await call(root)).questions.find(
      (q: { id: string }) => q.id === resolution.childQuestionId,
    );
    expect(child).toMatchObject({
      state: "open",
      parentQuestionId: parent.question.id,
      evidence: [cite("reference/other.md")],
      evidenceChanges: [],
    });
  });

  it("inherits facts, answer receipts and resolutions with provenance and isolates later edits", async () => {
    service = await startPlanningService();
    const fixture = await planningFixture(service);
    const { call, base, workflow, version, skill, record, factContent } =
      fixture;
    const { hash, fileHash: _fileHash, ...citation } = factContent.evidence[0];
    const cited = await confirmedQuestion(fixture, [
      { ...citation, versionHash: hash },
    ]);
    const unchanged = await confirmedQuestion(fixture);
    const before = await call(`${base}/questionnaire`);
    const { workflow: head } = await call(`/workflows/${workflow.id}`);
    const created = await call(
      `/workflows/${workflow.id}/versions`,
      "POST",
      { revision: head.revision },
      engineer,
      201,
    );
    expect(created.version).toMatchObject({
      number: 2,
      inheritedFromVersionId: version.id,
    });
    const next = `/workflows/${workflow.id}/versions/${created.version.id}`;
    const detail = await call(next);
    expect(detail.pins).toEqual([
      expect.objectContaining({ skillId: skill.id, hash }),
    ]);
    expect(detail.jobs).toEqual([
      expect.objectContaining({ status: "queued" }),
    ]);
    expect(detail.sourceStudy.facts[0]).toMatchObject({
      stale: false,
      origin: {
        workflowVersionId: version.id,
        recordId: record.id,
        revision: 1,
      },
    });
    const inherited = await call(`${next}/questionnaire`);
    expect(inherited.questions).toHaveLength(2);
    expect(inherited.facts).toHaveLength(2);
    expect(inherited.resolutions).toHaveLength(2);
    const { handoff } = await call(`${next}/questionnaire/ledger`);
    expect(handoff.ledger.confirmedUserFacts).toHaveLength(2);
    expect(handoff.ledger.confirmedUserFacts[0].origin).toMatchObject({
      workflowVersionId: version.id,
    });
    for (const fact of inherited.facts) {
      const original = before.facts.find(
        (f: { id: string }) => f.id === fact.origin.recordId,
      );
      expect(fact).toMatchObject({
        text: original.text,
        hash: original.hash,
        active: true,
        origin: {
          workflowVersionId: version.id,
          recordId: original.id,
          revision: 1,
        },
        acknowledgements: [
          expect.objectContaining({
            decision: "acknowledged",
            personId: original.acknowledgements[0].personId,
          }),
        ],
      });
    }
    expect((await call(`${next}/dossier`)).confirmation).toBeNull();
    const download = await service.request(
      `/api/v1${next}/questionnaire/attachments/${cited.attachment.id}`,
      { as: engineer },
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("Reviewed report.");

    const files = [
      {
        path: "SKILL.md",
        content: Buffer.from(
          "---\nname: prepare\ndescription: Prepare a report\n---\n\nReturn a signed report.\n",
        ).toString("base64"),
      },
    ];
    const preview = await uploadSkill(call, skill.id, files);
    await call(`${next}/pins`, "POST", {
      skillId: skill.id,
      hash: preview.hash,
      revision: 1,
    });
    const changed = await call(`${next}/questionnaire`);
    expect(
      changed.questions.find(
        (q: { origin: { recordId: string } }) =>
          q.origin.recordId === cited.question.id,
      ).state,
    ).toBe("needs-reconfirmation");
    expect(
      changed.questions.find(
        (q: { origin: { recordId: string } }) =>
          q.origin.recordId === unchanged.question.id,
      ).state,
    ).toBe("confirmed");
    expect(
      changed.facts.find(
        (f: { origin: { recordId: string } }) =>
          f.origin.recordId === cited.fact.id,
      ),
    ).toMatchObject({
      active: false,
      evidenceChanges: [{ path: "SKILL.md", status: "changed" }],
    });
    const original = await call(`${base}/questionnaire`);
    for (const key of ["questions", "facts", "resolutions", "answers"])
      expect(original[key]).toEqual(before[key]);

    const { workflow: current } = await call(`/workflows/${workflow.id}`);
    const third = await call(
      `/workflows/${workflow.id}/versions`,
      "POST",
      { revision: current.revision },
      engineer,
      201,
    );
    const thirdView = await call(
      `/workflows/${workflow.id}/versions/${third.version.id}/questionnaire`,
    );
    expect(
      thirdView.questions.map((q: { state: string }) => q.state).sort(),
    ).toEqual(["confirmed", "needs-reconfirmation"]);
    const reopened = thirdView.questions.find(
      (q: { state: string }) => q.state === "needs-reconfirmation",
    );
    const thirdRoot = `/workflows/${workflow.id}/versions/${third.version.id}/questionnaire`;
    await call(`${thirdRoot}/questions/${reopened.id}`, "PATCH", {
      text: reopened.text,
      topic: reopened.topic,
      targets: reopened.targets,
      rationale: reopened.rationale,
      assignees: reopened.assignees,
      priority: reopened.priority,
      revision: reopened.revision,
      evidence: [{ ...citation, versionHash: preview.hash }],
    });
    await call(
      `${thirdRoot}/questions/${reopened.id}/answer`,
      "PUT",
      {
        revision: 2,
        questionRevision: 2,
        text: "Return a signed report.",
        attachments: [cited.attachment.id],
      },
      owner,
    );
    await call(
      `${thirdRoot}/questions/${reopened.id}/submit`,
      "POST",
      { revision: 3, questionRevision: 2 },
      owner,
    );
    const input = {
      revision: 2,
      kind: "confirmed",
      facts: [
        {
          text: "Return a signed report.",
          answers: [
            { personId: inherited.facts[0].answers[0].personId, revision: 4 },
          ],
        },
      ],
    };
    const { preview: resolution } = await call(
      `${thirdRoot}/questions/${reopened.id}/resolution-preview`,
      "POST",
      input,
    );
    await call(`${thirdRoot}/questions/${reopened.id}/resolve`, "POST", {
      ...input,
      confirmed: true,
      confirmationHash: resolution.confirmationHash,
      requestId: "reconfirm-inherited-evidence",
    });
    const resolved = await call(thirdRoot);
    const currentFact = resolved.facts.find(
      (f: { questionId: string; active: boolean }) =>
        f.questionId === reopened.id && f.active,
    );
    expect(currentFact).toMatchObject({
      text: "Return a signed report.",
      origin: null,
      acknowledgements: [],
      evidenceChanges: [],
    });
    expect(
      resolved.facts.filter(
        (f: { questionId: string }) => f.questionId === reopened.id,
      ),
    ).toHaveLength(2);
    const { preview: acknowledgement } = await call(
      `${thirdRoot}/facts/${currentFact.id}/acknowledgement-preview`,
      "POST",
      { decision: "acknowledged" },
      owner,
    );
    await call(
      `${thirdRoot}/facts/${currentFact.id}/acknowledge`,
      "POST",
      {
        decision: "acknowledged",
        confirmed: true,
        confirmationHash: acknowledgement.confirmationHash,
        requestId: "ack-inherited-evidence",
      },
      owner,
    );
    expect(
      (await call(thirdRoot)).facts.find(
        (f: { id: string }) => f.id === currentFact.id,
      ).acknowledgements,
    ).toHaveLength(1);
  });

  it("keeps inherited private corrections private and enforces version creation roles and revisions", async () => {
    service = await startPlanningService();
    const fixture = await planningFixture(service);
    const { call, base, workflow } = fixture;
    const { question, attachment } = await confirmedQuestion(fixture);
    await call(
      `${base}/questionnaire/questions/${question.id}/answer`,
      "PUT",
      {
        revision: 2,
        questionRevision: 1,
        text: "Private correction, not submitted.",
        attachments: [attachment.id],
      },
      owner,
    );
    const { workflow: head } = await call(`/workflows/${workflow.id}`);
    await call(
      `/workflows/${workflow.id}/versions`,
      "POST",
      { revision: head.revision },
      owner,
      403,
    );
    const { version } = await call(
      `/workflows/${workflow.id}/versions`,
      "POST",
      { revision: head.revision },
      engineer,
      201,
    );
    await call(
      `/workflows/${workflow.id}/versions`,
      "POST",
      { revision: head.revision },
      engineer,
      409,
    );
    const root = `/workflows/${workflow.id}/versions/${version.id}/questionnaire`;
    const reader = await call(root);
    expect(reader.answers[0]).toMatchObject({
      text: "A reviewed report.",
      state: "submitted",
    });
    expect(reader.answers[0].revisions).toHaveLength(1);
    expect(reader.facts[0].active).toBe(false);
    const author = await call(root, "GET", undefined, owner);
    expect(author.answers[0]).toMatchObject({
      text: "Private correction, not submitted.",
      state: "draft",
    });
    const outsider = { subject: "outsider", email: "outside@example.com" };
    await call(root, "GET", undefined, outsider, 403);
    const download = await service.request(
      `/api/v1${root}/attachments/${attachment.id}`,
      { as: outsider },
    );
    expect(download.status).toBe(403);
  });
});
