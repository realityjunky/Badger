import { expect, it } from "vitest";
import { scopeDestination, scopeSelection } from "../src/shell/scope.js";

it("restores workflow and version context from paths and query strings", () => {
  expect(
    scopeSelection(
      "/workflows/workflow%201/versions/version%202",
      "?group=group-1",
    ),
  ).toEqual({ group: "group-1", workflow: "workflow 1", version: "version 2" });
  expect(
    scopeSelection("/questionnaire", "?workflow=workflow-1&version=version-1"),
  ).toEqual({ group: undefined, workflow: "workflow-1", version: "version-1" });
  expect(scopeSelection("/workflows/%", "").workflow).toBeUndefined();
});

it("clears descendant selection when moving groups and preserves compatible pages", () => {
  expect(
    scopeDestination("/workflows/old/versions/old-version", {
      group: "new group",
    }),
  ).toBe("/workflows?group=new%20group");
  expect(
    scopeDestination("/questionnaire/questions/old", {
      workflow: "workflow-1",
      version: "version-2",
    }),
  ).toBe("/questionnaire?workflow=workflow-1&version=version-2");
  expect(
    scopeDestination("/evaluations", {
      workflow: "workflow-1",
      version: "version-2",
    }),
  ).toBe("/evaluations?workflow=workflow-1&version=version-2");
  expect(
    scopeDestination("/runs/old", {
      workflow: "workflow-1",
      version: "version-2",
    }),
  ).toBe("/runs?workflow=workflow-1");
  expect(scopeDestination("/skills/old", { group: "group-1" })).toBe(
    "/skills?group=group-1",
  );
});
