import type { ServiceConfig } from "../config.js";
import { anonymousIdentityAdapter } from "./anonymous.js";
import type { IdentityAdapter } from "./identity.js";
import { createLocalIdentityAdapter } from "./local.js";

/** The identity adapter a deployment's settings select. */
export function configuredIdentityAdapter(
  config: ServiceConfig,
): IdentityAdapter {
  return config.identity.kind === "local"
    ? createLocalIdentityAdapter(config.identity.administrator)
    : anonymousIdentityAdapter;
}
