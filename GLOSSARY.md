# Badger

This context defines the language for turning a user's workflow idea and supplied Skills into a confirmed workflow package, for running that package, and for the collaborative service in which an organization's people do both together. Some terms name parts of that service, or kernel changes it needs, ahead of the code; the delivery status in `packages/kernel/README.md` says what is built.

## The service and its people

**Collaborative service**:
Badger's multi-user service around the workflow kernel, made up of the server with its web dashboard, the Badger MCP, and the host installer, in which an Organization's people build and run workflows together.

**Organization**:
The company or institution that one Badger deployment serves, together with its people, Groups, Skills, and workflows. Each deployment serves exactly one.

**Group**:
A department or team within the Organization that owns workflows and Skills. Groups nest, and a role held on a Group applies to the Groups inside it.

**Role binding**:
A role attached to a scope, the Organization, a Group, or a workflow, for a person. Bindings are additive, and a binding on a Group applies to the Groups inside it. A workflow binding applies only to that workflow and its versions. A binding made by email for an address no signed-in person has verified is an invitation.

**Invitation**:
A role binding recorded by email for an address no signed-in person has verified. It applies at the first sign-in that presents that address as verified, usually the person's first; from then on it follows the person's issuer and subject, so an address change at the provider moves no binding.

**Administrator**:
The Organization role that may do everything. An Administrator may override a blocked action only by recording a reason, and the override appears in the Activity log.

**Auditor**:
The Organization role that reads everything, including the Activity log, and changes nothing.

**Group lead**:
The Group role that manages the Group's members, bindings, workflows, and Skill entries. It applies to the Groups nested inside that Group.

**Member**:
The Group role that reads the Group's Skills and workflows.

**Activity log**:
The append-only record of every action with its actor, time, target, channel, and reason. Auditors and Administrators read all of it, and they can filter it.

**Workflow owner**:
The person who confirms the desired workflow, its acceptable behavior, and its unresolved choices. They also assign the workflow's other roles and decide its publication.

**Engineer**:
The person who builds a workflow's package: they study its sources, ask and resolve its questions, confirm facts, and drive drafting, authoring, and evaluation.

**Field expert**:
A person who holds the domain knowledge a workflow encodes, usually the author of its source Skills. They answer its questions and acknowledge or dispute the facts restated from their answers.

**Reviewer**:
The person who approves a workflow's package for publication. They must not have accepted any of its authoring-lane results, so approval stays independent of authorship.

**Operator**:
A person who runs a workflow's published versions, answers the Run gates its Nodes leave to Operators, and recovers interrupted Runs.

**Observer**:
A person who reads a workflow and its versions without changing them.

**Principal**:
The identity a request acts as: issuer, subject, email, display name, and status. A principal alone grants no Badger permission; Badger decides what the person may do.

**Session introspection**:
The identity adapter that proves a person by presenting the platform's own session token to the platform's current-user endpoint over the internal network. Badger maps the platform user ID to the person's external subject.

## Sources and versions

**Project**:
The directory in which a workflow is built and run locally. Badger's records of building its package, and its standalone Runs, live under it.

**Skill version**:
An immutable snapshot of one Skill's files, identified by a hash of their content; changed content makes a new version.

**Skill pin**:
A revisioned reference from a Workflow version to one immutable Skill version. Pin changes invalidate the Sources stage and queue a source check.

**Source check**:
The read-only inspection of a workflow's declared Skill sources that reports each source's identity, inventory, script side effects, ignored files, and blockers before any question is asked.
_Avoid_: candidates

**Registered source root**:
A directory outside the Project that the host lets source locations point into, registered with `--source-root`, `BADGER_SOURCE_ROOTS`, or the kernel's `sourceRoots` option; a source manifest or FactoryPlan cannot register one. A source location outside the Project and every registered source root is refused, including an upgrade plan's `sourceRoot`.
_Avoid_: allowed directory

**Source study**:
The Engineer's recorded reading of one pinned Skill version before the questionnaire. It yields source-derived facts with their evidence, the interfaces between Skills, and the Skill's own open questions.

**Workflow version**:
One iteration of a workflow: the Skill versions it pins, its questionnaire, and the dossier, plan, and package built from them. A new workflow version inherits the previous one's facts and resolutions.

**Workflow frame**:
The workflow's name, goal, intent (a new Skill or an upgrade of an existing one), and language. Each workflow version keeps the frame it began with.

**Stage track**:
The states of a workflow version's eight authoring stages: sources, source study, questionnaire, dossier, plan and proposal, package, evaluation, and review and publication.

## Discovery and meaning

**Semantic dossier**:
A structured account of the workflow's meaning, including Node responsibilities, inputs, completion evidence, bindings, outputs, decisions, routes, and recovery expectations.

**Node**:
A meaningful stage of a workflow with its own responsibility, completion evidence, and possible outcomes.

**Node responsibility**:
The work a Node owns and the reason that stage exists.

**Completion evidence**:
Observable information that supports the claim that a Node has finished its responsibility.

**Workflow decision**:
A choice by the workflow owner between at least two valid outcomes that changes scope, behavior, accepted risk, or an irreversible result.

**Automatic handling**:
A deterministic response for which no meaningful user choice remains.

**Stop condition**:
A state in which progress cannot safely continue until a missing dependency, contradiction, or invalid condition is repaired.

**Manual handoff**:
A transfer of bounded work or evidence to a person or agent without implying that the recipient must choose between workflow outcomes.

## Questionnaire

**Question**:
A request for workflow knowledge that the Engineer publishes to the people who can answer it, with its reason and evidence. A follow-up is a child Question that keeps its parent's thread.

**Round**:
An ordered batch of Questions published together, highest priority first.

**Answer**:
An assigned person's response to a Question, in any language, kept with every revision.

**Resolution**:
The Engineer's recorded outcome for an answered Question: confirmed, followed up, deferred with a reason, or withdrawn.
_Avoid_: disposition

**Fact**:
A formal statement of workflow meaning that the Semantic dossier may rely on, traced to its evidence: the Answer revisions it restates, or the lines of the Skill version it was derived from.

**Acknowledgement**:
The answering Field expert's confirmation that a Fact restates their Answer faithfully. Disputing the restatement instead reopens the Question.

## Authoring organization

**Authoring lane**:
A bounded responsibility for organizing workflow evidence or writing one declared part of the resulting Skill package.

**Wave**:
A group of authoring lanes that may proceed together because none depends on another lane's result.

**Authored leaf**:
A package document whose substantive content is supplied by an authoring lane.

**Deterministic backbone**:
The package content whose structure and behavior are defined by the confirmed workflow contract and generated consistently by Badger.

**Lane claim**:
An evidence-backed statement that a lane has fulfilled one declared responsibility.

## Drafting and sign-off

**Drafting job**:
A bounded piece of drafting that a connected Agent claims, bound to the hashes of its inputs. Its result stays a draft until a person accepts it.
_Avoid_: Agent job

**Gate**:
A point where work waits for a person's explicit confirmation or answer, bound to exactly what they reviewed. Gates guard the steps of building a workflow version, such as approving its dossier, and every moment a Run waits for a person.

**Personal access token**:
A person's credential for their Agents and the CLI, limited to the scopes they chose and never valid for an action reserved for people.

**MCP profile**:
One of the three tool sets the Badger MCP offers an Agent, for engineer, expert, or operator work.

## Execution meaning

**Workflow protocol**:
The executable description of Nodes, bindings, outputs, decisions, routes, guards, and recovery behavior.

**Authoring protocol**:
The contract for producing and checking package authoring evidence: lanes, dependencies, claims, authored leaves, review depth, and assembly boundaries.

**Runtime authority**:
The part of the workflow system that owns state, validates submissions, selects legal transitions, and records durable execution evidence.

## Runs and evaluation

**Run**:
One durable execution of a workflow package under the Runtime authority, which records every accepted step so that the Run can resume after a crash.

**Attempt**:
One entry of a Run into a Node. Re-entering the Node starts a new Attempt; retrying within it does not.

**Cycle**:
A declared loop of Nodes that a Run may repeat a bounded number of times, each repetition with its own identity.

**Artifact receipt**:
A record that identifies an artifact and the Attempt that produced it without holding the artifact's content.

**Run registry**:
The index that lists Runs and where each one lives, so that a Run can be found without knowing its location.

**Evaluation**:
The checks and runtime certification run against one exact package hash. Its report counts only for that hash, and publication requires a passing one.

## Notifications

**Notification channel**:
A route by which Badger tells people that something waits for them: the in-app inbox, or a team chat reached through a Group robot.

**Group robot**:
A WeCom group chat's webhook robot, through which Badger posts in a workflow team's chat and @mentions the people who need to act. Its group is the chat, not a Badger Group.

**Reminder**:
A recorded nudge to whoever an item still waits on, posted as a fresh mention through the workflow's Group robot, or offered as ready-to-paste text when there is none.

**Delivery**:
The record of one post sent through a Notification channel, such as a Group robot, and whether it arrived.
