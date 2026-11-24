import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { WorkingDossierJob } from "@realityjunky/badger";
import {
  base,
  createWorkflow,
  firstEdit,
  mcp,
  openPinSet,
  save,
  type MaterializedSources,
  openTeam,
  startDossierService,
  uploadSource,
  type Team,
  type WorkflowVersion,
} from "./fixtures/working-dossier-session.js";
import {
  rolesGap,
  textContent,
  textSkill,
} from "./fixtures/working-dossier-content.js";

const rolesField = "workflow/workflow/roles";

let deployment: Awaited<ReturnType<typeof startDossierService>>;
let team: Team | undefined;

test.beforeAll(async () => {
  deployment = await startDossierService();
});
test.afterAll(async () => {
  await deployment?.service.close();
  await deployment?.provider.stop();
});
test.afterEach(async () => {
  if (team) {
    await team.agent.close();
    await Promise.all(
      [team.admin, team.engineer, team.expert, team.owner].map((page) =>
        page.context().close(),
      ),
    );
    team = undefined;
  }
});

async function checkWorkstationCopies(
  team: Team,
  ids: WorkflowVersion,
  job: WorkingDossierJob,
  temporaryDirectory: string,
) {
  const [pin] = job.pins;
  const file = pin!.inventory.find((item) => item.path === "SKILL.md")!;
  const args = { ...ids, pinsHash: job.dossier.pinsHash };
  const empty = path.join(temporaryDirectory, "empty");
  const matching = path.join(temporaryDirectory, "matching");
  const changed = path.join(temporaryDirectory, "changed");
  for (const directory of [empty, matching, changed])
    await fs.mkdir(directory, { recursive: true });
  const fallback = await mcp<MaterializedSources>(
    team.agent,
    "working_dossier_sources",
    { ...args, localSourceRoot: empty },
  );
  const pinnedFile = (result: MaterializedSources) =>
    result.files.find(
      ({ skillId, path }) => skillId === pin!.skillId && path === file.path,
    )!;
  const fallbackFile = pinnedFile(fallback);
  expect(fallbackFile.source).toBe("badger");
  const original = await fs.readFile(fallbackFile.localPath);
  expect(createHash("sha256").update(original).digest("hex")).toBe(file.hash);
  await fs.writeFile(path.join(matching, file.path), original);
  await fs.writeFile(
    path.join(changed, file.path),
    Buffer.concat([original, Buffer.from("\nEdit after pinning.\n")]),
  );
  for (const [directory, expectedOrigin] of [
    [matching, "local"],
    [changed, "badger"],
  ] as const) {
    const materialized = await mcp<MaterializedSources>(
      team.agent,
      "working_dossier_sources",
      {
        ...args,
        localSkillRoots: { [pin!.skillId]: directory },
      },
    );
    const verified = pinnedFile(materialized);
    expect(verified.source).toBe(expectedOrigin);
    expect(await fs.readFile(verified.localPath)).toEqual(original);
  }
}

async function openQuestionnaire(
  page: Page,
  ids: WorkflowVersion,
  field = rolesField,
) {
  await page.goto(
    `${base}/questionnaire?workflow=${ids.workflowId}&version=${ids.versionId}&panel=ledger&dossierField=${encodeURIComponent(field)}`,
  );
}

async function fillRoles(page: Page) {
  const field = page.getByRole("article", {
    name: "Workflow · Roles",
    exact: true,
  });
  await field.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("dialog");
  await editor.getByRole("combobox", { name: "State", exact: true }).click();
  await page
    .locator(".ant-select-item-option")
    .filter({ hasText: /^Recorded decision$/u })
    .click();
  await editor
    .getByLabel("Value", { exact: true })
    .fill(
      "The Engineer coordinates work. The Workflow owner approves the dossier.",
    );
  await editor
    .getByLabel("Reason", { exact: true })
    .fill("The Engineer assigned the workflow roles.");
  await editor.getByRole("button", { name: "Save field", exact: true }).click();
  await expect(editor).toBeHidden();
}

test("the same Engineer prompt opens a dossier for single and reordered multi-Skill sources", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  team = await openTeam(browser, deployment.provider);
  const single = await createWorkflow(
    team,
    "checksum-note",
    "Calculate a checksum for a note.",
  );
  const checksum = await uploadSource(
    team.engineer,
    single.groupId,
    textSkill(
      "hash-note",
      "Read the note and calculate its checksum.",
      "note.txt as UTF-8 text.",
      "digest.txt with one SHA-256 checksum.",
    ),
  );
  const first = await openPinSet(deployment.service, team, single, [checksum]);
  await checkWorkstationCopies(
    team,
    first.ids,
    first.job,
    info.outputPath("workstations"),
  );
  const partial = firstEdit(first.job, textContent([checksum]));
  const saved = await save(team, first.ids, partial);
  expect((await save(team, first.ids, partial)).savedRevision).toBe(
    saved.savedRevision,
  );
  expect(saved.revision).toBe(first.job.dossier.revision + 1);
  await expect(
    team.expert.getByRole("button", { name: /hash-note/u }).last(),
  ).toBeVisible();
  const current = await mcp<WorkingDossierJob>(
    team.agent,
    "working_dossier_job",
    { ...first.ids },
  );
  expect(current.dossier.content.interfaces).toEqual({});
  await expect(team.expert.getByText(rolesGap, { exact: true })).toBeVisible();
  await expect(
    team.expert
      .getByRole("region", { name: "Scope", exact: true })
      .getByText("Calculate a checksum for a note.", { exact: true }),
  ).toBeVisible();
  await openQuestionnaire(team.engineer, first.ids);
  await fillRoles(team.engineer);
  const stale = await team.agent.callTool({
    name: "save_working_dossier",
    arguments: {
      ...first.ids,
      edit: { ...partial, editId: randomUUID(), revision: saved.revision },
    },
  });
  expect(stale.isError).toBe(true);
  expect(JSON.stringify(stale.content)).toMatch(/revision|conflict/iu);
  const refreshed = await mcp<WorkingDossierJob>(
    team.agent,
    "working_dossier_job",
    { ...first.ids },
  );
  expect(refreshed.dossier.revision).toBe(saved.revision + 1);
  expect(refreshed.dossier.content.fields[rolesField]?.value).toContain(
    "The Workflow owner approves",
  );

  const multi = await createWorkflow(
    team,
    "calendar-notice",
    "Prepare and render a calendar notice.",
  );
  const renderer = await uploadSource(
    team.engineer,
    multi.groupId,
    textSkill(
      "render-notice",
      "Render dates into a calendar notice.",
      "dates.json as a JSON array of ISO calendar dates.",
      "notice.txt in UTF-8.",
    ),
  );
  const dates = await uploadSource(
    team.engineer,
    multi.groupId,
    textSkill(
      "prepare-dates",
      "Prepare the dates for a calendar notice.",
      "calendar.txt with one date per line.",
      "dates.json as a JSON array of ISO calendar dates.",
    ),
  );
  const second = await openPinSet(deployment.service, team, multi, [
    renderer,
    dates,
  ]);
  expect(second.ids.workflowId).not.toBe(first.ids.workflowId);
  expect(second.job.dossier.pinsHash).not.toBe(first.job.dossier.pinsHash);
  expect(second.job.schema).toEqual(first.job.schema);
  expect(second.job.instructions).toBe(first.job.instructions);
  expect(second.prompt.split(first.job.instructions)[1]).toBe(
    first.prompt.split(first.job.instructions)[1],
  );
  await save(
    team,
    second.ids,
    firstEdit(second.job, textContent([dates, renderer])),
  );
  await expect(
    team.expert.getByRole("button", {
      name: "Next route from prepare-dates to render-notice",
      exact: true,
    }),
  ).toBeVisible();
  const edge = team.expert.getByRole("button", {
    name: /prepare-dates → render-notice/u,
  });
  await expect(edge).toBeVisible();
  await edge.click();
  const detail = team.expert.getByRole("region", { name: "Dossier details" });
  await expect(detail).toContainText("dates.json");
  await expect(detail).toContainText("Documented");
  await expect(detail).toContainText(renderer.hash);
  await expect(detail).toContainText(dates.hash);
});
