import type { Fiber } from "./fiber.js";

/**
 * Stage 6: minimal hooks — `useState` only.
 *
 * Hooks are matched to their fiber by CALL ORDER: the Nth `useState` call in a
 * component body reads/writes the Nth slot of that fiber's hook list — hence
 * the "rules of hooks" (no conditional hook calls; not enforced at runtime in
 * the MVP scope, only documented).
 *
 * This module deliberately owns two pieces of module-level state — the "fiber
 * currently being rendered" pointer and the current hook index. They cannot be
 * passed as parameters: `useState` is called from the body of a *user* function
 * component, and that user code knows nothing about fibers, so the render walk
 * (`fiber.ts`, which stays stateless by its Stage 4 convention) publishes the
 * current fiber here via {@link beginHooks}/{@link finishHooks} instead. This
 * is the same architectural necessity that makes React use a module-level
 * dispatcher. No general multi-hook dispatcher is built — `useState` is enough
 * for the MVP, and the per-fiber hook list does not preclude adding more hooks
 * later.
 *
 * Import graph note: this module imports `fiber.ts` type-only and nothing at
 * value level. The scheduler *registers* its re-render entry point here at load
 * time ({@link __setRerenderScheduler}) instead of being imported, keeping the
 * value-level import graph acyclic: scheduler → fiber → hooks.
 */

/** An update queued by `setState`: a new value or a functional updater. */
type StateAction<S> = S | ((prev: S) => S);

/**
 * One `useState` cell. THE SAME Hook object is reused across renders (carried
 * over from `alternate.hooks` by index), so a `setState` closure captured in
 * any past render always talks to the live cell — no per-generation copying.
 *
 * Write discipline (upholds the Stage 5 invariant "an uncommitted render
 * leaves no trace in the current tree"): the RENDER phase never mutates a Hook
 * — it only derives a {@link HookSnapshot} from `state` + `queue`. Both fields
 * are updated exclusively by the COMMIT phase ({@link commitFiberHooks}),
 * atomically with the DOM effects, i.e. only for a tree that really becomes
 * `current`. A render thrown away by preemption therefore cannot drain or
 * corrupt committed hook state.
 */
export interface Hook {
  /** Committed state value; written only by {@link commitFiberHooks}. */
  state: unknown;
  /**
   * Updates queued by `setState`; drained — by the exact count the committed
   * render folded in — only by {@link commitFiberHooks}.
   */
  queue: unknown[];
}

/**
 * Render-phase result for one hook slot: the state this WIP render derived and
 * how many queue entries it folded in. Lives on the WIP fiber, so discarding
 * the WIP discards the snapshot with it; if the render commits,
 * {@link commitFiberHooks} folds it into the durable {@link Hook}. `applied`
 * matters because `setState` may enqueue more updates between render and
 * commit: those must stay queued for the next render — neither lost nor
 * applied twice.
 */
export interface HookSnapshot {
  state: unknown;
  applied: number;
}

// --- Module-level hook context (see docblock for why it must live here) ------

/** The component fiber whose body is executing right now; null outside render. */
let currentFiber: Fiber | null = null;
/** Index of the next hook call within the current component body. */
let hookIndex = 0;

/**
 * Internal bridge for `fiber.ts`: called right before invoking a function
 * component. Resets the hook cursor and starts a fresh hook list on the WIP
 * fiber (individual Hook objects are still reused from the alternate).
 */
export function beginHooks(fiber: Fiber): void {
  currentFiber = fiber;
  hookIndex = 0;
  fiber.hooks = [];
  fiber.hookSnapshots = [];
}

/** Internal bridge for `fiber.ts`: called right after the component returns. */
export function finishHooks(): void {
  currentFiber = null;
  hookIndex = 0;
}

/**
 * Re-render entry point, injected by `scheduler.ts` at module load. `setState`
 * calls it with the owning container; the scheduler re-schedules that
 * container's current top-level VNode (the single source of truth it already
 * keeps) — hooks never store their own copy of the tree.
 */
let scheduleRerenderImpl: ((container: Element) => void) | null = null;

/** Internal registration hook for the scheduler (not part of the public API). */
export function __setRerenderScheduler(impl: (container: Element) => void): void {
  scheduleRerenderImpl = impl;
}

/**
 * `useState(initial)` → `[state, setState]`.
 *
 * State lives on the owning fiber's hook list and survives re-renders through
 * `alternate.hooks` (the previously committed fiber of the same component).
 * `setState` queues the update on the (persistent) Hook object and schedules a
 * re-render of the whole container tree via the scheduler. Each render of the
 * owner DERIVES the visible state from `state` + the pending queue without
 * mutating either (so functional updaters always see the up-to-date previous
 * state); the queue is actually drained at commit time
 * ({@link commitFiberHooks}), which keeps a preempted/discarded render from
 * touching committed hook state.
 */
export function useState<S>(
  initial: S,
): [S, (action: S | ((prev: S) => S)) => void] {
  const fiber = currentFiber;
  if (fiber === null) {
    throw new Error(
      "useState called outside of a function component render (rules of hooks)",
    );
  }
  const index = hookIndex++;

  // Reuse the previous render's Hook object for this slot, or create the cell
  // on first render. Object identity across renders is what lets `setState`
  // closures from old renders keep working (see Hook docs).
  const previous = fiber.alternate?.hooks?.[index];
  const hook: Hook = previous ?? { state: initial, queue: [] };

  // Derive the up-to-date state WITHOUT touching the Hook: this runs in the
  // render phase, and `hook` is shared by reference with the committed current
  // tree — draining it here would let a later-discarded render corrupt
  // committed state. The component still receives the freshest value below;
  // the durable cell is only updated if/when THIS render commits
  // (see commitFiberHooks). `applied` is snapshotted before the loop so
  // updates enqueued later (between render and commit) are left alone.
  const applied = hook.queue.length;
  let state = hook.state as S;
  for (let i = 0; i < applied; i++) {
    const action = hook.queue[i] as StateAction<S>;
    state = typeof action === "function" ? (action as (prev: S) => S)(state) : action;
  }

  fiber.hooks![index] = hook;
  fiber.hookSnapshots![index] = { state, applied };

  const setState = (action: S | ((prev: S) => S)): void => {
    hook.queue.push(action);
    if (scheduleRerenderImpl === null) {
      throw new Error(
        "setState requires the scheduler: import scheduleWork from the library entry point",
      );
    }
    scheduleRerenderImpl(findContainer(fiber));
  };

  return [state, setState];
}

/**
 * Commit-phase finalisation for one committed component fiber, called from
 * `commitRoot`'s dedicated tree walk for EVERY component fiber (PLACEMENT and
 * UPDATE alike — component fibers are DOM-transparent and never pass through
 * `commitFiber`). Folds the render's {@link HookSnapshot}s into the durable
 * Hooks: this is the only writer of `Hook.state` and the only drainer of
 * `Hook.queue` (besides `setState`'s enqueue), and it runs solely for a tree
 * that actually becomes `current` — so a preempted/discarded render leaves
 * committed hook state untouched. Exactly `applied` queue entries are dropped;
 * anything enqueued between render and commit stays for the next render.
 */
export function commitFiberHooks(fiber: Fiber): void {
  const hooks = fiber.hooks;
  const snapshots = fiber.hookSnapshots;
  if (hooks === undefined || snapshots === undefined) {
    return;
  }
  for (let i = 0; i < hooks.length; i++) {
    const hook = hooks[i];
    const snapshot = snapshots[i];
    if (hook === undefined || snapshot === undefined) {
      continue;
    }
    hook.state = snapshot.state;
    hook.queue.splice(0, snapshot.applied);
  }
  // Hygiene: the fiber is now part of `current`; its snapshots are consumed
  // and must not linger into the next generation.
  fiber.hookSnapshots = undefined;
}

/**
 * Climb from a component fiber to its root fiber; the root's `dom` is the
 * container ({@link createWorkInProgress} puts it there). The captured fiber
 * may be from a past render generation — its parent chain still leads to that
 * generation's root, and the container Element itself is stable across renders.
 */
function findContainer(fiber: Fiber): Element {
  let node: Fiber = fiber;
  while (node.parent !== null) {
    node = node.parent;
  }
  return node.dom as Element;
}
