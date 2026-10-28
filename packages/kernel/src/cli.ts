import { Command, Option } from "commander";
import path from "node:path";
import { promises as fs } from "node:fs";
import { checkSkillSources, readSkillSourceManifest } from "./skill/find.js";
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
import {
  authoringReadiness,
  authoringSessionGateway,
  buildAuthoringHandoff,
  buildAuthoringPlan,
  initializeAuthoringSession,
} from "./authoring/index.js";
import { migrateLegacyDraft } from "./factory/migration.js";
import { readCreatorGuide } from "./factory/guide.js";
import { createQuestionnaireHandoff } from "./factory/questionnaire.js";

const program = new Command();
program.name("badger").description("Standalone Badger workflow Skill factory");

function projectRoot(value?: string): string {
  return path.resolve(value ?? ".");
}

function collectRepeated(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function sourceRootOption(): Option {
  return new Option(
    "--source-root <dir>",
    "Registered root outside the project where Skill and upgrade sources may live; repeatable, added to BADGER_SOURCE_ROOTS",
  )
    .argParser(collectRepeated)
    .default([]);
}

function registeredSourceRoots(root: string, flags: string[] = []): string[] {
  const environment = (process.env.BADGER_SOURCE_ROOTS ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...environment, ...flags].map((entry) => path.resolve(root, entry));
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
  .command("source-check")
  .alias("candidates")
  .description(
    "Check the declared Skill sources: identity, inventory, scripts, and blockers",
  )
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
  .addOption(sourceRootOption())
  .option("--project <dir>", "Project root", ".")
  .option("--json", "JSON output")
  .action(async (options) => {
    const root = projectRoot(options.project);
    const declarations = [...(options.skill ?? [])].map(parseSourceDeclaration);
    for (const manifestFile of [...(options.sourceManifest ?? [])]) {
      const manifest = await readSkillSourceManifest(
        path.resolve(root, manifestFile),
      );
      declarations.push(...manifest.sources);
    }
    emit(
      {
        candidates: await checkSkillSources({
          projectRoot: root,
          sources: declarations,
          roots: registeredSourceRoots(root, options.sourceRoot),
        }),
      },
      options.json,
    );
  });

program
  .command("propose <plan>")
  .addOption(sourceRootOption())
  .option("--project <dir>", "Project root", ".")
  .option("--json", "JSON output")
  .action(async (plan, options) => {
    const root = projectRoot(options.project);
    emit(
      await buildProposal({
        projectRoot: root,
        planPath: plan,
        sourceRoots: registeredSourceRoots(root, options.sourceRoot),
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
  .addOption(sourceRootOption())
  .option("--project <dir>", "Project root", ".")
  .option("--json", "JSON output")
  .action(async (name, options) => {
    const root = projectRoot(options.project);
    const result = await migrateLegacyDraft({
      state: await readState(root, name),
      confirmed: options.confirm,
      depth: options.depth,
      sourceRoots: registeredSourceRoots(root, options.sourceRoot),
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
  .option("--confirm", "Confirm authoring record persistence")
  .option(
    "--expected-revision <revision>",
    "Expected authoring session revision",
  )
  .option("--project <dir>", "Project root", ".")
  .option("--json", "JSON output")
  .action(async (name, options) => {
    if (!options.confirm)
      throw new Error(
        "Authoring record persistence requires explicit confirmation",
      );
    const root = projectRoot(options.project);
    const state = await readState(root, name);
    const record = JSON.parse(
      await fs.readFile(path.resolve(options.file), "utf8"),
    );
    emit(
      await authoringSessionGateway().record({
        state,
        lane: options.lane,
        record,
        confirmed: options.confirm,
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
  .option("--confirm", "Confirm authoring assembly")
  .addOption(sourceRootOption())
  .option("--project <dir>", "Project root", ".")
  .option("--json", "JSON output")
  .action(async (name, options) => {
    if (!options.confirm)
      throw new Error("Authoring assembly requires explicit confirmation");
    const root = projectRoot(options.project);
    const state = await authoringSessionGateway().assemble(
      await readState(root, name),
      options.confirm,
      { sourceRoots: registeredSourceRoots(root, options.sourceRoot) },
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
  .addOption(sourceRootOption())
  .option("--project <dir>", "Project root", ".")
  .option("--json", "JSON output")
  .action(async (planPath, options) => {
    const root = projectRoot(options.project);
    const sourceRoots = registeredSourceRoots(root, options.sourceRoot);
    const proposal = await buildProposal({
      projectRoot: root,
      planPath,
      sourceRoots,
    });
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
        sourceRoots,
      }),
      options.json,
    );
  });

program
  .command("generate <name>")
  .addOption(sourceRootOption())
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
    const sourceRoots = registeredSourceRoots(root, options.sourceRoot);
    const proposal = await buildProposal({
      projectRoot: root,
      planPath: state.planPath,
      sourceRoots,
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
      projectRoot: root,
      sourceRoots,
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
      await publishState(
        await readState(projectRoot(options.project), name),
        options.confirm,
      ),
      options.json,
    );
  });

program
  .command("distribute <name>")
  .requiredOption("--destination <dir>", "Preview destination")
  .option("--confirm", "Confirm distribution preview")
  .option("--project <dir>", "Project root", ".")
  .option("--json", "JSON output")
  .action(async (name, options) => {
    if (!options.confirm)
      throw new Error("Distribution requires explicit confirmation");
    emit(
      await distributePreview(
        await readState(projectRoot(options.project), name),
        options.destination,
        options.confirm,
      ),
      options.json,
    );
  });

program
  .command("questionnaire-handoff <dossier>")
  .description("Validate a read-only semantic questionnaire handoff")
  .option("--plan <file>", "Candidate FactoryPlan to include for confirmation")
  .option("--project <dir>", "Target project root")
  .option(
    "--existing-context <path>",
    "Existing plan or Creator state reference",
  )
  .option("--stopped", "Record a user-requested stop with unresolved gaps")
  .option("--json", "JSON output")
  .action(async (dossier, options) => {
    const root = projectRoot(options.project);
    const handoff = createQuestionnaireHandoff({
      projectRoot: root,
      dossier: JSON.parse(
        await fs.readFile(path.resolve(root, dossier), "utf8"),
      ),
      factoryPlan: options.plan
        ? JSON.parse(
            await fs.readFile(path.resolve(root, options.plan), "utf8"),
          )
        : undefined,
      existingContext: options.existingContext,
      stopped: options.stopped === true,
    });
    emit(handoff, options.json);
    if (handoff.status === "incomplete") process.exitCode = 1;
  });

await program.parseAsync();
