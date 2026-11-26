import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  WORKING_DOSSIER_FIELDS,
  type DossierFieldValue,
  type WorkingDossierView,
} from "@realityjunky/badger";
import type { DossierView } from "../src/api/dossier.js";
import type { SkillVersion } from "../src/api/skills.js";
import type { WorkflowVersionDetail } from "../src/api/workflows.js";
import { readSkillArchive } from "./fixtures/skill-archive.js";
import {
  api,
  base,
  cite,
  confirmSources,
  people,
  signIn,
  startDossierService,
  uploadSource,
  workflowPath,
} from "./fixtures/working-dossier-session.js";

const questionText = "Which file format should the parcel report use?";
const submittedAnswer = "Export the report as UTF-8 JSON.";
const reviewedFact = "The successor exports the report as UTF-8 JSON.";
const fieldId = "workflow/workflow/guardrails";

async function selectOption(
  page: Page,
  label: string | RegExp,
  option: RegExp | string,
) {
  const select = page.getByRole("combobox", { name: label, exact: true });
  await select.click();
  await page
    .locator(".ant-select-dropdown:visible")
    .locator(".ant-select-item-option-content")
    .filter({ hasText: option })
    .click();
  if ((await select.getAttribute("aria-expanded")) === "true")
    await select.press("Escape");
}

async function readWorkflow(page: Page, path: string) {
  return api<WorkflowVersionDetail>(page, "GET", path);
}

test("a Skill decision stays with its reviewed version and reaches only workflows that adopt it", async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const { provider, service } = await startDossierService();
  const pages: Page[] = [];
  try {
    for (const person of [people.admin, people.engineer, people.expert])
      pages.push(await signIn(browser, provider, person));
    for (const page of pages) page.setDefaultTimeout(8_000);
    const [admin, engineer, expert] = pages as [Page, Page, Page];
    const { group } = await api<{ group: { id: string } }>(
      admin,
      "POST",
      "/groups",
      { name: "Parcel reports" },
    );
    const makeWorkflow = async (name: string, groupId = group.id) => {
      const { workflow, version } = await api<{
        workflow: { id: string };
        version: { id: string };
      }>(admin, "POST", "/workflows", {
        groupId,
        name,
        goal: "Generate a report for a parcel.",
        intent: "new-skill",
        locale: "en",
      });
      await api(admin, "POST", "/bindings", {
        scopeType: "workflow",
        scopeId: workflow.id,
        email: people.engineer.email,
        role: "Engineer",
      });
      return { workflowId: workflow.id, versionId: version.id };
    };
    const workflow = await makeWorkflow("parcel-report");
    const otherWorkflow = await makeWorkflow("parcel-comparison");
    const { group: privateGroup } = await api<{ group: { id: string } }>(
      admin,
      "POST",
      "/groups",
      { name: "Restricted reports" },
    );
    const restricted = await makeWorkflow("restricted-report", privateGroup.id);
    await api(admin, "POST", "/bindings", {
      scopeType: "group",
      scopeId: group.id,
      email: people.expert.email,
      role: "Member",
    });
    const path = workflowPath(workflow);
    const otherPath = workflowPath(otherWorkflow);
    const skill = await uploadSource(engineer, group.id, {
      name: "parcel-report",
      files: new Map([
        [
          "SKILL.md",
          Buffer.from(
            "---\nname: parcel-report\ndescription: Generate parcel reports\n---\n\nFollow the input and output guide.\n",
          ),
        ],
        [
          "references/format.md",
          Buffer.from("Export the report as plain text.\n"),
        ],
      ]),
    });
    const library = `/skills/${skill.skillId}/versions/${skill.hash}`;
    await engineer.goto(`${base}${library}`);
    await engineer.getByRole("link", { name: "Skill Questionnaire" }).click();
    await engineer
      .getByRole("button", { name: "New round", exact: true })
      .click();
    await engineer
      .getByLabel("Round title", { exact: true })
      .fill("Report format");
    await engineer
      .getByRole("button", { name: "Create round", exact: true })
      .click();
    await engineer
      .getByRole("button", { name: "New question", exact: true })
      .click();
    await engineer
      .getByLabel("Question text", { exact: true })
      .fill(questionText);
    await engineer
      .getByLabel("Rationale", { exact: true })
      .fill("Make the format explicit in the source.");
    await selectOption(engineer, /Assignees/u, people.expert.name);
    await selectOption(engineer, /Related workflows/u, "restricted-report");
    await engineer
      .getByRole("button", { name: "Add evidence", exact: true })
      .click();
    await engineer
      .getByLabel("File path", { exact: true })
      .fill("references/format.md");
    await engineer
      .getByRole("button", { name: "Save question", exact: true })
      .click();
    await engineer
      .getByRole("button", { name: "Review round", exact: true })
      .click();
    await engineer
      .getByRole("dialog")
      .getByRole("button", { name: "Publish round", exact: true })
      .click();
    await expert.goto(`${base}/my-work`);
    await expert
      .getByRole("link", {
        name: /Which file format should the parcel report use/u,
      })
      .first()
      .click();
    const questionUrl = expert.url();
    await expect(
      expert.getByRole("heading", { name: questionText, exact: true }),
    ).toBeVisible();
    await expert
      .getByRole("button", { name: "Evidence and history", exact: true })
      .click();
    await expect(
      expert.getByRole("link", { name: /references\/format\.md/ }),
    ).toHaveAttribute("href", `/team${library}?path=references%2Fformat.md`);
    await expert
      .getByRole("link", { name: "Open related workflow", exact: true })
      .click();
    await expect(expert).toHaveURL(
      `${base}/workflows/${restricted.workflowId}`,
    );
    await expect(
      expert.getByText("This workflow is unavailable or outside your roles."),
    ).toBeVisible();
    await expert.goto(questionUrl);
    await expert.getByTestId("answer-box").fill(submittedAnswer);
    await expert
      .getByRole("button", { name: "Submit answer", exact: true })
      .click();
    await expect((await readWorkflow(engineer, path)).pins).toEqual([]);

    const review = await engineer.context().newPage();
    review.setDefaultTimeout(8_000);
    await review.goto(questionUrl);
    await review
      .getByLabel("Formal fact 1", { exact: true })
      .fill(reviewedFact);
    await selectOption(review, "Skill outcome", "Change requested");
    await review
      .getByRole("button", { name: "Review resolution", exact: true })
      .click();
    await review
      .getByRole("dialog")
      .getByRole("button", { name: "Sign off", exact: true })
      .click();
    await expect(
      review.getByText("Awaiting a saved successor", { exact: true }),
    ).toBeVisible();

    const pin = async (
      workflowPathname: string,
      hash: string,
      replacing = false,
    ) => {
      await engineer.goto(`${base}${workflowPathname}#sources`);
      await selectOption(engineer, "Select a Skill", "parcel-report");
      await selectOption(
        engineer,
        "Select a version",
        new RegExp(hash.slice(0, 12)),
      );
      if (replacing) {
        const compare = engineer.getByRole("link", {
          name: "Compare versions",
          exact: true,
        });
        const comparisonUrl = new URL(
          (await compare.getAttribute("href"))!,
          base,
        );
        const comparisonPage = await engineer.context().newPage();
        try {
          await comparisonPage.goto(comparisonUrl.toString());
          await expect(
            comparisonPage.getByRole("row", {
              name: /references\/format\.md Modified/u,
            }),
          ).toBeVisible();
        } finally {
          await comparisonPage.close();
        }
      }
      await engineer
        .getByRole("button", {
          name: replacing ? "Replace pin" : "Pin version",
          exact: true,
        })
        .click();
      await expect
        .poll(async () =>
          (await readWorkflow(engineer, workflowPathname)).pins.map(
            ({ hash }) => hash,
          ),
        )
        .toEqual([hash]);
      await service.runSourceCheckJobs();
    };
    await pin(path, skill.hash);
    await pin(otherPath, skill.hash);
    const dossierPath = `${path}/working-dossier`;
    const draft = await api<WorkingDossierView>(engineer, "GET", dossierPath);
    await api(engineer, "PATCH", dossierPath, {
      revision: draft.revision,
      pinsHash: draft.pinsHash,
      editId: randomUUID(),
      fields: {
        [fieldId]: {
          state: "source",
          value: "Export the report as plain text.",
          evidence: [cite(skill, "references/format.md", "Export")],
        },
      },
    });
    await engineer.goto(`${base}${library}`);
    await engineer
      .getByRole("button", { name: "Edit files", exact: true })
      .click();
    const editor = engineer.getByRole("dialog", { name: "Edit files" });
    await editor
      .getByRole("combobox", { name: "File to edit", exact: true })
      .click();
    await engineer
      .getByText("references/format.md", { exact: true })
      .last()
      .click();
    await editor
      .getByRole("textbox", { name: "File contents", exact: true })
      .fill(`${submittedAnswer}\n`);
    await editor
      .getByRole("button", { name: "Review changes", exact: true })
      .click();
    await expect(
      editor.getByRole("row", { name: /references\/format\.md Modified/u }),
    ).toBeVisible();
    await engineer
      .getByRole("button", { name: "Save successor", exact: true })
      .click();
    await expect(editor).toBeHidden();
    const { versions } = await api<{ versions: SkillVersion[] }>(
      engineer,
      "GET",
      `/skills/${skill.skillId}/versions`,
    );
    const successor = versions.find(({ hash }) => hash !== skill.hash)!;
    expect(successor.editOrigins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ baseHash: skill.hash }),
      ]),
    );
    await engineer.getByRole("button", { name: "Edit version label" }).click();
    const label = engineer.getByRole("dialog", { name: "Edit version label" });
    await label.getByRole("textbox", { name: "Version label" }).fill("1.1.0");
    await label.getByRole("button", { name: "Save label" }).click();
    await expect(label).toBeHidden();
    const download = engineer.waitForEvent("download");
    await engineer
      .getByRole("link", { name: "Download ZIP", exact: true })
      .click();
    const successorArchive = testInfo.outputPath("reviewed-successor.zip");
    await (await download).saveAs(successorArchive);
    expect(await readSkillArchive(successorArchive)).toEqual(
      new Map(skill.files).set(
        "references/format.md",
        Buffer.from(`${submittedAnswer}\n`),
      ),
    );
    await review
      .getByRole("button", { name: "Refresh successor versions", exact: true })
      .click();
    await selectOption(review, "Successor version", /1\.1\.0/u);
    await review
      .getByRole("button", { name: "Review successor link", exact: true })
      .click();
    await review
      .getByRole("dialog")
      .getByRole("button", { name: "Sign off", exact: true })
      .click();
    await expect(
      expert.getByTestId("confirmed-fact").filter({ hasText: reviewedFact }),
    ).toBeVisible();
    await expert
      .getByRole("button", { name: "Acknowledge restatement", exact: true })
      .click();
    await expert
      .getByRole("dialog")
      .getByRole("button", { name: "Sign off", exact: true })
      .click();
    await expect(
      expert
        .getByTestId("confirmed-fact")
        .getByText("Acknowledged", { exact: true }),
    ).toBeVisible();
    await review.getByText("Resolution history", { exact: true }).click();
    await expect(
      review.getByRole("link", { name: successor.hash.slice(0, 12) }),
    ).toBeVisible();
    await expect(
      review.getByRole("link", { name: skill.hash, exact: true }),
    ).toBeVisible();
    for (const root of [path, otherPath])
      expect((await readWorkflow(engineer, root)).pins[0]?.hash).toBe(
        skill.hash,
      );

    await pin(path, successor.hash, true);
    await expect(
      engineer.getByRole("button", { name: "parcel-report", exact: true }),
    ).toContainText("1.1.0");
    expect((await readWorkflow(engineer, otherPath)).pins[0]?.hash).toBe(
      skill.hash,
    );
    const query = new URLSearchParams({
      workflow: workflow.workflowId,
      version: workflow.versionId,
      panel: "ledger",
      dossierField: fieldId,
    });
    await engineer.goto(`${base}/questionnaire?${query}`);
    const field = engineer.getByRole("article", {
      name: "Workflow · Workflow guardrails",
      exact: true,
    });
    await expect(
      field.getByText("A cited pin or endpoint changed"),
    ).toBeVisible();
    await expect(
      field.getByRole("button", { name: /references\/format\.md Changed/u }),
    ).toBeVisible();
    await field.getByRole("button", { name: "Edit", exact: true }).click();
    const fieldEditor = engineer.getByRole("dialog", {
      name: "Workflow · Workflow guardrails",
    });
    await selectOption(engineer, "State", "Recorded decision");
    await fieldEditor.getByLabel("Value", { exact: true }).fill(reviewedFact);
    await selectOption(
      engineer,
      "Reviewed answers",
      /parcel-report.*Export the report as UTF-8 JSON/u,
    );
    // The old citation remains inspectable in the previous dossier revision.
    await fieldEditor
      .locator(".ant-form-item")
      .filter({
        has: engineer.locator("label").filter({ hasText: /^Evidence$/u }),
      })
      .locator(".ant-select-selection-item-remove")
      .click();
    await fieldEditor
      .getByRole("button", { name: "Save field", exact: true })
      .click();
    await expect(fieldEditor).toBeHidden();
    await expect(
      field.getByRole("link", { name: /Resolution revision 1/u }),
    ).toBeVisible();
    const updated = await api<WorkingDossierView>(engineer, "GET", dossierPath);
    expect(updated.content.fields[fieldId]?.answers).toHaveLength(1);
    expect(
      updated.projection.fields.find(({ id }) => id === fieldId)?.blocker,
    ).toBeNull();

    await confirmSources(service, engineer, workflow);
    await admin.goto(`${base}${path}#dossier`);
    const dossierPanel = admin.getByTestId("workflow-dossier");
    const readiness = dossierPanel.getByRole("region", {
      name: "Readiness by topic",
    });
    await expect(readiness).toContainText("topics with blockers");

    await expect(dossierPanel.getByText(/^Workflow · Scope —/u)).toBeVisible();

    const supportingFields: Record<string, DossierFieldValue> = {};
    for (const [scope, id] of [
      ["workflow", "workflow"],
      ["skill", skill.skillId],
      ["node", "render"],
    ] as const)
      for (const field of WORKING_DOSSIER_FIELDS[scope].filter(
        ({ required }) => required,
      ))
        supportingFields[`${scope}/${id}/${field.key}`] = {
          state: "decision",
          value: field.label,
          reason: "Agreed for this example workflow.",
        };
    const ready = await api<WorkingDossierView>(
      engineer,
      "PATCH",
      dossierPath,
      {
        revision: updated.revision,
        pinsHash: updated.pinsHash,
        editId: randomUUID(),
        fields: supportingFields,
        nodes: {
          render: {
            kind: "node",
            label: "Render report",
            order: 0,
            skillId: skill.skillId,
            hash: successor.hash,
          },
        },
      },
    );
    await expect(readiness).toContainText("Ready");
    const scope = readiness.getByRole("button", { name: /^Scope Ready$/u });
    await expect(scope.getByText("Ready", { exact: true })).toBeVisible();
    await expect(dossierPanel.getByText(/^Workflow · Scope —/u)).toHaveCount(0);
    await dossierPanel
      .getByRole("button", { name: "Review dossier approval", exact: true })
      .click();
    const approval = admin.getByRole("dialog", {
      name: "Review dossier approval",
    });
    await expect(approval).toContainText(
      `Working dossier revision ${ready.revision}`,
    );
    await expect(
      approval.getByRole("region", { name: "Workflow diagram" }),
    ).toHaveCount(0);
    await expect(approval.getByRole("tab")).toHaveCount(0);
    const reviewedHash = approval.getByText(/^[a-f0-9]{64}$/u);
    await expect(reviewedHash).toBeVisible();
    const hash = await reviewedHash.textContent();
    await approval
      .getByRole("button", { name: "Approve this version" })
      .click();
    await expect(approval).toBeHidden();
    const approved = await api<DossierView>(admin, "GET", `${path}/dossier`);
    expect(approved.confirmation?.invalidatedAt).toBeNull();
    expect(approved.confirmation?.boundHashes.dossier).toBe(hash);
    await dossierPanel
      .getByRole("combobox", { name: "Dossier version" })
      .click();
    await admin
      .locator(".ant-select-item-option")
      .filter({ hasText: "Dossier version 1" })
      .click();
    await dossierPanel.getByRole("tab", { name: "Workflow details" }).click();
    await expect(
      dossierPanel.getByRole("heading", { name: "Scope", exact: true }),
    ).toBeVisible();
    await dossierPanel
      .getByRole("tab", { name: "Canonical JSON and record snapshot" })
      .click();
    const json = dossierPanel.locator("pre.dossier-json");
    const canonical = approved.versions[0]!.canonicalJson!;
    await expect(json).toHaveText(
      JSON.stringify(JSON.parse(canonical), null, 2),
      { useInnerText: true },
    );
    await dossierPanel.getByLabel("Show exact canonical text").check();
    expect(await json.textContent()).toBe(canonical);
    await engineer.goto(`${base}/questionnaire?${query}`);
    await expert
      .getByTestId("answer-box")
      .fill("The format also requires a schema.");
    await expert.getByTestId("answer-save-state").waitFor({ state: "visible" });
    await expect(expert.getByTestId("answer-save-state")).toHaveText(
      "Draft saved",
    );
    await expect(
      field.getByText("A linked reviewed answer changed"),
    ).toBeVisible();
    const stale = await api<DossierView>(admin, "GET", `${path}/dossier`);
    expect(stale.confirmation?.invalidatedAt).toEqual(expect.any(String));
    expect(stale.currentVersionId).toBeNull();
    expect(stale.versions.map(({ hash }) => hash)).toEqual(
      approved.versions.map(({ hash }) => hash),
    );
    await admin.goto(`${base}${library}`);
    await admin
      .getByRole("button", { name: "Remove version", exact: true })
      .click();
    await admin
      .getByRole("dialog")
      .getByRole("button", { name: "Retire version", exact: true })
      .click();
    await expect(admin.getByRole("dialog")).toBeHidden();
    const historicalPin = await readWorkflow(engineer, otherPath);
    expect(historicalPin.pins[0]).toMatchObject({
      hash: skill.hash,
      retiredAt: expect.any(String),
    });
    await expert.getByRole("link", { name: skill.hash, exact: true }).click();
    await expect(expert).toHaveURL(`${base}${library}`);
    await expect(
      expert
        .getByRole("combobox", { name: "Versions", exact: true })
        .locator(".."),
    ).toContainText("Retired");
    await expect(
      expert.getByRole("link", { name: "Download ZIP", exact: true }),
    ).toBeVisible();
    await testInfo.attach("workflow-decision-readiness", {
      body: await engineer.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  } finally {
    await Promise.allSettled(pages.map((page) => page.context().close()));
    await service.close();
    await provider.stop();
  }
});
