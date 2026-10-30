import type { Clock } from "../clock.js";

export interface TestClock extends Clock {
  advance(milliseconds: number): void;
  setTimer(milliseconds: number, run: () => void): () => void;
}

/**
 * A clock that only moves when a test moves it. Its timers run, in order,
 * as `advance` passes their time.
 */
export function createFixedClock(at: string): TestClock {
  let current = new Date(at).getTime();
  const timers: { due: number; run: () => void }[] = [];
  return {
    now: () => new Date(current),
    advance: (milliseconds) => {
      const target = current + milliseconds;
      for (;;) {
        const next = timers
          .filter((timer) => timer.due <= target)
          .sort((a, b) => a.due - b.due)[0];
        if (next === undefined) break;
        timers.splice(timers.indexOf(next), 1);
        // A timer set while this one runs counts from this one's time.
        current = Math.max(current, next.due);
        next.run();
      }
      current = target;
    },
    setTimer: (milliseconds, run) => {
      const timer = { due: current + milliseconds, run };
      timers.push(timer);
      return () => {
        const index = timers.indexOf(timer);
        if (index !== -1) timers.splice(index, 1);
      };
    },
  };
}
