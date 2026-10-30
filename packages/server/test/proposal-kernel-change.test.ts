import { afterEach, expect, it, vi } from "vitest";
import type { TestService } from "../src/testing/index.js";
import {
  admin,
  engineer,
  owner,
  planningFixture,
  startPlanningService,
} from "./fixtures/planning.js";

// A kernel release can change a proposal's shape, and so its hash, while the
// plan, dossier, and pins stay the same and no service write happens. Nothing
// at the HTTP seam changes the kernel, so this file wraps its proposal builder
// to stand in for that release.
const kernel = vi.hoisted(() => ({ release: 0 }));
vi.mock("@realityjunky/badger", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@realityjunky/badger")>();
  return {
    ...original,
    buildProposal: async (
      ...input: Parameters<typeof original.buildProposal>
    ) => {
      const proposal = await original.buildProposal(...input);
      return kernel.release === 0
        ? proposal
        : {
            ...proposal,
            proposalHash: original.canonicalHash({
              proposal: proposal.proposalHash,
              release: kernel.release,
            }),
          };
    },
  };
});

let service: TestService;
afterEach(async () => {
  kernel.release = 0;
  await service?.close();
});

it("supersedes a proposal approval whose hash a kernel change replaced, so the owner can approve the current proposal", async () => {
  service = await startPlanningService();
  const { call, base, approve } = await planningFixture(service);
  await approve("dossier", owner);
  const { skeleton: plan, dossierHash } = await call(`${base}/plan`);
  plan.workflow.customNodes[0].implementation.skill = "prepare";
  const { composition } = await call(`${base}/plan/preview`, "POST", {
    plan,
    dossierHash,
  });
  await call(
    `${base}/plan/save`,
    "POST",
    {
      plan,
      dossierHash,
      confirmationHash: composition.hash,
      expectedVersionId: null,
    },
    engineer,
    201,
  );
  await approve("plan", owner);
  const first = await approve("proposal", owner);
  const { job: queued } = await call(
    `${base}/proposal/initialize`,
    "POST",
    {
      proposalHash: first.confirmation.boundHashes.proposal,
      confirmed: true,
      requestId: "before-release",
    },
    engineer,
    202,
  );

  kernel.release = 1;
  const { proposal } = await call(`${base}/proposal`);
  expect(proposal.blockers).toEqual([]);
  expect(proposal.proposalHash).not.toBe(
    first.confirmation.boundHashes.proposal,
  );
  const initialize = {
    proposalHash: proposal.proposalHash,
    confirmed: true,
    requestId: "after-release",
  };
  await call(`${base}/proposal/initialize`, "POST", initialize, engineer, 409);
  const second = await approve("proposal", owner);
  expect(second.confirmation.boundHashes.proposal).toBe(proposal.proposalHash);
  const superseded = (await call(`${base}/gates/proposal`)).confirmations.find(
    (c: { id: string }) => c.id === first.confirmation.id,
  );
  expect(superseded).toMatchObject({
    invalidationReason: expect.stringContaining("kernel"),
    supersededBy: second.confirmation.id,
  });
  expect(superseded.invalidatedAt).not.toBeNull();
  for (const as of [owner, engineer])
    expect(
      (await call("/me/inbox", "GET", undefined, as)).items,
    ).toContainEqual(
      expect.objectContaining({ gate: "proposal", kind: "gate-invalidated" }),
    );
  const { events } = await call(
    "/audit-events?action=gate.invalidated",
    "GET",
    undefined,
    admin,
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      targetId: first.confirmation.id,
      reason: superseded.invalidationReason,
    }),
  );
  const { jobs } = await call(`${base}/proposal`);
  expect(jobs.find((job: { id: string }) => job.id === queued.id).status).toBe(
    "cancelled",
  );
  await call(`${base}/proposal/initialize`, "POST", initialize, engineer, 202);
});
