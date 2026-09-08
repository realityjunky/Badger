import { Command, Option } from "commander";
import path from "node:path";
import { promises as fs } from "node:fs";
import { findSkills, readSkillSourceManifest } from "./skill/find.js";
import type { SkillSourceDeclaration } from "./types.js";
import { buildProposal, readPlan } from "./factory/proposal.js";
import { generatePackage } from "./factory/generate.js";
import { initializeState, readState } from "./factory/state.js";
import { evaluatePackage } from "./eval/run.js";
import {
  approveReview,
  distributePreview,
  publishState,
  reviewState,
} from "./publish/lifecycle.js";
import { runDifferentialHarness } from "./differential/run.js";
import { runAuthoringDifferentialHarness } from "./differential/authoring/run.js";
import {
  assemblePackage,
  authoringReadiness,
  buildAuthoringHandoff,
  buildAuthoringPlan,
  initializeAuthoringSession,
  recordAuthoringFile,
} from "./authoring/index.js";
import { migrateLegacyDraft } from "./factory/migration.js";
import { readCreatorGuide } from "./factory/guide.js";
import {
  runEngineDifferential,
  runOfficialEngineBaseline,
} from "./differential/engine/run.js";

const program = new Command();
program.name("badger").description("Standalone Badger workflow Skill factory");

function projectRoot(value?: string): string {
  return path.resolve(value ?? ".");
}

function collectRepeated(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parseSourceDeclaration(value: string): SkillSourceDeclaration {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(
      `Invalid Skill source declaration: ${value}. Use name=location.`,
    );
  }
  return {
    name: value.slice(0, separator).trim(),
    location: value.slice(separator + 1).trim(),
  };
}
function emit(value: unknown, json?: boolean): void {
  console.log(json ? JSON.stringify(value, null, 2) : format(value));
}
function format(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

program
  .command("guide")
  .option(
    "--plan <file>",
    "Existing FactoryPlan to inspect; repeatable",
    collectRepeated,
    [],
  )
  .option("--project <dir>", "Project root", ".")
  .option("--json", "JSON output")
  .action(async (options) => {
    const root = projectRoot(options.project);
    emit(
      await readCreatorGuide({
        projectRoot: root,
        planPaths: options.plan ?? [],
      }),
      options.json,
    );
  });

program
  .command("candidates")
  .option(
    "--skill <name=location>",
    "Explicit Skill source declaration; repeatable",
    collectRepeated,
    [],
  )
  .option(
    "--source-manifest <file>",
    "JSON source manifest; repeatable",
    collectRepeated,
    [],
  )
  .option("--project <dir>", "Project root", ".")
  .option("--json", "JSON output")
  .action(async (options) => {
    const root = projectRoot(options.project);
    const declarations = [...(options.skill ?? [])].map(parseSourceDeclaration);
    for (const manifestFile of [...(options.sourceManifest ?? [])]) {
      declarations.push(
        ...(await readSkillSourceManifest(path.resolve(root, manifestFile)))
          .sources,
      );
    }
    emit(
      {
        candidates: await findSkills({
          projectRoot: root,
          sources: declarations,
        }),
      },
      options.json,
    );
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
  .command("authoring-plan <target>")
  .description("Preview the read-only AuthoringPlan for a workflow proposal")
  .option("--project <dir>", "Project root", ".")
  .addOption(
    new Option("--depth <depth>", "Authoring depth")
      .choices(["quick", "full"])
      .default("quick"),
  )
  .option("--json", "JSON output")
  .action(async (target, options) => {
    const root = projectRoot(options.project);
    emit(
      await buildAuthoringPlan({
        projectRoot: root,
        name: target,
        depth: options.depth,
      }),
      options.json,
    );
  });

program
  .command("authoring-status <name>")
  .description("Show resumable authoring lane status")
  .option("--project <dir>", "Project root", ".")
  .option("--json", "JSON output")
  .action(async (name, options) => {
    emit(
      await authoringReadiness(
        await readState(projectRoot(options.project), name),
      ),
      options.json,
    );
  });

program
  .command("migrate <name>")
  .alias("migrate-legacy")
  .description("Migrate a legacy deterministic draft into authoring")
  .requiredOption("--confirm", "Confirm migration writes")
  .addOption(
    new Option("--depth <depth>", "Authoring review depth")
      .choices(["quick", "full"])
      .default("quick"),
  )
  .option("--destination <dir>", "Destination for the migrated package")
  .option("--project <dir>", "Project root", ".")
  .option("--json", "JSON output")
  .action(async (name, options) => {
    const root = projectRoot(options.project);
    const result = await migrateLegacyDraft({
      state: await readState(root, name),
      confirmed: options.confirm,
      depth: options.depth,
      ...(options.destination
        ? { destination: path.resolve(root, options.destination) }
        : {}),
    });
    emit(
      {
        name,
        status: result.state.status,
        classification: "authoring-required",
        sourceRoot: result.sourceRoot,
        destination: result.destination,
        migrationPath: result.migrationPath,
        authoring: result.state.authoring,
        generated: result.state.generated,
      },
      options.json,
    );
  });

program
  .command("authoring-record <name>")
  .requiredOption("--lane <lane>", "Authoring lane")
  .requiredOption("--file <file>", "Authoring record JSON")
  .option(
    "--expected-revision <revision>",
    "Expected authoring session revision",
  )
  .option("--project <dir>", "Project root", ".")
  .option("--json", "JSON output")
  .action(async (name, options) => {
    const root = projectRoot(options.project);
    emit(
      await recordAuthoringFile({
        state: await readState(root, name),
        lane: options.lane,
        file: options.file,
        expectedRevision:
          options.expectedRevision === undefined
            ? undefined
            : Number(options.expectedRevision),
      }),
      options.json,
    );
  });

program
  .command("authoring-dispatch <name>")
  .description("Create a provider-neutral authoring file handoff")
  .requiredOption("--lane <lane>", "Authoring lane")
  .requiredOption("--output <file>", "Provider output JSON path")
  .option("--project <dir>", "Project root", ".")
  .option("--json", "JSON output")
  .action(async (name, options) => {
    emit(
      await buildAuthoringHandoff({
        state: await readState(projectRoot(options.project), name),
        lane: options.lane,
        outputPath: options.output,
      }),
      options.json,
    );
  });

program
  .command("assemble <name>")
  .description("Assemble a current authored workflow package")
  .option("--project <dir>", "Project root", ".")
  .option("--json", "JSON output")
  .action(async (name, options) => {
    const state = await assemblePackage(
      await readState(projectRoot(options.project), name),
    );
    emit(
      {
        name,
        status: state.status,
        authoring: state.authoring,
        generated: state.generated,
      },
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
  .addOption(
    new Option("--depth <depth>", "Authoring review depth")
      .choices(["quick", "full"])
      .default("quick"),
  )
  .option("--json", "JSON output")
  .action(async (name, options) => {
    const root = projectRoot(options.project);
    const state = await readState(root, name);
    const proposal = await buildProposal({
      projectRoot: root,
      planPath: state.planPath,
    });
    if (proposal.name !== state.name)
      throw new Error("Plan workflow name does not match Creator state");
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
      authoringDepth: options.depth,
    });
    state.generated = generated;
    state.planHash = proposal.planHash;
    state.confirmedProposal = structuredClone(proposal);
    state.candidates = proposal.candidates;
    state.status = "generated";
    state.currentHash = null;
    state.eval = undefined;
    state.review = undefined;
    await initializeAuthoringSession({
      state,
      plan: await buildAuthoringPlan({ proposal, depth: options.depth }),
      generated,
    });
    emit(
      { name, status: state.status, authoring: state.authoring, generated },
      options.json,
    );
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
  .description("Show composite authoring, runtime, and publication readiness")
  .option("--project <dir>", "Project root", ".")
  .option("--json", "JSON output")
  .action(async (name, options) => {
    const state = await readState(projectRoot(options.project), name);
    await authoringReadiness(state);
    emit(reviewState(state), options.json);
  });

program
  .command("approve <name>")
  .description("Record distinct human publication approval")
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
  .requiredOption("--official-root <dir>", "Pinned upstream reference checkout")
  .option("--official-cli <file>", "Upstream reference CLI entrypoint")
  .option("--official-revision <sha>", "Expected official revision")
  .option("--fixture-skills-root <dir>", "Reorganized Skill fixture root")
  .option("--repo <dir>", "Badger repository root", ".")
  .option("--json", "JSON output")
  .action(async (fixture, options) => {
    const root = projectRoot(options.repo);
    emit(
      await runDifferentialHarness({
        repositoryRoot: root,
        fixturePath: path.resolve(root, fixture),
        fixtureSkillsRoot: options.fixtureSkillsRoot
          ? path.resolve(root, options.fixtureSkillsRoot)
          : undefined,
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
  .command("authoring-differential <fixture>")
  .description("Certify pinned upstream and Badger authoring parity")
  .requiredOption("--official-root <dir>", "Pinned upstream reference checkout")
  .option("--official-cli <file>", "Upstream reference CLI entrypoint")
  .option("--official-revision <sha>", "Expected official revision")
  .option(
    "--official-protocol-path <path>",
    "Upstream authoring protocol path relative to the checkout",
  )
  .option(
    "--official-authoring-source-path <path>",
    "Upstream authoring implementation path relative to the checkout",
  )
  .option("--fixture-skills-root <dir>", "Reorganized Skill fixture root")
  .addOption(
    new Option("--depth <depth>", "Authoring review depth")
      .choices(["quick", "full"])
      .default("quick"),
  )
  .option("--repo <dir>", "Badger repository root", ".")
  .option("--output <file>", "Write certification report JSON")
  .option("--json", "JSON output")
  .action(async (fixture, options) => {
    const root = projectRoot(options.repo);
    const report = await runAuthoringDifferentialHarness({
      repositoryRoot: root,
      fixturePath: path.resolve(root, fixture),
      fixtureSkillsRoot: options.fixtureSkillsRoot
        ? path.resolve(root, options.fixtureSkillsRoot)
        : undefined,
      officialRoot: path.resolve(root, options.officialRoot),
      officialCli: options.officialCli
        ? path.resolve(root, options.officialCli)
        : undefined,
      officialRevision: options.officialRevision,
      officialProtocolPath: options.officialProtocolPath,
      officialAuthoringSourcePath: options.officialAuthoringSourcePath,
      depth: options.depth,
    });
    if (options.output) {
      await fs.writeFile(
        path.resolve(root, options.output),
        JSON.stringify(report, null, 2) + "\n",
        "utf8",
      );
    }
    emit(report, options.json);
    if (report.certification.status !== "certified") process.exitCode = 1;
  });

program
  .command("engine-differential <fixture>")
  .description("Characterize the pinned official Engine in disposable Runs")
  .requiredOption("--official-root <dir>", "Pinned upstream reference checkout")
  .option("--official-cli <file>", "Upstream reference CLI entrypoint")
  .option("--private", "Run the same fixture through the private Engine")
  .option("--repo <dir>", "Badger repository root", ".")
  .option("--confirm-output", "Confirm writing the baseline report")
  .option("--output <file>", "Write the baseline report to a JSON file")
  .option("--json", "JSON output")
  .action(async (fixture, options) => {
    const root = projectRoot(options.repo);
    if (options.output && !options.confirmOutput) {
      throw new Error("Writing a baseline report requires --confirm-output");
    }
    const baselineOptions = {
      repositoryRoot: root,
      fixturePath: path.resolve(root, fixture),
      officialRoot: path.resolve(root, options.officialRoot),
      officialCli: options.officialCli
        ? path.resolve(root, options.officialCli)
        : undefined,
    };
    const report = options.private
      ? await runEngineDifferential(baselineOptions)
      : await runOfficialEngineBaseline(baselineOptions);
    if (options.output) {
      await fs.writeFile(
        path.resolve(root, options.output),
        JSON.stringify(report, null, 2) + "\n",
        "utf8",
      );
    }
    emit(report, options.json);
    if (options.private && report.certification.status !== "certified") {
      process.exitCode = 1;
    }
  });

await program.parseAsync();
