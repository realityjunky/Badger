import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type { WorkingDossierView } from "@realityjunky/badger";
import type { SkillVersion } from "../src/api/skills.js";
import type { WorkflowVersionDetail } from "../src/api/workflows.js";
import {
  api,
  base,
  cite,
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
  label: string,
  option: RegExp | string,
) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option }).click();
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
    const [admin, engineer, expert] = pages as [Page, Page, Page];
    const { group } = await api<{ group: { id: string } }>(
      admin,
      "POST",
      "/groups",
      { name: "Parcel reports" },
    );
    const makeWorkflow = async (name: string) => {
      const { workflow, version } = await api<{
        workflow: { id: string };
        version: { id: string };
      }>(admin, "POST", "/workflows", {
        groupId: group.id,
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
    await engineer.getByRole("combobox", { name: /Assignees/u }).click();
    await engineer.getByRole("option", { name: people.expert.name, exact: true }).click();
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
    await expert.getByTestId("answer-box").fill(submittedAnswer);
    await expert
      .getByRole("button", { name: "Submit answer", exact: true })
      .click();
    await expect((await readWorkflow(engineer, path)).pins).toEqual([]);

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
    await editor
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
    await engineer.goto(questionUrl);
    await engineer
      .getByLabel("Formal fact 1", { exact: true })
      .fill(reviewedFact);
    await selectOption(engineer, "Skill outcome", "Implemented in a successor");
    await selectOption(engineer, "Successor version", /1\.1\.0/u);
    await engineer
      .getByRole("button", { name: "Review resolution", exact: true })
      .click();
    await engineer
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
      expert.getByText("Acknowledged", { exact: true }),
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
    await fieldEditor
      .getByRole("textbox", { name: "Value", exact: true })
      .fill(reviewedFact);
    await selectOption(
      engineer,
      "Reviewed answers",
      /parcel-report.*Export the report as UTF-8 JSON/u,
    );
    // The old citation remains inspectable in the previous dossier revision.
    await fieldEditor
      .getByLabel("Evidence", { exact: true })
      .locator("..")
      .getByLabel("close")
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

    await expert
      .getByTestId("answer-box")
      .fill("The format also requires a schema.");
    await expert
      .getByRole("button", { name: "Submit answer", exact: true })
      .click();
    await expect(
      field.getByText("A linked reviewed answer changed"),
    ).toBeVisible();
    await testInfo.attach("workflow-decision-readiness", {
      body: await engineer.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  } finally {
    await Promise.all(pages.map((page) => page.context().close()));
    await service.close();
    await provider.stop();
  }
});
