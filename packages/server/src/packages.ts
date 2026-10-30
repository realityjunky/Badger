import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  canonicalHash,
  type AuthoringPlan,
  type GeneratedPackageFile,
} from "@realityjunky/badger";
import type { Queryable } from "./database/database.js";
import type { ServiceConfig } from "./config.js";
import type { ServiceDependencies } from "./dependencies.js";
import { recordAudit, type WriteContext } from "./audit.js";
import { gatePreview, readGateConfirmations, type GateState } from "./gates.js";
import {
  approvedProposal,
  loadProposal,
  readKernelState,
} from "./proposals.js";
import { listWorkflowJobs, workspaceLocation } from "./workflow-source.js";
import { RequestError } from "./http/errors.js";
import { toIsoString } from "./util.js";

export interface PackageRow {
  id: string;
  workflow_version_id: string;
  generation_job_id: string;
  generation_confirmation_id: string;
  plan_version_hash: string;
  proposal_hash: string;
  state_hash: string;
  scaffold_hash: string;
  assembled_hash: string | null;
  assembled_at: Date | string | null;
  assembled_inventory: GeneratedPackageFile[] | null;
  package_path: string;
  inventory: GeneratedPackageFile[];
  authoring_plan: AuthoringPlan;
  generated_at: string | Date;
  invalidated_at: string | Date | null;
  invalidation_reason: string | null;
}

export async function readPackage(tx: Queryable, versionId: string) {
  return (
    (
      await tx.query<PackageRow>(
        "select * from workflow_packages where workflow_version_id = $1 order by generated_at desc, id desc limit 1",
        [versionId],
      )
    ).rows[0] ?? null
  );
}

export async function generationInputs(
  tx: Queryable,
  config: ServiceConfig,
  versionId: string,
  personId: string,
) {
  const loaded = await loadProposal(tx, config, versionId, personId);
  const state = await readKernelState(tx, versionId);
  const approval = loaded
    ? await approvedProposal(tx, versionId, loaded.proposal.proposalHash)
    : null;
  const current =
    !!loaded &&
    !!state &&
    loaded.proposal.canInitialize &&
    !loaded.serviceBlockers.length &&
    state.plan_version_hash === loaded.plan.hash &&
    state.proposal_hash === loaded.proposal.proposalHash &&
    approval?.id === state.proposal_confirmation_id;
  return { loaded, state, approval, current };
}

export async function generationGateState(
  tx: Queryable,
  config: ServiceConfig,
  versionId: string,
  personId: string,
): Promise<GateState> {
  const { loaded, state, current } = await generationInputs(
    tx,
    config,
    versionId,
    personId,
  );
  return {
    findings: current
      ? []
      : [
          {
            code: "GENERATION_BLOCKED",
            message:
              "Initialize the current approved proposal before generating its package",
            severity: "error",
            requiredAction: "repair",
            requiresUserDecision: false,
          },
        ],
    preview: gatePreview({
      gate: "generation",
      workflowVersionId: versionId,
      boundHashes: {
        proposal: loaded?.proposal.proposalHash ?? canonicalHash(null),
        plan: loaded?.plan.hash ?? canonicalHash(null),
        creatorState: state?.hash ?? canonicalHash(null),
      },
      records: state
        ? [
            {
              type: "creator-state",
              id: versionId,
              label: "Initialized Creator state",
              hash: state.hash,
            },
          ]
        : [],
      effects: [{ id: "package", state: "active" }],
    }),
  };
}

export async function packageView(
  tx: Queryable,
  config: ServiceConfig,
  versionId: string,
  personId: string,
) {
  const { state, current } = await generationInputs(
    tx,
    config,
    versionId,
    personId,
  );
  const saved = await readPackage(tx, versionId);
  return {
    canGenerate: current,
    currentStateHash: state?.hash ?? null,
    package: saved
      ? {
          id: saved.id,
          generationJobId: saved.generation_job_id,
          status:
            saved.invalidated_at === null && current
              ? "current"
              : "invalidated",
          invalidationReason: saved.invalidation_reason,
          planVersionHash: saved.plan_version_hash,
          proposalHash: saved.proposal_hash,
          scaffoldHash: saved.scaffold_hash,
          assembledHash: saved.assembled_hash,
          stateHash: saved.state_hash,
          files: saved.assembled_inventory ?? saved.inventory,
          authoringPlan: saved.authoring_plan,
          generatedAt: toIsoString(saved.generated_at),
        }
      : null,
    jobs: (await listWorkflowJobs(tx, versionId)).filter(
      (job) => job.kind === "generate",
    ),
  };
}

export interface GenerationInput {
  confirmationHash: string;
  stateHash: string;
  requestId: string;
}

/** Bound to the person's preview and committed approval under the version lock. */
export async function enqueueGeneration(
  tx: Queryable,
  config: ServiceConfig,
  deps: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  input: GenerationInput,
) {
  const jobs = await listWorkflowJobs(tx, versionId);
  const replay = jobs.find(
    (job) =>
      job.requesterId === context.personId && job.requestId === input.requestId,
  );
  if (replay) {
    if (
      replay.kind !== "generate" ||
      replay.creatorStateHash !== input.stateHash ||
      replay.generationConfirmationId === null ||
      !(await readGateConfirmations(tx, versionId, "generation")).some(
        (c) =>
          c.id === replay.generationConfirmationId &&
          c.confirmationHash === input.confirmationHash,
      )
    )
      throw new RequestError(
        409,
        "The generation request ID was already used for different inputs",
      );
    return replay;
  }
  const { loaded, state, current, approval } = await generationInputs(
    tx,
    config,
    versionId,
    context.personId,
  );
  const confirmation = (
    await readGateConfirmations(tx, versionId, "generation")
  ).find(
    (c) =>
      c.invalidatedAt === null &&
      c.confirmationHash === input.confirmationHash &&
      c.actorId === context.personId,
  );
  if (
    !current ||
    !loaded ||
    !state ||
    !approval ||
    state.hash !== input.stateHash ||
    !confirmation ||
    confirmation.boundHashes.creatorState !== state.hash ||
    confirmation.boundHashes.proposal !== state.proposal_hash
  )
    throw new RequestError(
      409,
      "Review and confirm generation for the current initialized proposal and Creator state",
    );
  const id = deps.ids.next();
  await tx.query(
    `insert into workflow_jobs (id, kind, workflow_version_id, requester_id, status, requested_at, pins_hash, plan_version_hash, proposal_hash, proposal_confirmation_id, request_id, generation_confirmation_id, creator_state_hash)
    values ($1,'generate',$2,$3,'queued',$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      id,
      versionId,
      context.personId,
      deps.clock.now(),
      loaded.pinsHash,
      loaded.plan.hash,
      state.proposal_hash,
      approval.id,
      input.requestId,
      confirmation.id,
      state.hash,
    ],
  );
  await recordAudit(tx, deps, {
    actor: { personId: context.personId, credential: context.credential },
    channel: context.channel,
    action: "workflow_generation.requested",
    target: { type: "workflow_job", id },
    before: null,
    after: { revision: 1, hash: state.hash },
    reason: "Confirmed package generation queued",
    requestId: context.requestId,
  });
  return (await listWorkflowJobs(tx, versionId)).find((job) => job.id === id)!;
}

export async function packageFile(
  tx: Queryable,
  config: ServiceConfig,
  versionId: string,
  relative: string,
) {
  const saved = await readPackage(tx, versionId);
  const file = (saved?.assembled_inventory ?? saved?.inventory)?.find(
    (file) => file.path === relative,
  );
  if (!saved || !file) throw new RequestError(404, "No such package file");
  if (file.bytes > 1024 * 1024)
    throw new RequestError(413, "This file is too large to preview");
  const { root } = workspaceLocation(config, versionId);
  const bytes = await fs.readFile(
    path.join(root, saved.package_path, file.path),
  );
  if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
    throw new RequestError(
      409,
      "The package file differs from its recorded hash",
    );
  return { ...file, text: bytes.toString("utf8") };
}
