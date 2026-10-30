import { recordAudit, type WriteContext } from "../audit.js";
import type { ServiceConfig } from "../config.js";
import type { Database, Queryable } from "../database/database.js";
import type { ServiceDependencies } from "../dependencies.js";
import { objectInput, RequestError } from "../http/errors.js";
import { toIsoString } from "../util.js";
import { fetchGitFiles } from "./git.js";
import type { Skill } from "./library.js";
import { inspectUpload } from "./upload.js";

export interface SkillRepository {
  id: string;
  skillId: string;
  url: string;
  registeredBy: string;
  createdAt: string;
}
interface RepositoryRow {
  id: string;
  skill_id: string;
  url: string;
  registered_by: string;
  created_at: string | Date;
}
function repository(row: RepositoryRow): SkillRepository {
  return {
    id: row.id,
    skillId: row.skill_id,
    url: row.url,
    registeredBy: row.registered_by,
    createdAt: toIsoString(row.created_at),
  };
}
function allowedRepository(config: ServiceConfig, value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || /[\s\\]/u.test(value))
    throw new RequestError(
      400,
      "A repository needs an absolute HTTPS URL without credentials",
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RequestError(400, "A repository needs an absolute HTTPS URL");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["https:", "http:"].includes(url.protocol) ||
    url.pathname === "/"
  )
    throw new RequestError(
      400,
      "Repository URLs must name a repository without credentials, a query, or a fragment",
    );
  if (!config.git.allowedOrigins.includes(url.origin))
    throw new RequestError(
      403,
      "The deployment has not enabled this Git origin",
    );
  return url.href.replace(/\/+$/u, "");
}
export async function listRepositories(database: Queryable, skillId: string) {
  const rows = await database.query<RepositoryRow>(
    "select * from skill_repositories where skill_id = $1 order by created_at, id",
    [skillId],
  );
  return rows.rows.map(repository);
}
export async function registerRepository(
  database: Database,
  dependencies: ServiceDependencies,
  context: WriteContext,
  config: ServiceConfig,
  skill: Skill,
  value: unknown,
) {
  const input = objectInput(value);
  if (Object.keys(input).some((key) => key !== "url"))
    throw new RequestError(400, "Unknown repository field");
  const url = allowedRepository(config, input["url"]);
  return database.transaction(async (tx) => {
    const inserted = await tx.query<RepositoryRow>(
      "insert into skill_repositories (id, skill_id, url, registered_by, created_at) values ($1, $2, $3, $4, $5) on conflict do nothing returning *",
      [
        dependencies.ids.next(),
        skill.id,
        url,
        context.personId,
        dependencies.clock.now(),
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) {
      const existing = await tx.query<RepositoryRow>(
        "select * from skill_repositories where skill_id = $1 and url = $2",
        [skill.id, url],
      );
      return { created: false, repository: repository(existing.rows[0]!) };
    }
    await recordAudit(tx, dependencies, {
      actor: { personId: context.personId, credential: context.credential },
      channel: context.channel,
      action: "skill_repository.registered",
      target: { type: "skill_repository", id: row.id, label: url },
      before: null,
      after: null,
      reason: "Skill repository registered",
      requestId: context.requestId,
    });
    return { created: true, repository: repository(row) };
  });
}
export async function inspectRepository(
  database: Queryable,
  config: ServiceConfig,
  skill: Skill,
  value: unknown,
) {
  const input = objectInput(value);
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "repositoryId",
          "commit",
          "scripts",
          "confirmed",
          "expectedHash",
        ].includes(key),
    )
  )
    throw new RequestError(400, "Unknown Git import field");
  const repositoryId = input["repositoryId"];
  const commit = input["commit"];
  if (
    typeof repositoryId !== "string" ||
    typeof commit !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)
  )
    throw new RequestError(
      400,
      "A Git source needs a registered repositoryId and a full commit hash",
    );
  const found = await database.query<RepositoryRow>(
    "select * from skill_repositories where skill_id = $1 and id = $2",
    [skill.id, repositoryId],
  );
  const row = found.rows[0];
  if (row === undefined)
    throw new RequestError(404, "No such registered repository for this Skill");
  const url = allowedRepository(config, row.url);
  const files = await fetchGitFiles(config, url, commit);
  const inspected = await inspectUpload(config, skill.name, {
    files: files.map((file) => ({
      path: file.path,
      content: file.content.toString("base64"),
    })),
    ...(input["scripts"] === undefined ? {} : { scripts: input["scripts"] }),
  });
  return { ...inspected, gitOrigin: { repositoryId, repository: url, commit } };
}
