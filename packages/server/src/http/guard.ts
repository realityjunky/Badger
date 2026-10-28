import { parseHostHeader } from "../network.js";

export interface GuardInput {
  method: string;
  hostHeader: string | undefined;
  originHeader: string | undefined;
  allowedHostnames: readonly string[];
  allowedOrigins: readonly string[];
}

export type GuardDecision =
  { ok: true; hostname: string } | { ok: false; message: string };

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function refusal(message: string): GuardDecision {
  return { ok: false, message };
}

function isAllowedOrigin(
  origin: string,
  allowedOrigins: readonly string[],
): boolean {
  try {
    return allowedOrigins.includes(new URL(origin).origin);
  } catch {
    return false;
  }
}

/**
 * Every request passes this before anyone is identified. A foreign Host is
 * refused, and a write must carry an Origin this deployment allows.
 */
export function guardRequest(input: GuardInput): GuardDecision {
  if (input.hostHeader === undefined) {
    return refusal("A Host header is required");
  }
  const host = parseHostHeader(input.hostHeader);
  if (host === null) {
    return refusal("The Host header is not valid");
  }
  if (!input.allowedHostnames.includes(host.hostname)) {
    return refusal("The Host header is not allowed");
  }

  if (input.originHeader !== undefined) {
    if (!isAllowedOrigin(input.originHeader, input.allowedOrigins)) {
      return refusal("The Origin header is not allowed");
    }
  } else if (UNSAFE_METHODS.has(input.method.toUpperCase())) {
    return refusal("An Origin header is required for this request");
  }

  return { ok: true, hostname: host.hostname };
}
