import type { Fiber } from "./fiber.js";

/**
 * Stage 6 + Post-MVP §1: minimal hooks — `useState` and `useEffect`.
 *
 * Hooks are matched to their fiber by CALL ORDER: the Nth hook call in a
 * component body reads/writes the Nth slot of that fiber's hook list — hence
 * the "rules of hooks" (no conditional hook calls; not enforced at runtime in
 * the MVP scope, only documented). State and effect hooks share ONE list (and
 * one `hookIndex` cursor), discriminated by `kind`: two parallel lists with two
 * counters would desync as soon as `useState`/`useEffect` calls interleave,
 * breaking the "Nth call ↔ Nth slot" invariant.
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

/** Discriminator so one hook list can mix state and effect slots by call order. */
export type HookKind = "state" | "effect";

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
export interface StateHook {
  kind: "state";
  /** Committed state value; written only by {@link commitFiberHooks}. */
  state: unknown;
  /**
   * Updates queued by `setState`; drained — by the exact count the committed
   * render folded in — only by {@link commitFiberHooks}.
   */
  queue: unknown[];
}

/** A cleanup returned by an effect callback, or nothing. */
export type EffectCleanup = (() => void) | void;
/** The user's effect body: runs after commit, may return a cleanup. */
export type EffectCallback = () => EffectCleanup;

/**
 * One `useEffect` cell. DURABLE across renders (carried over from
 * `alternate.hooks` by index, same object identity as {@link StateHook}). Write
 * discipline mirrors StateHook: the RENDER phase NEVER mutates these fields —
 * it only derives an {@link EffectHookSnapshot} (reading `deps` for the
 * comparison). Both `deps` and `cleanup` are written EXCLUSIVELY by the
 * commit/passive phase ({@link commitFiberHooks} writes `deps`,
 * {@link runPassiveEffects} writes `cleanup`), so a preempted render can
 * neither run an effect nor corrupt the durable prevDeps/cleanup.
 */
export interface EffectHook {
  kind: "effect";
  /** Deps of the LAST COMMITTED run; `undefined` means "no deps array". */
  deps: unknown[] | undefined;
  /** Cleanup returned by the last committed run of `create`; null if none. */
  cleanup: (() => void) | null;
}

export type Hook = StateHook | EffectHook;

/**
 * Render-phase result for one state slot: the state this WIP render derived and
 * how many queue entries it folded in. Lives on the WIP fiber, so discarding
 * the WIP discards the snapshot with it; if the render commits,
 * {@link commitFiberHooks} folds it into the durable {@link StateHook}.
 * `applied` matters because `setState` may enqueue more updates between render
 * and commit: those must stay queued for the next render — neither lost nor
 * applied twice.
 */
export interface StateHookSnapshot {
  kind: "state";
  state: unknown;
  applied: number;
}

/**
 * Render-phase decision for one effect slot. `shouldRun` is computed IN RENDER
 * by comparing this render's `deps` against the durable {@link EffectHook}'s
 * committed `deps`, but it is only ACTED ON at commit — the render never runs
 * the effect nor touches the durable cell. `create` is captured this render
 * (closes over this render's props/state). If the render is discarded, the
 * snapshot dies with the WIP.
 */
export interface EffectHookSnapshot {
  kind: "effect";
  create: EffectCallback;
  deps: unknown[] | undefined;
  shouldRun: boolean;
}

export type HookSnapshot = StateHookSnapshot | EffectHookSnapshot;

/**
 * A unit of passive work gathered at commit time, run strictly after commit
 * (from the scheduler's `commitWip`, AFTER the `current*` promotion — running
 * inside `commitRoot` would break re-entrancy when an effect calls `setState`).
 */
export interface PendingEffect {
  /** Cleanup of the PREVIOUS committed run (or a DELETION's); null if none. */
  cleanup: (() => void) | null;
  /** The new effect body to run; null for a DELETION (cleanup-only) entry. */
  create: EffectCallback | null;
  /** Durable hook to write the new cleanup back into; null for DELETION-only. */
  hook: EffectHook | null;
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
  // closures from old renders keep working (see StateHook docs). A kind
  // mismatch (rules-of-hooks violation) falls back to a fresh cell.
  const previous = fiber.alternate?.hooks?.[index];
  const hook: StateHook =
    previous !== undefined && previous.kind === "state"
      ? previous
      : { kind: "state", state: initial, queue: [] };

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
  fiber.hookSnapshots![index] = { kind: "state", state, applied };

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
 * `useEffect(create, deps?)`: register a passive effect for this fiber slot.
 *
 * Render-phase contract (same write discipline as `useState`): this call NEVER
 * runs `create` or a cleanup and NEVER writes the durable
 * {@link EffectHook.deps}/{@link EffectHook.cleanup} — the durable cell is
 * shared by reference with the committed current tree, so a later-discarded
 * render must leave it untouched. It only decides `shouldRun` (comparing this
 * render's deps to the last COMMITTED deps) and snapshots that decision plus
 * `create` on the WIP fiber. The commit phase ({@link commitFiberHooks})
 * gathers runnable effects; the passive phase ({@link runPassiveEffects},
 * called by the scheduler strictly after the `current*` promotion) runs them:
 * cleanup of the previous run first, then the new `create`.
 */
export function useEffect(create: EffectCallback, deps?: unknown[]): void {
  const fiber = currentFiber;
  if (fiber === null) {
    throw new Error(
      "useEffect called outside of a function component render (rules of hooks)",
    );
  }
  const index = hookIndex++;

  // Reuse the durable EffectHook from the previous committed render (identity
  // matters: the committed cleanup lives on it), or create a fresh cell on
  // first render — its `deps: undefined` makes depsChanged() return true, so
  // the first commit always runs the effect.
  const previous = fiber.alternate?.hooks?.[index];
  const hook: EffectHook =
    previous !== undefined && previous.kind === "effect"
      ? previous
      : { kind: "effect", deps: undefined, cleanup: null };

  const shouldRun = depsChanged(hook.deps, deps);

  fiber.hooks![index] = hook;
  fiber.hookSnapshots![index] = { kind: "effect", create, deps, shouldRun };
}

/**
 * Whether an effect must re-run, comparing this render's deps to the last
 * committed run's deps. Semantics match React:
 *  - `next === undefined` (no deps array): ALWAYS run.
 *  - `prev === undefined` (first commit): ALWAYS run.
 *  - different length: run (best-effort; a length change means deps changed —
 *    not an error, consistent with the project's "rules of hooks are
 *    documented, not enforced" stance).
 *  - otherwise: run iff any element differs by `Object.is` (NaN/-0 safe).
 */
function depsChanged(
  prev: unknown[] | undefined,
  next: unknown[] | undefined,
): boolean {
  if (next === undefined) return true;
  if (prev === undefined) return true;
  if (prev.length !== next.length) return true;
  for (let i = 0; i < next.length; i++) {
    if (!Object.is(prev[i], next[i])) return true;
  }
  return false;
}

/**
 * Commit-phase finalisation for one committed component fiber, called from
 * `commitRoot`'s dedicated tree walk for EVERY component fiber (PLACEMENT and
 * UPDATE alike — component fibers are DOM-transparent and never pass through
 * `commitFiber`). Folds the render's {@link HookSnapshot}s into the durable
 * Hooks, per slot kind:
 *  - state: the only writer of `StateHook.state` and the only drainer of
 *    `StateHook.queue` (besides `setState`'s enqueue). Exactly `applied` queue
 *    entries are dropped; anything enqueued between render and commit stays.
 *  - effect: writes the durable `EffectHook.deps` and, when the render decided
 *    `shouldRun`, gathers the effect into `pending` (previous cleanup captured
 *    from the durable cell BEFORE the passive phase overwrites it). The effect
 *    itself is NOT run here — ordering and "after commit" are the passive
 *    phase's job ({@link runPassiveEffects}).
 *
 * Runs solely for a tree that actually becomes `current` — so a
 * preempted/discarded render leaves committed hook state untouched.
 */
export function commitFiberHooks(fiber: Fiber, pending: PendingEffect[]): void {
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
    if (hook.kind === "state" && snapshot.kind === "state") {
      hook.state = snapshot.state;
      hook.queue.splice(0, snapshot.applied);
    } else if (hook.kind === "effect" && snapshot.kind === "effect") {
      // Written unconditionally: when !shouldRun the values are equal anyway.
      hook.deps = snapshot.deps;
      if (snapshot.shouldRun) {
        pending.push({ cleanup: hook.cleanup, create: snapshot.create, hook });
      }
    }
  }
  // Hygiene: the fiber is now part of `current`; its snapshots are consumed
  // and must not linger into the next generation.
  fiber.hookSnapshots = undefined;
}

/**
 * Gather cleanup-only entries for one UNMOUNTING component fiber (a fiber
 * inside a DELETION subtree): every effect slot whose last committed run left a
 * cleanup contributes a `{ cleanup, create: null, hook: null }` entry. Safe by
 * construction: a durable `cleanup` exists only if a past commit really ran the
 * effect — preemption of the current render cannot fabricate or corrupt it.
 * Update-path cleanups do NOT go through here (they ride along with the new
 * `create` in {@link commitFiberHooks}).
 */
export function collectFiberCleanups(fiber: Fiber, pending: PendingEffect[]): void {
  for (const hook of fiber.hooks ?? []) {
    if (hook.kind === "effect" && hook.cleanup !== null) {
      pending.push({ cleanup: hook.cleanup, create: null, hook: null });
    }
  }
}

/**
 * The passive phase: run the effects gathered at commit, in queue order
 * (unmount cleanups were pushed first, then mount/update effects in the
 * child-before-parent finalisation order). For each entry: cleanup of the
 * previous run, then the new `create`; the returned cleanup is written into
 * the durable hook — this function is the single writer of
 * {@link EffectHook.cleanup}.
 *
 * Called by the scheduler (`commitWip`) strictly AFTER the `current*`
 * promotion, so a `setState` inside an effect re-enters the scheduler safely
 * and synchronously. Deliberate teaching-scope simplifications (documented
 * tech debt): effects run synchronously in the same tick as the commit (no
 * separate post-paint task like React); cleanup-then-create is interleaved per
 * effect (not React's two passes); a DELETION's cleanup runs AFTER its DOM was
 * physically removed — cleanups must not rely on the removed DOM.
 */
export function runPassiveEffects(pending: PendingEffect[]): void {
  for (const effect of pending) {
    if (effect.cleanup !== null) {
      effect.cleanup();
    }
    if (effect.create !== null) {
      const cleanup = effect.create();
      if (effect.hook !== null) {
        effect.hook.cleanup = typeof cleanup === "function" ? cleanup : null;
      }
    }
  }
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
