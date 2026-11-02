import { assembledFixture } from "./evaluations.js";
import { admin, engineer, owner } from "./planning.js";
import type { TestService } from "../../src/testing/index.js";
export const operator = { subject: "operator", email: "operator@example.com" };
export const reviewer = { subject: "reviewer", email: "reviewer@example.com" };
export function decisionPlan(plan: any, authority = "operator") {
  const node = plan.workflow.customNodes[0];
  node.kind = "decision";
  node.outputSchemas = [];
  node.decision = {
    id: "release-report",
    question: "May this report be released?",
    choices: [{ id: "release", label: "Release report", to: null }],
    inputs: {
      type: "object",
      fields: [{ id: "ticket", type: "string", required: true }],
    },
    rationale: { required: true },
    reviewer: { authorities: [authority] },
  };
}
export function durableGatePlan(plan: any) {
  plan.workflow.capabilities = {
    version: 3,
    features: ["conditional-routing", "revisioned-attempts"],
    durability: {
      version: 1,
      capabilities: [
        "mutation-locks",
        "revision-fences",
        "transition-journal",
        "repair-policy",
        "transactional-finalization",
      ],
      bounds: {
        runStateBytes: 256 * 1024,
        pendingActionBytes: 256 * 1024,
        trajectoryBytes: 8 * 1024 * 1024,
        artifactsBytes: 1024 * 1024,
        claimBytes: 16 * 1024,
        transitionJournalBytes: 1024 * 1024,
        runLockBytes: 16 * 1024,
        repairHistoryBytes: 256 * 1024,
        repairHistoryCount: 32,
        finalizationPlanBytes: 256 * 1024,
        finalizationTransactionBytes: 1024 * 1024,
        finalizationReceiptBytes: 256 * 1024,
        finalizationContentBytes: 256,
        finalizationOperationCount: 16,
        finalizationEventCount: 64,
      },
      schemaVersions: {
        runState: 1,
        pendingAction: 1,
        trajectory: 1,
        artifacts: 1,
        revisionClaim: 1,
        transitionJournal: 1,
        runLock: 1,
        repairEpisode: 1,
        finalizationTransaction: 1,
        finalizationReceipt: 1,
      },
      findingCatalogVersion: 1,
      repairPolicy: {
        maxFailures: 4,
        warningThreshold: 1,
        manualStopThreshold: 2,
        allowedChoices: [
          {
            id: "retry-with-new-approach",
            label: "Retry with a new approach",
            outcome: "retry",
          },
          { id: "stop", label: "Stop", outcome: "stop" },
        ],
        allowOneTimeOverride: true,
        maxOverrideRationaleBytes: 256,
        reviewer: { authorities: ["operator"] },
        rationale: { required: true },
      },
    },
  };
  plan.workflow.finalization = {
    schemaVersion: 1,
    roots: [{ id: "project", path: "." }],
    operations: [
      {
        id: "write-result",
        kind: "write",
        root: "project",
        target: "released.txt",
        content: "released\n",
      },
    ],
    confirmation: {
      required: true,
      reviewer: { authorities: ["workflow-owner", "operator"] },
      rationale: { required: true },
    },
  };
  const durability = plan.workflow.capabilities.durability;
  durability.repair = durability.repairPolicy;
  delete durability.repairPolicy;
}
export async function publishedFixture(
  service: TestService,
  configurePlan?: Parameters<typeof assembledFixture>[1],
) {
  const f = await assembledFixture(service, configurePlan);
  for (const [person, role] of [
    [operator, "Operator"],
    [reviewer, "Workflow owner"],
  ] as const)
    await f.call(
      "/bindings",
      "POST",
      {
        scopeType: "workflow",
        scopeId: f.workflow.id,
        email: person.email,
        role,
      },
      admin,
      201,
    );
  await f.call(
    `${f.base}/evaluations`,
    "POST",
    {
      confirmed: true,
      packageHash: f.assembled.packageHash,
      requestId: "runs-evaluate",
    },
    engineer,
    202,
  );
  await service.worker().runOnce();
  const evaluation = await f.call(`${f.base}/evaluations`);
  if (!evaluation.reports[0]?.report.passed)
    throw new Error(JSON.stringify(evaluation.reports));
  for (const [action, person] of [
    ["approve", reviewer],
    ["publish", owner],
  ] as const) {
    const { preview } = await f.call(
      `${f.base}/review/${action}-preview`,
      "POST",
      {},
      person,
    );
    await f.call(
      `${f.base}/review/${action}`,
      "POST",
      {
        confirmed: true,
        confirmationHash: preview.confirmationHash,
        requestId: `runs-${action}`,
      },
      person,
    );
  }
  const { publications } = await f.call(
    `/workflows/${f.workflow.id}/publications`,
    "GET",
    undefined,
    operator,
  );
  const { secret: operatorToken } = await f.call(
    "/me/tokens",
    "POST",
    { name: "Run operator", scopes: ["operator"] },
    operator,
    201,
  );
  return { ...f, publication: publications[0], operatorToken };
}
export function receiptPlan(plan: any) {
  plan.workflow.customNodes[0].outputSchemas = ["report.v1"];
  plan.workflow.outputSchemas = [
    {
      id: "report.v1",
      description: "Report output.",
      externalRoots: {
        outputs: { description: "The shared folder for analysis results." },
      },
      artifacts: [
        {
          id: "result",
          kind: "file",
          required: true,
          paths: ["result.bin"],
          validations: ["artifact-exists"],
          verification: "receipt",
          root: "outputs",
          requireCurrentAttempt: true,
        },
      ],
      evidence: [{ id: "summary", required: true }],
    },
  ];
}
