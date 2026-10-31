import { recordAudit } from "../audit.js";
import type { ServiceConfig } from "../config.js";
import type { Database } from "../database/database.js";
import type { ServiceDependencies } from "../dependencies.js";
import type { Logger } from "../log.js";
import { lockBlobStore, type BlobStore } from "../skills/blobs.js";

/** A bounded maintenance batch; workflow locks serialize answer and inheritance writes. */
export async function expireAnswerAttachments(options: {
  database: Database;
  dependencies: ServiceDependencies;
  config: ServiceConfig;
  blobs: BlobStore;
  workerId: string;
  logger?: Logger;
}): Promise<void> {
  const { database, dependencies, config, blobs, workerId, logger } = options;
  const cutoff = new Date(
    dependencies.clock.now().getTime() -
      config.answerAttachments.retentionSeconds * 1000,
  );
  const candidates = await database.query<{
    id: string;
    workflow_id: string;
    workflow_version_id: string;
  }>(
    `select a.id, q.workflow_version_id, v.workflow_id from answer_attachments a
     join questions q on q.id = a.question_id join workflow_versions v on v.id = q.workflow_version_id
     where a.created_at <= $1 and not answer_attachment_is_referenced(a.id)
     order by a.created_at, a.id limit 100`,
    [cutoff],
  );
  for (const candidate of candidates.rows) {
    await database.transaction(async (tx) => {
      // Same order as questionnaire writers. Recheck after taking the locks.
      await tx.query(
        "select id from workflows where id = $1 for no key update",
        [candidate.workflow_id],
      );
      await tx.query(
        "select id from workflow_versions where id = $1 for no key update",
        [candidate.workflow_version_id],
      );
      const removed = (
        await tx.query<{ id: string; hash: string }>(
          `delete from answer_attachments a where a.id = $1 and a.created_at <= $2
         and not answer_attachment_is_referenced(a.id) returning id, hash`,
          [candidate.id, cutoff],
        )
      ).rows[0];
      if (!removed) return;
      await tx.query(
        "insert into attachment_blob_cleanup (hash) values ($1) on conflict do nothing",
        [removed.hash],
      );
      await recordAudit(tx, dependencies, {
        actor: { personId: null, credential: { kind: "worker", id: workerId } },
        channel: "worker",
        action: "answer.attachment-expired",
        target: { type: "attachment", id: removed.id },
        before: { revision: 1, hash: removed.hash },
        after: null,
        reason: `Unreferenced for ${config.answerAttachments.retentionSeconds} seconds`,
        requestId: dependencies.ids.next(),
      });
    });
  }
  const pending = await database.query<{ hash: string }>(
    "select hash from attachment_blob_cleanup order by hash limit 100",
  );
  for (const { hash } of pending.rows) {
    // Content that cannot be removed, such as a blob on a restored volume the
    // worker may not write, stays queued for a later run and holds up no
    // other blob.
    try {
      await database.transaction(async (tx) => {
        await lockBlobStore(tx);
        const referenced = (
          await tx.query<{ present: boolean }>(
            `select exists (select 1 from answer_attachments where hash = $1)
         or exists (select 1 from skill_versions where inventory @> jsonb_build_array(jsonb_build_object('hash', $1::text))) as present`,
            [hash],
          )
        ).rows[0]!.present;
        if (!referenced) await blobs.remove(hash);
        await tx.query("delete from attachment_blob_cleanup where hash = $1", [
          hash,
        ]);
      });
    } catch (error) {
      logger?.error({
        event: "worker.attachment-content-cleanup-failed",
        hash,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
