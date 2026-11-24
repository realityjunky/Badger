import { expect, test, type Page } from "@playwright/test";
import type {
  WorkingDossierEdit,
  WorkingDossierView,
} from "@realityjunky/badger";
import {
  cite,
  workflowPath,
  type UploadedSource,
} from "./fixtures/working-dossier-session.js";
import { textContent, textSkill } from "./fixtures/working-dossier-content.js";

const origin = "http://127.0.0.1:4320";
const base = `${origin}/badger`;

async function api<Result>(
  page: Page,
  method: string,
  endpoint: string,
  data?: unknown,
) {
  const response = await page.request.fetch(`${base}/api/v1${endpoint}`, {
    method,
    headers: { origin },
    data,
  });
  expect(response.ok(), `${method} ${endpoint}: ${response.status()}`).toBe(
    true,
  );
  return (await response.json()) as Result;
}

async function select(page: Page, name: string, option: string) {
  const combobox = page
    .getByRole("dialog")
    .getByRole("combobox", { name, exact: true });
  await combobox.focus();
  await combobox.press("ArrowDown");
  await expect(combobox).toHaveAttribute("aria-expanded", "true");
  await expect(combobox).toHaveAttribute("aria-activedescendant", /.+/u);
  const listbox = await combobox.getAttribute("aria-controls");
  const visited = new Set<string>();
  for (;;) {
    const active = (await combobox.getAttribute("aria-activedescendant"))!;
    const selected = page
      .locator(`[id="${listbox}"]`)
      .getByRole("option", { name: option, exact: true, includeHidden: true });
    if (
      (await selected.count()) === 1 &&
      (await selected.getAttribute("id")) === active
    ) {
      await combobox.press("Enter");
      await expect(combobox).toHaveAttribute("aria-expanded", "false");
      return;
    }
    expect(visited.has(active)).toBe(false);
    visited.add(active);
    await combobox.press("ArrowDown");
  }
}

test("an Engineer edits bounded rework and removes dependent or stale dossier records", async ({
  page,
}) => {
  page.setDefaultTimeout(10000);
  await page.goto(`${base}/my-work`);
  await page.getByTestId("language-switch").click();
  await page.getByRole("menuitem", { name: "English", exact: true }).click();
  const { group } = await api<{ group: { id: string } }>(
    page,
    "POST",
    "/groups",
    { name: `Dossier repair ${Date.now()}` },
  );
  const { workflow, version } = await api<{
    workflow: { id: string };
    version: { id: string };
  }>(page, "POST", "/workflows", {
    groupId: group.id,
    name: "calendar-notice",
    goal: "Prepare a calendar notice.",
    intent: "new-skill",
    locale: "en",
  });
  const root = workflowPath({ workflowId: workflow.id, versionId: version.id });
  const sources: UploadedSource[] = [];
  for (const fixture of [
    textSkill(
      "prepare-dates",
      "Prepare dates.",
      "dates.csv",
      "dates.json with ISO dates.",
    ),
    textSkill(
      "render-notice",
      "Render notice.",
      "dates.json with ISO dates.",
      "notice.txt",
    ),
  ]) {
    const { skill } = await api<{ skill: { id: string } }>(
      page,
      "POST",
      "/skills",
      { groupId: group.id, name: fixture.name },
    );
    const files = [...fixture.files].map(([path, bytes]) => ({
      path,
      content: bytes.toString("base64"),
    }));
    const skillPath = `/skills/${skill.id}`;
    const { preview } = await api<{
      preview: Omit<UploadedSource, "skillId" | "name" | "files">;
    }>(page, "POST", `${skillPath}/upload-preview`, { files });
    await api(page, "POST", `${skillPath}/versions`, {
      files,
      expectedHash: preview.hash,
      confirmed: true,
    });
    await api(page, "POST", `${root}/pins`, {
      skillId: skill.id,
      hash: preview.hash,
    });
    sources.push({ ...fixture, ...preview, skillId: skill.id });
  }
  const path = `${root}/working-dossier`;
  await expect
    .poll(
      async () => (await api<WorkingDossierView>(page, "GET", path)).available,
    )
    .toBe(true);
  const draft = await api<WorkingDossierView>(page, "GET", path);
  const content = textContent(sources);
  const consumer = sources[1]!;
  const handoff = "prepare-dates-to-render-notice";
  const field = `interface/${handoff}/artifact`;
  const evidence = cite(consumer, "SKILL.md", "description:");
  content.findings.affected = {
    evidence: [evidence],
    fields: [field],
    consequence: "Check notice format.",
  };
  content.findings.unpinned = {
    evidence: [evidence],
    fields: ["workflow/workflow/scope"],
    consequence: "Check the retired source.",
  };
  const edit: WorkingDossierEdit = {
    ...content,
    editId: "initial-repair-check",
    revision: draft.revision,
    pinsHash: draft.pinsHash,
  };
  const saved = await api<WorkingDossierView>(page, "PATCH", path, edit);
  const ledger = `${base}/questionnaire?workflow=${workflow.id}&version=${version.id}&panel=ledger`;
  await page.goto(ledger);
  await page.getByRole("button", { name: "Add route", exact: true }).click();
  await select(page, "From Node", "render-notice");
  await select(page, "To Node", "prepare-dates");
  await select(page, "Route type", "Bounded rework");
  await page
    .getByLabel("Condition", { exact: true })
    .fill("Retry if a date cannot be rendered.");
  await page.getByLabel("Maximum visits", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Save route", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.goto(`${base}${root}#source-study`);
  await page.getByRole("tab", { name: "Routes", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Route", exact: true })
    .selectOption({
      label:
        "Bounded rework from render-notice to prepare-dates · Retry if a date cannot be rendered.",
    });
  const detail = page.getByRole("region", {
    name: "Dossier details",
    exact: true,
  });
  await expect(detail).toContainText("Retry if a date cannot be rendered.");
  await expect(detail).toContainText("Visit limit 2");
  await page.goto(ledger);
  await page.getByText("Workflow structure", { exact: true }).click();
  const occurrence = page.locator(".working-dossier-toolbar").filter({
    has: page.getByText("render-notice", { exact: true }),
  });
  await occurrence
    .getByRole("button", { name: "Remove occurrence", exact: true })
    .click();
  const removal = page.getByRole("dialog", {
    name: "Review dossier removal",
    exact: true,
  });
  await expect(removal).toContainText("Check notice format.");
  await expect(removal).toContainText(
    "Bounded rework from render-notice to prepare-dates",
  );
  await expect(removal).toContainText("Exchanged artifact");
  await removal
    .getByRole("button", { name: "Remove from dossier", exact: true })
    .click();
  await expect(removal).toBeHidden();
  const after = await api<WorkingDossierView>(page, "GET", path);
  expect(after.revision).toBe(saved.revision + 2);
  expect(after.content.fields[field]).toBeUndefined();
  expect(after.content.nodes["render-notice"]).toBeUndefined();
  expect(after.content.interfaces[handoff]).toBeUndefined();
  expect(after.content.routes).toEqual({});
  expect(after.content.findings.affected).toBeUndefined();
  expect(after.content.findings.unpinned).toBeDefined();
  const { pins } = await api<{ pins: { skillId: string; revision: number }[] }>(
    page,
    "GET",
    root,
  );
  await api(page, "DELETE", `${root}/pins/${consumer.skillId}`, {
    revision: pins.find(({ skillId }) => skillId === consumer.skillId)!
      .revision,
  });
  await expect
    .poll(
      async () => (await api<WorkingDossierView>(page, "GET", path)).available,
    )
    .toBe(true);
  await page.reload();
  await page
    .getByRole("button", { name: "Remove finding", exact: true })
    .click();
  await removal
    .getByRole("button", { name: "Remove from dossier", exact: true })
    .click();
  await expect(removal).toBeHidden();
  await page
    .getByRole("button", { name: "Remove field", exact: true })
    .first()
    .click();
  await removal
    .getByRole("button", { name: "Remove from dossier", exact: true })
    .click();
  await expect(removal).toBeHidden();
  const final = await api<WorkingDossierView>(page, "GET", path);
  expect(final.projection.staleFindings).toEqual([]);
  expect(final.projection.removedFields).toHaveLength(2);
});
