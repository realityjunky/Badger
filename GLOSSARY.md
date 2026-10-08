# Badger Workflow Authoring

This context defines the language for turning a user's workflow idea and supplied Skills into a confirmed workflow package.

## Discovery and meaning

**Workflow owner**:
The person who confirms the desired workflow, its acceptable behavior, and its unresolved choices.

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

## Execution meaning

**Workflow protocol**:
The executable description of Nodes, bindings, outputs, decisions, routes, guards, and recovery behavior.

**Authoring protocol**:
The contract for producing and checking package authoring evidence: lanes, dependencies, claims, authored leaves, review depth, and assembly boundaries.

**Runtime authority**:
The part of the workflow system that owns state, validates submissions, selects legal transitions, and records durable execution evidence.
