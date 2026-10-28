import type { ServiceConfig } from "./config.js";
import { LOCAL_IDENTITY_ISSUER } from "./identity/local.js";
import type { Person } from "./people.js";

export type OrganizationRole = "Administrator";

/**
 * Badger's own decision about a signed-in person's Organization roles; an
 * identity adapter's principal grants nothing (ADR 0003). Until role bindings
 * exist, the Administrators are local mode's implicit one and the people whose
 * email the deployment lists in BADGER_BOOTSTRAP_ADMINISTRATORS.
 */
export function organizationRoles(
  person: Person,
  config: ServiceConfig,
): OrganizationRole[] {
  const implicitAdministrator =
    config.identity.kind === "local" &&
    person.issuer === LOCAL_IDENTITY_ISSUER &&
    person.subject === config.identity.administrator.subject;
  const bootstrapAdministrator = config.bootstrapAdministrators.includes(
    person.email.toLowerCase(),
  );
  return implicitAdministrator || bootstrapAdministrator
    ? ["Administrator"]
    : [];
}
