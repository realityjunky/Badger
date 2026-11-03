import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const skillText =
  "---\nname: documentation-sample\ndescription: Synthetic documentation example\n---\n\nUse synthetic examples only.\n";
const scriptText =
  'from pathlib import Path\nPath("synthetic-report.txt").write_text("synthetic")\n';
// A stored zip of the same two synthetic files used in the folder journey.
const skillZip =
  "UEsDBBQAAAAAAAAAIVwx/DPzbgAAAG4AAAAIAAAAU0tJTEwubWQtLS0KbmFtZTogZG9jdW1lbnRhdGlvbi1zYW1wbGUKZGVzY3JpcHRpb246IFN5bnRoZXRpYyBkb2N1bWVudGF0aW9uIGV4YW1wbGUKLS0tCgpVc2Ugc3ludGhldGljIGV4YW1wbGVzIG9ubHkuClBLAwQUAAAAAAAAACFcJv0ZQk4AAABOAAAAEQAAAHNjcmlwdHMvcmVwb3J0LnB5ZnJvbSBwYXRobGliIGltcG9ydCBQYXRoClBhdGgoInN5bnRoZXRpYy1yZXBvcnQudHh0Iikud3JpdGVfdGV4dCgic3ludGhldGljIikKUEsBAhQDFAAAAAAAAAAhXDH8M/NuAAAAbgAAAAgAAAAAAAAAAAAAAIABAAAAAFNLSUxMLm1kUEsBAhQDFAAAAAAAAAAhXCb9GUJOAAAATgAAABEAAAAAAAAAAAAAAIABlAAAAHNjcmlwdHMvcmVwb3J0LnB5UEsFBgAAAAACAAIAdQAAABEBAAAAAA==";

/** Create synthetic source records through the signed-in dashboard's HTTP seam. */
async function createSkill(page: Page) {
  return page.evaluate(async () => {
    async function post(resource: string, body: unknown) {
      const response = await fetch(`/api/v1${resource}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok)
        throw new Error(
          `${resource}: ${response.status} ${await response.text()}`,
        );
      return response.json();
    }
    const name = `documentation-${Date.now()}`;
    const { group } = await post("/groups", { name });
    const { skill } = await post("/skills", {
      groupId: group.id,
      name: "documentation-sample",
    });
    return { skillId: skill.id as string, groupId: group.id as string };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/my-work");
  await page.getByTestId("language-switch").click();
  await page.getByRole("menuitem", { name: "English", exact: true }).click();
});

test("Documentation is in the sidebar, opens the current section, and links to every guide", async ({
  page,
}) => {
  const rail = page.getByTestId("navigation-rail");
  const documentation = rail.getByRole("button", {
    name: "Documentation",
    exact: true,
  });
  await expect(documentation).toBeVisible();
  await expect(
    page.getByTestId("top-bar").getByRole("button", {
      name: "Documentation",
      exact: true,
    }),
  ).toHaveCount(0);
  await rail.getByRole("link", { name: "Personal settings" }).focus();
  await page.keyboard.press("Tab");
  await expect(documentation).toBeFocused();
  await page.keyboard.press("Enter");

  const guide = page.getByRole("dialog", {
    name: "Documentation",
    exact: true,
  });
  await expect(
    guide.getByRole("heading", { name: "My work", exact: true }),
  ).toBeVisible();
  const sections = guide.getByRole("navigation", { name: "Guide sections" });
  for (const name of [
    "My work",
    "Workflows",
    "Questionnaire",
    "Skills",
    "Runs",
    "Evaluations",
    "Activity",
    "Administration",
    "Personal settings",
  ]) {
    await sections.getByRole("link", { name, exact: true }).click();
    await expect(
      guide.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    await expect(
      guide.getByRole("heading", { name: "Who can act", exact: true }),
    ).toBeVisible();
    await expect(
      guide.getByRole("heading", { name: "Next step", exact: true }),
    ).toBeVisible();
  }
  await expect(page).toHaveURL(/\/my-work\?help=settings$/);
  await page.keyboard.press("Escape");
  await expect(guide).toBeHidden();
  await expect(documentation).toBeFocused();
  await expect(page).toHaveURL(/\/my-work$/);

  await page.goto("/skills?help=script-side-effects");
  await expect(
    guide.getByRole("heading", { name: "Script side effects", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    guide.getByRole("heading", { name: "Script side effects", exact: true }),
  ).toBeVisible();
  await guide
    .getByRole("button", { name: "Return to dashboard", exact: true })
    .click();
  await documentation.click();
  await expect(
    guide.getByRole("heading", { name: "Skills", exact: true }),
  ).toBeVisible();
});

for (const source of ["folder", "zip"] as const) {
  test(`side-effect help preserves an in-progress ${source} upload and its declarations`, async ({
    page,
  }, testInfo) => {
    const { skillId, groupId } = await createSkill(page);
    const original = `/skills/${skillId}?group=${groupId}#inventory`;
    await page.goto(original);
    await page
      .getByRole("button", { name: "Upload version", exact: true })
      .click();
    const upload = page.getByRole("dialog", { name: /^Upload version/ });
    if (source === "folder") {
      const folder = testInfo.outputPath("documentation-sample");
      await mkdir(path.join(folder, "scripts"), { recursive: true });
      await writeFile(path.join(folder, "SKILL.md"), skillText);
      await writeFile(path.join(folder, "scripts/report.py"), scriptText);
      await upload
        .getByLabel("Choose Skill folder", { exact: true })
        .setInputFiles(folder);
    } else {
      await upload.getByLabel("Choose zip", { exact: true }).setInputFiles({
        name: "documentation-skill.zip",
        mimeType: "application/zip",
        buffer: Buffer.from(skillZip, "base64"),
      });
    }
    await expect(upload).toContainText("2 files in the source inventory");
    const hash = await upload.locator(".skills-hash").first().innerText();
    const declaration = upload.getByRole("combobox", {
      name: "Script side effects scripts/report.py",
      exact: true,
    });
    await declaration.click();
    await page.getByText("Local writes", { exact: true }).click();
    await declaration.press("Escape");
    const help = upload.getByRole("link", {
      name: "Understand script side-effect declarations",
      exact: true,
    });
    await expect(help).toBeVisible();
    await help.focus();
    await page.keyboard.press("Enter");
    const guide = page.getByRole("dialog", {
      name: "Documentation",
      exact: true,
    });
    await expect(
      guide.getByRole("heading", { name: "Script side effects", exact: true }),
    ).toBeFocused();
    await expect(page).toHaveURL(
      new RegExp(`help=script-side-effects#inventory$`),
    );
    for (const [effect, example] of [
      ["none", "stdout/stderr"],
      ["local-writes", "appending a log"],
      ["network", "remote services"],
      ["scheduler-submission", "qsub"],
      ["installs", "pip install"],
    ]) {
      const definition = guide
        .getByRole("definition")
        .filter({ hasText: example });
      await definition.scrollIntoViewIfNeeded();
      await expect(definition).toBeInViewport();
      await expect(
        guide.getByRole("term").filter({ hasText: new RegExp(` ${effect}$`) }),
      ).toBeVisible();
    }
    await expect(guide).toContainText("none is exclusive");
    await expect(guide).toContainText("supported optional execution modes");
    await expect(guide).toContainText(
      "Uploading, importing, and previewing never execute uploaded scripts",
    );
    await page.keyboard.press("Escape");
    await expect(guide).toBeHidden();
    await expect(help).toBeFocused();
    await expect(page).toHaveURL(new URL(original, page.url()).href);
    await expect(upload.locator(".skills-hash").first()).toHaveText(hash);
    await expect(
      upload.getByText("Local writes", { exact: true }),
    ).toBeVisible();
    const input = upload.getByLabel(
      source === "folder" ? "Choose Skill folder" : "Choose zip",
      { exact: true },
    );
    expect(
      await input.evaluate(
        (element: HTMLInputElement) => element.files?.length,
      ),
    ).toBe(source === "folder" ? 2 : 1);
    await expect(
      upload.getByRole("button", {
        name: /Confirm immutable upload$/,
      }),
    ).toBeEnabled();
    await help.click();
    await guide
      .getByRole("navigation", { name: "Guide sections" })
      .getByRole("link", { name: "Workflows", exact: true })
      .click();
    await expect(guide).toContainText("Source study");
    await guide
      .getByRole("button", { name: "Return to dashboard", exact: true })
      .click();
    await expect(upload.locator(".skills-hash").first()).toHaveText(hash);
    await expect(
      upload.getByText("Local writes", { exact: true }),
    ).toBeVisible();
  });
}

test("a Skill without inventoried scripts can return from help without artificial declarations", async ({
  page,
}, testInfo) => {
  const { skillId } = await createSkill(page);
  await page.goto(`/skills/${skillId}`);
  await page
    .getByRole("button", { name: "Upload version", exact: true })
    .click();
  const upload = page.getByRole("dialog", { name: /^Upload version/ });
  const folder = testInfo.outputPath("documentation-sample");
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "SKILL.md"), skillText);
  await upload
    .getByLabel("Choose Skill folder", { exact: true })
    .setInputFiles(folder);
  await expect(upload).toContainText("No side-effect declarations are needed.");
  await expect(upload.getByRole("combobox")).toHaveCount(0);
  await upload
    .getByRole("link", {
      name: "Understand script side-effect declarations",
      exact: true,
    })
    .click();
  const guide = page.getByRole("dialog", {
    name: "Documentation",
    exact: true,
  });
  await expect(guide).toContainText("without adding artificial declarations");
  await guide
    .getByRole("button", { name: "Close documentation", exact: true })
    .click();
  await expect(
    upload.getByRole("button", {
      name: /Confirm immutable upload$/,
    }),
  ).toBeEnabled();
});

for (const theme of ["light", "dark"] as const) {
  test(`documentation is readable in ${theme}, with large text, translated controls, and a narrow demo layout`, async ({
    page,
  }, testInfo) => {
    const unexpectedRequests: string[] = [];
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (
        pathname.includes("/api/") &&
        (!pathname.startsWith("/badger/demo/api/") ||
          request.method() !== "GET")
      )
        unexpectedRequests.push(`${request.method()} ${pathname}`);
    });
    const demoPrefix =
      process.env["BADGER_DEMO_TEST_PREFIX"] ?? "http://127.0.0.1:4320/badger";
    await page.goto(`${demoPrefix}/demo/settings/appearance`);
    await page
      .getByText(theme === "light" ? "Light" : "Dark", { exact: true })
      .click();
    for (let step = 0; step < 5; step += 1)
      await page
        .getByRole("button", { name: "Larger text", exact: true })
        .click();
    await expect(page.getByTestId("font-scale-value")).toHaveText("150%");
    if (theme === "dark") {
      await page.getByTestId("language-switch").click();
      await page.getByRole("menuitem", { name: "中文", exact: true }).click();
    }
    const chinese = theme === "dark";
    const documentation = page.getByRole("button", {
      name: chinese ? "使用文档" : "Documentation",
      exact: true,
    });
    await documentation.hover();
    await expect(page.getByRole("tooltip")).toHaveText(
      chinese ? "打开当前页面的使用指南" : "Open the guide for this section",
    );
    await documentation.click();
    const guide = page.getByRole("dialog", {
      name: chinese ? "使用文档" : "Documentation",
      exact: true,
    });
    await expect(
      guide.getByRole("heading", {
        name: chinese ? "个人设置" : "Personal settings",
        exact: true,
      }),
    ).toBeVisible();
    await guide
      .getByRole("navigation", {
        name: chinese ? "指南章节" : "Guide sections",
      })
      .getByRole("link", { name: chinese ? "Skill 库" : "Skills", exact: true })
      .click();
    await expect(guide).toContainText(
      chinese
        ? "上传、导入和预览绝不执行上传的脚本"
        : "Uploading, importing, and previewing never execute uploaded scripts",
    );
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page).toHaveURL(
      /\/badger\/demo\/settings\/appearance\?help=skills$/,
    );
    await testInfo.attach(`documentation-${theme}-large-text`, {
      body: await guide.screenshot(),
      contentType: "image/png",
    });
    await guide
      .getByRole("button", {
        name: chinese ? "关闭使用文档" : "Close documentation",
        exact: true,
      })
      .click();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByTestId("rail-open").click();
    await documentation.scrollIntoViewIfNeeded();
    await expect(documentation).toBeInViewport();
    await documentation.focus();
    await page.keyboard.press("Enter");
    await guide
      .getByRole("navigation", {
        name: chinese ? "指南章节" : "Guide sections",
      })
      .getByRole("link", { name: chinese ? "Skill 库" : "Skills", exact: true })
      .click();
    await expect(
      guide.getByRole("heading", {
        name: chinese ? "Skill 库" : "Skills",
        exact: true,
      }),
    ).toBeInViewport();
    const bounds = await guide.boundingBox();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(375);
    expect(
      await guide.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await testInfo.attach(`documentation-${theme}-narrow`, {
      body: await guide.screenshot(),
      contentType: "image/png",
    });
    await page.keyboard.press("Escape");
    await expect(guide).toBeHidden();
    await expect(documentation).toBeFocused();
    expect(unexpectedRequests).toEqual([]);
  });
}
