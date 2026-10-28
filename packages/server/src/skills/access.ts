import {
  isAdministrator,
  mayManageGroup,
  visibleGroups,
  type Access,
} from "../authorization.js";
import type { Queryable } from "../database/database.js";
import type { Person } from "../people.js";

/** What one person may do with one Group's Skill library. */
export interface SkillGroupPermission {
  id: string;
  name: string;
  canUpload: boolean;
  canCreateSkill: boolean;
}

/**
 * The Groups whose Skills a person reads: those their Group bindings show
 * them, and the exact Group of each workflow where they hold a role. An
 * Engineer or Field expert there uploads and creates entries; a Group lead
 * creates entries; an Administrator does both everywhere.
 */
export async function skillGroupPermissions(
  database: Queryable,
  access: Access,
  person: Person,
): Promise<SkillGroupPermission[]> {
  const visible = await visibleGroups(database, access, person);
  const rows = await database.query<{
    id: string;
    name: string;
    may_upload: boolean;
  }>(
    `select g.id, g.name,
            exists (select 1 from role_bindings b
                      join workflows w on w.id = b.workflow_id
                     where b.scope_type = 'workflow' and w.group_id = g.id
                       and b.person_id = $3
                       and b.role in ('Engineer', 'Field expert')) as may_upload
       from groups g
      where $1::boolean or g.id = any($2::text[])
         or exists (select 1 from role_bindings b
                      join workflows w on w.id = b.workflow_id
                     where b.scope_type = 'workflow' and w.group_id = g.id
                       and b.person_id = $3)
      order by g.name, g.id`,
    [
      visible.everything,
      visible.everything ? [] : [...visible.groupIds],
      person.id,
    ],
  );
  const administrator = isAdministrator(access);
  return Promise.all(
    rows.rows.map(async (row) => {
      const canUpload = administrator || row.may_upload;
      return {
        id: row.id,
        name: row.name,
        canUpload,
        canCreateSkill:
          canUpload || (await mayManageGroup(database, access, person, row.id)),
      };
    }),
  );
}
