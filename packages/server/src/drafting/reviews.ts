import { canonicalHash } from "@realityjunky/badger";
import type { Queryable } from "../database/database.js";
import type { ServiceDependencies } from "../dependencies.js";
import type { BlobStore } from "../skills/blobs.js";
import { readVersion } from "../skills/library.js";
import { validateEffectDraft } from "../script-effects.js";
import { auditJob, type DraftingActor, type DraftingJobRow } from "./jobs.js";
import { validateDraftResult } from "./schema.js";
import { isAuthoringJob, validateLaneResult } from "../authoring.js";

export async function validateDraftingSubmission(
  tx: Queryable,
  job: DraftingJobRow,
  result: unknown,
  blobs: BlobStore,
) {
  const validated = validateDraftResult(
    job.kind,
    job.output_schema,
    result,
    job.context_bundle.pins.find((pin) => pin.skillId === job.skill_id),
  );
  if ("interfaces" in validated && validated.scriptEffects !== undefined) {
    const pin = job.context_bundle.pins.find(
      (entry) => entry.skillId === job.skill_id,
    )!;
    validated.scriptEffects = await validateEffectDraft(
      tx,
      blobs,
      await readVersion(tx, pin.skillId, pin.hash),
      validated.scriptEffects,
    );
  }
  if (isAuthoringJob(job)) validateLaneResult(job, validated);
  return validated;
}

export async function saveDraftingReview(
  tx: Queryable,
  deps: ServiceDependencies,
  actor: DraftingActor,
  job: DraftingJobRow,
  result: unknown,
  blobs: BlobStore,
) {
  const validated = await validateDraftingSubmission(tx, job, result, blobs);
  const now = deps.clock.now();
  const resultHash = canonicalHash(validated);
  const saved = (
    await tx.query<DraftingJobRow>(
      `update drafting_jobs set revision = revision + 1, review_revision = revision + 1,
       review_result = $2, review_hash = $3, review_person_id = $4, review_updated_at = $5,
       updated_at = $5 where id = $1 returning *`,
      [job.id, JSON.stringify(validated), resultHash, actor.personId, now],
    )
  ).rows[0]!;
  await tx.query(
    `insert into drafting_job_review_revisions (job_id, revision, result, result_hash, person_id, created_at)
     values ($1,$2,$3,$4,$5,$6)`,
    [
      job.id,
      saved.revision,
      JSON.stringify(validated),
      resultHash,
      actor.personId,
      now,
    ],
  );
  await auditJob(tx, deps, actor, saved, "review-saved", job.revision);
  return saved;
}
