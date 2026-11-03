import {
  canonicalHash,
  scriptEffectContract,
  scriptEffectReviewFindings,
  validateScriptEffectSuggestions,
  type ScriptEffectReviewRow,
  type ScriptEffectSuggestion,
} from "@realityjunky/badger";
import { recordAudit, type WriteContext } from "./audit.js";
import type { Queryable } from "./database/database.js";
import type { ServiceDependencies } from "./dependencies.js";
import { RequestError } from "./http/errors.js";
import { invalidateGate } from "./gates.js";
import { notifyWorkflowRoles } from "./inbox.js";
import { invalidateProposal } from "./proposal-invalidation.js";
import type { BlobStore } from "./skills/blobs.js";
import type { SkillVersion } from "./skills/library.js";
import { evidenceLines } from "./source-study.js";
import { invalidateStudyGates } from "./source-study-invalidation.js";
import { toIsoString } from "./util.js";

export interface EffectContent {
  scripts: ScriptEffectReviewRow[];
  proposalRevision: number | null;
  sourceJobId: string | null;
  workflowVersionId: string | null;
  note: string;
  confirmationHash?: string;
}
export interface EffectRevision {
  skillId: string;
  sourceHash: string;
  revision: number;
  kind: "legacy" | "proposal" | "review" | "clarification" | "confirmation";
  content: EffectContent;
  actorId: string;
  recordedAt: string;
  hash: string;
}
interface EffectRow {
  skill_id: string;
  source_hash: string;
  revision: number;
  kind: EffectRevision["kind"];
  content: EffectContent;
  actor_id: string;
  recorded_at: string | Date;
}

function publicRevision(row: EffectRow): EffectRevision {
  const value = {
    skillId: row.skill_id,
    sourceHash: row.source_hash,
    revision: row.revision,
    kind: row.kind,
    content: row.content,
    actorId: row.actor_id,
    recordedAt: toIsoString(row.recorded_at),
  };
  return { ...value, hash: canonicalHash(value) };
}

export async function effectHistory(
  tx: Queryable,
  skillId: string,
  hash: string,
) {
  const result = await tx.query<EffectRow>(
    "select * from script_effect_revisions where skill_id = $1 and source_hash = $2 order by revision desc",
    [skillId, hash],
  );
  return result.rows.map(publicRevision);
}

export async function effectHead(tx: Queryable, skillId: string, hash: string) {
  const result = await tx.query<EffectRow>(
    "select * from script_effect_revisions where skill_id = $1 and source_hash = $2 order by revision desc limit 1",
    [skillId, hash],
  );
  return result.rows[0] ? publicRevision(result.rows[0]) : null;
}

export function effectFindings(
  version: SkillVersion,
  review: EffectRevision | null,
) {
  return scriptEffectReviewFindings(
    version,
    review?.content.scripts ?? [],
    review?.kind === "confirmation",
  );
}

export async function validateEffectDraft(
  tx: Queryable,
  blobs: BlobStore,
  version: SkillVersion,
  input: unknown,
) {
  let rows: ScriptEffectSuggestion[];
  try {
    rows = validateScriptEffectSuggestions(version, input);
  } catch (error) {
    throw new RequestError(
      400,
      error instanceof Error ? error.message : String(error),
    );
  }
  await checkEffectEvidence(tx, blobs, rows);
  return rows;
}

export async function checkEffectEvidence(
  tx: Queryable,
  blobs: BlobStore,
  rows: ScriptEffectSuggestion[],
) {
  for (const row of rows)
    for (const citation of row.evidence)
      await evidenceLines(tx, blobs, citation);
}

export function effectConfirmationPreview(
  version: SkillVersion,
  review: EffectRevision,
  actorId: string,
) {
  const findings = scriptEffectReviewFindings(
    version,
    review.content.scripts,
    true,
  );
  if (
    findings.length ||
    review.kind === "legacy" ||
    review.kind === "clarification"
  )
    throw new RequestError(
      409,
      "Finish every script's review and answer its uncertainties before confirming",
      { findings },
    );
  const bound = {
    skillId: version.skillId,
    sourceHash: version.hash,
    revision: review.revision,
    reviewHash: review.hash,
    proposalRevision: review.content.proposalRevision,
    scripts: review.content.scripts,
    actorId,
    reviewedAt: review.recordedAt,
    contract: scriptEffectContract(),
  };
  return { ...bound, confirmationHash: canonicalHash(bound) };
}

async function invalidateEffectDependents(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  version: SkillVersion,
) {
  const versions = await tx.query<{ id: string }>(
    `select v.id from workflow_versions v
       join workflow_skill_pins p on p.workflow_version_id = v.id
       where p.skill_id = $1 and p.skill_version_hash = $2 order by v.id for no key update of v`,
    [version.skillId, version.hash],
  );
  const reason =
    "Script effect declarations changed; review the current declaration revision";
  for (const { id } of versions.rows) {
    await invalidateStudyGates(tx, deps, context, id, reason, [
      version.skillId,
    ]);
    await invalidateGate(tx, deps, context, id, "dossier", reason, [
      "Engineer",
      "Workflow owner",
    ]);
    await invalidateGate(tx, deps, context, id, "plan", reason, [
      "Engineer",
      "Workflow owner",
    ]);
    await invalidateProposal(tx, deps, context, id, reason);
    await tx.query(
      `update workflow_versions set stages = (
        select jsonb_object_agg(key, case
          when key = 'source-study' then to_jsonb('active'::text)
          when key <> 'sources' and value <> '"todo"'::jsonb then to_jsonb('invalidated'::text)
          else value end) from jsonb_each(stages)
       ), revision = revision + 1, updated_at = $2 where id = $1`,
      [id, deps.clock.now()],
    );
  }
}

export async function appendEffectRevision(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  version: SkillVersion,
  previous: EffectRevision | null,
  kind: EffectRevision["kind"],
  content: EffectContent,
) {
  const revision = (previous?.revision ?? 0) + 1;
  const result = await tx.query<EffectRow>(
    `insert into script_effect_revisions
      (skill_id, source_hash, revision, kind, content, actor_id, recorded_at)
      values ($1,$2,$3,$4,$5::jsonb,$6,$7) returning *`,
    [
      version.skillId,
      version.hash,
      revision,
      kind,
      JSON.stringify(content),
      context.personId,
      deps.clock.now(),
    ],
  );
  const review = publicRevision(result.rows[0]!);
  if (previous?.kind === "confirmation")
    await invalidateEffectDependents(tx, deps, context, version);
  await recordAudit(tx, deps, {
    actor: { personId: context.personId, credential: context.credential },
    channel: context.channel,
    action: `script_effects.${kind}`,
    target: { type: "skill_version", id: `${version.skillId}:${version.hash}` },
    before: previous
      ? { revision: previous.revision, hash: previous.hash }
      : null,
    after: { revision, hash: review.hash },
    reason: content.note || `Source study script effect ${kind}`,
    requestId: context.requestId,
  });
  if (kind === "confirmation") {
    await tx.query(
      `update inbox_items set state = 'done', revision = revision + 1, updated_at = $3
       where effect_skill_id = $1 and effect_source_hash = $2 and state <> 'done'`,
      [version.skillId, version.hash, deps.clock.now()],
    );
  } else if (content.workflowVersionId) {
    await tx.query(
      `insert into inbox_items
        (id, person_id, workflow_version_id, gate, kind, event_id, effect_skill_id, effect_source_hash, created_at, updated_at)
        values ($1,$2,$3,'source-study','script-effect-review',$4,$5,$6,$7,$7) on conflict do nothing`,
      [
        deps.ids.next(),
        version.uploadedBy,
        content.workflowVersionId,
        `${version.skillId}:${version.hash}:${revision}`,
        version.skillId,
        version.hash,
        deps.clock.now(),
      ],
    );
    if (kind === "clarification")
      await notifyWorkflowRoles(
        tx,
        deps,
        content.workflowVersionId,
        "source-study",
        "gate-ready",
        `effect-clarification:${version.skillId}:${version.hash}:${revision}`,
        ["Engineer"],
      );
  }
  return review;
}
