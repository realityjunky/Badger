import { createHash } from "node:crypto";
import { BlockList, isIP } from "node:net";
import type { TrustedHeaderSettings } from "../config.js";
import type { IdentityAdapter, IdentityRequest } from "./identity.js";

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
      const read = (name: string): string | null => {
        const value = request.headers[name];
        // Node joins repeated headers with commas. Identity must be singular.
        return typeof value === "string" &&
          value.trim() !== "" &&
          value.length <= 1024 &&
          !/[,\x00-\x1f\x7f]/u.test(value)
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
          displayName: read(settings.nameHeader) ?? email,
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
