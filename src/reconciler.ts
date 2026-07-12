import type { VNode } from "./types.js";

/**
 * Stage 3 (skeleton): synchronous VDOM diffing (reconciliation).
 *
 * Given the previous and next virtual trees for the same container, computes
 * the minimal set of DOM mutations and applies them in place. Still fully
 * synchronous and recursive — the interruptible fiber walk arrives in Stage 4/5.
 *
 * TODO(Этап 3): implement diff of one node (same type → patch props + recurse
 * children; different type → replace; missing → remove; new → mount) plus a
 * keyed children reconciliation.
 */
export function reconcile(
  _container: Element,
  _prev: VNode | null,
  _next: VNode | null,
): void {
  // TODO(Этап 3): implement
  throw new Error("reconcile is not implemented yet (Этап 3)");
}
