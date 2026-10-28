import { expect, test } from "@playwright/test";

test("a person creates a token, saves its secret once, and revokes it under a base path", async ({
  page,
}, testInfo) => {
  const base = "http://127.0.0.1:4320/badger";
  await page.goto(`${base}/settings/tokens`);
  await page.getByTestId("language-switch").click();
  await page.getByRole("menuitem", { name: "English" }).click();
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const name = `CLI ${Date.now()}`;
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog.getByRole("checkbox", { name: "Engineer", exact: true }).check();
  await dialog
    .getByRole("button", { name: "Create token", exact: true })
    .click();
  const secretField = page.getByRole("textbox", { name: "Token secret" });
  await expect(secretField).toBeVisible();
  const secret = await secretField.inputValue();
  const authenticated = await page.request.get(`${base}/api/v1/me`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(authenticated.status()).toBe(200);
  await page.getByRole("button", { name: "I have saved the token" }).click();
  await page.reload();
  await expect(secretField).toHaveCount(0);
  const token = page.getByRole("article", { name, exact: true });
  await expect(token).toBeVisible();
  await expect(token).toContainText("Engineer");
  await token.getByRole("button", { name: "Revoke", exact: true }).click();
  await page.getByRole("button", { name: "Revoke token", exact: true }).click();
  await expect(token).toContainText("Revoked");
  expect(
    (
      await page.request.get(`${base}/api/v1/me`, {
        headers: { authorization: `Bearer ${secret}` },
      })
    ).status(),
  ).toBe(401);
  for (const theme of ["light", "dark"]) {
    await page.goto(`${base}/settings/appearance`);
    await page
      .getByText(theme === "light" ? "Light" : "Dark", { exact: true })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.goto(`${base}/settings/tokens`);
    await expect(token).toContainText("Revoked");
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`tokens-${theme}.png`),
      fullPage: true,
    });
  }
});
