import { isDeepStrictEqual as equal } from "node:util";
import type { FactoryPlan } from "../types.js";

export type PlanConflictChoice = "current" | "draft" | { text: string };
export interface PlanConflict {
  path: string;
  base?: unknown;
  current?: unknown;
  draft?: unknown;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function indexed(items: unknown[]) {
  const byId = new Map<string, unknown>();
  for (const item of items) {
    if (!record(item) || typeof item.id !== "string" || byId.has(item.id))
      return null;
    byId.set(item.id, item);
  }
  return byId;
}

function segment(value: string) {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function orderOfItems(base: string[], current: string[], draft: string[]) {
  const currentIds = new Set(current);
  const draftIds = new Set(draft);
  if (equal(current, draft)) return current;
  if (equal(draft, base) && draft.every((id) => currentIds.has(id)))
    return current;
  if (equal(current, base) && current.every((id) => draftIds.has(id)))
    return draft;
  const anchors = current.filter((id) => draftIds.has(id));
  if (
    !equal(
      anchors,
      draft.filter((id) => currentIds.has(id)),
    )
  )
    return null;
  const order: string[] = [];
  let currentStart = 0;
  let draftStart = 0;
  for (const anchor of [...anchors, undefined]) {
    const currentEnd =
      anchor === undefined
        ? current.length
        : current.indexOf(anchor, currentStart);
    const draftEnd =
      anchor === undefined ? draft.length : draft.indexOf(anchor, draftStart);
    const left = current.slice(currentStart, currentEnd);
    const right = draft.slice(draftStart, draftEnd);
    if (left.length && right.length && right[0]! < left[0]!)
      order.push(...right, ...left);
    else order.push(...left, ...right);
    if (anchor !== undefined) order.push(anchor);
    currentStart = currentEnd + 1;
    draftStart = draftEnd + 1;
  }
  return order;
}

export function reconcilePlanDraft(
  base: FactoryPlan,
  current: FactoryPlan,
  draft: FactoryPlan,
  choices: Readonly<Record<string, PlanConflictChoice>> = {},
) {
  const conflicts: PlanConflict[] = [];
  function conflict(
    path: string,
    before: unknown,
    saved: unknown,
    proposed: unknown,
  ) {
    conflicts.push({ path, base: before, current: saved, draft: proposed });
    const choice = choices[path];
    if (
      record(choice) &&
      typeof saved === "string" &&
      typeof proposed === "string"
    )
      return choice.text;
    return choice === "draft" ? proposed : saved;
  }
  function merge(
    path: string,
    before: unknown,
    saved: unknown,
    proposed: unknown,
  ): unknown {
    if (equal(saved, proposed) || equal(before, proposed)) return saved;
    if (equal(before, saved)) return proposed;
    if (record(before) && record(saved) && record(proposed)) {
      const entries: [string, unknown][] = [];
      const keys = new Set([
        ...Object.keys(before),
        ...Object.keys(saved),
        ...Object.keys(proposed),
      ]);
      for (const key of [...keys].sort()) {
        const own = (object: Record<string, unknown>) =>
          Object.hasOwn(object, key) ? object[key] : undefined;
        const value = merge(
          path + "/" + segment(key),
          own(before),
          own(saved),
          own(proposed),
        );
        if (value !== undefined) entries.push([key, value]);
      }
      return Object.fromEntries(entries);
    }
    if (
      Array.isArray(before) &&
      Array.isArray(saved) &&
      Array.isArray(proposed)
    ) {
      const baseItems = indexed(before);
      const currentItems = indexed(saved);
      const draftItems = indexed(proposed);
      if (baseItems && currentItems && draftItems) {
        const values = new Map<string, unknown>();
        const possibleIds = new Set<string>();
        const ids = new Set([
          ...baseItems.keys(),
          ...currentItems.keys(),
          ...draftItems.keys(),
        ]);
        for (const id of [...ids].sort()) {
          const original = baseItems.get(id),
            currentItem = currentItems.get(id),
            draftItem = draftItems.get(id);
          const value = merge(
            path + "/@" + segment(id),
            original,
            currentItem,
            draftItem,
          );
          if (value !== undefined) values.set(id, value);
          if (
            value !== undefined ||
            (currentItem === undefined &&
              draftItem !== undefined &&
              !equal(original, draftItem)) ||
            (draftItem === undefined &&
              currentItem !== undefined &&
              !equal(original, currentItem))
          )
            possibleIds.add(id);
        }
        const retained = (items: Map<string, unknown>) =>
          [...items.keys()].filter((id) => possibleIds.has(id));
        const baseOrder = retained(baseItems);
        const currentOrder = retained(currentItems);
        const draftOrder = retained(draftItems);
        const order =
          orderOfItems(baseOrder, currentOrder, draftOrder) ??
          (conflict(
            path + "/$order",
            baseOrder,
            [...new Set([...currentOrder, ...draftOrder])],
            [...new Set([...draftOrder, ...currentOrder])],
          ) as string[]);
        return order.filter((id) => values.has(id)).map((id) => values.get(id));
      }
    }
    return conflict(path, before, saved, proposed);
  }
  const plan = structuredClone(merge("", base, current, draft)) as FactoryPlan;
  return { plan, conflicts };
}
