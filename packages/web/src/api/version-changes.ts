export interface RecordOrigin {
  workflowVersionId: string;
  recordId: string;
  revision: number;
}
export interface EvidenceChange {
  skillId: string;
  path: string;
  fromVersionHash: string;
  toVersionHash: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  status: "changed" | "removed" | "unpinned";
}
