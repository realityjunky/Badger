import { randomUUID } from "node:crypto";
import type {
  RuntimeIdentity,
  RunState,
  WorkflowRuntimeState,
} from "../engine/types.js";
import type { DeterministicResolver } from "../engine/resolver.js";
import {
  resumeManualRun,
  resumeManualWorkflowRun,
  startManualRun,
  type ManualRunResult,
  type PreparePendingAction,
  type ResumeManualRunOptions,
} from "../engine/manual-run.js";
import { readRunState } from "../engine/state.js";
import {
  readStandaloneRunState,
  resumeStandaloneRun,
  resumeStandaloneWorkflowRun,
  startStandaloneRun,
  standaloneRunDir,
} from "../engine/standalone-run.js";
import type { SkillPackage } from "../skill-runtime/types.js";
import type { WorkflowArtifactMutation } from "../engine/runtime-types.js";
import type {
  StartWorkflowRunOptions,
  WorkflowRunLocation,
  WorkflowRunTarget,
} from "./types.js";

export interface ResolvedWorkflowRunLocation {
  readonly kind: WorkflowRunLocation["kind"];
  readonly runRoot: string;
  readonly runId?: string;
  start(
    pkg: SkillPackage,
    options: {
      runId: string;
      confirmations: Iterable<string>;
      runtimeIdentity: RuntimeIdentity;
      workflowRuntime?: WorkflowRuntimeState;
      resolver?: DeterministicResolver<undefined>;
      prepareAction?: PreparePendingAction;
    },
  ): Promise<ManualRunResult>;
  resume(
    options?: ResumeManualRunOptions,
    artifactMutation?: WorkflowArtifactMutation,
  ): Promise<ManualRunResult>;
  readState(): Promise<RunState | null>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function manualLocation(runRoot: string): ResolvedWorkflowRunLocation {
  const validatedRoot = requiredString(runRoot, "WorkflowRuntime Run root");
  return {
    kind: "manual",
    runRoot: validatedRoot,
    async start(pkg, options) {
      return startManualRun(pkg, validatedRoot, options);
    },
    async resume(options = {}, artifactMutation) {
      return artifactMutation
        ? resumeManualWorkflowRun(validatedRoot, options, artifactMutation)
        : resumeManualRun(validatedRoot, options);
    },
    async readState() {
      return readRunState(validatedRoot);
    },
  };
}

function standaloneLocation(
  projectRoot: string,
  runId: string,
): ResolvedWorkflowRunLocation {
  const validatedRunId = requiredString(
    runId,
    "WorkflowRuntime standalone Run id",
  );
  const validatedProjectRoot = requiredString(
    projectRoot,
    "WorkflowRuntime standalone project root",
  );
  const runRoot = standaloneRunDir(validatedProjectRoot, validatedRunId);
  return {
    kind: "standalone",
    runRoot,
    runId: validatedRunId,
    async start(pkg, options) {
      return startStandaloneRun(pkg, {
        projectRoot: validatedProjectRoot,
        runId: validatedRunId,
        confirmations: options.confirmations,
        runtimeIdentity: options.runtimeIdentity,
        workflowRuntime: options.workflowRuntime,
        resolver: options.resolver,
        prepareAction: options.prepareAction,
      });
    },
    async resume(options = {}, artifactMutation) {
      return artifactMutation
        ? resumeStandaloneWorkflowRun(
            validatedProjectRoot,
            validatedRunId,
            options,
            artifactMutation,
          )
        : resumeStandaloneRun(validatedProjectRoot, validatedRunId, options);
    },
    async readState() {
      return readStandaloneRunState(validatedProjectRoot, validatedRunId);
    },
  };
}

export function resolveWorkflowRunLocation(
  target: WorkflowRunTarget,
): ResolvedWorkflowRunLocation {
  if (typeof target === "string") return manualLocation(target);
  if (!target || typeof target !== "object") {
    throw new Error("WorkflowRuntime Run location must be an object");
  }
  if (target.kind === "manual") return manualLocation(target.runRoot);
  if (target.kind === "standalone") {
    return standaloneLocation(target.projectRoot, target.runId);
  }
  throw new Error("Unsupported WorkflowRuntime Run location");
}

export function resolveWorkflowStartLocation(
  options: StartWorkflowRunOptions,
): { location: ResolvedWorkflowRunLocation; runId: string } {
  if ("location" in options) {
    const location = resolveWorkflowRunLocation(options.location);
    if (location.kind === "standalone") {
      return { location, runId: location.runId! };
    }
    return {
      location,
      runId: ("runId" in options ? options.runId : undefined) ?? randomUUID(),
    };
  }
  return {
    location: manualLocation(options.runRoot),
    runId: options.runId ?? randomUUID(),
  };
}
