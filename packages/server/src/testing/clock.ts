import type { Clock } from "../clock.js";

export interface TestClock extends Clock {
  advance(milliseconds: number): void;
}

/** A clock that only moves when a test moves it. */
export function createFixedClock(at: string): TestClock {
  let current = new Date(at);
  return {
    now: () => new Date(current),
    advance: (milliseconds) => {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}
