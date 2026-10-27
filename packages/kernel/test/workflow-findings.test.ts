import { describe, expect, it } from "vitest";
import {
  MAX_WORKFLOW_FINDINGS,
  MAX_WORKFLOW_FINDINGS_ENCODED_BYTES,
  boundWorkflowFindings,
  createWorkflowFinding,
  decisionRequiredFinding,
  evaluationWarningFinding,
  findingFromBlocker,
  parseWorkflowFindingSummary,
  parseWorkflowFinding,
} from "../src/workflow-runtime/findings.js";

describe("WorkflowRuntime structured findings", () => {
  it("orders findings deterministically and derives stable blocker messages", () => {
    const values = [
      findingFromBlocker("Missing guardrail evidence: guardrail:run.safe"),
      findingFromBlocker(
        "Route blocker: no matching success transition from Node start",
      ),
      findingFromBlocker("Missing Output Schema evidence: output.summary"),
    ];

    const bounded = boundWorkflowFindings(values.reverse());

    expect(bounded.findings.map((finding) => finding.code)).toEqual([
      "completion-missing-evidence",
      "completion-missing-guardrail",
      "route-no-match",
    ]);
    expect(
      bounded.findings.every((finding) => finding.catalogVersion === 1),
    ).toBe(true);
    expect(bounded.summary).toMatchObject({
      total: 3,
      returned: 3,
      omitted: 0,
      truncated: false,
    });
    expect(bounded.summary.omittedByCode).toEqual({});
  });

  it("redacts secrets and unsafe paths while keeping bounded operation arguments", () => {
    const finding = createWorkflowFinding({
      code: "state-invalid",
      severity: "error",
      message:
        "token=super-secret password:another-secret failed at /home/hugo/project/state.json",
      path: "../state.json",
      requiredAction: "stop",
    });

    expect(finding.message).not.toContain("super-secret");
    expect(finding.message).not.toContain("another-secret");
    expect(finding.message).not.toContain("/home/hugo");
    expect(finding.path).toBeUndefined();

    const operationFinding = createWorkflowFinding({
      code: "action-available",
      severity: "info",
      message: "An action is available.",
      requiredAction: "execute",
      operation: {
        id: "workflow.resume",
        args: ["token=secret", "/home/hugo/private.txt"],
      },
    });
    expect(operationFinding.operation?.args).toEqual([
      "token=[REDACTED]",
      "[PATH]",
    ]);

    const safe = createWorkflowFinding({
      code: "state-invalid",
      severity: "error",
      message: "The report is invalid.",
      path: "reports/result.json",
      requiredAction: "stop",
    });
    expect(safe.path).toBe("reports/result.json");
  });

  it("summarizes omitted severity and decision requirements when bounded", () => {
    const values = [
      ...Array.from({ length: MAX_WORKFLOW_FINDINGS + 4 }, (_, index) =>
        findingFromBlocker(`Missing Output Schema evidence: output.${index}`),
      ),
      decisionRequiredFinding("decision-action"),
    ];

    const bounded = boundWorkflowFindings(values);

    expect(bounded.findings).toHaveLength(MAX_WORKFLOW_FINDINGS);
    expect(bounded.summary).toMatchObject({
      total: MAX_WORKFLOW_FINDINGS + 5,
      returned: MAX_WORKFLOW_FINDINGS,
      omitted: 5,
      omittedBySeverity: { info: 1, warning: 0, error: 4 },
      omittedRequiresUserDecision: 1,
      truncated: true,
    });
    expect(bounded.summary.omittedByCode).toEqual({
      "completion-missing-evidence": 4,
      "decision-required": 1,
    });
    expect(bounded.summary.encodedBytes).toBeLessThanOrEqual(
      MAX_WORKFLOW_FINDINGS_ENCODED_BYTES,
    );
  });

  it("rejects unknown catalog versions and unregistered operations", () => {
    expect(() =>
      parseWorkflowFinding({
        catalogVersion: 99,
      }),
    ).toThrow("Unknown Workflow finding catalog version: 99");

    expect(() =>
      createWorkflowFinding({
        code: "state-invalid",
        severity: "error",
        message: "Invalid state.",
        requiredAction: "repair",
        operation: { id: "shell.exec" as never, args: ["rm", "-rf"] },
      }),
    ).toThrow("Unknown Workflow finding operation: shell.exec");
  });

  it("keeps non-blocking terminal evaluation warnings machine-readable", () => {
    const warning = evaluationWarningFinding(
      "final-check",
      "state.value = unexpected",
    );
    const bounded = boundWorkflowFindings([warning]);

    expect(bounded.findings).toEqual([
      expect.objectContaining({
        code: "evaluation-warning",
        severity: "warning",
        requiredAction: "none",
        requiresUserDecision: false,
      }),
    ]);
  });

  it("rejects inconsistent finding summaries", () => {
    const summary = boundWorkflowFindings([
      findingFromBlocker("Missing Output Schema evidence: output.summary"),
    ]).summary;

    expect(() =>
      parseWorkflowFindingSummary({
        ...summary,
        maxEncodedBytes: 1,
      }),
    ).toThrow("Workflow finding summary counts are inconsistent");
    expect(() =>
      parseWorkflowFindingSummary({
        ...summary,
        returned: 0,
      }),
    ).toThrow("Workflow finding summary counts are inconsistent");
  });

  it.each([
    [
      "Missing Output Schema artifacts: report.result",
      "completion-missing-artifact",
    ],
    [
      "Missing required Skill evidence: required-skill:prepare.check",
      "completion-missing-required-skill",
    ],
    [
      "Route blocker: invalid routing value for mode: unknown",
      "route-invalid-value",
    ],
    [
      "Workflow artifact version is unknown: version-1",
      "artifact-unknown-version",
    ],
    ["Retry budget exhausted for action: action-1", "retry-budget-exhausted"],
    [
      "WorkflowRuntime snapshot identity does not match Run state",
      "identity-invalid",
    ],
    [
      "WorkflowRuntime pending action does not match Run state",
      "pending-action-invalid",
    ],
  ] as const)("maps %s to %s", (message, code) => {
    expect(findingFromBlocker(message).code).toBe(code);
  });
});
