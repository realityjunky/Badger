import { createHash } from "node:crypto";
import { firstHeader, type IdentityRequest } from "./identity.js";

export function hashCredential(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Ambiguous cookies never select a credential. */
export function readCookie(
  headers: IdentityRequest["headers"],
  name: string,
): string | null {
  const matches = (firstHeader(headers, "cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  return matches.length === 1
    ? matches[0].slice(name.length + 1) || null
    : null;
}

export function strictCookie(
  name: string,
  value: string,
  path: string,
  seconds: number,
): string {
  return `${name}=${value}; Path=${path}; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Strict`;
}
