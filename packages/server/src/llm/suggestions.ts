import { createHash, randomUUID } from "node:crypto";
import { Ajv } from "ajv";
import {
  SKILL_SCRIPT_SIDE_EFFECTS,
  type SkillScriptSideEffect,
  type SkillSource,
} from "@realityjunky/badger";
import type { ServiceConfig } from "../config.js";
import type { Database } from "../database/database.js";
import type { ServiceDependencies } from "../dependencies.js";
import { RequestError } from "../http/errors.js";
import { contentHash, SCRIPT_EFFECT_FUNCTION } from "./configuration.js";
import { callModel, RESPONSE_RULES, SUGGESTION_SCHEMA } from "./provider.js";
import { readConfiguration } from "./store.js";

export interface SuggestionBinding {
  sourceHash: string;
  scripts: { path: string; hash: string }[];
  promptRevision: string;
  configurationRevision: number;
  configurationHash: string;
  modelId: string;
  modelRevision: string;
}
export interface SuggestionPreview {
  id: string | null;
  state: "ready" | "unconfigured" | "incomplete" | "no-scripts";
  message: string | null;
  prompt: {
    functionId: string;
    description: string;
    text: string;
    revision: string;
  };
  binding: SuggestionBinding | null;
}
interface EvidenceFile {
  path: string;
  hash: string;
  content: string;
}
export interface ScriptSuggestion {
  path: string;
  effects: SkillScriptSideEffect[];
  rationale: string;
  complete: boolean;
  uncertainty: string;
  citations: {
    path: string;
    hash: string;
    startLine: number;
    endLine: number;
    excerpt?: string;
  }[];
}
export interface SuggestionResult {
  binding: SuggestionBinding;
  status: "complete" | "incomplete" | "failed";
  message: string | null;
  scripts: ScriptSuggestion[];
}

const validateResponse = new Ajv({ strict: false }).compile(SUGGESTION_SCHEMA);
const hashBytes = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

export async function prepareSuggestions(
  db: Database,
  config: ServiceConfig,
  deps: ServiceDependencies,
  skillId: string,
  personId: string,
  inspected: { source: SkillSource; files: Map<string, Buffer> },
): Promise<SuggestionPreview> {
  await db.query(
    "delete from skill_suggestion_previews where person_id = $1 and skill_id = $2 and source_hash <> $3",
    [personId, skillId, inspected.source.hash],
  );
  const accepted = await readConfiguration(db);
  const task = accepted.configuration.prompts[SCRIPT_EFFECT_FUNCTION];
  const preview: SuggestionPreview = {
    id: null,
    state: "unconfigured",
    message:
      "Automatic suggestions are not configured; declare script effects manually.",
    prompt: {
      functionId: SCRIPT_EFFECT_FUNCTION,
      ...task,
      revision: contentHash(task),
    },
    binding: null,
  };
  if (!inspected.source.scripts.length)
    return { ...preview, state: "no-scripts", message: null };
  const model = accepted.configuration.models.find(
    (m) => m.id === accepted.configuration.bindings[SCRIPT_EFFECT_FUNCTION],
  );
  if (!model) return preview;
  if (!model.enabled)
    return {
      ...preview,
      message:
        "The assigned model is disabled; declare script effects manually or ask an Administrator to enable it.",
    };
  const evidence: EvidenceFile[] = [];
  let size = 0;
  for (const entry of inspected.source.inventory) {
    const bytes = inspected.files.get(entry.path);
    size += bytes?.length ?? 0;
    if (
      !bytes ||
      size > accepted.configuration.limits.maxSourceBytes ||
      hashBytes(bytes) !== entry.hash
    )
      return {
        ...preview,
        state: "incomplete",
        message:
          "Complete source coverage exceeds the configured byte limit or source identity changed; all scripts need manual review.",
      };
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (content.includes("\0")) throw new Error();
      evidence.push({ path: entry.path, hash: entry.hash, content });
    } catch {
      return {
        ...preview,
        state: "incomplete",
        message:
          "Bundled binary or non-UTF-8 evidence cannot be analyzed completely; all scripts need manual review.",
      };
    }
  }
  const binding: SuggestionBinding = {
    sourceHash: inspected.source.hash,
    scripts: inspected.source.scripts.map((s) => ({
      path: s.path,
      hash: inspected.source.inventory.find((f) => f.path === s.path)!.hash,
    })),
    promptRevision: preview.prompt.revision,
    configurationRevision: accepted.revision,
    configurationHash: accepted.hash,
    modelId: model.id,
    modelRevision: contentHash(model),
  };
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(8231130000000295)");
    await tx.query(
      "delete from skill_suggestion_previews where expires_at < $1",
      [deps.clock.now()],
    );
    // Keep a bounded number of short-lived evidence snapshots per uploader.
    await tx.query(
      "delete from skill_suggestion_previews where id in (select id from skill_suggestion_previews where person_id = $1 and status <> 'running' order by expires_at desc offset 9)",
      [personId],
    );
    const count = await tx.query<{ count: number }>(
      "select count(*)::integer as count from skill_suggestion_previews where person_id = $1",
      [personId],
    );
    if (count.rows[0].count >= 10)
      throw new RequestError(
        503,
        "Too many active suggestion previews; finish an existing request or continue manually",
      );
    await tx.query(
      "insert into skill_suggestion_previews (id, skill_id, person_id, source_hash, configuration_revision, binding, evidence, status, expires_at) values ($1,$2,$3,$4,$5,$6,$7,'ready',$8)",
      [
        id,
        skillId,
        personId,
        binding.sourceHash,
        accepted.revision,
        JSON.stringify(binding),
        JSON.stringify(evidence),
        new Date(deps.clock.now().getTime() + 15 * 60000),
      ],
    );
  });
  return { ...preview, id, state: "ready", message: null, binding };
}

function validatedSuggestions(
  value: unknown,
  binding: SuggestionBinding,
  evidence: EvidenceFile[],
): ScriptSuggestion[] {
  if (!validateResponse(value))
    throw new RequestError(
      400,
      "Model response does not match the required script/effect/evidence schema; review scripts manually",
    );
  const scripts = (value as unknown as { scripts: ScriptSuggestion[] }).scripts;
  const seen = new Set<string>();
  for (const script of scripts) {
    if (
      !binding.scripts.some((s) => s.path === script.path) ||
      seen.has(script.path) ||
      (script.effects.includes("none") && script.effects.length !== 1) ||
      script.effects.some(
        (effect) => !SKILL_SCRIPT_SIDE_EFFECTS.includes(effect),
      )
    )
      throw new RequestError(
        400,
        "Model returned unknown scripts, duplicate scripts or contradictory effects; no suggestions were applied",
      );
    seen.add(script.path);
    if (!script.rationale.trim())
      throw new RequestError(
        400,
        "Each script suggestion needs a concise rationale",
      );
    for (const citation of script.citations) {
      const file = evidence.find((f) => f.path === citation.path);
      if (
        !file ||
        file.hash !== citation.hash ||
        citation.endLine < citation.startLine ||
        citation.endLine > file.content.split("\n").length
      )
        throw new RequestError(
          400,
          "Model returned unsupported source citations; no suggestions were applied",
        );
      citation.excerpt = file.content
        .split("\n")
        .slice(citation.startLine - 1, citation.endLine)
        .join("\n")
        .slice(0, 2000);
      if (!citation.excerpt.trim())
        throw new RequestError(
          400,
          "Model cited empty source lines; review scripts manually",
        );
    }
    if (
      script.complete &&
      (!script.effects.length ||
        script.uncertainty.length ||
        !script.citations.some((c) => c.path === script.path))
    )
      throw new RequestError(
        400,
        "A complete suggestion needs effects and direct script evidence without unresolved uncertainty",
      );
    if (!script.complete && !script.uncertainty.trim())
      throw new RequestError(
        400,
        "An incomplete suggestion must explain missing evidence or uncertainty",
      );
  }
  return scripts;
}

interface PreviewRow {
  binding: SuggestionBinding;
  evidence: EvidenceFile[];
  status: "ready" | "running" | "finished";
  result: SuggestionResult | null;
}
export async function suggestEffects(
  db: Database,
  config: ServiceConfig,
  deps: ServiceDependencies,
  personId: string,
  skillId: string,
  previewId: unknown,
  expectedHash: unknown,
  stillAuthorized: () => Promise<boolean>,
): Promise<SuggestionResult> {
  if (typeof previewId !== "string" || typeof expectedHash !== "string")
    throw new RequestError(
      400,
      "A suggestion request needs previewId and expectedHash",
    );
  const accepted = await readConfiguration(db);
  const preview = await db.transaction(async (tx) => {
    const { rows } = await tx.query<PreviewRow>(
      "select binding, evidence, status, result from skill_suggestion_previews where id = $1 and skill_id = $2 and person_id = $3 and expires_at > $4 for update",
      [previewId, skillId, personId, deps.clock.now()],
    );
    const row = rows[0];
    if (!row)
      throw new RequestError(
        404,
        "No such active suggestion preview; preview the upload again",
      );
    if (
      row.binding.sourceHash !== expectedHash ||
      row.binding.configurationRevision !== accepted.revision ||
      row.binding.configurationHash !== accepted.hash
    )
      throw new RequestError(
        409,
        "Upload, task prompt or model settings changed; preview again before requesting suggestions",
      );
    if (row.status === "running")
      throw new RequestError(
        409,
        "Suggestions are already running for this preview",
      );
    if (row.status !== "finished")
      await tx.query(
        "update skill_suggestion_previews set status = 'running', started_at = $2 where id = $1",
        [previewId, deps.clock.now()],
      );
    return row;
  });
  if (preview.result) return preview.result;
  const model = accepted.configuration.models.find(
    (m) => m.id === preview.binding.modelId,
  )!;
  const prompt = accepted.configuration.prompts[SCRIPT_EFFECT_FUNCTION];
  const userPrompt = prompt.text.replace(
    /\{\{(source|scripts)\}\}/gu,
    (_, key: string) =>
      JSON.stringify(
        key === "source" ? preview.evidence : preview.binding.scripts,
      ),
  );
  let result: SuggestionResult;
  try {
    const raw = await callModel(
      db,
      config,
      accepted.configuration,
      model,
      personId,
      [
        { role: "system", content: RESPONSE_RULES },
        { role: "user", content: userPrompt },
      ],
    );
    const scripts = validatedSuggestions(
      raw,
      preview.binding,
      preview.evidence,
    );
    const complete =
      scripts.length === preview.binding.scripts.length &&
      scripts.every((s) => s.complete);
    result = {
      binding: preview.binding,
      status: complete ? "complete" : "incomplete",
      message: complete
        ? null
        : "Coverage is incomplete; missing or uncertain scripts still need manual review.",
      scripts,
    };
  } catch (error) {
    if (error instanceof RequestError && error.status === 503) {
      await db.query(
        "update skill_suggestion_previews set status = 'ready' where id = $1",
        [previewId],
      );
      throw error;
    }
    result = {
      binding: preview.binding,
      status:
        error instanceof RequestError && error.status === 413
          ? "incomplete"
          : "failed",
      message:
        error instanceof RequestError
          ? error.status === 413
            ? `Incomplete coverage. ${error.message}`
            : error.message
          : "Suggestions failed; declare script effects manually.",
      scripts: [],
    };
  }
  if (!(await stillAuthorized()))
    throw new RequestError(
      403,
      "Upload permission changed while suggestions were running",
    );
  await db.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(8231130000000095)");
    if ((await readConfiguration(tx)).revision !== accepted.revision)
      throw new RequestError(
        409,
        "Task prompt or model configuration changed while suggestions were running; preview again",
      );
    const saved = await tx.query(
      "update skill_suggestion_previews set status = 'finished', evidence = '[]'::jsonb, result = $2 where id = $1 and expires_at > $3 returning id",
      [previewId, JSON.stringify(result), deps.clock.now()],
    );
    if (!saved.rowCount)
      throw new RequestError(
        409,
        "The upload changed or its preview expired while suggestions were running; preview again",
      );
  });
  return result;
}
