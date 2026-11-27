import {
  canonicalHash,
  composeFactoryPlan,
  deriveFactoryPlan,
  type PlanComposition,
} from "@realityjunky/badger";
import type { Queryable } from "./database/database.js";
import type { ServiceConfig } from "./config.js";
import type { WriteContext } from "./audit.js";
import type { ServiceDependencies } from "./dependencies.js";
import { dossierGateState, storeApprovedWorkingDossier } from "./dossier.js";
import { gatePreview, type GateConfirmation, type GateState } from "./gates.js";
import { readPlanHead, storePlan } from "./plans.js";
import { buildImplementationFiles } from "./packages.js";
import {
  proposalForPlan,
  publicKernelMessage,
  readKernelState,
} from "./proposals.js";
import { RequestError } from "./http/errors.js";
import { readSourceCheck } from "./workflow-source.js";
import type { SkillSourceDeclaration } from "@realityjunky/badger";

export async function workflowBuildPreview(
  tx: Queryable,
  config: ServiceConfig,
  versionId: string,
  personId: string,
) {
  const evidence = await dossierGateState(tx, versionId, personId);
  const findings: GateState["findings"] = [...evidence.findings];
  const dossier = evidence.composition?.snapshot.dossier;
  const basis = dossier?.workingDossier;
  let composition: PlanComposition | undefined;
  let proposalHash: string | undefined;
  const reject = (message: string) =>
    findings.push({
      code: "MAP_NOT_READY",
      message,
      severity: "error",
      requiredAction: "repair",
      requiresUserDecision: false,
    });
  if (dossier && basis && evidence.composition) {
    if (!basis.content.contract)
      reject(
        "Open Workflow mapping and save Executable behavior. An approved Plan for this map can be adopted there.",
      );
    else
      try {
        const check = await readSourceCheck(tx, versionId);
        const skillSources: SkillSourceDeclaration[] = dossier.sources.map(
          (source) => {
            const scripts = Object.fromEntries(
              (
                check?.sources.find(
                  (entry) =>
                    entry.name === source.name &&
                    entry.hash === source.contentHash,
                )?.scripts ?? []
              ).flatMap((script) =>
                script.sideEffects === "undeclared"
                  ? []
                  : [[script.path, script.sideEffects]],
              ),
            );
            return {
              name: source.name,
              location: source.location,
              ...(Object.keys(scripts).length > 0 && { scripts }),
            };
          },
        );
        const input = {
          workflowVersionId: versionId,
          dossierHash: evidence.composition.hash,
          dossier,
          skillSources,
        };
        composition = composeFactoryPlan(input, deriveFactoryPlan(input));
        for (const finding of composition.findings)
          reject(finding.path + " — " + finding.message);
        if (!findings.length) {
          const loaded = await proposalForPlan(
            config,
            versionId,
            composition,
            basis.pinsHash,
          );
          proposalHash = loaded.proposal.proposalHash;
          for (const problem of [
            ...loaded.proposal.blockers,
            ...loaded.serviceBlockers,
          ])
            reject(publicKernelMessage(config, problem));
        }
      } catch (error) {
        reject(
          publicKernelMessage(
            config,
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
  } else if (!findings.length)
    reject("Save a workflow map for the checked source versions.");
  const files = await buildImplementationFiles(tx, versionId);
  const preview = gatePreview({
    gate: "workflow-build",
    workflowVersionId: versionId,
    boundHashes: {
      ...evidence.preview.boundHashes,
      pins: basis?.pinsHash ?? canonicalHash(null),
      plan: composition?.hash ?? canonicalHash(null),
      proposal: proposalHash ?? canonicalHash(null),
      creatorState:
        (await readKernelState(tx, versionId))?.hash ?? canonicalHash(null),
      ...(files.length && { implementation: canonicalHash(files) }),
    },
    records: evidence.preview.records,
    effects: [
      { id: "source-study", state: "done" },
      { id: "questionnaire", state: "done" },
      { id: "dossier", state: "done" },
      { id: "plan-proposal", state: "done" },
      { id: "package", state: "active" },
    ],
  });
  return { preview, findings, composition, evidence: evidence.composition };
}

export async function enqueueMappedBuild(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  confirmation: GateConfirmation,
  basis: Awaited<ReturnType<typeof workflowBuildPreview>>,
) {
  if (!basis.composition || !basis.evidence || basis.findings.length)
    throw new RequestError(409, "The workflow map is incomplete");
  await storeApprovedWorkingDossier(
    tx,
    deps,
    context,
    versionId,
    basis.evidence,
  );
  const head = await readPlanHead(tx, versionId);
  await storePlan(tx, deps, context, basis.composition, head?.id ?? null, true);
  await tx.query(
    `insert into workflow_jobs(id,kind,workflow_version_id,requester_id,status,requested_at,pins_hash,plan_version_hash,proposal_hash,proposal_confirmation_id,request_id,generation_confirmation_id,creator_state_hash)
    values($1,'generate',$2,$3,'queued',$4,$5,$6,$7,$8,$9,$8,$10)`,
    [
      deps.ids.next(),
      versionId,
      context.personId,
      deps.clock.now(),
      confirmation.boundHashes.pins,
      confirmation.boundHashes.plan,
      confirmation.boundHashes.proposal,
      confirmation.id,
      confirmation.requestId,
      confirmation.boundHashes.creatorState,
    ],
  );
}
