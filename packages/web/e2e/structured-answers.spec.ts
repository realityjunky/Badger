import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import {
  startTestService,
  type TestService,
} from "@realityjunky/badger-server/testing";

const origin = "http://127.0.0.1:4327";
const base = `${origin}/team`;
const admin = { subject: "admin", email: "admin@example.com" };
const engineer = {
  subject: "structured-engineer",
  email: "structured-engineer@example.com",
  displayName: "Sam Engineer",
};
const expert = {
  subject: "structured-expert",
  email: "structured-expert@example.com",
  displayName: "Dr Lin",
};
let service: TestService;
test.use({ actionTimeout: 10_000 });
test.beforeAll(async () => {
  service = await startTestService({
    environment: {
      BADGER_PORT: "4327",
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
async function call(method: string, route: string, body?: unknown, as = admin) {
  const response = await service.request(`/team/api/v1${route}`, {
    as,
    method,
    headers: { origin, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  expect(response.ok, JSON.stringify(value)).toBe(true);
  return value;
}
async function english(page: Page) {
  await page.getByTestId("language-switch").click();
  await page.getByRole("menuitem", { name: "English", exact: true }).click();
}

test("a shared drafting tab lets a Field expert edit suggestions before the Engineer accepts them", async ({
  browser,
}, testInfo) => {
  const { group } = await call("POST", "/groups", {
    name: `Structured drafting ${Date.now()}`,
  });
  const { workflow, version } = await call("POST", "/workflows", {
    groupId: group.id,
    name: `drafted-structured-${Date.now()}`,
    goal: "Agree draft storage requirements.",
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
  const root = `/workflows/${workflow.id}/versions/${version.id}/questionnaire`;
  const jobs = `/workflows/${workflow.id}/versions/${version.id}/drafting-jobs`;
  const { round } = await call(
    "POST",
    `${root}/rounds`,
    { title: "Drafted storage" },
    engineer,
  );
  const { round: queuedRound } = await call(
    "POST",
    `${root}/rounds`,
    {
      title:
        "Follow-up: specimen transport and storage requirements for samples collected outside the laboratory",
    },
    engineer,
  );
  await call(
    "POST",
    jobs,
    { kind: "draft-questions", roundId: queuedRound.id, confirmed: true },
    engineer,
  );
  const { job } = await call(
    "POST",
    jobs,
    { kind: "draft-questions", roundId: round.id, confirmed: true },
    engineer,
  );
  const { secret } = await call(
    "POST",
    "/me/tokens",
    { name: "Drafting Agent", scopes: ["engineer"] },
    engineer,
  );
  const agent = async (action: string, body: unknown) => {
    const response = await service.request(
      `/team/api/v1${jobs}/${job.id}/${action}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "x-badger-agent-host": "example-host",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    const result = await response.json();
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  const claimed = await agent("claim", { revision: job.revision });
  await agent("submit", {
    leaseId: claimed.job.lease.id,
    contextHash: job.contextHash,
    result: {
      questions: [
        {
          text: "Which storage is required?",
          topic: "scope",
          targets: [{ kind: "workflow", id: workflow.id }],
          rationale: "Agree storage.",
          evidence: [],
          assignees: [{ kind: "role", role: "Field expert" }],
          priority: 10,
          answerType: { kind: "number", unit: "°C" },
        },
      ],
    },
  });
  const context = await browser.newContext({
    viewport: testInfo.project.use.viewport,
    extraHTTPHeaders: { "x-badger-test-person": JSON.stringify(engineer) },
  });
  const expertContext = await browser.newContext({
    viewport: testInfo.project.use.viewport,
    extraHTTPHeaders: { "x-badger-test-person": JSON.stringify(expert) },
  });
  try {
    const page = await context.newPage();
    await page.goto(
      `${base}/questionnaire?workflow=${workflow.id}&version=${version.id}&group=${group.id}&round=${round.id}`,
    );
    await english(page);
    const draftingTab = page.getByRole("tab", {
      name: "Drafting jobs and suggestions",
      exact: true,
    });
    const tabLink = draftingTab.getByRole("link", {
      name: "Drafting jobs and suggestions",
      exact: true,
    });
    const href = await tabLink.getAttribute("href");
    expect(href).not.toBeNull();
    const sharedUrl = new URL(href!, origin);
    expect(sharedUrl.pathname).toBe("/team/questionnaire");
    expect(Object.fromEntries(sharedUrl.searchParams)).toEqual({
      workflow: workflow.id,
      version: version.id,
      group: group.id,
      panel: "suggestions",
    });
    const [newTab] = await Promise.all([
      context.waitForEvent("page"),
      tabLink.click({ modifiers: ["ControlOrMeta"] }),
    ]);
    await expect(newTab).toHaveURL(sharedUrl.href);
    await expect(
      newTab.getByRole("tab", {
        name: "Drafting jobs and suggestions",
        exact: true,
      }),
    ).toHaveAttribute("aria-selected", "true");
    await newTab.close();
    await expect(draftingTab).toHaveAttribute("aria-selected", "false");
    await tabLink.click({ button: "right" });
    await expect(draftingTab).toHaveAttribute("aria-selected", "false");
    await page.keyboard.press("Escape");
    await tabLink.click();
    await expect(draftingTab).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(new RegExp(`round=${round.id}`, "u"));
    await page.goBack();
    await expect(draftingTab).toHaveAttribute("aria-selected", "false");
    await tabLink.click();
    await expect(page.getByTestId("drafting-job")).toHaveCount(2);
    const panel = page.getByRole("region", {
      name: "Drafting jobs and suggestions",
      exact: true,
    });
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await panel.screenshot({
        path: testInfo.outputPath(`drafting-jobs-${theme}.png`),
        animations: "disabled",
      });
    }
    await expect(
      page.getByRole("button", { name: "Copy review prompt", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Review suggestions", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Edit suggestion", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Review suggestions", exact: true }),
    ).toBeHidden();
    await expect(page.getByLabel("Unit", { exact: true })).toHaveValue("°C");
    await page.getByLabel("Answer type", { exact: true }).click();
    await page
      .locator(".ant-select-dropdown:visible")
      .getByTitle("Single choice", { exact: true })
      .click();
    await page
      .getByLabel("Options (one per line)", { exact: true })
      .fill("Cold\nFrozen");
    await page.getByRole("button", { name: "Keep edits", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Review suggestions", exact: true })
      .getByRole("button", { name: "Save", exact: true })
      .click();
    const respondent = await expertContext.newPage();
    await respondent.goto(sharedUrl.href);
    await english(respondent);
    await expect(
      respondent.getByRole("tab", {
        name: "Drafting jobs and suggestions",
        exact: true,
      }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(respondent.getByTestId("scope-selector")).toContainText(
      `Structured drafting`,
    );
    await expect(respondent.getByTestId("drafting-job")).toHaveCount(2);
    for (const name of [
      "Request drafting",
      "Review decisions",
      "Discard suggestions",
    ])
      await expect(
        respondent.getByRole("button", { name, exact: true }),
      ).toHaveCount(0);
    await respondent
      .getByRole("button", { name: "Review suggestions", exact: true })
      .click();
    await respondent
      .getByRole("button", { name: "Edit suggestion", exact: true })
      .click();
    await expect(
      respondent.getByLabel("Options (one per line)", { exact: true }),
    ).toHaveValue("Cold\nFrozen");
    await respondent
      .getByLabel("Rationale", { exact: true })
      .fill("Storage choices reviewed by the Field expert.");
    await respondent
      .getByRole("button", { name: "Keep edits", exact: true })
      .click();
    await respondent
      .getByRole("dialog", { name: "Review suggestions", exact: true })
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await expect(
      respondent.getByText("Review edits saved.", { exact: false }),
    ).toBeVisible();
    const saved = await call("GET", `${jobs}/${job.id}`, undefined, expert);
    expect(saved.job.review.result.questions[0].rationale).toBe(
      "Storage choices reviewed by the Field expert.",
    );
    await respondent.setViewportSize({ width: 375, height: 812 });
    for (const theme of ["light", "dark"] as const) {
      await respondent.emulateMedia({
        colorScheme: theme,
        reducedMotion: "reduce",
      });
      await expect(respondent.locator("html")).toHaveAttribute(
        "data-theme",
        theme,
      );
      expect(
        await respondent.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await respondent.screenshot({
        path: testInfo.outputPath(`drafting-jobs-expert-${theme}-mobile.png`),
        fullPage: true,
        animations: "disabled",
      });
    }
    await page
      .getByRole("button", { name: "Review decisions", exact: true })
      .click();
    const preview = page.getByRole("dialog", {
      name: "Review decisions",
      exact: true,
    });
    await expect(preview).toContainText("Single choice");
    await expect(preview).toContainText("Frozen");
    await expect(preview).toContainText(
      "Storage choices reviewed by the Field expert.",
    );
    await preview
      .getByRole("button", { name: "Accept reviewed result", exact: true })
      .click();
    await expect(page.getByText("Accepted", { exact: true })).toBeVisible();
    const accepted = await call("GET", root, undefined, engineer);
    expect(accepted.questions[0].answerType).toEqual({
      kind: "single-choice",
      options: ["Cold", "Frozen"],
    });
  } finally {
    await context.close();
    await expertContext.close();
  }
});

test("Engineers compose every answer type and experts submit structured answers with attachments", async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const { group } = await call("POST", "/groups", {
    name: `Structured ${Date.now()}`,
  });
  const { workflow, version } = await call("POST", "/workflows", {
    groupId: group.id,
    name: `structured-${Date.now()}`,
    goal: "Agree storage.",
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
  const authorContext = await browser.newContext({
    viewport: testInfo.project.use.viewport,
    extraHTTPHeaders: { "x-badger-test-person": JSON.stringify(engineer) },
  });
  const expertContext = await browser.newContext({
    viewport: testInfo.project.use.viewport,
    extraHTTPHeaders: { "x-badger-test-person": JSON.stringify(expert) },
  });
  try {
    const author = await authorContext.newPage();
    const respondent = await expertContext.newPage();
    await author.goto(
      `${base}/questionnaire?workflow=${workflow.id}&version=${version.id}`,
    );
    await english(author);
    await author
      .getByRole("button", { name: "New round", exact: true })
      .click();
    await author
      .getByLabel("Round title", { exact: true })
      .fill("Storage examples");
    await author
      .getByRole("button", { name: "Create round", exact: true })
      .click();
    const schemas = [
      ["free-text", "Free text"],
      ["single-choice", "Single choice"],
      ["multiple-choice", "Multiple choice"],
      ["yes-no", "Yes or no"],
      ["number", "Number with unit"],
      ["table", "Table"],
      ["file", "File"],
    ];
    for (const [kind, label] of schemas) {
      await author
        .getByRole("button", { name: "New question", exact: true })
        .click();
      await author
        .getByLabel("Question text", { exact: true })
        .fill(`Storage: ${kind}`);
      await author
        .getByLabel("Rationale", { exact: true })
        .fill("Agree storage examples.");
      await author.getByLabel("Answer type", { exact: true }).click();
      await author
        .locator(".ant-select-dropdown:visible")
        .getByTitle(label, { exact: true })
        .click();
      if (kind.endsWith("choice"))
        await author
          .getByLabel("Options (one per line)", { exact: true })
          .fill("Cold\nFrozen");
      if (kind === "number")
        await author.getByLabel("Unit", { exact: true }).fill("°C");
      if (kind === "table")
        await author
          .getByLabel("Columns (one per line)", { exact: true })
          .fill("Sample\nStorage");
      await author
        .getByRole("button", { name: "Save question", exact: true })
        .click();
      await expect(
        author.getByRole("heading", { name: `Storage: ${kind}`, exact: true }),
      ).toBeVisible();
    }
    await author
      .getByRole("button", { name: "Review round", exact: true })
      .click();
    await author
      .getByRole("dialog")
      .getByRole("button", { name: "Publish round", exact: true })
      .click();
    const root = `/workflows/${workflow.id}/versions/${version.id}/questionnaire`;
    const view = await call("GET", root, undefined, engineer);
    await respondent.goto(
      `${base}/questionnaire/questions/${view.questions[0].id}`,
    );
    await english(respondent);
    for (const [kind] of schemas) {
      const question = view.questions.find(
        (item: { text: string }) => item.text === `Storage: ${kind}`,
      );
      expect(question.answerType.kind).toBe(kind);
      await respondent.goto(`${base}/questionnaire/questions/${question.id}`);
      await expect(
        respondent.getByRole("heading", { name: question.text, exact: true }),
      ).toBeVisible();
      if (kind === "free-text")
        await respondent.getByTestId("answer-box").fill("仅示例样本");
      if (kind === "single-choice")
        await respondent
          .getByRole("radio", { name: "Frozen", exact: true })
          .check();
      if (kind === "multiple-choice") {
        await respondent
          .getByRole("checkbox", { name: "Cold", exact: true })
          .check();
        await respondent
          .getByRole("checkbox", { name: "Frozen", exact: true })
          .check();
      }
      if (kind === "yes-no")
        await respondent
          .getByRole("radio", { name: "No", exact: true })
          .check();
      if (kind === "number") await respondent.getByRole("spinbutton").fill("0");
      if (kind === "table") {
        await respondent
          .getByRole("button", { name: "Add row", exact: true })
          .click();
        await respondent
          .getByLabel("Sample, row 1", { exact: true })
          .fill("示例血液");
        await respondent
          .getByLabel("Storage, row 1", { exact: true })
          .fill("Frozen");
        await expect(respondent.getByTestId("answer-save-state")).toHaveText(
          "Draft saved",
        );
        for (const colorScheme of ["light", "dark"] as const) {
          await respondent.emulateMedia({ colorScheme });
          await respondent.reload();
          await expect(respondent.locator("html")).toHaveAttribute(
            "data-theme",
            colorScheme,
          );
          await expect(
            respondent.getByLabel("Storage, row 1", { exact: true }),
          ).toHaveValue("Frozen");
          await respondent.evaluate(() => window.scrollTo(0, 0));
          await testInfo.attach(`table-${colorScheme}`, {
            body: await respondent.screenshot({ fullPage: true }),
            contentType: "image/png",
          });
        }
      }
      if (kind === "file" || kind === "free-text") {
        if (kind === "free-text")
          await respondent.route(
            "**/questions/*/attachments",
            async (route) => {
              if (route.request().postDataJSON().name === "failed.txt") {
                await new Promise((resolve) => setTimeout(resolve, 1100));
                await route.abort();
              } else await route.continue();
            },
          );
        const example = {
          name: "example.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("Example storage only"),
        };
        await respondent
          .locator("#answer-files")
          .setInputFiles(
            kind === "free-text"
              ? [example, { ...example, name: "failed.txt" }]
              : example,
          );
        await expect(
          respondent.getByRole("link", { name: "example.txt", exact: true }),
        ).toBeVisible();
      }
      await expect(respondent.getByTestId("answer-save-state")).toHaveText(
        "Draft saved",
      );
      if (kind === "free-text") {
        await expect(respondent.getByRole("alert")).toContainText("failed.txt");
        await respondent.unroute("**/questions/*/attachments");
      }
      await respondent.reload();
      await expect(respondent.getByTestId("answer-save-state")).toHaveText(
        "Draft saved",
      );
      if (kind === "yes-no")
        await expect(
          respondent.getByRole("radio", { name: "No", exact: true }),
        ).toBeChecked();
      if (kind === "number")
        await expect(respondent.getByRole("spinbutton")).toHaveValue("0");
      await respondent
        .getByRole("button", {
          name: kind === "file" ? "Submit round" : "Submit answer",
          exact: true,
        })
        .click();
      await expect(respondent.getByTestId("answer-save-state")).toHaveText(
        "Submitted",
      );
      await author.goto(`${base}/questionnaire/questions/${question.id}`);
      if (kind === "file") {
        const downloading = author.waitForEvent("download");
        await author
          .getByRole("link", { name: "example.txt", exact: true })
          .first()
          .click();
        expect((await downloading).suggestedFilename()).toBe("example.txt");
        await author
          .getByLabel("Formal fact 1", { exact: true })
          .fill("Use the attached storage example.");
        await author
          .getByRole("button", { name: "Review resolution", exact: true })
          .click();
        await expect(
          author
            .getByRole("dialog")
            .getByRole("link", { name: "example.txt", exact: true }),
        ).toBeVisible();
        await author
          .getByRole("dialog")
          .getByRole("button", { name: "Sign off", exact: true })
          .click();
        await expect(
          author
            .getByTestId("confirmed-fact")
            .getByRole("link", { name: "example.txt", exact: true }),
        ).toBeVisible();
        await respondent.reload();
        await respondent
          .getByTestId("confirmed-fact")
          .getByRole("button", { name: "Acknowledge restatement", exact: true })
          .click();
        await respondent
          .getByRole("dialog")
          .getByRole("button", { name: "Sign off", exact: true })
          .click();
        await expect(
          respondent
            .getByTestId("confirmed-fact")
            .getByText("Acknowledged", { exact: true }),
        ).toBeVisible();
        await expect(respondent.getByRole("dialog")).toBeHidden();
        await respondent.evaluate(() => window.scrollTo(0, 0));
        await testInfo.attach("file-evidence", {
          body: await respondent.screenshot({ fullPage: true }),
          contentType: "image/png",
        });
      }
    }
    const answered = await call("GET", root, undefined, engineer);
    expect(answered.answers).toHaveLength(7);
    expect(
      answered.answers.every(
        (answer: { state: string }) => answer.state === "submitted",
      ),
    ).toBe(true);
  } finally {
    await authorContext.close();
    await expertContext.close();
  }
});

test("an upload preserves the reviewed revision when another device saves attachments", async ({
  browser,
}) => {
  const { group } = await call("POST", "/groups", {
    name: `Upload conflict ${Date.now()}`,
  });
  const { workflow, version } = await call("POST", "/workflows", {
    groupId: group.id,
    name: `upload-conflict-${Date.now()}`,
    goal: "Keep draft edits.",
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
  const { round } = await call(
    "POST",
    `${root}/rounds`,
    { title: "Upload conflict" },
    engineer,
  );
  const { question } = await call(
    "POST",
    `${root}/rounds/${round.id}/questions`,
    {
      text: "Provide example storage instructions.",
      topic: "scope",
      targets: [{ kind: "workflow", id: workflow.id }],
      rationale: "Keep evidence.",
      evidence: [],
      assignees: [{ kind: "role", role: "Field expert" }],
      priority: 10,
      answerType: { kind: "file" },
    },
    engineer,
  );
  const { preview } = await call(
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
  const upload = async (name: string) =>
    (
      await call(
        "POST",
        `${root}/questions/${question.id}/attachments`,
        {
          questionRevision: 1,
          name,
          mediaType: "text/plain",
          contentBase64: Buffer.from("Example only").toString("base64"),
        },
        expert,
      )
    ).attachment;
  const original = await upload("original.txt");
  await call(
    "PUT",
    `${root}/questions/${question.id}/answer`,
    { revision: 0, questionRevision: 1, attachments: [original.id] },
    expert,
  );
  const context = await browser.newContext({
    extraHTTPHeaders: { "x-badger-test-person": JSON.stringify(expert) },
  });
  let releaseUpload = () => {};
  const release = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  let signalUpload = () => {};
  const uploading = new Promise<void>((resolve) => {
    signalUpload = resolve;
  });
  try {
    const page = await context.newPage();
    await page.goto(`${base}/questionnaire/questions/${question.id}`);
    await english(page);
    await expect(
      page.getByRole("link", { name: "original.txt", exact: true }),
    ).toBeVisible();
    await page.route("**/questions/*/attachments", async (route) => {
      const response = await route.fetch();
      signalUpload();
      await release;
      await route.fulfill({ response });
    });
    await page.locator("#answer-files").setInputFiles({
      name: "local.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Example local evidence"),
    });
    await uploading;
    const remote = await upload("remote.txt");
    const refreshed = page.waitForResponse(
      async (response) =>
        response.request().method() === "GET" &&
        response.url().endsWith(root) &&
        (await response.json()).answers.some(
          (answer: { revision: number }) => answer.revision === 2,
        ),
    );
    await call(
      "PUT",
      `${root}/questions/${question.id}/answer`,
      {
        revision: 1,
        questionRevision: 1,
        attachments: [original.id, remote.id],
      },
      expert,
    );
    await refreshed;
    releaseUpload();
    await expect(page.getByTestId("answer-save-state")).toHaveText(
      "Draft not saved",
    );
    await expect(
      page.getByRole("link", { name: "local.txt", exact: true }),
    ).toBeVisible();
    const view = await call("GET", root, undefined, expert);
    expect(view.answers[0].revision).toBe(2);
    expect(
      view.answers[0].attachments.map((file: { name: string }) => file.name),
    ).toEqual(["original.txt", "remote.txt"]);
  } finally {
    releaseUpload();
    await context.close();
  }
});
