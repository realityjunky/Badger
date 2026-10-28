import type { IdentityAdapter, Principal } from "../identity/identity.js";
import { firstHeader } from "../identity/identity.js";

export const TEST_PERSON_HEADER = "x-badger-test-person";

/** Who a test request acts as. It carries no role: Badger decides those. */
export interface TestPerson {
  issuer?: string;
  subject: string;
  email?: string;
  displayName?: string;
  /** Whether the test provider has verified this address; true by default. */
  emailVerified?: boolean;
}

function principalFor(person: TestPerson): Principal {
  return {
    issuer: person.issuer ?? "test-issuer",
    subject: person.subject,
    email: person.email ?? `${person.subject}@test.invalid`,
    displayName: person.displayName ?? person.subject,
    status: "active",
    credential: { kind: "session", id: "test-session" },
    emailVerified: person.emailVerified ?? true,
    platformAdministrator: false,
  };
}

/**
 * Selects the person per request from a test-only header. The harness adds
 * the header; no production entry point wires this adapter.
 */
export function createTestIdentityAdapter(): IdentityAdapter {
  return {
    resolve: async (request) => {
      const raw = firstHeader(request.headers, TEST_PERSON_HEADER);
      if (raw === null) {
        return { kind: "anonymous" };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { kind: "denied", reason: "Invalid test identity" };
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as { subject?: unknown }).subject !== "string"
      ) {
        return { kind: "denied", reason: "Invalid test identity" };
      }
      return {
        kind: "authenticated",
        principal: principalFor(parsed as TestPerson),
      };
    },
  };
}
