import { expect, test } from "@playwright/test";

// A deployment behind a reverse proxy serves the dashboard under a prefix. Its
// document has to point the app's code and routes there: when it did not, the
// page stayed blank while health and the API still answered (#39).
const PREFIX = "http://127.0.0.1:4320/badger";

test("the dashboard loads under a base path, at its root and on a deep link", async ({
  page,
}) => {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("response", (response) => {
    const type = response.headers()["content-type"] ?? "";
    if (
      response.request().resourceType() === "script" &&
      !type.includes("javascript")
    ) {
      problems.push(`${response.url()} answered ${type}`);
    }
  });

  await page.goto(`${PREFIX}/`);
  await expect(page).toHaveURL(`${PREFIX}/my-work`);
  await expect(page.getByTestId("page-my-work")).toBeVisible();
  await expect(page.getByTestId("user-menu")).toContainText("Alex Chen");

  await page.goto(`${PREFIX}/workflows`);
  await expect(page).toHaveURL(`${PREFIX}/workflows`);
  await expect(page.getByTestId("navigation-rail")).toBeVisible();

  expect(problems).toEqual([]);
});
