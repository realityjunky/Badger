import type { RoleBinding } from "./bindings.js";
import type { ServiceConfig } from "./config.js";
import type { Principal } from "./identity/identity.js";

export interface InvitationDelivery {
  status: "sent" | "failed" | "not-configured";
}

export async function deliverInvitation(
  config: ServiceConfig,
  binding: RoleBinding,
  principal: Principal,
): Promise<InvitationDelivery> {
  const settings = config.invitationDelivery;
  if (settings === null) return { status: "not-configured" };
  try {
    const response = await fetch(settings.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(settings.timeoutMs),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${settings.token}`,
      },
      body: JSON.stringify({
        bindingId: binding.id,
        email: binding.email,
        role: binding.role,
        scopeType: binding.scopeType,
        scopeId: binding.scopeId,
        url: `${config.notifications.publicUrl!.replace(/\/+$/u, "")}/`,
        inviter: { subject: principal.subject, issuer: principal.issuer },
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: "failed" };
    }
    const answer: unknown = await response.json();
    return {
      status:
        typeof answer === "object" &&
        answer !== null &&
        "emailSent" in answer &&
        answer.emailSent === true
          ? "sent"
          : "failed",
    };
  } catch {
    return { status: "failed" };
  }
}
