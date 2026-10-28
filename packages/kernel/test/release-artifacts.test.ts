import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AUTHORING_CONTROL_PLANE_SCRIPTS,
  AUTHORING_DETERMINISTIC_BACKBONE,
  AUTHORING_LANE_IDS,
  AUTHORING_PROTOCOL,
} from "../src/authoring/index.js";
import { SKILL_IDENTITY_IGNORE } from "../src/skill/identity.js";
import { SKILL_SCRIPT_SIDE_EFFECTS } from "../src/types.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const kernelRoot = path.join(repositoryRoot, "packages/kernel");
const semanticDossierDecision = "0001-semantic-dossier-and-wave-one-lenses.md";
const serviceDecisions = [
  "0002-collaborative-service-in-scope.md",
  "0003-identity-boundary.md",
  "0004-service-state-in-postgres.md",
  "0005-agents-draft-people-sign-off.md",
  "0006-questionnaire-records-and-dossier-version-2.md",
  "0009-reviewed-sql-migrations.md",
  "0010-nested-groups-and-email-bindings.md",
];
const kernelDecisions = [
  "0007-project-relative-creator-paths.md",
  "0008-skill-identity-and-registered-roots.md",
];

async function readText(relativePath: string): Promise<string> {
  return fs.readFile(path.join(repositoryRoot, relativePath), "utf8");
}

async function expectLocalLinksToResolve(
  directory: string,
  hrefs: string[],
): Promise<void> {
  const localPaths = hrefs
    .filter((href) => href && !href.startsWith("#") && !/^[a-z]+:/iu.test(href))
    .map((href) => href.split("#", 1)[0]);
  for (const relativePath of new Set(localPaths)) {
    const target = await fs.stat(
      path.resolve(repositoryRoot, directory, relativePath),
    );
    expect(target.isFile(), `${directory}: ${relativePath}`).toBe(true);
  }
}

async function readJson(
  relativePath: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(await readText(relativePath)) as Record<string, unknown>;
}

describe("Badger release artifacts", () => {
  it("ships the complete package-facing authoring reference set", async () => {
    const references = [
      "assets/skills/badger-create/reference/authoring-protocol.json",
      "assets/skills/badger-create/reference/authoring-subagents.md",
      "assets/skills/badger-create/reference/bundle-authoring.md",
      "assets/skills/badger-create/reference/authored-zone-example.md",
      "assets/skills/badger-create/reference/eval-provider.md",
      "assets/skills/badger-create/reference/package-inventory.example.json",
    ];

    const packageManifest = await readJson("packages/kernel/package.json");
    expect(packageManifest.files).toEqual(
      expect.arrayContaining(["assets", "README.md", "CHANGELOG.md"]),
    );

    for (const relativePath of [
      "assets/skills/badger-create/SKILL.md",
      ...references,
      ...AUTHORING_LANE_IDS.map(
        (lane) =>
          `assets/skills/badger-create/${AUTHORING_PROTOCOL.lanes[lane].brief}`,
      ),
    ]) {
      await expect(
        fs.stat(path.join(kernelRoot, relativePath)),
      ).resolves.toMatchObject({
        isFile: expect.any(Function),
      });
    }
  });

  it("documents the closed-world explicit source contract", async () => {
    const creator = await readText(
      "packages/kernel/assets/skills/badger-create/SKILL.md",
    );
    const questionnaire = await readText(
      "packages/kernel/assets/skills/badger-workflow-questionnaire/SKILL.md",
    );
    const manual = await readText("docs/badger-workflow-manual.html");
    expect(creator).toMatch(/^---\nname: badger-create\n/u);
    expect(creator).toContain("/badger-create");
    expect(creator).toContain("automatic-first-use");
    expect(creator).toContain("manual-refinement");
    expect(creator).toContain("skillSources");
    expect(creator).toContain("--skill <name=location>");
    expect(questionnaire).toContain("explicit Skill source declarations");
    expect(questionnaire).toContain("Confirmed user facts");
    expect(questionnaire).toContain("Source-derived facts");
    expect(questionnaire).toContain("Agent inferences");
    expect(questionnaire).toContain("Unresolved assumptions");
    expect(questionnaire).toContain("Remaining questions");
    expect(questionnaire).toContain("docs/badger-workflow-manual.html");
    expect(questionnaire).toContain("automatic-first-use");
    expect(questionnaire).toContain("manual-refinement");
    expect(questionnaire).toContain("badger-questionnaire-handoff");
    expect(manual).toContain("skillSources");
    expect(manual).toContain("Agent and backend authoring boundary");
    expect(manual).toContain("FactoryPlan completeness checklist");
    expect(manual).toContain("Required Skill Call");
    expect(creator).not.toContain("skill-preferences.yaml");
    expect(questionnaire).not.toContain("skill-preferences.yaml");
    expect(manual).not.toContain("skill-preferences.yaml");
  });

  it("documents semantic dossier version 2 in the packaged questionnaire contract", async () => {
    const questionnaire = await readText(
      "packages/kernel/assets/skills/badger-workflow-questionnaire/SKILL.md",
    );
    const reference = await readText(
      "packages/kernel/assets/skills/badger-workflow-questionnaire/reference/semantic-dossier.md",
    );
    const manual = await readText("docs/badger-workflow-manual.html");
    const ledger = await readText("docs/release-artifacts.md");

    for (const prose of [questionnaire, reference]) {
      expect(prose).toContain("version 2");
      expect(prose).toContain("interfaces");
      expect(prose).toContain("resolution");
    }
    for (const field of [
      "deferredQuestions",
      "answerRevisions",
      "acknowledgedBy",
    ])
      expect(reference).toContain(field);
    expect(reference).toContain("Version 1 is retired");
    expect(manual).toContain("The dossier is schema version 2");
    expect(manual).toContain("处理结论");
    // Version 2 is delivered, so §7, which describes only what is not built,
    // no longer lists it among the kernel changes still to come.
    const planned = manual.slice(manual.indexOf('id="service"'));
    expect(planned).not.toContain("issues/29");
    expect(planned).not.toContain("Schema version 2 adds");
    expect(ledger).toContain("reference/semantic-dossier.md");
  });

  it("documents every assembled backbone path and content owner", async () => {
    const inventory = await readJson(
      "packages/kernel/assets/skills/badger-create/reference/package-inventory.example.json",
    );
    const files = inventory.files as Array<Record<string, unknown>>;
    const entries = new Map(
      files.map((file) => [String(file.path), String(file.owner)]),
    );
    const expectedContentLeaves = [
      "SKILL.md",
      "prepared-workflow-prepare/SKILL.md",
      "reference/decision-points.md",
      "reference/recovery.md",
      "reference/skill-review.md",
    ];

    expect(inventory).toMatchObject({
      schemaVersion: 1,
      kind: "badger-package-inventory",
      status: "assembled",
    });
    expect(
      AUTHORING_CONTROL_PLANE_SCRIPTS.map((script) => script.path),
    ).toEqual(
      expect.arrayContaining([
        "scripts/workflow-state.mjs",
        "scripts/workflow-guard.mjs",
        "scripts/workflow-handoff.mjs",
        "scripts/badger-plan.mjs",
        "scripts/badger-check.mjs",
        "scripts/badger-hook-guard.mjs",
      ]),
    );

    for (const relativePath of [
      ...AUTHORING_DETERMINISTIC_BACKBONE,
      ...AUTHORING_LANE_IDS.map((lane) => AUTHORING_PROTOCOL.lanes[lane].brief),
      ...expectedContentLeaves,
    ]) {
      expect(entries.has(relativePath), relativePath).toBe(true);
    }

    for (const relativePath of expectedContentLeaves) {
      expect(entries.get(relativePath)).toBe("authored");
    }
    for (const relativePath of AUTHORING_DETERMINISTIC_BACKBONE) {
      expect(entries.get(relativePath)).toBe("auto");
    }

    expect(
      files.every((file) => {
        const relativePath = String(file.path);
        return (
          !path.isAbsolute(relativePath) &&
          !relativePath.split("/").includes("..")
        );
      }),
    ).toBe(true);

    const inventoryText = JSON.stringify(inventory);
    expect(inventoryText).not.toMatch(
      /\.badger|provider|credential|raw_data|authoringInputHash/u,
    );
  });

  it("keeps the collaborative service in scope", async () => {
    for (const relativePath of [
      "AGENTS.md",
      "README.md",
      "packages/kernel/README.md",
      "docs/release-artifacts.md",
      "packages/kernel/CHANGELOG.md",
    ]) {
      const prose = (await readText(relativePath)).replace(/\s+/gu, " ");
      for (const surface of [
        "collaborative service",
        "web dashboard",
        "Badger MCP",
        "host installer",
      ]) {
        expect(prose, `${relativePath}: ${surface}`).toContain(surface);
      }
      expect(prose, relativePath).toMatch(
        /launcher entries, reverse-proxy routes, and deploy scripts/u,
      );
    }

    const agents = await readText("AGENTS.md");
    const readme = await readText("packages/kernel/README.md");
    const ledger = await readText("docs/release-artifacts.md");
    const changelog = await readText("packages/kernel/CHANGELOG.md");
    expect(agents).not.toContain("platform installers");
    expect(readme).not.toContain("Platform and dashboard integration");
    expect(readme).not.toContain("intentionally excludes host platform");
    expect(ledger).not.toContain("host dashboards");
    expect(ledger).not.toMatch(/installers[^\n]*\| Out of scope/u);
    expect(changelog).not.toContain("dashboard adapters");
  });

  it("records the collaborative service and kernel decisions as ADRs", async () => {
    await expect(
      fs.readdir(path.join(repositoryRoot, "docs/adr")),
    ).resolves.toEqual(
      expect.arrayContaining([
        semanticDossierDecision,
        ...serviceDecisions,
        ...kernelDecisions,
      ]),
    );

    for (const decision of [...serviceDecisions, ...kernelDecisions]) {
      const record = await readText(`docs/adr/${decision}`);
      expect(record, decision).toMatch(/^# .+\n\nStatus: accepted\./u);
      await expectLocalLinksToResolve(
        "docs/adr",
        [...record.matchAll(/\]\(([^)]+)\)/gu)].map((match) => match[1]),
      );
    }
    expect(
      await readText(
        "docs/adr/0006-questionnaire-records-and-dossier-version-2.md",
      ),
    ).toContain(`(${semanticDossierDecision})`);
  });

  it("documents the identity ignore list and the script side effects the kernel enforces", async () => {
    const manual = await readText("docs/badger-workflow-manual.html");
    const decision = await readText(
      "docs/adr/0008-skill-identity-and-registered-roots.md",
    );
    const codes = (text: string | undefined, pattern: RegExp) =>
      [...(text ?? "").matchAll(pattern)].map((match) => match[1]);
    const htmlCode = /<code>([^<]+)<\/code>/gu;
    const markdownCode = /`([^`]+)`/gu;

    for (const heading of [
      '<p data-lang="en"><b>The ignored entries, in full.</b>',
      '<p data-lang="zh" lang="zh-CN"><b>被忽略条目的完整清单。</b>',
    ]) {
      const paragraph = manual.slice(manual.indexOf(heading));
      expect(
        codes(paragraph.slice(0, paragraph.indexOf("</p>")), htmlCode),
        heading,
      ).toEqual([...SKILL_IDENTITY_IGNORE]);
    }
    expect(
      codes(
        decision.match(/stays out of it: (.+?)\. The list is fixed/u)?.[1],
        markdownCode,
      ),
    ).toEqual([...SKILL_IDENTITY_IGNORE]);

    expect(
      codes(
        manual.match(/A script's side effects \(([^)]+)\)/u)?.[1],
        htmlCode,
      ),
    ).toEqual([...SKILL_SCRIPT_SIDE_EFFECTS]);
    expect(
      codes(
        decision.match(
          /`scripts\/` path: one of (.+?), or a list of them/u,
        )?.[1],
        markdownCode,
      ),
    ).toEqual([...SKILL_SCRIPT_SIDE_EFFECTS]);
  });

  it("defines the collaborative service vocabulary once", async () => {
    const glossary = await readText("GLOSSARY.md");
    const terms = [...glossary.matchAll(/^\*\*(.+)\*\*:$/gmu)].map(
      (match) => match[1],
    );

    expect(new Set(terms).size).toBe(terms.length);
    expect(terms).toEqual(
      expect.arrayContaining([
        "Collaborative service",
        "Organization",
        "Group",
        "Field expert",
        "Engineer",
        "Reviewer",
        "Operator",
        "Skill version",
        "Workflow version",
        "Source check",
        "Source study",
        "Question",
        "Round",
        "Answer",
        "Resolution",
        "Fact",
        "Acknowledgement",
        "Drafting job",
        "Personal access token",
        "MCP profile",
        "Notification channel",
        "Group robot",
        "Reminder",
        "Delivery",
        "Gate",
        "Artifact receipt",
        "Run registry",
        "Run",
        "Attempt",
        "Cycle",
        "Evaluation",
        "Project",
      ]),
    );
    expect(glossary).toMatch(
      /^\*\*Source check\*\*:\n.+\n_Avoid_: candidates$/mu,
    );
  });

  it("keeps the workflow manual truthful", async () => {
    const manual = await readText("docs/badger-workflow-manual.html");

    expect(manual).toContain("Integrated authoring delivered");
    expect(manual).toContain("集成式创作已交付");
    expect(manual).toContain("docs/release-artifacts.md");
    expect(manual).not.toContain("Integrated authoring target");
    expect(manual).not.toContain("计划中的创作恢复");
    expect(manual).not.toContain("authoring integration will expose");
    expect(manual).not.toContain(
      "list dashboards and platform integration as out of scope",
    );
    expect(manual).not.toContain("把仪表盘与平台集成列为范围之外");
    for (const decision of [
      semanticDossierDecision,
      ...serviceDecisions,
      ...kernelDecisions,
    ]) {
      expect(manual).toContain(`href="adr/${decision}"`);
    }

    await expectLocalLinksToResolve(
      "docs",
      [...manual.matchAll(/href="([^"]+)"/gu)].map((match) => match[1]),
    );
  });

  it("describes the delivered dashboard shell and platform sign-in outside the plans", async () => {
    const manual = await readText("docs/badger-workflow-manual.html");
    const delivered = manual.slice(0, manual.indexOf('id="service"'));
    const planned = manual.slice(manual.indexOf('id="service"'));

    expect(delivered).toContain('href="#code-web"');
    expect(delivered).toContain('id="code-web"');
    expect(delivered).toContain("platform-session.ts");
    expect(delivered).not.toContain(
      "the dashboard, the Badger MCP, and the rest of §7",
    );
    expect(planned).not.toContain("<code>web</code>, <code>mcp</code>");
    expect(planned).not.toContain("the AI platform's session, OpenID Connect");
  });
});
