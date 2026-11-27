import path from "node:path";
import { promises as fs } from "node:fs";
import type { CreatorState } from "../types.js";
import type { AuthoringLaneId, AuthoringRecord } from "./types.js";
import { canonicalHash } from "../util.js";
import { atomicWriteContainedText } from "../engine/contained-atomic-write.js";
import {
  ensureProtectedProjectDirectory,
  inspectProtectedProjectPath,
  readProtectedProjectFile,
} from "../engine/protected-project-path.js";
import { findingSubjectKey } from "./findings.js";

function directory(state: CreatorState) {
  const lineage =
    state.generated?.findingLineage ??
    (!state.stateNamespace || state.stateNamespace === ".badger"
      ? state.name
      : null);
  return lineage
    ? ".badger/finding-history/" +
        canonicalHash({ lineage, workflow: state.name })
    : null;
}

export async function retainLocalFindingReport(
  state: CreatorState,
  record: AuthoringRecord,
) {
  const folder = directory(state);
  const findings = [
    ...(record.findings ?? []),
    ...(record.review?.findings ?? []),
  ];
  if (!folder || !findings.length) return;
  const report = {
    workflow: state.name,
    lane: record.lane,
    revision: record.revision,
    recordedAt: record.at,
    input: record.authoringInputHash,
    material: record.authoredMaterialHash,
    findings,
  };
  const file = canonicalHash(report) + ".json";
  const root = await ensureProtectedProjectDirectory(
    state.projectRoot,
    folder,
    { label: "Authoring finding history" },
  );
  const content = JSON.stringify(report);
  try {
    await atomicWriteContainedText(path.join(root, file), content, {
      containedRoot: state.projectRoot,
      exclusive: true,
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const saved = await readProtectedProjectFile(
      state.projectRoot,
      folder + "/" + file,
      1024 * 1024,
      { label: "Existing finding report" },
    );
    if (saved.bytes.toString("utf8") !== content)
      throw new Error(
        "Stored finding report differs from its recorded identity",
      );
  }
}

export async function localFindingHandoff(
  state: CreatorState,
  lane: AuthoringLaneId,
) {
  const folder = directory(state);
  if (!folder) return [];
  const inspected = await inspectProtectedProjectPath(
    state.projectRoot,
    folder,
    { label: "Authoring finding history", expected: "directory" },
  );
  if (!inspected.exists) return [];
  const history = [];
  for (const name of (await fs.readdir(inspected.target)).sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const { bytes } = await readProtectedProjectFile(
      state.projectRoot,
      folder + "/" + name,
      1024 * 1024,
      { label: "Authoring finding report" },
    );
    const report = JSON.parse(bytes.toString("utf8")) as {
      workflow: string;
      lane: AuthoringLaneId;
      recordedAt: string;
      input: string;
      findings: NonNullable<AuthoringRecord["findings"]>;
    };
    if (
      report.workflow !== state.name ||
      name !== canonicalHash(report) + ".json"
    )
      throw new Error("Authoring finding report identity changed");
    if (report.lane !== lane && lane !== "skill-review") continue;
    for (const [ordinal, finding] of report.findings.entries()) {
      history.push({
        id:
          finding.disposition?.findingId ??
          (finding.disposition
            ? findingSubjectKey(finding.disposition)
            : canonicalHash({ name, ordinal })),
        report: name,
        ordinal,
        lane: report.lane,
        recordedAt: report.recordedAt,
        input: report.input,
        finding,
      });
    }
  }
  return history;
}
