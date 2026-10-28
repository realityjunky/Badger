import type { IdSource } from "../ids.js";

export interface SequentialIdSource extends IdSource {
  count(): number;
}

/** Fixed identifiers: id-0001, id-0002, and so on. */
export function createSequentialIds(prefix = "id"): SequentialIdSource {
  let issued = 0;
  return {
    next: () => {
      issued += 1;
      return `${prefix}-${String(issued).padStart(4, "0")}`;
    },
    count: () => issued,
  };
}
