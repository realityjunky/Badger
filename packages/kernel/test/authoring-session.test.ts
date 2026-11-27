import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { localFindingHandoff } from "../src/authoring/finding-history.js";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { buildProposal, readPlan } from "../src/factory/proposal.js";
import { generatePackage } from "../src/factory/generate.js";
import {
  creatorStateHash,
  initializeState,
  readState,
} from "../src/factory/state.js";
import {
  AUTHORING_INPUT_LIMIT_BYTES,
  AuthoringRevisionConflictError,
  assemblePackage as assemblePackageImplementation,
  authoringReadiness,
  authoringSessionGateway,
  buildAuthoringHandoff,
  hashAuthoringSessionInput,
  initializeAuthoringSession,
  recordAuthoring as persistAuthoring,
  recordAuthoringFile,
  readAuthoringSession,
  runManualAuthoringFixture,
  validateAuthoringLaneOutput,
} from "../src/authoring/index.js";
import { deriveAuthoringPlan } from "../src/authoring/plan.js";
import type { CreatorState, FactoryPlan } from "../src/types.js";
import { questionnaireFixture } from "./fixtures/semantic-dossier.js";
import { findSkills } from "../src/skill/find.js";
import { evaluatePackage } from "../src/eval/run.js";
import { reviewState } from "../src/publish/lifecycle.js";
import { sha256, stableValue } from "../src/util.js";

const recordAuthoring = (options: Parameters<typeof persistAuthoring>[0]) =>
  persistAuthoring({ ...options, confirmed: true });
const assemblePackage = (
  state: Parameters<typeof assemblePackageImplementation>[0],
) => assemblePackageImplementation(state, true);

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
      skillSources: [{ name: "prepare", location: skillRoot }],
      defaultLocale: "en",
      workflow: {
        kind: "workflow-kernel",
        name: "prepared-workflow",
        goal: "Create a prepared workflow.",
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
    const existingHash = await creatorStateHash(project, proposal.name);
    const state = await initializeState({
      projectRoot: project,
      planPath,
      proposalHash: proposal.proposalHash,
      ...(existingHash ? { replaceStateHash: existingHash } : {}),
      confirmed: true,
    });
    const generated = await generatePackage({
      proposal,
      plan,
      destination: state.draftPath,
      projectRoot: state.projectRoot,
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

  it("carries confirmed dossier evidence into every Wave 1 handoff and invalidates records after semantic repair", async () => {
    const factoryPlan = await readPlan(planPath);
    const candidates = await findSkills({
      projectRoot: project,
      sources: factoryPlan.skillSources,
    });
    const source = candidates[0].sources[0];
    const { dossier } = questionnaireFixture();
    dossier.workflow.goal = factoryPlan.goal;
    dossier.sources[0] = {
      ...dossier.sources[0],
      location: factoryPlan.skillSources[0].location,
      contentHash: source.hash,
    };
    factoryPlan.semanticDossier = dossier;
    await fs.writeFile(planPath, JSON.stringify(factoryPlan));
    const { state, plan } = await createSession();
    const originalHash = state.authoring!.authoringInputHash;
    const output = {
      lane: "script",
      status: "DONE",
      claims: claims(plan, "script"),
      artifacts: [],
      findings: [],
      protocolHash: plan.protocolHash,
      authoringPlanHash: plan.authoringPlanHash,
      workflowProtocolHash: plan.workflowProtocolHash,
      sourceEvidenceHash: plan.sourceEvidenceHash,
      authoringInputHash: originalHash,
      semanticDossierHash: plan.semanticDossierHash,
    };
    expect(validateAuthoringLaneOutput(output, plan, "script")).toEqual([]);
    for (const semanticDossierHash of [undefined, "0".repeat(64)]) {
      expect(
        validateAuthoringLaneOutput(
          { ...output, semanticDossierHash },
          plan,
          "script",
        ).join(" "),
      ).toMatch(/semanticDossierHash/);
      await expect(
        recordAuthoring({
          state,
          lane: "script",
          record: { ...output, semanticDossierHash },
        }),
      ).rejects.toThrow(/semanticDossierHash/);
    }
    expect(
      validateAuthoringLaneOutput(
        {
          ...output,
          status: "NEEDS_CONTEXT",
          summary: "Need recovery details",
        },
        plan,
        "script",
      ).join(" "),
    ).toMatch(/action/);
    expect(plan.semanticDossierHash).toMatch(/^[a-f0-9]{64}$/u);
    for (const lane of ["script", "reference", "pause-points"] as const) {
      const handoff = await buildAuthoringHandoff({
        state,
        lane,
        outputPath: path.join(root, `${lane}.json`),
      });
      expect(handoff.semanticDossier).toEqual({
        path: state.authoring!.planPath,
        pointer: "/semanticDossier",
        hash: plan.semanticDossierHash,
      });
      const commonInput = JSON.parse(
        await fs.readFile(handoff.commonInputPath, "utf8"),
      );
      expect(commonInput.semanticDossier).toEqual(handoff.semanticDossier);
      expect(commonInput.hashes).toEqual(handoff.hashes);
      expect(handoff.capabilities.modifyGeneratedPackage).toBe(false);
      const persistedPlan = JSON.parse(
        await fs.readFile(handoff.semanticDossier!.path, "utf8"),
      );
      expect(persistedPlan.semanticDossier).toEqual(dossier);
    }
    const question = {
      kind: "question",
      requirement: "/topics/recoveryPolicy",
      prompt: "Who confirms recovery after an interrupted prepare step?",
    };
    await expect(
      buildAuthoringHandoff({
        state,
        lane: "script",
        outputPath: path.join(state.generated!.packageRoot, "SKILL.md"),
      }),
    ).rejects.toThrow(/generated package|\.badger state/);
    const repair = {
      kind: "repair",
      requirement: "Reconcile conflicting source composition evidence",
      prompt: "Repair the source composition evidence before review.",
    };
    const packageBefore = await fs.readFile(
      path.join(state.generated!.packageRoot, "reference", "recovery.md"),
      "utf8",
    );
    await Promise.all([
      recordAuthoring({
        state,
        lane: "script",
        record: {
          ...output,
          status: "NEEDS_CONTEXT",
          summary: question.prompt,
          action: question,
        },
      }),
      recordAuthoring({
        state,
        lane: "reference",
        record: {
          ...output,
          lane: "reference",
          status: "BLOCKED",
          summary: repair.prompt,
          claims: [],
          action: repair,
        },
      }),
      recordAuthoring({
        state,
        lane: "pause-points",
        record: {
          ...output,
          lane: "pause-points",
          status: "DONE_WITH_CONCERNS",
          summary: "Recovery classification awaits the script answer.",
          claims: claims(plan, "pause-points"),
          artifacts: [],
        },
      }),
    ]);
    const stopped = await authoringReadiness(
      await readState(project, state.name),
    );
    expect(stopped.lanes.script).toMatchObject({
      status: "NEEDS_CONTEXT",
      action: question,
    });
    expect(stopped.lanes.reference).toMatchObject({
      status: "BLOCKED",
      action: repair,
    });
    expect(stopped.lanes["pause-points"].status).toBe("DONE_WITH_CONCERNS");
    expect(stopped.nextLanes).not.toContain("workflow-entry");
    await expect(
      buildAuthoringHandoff({
        state,
        lane: "workflow-entry",
        outputPath: path.join(root, "entry.json"),
      }),
    ).rejects.toThrow(/script/);
    expect(
      await fs.readFile(
        path.join(state.generated!.packageRoot, "reference", "recovery.md"),
        "utf8",
      ),
    ).toBe(packageBefore);
    expect(
      validateAuthoringLaneOutput(
        {
          ...output,
          status: "NEEDS_CONTEXT",
          summary: question.prompt,
          action: { ...question, requirement: "/unknown" },
        },
        plan,
        "script",
      ).join(" "),
    ).toMatch(/dossier field/);
    await recordAuthoring({ state, lane: "script", record: output });
    await runManualAuthoringFixture({ state });
    expect(
      (await authoringReadiness(await readState(project, state.name))).state,
    ).toBe("ready");
    const reordered = {
      ...factoryPlan,
      semanticDossier: Object.fromEntries(Object.entries(dossier).reverse()),
    };
    await fs.writeFile(planPath, JSON.stringify(reordered));
    const stable = await createSession();
    expect(stable.state.authoring!.authoringInputHash).toBe(originalHash);
    dossier.topics.recoveryPolicy.summary =
      "Resume prepare only after owner-confirmed repair.";
    await fs.writeFile(planPath, JSON.stringify(factoryPlan));
    const repaired = await createSession();
    expect(repaired.state.authoring!.authoringInputHash).not.toBe(originalHash);
    expect(repaired.state.authoring!.invalidatedLanes).toContain("script");
    const readiness = await authoringReadiness(repaired.state);
    expect(readiness.state).toBe("blocked");
    dossier.sources[0].contentHash = "0".repeat(64);
    await fs.writeFile(planPath, JSON.stringify(factoryPlan));
    expect(
      (await buildProposal({ projectRoot: project, planPath })).blockers,
    ).toContain("Semantic dossier source identity is stale: prepare");
  });

  it("rejects symlink ancestors and leaves before writing handoff inputs", async () => {
    const { state } = await createSession();
    const linkedRoot = path.join(root, "linked-package");
    await fs.symlink(state.generated!.packageRoot, linkedRoot, "dir");
    for (const suffix of ["script.json", "missing/nested/script.json"]) {
      await expect(
        buildAuthoringHandoff({
          state,
          lane: "script",
          outputPath: path.join(linkedRoot, suffix),
        }),
      ).rejects.toThrow(/symbolic link/);
    }
    const safeRoot = path.join(root, "worker");
    await fs.mkdir(safeRoot);
    const target = path.join(state.generated!.packageRoot, "SKILL.md");
    const original = await fs.readFile(target, "utf8");
    const outputPath = path.join(safeRoot, "script.json");
    await fs.symlink(target, outputPath);
    await expect(
      buildAuthoringHandoff({ state, lane: "script", outputPath }),
    ).rejects.toThrow(/symbolic link/);
    await fs.unlink(outputPath);
    const commonPath = path.join(safeRoot, ".script.json.common-input.json");
    await fs.symlink(target, commonPath);
    await expect(
      buildAuthoringHandoff({ state, lane: "script", outputPath }),
    ).rejects.toThrow(/symbolic link/);
    expect(await fs.readdir(safeRoot)).toEqual([
      ".script.json.common-input.json",
    ]);
    expect(await fs.readFile(target, "utf8")).toBe(original);
    await expect(
      fs.stat(path.join(state.generated!.packageRoot, "missing")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("shares a bounded hash-bound confirmed proposal across concurrent Wave 1 handoffs", async () => {
    const { state } = await createSession();
    const handoffs = await Promise.all(
      (["script", "reference", "pause-points"] as const).map((lane) =>
        buildAuthoringHandoff({
          state,
          lane,
          outputPath: path.join(root, "inputs", `${lane}.json`),
        }),
      ),
    );
    const identities = new Set<string>();
    for (const handoff of handoffs) {
      const descriptor = handoff.confirmedProposal;
      const bytes = await fs.readFile(descriptor.path);
      expect(bytes.length).toBeLessThanOrEqual(descriptor.limitBytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        descriptor.hash,
      );
      expect(JSON.parse(bytes.toString())).toEqual(state.confirmedProposal);
      const common = JSON.parse(
        await fs.readFile(handoff.commonInputPath, "utf8"),
      );
      expect(common.confirmedProposal).toEqual(descriptor);
      expect(handoff.inputPaths).toContain(descriptor.path);
      identities.add(descriptor.hash);
    }
    expect(identities.size).toBe(1);
    const descriptor = handoffs[0].confirmedProposal;
    const target = path.join(state.generated!.packageRoot, "SKILL.md");
    await fs.unlink(descriptor.path);
    await fs.symlink(target, descriptor.path);
    await expect(
      buildAuthoringHandoff({
        state,
        lane: "script",
        outputPath: handoffs[0].outputPath,
      }),
    ).rejects.toThrow(/symbolic link/);
    state.confirmedProposal!.planHash = "0".repeat(64);
    await expect(
      buildAuthoringHandoff({
        state,
        lane: "script",
        outputPath: path.join(root, "stale.json"),
      }),
    ).rejects.toThrow(/stale/);
  });

  it("dispatches a generated package with a large semantic dossier", async () => {
    const factoryPlan = await readPlan(planPath);
    const candidates = await findSkills({
      projectRoot: project,
      sources: factoryPlan.skillSources,
    });
    const { dossier } = questionnaireFixture();
    dossier.workflow.goal = factoryPlan.goal;
    dossier.sources[0] = {
      ...dossier.sources[0],
      location: factoryPlan.skillSources[0].location,
      contentHash: candidates[0].sources[0].hash,
    };
    const fact = dossier.sourceDerivedFacts[0];
    dossier.sourceDerivedFacts = Array.from({ length: 1_200 }, (_, index) => ({
      ...fact,
      id: `report-requirement-${index}`,
      statement: `Report requirement ${index}. ${"Keep the reviewed evidence with the report. ".repeat(20)}`,
    }));
    factoryPlan.semanticDossier = dossier;
    await fs.writeFile(planPath, JSON.stringify(factoryPlan));

    const { state } = await createSession();
    expect((await fs.stat(state.authoring!.planPath)).size).toBeGreaterThan(
      256 * 1024,
    );
    const handoff = await buildAuthoringHandoff({
      state,
      lane: "script",
      outputPath: path.join(root, "script.json"),
    });
    const proposal = await fs.readFile(handoff.confirmedProposal.path);
    expect(proposal.length).toBeGreaterThan(1024 * 1024);
    expect(proposal.length).toBeLessThanOrEqual(
      handoff.confirmedProposal.limitBytes,
    );
    expect(createHash("sha256").update(proposal).digest("hex")).toBe(
      handoff.confirmedProposal.hash,
    );
    expect(handoff.outputLimitBytes).toBe(256 * 1024);
  });

  it("rejects oversized confirmed proposals before creating handoff files", async () => {
    const { state } = await createSession();
    state.confirmedProposal!.warnings = [
      "x".repeat(AUTHORING_INPUT_LIMIT_BYTES),
    ];
    const outputRoot = path.join(root, "oversized");
    await expect(
      buildAuthoringHandoff({
        state,
        lane: "script",
        outputPath: path.join(outputRoot, "script.json"),
      }),
    ).rejects.toThrow(/proposal exceeds/);
    await expect(fs.stat(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

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

  it("accepts the lane output envelope and reports bounded evidence", async () => {
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
    const history = await localFindingHandoff(state, "script");
    expect(history).toContainEqual(
      expect.objectContaining({
        lane: "script",
        finding: expect.objectContaining({
          problem: "Fixture uses the bundled adapter.",
        }),
      }),
    );

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
      modifyGeneratedPackage: false,
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
      recordAuthoringFile({
        state,
        lane: "reference",
        file: outputPath,
        confirmed: true,
      }),
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
    expect(recovered.recovery.recoveryRequired).toBe(true);
    expect(recovered.recoveryError).toMatch(/JSON|summary/i);
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

  it("requires the exact deferred check before allowing package review", async () => {
    const { state } = await createSession();
    const completed = await runManualAuthoringFixture({ state });
    const original = (await authoringReadiness(completed)).records;
    const finding = {
      severity: "minor" as const,
      problem: "The assembled package needs its generated check.",
      fix: "Run the generated package check on the assembled package.",
      evaluationCheck: "assembled-package-check" as const,
    };
    await recordAuthoring({
      state: completed,
      lane: "script",
      record: {
        ...original.script!,
        status: "DONE_WITH_CONCERNS",
        findings: [finding],
        summary: finding.problem,
      },
    });
    const readiness = await authoringReadiness(completed);
    expect(readiness.completedLanes).toContain("script");
    expect(readiness.nextLanes).toContain("workflow-entry");
    for (const lane of [
      "workflow-entry",
      "skill-core",
      "skill-review",
    ] as const) {
      const record = original[lane]!;
      const artifacts = await Promise.all(
        record.artifacts.map(async ({ contentPath, ...artifact }) => ({
          ...artifact,
          ...(contentPath
            ? { content: await fs.readFile(contentPath, "utf8") }
            : {}),
        })),
      );
      await recordAuthoring({
        state: completed,
        lane,
        record: { ...record, artifacts },
      });
    }
    const assembled = await assemblePackage(completed);
    const report = await evaluatePackage(assembled, { persistState: false });
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^authoring-concern:script:/u),
        passed: true,
      }),
    );
    await fs.writeFile(
      assembled.eval!.resultPath,
      JSON.stringify({
        ...report,
        checks: report.checks.filter(
          ({ id }) => !id.startsWith("authoring-concern:"),
        ),
      }),
    );
    expect(
      reviewState(assembled, await authoringReadiness(assembled)).blockers,
    ).toContainEqual(
      expect.stringContaining("Evaluation is missing assembled-package-check"),
    );
  });

  it("exposes persisted session decisions and confirmation gates through one gateway", async () => {
    const { state, plan } = await createSession();
    const gateway = authoringSessionGateway();
    const missingSession = {
      ...structuredClone(state),
      projectRoot: path.join(root, "missing-project"),
      authoring: undefined,
      generated: undefined,
    };
    const missingDecision = await gateway.decide({
      state: missingSession,
      operation: "dispatch",
      lane: "script",
    });
    expect(missingDecision.allowed).toBe(false);
    expect(missingDecision.blockers).toContain(
      "Authoring session is missing; generate a confirmed scaffold",
    );
    const initial = await gateway.read(project, state.name);

    expect(initial.sessionId).toMatch(/^[a-f0-9]{64}$/u);
    expect(initial.workflow).toBe(state.name);
    expect(initial.semanticDossierHash).toBeUndefined();
    await expect(
      persistAuthoring({
        state,
        lane: "script",
        record: {
          status: "DONE",
          claims: claims(plan, "script"),
          artifacts: [],
        },
      }),
    ).rejects.toThrow(/confirmation/iu);
    await expect(assemblePackageImplementation(state)).rejects.toThrow(
      /confirmation/iu,
    );

    const dispatch = await gateway.decide({
      state,
      operation: "dispatch",
      lane: "script",
    });
    expect(dispatch.allowed).toBe(true);
    expect(dispatch.identity?.sessionId).toBe(initial.sessionId);
    expect(dispatch.revision).toBe(initial.revision);

    const gate = await gateway.writeGate({
      state,
      operation: "assemble",
      confirmed: false,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.confirmed).toBe(false);
    expect(gate.blockers).toContain(
      "Authoring assembly requires explicit confirmation",
    );

    const staleState = structuredClone(state);
    const record = await gateway.record({
      state,
      lane: "script",
      confirmed: true,
      record: {
        status: "DONE",
        claims: claims(plan, "script"),
        artifacts: [],
      },
    });
    const refreshed = await gateway.decide({
      state: staleState,
      operation: "dispatch",
      lane: "reference",
    });

    expect(record.revision).toBe(initial.revision + 1);
    expect(refreshed.revision).toBe(record.revision);
    expect(refreshed.identity?.authoringInputHash).toBe(
      initial.authoringInputHash,
    );
  });

  it("reports revision conflicts and stale lock ownership through the gateway", async () => {
    const { state, plan } = await createSession();
    const gateway = authoringSessionGateway();
    const initial = await gateway.read(project, state.name);
    const staleState = structuredClone(state);

    const first = await gateway.record({
      state,
      lane: "script",
      confirmed: true,
      record: {
        status: "DONE",
        claims: claims(plan, "script"),
        artifacts: [],
      },
    });
    const conflict = await gateway.decide({
      state: staleState,
      operation: "dispatch",
      lane: "reference",
      expectedRevision: initial.revision,
    });

    expect(conflict.allowed).toBe(false);
    expect(conflict.state).toBe("stale");
    expect(conflict.conflict).toMatchObject({
      lane: "reference",
      expectedRevision: initial.revision,
      actualRevision: first.revision,
    });
    expect(conflict.recovery.conflict).toEqual(conflict.conflict);

    await fs.writeFile(
      path.join(state.authoring!.sessionPath, ".lock"),
      JSON.stringify({ pid: 99999999, at: "1970-01-01T00:00:00.000Z" }),
    );
    await expect(gateway.lock(state)).resolves.toMatchObject({
      status: "stale",
      owner: { pid: 99999999 },
    });
  });

  it("invalidates a lane and its dependent records as one persisted transition", async () => {
    const { state } = await createSession();
    const completed = await runManualAuthoringFixture({ state });
    const gateway = authoringSessionGateway();

    const invalidation = await gateway.invalidate({
      state: completed,
      lanes: ["script"],
      expectedRevision: completed.authoring!.revision,
      reason: "The confirmed protocol changed.",
      confirmed: true,
    });

    expect(invalidation.lanes).toEqual([
      "script",
      "workflow-entry",
      "skill-core",
      "skill-review",
    ]);
    expect(invalidation.reason).toBe("The confirmed protocol changed.");
    expect(invalidation.revision).toBe(completed.authoring!.revision);
    expect(invalidation.identity?.sessionId).toBe(
      completed.authoring!.sessionId,
    );

    const readiness = await gateway.readiness(
      await readState(project, completed.name),
    );
    expect(readiness.recovery.invalidatedLanes).toEqual(invalidation.lanes);
    expect(readiness.nextLanes).toEqual(["script"]);
    expect(readiness.state).toBe("blocked");
  });

  it("reads generator contract v1 session summaries through the current gateway", async () => {
    const { state } = await createSession();
    const summaryPath = path.join(state.authoring!.sessionPath, "state.json");
    const summary = JSON.parse(
      await fs.readFile(summaryPath, "utf8"),
    ) as Record<string, unknown>;
    summary.generatorContractVersion = 1;
    delete summary.sessionId;
    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n");

    const gateway = authoringSessionGateway();
    const recovered = await gateway.readiness(
      await readState(project, state.name),
    );

    expect(recovered.recovery.recoveryRequired).toBeUndefined();
    expect(recovered.identity?.sessionId).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps accepted version 3 reports readable while requiring regeneration", async () => {
    const { state, plan } = await createSession();
    const finding = {
      severity: "minor" as const,
      problem: "The shared brief was missing from the handoff.",
    };
    const record = await recordAuthoring({
      state,
      lane: "script",
      record: {
        status: "DONE_WITH_CONCERNS",
        findings: [finding],
      },
    });
    const session = state.authoring!;
    const version3InputHash = hashAuthoringSessionInput(plan, 3);
    const {
      schemaVersion,
      kind,
      at,
      authoredMaterialHash: _currentMaterialHash,
      ...output
    } = record;
    const version3Output = {
      ...output,
      authoringInputHash: version3InputHash,
      review: null,
    };
    const version3MaterialHash = sha256(
      JSON.stringify(stableValue(version3Output)),
    );
    const summaryPath = path.join(session.sessionPath, "state.json");
    const summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
    summary.generatorContractVersion = 3;
    summary.authoringInputHash = version3InputHash;
    summary.records.script.authoringInputHash = version3InputHash;
    summary.records.script.authoredMaterialHash = version3MaterialHash;
    delete summary.sessionId;
    await fs.writeFile(summaryPath, JSON.stringify(summary));
    await fs.writeFile(
      path.join(session.recordsPath, "script.json"),
      JSON.stringify({
        schemaVersion,
        kind,
        at,
        ...version3Output,
        authoredMaterialHash: version3MaterialHash,
      }),
    );

    const gateway = authoringSessionGateway();
    const persisted = await readState(project, state.name);
    const readiness = await gateway.readiness(persisted);
    expect(readiness.recoveryError).toBeUndefined();
    expect(readiness.status).toBe("stale");
    expect(readiness.recovery.regenerationRequired).toBe(true);
    expect(readiness.blockers).toContainEqual(
      expect.stringContaining("regenerate the scaffold"),
    );
    expect(readiness.blockers).not.toContainEqual(
      expect.stringContaining("invalid authoring record script"),
    );
    expect(readiness.lanes.script).toMatchObject({
      status: "DONE_WITH_CONCERNS",
      executable: false,
      findings: [finding],
    });
    expect(readiness.completedLanes).toEqual([]);
    expect(readiness.nextLanes).toEqual([]);
    expect(
      await gateway.decide({
        state: persisted,
        operation: "dispatch",
        lane: "script",
      }),
    ).toMatchObject({ allowed: false });
    await expect(assemblePackage(persisted)).rejects.toThrow(
      /regenerate the scaffold/u,
    );
  });
});
