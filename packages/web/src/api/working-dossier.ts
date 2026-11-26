import type {
  ApprovedWorkingDossier,
  DossierEvidence,
  WorkingDossierView,
} from "@realityjunky/badger";

export function workingDossierPath(workflowId: string, versionId: string) {
  return `/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(versionId)}/working-dossier`;
}

export type WorkingDossierField =
  WorkingDossierView["projection"]["fields"][number];

export function approvedDossierFields({
  content,
  fields,
  pins,
}: ApprovedWorkingDossier): WorkingDossierField[] {
  const owners = [
    { scope: "workflow", owner: "workflow", ownerLabel: "Workflow" } as const,
    ...pins.map(({ skillId, name }) => ({
      scope: "skill" as const,
      owner: skillId,
      ownerLabel: name,
    })),
    ...Object.entries(content.nodes).map(([owner, node]) => ({
      scope: "node" as const,
      owner,
      ownerLabel: node.label,
    })),
    ...Object.entries(content.interfaces).map(([owner, edge]) => ({
      scope: "interface" as const,
      owner,
      ownerLabel: `${content.nodes[edge.producer]?.label ?? edge.producer} → ${content.nodes[edge.consumer]?.label ?? edge.consumer}`,
    })),
  ];
  return owners.flatMap((owner) =>
    fields[owner.scope].map((definition) => {
      const id = `${owner.scope}/${owner.owner}/${definition.key}`;
      return {
        ...owner,
        ...definition,
        id,
        content: content.fields[id] ?? null,
        blocker: null,
        evidenceChanges: [],
      };
    }),
  );
}

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
