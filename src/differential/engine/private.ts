import {
  evaluateManualRun,
  resumeManualRun,
  startManualRun,
  type ManualRunEvaluation,
  type ManualRunResult,
  type ResumeManualRunOptions,
} from "../../engine/manual-run.js";
import {
  evaluateStandaloneRun,
  resumeStandaloneRun,
  startStandaloneRun,
} from "../../engine/standalone-run.js";
import { loadSkillPackage } from "../../skill-runtime/load.js";
import type { EngineCommandRunner } from "./types.js";

type RunTarget =
  | { kind: "manual"; changeDir: string }
  | { kind: "standalone"; projectRoot: string; runId: string };

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function requiredOption(args: string[], name: string): string {
  const value = optionValue(args, name);
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function repeatedOption(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (!value) throw new Error(`${name} requires a value`);
    values.push(value);
    index += 1;
  }
  return values;
}

function parsePairs(args: string[], name: string): Record<string, string> {
  return Object.fromEntries(
    repeatedOption(args, name).map((value) => {
      const separator = value.indexOf("=");
      if (separator <= 0 || separator === value.length - 1) {
        throw new Error(`${name} must use key=value: ${value}`);
      }
      return [value.slice(0, separator), value.slice(separator + 1)];
    }),
  );
}

function targetFromArgs(args: string[], options: { cwd: string }): RunTarget {
  const runId = optionValue(args, "--run-id");
  const changeDir = optionValue(args, "--change");
  if (Boolean(runId) === Boolean(changeDir)) {
    throw new Error("Pass exactly one of --change or --run-id");
  }
  if (runId) {
    return {
      kind: "standalone",
      projectRoot: optionValue(args, "--project") ?? options.cwd,
      runId,
    };
  }
  return { kind: "manual", changeDir: changeDir! };
}

function resultWithChecks(
  result: ManualRunResult | ManualRunEvaluation,
): Record<string, unknown> {
  const { evals, ...rest } = result;
  return {
    ...rest,
    checks: evals.map((evaluation) => ({
      checkId: evaluation.evalId,
      passed: evaluation.passed,
      evidence: evaluation.evidence,
    })),
  };
}

function statusOption(args: string[]): "succeeded" | "failed" | undefined {
  const status = optionValue(args, "--status");
  if (status === undefined) return undefined;
  if (status !== "succeeded" && status !== "failed") {
    throw new Error(`Invalid outcome status: ${status}`);
  }
  return status;
}

function resumeOptions(args: string[]): ResumeManualRunOptions {
  const status = statusOption(args);
  const summary = optionValue(args, "--summary");
  const artifacts = parsePairs(args, "--artifact");
  const state = parsePairs(args, "--state");
  if (
    !status &&
    (summary || Object.keys(artifacts).length || Object.keys(state).length)
  ) {
    throw new Error("--summary, --artifact, and --state require --status");
  }
  if (status && !summary) {
    throw new Error("--summary is required when submitting an outcome");
  }
  return {
    confirmations: repeatedOption(args, "--confirm"),
    outcome: status
      ? { status, summary: summary!, artifacts, state }
      : undefined,
  };
}

export function createPrivateEngineCommandRunner(): EngineCommandRunner {
  return {
    async run(args, options) {
      if (args[0] !== "skill") {
        throw new Error(
          `Unsupported private Engine command: ${args.join(" ")}`,
        );
      }
      if (args[1] === "run") {
        const skillRoot = args[2];
        if (!skillRoot) throw new Error("skill run requires a Skill path");
        const confirmations = repeatedOption(args, "--confirm");
        const runId = optionValue(args, "--run-id");
        const changeDir = optionValue(args, "--change");
        if (Boolean(runId) === Boolean(changeDir)) {
          throw new Error("Pass exactly one of --change or --run-id");
        }
        const pkg = await loadSkillPackage(skillRoot);
        if (runId) {
          return resultWithChecks(
            await startStandaloneRun(pkg, {
              projectRoot: optionValue(args, "--project") ?? options.cwd,
              runId,
              confirmations,
            }),
          );
        }
        return resultWithChecks(
          await startManualRun(pkg, changeDir!, confirmations),
        );
      }

      if (args[1] === "continue") {
        const target = targetFromArgs(args, options);
        const continuation =
          target.kind === "standalone"
            ? await resumeStandaloneRun(
                target.projectRoot,
                target.runId,
                resumeOptions(args),
              )
            : await resumeManualRun(target.changeDir, resumeOptions(args));
        return resultWithChecks(continuation);
      }

      if (args[1] === "check") {
        const target = targetFromArgs(args, options);
        const scope = requiredOption(args, "--scope");
        if (
          scope !== "progress" &&
          scope !== "step" &&
          scope !== "completion"
        ) {
          throw new Error(`Invalid check scope: ${scope}`);
        }
        const result =
          target.kind === "standalone"
            ? await evaluateStandaloneRun(
                target.projectRoot,
                target.runId,
                scope,
              )
            : await evaluateManualRun(target.changeDir, scope);
        return resultWithChecks(result);
      }

      throw new Error(`Unsupported private Engine command: ${args.join(" ")}`);
    },
  };
}
