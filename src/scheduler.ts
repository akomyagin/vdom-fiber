import {
  commitRoot,
  createWorkInProgress,
  performUnitOfWork,
  type Fiber,
} from "./fiber.js";
import { __setRerenderScheduler, runPassiveEffects } from "./hooks.js";
import type { VNode } from "./types.js";

/**
 * Stage 5: the interruptible, priority-aware scheduler.
 *
 * Drives the Stage 4 fiber walk in time-sliced chunks. The render phase
 * (`workLoop` cranking {@link performUnitOfWork}) never touches the DOM, so it
 * can be paused whenever the frame budget runs out — control is yielded back to
 * the host via a `MessageChannel`-style tick and resumed from the saved
 * `nextUnitOfWork` pointer — or thrown away entirely when a higher-priority
 * update preempts it. Only the commit phase ({@link commitRoot}) mutates the
 * DOM, and it is synchronous and indivisible: it never checks the deadline.
 *
 * This module is the home of the `current` tree (the last committed one) that
 * Stage 4 deliberately did not keep: `fiber.ts` stays stateless, the scheduler
 * owns the module-level state below. Only one render is ever in flight at a
 * time, regardless of how many containers are targeted across calls — a
 * pending update for a container other than the in-flight one simply waits in
 * `pending` and starts once the current render commits; it is never dropped
 * (preemption only discards the in-flight WIP when the newer update targets
 * the SAME container — see `scheduleWork`).
 *
 * Synchronicity contract: the first `workLoop` pass runs synchronously inside
 * `scheduleWork`, so a render that fits into one frame budget commits before
 * `scheduleWork` returns. Asynchrony only appears when `shouldYield` splits the
 * work across ticks. This keeps short renders trivially observable in tests.
 */

/** Update priorities. Lower number = more urgent (processed first). */
export enum Priority {
  Immediate = 0,
  UserBlocking = 1,
  Normal = 2,
  Idle = 3,
}

/** One queued update: what to render, where, and how urgently. */
interface PendingUpdate {
  container: Element;
  vnode: VNode | null;
  priority: Priority;
}

/**
 * Injectable environment of the scheduler. Everything time- or tick-related
 * goes through this object so tests can drive interruptions deterministically;
 * the production defaults need no injection at all.
 */
interface SchedulerDeps {
  /** The ONLY source of time in the scheduler (deadline computation). */
  now: () => number;
  /** Schedules one asynchronous resumption of the work loop (a "yield"). */
  scheduleTick: (cb: () => void) => void;
  /** How long one uninterrupted render slice may run, in `now()` units. */
  frameBudgetMs: number;
}

/**
 * Production tick: a `MessageChannel` message is a macrotask that fires ahead
 * of timers — the classic scheduler trick (React does the same). A
 * `requestIdleCallback`-based tick would be a reasonable alternative for
 * Idle-priority work, but one tick primitive is enough for the teaching scope.
 */
function defaultScheduleTick(cb: () => void): void {
  if (typeof MessageChannel !== "undefined") {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => cb();
    channel.port2.postMessage(null);
  } else {
    setTimeout(cb, 0);
  }
}

const defaultDeps: SchedulerDeps = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  scheduleTick: defaultScheduleTick,
  frameBudgetMs: 5,
};

let deps: SchedulerDeps = { ...defaultDeps };

// --- Module-level scheduler state ------------------------------------------

/** Queued updates not yet picked up by a render. */
let pending: PendingUpdate[] = [];

// The committed triple: what is REALLY in the DOM right now. Updated atomically
// and strictly after commitRoot — never during the render phase — so a
// preempted/interrupted render can never desync it from the real DOM.
let currentContainer: Element | null = null;
let currentRoot: Fiber | null = null;
let currentVNode: VNode | null = null;

// The in-flight (possibly half-built) render. `nextUnitOfWork` is the single
// source of truth for "is a render in progress": preemption nulls it, and a
// stale tick that observes null simply exits.
let wipRoot: Fiber | null = null;
let wipVNode: VNode | null = null;
let wipContainer: Element | null = null;
let nextUnitOfWork: Fiber | null = null;
/** Priority of the in-flight render; only meaningful while one is in flight. */
let activePriority: Priority = Priority.Normal;
/** Deadline of the current slice; recomputed on every entry into `workLoop`. */
let deadline = 0;

/**
 * Schedule a render of `nextVNode` into `container`. The previous tree is
 * remembered by the scheduler itself (from the last commit), so repeated calls
 * with the same container diff against what is actually in the DOM.
 * `nextVNode === null` unmounts the root, mirroring `reconcile(c, prev, null)`.
 *
 * Preemption model: an update with a STRICTLY higher priority (lower number)
 * than the in-flight render for the SAME container throws the half-built WIP
 * away and restarts with the more urgent tree. The discarded update is NOT
 * re-queued — the fresher, higher-priority state of the container replaces it
 * (React-like "latest state wins"). Updates with equal or lower priority, and
 * ANY update targeting a different container than the in-flight render, wait
 * in the queue and run after the current render commits (highest priority
 * first, FIFO among equals) — a higher-priority update elsewhere never drops
 * work in-flight for this container, it just queues behind it.
 */
export function scheduleWork(
  container: Element,
  nextVNode: VNode | null,
  priority: Priority = Priority.Normal,
): void {
  pending.push({ container, vnode: nextVNode, priority });

  if (nextUnitOfWork !== null) {
    if (container === wipContainer && priority < activePriority) {
      // Preempt: drop the half-built WIP. The render phase never touched the
      // DOM, so this rollback is free and safe — that is the whole point of
      // splitting render from commit. `current*` is left untouched: it still
      // describes the committed DOM and provides the prev tree for the restart.
      // Scoped to the SAME container: an unrelated container's higher-priority
      // update must not discard this one's in-flight (and un-requeued) work.
      nextUnitOfWork = null;
      wipRoot = null;
      wipVNode = null;
      wipContainer = null;
      startNextPendingRender();
      workLoop();
    }
    // Not more urgent (or a different container): stays in `pending`, picked
    // up after the current commit.
    return;
  }

  // Idle scheduler: start right away, synchronously (see module docblock).
  startNextPendingRender();
  workLoop();
}

/**
 * Stage 6: re-schedule the CURRENT tree of `container` — the narrow entry point
 * `setState` uses. The top-level VNode is not a parameter on purpose: its
 * single source of truth is the `currentVNode` this module saved at the last
 * commit, so hooks never keep their own copy of the tree. Everything else
 * (queueing, preemption, work loop) is the untouched `scheduleWork` machinery.
 *
 * `Priority.Normal` is the deliberate default for `setState` re-renders (the
 * teaching counter does not need UserBlocking semantics).
 *
 * Internal contract (like `__setSchedulerDeps`): not re-exported from index.ts.
 */
export function scheduleRerender(
  container: Element,
  priority: Priority = Priority.Normal,
): void {
  if (container !== currentContainer) {
    // Nothing committed for this container (or another container has committed
    // since — the scheduler keeps ONE current triple, a Stage 5 limitation):
    // a stale setState has no tree to re-render, drop it.
    return;
  }
  scheduleWork(container, currentVNode, priority);
}

// Register the setState → re-render bridge at load time. hooks.ts deliberately
// does not import the scheduler, keeping the value-level import graph acyclic:
// scheduler → fiber → hooks.
__setRerenderScheduler(scheduleRerender);

/**
 * Test-only hook: override part of the scheduler dependencies. Returns a reset
 * function that restores the production defaults AND clears all module-level
 * scheduler state (queue, current/WIP trees), so tests cannot leak into each
 * other. The `__` prefix marks it internal — it is not re-exported from
 * `index.ts` and is not part of the public contract.
 */
export function __setSchedulerDeps(overrides: Partial<SchedulerDeps>): () => void {
  deps = { ...deps, ...overrides };
  return () => {
    deps = { ...defaultDeps };
    pending = [];
    currentContainer = null;
    currentRoot = null;
    currentVNode = null;
    wipRoot = null;
    wipVNode = null;
    wipContainer = null;
    nextUnitOfWork = null;
    activePriority = Priority.Normal;
    deadline = 0;
  };
}

/** The current slice is over when the injected clock reaches the deadline. */
function shouldYield(): boolean {
  return deps.now() >= deadline;
}

/**
 * One slice of the render phase, plus the commit when the walk completes.
 * Re-entrant: it is both the synchronous first pass and the tick callback.
 */
function workLoop(): void {
  // Stale-tick guard: a queued tick may fire after its render was preempted or
  // already committed. If the pointer was reset — nothing to do; if it points
  // at a NEWER render, continuing it is equally correct (single source of truth).
  if (nextUnitOfWork === null) {
    return;
  }

  // Recompute the deadline on every entry — a resumed tick starts a fresh
  // budget; keeping the old deadline would make it yield immediately, forever.
  deadline = deps.now() + deps.frameBudgetMs;

  while (nextUnitOfWork !== null && !shouldYield()) {
    nextUnitOfWork = performUnitOfWork(nextUnitOfWork);
  }

  if (nextUnitOfWork !== null) {
    // Budget exhausted mid-render: yield to the host, resume on the next tick
    // from the saved pointer.
    deps.scheduleTick(workLoop);
    return;
  }

  // Render phase complete → commit synchronously and indivisibly (no deadline
  // checks past this point).
  commitWip();

  // Post-MVP §1: a passive effect's `setState` can re-enter this function
  // (via `commitWip` → `runPassiveEffects`) and, if that reentrant render
  // yields mid-flight, leave `nextUnitOfWork` pointing at ITS suspended WIP
  // with a tick already scheduled. Only pull the next queued render here when
  // no such suspended render is in flight — otherwise this call would
  // overwrite the suspended render's module state (`wipRoot`/`wipContainer`/
  // `wipVNode`) out from under its pending tick, orphaning it.
  if (nextUnitOfWork === null && startNextPendingRender()) {
    // More queued updates: re-enter through the guard with a fresh deadline
    // (the commit may have eaten the rest of this slice's budget).
    workLoop();
  }
}

/** Commit the finished WIP and atomically promote it to `current`. */
function commitWip(): void {
  // Invariant: the walk just returned null, so a WIP root exists.
  const root = wipRoot!;
  const pending = commitRoot(root);
  // Strictly AFTER the commit: `current*` must always describe the real DOM.
  currentContainer = wipContainer;
  currentRoot = root;
  currentVNode = wipVNode;
  wipRoot = null;
  wipVNode = null;
  wipContainer = null;
  // Passive effects run LAST, after the `current*` promotion above: a setState
  // inside an effect re-enters the scheduler synchronously (possibly nesting
  // another full render+commitWip); with no code after this call there is
  // nothing left in THIS frame to clobber the nested commit's promotion.
  runPassiveEffects(pending);
}

/**
 * Pull the most urgent queued update (lowest number; FIFO among equals — a
 * linear scan with a strict `<` keeps insertion order, no heap needed) and set
 * up its render. Returns false when the queue is empty.
 */
function startNextPendingRender(): boolean {
  if (pending.length === 0) {
    return false;
  }
  let bestIndex = 0;
  for (let i = 1; i < pending.length; i++) {
    if (pending[i]!.priority < pending[bestIndex]!.priority) {
      bestIndex = i;
    }
  }
  const entry = pending.splice(bestIndex, 1)[0]!;

  // The prev tree is what is committed in THIS container (the committed pair
  // currentRoot/currentVNode is kept in sync — an existing root means the
  // vnode is trustworthy); a different container is a fresh target and mounts
  // from scratch.
  const hasPrev = entry.container === currentContainer && currentRoot !== null;
  const prevVNode = hasPrev ? currentVNode : null;
  activePriority = entry.priority;
  wipContainer = entry.container;
  wipVNode = entry.vnode;
  // Stage 6: the committed root fiber rides along as the prev-side fiber tree —
  // function components read their hooks and previously rendered result off it.
  wipRoot = createWorkInProgress(
    entry.container,
    prevVNode,
    entry.vnode,
    hasPrev ? currentRoot : null,
  );
  nextUnitOfWork = wipRoot;
  return true;
}
