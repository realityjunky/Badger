import type { GateConfirmation, WorkflowJob } from "./workflows.js";

export interface Proposal {
  name: string;
  goal: string;
  intent: "new-skill" | "upgrade-existing";
  planHash: string;
  proposalHash: string;
  canInitialize: boolean;
  blockers: string[];
  warnings: string[];
  sources: {
    id: string;
    name: string;
    location: string;
    status: string;
    hash: string | null;
    blockers: string[];
  }[];
}
export interface ProposalView {
  proposal: Proposal | null;
  planVersionHash: string | null;
  confirmation: GateConfirmation | null;
  currentState: {
    hash: string;
    proposalHash: string;
    planVersionHash: string;
    revision: number;
    initializedAt: string;
  } | null;
  jobs: WorkflowJob[];
}
