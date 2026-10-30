import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { RequestError } from "../http/errors.js";

export function validateWebhook(value: unknown): string {
  if (typeof value !== "string" || value.length > 512)
    throw new RequestError(400, "Enter a WeCom group robot webhook URL");
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "qyapi.weixin.qq.com" ||
      url.port !== "" ||
      url.pathname !== "/cgi-bin/webhook/send" ||
      url.username ||
      url.password ||
      url.hash ||
      [...url.searchParams.keys()].join(",") !== "key" ||
      !/^[a-zA-Z0-9_-]{1,128}$/u.test(url.searchParams.get("key") ?? "")
    )
      throw new Error("Invalid robot URL");
    url.search = new URLSearchParams({
      key: url.searchParams.get("key")!,
    }).toString();
    return url.href;
  } catch {
    throw new RequestError(400, "Enter a WeCom group robot webhook URL");
  }
}

export function encryptWebhook(url: string, key: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), nonce);
  const ciphertext = Buffer.concat([
    cipher.update(url, "utf8"),
    cipher.final(),
  ]);
  return [nonce, cipher.getAuthTag(), ciphertext]
    .map((part) => part.toString("base64url"))
    .join(".");
}

export function decryptWebhook(value: string, key: string): string {
  const [nonce, tag, ciphertext] = value
    .split(".")
    .map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key, "hex"),
    nonce,
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

export function robotKey(url: string, key: string): string {
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update(url)
    .digest("hex");
}
