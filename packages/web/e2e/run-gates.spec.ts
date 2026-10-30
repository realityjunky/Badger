import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startTestService } from "../../server/src/testing/index.js";
import { createBadgerMcp } from "../../mcp/src/index.js";
import {
  publishedFixture,
  operator,
  decisionPlan,
} from "../../server/test/fixtures/runs.js";

test("an Operator reviews and answers a Run gate in the dashboard, then the Agent continues", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(120_000);
  const port = await new Promise<number>((resolve, reject) => {
    const reservation = createServer();
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", () => {
      const port = (reservation.address() as AddressInfo).port;
      reservation.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
  const service = await startTestService({
    environment: {
      BADGER_PORT: String(port),
      BADGER_WEB_DIR: path.resolve("dist"),
      BADGER_BOOTSTRAP_ADMINISTRATORS: "admin@example.com",
      BADGER_ALLOWED_ORIGINS: `http://localhost,http://127.0.0.1:${port}`,
    },
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-browser-gate-"));
  let mcp: ReturnType<typeof createBadgerMcp> | undefined;
  let client: Client | undefined;
  try {
    const f = await publishedFixture(service, decisionPlan);
    mcp = createBadgerMcp({
      url: service.baseUrl,
      token: f.operatorToken,
      agentHost: "Planning Agent",
      profile: "operator",
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await mcp.connect(b);
    client = new Client({ name: "browser-operator", version: "1" });
    await client.connect(a);
    const tool = async (name: string, args: Record<string, unknown>) => {
      const result = await client!.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      return JSON.parse((result.content as { text: string }[])[0].text);
    };
    const args = { projectRoot: root, runId: "browser-gate" };
    const started = await tool("start", {
      ...args,
      workflowId: f.workflow.id,
      publicationId: f.publication.id,
      packageHash: f.publication.packageHash,
      hostLabel: "Lab workstation",
      confirmed: true,
    });
    expect(started.requiresPerson).toBe(true);
    await expect
      .poll(
        async () =>
          (await f.call("/me/inbox", "GET", undefined, operator)).items.filter(
            (item: any) => item.href.startsWith("/runs/"),
          ).length,
      )
      .toBe(1);
    const inbox = await f.call("/me/inbox", "GET", undefined, operator);
    const item = inbox.items.find((item: any) =>
      item.href.startsWith("/runs/"),
    );
    await context.setExtraHTTPHeaders({
      "x-badger-test-person": JSON.stringify(operator),
    });
    await page.goto(`${service.baseUrl}${item.href}`);
    await page.getByTestId("language-switch").click();
    await page.getByRole("menuitem", { name: "English", exact: true }).click();
    await expect(
      page.getByText("May this report be released?", { exact: true }),
    ).toBeVisible();
    await page.getByLabel("Decision", { exact: true }).click();
    await page.getByLabel("Decision", { exact: true }).press("ArrowDown");
    await page.getByLabel("Decision", { exact: true }).press("Enter");
    await page.getByLabel("ticket", { exact: true }).fill("REL-66");
    await page
      .getByLabel("Rationale", { exact: true })
      .fill("Reviewed the report and its release scope.");
    await page
      .getByRole("button", { name: "Review answer", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("REL-66");
    await dialog
      .getByRole("button", { name: "Confirm answer", exact: true })
      .click();
    await expect(
      page.getByText(
        "Answer recorded. Your Agent will receive it on its next next or status call.",
        { exact: true },
      ),
    ).toBeVisible();
    const continued = await tool("next", args);
    expect(continued.continuation.disposition).toBe("done");
    await page
      .getByRole("button", { name: "Reload records", exact: true })
      .click();
    await expect(page.getByLabel("Run overview")).toContainText("Completed", {
      timeout: 15_000,
    });
    await page.screenshot({
      path: testInfo.outputPath("run-gate-completed.png"),
      fullPage: true,
    });
  } finally {
    await client?.close();
    await mcp?.close();
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
