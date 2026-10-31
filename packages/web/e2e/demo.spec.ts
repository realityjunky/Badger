import { expect, test } from "@playwright/test";

test("browse all seven demo pages and follow fixture records without live requests or writes", async ({
  page,
}) => {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname.includes("/api/") &&
      (!url.pathname.startsWith("/demo/api/") || request.method() !== "GET")
    ) {
      problems.push(`${request.method()} ${url.pathname}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400)
      problems.push(`${response.status()} ${response.url()}`);
  });

  await page.goto("/demo");
  await expect(page.getByTestId("demo-banner")).toContainText("read-only");
  await expect(page.getByTestId("metric-questions")).toContainText("1");
  await expect(
    page.getByRole("link", { name: /answer a Run gate/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Mark read", exact: true }).first(),
  ).toBeDisabled();
  await page
    .getByRole("link", { name: /What evidence must a person review/ })
    .click();
  await expect(page).toHaveURL(
    /\/demo\/questionnaire\/questions\/demo-question$/,
  );
  await expect(
    page
      .getByText(
        "Review the synthetic input, the findings, and the validation summary before release.",
        { exact: true },
      )
      .first(),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Your answer" })).toHaveCount(
    0,
  );

  const nav = page.getByRole("navigation", { name: "Primary navigation" });
  await nav.getByRole("link", { name: "Workflows", exact: true }).click();
  await page.getByRole("link", { name: "Sample review", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Sample review", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit workflow", exact: true }),
  ).toHaveCount(0);
  await nav.getByRole("link", { name: "Questionnaire", exact: true }).click();
  await expect(
    page.getByText("Release evidence", { exact: false }).first(),
  ).toBeVisible();
  await nav.getByRole("link", { name: "Skills", exact: true }).click();
  await page.getByRole("link", { name: /Sample review Skill/ }).click();
  await expect(page.locator(".skills-file-preview")).toContainText(
    "Use synthetic examples only.",
  );
  await nav.getByRole("link", { name: "Runs", exact: true }).click();
  await page
    .getByRole("link", { name: "sample-review-001", exact: true })
    .click();
  await expect(
    page.getByText("Release this synthetic review result?", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review answer", exact: true }),
  ).toHaveCount(0);
  await nav.getByRole("link", { name: "Evaluations", exact: true }).click();
  await expect(page.getByTestId("evaluation-report")).toContainText(
    "Illustrative result",
  );
  await nav.getByRole("link", { name: "Activity", exact: true }).click();
  await expect(page.getByTestId("activity-table")).toContainText(
    "publication.published",
  );
  await page.reload();
  await expect(page.getByTestId("activity-table")).toBeVisible();

  await nav
    .getByRole("link", { name: "Personal settings", exact: true })
    .click();
  await page.getByText("Dark", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(
    page.getByRole("tab", { name: "Personal access tokens", exact: true }),
  ).toHaveCount(0);
  await page.getByTestId("language-switch").click();
  await page.getByRole("menuitem", { name: "中文" }).click();
  await expect(page.getByTestId("demo-banner")).toContainText("只读");
  await page.reload();
  await expect(page.getByTestId("demo-banner")).toContainText("read-only");
  expect(problems).toEqual([]);
});

test("demo links and assets keep the deployment base path", async ({
  page,
}) => {
  const prefix =
    process.env["BADGER_DEMO_TEST_PREFIX"] ?? "http://127.0.0.1:4320/badger";
  await page.goto(`${prefix}/demo/questionnaire/questions/demo-question`);
  await expect(page.getByTestId("demo-banner")).toBeVisible();
  await expect(page.getByTestId("page-questionnaire")).toBeVisible();
  await page
    .getByRole("navigation", { name: "Primary navigation" })
    .getByRole("link", { name: "Runs", exact: true })
    .click();
  await expect(page).toHaveURL(`${prefix}/demo/runs`);
  await page
    .getByRole("link", { name: "sample-review-001", exact: true })
    .click();
  await page.reload();
  await expect(
    page.getByText("Release this synthetic review result?", { exact: true }),
  ).toBeVisible();
});

test("HTML entry aliases retain demo isolation", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.includes("/api/") && !path.startsWith("/demo/api/"))
      requests.push(path);
  });
  for (const entry of [
    "/demo/index.html",
    "/demo/%69ndex.html",
    "/demo/assets/..%2findex.html",
  ]) {
    await page.goto(entry);
    await expect(page.getByTestId("demo-banner")).toBeVisible();
    await page
      .getByRole("link", { name: "Go to My work", exact: true })
      .click();
    await expect(page.getByTestId("metric-inbox")).toContainText("2");
    await expect(page).toHaveURL(/\/demo\/my-work$/);
  }
  expect(requests).toEqual([]);
});
