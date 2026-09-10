import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildProposal } from "../src/factory/proposal.js";
import {
  AUTHORING_COMPATIBILITY,
  AUTHORING_PROTOCOL,
  AUTHORING_PROTOCOL_HASH,
  AuthoringPlanValidationError,
  buildAuthoringPlan,
  deriveAuthoringPlan,
  validateAuthoringPlan,
  validateAuthoringProtocol,
} from "../src/authoring/index.js";
import type { FactoryPlan } from "../src/types.js";

describe("AuthoringPlan preview", () => {
  const execFileAsync = promisify(execFile);
  let root: string;
  let project: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-authoring-plan-"));
    project = path.join(root, "project");
    const skillRoot = path.join(project, ".agents", "skills", "prepare");
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.writeFile(
      path.join(skillRoot, "SKILL.md"),
      "---\nname: prepare\ndescription: Prepare the workflow.\n---\n\n# Prepare\n",
    );
  });

  afterEach(async () => fs.rm(root, { recursive: true, force: true }));

  it("derives the six-lane plan from a normalized proposal without writes", async () => {
    const plan: FactoryPlan = {
      schemaVersion: 1,
      goal: "Create a prepared workflow.",
      skillCreatorIntent: "new-skill",
      skillSources: [
        {
          name: "prepare",
          location: path.join(".agents", "skills", "prepare"),
        },
      ],
      defaultLocale: "en",
      workflow: {
        kind: "workflow-kernel",
        name: "prepared-workflow",
        goal: "Prepare a workflow.",
        customNodes: [
          {
            id: "prepare",
            label: "Prepare",
            kind: "action",
            responsibility: "Prepare the workflow.",
            implementation: {
              skill: "prepare",
              operation: "default",
              scope: "main",
            },
            operations: ["require", "augment", "disable"],
            outputSchemas: [],
            guardrails: [],
          },
          {
            id: "disabled",
            label: "Disabled",
            kind: "action",
            responsibility: "Not executable.",
            implementation: {
              skill: "prepare",
              operation: "default",
              scope: "main",
            },
            disabled: true,
            operations: ["require", "augment", "disable"],
            outputSchemas: [],
            guardrails: [],
          },
        ],
        outputSchemas: [],
      },
    };
    const planPath = path.join(project, "plan.json");
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2));

    const proposal = await buildProposal({ projectRoot: project, planPath });
    const authoringPlan = deriveAuthoringPlan({ proposal, depth: "full" });

    expect(authoringPlan).toMatchObject({
      schemaVersion: 1,
      kind: "authoring-plan",
      name: "prepared-workflow",
      depth: "full",
      protocolHash: AUTHORING_PROTOCOL_HASH,
      workflowProtocolHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      sourceEvidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      dag: {
        wave1: ["script", "reference", "pause-points"],
        wave2: ["workflow-entry", "skill-core"],
        barrier: ["skill-review"],
      },
      verify: {
        voters: 3,
        lenses: [
          "contract-fit",
          "usability",
          "evidence-trace",
          "self-consistency",
        ],
        maxRounds: 4,
      },
      merge: {
        deterministicBackbone: expect.arrayContaining([
          "reference/workflow-protocol.json",
          "reference/authoring-lanes.json",
        ]),
        contentLeaves: expect.arrayContaining([
          "SKILL.md",
          "../prepared-workflow-prepare/SKILL.md",
          "reference/decision-points.md",
          "reference/recovery.md",
          "reference/skill-review.md",
        ]),
      },
    });
    expect(authoringPlan.workflowProtocolHash).not.toBe(
      authoringPlan.protocolHash,
    );
    expect(authoringPlan.sourceEvidence).toEqual([
      expect.objectContaining({
        name: "prepare",
        status: "available",
        sources: [expect.objectContaining({ name: "prepare" })],
      }),
    ]);
    expect(authoringPlan.lanes.map((lane) => lane.id)).toEqual([
      "script",
      "reference",
      "pause-points",
      "workflow-entry",
      "skill-core",
      "skill-review",
    ]);
    expect(
      authoringPlan.lanes.find((lane) => lane.id === "skill-core")
        ?.contentLeaves,
    ).toEqual(["../prepared-workflow-prepare/SKILL.md"]);
    await expect(
      fs.access(path.join(project, ".badger")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns structured diagnostics for invalid lane definitions", async () => {
    const plan: FactoryPlan = {
      schemaVersion: 1,
      goal: "Create a prepared workflow.",
      skillCreatorIntent: "new-skill",
      skillSources: [
        {
          name: "prepare",
          location: path.join(".agents", "skills", "prepare"),
        },
      ],
      defaultLocale: "en",
      workflow: {
        kind: "workflow-kernel",
        name: "prepared-workflow",
        goal: "Prepare a workflow.",
        customNodes: [],
        outputSchemas: [],
      },
    };
    const planPath = path.join(project, "plan.json");
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2));
    const proposal = await buildProposal({ projectRoot: project, planPath });
    const authoringPlan = deriveAuthoringPlan({ proposal });

    const unknown = structuredClone(authoringPlan);
    unknown.lanes[0].id = "unknown" as never;
    expect(
      validateAuthoringPlan(unknown).map((finding) => finding.code),
    ).toContain("unknown-lane");

    const duplicate = structuredClone(authoringPlan);
    duplicate.lanes[1].id = duplicate.lanes[0].id;
    expect(
      validateAuthoringPlan(duplicate).map((finding) => finding.code),
    ).toContain("duplicate-lane");

    const reordered = structuredClone(authoringPlan);
    [reordered.lanes[0], reordered.lanes[1]] = [
      reordered.lanes[1],
      reordered.lanes[0],
    ];
    expect(
      validateAuthoringPlan(reordered).map((finding) => finding.code),
    ).toContain("lane-order");

    const missing = structuredClone(authoringPlan);
    missing.lanes.pop();
    expect(
      validateAuthoringPlan(missing).map((finding) => finding.code),
    ).toContain("lane-order");

    const malformed = structuredClone(authoringPlan);
    malformed.lanes[0] = null as never;
    expect(
      validateAuthoringPlan(malformed).map((finding) => finding.code),
    ).toContain("invalid-lane");
    expect(() => {
      throw new AuthoringPlanValidationError(validateAuthoringPlan(malformed));
    }).toThrow(AuthoringPlanValidationError);
  });

  it("binds source evidence changes without changing the workflow protocol identity", async () => {
    const plan: FactoryPlan = {
      schemaVersion: 1,
      goal: "Create a prepared workflow.",
      skillCreatorIntent: "new-skill",
      skillSources: [
        {
          name: "prepare",
          location: path.join(".agents", "skills", "prepare"),
        },
      ],
      defaultLocale: "en",
      workflow: {
        kind: "workflow-kernel",
        name: "prepared-workflow",
        goal: "Prepare a workflow.",
        customNodes: [],
        outputSchemas: [],
      },
    };
    const planPath = path.join(project, "plan.json");
    const skillPath = path.join(
      project,
      ".agents",
      "skills",
      "prepare",
      "SKILL.md",
    );
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2));
    const first = deriveAuthoringPlan({
      proposal: await buildProposal({ projectRoot: project, planPath }),
    });
    await fs.appendFile(skillPath, "\nAdditional source evidence.\n");
    const second = deriveAuthoringPlan({
      proposal: await buildProposal({ projectRoot: project, planPath }),
    });

    expect(second.workflowProtocolHash).toBe(first.workflowProtocolHash);
    expect(second.sourceEvidenceHash).not.toBe(first.sourceEvidenceHash);
  });

  it("matches the pinned upstream protocol while recording Badger extensions separately", async () => {
    const protocolFixture = JSON.parse(
      await fs.readFile(
        path.join(
          process.cwd(),
          "assets/skills/badger-create/reference/authoring-protocol.json",
        ),
        "utf8",
      ),
    );
    const compatibilityFixture = JSON.parse(
      await fs.readFile(
        path.join(
          process.cwd(),
          "test/fixtures/authoring/authoring-compatibility.json",
        ),
        "utf8",
      ),
    );

    expect(AUTHORING_PROTOCOL).toEqual(protocolFixture);
    expect(validateAuthoringProtocol(protocolFixture)).toEqual([]);
    expect(AUTHORING_PROTOCOL_HASH).toBe(
      "d7e5d2f97828336e6d7b1237d786c3dd02229370f7698a5162f52942938b8303",
    );
    expect(compatibilityFixture).toMatchObject({
      official: {
        revision: "99fd7495f8b9217efbaae3a46d885f6fa7f4102a",
        version: "0.4.0-beta.19",
      },
      knownUpstreamInconsistencies: expect.any(Array),
      badgerExtensions: expect.any(Array),
    });
    expect(
      AUTHORING_COMPATIBILITY.knownUpstreamInconsistencies.map(
        (note) => note.id,
      ),
    ).toEqual(compatibilityFixture.knownUpstreamInconsistencies);
    expect(
      AUTHORING_COMPATIBILITY.badgerExtensions.map((note) => note.id),
    ).toEqual(compatibilityFixture.badgerExtensions);
  });

  it("accepts the upstream AuthoringPlan core without Badger extensions", async () => {
    const plan: FactoryPlan = {
      schemaVersion: 1,
      goal: "Create a prepared workflow.",
      skillCreatorIntent: "new-skill",
      skillSources: [
        {
          name: "prepare",
          location: path.join(".agents", "skills", "prepare"),
        },
      ],
      defaultLocale: "en",
      workflow: {
        kind: "workflow-kernel",
        name: "prepared-workflow",
        goal: "Prepare a workflow.",
        customNodes: [],
        outputSchemas: [],
      },
    };
    const planPath = path.join(project, "plan.json");
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2));
    const derived = deriveAuthoringPlan({
      proposal: await buildProposal({ projectRoot: project, planPath }),
    });
    expect(
      derived.lanes.find((lane) => lane.id === "skill-core")
        ?.producesContentLeaves,
    ).toBe(true);
    const upstreamPlan = {
      schemaVersion: 1,
      name: derived.name,
      depth: derived.depth,
      protocolHash: derived.protocolHash,
      dag: derived.dag,
      lanes: derived.lanes.map(({ id, claims, producesContentLeaves }) => ({
        id,
        claims,
        producesContentLeaves,
      })),
      verify: {
        voters: derived.verify.voters,
        lenses: derived.verify.lenses,
        maxRounds: derived.verify.maxRounds,
        dryThreshold: derived.verify.dryThreshold,
      },
    };

    expect(validateAuthoringPlan(upstreamPlan)).toEqual([]);
  });

  it("rejects an unsupported authoring depth with a structured diagnostic", async () => {
    const plan: FactoryPlan = {
      schemaVersion: 1,
      goal: "Create a prepared workflow.",
      skillCreatorIntent: "new-skill",
      skillSources: [
        {
          name: "prepare",
          location: path.join(".agents", "skills", "prepare"),
        },
      ],
      defaultLocale: "en",
      workflow: {
        kind: "workflow-kernel",
        name: "prepared-workflow",
        goal: "Prepare a workflow.",
        customNodes: [],
        outputSchemas: [],
      },
    };
    const planPath = path.join(project, "plan.json");
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2));
    const proposal = await buildProposal({ projectRoot: project, planPath });

    try {
      deriveAuthoringPlan({ proposal, depth: "extended" as never });
      throw new Error("expected invalid depth");
    } catch (error) {
      expect(error).toBeInstanceOf(AuthoringPlanValidationError);
      expect((error as AuthoringPlanValidationError).diagnostics).toEqual([
        expect.objectContaining({ code: "invalid-plan", path: "depth" }),
      ]);
    }
  });

  it("previews through the CLI from a plan path or an existing workflow name", async () => {
    const plan: FactoryPlan = {
      schemaVersion: 1,
      goal: "Create a prepared workflow.",
      skillCreatorIntent: "new-skill",
      skillSources: [
        {
          name: "prepare",
          location: path.join(".agents", "skills", "prepare"),
        },
      ],
      defaultLocale: "en",
      workflow: {
        kind: "workflow-kernel",
        name: "prepared-workflow",
        goal: "Prepare a workflow.",
        customNodes: [],
        outputSchemas: [],
      },
    };
    const planPath = path.join(project, "plan.json");
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2));
    const proposal = await buildProposal({ projectRoot: project, planPath });
    const direct = await buildAuthoringPlan({
      proposal,
      depth: "quick",
    });
    const directOutput = JSON.stringify(direct);
    expect(directOutput).toContain("workflowProtocolHash");

    const state = await import("../src/factory/state.js").then(
      ({ initializeState }) =>
        initializeState({
          projectRoot: project,
          planPath,
          plan,
          proposal,
          confirmed: true,
        }),
    );
    const stateBeforePreview = await fs.readFile(
      path.join(project, ".badger", "states", `${state.name}.json`),
      "utf8",
    );
    const cliNameResult = await execFileAsync(
      process.execPath,
      [
        "bin/badger.js",
        "authoring-plan",
        state.name,
        "--project",
        project,
        "--json",
      ],
      { cwd: path.resolve(process.cwd()) },
    );
    expect(JSON.parse(cliNameResult.stdout)).toMatchObject({
      kind: "authoring-plan",
      name: state.name,
    });
    await expect(
      fs.readFile(
        path.join(project, ".badger", "states", `${state.name}.json`),
        "utf8",
      ),
    ).resolves.toBe(stateBeforePreview);
  });
});
