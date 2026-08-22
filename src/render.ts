import type { VNode } from "./types.js";
import { createDomNode } from "./reconciler.js";

/**
 * Stage 2: synchronous first-paint mount.
 *
 * Recursively creates real DOM nodes from a {@link VNode} tree and appends them
 * to `container` in a single synchronous depth-first pass. No diffing here —
 * re-renders go through Stage 3's `reconcile`.
 *
 * Since Stage 3 the node-building itself lives in `reconciler.ts`
 * (`createDomNode`, with props applied via the shared `patchProps`), so mount
 * and reconcile share exactly one implementation of props application.
 */
export function render(vnode: VNode, container: Element): void {
  container.appendChild(createDomNode(vnode));
}
