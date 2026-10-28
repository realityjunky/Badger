import { describe, expect, it } from "vitest";
import {
  navigationSections,
  pageTitleKey,
  routes,
} from "../src/app/navigation.js";

describe("the dashboard's addresses", () => {
  it("gives every page a unique URL", () => {
    const patterns = routes.map((route) => route.pattern);
    expect(new Set(patterns).size).toBe(patterns.length);
    for (const route of [
      "/my-work",
      "/workflows",
      "/questionnaire",
      "/skills",
      "/runs",
      "/evaluations",
      "/activity",
      "/admin",
      "/settings",
    ]) {
      expect(patterns).toContain(route);
    }
  });

  it("names each route's title in the catalog", () => {
    for (const route of routes) {
      expect(route.title).toMatch(/^page\..+\.title$/u);
    }
  });

  it("lists My work first in the rail", () => {
    const work = navigationSections[0];
    expect(work?.items[0]).toMatchObject({
      path: "/my-work",
      title: "nav.myWork",
    });
  });

  it("groups the rail into work, operations, administration, and system", () => {
    expect(navigationSections.map((section) => section.title)).toEqual([
      "nav.section.work",
      "nav.section.operations",
      "nav.section.administration",
      "nav.section.system",
    ]);
  });

  it("matches a deep link to the page it belongs to", () => {
    expect(pageTitleKey("/my-work")).toBe("page.myWork.title");
    expect(pageTitleKey("/workflows/w-1/versions/v-1")).toBe(
      "page.workflows.title",
    );
    expect(pageTitleKey("/questionnaire/questions/q-9")).toBe(
      "page.questionnaire.title",
    );
    expect(pageTitleKey("/settings/appearance")).toBe("page.settings.title");
    expect(pageTitleKey("/not-a-page")).toBe("page.notFound.title");
  });
});
