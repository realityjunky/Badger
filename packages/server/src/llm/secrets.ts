import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { ServiceConfig } from "../config.js";
import type { Queryable } from "../database/database.js";
import { RequestError } from "../http/errors.js";
import type { ModelConnection } from "./configuration.js";

export function encryptSecret(
  value: string,
  reference: string,
  key: string,
): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), nonce);
  cipher.setAAD(Buffer.from(reference));
  const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [nonce, cipher.getAuthTag(), bytes]
    .map((b) => b.toString("base64url"))
    .join(".");
}

export async function resolveSecret(
  db: Queryable,
  config: ServiceConfig,
  model: ModelConnection,
): Promise<string> {
  const ref = model.secretRef;
  let secret: string | undefined;
  if (ref?.startsWith("env:"))
    secret = config.llm.externalSecrets[ref.slice(4)];
  if (ref?.startsWith("stored:")) {
    const { rows } = await db.query<{ ciphertext: string }>(
      "select ciphertext from llm_secrets where reference = $1",
      [ref],
    );
    if (rows[0] && config.llm.encryptionKey) {
      try {
        const [nonce, tag, bytes] = rows[0].ciphertext
          .split(".")
          .map((s) => Buffer.from(s, "base64url"));
        const cipher = createDecipheriv(
          "aes-256-gcm",
          Buffer.from(config.llm.encryptionKey, "hex"),
          nonce,
        );
        cipher.setAuthTag(tag);
        cipher.setAAD(Buffer.from(ref));
        secret = Buffer.concat([cipher.update(bytes), cipher.final()]).toString(
          "utf8",
        );
      } catch {
        throw new RequestError(
          400,
          "The stored API key cannot be decrypted; restore BADGER_LLM_KEY or replace the key",
        );
      }
    }
  }
  if (!secret || /[\r\n]/u.test(secret) || secret.length > 8192)
    throw new RequestError(
      400,
      "API key is missing or unavailable; configure a protected secret reference or replace the key",
    );
  return secret;
}
