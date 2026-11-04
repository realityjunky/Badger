import { expect, test, type Page } from "@playwright/test";

// The base-path server keeps this journey's records out of the main server's
// visual checks, and proves the inbox's deep links resolve under a prefix.
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

test("a person confirms Sources, and the inbox announces its invalidation under a base path", async ({
  page,
}) => {
  const name = `gate-journey-${Date.now()}`;
  await page.goto(`${base}/my-work`);
  await page.getByTestId("language-switch").click();
  await page.getByRole("menuitem", { name: "English" }).click();

  // The local Administrator creates the workflow, so it is the Workflow owner.
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
    goal: "Confirm reviewed sources.",
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
        `---\nname: ${name}-source\ndescription: Example source\n---\n\nUse the source.\n`,
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

  // The gate opens once the worker's check passes, and shows what it binds.
  await page.goto(`${base}${versionPath}#sources`);
  const review = page.getByRole("button", { name: "Review Sources" });
  await expect(review).toBeVisible({ timeout: 20_000 });
  await review.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "completes Sources and opens Source study",
  );
  await expect(dialog).toContainText(`${name}-source`);
  await expect(dialog).toContainText(preview.hash);
  await dialog.getByRole("button", { name: "Confirm source set" }).click();
  await expect(page.getByText(/^Sources confirmed /u)).toBeVisible();
  await expect(review).toHaveCount(0);

  // Removing the pin invalidates the confirmation and tells the owner.
  const { pins } = await call<{ pins: { revision: number }[] }>(
    page,
    "GET",
    `${versionPath}/pins`,
  );
  await call(page, "DELETE", `${versionPath}/pins/${skill.id}`, {
    revision: pins[0]!.revision,
  });
  const { unreadCount } = await call<{ unreadCount: number }>(
    page,
    "GET",
    "/me/inbox",
  );
  expect(unreadCount).toBeGreaterThan(0);
  const unread = (count: number) =>
    count === 0 ? "Open inbox" : `Inbox: ${count} unread items`;

  await page.goto(`${base}/my-work`);
  const bell = page.getByTestId("inbox-button");
  await expect(bell).toHaveAccessibleName(unread(unreadCount));
  const item = page.getByRole("listitem").filter({ hasText: name });
  await expect(item.locator(".ant-tag")).toHaveText("Unread");
  await item
    .getByRole("link", {
      name: `${name} · v1: Sources confirmation invalidated`,
    })
    .click();
  await expect(page).toHaveURL(`${base}${versionPath}#sources`);
  await expect(
    page.getByText("The pins changed. Review and confirm the source set again"),
  ).toBeVisible();
  // Following the link marks the item read.
  await expect(bell).toHaveAccessibleName(unread(unreadCount - 1));
  await page.goto(`${base}/my-work`);
  await expect(item.locator(".ant-tag")).toHaveText("Read");
});
