import type { VNode } from "./types.js";

/**
 * Stage 2 (skeleton): synchronous first-paint mount.
 *
 * Recursively creates real DOM nodes from a {@link VNode} tree and appends them
 * to `container`. No diffing here — this is the "just draw it once" pass that
 * Stage 3's reconciler will later supersede for re-renders.
 *
 * TODO(Этап 2): implement recursive mount (createElement/createTextNode, apply
 * props/attributes/event listeners, append children depth-first).
 */
export function render(_vnode: VNode, _container: Element): void {
  // TODO(Этап 2): implement
  throw new Error("render is not implemented yet (Этап 2)");
}
