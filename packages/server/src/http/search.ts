import { isAdministrator } from "../authorization.js";
import { questionnaireCapabilities } from "../questionnaire/access.js";
import { skillGroupPermissions } from "../skills/access.js";
import { listSkills } from "../skills/library.js";
import { listWorkflows } from "../workflows.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { RequestError } from "./errors.js";

export interface SearchResult {
  kind: "workflow" | "question" | "skill";
  id: string;
  label: string;
  context: string;
  href: string;
}

export async function handleSearch(input: AuthorizedRequest): Promise<void> {
  const { database, access, person, reply, url } = input;
  const query = (url.searchParams.get("q") ?? "").trim();
  if (query.length > 200)
    throw new RequestError(400, "Search is limited to 200 characters");
  if (query === "") return reply.json(200, { results: [] });
  const groupId = url.searchParams.get("group");
  const workflowId = url.searchParams.get("workflow");
  const versionId = url.searchParams.get("version");
  if (versionId && !workflowId)
    throw new RequestError(400, "A version filter requires a workflow");
  const workflows = (await listWorkflows(database, access, person)).filter(
    (workflow) =>
      (!groupId || workflow.groupId === groupId) &&
      (!workflowId || workflow.id === workflowId),
  );
  if (workflowId && workflows.length === 0)
    return reply.json(200, { results: [] });
  if (versionId) {
    const version = await database.query(
      "select 1 from workflow_versions where id = $1 and workflow_id = any($2::text[])",
      [versionId, workflows.map((workflow) => workflow.id)],
    );
    if (version.rows.length === 0) return reply.json(200, { results: [] });
  }
  const needle = query.toLocaleLowerCase();
  const results: SearchResult[] = workflows
    .filter((workflow) =>
      `${workflow.name} ${workflow.goal}`.toLocaleLowerCase().includes(needle),
    )
    .slice(0, 10)
    .map((workflow) => ({
      kind: "workflow",
      id: workflow.id,
      label: workflow.name,
      context: workflow.goal,
      href: `/workflows/${encodeURIComponent(workflow.id)}${versionId ? `/versions/${encodeURIComponent(versionId)}` : ""}`,
    }));
  const composerIds: string[] = [];
  if (!isAdministrator(access)) {
    for (const workflow of workflows) {
      if (
        (await questionnaireCapabilities(database, access, person, workflow.id))
          .compose
      )
        composerIds.push(workflow.id);
    }
  }
  const questions = await database.query<{
    id: string;
    text: string;
    name: string;
    number: number;
    semantic_version: string | null;
  }>(
    `select q.id, left(r.content->>'text', 200) as text, v.name, v.number, v.semantic_version
       from questions q
       join question_revisions r on r.question_id = q.id and r.revision = q.revision
       join workflow_versions v on v.id = q.workflow_version_id
      where v.workflow_id = any($1::text[])
        and ($2::boolean or v.workflow_id = any($3::text[]) or q.state <> 'draft')
        and ($4::text is null or v.id = $4)
        and strpos(lower(r.content->>'text'), lower($5)) > 0
      order by v.name, v.number desc, q.id limit 10`,
    [
      workflows.map((workflow) => workflow.id),
      isAdministrator(access),
      composerIds,
      versionId,
      query,
    ],
  );
  results.push(
    ...questions.rows.map((question): SearchResult => ({
      kind: "question",
      id: question.id,
      label: question.text,
      context: `${question.name} · ${question.semantic_version ?? `v${question.number}`}`,
      href: `/questionnaire/questions/${encodeURIComponent(question.id)}`,
    })),
  );
  const skillGroups = (
    await skillGroupPermissions(database, access, person)
  ).filter(
    (group) =>
      (!groupId || group.id === groupId) &&
      (!workflowId || group.id === workflows[0]?.groupId),
  );
  const skills = await listSkills(
    database,
    skillGroups.map((group) => group.id),
  );
  results.push(
    ...skills
      .filter((skill) => skill.name.toLocaleLowerCase().includes(needle))
      .slice(0, 10)
      .map((skill): SearchResult => ({
        kind: "skill",
        id: skill.id,
        label: skill.name,
        context:
          skillGroups.find((group) => group.id === skill.groupId)?.name ?? "",
        href: `/skills/${encodeURIComponent(skill.id)}`,
      })),
  );
  return reply.json(200, { results });
}
