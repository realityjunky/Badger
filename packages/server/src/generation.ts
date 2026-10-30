import { promises as fs } from "node:fs";
import path from "node:path";
import {
  createWorkflowKernel,
  generateFromApprovedProposal,
  type AuthoringPlan,
} from "@realityjunky/badger";
import { recordAudit, type AuditWriteContext } from "./audit.js";
import { readGateConfirmations } from "./gates.js";
import { closeGateInbox } from "./inbox.js";
import { generationInputs } from "./packages.js";
import { invalidateGeneratedPackage } from "./package-invalidation.js";
import { publicKernelMessage } from "./proposals.js";
import {
  listWorkflowJobs,
  type SourceCheckWorkerOptions,
  type WorkflowJob,
} from "./workflow-source.js";

/** All kernel writes are disposable until the package and exact Creator bytes commit. */
export async function runGeneration(
  options: SourceCheckWorkerOptions,
  job: WorkflowJob,
): Promise<WorkflowJob> {
  const { database, config, dependencies, workerId } = options;
  return database.transaction(async (tx) => {
    await tx.query(
      "select id from workflow_versions where id = $1 for no key update",
      [job.workflowVersionId],
    );
    await tx.query("select id from workflow_jobs where id = $1 for update", [
      job.id,
    ]);
    const current = (await listWorkflowJobs(tx, job.workflowVersionId)).find(
      (j) => j.id === job.id,
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
      await recordAudit(tx, dependencies, {
        actor: { personId: null, credential: { kind: "worker", id: workerId } },
        channel: "worker",
        action: `workflow_generation.${status}`,
        target: { type: "workflow_job", id: job.id },
        before: { revision: current.revision, hash: null },
        after: {
          revision: current.revision + 1,
          hash: outcome?.stateHash ?? null,
        },
        reason: error ?? "Generated the confirmed package scaffold",
        requestId: job.id,
      });
      return (await listWorkflowJobs(tx, job.workflowVersionId)).find(
        (j) => j.id === job.id,
      )!;
    };
    let inputs: Awaited<ReturnType<typeof generationInputs>>;
    try {
      inputs = await generationInputs(
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
    const { loaded, state, approval } = inputs;
    const confirmation = (
      await readGateConfirmations(tx, job.workflowVersionId, "generation")
    ).find(
      (c) => c.id === job.generationConfirmationId && c.invalidatedAt === null,
    );
    if (
      !inputs.current ||
      !loaded ||
      !state ||
      !confirmation ||
      state.hash !== job.creatorStateHash ||
      approval?.id !== job.proposalConfirmationId ||
      loaded.plan.hash !== job.planVersionHash ||
      loaded.proposal.proposalHash !== job.proposalHash ||
      loaded.pinsHash !== job.pinsHash
    )
      return finish(
        "cancelled",
        null,
        "The initialized proposal, confirmation, or Creator state changed",
      );

    const namespace = `.badger/generations/${job.id}`;
    const directory = path.join(loaded.root, namespace);
    const stateFile = path.join(
      directory,
      "states",
      `${loaded.proposal.name}.json`,
    );
    let generated: Awaited<ReturnType<typeof generateFromApprovedProposal>>;
    let stateJson: string;
    let stateHash: string;
    let authoringPlan: AuthoringPlan;
    try {
      await fs.rm(directory, { recursive: true, force: true });
      const kernel = createWorkflowKernel({
        projectRoot: loaded.root,
        stateNamespace: namespace,
      });
      await kernel.initializeState({
        planPath: loaded.planPath,
        proposalHash: job.proposalHash!,
        confirmed: true,
      });
      generated = await generateFromApprovedProposal({
        projectRoot: loaded.root,
        name: loaded.proposal.name,
        stateNamespace: namespace,
        confirmed: true,
      });
      stateJson = await fs.readFile(stateFile, "utf8");
      stateHash = (await kernel.stateHash(loaded.proposal.name))!;
      authoringPlan = JSON.parse(
        await fs.readFile(generated.generated.authoringPlanPath, "utf8"),
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
    const context: AuditWriteContext = {
      personId: null,
      credential: { kind: "worker" as const, id: workerId },
      channel: "worker" as const,
      requestId: job.id,
    };
    await invalidateGeneratedPackage(
      tx,
      dependencies,
      context,
      job.workflowVersionId,
      "Package regeneration superseded later work",
    );
    await tx.query(
      `insert into workflow_packages (id, workflow_version_id, generation_job_id, generation_confirmation_id, plan_version_hash, proposal_hash, state_hash, scaffold_hash, package_path, inventory, authoring_plan, generated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12)`,
      [
        dependencies.ids.next(),
        job.workflowVersionId,
        job.id,
        job.generationConfirmationId,
        job.planVersionHash,
        job.proposalHash,
        stateHash,
        generated.generated.scaffoldHash,
        path
          .relative(loaded.root, generated.generated.packageRoot)
          .split(path.sep)
          .join("/"),
        JSON.stringify(generated.generated.inventory),
        JSON.stringify(authoringPlan),
        dependencies.clock.now(),
      ],
    );
    await tx.query(
      `update workflow_kernel_states set state_json = $2, hash = $3, state_namespace = $4, revision = revision + 1 where workflow_version_id = $1`,
      [job.workflowVersionId, stateJson, stateHash, namespace],
    );
    await tx.query(
      `update workflow_versions set stages = stages || jsonb_build_object('package','active',
      'evaluation',case when stages->>'evaluation' = 'todo' then 'todo' else 'invalidated' end,
      'review-publication',case when stages->>'review-publication' = 'todo' then 'todo' else 'invalidated' end),
      revision = revision + 1, updated_at = $2 where id = $1`,
      [job.workflowVersionId, dependencies.clock.now()],
    );
    await closeGateInbox(
      tx,
      job.workflowVersionId,
      "generation",
      dependencies.clock.now(),
    );
    return finish("succeeded", {
      status: "generated",
      blockers: [],
      stateHash,
      scaffoldHash: generated.generated.scaffoldHash,
    });
  });
}
