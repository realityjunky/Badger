import { expect, test, type Locator, type Page } from "@playwright/test";

const base = "http://127.0.0.1:4320/badger";

async function expectScrollNear(page: Page, position: number) {
  await expect
    .poll(async () =>
      Math.abs((await page.evaluate(() => window.scrollY)) - position),
    )
    .toBeLessThan(100);
}

async function waitForAnimations(content: Locator) {
  await expect
    .poll(() =>
      content.evaluate((element) =>
        element
          .getAnimations({ subtree: true })
          .some((animation) => animation.playState === "running"),
      ),
    )
    .toBe(false);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function holdRefresh(page: Page, url: string) {
  const started = deferred();
  const released = deferred();
  const completed = deferred();
  let intercepted = false;
  await page.route(url, async (route) => {
    intercepted = true;
    started.resolve();
    await released.promise;
    await route.continue();
    completed.resolve();
  });
  return {
    started: started.promise,
    release: async () => {
      released.resolve();
      if (intercepted) await completed.promise;
      await page.unroute(url);
    },
  };
}

async function keepScrollDuringRefresh(
  page: Page,
  url: string,
  content: Locator,
  action: () => Promise<void>,
) {
  const refresh = await holdRefresh(page, url);
  const before = await page.evaluate(() => window.scrollY);
  try {
    await action();
    await refresh.started;
    await expect(content).toBeVisible();
    await expectScrollNear(page, before);
  } finally {
    await refresh.release();
  }
}

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
      if (!response.ok) {
        throw new Error(`${method} ${path} answered ${response.status}`);
      }
      return response.json() as Promise<T>;
    },
    { method, path, body },
  );
}

test("assigning and removing workflow roles keep the page's scroll position", async ({
  page,
}) => {
  await page.goto(`${base}/my-work`);
  await page.getByTestId("language-switch").click();
  await page.getByRole("menuitem", { name: "English" }).click();
  const name = `scroll-journey-${Date.now()}`;
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
    goal: "Keep the team editor in view after edits.",
    intent: "new-skill",
    locale: "en",
  });
  await page.goto(`${base}/workflows/${workflow.id}/versions/${version.id}`);
  const team = page.locator(".workflow-panel").filter({
    has: page.getByRole("heading", { name: "Workflow team", exact: true }),
  });
  const robotSettings = page.getByRole("button", {
    name: "Team chat robot",
    exact: true,
  });
  await robotSettings.click();
  const saveRobot = page.getByRole("button", {
    name: "Save and send test post",
    exact: true,
  });
  await expect(saveRobot).toBeVisible();
  await team.getByRole("textbox", { name: "Email" }).fill("scroll@example.com");
  const role = team.getByRole("combobox", { name: /Workflow role/u });
  await role.click();
  await role.press("ArrowDown");
  await role.press("Enter");
  await expect(team.locator(".ant-select")).toContainText("Field expert");
  const assign = team.getByRole("button", { name: "Assign role", exact: true });
  await assign.scrollIntoViewIfNeeded();
  const beforeAssign = await page.evaluate(() => window.scrollY);
  expect(beforeAssign).toBeGreaterThan(100);
  const detailUrl = `${base}/api/v1/workflows/${workflow.id}`;
  await keepScrollDuringRefresh(page, detailUrl, team, () => assign.click());
  const binding = team.locator("li").filter({ hasText: "scroll@example.com" });
  await expect(binding).toBeVisible();
  await expectScrollNear(page, beforeAssign);
  await expect(team.locator(".ant-select")).toContainText("Field expert");
  await expect(saveRobot).toBeVisible();

  const remove = binding.getByRole("button", { name: /^Remove role/u });
  await remove.scrollIntoViewIfNeeded();
  await remove.click();
  const confirmation = page.getByRole("tooltip");
  const confirm = confirmation.getByRole("button", {
    name: "Remove role",
    exact: true,
  });
  await expect(confirm).toBeVisible();
  await waitForAnimations(confirmation);
  await confirm.scrollIntoViewIfNeeded();
  const beforeRemove = await page.evaluate(() => window.scrollY);
  const confirmBox = await confirm.boundingBox();
  expect(confirmBox).not.toBeNull();
  await keepScrollDuringRefresh(page, detailUrl, team, () =>
    page.mouse.click(
      confirmBox!.x + confirmBox!.width / 2,
      confirmBox!.y + confirmBox!.height / 2,
    ),
  );
  await expect(binding).toHaveCount(0);
  await expectScrollNear(page, beforeRemove);
  await expect(saveRobot).toBeVisible();
});

test("refreshing a Run keeps the scrolled report and expanded sections mounted", async ({
  page,
}) => {
  await page.goto(`${base}/demo/runs`);
  await page
    .getByRole("link", { name: "sample-review-001", exact: true })
    .click();
  const report = page.getByTestId("page-runs");
  const lastSection = report.locator(".ant-collapse-header").last();
  await lastSection.click();
  const pendingSection = report.locator(".ant-collapse-header").nth(-2);
  await pendingSection.click();
  await waitForAnimations(report);
  await lastSection.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(100);
  const runId = new URL(page.url()).pathname.split("/").at(-1);
  await keepScrollDuringRefresh(
    page,
    `${base}/demo/api/v1/runs/${runId}`,
    lastSection,
    () =>
      page
        .getByRole("button", { name: "Reload records", exact: true })
        .dispatchEvent("click"),
  );
  await expect(lastSection).toHaveAttribute("aria-expanded", "true");
  await expect(pendingSection).toHaveAttribute("aria-expanded", "true");
  await expectScrollNear(page, before);
});

test("reloading notification preferences after an edit conflict keeps the form in view", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 480 });
  await page.goto(`${base}/settings/channels`);
  await page.getByTestId("language-switch").click();
  await page.getByRole("menuitem", { name: "English" }).click();
  const userid = page.getByRole("textbox", {
    name: "WeCom userid",
    exact: true,
  });
  await expect(userid).toBeVisible();
  const { preferences } = await call<{ preferences: Record<string, unknown> }>(
    page,
    "GET",
    "/me/notifications",
  );
  await call(page, "PUT", "/me/notifications", {
    ...preferences,
    wecomUserId: "updated-in-another-tab",
  });
  await userid.fill("my-edited-address");
  await page
    .getByRole("button", { name: "Save notification preferences", exact: true })
    .click();
  const reload = page.getByRole("button", {
    name: "Reload records",
    exact: true,
  });
  await expect(reload).toBeVisible();
  await userid.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(0);
  await keepScrollDuringRefresh(
    page,
    `${base}/api/v1/me/notifications`,
    userid,
    () => reload.dispatchEvent("click"),
  );
  await expect(userid).toHaveValue("updated-in-another-tab");
  await expectScrollNear(page, before);
});
