import { readsEverything } from "../authorization.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { RequestError } from "./errors.js";

export function handleIntegrations({
  access,
  config,
  reply,
}: AuthorizedRequest): void {
  if (!readsEverything(access))
    throw new RequestError(
      403,
      "Only Administrators and Auditors read deployment integration status",
    );
  reply.json(200, {
    identity: {
      kind: config.identity.kind,
      configured: config.identity.kind !== "none",
    },
    invitationEmail: { configured: config.invitationDelivery !== null },
    notifications: {
      configured:
        config.notifications.encryptionKey !== null &&
        config.notifications.publicUrl !== null,
    },
  });
}
