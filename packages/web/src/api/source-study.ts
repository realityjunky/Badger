import {
  read,
  write,
  type GateConfirmation,
  type GatePreview,
  type WorkflowSkillPin,
} from "./workflows.js";
import type { EvidenceChange, RecordOrigin } from "./version-changes.js";

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
interface RecordFields {
  evidenceChanges?: EvidenceChange[];
  origin?: RecordOrigin | null;
  id: string;
  revision: number;
  status: "active" | "retired";
  stale: boolean;
}
export type StudyRecord = RecordFields &
  (
    | { kind: "fact"; content: SourceFact }
    | { kind: "interface"; content: SkillInterface }
  );
export interface StudyRevision {
  revision: number;
  status: string;
  content: SourceFact | SkillInterface;
  actorId: string;
  recordedAt: string;
}
export interface SourceStudy {
  facts: StudyRecord[];
  interfaces: StudyRecord[];
  studies: (WorkflowSkillPin & {
    studied: boolean;
    confirmation: GateConfirmation | null;
  })[];
}
export interface EvidencePreview {
  evidence: SourceEvidence;
  lines: { number: number; text: string }[];
}
export function studyPath(workflowId: string, versionId: string) {
  return `/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(versionId)}`;
}
export function recordPath(
  base: string,
  kind: StudyRecord["kind"],
  id?: string,
) {
  return `${base}/source-study/${kind === "fact" ? "facts" : "interfaces"}${id === undefined ? "" : `/${encodeURIComponent(id)}`}`;
}
export function saveRecord(
  basePath: string,
  base: string,
  kind: StudyRecord["kind"],
  content: SourceFact | SkillInterface,
  previous?: StudyRecord,
) {
  return write<{ record: StudyRecord }>(
    basePath,
    previous === undefined ? "POST" : "PATCH",
    recordPath(base, kind, previous?.id),
    {
      ...content,
      ...(previous === undefined ? {} : { revision: previous.revision }),
    },
  );
}
export function retireRecord(
  basePath: string,
  base: string,
  record: StudyRecord,
) {
  return write<{ record: StudyRecord }>(
    basePath,
    "DELETE",
    recordPath(base, record.kind, record.id),
    { revision: record.revision },
  );
}
export function loadRecord(
  basePath: string,
  base: string,
  record: StudyRecord,
  signal?: AbortSignal,
) {
  return read<{ record: StudyRecord; revisions: StudyRevision[] }>(
    basePath,
    recordPath(base, record.kind, record.id),
    signal,
  );
}
export function loadEvidence(
  basePath: string,
  base: string,
  record: StudyRecord,
  revision: number,
  index: number,
  signal?: AbortSignal,
) {
  return read<EvidencePreview>(
    basePath,
    `${recordPath(base, record.kind, record.id)}/evidence/${index}?revision=${revision}`,
    signal,
  );
}
export function previewStudy(basePath: string, base: string, skillId: string) {
  return write<{ preview: GatePreview }>(
    basePath,
    "POST",
    `${base}/gates/source-study/${encodeURIComponent(skillId)}/preview`,
    {},
  );
}
export function confirmStudy(
  basePath: string,
  base: string,
  skillId: string,
  confirmationHash: string,
  requestId: string,
) {
  return write<{ confirmation: GateConfirmation }>(
    basePath,
    "POST",
    `${base}/gates/source-study/${encodeURIComponent(skillId)}/commit`,
    { confirmationHash, requestId },
  );
}
