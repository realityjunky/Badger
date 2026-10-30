import { readLedger } from "../questionnaire/ledger.js";
import { composeSemanticDossier } from "@realityjunky/badger";
import {
  dossierInputs,
  readDossierHead,
  readDossierVersions,
  storeDossier,
} from "../dossier.js";
import { canonicalHash } from "@realityjunky/badger";
import { readGateConfirmations } from "../gates.js";
import { workflowCapabilities } from "../workflow-access.js";
import { listWorkflowVersions, readWorkflow } from "../workflows.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { readJsonBody } from "./body.js";
import { objectInput, RequestError } from "./errors.js";

const PATH =
  /^\/api\/v1\/workflows\/([^/]+)\/versions\/([^/]+)\/dossier(?:\/(preview|compose))?$/u;

export function dossierMethods(path: string): string | null {
  const match = PATH.exec(path);
  return match === null ? null : match[3] === undefined ? "GET, HEAD" : "POST";
}

export async function handleDossier(input: AuthorizedRequest): Promise<void> {
  const {
    path,
    method,
    database,
    person,
    access,
    reply,
    request,
    dependencies,
    context,
    config,
  } = input;
  const match = PATH.exec(path)!;
  const methods = dossierMethods(path)!;
  if (!methods.split(", ").includes(method))
    return reply.error(405, "invalid", "Method not allowed", {
      allow: methods,
    });
  const workflowId = decodeURIComponent(match[1]);
  const versionId = decodeURIComponent(match[2]);
  const body = match[3] === undefined ? null : await readJsonBody(request);
  if (body !== null && !body.ok)
    return reply.error(400, "invalid", body.message);
  const value = body?.ok ? objectInput(body.value) : {};
  const allowed = [
    "topics",
    "nodes",
    "upgradeSource",
    ...(match[3] === "compose" ? ["confirmationHash"] : []),
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new RequestError(
      400,
      "Only topic summaries, Node responsibilities, and upgrade recovery can be authored; the ledger is derived from records",
    );
  const result = await database.transaction(async (tx) => {
    await tx.query(
      "select id from workflow_versions where id = $1 for no key update",
      [versionId],
    );
    const workflow = await readWorkflow(tx, workflowId);
    if (!workflow) throw new RequestError(404, "No such workflow");
    const caps = await workflowCapabilities(tx, access, person, workflow);
    if (!caps.read)
      throw new RequestError(403, "This workflow is outside your roles");
    const version = (await listWorkflowVersions(tx, workflowId)).find(
      (v) => v.id === versionId,
    );
    if (!version) throw new RequestError(404, "No such workflow version");
    if (match[3] !== undefined && !caps.composeDossier)
      throw new RequestError(
        403,
        "Only a signed-in Engineer or Administrator composes a dossier",
      );
    if (match[3] === undefined) {
      const versions = await readDossierVersions(tx, versionId);
      const { handoff } = await readLedger(
        tx,
        versionId,
        person.id,
        caps.composeDossier,
      );
      const head = await readDossierHead(tx, versionId);
      const currentVersionId =
        head && canonicalHash(head.snapshot.ledger) === canonicalHash(handoff)
          ? head.id
          : null;
      const confirmations = await readGateConfirmations(
        tx,
        versionId,
        "dossier",
      );
      return {
        status: 200,
        value: {
          versions,
          headVersionId: head?.id ?? null,
          currentVersionId,
          confirmation: confirmations[0] ?? null,
          confirmations,
          handoff,
        },
      };
    }
    const { handoff } = await readLedger(tx, versionId, person.id, true);
    if (handoff.status !== "complete")
      throw new RequestError(
        409,
        "Resolve questionnaire readiness blockers before composing a dossier",
        { readiness: handoff.readiness },
      );
    const composition = composeSemanticDossier({
      ...(await dossierInputs(tx, version, person.id, config)),
      semantics: value,
    });
    if (match[3] === "preview") return { status: 200, value: { composition } };
    if (value.confirmationHash !== composition.hash)
      throw new RequestError(
        409,
        "The dossier or its records changed; preview again",
      );
    if (composition.findings.length)
      throw new RequestError(
        409,
        "Repair the kernel's dossier findings before composing",
        { findings: composition.findings },
      );
    const stored = await storeDossier(
      tx,
      dependencies,
      context,
      versionId,
      composition,
    );
    return {
      status: stored.changed ? 201 : 200,
      value: { version: stored.version },
    };
  });
  reply.json(result.status, result.value);
}
