import type { TestService } from "../../src/testing/index.js";
import { initializedFixture } from "./packages.js";
import { engineer } from "./planning.js";
import { reportLaneOutput } from "./authoring.js";

/** An assembled report package, reached entirely through confirmed HTTP actions. */
export async function assembledFixture(
  service: TestService,
  configurePlan?: Parameters<typeof initializedFixture>[1],
) {
  const fixture = await initializedFixture(service, configurePlan);
  const { call, base, approve } = fixture;
  const before = await call(`${base}/package`);
  const { confirmation } = await approve("generation");
  await call(
    `${base}/package/generate`,
    "POST",
    {
      confirmed: true,
      confirmationHash: confirmation.confirmationHash,
      stateHash: before.currentStateHash,
      requestId: "generate-evaluation",
    },
    engineer,
    202,
  );
  await service.worker().runOnce();
  const { secret } = await call(
    "/me/tokens",
    "POST",
    {
      name: "evaluation-authoring",
      scopes: ["engineer"],
    },
    engineer,
    201,
  );
  for (let wave = 0; wave < 3; wave++) {
    const { jobs } = await call(
      `${base}/package/authoring-jobs`,
      "POST",
      { confirmed: true },
      engineer,
      201,
    );
    for (const job of jobs) {
      const route = `${base}/drafting-jobs/${job.id}`;
      const claimed = await call(
        `${route}/claim`,
        "POST",
        { revision: job.revision },
        engineer,
        200,
        secret,
      );
      const laneOutput = reportLaneOutput(claimed.contextBundle);
      const { job: submitted } = await call(
        `${route}/submit`,
        "POST",
        {
          leaseId: claimed.job.lease.id,
          contextHash: claimed.job.contextHash,
          result: { laneOutput },
        },
        engineer,
        200,
        secret,
      );
      const decision = { revision: submitted.revision, laneOutput };
      const { preview } = await call(
        `${route}/accept-preview`,
        "POST",
        decision,
      );
      await call(`${route}/accept`, "POST", {
        ...decision,
        confirmed: true,
        confirmationHash: preview.confirmationHash,
        requestId: `accept-evaluation-${job.laneId}`,
      });
    }
  }
  const { preview } = await call(
    `${base}/package/assemble-preview`,
    "POST",
    {},
  );
  const assembled = await call(`${base}/package/assemble`, "POST", {
    confirmed: true,
    confirmationHash: preview.confirmationHash,
    requestId: "assemble-evaluation",
  });
  return { ...fixture, assembled, secret };
}
