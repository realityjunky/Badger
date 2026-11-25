import {
  applyWorkingDossierEdit,
  canonicalHash,
  createQuestionnaireHandoff,
  dossierFieldId,
  dossierFieldOwners,
  emptyWorkingDossier,
  projectWorkingDossier,
  workingDossierCitations,
  workingDossierEditFinding,
  WORKING_DOSSIER_EDIT_SCHEMA,
  WORKING_DOSSIER_FIELDS,
  WORKING_DOSSIER_INSTRUCTIONS,
  type DossierAnswerChoice,
  type DossierEvidence,
  type DossierJobPin,
  type DossierRestatementChoice,
  type WorkingDossierEdit,
  type WorkingDossierJob,
  type WorkingDossierView,
} from "@realityjunky/badger";
import { Ajv } from "ajv";
import type { Queryable } from "./database/database.js";
import type { ServiceDependencies } from "./dependencies.js";
import { recordAudit, type WriteContext } from "./audit.js";
import {
  hasLegacyAuthoring,
  lockDossierSkillAnswers,
  readWorkingRevision,
} from "./working-dossier-store.js";
import { listWorkflowPins, readSourceCheck } from "./workflow-source.js";
import { readVersion } from "./skills/library.js";
import { evidenceLines, parseSourceEvidence } from "./source-study.js";
import type { BlobStore } from "./skills/blobs.js";
import { readQuestionnaireInputs } from "./questionnaire/ledger.js";
import { listReviewedSkillAnswers } from "./questionnaire/skill-decisions.js";
import type { QuestionContent, QuestionTarget } from "./questionnaire/model.js";
import { evidenceComparison } from "./evidence-changes.js";
import { objectInput, RequestError } from "./http/errors.js";
import { readWorkflow, type WorkflowVersion } from "./workflows.js";
import {
  workflowVersionLabel,
  type WorkflowVersionLabel,
} from "./workflow-version-labels.js";

type LabeledWorkflowVersion = WorkflowVersion & WorkflowVersionLabel;

const validateEdit = new Ajv().compile<WorkingDossierEdit>(
  WORKING_DOSSIER_EDIT_SCHEMA,
);
export const MAX_DOSSIER_EDIT_BYTES = 512 * 1024;
const CHUNK_BYTES = 256 * 1024;
const MAX_BATCH_BYTES = 4 * CHUNK_BYTES;
const MAX_BATCH_FILES = 32;

export const workingDossierReviewUrl = (
  workflowId: string,
  versionId: string,
) =>
  `workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(versionId)}?stage=source-study`;

export async function workingDossierBasis(tx: Queryable, versionId: string) {
  const check = await readSourceCheck(tx, versionId);
  const allPins = await listWorkflowPins(tx, versionId);
  const pins = allPins.map((pin) => ({
    skillId: pin.skillId,
    name: pin.skillName,
    hash: pin.hash,
  }));
  const pinsHash = check?.pinsHash ?? canonicalHash([]);
  const available =
    check?.status === "passed" &&
    pins.length > 0 &&
    pins.every((pin) =>
      check.sources.some(
        (source) =>
          source.name === pin.name &&
          source.hash === pin.hash &&
          source.status === "available",
      ),
    );
  const revision = await readWorkingRevision(tx, versionId);
  return {
    revision,
    pins,
    pinsHash,
    available,
    legacy: revision === null && (await hasLegacyAuthoring(tx, versionId)),
  };
}

function targetFields(targets: QuestionTarget[]) {
  return targets.flatMap((target) =>
    target.kind === "field"
      ? [target.id]
      : target.kind === "interface"
        ? WORKING_DOSSIER_FIELDS.interface.map(({ key }) =>
            dossierFieldId("interface", target.id, key),
          )
        : [],
  );
}

function reviewedDossierRecords(
  {
    records,
    questions,
    answers,
  }: Awaited<ReturnType<typeof readQuestionnaireInputs>>,
  acknowledgedFacts: ReadonlySet<string>,
) {
  const reviewedFacts =
    records.facts?.filter((fact) => fact.active && fact.current) ?? [];
  const choices = new Map<string, DossierAnswerChoice>();
  const restatements = new Map<string, DossierRestatementChoice>();
  for (const fact of reviewedFacts) {
    const question = questions.find(({ id }) => id === fact.questionId);
    if (
      !question ||
      question.state !== "confirmed" ||
      fact.acknowledgements.some(({ decision }) => decision === "disputed")
    )
      continue;
    const fields = targetFields(question.targets);
    if (!fields.length) continue;
    const sources = [];
    for (const link of fact.answers) {
      const answer = answers.find(
        (item) =>
          item.questionId === question.id && item.personId === link.personId,
      );
      const current = answer?.revisions
        .filter((item) => item.state === "submitted")
        .at(-1);
      if (
        current?.revision !== link.revision ||
        current.questionRevision !== question.revision
      )
        continue;
      const source = {
        questionId: question.id,
        resolutionRevision: fact.resolutionRevision,
        personId: link.personId,
        revision: link.revision,
      };
      choices.set(`${question.id}/${link.personId}/${link.revision}`, {
        ...source,
        text: current.text,
        fields,
      });
      sources.push(source);
    }
    if (
      acknowledgedFacts.has(fact.id) &&
      sources.length === fact.answers.length
    )
      restatements.set(fact.id, {
        id: fact.id,
        text: fact.statement,
        answers: sources,
      });
  }
  return { reviewedAnswers: [...choices.values()], restatements };
}

export async function readWorkingDossier(
  tx: Queryable,
  version: WorkflowVersion & Partial<WorkflowVersionLabel>,
  personId: string,
  editable: boolean,
): Promise<WorkingDossierView> {
  const basis = await workingDossierBasis(tx, version.id);
  const content = basis.revision?.content ?? emptyWorkingDossier();
  const inputs = await readQuestionnaireInputs(tx, version.id, personId, false);
  const handoff = createQuestionnaireHandoff({ records: inputs.records });
  const acknowledgedFacts = new Set(
    handoff.ledger.confirmedUserFacts.map((fact) => fact.record.id),
  );
  const { reviewedAnswers, restatements } = reviewedDossierRecords(
    inputs,
    acknowledgedFacts,
  );
  const workflow = basis.pins.length
    ? await readWorkflow(tx, version.workflowId)
    : null;
  if (workflow) {
    // Every workflow reader has library access in its Group. Pins and
    // reusable decisions both resolve in that exact Group.
    const decisions = await listReviewedSkillAnswers(
      tx,
      workflow.groupId,
      basis.pins,
    );
    const fields = dossierFieldOwners(content, basis.pins).flatMap(
      ({ scope, id }) =>
        WORKING_DOSSIER_FIELDS[scope].map(({ key }) =>
          dossierFieldId(scope, id, key),
        ),
    );
    for (const decision of decisions) {
      const { questionId, resolutionRevision, personId, revision } = decision;
      const source = { questionId, resolutionRevision, personId, revision };
      reviewedAnswers.push({
        ...source,
        text: decision.text,
        fields,
        skill: {
          name: basis.pins.find((pin) => pin.skillId === decision.skillId)!
            .name,
          versionHash: decision.versionHash,
        },
      });
      for (const fact of decision.restatements) {
        const restatement = restatements.get(fact.id);
        if (restatement) restatement.answers.push(source);
        else restatements.set(fact.id, { ...fact, answers: [source] });
      }
    }
  }
  const compare = await evidenceComparison(tx, version.id);
  const changes = await compare(
    workingDossierCitations(content).map(
      ({ skillId, hash, path, fileHash }) => ({
        skillId,
        versionHash: hash,
        path,
        fileHash,
      }),
    ),
  );
  const projection = projectWorkingDossier(
    content,
    basis.pins,
    reviewedAnswers,
    changes,
  );
  const reviewUrl = workingDossierReviewUrl(version.workflowId, version.id);
  const ids = JSON.stringify({
    workflowId: version.workflowId,
    versionId: version.id,
  });
  return {
    available: basis.available,
    legacy: basis.legacy,
    editable,
    revision: basis.revision?.revision ?? 0,
    pinsHash: basis.pinsHash,
    pins: basis.pins,
    content,
    reviewedAnswers,
    reviewedRestatements: [...restatements.values()],
    questions: inputs.questions.flatMap(({ id, text, state, targets }) => {
      const fields = targetFields(targets);
      return fields.length && (editable || state !== "draft")
        ? [{ id, text, state, fields }]
        : [];
    }),
    projection,
    reviewUrl,
    readiness: handoff.readiness.map(({ topic, blockers }) => ({
      topic,
      blockers: [
        ...projection.fields
          .filter((entry) => entry.topic === topic && entry.blocker)
          .map((entry) => ({
            id: entry.id,
            message: `${entry.ownerLabel} · ${entry.label} — ${entry.blocker}`,
          })),
        ...blockers.map((blocker) => {
          const item = handoff.items.find(
            ({ record }) =>
              record.type === blocker.record?.type &&
              record.id === blocker.record?.id,
          );
          const message =
            item?.state === "draft" && !editable
              ? "A draft Question needs review"
              : item?.statement;
          return {
            id:
              item?.state === "draft" && !editable
                ? topic
                : (blocker.record?.id ?? topic),
            message: message ?? blocker.code,
          };
        }),
      ],
    })),
    prompt:
      editable && basis.available && !basis.legacy
        ? `Study the pinned Skills for ${version.name} version ${workflowVersionLabel(version)}.

Call Badger MCP working_dossier_job with ${ids}. Read its current revision, complete pin inventory, field definitions and edit schema.

Call working_dossier_sources with those IDs and the job's dossier.pinsHash. Omit both local path options by default. Badger MCP will fetch the exact pinned files from Badger. If the user gives you local Skill paths accessible to Badger MCP, use localSourceRoot for a parent folder with subfolders named after the Skills, or use localSkillRoots to map each Skill ID to its folder. Badger MCP reuses files that match the pins and downloads the rest. Read the returned localPath for each file.

${WORKING_DOSSIER_INSTRUCTIONS}

Use save_working_dossier with those IDs and an edit matching the job schema. Quote its revision and pinsHash and choose a stable editId for each edit. For an unchanged retry reuse the same editId and body. If the revision conflicts, reload the job and reconcile the edits with the current dossier.`
        : null,
  };
}

export async function validateDossierQuestionTargets(
  tx: Queryable,
  versionId: string,
  question: QuestionContent,
) {
  const targets = question.targets.filter(
    ({ kind }) => kind === "field" || kind === "interface",
  );
  if (!targets.length) return;
  const basis = await workingDossierBasis(tx, versionId);
  if (!basis.revision && targets.every(({ kind }) => kind === "interface"))
    return;
  const projection = projectWorkingDossier(
    basis.revision?.content ?? emptyWorkingDossier(),
    basis.pins,
    [],
  );
  for (const target of targets) {
    if (!basis.revision && target.kind === "interface") continue;
    if (
      !projection.fields.some(
        (field) =>
          (target.kind === "field"
            ? field.id === target.id
            : field.scope === "interface" && field.owner === target.id) &&
          field.topic === question.topic,
      )
    )
      throw new RequestError(
        400,
        "Choose a current dossier field or handoff in the Question's topic",
      );
  }
}

export async function workingDossierJob(
  tx: Queryable,
  version: LabeledWorkflowVersion,
  personId: string,
): Promise<WorkingDossierJob> {
  const view = await readWorkingDossier(tx, version, personId, true);
  requireWorkingDossier(view);
  const { revision, pinsHash, pins, content, reviewedAnswers, reviewUrl } =
    view;
  return {
    workflow: {
      id: version.workflowId,
      versionId: version.id,
      number: version.number,
      versionLabel: workflowVersionLabel(version),
      name: version.name,
      goal: version.goal,
    },
    dossier: { revision, pinsHash, pins, content },
    pins: await Promise.all(
      pins.map(async (pin) => ({
        ...pin,
        inventory: (await readVersion(tx, pin.skillId, pin.hash)).inventory,
      })),
    ),
    fields: WORKING_DOSSIER_FIELDS,
    schema: WORKING_DOSSIER_EDIT_SCHEMA,
    reviewedAnswers,
    instructions: WORKING_DOSSIER_INSTRUCTIONS,
    reviewUrl,
  };
}

function requireWorkingDossier(view: { available: boolean; legacy: boolean }) {
  if (view.legacy)
    throw new RequestError(
      409,
      "This workflow has an existing dossier authoring history",
    );
  if (!view.available)
    throw new RequestError(
      409,
      "Wait for the selected pin set to pass its source check",
    );
}

export async function saveWorkingDossier(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  blobs: BlobStore,
  version: LabeledWorkflowVersion,
  input: unknown,
) {
  if (!validateEdit(input)) {
    const error = validateEdit.errors?.[0];
    const location = error?.instancePath || "/";
    const detail =
      error?.keyword === "additionalProperties"
        ? "contains an unknown property"
        : error?.message;
    throw new RequestError(
      400,
      detail
        ? `Working dossier edit ${location} ${detail}`
        : "Use the working dossier edit schema",
    );
  }
  const edit = input;
  const editHash = canonicalHash(edit);
  if (edit.fields) await lockDossierSkillAnswers(tx, version.id, edit.fields);
  const view = await readWorkingDossier(tx, version, context.personId, true);
  const replay = (
    await tx.query<{ revision: number; edit_hash: string }>(
      "select revision, edit_hash from working_dossier_revisions where workflow_version_id = $1 and edit_id = $2",
      [version.id, edit.editId],
    )
  ).rows[0];
  if (replay) {
    if (replay.edit_hash !== editHash)
      throw new RequestError(
        409,
        "This edit ID was already used for a different edit",
        { currentRevision: view.revision },
      );
    return { ...view, savedRevision: replay.revision, newRevision: false };
  }
  requireWorkingDossier(view);
  if (edit.revision !== view.revision || edit.pinsHash !== view.pinsHash)
    throw new RequestError(
      409,
      "The dossier revision or pins changed. Reload the job and reconcile your edit.",
      {
        currentRevision: view.revision,
        pinsHash: view.pinsHash,
      },
    );
  const content = applyWorkingDossierEdit(view.content, edit);
  if (
    context.credential.kind === "token" &&
    Object.values(edit.fields ?? {}).some(
      (value) => value?.state === "decision" && !value.answers?.length,
    )
  )
    throw new RequestError(
      403,
      "Link a reviewed Answer when applying a decision through MCP",
    );
  const finding = workingDossierEditFinding(
    content,
    edit,
    view.pins,
    view.reviewedAnswers,
  );
  if (finding) throw new RequestError(400, finding);
  const citations = workingDossierCitations(
    applyWorkingDossierEdit(emptyWorkingDossier(), edit),
  );
  const pinHashes = new Map(view.pins.map((pin) => [pin.skillId, pin.hash]));
  const unique = new Map(
    citations.map((citation) => [canonicalHash(citation), citation]),
  );
  for (const citation of unique.values()) {
    if (pinHashes.get(citation.skillId) !== citation.hash)
      throw new RequestError(
        409,
        "Use evidence from the exact Skill version pinned in this dossier",
      );
    await evidenceLines(tx, blobs, parseSourceEvidence(citation));
  }
  const revision = view.revision + 1;
  await tx.query(
    `insert into working_dossier_revisions
      (workflow_version_id, revision, edit_id, edit_hash, pins_hash, pins, content, saved_by, saved_at)
      values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)`,
    [
      version.id,
      revision,
      edit.editId,
      editHash,
      view.pinsHash,
      JSON.stringify(view.pins),
      JSON.stringify(content),
      context.personId,
      deps.clock.now(),
    ],
  );
  await recordAudit(tx, deps, {
    actor: context,
    channel: context.channel,
    action: "working_dossier.saved",
    target: { type: "workflow_version", id: version.id },
    before:
      view.revision === 0
        ? null
        : { revision: view.revision, hash: canonicalHash(view.content) },
    after: { revision, hash: canonicalHash(content) },
    reason: "Saved a working dossier revision",
    requestId: context.requestId,
  });
  return {
    ...(await readWorkingDossier(tx, version, context.personId, true)),
    savedRevision: revision,
    newRevision: true,
  };
}

export async function workingDossierEvidence(
  tx: Queryable,
  blobs: BlobStore,
  versionId: string,
  revision: number,
  evidence: DossierEvidence,
) {
  const saved = await readWorkingRevision(tx, versionId, revision);
  if (
    !saved ||
    !workingDossierCitations(saved.content).some(
      (citation) => canonicalHash(citation) === canonicalHash(evidence),
    )
  )
    throw new RequestError(404, "No such evidence in this dossier revision");
  return evidenceLines(tx, blobs, evidence);
}

export async function workingDossierFiles(
  tx: Queryable,
  blobs: BlobStore,
  version: WorkflowVersion,
  input: unknown,
) {
  const body = objectInput(input);
  if (
    !Array.isArray(body.files) ||
    !body.files.length ||
    body.files.length > MAX_BATCH_FILES
  )
    throw new RequestError(400, "Request 1 to 32 file ranges");
  const basis = await workingDossierBasis(tx, version.id);
  requireWorkingDossier(basis);
  if (body.pinsHash !== basis.pinsHash)
    throw new RequestError(
      409,
      "The pin set changed. Read the current working dossier job.",
    );
  const pins = new Map<string, DossierJobPin>();
  const requests = [];
  let total = 0;
  for (const request of body.files) {
    const coord = objectInput(request);
    const { skillId, path, offset = 0, length = CHUNK_BYTES } = coord;
    if (
      typeof skillId !== "string" ||
      typeof path !== "string" ||
      typeof offset !== "number" ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > CHUNK_BYTES
    )
      throw new RequestError(
        400,
        "Use a pinned Skill, relative path and a file range up to 256 KiB",
      );
    let pin = pins.get(skillId);
    if (!pin) {
      const selected = basis.pins.find((entry) => entry.skillId === skillId);
      if (!selected)
        throw new RequestError(404, "No such pin in the working dossier job");
      pin = {
        ...selected,
        inventory: (await readVersion(tx, skillId, selected.hash)).inventory,
      };
      pins.set(skillId, pin);
    }
    const file = pin.inventory.find((entry) => entry.path === path);
    if (!file)
      throw new RequestError(404, "No such file in the pinned inventory");
    if (offset > file.bytes)
      throw new RequestError(400, "The requested offset is beyond the file");
    const size = Math.min(length, file.bytes - offset);
    total += size;
    if (total > MAX_BATCH_BYTES)
      throw new RequestError(
        413,
        "Request at most 1 MiB of file bytes per batch",
      );
    requests.push({ skillId, file, offset, size, index: requests.length });
  }
  const files = [];
  let loaded: { hash: string; bytes: Buffer } | undefined;
  for (const { skillId, file, offset, size, index } of requests.sort(
    (left, right) => left.file.hash.localeCompare(right.file.hash),
  )) {
    if (loaded?.hash !== file.hash) {
      const bytes = await blobs.get(file.hash);
      loaded = { hash: file.hash, bytes };
    }
    files[index] = {
      skillId,
      ...file,
      offset,
      content: loaded.bytes.subarray(offset, offset + size).toString("base64"),
    };
  }
  return { files };
}
