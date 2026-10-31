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
  "0019-source-study-records-and-completion.md",
  "0020-answer-resolution-reconfirmation.md",
  "0021-oidc-browser-sessions.md",
  "0022-questionnaire-ledger-and-round-baselines.md",
  "0023-immutable-dossier-versions.md",
  "0024-structured-answer-provenance.md",
  "0025-dossier-bound-plan-versions.md",
  "0026-transactional-notification-delivery.md",
  "0027-transactional-proposal-initialization.md",
  "0028-workflow-version-inheritance.md",
  "0029-registered-git-skill-versions.md",
  "0030-transactional-package-generation.md",
  "0031-transactional-authoring-acceptance.md",
  "0032-isolated-immutable-evaluations.md",
  "0033-immutable-package-publication.md",
  "0034-preview-bound-local-host-installation.md",
  "0035-local-runtime-run-mirroring.md",
  "0036-dashboard-run-gates.md",
  "0037-run-integrity-and-recovery.md",
];
const kernelDecisions = [
  "0007-project-relative-creator-paths.md",
  "0008-skill-identity-and-registered-roots.md",
  "0011-creator-state-bound-to-approved-proposal.md",
  "0014-bundle-source-skills.md",
  "0017-artifact-receipts-and-attempt-freshness.md",
  "0018-run-lock-host-identity.md",
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

  it("pins the receipt and external-root reference and start procedure in both languages", async () => {
    const manual = await readText("docs/badger-workflow-manual.html");
    expect(manual).toContain('href="#ref-receipts"');
    expect(manual).toContain("6.5 Artifact receipts and external roots");
    expect(manual).toContain("6.5 产物回执与外部根目录");
    expect(manual).toContain("Starting a Run with external roots");
    expect(manual).toContain("使用外部根目录启动 Run");
    const reference = manual.slice(
      manual.indexOf('id="ref-receipts"'),
      manual.indexOf('id="service"'),
    );
    const translations = [
      reference.slice(
        reference.indexOf('id="receipts-en"'),
        reference.indexOf('id="receipts-zh"'),
      ),
      reference.slice(reference.indexOf('id="receipts-zh"')),
    ];
    for (const text of translations) {
      for (const term of [
        "32",
        "128",
        "1,000",
        "256",
        "externalRoots",
        "verification",
        "receipt",
        "requireCurrentAttempt",
        "--external-root &lt;name&gt;=&lt;directory&gt;",
        "artifactId",
        "root",
        "path",
        "size",
        "sha256",
        "mtimeMs",
        "producer",
        "artifact-stale-attempt",
        "artifact-content-drift",
        "external-root-binding-required",
        "workflow.start",
        "execute",
        "requiresUserDecision",
        "is not declared by this workflow",
        "needs a directory when the Run starts",
        "must be bound to an absolute directory",
        "directory does not exist",
        "must be a real directory, not a link",
        "with different descriptions",
        "receipt paths must stay relative to the declared root and support only * wildcards",
      ])
        expect(text, term).toContain(term);
    }
    expect(translations[0]).toContain(
      "never copies, writes, or publishes a file",
    );
    expect(translations[0]).toContain(
      "never attests which process wrote a file",
    );
    expect(translations[1]).toContain("从不复制、写入或发布文件");
    expect(translations[1]).toContain("不证明由哪个进程写入了文件");
    const procedure = manual.slice(
      manual.indexOf('id="run-external-roots"'),
      manual.indexOf('id="codebase"'),
    );
    for (const term of [
      "status",
      "startRequirements.externalRoots",
      "init",
      "next",
      'href="#ref-receipts"',
      "confirm",
      "确认",
    ]) {
      expect(procedure).toContain(term);
    }
    const contract = await fs.readFile(
      path.join(
        kernelRoot,
        "assets/skills/badger-create/reference/workflow-contract.md",
      ),
      "utf8",
    );
    for (const text of [
      "what the directory holds",
      "where it usually lives",
      "who owns it",
      "Agent's question",
      "Never give a path",
    ])
      expect(contract).toContain(text);
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
      "(ADRs) 0002–0006, 0009, 0010, 0012, 0013, 0015, 0016, and 0019–0037",
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

  it("describes answer resolutions, threads, and concerns as delivered", async () => {
    const manual = await readText("docs/badger-workflow-manual.html");
    const ledger = await readText("docs/release-artifacts.md");
    const delivered = manual.slice(0, manual.indexOf('id="service"'));
    const planned = manual.slice(manual.indexOf('id="service"'));

    expect(delivered).toContain("Answer resolutions (#48).");
    expect(delivered).toContain("回答结论（#48）。");
    expect(delivered).toContain("Question threads and expert concerns (#47).");
    expect(delivered).toContain("问题讨论串与专家关切（#47）。");
    expect(planned).not.toContain("threads, concerns, ledger composition");
    expect(planned).not.toContain("讨论串、关切、账目编制");
    expect(ledger).toContain("Answer resolutions (#48)");
    expect(ledger).toContain("Question threads and expert concerns (#47)");
  });

  it("describes the ledger, the identity adapters, and the expert MCP as delivered", async () => {
    const manual = await readText("docs/badger-workflow-manual.html");
    const ledger = await readText("docs/release-artifacts.md");
    const delivered = manual.slice(0, manual.indexOf('id="service"'));
    const planned = manual.slice(manual.indexOf('id="service"'));

    expect(delivered).toContain("Ledger and readiness (#49).");
    expect(delivered).toContain("账目与就绪状态（#49）。");
    expect(delivered).toContain("With OpenID Connect (#69)");
    expect(delivered).toContain("使用 OpenID Connect（#69）时");
    expect(delivered).toContain('href="identity-adapters.md"');
    expect(delivered).toContain('href="#code-mcp"');
    expect(delivered).toContain('id="code-mcp"');
    expect(delivered).toContain("Its expert profile (#54) is delivered");
    expect(planned).not.toContain("Delivered (#54)");
    expect(planned).not.toContain("已交付（#54）");
    expect(planned).not.toContain("become read models over these records");
    expect(planned).not.toContain("变成基于这些记录的读模型");
    expect(planned).not.toContain(
      "OpenID Connect, or headers from a trusted proxy",
    );
    expect(ledger).toContain("ledger and readiness (#49)");
    expect(ledger).toContain("OpenID Connect and trusted-header sign-in (#69)");
    expect(ledger).toContain("The Badger MCP's expert profile (#54)");
  });

  it("plans Run storage on macOS and Windows only, after #35 shipped for Linux", async () => {
    const manual = await readText("docs/badger-workflow-manual.html");
    const readme = await readText("packages/kernel/README.md");
    const planned = manual.slice(manual.indexOf('id="service"'));

    expect(planned).not.toContain("issues/35");
    expect(planned).toContain("issues/86");
    expect(readme).toContain("CI runs the Run storage suites on Linux.");
    expect(readme).not.toContain("suites on Linux, macOS, and Windows");
  });

  it("describes dossier, plan, and proposal gates, drafting jobs, structured answers, WeCom notifications, version changes, and Git imports as delivered", async () => {
    const manual = await readText("docs/badger-workflow-manual.html");
    const ledger = await readText("docs/release-artifacts.md");
    const delivered = manual.slice(0, manual.indexOf('id="service"'));
    const planned = manual.slice(manual.indexOf('id="service"'));

    for (const heading of [
      "Dossier versions (#50).",
      "档案版本（#50）。",
      "Drafting jobs (#55).",
      "起草作业（#55）。",
      "Structured answers and attachments (#51).",
      "结构化回答与附件（#51）。",
      "Plan versions (#58).",
      "计划版本（#58）。",
      "Source-study, restatement, translation, and import jobs (#56).",
      "源文件研读、事实重述、问题翻译与导入作业（#56）。",
      "WeCom group robot notifications and reminders (#57).",
      "企业微信群机器人通知与提醒（#57）。",
      "Proposal approval and initialization (#59).",
      "提案批准与初始化（#59）。",
      "Skill and workflow version changes (#52).",
      "Skill 与工作流的版本变化（#52）。",
      "Skill versions from registered Git repositories (#70).",
      "从已注册 Git 仓库导入的 Skill 版本（#70）。",
    ])
      expect(delivered, heading).toContain(`<strong>${heading}</strong>`);
    expect(delivered).toContain(
      "a post to a real team chat has not been checked yet",
    );
    expect(delivered).toContain("尚未在真实的团队群中验证");
    expect(delivered).toContain("and so is its engineer profile (#55)");
    expect(delivered).toContain("工程师 profile（#55）也已交付");
    expect(delivered).toContain('href="../packages/mcp/src/engineer-tools.ts"');
    for (const sentence of [
      "the later gates are to follow them",
      "后续各门槛将沿用这一方式",
      "composing a dossier from the ledger is to follow",
      "由账目编制档案将随后提供",
      "Still to come:",
      "尚待实现的是",
      "the engineer and operator profiles are to follow",
      "工程师和运行者 profile 将随后提供",
      "the other items are to arrive with their records",
      "其他条目将随各自的记录一起到来",
      "is to take the other jobs from its queue too: kernel transitions, evaluations, and notification delivery",
      "Saving sends a test post",
      "保存时会发送一条测试消息",
      // #60–#66 delivered these, so §7 no longer plans them.
      "the Package, Evaluation, and Review and publication gates are to follow them",
      "“软件包”“评估”和“审查与发布”的门槛将沿用这一方式",
      "and so is the operator profile:",
      "以及运行者 profile，将随后提供",
      "Planned (#65):",
      "规划中（#65）",
      "A host installer is to write published packages",
      "宿主安装器将把已发布的软件包",
    ])
      expect(planned, sentence).not.toContain(sentence);
    expect(planned).toContain("WeCom app messages to individuals, email");
    expect(planned).toContain("tested against a stub robot only");

    for (const paragraph of [
      "Dossier versions (#50)",
      "Drafting jobs and the engineer MCP profile (#55)",
      "Structured answers and attachments (#51)",
      "Plan versions (#58)",
      "Source-study, restatement, translation, and import jobs (#56)",
      "WeCom group robot notifications, Remind, and Copy reminder (#57)",
      "Proposal approval and initialization (#59)",
      "Skill and workflow version changes (#52)",
      "Skill versions from registered Git repositories (#70)",
    ])
      expect(ledger, paragraph).toContain(`\n${paragraph} are delivered`);
    expect(ledger).toContain(
      "a post to a real team chat has not been verified",
    );
    expect(ledger).toContain(
      "the expert, engineer, and operator MCP profiles are delivered in `packages/mcp/` (#54, #55, #64, #65, #66, #67)",
    );
    expect(ledger).not.toContain(
      "the other profiles and host installer are planned",
    );
  });

  it("describes #75–#85 and the review fixes of the dossier through Git import tickets as delivered", async () => {
    const manual = await readText("docs/badger-workflow-manual.html");
    const ledger = (await readText("docs/release-artifacts.md")).replace(
      /\s+/gu,
      " ",
    );
    const delivered = manual.slice(0, manual.indexOf('id="service"'));

    for (const sentence of [
      // #81–#84 in the identity row, #80 in the Skills row.
      "it is stored with the sign-in transaction on the server (#81)",
      "它随登录事务保存在服务端（#81）",
      "<code>BADGER_OIDC_MAX_PENDING_SIGN_INS</code>, 10,000 by default, caps pending sign-ins: a start beyond it evicts the oldest and is never refused (#82)",
      "自身从不被拒绝（#82）",
      "so two tabs can sign in at once, in either order (#83)",
      "两个标签页可以同时登录，并以任意顺序完成（#83）",
      "A display name sent once may contain commas; the subject and email still refuse them (#84)",
      "只发送一次的显示名可以包含逗号；主体和邮箱仍拒绝逗号（#84）",
      "a path with a <code>.git</code> segment is refused too, with a message that suggests uploading <code>git archive</code> output instead (#80)",
      "提示信息建议改为上传 <code>git archive</code> 的输出（#80）",
      // #77 and #75 in the ledger paragraph.
      "refuses a malformed record before computing any ledger, with an error that names the record's kind, ID, and problem (#77)",
      "错误信息写明该记录的类别、ID 和问题所在（#77）",
      "read their records under the version lock that every questionnaire writer takes",
      "the request answers 503 with <code>Retry-After</code>, never 500 (#75)",
      "该请求以 503 和 <code>Retry-After</code> 答复，从不返回 500（#75）",
      // Review fixes in the nine tickets' paragraphs.
      "The latest entry in an append-only list of heads names the current version",
      "content identical to an earlier version selects that version again",
      "当前版本由一份只追加的指针列表中最新的一条指明",
      "As with dossiers, the latest head names the current plan version",
      "与档案一样，当前计划版本由最新的一条指针指明",
      "the exact files of the pinned Skills its kind reads",
      "A claim whose files exceed twice the upload limit is refused with 413, and the job stays queued",
      "领取的文件总量超过上传上限的两倍时，以 413 拒绝",
      "the job is cancelled only when the inputs its kind reads change",
      "importing it again is refused with 409",
      "再次导入会以 409 拒绝",
      "Saving a robot is refused until the deployment sets <code>BADGER_NOTIFICATION_KEY</code> and <code>BADGER_PUBLIC_URL</code>",
      "保存机器人会被拒绝",
      'a pending invitee as "Invited person" and never by email address',
      "尚待接受邀请的人称为“Invited person”",
      "after a rate-limited answer it waits at least 60 seconds, and rate-limited attempts do not use up the five",
      "遇到限流答复时至少等待 60 秒，限流的尝试不计入这五次",
      "a Group default's posts, test posts included, are recorded with that Group",
      "a Remind whose post would reach nobody records nothing and offers Copy reminder instead",
      "the Workflow owner's approval of the current proposal supersedes the stale one",
      "工作流负责人对当前提案的批准会取代过时的那次批准",
      "failed and cancelled jobs are audited too",
      "audited as <code>workflow_version.inherited</code>",
      "并以 <code>workflow_version.inherited</code> 写入审计",
      "Pending questionnaire inbox items move to the new version",
      "a URL with <code>?</code> or <code>#</code> is refused",
      "Git LFS content is refused",
      "Git LFS 内容会被拒绝",
      "A server process runs at most two fetches at once and refuses another with 503 and <code>Retry-After</code>",
      // The dashboard.
      "Retire asks first, naming the draft's kind and saying that a retired draft cannot be revised and leaves the ledger and readiness (#76)",
      "“停用”会先请求确认",
      "list every approval, marking the superseded ones (#52)",
      "并标出已被取代的批准（#52）",
      "whose text it writes in the viewer's language with an absolute link",
      "复制的文字使用查看者的语言，并带有绝对链接",
      "shown with the Group's own Delivery log (#57)",
      "并查看该组自己的投递日志（#57）",
      // The Badger MCP.
      "<code>upload_attachment</code> reads a local file and checks the person's assignment, the question revision, and the service's type and size limits before sending it (#51)",
      "A folder that holds a <code>.git</code> folder is refused before any file is read (#80)",
      "含有 <code>.git</code> 文件夹的文件夹在读取任何文件之前就会被拒绝（#80）",
      "a file whose path has a <code>.git</code> component, in any letter case, is refused, so the claim writes nothing and is released",
      "此时领取不写入任何内容并释放作业",
      'href="../packages/mcp/src/attachments.ts"',
    ])
      expect(delivered, sentence).toContain(sentence);
    for (const superseded of [
      "composing identical content returns the existing version",
      "内容相同的编制返回已有版本",
      "A new version asks the Workflow owner for approval",
      "新版本会请工作流负责人批准",
      "the exact pinned Skill files",
      "30 分钟的租约和固定 Skill 的原样文件",
      "输出 Schema 和固定 Skill 的原样文件",
      "An expired lease returns the job to the queue, and changed inputs cancel it.",
      "租约过期后作业回到队列，输入变化则作业取消。",
      "A new plan supersedes that approval",
      "新的计划会取代这次批准",
      "Saving queues a test post.",
      "保存时会排入一条测试消息。",
      "records each post in a Delivery log that the Workflow owner and Administrators read",
      "每条消息都记入投递日志，供工作流负责人和管理员查看",
      "resolutions, and linked drafts in one locked transaction",
      "处理结论和关联草稿；",
      "saving and submitting answers, comments, concerns",
      "保存与提交回答、评论、关切",
      "Reading a Skill folder (regular files only, within the service's limits) and keeping",
      "读取 Skill 文件夹（只读普通文件，并遵守服务端的限制），并把",
      // #89 added the reachability check.
      "and Badger does not check that yet",
      "而 Badger 目前还不检查这一点",
    ])
      expect(manual, superseded).not.toContain(superseded);

    for (const sentence of [
      "Consistent ledger reads (#75) are delivered in the server",
      "Retire confirmation (#76) is delivered in the dashboard",
      "Questionnaire record checks (#77) are delivered in the kernel",
      "Agent hosts on token writes (#79) are delivered in the server and the Activity page: token writes record the Agent host",
      "The `.git` refusal in Skill uploads (#80) is delivered in the server, the Skills page, and the expert MCP profile",
      "Return to the requested page after OpenID Connect sign-in (#81) is delivered in the server",
      "Bounded pending sign-ins (#82) are delivered in the server",
      "Concurrent sign-ins (#83) are delivered in the server",
      "Comma-bearing display names (#84) are delivered in the trusted-header adapter",
      "The dashboard declares its type-only kernel dependency (#78), and server tests now cover OpenID Connect provider timeouts and IPv4-mapped proxy peers (#85)",
      "consistent ledger reads (#75), questionnaire record checks (#77)",
      "retire confirmation (#76), declared kernel dependency (#78)",
      "`.git` refusal in Skill folders (#80)",
      "The latest of the append-only heads names the current version",
      "append-only heads name the current plan version",
      "cancellation only when the inputs a job's kind reads change",
      "A claim larger than twice the upload limit is refused with 413",
      "`upload_attachment` checks a local file's type and size",
      "a numbered source question enters a workflow version at most once; a repeat gets 409",
      "saved only once the deployment sets `BADGER_NOTIFICATION_KEY` and `BADGER_PUBLIC_URL`",
      'a pending invitee is named "Invited person", never by email address',
      "the owner's approval of the current proposal supersedes the stale one",
      "records `workflow_version.inherited`",
      "Since #89 an import also needs a branch or tag of the repository that reaches the commit",
    ])
      expect(ledger, sentence).toContain(sentence);
    for (const superseded of [
      "cancellation on changed inputs",
      "claiming writes the context and the exact pinned Skill files to a private local folder",
      "Migration `0016` adds the table;",
      "Migration `0019` adds the table;",
      "retried with backoff through the deployment's proxy, a Delivery log, personal mention preferences",
      "with provenance to their origins, then queues its own source check",
      "Structured answers and attachments (#51) are delivered in the server and the Questionnaire page",
      "checking reachability is a follow-up",
    ])
      expect(ledger, superseded).not.toContain(superseded);
  });

  it("describes #60–#67, #71, and #89 as delivered and keeps #68 open", async () => {
    const manual = await readText("docs/badger-workflow-manual.html");
    const ledger = await readText("docs/release-artifacts.md");
    const flat = (text: string) => text.replace(/\s+/gu, " ");
    const kernelReadme = flat(await readText("packages/kernel/README.md"));
    const readme = flat(await readText("README.md"));
    const webReadme = flat(await readText("packages/web/README.md"));
    const runMirroring = flat(
      await readText("docs/adr/0035-local-runtime-run-mirroring.md"),
    );
    const delivered = manual.slice(0, manual.indexOf('id="service"'));
    const planned = manual.slice(manual.indexOf('id="service"'));

    for (const heading of [
      "Package scaffold generation (#60).",
      "软件包脚手架生成（#60）。",
      "Authoring lanes and assembly (#61).",
      "创作 lane 与组装（#61）。",
      "Evaluations (#62).",
      "评估（#62）。",
      "Package review and publication (#63).",
      "软件包审查与发布（#63）。",
      "Runs mirrored from the Badger MCP (#65).",
      "从 Badger MCP 同步的 Run（#65）。",
      "Run gates (#66).",
      "Run 门槛（#66）。",
      "Run integrity and recovery (#67).",
      "Run 完整性与恢复（#67）。",
      "Run recovery (#67).",
      "Run 恢复（#67）。",
      "Read-only demo (#71).",
      "只读演示（#71）。",
      "Operator profile (#64, #65, #66).",
      "运行者 profile（#64、#65、#66）。",
      "Certification in MCP mode (#65).",
      "MCP 模式下的认证（#65）。",
    ])
      expect(delivered, heading).toContain(`<strong>${heading}</strong>`);
    for (const sentence of [
      'id="code-hosts"',
      'href="#code-hosts"',
      'href="../packages/hosts/src/index.ts"',
      'href="../packages/server/src/generation.ts"',
      'href="../packages/server/src/run-gates.ts"',
      'href="../packages/mcp/src/operator-tools.ts"',
      'href="../packages/web/src/pages/RunsPage.tsx"',
      'href="../packages/server/src/run-integrity.ts"',
      'href="../packages/web/e2e/run-integrity.spec.ts"',
      'href="../packages/mcp/test/run-integrity.test.ts"',
      // #67 moved out of §7.5 into §5.4–§5.6.
      "The service flags a decision with no matching gate answer, a gap in the event sequence, and an execution that differs from the published package as findings on the Run",
      "若出现没有对应门槛回答的决策、事件序列有缺口，或执行与已发布软件包不同，服务都会把它作为 finding 标记在 Run 上",
      "A Run that needs recovery (#67) is marked in the Runs list and on its page",
      "需要恢复的 Run（#67）在 Run 列表和其详情页上都有标记",
      "<code>.badger/mcp-recovery.json</code>",
      "its operator profile installs published workflows (#64) and runs them (#65, #66)",
      "其运行者 profile 安装已发布的工作流（#64）并运行它们（#65、#66）",
      "Only <code>start</code> takes <code>externalRoots</code>",
      // #89 in §3.2, §4.5, and the server's paragraphs.
      "Each source is identified by its Project-relative location and its content hash",
      "as often as one transition can replace it, instead of failing (#89)",
      "Each person may leave at most eight unreferenced uploads",
      "refuses a commit that none of them reaches",
      "<code>BADGER_GIT_PROXY</code> sends Git fetches through an HTTP or HTTPS proxy",
      "in upper and lower case, as build arguments",
      // #68 is a human acceptance ticket that stays open.
      "has not been verified in the real host yet (#68",
      "尚未在真实宿主中验证（#68",
    ])
      expect(delivered, sentence).toContain(sentence);
    for (const stale of [
      "the operator profile of §7.5 is not built yet",
      "§7.5 的运行者 profile 尚未实现",
      "The other pages hold placeholders",
      "其余页面在 §7 的记录落地之前只放置占位内容",
      "the records that move the rest arrive with §7.3",
      "推动其余阶段的记录随 §7.3 一起到来",
      "workspace package joins the kernel",
      "certification exercises the runtime and the scripts, not a live MCP",
    ])
      expect(delivered, stale).not.toContain(stale);

    // The remaining engineer tools and the laptop verification stay planned.
    for (const sentence of [
      "Jobs for dossier drafts are to follow on the same terms.",
      "is still to gain dossier and proposal previews",
      "is still to be verified in the real host",
      "#24 was first split into the sub-issues #25–#72",
      "#24 最初拆成子 issue #25–#72",
    ])
      expect(planned, sentence).toContain(sentence);
    for (const landed of [
      "is to serve the API for the later stages and Runs",
      "is to take the other jobs from its queue too",
      "the service adds one more npm workspace package",
      "Jobs for dossier drafts, authoring lanes in Wave order, and review votes are to follow",
      "evaluation is to run as a sandboxed worker job",
      "Items and posts for Runs and the later stages are to arrive with their records",
      "Run 和后续阶段的条目与消息将随各自的记录一起到来",
      // #67 is delivered (§5.4–§5.6).
      "The service flags a decision with no matching gate answer, a gap in the event sequence, and a package hash that differs from the published one.",
      "若出现没有对应门槛回答的决策、事件序列有缺口，或软件包哈希与已发布版本不同，服务都会标记出来。",
      "48 sub-issues",
      "48 个子 issue",
    ])
      expect(planned, landed).not.toContain(landed);
    expect(manual).not.toContain(
      "checks of each Run's events against the service's records",
    );
    expect(manual).not.toContain("按服务的记录核对每个 Run 的事件");

    for (const paragraph of [
      "Authoring lanes, review votes, and assembly (#61)",
      "Sandboxed evaluations (#62)",
      "Package review and publication (#63)",
      "Runs through the local Badger MCP (#65)",
      "Run gates (#66)",
      "Review follow-ups (#89)",
    ])
      expect(ledger, paragraph).toContain(`\n${paragraph} are delivered`);
    for (const paragraph of [
      "Package scaffold generation (#60)",
      "Host installation (#64)",
      "Run integrity and recovery (#67)",
      "Demo mode (#71)",
    ])
      expect(ledger, paragraph).toContain(`\n${paragraph} is delivered`);
    expect(ledger).toContain("laptop checks prepared but not yet verified");
    expect(ledger).not.toContain("Runtime Run tools follow separately");
    expect(kernelReadme).not.toContain("Runtime Run tools follow separately");
    expect(kernelReadme).not.toContain("Run integrity (#67) and WorkBuddy");
    expect(kernelReadme).toContain(
      "and Run integrity and recovery (#67), with demo mode (#71)",
    );
    expect(runMirroring).not.toContain("answer delivery is implemented");
    expect(runMirroring).not.toContain("remain separate work");
    expect(runMirroring).toContain(
      "[ADR 0037](0037-run-integrity-and-recovery.md)",
    );
    expect(webReadme).toContain(
      "Workflows, Questionnaire, Skills, Runs, Evaluations, Activity, Admin, and Settings",
    );
    expect(webReadme).not.toContain("replaces the token placeholder");
    for (const ticket of ["#62", "#63", "#64", "#65", "#66", "#67"])
      expect(webReadme, ticket).toContain(`(${ticket})`);
    expect(readme).not.toContain("Evaluation and review gates follow.");
    expect(readme).not.toContain("Future extensions (#24)");
  });
});
