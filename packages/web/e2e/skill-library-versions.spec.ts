import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { SkillVersion, VersionPreview } from "../src/api/skills.js";
import { readSkillArchive } from "./fixtures/skill-archive.js";

const origin = `http://127.0.0.1:${process.env["BADGER_E2E_BASE_PATH_PORT"] ?? "4320"}`;
const base = `${origin}/badger`;

async function api<Result>(
  page: Page,
  endpoint: string,
  method = "GET",
  data?: unknown,
): Promise<Result> {
  const response = await page.request.fetch(`${base}/api/v1${endpoint}`, {
    method,
    headers: { origin, "content-type": "application/json" },
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as Result;
}

async function upload(
  page: Page,
  skill: string,
  snapshot: ReadonlyMap<string, Buffer>,
) {
  const files = [...snapshot].map(([path, content]) => ({
    path,
    content: content.toString("base64"),
  }));
  const { preview } = await api<{ preview: VersionPreview }>(
    page,
    `/skills/${skill}/upload-preview`,
    "POST",
    { files },
  );
  const { version } = await api<{ version: SkillVersion }>(
    page,
    `/skills/${skill}/versions`,
    "POST",
    { files, expectedHash: preview.hash, confirmed: true },
  );
  return version;
}

async function createFixture(page: Page) {
  await page.goto(`${base}/skills`);
  await page.getByTestId("language-switch").click();
  await page.getByRole("menuitem", { name: "English", exact: true }).click();
  const name = `library-${randomUUID()}`;
  const { group } = await api<{ group: { id: string } }>(
    page,
    "/groups",
    "POST",
    {
      name,
    },
  );
  const { skill } = await api<{ skill: { id: string } }>(
    page,
    "/skills",
    "POST",
    {
      groupId: group.id,
      name,
    },
  );
  const original = new Map([
    [
      "SKILL.md",
      Buffer.from(
        `---\nname: ${name}\ndescription: Track immutable instructions\n---\nRead the current guide.\n`,
      ),
    ],
    ["references/examples/labels.bin", Buffer.from([0, 213, 178, 10, 255])],
    ["references/notes.md", Buffer.from("Keep the original note.\n")],
  ]);
  const first = await upload(page, skill.id, original);
  const location = (hash: string) =>
    `${base}/skills/${skill.id}/versions/${hash}`;
  return { skill, group, name, original, first, location };
}

test("filter the library by workflow and open the exact pinned Skill version", async ({
  page,
}) => {
  const { skill, group, name, original, first, location } =
    await createFixture(page);
  const later = await upload(
    page,
    skill.id,
    new Map(original).set("references/notes.md", Buffer.from("Newer note.\n")),
  );
  const other = `other-${randomUUID()}`;
  await api(page, "/skills", "POST", { groupId: group.id, name: other });
  const workflowName = `workflow-${randomUUID()}`;
  const { workflow, version } = await api<{
    workflow: { id: string };
    version: { id: string };
  }>(page, "/workflows", "POST", {
    groupId: group.id,
    name: workflowName,
    goal: "Browse a reviewed Skill.",
    intent: "new-skill",
    locale: "en",
  });
  await api(
    page,
    `/workflows/${workflow.id}/versions/${version.id}/pins`,
    "POST",
    {
      skillId: skill.id,
      hash: first.hash,
      purpose: "source",
    },
  );
  await page.reload();
  const library = page.getByRole("complementary", { name: "Skill library" });
  const workflowSelect = page.getByRole("combobox", {
    name: "Workflow",
    exact: true,
  });
  const skillSelect = page.getByRole("combobox", {
    name: "Skill",
    exact: true,
  });
  await expect(
    library.getByRole("link", { name: new RegExp(other) }),
  ).toBeVisible();
  await workflowSelect.click();
  await workflowSelect.fill(workflowName);
  await page.getByRole("option", { name: `${workflowName} · ${name}` }).click();
  await expect(
    library.getByRole("link", { name: new RegExp(other) }),
  ).toHaveCount(0);
  await skillSelect.click();
  await page.getByRole("option", { name: `${name} · ${name}` }).click();
  const query = `?workflow=${workflow.id}`;
  await expect(page).toHaveURL(location(first.hash) + query);
  const versions = page.getByRole("region", { name: "Versions" });
  await expect(versions).toContainText(first.hash);
  await page.reload();
  await expect(versions).toContainText(first.hash);

  await versions.getByRole("combobox", { name: "Versions" }).click();
  await page.getByText(new RegExp(`${later.hash.slice(0, 12)}$`)).click();
  await expect(page).toHaveURL(location(later.hash) + query);
  await page.goBack();
  await expect(versions).toContainText(first.hash);

  await workflowSelect.click();
  await page.getByRole("option", { name: "All workflows" }).click();
  await expect(
    library.getByRole("link", { name: new RegExp(other) }),
  ).toBeVisible();
});

test("select and download an unlabelled Skill snapshot and label it by hash", async ({
  page,
}, info) => {
  const { skill, original, first, location } = await createFixture(page);
  await page.goto(location(first.hash));
  await expect(
    page.getByRole("combobox", { name: "Versions" }).locator(".."),
  ).toContainText(`Unlabelled ·`);
  await expect(page.getByRole("region", { name: "Versions" })).toContainText(
    first.hash,
  );

  const downloading = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download ZIP" }).click();
  const download = await downloading;
  const zip = info.outputPath("original.zip");
  await download.saveAs(zip);
  expect(await fs.stat(zip).then((entry) => entry.size)).toBeGreaterThan(0);
  const extracted = await readSkillArchive(zip);
  expect(extracted).toEqual(original);
  expect(first.inventory.map(({ path, hash }) => [path, hash]).sort()).toEqual(
    [...extracted]
      .map(([path, contents]) => [
        path,
        createHash("sha256").update(contents).digest("hex"),
      ])
      .sort(),
  );

  await page.getByRole("button", { name: "Edit version label" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit version label" });
  const label = dialog.getByRole("textbox", { name: "Version label" });
  await label.fill("1.2");
  await dialog.getByRole("button", { name: "Save label" }).click();
  await expect(
    dialog.getByText("Enter a version label like 1.2.3."),
  ).toBeVisible();
  await label.fill("1.2.3");
  await dialog.getByRole("button", { name: "Save label" }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(location(first.hash));
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Versions" }).locator(".."),
  ).toContainText(`1.2.3 ·`);
  await page.goto(`${location(first.hash)}?path=references%2Fmissing.md`);
  await expect(
    page.getByText("This file is absent from this version.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Skill Questionnaire" }),
  ).toHaveAttribute(
    "href",
    `${new URL(base).pathname}/questionnaire?${new URLSearchParams({ skill: skill.id, skillVersion: first.hash })}`,
  );

  const candidate = new Map(original).set(
    "references/notes.md",
    Buffer.from("Another version.\n"),
  );
  const second = await upload(page, skill.id, candidate);
  await page.goto(location(second.hash));
  await page.getByRole("button", { name: "Edit version label" }).click();
  await label.fill("1.2.3");
  await dialog.getByRole("button", { name: "Save label" }).click();
  await expect(
    dialog.getByText(
      "That version label is already used. Choose another label.",
    ),
  ).toBeVisible();
  await label.fill("2.0.0");
  await dialog.getByRole("button", { name: "Save label" }).click();
  await expect(dialog).toBeHidden();
  await page.goto(location(first.hash));
  await expect(
    page.getByRole("combobox", { name: "Versions" }).locator(".."),
  ).toContainText("1.2.3 ·");
});

test("review browser changes against an older Skill version before saving a successor", async ({
  page,
}, info) => {
  const { skill, original, first, location } = await createFixture(page);
  const candidate = new Map(original).set(
    "references/notes.md",
    Buffer.from("Later upload.\n"),
  );
  const newer = await upload(page, skill.id, candidate);
  await page.goto(location(newer.hash));
  await page.getByRole("combobox", { name: "Versions" }).click();
  await page.getByText(new RegExp(`${first.hash.slice(0, 12)}$`)).click();
  await expect(page).toHaveURL(location(first.hash));
  await page.getByRole("button", { name: "Edit files", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit files" });
  const contents = editor.getByRole("textbox", { name: "File contents" });
  const revised = original
    .get("SKILL.md")!
    .toString()
    .replace(
      "Read the current guide.",
      "Review the guide before publishing. 支持 Unicode。",
    );
  await expect(contents).toHaveValue(original.get("SKILL.md")!.toString());
  await contents.fill(revised);
  const filePicker = editor.getByRole("combobox", { name: "File to edit" });
  async function editFile(file: string) {
    await filePicker.click();
    await page.getByText(file, { exact: true }).last().click();
  }
  await editFile("references/notes.md");
  await editor
    .getByRole("button", { name: "Remove file", exact: true })
    .click();
  await editFile("references/examples/labels.bin");
  const binary = Buffer.from([0, 255, 241, 110]);
  await editor.getByLabel("Replace with file").setInputFiles({
    name: "labels.bin",
    mimeType: "application/octet-stream",
    buffer: binary,
  });
  await editor
    .getByRole("textbox", { name: "New file path" })
    .fill("references/decision.md");
  await editor.getByRole("button", { name: "Add file", exact: true }).click();
  await contents.fill("This is a reviewed decision.\n");
  await editor.getByRole("button", { name: "Review changes" }).click();
  await expect(
    editor.getByRole("row", { name: /references\/notes\.md Removed/u }),
  ).toBeVisible();
  await expect(
    editor.getByRole("row", { name: /references\/decision\.md Added/u }),
  ).toBeVisible();
  await expect(
    editor.getByRole("row", {
      name: /references\/examples\/labels\.bin Modified/u,
    }),
  ).toBeVisible();
  await editor.getByRole("button", { name: "SKILL.md", exact: true }).click();
  await expect(
    editor.getByText("Review the guide before publishing. 支持 Unicode。", {
      exact: false,
    }),
  ).toBeVisible();
  expect(
    (
      await api<{ versions: SkillVersion[] }>(
        page,
        `/skills/${skill.id}/versions`,
      )
    ).versions,
  ).toHaveLength(2);
  await editor.getByRole("button", { name: "Save successor" }).click();
  await expect(editor).toBeHidden();
  await expect(
    page.getByText("Browser edit from", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: first.hash.slice(0, 12) }),
  ).toHaveAttribute("href", new URL(location(first.hash)).pathname);

  const downloading = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download ZIP" }).click();
  const archive = info.outputPath("successor.zip");
  await (await downloading).saveAs(archive);
  expect(await readSkillArchive(archive)).toEqual(
    new Map([
      ["SKILL.md", Buffer.from(revised)],
      ["references/decision.md", Buffer.from("This is a reviewed decision.\n")],
      ["references/examples/labels.bin", binary],
    ]),
  );
});

test("review a local upload against the explicit starting Skill version", async ({
  page,
}, info) => {
  const { skill, original, first, location } = await createFixture(page);
  const unrelated = await upload(
    page,
    skill.id,
    new Map(original).set(
      "references/notes.md",
      Buffer.from("Another author's version.\n"),
    ),
  );
  await page.goto(location(first.hash));
  const downloading = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download ZIP" }).click();
  const zip = info.outputPath("workstation.zip");
  await (await downloading).saveAs(zip);
  const files = await readSkillArchive(zip);
  const workspace = info.outputPath("workstation");
  for (const [name, content] of files) {
    const destination = path.join(workspace, name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content);
  }
  await fs.writeFile(
    path.join(workspace, "references/notes.md"),
    "Edited locally.\n",
  );

  await page.getByRole("button", { name: "Upload local changes" }).click();
  const dialog = page.getByRole("dialog", { name: /^Upload local changes/u });
  await expect(dialog).toContainText(first.hash);
  await dialog
    .getByLabel("Choose Skill folder", { exact: true })
    .setInputFiles(workspace);
  await expect(
    dialog.getByRole("row", { name: /references\/notes\.md Modified/u }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Save successor" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText("Local edit uploaded from", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: first.hash.slice(0, 12) }),
  ).toHaveAttribute("href", new URL(location(first.hash)).pathname);
  await expect(page).not.toHaveURL(location(unrelated.hash));
});

test("delete an unused version and retire a snapshot used as a base", async ({
  page,
}, info) => {
  const { skill, original, first, location } = await createFixture(page);
  const unused = await upload(
    page,
    skill.id,
    new Map(original).set(
      "references/notes.md",
      Buffer.from("A disposable upload.\n"),
    ),
  );
  const dialog = page.getByRole("dialog", { name: "Remove version" });
  await page.goto(location(unused.hash));
  await page
    .getByRole("button", { name: "Remove version", exact: true })
    .click();
  await expect(
    dialog.getByText(
      "This version has no references and can be permanently deleted.",
    ),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Delete version", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(location(first.hash));
  await page.goto(location(unused.hash));
  await expect(
    page.getByText("That Skill version is unavailable."),
  ).toBeVisible();

  await page.goto(location(first.hash));
  await page
    .getByRole("button", { name: "Remove version", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Delete version", exact: true }),
  ).toBeEnabled();
  const changes = {
    baseHash: first.hash,
    changes: [
      {
        path: "references/notes.md",
        content: Buffer.from("A derived version.\n").toString("base64"),
      },
    ],
  };
  const { preview } = await api<{ preview: VersionPreview }>(
    page,
    `/skills/${skill.id}/upload-preview`,
    "POST",
    changes,
  );
  await api(page, `/skills/${skill.id}/versions`, "POST", {
    ...changes,
    confirmed: true,
    expectedHash: preview.hash,
    confirmationHash: preview.confirmationHash,
  });
  await dialog
    .getByRole("button", { name: "Delete version", exact: true })
    .click();
  await expect(
    dialog.getByText("Version use changed. Review the available action."),
  ).toBeVisible();
  await expect(
    dialog.getByText(
      "This version has references. Retirement keeps them available and removes the version from new pin choices.",
    ),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Retire version", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(location(first.hash));
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Versions" }).locator(".."),
  ).toContainText("Retired");
  const downloading = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download ZIP" }).click();
  const zip = info.outputPath("retired.zip");
  await (await downloading).saveAs(zip);
  expect(await readSkillArchive(zip)).toEqual(original);
});
