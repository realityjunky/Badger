import { promises as fs } from "node:fs";
import type { ServiceConfig } from "../config.js";
import type { Database, Queryable } from "../database/database.js";
import type { ServiceDependencies } from "../dependencies.js";
import { recordAudit, type WriteContext } from "../audit.js";
import { objectInput, RequestError } from "../http/errors.js";
import {
  contentHash,
  defaultConfiguration,
  validateConfiguration,
  type LlmConfiguration,
} from "./configuration.js";
import { encryptSecret, resolveSecret } from "./secrets.js";

export interface AcceptedConfiguration {
  revision: number;
  configuration: LlmConfiguration;
  hash: string;
}
interface Row {
  revision: number;
  configuration: LlmConfiguration;
  content_hash: string;
}

export async function readConfiguration(
  db: Queryable,
): Promise<AcceptedConfiguration> {
  const { rows } = await db.query<Row>(
    "select revision, configuration, content_hash from llm_configuration where singleton = true",
  );
  if (!rows[0]) throw new RequestError(503, "LLM configuration is unavailable");
  return {
    revision: rows[0].revision,
    configuration: rows[0].configuration,
    hash: rows[0].content_hash,
  };
}

export async function readConfigurationFile(config: ServiceConfig) {
  if (!config.llm.configurationFile)
    throw new RequestError(
      400,
      "Set BADGER_LLM_CONFIG_FILE before reloading a file",
    );
  try {
    const file = await fs.open(config.llm.configurationFile, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 262144) throw new Error();
      const bytes = Buffer.alloc(262145);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 262144) throw new Error();
      const input = objectInput(
        JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")),
      );
      if (
        !Number.isInteger(input.revision) ||
        (input.revision as number) < 0 ||
        Object.keys(input).some(
          (key) => !["revision", "configuration"].includes(key),
        )
      )
        throw new Error();
      return {
        revision: input.revision as number,
        configuration: validateConfiguration(input.configuration),
      };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(
      400,
      "Could not load LLM configuration file; use a readable JSON {revision, configuration} file within 256 KiB",
    );
  }
}

export async function initializeLlmConfiguration(
  db: Database,
  config: ServiceConfig,
  dependencies: ServiceDependencies,
) {
  await db.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(8231130000000095)");
    const existing = await tx.query(
      "select 1 from llm_configuration where singleton = true",
    );
    if (existing.rows.length) return;
    const loaded = config.llm.configurationFile
      ? await readConfigurationFile(config)
      : { revision: 0, configuration: defaultConfiguration() };
    assertSecretFree(
      loaded.configuration,
      Object.values(config.llm.externalSecrets),
    );
    if (loaded.revision !== 0)
      throw new RequestError(
        409,
        "First configuration import must have revision 0",
      );
    const hash = contentHash(loaded.configuration);
    await tx.query(
      "insert into llm_configuration (revision, configuration, content_hash, updated_at) values (1, $1, $2, $3)",
      [JSON.stringify(loaded.configuration), hash, dependencies.clock.now()],
    );
    if (config.llm.configurationFile)
      await recordAudit(tx, dependencies, {
        actor: {
          personId: null,
          credential: { kind: "worker", id: "llm-configuration" },
        },
        channel: "worker",
        action: "llm_configuration.initialized",
        target: { type: "llm_configuration", id: "organization" },
        before: null,
        after: { revision: 1, hash },
        reason: "Initial LLM configuration accepted",
        requestId: dependencies.ids.next(),
      });
  });
}

export async function configurationView(db: Queryable, config: ServiceConfig) {
  const accepted = await readConfiguration(db);
  const stored = await db.query<{ reference: string }>(
    "select reference from llm_secrets",
  );
  const refs = new Set(stored.rows.map((r) => r.reference));
  return {
    ...accepted,
    fileConfigured: config.llm.configurationFile !== null,
    secretStorageConfigured: config.llm.encryptionKey !== null,
    credentials: Object.fromEntries(
      accepted.configuration.models.map((model) => [
        model.id,
        {
          configured: model.secretRef?.startsWith("env:")
            ? Boolean(config.llm.externalSecrets[model.secretRef.slice(4)])
            : Boolean(
                model.secretRef &&
                refs.has(model.secretRef) &&
                config.llm.encryptionKey,
              ),
        },
      ]),
    ),
  };
}

export async function saveConfiguration(
  db: Database,
  config: ServiceConfig,
  deps: ServiceDependencies,
  actor: WriteContext,
  value: unknown,
) {
  const body = objectInput(value);
  if (
    Object.keys(body).some(
      (key) => !["revision", "configuration", "secrets"].includes(key),
    ) ||
    !Number.isInteger(body.revision)
  )
    throw new RequestError(
      400,
      "Save the configuration with its current revision",
    );
  const configuration = validateConfiguration(body.configuration);
  const secrets = body.secrets === undefined ? {} : objectInput(body.secrets);
  await db.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(8231130000000095)");
    const current = await readConfiguration(tx);
    if (current.revision !== body.revision)
      throw new RequestError(
        409,
        "LLM configuration changed; reload it and apply your edits to the current revision",
      );
    const protectedValues = Object.values(config.llm.externalSecrets);
    for (const model of current.configuration.models) {
      try {
        protectedValues.push(await resolveSecret(tx, config, model));
      } catch (error) {
        if (!(error instanceof RequestError)) throw error;
      }
      const next = configuration.models.find((entry) => entry.id === model.id);
      if (
        next &&
        next.secretRef === null &&
        model.secretRef?.startsWith("stored:") &&
        secrets[model.id] === undefined
      )
        next.secretRef = model.secretRef;
    }
    assertSecretFree(configuration, protectedValues);
    for (const [id, raw] of Object.entries(secrets)) {
      const model = configuration.models.find((m) => m.id === id);
      const change = objectInput(raw);
      if (
        !model ||
        Object.keys(change).some((key) => !["action", "value"].includes(key))
      )
        throw new RequestError(
          400,
          "Secret changes must name an existing model",
        );
      const ref = `stored:${id}`;
      if (change.action === "clear" && change.value === undefined) {
        await tx.query("delete from llm_secrets where reference = $1", [ref]);
        model.secretRef = null;
      } else if (
        change.action === "replace" &&
        typeof change.value === "string" &&
        change.value.length > 0 &&
        change.value.length <= 8192 &&
        !/[\r\n]/u.test(change.value)
      ) {
        if (!config.llm.encryptionKey)
          throw new RequestError(
            400,
            "Configure BADGER_LLM_KEY or use a protected external secret reference before storing API keys",
          );
        // A submitted key must never be smuggled into settings or task prompts.
        if (JSON.stringify(configuration).includes(change.value))
          throw new RequestError(
            400,
            "Keep API keys only in the write-only secret field",
          );
        await tx.query(
          "insert into llm_secrets (reference, ciphertext) values ($1, $2) on conflict (reference) do update set ciphertext = excluded.ciphertext",
          [ref, encryptSecret(change.value, ref, config.llm.encryptionKey)],
        );
        model.secretRef = ref;
      } else
        throw new RequestError(
          400,
          "Explicitly replace a nonempty API key or clear it",
        );
    }
    const effectiveHash = contentHash(configuration);
    await tx.query(
      "update llm_configuration set revision = revision + 1, configuration = $1, content_hash = $2, updated_at = $3 where singleton = true",
      [JSON.stringify(configuration), effectiveHash, deps.clock.now()],
    );
    await recordAudit(tx, deps, {
      actor: { personId: actor.personId, credential: actor.credential },
      channel: actor.channel,
      action: "llm_configuration.updated",
      target: { type: "llm_configuration", id: "organization" },
      before: { revision: current.revision, hash: current.hash },
      after: { revision: current.revision + 1, hash: effectiveHash },
      reason: "LLM connections, assignments or secrets updated",
      requestId: actor.requestId,
    });
    if (
      contentHash(current.configuration.prompts) !==
      contentHash(configuration.prompts)
    )
      await recordAudit(tx, deps, {
        actor: { personId: actor.personId, credential: actor.credential },
        channel: actor.channel,
        action: "llm_prompts.updated",
        target: { type: "llm_prompts", id: "organization" },
        before: {
          revision: current.revision,
          hash: contentHash(current.configuration.prompts),
        },
        after: {
          revision: current.revision + 1,
          hash: contentHash(configuration.prompts),
        },
        reason: "Task prompts updated",
        requestId: actor.requestId,
      });
  });
  return configurationView(db, config);
}

function assertSecretFree(configuration: LlmConfiguration, values: string[]) {
  const json = JSON.stringify(configuration);
  if (
    values.some(
      (value) => value && json.includes(JSON.stringify(value).slice(1, -1)),
    )
  )
    throw new RequestError(
      400,
      "Keep API keys only in write-only secret fields or protected external references",
    );
}
