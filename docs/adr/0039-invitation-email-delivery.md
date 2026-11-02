# Deliver Invitation Emails Through a Configured Service

Status: accepted. Badger records and authorizes role bindings; a deployment's
identity platform owns account activation and email delivery. A configured HTTP
endpoint receives an invitation only after the authorized person's binding has
committed. It receives the recipient, binding and scope, Badger role, dashboard
URL, and inviter's issuer and subject, using a dedicated bearer credential.
SMTP settings and platform account or entry-role provisioning stay outside Badger.

An invitation's pending state continues to mean that no verified sign-in has
resolved its binding (ADRs 0003 and 0010). Email delivery is a separate result:
sent, failed, or not configured. A delivery failure preserves the binding and is
shown to the person, who can explicitly resend against its current revision.
Resending requires permission to manage the binding's scope and a signed-in
person. Delivery attempts are audited without remote error text or credentials.

Delivery runs after commit rather than inside the binding transaction so a
transaction rollback cannot send an invitation. There is no automatic retry:
an ambiguous network timeout can mean the email was accepted, and another send
is the person's choice. A platform that also controls application entry may
provision that entry through its own restricted integration; it never decides
Badger's Organization, Group, or workflow roles.
