import path from "node:path";
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
import type { ServiceConfig } from "./config.js";
import { gatePreview, invalidateGate, type GateState } from "./gates.js";
import { closeGateInbox, notifyWorkflowRoles } from "./inbox.js";
import { RequestError } from "./http/errors.js";

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

/** Project durable identities and provenance; all authoring rules stay in the kernel. */
export async function dossierInputs(
  tx: Queryable,
  version: WorkflowVersion,
  personId: string,
  config: ServiceConfig,
) {
  const pins = await listWorkflowPins(tx, version.id);
  const study = await readSourceStudy(tx, version.id);
  const sources: SemanticDossier["sources"] = pins.map((p) => ({
    id: p.skillId,
    name: p.skillName,
    location: `skills/${p.skillName}`,
    canonicalPath: path.resolve(
      config.storage.workspaceDirectory,
      "workflow-versions",
      version.id,
      "skills",
      p.skillName,
    ),
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

export async function storeDossier(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  composition: DossierComposition,
) {
  const versions = await readDossierVersions(tx, versionId);
  const existing = versions.find((v) => v.hash === composition.hash);
  if (existing) {
    if (existing.id !== versions[0]!.id)
      throw new RequestError(
        409,
        "This composition is an earlier dossier version; review the latest version before composing again",
      );
    return { version: existing, created: false };
  }
  const id = deps.ids.next();
  const number = (versions[0]?.number ?? 0) + 1;
  const result = await tx.query<DossierRow>(
    `insert into dossier_versions (id, workflow_version_id, number, hash, canonical_json, created_by, created_at)
    values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [
      id,
      versionId,
      number,
      composition.hash,
      composition.canonicalJson,
      context.personId,
      deps.clock.now(),
    ],
  );
  await invalidateGate(
    tx,
    deps,
    context,
    versionId,
    "dossier",
    "A new dossier version superseded the approval",
    ["Engineer", "Workflow owner"],
  );
  await updateDossierStages(tx, deps, versionId, true);
  await closeGateInbox(
    tx,
    versionId,
    "dossier",
    deps.clock.now(),
    "gate-ready",
  );
  await notifyWorkflowRoles(tx, deps, versionId, "dossier", "gate-ready", id, [
    "Workflow owner",
  ]);
  await recordAudit(tx, deps, {
    actor: { personId: context.personId, credential: context.credential },
    channel: context.channel,
    action: "dossier.composed",
    target: { type: "dossier_version", id },
    before: null,
    after: { revision: number, hash: composition.hash },
    reason: "Composed a dossier version",
    requestId: context.requestId,
  });
  return { version: toVersion(result.rows[0]!), created: true };
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
  const latest = (await readDossierVersions(tx, versionId))[0];
  if (!latest) return;
  const ledger = createQuestionnaireHandoff({
    records: await readQuestionnaireRecords(tx, versionId, context.personId),
  });
  if (canonicalHash(ledger) === canonicalHash(latest.snapshot.ledger)) return;
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
}

export async function dossierGateState(
  tx: Queryable,
  versionId: string,
  personId: string,
): Promise<GateState> {
  const dossier = (await readDossierVersions(tx, versionId))[0];
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
