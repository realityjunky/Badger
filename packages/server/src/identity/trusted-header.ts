import { createHash } from "node:crypto";
import { BlockList, isIP } from "node:net";
import type { TrustedHeaderSettings } from "../config.js";
import type { IdentityAdapter, IdentityRequest } from "./identity.js";

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Node reads header bytes as Latin-1. Proxies send UTF-8, so a value whose
 * bytes are valid UTF-8 is read as UTF-8, and any other keeps its Latin-1
 * reading.
 */
function headerText(value: string): string {
  if (!/[\x80-\xff]/u.test(value)) return value;
  try {
    return utf8.decode(Buffer.from(value, "latin1"));
  } catch {
    return value;
  }
}

/** The proxy must replace client identity headers and verify the account. */
export function createTrustedHeaderIdentityAdapter(
  settings: TrustedHeaderSettings,
): IdentityAdapter {
  const proxies = new BlockList();
  for (const address of settings.proxyAddresses) {
    proxies.addAddress(address, isIP(address) === 4 ? "ipv4" : "ipv6");
  }
  return {
    resolve: async (request: IdentityRequest) => {
      const peer = request.remoteAddress;
      if (
        peer === null ||
        isIP(peer) === 0 ||
        !proxies.check(peer, isIP(peer) === 4 ? "ipv4" : "ipv6")
      ) {
        return { kind: "anonymous" };
      }
      const read = (name: string, allowComma = false): string | null => {
        if (request.headersDistinct[name]?.length !== 1) return null;
        const raw = request.headers[name];
        if (typeof raw !== "string") return null;
        const value = headerText(raw);
        return value.trim() !== "" &&
          value.length <= 1024 &&
          !/[\x00-\x1f\x7f-\x9f]/u.test(value) &&
          (allowComma || !value.includes(","))
          ? value.trim()
          : null;
      };
      const subject = read(settings.subjectHeader);
      const email = read(settings.emailHeader);
      if (
        subject === null ||
        email === null ||
        !/^[^@\s]+@[^@\s]+$/u.test(email)
      )
        return { kind: "anonymous" };
      return {
        kind: "authenticated",
        principal: {
          issuer: settings.issuer,
          subject,
          email,
          displayName: read(settings.nameHeader, true) ?? email,
          status: "active",
          credential: {
            kind: "session",
            id: createHash("sha256")
              .update(JSON.stringify([settings.issuer, subject]))
              .digest("hex"),
          },
          emailVerified: settings.emailsVerified,
          platformAdministrator: false,
        },
      };
    },
  };
}
