import type { Fiber } from "./fiber.js";

/** Update priorities. Lower number = more urgent (processed first). */
export enum Priority {
  Immediate = 0,
  UserBlocking = 1,
  Normal = 2,
  Idle = 3,
}

/**
 * Stage 5 (skeleton): the interruptible, priority-aware scheduler.
 *
 * Drives the Stage 4 fiber walk in time-sliced chunks: it yields control back
 * to the browser (via a `MessageChannel` / `requestIdleCallback`-style tick)
 * whenever the current time-slice is exhausted, then resumes from the saved
 * work-in-progress fiber. Higher-priority updates (e.g. user input) can preempt
 * a lower-priority render already in flight.
 *
 * TODO(Этап 5): implement the work loop (`shouldYield()` deadline check),
 * MessageChannel-based tick, priority queue, and preemption of in-flight work.
 */
export function scheduleWork(_root: Fiber, _priority: Priority): void {
  // TODO(Этап 5): implement
  throw new Error("scheduleWork is not implemented yet (Этап 5)");
}
