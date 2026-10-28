import type { IdSource } from "../ids.js";

/** Fixed identifiers: id-0001, id-0002, and so on. */
export function createSequentialIds(prefix = "id"): IdSource {
  let issued = 0;
  return {
    next: () => {
      issued += 1;
      return `${prefix}-${String(issued).padStart(4, "0")}`;
    },
  };
}
