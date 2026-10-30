import { promises as fs } from "node:fs";
import path from "node:path";
import { buildProposal } from "@realityjunky/badger";
import type { ServiceConfig } from "./config.js";
import type { Queryable } from "./database/database.js";
import { canonicalHash } from "@realityjunky/badger";
import { gatePreview, readGateConfirmations, type GateState } from "./gates.js";
import { planGateState, readPlanVersions } from "./plans.js";
import {
  listWorkflowJobs,
  readSourceCheck,
  workspaceLocation,
} from "./workflow-source.js";
import type { ServiceDependencies } from "./dependencies.js";
import { recordAudit, type WriteContext } from "./audit.js";
import { RequestError } from "./http/errors.js";
import { toIsoString } from "./util.js";

export interface KernelStateRow {
  workflow_version_id: string;
  plan_version_hash: string;
  proposal_hash: string;
  proposal_confirmation_id: string;
  initialized_job_id: string;
  state_namespace: string;
  state_json: string;
  hash: string;
  revision: number;
  initialized_at: string | Date;
}

export async function readKernelState(tx: Queryable, versionId: string) {
  return (
    (
      await tx.query<KernelStateRow>(
        "select * from workflow_kernel_states where workflow_version_id = $1",
        [versionId],
      )
    ).rows[0] ?? null
  );
}

export async function approvedProposal(
  tx: Queryable,
  versionId: string,
  proposalHash: string,
) {
  return (
    (await readGateConfirmations(tx, versionId, "proposal")).find(
      (confirmation) =>
        confirmation.invalidatedAt === null &&
        confirmation.boundHashes.proposal === proposalHash,
    ) ?? null
  );
}

/** Materialize an immutable approved plan; the kernel owns proposal derivation. */
export async function loadProposal(
  tx: Queryable,
  config: ServiceConfig,
  versionId: string,
  personId: string,
) {
  const plan = (await readPlanVersions(tx, versionId))[0];
  const approval = (await readGateConfirmations(tx, versionId, "plan")).find(
    (confirmation) => confirmation.invalidatedAt === null,
  );
  const check = await readSourceCheck(tx, versionId);
  if (
    !plan ||
    approval?.boundHashes.plan !== plan.hash ||
    check?.status !== "passed" ||
    (await planGateState(tx, versionId, personId)).findings.length
  )
    return null;
  const { root } = workspaceLocation(config, versionId);
  const planPath = path.join(root, "plans", `${plan.hash}.json`);
  const text = JSON.stringify(plan.snapshot.plan, null, 2) + "\n";
  await fs.mkdir(path.dirname(planPath), { recursive: true });
  try {
    await fs.writeFile(planPath, text, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await fs.readFile(planPath, "utf8")) !== text)
      throw new Error(
        "The materialized plan differs from its immutable version",
      );
  }
  const proposal = await buildProposal({ projectRoot: root, planPath });
  // Artifact paths are supplied by the service. A saved plan cannot grant
  // itself permission to write outside the job's private kernel namespace.
  const serviceBlockers =
    plan.snapshot.plan.artifactRoot === undefined
      ? []
      : [
          "Service projects use the kernel's managed artifact root; remove artifactRoot from the plan",
        ];
  return {
    plan,
    proposal,
    root,
    planPath,
    pinsHash: check.pinsHash,
    serviceBlockers,
  };
}

export function publicKernelMessage(config: ServiceConfig, value: string) {
  return value.replaceAll(path.resolve(config.storage.root), "<storage>");
}

export async function proposalView(
  tx: Queryable,
  config: ServiceConfig,
  versionId: string,
  personId: string,
) {
  const loaded = await loadProposal(tx, config, versionId, personId);
  const proposal = loaded?.proposal;
  const state = await readKernelState(tx, versionId);
  return {
    planVersionHash: loaded?.plan.hash ?? null,
    proposal: proposal
      ? {
          name: proposal.name,
          goal: proposal.goal,
          intent: proposal.intent,
          planHash: proposal.planHash,
          proposalHash: proposal.proposalHash,
          canInitialize:
            proposal.canInitialize && loaded.serviceBlockers.length === 0,
          blockers: [...proposal.blockers, ...loaded.serviceBlockers].map(
            (message) => publicKernelMessage(config, message),
          ),
          warnings: proposal.warnings,
          sources: proposal.candidates.map((candidate) => {
            const source =
              loaded.plan.snapshot.plan.semanticDossier!.sources.find(
                (source) => source.name === candidate.name,
              )!;
            return {
              id: source.id,
              name: candidate.name,
              location: source.location,
              status: candidate.status,
              hash: candidate.sources[0]?.hash ?? null,
              blockers: (candidate.blockers ?? []).map((message) =>
                publicKernelMessage(config, message),
              ),
            };
          }),
        }
      : null,
    confirmation:
      (await readGateConfirmations(tx, versionId, "proposal"))[0] ?? null,
    currentState: state
      ? {
          hash: state.hash,
          proposalHash: state.proposal_hash,
          planVersionHash: state.plan_version_hash,
          revision: state.revision,
          initializedAt: toIsoString(state.initialized_at),
        }
      : null,
    jobs: (await listWorkflowJobs(tx, versionId)).filter(
      (job) => job.kind === "init",
    ),
  };
}

export async function proposalGateState(
  tx: Queryable,
  config: ServiceConfig,
  versionId: string,
  personId: string,
): Promise<GateState> {
  const loaded = await loadProposal(tx, config, versionId, personId);
  const blockers = loaded
    ? [...loaded.proposal.blockers, ...loaded.serviceBlockers]
    : ["Approve the current plan before reviewing its proposal"];
  return {
    findings: blockers.map((message) => ({
      code: "PROPOSAL_BLOCKED",
      message: publicKernelMessage(config, message),
      severity: "error",
      requiresUserDecision: false,
      requiredAction: "repair",
    })),
    preview: gatePreview({
      gate: "proposal",
      workflowVersionId: versionId,
      boundHashes: {
        plan: loaded?.plan.hash ?? canonicalHash(null),
        dossier: loaded?.plan.snapshot.dossierHash ?? canonicalHash(null),
        proposal: loaded?.proposal.proposalHash ?? canonicalHash(null),
        pins: loaded?.pinsHash ?? canonicalHash(null),
      },
      records: loaded
        ? [
            {
              type: "plan-version",
              id: loaded.plan.id,
              label: `Plan ${loaded.plan.number}`,
              hash: loaded.plan.hash,
            },
            ...loaded.plan.snapshot.plan.semanticDossier!.sources.map(
              (source) => ({
                type: "skill-source",
                id: source.id,
                label: source.name,
                hash: source.contentHash,
              }),
            ),
          ]
        : [],
      effects: [{ id: "plan-proposal", state: "active" }],
    }),
  };
}

export interface InitializationInput {
  proposalHash: string;
  requestId: string;
  replaceStateHash?: string;
}

/** Called under the same version lock as approval and invalidation. */
export async function enqueueInitialization(
  tx: Queryable,
  config: ServiceConfig,
  deps: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  input: InitializationInput,
) {
  const jobs = await listWorkflowJobs(tx, versionId);
  const replay = jobs.find(
    (job) =>
      job.requesterId === context.personId && job.requestId === input.requestId,
  );
  if (replay) {
    if (
      replay.proposalHash !== input.proposalHash ||
      replay.replaceStateHash !== (input.replaceStateHash ?? null)
    )
      throw new RequestError(
        409,
        "The initialization request ID was already used for different inputs",
      );
    return replay;
  }
  if (
    (
      await tx.query(
        "select id from workflow_jobs where requester_id = $1 and request_id = $2",
        [context.personId, input.requestId],
      )
    ).rows.length
  )
    throw new RequestError(
      409,
      "The initialization request ID was already used",
    );
  const loaded = await loadProposal(tx, config, versionId, context.personId);
  const approval = await approvedProposal(tx, versionId, input.proposalHash);
  if (
    !loaded ||
    !loaded.proposal.canInitialize ||
    loaded.serviceBlockers.length ||
    loaded.proposal.proposalHash !== input.proposalHash ||
    approval?.boundHashes.plan !== loaded.plan.hash
  )
    throw new RequestError(
      409,
      "Review and approve the current unblocked proposal before initialization",
    );
  const state = await readKernelState(tx, versionId);
  if ((state?.hash ?? null) !== (input.replaceStateHash ?? null))
    throw new RequestError(
      409,
      "Quote the current Creator state hash to replace it",
      { currentStateHash: state?.hash ?? null },
    );
  const id = deps.ids.next();
  await tx.query(
    `insert into workflow_jobs (id, kind, workflow_version_id, requester_id, status, requested_at, pins_hash, plan_version_hash, proposal_hash, proposal_confirmation_id, replace_state_hash, request_id)
    values ($1,'init',$2,$3,'queued',$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      versionId,
      context.personId,
      deps.clock.now(),
      loaded.pinsHash,
      loaded.plan.hash,
      input.proposalHash,
      approval.id,
      input.replaceStateHash ?? null,
      input.requestId,
    ],
  );
  await recordAudit(tx, deps, {
    actor: { personId: context.personId, credential: context.credential },
    channel: context.channel,
    action: "workflow_initialization.requested",
    target: { type: "workflow_job", id },
    before: null,
    after: { revision: 1, hash: input.proposalHash },
    reason: "Approved proposal initialization queued",
    requestId: context.requestId,
  });
  return (await listWorkflowJobs(tx, versionId)).find((job) => job.id === id)!;
}
