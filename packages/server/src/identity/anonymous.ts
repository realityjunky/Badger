import type { IdentityAdapter, IdentityResult } from "./identity.js";

/**
 * Refuses everyone. Service deployments use it until a people-facing adapter
 * ships; the health endpoint stays reachable.
 */
export const anonymousIdentityAdapter: IdentityAdapter = {
  resolve: async (): Promise<IdentityResult> => ({ kind: "anonymous" }),
};
