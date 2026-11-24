import { recordAudit, type WriteContext } from "../audit.js";
import type { Database, Queryable } from "../database/database.js";
import type { ServiceDependencies } from "../dependencies.js";
import { objectInput, RequestError } from "../http/errors.js";
import { parseSemanticVersion } from "../workflow-version-labels.js";
import { lockBlobStore } from "./blobs.js";
import { readVersion, type Skill, type SkillVersion } from "./library.js";

export async function updateSkillVersionLabel(
  database: Database,
  dependencies: ServiceDependencies,
  context: WriteContext,
  skill: Skill,
  hash: string,
  value: unknown,
) {
  const input = objectInput(value);
  const revision = input["revision"];
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  )
    throw new RequestError(400, "A version label needs its current revision");
  const label = parseSemanticVersion(input["label"]);
  if (!label.ok)
    throw new RequestError(
      400,
      "Use a major.minor.patch label with no leading zeroes and at most 64 characters, or null to clear the label",
    );
  if (Object.keys(input).some((key) => !["label", "revision"].includes(key)))
    throw new RequestError(400, "Unknown version label field");
  return database.transaction(async (tx) => {
    await tx.query("select id from skills where id = $1 for no key update", [
      skill.id,
    ]);
    await tx.query(
      "select hash from skill_versions where skill_id = $1 and hash = $2 for no key update",
      [skill.id, hash],
    );
    const current = await readVersion(tx, skill.id, hash);
    if (current.labelRevision !== revision)
      throw new RequestError(
        409,
        "The version label changed since you read it",
        {
          version: current,
        },
      );
    if (current.label === label.value) return current;
    if (
      label.value !== null &&
      (
        await tx.query(
          "select 1 from skill_versions where skill_id = $1 and label = $2",
          [skill.id, label.value],
        )
      ).rows.length > 0
    )
      throw new RequestError(
        409,
        "That version label is already used in this Skill",
      );
    await tx.query(
      `update skill_versions set label = $3, label_revision = label_revision + 1
       where skill_id = $1 and hash = $2`,
      [skill.id, hash, label.value],
    );
    await recordAudit(tx, dependencies, {
      actor: { personId: context.personId, credential: context.credential },
      channel: context.channel,
      action: "skill_version.label_updated",
      target: {
        type: "skill_version",
        id: `${skill.id}:${hash}`,
        label: `${skill.name} · ${label.value ?? hash}`,
      },
      before: { revision: revision === 0 ? null : revision, hash },
      after: { revision: revision + 1, hash },
      reason: `Version label changed from ${current.label ?? "unlabelled"} to ${label.value ?? "unlabelled"}`,
      requestId: context.requestId,
    });
    return readVersion(tx, skill.id, hash);
  });
}

type RemovalAction = "delete" | "retire";

export async function versionRemoval(
  database: Queryable,
  version: SkillVersion,
) {
  const { rows } = await database.query<{ referenced: boolean }>(
    "select skill_version_is_referenced($1, $2) as referenced",
    [version.skillId, version.hash],
  );
  const referenced = rows[0]!.referenced;
  const action: RemovalAction | "none" = referenced
    ? version.retiredAt === null
      ? "retire"
      : "none"
    : "delete";
  return { action, referenced };
}

export async function removeSkillVersion(
  database: Database,
  dependencies: ServiceDependencies,
  context: WriteContext,
  skill: Skill,
  hash: string,
  value: unknown,
) {
  const input = objectInput(value);
  const action = input["action"];
  if (
    (action !== "delete" && action !== "retire") ||
    Object.keys(input).some((key) => key !== "action")
  )
    throw new RequestError(
      400,
      "Confirm whether to delete or retire this version",
    );
  return database
    .transaction(async (tx) => {
      if (action === "delete") await lockBlobStore(tx);
      await tx.query(
        "select hash from skill_versions where skill_id = $1 and hash = $2 for update",
        [skill.id, hash],
      );
      const version = await readVersion(tx, skill.id, hash);
      if (action === "retire" && version.retiredAt !== null)
        return { action, version };
      const removal = await versionRemoval(tx, version);
      if (removal.action !== action)
        throw new RequestError(
          409,
          removal.referenced
            ? "This version is referenced and must be retained. Review the available removal action."
            : "This version is unused and can be deleted. Review the available removal action.",
          { removal },
        );
      if (action === "delete") {
        await tx.query(
          "delete from skill_versions where skill_id = $1 and hash = $2",
          [skill.id, hash],
        );
        await tx.query(
          `insert into attachment_blob_cleanup (hash)
         select unnest($1::text[]) on conflict do nothing`,
          [version.inventory.map((file) => file.hash)],
        );
      } else {
        await tx.query(
          "update skill_versions set retired_at = $3 where skill_id = $1 and hash = $2",
          [skill.id, hash, dependencies.clock.now()],
        );
      }
      await recordAudit(tx, dependencies, {
        actor: { personId: context.personId, credential: context.credential },
        channel: context.channel,
        action:
          action === "delete"
            ? "skill_version.deleted"
            : "skill_version.retired",
        target: {
          type: "skill_version",
          id: `${skill.id}:${hash}`,
          label: `${skill.name} · ${version.label ?? hash}`,
        },
        before: { revision: null, hash },
        after: action === "delete" ? null : { revision: null, hash },
        reason:
          action === "delete"
            ? "Deleted an unreferenced Skill version"
            : "Retained a referenced Skill version and retired it from new pins",
        requestId: context.requestId,
      });
      return {
        action,
        version:
          action === "delete" ? null : await readVersion(tx, skill.id, hash),
      };
    })
    .catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23503"
      ) {
        throw new RequestError(
          409,
          "This version acquired a reference. Review the available removal action.",
        );
      }
      throw error;
    });
}
