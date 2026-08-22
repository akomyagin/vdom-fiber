import { createDomNode, isKeyedChildren, patchProps } from "./reconciler.js";
import { TEXT_ELEMENT, type VNode, type VProps } from "./types.js";

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
  /** Host tag or `TEXT_ELEMENT`; absent on the host-root fiber (the container). */
  type?: string;
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
): Fiber {
  // Synthetic prev-root: lets the ordinary child reconciliation of the root
  // produce the right effect (mount when prev is null, patch/replace/delete
  // otherwise). Its `dom` is the container — that is where prev children live.
  const alternate: Fiber | null =
    prevVNode === null
      ? null
      : {
          props: { children: [prevVNode] },
          dom: container,
          parent: null,
          child: null,
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

/** A prev-side child: its VNode plus the real DOM node currently backing it. */
interface PrevSlot {
  vnode: VNode;
  dom: Node | null;
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
  const nextChildren = fiber.props.children;
  const prevChildren = fiber.alternate?.props.children ?? [];
  // The DOM still mirrors the prev tree during the whole render phase (the walk
  // never mutates it), so prev child `i` is backed by `alternate.dom.childNodes[i]`.
  const prevParentDom = fiber.alternate?.dom ?? null;
  const prevSlots: PrevSlot[] = prevChildren.map((vnode, i) => ({
    vnode,
    dom: prevParentDom?.childNodes.item(i) ?? null,
  }));

  // The "when keyed" rule is the shared predicate from reconciler.ts — it must
  // exist in the project exactly once.
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
    const reused = prev !== null && prev.vnode.type === next.type ? prev : null;
    if (prev !== null && reused === null) {
      // Type changed: the old subtree goes away, the new one is placed fresh.
      addDeletion(fiber, prev);
    }
    const childFiber: Fiber = {
      type: next.type,
      props: next.props,
      dom: reused !== null ? reused.dom : null,
      parent: fiber,
      child: null,
      sibling: null,
      alternate:
        reused !== null
          ? {
              type: reused.vnode.type,
              props: reused.vnode.props,
              dom: reused.dom,
              parent: null,
              child: null,
              sibling: null,
              alternate: null,
            }
          : null,
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
    child: null,
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
}

/**
 * Commit one parent's child list: deletions first, then walk the sibling chain
 * left to right keeping `lastPlaced`, so every child ends up right after the
 * previously placed one (a no-op `insertBefore` when it is already there —
 * exactly the Stage 3 positioning algorithm, covering keyed moves and inserts).
 */
function commitChildren(parentFiber: Fiber): void {
  // Parents reached here always have a dom: the root carries the container and
  // commit never descends into PLACEMENT subtrees (see commitFiber).
  const parentDom = parentFiber.dom;
  if (parentDom === null) {
    return;
  }

  for (const deletion of parentFiber.deletions ?? []) {
    if (deletion.dom !== null && deletion.dom.parentNode === parentDom) {
      parentDom.removeChild(deletion.dom);
    }
  }

  let lastPlaced: Node | null = null;
  for (let child = parentFiber.child; child !== null; child = child.sibling) {
    const dom = commitFiber(child);
    const refNode: Node | null =
      lastPlaced === null ? parentDom.firstChild : lastPlaced.nextSibling;
    if (dom !== refNode) {
      parentDom.insertBefore(dom, refNode);
    }
    lastPlaced = dom;
  }
}

/**
 * Apply one fiber's own effect and return its DOM node (positioning is done by
 * the caller, {@link commitChildren}).
 */
function commitFiber(fiber: Fiber): Node {
  if (fiber.effectTag === "PLACEMENT") {
    // The whole subtree is built by ONE createDomNode call (the single home of
    // node creation). Child fibers under a PLACEMENT exist only for the walk;
    // commit must NOT descend into them or nodes would be created twice.
    const dom = createDomNode({ type: fiber.type!, props: fiber.props });
    fiber.dom = dom;
    return dom;
  }

  // UPDATE: `dom` was carried over from the alternate — identity preserved.
  const dom = fiber.dom!;
  if (fiber.type === TEXT_ELEMENT) {
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
