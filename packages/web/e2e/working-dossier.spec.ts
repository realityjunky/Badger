import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { WorkingDossierJob } from "@realityjunky/badger";
import {
  base,
  cite,
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
  await team.expert.getByText("Workflow details", { exact: true }).click();
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
  const archive = await uploadSource(
    team.engineer,
    multi.groupId,
    textSkill(
      "archive-notice",
      "Archive a calendar notice.",
      "notice.txt in UTF-8.",
      "archive.zip containing the notice.",
    ),
  );
  const second = await openPinSet(deployment.service, team, multi, [
    renderer,
    archive,
    dates,
  ]);
  expect(second.ids.workflowId).not.toBe(first.ids.workflowId);
  expect(second.job.dossier.pinsHash).not.toBe(first.job.dossier.pinsHash);
  expect(second.job.schema).toEqual(first.job.schema);
  expect(second.job.instructions).toBe(first.job.instructions);
  expect(second.prompt.split(first.job.instructions)[1]).toBe(
    first.prompt.split(first.job.instructions)[1],
  );
  const content = textContent([dates, renderer]);
  const handoffId = `${dates.name}-to-${renderer.name}`;
  content.nodes["check-dates"] = {
    label: "Check dates",
    order: 2,
    kind: "required-skill-call",
    parent: renderer.name,
    skillId: dates.skillId,
    hash: dates.hash,
  };
  content.interfaces["dates-to-check"] = {
    producer: dates.name,
    consumer: "check-dates",
    status: "proposed",
    producerEvidence: [cite(dates, "references/contract.md", "Output")],
    consumerEvidence: [],
  };
  content.findings["date-format"] = {
    fields: [`interface/${handoffId}/shape`],
    evidence: [cite(dates, "references/contract.md", "Output")],
    consequence: "The date format is required for rendering.",
  };
  await save(team, second.ids, firstEdit(second.job, content));

  const page = team.expert;
  const diagram = page.getByRole("region", { name: "Workflow diagram" });
  const producer = diagram.getByRole("button", { name: dates.name });
  const consumer = diagram.getByRole("button", { name: renderer.name });
  const requiredCall = diagram.getByRole("button", { name: "Check dates" });
  await expect(requiredCall).toContainText("Required Skill call");
  const [startBox, endBox, callBox] = await Promise.all([
    producer.boundingBox(),
    consumer.boundingBox(),
    requiredCall.boundingBox(),
  ]);
  expect(startBox!.x).toBeLessThan(endBox!.x);
  expect(startBox!.y).toBe(endBox!.y);
  expect(callBox!.x).toBe(endBox!.x);
  expect(callBox!.y).toBeGreaterThan(endBox!.y);

  await page.getByRole("tab", { name: "Handoffs", exact: true }).click();
  const detail = page.getByRole("region", { name: "Dossier details" });
  const handoff = page.getByRole("combobox", { name: "Handoff" });
  await expect(detail).toBeHidden();
  await expect(
    handoff.locator("optgroup[label=Documented] option"),
  ).toHaveCount(1);
  await expect(handoff.locator("optgroup[label=Proposed] option")).toHaveCount(
    1,
  );
  await handoff.selectOption(handoffId);
  await expect(detail).toContainText("dates.json");
  await expect(detail).toContainText("Documented");
  await expect(detail).not.toContainText(renderer.hash);
  await expect(detail).not.toContainText(dates.hash);
  expect((await detail.boundingBox())!.y).toBeGreaterThan(
    (await diagram.boundingBox())!.y + (await diagram.boundingBox())!.height,
  );
  const endpoint = detail.locator(".working-dossier-endpoints section").filter({
    has: page.getByRole("heading", { name: "Producer" }),
  });
  const evidence = endpoint.getByRole("button", {
    name: "references/contract.md:L4",
  });
  await expect(evidence).toBeHidden();
  await endpoint.getByText("Source evidence", { exact: true }).click();
  await evidence.click();
  const excerpt = page.getByRole("dialog", {
    name: "references/contract.md:L4",
  });
  await expect(excerpt).toContainText(
    "Output dates.json as a JSON array of ISO calendar dates.",
  );
  await excerpt.getByRole("button", { name: "Close", exact: true }).click();
  await expect(excerpt).toBeHidden();

  // Both arrows between these Nodes remain clickable where they run in parallel.
  await diagram.evaluate((region) =>
    region.scrollIntoView({ block: "center", behavior: "instant" }),
  );
  for (const [variant, tab] of [
    ["next", "Routes"],
    ["documented", "Handoffs"],
  ]) {
    const arrow = diagram.locator(
      `path[data-variant="${variant}"] + .working-dossier-edge-target`,
    );
    const point = await arrow.evaluate((path: SVGPathElement) => {
      const center = path.getPointAtLength(path.getTotalLength() / 2);
      const result = center.matrixTransform(path.getScreenCTM()!);
      return { x: result.x, y: result.y };
    });
    await page.mouse.click(point.x, point.y);
    await expect(
      page.getByRole("tab", { name: tab, exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  }

  await page.getByRole("tab", { name: "Material findings" }).click();
  await page
    .getByRole("combobox", { name: "Material finding", exact: true })
    .selectOption("date-format");
  await expect(detail).toContainText(
    "The date format is required for rendering.",
  );
  await expect(detail).toContainText("Format and shape");
  await expect(
    diagram.locator('path[data-variant="documented"][data-highlighted="true"]'),
  ).toHaveCount(1);

  await page.getByRole("tab", { name: "Pinned Skills" }).click();
  const pins = page.getByRole("region", { name: "Pinned Skills" });
  await pins.getByRole("button", { name: dates.name }).click();
  await expect(producer).toHaveAttribute("data-highlighted", "true");
  await expect(requiredCall).toHaveAttribute("data-highlighted", "true");
  await expect(consumer).toHaveAttribute("data-highlighted", "false");
  await requiredCall.click();
  await expect(detail).toContainText(`Parent Node · ${renderer.name}`);
  await pins.getByRole("button", { name: archive.name }).click();
  await expect(detail).toContainText(
    "This Skill has no recorded use in the diagram.",
  );
  await expect(diagram.getByRole("button", { name: archive.name })).toHaveCount(
    0,
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "More study tabs" })
    .click({ timeout: 5_000 });
  await page
    .getByRole("listbox", { name: "More study tabs" })
    .getByRole("option", { name: "Handoffs", exact: true })
    .click({ timeout: 5_000 });
  await expect(handoff).toHaveValue(handoffId);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBe(390);
  const canvas = diagram.getByRole("group", { name: "Skill occurrences" });
  expect(
    await canvas.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(true);
});
