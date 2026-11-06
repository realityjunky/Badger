import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type { ScriptEffectSuggestion } from "@realityjunky/badger";

const base = "http://127.0.0.1:4320/badger";

async function call(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
) {
  return page.evaluate(
    async ({ method, path, body, token }) => {
      const response = await fetch(`/badger/api/v1${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(token
            ? {
                authorization: `Bearer ${token}`,
                "x-badger-agent-host": "Browser study Agent",
              }
            : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const value = await response.json();
      if (!response.ok)
        throw new Error(
          `${method} ${path}: ${response.status} ${JSON.stringify(value)}`,
        );
      return value;
    },
    { method, path, body, token },
  );
}

test("the uploader clarifies uncertainty, corrects exclusive none, personally confirms effects, and completes Source study", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(10_000);
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto(`${base}/my-work`);
  const { preferences } = await call(page, "GET", "/me/preferences");
  await call(page, "PUT", "/me/preferences", {
    revision: preferences.revision,
    language: "en",
    theme: "light",
    fontScale: 100,
    railCollapsed: false,
  });
  await page.reload();
  const name = `effects-${Date.now()}`;
  const { group } = await call(page, "POST", "/groups", { name });
  const { workflow, version } = await call(page, "POST", "/workflows", {
    groupId: group.id,
    name,
    goal: "Review script effects from pinned files",
    intent: "new-skill",
    locale: "en",
  });
  const { skill } = await call(page, "POST", "/skills", {
    groupId: group.id,
    name,
  });
  const script = "#!/bin/sh\nprintf example > output.txt\n";
  const files = [
    {
      path: "SKILL.md",
      content: Buffer.from(
        `---\nname: ${name}\ndescription: Example source\n---\nRead scripts/run.sh.\n`,
      ).toString("base64"),
    },
    { path: "scripts/run.sh", content: Buffer.from(script).toString("base64") },
  ];
  const { preview: upload } = await call(
    page,
    "POST",
    `/skills/${skill.id}/upload-preview`,
    { files },
  );
  expect(upload.scripts).toEqual([
    { path: "scripts/run.sh", sideEffects: "undeclared" },
  ]);
  await call(page, "POST", `/skills/${skill.id}/versions`, {
    files,
    confirmed: true,
    expectedHash: upload.hash,
  });
  const path = `/workflows/${workflow.id}/versions/${version.id}`;
  const effects = `/skills/${skill.id}/versions/${upload.hash}/effects`;
  const pin = { skillId: skill.id, hash: upload.hash };
  await call(page, "POST", `${path}/pins`, pin);
  await page.goto(`${base}${path}#source-study`);
  const study = page.locator("#source-study");
  await expect(study).toContainText("Effect review pending");
  const reviewSources = page.getByRole("button", {
    name: "Review Sources",
    exact: true,
  });
  await expect(reviewSources).toBeVisible({ timeout: 20_000 });
  await reviewSources.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm source set" })
    .click();
  await expect(page.getByText(/^Sources confirmed /u)).toBeVisible();
  const panel = study.getByRole("region", {
    name: `Script effect review · ${name}`,
    exact: true,
  });
  await panel
    .getByRole("button", { name: "Request Source study draft", exact: true })
    .click();
  const { jobs } = await call(page, "GET", `${path}/drafting-jobs`);
  const job = jobs.find(
    (entry: { kind: string }) => entry.kind === "source-study",
  );
  const { secret } = await call(page, "POST", "/me/tokens", {
    name: "Browser study Agent",
    scopes: ["engineer"],
  });
  const claim = await call(
    page,
    "POST",
    `${path}/drafting-jobs/${job.id}/claim`,
    { revision: job.revision },
    secret,
  );
  expect(claim.contextBundle.scriptEffectContract.schemaVersion).toBe(1);
  const result = {
    facts: [
      {
        statement: "The script writes output.txt.",
        evidence: [
          {
            ...pin,
            path: "scripts/run.sh",
            fileHash: createHash("sha256").update(script).digest("hex"),
            startLine: 2,
            endLine: 2,
          },
        ],
      },
    ],
    interfaces: [],
    scriptEffects: [
      {
        ...pin,
        path: "scripts/run.sh",
        effects: ["local-writes"],
        rationale: "The script writes output.txt.",
        evidence: [
          {
            ...pin,
            path: "scripts/run.sh",
            fileHash: createHash("sha256").update(script).digest("hex"),
            startLine: 2,
            endLine: 2,
          },
        ],
        conditionalBehavior: "Writes on every invocation.",
        uncertainty: "Does this also contact a remote service?",
      },
    ],
  };
  const { job: submitted } = await call(
    page,
    "POST",
    `${path}/drafting-jobs/${job.id}/submit`,
    {
      leaseId: claim.job.lease.id,
      contextHash: job.contextHash,
      result,
    },
    secret,
  );
  const { preview: acceptance } = await call(
    page,
    "POST",
    `${path}/drafting-jobs/${job.id}/accept-preview`,
    { revision: submitted.revision, ...result },
  );
  await call(page, "POST", `${path}/drafting-jobs/${job.id}/accept`, {
    revision: submitted.revision,
    ...result,
    confirmed: true,
    confirmationHash: acceptance.confirmationHash,
    requestId: `accept-${job.id}`,
  });
  expect((await call(page, "GET", effects)).review).toBeNull();
  await panel
    .getByRole("button", { name: "Reload records", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Send effect draft to uploader" }),
  ).toBeEnabled();
  await panel
    .getByRole("button", { name: "Send effect draft to uploader" })
    .click();
  await expect(panel).toContainText("Does this also contact a remote service?");
  await panel
    .getByRole("link", { name: "Open this Source study review" })
    .click();
  const review = page.getByRole("region", {
    name: `Script effect review · ${name}`,
    exact: true,
  });
  await expect(review).toBeVisible();
  await review
    .getByRole("button", { name: "scripts/run.sh:2–2", exact: true })
    .click();
  const cited = page.getByRole("dialog", {
    name: "Cited immutable source lines",
  });
  await expect(cited).toContainText("printf example > output.txt");
  await cited.getByRole("button", { name: "Close", exact: true }).click();
  await review
    .getByLabel("Clarification or correction note", { exact: true })
    .fill(
      "Please confirm whether the invoked helper uses a network connection.",
    );
  await review
    .getByRole("button", { name: "Request clarification", exact: true })
    .click();
  await expect(review).toContainText(
    "Please confirm whether the invoked helper uses a network connection.",
  );
  await review
    .getByRole("button", {
      name: "Review complete declaration set",
      exact: true,
    })
    .click();
  await expect(
    review.getByRole("alert").filter({ hasText: "Finish every script" }),
  ).toBeVisible();
  const row = review.getByRole("article", {
    name: "scripts/run.sh",
    exact: true,
  });
  await row
    .getByLabel("Answer the uncertainty scripts/run.sh", { exact: true })
    .fill(
      "No remote service is contacted; this version writes only output.txt.",
    );
  const labels = row.getByRole("combobox", {
    name: "Script side effects scripts/run.sh",
    exact: true,
  });
  await labels.click();
  await page
    .locator(".ant-select-item-option")
    .filter({ hasText: /^None$/u })
    .click();
  await expect(
    row.locator(".ant-select-selection-item").first(),
  ).toHaveAttribute("title", "None");
  await page
    .locator(".ant-select-item-option")
    .filter({ hasText: /^Local writes$/u })
    .click();
  await labels.press("Escape");
  await expect(
    row.locator(".ant-select-selection-item").first(),
  ).toHaveAttribute("title", "Local writes");
  await row
    .getByRole("checkbox", { name: "I reviewed this script's declaration" })
    .check();
  await review
    .getByRole("button", {
      name: "Review complete declaration set",
      exact: true,
    })
    .click();
  const confirmation = page.getByRole("dialog", {
    name: "Review complete declaration set",
    exact: true,
  });
  await expect(confirmation).toContainText(upload.hash);
  await expect(confirmation).toContainText("No remote service is contacted");
  await expect(review).toContainText("Effect review pending");
  await confirmation
    .getByRole("button", {
      name: "Personally confirm declarations",
      exact: true,
    })
    .click();
  await expect(confirmation).toBeHidden();
  await expect(review).toContainText("Uploader confirmed");
  expect(
    (await call(page, "GET", "/me/inbox")).items.find(
      (entry: { kind: string }) => entry.kind === "script-effect-review",
    ).state,
  ).toBe("done");
  await page.goto(`${base}${path}#source-study`);
  await study
    .getByRole("button", { name: "Review study", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Review study", exact: true })
    .getByRole("button", { name: "Mark version studied", exact: true })
    .click();
  await expect(study).toContainText("1 of 1 pinned versions studied");
  await page.goto(
    `${base}/source-reviews/${skill.id}/${upload.hash}#source-study`,
  );
  await page.setViewportSize({ width: 375, height: 812 });
  for (const theme of ["light", "dark"] as const) {
    const current = await call(page, "GET", "/me/preferences");
    await call(page, "PUT", "/me/preferences", {
      revision: current.preferences.revision,
      language: "en",
      theme,
      fontScale: 100,
      railCollapsed: false,
    });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(review).toContainText("Uploader confirmed");
    await expect(
      review.getByRole("button", { name: "Reload records", exact: true }),
    ).toBeEnabled();
    await expect(
      review.getByRole("button", { name: "Correct declarations", exact: true }),
    ).toBeEnabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`script-effects-${theme}-mobile.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
  expect(problems).toEqual([]);
});

test("source-study suggestions keep edits across numbered tabs without confirming uploader declarations", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(10_000);
  await page.goto(`${base}/my-work`);
  const { preferences } = await call(page, "GET", "/me/preferences");
  await call(page, "PUT", "/me/preferences", {
    revision: preferences.revision,
    language: "en",
    theme: "system",
    fontScale: 100,
    railCollapsed: false,
  });
  await page.reload();
  const name = `source-tabs-${Date.now()}`;
  const { group } = await call(page, "POST", "/groups", { name });
  const { workflow, version } = await call(page, "POST", "/workflows", {
    groupId: group.id,
    name,
    goal: "Review source statements and script effect suggestions.",
    intent: "new-skill",
    locale: "en",
  });
  const { skill } = await call(page, "POST", "/skills", {
    groupId: group.id,
    name,
  });
  const scripts = [
    {
      path: "scripts/write.sh",
      content:
        '#!/bin/sh\nprintf example > output.txt\nif [ "$FETCH_REMOTE" = 1 ]; then curl https://example.test/input; fi\n',
    },
    { path: "scripts/inspect.sh", content: "#!/bin/sh\nprintf example\n" },
  ];
  const files = [
    {
      path: "SKILL.md",
      content: Buffer.from(
        `---\nname: ${name}\ndescription: Source review example\n---\nInspect the two scripts.\n`,
      ).toString("base64"),
    },
    ...scripts.map((script) => ({
      path: script.path,
      content: Buffer.from(script.content).toString("base64"),
    })),
  ];
  const { preview: upload } = await call(
    page,
    "POST",
    `/skills/${skill.id}/upload-preview`,
    { files },
  );
  await call(page, "POST", `/skills/${skill.id}/versions`, {
    files,
    confirmed: true,
    expectedHash: upload.hash,
  });
  const path = `/workflows/${workflow.id}/versions/${version.id}`;
  const jobs = `${path}/drafting-jobs`;
  const effects = `/skills/${skill.id}/versions/${upload.hash}/effects`;
  const pin = { skillId: skill.id, hash: upload.hash };
  await call(page, "POST", `${path}/pins`, pin);
  await page.goto(`${base}${path}#sources`);
  await page
    .getByRole("button", { name: "Review Sources", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm source set" })
    .click();
  await expect(page.getByText(/^Sources confirmed /u)).toBeVisible();
  const { job } = await call(page, "POST", jobs, {
    kind: "source-study",
    skillId: skill.id,
    confirmed: true,
  });
  const { secret } = await call(page, "POST", "/me/tokens", {
    name: "Source review Agent",
    scopes: ["engineer"],
  });
  const claim = await call(
    page,
    "POST",
    `${jobs}/${job.id}/claim`,
    { revision: job.revision },
    secret,
  );
  const evidence = scripts.map((script) => ({
    ...pin,
    path: script.path,
    fileHash: createHash("sha256").update(script.content).digest("hex"),
    startLine: 2,
    endLine: 2,
  }));
  const result = {
    facts: [
      { statement: "The first script writes a file.", evidence: [evidence[0]] },
      {
        statement: "The second script prints a value.",
        evidence: [evidence[1]],
      },
    ],
    interfaces: [],
    scriptEffects: scripts.map((script, index) => ({
      ...pin,
      path: script.path,
      effects: [index === 0 ? "local-writes" : "network"],
      rationale: "Initial Agent suggestion.",
      evidence: [evidence[index]],
      conditionalBehavior: "Initial behavior description.",
      uncertainty: "Which conditions apply?",
    })),
  };
  const { job: submitted } = await call(
    page,
    "POST",
    `${jobs}/${job.id}/submit`,
    { leaseId: claim.job.lease.id, contextHash: job.contextHash, result },
    secret,
  );
  await page.goto(
    `${base}/questionnaire?workflow=${workflow.id}&version=${version.id}&group=${group.id}&panel=suggestions&job=${job.id}`,
  );
  const card = page.locator(`#drafting-job-${job.id}`);
  await card
    .getByRole("button", { name: "Review suggestions", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Review suggestions",
    exact: true,
  });
  await expect(
    dialog.getByRole("tab", { name: "Statements", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    dialog.getByRole("tab", { name: "Script effect review", exact: true }),
  ).toBeVisible();
  const statement = dialog.getByRole("textbox", {
    name: "Statement",
    exact: true,
  });
  await expect(statement).toHaveValue(result.facts[0]!.statement);
  await statement.fill("The first script writes output.txt.");
  await dialog.getByRole("tab", { name: "2", exact: true }).click();
  await expect(statement).toHaveValue(result.facts[1]!.statement);
  await statement.fill("The second script prints only to standard output.");
  await dialog
    .getByRole("tab", { name: "Script effect review", exact: true })
    .click();
  await expect(
    dialog.getByRole("heading", { name: scripts[0]!.path }),
  ).toBeVisible();
  await dialog.getByRole("combobox", { name: "Script side effects" }).click();
  await page
    .locator(".ant-select-dropdown:visible")
    .getByTitle("Network", { exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".ant-select-dropdown:visible")).toHaveCount(0);
  await dialog
    .getByRole("textbox", { name: "Why these effects apply", exact: true })
    .fill("Writes output.txt and can fetch remote input.");
  await dialog
    .getByRole("textbox", {
      name: "Conditional behavior and invoked tools",
      exact: true,
    })
    .fill("The curl command runs only when FETCH_REMOTE=1.");
  await dialog
    .getByRole("textbox", { name: "Uncertainty to resolve", exact: true })
    .fill("Does the remote endpoint require authentication?");
  await dialog.getByRole("tab", { name: "2", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: scripts[1]!.path }),
  ).toBeVisible();
  await dialog.getByRole("combobox", { name: "Script side effects" }).click();
  await page
    .locator(".ant-select-dropdown:visible")
    .getByTitle("None", { exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".ant-select-dropdown:visible")).toHaveCount(0);
  await dialog
    .getByRole("textbox", { name: "Why these effects apply", exact: true })
    .fill("Only writes to standard output; no files or network access.");
  await dialog
    .getByRole("textbox", {
      name: "Conditional behavior and invoked tools",
      exact: true,
    })
    .fill("Prints on every invocation.");
  await dialog
    .getByRole("textbox", { name: "Uncertainty to resolve", exact: true })
    .fill("");
  await dialog.getByRole("tab", { name: "Statements", exact: true }).click();
  await expect(statement).toHaveValue(
    "The second script prints only to standard output.",
  );
  await dialog.getByRole("tab", { name: "1", exact: true }).click();
  await expect(statement).toHaveValue("The first script writes output.txt.");
  await dialog
    .getByRole("tab", { name: "Script effect review", exact: true })
    .click();
  await dialog.getByRole("tab", { name: "1", exact: true }).click();
  await expect(
    dialog.getByRole("textbox", {
      name: "Conditional behavior and invoked tools",
      exact: true,
    }),
  ).toHaveValue("The curl command runs only when FETCH_REMOTE=1.");
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await dialog.screenshot({
      path: info.outputPath(`source-suggestions-${theme}.png`),
      animations: "disabled",
    });
  }
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  const saved = (await call(page, "GET", `${jobs}/${job.id}`)).job;
  expect(saved.result).toEqual(result);
  expect(saved.resultHash).toBe(submitted.resultHash);
  expect(
    saved.review.result.facts.map(
      (fact: { statement: string }) => fact.statement,
    ),
  ).toEqual([
    "The first script writes output.txt.",
    "The second script prints only to standard output.",
  ]);
  expect(saved.review.result.scriptEffects).toEqual([
    {
      ...result.scriptEffects[0],
      effects: ["local-writes", "network"],
      rationale: "Writes output.txt and can fetch remote input.",
      conditionalBehavior: "The curl command runs only when FETCH_REMOTE=1.",
      uncertainty: "Does the remote endpoint require authentication?",
    },
    {
      ...result.scriptEffects[1],
      effects: ["none"],
      rationale: "Only writes to standard output; no files or network access.",
      conditionalBehavior: "Prints on every invocation.",
      uncertainty: null,
    },
  ]);
  expect((await call(page, "GET", effects)).review).toBeNull();
  await card
    .getByRole("button", { name: "Review decisions", exact: true })
    .click();
  const decision = page.getByRole("dialog", {
    name: "Review decisions",
    exact: true,
  });
  await decision
    .getByRole("tab", { name: "Script effect review", exact: true })
    .click();
  await expect(decision).toContainText(
    "Writes output.txt and can fetch remote input.",
  );
  await expect(decision.getByRole("textbox")).toHaveCount(0);
  await expect(decision.getByRole("combobox")).toHaveCount(0);
  await decision.getByRole("button", { name: "Cancel", exact: true }).click();
  const routed = await call(page, "POST", `${effects}/route`, {
    workflowVersionId: version.id,
    jobId: job.id,
    jobRevision: saved.revision,
    revision: 0,
  });
  expect(routed.review.kind).toBe("proposal");
  expect(routed.review.content.scripts).toEqual(
    saved.review.result.scriptEffects.map((row: ScriptEffectSuggestion) => ({
      ...row,
      reviewed: false,
      uncertaintyAnswer: "",
    })),
  );
});
