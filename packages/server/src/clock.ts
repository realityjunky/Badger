export interface Clock {
  now(): Date;
  /**
   * Runs `run` once `milliseconds` have passed on this clock and returns a
   * function that cancels it. A clock without its own timers uses the
   * system's (`setClockTimer`).
   */
  setTimer?(milliseconds: number, run: () => void): () => void;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A timer on `clock`; a system timer never keeps the process alive. */
export function setClockTimer(
  clock: Clock,
  milliseconds: number,
  run: () => void,
): () => void {
  if (clock.setTimer !== undefined) return clock.setTimer(milliseconds, run);
  const timer = setTimeout(run, milliseconds);
  timer.unref();
  return () => clearTimeout(timer);
}
