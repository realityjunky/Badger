import { expect, test } from "@playwright/test";

test("copies expert MCP configuration for each host under the deployment base path", async ({
  page,
  context,
}, testInfo) => {
  const base = "http://127.0.0.1:4320/badger";
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`${base}/settings/tokens`);
  await page.getByTestId("language-switch").click();
  await page.getByRole("menuitem", { name: "English" }).click();
  await page.getByRole("button", { name: "Connect your Agent" }).click();
  const field = page.getByRole("textbox", {
    name: "MCP configuration",
    exact: true,
  });
  for (const host of ["Claude Code", "Codex", "WorkBuddy"]) {
    await page.getByRole("radio", { name: host, exact: true }).check();
    const config = await field.inputValue();
    expect(config).toContain(base);
    expect(config).toContain("<YOUR_PERSONAL_ACCESS_TOKEN>");
    if (host === "Codex") expect(config).toContain("[mcp_servers.badger.env]");
    else
      expect(JSON.parse(config)).toMatchObject({
        mcpServers: {
          badger: {
            type: "stdio",
            command: "badger-mcp",
            args: [],
            env: { BADGER_URL: base },
          },
        },
      });
    await page
      .getByRole("button", { name: "Copy configuration", exact: true })
      .click();
    await expect(
      page.getByText("Configuration copied.", { exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      config,
    );
  }
  for (const theme of ["Light", "Dark"]) {
    await page.goto(`${base}/settings/appearance`);
    await page.getByText(theme, { exact: true }).click();
    await page.goto(`${base}/settings/tokens`);
    await page.getByRole("button", { name: "Connect your Agent" }).click();
    await expect(field).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`mcp-${theme.toLowerCase()}.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
});
