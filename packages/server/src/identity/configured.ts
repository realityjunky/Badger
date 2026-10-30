import type { Clock } from "../clock.js";
import type { ServiceConfig } from "../config.js";
import { anonymousIdentityAdapter } from "./anonymous.js";
import type { IdentityAdapter } from "./identity.js";
import { createLocalIdentityAdapter } from "./local.js";
import { createPlatformSessionIdentityAdapter } from "./platform-session.js";
import { createTrustedHeaderIdentityAdapter } from "./trusted-header.js";
import { createOidcIdentityAdapter } from "./oidc.js";
import type { Database } from "../database/database.js";
import { silentLogger, type Logger } from "../log.js";

/** The identity adapter a deployment's settings select. */
export function configuredIdentityAdapter(
  config: ServiceConfig,
  clock: Clock,
  database: Database,
  logger: Logger = silentLogger,
): IdentityAdapter {
  switch (config.identity.kind) {
    case "oidc":
      return createOidcIdentityAdapter(
        config.identity.oidc,
        clock,
        database,
        logger,
      );
    case "trusted-header":
      return createTrustedHeaderIdentityAdapter(config.identity.headers);
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
