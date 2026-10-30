import {
  composeFactoryPlan,
  canonicalHash,
  deriveFactoryPlan,
  type PlanComposition,
  type PlanCompositionInput,
  type PlanSnapshot,
  type SkillSourceDeclaration,
} from "@realityjunky/badger";
import { recordAudit, type WriteContext } from "./audit.js";
import type { Queryable } from "./database/database.js";
import type { ServiceDependencies } from "./dependencies.js";
import { dossierGateState, readDossierVersions } from "./dossier.js";
import {
  gatePreview,
  readGateConfirmations,
  invalidateGate,
  type GateState,
} from "./gates.js";
import { closeGateInbox, notifyWorkflowRoles } from "./inbox.js";
import { readVersion } from "./skills/library.js";
import { listWorkflowPins } from "./workflow-source.js";
import { RequestError } from "./http/errors.js";
import { toIsoString } from "./util.js";

interface PlanRow {
  id: string;
  number: number;
  hash: string;
  canonical_json: string;
  created_by: string;
  created_at: string | Date;
}
function toVersion(row: PlanRow) {
  return {
    id: row.id,
    number: row.number,
    hash: row.hash,
    canonicalJson: row.canonical_json,
    snapshot: JSON.parse(row.canonical_json) as PlanSnapshot,
    createdBy: row.created_by,
    createdAt: toIsoString(row.created_at),
  };
}
export async function readPlanVersions(tx: Queryable, versionId: string) {
  return (
    await tx.query<PlanRow>(
      "select * from plan_versions where workflow_version_id = $1 order by number desc",
      [versionId],
    )
  ).rows.map(toVersion);
}

/** Gate history grants approval; a dossier's payload flag never does. */
export async function planInputs(
  tx: Queryable,
  versionId: string,
  personId: string,
): Promise<PlanCompositionInput | null> {
  const dossier = (await readDossierVersions(tx, versionId))[0];
  const approval = (await readGateConfirmations(tx, versionId, "dossier")).find(
    (c) => c.invalidatedAt === null,
  );
  if (
    !dossier ||
    approval?.boundHashes.dossier !== dossier.hash ||
    (await dossierGateState(tx, versionId, personId)).findings.length
  )
    return null;
  const pins = await listWorkflowPins(tx, versionId);
  const skillSources: SkillSourceDeclaration[] = [];
  for (const source of dossier.snapshot.dossier.sources) {
    const pin = pins.find(
      (pin) => pin.skillId === source.id && pin.hash === source.contentHash,
    );
    if (!pin) return null;
    const version = await readVersion(tx, pin.skillId, pin.hash);
    const scripts = Object.fromEntries(
      version.scripts
        .filter((script) => script.sideEffects !== "undeclared")
        .map((script) => [script.path, script.sideEffects]),
    );
    skillSources.push({
      name: source.name,
      location: source.location,
      ...(Object.keys(scripts).length
        ? { scripts: scripts as SkillSourceDeclaration["scripts"] }
        : {}),
    });
  }
  return {
    workflowVersionId: versionId,
    dossierHash: dossier.hash,
    dossier: dossier.snapshot.dossier,
    skillSources,
  };
}

export function requirePlanInputs(
  input: PlanCompositionInput | null,
  dossierHash: unknown,
): PlanCompositionInput {
  if (!input || input.dossierHash !== dossierHash)
    throw new RequestError(
      409,
      "Review the current approved dossier before planning",
    );
  return input;
}

/** Called under the Workflow version lock by direct saves and human draft acceptance. */
export async function storePlan(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  composition: PlanComposition,
  expectedVersionId: unknown,
) {
  if (composition.findings.length)
    throw new RequestError(
      409,
      "Repair the kernel's plan findings before saving",
      { findings: composition.findings },
    );
  const versionId = composition.snapshot.workflowVersionId;
  const versions = await readPlanVersions(tx, versionId);
  const latest = versions[0];
  if (latest?.hash === composition.hash)
    return { version: latest, created: false };
  if (expectedVersionId !== (latest?.id ?? null))
    throw new RequestError(
      409,
      "Another plan version was saved; reload before saving your edits",
    );
  if (versions.some((version) => version.hash === composition.hash))
    throw new RequestError(
      409,
      "This is an earlier plan version; review the latest plan",
    );
  const row = (
    await tx.query<PlanRow>(
      `insert into plan_versions (id, workflow_version_id, dossier_hash, number, hash, canonical_json, created_by, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [
        deps.ids.next(),
        versionId,
        composition.snapshot.dossierHash,
        (latest?.number ?? 0) + 1,
        composition.hash,
        composition.canonicalJson,
        context.personId,
        deps.clock.now(),
      ],
    )
  ).rows[0]!;
  await invalidateGate(
    tx,
    deps,
    context,
    versionId,
    "plan",
    "A new plan version superseded the approval",
    ["Engineer", "Workflow owner"],
  );
  const { stages } = (
    await tx.query<{ stages: Record<string, string> }>(
      "select stages from workflow_versions where id = $1",
      [versionId],
    )
  ).rows[0]!;
  stages["plan-proposal"] = "active";
  for (const stage of ["package", "evaluation", "review-publication"])
    if (stages[stage] !== "todo") stages[stage] = "invalidated";
  await tx.query(
    `update workflow_versions set stages = $2::jsonb, revision = revision + 1, updated_at = $3 where id = $1`,
    [versionId, JSON.stringify(stages), deps.clock.now()],
  );
  await closeGateInbox(tx, versionId, "plan", deps.clock.now(), "gate-ready");
  await notifyWorkflowRoles(tx, deps, versionId, "plan", "gate-ready", row.id, [
    "Workflow owner",
  ]);
  await recordAudit(tx, deps, {
    actor: { personId: context.personId, credential: context.credential },
    channel: context.channel,
    action: "plan.saved",
    target: { type: "plan_version", id: row.id },
    before: null,
    after: { revision: row.number, hash: row.hash },
    reason: "Saved a dossier-bound plan version",
    requestId: context.requestId,
  });
  return { version: toVersion(row), created: true };
}

export async function planView(
  tx: Queryable,
  versionId: string,
  personId: string,
) {
  const inputs = await planInputs(tx, versionId, personId);
  const versions = await readPlanVersions(tx, versionId);
  const latest = versions[0];
  return {
    versions,
    dossierHash: inputs?.dossierHash ?? null,
    skeleton: inputs ? deriveFactoryPlan(inputs) : null,
    currentVersionId:
      inputs && latest?.snapshot.dossierHash === inputs.dossierHash
        ? latest.id
        : null,
    confirmation:
      (await readGateConfirmations(tx, versionId, "plan"))[0] ?? null,
  };
}

export async function planGateState(
  tx: Queryable,
  versionId: string,
  personId: string,
): Promise<GateState> {
  const inputs = await planInputs(tx, versionId, personId);
  const plan = (await readPlanVersions(tx, versionId))[0];
  const findings: GateState["findings"] = [];
  const reject = (code: string, message: string) =>
    findings.push({
      code,
      message,
      severity: "error",
      requiresUserDecision: false,
      requiredAction: "repair",
    });
  if (!inputs)
    reject(
      "DOSSIER_NOT_APPROVED",
      "Approve the current dossier before approving a plan",
    );
  if (!plan)
    reject("PLAN_NOT_SAVED", "Ask the Engineer to save a plan version");
  else if (inputs) {
    if (plan.snapshot.dossierHash !== inputs.dossierHash)
      reject(
        "PLAN_SUPERSEDED",
        "Save a plan from the current approved dossier",
      );
    for (const finding of composeFactoryPlan(inputs, plan.snapshot.plan)
      .findings)
      reject("PLAN_INVALID", `${finding.path}: ${finding.message}`);
  }
  return {
    findings,
    preview: gatePreview({
      gate: "plan",
      workflowVersionId: versionId,
      boundHashes: {
        plan: plan?.hash ?? canonicalHash(null),
        dossier: inputs?.dossierHash ?? canonicalHash(null),
      },
      records: plan
        ? [
            {
              type: "plan-version",
              id: plan.id,
              label: `Plan ${plan.number}`,
              hash: plan.hash,
            },
          ]
        : [],
      // The proposal is a separate human gate before package authoring.
      effects: [{ id: "plan-proposal", state: "active" }],
    }),
  };
}
