import { promises as fs } from "node:fs";
import path from "node:path";
import { buildProposal } from "../factory/proposal.js";
import { generatePackage } from "../factory/generate.js";
import { initializeState, writeState } from "../factory/state.js";
import { reviewState } from "../publish/lifecycle.js";
import type { CreatorState } from "../types.js";
import { fixturePlanForStandalone } from "./fixture.js";
import {
  canonicalizeCandidates,
  inventoryDirectory,
  observationParts,
} from "./observe.js";
import type {
  DifferentialFixture,
  DifferentialObservation,
  ReadinessObservation,
} from "./types.js";

export async function observeStandalone(options: {
  fixture: DifferentialFixture;
  projectRoot: string;
  homeDir: string;
}): Promise<DifferentialObservation> {
  const projectRoot = path.resolve(options.projectRoot);
  const planPath = path.join(projectRoot, "differential-plan.json");
  const plan = fixturePlanForStandalone(options.fixture);
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(planPath, JSON.stringify(plan, null, 2) + "\n", "utf8");

  const proposal = await buildProposal({
    projectRoot,
    planPath,
    homeDir: options.homeDir,
  });
  let generatedRoot = path.join(
    projectRoot,
    ".comet-any",
    "drafts",
    plan.workflow.name,
  );
  let readiness: ReadinessObservation;

  if (proposal.canInitialize) {
    const initial = await initializeState({
      projectRoot,
      planPath,
      plan,
      proposal,
      confirmed: true,
    });
    const generated = await generatePackage({
      proposal,
      plan,
      destination: initial.draftPath,
    });
    const state: CreatorState = {
      ...initial,
      status: "generated",
      generated,
      currentHash: null,
      eval: undefined,
      review: undefined,
    };
    await writeState(state);
    generatedRoot = generated.packageRoot;
    const review = reviewState(state);
    readiness = {
      state: review.state,
      blockers: review.blockers,
      warnings: [],
      evidence: review.evidence,
    };
  } else {
    readiness = {
      state: "blocked",
      blockers: proposal.blockers,
      warnings: proposal.warnings,
      evidence: {},
    };
  }

  return observationParts(
    canonicalizeCandidates(proposal.candidates),
    proposal.workflow,
    await inventoryDirectory(generatedRoot, true),
    readiness,
  );
}
