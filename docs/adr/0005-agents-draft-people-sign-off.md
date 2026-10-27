# Let Agents Draft and People Sign Off

Status: accepted. In the service, Agents connected through the Badger MCP draft the semantic work, and signed-in people sign it off. An Engineer's Agent claims a drafting job, such as a source study, questions and follow-ups, a restatement or translation, a dossier or plan draft, an Authoring lane, or a review vote. Each job is bound to the hashes of its inputs and carries an output schema and a lease; an expired lease returns it to the queue, and changed inputs cancel it. A result stays a draft until a person accepts it, and acceptance is the only way it enters the records, the dossier, the plan, or the package. Agents may also act for their person within that person's MCP profile, for example by submitting the answers an expert gives in chat, marked as sent through an Agent, or by driving a Run, but they never sign off.

The actions reserved for people are confirming a fact, acknowledging or disputing a restatement, approving a dossier, plan, proposal, or package, publishing, and answering a Run gate. They are not MCP tools, and personal access tokens never perform them; the tool returns a dashboard link instead. Each gate is previewed with the hashes it binds, then committed by a signed-in person quoting the preview's confirmation hash. The Engineer confirms a fact, and the Field expert who answered acknowledges its restatement. In a Run, the service attaches the signed-in person's attestation to a gate answer and the MCP delivers it; the Agent never names a reviewer. The local CLI keeps its `--confirm` gates, which an Agent runs only after the person confirms in the conversation.

Today confirmations are typed commands that record no actor, the reviewer is a free-text name, and decision gates accept whatever reviewer the caller claims to be. An approval means something only when a named person reviewed exactly what it binds, and an Agent holding that person's token must not be able to sign off for them.

## Considered Options

- A server-side drafting runner. Deferred: it needs a credential for model access that the first version does without, and Engineers' own Agents already read large script sets with their own file tools.
- Token scopes that allow approvals. Rejected because the Agent holding the token could then sign off for its owner.
