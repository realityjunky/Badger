import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startStubLlmProvider } from "@realityjunky/badger-server/testing";

async function call(page: Page, path: string, body?: unknown) {
  return page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(`/api/v1${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers:
          body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const value = await response.json();
      if (!response.ok)
        throw new Error(`HTTP ${response.status}: ${JSON.stringify(value)}`);
      return value;
    },
    { path, body },
  );
}

test("connection settings expose API key entry and keep save and test feedback visible", async ({
  page,
}) => {
  const provider = await startStubLlmProvider();
  const id = `settings-feedback-${Date.now()}`;
  try {
    await page.goto("/admin/llm");
    await page.getByTestId("language-switch").click();
    await page.getByRole("menuitem", { name: "English", exact: true }).click();
    const example = JSON.parse(
      await fs.readFile(
        new URL("../../server/config/llm.example.json", import.meta.url),
        "utf8",
      ),
    );
    const profile = {
      ...example.configuration.models[0],
      id,
      name: `Settings ${id}`,
    };
    await page.getByLabel("Import model profiles (JSON)").setInputFiles({
      name: "profile.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ models: [profile] })),
    });
    const key = page.getByLabel(`API key · ${id}`, { exact: true });
    await expect(key).toBeVisible();
    const earlyConnection = page
      .locator("details.llm-connection")
      .filter({ has: page.locator("summary").filter({ hasText: id }) });
    await page
      .getByRole("button", { name: "Save LLM configuration", exact: true })
      .click();
    await expect(
      page.getByText("LLM configuration saved.", { exact: true }),
    ).toBeVisible();
    await earlyConnection
      .getByRole("button", { name: "Test saved connection", exact: true })
      .click();
    await expect(earlyConnection.getByRole("alert")).toContainText(
      "Enter the model API base URL",
    );
    await expect(earlyConnection.getByRole("alert")).toBeInViewport({
      ratio: 1,
    });
    expect(provider.requests).toHaveLength(0);
    await key.fill("synthetic-settings-key");
    await page.getByLabel(`API base URL · ${id}`).fill(provider.url);
    const connection = page
      .locator("details.llm-connection")
      .filter({ has: page.locator("summary").filter({ hasText: id }) });
    const testConnection = connection.getByRole("button", {
      name: "Test saved connection",
      exact: true,
    });
    await expect(testConnection).toBeDisabled();
    await expect(
      connection.getByText("Save changes before testing this connection.", {
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByLabel("Task prompt text · script-side-effects")
      .scrollIntoViewIfNeeded();
    const save = page.getByRole("button", {
      name: "Save LLM configuration",
      exact: true,
    });
    await expect(save).toBeInViewport({ ratio: 1 });
    await save.click();
    await expect(
      page.getByText("LLM configuration saved.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("LLM configuration saved.", { exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(key).toHaveCount(0);
    provider.requireKey("synthetic-settings-key");
    provider.respond({ scripts: [] }, { status: 401 });
    await testConnection.click();
    const error = connection.getByRole("alert");
    await expect(error).toContainText("Model HTTP 401");
    await expect(error).toBeInViewport({ ratio: 1 });
    provider.respond({ scripts: [] });
    await testConnection.click();
    const accepted = connection.getByRole("alert");
    await expect(accepted).toContainText(
      "provider accepted the configured request",
    );
    await expect(accepted).toBeInViewport({ ratio: 1 });
    await page.getByLabel(`Display name · ${id}`).fill(`Updated ${id}`);
    await save.click();
    await expect(
      page.getByText("LLM configuration saved.", { exact: true }),
    ).toBeVisible();
    await testConnection.click();
    await expect(connection.getByRole("alert")).toContainText(
      "provider accepted the configured request",
    );
    expect(provider.requests).toHaveLength(3);
  } finally {
    await provider.close();
  }
});

test("an Administrator configures a model and a person reviews automatic editable upload suggestions", async ({
  page,
}) => {
  const provider = await startStubLlmProvider();
  const folder = await fs.mkdtemp(path.join(tmpdir(), "badger-browser-llm-"));
  const suffix = `${Date.now()}`;
  const id = `browser-flash-${suffix}`;
  const name = `suggestion-source-${suffix}`;
  const script =
    "#!/bin/sh\ncurl https://synthetic.example/data > result.txt\n";
  try {
    await page.goto("/admin/llm");
    await page.getByTestId("language-switch").click();
    await page.getByRole("menuitem", { name: "English" }).click();
    await expect(
      page.getByRole("heading", { name: "Model connections" }),
    ).toBeVisible();
    const example = JSON.parse(
      await fs.readFile(
        new URL("../../server/config/llm.example.json", import.meta.url),
        "utf8",
      ),
    );
    const profile = example.configuration.models[0];
    profile.id = id;
    profile.name = `Browser Flash ${suffix}`;
    await page.getByLabel("Import model profiles (JSON)").setInputFiles({
      name: "profile.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ models: [profile] })),
    });
    await page.getByLabel(`API base URL · ${id}`).fill(provider.url);
    await page
      .getByLabel(`API key · ${id}`, { exact: true })
      .fill("synthetic-browser-key-95");
    await page.getByLabel("Assigned model · script-side-effects").click();
    await page
      .locator(".ant-select-dropdown:visible")
      .getByText(`${profile.name} · ${id}`, { exact: true })
      .click();
    const prompt = page.getByLabel("Task prompt text · script-side-effects");
    await prompt.fill(
      `${await prompt.inputValue()}\nBrowser journey prompt revision.`,
    );
    await page
      .getByRole("button", { name: "Save LLM configuration", exact: true })
      .click();
    await expect(
      page.getByText("LLM configuration saved.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByLabel(`API key · ${id}`, { exact: true }),
    ).toHaveCount(0);
    const connection = page
      .locator("details.llm-connection")
      .filter({ has: page.locator("summary").filter({ hasText: id }) });
    await connection
      .getByRole("button", { name: "Test saved connection" })
      .click();
    await expect(
      page.getByText(/provider accepted the configured request/),
    ).toBeVisible();
    expect(provider.requests[0]).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
      max_tokens: 8192,
    });

    const { group } = await call(page, "/groups", {
      name: `LLM browser ${suffix}`,
    });
    const { skill } = await call(page, "/skills", { groupId: group.id, name });
    await fs.mkdir(path.join(folder, "scripts"));
    await fs.writeFile(
      path.join(folder, "SKILL.md"),
      `---\nname: ${name}\ndescription: Synthetic browser source\n---\n# Example\n`,
    );
    await fs.writeFile(path.join(folder, "scripts/run.sh"), script);
    provider.respond(
      {
        scripts: [
          {
            path: "scripts/run.sh",
            effects: ["network", "local-writes"],
            rationale: "The script calls curl and writes result.txt.",
            complete: true,
            uncertainty: "",
            citations: [
              {
                path: "scripts/run.sh",
                hash: createHash("sha256").update(script).digest("hex"),
                startLine: 2,
                endLine: 2,
              },
            ],
          },
        ],
      },
      { delayMs: 1500 },
    );
    await page.goto(`/skills/${skill.id}`);
    await page
      .getByRole("button", { name: "Upload version", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Choose Skill folder").setInputFiles(folder);
    await expect(dialog.getByRole("status")).toContainText(
      "Analyzing script effects",
    );
    await expect(
      dialog.getByRole("button", { name: "Confirm immutable upload" }),
    ).toBeDisabled();
    await dialog
      .getByText("Inspect active task prompt and revision", { exact: true })
      .click();
    await expect(dialog).toContainText("Browser journey prompt revision.");
    await expect(dialog).toContainText(
      "The script calls curl and writes result.txt.",
    );
    await dialog.getByText("scripts/run.sh:2–2", { exact: true }).click();
    await expect(
      dialog
        .locator("pre")
        .filter({ hasText: "curl https://synthetic.example/data" }),
    ).toBeVisible();
    const effects = dialog.getByLabel("Script side effects scripts/run.sh");
    const field = dialog
      .locator("label.field")
      .filter({ hasText: "scripts/run.sh" });
    await expect(field).toContainText("Network");
    await expect(field).toContainText("Local writes");
    expect(
      (await call(page, `/skills/${skill.id}/versions`)).versions,
    ).toHaveLength(0);
    await effects.click();
    await page
      .locator(".ant-select-dropdown:visible")
      .getByText("Scheduler submission", { exact: true })
      .click();
    await effects.press("Escape");
    await dialog
      .getByRole("button", { name: "Confirm immutable upload" })
      .click();
    await expect(dialog).toHaveCount(0);
    const versions = (await call(page, `/skills/${skill.id}/versions`))
      .versions;
    expect(versions).toHaveLength(1);
    expect(versions[0].scripts[0].sideEffects).toEqual(
      expect.arrayContaining([
        "network",
        "local-writes",
        "scheduler-submission",
      ]),
    );
    expect(
      await page.evaluate(() => JSON.stringify({ ...localStorage })),
    ).not.toContain("synthetic-browser-key-95");

    // A late suggestion must not overwrite a declaration edited in flight.
    await page
      .getByRole("button", { name: "Upload version", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByLabel("Choose Skill folder")
      .setInputFiles(folder);
    await expect(page.getByRole("dialog").getByRole("status")).toContainText(
      "Analyzing script effects",
    );
    const manualEffects = page
      .getByRole("dialog")
      .getByLabel("Script side effects scripts/run.sh");
    await manualEffects.click();
    await page
      .locator(".ant-select-dropdown:visible")
      .getByText("None", { exact: true })
      .click();
    await manualEffects.press("Escape");
    await expect(page.getByRole("dialog")).toContainText(
      "The script calls curl and writes result.txt.",
    );
    const manualField = page
      .getByRole("dialog")
      .locator("label.field")
      .filter({ hasText: "scripts/run.sh" });
    await expect(manualField).toContainText("None");
    await expect(manualField.locator(".ant-select-selection-item")).toHaveCount(
      1,
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close", exact: true })
      .last()
      .click();
  } finally {
    await provider.close();
    await fs.rm(folder, { recursive: true, force: true });
  }
});
