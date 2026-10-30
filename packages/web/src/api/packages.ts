import type { AuthoringPlan, GeneratedPackageFile } from "@realityjunky/badger";
import type { WorkflowJob } from "./workflows.js";

export interface PackageView {
  canGenerate: boolean;
  currentStateHash: string | null;
  package: {
    id: string;
    generationJobId: string;
    status: "current" | "invalidated";
    invalidationReason: string | null;
    planVersionHash: string;
    proposalHash: string;
    scaffoldHash: string;
    assembledHash: string | null;
    stateHash: string;
    files: GeneratedPackageFile[];
    authoringPlan: AuthoringPlan;
    generatedAt: string;
  } | null;
  jobs: WorkflowJob[];
}
