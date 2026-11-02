import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  approveReview,
  publishState,
  createPackageSnapshot,
  verifyPackageSnapshot,
  canonicalHash,
  reviewState,
  type CreatorState,
  type PackageSnapshot,
} from "@realityjunky/badger";
import type { Queryable } from "./database/database.js";
import type { ServiceConfig } from "./config.js";
import { loadEvaluationState } from "./evaluations.js";
import { gatePreview, type GateState } from "./gates.js";
import { RequestError } from "./http/errors.js";
import { toIsoString } from "./util.js";
import type { ServiceDependencies } from "./dependencies.js";
import { recordAudit, type WriteContext } from "./audit.js";
import type { GateConfirmation } from "./gates.js";
import { publicKernelMessage } from "./proposals.js";
import { notifyWorkflowRoles } from "./inbox.js";

interface ReviewRow {
  id: string;
  workflow_version_id: string;
  package_id: string;
  package_hash: string;
  evaluation_report_id: string;
  reviewer_id: string;
  reviewer_name: string;
  approved_at: string | Date;
  override_reason: string | null;
  kernel_review: NonNullable<CreatorState["review"]>;
  invalidated_at: string | Date | null;
  invalidation_reason: string | null;
}
const reviewRows = async (tx: Queryable, versionId: string) =>
  (
    await tx.query<ReviewRow>(
      `select r.*,g.invalidated_at,g.invalidation_reason from package_reviews r join gate_confirmations g on g.id=r.id where r.workflow_version_id=$1 order by r.approved_at desc,r.id desc`,
      [versionId],
    )
  ).rows;

export async function loadPublicationState(
  tx: Queryable,
  config: ServiceConfig,
  versionId: string,
  bindApproval = true,
) {
  let loaded = await loadEvaluationState(tx, config, versionId);
  const history = await reviewRows(tx, versionId);
  const approval = history.find(
    (r) =>
      r.invalidated_at === null &&
      r.package_id === loaded.saved.id &&
      r.package_hash === loaded.saved.assembled_hash,
  );
  if (
    bindApproval &&
    approval &&
    loaded.passing?.id !== approval.evaluation_report_id
  )
    loaded = await loadEvaluationState(tx, config, versionId, {
      reportId: approval.evaluation_report_id,
    });
  delete loaded.state.review;
  if (approval && bindApproval)
    loaded.state.review = structuredClone(approval.kernel_review);
  return {
    ...loaded,
    approval,
    reviews: history,
    publicationReadiness: reviewState(loaded.state, loaded.readiness),
  };
}

export async function reviewView(
  tx: Queryable,
  config: ServiceConfig,
  versionId: string,
) {
  let loaded: Awaited<ReturnType<typeof loadPublicationState>> | null = null;
  try {
    loaded = await loadPublicationState(tx, config, versionId);
  } catch (error) {
    if (!(error instanceof RequestError)) throw error;
  }
  return {
    currentPackageHash:
      loaded?.saved.invalidated_at === null
        ? loaded.saved.assembled_hash
        : null,
    readiness: loaded?.publicationReadiness ?? null,
    passingReportId:
      loaded?.publicationReadiness.runtime.state === "ready"
        ? (loaded.passing?.id ?? null)
        : null,
    approvalId:
      loaded?.publicationReadiness.state === "publishable"
        ? (loaded.approval?.id ?? null)
        : null,
    reviews: (loaded?.reviews ?? (await reviewRows(tx, versionId))).map(
      (r) => ({
        id: r.id,
        packageId: r.package_id,
        packageHash: r.package_hash,
        evaluationReportId: r.evaluation_report_id,
        reviewerId: r.reviewer_id,
        reviewerName: r.reviewer_name,
        approvedAt: toIsoString(r.approved_at),
        overrideReason: r.override_reason,
        invalidatedAt:
          r.invalidated_at === null ? null : toIsoString(r.invalidated_at),
        invalidationReason: r.invalidation_reason,
      }),
    ),
  };
}

export async function reviewGateState(
  tx: Queryable,
  config: ServiceConfig,
  versionId: string,
  personId: string,
  action: "package" | "publication",
): Promise<GateState> {
  const loaded = await loadPublicationState(
    tx,
    config,
    versionId,
    action !== "package",
  );
  const readiness =
    action === "package"
      ? reviewState({ ...loaded.state, review: undefined }, loaded.readiness)
      : loaded.publicationReadiness;
  const blockers = [...readiness.blockers];
  if (loaded.saved.invalidated_at !== null || !loaded.saved.assembled_hash)
    blockers.push(
      "Assemble the current approved package before review or publication",
    );
  if (action === "publication" && readiness.state !== "publishable")
    blockers.push(...readiness.publication.blockers);
  return {
    preview: gatePreview({
      gate: action,
      workflowVersionId: versionId,
      boundHashes: {
        package: loaded.saved.assembled_hash ?? canonicalHash(null),
        generation: loaded.saved.id,
        creatorState: loaded.persisted.hash,
        evaluation: loaded.passing?.id ?? canonicalHash(null),
        readiness: readiness.hashes.publicationReadiness ?? canonicalHash(null),
        approval:
          action === "publication"
            ? (loaded.approval?.id ?? canonicalHash(null))
            : canonicalHash(null),
        actor: canonicalHash({ personId }),
      },
      records: [
        {
          type: "workflow-package",
          id: loaded.saved.id,
          label: "Assembled package",
          hash: loaded.saved.assembled_hash ?? canonicalHash(null),
        },
      ],
      effects: [
        {
          id: "review-publication",
          state: action === "package" ? "active" : "done",
        },
      ],
    }),
    findings: [...new Set(blockers)].map((message) => ({
      code: "PUBLICATION_BLOCKED",
      message,
      severity: "error",
      requiredAction: "repair",
      requiresUserDecision: false,
    })),
  };
}

/** Called in the gate transaction. Kernel transitions affect only cloned state. */
export async function recordPackageSignOff(
  tx: Queryable,
  config: ServiceConfig,
  deps: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  confirmation: GateConfirmation,
  reviewerName: string,
) {
  const loaded = await loadPublicationState(
    tx,
    config,
    versionId,
    confirmation.gate !== "package",
  );
  try {
    if (confirmation.gate === "package") {
      delete loaded.state.review;
      await approveReview({
        state: loaded.state,
        reviewer: context.personId,
        approve: true,
        persistState: false,
      });
      await tx.query(
        `insert into package_reviews(id,workflow_version_id,package_id,package_hash,evaluation_report_id,reviewer_id,reviewer_name,approved_at,override_reason,kernel_review) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [
          confirmation.id,
          versionId,
          loaded.saved.id,
          loaded.state.review!.hash,
          loaded.passing!.id,
          context.personId,
          reviewerName,
          deps.clock.now(),
          null,
          JSON.stringify(loaded.state.review),
        ],
      );
      await notifyWorkflowRoles(
        tx,
        deps,
        versionId,
        "publication",
        "gate-ready",
        confirmation.id,
        ["Workflow owner"],
      );
    } else {
      const directory = path.join(
        loaded.root,
        ".badger",
        "publication-attempts",
        randomUUID(),
      );
      try {
        await publishState(loaded.state, true, {
          persistState: false,
          destination: directory,
        });
        const snapshot = await createPackageSnapshot(
          directory,
          loaded.saved.assembled_inventory!,
        );
        if (snapshot.packageHash !== loaded.saved.assembled_hash)
          throw new Error("Published bytes differ from the approved package");
        await tx.query(
          `insert into published_packages(id,workflow_version_id,review_id,package_id,package_hash,publisher_id,publisher_name,published_at,snapshot) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
          [
            confirmation.id,
            versionId,
            loaded.approval!.id,
            loaded.saved.id,
            snapshot.packageHash,
            context.personId,
            reviewerName,
            deps.clock.now(),
            JSON.stringify(snapshot),
          ],
        );
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  } catch (error) {
    if (error instanceof RequestError) throw error;
    // Keep database failures visible to the service's transaction retry policy.
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      !String(error.code).startsWith("E")
    )
      throw error;
    throw new RequestError(
      409,
      publicKernelMessage(
        config,
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
  await recordAudit(tx, deps, {
    actor: context,
    channel: context.channel,
    action:
      confirmation.gate === "package"
        ? "workflow_package.approved"
        : "workflow_package.published",
    target: {
      type:
        confirmation.gate === "package"
          ? "package-review"
          : "published-package",
      id: confirmation.id,
    },
    before: null,
    after: { revision: 1, hash: loaded.saved.assembled_hash },
    reason:
      confirmation.gate === "package"
        ? "Workflow owner or Administrator approved this exact package hash"
        : "Workflow owner or Administrator confirmed publication of the approved package",
    requestId: context.requestId,
  });
}

interface PublishedMetadataRow {
  id: string;
  workflow_version_id: string;
  review_id: string;
  package_id: string;
  package_hash: string;
  publisher_id: string;
  publisher_name: string;
  published_at: string | Date;
  file_count: number;
  version_number: number;
  version_name: string;
}
interface PublishedRow extends PublishedMetadataRow {
  snapshot: PackageSnapshot;
}
const publishedMetadata = (r: PublishedMetadataRow) => ({
  id: r.id,
  workflowVersionId: r.workflow_version_id,
  versionNumber: r.version_number,
  versionName: r.version_name,
  reviewId: r.review_id,
  packageId: r.package_id,
  packageHash: r.package_hash,
  publisherId: r.publisher_id,
  publisherName: r.publisher_name,
  publishedAt: toIsoString(r.published_at),
  fileCount: r.file_count,
});

/** Publication history never joins the mutable current Creator namespace. */
export async function listPublishedPackages(tx: Queryable, workflowId: string) {
  const result = await tx.query<PublishedMetadataRow>(
    `select p.id,p.workflow_version_id,p.review_id,p.package_id,p.package_hash,p.publisher_id,p.publisher_name,p.published_at,
      jsonb_array_length(p.snapshot->'inventory') as file_count,v.number as version_number,v.name as version_name
      from published_packages p join workflow_versions v on v.id=p.workflow_version_id where v.workflow_id=$1 order by p.published_at desc,p.id desc`,
    [workflowId],
  );
  return result.rows.map(publishedMetadata);
}

/** Deep public retrieval seam for host installation and Run creation. */
export async function readPublishedPackage(
  tx: Queryable,
  workflowId: string,
  publicationId: string,
  expectedHash?: string,
) {
  const row = (
    await tx.query<PublishedRow>(
      `select p.*,jsonb_array_length(p.snapshot->'inventory') as file_count,v.number as version_number,v.name as version_name from published_packages p join workflow_versions v on v.id=p.workflow_version_id where v.workflow_id=$1 and p.id=$2`,
      [workflowId, publicationId],
    )
  ).rows[0];
  if (!row) throw new RequestError(404, "No such published package");
  if (expectedHash !== undefined && expectedHash !== row.package_hash)
    throw new RequestError(
      409,
      "Published package selection has a different hash",
    );
  try {
    verifyPackageSnapshot(row.snapshot);
    if (row.snapshot.packageHash !== row.package_hash)
      throw new Error("Published package hash mismatch");
  } catch {
    throw new RequestError(
      409,
      "Published package integrity verification failed",
    );
  }
  return { publication: publishedMetadata(row), snapshot: row.snapshot };
}
