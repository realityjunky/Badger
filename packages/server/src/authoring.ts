import { invalidateEvaluations } from "./package-invalidation.js";
import { invalidateGate } from "./gates.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  authoringReadiness,
  authoringSessionGateway,
  buildAuthoringHandoff,
  createWorkflowKernel,
  generateFromApprovedProposal,
  recordAuthoring,
  assemblePackage,
  canonicalHash,
  validateAuthoringLaneOutput,
  type AuthoringLaneId,
  type AuthoringLaneOutput,
  type CreatorState,
} from "@realityjunky/badger";
import type { Queryable } from "./database/database.js";
import type { ServiceConfig } from "./config.js";
import type { ServiceDependencies } from "./dependencies.js";
import { recordAudit, type WriteContext } from "./audit.js";
import { generationInputs, readPackage } from "./packages.js";
import { readKernelState, publicKernelMessage } from "./proposals.js";
import { workspaceLocation } from "./workflow-source.js";
import { RequestError } from "./http/errors.js";
import { createRound, saveQuestion } from "./questionnaire/store.js";
import {
  auditJob,
  publicDraftingJob,
  readDraftingJobs,
  type DraftingActor,
  type DraftingJobRow,
} from "./drafting/jobs.js";
import { draftingContext } from "./drafting/context.js";

export const isAuthoringJob = (job: { kind: string }) =>
  job.kind === "authoring-lane" || job.kind === "review-vote";
const sha = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Kernel output as readers and Agents see it: an absolute path under the
 * Project root becomes Project-relative, and `aliases` rename exact paths.
 */
function portablePaths(
  root: string,
  value: unknown,
  aliases: ReadonlyMap<string, string> = new Map(),
): any {
  if (typeof value === "string") {
    const alias = aliases.get(value);
    if (alias) return alias;
    if (path.isAbsolute(value)) {
      const relative = path.relative(root, value);
      if (
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      )
        return relative.split(path.sep).join("/") || ".";
    }
    return value;
  }
  if (Array.isArray(value))
    return value.map((entry) => portablePaths(root, entry, aliases));
  return value && typeof value === "object"
    ? Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          portablePaths(root, entry, aliases),
        ]),
      )
    : value;
}

export async function loadAuthoring(
  tx: Queryable,
  config: ServiceConfig,
  versionId: string,
) {
  const saved = await readPackage(tx, versionId);
  const persisted = await readKernelState(tx, versionId);
  if (!saved || !persisted)
    throw new RequestError(409, "Generate the package before authoring");
  const { root } = workspaceLocation(config, versionId);
  const kernel = createWorkflowKernel({
    projectRoot: root,
    stateNamespace: persisted.state_namespace,
  });
  if (
    (await kernel.stateHash(JSON.parse(persisted.state_json).name)) !==
    persisted.hash
  )
    throw new RequestError(409, "The committed Creator state needs recovery");
  const state = await kernel.readState(JSON.parse(persisted.state_json).name);
  const readiness = await authoringReadiness(state);
  return { saved, persisted, state, readiness, root };
}

export async function authoringView(
  tx: Queryable,
  config: ServiceConfig,
  versionId: string,
) {
  const loaded = await loadAuthoring(tx, config, versionId);
  const followUps = await tx.query<{
    lane_id: string;
    question_id: string | null;
    repair_job_id: string | null;
  }>(
    "select lane_id, question_id, repair_job_id from authoring_follow_ups where package_id = $1 order by job_id",
    [loaded.saved.id],
  );
  return {
    packageId: loaded.saved.id,
    current: loaded.saved.invalidated_at === null,
    readiness: portablePaths(loaded.root, loaded.readiness),
    jobs: (await readDraftingJobs(tx, versionId))
      .filter((j) => j.package_id === loaded.saved.id)
      .map(publicDraftingJob),
    followUps: followUps.rows.map((r) => ({
      laneId: r.lane_id,
      questionId: r.question_id,
      repairJobId: r.repair_job_id,
    })),
  };
}

export function laneInput(
  loaded: Awaited<ReturnType<typeof loadAuthoring>>,
  lane: AuthoringLaneId,
) {
  const dependencies = loaded.saved.authoring_plan.lanes.find(
    (l) => l.id === lane,
  )!.dependencies;
  return canonicalHash({
    packageId: loaded.saved.id,
    authoringInputHash: loaded.state.authoring!.authoringInputHash,
    own: loaded.readiness.records[lane]?.authoredMaterialHash ?? null,
    dependencies: dependencies.map((id) => ({
      lane: id,
      hash: loaded.readiness.records[id]?.authoredMaterialHash ?? null,
    })),
  });
}

export async function reconcileAuthoringJobs(
  tx: Queryable,
  config: ServiceConfig,
  deps: ServiceDependencies,
  actor: DraftingActor,
  versionId: string,
  jobs: DraftingJobRow[],
) {
  const active = jobs.filter(
    (j) =>
      isAuthoringJob(j) &&
      ["queued", "claimed", "submitted"].includes(j.status),
  );
  if (!active.length) return;
  const loaded = await loadAuthoring(tx, config, versionId);
  for (const job of active) {
    const dispatch = await authoringSessionGateway().decide({
      state: loaded.state,
      operation: "dispatch",
      lane: job.lane_id!,
    });
    if (
      job.package_id === loaded.saved.id &&
      loaded.saved.invalidated_at === null &&
      dispatch.allowed &&
      job.input_hash === laneInput(loaded, job.lane_id!)
    )
      continue;
    const updated = (
      await tx.query<DraftingJobRow>(
        "update drafting_jobs set status = 'cancelled', revision = revision + 1, lease_id = null, lease_person_id = null, lease_token_id = null, lease_agent_host = null, lease_until = null, updated_at = $2 where id = $1 returning *",
        [job.id, deps.clock.now()],
      )
    ).rows[0]!;
    await auditJob(
      tx,
      deps,
      actor,
      updated,
      "cancelled",
      job.revision,
      "The package or accepted lane inputs changed",
    );
    Object.assign(job, updated);
    await tx.query(
      "update inbox_items set state = 'done', revision = revision + 1, updated_at = $2 where drafting_job_id = $1 and state <> 'done'",
      [job.id, deps.clock.now()],
    );
  }
}

async function boundedBundle(
  loaded: Awaited<ReturnType<typeof loadAuthoring>>,
  lane: AuthoringLaneId,
  id: string,
) {
  const outputPath = path.join(loaded.root, "agent-outputs", `${id}.json`);
  const handoff = await buildAuthoringHandoff({
    state: loaded.state,
    lane,
    outputPath,
  });
  const aliases = new Map(
    handoff.inputPaths.map((file, i) => [
      file,
      `inputs/${i}-${path.basename(file)}`,
    ]),
  );
  aliases.set(outputPath, "result.json");
  const portable = (value: unknown) =>
    portablePaths(loaded.root, value, aliases);
  const files = [];
  let total = 0;
  for (const file of handoff.inputPaths) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
      throw new RequestError(
        413,
        "Authoring input must be a regular file within 1 MiB",
      );
    const bytes = await fs.readFile(file);
    total += bytes.length;
    if (total > 16 * 1024 * 1024)
      throw new RequestError(413, "The bounded authoring inputs exceed 16 MiB");
    let text = bytes.toString("utf8");
    if (
      file === handoff.commonInputPath ||
      file === handoff.confirmedProposal.path
    )
      text = JSON.stringify(portable(JSON.parse(text)), null, 2);
    files.push({ path: aliases.get(file)!, text, hash: sha(text) });
  }
  const projectedHandoff = portable(handoff) as typeof handoff;
  const proposal = files.find(
    (file) => file.path === projectedHandoff.confirmedProposal.path,
  )!;
  projectedHandoff.confirmedProposal.hash = proposal.hash;
  const common = files.find(
    (file) => file.path === projectedHandoff.commonInputPath,
  )!;
  const commonInput = JSON.parse(common.text);
  commonInput.confirmedProposal = projectedHandoff.confirmedProposal;
  common.text = JSON.stringify(commonInput, null, 2);
  common.hash = sha(common.text);
  return {
    packageId: loaded.saved.id,
    lane,
    plan: portable(loaded.saved.authoring_plan),
    handoff: projectedHandoff,
    files,
    repair: loaded.readiness.records[lane]?.action ?? null,
  };
}

export async function requestLaneJobs(
  tx: Queryable,
  config: ServiceConfig,
  deps: ServiceDependencies,
  actor: DraftingActor,
  workflowId: string,
  versionId: string,
  repairLane?: AuthoringLaneId,
  excludedJobId?: string,
) {
  const loaded = await loadAuthoring(tx, config, versionId);
  if (
    loaded.saved.invalidated_at !== null ||
    !(await generationInputs(tx, config, versionId, actor.personId)).current
  )
    throw new RequestError(
      409,
      "The package's approved inputs changed; regenerate before authoring",
    );
  const { bundle } = await draftingContext(
    tx,
    workflowId,
    versionId,
    actor.personId,
  );
  const jobs = await readDraftingJobs(tx, versionId);
  const created: DraftingJobRow[] = [];
  for (const definition of loaded.saved.authoring_plan.lanes) {
    const lane = definition.id;
    if (repairLane && lane !== repairLane) continue;
    if (!repairLane && loaded.readiness.completedLanes.includes(lane)) continue;
    if (
      jobs.some(
        (j) =>
          j.id !== excludedJobId &&
          j.package_id === loaded.saved.id &&
          j.lane_id === lane &&
          ["queued", "claimed", "submitted"].includes(j.status),
      )
    )
      continue;
    const decision = await authoringSessionGateway().decide({
      state: loaded.state,
      operation: "dispatch",
      lane,
    });
    if (!decision.allowed) continue;
    const id = deps.ids.next();
    const authoring = await boundedBundle(loaded, lane, id);
    const context = {
      workflow: bundle.workflow,
      version: bundle.version,
      pins: bundle.pins,
      authoring,
    };
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["laneOutput"],
      properties: {
        laneOutput: {
          type: "object",
          required: ["lane", "status"],
          properties: {
            lane: { const: lane },
            status: {
              enum: ["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"],
            },
          },
        },
      },
    };
    const job = (
      await tx.query<DraftingJobRow>(
        `insert into drafting_jobs (id,workflow_version_id,kind,requester_id,context_bundle,context_hash,input_hash,output_schema,package_id,lane_id,created_at,updated_at)
      values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9,$10,$11,$11) returning *`,
        [
          id,
          versionId,
          lane === "skill-review" ? "review-vote" : "authoring-lane",
          actor.personId,
          JSON.stringify(context),
          canonicalHash(context),
          laneInput(loaded, lane),
          JSON.stringify(schema),
          loaded.saved.id,
          lane,
          deps.clock.now(),
        ],
      )
    ).rows[0]!;
    await auditJob(
      tx,
      deps,
      actor,
      job,
      "queued",
      null,
      repairLane ? "Repair the blocked authoring lane" : null,
    );
    created.push(job);
  }
  return created;
}

export function validateLaneResult(job: DraftingJobRow, result: unknown) {
  const output = (result as { laneOutput: AuthoringLaneOutput }).laneOutput;
  if (Buffer.byteLength(JSON.stringify(output)) > 256 * 1024)
    throw new RequestError(413, "Authoring lane output exceeds 256 KiB");
  if (output.artifacts?.some((a) => a.contentPath !== undefined))
    throw new RequestError(
      400,
      "Submit authored content inline; host file paths grant no service access",
    );
  const findings = validateAuthoringLaneOutput(
    output,
    job.context_bundle.authoring!.plan,
    job.lane_id!,
  );
  if (findings.length)
    throw new RequestError(
      400,
      "Repair the kernel's authoring output findings",
      { findings },
    );
  return output;
}

/** Replay accepted outputs through the kernel into a new disposable namespace. */
async function replayAuthoring(
  tx: Queryable,
  config: ServiceConfig,
  deps: ServiceDependencies,
  versionId: string,
  personId: string,
) {
  const loaded = await loadAuthoring(tx, config, versionId);
  const inputs = await generationInputs(tx, config, versionId, personId);
  if (!inputs.current || !inputs.loaded || loaded.saved.invalidated_at !== null)
    throw new RequestError(
      409,
      "Regenerate the current approved package before changing authoring",
    );
  const namespace = `.badger/authoring-transactions/${deps.ids.next()}`;
  const kernel = createWorkflowKernel({
    projectRoot: loaded.root,
    stateNamespace: namespace,
  });
  await kernel.initializeState({
    planPath: inputs.loaded.planPath,
    proposalHash: inputs.loaded.proposal.proposalHash,
    confirmed: true,
  });
  const { state } = await generateFromApprovedProposal({
    projectRoot: loaded.root,
    name: loaded.state.name,
    stateNamespace: namespace,
    confirmed: true,
    depth: loaded.saved.authoring_plan.depth,
  });
  const accepted = (
    await tx.query<{ lane_id: AuthoringLaneId; output: AuthoringLaneOutput }>(
      "select lane_id, output from accepted_authoring_outputs where package_id = $1 order by revision",
      [loaded.saved.id],
    )
  ).rows;
  for (const entry of accepted)
    await recordAuthoring({
      state,
      lane: entry.lane_id,
      record: { ...entry.output, expectedRevision: state.authoring!.revision },
      expectedRevision: state.authoring!.revision,
      confirmed: true,
    });
  return { ...loaded, state, namespace, kernel };
}

async function commitAuthoring(
  tx: Queryable,
  state: CreatorState,
  versionId: string,
) {
  const file = path.join(
    state.projectRoot,
    state.stateNamespace!,
    "states",
    `${state.name}.json`,
  );
  const text = await fs.readFile(file, "utf8");
  const hash = sha(text);
  await tx.query(
    "update workflow_kernel_states set state_json = $2, hash = $3, state_namespace = $4, revision = revision + 1 where workflow_version_id = $1",
    [versionId, text, hash, state.stateNamespace],
  );
  return hash;
}

export async function acceptLaneResult(
  tx: Queryable,
  config: ServiceConfig,
  deps: ServiceDependencies,
  actor: DraftingActor,
  job: DraftingJobRow,
  result: unknown,
) {
  const output = validateLaneResult(job, result);
  const loaded = await replayAuthoring(
    tx,
    config,
    deps,
    job.workflow_version_id,
    actor.personId,
  );
  let record;
  try {
    record = await recordAuthoring({
      state: loaded.state,
      lane: job.lane_id!,
      record: { ...output, expectedRevision: loaded.state.authoring!.revision },
      expectedRevision: loaded.state.authoring!.revision,
      confirmed: true,
    });
  } catch (error) {
    throw new RequestError(
      409,
      publicKernelMessage(
        config,
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
  await tx.query(
    "insert into accepted_authoring_outputs (job_id,package_id,revision,person_id,lane_id,output,accepted_at) values ($1,$2,$3,$4,$5,$6::jsonb,$7)",
    [
      job.id,
      loaded.saved.id,
      record.revision,
      actor.personId,
      job.lane_id,
      JSON.stringify(output),
      deps.clock.now(),
    ],
  );
  await invalidateEvaluations(
    tx,
    deps,
    actor,
    job.workflow_version_id,
    "Accepted Authoring output superseded evaluation",
  );
  for (const gate of ["package", "publication"])
    await invalidateGate(
      tx,
      deps,
      actor,
      job.workflow_version_id,
      gate,
      "Accepted Authoring output superseded package review",
      ["Reviewer", "Workflow owner"],
    );
  const stateHash = await commitAuthoring(
    tx,
    loaded.state,
    job.workflow_version_id,
  );
  await tx.query(
    "update workflow_packages set state_hash = $2, assembled_hash = null, assembled_at = null, assembled_inventory = null where id = $1",
    [loaded.saved.id, stateHash],
  );
  await tx.query(
    "update workflow_versions set revision = revision + 1, updated_at = $2, stages = stages || jsonb_build_object('package','active','evaluation',case when stages->>'evaluation' = 'todo' then 'todo' else 'invalidated' end,'review-publication',case when stages->>'review-publication' = 'todo' then 'todo' else 'invalidated' end) where id = $1",
    [job.workflow_version_id, deps.clock.now()],
  );
  if (record.status === "NEEDS_CONTEXT") {
    const round = await createRound(
      tx,
      deps,
      actor,
      job.workflow_version_id,
      `Authoring: ${job.lane_id}`,
    );
    // The kernel requires a question action only from Wave 1 lanes. Without
    // one, the draft starts from the summary for the Engineer to edit.
    const question = await saveQuestion(
      tx,
      deps,
      actor,
      job.workflow_version_id,
      round.id,
      {
        text:
          record.action?.prompt ??
          (record.summary?.trim()
            ? record.summary
            : `The ${job.lane_id} Authoring lane needs more context.`),
        rationale:
          record.action?.requirement ??
          `The ${job.lane_id} Authoring lane reported NEEDS_CONTEXT without naming a dossier field.`,
        topic: "scope",
        targets: [{ kind: "workflow", id: "workflow" }],
        evidence: [],
        assignees: [{ kind: "role", role: "Workflow owner" }],
        priority: 100,
      },
    );
    await tx.query(
      "insert into authoring_follow_ups (job_id,package_id,lane_id,question_id) values ($1,$2,$3,$4)",
      [job.id, loaded.saved.id, job.lane_id, question.id],
    );
  } else if (record.status === "BLOCKED") {
    const workflowId = (
      await tx.query<{ workflow_id: string }>(
        "select workflow_id from workflow_versions where id=$1",
        [job.workflow_version_id],
      )
    ).rows[0]!.workflow_id;
    const [repair] = await requestLaneJobs(
      tx,
      config,
      deps,
      actor,
      workflowId,
      job.workflow_version_id,
      job.lane_id!,
      job.id,
    );
    if (repair)
      await tx.query(
        "insert into authoring_follow_ups (job_id,package_id,lane_id,repair_job_id) values ($1,$2,$3,$4)",
        [job.id, loaded.saved.id, job.lane_id, repair.id],
      );
  }
  return {
    authoringRevision: record.revision,
    laneId: job.lane_id,
    packageId: loaded.saved.id,
  };
}

export async function assemblyPreview(
  tx: Queryable,
  config: ServiceConfig,
  versionId: string,
  personId: string,
) {
  const loaded = await loadAuthoring(tx, config, versionId);
  const inputs = await generationInputs(tx, config, versionId, personId);
  const decision = await authoringSessionGateway().decide({
    state: loaded.state,
    operation: "assemble",
  });
  if (
    !inputs.current ||
    loaded.saved.invalidated_at !== null ||
    !decision.allowed
  )
    throw new RequestError(
      409,
      "Every Authoring lane must be current before assembly",
      { blockers: decision.blockers },
    );
  const bound = {
    packageId: loaded.saved.id,
    stateHash: loaded.persisted.hash,
    revision: loaded.state.authoring!.revision,
  };
  return { ...bound, confirmationHash: canonicalHash(bound) };
}

export async function assembleCurrentPackage(
  tx: Queryable,
  config: ServiceConfig,
  deps: ServiceDependencies,
  actor: WriteContext,
  versionId: string,
  input: { confirmationHash: string; requestId: string },
) {
  const inputHash = canonicalHash({ versionId, ...input });
  const replay = (
    await tx.query<{ input_hash: string; response: object }>(
      "select input_hash,response from package_assembly_requests where person_id=$1 and request_id=$2",
      [actor.personId, input.requestId],
    )
  ).rows[0];
  if (replay) {
    if (replay.input_hash !== inputHash)
      throw new RequestError(409, "The assembly request ID was already used");
    return replay.response;
  }
  const preview = await assemblyPreview(tx, config, versionId, actor.personId);
  if (preview.confirmationHash !== input.confirmationHash)
    throw new RequestError(
      409,
      "The Authoring session changed; preview assembly again",
    );
  const loaded = await replayAuthoring(
    tx,
    config,
    deps,
    versionId,
    actor.personId,
  );
  try {
    await assemblePackage(loaded.state, true);
  } catch (error) {
    throw new RequestError(
      409,
      publicKernelMessage(
        config,
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
  const stateHash = await commitAuthoring(tx, loaded.state, versionId);
  await tx.query(
    "update workflow_packages set state_hash=$2, package_path=$3, assembled_hash=$4, assembled_at=$5, assembled_inventory=$6::jsonb where id=$1",
    [
      loaded.saved.id,
      stateHash,
      path.relative(loaded.root, loaded.state.generated!.packageRoot),
      loaded.state.generated!.assembledPackageHash,
      deps.clock.now(),
      JSON.stringify(loaded.state.generated!.inventory),
    ],
  );
  await tx.query(
    'update workflow_versions set stages=stages || \'{"package":"done","evaluation":"active"}\'::jsonb, revision=revision+1, updated_at=$2 where id=$1',
    [versionId, deps.clock.now()],
  );
  await recordAudit(tx, deps, {
    actor: { personId: actor.personId, credential: actor.credential },
    channel: actor.channel,
    action: "workflow_package.assembled",
    target: { type: "workflow-package", id: loaded.saved.id },
    before: { revision: preview.revision, hash: preview.stateHash },
    after: {
      revision: loaded.state.authoring!.revision,
      hash: loaded.state.generated!.assembledPackageHash ?? null,
    },
    reason: "Confirmed assembly of current Authoring lanes",
    requestId: actor.requestId,
  });
  const response = {
    packageHash: loaded.state.generated!.assembledPackageHash,
    stateHash,
  };
  await tx.query(
    "insert into package_assembly_requests(person_id,request_id,input_hash,response) values($1,$2,$3,$4::jsonb)",
    [actor.personId, input.requestId, inputHash, JSON.stringify(response)],
  );
  return response;
}
