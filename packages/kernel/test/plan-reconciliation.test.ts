import { describe, expect, it } from "vitest";
import {
  reconcilePlanDraft,
  type FactoryPlan,
  type PlanConflictChoice,
} from "../src/index.js";

function merge(
  base: unknown,
  current: unknown,
  draft: unknown,
  choices?: Record<string, PlanConflictChoice>,
) {
  const wrap = (nodes: unknown) =>
    ({ workflow: { customNodes: nodes } }) as FactoryPlan;
  return reconcilePlanDraft(wrap(base), wrap(current), wrap(draft), choices);
}
const entry = (id: string, label = id) => ({ id, label });

describe("lane Plan reconciliation", () => {
  it("retains independent edits and deduplicates shared additions in either acceptance order", () => {
    const base = [entry("prepare")];
    const current = [entry("a"), entry("prepare", "revised"), entry("shared")];
    const draft = [
      entry("b"),
      entry("prepare"),
      entry("shared"),
      entry("last"),
    ];
    const result = merge(base, current, draft);
    expect(result.conflicts).toEqual([]);
    expect(result.plan.workflow.customNodes).toEqual([
      entry("a"),
      entry("b"),
      entry("prepare", "revised"),
      entry("shared"),
      entry("last"),
    ]);
    expect(merge(base, draft, current)).toEqual(result);
    expect(merge(base, result.plan.workflow.customNodes, draft)).toEqual(
      result,
    );
  });

  it("distinguishes deletion from null and resolves competing values including edited text", () => {
    const base = [entry("source/one"), { id: "other", value: null }];
    const current = [{ id: "other" }];
    const draft = [entry("source/one", "new"), { id: "other", value: "new" }];
    const result = merge(base, current, draft);
    const deleted = "/workflow/customNodes/@source~1one";
    const nullable = "/workflow/customNodes/@other/value";
    expect(result.conflicts.map(({ path }) => path)).toEqual([
      nullable,
      deleted,
    ]);
    expect(result.conflicts[0]).toMatchObject({
      base: null,
      current: undefined,
      draft: "new",
    });
    const resolved = merge(base, current, draft, {
      [deleted]: "draft",
      [nullable]: "current",
    });
    expect(resolved.plan.workflow.customNodes).toEqual([
      entry("source/one", "new"),
      { id: "other" },
    ]);
    const path = "/workflow/customNodes/@review/label";
    expect(
      merge(
        [entry("review")],
        [entry("review", "first")],
        [entry("review", "second")],
        { [path]: { text: "combined" } },
      ).plan.workflow.customNodes,
    ).toEqual([entry("review", "combined")]);
  });

  it("retains both sides' item edits while resolving incompatible ordering", () => {
    const base = [entry("a"), entry("b"), entry("c")];
    const current = [entry("b", "edited b"), entry("a"), entry("c")];
    const draft = [entry("a", "edited a"), entry("c"), entry("b")];
    const path = "/workflow/customNodes/$order";
    expect(
      merge(base, current, draft).conflicts.map((item) => item.path),
    ).toEqual([path]);
    expect(
      merge(base, current, draft, { [path]: "draft" }).plan.workflow
        .customNodes,
    ).toEqual([entry("a", "edited a"), entry("c"), entry("b", "edited b")]);
  });

  it("asks for a choice when concurrent changes affect a list without unique identifiers", () => {
    const result = merge(
      [{ id: "a", operations: ["one"] }],
      [{ id: "a", operations: ["two"] }],
      [{ id: "a", operations: ["three"] }],
    );
    expect(result.conflicts).toEqual([
      {
        path: "/workflow/customNodes/@a/operations",
        base: ["one"],
        current: ["two"],
        draft: ["three"],
      },
    ]);
  });
});
