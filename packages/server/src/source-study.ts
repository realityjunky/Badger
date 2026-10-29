import { canonicalHash } from "@realityjunky/badger";
import { recordAudit, type WriteContext } from "./audit.js";
import type { Database, Queryable } from "./database/database.js";
import type { ServiceDependencies } from "./dependencies.js";
import { objectInput, RequestError } from "./http/errors.js";
import { readVersion } from "./skills/library.js";
import type { BlobStore } from "./skills/blobs.js";
import { toIsoString } from "./util.js";
import { listWorkflowPins, type WorkflowSkillPin } from "./workflow-source.js";
import { readGateConfirmations } from "./gates.js";
import {
  invalidateStudyGates,
  studyGateName,
} from "./source-study-invalidation.js";

export interface StudySkill {
  skillId: string;
  hash: string;
}
export interface SourceEvidence extends StudySkill {
  path: string;
  startLine: number;
  endLine: number;
  fileHash: string;
}
export interface SourceFact {
  statement: string;
  evidence: SourceEvidence[];
}
export interface SkillInterface {
  producer: StudySkill;
  consumer: StudySkill;
  artifact: string;
  columns: string[];
  naming: string;
  validation: string;
  evidence: SourceEvidence[];
}
export type StudyKind = "fact" | "interface";
export type StudyContent = SourceFact | SkillInterface;
export interface StudyRecord {
  id: string;
  workflowVersionId: string;
  kind: StudyKind;
  revision: number;
  status: "active" | "retired";
  content: StudyContent;
  stale: boolean;
  createdAt: string;
  updatedAt: string;
}
interface RecordRow {
  id: string;
  workflow_version_id: string;
  kind: StudyKind;
  revision: number;
  status: "active" | "retired";
  content: StudyContent;
  created_at: Date | string;
  updated_at: Date | string;
}
function text(value: unknown, name: string, max = 4000): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max)
    throw new RequestError(
      400,
      `${name} must be text of 1 to ${max} characters`,
    );
  return value.trim();
}
function fields(value: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new RequestError(400, `Unknown field ${key}`);
}
function hash(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    throw new RequestError(400, `${name} must be a SHA-256 hash`);
  return value;
}
function skillRef(input: unknown): StudySkill {
  const value = objectInput(input);
  fields(value, ["skillId", "hash"]);
  return {
    skillId: text(value.skillId, "skillId", 200),
    hash: hash(value.hash, "hash"),
  };
}
export function parseStudyContent(
  kind: StudyKind,
  input: unknown,
): StudyContent {
  const value = objectInput(input);
  fields(
    value,
    kind === "fact"
      ? ["statement", "evidence"]
      : [
          "producer",
          "consumer",
          "artifact",
          "columns",
          "naming",
          "validation",
          "evidence",
        ],
  );
  if (
    !Array.isArray(value.evidence) ||
    value.evidence.length === 0 ||
    value.evidence.length > 50
  )
    throw new RequestError(400, "evidence must contain 1 to 50 citations");
  const evidence = value.evidence.map((input): SourceEvidence => {
    const citation = objectInput(input);
    fields(citation, [
      "skillId",
      "hash",
      "path",
      "startLine",
      "endLine",
      "fileHash",
    ]);
    const start = citation.startLine;
    const end = citation.endLine;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      (start as number) < 1 ||
      (end as number) < (start as number) ||
      (end as number) - (start as number) >= 1000
    )
      throw new RequestError(
        400,
        "Cite a range of 1 to 1000 lines starting at line 1 or later",
      );
    return {
      skillId: text(citation.skillId, "skillId", 200),
      hash: hash(citation.hash, "hash"),
      path: text(citation.path, "path", 1000),
      fileHash: hash(citation.fileHash, "fileHash"),
      startLine: start as number,
      endLine: end as number,
    };
  });
  if (kind === "fact")
    return { statement: text(value.statement, "statement", 8000), evidence };
  if (!Array.isArray(value.columns) || value.columns.length > 100)
    throw new RequestError(
      400,
      "columns must be an array of at most 100 column names",
    );
  return {
    producer: skillRef(value.producer),
    consumer: skillRef(value.consumer),
    artifact: text(value.artifact, "artifact"),
    columns: value.columns.map((v) => text(v, "column", 256)),
    naming: text(value.naming, "naming"),
    validation: text(value.validation, "validation"),
    evidence,
  };
}
export function studyReferences(content: StudyContent): StudySkill[] {
  return [
    ...content.evidence,
    ...("producer" in content ? [content.producer, content.consumer] : []),
  ];
}
function pinned(pins: WorkflowSkillPin[], ref: StudySkill): boolean {
  return pins.some(
    (pin) => pin.skillId === ref.skillId && pin.hash === ref.hash,
  );
}
function record(row: RecordRow, pins: WorkflowSkillPin[]): StudyRecord {
  return {
    id: row.id,
    workflowVersionId: row.workflow_version_id,
    kind: row.kind,
    revision: row.revision,
    status: row.status,
    content: row.content,
    stale: studyReferences(row.content).some((ref) => !pinned(pins, ref)),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}
export async function studyRecords(
  database: Queryable,
  versionId: string,
): Promise<StudyRecord[]> {
  const rows = await database.query<RecordRow>(
    "select * from source_study_records where workflow_version_id = $1 order by id",
    [versionId],
  );
  const pins = await listWorkflowPins(database, versionId);
  return rows.rows.map((row) => record(row, pins));
}
export async function readSourceStudy(database: Queryable, versionId: string) {
  const records = await studyRecords(database, versionId);
  const pins = await listWorkflowPins(database, versionId);
  const studies = await Promise.all(
    pins.map(async (pin) => {
      const confirmations = await readGateConfirmations(
        database,
        versionId,
        studyGateName(pin.skillId),
      );
      const confirmation = confirmations[0] ?? null;
      return {
        ...pin,
        studied: confirmation !== null && confirmation.invalidatedAt === null,
        confirmation,
      };
    }),
  );
  return {
    facts: records.filter((r) => r.kind === "fact"),
    interfaces: records.filter((r) => r.kind === "interface"),
    studies,
  };
}
export async function evidenceLines(
  database: Queryable,
  blobs: BlobStore,
  evidence: SourceEvidence,
) {
  const version = await readVersion(database, evidence.skillId, evidence.hash);
  const file = version.inventory.find((entry) => entry.path === evidence.path);
  if (file === undefined)
    throw new RequestError(400, "The cited path is not in this Skill version");
  if (file.hash !== evidence.fileHash)
    throw new RequestError(
      409,
      "The cited file hash does not match this Skill version",
    );
  const bytes = await blobs.get(file.hash);
  let content: string;
  try {
    if (bytes.includes(0)) throw new Error("Binary file");
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RequestError(400, "Evidence must cite a UTF-8 text file");
  }
  const lines = content.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  if (evidence.endLine > lines.length)
    throw new RequestError(
      400,
      "The cited line range extends beyond this file",
    );
  const selected = lines.slice(evidence.startLine - 1, evidence.endLine);
  if (Buffer.byteLength(selected.join("\n")) > 256 * 1024)
    throw new RequestError(
      413,
      "Cite a smaller range of lines (at most 256 KiB)",
    );
  return {
    evidence,
    lines: selected.map((line, index) => ({
      number: evidence.startLine + index,
      text: line,
    })),
  };
}
export async function studyRevisions(database: Queryable, recordId: string) {
  const result = await database.query<{
    revision: number;
    status: string;
    content: StudyContent;
    actor_id: string;
    recorded_at: Date | string;
  }>(
    "select revision, status, content, actor_id, recorded_at from source_study_revisions where record_id = $1 order by revision",
    [recordId],
  );
  return result.rows.map((row) => ({
    revision: row.revision,
    status: row.status,
    content: row.content,
    actorId: row.actor_id,
    recordedAt: toIsoString(row.recorded_at),
  }));
}
export async function saveStudyRecord(
  database: Database,
  dependencies: ServiceDependencies,
  context: WriteContext,
  blobs: BlobStore,
  versionId: string,
  kind: StudyKind,
  change: { id?: string; revision?: number; content: StudyContent | null },
) {
  return database.transaction(async (tx) => {
    await tx.query(
      "select id from workflow_versions where id = $1 for update",
      [versionId],
    );
    const pins = await listWorkflowPins(tx, versionId);
    const previous =
      change.id === undefined
        ? undefined
        : (await studyRecords(tx, versionId)).find(
            (r) => r.id === change.id && r.kind === kind,
          );
    if (change.id !== undefined && previous === undefined)
      throw new RequestError(404, "No such source study record");
    if (
      previous !== undefined &&
      (previous.revision !== change.revision || previous.status === "retired")
    )
      throw new RequestError(
        409,
        "The source study record changed or was retired; read it again",
        { record: previous },
      );
    const content = change.content ?? previous!.content;
    const status = change.content === null ? "retired" : "active";
    const revision = (previous?.revision ?? 0) + 1;
    if (status === "active") {
      if (studyReferences(content).some((ref) => !pinned(pins, ref)))
        throw new RequestError(
          409,
          "Evidence and interface endpoints must name currently pinned Skill versions",
        );
      for (const evidence of content.evidence)
        await evidenceLines(tx, blobs, evidence);
    }
    const now = dependencies.clock.now();
    const result =
      previous === undefined
        ? await tx.query<RecordRow>(
            `insert into source_study_records
      (id, workflow_version_id, kind, revision, status, content, created_at, updated_at)
      values ($1, $2, $3, 1, 'active', $4::jsonb, $5, $5) returning *`,
            [
              dependencies.ids.next(),
              versionId,
              kind,
              JSON.stringify(content),
              now,
            ],
          )
        : await tx.query<RecordRow>(
            `update source_study_records set revision = $2, status = $3, content = $4::jsonb, updated_at = $5 where id = $1 returning *`,
            [previous.id, revision, status, JSON.stringify(content), now],
          );
    const row = result.rows[0]!;
    await tx.query(
      `insert into source_study_revisions (record_id, revision, status, content, actor_id, recorded_at)
      values ($1, $2, $3, $4::jsonb, $5, $6)`,
      [
        row.id,
        revision,
        status,
        JSON.stringify(content),
        context.personId,
        now,
      ],
    );
    await invalidateStudyGates(
      tx,
      dependencies,
      context,
      versionId,
      "Source study records changed",
      [
        ...studyReferences(content),
        ...(previous === undefined ? [] : studyReferences(previous.content)),
      ].map((ref) => ref.skillId),
    );
    const current = await tx.query<{ stages: Record<string, string> }>(
      "select stages from workflow_versions where id = $1",
      [versionId],
    );
    const stages = current.rows[0]!.stages;
    let later = false;
    for (const id of Object.keys(stages)) {
      // JSONB object order is not the order of the stage track.
      if (
        [
          "questionnaire",
          "dossier",
          "plan-proposal",
          "package",
          "evaluation",
          "review-publication",
        ].includes(id) &&
        stages[id] !== "todo"
      ) {
        stages[id] = "invalidated";
        later = true;
      }
    }
    if (stages.sources === "done") stages["source-study"] = "active";
    else if (stages["source-study"] !== "todo")
      stages["source-study"] = "invalidated";
    if (later || stages.sources === "done")
      await tx.query(
        "update workflow_versions set stages = $2::jsonb, revision = revision + 1, updated_at = $3 where id = $1",
        [versionId, JSON.stringify(stages), now],
      );
    await recordAudit(tx, dependencies, {
      actor: { personId: context.personId, credential: context.credential },
      channel: context.channel,
      action: `source_${kind}.${previous === undefined ? "created" : status === "retired" ? "retired" : "updated"}`,
      target: {
        type: `source_${kind}`,
        id: row.id,
        label: ("statement" in content
          ? content.statement
          : content.artifact
        ).slice(0, 200),
      },
      before:
        previous === undefined
          ? null
          : {
              revision: previous.revision,
              hash: canonicalHash({
                status: previous.status,
                content: previous.content,
              }),
            },
      after: { revision, hash: canonicalHash({ status, content }) },
      reason: `Source study ${kind} ${status === "retired" ? "retired" : "recorded"}`,
      requestId: context.requestId,
    });
    return record(row, pins);
  });
}
