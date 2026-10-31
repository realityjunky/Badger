import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWorkflowRuntime } from "@realityjunky/badger/workflow-runtime";
import { startTestService } from "../../server/src/testing/index.js";
import { createBadgerMcp } from "../../mcp/src/index.js";
import { publishedFixture, operator } from "../../server/test/fixtures/runs.js";
import { admin } from "../../server/test/fixtures/planning.js";

for (const theme of ["light", "dark"] as const) {
  test(`an Auditor sees Run integrity and the Operator's local recovery outcome (${theme})`, async ({
    page,
    context,
  }, info) => {
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
        BADGER_BOOTSTRAP_ADMINISTRATORS: admin.email,
        BADGER_ALLOWED_ORIGINS: `http://localhost,http://127.0.0.1:${port}`,
      },
    });
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "badger-browser-recovery-"),
    );
    let client: Client | undefined;
    let mcp: ReturnType<typeof createBadgerMcp> | undefined;
    try {
      const f = await publishedFixture(service);
      const auditor = { subject: "run-auditor", email: "auditor@example.com" };
      await f.call(
        "/bindings",
        "POST",
        { scopeType: "organization", role: "Auditor", email: auditor.email },
        admin,
        201,
      );
      let holdEvents = true;
      mcp = createBadgerMcp({
        url: service.baseUrl,
        token: f.operatorToken,
        agentHost: "Planning Agent",
        profile: "operator",
        fetch: async (url, init) =>
          holdEvents && url.endsWith("/events")
            ? Response.json(
                { error: { message: "Mirror unavailable" } },
                { status: 503 },
              )
            : fetch(url, init),
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await mcp.connect(b);
      client = new Client({ name: "browser-recovery", version: "1" });
      await client.connect(a);
      const tool = async (name: string, args: Record<string, unknown>) => {
        const reply = await client!.callTool({ name, arguments: args });
        expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
        return JSON.parse((reply.content as { text: string }[])[0].text);
      };
      const args = { projectRoot: root, runId: "browser-recovery" };
      const started = await tool("start", {
        ...args,
        workflowId: f.workflow.id,
        publicationId: f.publication.id,
        packageHash: f.publication.packageHash,
        hostLabel: "Lab workstation",
        confirmed: true,
      });
      const route = `/runs/${started.runUrl.split("/").at(-1)}`;
      await expect
        .poll(
          async () =>
            (await f.call("/me/runs", "GET", undefined, operator)).runs.length,
        )
        .toBe(1);
      const report = (await createWorkflowRuntime().readReport({
        kind: "standalone",
        ...args,
      }))!;
      await f.call(
        `${route}/events`,
        "POST",
        { events: [report.events.at(-1)] },
        operator,
        409,
        f.operatorToken,
      );
      await context.setExtraHTTPHeaders({
        "x-badger-test-person": JSON.stringify(auditor),
      });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(`${service.baseUrl}/runs?workflow=${f.workflow.id}`);
      await page.getByTestId("language-switch").click();
      await page
        .getByRole("menuitem", { name: "English", exact: true })
        .click();
      await expect(
        page.getByText("Recovery required", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("link", { name: "browser-recovery", exact: true })
        .click();
      await expect(
        page.getByText("The reported events have a sequence gap.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByText("Recovery required", { exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: info.outputPath(`run-integrity-${theme}.png`),
        fullPage: true,
      });
      holdEvents = false;
      await tool("recover", args);
      await expect
        .poll(
          async () =>
            (await f.call(route, "GET", undefined, operator)).run.recovery
              ?.outcome,
        )
        .toBe("settled");
      await page
        .getByRole("button", { name: "Reload records", exact: true })
        .click();
      await expect(
        page.getByText("Recovery settled", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Recovery required", { exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByText("The reported events have a sequence gap.", {
          exact: true,
        }),
      ).toHaveCount(0);
      await page.screenshot({
        path: info.outputPath(`run-recovered-${theme}.png`),
        fullPage: true,
      });
    } finally {
      await client?.close();
      await mcp?.close();
      await service.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
