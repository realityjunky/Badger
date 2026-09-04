import { describe, expect, it } from "vitest";
import {
  AUTHORING_REVIEW_LENSES,
  composeAuthoringReview,
  hashAuthoringReviewVoterEvidence,
  validateAuthoringReviewResult,
  validateAuthoringReviewInput,
} from "../src/authoring/review.js";
import type {
  AuthoringPlan,
  AuthoringReviewFinding,
  AuthoringReviewOutput,
  AuthoringReviewVoterEvidence,
} from "../src/authoring/types.js";
import { reviewState } from "../src/publish/lifecycle.js";
import { approveReview } from "../src/publish/lifecycle.js";
import type { CreatorState } from "../src/types.js";

const HASH = "a".repeat(64);

function plan(depth: "quick" | "full"): AuthoringPlan {
  return {
    depth,
    verify: {
      voters: depth === "quick" ? 1 : 3,
      lenses: [...AUTHORING_REVIEW_LENSES],
      maxRounds: depth === "quick" ? 1 : 4,
      dryThreshold: 2,
      evidenceSource: depth === "quick" ? "llm-single" : "llm-multivote",
      loopUntilDry: true,
    },
  } as AuthoringPlan;
}

function voter(
  id: string,
  inputHash: string,
  findings: AuthoringReviewFinding[] = [],
): AuthoringReviewVoterEvidence {
  const evidence = {
    id,
    provider: "manual-provider",
    model: "review-model",
    inputHash,
    passed: findings.length === 0,
    findings,
  } satisfies Omit<AuthoringReviewVoterEvidence, "evidenceHash">;
  return {
    ...evidence,
    evidenceHash: hashAuthoringReviewVoterEvidence(evidence),
  };
}

function review(
  mode: "quick" | "full",
  inputHash: string,
  voterEvidence: AuthoringReviewVoterEvidence[],
): AuthoringReviewOutput {
  return {
    decision: "approved",
    reviewer: "authoring-reviewer",
    summary: "The authored package was reviewed.",
    blockingFindings: [],
    warnings: [],
    passed: true,
    mode,
    evidenceSource: mode === "quick" ? "llm-single" : "llm-multivote",
    voters: voterEvidence.length,
    lenses: [...AUTHORING_REVIEW_LENSES],
    rounds: 1,
    dryRounds: mode === "quick" ? 1 : 2,
    reviewedAt: "2026-09-04T00:00:00.000Z",
    inputHash,
    contractFit: "pass",
    usability: "pass",
    voterEvidence,
  };
}

function stateWithAuthoringReview(
  authoringReview: CreatorState["authoring"] extends infer Summary
    ? Summary extends { review?: infer Review }
      ? Review
      : never
    : never,
): CreatorState {
  return {
    schemaVersion: 1,
    name: "reviewable-workflow",
    status: "generated",
    projectRoot: "/tmp/reviewable-workflow",
    planPath: "/tmp/reviewable-workflow/plan.json",
    planHash: HASH,
    draftPath: "/tmp/reviewable-workflow/draft",
    currentHash: HASH,
    candidates: [],
    generated: {
      packageRoot: "/tmp/reviewable-workflow/draft",
      protocolPath:
        "/tmp/reviewable-workflow/draft/reference/workflow-protocol.json",
      evalPath: "/tmp/reviewable-workflow/draft/badger/eval.yaml",
    },
    authoring: {
      schemaVersion: 1,
      status: "assembled",
      sessionPath:
        "/tmp/reviewable-workflow/.badger/authoring/reviewable-workflow",
      planPath:
        "/tmp/reviewable-workflow/.badger/authoring/reviewable-workflow/plan.json",
      recordsPath:
        "/tmp/reviewable-workflow/.badger/authoring/reviewable-workflow/records",
      revision: 1,
      generatorContractVersion: 2,
      planHash: HASH,
      protocolHash: HASH,
      workflowProtocolHash: HASH,
      sourceEvidenceHash: HASH,
      authoringPlanHash: HASH,
      authoringInputHash: HASH,
      scaffoldHash: HASH,
      authoredMaterialHash: HASH,
      assembledPackageHash: HASH,
      records: {},
      review: authoringReview,
    },
  };
}

describe("authoring review", () => {
  it("requires quick review evidence to contain one bound voter", () => {
    const input = review("quick", HASH, [voter("voter-1", HASH)]);

    expect(validateAuthoringReviewInput(input, plan("quick"), HASH)).toEqual(
      [],
    );

    expect(
      validateAuthoringReviewInput(
        { ...input, voters: 2 },
        plan("quick"),
        HASH,
      ),
    ).toContain("quick authoring review must record exactly one voter");

    expect(
      validateAuthoringReviewInput(
        { ...input, voterEvidence: undefined },
        plan("quick"),
        HASH,
      ),
    ).toContain("quick authoring review must include one provider voter");
  });

  it("requires full review evidence to contain three independent voters", () => {
    const input = review("full", HASH, [
      voter("voter-1", HASH),
      voter("voter-2", HASH),
      voter("voter-3", HASH),
    ]);

    expect(validateAuthoringReviewInput(input, plan("full"), HASH)).toEqual([]);

    expect(
      validateAuthoringReviewInput(
        { ...input, voterEvidence: [voter("voter-1", HASH)] },
        plan("full"),
        HASH,
      ),
    ).toContain("full authoring review must record three independent voters");

    expect(
      validateAuthoringReviewInput(
        {
          ...input,
          voterEvidence: [
            voter("voter-1", HASH),
            voter("voter-2", HASH),
            voter("voter-3", "b".repeat(64)),
          ],
        },
        plan("full"),
        HASH,
      ),
    ).toContain("authoring review voterEvidence[2].inputHash is stale");
  });

  it("confirms provider findings by majority and keeps deterministic blockers", () => {
    const providerFinding: AuthoringReviewFinding = {
      severity: "important",
      lens: "contract-fit",
      source: "provider",
      path: "SKILL.md",
      problem: "The contract explanation omits the declared recovery boundary.",
      impact: "Users may treat authored guidance as runtime authority.",
      fix: "Explain the generated recovery boundary in the Decision Core.",
    };
    const input = review("full", HASH, [
      voter("voter-1", HASH, [providerFinding]),
      voter("voter-2", HASH, [providerFinding]),
      voter("voter-3", HASH),
    ]);
    const deterministicFinding: AuthoringReviewFinding = {
      severity: "critical",
      lens: "self-consistency",
      source: "deterministic",
      path: "scripts/badger-check.mjs",
      problem: "Generated package inventory does not match the package tree.",
      impact: "Package identity cannot be trusted.",
      fix: "Regenerate the package inventory from the assembled tree.",
    };

    const result = composeAuthoringReview({
      plan: plan("full"),
      input,
      deterministicFindings: [deterministicFinding],
      authoringInputHash: HASH,
      authoredMaterialHash: HASH,
      packageHash: HASH,
    });

    expect(result.contractFit).toBe("fail");
    expect(result.passed).toBe(false);
    expect(result.blockingFindings).toEqual(
      expect.arrayContaining([
        providerFinding.problem,
        deterministicFinding.problem,
      ]),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "provider" }),
        expect.objectContaining({ source: "deterministic" }),
      ]),
    );
  });

  it("keeps authoring review separate from runtime certification", () => {
    const authoringReview = composeAuthoringReview({
      plan: plan("quick"),
      input: review("quick", HASH, [voter("voter-1", HASH)]),
      deterministicFindings: [],
      authoringInputHash: HASH,
      authoredMaterialHash: HASH,
      packageHash: HASH,
    });
    expect(validateAuthoringReviewResult(authoringReview)).toEqual([]);
    expect(
      validateAuthoringReviewResult({
        ...authoringReview,
        summary: "Tampered after review.",
      }),
    ).toContain("authoring review evidence hash does not match contents");
    const state = stateWithAuthoringReview(authoringReview);
    const readiness = reviewState(state);

    expect(readiness.authoring.state).toBe("ready");
    expect(readiness.authoring.review).toMatchObject({
      packageHash: HASH,
      authoringInputHash: HASH,
    });
    expect(readiness.runtime.state).toBe("blocked");
    expect(readiness.state).toBe("blocked");
    expect(readiness.blockers).toEqual(
      expect.arrayContaining([
        "WorkflowRuntime certification evidence is missing",
      ]),
    );

    const withoutReview = stateWithAuthoringReview(undefined);
    const withoutReviewReadiness = reviewState(withoutReview);
    expect(withoutReviewReadiness.authoring.blockers).toContain(
      "Authoring review evidence is missing",
    );

    const stale = stateWithAuthoringReview(authoringReview);
    stale.authoring!.review!.packageHash = "b".repeat(64);
    expect(reviewState(stale).authoring.blockers).toContain(
      "Authoring review is stale for assembled package",
    );
  });

  it("requires a distinct publication reviewer", async () => {
    const authoringReview = composeAuthoringReview({
      plan: plan("quick"),
      input: review("quick", HASH, [voter("voter-1", HASH)]),
      deterministicFindings: [],
      authoringInputHash: HASH,
      authoredMaterialHash: HASH,
      packageHash: HASH,
    });

    await expect(
      approveReview({
        state: stateWithAuthoringReview(authoringReview),
        reviewer: authoringReview.reviewer,
        approve: true,
      }),
    ).rejects.toThrow(
      "Publication reviewer must differ from the authoring reviewer",
    );
  });
});
