# Organize People with Nested Groups and Email Bindings

Status: accepted. Badger records who may act as role bindings on a scope: the Organization, or a Group. A Group nests inside another, and a binding on a Group applies to every Group inside it, so a department's Group lead manages its teams without a second binding. Organization roles are Administrator and Auditor; Group roles are Group lead and Member. Bindings are additive, and every request is checked on the server against the capability its scope implies (ADR 0003).

A binding may be recorded for an email before that person has ever signed in. It waits as an invitation. At the first sign-in with an address the identity provider has verified, Badger records the person and applies the waiting bindings; from then on the binding follows the person's issuer and subject, so an address change at the provider moves no binding. An address the provider has not verified applies nothing.

Badger refuses a person granting themselves an organization role. An Administrator may override that block only by recording a reason; the write then proceeds and the reason appears in the Activity log, where the actor, time, target, and channel are recorded too. Configuration supplies bootstrap Administrator addresses. Platform administrators become Badger Administrators only when a deployment switches `BADGER_PLATFORM_ADMIN_MAPPING` on.

## Consequences

- Groups form a tree; a cycle is refused, and two groups under one parent cannot share a name.
- Every person's effective roles are derived at request time from configuration and bindings, so revoking a binding takes effect at the next request.
- An Auditor reads the whole Activity log and changes nothing.
- The dashboard hides controls a person may not use, but the server's capability check is the enforcement.

## Considered Options

- One flat group list with explicit per-group members. Rejected because nested departments would need every member bound to every team.
- Let an Administrator grant themselves privileges silently. Rejected because self-escalation would leave no record of the exception.
