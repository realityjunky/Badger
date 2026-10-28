import { expect, test, type Page } from "@playwright/test";

interface PreferencePatch {
  language?: "en" | "zh";
  theme?: "system" | "light" | "dark";
  fontScale?: number;
  railCollapsed?: boolean;
}

/** Saves choices through the same endpoint the dashboard uses. */
async function setPreferences(
  page: Page,
  patch: PreferencePatch,
): Promise<void> {
  await page.evaluate(async (changes) => {
    const current = (await (await fetch("/api/v1/me/preferences")).json()) as {
      preferences: Record<string, unknown>;
    };
    const response = await fetch("/api/v1/me/preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        language: current.preferences["language"],
        theme: current.preferences["theme"],
        fontScale: current.preferences["fontScale"],
        railCollapsed: current.preferences["railCollapsed"],
        ...changes,
        revision: current.preferences["revision"],
      }),
    });
    if (!response.ok) {
      throw new Error(`Saving preferences answered ${response.status}`);
    }
  }, patch);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/my-work");
  await setPreferences(page, {
    language: "en",
    theme: "light",
    fontScale: 100,
    railCollapsed: false,
  });
  await page.reload();
  await expect(page.getByTestId("page-my-work")).toBeVisible();
});

test("lands on My work at its own URL", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveURL(/\/my-work$/u);
  await expect(
    page.getByRole("heading", { name: "My work", level: 1 }),
  ).toBeVisible();
  await expect(page.getByTestId("summary-strip")).toBeVisible();
});

test("the rail is 228px and the top bar is 68px", async ({ page }) => {
  const rail = await page.getByTestId("navigation-rail").boundingBox();
  const topBar = await page.getByTestId("top-bar").boundingBox();

  expect(rail?.width).toBe(228);
  expect(topBar?.height).toBe(68);
  await expect(page.getByTestId("scope-selector")).toBeVisible();
  await expect(page.getByTestId("search-input")).toBeVisible();
  await expect(page.getByTestId("inbox-button")).toBeVisible();
  await expect(page.getByTestId("language-switch")).toBeVisible();
  await expect(page.getByTestId("user-menu")).toBeVisible();
});

test("the rail collapses to 64px and remembers it", async ({ page }) => {
  await page.getByTestId("rail-collapse").click();

  await expect
    .poll(
      async () =>
        (await page.getByTestId("navigation-rail").boundingBox())?.width,
    )
    .toBe(64);

  await page.reload();
  await expect
    .poll(
      async () =>
        (await page.getByTestId("navigation-rail").boundingBox())?.width,
    )
    .toBe(64);
});

test("the three panes sit in a row, then stack below 1180px", async ({
  page,
}) => {
  await page.goto("/questionnaire/questions/q-1");

  const explorer = await page.getByTestId("explorer-pane").boundingBox();
  const main = await page.getByTestId("main-pane").boundingBox();
  const inspector = await page.getByTestId("inspector-pane").boundingBox();
  expect(explorer).not.toBeNull();
  expect(main).not.toBeNull();
  expect(inspector).not.toBeNull();
  expect(Math.abs((explorer?.y ?? 0) - (main?.y ?? 0))).toBeLessThan(2);
  expect(Math.abs((main?.y ?? 0) - (inspector?.y ?? 0))).toBeLessThan(2);
  expect(explorer?.width).toBeGreaterThanOrEqual(260);
  expect(explorer?.width).toBeLessThanOrEqual(320);
  expect(inspector?.width).toBeGreaterThanOrEqual(280);
  expect(inspector?.width).toBeLessThanOrEqual(320);

  await page.setViewportSize({ width: 1100, height: 900 });
  const stackedExplorer = await page.getByTestId("explorer-pane").boundingBox();
  const stackedMain = await page.getByTestId("main-pane").boundingBox();
  expect(
    (stackedMain?.y ?? 0) -
      ((stackedExplorer?.y ?? 0) + (stackedExplorer?.height ?? 0)),
  ).toBeGreaterThan(-2);
});

test("the rail becomes a drawer below 1024px", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.reload();

  await expect(page.getByTestId("rail-open")).toBeVisible();
  await page.getByTestId("rail-open").click();
  await expect(page.getByTestId("navigation-rail")).toHaveAttribute(
    "data-drawer-open",
    "true",
  );

  await page.getByRole("link", { name: "Workflows" }).click();
  await expect(page).toHaveURL(/\/workflows$/u);
  await expect(page.getByTestId("navigation-rail")).toHaveAttribute(
    "data-drawer-open",
    "false",
  );
});

test("switching language keeps the page and form state, and survives reload", async ({
  page,
}) => {
  await page.goto("/questionnaire/questions/q-1");
  await page.getByTestId("answer-box").fill("The sample is collected at 4°C.");

  await page.getByTestId("language-switch").click();
  await page.getByRole("menuitem", { name: "中文" }).click();

  await expect(page).toHaveURL(/\/questionnaire\/questions\/q-1$/u);
  await expect(page.getByTestId("answer-box")).toHaveValue(
    "The sample is collected at 4°C.",
  );
  await expect(
    page.getByRole("heading", { name: "问卷", level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "我的工作" })).toBeVisible();

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "问卷", level: 1 }),
  ).toBeVisible();
});

test("theme and text size persist for the person", async ({ page }) => {
  await page.goto("/settings/appearance");

  await page.getByText("Dark", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  const heading = page.getByRole("heading", { name: "Personal settings" });
  const before = await heading.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );

  await page.getByRole("button", { name: "Larger text" }).click();
  await expect(page.getByTestId("font-scale-value")).toHaveText("110%");
  await expect(page.getByTestId("save-state")).toHaveText("Saved");
  const after = await heading.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
  expect(after).toBeGreaterThan(before);

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByTestId("font-scale-value")).toHaveText("110%");
});

test("follows the system theme while the person follows it", async ({
  page,
}) => {
  await setPreferences(page, { theme: "system" });
  await page.reload();

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("deep links, refresh, and history restore the page", async ({ page }) => {
  await page.goto("/workflows/w-1/versions/v-1");
  await expect(
    page.getByRole("heading", { name: "Workflows", level: 1 }),
  ).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/\/workflows\/w-1\/versions\/v-1$/u);

  await page.getByRole("link", { name: "My work" }).click();
  await expect(page).toHaveURL(/\/my-work$/u);
  await page.goBack();
  await expect(page).toHaveURL(/\/workflows\/w-1\/versions\/v-1$/u);
  await expect(
    page.getByRole("heading", { name: "Workflows", level: 1 }),
  ).toBeVisible();
});

test("every control is reachable by keyboard", async ({ page }) => {
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();

  const language = page.getByTestId("language-switch");
  let reached = false;
  for (let step = 0; step < 40 && !reached; step += 1) {
    await page.keyboard.press("Tab");
    reached = await language.evaluate(
      (element) => element === document.activeElement,
    );
  }
  expect(reached).toBe(true);

  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "中文" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("reduced motion stops the stage animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/workflows");

  const animation = await page
    .locator(".stage-marker")
    .first()
    .evaluate((element) => getComputedStyle(element).animationName);
  expect(animation).toBe("none");
});

for (const theme of ["light", "dark"] as const) {
  test(`visual check in ${theme}`, async ({ page }) => {
    await setPreferences(page, { theme, language: "en", fontScale: 100 });
    await page.goto("/questionnaire/questions/q-1");
    await expect(page.getByTestId("page-questionnaire")).toBeVisible();
    await page.waitForLoadState("networkidle");

    await expect(page).toHaveScreenshot(`dashboard-${theme}.png`, {
      fullPage: true,
    });
  });
}
