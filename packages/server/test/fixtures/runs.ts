import { assembledFixture } from "./evaluations.js";
import { admin, engineer, owner } from "./planning.js";
import type { TestService } from "../../src/testing/index.js";
export const operator = { subject: "operator", email: "operator@example.com" };
export const reviewer = { subject: "reviewer", email: "reviewer@example.com" };
export async function publishedFixture(
  service: TestService,
  configurePlan?: Parameters<typeof assembledFixture>[1],
) {
  const f = await assembledFixture(service, configurePlan);
  for (const [person, role] of [
    [operator, "Operator"],
    [reviewer, "Reviewer"],
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
