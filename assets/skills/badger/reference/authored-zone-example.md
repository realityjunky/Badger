# Authored-Zone Quality Example

This is an illustrative quality bar for authored content. It is not a
generated workflow and does not add routes, commands, or runtime policy. The
assembler keeps the surrounding Auto zone deterministic and inserts only
declared authored sections.

## Entry Decision Core

### Determine the current Node

1. Read the persisted WorkflowRuntime continuation and identify its current
   Node, pending action, revision, and package identity.
2. Compare the user's request with the declared Node responsibility. If the
   request belongs to a later Node, explain the dependency and keep the current
   Node active. If it corrects an earlier result, record the correction through
   the runtime contract rather than skipping to a later Node.
3. If the continuation and the user's context disagree, trust the persisted
   package and Run evidence first. Ask a question only when two declared
   choices change scope, behavior, accepted risk, or an irreversible outcome.

### Resume rules

On every fresh process, read state again. Do not infer the current Node from
conversation history, a stale generated projection, or the presence of a file.
When a required artifact or evidence record is missing, keep the Node
incomplete and report the declared recovery path. A topic change during an
active Node is a decision point only if more than one declared continuation is
valid.

### Red flags

- Treating a `DONE` projection as completion when required evidence is absent.
- Loading a later Node because the user's wording sounds advanced.
- Treating a generated file or preview as proof that work was accepted.
- Inventing a route, choice, artifact version, or recovery owner in prose.

## Node Guidance: evidence review

### Prerequisites

- The current Node and its required Skill Calls are identified by the
  `WorkflowProtocol`.
- The source evidence and the requested review scope are available.
- Any required prior artifacts are selected by explicit accepted version, not
  by an implicit latest-file rule.

### Steps

1. Load the declared review Skill when its Required Skill Call is present.
2. Inspect each declared input and record its origin, scope, and acceptance
   reason. Do not replace a required source with a generic alternative.
3. Compare the result with the Node's Output Schemas and guardrails. Record
   evidence for every required check and identify unresolved concerns.
4. Explain the completion judgment in domain terms in addition to the
   mechanical exit checks. If evidence is sparse, contradictory, or stale,
   remain in the current Node and use the declared recovery guidance.

### Completion reasoning

The Node is complete only when the required evidence is present, current, and
consistent with the declared Output Schemas. A successful command or a
non-empty file is not sufficient by itself. The authored guidance may explain
the judgment, but only WorkflowRuntime can accept the outcome and select the
next declared transition.

### Recovery

After interruption, call the runtime recovery operation and inspect its
continuation. Do not repeat external work automatically. If the runtime
returns `await-user`, present the persisted declared choices. If it returns
`blocked`, report the finding and required action without inventing a bypass.
