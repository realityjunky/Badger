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
