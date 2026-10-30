import { engineer, owner, planningFixture } from "./planning.js";
import type { TestService } from "../../src/testing/index.js";

/** Reaches the initialized project using only the service's HTTP seam. */
export async function initializedFixture(service: TestService) {
  const fixture = await planningFixture(service);
  const { call, base, approve } = fixture;
  await approve("dossier", owner);
  const { skeleton: plan, dossierHash } = await call(`${base}/plan`);
  plan.workflow.customNodes[0].implementation.skill = "prepare";
  const { composition } = await call(`${base}/plan/preview`, "POST", {
    plan,
    dossierHash,
  });
  const { version: planVersion } = await call(
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
  const { confirmation } = await approve("proposal", owner);
  await call(
    `${base}/proposal/initialize`,
    "POST",
    {
      proposalHash: confirmation.boundHashes.proposal,
      confirmed: true,
      requestId: "initialize-package",
    },
    engineer,
    202,
  );
  await service.worker().runOnce();
  return { ...fixture, plan, planVersion };
}
