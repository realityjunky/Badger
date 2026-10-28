import { describe, expect, it } from "vitest";
import {
  catalogs,
  formatMessage,
  message,
  type MessageId,
} from "../src/i18n/catalog.js";

describe("the message catalogs", () => {
  it("keys zh and en by the same message IDs", () => {
    const english = Object.keys(catalogs.en).sort();
    const chinese = Object.keys(catalogs.zh).sort();

    expect(chinese).toEqual(english);
    expect(english.length).toBeGreaterThan(30);
  });

  it("leaves no message empty", () => {
    for (const locale of ["en", "zh"] as const) {
      for (const [id, text] of Object.entries(catalogs[locale])) {
        expect(text.trim(), `${locale} ${id}`).not.toBe("");
      }
    }
  });

  it("has real Chinese, not copied English, for navigation", () => {
    expect(message("zh", "nav.myWork")).toBe("我的工作");
    expect(message("en", "nav.myWork")).toBe("My work");
    expect(message("zh", "page.myWork.title")).not.toBe(
      message("en", "page.myWork.title"),
    );
  });

  it("fills counts into a message", () => {
    expect(
      formatMessage("en", "questionnaire.waitingCount", { count: 3 }),
    ).toBe("3 waiting");
    expect(
      formatMessage("zh", "questionnaire.waitingCount", { count: 3 }),
    ).toBe("3 项待处理");
  });

  it("leaves an unknown placeholder visible instead of dropping the message", () => {
    expect(formatMessage("en", "questionnaire.waitingCount", {})).toBe(
      "{count} waiting",
    );
  });

  it("types every route title as a catalog message", () => {
    const routeTitles: MessageId[] = [
      "page.myWork.title",
      "page.workflows.title",
      "page.questionnaire.title",
      "page.skills.title",
      "page.runs.title",
      "page.evaluations.title",
      "page.activity.title",
      "page.admin.title",
      "page.settings.title",
      "page.notFound.title",
    ];
    for (const id of routeTitles) {
      expect(catalogs.en[id]).toEqual(expect.any(String));
      expect(catalogs.zh[id]).toEqual(expect.any(String));
    }
  });
});
