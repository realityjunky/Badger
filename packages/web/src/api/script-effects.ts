import type {
  scriptEffectContract,
  ScriptEffectReviewRow,
} from "@realityjunky/badger";
import type { EffectRevision } from "@realityjunky/badger-server";
import type { SkillFile, ScriptEffects } from "./skills.js";
export type { EffectRevision, ScriptEffectReviewRow };

export interface ScriptEffectStatus {
  review: EffectRevision | null;
  findings: { code: string; message: string }[];
}

export interface ScriptEffectPanel extends ScriptEffectStatus {
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
  history: EffectRevision[];
}

export function unansweredScriptPaths(
  review: EffectRevision | null | undefined,
) {
  return (
    review?.content.scripts
      .filter(
        (row) => row.uncertainty !== null && !row.uncertaintyAnswer.trim(),
      )
      .map((row) => row.path) ?? []
  );
}

export function effectsPath(skillId: string, hash: string) {
  return `/skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(hash)}/effects`;
}
