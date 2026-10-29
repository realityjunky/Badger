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
  "0012-workflow-frames-and-workflow-bindings.md",
  "0013-uploaded-skill-versions.md",
  "0015-pinned-skill-versions-and-source-check-jobs.md",
  "0016-gate-confirmations-and-inbox.md",
];
const kernelDecisions = [
  "0007-project-relative-creator-paths.md",
  "0008-skill-identity-and-registered-roots.md",
  "0011-creator-state-bound-to-approved-proposal.md",
  "0014-bundle-source-skills.md",
  "0017-artifact-receipts-and-attempt-freshness.md",
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

  it("documents the approved-proposal binding in the packaged contract", async () => {
    const creator = await readText(
      "packages/kernel/assets/skills/badger-create/SKILL.md",
    );
    const lifecycle = await readText(
      "packages/kernel/assets/skills/badger-create/reference/lifecycle.md",
    );
    const manual = await readText("docs/badger-workflow-manual.html");
    const readme = await readText("packages/kernel/README.md");

    for (const prose of [creator, manual]) {
      expect(prose).toContain("--proposal");
      expect(prose).toContain("--replace-state");
    }
    expect(creator).toMatch(/generate <name> --confirm/u);
    expect(readme).toMatch(/badger\.js generate \S+ --confirm/u);
    expect(lifecycle).toContain("proposal hash");
    expect(creator).toMatch(
      /Wait for separate explicit confirmation of generation before running\s+`badger generate <name> --confirm/u,
    );
    expect(manual).toContain(
      "class Generate,Lanes,Assemble,Approve,Publish,Distribute write;",
    );
    expect(manual).not.toContain("class Generate,Eval,Review check;");
    // The binding is delivered, so §7, which lists only what is not built,
    // no longer carries its ticket.
    const planned = manual.slice(manual.indexOf('id="service"'));
    expect(planned).not.toContain("issues/27");
    expect(planned).not.toContain("re-read the plan file");
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
        "Role binding",
        "Invitation",
        "Administrator",
        "Auditor",
        "Group lead",
        "Member",
        "Activity log",
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

  it("describes the delivered groups, roles, and bindings outside the plans", async () => {
    const manual = await readText("docs/badger-workflow-manual.html");
    const delivered = manual.slice(0, manual.indexOf('id="service"'));
    const planned = manual.slice(manual.indexOf('id="service"'));

    expect(delivered).toContain("bindings.ts");
    expect(delivered).toContain("BADGER_PLATFORM_ADMIN_MAPPING");
    expect(delivered).toContain("presents that address as verified");
    expect(planned).toContain(
      "(ADRs) 0002–0006, 0009, 0010, 0012, 0013, 0015, and 0016",
    );
    expect(planned).not.toContain("bind people by email; a binding takes");
    expect(planned).not.toContain("inherited by its nested groups");
    expect(planned).not.toContain("every write is audited with its actor");
  });

  it("describes the delivered workflows and Skill versions outside the plans", async () => {
    const manual = await readText("docs/badger-workflow-manual.html");
    const ledger = await readText("docs/release-artifacts.md");
    const delivered = manual.slice(0, manual.indexOf('id="service"'));
    const planned = manual.slice(manual.indexOf('id="service"'));

    expect(delivered).toContain("workflow-access.ts");
    expect(delivered).toContain("src/skills/");
    expect(delivered).toContain("The Workflows page lists the catalog");
    expect(delivered).toContain("工作流页面列出工作流目录");
    expect(planned).not.toContain("the table adds the workflow roles");
    expect(planned).not.toContain("下表补充工作流角色");
    expect(ledger).toContain(
      "workflows and versions (#41), Skill versions (#42)",
    );
    expect(ledger).toContain("docs/backup-and-restore.md");
  });

  it("describes bundled source Skills and personal access tokens as delivered", async () => {
    const manual = await readText("docs/badger-workflow-manual.html");
    const ledger = await readText("docs/release-artifacts.md");
    const delivered = manual.slice(0, manual.indexOf('id="service"'));
    const planned = manual.slice(manual.indexOf('id="service"'));

    expect(delivered).toContain("sources/&lt;hash&gt;/");
    expect(delivered).toContain("src/tokens.ts");
    expect(delivered).toContain("/api/v1/me/tokens");
    expect(delivered).toContain("供 Agent 和 CLI 使用的个人访问令牌（#53）");
    expect(planned).not.toContain("Packages do not bundle their source Skills");
    expect(planned).not.toContain("软件包不内置其源 Skill");
    expect(ledger).toContain("personal access tokens (#53)");
  });

  it("describes Skill pins and source checks as delivered", async () => {
    const manual = await readText("docs/badger-workflow-manual.html");
    const ledger = await readText("docs/release-artifacts.md");
    const delivered = manual.slice(0, manual.indexOf('id="service"'));
    const planned = manual.slice(manual.indexOf('id="service"'));

    expect(delivered).toContain("src/workflow-source.ts");
    expect(delivered).toContain("src/worker.ts");
    expect(delivered).toContain("pins, latest source check, and jobs");
    expect(delivered).toContain("Skill 固定与来源检查（#43）");
    expect(planned).not.toContain("Each workflow version gets its own kernel");
    expect(planned).not.toContain("每个工作流版本都有自己的内核工作区");
    expect(ledger).toContain("Skill pins and source checks (#43)");
  });

  it("describes the Sources gate, the inbox, artifact receipts, and MCP mode as delivered", async () => {
    const manual = await readText("docs/badger-workflow-manual.html");
    const ledger = await readText("docs/release-artifacts.md");
    const delivered = manual.slice(0, manual.indexOf('id="service"'));
    const planned = manual.slice(manual.indexOf('id="service"'));

    expect(delivered).toContain("src/gates.ts");
    expect(delivered).toContain("/api/v1/me/inbox");
    expect(delivered).toContain("“来源”门槛与应用内收件箱（#44）");
    expect(delivered).toContain("evidence.artifactReceipts");
    expect(delivered).toContain("artifact-stale-attempt");
    expect(delivered).toContain("Runtime Access section for two host modes");
    expect(delivered).toContain("涵盖两种宿主模式（#34）");
    expect(planned).not.toContain("issues/31");
    expect(planned).not.toContain("issues/34");
    expect(planned).not.toContain("now prefer the Badger MCP Run tools");
    expect(ledger).toContain("Sources gate and inbox (#44)");
    expect(ledger).toContain("Artifacts by receipt (#31)");
  });
});
