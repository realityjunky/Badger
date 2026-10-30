import {
  canonicalHash,
  createQuestionnaireHandoff,
  validateSemanticDossier,
  type DossierComposition,
  type DossierSnapshot,
  type SemanticDossier,
} from "@realityjunky/badger";
import type { Queryable } from "./database/database.js";
import type { ServiceDependencies } from "./dependencies.js";
import { recordAudit, type WriteContext } from "./audit.js";
import { readQuestionnaireRecords } from "./questionnaire/ledger.js";
import { readSourceStudy } from "./source-study.js";
import { listWorkflowPins } from "./workflow-source.js";
import { toIsoString } from "./util.js";
import type { WorkflowVersion } from "./workflows.js";
import { gatePreview, invalidateGate, type GateState } from "./gates.js";
import { invalidateProposal } from "./proposal-invalidation.js";
import { closeGateInbox, notifyWorkflowRoles } from "./inbox.js";

export interface DossierVersion {
  id: string;
  number: number;
  hash: string;
  canonicalJson: string;
  snapshot: DossierSnapshot;
  createdBy: string;
  createdAt: string;
}
interface DossierRow {
  id: string;
  number: number;
  hash: string;
  canonical_json: string;
  created_by: string;
  created_at: Date | string;
}
function toVersion(row: DossierRow): DossierVersion {
  return {
    id: row.id,
    number: row.number,
    hash: row.hash,
    canonicalJson: row.canonical_json,
    snapshot: JSON.parse(row.canonical_json) as DossierSnapshot,
    createdBy: row.created_by,
    createdAt: toIsoString(row.created_at),
  };
}
export async function readDossierVersions(tx: Queryable, versionId: string) {
  const result = await tx.query<DossierRow>(
    "select * from dossier_versions where workflow_version_id = $1 order by number desc",
    [versionId],
  );
  return result.rows.map(toVersion);
}

/** The current version is the latest head's, which need not be the newest. */
export async function readDossierHead(
  tx: Queryable,
  versionId: string,
): Promise<DossierVersion | null> {
  const row = (
    await tx.query<DossierRow>(
      `select d.* from dossier_heads h
        join dossier_versions d on d.workflow_version_id = h.workflow_version_id and d.hash = h.dossier_hash
       where h.workflow_version_id = $1 order by h.sequence desc limit 1`,
      [versionId],
    )
  ).rows[0];
  return row === undefined ? null : toVersion(row);
}

/** Project durable identities and provenance; all authoring rules stay in the kernel. */
export async function dossierInputs(
  tx: Queryable,
  version: WorkflowVersion,
  personId: string,
) {
  const pins = await listWorkflowPins(tx, version.id);
  const study = await readSourceStudy(tx, version.id);
  const sources: SemanticDossier["sources"] = pins.map((p) => ({
    id: p.skillId,
    name: p.skillName,
    location: `skills/${p.skillName}`,
    contentHash: p.hash,
    roles: [p.purpose],
  }));
  return {
    workflowVersionId: version.id,
    workflow: {
      name: version.name,
      goal: version.goal,
      intent: version.intent,
      defaultLocale: "en" as const,
    },
    sources,
    records: await readQuestionnaireRecords(tx, version.id, personId),
    sourceEvidence: Object.fromEntries(
      [...study.facts, ...study.interfaces].map((r) => [
        r.id,
        {
          sourceId: r.content.evidence[0]?.skillId ?? "",
          evidencePath: r.content.evidence[0]?.path ?? "",
        },
      ]),
    ),
  };
}

/**
 * Content identical to the current version returns it unchanged. Any other
 * composition appends a head: to a new version, or to the earlier version
 * with identical content, which is selected again and needs the same new
 * approval as a new version.
 */
export async function storeDossier(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  composition: DossierComposition,
) {
  const head = await readDossierHead(tx, versionId);
  if (head?.hash === composition.hash) return { version: head, changed: false };
  const versions = await readDossierVersions(tx, versionId);
  const earlier = versions.find((v) => v.hash === composition.hash);
  const version =
    earlier ??
    toVersion(
      (
        await tx.query<DossierRow>(
          `insert into dossier_versions (id, workflow_version_id, number, hash, canonical_json, created_by, created_at)
          values ($1,$2,$3,$4,$5,$6,$7) returning *`,
          [
            deps.ids.next(),
            versionId,
            (versions[0]?.number ?? 0) + 1,
            composition.hash,
            composition.canonicalJson,
            context.personId,
            deps.clock.now(),
          ],
        )
      ).rows[0]!,
    );
  const headId = deps.ids.next();
  await tx.query(
    `insert into dossier_heads (id, workflow_version_id, sequence, dossier_hash, selected_by, selected_at)
    select $1, $2, coalesce(max(sequence), 0) + 1, $3, $4, $5 from dossier_heads where workflow_version_id = $2`,
    [headId, versionId, version.hash, context.personId, deps.clock.now()],
  );
  const change = earlier
    ? "Selecting an earlier dossier version again"
    : "A new dossier version";
  await invalidateGate(
    tx,
    deps,
    context,
    versionId,
    "dossier",
    `${change} superseded the approval`,
    ["Engineer", "Workflow owner"],
  );
  await updateDossierStages(tx, deps, versionId, true);
  await invalidateGate(
    tx,
    deps,
    context,
    versionId,
    "plan",
    `${change} superseded the plan's meaning`,
    ["Engineer", "Workflow owner"],
  );
  await invalidateProposal(
    tx,
    deps,
    context,
    versionId,
    `${change} superseded the proposal's plan`,
  );
  await closeGateInbox(
    tx,
    versionId,
    "dossier",
    deps.clock.now(),
    "gate-ready",
  );
  // Each head is a new request for approval, even of an earlier version.
  await notifyWorkflowRoles(
    tx,
    deps,
    versionId,
    "dossier",
    "gate-ready",
    headId,
    ["Workflow owner"],
  );
  await recordAudit(tx, deps, {
    actor: { personId: context.personId, credential: context.credential },
    channel: context.channel,
    action: earlier ? "dossier.reselected" : "dossier.composed",
    target: { type: "dossier_version", id: version.id },
    before: earlier && head ? { revision: head.number, hash: head.hash } : null,
    after: { revision: version.number, hash: version.hash },
    reason: earlier
      ? "Selected an earlier dossier version again"
      : "Composed a dossier version",
    requestId: context.requestId,
  });
  return { version, changed: true };
}

async function updateDossierStages(
  tx: Queryable,
  deps: ServiceDependencies,
  versionId: string,
  composed: boolean,
) {
  const row = (
    await tx.query<{ stages: Record<string, string> }>(
      "select stages from workflow_versions where id = $1",
      [versionId],
    )
  ).rows[0]!;
  const stages = row.stages;
  const before = canonicalHash(stages);
  stages.dossier = composed ? "active" : "invalidated";
  if (composed) stages.questionnaire = "done";
  else if (stages.questionnaire === "done") stages.questionnaire = "active";
  for (const stage of [
    "plan-proposal",
    "package",
    "evaluation",
    "review-publication",
  ])
    if (stages[stage] !== "todo") stages[stage] = "invalidated";
  if (!composed && canonicalHash(stages) === before) return;
  await tx.query(
    "update workflow_versions set stages = $2::jsonb, revision = revision + 1, updated_at = $3 where id = $1",
    [versionId, JSON.stringify(stages), deps.clock.now()],
  );
}

/** Run in the record writer's version-locked transaction, including its audit and inbox changes. */
export async function reconcileDossier(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  versionId: string,
) {
  const head = await readDossierHead(tx, versionId);
  if (!head) return;
  const ledger = createQuestionnaireHandoff({
    records: await readQuestionnaireRecords(tx, versionId, context.personId),
  });
  if (canonicalHash(ledger) === canonicalHash(head.snapshot.ledger)) return;
  await invalidateGate(
    tx,
    deps,
    context,
    versionId,
    "dossier",
    "The dossier's questionnaire or source records changed",
    ["Engineer", "Workflow owner"],
  );
  await updateDossierStages(tx, deps, versionId, false);
  await invalidateGate(
    tx,
    deps,
    context,
    versionId,
    "plan",
    "The plan's dossier records changed",
    ["Engineer", "Workflow owner"],
  );
  await invalidateProposal(
    tx,
    deps,
    context,
    versionId,
    "The proposal's plan and dossier records changed",
  );
}

export async function dossierGateState(
  tx: Queryable,
  versionId: string,
  personId: string,
): Promise<GateState> {
  const dossier = await readDossierHead(tx, versionId);
  const ledger = createQuestionnaireHandoff({
    records: await readQuestionnaireRecords(tx, versionId, personId),
  });
  const findings: GateState["findings"] = [];
  const reject = (code: string, message: string) =>
    findings.push({
      code,
      message,
      severity: "error",
      requiresUserDecision: false,
      requiredAction: "repair",
    });
  if (!dossier)
    reject(
      "DOSSIER_NOT_COMPOSED",
      "Ask the Engineer to compose a dossier version",
    );
  else {
    if (canonicalHash(ledger) !== canonicalHash(dossier.snapshot.ledger))
      reject(
        "DOSSIER_SUPERSEDED",
        "The dossier's records changed; ask the Engineer to compose a new version",
      );
    for (const finding of validateSemanticDossier(dossier.snapshot.dossier))
      reject("DOSSIER_INVALID", `${finding.path}: ${finding.message}`);
  }
  if (ledger.status !== "complete")
    reject(
      "DOSSIER_NOT_READY",
      "Resolve questionnaire readiness blockers before approving the dossier",
    );
  return {
    findings,
    preview: gatePreview({
      gate: "dossier",
      workflowVersionId: versionId,
      boundHashes: {
        dossier: dossier?.hash ?? canonicalHash(null),
        ledger: canonicalHash(ledger),
      },
      records: dossier
        ? [
            {
              type: "dossier-version",
              id: dossier.id,
              label: `Dossier ${dossier.number}`,
              hash: dossier.hash,
            },
          ]
        : [],
      effects: [
        { id: "questionnaire", state: "done" },
        { id: "dossier", state: "done" },
        { id: "plan-proposal", state: "active" },
      ],
    }),
  };
}
