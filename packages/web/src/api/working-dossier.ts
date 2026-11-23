import type { DossierEvidence, WorkingDossierView } from "@realityjunky/badger";

export function workingDossierPath(workflowId: string, versionId: string) {
  return `/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(versionId)}/working-dossier`;
}

export type WorkingDossierField =
  WorkingDossierView["projection"]["fields"][number];

export interface WorkingDossierExcerpt {
  evidence: DossierEvidence;
  lines: { number: number; text: string }[];
}

export function dossierEvidencePath(
  path: string,
  revision: number,
  evidence: DossierEvidence,
) {
  const query = new URLSearchParams({
    ...evidence,
    revision: String(revision),
    startLine: String(evidence.startLine),
    endLine: String(evidence.endLine),
  });
  return `${path}/evidence?${query}`;
}

export function dossierEvidenceKey(evidence: DossierEvidence) {
  return JSON.stringify([
    evidence.skillId,
    evidence.hash,
    evidence.path,
    evidence.fileHash,
    evidence.startLine,
    evidence.endLine,
  ]);
}
