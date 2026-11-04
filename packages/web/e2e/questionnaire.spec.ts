import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import {
  startTestService,
  type TestService,
} from "@realityjunky/badger-server/testing";

const origin = "http://127.0.0.1:4321";
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
      BADGER_PORT: "4321",
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
async function english(page: Page) {
  await page.getByTestId("language-switch").click();
  await page.getByRole("menuitem", { name: "English", exact: true }).click();
}

test("Questionnaire tabs preserve the selected question, drafts, filters, and scroll", async ({
  browser,
}, testInfo) => {
  const engineer = {
    subject: "navigation-engineer",
    email: "navigation-engineer@example.com",
    displayName: "Sam Engineer",
  };
  const expert = {
    subject: "navigation-expert",
    email: "navigation-expert@example.com",
    displayName: "Dr Lin",
  };
  const { group } = await call<{ group: { id: string } }>("POST", "/groups", {
    name: `Navigation ${Date.now()}`,
  });
  const { workflow, version } = await call<{
    workflow: { id: string };
    version: { id: string };
  }>("POST", "/workflows", {
    groupId: group.id,
    name: `navigation-${Date.now()}`,
    goal: "Preserve questionnaire context while reviewing jobs and readiness.",
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
  const root = `/workflows/${workflow.id}/versions/${version.id}/questionnaire`;
  const { round } = await call<{ round: { id: string } }>(
    "POST",
    `${root}/rounds`,
    { title: "Sample handling" },
    engineer,
  );
  const { question } = await call<{ question: { id: string } }>(
    "POST",
    `${root}/rounds/${round.id}/questions`,
    {
      text: "Which sample is accepted?",
      topic: "scope",
      targets: [{ kind: "workflow", id: workflow.id }],
      rationale: Array.from(
        { length: 50 },
        (_, index) => `Sample requirement ${index + 1} needs expert review.`,
      ).join("\n\n"),
      evidence: [],
      assignees: [{ kind: "role", role: "Field expert" }],
      priority: 10,
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
  await call(
    "POST",
    `${root}/questions/${question.id}/comments`,
    {
      text: Array.from(
        { length: 80 },
        (_, index) => `Sample review note ${index + 1}.`,
      ).join("\n"),
    },
    engineer,
  );
  const { round: draftRound } = await call<{ round: { id: string } }>(
    "POST",
    `${root}/rounds`,
    { title: "Follow-up" },
    engineer,
  );
  const authorContext = await browser.newContext({
    extraHTTPHeaders: { "x-badger-test-person": JSON.stringify(engineer) },
  });
  const expertContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    extraHTTPHeaders: { "x-badger-test-person": JSON.stringify(expert) },
  });
  try {
    const author = await authorContext.newPage();
    const questionUrl = `${base}/questionnaire/questions/${question.id}`;
    await author.goto(questionUrl);
    await english(author);
    const tabs = author.locator(".questionnaire-tabs > .ant-tabs-nav");
    const questionsTab = tabs.getByRole("tab", {
      name: "Rounds and questions",
      exact: true,
    });
    const draftingTab = tabs.getByRole("tab", {
      name: "Drafting jobs and suggestions",
      exact: true,
    });
    const ledgerTab = tabs.getByRole("tab", {
      name: "Ledger and readiness",
      exact: true,
    });
    await author.getByTestId("question-search").fill("sample");
    const comment = author.getByLabel("Comment text", { exact: true });
    await comment.fill("Keep this comment until I finish checking readiness.");
    await author.evaluate(() => window.scrollTo(0, 400));
    await expect.poll(() => author.evaluate(() => window.scrollY)).toBe(400);
    await draftingTab.click();
    await expect(draftingTab).toHaveAttribute("aria-selected", "true");
    await expect(author).toHaveURL(
      new RegExp(`/questions/${question.id}\\?.*panel=suggestions`, "u"),
    );
    const contentWidth = (await author
      .locator(".questionnaire-tabs")
      .boundingBox())!.width;
    expect(
      (await author.getByRole("tabpanel").boundingBox())!.width,
    ).toBeCloseTo(contentWidth, 0);
    await ledgerTab.click();
    await expect(ledgerTab).toHaveAttribute("aria-selected", "true");
    const ledger = author.getByTestId("questionnaire-ledger");
    await expect(ledger.getByRole("status")).toHaveText("Blocked");
    expect(
      (await author.getByRole("tabpanel").boundingBox())!.width,
    ).toBeCloseTo(contentWidth, 0);
    const baseline = ledger.getByRole("combobox", {
      name: "Published round",
      exact: true,
    });
    await baseline.click();
    await author
      .locator(".ant-select-dropdown")
      .getByText("1. Sample handling", { exact: true })
      .click();
    await expect(author).toHaveURL(new RegExp(`sinceRound=${round.id}`, "u"));
    await questionsTab.click();
    await expect(questionsTab).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => author.evaluate(() => window.scrollY)).toBe(400);
    await expect(comment).toHaveValue(
      "Keep this comment until I finish checking readiness.",
    );
    await expect(author.getByTestId("question-search")).toHaveValue("sample");
    await author.goBack();
    await expect(ledgerTab).toHaveAttribute("aria-selected", "true");
    await expect(baseline.locator("xpath=..")).toContainText(
      "1. Sample handling",
    );
    await questionsTab.click();
    await author
      .getByRole("button", { name: "Hide rounds", exact: true })
      .click();
    await expect(author.getByTestId("explorer-pane")).toBeHidden();
    await author
      .getByRole("button", { name: "Show rounds", exact: true })
      .click();
    await expect(author.getByTestId("question-search")).toHaveValue("sample");
    const inspectorButton = author.getByRole("button", {
      name: "Evidence and history",
      exact: true,
    });
    await inspectorButton.click();
    const inspector = author.getByRole("dialog", {
      name: "Evidence and history",
      exact: true,
    });
    await expect(
      inspector.getByRole("heading", {
        name: "Which sample is accepted?",
        exact: true,
      }),
    ).toBeVisible();
    await inspector.getByRole("tab", { name: "History", exact: true }).click();
    await expect(
      inspector.locator("summary").filter({ hasText: "Question revision 1" }),
    ).toBeVisible();
    await inspector
      .getByRole("button", { name: "Expand view", exact: true })
      .click();
    await expect
      .poll(async () => (await inspector.boundingBox())!.width)
      .toBeCloseTo(author.viewportSize()!.width, 0);
    await author.screenshot({
      path: testInfo.outputPath("expanded-question-history.png"),
      animations: "disabled",
    });
    await author.keyboard.press("Escape");
    await expect(inspector).toBeHidden();
    await expect(inspectorButton).toBeFocused();
    await author.goto(
      `${base}/questionnaire?workflow=${workflow.id}&version=${version.id}&round=${draftRound.id}`,
    );
    await author
      .getByRole("button", { name: "New question", exact: true })
      .click();
    await author
      .getByLabel("Question text", { exact: true })
      .fill("An unfinished follow-up question");
    await author
      .getByLabel("Rationale", { exact: true })
      .fill("Preserve the draft while looking at jobs.");
    await draftingTab.click();
    await ledgerTab.click();
    await questionsTab.click();
    await expect(
      author.getByLabel("Question text", { exact: true }),
    ).toHaveValue("An unfinished follow-up question");
    await expect(author.getByLabel("Rationale", { exact: true })).toHaveValue(
      "Preserve the draft while looking at jobs.",
    );
    await expect(author).toHaveURL(new RegExp(`round=${draftRound.id}`, "u"));
    await author.evaluate(() => window.scrollTo(0, 0));
    await author.screenshot({
      path: testInfo.outputPath("questionnaire-tabs.png"),
      fullPage: true,
      animations: "disabled",
    });

    const respondent = await expertContext.newPage();
    await respondent.goto(questionUrl);
    await english(respondent);
    await expect(
      respondent.getByRole("tab", {
        name: "Drafting jobs and suggestions",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(respondent.getByTestId("explorer-pane")).toBeHidden();
    await respondent
      .getByRole("button", { name: "Show rounds", exact: true })
      .click();
    await expect(respondent.getByTestId("explorer-pane")).toBeVisible();
    expect(
      await respondent.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await respondent
      .getByRole("button", { name: "Evidence and history", exact: true })
      .click();
    expect(
      (await respondent.getByRole("dialog").boundingBox())!.width,
    ).toBeCloseTo(390, 0);
    await respondent.screenshot({
      path: testInfo.outputPath("question-evidence-mobile.png"),
      animations: "disabled",
    });
  } finally {
    await authorContext.close();
    await expertContext.close();
  }
});

test("question threads retain edits and expert concerns reach the Engineer for all three outcomes", async ({
  browser,
}, testInfo) => {
  const engineer = {
    subject: "discussion-engineer",
    email: "discussion-engineer@example.com",
    displayName: "Sam Engineer",
  };
  const expert = {
    subject: "discussion-expert",
    email: "discussion-expert@example.com",
    displayName: "Dr Lin",
  };
  const { group } = await call<{ group: { id: string } }>("POST", "/groups", {
    name: `Discussion ${Date.now()}`,
  });
  const { workflow, version } = await call<{
    workflow: { id: string };
    version: { id: string };
  }>("POST", "/workflows", {
    groupId: group.id,
    name: `discussion-${Date.now()}`,
    goal: "Handle unprompted expert knowledge.",
    intent: "new-skill",
    locale: "en",
  });
  const observer = {
    subject: "discussion-observer",
    email: "discussion-observer@example.com",
  };
  for (const [person, role] of [
    [engineer, "Engineer"],
    [expert, "Field expert"],
    [observer, "Observer"],
  ] as const)
    await call("POST", "/bindings", {
      scopeType: "workflow",
      scopeId: workflow.id,
      email: person.email,
      role,
    });
  const root = `/workflows/${workflow.id}/versions/${version.id}/questionnaire`;
  const { round } = await call<{ round: { id: string } }>(
    "POST",
    `${root}/rounds`,
    { title: "Storage" },
    engineer,
  );
  const { question } = await call<{ question: { id: string } }>(
    "POST",
    `${root}/rounds/${round.id}/questions`,
    {
      text: "How is the sample stored?",
      topic: "scope",
      targets: [{ kind: "workflow", id: workflow.id }],
      rationale: "Agree storage.",
      evidence: [],
      assignees: [{ kind: "role", role: "Field expert" }],
      priority: 10,
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
  const observerContext = await browser.newContext({
    extraHTTPHeaders: { "x-badger-test-person": JSON.stringify(observer) },
  });
  try {
    const author = await authorContext.newPage();
    const respondent = await expertContext.newPage();
    const reader = await observerContext.newPage();
    for (const page of [author, respondent, reader]) {
      await page.goto(`${base}/questionnaire/questions/${question.id}`);
      await english(page);
    }
    await expect(
      reader.getByLabel("Comment text", { exact: true }),
    ).toHaveCount(0);
    await respondent
      .getByLabel("Comment text", { exact: true })
      .fill("Use a cold chain.");
    await respondent
      .getByRole("button", { name: "Post comment", exact: true })
      .click();
    await expect(
      author
        .getByTestId("question-thread")
        .getByText("Use a cold chain.", { exact: true }),
    ).toBeVisible();
    const ownComment = respondent.getByTestId("question-comment").filter({
      has: respondent.getByRole("heading", { name: "Dr Lin", exact: true }),
    });
    await ownComment
      .getByRole("button", { name: "Edit comment", exact: true })
      .click();
    await ownComment
      .getByLabel("Edit comment text", { exact: true })
      .fill("Use a cold chain at 4°C.");
    await ownComment
      .getByRole("button", { name: "Save comment", exact: true })
      .click();
    const received = author
      .getByTestId("question-comment")
      .filter({ hasText: "Use a cold chain at 4°C." });
    await expect(received).toBeVisible();
    await received.getByText("Edit history", { exact: true }).click();
    await expect(
      received.getByText("Use a cold chain.", { exact: true }),
    ).toBeVisible();
    await expect(
      reader.getByRole("button", { name: "Edit comment", exact: true }),
    ).toHaveCount(0);
    await expect(
      reader.getByRole("button", { name: "Raise concern", exact: true }),
    ).toHaveCount(0);

    const raise = async (text: string) => {
      await respondent
        .getByRole("button", { name: "Raise concern", exact: true })
        .click();
      const dialog = respondent.getByRole("dialog");
      await dialog.getByLabel("Concern text", { exact: true }).fill(text);
      await dialog
        .getByRole("button", { name: "Raise concern", exact: true })
        .click();
      await expect(
        respondent.getByRole("heading", { name: "Concern", exact: true }),
      ).toBeVisible();
      await expect(
        respondent
          .getByTestId("concern-record")
          .getByText(text, { exact: true }),
      ).toBeVisible();
      await author.goto(`${base}/my-work`);
      await author
        .getByRole("link", {
          name: new RegExp(text.replace(/[.?]/gu, "\\$&"), "u"),
        })
        .click();
      await expect(
        author.getByTestId("concern-record").getByText(text, { exact: true }),
      ).toBeVisible();
    };
    const choose = async (outcome: string) => {
      await author.getByLabel("Resolution", { exact: true }).click();
      await author.getByText(outcome, { exact: true }).click();
    };
    const confirm = async () => {
      await author
        .getByRole("button", { name: "Review resolution", exact: true })
        .click();
      await author
        .getByRole("dialog")
        .getByRole("button", { name: "Confirm resolution", exact: true })
        .click();
      await expect(author.getByRole("dialog")).toHaveCount(0);
    };
    await raise("A backup freezer is available.");
    await choose("Accept as fact source");
    await confirm();
    await expect(
      respondent
        .getByTestId("concern-record")
        .getByText("Accepted as fact source", { exact: true }),
    ).toBeVisible();
    await author.goto(`${base}/my-work`);
    await expect(
      author
        .locator(".inbox-item-done")
        .filter({ hasText: "A backup freezer is available." }),
    ).toBeVisible();
    await raise("Could we automate the microscope?");
    await choose("Decline with a reason");
    await expect(
      author.getByRole("button", { name: "Review resolution", exact: true }),
    ).toBeDisabled();
    await author
      .getByLabel("Reason for declining", { exact: true })
      .fill("Outside this workflow's scope.");
    await confirm();
    await expect(
      respondent
        .getByTestId("concern-record")
        .getByText("Outside this workflow's scope.", { exact: true }),
    ).toBeVisible();

    for (const theme of ["light", "dark"] as const) {
      await respondent.emulateMedia({ colorScheme: theme });
      await expect(respondent.locator("html")).toHaveAttribute(
        "data-theme",
        theme,
      );
      await respondent.screenshot({
        path: testInfo.outputPath(`concern-${theme}.png`),
        fullPage: true,
        animations: "disabled",
      });
      expect(
        await respondent.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    }

    await call(
      "POST",
      `${root}/rounds`,
      { title: "Expert follow-up" },
      engineer,
    );
    await raise("What happens if the cold chain fails?");
    await author
      .getByRole("button", { name: "Draft question", exact: true })
      .click();
    await author
      .getByLabel("Question text", { exact: true })
      .fill("Which samples remain usable after a cold chain failure?");
    await author
      .getByLabel("Rationale", { exact: true })
      .fill("Resolve the expert's concern.");
    await confirm();
    await expect(
      author.getByRole("heading", {
        name: "Which samples remain usable after a cold chain failure?",
        exact: true,
      }),
    ).toBeVisible();
    await author
      .getByRole("button", { name: "Review round", exact: true })
      .click();
    await author
      .getByRole("dialog")
      .getByRole("button", { name: "Publish round", exact: true })
      .click();
    await respondent
      .getByRole("link", { name: "Open question", exact: true })
      .click();
    await expect(respondent.getByTestId("answer-box")).toBeVisible();
    await respondent
      .getByRole("button", { name: "Evidence and history", exact: true })
      .click();
    await expect(
      respondent
        .getByTestId("inspector-pane")
        .getByRole("link", { name: "Source concern", exact: true }),
    ).toBeVisible();
  } finally {
    await authorContext.close();
    await expertContext.close();
    await observerContext.close();
  }
});

test("an expert answers a round and the Engineer sees the submitted revisions arrive live", async ({
  browser,
}, testInfo) => {
  const { group } = await call<{ group: { id: string } }>("POST", "/groups", {
    name: `Questionnaire ${Date.now()}`,
  });
  const { workflow, version } = await call<{
    workflow: { id: string };
    version: { id: string };
  }>("POST", "/workflows", {
    groupId: group.id,
    name: `rounds-${Date.now()}`,
    goal: "Agree sample handling.",
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
  await call("GET", "/me", undefined, expert);
  const engineerContext = await browser.newContext({
    extraHTTPHeaders: { "x-badger-test-person": JSON.stringify(engineer) },
  });
  const expertContext = await browser.newContext({
    extraHTTPHeaders: { "x-badger-test-person": JSON.stringify(expert) },
  });
  let releaseRead = () => {};
  try {
    const author = await engineerContext.newPage();
    const respondent = await expertContext.newPage();
    await author.goto(
      `${base}/questionnaire?workflow=${workflow.id}&version=${version.id}`,
    );
    await english(author);
    await expect(author.getByText("Composer", { exact: true })).toBeVisible();
    await author
      .getByRole("button", { name: "New round", exact: true })
      .click();
    await author
      .getByLabel("Round title", { exact: true })
      .fill("Sample handling");
    await author
      .getByRole("button", { name: "Create round", exact: true })
      .click();
    for (const [text, priority] of [
      ["Which sample is accepted?", "90"],
      ["How cold is storage?", "10"],
    ]) {
      await author
        .getByRole("button", { name: "New question", exact: true })
        .click();
      await author.getByLabel("Question text", { exact: true }).fill(text!);
      await author
        .getByLabel("Rationale", { exact: true })
        .fill("Agree the input requirements.");
      await author.getByLabel("Priority", { exact: true }).fill(priority!);
      await author
        .getByRole("button", { name: "Save question", exact: true })
        .click();
    }
    await author
      .getByRole("button", { name: "Review round", exact: true })
      .click();
    await author
      .getByRole("dialog")
      .getByRole("button", { name: "Publish round", exact: true })
      .click();
    await expect(
      author.getByText("Live updates connected", { exact: true }),
    ).toBeVisible();
    await respondent.goto(`${base}/my-work`);
    await english(respondent);
    await expect(
      respondent.getByTestId("metric-questions").locator(".summary-value"),
    ).toHaveText("2");
    await respondent
      .getByRole("link", { name: /Which sample is accepted\?/u })
      .click();
    await expect(
      respondent.getByText("Answer mode", { exact: true }),
    ).toBeVisible();
    let failSave = true;
    const failOnce = async (route: import("@playwright/test").Route) => {
      if (failSave) {
        failSave = false;
        await route.abort();
      } else await route.continue();
    };
    await respondent.route("**/questions/*/answer", failOnce);
    await respondent.getByTestId("answer-box").fill("血浆");
    await expect(respondent.getByTestId("answer-save-state")).toHaveText(
      "Draft not saved",
    );
    await expect(respondent.getByTestId("answer-box")).toHaveValue("血浆");
    await respondent
      .getByRole("button", { name: "Retry save", exact: true })
      .click();
    await expect(respondent.getByTestId("answer-save-state")).toHaveText(
      "Draft saved",
    );
    await respondent.unroute("**/questions/*/answer", failOnce);
    await respondent.reload();
    await expect(respondent.getByTestId("answer-box")).toHaveValue("血浆");
    await respondent
      .getByRole("link", { name: /How cold is storage\?/u })
      .click();
    await expect(
      respondent.getByRole("heading", {
        name: "How cold is storage?",
        exact: true,
      }),
    ).toBeVisible();
    let delayed = false;
    await expect(respondent.getByTestId("answer-box")).toHaveCount(1);
    await respondent.route("**/questions/*/answer", async (route) => {
      if (!delayed) {
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      await route.continue();
    });
    const saving = respondent.waitForRequest(
      (request) =>
        request.method() === "PUT" && request.url().endsWith("/answer"),
      { timeout: 10000 },
    );
    await respondent.getByTestId("answer-box").fill("4");
    await saving;
    await respondent.getByTestId("answer-box").fill("4°C");
    await expect(respondent.getByTestId("answer-save-state")).toHaveText(
      "Draft saved",
    );
    await expect(author.getByText("血浆", { exact: true })).toHaveCount(0);
    await author
      .getByRole("link", { name: /Which sample is accepted\?/u })
      .click();
    // An older refresh must still return its records to the submission that
    // requested it, even when an event refresh finishes first.
    let blockedRead!: () => void;
    const blocked = new Promise<void>((resolve) => {
      blockedRead = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let blockFirst = true;
    const overlap = async (route: import("@playwright/test").Route) => {
      if (blockFirst) {
        blockFirst = false;
        blockedRead();
        await released;
      }
      await route.continue();
    };
    await respondent.route("**/versions/*/questionnaire", overlap);
    await respondent
      .getByRole("button", { name: "Submit round", exact: true })
      .click();
    await blocked;
    const newer = respondent.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response.url().endsWith(`/versions/${version.id}/questionnaire`),
      { timeout: 5000 },
    );
    await call(
      "PUT",
      `/workflows/${workflow.id}/versions/${version.id}/questionnaire/settings`,
      { revision: 0, roundSizeLimit: null },
    );
    await newer;
    releaseRead();
    await respondent.unroute("**/versions/*/questionnaire", overlap);
    await expect(author.getByText("血浆", { exact: true }).first()).toBeVisible(
      { timeout: 8000 },
    );
    await expect(
      author.getByText("Dr Lin", { exact: false }).first(),
    ).toBeVisible();
    await testInfo.attach("questionnaire-engineer", {
      body: await author.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await respondent.goto(`${base}/my-work`);
    await expect(
      respondent.getByTestId("metric-questions").locator(".summary-value"),
    ).toHaveText("0");
    // A failed event stream leaves the record open and polling recovers it.
    await engineerContext.route("**/api/v1/me/events", (route) =>
      route.abort(),
    );
    await author.reload();
    await expect(
      author.getByText("Checking for updates periodically", { exact: true }),
    ).toBeVisible();
    await respondent
      .getByRole("link", { name: /Which sample is accepted\?/u })
      .click();
    await respondent.getByTestId("answer-box").fill("血清");
    await respondent
      .getByRole("button", { name: "Submit answer", exact: true })
      .click();
    await expect(author.getByText("血清", { exact: true }).first()).toBeVisible(
      { timeout: 15000 },
    );
  } finally {
    releaseRead();
    await engineerContext.close();
    await expertContext.close();
  }
});

test("the Engineer confirms formal facts and the answering expert acknowledges or disputes each restatement", async ({
  browser,
}, testInfo) => {
  const { group } = await call<{ group: { id: string } }>("POST", "/groups", {
    name: `Resolutions ${Date.now()}`,
  });
  const { workflow, version } = await call<{
    workflow: { id: string };
    version: { id: string };
  }>("POST", "/workflows", {
    groupId: group.id,
    name: `facts-${Date.now()}`,
    goal: "Agree sample handling.",
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
    { title: "Restatements" },
    engineer,
  );
  const { question } = await call<{ question: { id: string } }>(
    "POST",
    `${root}/rounds/${round.id}/questions`,
    {
      text: "How should plasma be stored?",
      topic: "scope",
      targets: [{ kind: "workflow", id: workflow.id }],
      rationale: "Agree handling.",
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
  await call(
    "PUT",
    `${root}/questions/${question.id}/answer`,
    {
      revision: 0,
      questionRevision: 1,
      text: "血浆在2–8°C保存，24小时内使用。",
    },
    expert,
  );
  await call(
    "POST",
    `${root}/questions/${question.id}/submit`,
    { revision: 1, questionRevision: 1 },
    expert,
  );
  const authorContext = await browser.newContext({
    extraHTTPHeaders: { "x-badger-test-person": JSON.stringify(engineer) },
  });
  const expertContext = await browser.newContext({
    extraHTTPHeaders: { "x-badger-test-person": JSON.stringify(expert) },
  });
  try {
    const author = await authorContext.newPage();
    const respondent = await expertContext.newPage();
    const url = `${base}/questionnaire/questions/${question.id}`;
    await author.goto(url);
    await english(author);
    await author
      .getByLabel("Formal fact 1", { exact: true })
      .fill("Store plasma at 2–8°C.");
    await author.getByRole("button", { name: "Add fact", exact: true }).click();
    await author
      .getByLabel("Formal fact 2", { exact: true })
      .fill("Use plasma within 48 hours.");
    await author
      .getByRole("button", { name: "Review resolution", exact: true })
      .click();
    await expect(author.getByRole("dialog")).toContainText(
      "Store plasma at 2–8°C.",
    );
    await author
      .getByRole("dialog")
      .getByRole("button", { name: "Sign off", exact: true })
      .click();
    await expect(author.getByTestId("confirmed-fact")).toHaveCount(2);
    await respondent.goto(`${base}/my-work`);
    await english(respondent);
    await respondent
      .getByRole("link", {
        name: /restatement to acknowledge.*How should plasma be stored\?/u,
      })
      .first()
      .click();
    const storage = respondent
      .getByTestId("confirmed-fact")
      .filter({ hasText: "Store plasma at 2–8°C." });
    await storage
      .getByRole("button", { name: "Acknowledge restatement", exact: true })
      .click();
    await respondent
      .getByRole("dialog")
      .getByRole("button", { name: "Sign off", exact: true })
      .click();
    await expect(
      storage.getByText("Acknowledged", { exact: true }),
    ).toBeVisible();
    await expect(
      author
        .getByTestId("confirmed-fact")
        .filter({ hasText: "Store plasma at 2–8°C." })
        .getByText("Acknowledged", { exact: true }),
    ).toBeVisible();
    await testInfo.attach("acknowledged-facts", {
      body: await respondent.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    const duration = respondent
      .getByTestId("confirmed-fact")
      .filter({ hasText: "Use plasma within 48 hours." });
    await duration
      .getByRole("button", { name: "Dispute restatement", exact: true })
      .click();
    await respondent
      .getByRole("dialog")
      .getByLabel("Reason", { exact: true })
      .fill("The answer says 24 hours.");
    await respondent
      .getByRole("dialog")
      .getByRole("button", { name: "Review resolution", exact: true })
      .click();
    await respondent
      .getByRole("dialog")
      .getByRole("button", { name: "Sign off", exact: true })
      .click();
    await expect(duration.getByText("Disputed", { exact: true })).toBeVisible();
    await expect(respondent.getByTestId("answer-box")).toBeEditable();
    await author.goto(`${base}/my-work`);
    await expect(
      author.getByRole("link", {
        name: /question needs attention.*How should plasma be stored\?/u,
      }),
    ).toBeVisible();
    await respondent
      .getByTestId("answer-box")
      .fill("Use plasma within 24 hours.");
    await respondent
      .getByRole("button", { name: "Submit answer", exact: true })
      .click();
    const { skill } = await call<{ skill: { id: string } }>("POST", "/skills", {
      groupId: group.id,
      name: "storage-backlog",
    });
    const files = [
      {
        path: "SKILL.md",
        content: Buffer.from(
          "---\nname: storage-backlog\ndescription: Storage rules\n---\nKeep cold.\n",
        ).toString("base64"),
      },
    ];
    const { preview: upload } = await call<{ preview: { hash: string } }>(
      "POST",
      `/skills/${skill.id}/upload-preview`,
      { files },
      engineer,
    );
    await call(
      "POST",
      `/skills/${skill.id}/versions`,
      { files, confirmed: true, expectedHash: upload.hash },
      engineer,
    );
    await call(
      "POST",
      `/workflows/${workflow.id}/versions/${version.id}/pins`,
      { skillId: skill.id, hash: upload.hash, purpose: "source" },
      engineer,
    );
    await author.goto(url);
    await author.getByLabel("Resolution", { exact: true }).click();
    await author.getByRole("option", { name: "Deferred", exact: true }).click();
    await author.getByLabel("Defer as", { exact: true }).click();
    await author
      .getByRole("option", { name: "Internal to a Skill", exact: true })
      .click();
    await author.getByLabel("Skill", { exact: true }).click();
    await author
      .getByRole("option", { name: "storage-backlog", exact: true })
      .click();
    await author
      .getByLabel("Reason", { exact: true })
      .fill("The Skill needs to document storage duration.");
    await author
      .getByRole("button", { name: "Review resolution", exact: true })
      .click();
    await author
      .getByRole("dialog")
      .getByRole("button", { name: "Sign off", exact: true })
      .click();
    await respondent.goto(`${base}/skills/${skill.id}`);
    const backlog = respondent.getByRole("region", {
      name: "Skill backlog",
      exact: true,
    });
    await expect(
      backlog.getByRole("link", {
        name: "How should plasma be stored?",
        exact: true,
      }),
    ).toBeVisible();
    await expect(backlog).toContainText(
      "The Skill needs to document storage duration.",
    );
  } finally {
    await authorContext.close();
    await expertContext.close();
  }
});
