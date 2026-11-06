import {
  scriptEffectContract,
  validateScriptEffectSuggestions,
  type ScriptEffectReviewRow,
} from "@realityjunky/badger";
import { accessFor } from "../authorization.js";
import { draftingTarget, type DraftingJobRow } from "../drafting/jobs.js";
import { draftingContext, draftingInputHash } from "../drafting/context.js";
import {
  appendEffectRevision,
  checkEffectEvidence,
  effectConfirmationPreview,
  effectFindings,
  effectHead,
  effectHistory,
  validateEffectDraft,
} from "../script-effects.js";
import { readPersonById } from "../people.js";
import { readSkill, readVersion } from "../skills/library.js";
import { skillGroupPermissions } from "../skills/access.js";
import { workflowCapabilities } from "../workflow-access.js";
import { readWorkflow } from "../workflows.js";
import { evidenceLines, parseSourceEvidence } from "../source-study.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { readJsonBody } from "./body.js";
import { objectInput, RequestError } from "./errors.js";

const PATH =
  /^\/api\/v1\/skills\/([^/]+)\/versions\/([^/]+)\/effects(?:\/(route|clarify|preview|confirm|evidence))?$/u;
export function scriptEffectMethods(path: string): string | null {
  const match = PATH.exec(path);
  return !match
    ? null
    : match[3] === "evidence"
      ? "GET, HEAD"
      : match[3]
        ? "POST"
        : "GET, HEAD, POST";
}

export async function handleScriptEffects(input: AuthorizedRequest) {
  const {
    database,
    dependencies: deps,
    context,
    access,
    person,
    blobs,
    reply,
  } = input;
  const [, rawSkill, rawHash, action] = PATH.exec(input.path)!;
  const skillId = decodeURIComponent(rawSkill!);
  const hash = decodeURIComponent(rawHash!);
  let body: Record<string, unknown> = {};
  if (input.method === "POST") {
    const parsed = await readJsonBody(input.request, 1024 * 1024);
    if (!parsed.ok)
      throw new RequestError(parsed.status ?? 400, parsed.message);
    body = objectInput(parsed.value);
  }
  const response = await database.transaction(async (tx) => {
    if (action === "confirm")
      await tx.query("select id from people where id = $1 for no key update", [
        person.id,
      ]);
    const skill = await readSkill(tx, skillId);
    const permission = (await skillGroupPermissions(tx, access, person)).find(
      (group) => group.id === skill?.groupId,
    );
    if (!skill || !permission)
      throw new RequestError(404, "No such Skill review");
    if (input.method === "POST")
      await tx.query(
        "select skill_id from skill_versions where skill_id = $1 and hash = $2 for no key update",
        [skillId, hash],
      );
    const version = await readVersion(tx, skillId, hash);
    const responsible = await readPersonById(tx, version.uploadedBy);
    const responsibleAccess =
      responsible && responsible.status === "active"
        ? await skillGroupPermissions(
            tx,
            responsible.id === person.id
              ? access
              : await accessFor(tx, responsible, null, input.config),
            responsible,
          )
        : [];
    const uploaderAvailable = responsibleAccess.some(
      (group) => group.id === skill.groupId,
    );
    const canReview =
      context.credential.kind !== "token" && person.id === version.uploadedBy;
    const review = await effectHead(tx, skillId, hash);
    if (action === "evidence") {
      const query = input.url.searchParams;
      const citation = parseSourceEvidence({
        skillId,
        hash,
        path: query.get("path"),
        fileHash: query.get("fileHash"),
        startLine: Number(query.get("startLine")),
        endLine: Number(query.get("endLine")),
      });
      return evidenceLines(tx, blobs, citation);
    }
    if (input.method !== "POST")
      return {
        skillId,
        hash,
        skillName: skill.name,
        uploadedBy: version.uploadedBy,
        uploader: responsible
          ? { id: responsible.id, displayName: responsible.displayName }
          : null,
        uploaderAvailable,
        pendingReason: uploaderAvailable
          ? null
          : "The original uploader is unavailable or no longer authorized. Review remains pending; responsibility cannot be reassigned here.",
        canReview,
        contract: scriptEffectContract(),
        scripts: version.scripts,
        inventory: version.inventory,
        review,
        history: await effectHistory(tx, skillId, hash),
        findings: effectFindings(version, review),
      };
    if (!version.scripts.length)
      throw new RequestError(400, "A script-free Skill needs no effect review");
    const allowed =
      action === "route"
        ? ["workflowVersionId", "jobId", "jobRevision", "revision"]
        : action === "confirm"
          ? ["confirmationHash", "requestId"]
          : action === "preview"
            ? ["revision"]
            : action === "clarify"
              ? ["revision", "note"]
              : ["revision", "scripts", "note"];
    if (Object.keys(body).some((key) => !allowed.includes(key)))
      throw new RequestError(400, "Unknown script effect review field");
    if (action !== "route" && (!canReview || !uploaderAvailable))
      throw new RequestError(
        403,
        "Only the exact version's authorized uploader may personally review and confirm its declarations",
      );
    if (action === "confirm") {
      if (
        typeof body.requestId !== "string" ||
        !/^[A-Za-z0-9._-]{1,100}$/u.test(body.requestId)
      )
        throw new RequestError(400, "Provide a confirmation requestId");
      const replay = await tx.query<{
        confirmation_hash: string;
        skill_id: string;
        source_hash: string;
        response: unknown;
      }>(
        "select * from script_effect_confirmations where actor_id = $1 and request_id = $2",
        [person.id, body.requestId],
      );
      if (replay.rows[0]) {
        const receipt = replay.rows[0];
        if (
          receipt.skill_id !== skillId ||
          receipt.source_hash !== hash ||
          receipt.confirmation_hash !== body.confirmationHash
        )
          throw new RequestError(
            409,
            "This requestId already confirmed a different declaration set",
          );
        return receipt.response;
      }
      if (!review || review.kind === "confirmation")
        throw new RequestError(409, "Reload the current declaration review");
      const preview = effectConfirmationPreview(version, review, person.id);
      if (preview.confirmationHash !== body.confirmationHash)
        throw new RequestError(
          409,
          "The declaration review changed after preview; review it again",
        );
      await checkEffectEvidence(tx, blobs, review.content.scripts);
      const confirmed = await appendEffectRevision(
        tx,
        deps,
        context,
        version,
        review,
        "confirmation",
        { ...review.content, confirmationHash: preview.confirmationHash },
      );
      const result = { review: confirmed };
      await tx.query(
        `insert into script_effect_confirmations (actor_id, request_id, skill_id, source_hash, revision, confirmation_hash, response)
          values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [
          person.id,
          body.requestId,
          skillId,
          hash,
          confirmed.revision,
          preview.confirmationHash,
          JSON.stringify(result),
        ],
      );
      return result;
    }
    if (
      !Number.isSafeInteger(body.revision) ||
      body.revision !== (review?.revision ?? 0)
    )
      throw new RequestError(
        409,
        "The script effect review changed; reload its current revision",
      );
    if (action === "route") {
      await tx.query(
        "select id from workflows where id = (select workflow_id from workflow_versions where id = $1) for no key update",
        [body.workflowVersionId],
      );
      await tx.query(
        "select id from workflow_versions where id = $1 for no key update",
        [body.workflowVersionId],
      );
      const job = (
        await tx.query<DraftingJobRow>(
          "select * from drafting_jobs where id = $1 and workflow_version_id = $2",
          [body.jobId, body.workflowVersionId],
        )
      ).rows[0];
      if (
        !job ||
        job.kind !== "source-study" ||
        job.skill_id !== skillId ||
        job.revision !== body.jobRevision ||
        !["submitted", "accepted"].includes(job.status)
      )
        throw new RequestError(
          409,
          "Select a current submitted or accepted Source study draft",
        );
      const workflowRow = (
        await tx.query<{ workflow_id: string }>(
          "select workflow_id from workflow_versions where id = $1",
          [job.workflow_version_id],
        )
      ).rows[0];
      const workflow = workflowRow
        ? await readWorkflow(tx, workflowRow.workflow_id)
        : null;
      if (
        !workflow ||
        !(await workflowCapabilities(tx, access, person, workflow))
          .manageSourceStudy
      )
        throw new RequestError(
          403,
          "Only a signed-in Engineer routes this Source study draft",
        );
      const pin = (
        await tx.query(
          "select 1 from workflow_skill_pins where workflow_version_id = $1 and skill_id = $2 and skill_version_hash = $3",
          [job.workflow_version_id, skillId, hash],
        )
      ).rows[0];
      const contextPin = job.context_bundle.pins.find(
        (entry) => entry.skillId === skillId,
      );
      if (!pin || contextPin?.hash !== hash)
        throw new RequestError(
          409,
          "This draft no longer describes the pinned source version",
        );
      if (
        review?.kind === "confirmation" ||
        review?.content.sourceJobId === job.id
      )
        return { review };
      if (
        (contextPin.effectRevision?.revision ?? 0) !== (review?.revision ?? 0)
      )
        throw new RequestError(
          409,
          "The declaration review changed after this job; request a current draft",
        );
      const decision = job.decision as {
        decision?: { scriptEffects?: unknown };
        studyRecordIds?: string[];
      } | null;
      const current = await draftingContext(
        tx,
        workflow.id,
        job.workflow_version_id,
        person.id,
      );
      const acceptedRecords = new Set(
        job.status === "accepted" ? (decision?.studyRecordIds ?? []) : [],
      );
      for (const kind of ["facts", "interfaces"] as const)
        current.bundle.sourceStudy[kind] = current.bundle.sourceStudy[
          kind
        ].filter(
          (record) =>
            !acceptedRecords.has(record.id) ||
            record.revision !== 1 ||
            record.status !== "active",
        );
      if (
        draftingInputHash(current.bundle, draftingTarget(job)) !==
        job.input_hash
      )
        throw new RequestError(
          409,
          "The Source study inputs changed after this draft; request a current draft",
        );
      const reviewedResult = job.review_result ?? job.result;
      const result =
        reviewedResult && "interfaces" in reviewedResult
          ? reviewedResult.scriptEffects
          : undefined;
      const suggestions = await validateEffectDraft(
        tx,
        blobs,
        version,
        decision?.decision?.scriptEffects ?? result ?? [],
      );
      const routed = await appendEffectRevision(
        tx,
        deps,
        context,
        version,
        review,
        "proposal",
        {
          scripts: suggestions.map((row) => ({
            ...row,
            reviewed: false,
            uncertaintyAnswer: "",
          })),
          proposalRevision: (review?.revision ?? 0) + 1,
          sourceJobId: job.id,
          workflowVersionId: job.workflow_version_id,
          note: "Engineer routed the Source study effect draft to the original uploader.",
        },
      );
      return { review: routed };
    }
    if (!review)
      throw new RequestError(
        409,
        "Ask the Engineer to route a Source study effect draft first",
      );
    if (action === "preview")
      return { preview: effectConfirmationPreview(version, review, person.id) };
    const note = body.note ?? "";
    if (
      typeof note !== "string" ||
      note.length > 8000 ||
      (action === "clarify" && !note.trim())
    )
      throw new RequestError(
        400,
        "Provide a clarification or correction note of at most 8000 characters",
      );
    if (action === "clarify")
      return {
        review: await appendEffectRevision(
          tx,
          deps,
          context,
          version,
          review,
          "clarification",
          {
            ...review.content,
            scripts: review.content.scripts.map((row) => ({
              ...row,
              reviewed: false,
            })),
            note,
          },
        ),
      };
    let rows: ScriptEffectReviewRow[];
    try {
      rows = validateScriptEffectSuggestions(version, body.scripts, true);
    } catch (error) {
      throw new RequestError(
        400,
        error instanceof Error ? error.message : String(error),
      );
    }
    await checkEffectEvidence(tx, blobs, rows);
    return {
      review: await appendEffectRevision(
        tx,
        deps,
        context,
        version,
        review,
        "review",
        { ...review.content, scripts: rows, note },
      ),
    };
  });
  reply.json(200, response);
}
