import { canonicalHash } from "../util.js";
import type {
  AuthoringEvaluationCheck,
  AuthoringReadiness,
  AuthoringRecordInput,
} from "./types.js";

type Outcome = Pick<AuthoringRecordInput, "status" | "findings" | "action">;

export function concernsDeferredToEvaluation(outcome: Outcome): boolean {
  return (
    outcome.status === "DONE_WITH_CONCERNS" &&
    !outcome.action &&
    !!outcome.findings?.length &&
    outcome.findings.every(
      (finding) => finding.severity === "minor" && finding.evaluationCheck,
    )
  );
}

export function authoringEvaluationObligations(
  records: AuthoringReadiness["records"],
): Array<{ id: string; check: AuthoringEvaluationCheck; detail: string }> {
  return Object.values(records).flatMap((record) =>
    (record.findings ?? []).flatMap((finding, index) =>
      finding.evaluationCheck
        ? [
            {
              id: `authoring-concern:${record.lane}:${canonicalHash({
                input: record.authoringInputHash,
                revision: record.revision,
                index,
                finding,
              })}`,
              check: finding.evaluationCheck,
              detail: finding.problem,
            },
          ]
        : [],
    ),
  );
}
