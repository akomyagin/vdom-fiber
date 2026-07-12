import type { VNode } from "./types.js";

/**
 * Stage 4 (skeleton): the Fiber node.
 *
 * A Fiber is one unit of work. Unlike the recursive Stage 2/3 walk, fibers form
 * a singly-linked tree (child / sibling / return pointers) so the reconciler can
 * pause after any single fiber and resume later from the saved pointer — this is
 * what makes Stage 5's interruptible scheduling possible.
 *
 * TODO(Этап 4): flesh out effect tags (PLACEMENT/UPDATE/DELETION), the
 * alternate (current ↔ work-in-progress) link, and the `dom` backing node.
 */
export interface Fiber {
  type?: string;
  props: VNode["props"];
  /** Backing real DOM node (null until committed). */
  dom: Node | null;
  parent: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
  /** The committed fiber this WIP fiber is derived from. */
  alternate: Fiber | null;
}

/**
 * Perform one unit of work and return the next fiber to process (child, then
 * sibling, then walk up via `return`/parent), or null when the tree is done.
 *
 * TODO(Этап 4): implement the depth-first fiber walk without recursion.
 */
export function performUnitOfWork(_fiber: Fiber): Fiber | null {
  // TODO(Этап 4): implement
  throw new Error("performUnitOfWork is not implemented yet (Этап 4)");
}
