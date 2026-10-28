import { isLoopbackHostname } from "../network.js";
import type {
  IdentityAdapter,
  IdentityRequest,
  IdentityResult,
  Principal,
} from "./identity.js";

export const LOCAL_IDENTITY_ISSUER = "badger-local";

export interface LocalAdministrator {
  subject: string;
  email: string;
  displayName: string;
}

function localPrincipal(administrator: LocalAdministrator): Principal {
  return {
    issuer: LOCAL_IDENTITY_ISSUER,
    subject: administrator.subject,
    email: administrator.email,
    displayName: administrator.displayName,
    status: "active",
    credential: { kind: "local-implicit", id: null },
  };
}

/**
 * Local single-user mode signs in its one configured person, and only when
 * the request arrived on a loopback hostname. It never looks at a password or
 * a token, because the deployment binds to the loopback interface. Badger,
 * not this adapter, makes that person the implicit Administrator.
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
        principal: localPrincipal(administrator),
      };
    },
  };
}
