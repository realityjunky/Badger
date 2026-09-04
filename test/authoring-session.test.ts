import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProposal, readPlan } from "../src/factory/proposal.js";
import { generatePackage } from "../src/factory/generate.js";
import { initializeState, readState } from "../src/factory/state.js";
import {
  AuthoringRevisionConflictError,
  assemblePackage,
  authoringReadiness,
  buildAuthoringHandoff,
  initializeAuthoringSession,
  recordAuthoring,
  recordAuthoringFile,
  readAuthoringSession,
  runManualAuthoringFixture,
  validateAuthoringLaneOutput,
} from "../src/authoring/index.js";
import { deriveAuthoringPlan } from "../src/authoring/plan.js";
import type { CreatorState, FactoryPlan } from "../src/types.js";

describe("resumable authoring session", () => {
  let root: string;
  let project: string;
  let planPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-authoring-session-"),
    );
    project = path.join(root, "project");
    const skillRoot = path.join(project, ".agents", "skills", "prepare");
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.writeFile(
      path.join(skillRoot, "SKILL.md"),
      "---\nname: prepare\ndescription: Prepare the workflow.\n---\n\n# Prepare\n",
    );
    const plan: FactoryPlan = {
      schemaVersion: 1,
      goal: "Create a prepared workflow.",
      skillCreatorIntent: "new-skill",
      preferredSkills: ["prepare"],
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
        ],
        outputSchemas: [],
      },
    };
    planPath = path.join(project, "plan.json");
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2));
  });

  afterEach(async () => fs.rm(root, { recursive: true, force: true }));

  async function createSession(): Promise<{
    state: CreatorState;
    plan: ReturnType<typeof deriveAuthoringPlan>;
  }> {
    const proposal = await buildProposal({ projectRoot: project, planPath });
    const plan = await readPlan(planPath);
    const state = await initializeState({
      projectRoot: project,
      planPath,
      plan,
      proposal,
      confirmed: true,
    });
    const generated = await generatePackage({
      proposal,
      plan,
      destination: state.draftPath,
    });
    state.generated = generated;
    const authoringPlan = deriveAuthoringPlan({ proposal });
    await initializeAuthoringSession({
      state,
      plan: authoringPlan,
      generated,
    });
    return { state, plan: authoringPlan };
  }

  function claims(
    plan: ReturnType<typeof deriveAuthoringPlan>,
    laneId: string,
  ) {
    const lane = plan.lanes.find((item) => item.id === laneId)!;
    return lane.claims.concat(lane.derivedClaims).map((id) => ({
      id,
      summary: `Supported by ${id}.`,
    }));
  }

  it("accepts the upstream lane envelope and reports bounded evidence", async () => {
    const { state, plan } = await createSession();
    const initialRevision = state.authoring!.revision;

    const record = await recordAuthoring({
      state,
      lane: "script",
      expectedRevision: state.authoring!.revision,
      record: {
        lane: "script",
        status: "DONE",
        dispatchMode: "manual-file",
        claims: claims(plan, "script"),
        artifacts: [],
        findings: [
          {
            severity: "minor",
            path: "scripts/workflow-state.mjs",
            problem: "Fixture uses the bundled adapter.",
          },
        ],
      },
    });

    expect(record).toMatchObject({
      lane: "script",
      status: "DONE",
      dispatchMode: "manual-file",
      protocolHash: plan.protocolHash,
      workflowProtocolHash: plan.workflowProtocolHash,
      sourceEvidenceHash: plan.sourceEvidenceHash,
    });
    expect(record.findings).toHaveLength(1);

    const recovered = await readState(project, state.name);
    const readiness = await authoringReadiness(recovered);
    expect(readiness.completedLanes).toEqual(["script"]);
    expect(readiness.nextLanes).toEqual([
      "reference",
      "pause-points",
      "workflow-entry",
      "skill-core",
    ]);
    expect(readiness.recovery).toMatchObject({
      resumable: true,
      revision: initialRevision + 1,
      sessionPath: state.authoring!.sessionPath,
    });
    expect(readiness.lanes.script).toMatchObject({
      status: "DONE",
      claims: expect.arrayContaining([
        expect.objectContaining({ id: "script:workflow-state" }),
      ]),
      artifacts: [],
    });
  });

  it("rejects stale revisions without losing the last accepted lane", async () => {
    const { state, plan } = await createSession();
    const firstRevision = state.authoring!.revision;
    await recordAuthoring({
      state,
      lane: "script",
      expectedRevision: firstRevision,
      record: { status: "DONE", claims: claims(plan, "script"), artifacts: [] },
    });

    await expect(
      recordAuthoring({
        state: structuredClone(state),
        lane: "reference",
        expectedRevision: firstRevision,
        record: {
          status: "DONE",
          claims: claims(plan, "reference"),
          artifacts: [],
        },
      }),
    ).rejects.toBeInstanceOf(AuthoringRevisionConflictError);

    const recovered = await readState(project, state.name);
    const readiness = await authoringReadiness(recovered);
    expect(readiness.completedLanes).toEqual(["script"]);
    expect(readiness.recovery.revision).toBe(firstRevision + 1);
  });

  it("serializes concurrent wave-one records and blocks dependent lanes", async () => {
    const { state, plan } = await createSession();
    const initialRevision = state.authoring!.revision;
    await Promise.all([
      recordAuthoring({
        state: structuredClone(state),
        lane: "script",
        record: {
          status: "DONE",
          claims: claims(plan, "script"),
          artifacts: [],
        },
      }),
      recordAuthoring({
        state: structuredClone(state),
        lane: "reference",
        record: {
          status: "DONE",
          claims: claims(plan, "reference"),
          artifacts: [],
        },
      }),
    ]);

    const recovered = await readState(project, state.name);
    const readiness = await authoringReadiness(recovered);
    expect(readiness.completedLanes).toEqual(["script", "reference"]);
    expect(readiness.nextLanes).toEqual([
      "pause-points",
      "workflow-entry",
      "skill-core",
    ]);
    expect(readiness.recovery.revision).toBe(initialRevision + 2);
    await recordAuthoring({
      state: recovered,
      lane: "workflow-entry",
      record: {
        status: "DONE",
        claims: claims(plan, "workflow-entry"),
        artifacts: [
          {
            id: "SKILL.md",
            path: "SKILL.md",
            present: true,
            content:
              "## Decision Core\n\n### Automatic Node Detection\nRead the current Node from persisted state and compare the request topic with declared responsibilities.\n\n### Resume And Drift\nOn resume, re-read persisted state instead of trusting conversation history, and handle topic changes explicitly.\n\n### Decision Classification And Decision Points\nClassify every user decision, automatic handling case, stop condition, and manual handoff before continuing.\n\n### Red Flags\nDo not skip the current Node or treat missing evidence as complete.",
          },
        ],
      },
    });
  });

  it("creates a capability-limited handoff and completes through the manual fixture", async () => {
    const { state } = await createSession();
    const handoff = await buildAuthoringHandoff({
      state,
      lane: "script",
      outputPath: path.join(root, "provider-output", "script.json"),
    });

    expect(handoff).not.toHaveProperty("statePath");
    expect(handoff.capabilities).toEqual({
      writeCreatorState: false,
      executeCandidateSkills: false,
      publish: false,
      distribute: false,
      accessCredentials: false,
    });
    expect(handoff.inputPaths).toEqual(
      expect.arrayContaining([handoff.roleBriefPath, handoff.commonInputPath]),
    );

    const completed = await runManualAuthoringFixture({ state });
    const readiness = await authoringReadiness(
      await readState(project, completed.name),
    );
    expect(readiness.state).toBe("ready");
    expect(readiness.completedLanes).toEqual([
      "script",
      "reference",
      "pause-points",
      "workflow-entry",
      "skill-core",
      "skill-review",
    ]);
    const assembled = await assemblePackage(completed);
    expect(assembled.authoring?.status).toBe("assembled");
  });

  it("persists explicit stop statuses and prevents dependent execution", async () => {
    const { state, plan } = await createSession();
    await recordAuthoring({
      state,
      lane: "script",
      record: {
        status: "BLOCKED",
        summary: "The script contract needs runtime context.",
        findings: [
          {
            severity: "important",
            problem: "The runtime adapter contract is unavailable.",
          },
        ],
        claims: [],
        artifacts: [],
      },
    });

    await expect(
      recordAuthoring({
        state,
        lane: "workflow-entry",
        record: {
          status: "DONE",
          claims: claims(plan, "workflow-entry"),
          artifacts: [],
        },
      }),
    ).rejects.toThrow(/blocked by script/iu);

    const readiness = await authoringReadiness(
      await readState(project, state.name),
    );
    expect(readiness.state).toBe("blocked");
    expect(readiness.lanes.script).toMatchObject({
      status: "BLOCKED",
      summary: "The script contract needs runtime context.",
    });
    expect(readiness.blockers).toContain("Authoring lane is BLOCKED: script");
    expect(readiness.nextLanes).toEqual([
      "script",
      "reference",
      "pause-points",
    ]);
  });

  it("rejects malformed lane envelopes before they can mutate the session", async () => {
    const { state, plan } = await createSession();
    const valid = {
      lane: "script",
      status: "DONE",
      claims: claims(plan, "script"),
      artifacts: [],
    };
    expect(validateAuthoringLaneOutput(valid, plan, "script")).toEqual([]);
    expect(
      validateAuthoringLaneOutput(
        { ...valid, status: "PENDING" },
        plan,
        "script",
      ),
    ).toEqual(
      expect.arrayContaining([expect.stringContaining("status is invalid")]),
    );
    expect(
      validateAuthoringLaneOutput(
        {
          ...valid,
          claims: [...claims(plan, "script"), { id: "unknown", summary: "x" }],
        },
        plan,
        "script",
      ),
    ).toContain("unknown authoring claim: unknown");
    expect(
      validateAuthoringLaneOutput(
        { ...valid, protocolHash: "0".repeat(64) },
        plan,
        "script",
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("protocolHash is stale"),
      ]),
    );

    const before = await readState(project, state.name);
    await expect(
      recordAuthoring({
        state,
        lane: "script",
        record: { ...valid, protocolHash: "0".repeat(64) },
      }),
    ).rejects.toThrow(/stale/iu);
    const after = await readState(project, state.name);
    expect(after.authoring?.revision).toBe(before.authoring?.revision);
    expect(after.authoring?.records).toEqual(before.authoring?.records);
  });

  it("preserves prior records when a provider report is oversized or a session summary is partial", async () => {
    const { state, plan } = await createSession();
    await recordAuthoring({
      state,
      lane: "script",
      record: { status: "DONE", claims: claims(plan, "script"), artifacts: [] },
    });
    const outputPath = path.join(root, "oversized.json");
    await fs.writeFile(
      outputPath,
      JSON.stringify({ data: "x".repeat(300_000) }),
    );
    await expect(
      recordAuthoringFile({ state, lane: "reference", file: outputPath }),
    ).rejects.toThrow(/size limit/iu);

    await fs.writeFile(
      path.join(project, ".badger", "authoring", state.name, "state.json"),
      "{\n",
    );
    const recovered = await authoringReadiness(
      await readState(project, state.name),
    );
    expect(recovered.completedLanes).toEqual(["script"]);
    expect(recovered.recovery.revision).toBe(state.authoring!.revision);
  });

  it("reconciles a lane record that committed before the process exited", async () => {
    const { state, plan } = await createSession();
    const initialRevision = state.authoring!.revision;
    await recordAuthoring({
      state,
      lane: "script",
      record: { status: "DONE", claims: claims(plan, "script"), artifacts: [] },
    });
    const stateFile = path.join(
      project,
      ".badger",
      "states",
      `${state.name}.json`,
    );
    const sessionFile = path.join(
      project,
      ".badger",
      "authoring",
      state.name,
      "state.json",
    );
    for (const file of [stateFile, sessionFile]) {
      const value = JSON.parse(await fs.readFile(file, "utf8")) as CreatorState;
      if (file === stateFile) {
        value.authoring!.revision = initialRevision;
        delete value.authoring!.records.script;
      } else {
        const summary = value as unknown as CreatorState["authoring"];
        summary!.revision = initialRevision;
        delete summary!.records.script;
      }
      await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n");
    }
    const recovered = await readAuthoringSession(project, state.name);
    expect(recovered.revision).toBe(initialRevision + 1);
    expect(recovered.records.script?.revision).toBe(initialRevision + 1);
    expect(
      (await authoringReadiness(await readState(project, state.name)))
        .completedLanes,
    ).toEqual(["script"]);
  });

  it("keeps concerns visible and prevents them from unlocking dependents", async () => {
    const { state, plan } = await createSession();
    await recordAuthoring({
      state,
      lane: "script",
      record: {
        status: "DONE_WITH_CONCERNS",
        findings: [
          {
            severity: "important",
            problem: "A recovery edge needs confirmation.",
          },
        ],
        claims: [],
        artifacts: [],
      },
    });
    const readiness = await authoringReadiness(
      await readState(project, state.name),
    );
    expect(readiness.warnings).toContain("Authoring lane has concerns: script");
    expect(readiness.lanes.script.summary).toBe(
      "A recovery edge needs confirmation.",
    );
    expect(readiness.waves[0].blocked.script).toContain("lane has concerns");
    await expect(
      recordAuthoring({
        state,
        lane: "workflow-entry",
        record: {
          status: "DONE",
          claims: claims(plan, "workflow-entry"),
          artifacts: [
            {
              id: "SKILL.md",
              path: "SKILL.md",
              present: true,
              content: "Detect the current Node.",
            },
          ],
        },
      }),
    ).rejects.toThrow(/blocked by script/iu);
  });

  it("invalidates dependent records when an upstream lane is revised", async () => {
    const { state, plan } = await createSession();
    const completed = await runManualAuthoringFixture({ state });
    const revisionBefore = completed.authoring!.revision;
    await recordAuthoring({
      state: completed,
      lane: "script",
      expectedRevision: revisionBefore,
      record: {
        status: "DONE",
        dispatchMode: "manual-file",
        claims: claims(plan, "script"),
        artifacts: [],
        summary: "The script contract was revised and re-recorded.",
      },
    });
    const readiness = await authoringReadiness(
      await readState(project, completed.name),
    );
    expect(readiness.recovery.invalidatedLanes).toEqual([
      "workflow-entry",
      "skill-core",
      "skill-review",
    ]);
    expect(readiness.completedLanes).toEqual([
      "script",
      "reference",
      "pause-points",
    ]);
    expect(readiness.nextLanes).toEqual(["workflow-entry", "skill-core"]);
    expect(readiness.state).toBe("blocked");
  });
});
