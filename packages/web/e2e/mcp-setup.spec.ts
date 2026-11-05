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
    // Claude Code's .mcp.json is often committed, so it names the variable.
    if (host !== "Codex") {
      expect(JSON.parse(config).mcpServers.badger.env.BADGER_TOKEN).toBe(
        "${BADGER_TOKEN}",
      );
      expect(config).not.toContain("<YOUR_PERSONAL_ACCESS_TOKEN>");
    }
    if (host === "Codex") {
      expect(config).toContain("[mcp_servers.badger.env]");
      expect(config).toContain('env_vars = ["BADGER_TOKEN"]');
      expect(config).not.toContain("BADGER_TOKEN =");
    } else
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
  const generatedConfiguration = await field.inputValue();
  await page
    .getByRole("link", { name: "Badger MCP setup", exact: true })
    .click();
  const guide = page.getByRole("dialog", {
    name: "Documentation",
    exact: true,
  });
  await expect(page).toHaveURL(/\/badger\/settings\/tokens\?help=mcp$/u);
  await expect(
    guide.getByRole("heading", { name: "Badger MCP setup", exact: true }),
  ).toBeFocused();
  await expect(guide).toContainText("Fully quit WorkBuddy");
  await expect(guide.locator("ol.documentation-actions > li")).toHaveCount(9);
  await expect(
    guide.getByRole("link", { name: "Connect your Agent", exact: true }),
  ).toHaveAttribute("href", "/badger/settings/tokens");
  await guide.screenshot({
    path: testInfo.outputPath("badger-mcp-setup-guide.png"),
    animations: "disabled",
  });
  await guide
    .getByRole("navigation", { name: "Guide sections" })
    .getByRole("link", { name: "WeCom CLI installation", exact: true })
    .click();
  await expect(
    guide.getByRole("heading", { name: "WeCom CLI installation", exact: true }),
  ).toBeFocused();
  await expect(guide.locator("ol.documentation-actions > li")).toHaveCount(7);
  await expect(guide.locator("pre")).toContainText([
    "node --version",
    "npm install -g @wecom/cli",
    "npx skills add WeComTeam/wecom-cli -y -g",
    "wecom-cli auth init",
    "wecom-cli auth show --status",
    "npx skills add WecomTeam/wecom-unified -y -g",
  ]);
  await expect(
    guide.getByRole("link", {
      name: "Official WeCom CLI installation guide",
      exact: true,
    }),
  ).toHaveAttribute("href", "https://open.work.weixin.qq.com/help2/pc/21676");
  await page.reload();
  await expect(
    guide.getByRole("heading", { name: "WeCom CLI installation", exact: true }),
  ).toBeFocused();
  await guide.screenshot({
    path: testInfo.outputPath("wecom-cli-installation-guide.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Connect your Agent" }).click();
  await page.getByRole("radio", { name: "WorkBuddy", exact: true }).check();
  expect(await field.inputValue()).toBe(generatedConfiguration);
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
  await page.getByRole("radio", { name: "Windows", exact: true }).check();
  const cli = "C:\\Agent's tools\\badger-mcp\\cli.js";
  await page
    .getByRole("textbox", {
      name: "Installed Badger MCP cli.js path",
      exact: true,
    })
    .fill(cli);
  await page.getByRole("radio", { name: "Claude Code", exact: true }).check();
  expect(JSON.parse(await field.inputValue()).mcpServers.badger).toMatchObject({
    command: "node",
    args: [cli],
  });
  await page.getByRole("radio", { name: "Codex", exact: true }).check();
  expect(await field.inputValue()).toContain('command = "node"');
  expect(await field.inputValue()).toContain(`args = ${JSON.stringify([cli])}`);
});
