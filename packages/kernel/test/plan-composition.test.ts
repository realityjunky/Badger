import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { composeFactoryPlan, deriveFactoryPlan } from "../src/index.js";
import { questionnaireFixture } from "./fixtures/semantic-dossier.js";

it("derives the plan frame, ordered Node identities, and exact source declarations from the approved meaning", () => {
  const { dossier } = questionnaireFixture();
  dossier.nodes.unshift({
    id: "inspect",
    order: 1,
    responsibility: {
      summary: "Inspect the report.",
      factIds: ["owner-scope"],
    },
  });
  const plan = deriveFactoryPlan({
    workflowVersionId: "workflow-version",
    dossierHash: "a".repeat(64),
    dossier,
    skillSources: [{ name: "prepare", location: "skills/prepare" }],
  });
  expect(plan).toMatchObject({
    schemaVersion: 1,
    goal: "Prepare a reviewed report.",
    skillCreatorIntent: "new-skill",
    defaultLocale: "en",
    workflow: {
      kind: "workflow-kernel",
      name: "prepared-workflow",
      goal: "Prepare a reviewed report.",
    },
    skillSources: [{ name: "prepare", location: "skills/prepare" }],
    semanticDossier: dossier,
  });
  expect(plan.workflow.customNodes.map((node) => node.id)).toEqual([
    "prepare",
    "inspect",
  ]);
  expect(plan.workflow.customNodes[0]!.implementation.skill).toBe("");
  plan.semanticDossier!.workflow.name = "changed-by-reader";
  expect(dossier.workflow.name).toBe("prepared-workflow");
});

it("returns findings for malformed source edits instead of throwing during live validation", () => {
  const { dossier, factoryPlan } = questionnaireFixture();
  const input = {
    workflowVersionId: "version",
    dossierHash: "b".repeat(64),
    dossier,
    skillSources: factoryPlan.skillSources,
  };
  const result = composeFactoryPlan(input, {
    ...factoryPlan,
    semanticDossier: dossier,
    skillSources: [null, { name: 12 }],
  });
  expect(result.findings.length).toBeGreaterThan(0);
});

it("refuses additional disabled Nodes outside the approved dossier", () => {
  const { dossier, factoryPlan } = questionnaireFixture();
  const plan = { ...factoryPlan, semanticDossier: dossier };
  plan.workflow.customNodes.push({
    ...structuredClone(plan.workflow.customNodes[0]!),
    id: "unapproved",
    disabled: true,
  });
  const input = {
    workflowVersionId: "version",
    dossierHash: "b".repeat(64),
    dossier,
    skillSources: factoryPlan.skillSources,
  };
  expect(composeFactoryPlan(input, plan).findings).toContainEqual(
    expect.objectContaining({ path: "workflow.customNodes" }),
  );
});

it("derives and protects the upgrade root from the dossier's identified source", () => {
  const { dossier, factoryPlan } = questionnaireFixture();
  dossier.workflow.intent = "upgrade-existing";
  dossier.upgradeSource = {
    sourceId: "prepare-source",
    recovery: "Preserve the original source before replacement.",
  };
  const input = {
    workflowVersionId: "version",
    dossierHash: "b".repeat(64),
    dossier,
    skillSources: factoryPlan.skillSources,
  };
  const plan = deriveFactoryPlan(input);
  expect(plan.sourceRoot).toBe("skills/prepare");
  plan.workflow.customNodes[0]!.implementation.skill = "prepare";
  expect(composeFactoryPlan(input, plan).findings).toEqual([]);
  expect(
    composeFactoryPlan(input, { ...plan, sourceRoot: "skills/another" })
      .findings,
  ).toContainEqual(expect.objectContaining({ path: "sourceRoot" }));
});

it("refuses changed dossier content, pinned script declarations, and incomplete implementation choices", () => {
  const { dossier, factoryPlan } = questionnaireFixture();
  const input = {
    workflowVersionId: "workflow-version",
    dossierHash: "b".repeat(64),
    dossier,
    skillSources: factoryPlan.skillSources,
  };
  const changedDossier = structuredClone(dossier);
  changedDossier.topics.inputs.summary = "A different input contract.";
  expect(
    composeFactoryPlan(input, {
      ...factoryPlan,
      semanticDossier: changedDossier,
    }).findings,
  ).toContainEqual(expect.objectContaining({ path: "semanticDossier" }));
  expect(
    composeFactoryPlan(input, {
      ...factoryPlan,
      semanticDossier: dossier,
      skillSources: [
        { ...factoryPlan.skillSources[0], scripts: { "run.sh": "network" } },
      ],
    }).findings,
  ).toContainEqual(expect.objectContaining({ path: "skillSources" }));
  expect(
    composeFactoryPlan(input, deriveFactoryPlan(input)).findings,
  ).toContainEqual(
    expect.objectContaining({
      path: "workflow.customNodes.prepare.implementation",
    }),
  );
});

it("composes a canonical plan version that binds the dossier hash without depending on JSON key order", () => {
  const { dossier, factoryPlan } = questionnaireFixture();
  const input = {
    workflowVersionId: "workflow-version",
    dossierHash: "b".repeat(64),
    dossier,
    skillSources: factoryPlan.skillSources,
  };
  const plan = { ...factoryPlan, semanticDossier: dossier };
  const composition = composeFactoryPlan(input, plan);
  expect(composition.findings).toEqual([]);
  expect(composition.snapshot).toMatchObject({
    kind: "badger-plan-version",
    workflowVersionId: "workflow-version",
    dossierHash: "b".repeat(64),
    plan,
  });
  expect(composition.hash).toBe(
    createHash("sha256").update(composition.canonicalJson).digest("hex"),
  );
  const reordered = Object.fromEntries(Object.entries(plan).reverse());
  expect(composeFactoryPlan(input, reordered).hash).toBe(composition.hash);
});
