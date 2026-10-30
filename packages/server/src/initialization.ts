import { promises as fs } from "node:fs";
import path from "node:path";
import { createWorkflowKernel } from "@realityjunky/badger";
import { recordAudit } from "./audit.js";
import {
  approvedProposal,
  loadProposal,
  publicKernelMessage,
  readKernelState,
} from "./proposals.js";
import {
  listWorkflowJobs,
  type SourceCheckWorkerOptions,
  type WorkflowJob,
} from "./workflow-source.js";

/**
 * Only the committed database snapshot is current. A private namespace lets
 * the kernel perform its exact-byte replacement checks without changing the
 * previous state if a worker or transaction fails.
 */
export async function runInitialization(
  options: SourceCheckWorkerOptions,
  job: WorkflowJob,
): Promise<WorkflowJob> {
  const { database, config, dependencies, workerId } = options;
  return database.transaction(async (tx) => {
    await tx.query(
      "select id from workflow_versions where id = $1 for update",
      [job.workflowVersionId],
    );
    await tx.query("select id from workflow_jobs where id = $1 for update", [
      job.id,
    ]);
    const current = (await listWorkflowJobs(tx, job.workflowVersionId)).find(
      (current) => current.id === job.id,
    )!;
    if (
      current.status !== "running" ||
      current.workerId !== workerId ||
      current.revision !== job.revision
    )
      return current;
    const finish = async (
      status: "succeeded" | "failed" | "cancelled",
      outcome: WorkflowJob["outcome"],
      error: string | null = null,
    ) => {
      await tx.query(
        `update workflow_jobs set status = $2, outcome = $3::jsonb, error = $4, finished_at = $5, lease_until = null, revision = revision + 1 where id = $1`,
        [
          job.id,
          status,
          outcome === null ? null : JSON.stringify(outcome),
          error,
          dependencies.clock.now(),
        ],
      );
      // Success records the state it committed as workflow.initialized.
      if (status !== "succeeded")
        await recordAudit(tx, dependencies, {
          actor: {
            personId: null,
            credential: { kind: "worker", id: workerId },
          },
          channel: "worker",
          action:
            status === "failed"
              ? "workflow_initialization.failed"
              : "workflow_initialization.cancelled",
          target: { type: "workflow_job", id: job.id },
          before: { revision: current.revision, hash: null },
          after: { revision: current.revision + 1, hash: null },
          reason: error,
          requestId: job.id,
        });
      return (await listWorkflowJobs(tx, job.workflowVersionId)).find(
        (current) => current.id === job.id,
      )!;
    };
    let loaded: Awaited<ReturnType<typeof loadProposal>>;
    try {
      loaded = await loadProposal(
        tx,
        config,
        job.workflowVersionId,
        job.requesterId,
      );
    } catch (error) {
      return finish(
        "failed",
        null,
        publicKernelMessage(
          config,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
    const approval = await approvedProposal(
      tx,
      job.workflowVersionId,
      job.proposalHash!,
    );
    if (
      !loaded ||
      !loaded.proposal.canInitialize ||
      loaded.serviceBlockers.length ||
      loaded.plan.hash !== job.planVersionHash ||
      loaded.proposal.proposalHash !== job.proposalHash ||
      loaded.pinsHash !== job.pinsHash ||
      approval?.id !== job.proposalConfirmationId
    )
      return finish(
        "cancelled",
        null,
        "The approved proposal or its inputs changed",
      );
    const previous = await readKernelState(tx, job.workflowVersionId);
    if ((previous?.hash ?? null) !== job.replaceStateHash)
      return finish(
        "failed",
        null,
        "The Creator state changed; review its current hash before replacing it",
      );

    const namespace = `.badger/initializations/${job.id}`;
    const directory = path.join(loaded.root, namespace);
    const file = path.join(directory, "states", `${loaded.proposal.name}.json`);
    let text: string;
    let hash: string;
    try {
      // Only this job owns this namespace. A retry discards its uncommitted
      // attempt and starts again from the last committed exact state bytes.
      await fs.rm(directory, { recursive: true, force: true });
      await fs.mkdir(path.dirname(file), { recursive: true });
      if (previous)
        await fs.writeFile(file, previous.state_json, { flag: "wx" });
      const kernel = createWorkflowKernel({
        projectRoot: loaded.root,
        stateNamespace: namespace,
      });
      await kernel.initializeState({
        planPath: loaded.planPath,
        proposalHash: job.proposalHash!,
        confirmed: true,
        ...(job.replaceStateHash
          ? { replaceStateHash: job.replaceStateHash }
          : {}),
      });
      text = await fs.readFile(file, "utf8");
      hash = (await kernel.stateHash(loaded.proposal.name))!;
    } catch (error) {
      return finish(
        "failed",
        null,
        publicKernelMessage(
          config,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
    await tx.query(
      `insert into workflow_kernel_states
      (workflow_version_id, plan_version_hash, proposal_hash, proposal_confirmation_id, initialized_job_id, state_namespace, state_json, hash, initialized_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      on conflict (workflow_version_id) do update set
        plan_version_hash = excluded.plan_version_hash, proposal_hash = excluded.proposal_hash,
        proposal_confirmation_id = excluded.proposal_confirmation_id, initialized_job_id = excluded.initialized_job_id,
        state_namespace = excluded.state_namespace, state_json = excluded.state_json, hash = excluded.hash,
        initialized_at = excluded.initialized_at, revision = workflow_kernel_states.revision + 1`,
      [
        job.workflowVersionId,
        job.planVersionHash,
        job.proposalHash,
        job.proposalConfirmationId,
        job.id,
        namespace,
        text,
        hash,
        dependencies.clock.now(),
      ],
    );
    await tx.query(
      `update workflow_versions set stages = stages || '{"plan-proposal":"done","package":"active"}'::jsonb, revision = revision + 1, updated_at = $2 where id = $1`,
      [job.workflowVersionId, dependencies.clock.now()],
    );
    await recordAudit(tx, dependencies, {
      actor: { personId: null, credential: { kind: "worker", id: workerId } },
      channel: "worker",
      action: "workflow.initialized",
      target: { type: "workflow_version", id: job.workflowVersionId },
      before: previous
        ? { revision: previous.revision, hash: previous.hash }
        : null,
      after: { revision: (previous?.revision ?? 0) + 1, hash },
      reason: "Initialized the exact approved kernel proposal",
      requestId: job.id,
    });
    return finish("succeeded", {
      status: "initialized",
      blockers: [],
      stateHash: hash,
    });
  });
}
