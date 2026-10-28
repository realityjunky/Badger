import { isLoopbackHostname } from "../network.js";
import type {
  IdentityAdapter,
  IdentityRequest,
  IdentityResult,
  Principal,
} from "./identity.js";

export interface LocalAdministrator {
  subject: string;
  email: string;
  displayName: string;
}

export function localAdministratorPrincipal(
  administrator: LocalAdministrator,
): Principal {
  return {
    issuer: "badger-local",
    subject: administrator.subject,
    email: administrator.email,
    displayName: administrator.displayName,
    status: "active",
    isAdministrator: true,
    credential: { kind: "local-implicit", id: null },
  };
}

/**
 * Local single-user mode trusts one implicit Administrator, and only when the
 * request arrived on a loopback hostname. It never looks at a password or a
 * token, because the deployment binds to the loopback interface.
 */
export function createLocalIdentityAdapter(
  administrator: LocalAdministrator,
): IdentityAdapter {
  return {
    resolve: async (request: IdentityRequest): Promise<IdentityResult> => {
      if (request.hostname === null || !isLoopbackHostname(request.hostname)) {
        return { kind: "anonymous" };
      }
      return {
        kind: "authenticated",
        principal: localAdministratorPrincipal(administrator),
      };
    },
  };
}
