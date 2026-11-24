import { canonicalHash } from "@realityjunky/badger";
import type { Access } from "../authorization.js";
import type { ServiceConfig } from "../config.js";
import type { Queryable } from "../database/database.js";
import { RequestError } from "../http/errors.js";
import type { Person } from "../people.js";
import { LOCAL_IDENTITY_ISSUER } from "../identity/local.js";
import { skillGroupPermissions } from "../skills/access.js";
import { readSkill } from "../skills/library.js";
import { toIsoString } from "../util.js";
import type { SkillQuestionnaireScope } from "./subject.js";

interface SkillVersionRow {
  hash: string;
  label: string | null;
  created_at: Date | string;
  retired_at: Date | string | null;
}

function versionSummary(row: SkillVersionRow) {
  return {
    versionHash: row.hash,
    label: row.label,
    createdAt: toIsoString(row.created_at),
    retiredAt: row.retired_at === null ? null : toIsoString(row.retired_at),
  };
}

async function visibleSkill(
  database: Queryable,
  access: Access,
  person: Person,
  skillId: string,
) {
  const skill = await readSkill(database, skillId);
  if (!skill) return null;
  const permission = (
    await skillGroupPermissions(database, access, person)
  ).find((grant) => grant.id === skill.groupId);
  return permission ? { skill, permission } : null;
}

export async function listSkillQuestionnaireVersions(
  database: Queryable,
  access: Access,
  person: Person,
) {
  const groups = await skillGroupPermissions(database, access, person);
  const result = await database.query<
    SkillVersionRow & {
      skill_id: string;
      skill_name: string;
      group_name: string;
      base_hashes: string[];
    }
  >(
    `select v.hash, v.label, v.created_at, v.retired_at, s.id as skill_id, s.name as skill_name, g.name as group_name,
      array(select distinct o.base_hash from skill_version_edit_origins o
        where o.skill_id = v.skill_id and o.hash = v.hash order by o.base_hash) as base_hashes
    from skill_versions v join skills s on s.id = v.skill_id join groups g on g.id = s.group_id
    where g.id = any($1::text[]) order by g.name, s.name, v.created_at desc, v.hash`,
    [groups.map((group) => group.id)],
  );
  return result.rows.map((row) => ({
    skillId: row.skill_id,
    skillName: row.skill_name,
    groupName: row.group_name,
    baseHashes: row.base_hashes,
    ...versionSummary(row),
  }));
}

export async function readSkillQuestionnaireSubject(
  database: Queryable,
  access: Access,
  person: Person,
  skillId: string,
  versionHash: string,
  lock: { subject: boolean; versions: string[] },
  config: ServiceConfig,
) {
  const visible = await visibleSkill(database, access, person, skillId);
  if (!visible) throw new RequestError(404, "No such Skill version");
  const { skill, permission } = visible;
  if (lock.versions.length > 0)
    await database.query(
      `select hash from skill_versions where skill_id = $1 and hash = any($2::text[]) order by hash for update`,
      [skillId, lock.versions],
    );
  const row = (
    await database.query<SkillVersionRow>(
      "select hash, label, created_at, retired_at from skill_versions where skill_id = $1 and hash = $2",
      [skillId, versionHash],
    )
  ).rows[0];
  if (!row) throw new RequestError(404, "No such Skill version");
  if (lock.subject)
    await database.query(
      "select id from skill_questionnaires where skill_id = $1 and version_hash = $2 for no key update",
      [skillId, versionHash],
    );
  const localAdministrator =
    config.identity.kind === "local" ? config.identity.administrator : null;
  const administrators = await database.query<{ id: string }>(
    `select id from people where status = 'active' and
     ((email_verified and lower(email) = any($1::text[])) or
       (issuer = $2 and subject = $3)) order by id`,
    [
      config.bootstrapAdministrators,
      LOCAL_IDENTITY_ISSUER,
      localAdministrator?.subject ?? null,
    ],
  );
  const scope: SkillQuestionnaireScope = {
    id: `skill:${canonicalHash({ skillId, versionHash })}`,
    skillId,
    versionHash,
    groupId: skill.groupId,
    configuredAdministratorIds: administrators.rows.map(({ id }) => id),
  };
  const compose = access.tokenScopes === undefined && permission.canCreateSkill;
  const participant =
    scope.configuredAdministratorIds.includes(person.id) ||
    (
      await database.query(
        "select 1 from skill_questionnaire_participants where group_id = $1 and person_id = $2",
        [skill.groupId, person.id],
      )
    ).rows.length > 0;
  const respond =
    participant &&
    (access.tokenScopes === undefined ||
      access.tokenScopes.includes("expert") ||
      access.tokenScopes.includes("engineer"));
  return {
    scope,
    subject: {
      kind: "skill" as const,
      id: scope.id,
      skillId,
      ...versionSummary(row),
    },
    skill,
    groupName: permission.name,
    capabilities: {
      compose,
      reviewSuggestions: false,
      resolve: compose,
      answer: respond,
      acknowledge: participant && access.tokenScopes === undefined,
      comment: compose || respond,
      raiseConcern: false,
      resolveConcern: false,
    },
  };
}

export async function listSkillQuestionnaireAssignees(
  database: Queryable,
  scope: SkillQuestionnaireScope,
) {
  const list = await database.query<{
    person_id: string;
    display_name: string;
  }>(
    `select p.id as person_id, p.display_name from people p
    where p.status = 'active' and (p.id = any($2::text[]) or exists (
      select 1 from skill_questionnaire_participants a where a.person_id = p.id and a.group_id = $1
    )) order by p.display_name, p.id`,
    [scope.groupId, scope.configuredAdministratorIds],
  );
  return list.rows.map((row) => ({
    personId: row.person_id,
    name: row.display_name,
    role: null,
  }));
}
