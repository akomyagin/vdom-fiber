/**
 * Stage 6 (skeleton): minimal hooks.
 *
 * `useState` needs the scheduler (Stage 5) to exist: reading state returns the
 * current value; the setter enqueues an update and asks the scheduler to
 * re-render the owning component. Hooks are matched to their fiber by call
 * order, exactly like React — hence the "rules of hooks".
 *
 * TODO(Этап 6): implement the per-fiber hook list, `useState` with a queued
 * dispatch, and wiring into the scheduler's re-render.
 */
export function useState<S>(
  _initial: S,
): [S, (action: S | ((prev: S) => S)) => void] {
  // TODO(Этап 6): implement
  throw new Error("useState is not implemented yet (Этап 6)");
}
