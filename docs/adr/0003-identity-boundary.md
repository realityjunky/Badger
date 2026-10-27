# Prove Identity Outside Badger and Authorize Inside It

Status: accepted. An identity provider only proves who a person is; Badger decides what they may do. An identity port turns each request into a principal (issuer, subject, email, display name, and status), and a principal alone grants no permission. Badger owns the Groups, workflow roles, bindings, separation of duties, and audit log, and each deployment serves one Organization. The first deployment must sign people in through the organization's AI platform, so nobody manages another password, while other companies bring their own identity systems; the workflow roles and their separation of duties exist only in Badger.

Adapters prove identity through the platform's session, checked against its current-user endpoint; through OpenID Connect, after which Badger issues its own session; through headers accepted only from configured proxy addresses; or through loopback in local single-user mode. Personal access tokens, used by Agents and the CLI, work beside the one adapter that serves people.

## Consequences

- A signed-in person can do nothing until someone binds them to a role. Invitations and bindings made by email apply at a person's first sign-in, matched only on an email the provider has verified, and that sign-in links the provider's issuer and subject. Later sign-ins match on those, so an email change at the provider moves no binding.
- An unreachable identity provider yields "unavailable", never "allowed" or "denied". Non-active platform users are refused.
- Platform administrators become Badger Administrators only when a deployment switches that mapping on.

## Considered Options

- Let the platform make authorization decisions, or project Badger's resources into its permission system. Rejected for now: it would tie Badger to one platform, and the platform would first have to accept ServiceAccount credentials.
- Give Badger its own accounts and passwords. Rejected because people would manage yet another password.
