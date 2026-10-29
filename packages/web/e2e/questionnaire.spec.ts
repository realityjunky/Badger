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
      body: await respondent.screenshot({
        fullPage: true,
        path: `../../output/playwright/issue-48-acknowledged-${testInfo.project.name}.png`,
      }),
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
