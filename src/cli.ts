import { Command } from "commander";
import path from "node:path";
import { promises as fs } from "node:fs";
import { readPreferenceEntries, findSkills } from "./skill/find.js";
import { buildProposal, readPlan } from "./factory/proposal.js";
import { generatePackage } from "./factory/generate.js";
import { initializeState, readState, writeState } from "./factory/state.js";
import { evaluatePackage } from "./eval/run.js";
import {
  approveReview,
  distributePreview,
  publishState,
  reviewState,
} from "./publish/lifecycle.js";
import { runDifferentialHarness } from "./differential/run.js";
import { runOfficialEngineBaseline } from "./differential/engine/run.js";

const program = new Command();
program
  .name("comet-any")
  .description("Standalone Comet-any workflow Skill factory");

function projectRoot(value?: string): string {
  return path.resolve(value ?? ".");
}
function emit(value: unknown, json?: boolean): void {
  console.log(json ? JSON.stringify(value, null, 2) : format(value));
}
function format(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

program
  .command("guide")
  .option("--project <dir>", "Project root", ".")
  .option("--json", "JSON output")
  .action(async (options) => {
    const root = projectRoot(options.project);
    const preferences = await readPreferenceEntries(root);
    const states = await safeStates(root);
    emit(
      {
        schemaVersion: 1,
        intent: ["new-skill", "upgrade-existing"],
        preferenceFile: path.join(root, ".comet-any", "skill-preferences.yaml"),
        preferences,
        resumable: states.map((state) => ({
          name: state.name,
          status: state.status,
        })),
      },
      options.json,
    );
  });

program
  .command("candidates")
  .option("--project <dir>", "Project root", ".")
  .option("--json", "JSON output")
  .action(async (options) => {
    const root = projectRoot(options.project);
    emit({ candidates: await findSkills({ projectRoot: root }) }, options.json);
  });

program
  .command("propose <plan>")
  .option("--project <dir>", "Project root", ".")
  .option("--json", "JSON output")
  .action(async (plan, options) => {
    emit(
      await buildProposal({
        projectRoot: projectRoot(options.project),
        planPath: plan,
      }),
      options.json,
    );
  });

program
  .command("init <plan>")
  .option("--confirm", "Confirm the displayed proposal")
  .option("--project <dir>", "Project root", ".")
  .option("--json", "JSON output")
  .action(async (planPath, options) => {
    const root = projectRoot(options.project);
    const proposal = await buildProposal({ projectRoot: root, planPath });
    const plan = await readPlan(planPath);
    if (!proposal.canInitialize)
      throw new Error(
        `Cannot initialize blocked proposal:\n${proposal.blockers.join("\n")}`,
      );
    emit(
      await initializeState({
        projectRoot: root,
        planPath,
        plan,
        proposal,
        confirmed: options.confirm,
      }),
      options.json,
    );
  });

program
  .command("generate <name>")
  .option("--project <dir>", "Project root", ".")
  .option("--json", "JSON output")
  .action(async (name, options) => {
    const root = projectRoot(options.project);
    const state = await readState(root, name);
    const proposal = await buildProposal({
      projectRoot: root,
      planPath: state.planPath,
    });
    if (!proposal.canInitialize)
      throw new Error(
        `Cannot generate blocked proposal:\n${proposal.blockers.join("\n")}`,
      );
    const plan = await readPlan(state.planPath);
    if (plan.sourceRoot) plan.sourceRoot = path.resolve(root, plan.sourceRoot);
    const generated = await generatePackage({
      proposal,
      plan,
      destination: state.draftPath,
    });
    state.generated = generated;
    state.status = "generated";
    state.currentHash = null;
    state.eval = undefined;
    state.review = undefined;
    await writeState(state);
    emit({ name, status: state.status, generated }, options.json);
  });

program
  .command("eval <name>")
  .option("--project <dir>", "Project root", ".")
  .option("--json", "JSON output")
  .action(async (name, options) => {
    emit(
      await evaluatePackage(
        await readState(projectRoot(options.project), name),
      ),
      options.json,
    );
  });

program
  .command("review <name>")
  .option("--project <dir>", "Project root", ".")
  .option("--json", "JSON output")
  .action(async (name, options) => {
    emit(
      reviewState(await readState(projectRoot(options.project), name)),
      options.json,
    );
  });

program
  .command("approve <name>")
  .requiredOption("--reviewer <id>", "Reviewer identity")
  .option("--confirm", "Confirm approval")
  .option("--project <dir>", "Project root", ".")
  .option("--json", "JSON output")
  .action(async (name, options) => {
    const state = await approveReview({
      state: await readState(projectRoot(options.project), name),
      reviewer: options.reviewer,
      approve: options.confirm,
    });
    emit(state, options.json);
  });

program
  .command("publish <name>")
  .option("--confirm", "Confirm publication")
  .option("--project <dir>", "Project root", ".")
  .option("--json", "JSON output")
  .action(async (name, options) => {
    if (!options.confirm)
      throw new Error("Publication requires explicit confirmation");
    emit(
      await publishState(await readState(projectRoot(options.project), name)),
      options.json,
    );
  });

program
  .command("distribute <name>")
  .requiredOption("--destination <dir>", "Preview destination")
  .option("--project <dir>", "Project root", ".")
  .option("--json", "JSON output")
  .action(async (name, options) => {
    emit(
      await distributePreview(
        await readState(projectRoot(options.project), name),
        options.destination,
      ),
      options.json,
    );
  });

program
  .command("differential <fixture>")
  .requiredOption("--official-root <dir>", "Pinned official Comet checkout")
  .option("--official-cli <file>", "Official Comet CLI entrypoint")
  .option("--official-revision <sha>", "Expected official revision")
  .option("--repo <dir>", "Skill harness repository root", ".")
  .option("--json", "JSON output")
  .action(async (fixture, options) => {
    const root = projectRoot(options.repo);
    emit(
      await runDifferentialHarness({
        repositoryRoot: root,
        fixturePath: path.resolve(root, fixture),
        officialRoot: path.resolve(root, options.officialRoot),
        officialCli: options.officialCli
          ? path.resolve(root, options.officialCli)
          : undefined,
        officialRevision: options.officialRevision,
      }),
      options.json,
    );
  });

program
  .command("engine-differential <fixture>")
  .description("Characterize the pinned official Engine in disposable Runs")
  .requiredOption("--official-root <dir>", "Pinned official Comet checkout")
  .option("--official-cli <file>", "Official Comet CLI entrypoint")
  .option("--repo <dir>", "Skill harness repository root", ".")
  .option("--confirm-output", "Confirm writing the baseline report")
  .option("--output <file>", "Write the baseline report to a JSON file")
  .option("--json", "JSON output")
  .action(async (fixture, options) => {
    const root = projectRoot(options.repo);
    if (options.output && !options.confirmOutput) {
      throw new Error("Writing a baseline report requires --confirm-output");
    }
    const report = await runOfficialEngineBaseline({
      repositoryRoot: root,
      fixturePath: path.resolve(root, fixture),
      officialRoot: path.resolve(root, options.officialRoot),
      officialCli: options.officialCli
        ? path.resolve(root, options.officialCli)
        : undefined,
    });
    if (options.output) {
      await fs.writeFile(
        path.resolve(root, options.output),
        JSON.stringify(report, null, 2) + "\n",
        "utf8",
      );
    }
    emit(report, options.json);
  });

async function safeStates(root: string) {
  try {
    const { readdir } = await import("node:fs/promises");
    const directory = path.join(root, ".comet-any", "states");
    const entries = await readdir(directory, { withFileTypes: true });
    const states = [];
    for (const entry of entries.filter(
      (item) => item.isFile() && item.name.endsWith(".json"),
    )) {
      states.push(await readState(root, entry.name.slice(0, -5)));
    }
    return states;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

await program.parseAsync();
