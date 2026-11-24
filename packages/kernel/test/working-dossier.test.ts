import { describe, expect, it } from "vitest";
import { composeSemanticDossier } from "../src/factory/dossier-composition.js";
import { validateSemanticDossier } from "../src/factory/questionnaire.js";
import {
  applyWorkingDossierEdit,
  emptyWorkingDossier,
  projectWorkingDossier,
  workingDossierEditFinding,
  WORKING_DOSSIER_FIELDS,
  type WorkingDossierContent,
  type WorkingDossierEdit,
} from "../src/factory/working-dossier.js";

const report = { skillId: "report", name: "report", hash: "a".repeat(64) };
const renderer = {
  skillId: "renderer",
  name: "renderer",
  hash: "b".repeat(64),
};
const evidence = {
  skillId: report.skillId,
  hash: report.hash,
  path: "SKILL.md",
  fileHash: "c".repeat(64),
  startLine: 4,
  endLine: 4,
};
const reportContent: WorkingDossierContent = {
  ...emptyWorkingDossier(),
  fields: {
    "node/write/responsibility": {
      state: "source",
      value: "Prepare a report.",
      evidence: [evidence],
    },
    "node/render/responsibility": {
      state: "decision",
      value: "Render the report.",
      reason: "Approved format.",
    },
    "interface/report-transfer/artifact": {
      state: "source",
      value: "report.txt",
      evidence: [evidence],
    },
  },
  nodes: {
    write: {
      kind: "node",
      order: 0,
      label: "Write",
      skillId: report.skillId,
      hash: report.hash,
    },
    render: {
      kind: "node",
      order: 1,
      label: "Render",
      skillId: renderer.skillId,
      hash: renderer.hash,
    },
  },
  interfaces: {
    "report-transfer": {
      producer: "write",
      consumer: "render",
      status: "documented",
      producerEvidence: [evidence],
      consumerEvidence: [
        { ...evidence, skillId: renderer.skillId, hash: renderer.hash },
      ],
    },
  },
};

describe("working dossier readiness", () => {
  it("shows a populated source field and the named gaps of a single pinned Skill", () => {
    const hash = "a".repeat(64);
    const study = projectWorkingDossier(
      {
        nodes: {},
        interfaces: {},
        fields: {
          "skill/report/inputs": {
            state: "source",
            value: "A report title",
            evidence: [
              {
                skillId: "report",
                hash,
                path: "SKILL.md",
                fileHash: "b".repeat(64),
                startLine: 4,
                endLine: 4,
              },
            ],
          },
          "skill/report/prerequisites": {
            state: "missing",
            reason: "Which renderer is installed?",
          },
        },
        findings: {},
      },
      [{ skillId: "report", name: "report", hash }],
      [],
    );
    expect(
      study.fields.find(({ id }) => id === "skill/report/inputs"),
    ).toMatchObject({
      topic: "inputs",
      content: { value: "A report title" },
      blocker: null,
    });
    expect(
      study.fields.find(({ id }) => id === "skill/report/prerequisites"),
    ).toMatchObject({
      topic: "prerequisites",
      blocker: "Which renderer is installed?",
    });
    expect(study.fields.some(({ scope }) => scope === "interface")).toBe(false);
  });

  it("flags a rebound occurrence and its handoff even while the former Skill remains pinned", () => {
    const content: WorkingDossierContent = {
      ...reportContent,
      nodes: {
        ...reportContent.nodes,
        write: {
          ...reportContent.nodes.write,
          skillId: renderer.skillId,
          hash: renderer.hash,
        },
      },
    };
    const { fields } = projectWorkingDossier(content, [report, renderer], []);
    for (const id of [
      "node/write/responsibility",
      "interface/report-transfer/artifact",
    ])
      expect(fields.find((field) => field.id === id)?.blocker).toContain(
        "changed",
      );
  });

  it("validates the same approved meaning after canonical serialization", () => {
    const pins = [report, renderer];
    const composition = composeSemanticDossier({
      workflowVersionId: "version-1",
      workflow: {
        name: "report",
        goal: "Create a report.",
        intent: "new-skill",
        defaultLocale: "en",
      },
      sources: pins.map((pin) => ({
        id: pin.skillId,
        name: pin.name,
        location: `skills/${pin.name}`,
        contentHash: pin.hash,
        roles: ["source"],
      })),
      records: { questions: [] },
      sourceEvidence: {},
      semantics: {},
      workingDossier: {
        revision: 1,
        pinsHash: "d".repeat(64),
        pins,
        content: reportContent,
        fields: WORKING_DOSSIER_FIELDS,
        scriptEffects: [],
      },
    });
    expect(composition.findings).toEqual([]);
    expect(
      validateSemanticDossier(JSON.parse(composition.canonicalJson).dossier),
    ).toEqual([]);
  });

  it("keeps a bounded control transition separate from artifact handoffs", () => {
    const edit: WorkingDossierEdit = {
      revision: 1,
      pinsHash: "d".repeat(64),
      editId: "routes",
      routes: {
        redo: {
          from: "render",
          to: "write",
          kind: "rework",
          condition: "Report exceeds the limit",
          maxVisits: 2,
        },
      },
    };
    const content = applyWorkingDossierEdit(reportContent, edit);
    expect(
      workingDossierEditFinding(content, edit, [report, renderer], []),
    ).toBeNull();
    expect(content.routes?.redo?.maxVisits).toBe(2);
    expect(content.interfaces).toEqual(reportContent.interfaces);
    const invalidEdit: WorkingDossierEdit = {
      ...edit,
      routes: { redo: { from: "render", to: "write", kind: "rework" } },
    };
    expect(
      workingDossierEditFinding(
        applyWorkingDossierEdit(content, invalidEdit),
        invalidEdit,
        [report, renderer],
        [],
      ),
    ).toContain("visit limit");
  });
});
