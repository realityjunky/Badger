import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assemblePackage,
  buildProposal,
  evaluatePackage,
  generateFromApprovedProposal,
  initializeState,
  readState,
  runManualAuthoringFixture,
  type SkillCandidate,
} from "../src/index.js";
import { questionnaireFixture } from "./fixtures/semantic-dossier.js";

describe("packaged source Skills", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-package-sources-"));
  });

  afterEach(async () => fs.rm(root, { recursive: true, force: true }));

  async function generate(project: string, sourceLocation = "skills/prepare") {
    const skillRoot = path.resolve(project, sourceLocation);
    await fs.mkdir(path.join(skillRoot, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(skillRoot, "SKILL.md"),
      "---\nname: prepare\ndescription: Prepare a report.\n---\n\nRead scripts/prepare.py.\n",
    );
    await fs.writeFile(
      path.join(skillRoot, "scripts", "prepare.py"),
      "print('prepared')\n",
    );
    await fs.mkdir(path.join(skillRoot, ".config"), { recursive: true });
    await fs.writeFile(
      path.join(skillRoot, ".config", "settings.json"),
      '{"format":"report"}\n',
    );
    await fs.writeFile(
      path.join(skillRoot, "template.bin"),
      Buffer.from([0, 128, 255, 10]),
    );
    await fs.mkdir(project, { recursive: true });
    const planPath = path.join(project, "plan.json");
    const plan = questionnaireFixture().factoryPlan;
    plan.skillSources[0]!.location = sourceLocation;
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2));
    const sourceRoots = path.isAbsolute(sourceLocation)
      ? [path.dirname(sourceLocation)]
      : [];
    const proposal = await buildProposal({
      projectRoot: project,
      planPath,
      sourceRoots,
    });
    expect(proposal.canInitialize).toBe(true);
    const state = await initializeState({
      projectRoot: project,
      planPath,
      proposalHash: proposal.proposalHash,
      confirmed: true,
      sourceRoots,
    });
    return generateFromApprovedProposal({
      projectRoot: project,
      name: state.name,
      confirmed: true,
      sourceRoots,
    });
  }

  it("bundles the complete source Skill at a package-relative location", async () => {
    const external = path.join(root, "registered", "prepare");
    const { generated } = await generate(path.join(root, "project"), external);
    const candidates = JSON.parse(
      await fs.readFile(
        path.join(generated.packageRoot, "reference", "resolved-skills.json"),
        "utf8",
      ),
    ) as SkillCandidate[];
    const source = candidates[0]!.sources[0]!;
    expect(path.isAbsolute(source.root)).toBe(false);
    expect(source.root.split("/")).not.toContain("..");
    expect(
      await fs.readFile(
        path.join(generated.packageRoot, source.root, "SKILL.md"),
        "utf8",
      ),
    ).toContain("Read scripts/prepare.py.");
    expect(
      await fs.readFile(
        path.join(generated.packageRoot, source.root, "scripts", "prepare.py"),
        "utf8",
      ),
    ).toBe("print('prepared')\n");
    expect(
      await fs.readFile(
        path.join(
          generated.packageRoot,
          source.root,
          ".config",
          "settings.json",
        ),
        "utf8",
      ),
    ).toBe('{"format":"report"}\n');
    expect(
      await fs.readFile(
        path.join(generated.packageRoot, source.root, "template.bin"),
      ),
    ).toEqual(Buffer.from([0, 128, 255, 10]));
    for (const file of ["resolved-skills.json", "authoring-plan.json"]) {
      expect(
        await fs.readFile(
          path.join(generated.packageRoot, "reference", file),
          "utf8",
        ),
      ).not.toContain(external);
    }
    expect(generated.inventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: `${source.root}/scripts/prepare.py`,
          owner: "source",
        }),
      ]),
    );
  });

  it.each(["project", "registered"])(
    "generates the same package hash in two directories with %s sources",
    async (scope) => {
      const location =
        scope === "registered"
          ? path.join(root, "registered", "prepare")
          : "skills/prepare";
      const first = await generate(path.join(root, "first"), location);
      const second = await generate(path.join(root, "second"), location);
      expect(second.generated.scaffoldHash).toBe(first.generated.scaffoldHash);
      expect(second.generated.inventory).toEqual(first.generated.inventory);
    },
  );

  it("excludes identity noise from the bundle and its package hash", async () => {
    const project = path.join(root, "project");
    const first = await generate(project);
    const skillRoot = path.join(project, "skills", "prepare");
    await fs.writeFile(path.join(skillRoot, ".DS_Store"), "desktop state");
    await fs.mkdir(path.join(skillRoot, "scripts", "__pycache__"));
    await fs.writeFile(
      path.join(skillRoot, "scripts", "__pycache__", "prepare.pyc"),
      "cached bytecode",
    );
    const second = await generateFromApprovedProposal({
      projectRoot: project,
      name: first.state.name,
      confirmed: true,
    });
    expect(second.generated.scaffoldHash).toBe(first.generated.scaffoldHash);
    expect(second.generated.inventory).toEqual(first.generated.inventory);
  });

  it("refuses binary source edits outside the assembler", async () => {
    const { state, generated } = await generate(path.join(root, "project"));
    const authored = await runManualAuthoringFixture({ state });
    const binary = generated.inventory.find((file) =>
      file.path.endsWith("/template.bin"),
    )!;
    await fs.writeFile(
      path.join(generated.packageRoot, binary.path),
      Buffer.from([0, 129, 255, 10]),
    );
    await expect(assemblePackage(authored, true)).rejects.toThrow(
      /Auto-zone file changed: sources\/.*\/template\.bin/u,
    );
  });

  it("evaluates a copied package without the original source Skills", async () => {
    const project = path.join(root, "original");
    const { state } = await generate(project);
    const assembled = await assemblePackage(
      await runManualAuthoringFixture({ state }),
      true,
    );
    const copied = path.join(root, "copied");
    await fs.cp(project, copied, { recursive: true });
    await fs.rm(project, { recursive: true });
    await fs.rm(path.join(copied, "skills"), { recursive: true });

    const copiedState = await readState(copied, assembled.name);
    const report = await evaluatePackage(copiedState);
    expect(report.checks.filter((check) => !check.passed)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.runtime?.completed).toBe(true);
    expect(report.hash).toBe(assembled.authoring!.assembledPackageHash);
  }, 30_000);

  it.each(["missing", "changed"])(
    "refuses evaluation with a %s bundle when the original is absent",
    async (damage) => {
      const project = path.join(root, "project");
      const { state, generated } = await generate(project);
      const assembled = await assemblePackage(
        await runManualAuthoringFixture({ state }),
        true,
      );
      await fs.rm(path.join(project, "skills"), { recursive: true });
      const binary = generated.inventory.find((file) =>
        file.path.endsWith("/template.bin"),
      )!;
      const target = path.join(generated.packageRoot, binary.path);
      if (damage === "missing") await fs.rm(target);
      else await fs.writeFile(target, Buffer.from([0, 129, 255, 10]));

      const report = await evaluatePackage(assembled);
      expect(report.passed).toBe(false);
      expect(report.checks).toContainEqual(
        expect.objectContaining({ id: "authoring-assembly", passed: false }),
      );
    },
    30_000,
  );
});
