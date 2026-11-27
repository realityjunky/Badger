import { expect, test } from "@playwright/test";
import path from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { startTestService } from "../../server/src/testing/index.js";
import { initializedFixture } from "../../server/test/fixtures/packages.js";
import { admin, engineer } from "../../server/test/fixtures/planning.js";

test("the Engineer dispatches and adopts a package patch from Findings", async ({
  page,
}) => {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string")
    throw new Error("Missing loopback port");
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  const service = await startTestService({
    environment: {
      BADGER_PORT: String(address.port),
      BADGER_WEB_DIR: path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../dist",
      ),
      BADGER_BOOTSTRAP_ADMINISTRATORS: admin.email,
      BADGER_ALLOWED_ORIGINS:
        "http://localhost,http://127.0.0.1:" + address.port,
    },
  });
  try {
    const { call, base, approve } = await initializedFixture(service);
    const before = await call(base + "/package");
    const { confirmation } = await approve("generation");
    await call(
      base + "/package/generate",
      "POST",
      {
        confirmed: true,
        confirmationHash: confirmation.confirmationHash,
        stateHash: before.currentStateHash,
        requestId: "generate-finding-browser",
      },
      engineer,
      202,
    );
    expect((await service.worker().runOnce())?.status).toBe("succeeded");
    const { jobs } = await call(
      base + "/package/authoring-jobs",
      "POST",
      { confirmed: true },
      engineer,
      201,
    );
    const lane = jobs.find(
      (job: { laneId: string }) => job.laneId === "script",
    );
    const { secret } = await call(
      "/me/tokens",
      "POST",
      { name: "Package fixture", scopes: ["engineer"] },
      engineer,
      201,
    );
    const jobPath = base + "/drafting-jobs/";
    const claimed = await call(
      jobPath + lane.id + "/claim",
      "POST",
      { revision: lane.revision },
      engineer,
      200,
      secret,
    );
    const disposition = {
      subject: "Workbook checker",
      route: "implementation",
      target: "implementation/workbook.mjs",
      authority: "Approved workbook requirement",
      acceptance: "Accept the reviewed workbook",
    };
    await call(
      jobPath + lane.id + "/submit",
      "POST",
      {
        leaseId: claimed.job.lease.id,
        contextHash: claimed.job.contextHash,
        result: {
          laneOutput: {
            schemaVersion: 2,
            lane: "script",
            status: "BLOCKED",
            summary: "The workbook checker is missing",
            semanticDossierHash:
              claimed.contextBundle.authoring.plan.semanticDossierHash,
            findings: [
              {
                severity: "important",
                problem: "Missing workbook checker",
                fix: "Add the checker",
                disposition,
              },
            ],
          },
        },
      },
      engineer,
      200,
      secret,
    );
    await page.setExtraHTTPHeaders({
      "x-badger-test-person": JSON.stringify(engineer),
    });
    await page.goto(service.baseUrl + base + "#package");
    await page.getByTestId("language-switch").click();
    await page.getByRole("menuitem", { name: "English", exact: true }).click();
    await page.getByRole("tab", { name: "Findings", exact: true }).click();
    const panel = page.getByRole("region", { name: "Findings" });
    await panel.getByRole("checkbox", { name: /script #1/ }).check();
    await panel.getByRole("button", { name: "Review grouping" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Save finding" })
      .click();
    await panel
      .getByRole("checkbox", { name: "Workbook checker", exact: true })
      .check();
    await panel.getByRole("button", { name: "Dispatch ready work" }).click();
    await expect(
      panel.getByText("implement-finding", { exact: true }),
    ).toBeVisible();
    const assignment = (await call(base + "/package/findings")).work[0];
    expect((await call(jobPath + assignment.id + "/prompt")).prompt).toContain(
      "claim_job",
    );
    const implementation = await call(
      jobPath + assignment.id + "/claim",
      "POST",
      { revision: assignment.revision },
      engineer,
      200,
      secret,
    );
    await call(
      jobPath + assignment.id + "/submit",
      "POST",
      {
        leaseId: implementation.job.lease.id,
        contextHash: implementation.job.contextHash,
        result: {
          implementation: {
            summary: "Added the package checker",
            tests: "A checked workbook passed",
            changes: [
              {
                path: disposition.target,
                previousHash: null,
                content: "export const check = () => true;\n",
              },
            ],
          },
        },
      },
      engineer,
      200,
      secret,
    );
    await panel.getByRole("button", { name: "Refresh", exact: true }).click();
    await panel
      .getByRole("button", { name: "Review result", exact: true })
      .click();
    const review = page.getByRole("dialog", { name: "Review result" });
    await expect(review.getByText(/Added the package checker/)).toBeVisible();
    await review
      .getByRole("button", { name: "Accept result", exact: true })
      .click();
    await review.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(review).toBeHidden();
    expect(
      (await call(base + "/package/findings")).findings.some(
        (finding: { status: string }) => finding.status === "awaiting-evidence",
      ),
    ).toBe(true);
  } finally {
    await page.close();
    await service.close();
  }
});
