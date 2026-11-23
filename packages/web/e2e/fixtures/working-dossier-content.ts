import type {
  DossierEvidence,
  DossierFieldValue,
  WorkingDossierContent,
} from "@realityjunky/badger";
import {
  cite,
  type SourceFixture,
  type UploadedSource,
} from "./working-dossier-session.js";

export const rolesGap = "Who may authorize continued work?";
function sourceValue(
  value: string,
  ...evidence: DossierEvidence[]
): DossierFieldValue {
  return { state: "source", value, evidence };
}

function recordOccurrence(
  content: WorkingDossierContent,
  source: UploadedSource,
  id: string,
  order: number,
  label: string,
  fields: Record<string, DossierFieldValue>,
) {
  const { skillId, hash } = source;
  content.nodes[id] = { label, order, kind: "node", skillId, hash };
  for (const [field, value] of Object.entries(fields)) {
    content.fields[`node/${id}/${field}`] = value;
    if (field !== "trigger" && field !== "nextDecision")
      content.fields[`skill/${skillId}/${field}`] ??= value;
  }
}

function handoff(
  content: WorkingDossierContent,
  producer: string,
  consumer: string,
  artifact: string,
  shape: string,
  producerEvidence: DossierEvidence,
  consumerEvidence?: DossierEvidence,
) {
  const id = `${producer}-to-${consumer}`;
  content.interfaces[id] = {
    producer,
    consumer,
    status: consumerEvidence ? "documented" : "proposed",
    producerEvidence: [producerEvidence],
    consumerEvidence: consumerEvidence ? [consumerEvidence] : [],
  };
  const state = (value: string): DossierFieldValue =>
    consumerEvidence
      ? sourceValue(value, producerEvidence, consumerEvidence)
      : {
          state: "proposed",
          value,
          evidence: [producerEvidence],
          reason: "The consumer contract does not identify this input.",
        };
  content.fields[`interface/${id}/artifact`] = state(artifact);
  content.fields[`interface/${id}/shape`] = state(shape);
}

function workingContent(scope: DossierFieldValue): WorkingDossierContent {
  return {
    fields: {
      "workflow/workflow/scope": scope,
      "workflow/workflow/roles": { state: "missing", reason: rolesGap },
    },
    nodes: {},
    interfaces: {},
    findings: {},
  };
}

export function textSkill(
  name: string,
  use: string,
  input: string,
  output: string,
): SourceFixture {
  return {
    name,
    files: new Map([
      [
        "SKILL.md",
        Buffer.from(
          `---\nname: ${name}\ndescription: ${use}\n---\n\n${use}\n\nRead references/contract.md.\n`,
        ),
      ],
      [
        "references/contract.md",
        Buffer.from(`# Contract\n\nInput ${input}\nOutput ${output}\n`),
      ],
    ]),
  };
}

export function textContent(sources: UploadedSource[]) {
  const [first, second] = sources;
  const scope = cite(first!, "SKILL.md", "description:");
  const content = workingContent(
    sourceValue(
      second
        ? "Prepare and render a calendar notice."
        : "Calculate a checksum for a note.",
      scope,
    ),
  );
  for (const [order, source] of sources.entries()) {
    const contract = "references/contract.md";
    const lines = source.files.get(contract)!.toString("utf8").split("\n");
    recordOccurrence(content, source, source.name, order, source.name, {
      responsibility: sourceValue(
        source.description,
        cite(source, "SKILL.md", "description:"),
      ),
      inputs: sourceValue(lines[2]!, cite(source, contract, "Input ")),
      outputSchemas: sourceValue(lines[3]!, cite(source, contract, "Output ")),
      trigger: sourceValue(lines[2]!, cite(source, contract, "Input ")),
    });
  }
  if (first && second) {
    content.routes = {
      "prepare-to-render": { from: first.name, to: second.name, kind: "next" },
    };
    handoff(
      content,
      first.name,
      second.name,
      "dates.json",
      "JSON array of ISO calendar dates.",
      cite(first, "references/contract.md", "Output dates.json"),
      cite(second, "references/contract.md", "Input dates.json"),
    );
  }
  return content;
}
