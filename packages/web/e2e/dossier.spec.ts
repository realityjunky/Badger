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
      await planning
        .getByRole("button", { name: "Request plan draft", exact: true })
        .click();
      await author
        .getByRole("dialog")
        .getByRole("button", { name: "Request plan draft", exact: true })
        .click();
      await expect(author.getByRole("dialog")).toBeHidden();
      const { jobs } = await call<{
        jobs: { id: string; revision: number; kind: string }[];
      }>("GET", `${root}/drafting-jobs`);
      const job = jobs.find((job) => job.kind === "draft-plan")!;
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
      await agentCall(`${root}/drafting-jobs/${job.id}/submit`, {
        leaseId: claimed.job.lease.id,
        contextHash: claimed.job.contextHash,
        result: { plan },
      });
      expect((await call<PlanView>("GET", `${root}/plan`)).versions).toEqual(
        [],
      );
      await author.reload();
      await planning
        .getByRole("button", { name: "Review plan suggestion", exact: true })
        .click();
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

      const proposalPanel = page.getByTestId("workflow-proposal");
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
      await author.reload();
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
        packagePanel.getByText("Generation queued", { exact: true }),
      ).toBeVisible();
      expect(await service.runSourceCheckJobs()).toBe(1);
      await expect(
        packagePanel.getByText("Package generated", { exact: true }),
      ).toBeVisible();
      const generated = await call<PackageView>("GET", `${root}/package`);
      await expect(
        packagePanel.getByText(generated.package!.scaffoldHash, {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        packagePanel
          .getByText("Deterministic backbone", { exact: true })
          .first(),
      ).toBeVisible();
      await expect(
        packagePanel.getByText("Authored leaf", { exact: true }).first(),
      ).toBeVisible();
      await expect(
        packagePanel.getByText("skill-review", { exact: true }).first(),
      ).toBeVisible();
      await packagePanel
        .getByLabel("Filter package files", { exact: true })
        .fill("SKILL.md");
      await packagePanel
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
        .getByLabel("Filter package files", { exact: true })
        .fill("");
      const authoring = packagePanel.getByTestId("workflow-authoring");
      await authoring
        .getByRole("button", { name: "Request ready lanes", exact: true })
        .click();
      await expect(
        authoring.getByText("Lane draft", { exact: true }),
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
      await expect(
        authoring.getByText("Repair job", { exact: false }),
      ).toBeVisible();
      await expect(
        authoring.getByRole("button", {
          name: "Assemble package",
          exact: true,
        }),
      ).toBeDisabled();
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
      await page.reload();
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
      await expect(
        page
          .getByTestId("workflow-proposal")
          .getByText(
            "Proposal approval was superseded. Review the current plan and proposal again.",
            { exact: true },
          ),
      ).toBeVisible();
      await expect(
        page
          .getByTestId("workflow-dossier")
          .getByText("Superseded", { exact: true }),
      ).toBeVisible();
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
      await expect(
        page
          .getByTestId("workflow-dossier")
          .getByRole("button", { name: "Review dossier approval" }),
      ).toHaveCount(0);
      await page.goto(`${base}/my-work`);
      await expect(
        page.getByRole("link", {
          name: `${workflow.name} · v1: dossier approval superseded`,
          exact: true,
        }),
      ).toBeVisible();
    } finally {
      await authorContext.close();
      await ownerContext.close();
    }
  });
}
