import type { Clock } from "../clock.js";
import type { ServiceConfig } from "../config.js";
import { anonymousIdentityAdapter } from "./anonymous.js";
import type { IdentityAdapter } from "./identity.js";
import { createLocalIdentityAdapter } from "./local.js";
import { createPlatformSessionIdentityAdapter } from "./platform-session.js";

/** The identity adapter a deployment's settings select. */
export function configuredIdentityAdapter(
  config: ServiceConfig,
  clock: Clock,
): IdentityAdapter {
  switch (config.identity.kind) {
    case "local":
      return createLocalIdentityAdapter(config.identity.administrator);
    case "platform-session":
      return createPlatformSessionIdentityAdapter(
        config.identity.platform,
        clock,
      );
    case "none":
      return anonymousIdentityAdapter;
  }
}
