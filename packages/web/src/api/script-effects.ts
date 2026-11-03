import type {
  scriptEffectContract,
  ScriptEffectReviewRow,
} from "@realityjunky/badger";
import type { EffectRevision } from "@realityjunky/badger-server";
import type { SkillFile, ScriptEffects } from "./skills.js";
export type { EffectRevision, ScriptEffectReviewRow };

export interface ScriptEffectPanel {
  skillId: string;
  hash: string;
  skillName: string;
  uploadedBy: string;
  uploader: { id: string; displayName: string } | null;
  uploaderAvailable: boolean;
  pendingReason: string | null;
  canReview: boolean;
  contract: ReturnType<typeof scriptEffectContract>;
  scripts: { path: string; sideEffects: ScriptEffects }[];
  inventory: SkillFile[];
  review: EffectRevision | null;
  history: EffectRevision[];
  findings: { code: string; message: string }[];
}

export function effectsPath(skillId: string, hash: string) {
  return `/skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(hash)}/effects`;
}
