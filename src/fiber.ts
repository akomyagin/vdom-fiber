import {
  beginHooks,
  commitFiberHooks,
  finishHooks,
  type Hook,
  type HookSnapshot,
} from "./hooks.js";
import { createDomNode, isKeyedChildren, patchProps } from "./reconciler.js";
import {
  TEXT_ELEMENT,
  type ComponentFunction,
  type VNode,
  type VProps,
} from "./types.js";

/**
 * Stage 4: the Fiber data structure and the non-recursive, interruptible walk.
 *
 * A Fiber is one unit of work. Unlike the recursive Stage 2/3 walk, fibers form
 * a singly-linked tree (child / sibling / parent pointers) so the reconciler can
 * pause after any single fiber and resume later from the saved pointer — this is
 * what makes Stage 5's interruptible scheduling possible.
 *
 * Division of labour with `reconciler.ts` (Stage 3): the *patching rules* stay
 * there and are reused ({@link createDomNode}, {@link patchProps}, the keyed
 * predicate {@link isKeyedChildren}); this module only changes the *way the
 * tree is walked*. The walk ({@link performUnitOfWork}) never touches the DOM —
 * it builds a work-in-progress (WIP) fiber tree and marks every fiber with an
 * {@link EffectTag}; the separate commit phase ({@link commitRoot}) then applies
 * all accumulated effects to the real DOM in one synchronous pass.
 *
 * No module-level state: the "next unit of work" pointer is returned from
 * {@link performUnitOfWork} and kept by the caller (the Stage 5 scheduler, or a
 * plain `while` loop in tests), and the previous tree is passed in explicitly
 * via {@link createWorkInProgress} — same principle as Stage 3's `reconcile`.
 */

/** What the commit phase must do for a fiber (string-literal union, no enum). */
export type EffectTag = "PLACEMENT" | "UPDATE" | "DELETION";

/**
 * One node of the work-in-progress tree.
 */
export interface Fiber {
  /**
   * Host tag, `TEXT_ELEMENT` or (Stage 6) a function component; absent on the
   * host-root fiber (the container).
   */
  type?: string | ComponentFunction;
  /** Props of the corresponding VNode (synthetic `{ children }` bag on the root). */
  props: VProps;
  /**
   * Backing real DOM node. For UPDATE fibers it is carried over from
   * `alternate.dom` (same object — DOM identity is preserved); for PLACEMENT it
   * stays `null` until commit creates the subtree; on the host root it is the
   * container itself.
   */
  dom: Node | null;
  /** Parent in the WIP tree (the "return" pointer in React terms). */
  parent: Fiber | null;
  /** First child. */
  child: Fiber | null;
  /** Next sibling. */
  sibling: Fiber | null;
  /**
   * The prev-tree counterpart this WIP fiber is derived from: carries the old
   * `props` (for `patchProps`) and the existing `dom` (for reuse). `null` for
   * brand-new (PLACEMENT) fibers.
   */
  alternate: Fiber | null;
  /** What commit must do; `undefined` = nothing (e.g. the host root). */
  effectTag?: EffectTag;
  /**
   * DELETION fibers for prev-children that have no place in the WIP tree (they
   * are absent from `next`, so they cannot hang off `child`/`sibling`).
   * Collected on the parent during the walk so no DELETION effect is ever lost;
   * consumed by {@link commitRoot}.
   */
  deletions?: Fiber[];
  /**
   * Stage 6: the hook list of a function-component fiber, one {@link Hook} per
   * `useState` call in body order. Owned by `hooks.ts` (which also holds the
   * "currently rendering fiber" pointer — this module stays stateless); carried
   * across renders through `alternate.hooks`.
   */
  hooks?: Hook[];
  /**
   * Stage 6: render-phase state snapshots, parallel to {@link hooks} by index.
   * The render walk never mutates the durable Hook objects (they are shared
   * with the committed tree) — it derives here instead. Discarded together
   * with the WIP tree on preemption; folded into the Hooks by the commit walk
   * ({@link commitRoot} → `commitFiberHooks`).
   */
  hookSnapshots?: HookSnapshot[];
}

/**
 * The single home of the "is this fiber a function component" check (Stage 6).
 * Component fibers are transparent for the DOM: they never own a node, their
 * children live in the nearest host ancestor.
 */
export function isComponentFiber(fiber: Fiber): boolean {
  return typeof fiber.type === "function";
}

/**
 * Prepare the root host-fiber for a render from `prevVNode` to `nextVNode`,
 * modelling the container the same way Stage 3's `reconcile(container, prev,
 * next)` models slot 0. The returned fiber is the first unit of work; drive it
 * with `let u = root; while (u) u = performUnitOfWork(u);` then `commitRoot(root)`.
 */
export function createWorkInProgress(
  container: Element,
  prevVNode: VNode | null,
  nextVNode: VNode | null,
  prevRoot: Fiber | null = null,
): Fiber {
  // Synthetic prev-root: lets the ordinary child reconciliation of the root
  // produce the right effect (mount when prev is null, patch/replace/delete
  // otherwise). Its `dom` is the container — that is where prev children live.
  // Stage 6: when the caller retains the previously committed root fiber (the
  // scheduler does), its child chain is threaded in as the prev-side fibers —
  // that is where a function component's hooks and previously rendered result
  // live; without it components would lose state and DOM identity on re-render.
  const alternate: Fiber | null =
    prevVNode === null
      ? null
      : {
          props: { children: [prevVNode] },
          dom: container,
          parent: null,
          child: prevRoot?.child ?? null,
          sibling: null,
          alternate: null,
        };
  return {
    props: { children: nextVNode === null ? [] : [nextVNode] },
    dom: container,
    parent: null,
    child: null,
    sibling: null,
    alternate,
    // No effectTag: the container itself is never created or patched.
  };
}

/**
 * Perform ONE unit of work and return the next fiber to process, or `null`
 * when the walk is complete.
 *
 * A step (1) reconciles the fiber's children — pairs prev/next child VNodes
 * (keyed or indexed, via the shared {@link isKeyedChildren} predicate), spawns
 * child fibers with their effect tags and collects DELETIONs — and (2) returns
 * the next fiber in classic non-recursive DFS order: child first, else sibling,
 * else the nearest ancestor's sibling.
 *
 * Pure with respect to the DOM: no node creation, no props application, no
 * (re)insertion happens here — that is what makes interruption safe. Stopping
 * between two calls leaves a half-built WIP tree but an untouched DOM.
 */
export function performUnitOfWork(fiber: Fiber): Fiber | null {
  reconcileChildren(fiber);

  if (fiber.child !== null) {
    return fiber.child;
  }
  let node: Fiber | null = fiber;
  while (node !== null) {
    if (node.sibling !== null) {
      return node.sibling;
    }
    node = node.parent;
  }
  return null;
}

/**
 * A prev-side child: its VNode, the real DOM node currently backing it, and
 * (when the committed prev tree is available — Stage 6) the committed fiber
 * itself, carrying hooks, the rendered result of components and the child
 * fibers for deletions.
 */
interface PrevSlot {
  vnode: VNode;
  dom: Node | null;
  fiber: Fiber | null;
}

/** One matching result: `(prev | null, next | null)`; `(prev, null)` = deletion. */
interface ChildPair {
  prev: PrevSlot | null;
  next: VNode | null;
}

/**
 * Pair up this fiber's next-children with its alternate's prev-children and
 * spawn the child fibers (linked via `parent`/`child`/`sibling`), marking each
 * with an effect tag by the reuse-vs-replace rule:
 * - no prev pair → PLACEMENT;
 * - same `type` → UPDATE (dom + alternate carried over from prev);
 * - different `type` → DELETION of the old + PLACEMENT of the new;
 * - prev without next → DELETION.
 *
 * DELETION fibers are accumulated in `fiber.deletions`, not linked as live
 * children (the node they represent does not exist in the WIP tree).
 */
function reconcileChildren(fiber: Fiber): void {
  let nextChildren: VNode[];
  let prevSlots: PrevSlot[];

  if (typeof fiber.type === "function") {
    // Component fiber (Stage 6): its "children" are NOT `props.children` but
    // the result of calling the function — a single VNode (or none). The call
    // is a plain synchronous JS call inside this one unit of work: it keeps the
    // walk non-recursive and DOM-pure (interruption between units stays safe;
    // the only side effect is on this fiber's hook state).
    beginHooks(fiber);
    let rendered: VNode | null;
    try {
      rendered = fiber.type(fiber.props);
    } finally {
      finishHooks();
    }
    nextChildren = rendered === null ? [] : [rendered];
    // Prev side = the component's PREVIOUS RENDERED RESULT (the committed
    // fiber's child chain), not `props.children`. Prev DOM comes from the prev
    // fibers themselves: a component fiber has no dom of its own, so the host
    // branch's `childNodes.item(i)` indexing is impossible here.
    prevSlots = [];
    for (let p = fiber.alternate?.child ?? null; p !== null; p = p.sibling) {
      prevSlots.push({ vnode: { type: p.type!, props: p.props }, dom: p.dom, fiber: p });
    }
  } else {
    // Host fiber: Stage 4 behaviour. The DOM still mirrors the prev tree during
    // the whole render phase (the walk never mutates it), so prev child `i` is
    // backed by `alternate.dom.childNodes[i]` — UNLESS the committed prev child
    // fibers are available (scheduler path): then the prev DOM is taken from
    // them, because positional childNodes indexing breaks as soon as a
    // component child contributes 0..N host nodes instead of exactly one.
    nextChildren = fiber.props.children;
    const prevChildren = fiber.alternate?.props.children ?? [];
    const prevParentDom = fiber.alternate?.dom ?? null;
    const prevFibers: Fiber[] = [];
    for (let p = fiber.alternate?.child ?? null; p !== null; p = p.sibling) {
      prevFibers.push(p);
    }
    prevSlots = prevChildren.map((vnode, i) => {
      const prevFiber = prevFibers[i] ?? null;
      return {
        vnode,
        dom:
          prevFiber !== null ? prevFiber.dom : prevParentDom?.childNodes.item(i) ?? null,
        fiber: prevFiber,
      };
    });
  }

  // The "when keyed" rule is the shared predicate from reconciler.ts — it must
  // exist in the project exactly once. Both branches above feed the SAME
  // pairing and the same child-fiber spawning below (no duplicated matching).
  const pairs = isKeyedChildren(nextChildren)
    ? matchKeyedChildren(prevSlots, nextChildren)
    : matchIndexedChildren(prevSlots, nextChildren);

  let prevSibling: Fiber | null = null;
  for (const { prev, next } of pairs) {
    if (next === null) {
      // Prev child with no next counterpart: pure deletion.
      if (prev !== null) {
        addDeletion(fiber, prev);
      }
      continue;
    }
    // `===` on `type` covers function components too: functions compare by
    // reference, exactly the reuse semantics we want.
    const reused = prev !== null && prev.vnode.type === next.type ? prev : null;
    if (prev !== null && reused === null) {
      // Type changed: the old subtree goes away, the new one is placed fresh.
      addDeletion(fiber, prev);
    }
    let alternate: Fiber | null = null;
    if (reused !== null) {
      if (reused.fiber !== null) {
        // The real committed fiber: carries prev props/dom AND (Stage 6) the
        // hooks and previously rendered children of components. Cut its own
        // alternate link so old generations cannot chain up unboundedly.
        alternate = reused.fiber;
        alternate.alternate = null;
      } else {
        // Legacy path (no retained prev root): a snapshot from VNode + DOM,
        // byte-for-byte the Stage 4 behaviour.
        alternate = {
          type: reused.vnode.type,
          props: reused.vnode.props,
          dom: reused.dom,
          parent: null,
          child: null,
          sibling: null,
          alternate: null,
        };
      }
    }
    const childFiber: Fiber = {
      type: next.type,
      props: next.props,
      dom: reused !== null ? reused.dom : null,
      parent: fiber,
      child: null,
      sibling: null,
      alternate,
      effectTag: reused !== null ? "UPDATE" : "PLACEMENT",
    };
    if (prevSibling === null) {
      fiber.child = childFiber;
    } else {
      prevSibling.sibling = childFiber;
    }
    prevSibling = childFiber;
  }
}

/** Record a DELETION fiber for a vanished prev child on its parent. */
function addDeletion(parent: Fiber, prev: PrevSlot): void {
  const deletion: Fiber = {
    type: prev.vnode.type,
    props: prev.vnode.props,
    dom: prev.dom,
    parent,
    // A dom-less (component) prev child is deleted by removing its lowest host
    // descendants — reachable through the committed child fibers (Stage 6).
    child: prev.fiber?.child ?? null,
    sibling: null,
    alternate: null,
    effectTag: "DELETION",
  };
  (parent.deletions ??= []).push(deletion);
}

/** Indexed (positional) pairing: zip to the longer length, `null` fills gaps. */
function matchIndexedChildren(
  prevSlots: PrevSlot[],
  nextChildren: VNode[],
): ChildPair[] {
  const pairs: ChildPair[] = [];
  const length = Math.max(prevSlots.length, nextChildren.length);
  for (let i = 0; i < length; i++) {
    pairs.push({ prev: prevSlots[i] ?? null, next: nextChildren[i] ?? null });
  }
  return pairs;
}

/**
 * Keyed pairing: match each next child to the prev child with the same `key`
 * (a queue per key keeps duplicate keys deterministic, as in Stage 3);
 * unclaimed prev children become `(prev, null)` deletion pairs.
 *
 * Accepted trade-off (per the Stage 4 plan): the *pair-building* of
 * `patchKeyedChildren` in reconciler.ts is welded to a live-DOM snapshot and
 * `insertBefore`, so it cannot be reused here as-is; only the "when keyed"
 * predicate is shared. Ordering/moving nodes is the commit phase's job.
 */
function matchKeyedChildren(prevSlots: PrevSlot[], nextChildren: VNode[]): ChildPair[] {
  const prevByKey = new Map<unknown, PrevSlot[]>();
  for (const slot of prevSlots) {
    const key = slot.vnode.props.key;
    const queue = prevByKey.get(key);
    if (queue !== undefined) {
      queue.push(slot);
    } else {
      prevByKey.set(key, [slot]);
    }
  }
  const pairs: ChildPair[] = [];
  for (const next of nextChildren) {
    const prev = prevByKey.get(next.props.key)?.shift() ?? null;
    pairs.push({ prev, next });
  }
  for (const queue of prevByKey.values()) {
    for (const slot of queue) {
      pairs.push({ prev: slot, next: null });
    }
  }
  return pairs;
}

/**
 * Commit phase: apply every effect accumulated in the fully-built WIP tree to
 * the real DOM in ONE synchronous, indivisible pass (no re-diffing). Reuses the
 * Stage 3 primitives: {@link createDomNode} for PLACEMENT subtrees,
 * {@link patchProps} for UPDATE props, and the `lastPlaced`/`insertBefore`
 * positioning strategy of `patchKeyedChildren` for ordering.
 */
export function commitRoot(rootFiber: Fiber): void {
  commitChildren(rootFiber);
  finalizeHooks(rootFiber);
}

/**
 * Stage 6, second half of the hooks write-discipline: the render phase only
 * SNAPSHOTS hook state (never mutating the durable Hook objects shared with
 * the committed tree — see `useState`), so the tree that actually commits must
 * fold those snapshots into the durable Hooks. This dedicated pass exists
 * because component fibers are DOM-transparent and never reach
 * {@link commitFiber}; it walks the WHOLE committed WIP tree and finalises
 * every component fiber, PLACEMENT and UPDATE alike. Runs inside the same
 * synchronous, indivisible commit as the DOM effects — no deadline checks
 * (plain recursion is fine: only the render walk must be non-recursive).
 */
function finalizeHooks(fiber: Fiber): void {
  if (isComponentFiber(fiber)) {
    commitFiberHooks(fiber);
  }
  for (let child = fiber.child; child !== null; child = child.sibling) {
    finalizeHooks(child);
  }
}

/**
 * Commit one host parent's child list: deletions first, then place the children
 * left to right keeping `lastPlaced`, so every child ends up right after the
 * previously placed one (a no-op `insertBefore` when it is already there —
 * exactly the Stage 3 positioning algorithm, covering keyed moves and inserts).
 * Stage 6: component fibers in the list are transparent — see
 * {@link placeChildren}.
 */
function commitChildren(parentFiber: Fiber): void {
  // Parents reached here always have a dom: the root carries the container and
  // this is only ever called for host fibers (components are unfolded by
  // placeChildren, never passed here).
  const parentDom = parentFiber.dom;
  if (parentDom === null) {
    return;
  }
  commitDeletions(parentFiber, parentDom);
  placeChildren(parentFiber, parentDom, null);
}

/**
 * Remove the host DOM of every DELETION recorded on `fiber` from `parentDom` —
 * the nearest host ancestor's DOM (for a host parent that is its own `dom`; for
 * a transparent component level it is passed down by {@link placeChildren}).
 * Deleting a dom-less component means deleting its lowest host descendants
 * ({@link collectHostDoms}).
 */
function commitDeletions(fiber: Fiber, parentDom: Node): void {
  for (const deletion of fiber.deletions ?? []) {
    for (const dom of collectHostDoms(deletion)) {
      if (dom.parentNode === parentDom) {
        parentDom.removeChild(dom);
      }
    }
  }
}

/**
 * The "downward" half of the Stage 6 commit invariant: the host subtree of a
 * fiber is its own `dom` when it has one, otherwise the host nodes of its
 * children — descending through dom-less component levels until the first host
 * fibers.
 */
function collectHostDoms(fiber: Fiber): Node[] {
  if (fiber.dom !== null) {
    return [fiber.dom];
  }
  const doms: Node[] = [];
  for (let child = fiber.child; child !== null; child = child.sibling) {
    doms.push(...collectHostDoms(child));
  }
  return doms;
}

/**
 * Place `fiber`'s children into `parentDom` (the nearest host ancestor's DOM),
 * returning the updated `lastPlaced`. Host children commit their own effect and
 * take the next slot; component children are TRANSPARENT: their deletions are
 * committed against the same `parentDom` and their children are placed inline —
 * positioning is always computed in the host parent's coordinates, so a
 * component between two host siblings occupies no slot of its own while its
 * host nodes land exactly between them.
 */
function placeChildren(
  fiber: Fiber,
  parentDom: Node,
  lastPlaced: Node | null,
): Node | null {
  for (let child = fiber.child; child !== null; child = child.sibling) {
    if (isComponentFiber(child)) {
      commitDeletions(child, parentDom);
      lastPlaced = placeChildren(child, parentDom, lastPlaced);
      continue;
    }
    const dom = commitFiber(child);
    const refNode: Node | null =
      lastPlaced === null ? parentDom.firstChild : lastPlaced.nextSibling;
    if (dom !== refNode) {
      parentDom.insertBefore(dom, refNode);
    }
    lastPlaced = dom;
  }
  return lastPlaced;
}

/**
 * Apply one HOST fiber's own effect and return its DOM node (positioning is
 * done by the caller, {@link placeChildren}). Component fibers never reach this
 * function — they are unfolded transparently by {@link placeChildren}.
 */
function commitFiber(fiber: Fiber): Node {
  const type = fiber.type;
  if (typeof type === "function") {
    throw new Error("unreachable: component fibers are committed transparently");
  }

  if (fiber.effectTag === "PLACEMENT") {
    if (!hasComponentDescendant(fiber.props)) {
      // Pure host subtree: built by ONE createDomNode call (the single home of
      // node creation) — the unchanged Stage 4 fast path. Commit must NOT
      // re-create nodes for the child fibers; instead the created DOM subtree
      // is ADOPTED into them (1:1 by construction — both come from the same
      // props.children, and the subtree is component-free), so the committed
      // tree always knows its backing DOM. Stage 6 relies on that: the next
      // render reads prev DOM off these fibers.
      const dom = createDomNode({ type: type!, props: fiber.props });
      adoptSubtreeDoms(fiber, dom);
      return dom;
    }
    // A component hides somewhere below: createDomNode cannot build the subtree
    // from VNodes (a function type has no DOM equivalent). Create THIS node
    // shallowly (same createDomNode, children stripped) and, exceptionally for
    // a PLACEMENT, descend into the child fibers — unfolding component levels
    // down to their host nodes.
    const dom = createDomNode({ type: type!, props: { ...fiber.props, children: [] } });
    fiber.dom = dom;
    placeChildren(fiber, dom, null);
    return dom;
  }

  // UPDATE: `dom` was carried over from the alternate — identity preserved.
  const dom = fiber.dom!;
  if (type === TEXT_ELEMENT) {
    const text = String(fiber.props.nodeValue);
    if (dom.nodeValue !== text) {
      dom.nodeValue = text;
    }
    return dom;
  }
  patchProps(dom as Element, fiber.alternate!.props, fiber.props);
  // Children are handled by their own fibers — recurse into the child list
  // (commit recursion is fine: only the render walk must be non-recursive).
  commitChildren(fiber);
  return dom;
}

/**
 * Pair a freshly created DOM subtree with the fiber subtree it was built for:
 * fiber children and DOM children correspond positionally (both derive from the
 * same `props.children`; only valid for component-free subtrees — the
 * createDomNode fast path guarantees that).
 */
function adoptSubtreeDoms(fiber: Fiber, dom: Node): void {
  fiber.dom = dom;
  let child = fiber.child;
  let domChild = dom.firstChild;
  while (child !== null && domChild !== null) {
    adoptSubtreeDoms(child, domChild);
    child = child.sibling;
    domChild = domChild.nextSibling;
  }
}

/**
 * Does this props bag's child VNode tree contain a function component anywhere?
 * Decides whether a PLACEMENT can take the one-shot createDomNode fast path.
 */
function hasComponentDescendant(props: VProps): boolean {
  return props.children.some(
    (child) => typeof child.type === "function" || hasComponentDescendant(child.props),
  );
}
