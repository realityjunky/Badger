import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  startTestService,
  type TestPerson,
  type TestService,
} from "../src/testing/index.js";

const admin = { subject: "admin", email: "admin@example.com" };
const lead = { subject: "lead", email: "lead@example.com" };
const respondent = {
  subject: "respondent",
  email: "respondent@example.com",
  displayName: "Named respondent",
};
const outsider = { subject: "outsider", email: "outsider@example.com" };
let service: TestService;
afterEach(async () => service?.close());

async function api<T = unknown>(
  method: string,
  route: string,
  as: TestPerson,
  body?: unknown,
  status = 200,
): Promise<T> {
  const response = await service.request(`/api/v1${route}`, {
    as,
    method,
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(status);
  return value as T;
}

async function upload(
  skillId: string,
  heading = "Parcel rules",
  baseHash?: string,
) {
  const content = {
    ...(baseHash === undefined ? {} : { baseHash }),
    files: [
      {
        path: "SKILL.md",
        content: Buffer.from(
          `---\nname: parcel-rules\ndescription: Explain parcel rules\n---\n\n# ${heading}\n`,
        ).toString("base64"),
      },
    ],
  };
  const { preview } = await api<{
    preview: { hash: string; confirmationHash?: string };
  }>("POST", `/skills/${skillId}/upload-preview`, admin, content);
  const { version } = await api<{ version: { hash: string } }>(
    "POST",
    `/skills/${skillId}/versions`,
    admin,
    {
      ...content,
      confirmed: true,
      expectedHash: preview.hash,
      confirmationHash: preview.confirmationHash,
    },
    201,
  );
  return version.hash;
}

async function setup() {
  service = await startTestService({
    environment: {
      BADGER_BOOTSTRAP_ADMINISTRATORS: admin.email,
      BADGER_ALLOWED_ORIGINS: "http://localhost",
    },
  });
  const { group } = await api<{ group: { id: string } }>(
    "POST",
    "/groups",
    admin,
    { name: "Parcel operations" },
    201,
  );
  for (const [person, role] of [
    [lead, "Group lead"],
    [respondent, "Member"],
  ] as const) {
    await api(
      "POST",
      "/bindings",
      admin,
      {
        scopeType: "group",
        scopeId: group.id,
        email: person.email,
        role,
      },
      201,
    );
  }
  const { person } = await api<{ person: { id: string } }>(
    "GET",
    "/me",
    respondent,
  );
  const { skill } = await api<{ skill: { id: string } }>(
    "POST",
    "/skills",
    admin,
    { groupId: group.id, name: "parcel-rules" },
    201,
  );
  const versionHash = await upload(skill.id);
  return {
    groupId: group.id,
    skillId: skill.id,
    versionHash,
    respondentId: person.id,
    base: `/skills/${skill.id}/versions/${versionHash}/questionnaire`,
  };
}

interface QuestionRecord {
  id: string;
  revision: number;
  state: string;
  parentQuestionId: string | null;
}

async function signOff<T>(
  resource: string,
  previewAction: "resolution-preview" | "acknowledgement-preview",
  action: "resolve" | "acknowledge",
  as: TestPerson,
  decision: Record<string, unknown>,
) {
  const { preview } = await api<{ preview: { confirmationHash: string } }>(
    "POST",
    `${resource}/${previewAction}`,
    as,
    decision,
  );
  const body = {
    ...decision,
    confirmed: true,
    requestId: randomUUID(),
    confirmationHash: preview.confirmationHash,
  };
  const result = await api<T>("POST", `${resource}/${action}`, as, body);
  expect(await api<T>("POST", `${resource}/${action}`, as, body)).toEqual(
    result,
  );
  return result;
}

describe("Skill-owned Questionnaire", () => {
  it("uses the configured Administrator's library access for a named assignment", async () => {
    const { base, skillId } = await setup();
    const { person } = await api<{ person: { id: string } }>(
      "GET",
      "/me",
      admin,
    );
    const view = await api<{ assignees: { personId: string }[] }>(
      "GET",
      base,
      lead,
    );
    expect(view.assignees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ personId: person.id }),
      ]),
    );
    const { round } = await api<{ round: { id: string } }>(
      "POST",
      `${base}/rounds`,
      lead,
      { title: "Check the report" },
      201,
    );
    const roundPath = `${base}/rounds/${round.id}`;
    const { question } = await api<{ question: { id: string } }>(
      "POST",
      `${roundPath}/questions`,
      lead,
      {
        text: "Which report layout do we use?",
        topic: "scope",
        targets: [{ kind: "skill", id: skillId }],
        rationale: "Document the layout",
        evidence: [],
        assignees: [{ kind: "person", personId: person.id }],
        priority: 10,
      },
      201,
    );
    const { preview } = await api<{ preview: { confirmationHash: string } }>(
      "GET",
      `${roundPath}/publish-preview`,
      lead,
    );
    await api("POST", `${roundPath}/publish`, lead, {
      confirmed: true,
      confirmationHash: preview.confirmationHash,
    });
    const response = await api<{
      questions: { id: string; canAnswer: boolean }[];
    }>("GET", base, admin);
    expect(response.questions).toMatchObject([
      { id: question.id, canAnswer: true },
    ]);
    await api("PUT", `${base}/questions/${question.id}/answer`, admin, {
      revision: 0,
      questionRevision: 1,
      text: "Use the compact layout.",
    });
  });

  it("opens a round on an exact Skill version with no Workflow and hides drafts from readers", async () => {
    const { base, skillId, versionHash } = await setup();
    await api("GET", base, outsider, undefined, 404);
    await api(
      "POST",
      `${base}/rounds`,
      respondent,
      { title: "Parcel handling" },
      403,
    );
    const { round } = await api<{ round: { id: string } }>(
      "POST",
      `${base}/rounds`,
      lead,
      { title: "Parcel handling" },
      201,
    );
    const view = await api<{ subject: unknown; rounds: { id: string }[] }>(
      "GET",
      base,
      lead,
    );
    expect(view.subject).toMatchObject({ kind: "skill", skillId, versionHash });
    expect(view.rounds.map((item) => item.id)).toEqual([round.id]);
    const readerView = await api<{ rounds: unknown[] }>(
      "GET",
      base,
      respondent,
    );
    expect(readerView.rounds).toEqual([]);
    const catalog = await api<{ skillVersions: unknown[] }>(
      "GET",
      "/questionnaire",
      respondent,
    );
    expect(catalog.skillVersions).toEqual([
      expect.objectContaining({ skillId, versionHash }),
    ]);
  });

  it("keeps reviewed answers on the discussed version and binds a change to its saved successor", async () => {
    const { base, groupId, skillId, versionHash, respondentId } = await setup();
    const { round } = await api<{ round: { id: string } }>(
      "POST",
      `${base}/rounds`,
      lead,
      { title: "Parcel delivery rules" },
      201,
    );
    const roundPath = `${base}/rounds/${round.id}`;
    const content = {
      text: "Which parcel labels are accepted?",
      topic: "scope",
      targets: [{ kind: "skill", id: skillId }],
      rationale: "Agree the current rule for labels.",
      evidence: [
        { skillId, versionHash, path: "SKILL.md", startLine: 6, endLine: 6 },
      ],
      assignees: [{ kind: "person", personId: respondentId }],
      priority: 10,
    };
    const { person } = await api<{ person: { id: string } }>(
      "GET",
      "/me",
      outsider,
    );
    await api(
      "POST",
      `${roundPath}/questions`,
      lead,
      {
        ...content,
        assignees: [{ kind: "person", personId: person.id }],
      },
      400,
    );
    const { question } = await api<{ question: QuestionRecord }>(
      "POST",
      `${roundPath}/questions`,
      lead,
      content,
      201,
    );
    const questionPath = `${base}/questions/${question.id}`;
    const contextPath = `/questionnaire/questions/${question.id}`;
    await api("GET", contextPath, respondent, undefined, 403);
    const { preview } = await api<{ preview: { confirmationHash: string } }>(
      "GET",
      `${roundPath}/publish-preview`,
      lead,
    );
    await api("POST", `${roundPath}/publish`, lead, {
      confirmed: true,
      confirmationHash: preview.confirmationHash,
    });
    expect(await api("GET", contextPath, respondent)).toEqual({
      kind: "skill",
      skillId,
      versionHash,
    });
    await api("GET", contextPath, outsider, undefined, 404);
    const inbox = await api<{ items: { href: string; kind: string }[] }>(
      "GET",
      "/me/inbox",
      respondent,
    );
    expect(inbox.items).toContainEqual(
      expect.objectContaining({ href: contextPath, kind: "question-assigned" }),
    );
    const { answer } = await api<{ answer: { revision: number } }>(
      "PUT",
      `${questionPath}/answer`,
      respondent,
      {
        revision: 0,
        questionRevision: question.revision,
        text: "Use the delivery label from the desk.",
      },
    );
    expect(await api("GET", base, lead)).toMatchObject({ answers: [] });
    const {
      answers: [submitted],
    } = await api<{ answers: { revision: number }[] }>(
      "POST",
      `${questionPath}/submit`,
      respondent,
      {
        revision: answer.revision,
        questionRevision: question.revision,
      },
    );
    const fact = {
      text: "Accept labels issued at the delivery desk.",
      answers: [{ personId: respondentId, revision: submitted.revision }],
    };
    const clarification = {
      revision: question.revision,
      kind: "confirmed",
      facts: [fact],
      skillOutcome: { kind: "clarification" },
    };
    const reviewed = await signOff(
      questionPath,
      "resolution-preview",
      "resolve",
      lead,
      clarification,
    );
    expect(reviewed).toMatchObject({
      resolution: {
        skillOutcome: {
          kind: "clarification",
          versionHash,
          successorVersionHash: null,
          applicabilityVersionHash: versionHash,
        },
      },
    });
    const beforeDispute = await api<{
      facts: { id: string; active: boolean }[];
    }>("GET", base, respondent);
    const originalFact = beforeDispute.facts[0];
    expect(originalFact.active).toBe(true);
    await api(
      "POST",
      `${base}/facts/${originalFact.id}/acknowledgement-preview`,
      lead,
      { decision: "acknowledged" },
      403,
    );
    await signOff(
      `${base}/facts/${originalFact.id}`,
      "acknowledgement-preview",
      "acknowledge",
      respondent,
      {
        decision: "disputed",
        reason: "The text should include remote deliveries.",
      },
    );
    expect(await api("GET", base, respondent)).toMatchObject({
      questions: [{ id: question.id, state: "open" }],
      facts: [{ active: false }],
    });

    const { answer: corrected } = await api<{ answer: { revision: number } }>(
      "PUT",
      `${questionPath}/answer`,
      respondent,
      {
        revision: submitted.revision,
        questionRevision: question.revision,
        text: "Remote deliveries use a generated label.",
      },
    );
    const {
      answers: [resubmitted],
    } = await api<{ answers: { revision: number }[] }>(
      "POST",
      `${questionPath}/submit`,
      respondent,
      {
        revision: corrected.revision,
        questionRevision: question.revision,
      },
    );
    const change = {
      revision: question.revision,
      kind: "confirmed",
      facts: [
        {
          text: "Accept generated labels for remote deliveries.",
          answers: [{ personId: respondentId, revision: resubmitted.revision }],
        },
      ],
      skillOutcome: { kind: "change" },
    };
    await api(
      "POST",
      `${questionPath}/resolution-preview`,
      lead,
      {
        ...change,
        skillOutcome: { kind: "change", successorVersionHash: "0".repeat(64) },
      },
      400,
    );
    const unrelated = await upload(skillId, "Separate library upload");
    await api(
      "POST",
      `${questionPath}/resolution-preview`,
      lead,
      {
        ...change,
        skillOutcome: { kind: "change", successorVersionHash: unrelated },
      },
      400,
    );
    const reviewedChange = await signOff<{ resolution: { id: string } }>(
      questionPath,
      "resolution-preview",
      "resolve",
      lead,
      change,
    );
    expect(reviewedChange).toMatchObject({
      resolution: {
        skillOutcome: {
          kind: "change",
          versionHash,
          successorVersionHash: null,
          applicabilityVersionHash: null,
        },
      },
    });
    const final = await api<{ facts: { id: string; active: boolean }[] }>(
      "GET",
      base,
      respondent,
    );
    const currentFact = final.facts.find((item) => item.active)!;
    await signOff(
      `${base}/facts/${currentFact.id}`,
      "acknowledgement-preview",
      "acknowledge",
      respondent,
      { decision: "acknowledged" },
    );
    expect(await api("GET", base, lead)).toMatchObject({
      subject: { versionHash },
      rounds: [{ id: round.id }],
      facts: expect.arrayContaining([
        expect.objectContaining({
          id: currentFact.id,
          active: true,
          acknowledgements: [
            expect.objectContaining({ decision: "acknowledged" }),
          ],
        }),
      ]),
    });
    const successor = await upload(
      skillId,
      "Parcel rules for remote deliveries",
      versionHash,
    );
    const pinForDossier = async (name: string, hash: string) => {
      const { workflow, version } = await api<{
        workflow: { id: string };
        version: { id: string };
      }>(
        "POST",
        "/workflows",
        admin,
        {
          groupId,
          name,
          goal: "Deliver parcels",
          intent: "new-skill",
          locale: "en",
        },
        201,
      );
      const workflowPath = `/workflows/${workflow.id}/versions/${version.id}`;
      await api("POST", `${workflowPath}/pins`, admin, { skillId, hash }, 201);
      return `${workflowPath}/working-dossier`;
    };
    const originalDossier = await pinForDossier(
      "original-parcel-process",
      versionHash,
    );
    const successorDossier = await pinForDossier(
      "remote-parcel-process",
      successor,
    );
    for (const dossier of [originalDossier, successorDossier])
      expect(await api("GET", dossier, admin)).toMatchObject({
        reviewedAnswers: [],
      });
    const linkInput = {
      resolutionId: reviewedChange.resolution.id,
      successorVersionHash: successor,
    };
    const linkPreview = `${questionPath}/link-successor-preview`;
    const linkCommit = `${questionPath}/link-successor`;
    await api("POST", linkPreview, outsider, linkInput, 404);
    await api("POST", linkPreview, respondent, linkInput, 403);
    await api(
      "POST",
      linkPreview,
      lead,
      { ...linkInput, successorVersionHash: unrelated },
      400,
    );
    const prepared = await api<{ preview: { confirmationHash: string } }>(
      "POST",
      linkPreview,
      lead,
      linkInput,
    );
    expect(prepared).toMatchObject({
      preview: {
        resolutionId: reviewedChange.resolution.id,
        versionHash,
        successorVersionHash: successor,
        answers: [{ personId: respondentId, revision: resubmitted.revision }],
      },
    });
    const link = {
      ...linkInput,
      confirmed: true,
      confirmationHash: prepared.preview.confirmationHash,
      requestId: randomUUID(),
    };
    await api(
      "POST",
      linkCommit,
      lead,
      { ...link, confirmationHash: "a".repeat(64) },
      409,
    );
    await api("POST", linkCommit, respondent, link, 403);
    const [linked, replayed] = await Promise.all([
      api<{ successorLink: { id: string } }>("POST", linkCommit, lead, link),
      api("POST", linkCommit, lead, link),
    ]);
    expect(replayed).toEqual(linked);
    await api(
      "POST",
      linkCommit,
      lead,
      { ...link, successorVersionHash: unrelated },
      409,
    );
    await api("POST", linkPreview, lead, linkInput, 409);
    await api(
      "POST",
      `/skills/${skillId}/versions/${successor}/questionnaire/questions/${question.id}/link-successor-preview`,
      lead,
      linkInput,
      404,
    );
    expect(
      await api("GET", "/audit-events?action=question.successor_linked", admin),
    ).toMatchObject({
      events: [
        {
          channel: "web",
          targetId: question.id,
          after: { hash: prepared.preview.confirmationHash },
        },
      ],
    });
    expect(await api("GET", originalDossier, admin)).toMatchObject({
      reviewedAnswers: [],
    });
    expect(await api("GET", successorDossier, admin)).toMatchObject({
      reviewedAnswers: [
        {
          questionId: question.id,
          personId: respondentId,
          revision: resubmitted.revision,
        },
      ],
    });
    expect(await api("GET", base, respondent)).toMatchObject({
      resolutions: expect.arrayContaining([
        expect.objectContaining({
          id: reviewedChange.resolution.id,
          skillOutcome: expect.objectContaining({
            applicabilityVersionHash: successor,
            successorLink: expect.objectContaining({
              id: linked.successorLink.id,
            }),
          }),
        }),
      ]),
      facts: expect.arrayContaining([
        expect.objectContaining({ id: currentFact.id, active: true }),
      ]),
    });
    const successorPath = `/skills/${skillId}/versions/${successor}/questionnaire`;
    expect(await api("GET", successorPath, lead)).toMatchObject({
      rounds: [],
      subject: { versionHash: successor },
    });
    await api(
      "PUT",
      `${successorPath}/questions/${question.id}/answer`,
      respondent,
      {
        revision: 0,
        questionRevision: question.revision,
        text: "Wrong subject",
      },
      404,
    );
    const successorVersion = successorPath.replace(/\/questionnaire$/u, "");
    expect(await api("GET", `${successorVersion}/removal`, lead)).toEqual({
      action: "retire",
      referenced: true,
    });
    await api("DELETE", successorVersion, lead, { action: "delete" }, 409);
    await api("DELETE", successorVersion, lead, { action: "retire" });
    expect(await api("GET", contextPath, respondent)).toEqual({
      kind: "skill",
      skillId,
      versionHash,
    });
    expect(await api("GET", base, respondent)).toMatchObject({
      resolutions: expect.arrayContaining([
        expect.objectContaining({
          skillOutcome: expect.objectContaining({
            successorVersionHash: successor,
          }),
        }),
      ]),
    });
  });

  it("serializes opening a Skill round with deletion of its exact version", async () => {
    const { base, versionHash } = await setup();
    const versionPath = base.replace(/\/questionnaire$/u, "");
    const send = (method: string, route: string, body: unknown) =>
      service.request(`/api/v1${route}`, {
        as: lead,
        method,
        headers: {
          "content-type": "application/json",
          origin: "http://localhost",
        },
        body: JSON.stringify(body),
      });
    const [created, removed] = await Promise.all([
      send("POST", `${base}/rounds`, { title: "Parcel requirements" }),
      send("DELETE", versionPath, { action: "delete" }),
    ]);
    expect([
      [201, 409],
      [404, 200],
    ]).toContainEqual([created.status, removed.status]);
    if (created.ok) {
      await api("DELETE", versionPath, lead, { action: "retire" });
      await api(
        "POST",
        `${base}/rounds`,
        lead,
        { title: "Historical clarification" },
        201,
      );
      expect(await api("GET", base, respondent)).toMatchObject({
        subject: { versionHash, retiredAt: expect.any(String) },
      });
    } else await api("GET", base, respondent, undefined, 404);
  });
});
