import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fixturePlanForOfficial } from "./fixture.js";
import {
  canonicalizeCandidates,
  canonicalizeReadiness,
  canonicalizeWorkflowProtocol,
  inventoryDirectory,
  observationParts,
} from "./observe.js";
import type {
  DifferentialFixture,
  DifferentialObservation,
  OfficialCommandRunner,
} from "./types.js";

const execFile = promisify(execFileCallback);

function projectPath(projectRoot: string, value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(projectRoot, value.replace(/^\.\//u, ""));
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function generatedArtifactRoot(
  projectRoot: string,
  generated: Record<string, unknown>,
  fallback: string,
): string {
  const directRoot = projectPath(projectRoot, generated.draftPath);
  if (directRoot) return directRoot;
  const factory = objectValue(generated.factory);
  const generatedPackage = objectValue(factory?.generatedSkillPackage);
  return projectPath(projectRoot, generatedPackage?.packageRoot) ?? fallback;
}

function commandArgs(command: string[], projectRoot: string): string[] {
  return [...command, "--project", projectRoot, "--json"];
}

export function createOfficialCommandRunner(options: {
  officialCli: string;
}): OfficialCommandRunner {
  return {
    async run(args, commandOptions) {
      let result;
      try {
        result = await execFile(
          process.execPath,
          [options.officialCli, ...args],
          {
            cwd: commandOptions.cwd,
            env: {
              ...process.env,
              HOME: commandOptions.homeDir,
              USERPROFILE: commandOptions.homeDir,
            },
            maxBuffer: 64 * 1024 * 1024,
          },
        );
      } catch (error) {
        const failure = error as {
          stderr?: string;
          stdout?: string;
          message?: string;
        };
        throw new Error(
          `Official Creator command failed: ${args.join(" ")}\n${
            failure.stderr ?? failure.stdout ?? failure.message ?? String(error)
          }`.trim(),
        );
      }
      const output = result.stdout.trim();
      if (!output)
        throw new Error(
          `Official Creator command returned no JSON: ${args.join(" ")}`,
        );
      try {
        return JSON.parse(output) as unknown;
      } catch (error) {
        throw new Error(
          `Official Creator command returned invalid JSON: ${args.join(" ")}`,
          { cause: error },
        );
      }
    },
  };
}

export async function readOfficialRevision(
  officialRoot: string,
): Promise<string> {
  try {
    const result = await execFile("git", [
      "-C",
      path.resolve(officialRoot),
      "rev-parse",
      "HEAD",
    ]);
    return result.stdout.trim();
  } catch (error) {
    throw new Error(
      `Unable to read pinned official revision from ${officialRoot}`,
      {
        cause: error,
      },
    );
  }
}

export async function observeOfficial(options: {
  fixture: DifferentialFixture;
  projectRoot: string;
  homeDir: string;
  runner: OfficialCommandRunner;
}): Promise<DifferentialObservation> {
  const projectRoot = path.resolve(options.projectRoot);
  const planPath = path.join(projectRoot, "differential-plan.json");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(
    planPath,
    JSON.stringify(fixturePlanForOfficial(options.fixture), null, 2) + "\n",
    "utf8",
  );

  const name = options.fixture.plan.workflow.name;
  const candidatesResult = await options.runner.run(
    commandArgs(["creator", "candidates"], projectRoot),
    { cwd: projectRoot, homeDir: options.homeDir },
  );
  const candidates = canonicalizeCandidates(candidatesResult);
  const proposalResult = await options.runner.run(
    commandArgs(["creator", "propose", name, "--file", planPath], projectRoot),
    { cwd: projectRoot, homeDir: options.homeDir },
  );
  const proposal = proposalResult as Record<string, unknown>;
  const resolvedCandidates = Array.isArray(proposal.resolvedSkills)
    ? canonicalizeCandidates({ candidates: proposal.resolvedSkills })
    : candidates;
  const workflowProtocol = canonicalizeWorkflowProtocol(
    proposal.workflowProtocol,
  );
  let artifactRoot = path.join(projectRoot, ".comet", "bundle-drafts", name);
  let readiness;

  if (proposal.canGenerate === true) {
    await options.runner.run(
      commandArgs(
        ["creator", "init", name, "--file", planPath, "--confirmed-proposal"],
        projectRoot,
      ),
      { cwd: projectRoot, homeDir: options.homeDir },
    );
    const generatedResult = await options.runner.run(
      commandArgs(["creator", "generate", name], projectRoot),
      { cwd: projectRoot, homeDir: options.homeDir },
    );
    const generated = generatedResult as Record<string, unknown>;
    artifactRoot = generatedArtifactRoot(projectRoot, generated, artifactRoot);
    const statusResult = await options.runner.run(
      commandArgs(["creator", "status", name], projectRoot),
      { cwd: projectRoot, homeDir: options.homeDir },
    );
    const status = statusResult as Record<string, unknown>;
    artifactRoot = projectPath(projectRoot, status.draftPath) ?? artifactRoot;
    const reviewResult = await options.runner.run(
      commandArgs(
        [
          "publish",
          "review",
          name,
          "--platform",
          "claude",
          "--scope",
          "project",
        ],
        projectRoot,
      ),
      { cwd: projectRoot, homeDir: options.homeDir },
    );
    readiness = canonicalizeReadiness(reviewResult);
  } else {
    readiness = {
      state: "blocked",
      blockers: Array.isArray(proposal.blockers)
        ? proposal.blockers.filter(
            (item): item is string => typeof item === "string",
          )
        : ["Official Creator proposal cannot generate"],
      warnings: Array.isArray(proposal.warnings)
        ? proposal.warnings.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
      evidence: {},
    };
  }

  return observationParts(
    resolvedCandidates,
    workflowProtocol,
    await inventoryDirectory(artifactRoot, true),
    readiness,
  );
}
