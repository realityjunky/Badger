import { reportLaneOutput } from "../../server/test/fixtures/authoring.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type { FactoryPlan, PlanView } from "../src/api/plans.js";
import type { ProposalView } from "../src/api/proposals.js";
import type { PackageView } from "../src/api/packages.js";
import {
  startTestService,
  type TestService,
} from "@realityjunky/badger-server/testing";

const origin = "http://127.0.0.1:4324";
const base = `${origin}/team`;
const admin = { subject: "admin", email: "admin@example.com" };
const engineer = { subject: "engineer", email: "engineer@example.com" };
const owner = { subject: "owner", email: "owner@example.com" };
let service: TestService;

test.beforeAll(async () => {
  service = await startTestService({
    environment: {
      BADGER_PORT: "4324",
      BADGER_BASE_PATH: "/team",
      BADGER_WEB_DIR: path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../dist",
      ),
      BADGER_BOOTSTRAP_ADMINISTRATORS: admin.email,
      BADGER_ALLOWED_ORIGINS: origin,
    },
  });
});
test.afterAll(async () => service?.close());

async function call<T>(
  method: string,
  route: string,
  body?: unknown,
  as = engineer,
): Promise<T> {
  const response = await service.request(`/team/api/v1${route}`, {
    as,
    method,
    headers: { origin, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  expect(response.ok, JSON.stringify(value)).toBe(true);
  return value as T;
}
async function confirm(root: string, gate: string) {
  const { preview } = await call<{ preview: { confirmationHash: string } }>(
    "POST",
    `${root}/gates/${gate}/preview`,
    {},
  );
  await call("POST", `${root}/gates/${gate}/commit`, {
    confirmationHash: preview.confirmationHash,
    requestId: crypto.randomUUID(),
  });
}
async function english(page: Page) {
  await page.getByTestId("language-switch").click();
  await page.getByRole("menuitem", { name: "English", exact: true }).click();
}

test.setTimeout(90_000);

for (const theme of ["light", "dark"] as const) {
  test(`the Engineer accepts a plan draft and the owner approves dossier and plan, then sees supersession (${theme})`, async ({
    browser,
  }, info) => {
    const { group } = await call<{ group: { id: string } }>(
      "POST",
      "/groups",
      { name: `Dossier ${Date.now()}` },
      admin,
    );
    const { workflow, version } = await call<{
      workflow: { id: string; name: string };
      version: { id: string };
    }>(
      "POST",
      "/workflows",
      {
        groupId: group.id,
        name: `dossier-${Date.now()}`,
        goal: "Prepare a reviewed report.",
        intent: "new-skill",
        locale: "en",
      },
      admin,
    );
    for (const [person, role] of [
      [engineer, "Engineer"],
      [owner, "Workflow owner"],
    ] as const)
      await call(
        "POST",
        "/bindings",
        {
          scopeType: "workflow",
          scopeId: workflow.id,
          email: person.email,
          role,
        },
        admin,
      );
    const root = `/workflows/${workflow.id}/versions/${version.id}`;
    const skillName = `report-${Date.now()}`;
    const { skill } = await call<{ skill: { id: string } }>(
      "POST",
      "/skills",
      { groupId: group.id, name: skillName },
      admin,
    );
    const text = `---\nname: ${skillName}\ndescription: Prepare a report\n---\n\nReturn report text.\n`;
    const files = [
      { path: "SKILL.md", content: Buffer.from(text).toString("base64") },
    ];
    const { preview: upload } = await call<{ preview: { hash: string } }>(
      "POST",
      `/skills/${skill.id}/upload-preview`,
      { files },
    );
    await call("POST", `/skills/${skill.id}/versions`, {
      files,
      confirmed: true,
      expectedHash: upload.hash,
    });
    const pin = { skillId: skill.id, hash: upload.hash };
    await call("POST", `${root}/pins`, pin);
    await service.runSourceCheckJobs();
    await confirm(root, "sources");
    const content = {
      statement: "The source returns report text.",
      evidence: [
        {
          ...pin,
          path: "SKILL.md",
          startLine: 6,
          endLine: 6,
          fileHash: createHash("sha256").update(text).digest("hex"),
        },
      ],
    };
    const { record } = await call<{ record: { id: string } }>(
      "POST",
      `${root}/source-study/facts`,
      content,
    );
    await confirm(root, `source-study/${skill.id}`);
    const { handoff } = await call<{
      handoff: { readiness: { topic: string }[] };
    }>("GET", `${root}/questionnaire/ledger`);
    const semanticTopic = {
      summary: "Return the report; no additional behavior applies.",
      factIds: [record.id],
    };
    const semantics = {
      nodes: [{ id: "report", order: 0, responsibility: semanticTopic }],
      topics: Object.fromEntries(
        handoff.readiness
          .filter((r) => r.topic !== "scope")
          .map((r) => [r.topic, semanticTopic]),
      ),
    };
    const { composition } = await call<{ composition: { hash: string } }>(
      "POST",
      `${root}/dossier/preview`,
      semantics,
    );
    await call("POST", `${root}/dossier/compose`, {
      ...semantics,
      confirmationHash: composition.hash,
    });

    const authorContext = await browser.newContext({
      colorScheme: theme,
      extraHTTPHeaders: { "x-badger-test-person": JSON.stringify(engineer) },
    });
    const ownerContext = await browser.newContext({
      colorScheme: theme,
      extraHTTPHeaders: { "x-badger-test-person": JSON.stringify(owner) },
    });
    try {
      const author = await authorContext.newPage();
      await author.goto(
        `${base}/workflows/${workflow.id}/versions/${version.id}#dossier`,
      );
      await english(author);
      const authorDossier = author.getByTestId("workflow-dossier");
      await authorDossier
        .getByRole("button", { name: "Compose dossier", exact: true })
        .click();
      const compose = author.getByRole("dialog");
      await compose
        .getByLabel("Inputs summary", { exact: true })
        .fill("The report has no runtime input beyond the agreed scope.");
      await compose
        .getByRole("button", { name: "Review composition", exact: true })
        .click();
      await compose
        .getByRole("button", { name: "Inputs", exact: true })
        .click();
      await expect(
        compose.getByText(
          "The report has no runtime input beyond the agreed scope.",
          { exact: true },
        ),
      ).toBeVisible();
      await compose
        .getByRole("button", { name: "Compose this version", exact: true })
        .click();
      await expect(compose).toBeHidden();

      const { versions } = await call<{ versions: { hash: string }[] }>(
        "GET",
        `${root}/dossier`,
      );
      const page = await ownerContext.newPage();
      await page.goto(
        `${base}/workflows/${workflow.id}/versions/${version.id}#dossier`,
      );
      await english(page);
      const dossier = page.getByTestId("workflow-dossier");
      await expect(
        dossier.getByRole("button", { name: "Compose dossier", exact: true }),
      ).toHaveCount(0);
      await dossier
        .getByRole("button", { name: "Review dossier approval", exact: true })
        .click();
      const review = page.getByRole("dialog");
      await expect(
        review.getByText(versions[0]!.hash, { exact: true }).first(),
      ).toBeVisible();
      await expect(
        review.getByText(content.statement, { exact: true }),
      ).toBeVisible();
      await review
        .getByRole("button", { name: "Approve this version", exact: true })
        .click();
      await expect(review).toBeHidden();
      await expect(
        page
          .getByTestId("workflow-dossier")
          .getByText("Dossier approved", { exact: true }),
      ).toBeVisible();
      const history = await call<{
        confirmation: { boundHashes: { dossier: string } };
      }>("GET", `${root}/gates/dossier`, undefined, owner);
      expect(history.confirmation.boundHashes.dossier).toBe(versions[0]!.hash);
      const screenshot = info.outputPath(`dossier-${theme}.png`);
      await page
        .getByTestId("workflow-dossier")
        .screenshot({ path: screenshot });
      await info.attach(`dossier-${theme}`, {
        path: screenshot,
        contentType: "image/png",
      });

      await author.goto(
        `${base}/workflows/${workflow.id}/versions/${version.id}#plan`,
      );
      const planning = author.getByTestId("workflow-plan");
      const draftsTab = planning.getByRole("tab", {
        name: "Plan drafting jobs and suggestions",
      });
      await expect(draftsTab).toHaveAttribute("aria-selected", "true");
      await expect(
        planning.getByText("No plan drafting jobs yet."),
      ).toBeVisible();
      await planning.getByRole("tab", { name: "Hashes", exact: true }).click();
      await expect(
        planning.getByRole("tabpanel", { name: "Hashes" }),
      ).toHaveText("No plan version has been saved yet.");
      await planning
        .getByRole("button", { name: "About drafting jobs and suggestions" })
        .hover();
      await expect(author.getByRole("tooltip")).toHaveText(
        "Queue a drafting job for your Agent using the approved dossier, skeleton, and pinned Skill versions. Its result stays a suggestion until you accept it.",
      );
      await planning
        .getByRole("button", { name: "Request plan draft", exact: true })
        .click();
      await expect(draftsTab).toHaveAttribute("aria-selected", "true");
      await expect(
        planning.getByRole("tabpanel", {
          name: "Plan drafting jobs and suggestions",
        }),
      ).toContainText("Plan draft");
      await expect(author.getByRole("dialog")).toHaveCount(0);
      const { jobs } = await call<{
        jobs: { id: string; revision: number; kind: string }[];
      }>("GET", `${root}/drafting-jobs`);
      const drafts = jobs.filter((job) => job.kind === "draft-plan");
      expect(drafts).toHaveLength(1);
      const job = drafts[0]!;
      const { secret } = await call<{ secret: string }>("POST", "/me/tokens", {
        name: "Planning Agent",
        scopes: ["engineer"],
      });
      async function agentCall<T>(route: string, body: unknown): Promise<T> {
        const response = await service.request(`/team/api/v1${route}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${secret}`,
            "x-badger-agent-host": "Planning Agent",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
        const value = await response.json();
        expect(response.ok, JSON.stringify(value)).toBe(true);
        return value as T;
      }
      const claimed = await agentCall<{
        job: { contextHash: string; lease: { id: string } };
        contextBundle: { planning: { skeleton: FactoryPlan } };
      }>(`${root}/drafting-jobs/${job.id}/claim`, { revision: job.revision });
      const plan = claimed.contextBundle.planning.skeleton;
      plan.workflow.customNodes[0]!.implementation.skill = skillName;
      const saved = await agentCall<{
        job: { revision: number; status: string };
      }>(`${root}/drafting-jobs/${job.id}/submit`, {
        leaseId: claimed.job.lease.id,
        contextHash: claimed.job.contextHash,
        result: { plan },
        keepClaim: true,
      });
      expect(saved.job.status).toBe("claimed");
      expect((await call<PlanView>("GET", `${root}/plan`)).versions).toEqual(
        [],
      );
      await expect(
        planning.getByText("Draft saved.", { exact: false }),
      ).toBeVisible({ timeout: 10_000 });
      const suggestion = planning.getByRole("button", {
        name: "Review plan suggestion",
        exact: true,
      });
      await expect(suggestion).toHaveCount(0);
      await agentCall(`${root}/drafting-jobs/${job.id}/finish`, {
        leaseId: claimed.job.lease.id,
        contextHash: claimed.job.contextHash,
        revision: saved.job.revision,
      });
      await expect(suggestion).toBeVisible({ timeout: 10_000 });
      await suggestion.click();
      const editor = author.getByRole("dialog");
      const json = editor.getByLabel("FactoryPlan (JSON)", { exact: true });
      await json.fill(
        JSON.stringify({ ...plan, goal: "Unapproved scope" }, null, 2),
      );
      await expect(
        editor.getByText("goal: Dossier contradicts FactoryPlan", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        editor.getByRole("button", {
          name: "Review plan version",
          exact: true,
        }),
      ).toBeDisabled();
      plan.workflow.customNodes[0]!.label = "Prepare the reviewed report";
      await json.fill(JSON.stringify(plan, null, 2));
      await expect(
        editor.getByText("The kernel found no plan blockers.", { exact: true }),
      ).toBeVisible();
      await editor
        .getByRole("button", { name: "Review plan version", exact: true })
        .click();
      await author
        .getByRole("dialog")
        .getByRole("button", { name: "Accept as a plan version", exact: true })
        .click();
      await expect(author.getByRole("dialog")).toBeHidden();
      const plans = await call<PlanView>("GET", `${root}/plan`);
      expect(plans.versions).toHaveLength(1);
      expect(
        plans.versions[0]!.snapshot.plan.workflow.customNodes[0]!.label,
      ).toBe("Prepare the reviewed report");
      await page.goto(
        `${base}/workflows/${workflow.id}/versions/${version.id}#plan`,
      );
      const ownerPlan = page.getByTestId("workflow-plan");
      await expect(
        ownerPlan.getByRole("tab", {
          name: "Plan drafting jobs and suggestions",
        }),
      ).toHaveAttribute("aria-selected", "true");
      await ownerPlan.getByRole("tab", { name: "Canonical plan JSON" }).click();
      const planJson = ownerPlan.getByRole("tabpanel", {
        name: "Canonical plan JSON",
      });
      await planJson.getByLabel("Show exact canonical text").check();
      expect(await planJson.locator("pre").textContent()).toBe(
        plans.versions[0]!.canonicalJson,
      );
      await ownerPlan
        .getByRole("tab", { name: "Node responsibilities" })
        .click();
      await expect(
        ownerPlan.getByRole("tabpanel", { name: "Node responsibilities" }),
      ).toContainText("Prepare the reviewed report");
      await ownerPlan.getByRole("tab", { name: "Hashes", exact: true }).click();
      const hashes = ownerPlan.getByRole("tabpanel", { name: "Hashes" });
      await expect(hashes).toContainText(plans.versions[0]!.hash);
      await expect(hashes).toContainText(
        plans.versions[0]!.snapshot.dossierHash,
      );
      await expect(
        ownerPlan.getByRole("button", { name: "Edit plan", exact: true }),
      ).toHaveCount(0);
      await ownerPlan
        .getByRole("button", { name: "Review plan approval", exact: true })
        .click();
      const approvalDialog = page.getByRole("dialog");
      await expect(
        approvalDialog.getByText(plans.versions[0]!.hash, { exact: true }),
      ).toBeVisible();
      await approvalDialog
        .getByRole("button", { name: "Approve this plan", exact: true })
        .click();
      await expect(approvalDialog).toBeHidden();
      await expect(
        ownerPlan.getByText("Plan approved", { exact: true }),
      ).toBeVisible();
      const planScreenshot = info.outputPath(`plan-${theme}.png`);
      await ownerPlan.screenshot({ path: planScreenshot });
      await info.attach(`plan-${theme}`, {
        path: planScreenshot,
        contentType: "image/png",
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);

      await page.goto(`${base}${root}#proposal`);
      const proposalPanel = page.getByTestId("workflow-proposal");
      const aboutProposal = proposalPanel.getByRole("button", {
        name: "About proposal approval and initialization",
      });
      await aboutProposal.hover();
      await expect(page.getByRole("tooltip")).toHaveText(
        "Review the workflow and pinned sources the kernel resolved from the approved plan. The Workflow owner approves this proposal before project initialization.",
      );
      await proposalPanel
        .getByRole("button", { name: "Review proposal approval", exact: true })
        .click();
      const proposalView = await call<ProposalView>("GET", `${root}/proposal`);
      const proposalDialog = page.getByRole("dialog");
      await expect(
        proposalDialog.getByText(proposalView.proposal!.proposalHash, {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        proposalDialog.getByText(upload.hash, { exact: true }),
      ).toBeVisible();
      await proposalDialog
        .getByRole("button", { name: "Approve this proposal", exact: true })
        .click();
      await expect(proposalDialog).toBeHidden();
      await expect(
        proposalPanel.getByText("Proposal approved", { exact: true }),
      ).toBeVisible();
      await expect(
        proposalPanel.getByRole("button", {
          name: "Initialize project",
          exact: true,
        }),
      ).toHaveCount(0);
      await author.goto(`${base}${root}#proposal`);
      const authorProposal = author.getByTestId("workflow-proposal");
      await authorProposal
        .getByRole("button", { name: "Initialize project", exact: true })
        .click();
      await expect(
        author
          .getByRole("dialog")
          .getByText(proposalView.proposal!.proposalHash, { exact: true }),
      ).toBeVisible();
      await author
        .getByRole("dialog")
        .getByRole("button", { name: "Initialize project", exact: true })
        .click();
      await expect(author.getByRole("dialog")).toBeHidden();
      await expect(
        authorProposal.getByText("Initialization queued", { exact: true }),
      ).toBeVisible();
      expect(await service.runSourceCheckJobs()).toBe(1);
      await expect(
        authorProposal.getByText("Project initialized", { exact: true }),
      ).toBeVisible();
      const initialized = await call<ProposalView>("GET", `${root}/proposal`);
      const completedJob = initialized.jobs.find(
        (job) => job.status === "succeeded",
      )!;
      const jobRow = authorProposal
        .getByRole("listitem")
        .filter({ hasText: completedJob.id });
      for (const timestamp of [
        completedJob.requestedAt,
        completedJob.startedAt,
        completedJob.finishedAt,
      ]) {
        await expect(
          jobRow.locator(`time[datetime="${timestamp}"]`).first(),
        ).toBeVisible();
      }
      const references = authorProposal
        .locator("details")
        .filter({ has: author.getByText("Hashes", { exact: true }) });
      await references.locator("summary").click();
      await expect(
        references.getByText(initialized.currentState!.hash, { exact: true }),
      ).toBeVisible();
      await references.locator("summary").click();
      await authorProposal
        .getByRole("button", { name: "Replace Creator state", exact: true })
        .click();
      await expect(
        author
          .getByRole("dialog")
          .getByText(initialized.currentState!.hash, { exact: true }),
      ).toBeVisible();
      await author
        .getByRole("dialog")
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await expect(author.getByRole("dialog")).toBeHidden();
      const proposalScreenshot = info.outputPath(`proposal-${theme}.png`);
      await authorProposal.screenshot({ path: proposalScreenshot });
      await info.attach(`proposal-${theme}`, {
        path: proposalScreenshot,
        contentType: "image/png",
      });
      const desktop = author.viewportSize()!;
      const controls = authorProposal.getByRole("button", {
        name: "Replace Creator state",
      });
      const bounds = await controls.boundingBox();
      expect((await jobRow.boundingBox())!.x).toBeGreaterThan(
        bounds!.x + bounds!.width,
      );
      await author.setViewportSize({ width: 390, height: 844 });
      await expect(jobRow).toBeVisible();
      expect((await jobRow.boundingBox())!.y).toBeGreaterThan(
        (await controls.boundingBox())!.y,
      );
      expect(
        await author.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await author.setViewportSize(desktop);

      await author.goto(`${base}${root}#package`);
      const packagePanel = author.getByTestId("workflow-package");
      await packagePanel
        .getByRole("button", { name: "Generate package", exact: true })
        .click();
      const generationDialog = author.getByRole("dialog");
      await expect(
        generationDialog.getByText(initialized.currentState!.hash, {
          exact: true,
        }),
      ).toBeVisible();
      await generationDialog
        .getByRole("button", { name: "Confirm generation", exact: true })
        .click();
      await expect(generationDialog).toBeHidden();
      await expect(
        packagePanel.getByRole("tab", { name: "Generation jobs", exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      const generationJobs = packagePanel.getByRole("tabpanel", {
        name: "Generation jobs",
        exact: true,
      });
      await expect(
        generationJobs.getByText("Generation queued", { exact: true }),
      ).toBeVisible();
      expect(await service.runSourceCheckJobs()).toBe(1);
      await expect(
        packagePanel.getByRole("button", {
          name: "Regenerate package",
          exact: true,
        }),
      ).toBeVisible();
      await packagePanel
        .getByRole("tab", { name: "Generation jobs", exact: true })
        .click();
      await expect(
        generationJobs.getByText("Package generated", { exact: true }),
      ).toBeVisible();
      await expect(
        generationJobs.getByText("Shown package", { exact: true }),
      ).toBeVisible();
      const generated = await call<PackageView>("GET", `${root}/package`);
      const tabBar = packagePanel.locator(".ant-tabs-nav");
      await expect(
        tabBar.getByRole("button", { name: "Regenerate package" }),
      ).toBeVisible();
      await expect(
        tabBar.getByRole("button", { name: "Reload records", exact: true }),
      ).toBeVisible();
      await expect(
        packagePanel.getByRole("heading", { name: "Package", exact: true }),
      ).toHaveClass("sr-only");
      await expect(
        generationJobs.getByText(generated.package!.scaffoldHash, {
          exact: true,
        }),
      ).toHaveCount(0);
      const filesTab = packagePanel.getByRole("tab", {
        name: "Package files",
        exact: true,
      });
      const files = packagePanel.getByRole("tabpanel", {
        name: "Package files",
        exact: true,
      });
      await filesTab.click();
      await expect(generationJobs).toBeHidden();
      await expect(
        files.getByText(generated.package!.scaffoldHash, { exact: true }),
      ).toBeVisible();
      await expect(
        files.getByText(generated.package!.proposalHash, { exact: true }),
      ).toBeVisible();
      await expect(
        files.getByText("Deterministic backbone", { exact: true }).first(),
      ).toBeVisible();
      await expect(
        files.getByText("Authored leaf", { exact: true }).first(),
      ).toBeVisible();
      const fileFilter = files.getByLabel("Filter package files", {
        exact: true,
      });
      await fileFilter.fill("skill.md");
      await files
        .getByRole("button", { name: "SKILL.md", exact: true })
        .click();
      await expect(
        author
          .getByRole("dialog")
          .getByText("Prefer the Badger MCP Run tools", { exact: false }),
      ).toBeVisible();
      await author
        .getByRole("dialog")
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await packagePanel
        .getByRole("tab", { name: "Authoring plan", exact: true })
        .click();
      const authoringPlan = packagePanel.getByRole("tabpanel", {
        name: "Authoring plan",
        exact: true,
      });
      await expect(
        authoringPlan.getByText(
          generated.package!.authoringPlan.authoringPlanHash,
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        authoringPlan
          .getByRole("cell", { name: "skill-review", exact: true })
          .first(),
      ).toBeVisible();
      await filesTab.click();
      await expect(fileFilter).toHaveValue("skill.md");
      await packagePanel
        .getByRole("tab", { name: "Authoring lanes", exact: true })
        .click();
      const authoring = packagePanel.getByTestId("workflow-authoring");
      await authoring
        .getByRole("button", { name: "Request ready lanes", exact: true })
        .click();
      await expect(
        authoring.getByRole("button", {
          name: "Copy Agent prompt",
          exact: true,
        }),
      ).toHaveCount(3);
      const { jobs: laneJobs } = await call<{
        jobs: { id: string; laneId: string; revision: number }[];
      }>("GET", `${root}/drafting-jobs`);
      const script = laneJobs.find((job) => job.laneId === "script")!;
      const claim = await call<{
        job: { lease: { id: string }; contextHash: string };
        contextBundle: { authoring: { plan: { semanticDossierHash: string } } };
      }>("POST", `${root}/drafting-jobs/${script.id}/claim`, {
        revision: script.revision,
      });
      await call("POST", `${root}/drafting-jobs/${script.id}/submit`, {
        leaseId: claim.job.lease.id,
        contextHash: claim.job.contextHash,
        result: {
          laneOutput: {
            lane: "script",
            status: "BLOCKED",
            semanticDossierHash:
              claim.contextBundle.authoring.plan.semanticDossierHash,
            claims: [],
            artifacts: [],
            summary: "The report evidence needs repair.",
            findings: [
              {
                severity: "important",
                owner: "Workflow Engineer",
                problem: "The report contract omits its expected source.",
                impact: "The next lane cannot check the source citation.",
                fix: "Map the primary source to the report citation.",
                evidence: [
                  "The approved output schema requires a source citation.",
                ],
              },
            ],
            action: {
              kind: "repair",
              prompt: "Repair the report evidence mapping.",
              requirement: "Keep the approved report evidence.",
            },
          },
        },
      });
      await authoring
        .getByRole("button", { name: "Reload records", exact: true })
        .click();
      await authoring
        .getByRole("button", { name: "Review result", exact: true })
        .click();
      await author
        .getByRole("dialog")
        .getByRole("button", { name: "Preview acceptance", exact: true })
        .click();
      await author
        .getByRole("dialog", { name: "Confirm lane decision" })
        .getByRole("button", { name: "Confirm", exact: true })
        .click();
      await expect(author.getByRole("dialog")).toHaveCount(0);
      const scriptRow = authoring
        .getByRole("row")
        .filter({ hasText: /^script/ });
      await scriptRow.getByRole("button", { name: "Expand row" }).click();
      await authoring
        .getByRole("button", { name: "View report", exact: true })
        .click();
      const acceptedReport = author.getByRole("dialog", {
        name: "script · Lane report",
      });
      await expect(
        acceptedReport.getByText(
          "The report contract omits its expected source.",
        ),
      ).toBeVisible();
      await expect(
        acceptedReport.getByText(
          "The approved output schema requires a source citation.",
        ),
      ).toBeVisible();
      await expect(
        acceptedReport.getByRole("button", { name: "Preview acceptance" }),
      ).toHaveCount(0);
      await acceptedReport.getByRole("button", { name: "Close" }).click();
      await expect(
        authoring.getByText("Repair job needs dispatch", { exact: true }),
      ).toBeVisible();
      await expect(
        authoring.getByRole("button", {
          name: "Assemble package",
          exact: true,
        }),
      ).toBeDisabled();
      const queue = await call<{
        jobs: {
          id: string;
          laneId: string;
          status: string;
          revision: number;
        }[];
      }>("GET", `${root}/drafting-jobs`);
      const repair = queue.jobs.find(
        (job) => job.laneId === "script" && job.status === "queued",
      )!;
      const repairRoute = `${root}/drafting-jobs/${repair.id}`;
      const repairClaim = await call<{
        job: { lease: { id: string }; contextHash: string };
        contextBundle: unknown;
      }>("POST", `${repairRoute}/claim`, { revision: repair.revision });
      await call("POST", `${repairRoute}/submit`, {
        leaseId: repairClaim.job.lease.id,
        contextHash: repairClaim.job.contextHash,
        result: {
          laneOutput: {
            ...reportLaneOutput(repairClaim.contextBundle),
            status: "DONE_WITH_CONCERNS",
            findings: [
              {
                severity: "minor",
                owner: "Workflow Engineer",
                problem: "The review used an incomplete handoff.",
                fix: "Recheck the current handoff.",
              },
            ],
          },
        },
      });
      await authoring
        .getByRole("button", { name: "Reload records", exact: true })
        .click();
      await scriptRow
        .getByRole("button", { name: "Review result", exact: true })
        .click();
      await acceptedReport
        .getByRole("button", { name: "Preview acceptance" })
        .click();
      await author
        .getByRole("dialog", { name: "Confirm lane decision" })
        .getByRole("button", { name: "Confirm", exact: true })
        .click();
      await scriptRow
        .getByRole("button", { name: "View report", exact: true })
        .click();
      await expect(
        acceptedReport.getByText("The review used an incomplete handoff."),
      ).toBeVisible();
      await acceptedReport
        .getByRole("button", { name: "Request revised draft" })
        .click();
      await expect(acceptedReport).toBeHidden();
      await expect(
        scriptRow.getByRole("button", {
          name: "Copy Agent prompt",
          exact: true,
        }),
      ).toBeVisible();
      for (let wave = 0; wave < 3; wave++) {
        await call("POST", `${root}/package/authoring-jobs`, {
          confirmed: true,
        });
        const { jobs } = await call<{
          jobs: {
            id: string;
            kind: string;
            status: string;
            revision: number;
          }[];
        }>("GET", `${root}/drafting-jobs`);
        for (const job of jobs.filter(
          (j) =>
            (j.kind === "authoring-lane" || j.kind === "review-vote") &&
            j.status === "queued",
        )) {
          const route = `${root}/drafting-jobs/${job.id}`;
          const claim = await call<{
            job: { lease: { id: string }; contextHash: string };
            contextBundle: unknown;
          }>("POST", `${route}/claim`, { revision: job.revision });
          const laneOutput = reportLaneOutput(claim.contextBundle);
          const submitted = await call<{ job: { revision: number } }>(
            "POST",
            `${route}/submit`,
            {
              leaseId: claim.job.lease.id,
              contextHash: claim.job.contextHash,
              result: { laneOutput },
            },
          );
          const decision = { revision: submitted.job.revision, laneOutput };
          const { preview } = await call<{
            preview: { confirmationHash: string };
          }>("POST", `${route}/accept-preview`, decision);
          await call("POST", `${route}/accept`, {
            ...decision,
            confirmed: true,
            confirmationHash: preview.confirmationHash,
            requestId: crypto.randomUUID(),
          });
        }
      }
      await authoring
        .getByRole("button", { name: "Reload records", exact: true })
        .click();
      await authoring
        .getByRole("button", { name: "Assemble package", exact: true })
        .click();
      await expect(
        author.getByRole("dialog", { name: "Confirm package assembly" }),
      ).toBeVisible();
      await author
        .getByRole("dialog", { name: "Confirm package assembly" })
        .getByRole("button", { name: "Confirm", exact: true })
        .click();
      await expect(author.getByRole("dialog")).toHaveCount(0);
      await expect(
        authoring.getByText("Package assembled", { exact: true }),
      ).toBeVisible();
      const packageScreenshot = info.outputPath(`package-${theme}.png`);
      await packagePanel.screenshot({
        path: packageScreenshot,
        style: ".top-bar { visibility: hidden; }",
      });
      await info.attach(`package-${theme}`, {
        path: packageScreenshot,
        contentType: "image/png",
      });
      expect(
        await author.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await author.setViewportSize({ width: 390, height: 844 });
      await packagePanel
        .getByRole("button", { name: "More package tabs", exact: true })
        .click();
      await author
        .getByRole("listbox", { name: "More package tabs", exact: true })
        .getByRole("option", { name: "Generation jobs", exact: true })
        .click();
      await expect(
        generationJobs.getByText("Shown package", { exact: true }),
      ).toBeVisible();
      await expect
        .poll(() => author.evaluate(() => document.documentElement.scrollWidth))
        .toBe(390);
      await page.goto(`${base}${root}#package`);
      await expect(
        page
          .getByTestId("workflow-package")
          .getByRole("button", { name: "Regenerate package", exact: true }),
      ).toHaveCount(0);

      await call("PATCH", `${root}/source-study/facts/${record.id}`, {
        ...content,
        statement: "The source now returns a revised report.",
        revision: 1,
      });
      await page.reload();
      await expect(
        page
          .getByTestId("workflow-package")
          .getByText(
            "This package was superseded. Review the upstream change and generate it again.",
            { exact: true },
          ),
      ).toBeVisible();
      await page.goto(`${base}${root}#proposal`);
      await expect(
        page
          .getByTestId("workflow-proposal")
          .getByText(
            "Proposal approval was superseded. Review the current plan and proposal again.",
            { exact: true },
          ),
      ).toBeVisible();
      await page.goto(`${base}${root}#dossier`);
      await expect(
        page
          .getByTestId("workflow-dossier")
          .getByText("Superseded", { exact: true }),
      ).toBeVisible();
      await page.goto(`${base}${root}#plan`);
      await expect(
        page
          .getByTestId("workflow-plan")
          .getByText("Superseded", { exact: true }),
      ).toBeVisible();
      await expect(
        page
          .getByTestId("workflow-plan")
          .getByRole("button", { name: "Review plan approval", exact: true }),
      ).toHaveCount(0);
      await page.goto(`${base}${root}#dossier`);
      await expect(
        page
          .getByTestId("workflow-dossier")
          .getByRole("button", { name: "Review dossier approval" }),
      ).toHaveCount(0);
      await page.goto(`${base}/my-work`);
      await expect(
        page.getByRole("link", {
          name: `${workflow.name} · 0.1.0: dossier approval superseded`,
          exact: true,
        }),
      ).toBeVisible();
    } finally {
      await authorContext.close();
      await ownerContext.close();
    }
  });
}
