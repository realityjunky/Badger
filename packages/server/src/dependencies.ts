import type { Clock } from "./clock.js";
import type { IdSource } from "./ids.js";

/** The injected sources of time and identifiers. */
export interface ServiceDependencies {
  clock: Clock;
  ids: IdSource;
}
