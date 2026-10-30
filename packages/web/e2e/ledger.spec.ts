import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import {
  startTestService,
  type TestService,
} from "@realityjunky/badger-server/testing";

const port = process.env["BADGER_E2E_LEDGER_PORT"] ?? "4322";
const origin = `http://127.0.0.1:${port}`;
const base = `${origin}/team`;
const engineer = {
  subject: "engineer",
  email: "engineer@example.com",
  displayName: "Sam Engineer",
};
const expert = {
  subject: "expert",
  email: "expert@example.com",
  displayName: "Dr Lin",
};
const admin = { subject: "admin", email: "admin@example.com" };
let service: TestService;

test.beforeAll(async () => {
  service = await startTestService({
    environment: {
      BADGER_PORT: port,
      BADGER_BASE_PATH: "/team",
      BADGER_WEB_DIR: path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../dist",
      ),
      BADGER_BOOTSTRAP_ADMINISTRATORS: admin.email,
      BADGER_ALLOWED_ORIGINS: origin,
    },
  });
});
test.afterAll(async () => service?.close());

async function call<T>(
  method: string,
  route: string,
  body?: unknown,
  as = admin,
): Promise<T> {
  const response = await service.request(`/team/api/v1${route}`, {
    as,
    method,
    headers: { origin, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  expect(response.ok, JSON.stringify(value)).toBe(true);
  return value as T;
}
async function sign(
  route: string,
  previewAction: string,
  action: string,
  input: object,
  as: typeof engineer,
) {
  const { preview } = await call<{ preview: { confirmationHash: string } }>(
    "POST",
    `${route}/${previewAction}`,
    input,
    as,
  );
  await call(
    "POST",
    `${route}/${action}`,
    {
      ...input,
      confirmed: true,
      confirmationHash: preview.confirmationHash,
      requestId: crypto.randomUUID(),
    },
    as,
  );
}
async function english(page: Page) {
  await page.getByTestId("language-switch").click();
  await page.getByRole("menuitem", { name: "English", exact: true }).click();
}

for (const kind of ["inference", "assumption"] as const) {
  test(`retiring an ${kind} waits for confirmation and cancelling preserves the draft`, async ({
    browser,
  }) => {
    const { group } = await call<{ group: { id: string } }>("POST", "/groups", {
      name: `Retirement ${Date.now()}`,
    });
    const { workflow, version } = await call<{
      workflow: { id: string };
      version: { id: string };
    }>("POST", "/workflows", {
      groupId: group.id,
      name: `retirement-${Date.now()}`,
      goal: "Confirm the meaning before removing a readiness blocker.",
      intent: "new-skill",
      locale: "en",
    });
    const root = `/workflows/${workflow.id}/versions/${version.id}/questionnaire`;
    const statement = "The consumer requires sample_id.";
    const resource = kind === "inference" ? "inferences" : "assumptions";
    const { record } = await call<{ record: { id: string } }>(
      "POST",
      `${root}/${resource}`,
      { statement, topic: "interfaces", questionId: null },
    );
    const context = await browser.newContext({
      extraHTTPHeaders: { "x-badger-test-person": JSON.stringify(admin) },
    });
    try {
      const page = await context.newPage();
      const retirements: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "DELETE") retirements.push(request.url());
      });
      await page.goto(
        `${base}/questionnaire?workflow=${workflow.id}&version=${version.id}&panel=ledger`,
      );
      await english(page);
      const ledger = page.getByTestId("questionnaire-ledger");
      const draft = ledger
        .locator(".questionnaire-record")
        .filter({ hasText: statement });
      await expect(ledger.getByRole("status")).toHaveText("Blocked");
      await draft.getByRole("button", { name: "Record revision 1" }).click();
      const history = page.getByRole("dialog", {
        name: "Draft revision history",
      });
      await history.getByRole("button", { name: "Retire draft" }).click();
      const prompt = page.locator(".ant-popconfirm");
      await expect(
        prompt.getByText(`Retire this ${kind}?`, { exact: true }),
      ).toBeVisible();
      await expect(
        prompt.getByText(
          "A retired draft cannot be revised. It is removed from the ledger and readiness.",
        ),
      ).toBeVisible();
      expect(retirements).toEqual([]);
      await prompt.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(prompt).toBeHidden();
      expect(retirements).toEqual([]);
      await expect(history).toBeVisible();
      const unchanged = await call<{
        record: { status: string; revision: number };
      }>("GET", `${root}/${resource}/${record.id}`);
      expect(unchanged.record).toMatchObject({ status: "active", revision: 1 });

      await history.getByRole("button", { name: "Retire draft" }).click();
      await prompt
        .getByRole("button", { name: "Retire draft", exact: true })
        .click();
      await expect(history).toBeHidden();
      await expect(draft).toHaveCount(0);
      await expect(ledger.getByRole("status")).toHaveText("Ready");
      expect(retirements).toEqual([
        `${base}/api/v1${root}/${resource}/${record.id}`,
      ]);
      const retired = await call<{
        record: { status: string; revision: number };
      }>("GET", `${root}/${resource}/${record.id}`);
      expect(retired.record).toMatchObject({ status: "retired", revision: 2 });
    } finally {
      await context.close();
    }
  });
}

test("the ledger shows readiness blockers, confirms a linked inference, and lists changes since a round", async ({
  browser,
}) => {
  const { group } = await call<{ group: { id: string } }>("POST", "/groups", {
    name: `Ledger ${Date.now()}`,
  });
  const { workflow, version } = await call<{
    workflow: { id: string };
    version: { id: string };
  }>("POST", "/workflows", {
    groupId: group.id,
    name: `ledger-${Date.now()}`,
    goal: "Agree the sample sheet contract.",
    intent: "new-skill",
    locale: "en",
  });
  for (const [person, role] of [
    [engineer, "Engineer"],
    [expert, "Field expert"],
  ] as const)
    await call("POST", "/bindings", {
      scopeType: "workflow",
      scopeId: workflow.id,
      email: person.email,
      role,
    });
  const { person } = await call<{ person: { id: string } }>(
    "GET",
    "/me",
    undefined,
    expert,
  );
  const root = `/workflows/${workflow.id}/versions/${version.id}/questionnaire`;
  const { round } = await call<{ round: { id: string } }>(
    "POST",
    `${root}/rounds`,
    { title: "Contracts" },
    engineer,
  );
  const { question } = await call<{ question: { id: string } }>(
    "POST",
    `${root}/rounds/${round.id}/questions`,
    {
      text: "Which columns does the consumer require?",
      topic: "interfaces",
      targets: [{ kind: "workflow", id: workflow.id }],
      rationale: "Agree the interface.",
      evidence: [],
      assignees: [{ kind: "person", personId: person.id }],
      priority: 80,
    },
    engineer,
  );
  const { preview } = await call<{ preview: { confirmationHash: string } }>(
    "GET",
    `${root}/rounds/${round.id}/publish-preview`,
    undefined,
    engineer,
  );
  await call(
    "POST",
    `${root}/rounds/${round.id}/publish`,
    { confirmed: true, confirmationHash: preview.confirmationHash },
    engineer,
  );

  const authorContext = await browser.newContext({
    extraHTTPHeaders: { "x-badger-test-person": JSON.stringify(engineer) },
  });
  const expertContext = await browser.newContext({
    extraHTTPHeaders: { "x-badger-test-person": JSON.stringify(expert) },
  });
  try {
    const author = await authorContext.newPage();
    await author.goto(
      `${base}/questionnaire?workflow=${workflow.id}&version=${version.id}&panel=ledger`,
    );
    await english(author);
    const ledger = author.getByTestId("questionnaire-ledger");
    await expect(
      ledger.getByRole("heading", { name: "Ledger and readiness" }),
    ).toBeVisible();
    await expect(ledger.getByRole("status")).toHaveText("Blocked");
    await expect(
      ledger.getByText("Remaining questions (1)", { exact: true }),
    ).toBeVisible();

    // The Engineer drafts an inference that the published question confirms.
    await ledger
      .getByRole("button", { name: "Add inference draft", exact: true })
      .click();
    const editor = author.getByRole("dialog");
    await editor
      .getByLabel("Statement", { exact: true })
      .fill("The consumer requires sample_id.");
    await editor.getByLabel("Topic", { exact: true }).click();
    await author
      .locator(".ant-select-item-option")
      .filter({ hasText: /^Interfaces$/u })
      .click();
    await editor.getByLabel("Confirming question", { exact: true }).click();
    await author
      .locator(".ant-select-item-option")
      .filter({ hasText: "Which columns does the consumer require?" })
      .click();
    await editor.getByRole("button", { name: "Save draft" }).click();
    await expect(editor).toBeHidden();
    await expect(
      ledger.getByText("Agent inferences (1)", { exact: true }),
    ).toBeVisible();
    await ledger.getByRole("button", { name: /Interfaces/u }).click();
    await expect(
      ledger.getByText(/Unconfirmed inference · The consumer requires/u),
    ).toBeVisible();
    await expect(
      ledger.getByText(/Unresolved question · Which columns/u),
    ).toBeVisible();

    // The expert answers, the Engineer confirms a fact, and the expert
    // acknowledges it; only then is the inference confirmed.
    await call(
      "PUT",
      `${root}/questions/${question.id}/answer`,
      { revision: 0, questionRevision: 1, text: "sample_id and sequence." },
      expert,
    );
    await call(
      "POST",
      `${root}/questions/${question.id}/submit`,
      { revision: 1, questionRevision: 1 },
      expert,
    );
    await sign(
      `${root}/questions/${question.id}`,
      "resolution-preview",
      "resolve",
      {
        revision: 1,
        kind: "confirmed",
        facts: [
          {
            text: "The consumer requires sample_id and sequence.",
            answers: [{ personId: person.id, revision: 2 }],
          },
        ],
      },
      engineer,
    );
    await author.reload();
    await expect(ledger.getByRole("status")).toHaveText("Blocked");
    await ledger.getByRole("button", { name: /Interfaces/u }).click();
    await expect(
      ledger.getByText(/Pending acknowledgement · The consumer requires/u),
    ).toBeVisible();

    const { facts } = await call<{ facts: { id: string }[] }>(
      "GET",
      root,
      undefined,
      engineer,
    );
    await sign(
      `${root}/facts/${facts[0]!.id}`,
      "acknowledgement-preview",
      "acknowledge",
      { decision: "acknowledged" },
      expert,
    );
    await author.reload();
    await expect(ledger.getByRole("status")).toHaveText("Ready");
    await expect(
      ledger.getByText("Confirmed user facts (1)", { exact: true }),
    ).toBeVisible();
    await expect(
      ledger.getByText("Remaining questions (0)", { exact: true }),
    ).toBeVisible();
    const inference = ledger
      .locator(".questionnaire-record")
      .filter({ hasText: "The consumer requires sample_id." });
    await expect(
      inference.getByText("Confirmed", { exact: true }),
    ).toBeVisible();

    // Since the round's publication, the fact and the inference were added
    // and the question was resolved; the comparison has its own URL.
    await ledger.getByLabel("Published round", { exact: true }).click();
    await author
      .locator(".ant-select-item-option")
      .filter({ hasText: "1. Contracts" })
      .click();
    await expect(author).toHaveURL(
      new RegExp(`panel=ledger&sinceRound=${round.id}`, "u"),
    );
    await expect(
      ledger.getByRole("heading", { name: "Added (2)", exact: true }),
    ).toBeVisible();
    await expect(
      ledger.getByRole("heading", { name: "Resolved (1)", exact: true }),
    ).toBeVisible();
    await author.reload();
    await expect(
      ledger.getByRole("heading", { name: "Resolved (1)", exact: true }),
    ).toBeVisible();

    // A Field expert reads the same ledger but cannot draft inferences.
    const respondent = await expertContext.newPage();
    await respondent.goto(
      `${base}/questionnaire?workflow=${workflow.id}&version=${version.id}&panel=ledger`,
    );
    await english(respondent);
    const expertLedger = respondent.getByTestId("questionnaire-ledger");
    await expect(expertLedger.getByRole("status")).toHaveText("Ready");
    await expect(
      expertLedger.getByRole("button", { name: "Add inference draft" }),
    ).toHaveCount(0);
  } finally {
    await authorContext.close();
    await expertContext.close();
  }
});
