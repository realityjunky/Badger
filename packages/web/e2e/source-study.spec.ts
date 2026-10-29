import { expect, test, type Page } from "@playwright/test";

// The base-path server keeps this journey's records out of the main server's
// visual checks.
const origin = "http://127.0.0.1:4320";
const base = `${origin}/badger`;

/** Calls the API the dashboard uses, as the signed-in page. */
async function call<T>(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const response = await fetch(`/badger/api/v1${path}`, {
        method,
        headers:
          body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `${method} ${path} answered ${response.status}: ${text}`,
        );
      }
      return (text === "" ? null : JSON.parse(text)) as T;
    },
    { method, path, body },
  );
}

function file(path: string, text: string) {
  return { path, content: Buffer.from(text).toString("base64") };
}

test("an Engineer records a cited fact, opens its lines, and marks the pinned version studied", async ({
  page,
}) => {
  const name = `study-journey-${Date.now()}`;
  await page.goto(`${base}/my-work`);
  await page.getByTestId("language-switch").click();
  await page.getByRole("menuitem", { name: "English" }).click();

  // The local Administrator creates the workflow and pins one Skill version.
  const { group } = await call<{ group: { id: string } }>(
    page,
    "POST",
    "/groups",
    { name },
  );
  const { workflow, version } = await call<{
    workflow: { id: string };
    version: { id: string };
  }>(page, "POST", "/workflows", {
    groupId: group.id,
    name,
    goal: "Study the pinned sources.",
    intent: "new-skill",
    locale: "en",
  });
  const { skill } = await call<{ skill: { id: string } }>(
    page,
    "POST",
    "/skills",
    { groupId: group.id, name: `${name}-source` },
  );
  const upload = {
    files: [
      file(
        "SKILL.md",
        `---\nname: ${name}-source\ndescription: Example source\n---\n\nRead reference/guide.md.\n`,
      ),
      file(
        "reference/guide.md",
        "# Output contract\nWrite samples.tsv.\nColumns: sample_id, sequence.\n",
      ),
    ],
  };
  const { preview } = await call<{ preview: { hash: string } }>(
    page,
    "POST",
    `/skills/${skill.id}/upload-preview`,
    upload,
  );
  await call(page, "POST", `/skills/${skill.id}/versions`, {
    ...upload,
    confirmed: true,
    expectedHash: preview.hash,
  });
  const versionPath = `/workflows/${workflow.id}/versions/${version.id}`;
  await call(page, "POST", `${versionPath}/pins`, {
    skillId: skill.id,
    hash: preview.hash,
  });

  // Study waits for the confirmed source set.
  await page.goto(`${base}${versionPath}`);
  const study = page.locator("#source-study");
  await expect(study).toContainText(
    "Confirm the current Sources gate before marking versions studied",
  );
  await expect(study).toContainText("0 of 1 pinned versions studied");
  const reviewSources = page.getByRole("button", { name: "Review Sources" });
  await expect(reviewSources).toBeVisible({ timeout: 20_000 });
  await reviewSources.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm source set" })
    .click();
  await expect(page.getByText(/^Sources confirmed /u)).toBeVisible();

  // A fact cites lines of a file in the pinned version's inventory.
  await study.getByRole("button", { name: "Add fact" }).click();
  const editor = page.getByRole("dialog").filter({ hasText: "Statement" });
  await editor
    .getByLabel("Statement")
    .fill("The source writes samples.tsv with two columns.");
  await editor.getByLabel("Source path").click();
  await page
    .locator(".ant-select-item-option")
    .filter({ hasText: "reference/guide.md" })
    .click();
  await editor.getByLabel("First line").fill("2");
  await editor.getByLabel("Last line").fill("3");
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(editor).toBeHidden();

  // Its evidence link opens exactly the cited lines.
  await study.getByRole("link", { name: "reference/guide.md:2–3" }).click();
  const inspector = page
    .getByRole("dialog")
    .filter({ hasText: "Record history" });
  const lines = inspector.getByRole("region", { name: "Cited source lines" });
  await expect(lines.getByRole("listitem")).toHaveText([
    "Write samples.tsv.",
    "Columns: sample_id, sequence.",
  ]);
  await expect(inspector).toContainText("Revision 1");
  await inspector.getByRole("button", { name: "Close" }).click();
  await expect(inspector).toBeHidden();

  // Marking the only pinned version studied completes Source study.
  await study.getByRole("button", { name: "Review study" }).click();
  const review = page
    .getByRole("dialog")
    .filter({ hasText: "Mark version studied" });
  await expect(review).toContainText(
    "The source writes samples.tsv with two columns.",
  );
  await review.getByRole("button", { name: "Mark version studied" }).click();
  await expect(review).toBeHidden();
  await expect(study).toContainText("1 of 1 pinned versions studied");
  await expect(study.locator(".study-pin")).toContainText("Studied");
  const detail = await call<{
    version: { stages: { id: string; state: string }[] };
  }>(page, "GET", versionPath);
  expect(detail.version.stages).toEqual(
    expect.arrayContaining([
      { id: "source-study", state: "done" },
      { id: "questionnaire", state: "active" },
    ]),
  );
});
