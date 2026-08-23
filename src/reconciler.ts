import { TEXT_ELEMENT, type VNode, type VProps } from "./types.js";

/**
 * Stage 3: synchronous VDOM diffing (reconciliation).
 *
 * Given the previous and next virtual trees for the same container, computes
 * the minimal set of DOM mutations and applies them in place. Still fully
 * synchronous and recursive — the interruptible fiber walk arrives in Stage 4/5.
 *
 * "Minimal" here means "do not recreate unchanged nodes": a node whose type did
 * not change keeps its DOM identity (the very same `Node` object) across
 * reconciles; only the changed props / text / children are touched.
 *
 * This module is also the single home of props application for the whole
 * project: {@link patchProps} covers mount (patch from empty props) and update
 * alike, and `render.ts` reuses {@link createDomNode} for its first paint.
 */

/** Matches event-listener props such as `onClick` / `onMouseEnter`. */
const EVENT_PROP_RE = /^on[A-Z]/;

/** Empty props bag used when mounting: mount = patch from nothing. */
const EMPTY_PROPS: VProps = { children: [] };

/**
 * Diff two virtual trees rooted in slot 0 of `container` and mutate the real
 * DOM in place. `prev === null` mounts, `next === null` unmounts the root.
 */
export function reconcile(
  container: Element,
  prev: VNode | null,
  next: VNode | null,
): void {
  patchNode(container, prev, next, 0);
}

/**
 * Diff a single child slot of `parentDom`. `index` locates the real DOM node
 * that corresponds to `prev` (the DOM mirrors the previous virtual tree).
 */
function patchNode(
  parentDom: Element,
  prev: VNode | null,
  next: VNode | null,
  index: number,
): void {
  if (next === null) {
    if (prev !== null) {
      const dom = parentDom.childNodes[index];
      if (dom !== undefined) {
        parentDom.removeChild(dom);
      }
    }
    return;
  }
  if (prev === null) {
    parentDom.insertBefore(createDomNode(next), parentDom.childNodes[index] ?? null);
    return;
  }
  // Both present: the DOM node for `prev` must exist at `index` by invariant.
  patchExisting(parentDom, parentDom.childNodes[index]!, prev, next);
}

/**
 * Patch an existing DOM node (`dom` corresponds to `prev`) into `next`.
 * Returns the DOM node that represents `next` afterwards — the same object
 * when the type matched, a freshly created replacement otherwise.
 */
function patchExisting(parentDom: Element, dom: Node, prev: VNode, next: VNode): Node {
  if (prev.type !== next.type) {
    // Type changed (`div` → `span`, element ↔ text): replace the whole subtree.
    const newDom = createDomNode(next);
    parentDom.replaceChild(newDom, dom);
    return newDom;
  }
  if (next.type === TEXT_ELEMENT) {
    // Same text node: update its data in place, never recreate.
    const text = String(next.props.nodeValue);
    if (dom.nodeValue !== text) {
      dom.nodeValue = text;
    }
    return dom;
  }
  // Same element type: keep the node, diff props and recurse into children.
  const el = dom as Element;
  patchProps(el, prev.props, next.props);
  patchChildren(el, prev.props.children, next.props.children);
  return dom;
}

/**
 * Diff the child lists of an element.
 *
 * Two modes:
 * - keyed — only when **every** next child has a `key`: match by key, reuse
 *   and move existing DOM nodes via `insertBefore` (no LIS optimisation);
 * - indexed — otherwise (no keys, or keys on only some children): match
 *   children positionally. Partially-keyed lists deliberately fall back here —
 *   keys then give no reuse benefit, but the result stays correct.
 */
function patchChildren(
  parentDom: Element,
  prevChildren: VNode[],
  nextChildren: VNode[],
): void {
  if (isKeyedChildren(nextChildren)) {
    patchKeyedChildren(parentDom, prevChildren, nextChildren);
  } else {
    patchIndexedChildren(parentDom, prevChildren, nextChildren);
  }
}

/**
 * The single home of the "when is a child list keyed" rule: keyed mode is used
 * only when **every** next child carries a `key`. Partially-keyed lists fall
 * back to the indexed mode on purpose (see {@link patchChildren}).
 *
 * Exported so the Stage 4 fiber walk reuses the exact same predicate instead of
 * duplicating the rule.
 */
export function isKeyedChildren(nextChildren: VNode[]): boolean {
  return (
    nextChildren.length > 0 && nextChildren.every((child) => child.props.key != null)
  );
}

/** Positional diff: patch the common range, mount extras, drop the tail. */
function patchIndexedChildren(
  parentDom: Element,
  prevChildren: VNode[],
  nextChildren: VNode[],
): void {
  const common = Math.min(prevChildren.length, nextChildren.length);
  for (let i = 0; i < common; i++) {
    patchNode(parentDom, prevChildren[i]!, nextChildren[i]!, i);
  }
  // New children beyond the old length: mount in order (appends at the end).
  for (let i = common; i < nextChildren.length; i++) {
    patchNode(parentDom, null, nextChildren[i]!, i);
  }
  // Old children beyond the new length: remove back-to-front so that the
  // indexes of the yet-to-be-removed nodes stay valid.
  for (let i = prevChildren.length - 1; i >= common; i--) {
    patchNode(parentDom, prevChildren[i]!, null, i);
  }
}

/**
 * Keyed diff: reuse DOM nodes by `key`, moving them into place with
 * `insertBefore` (which relocates a node already in the tree), then drop the
 * old nodes whose keys did not reappear.
 */
function patchKeyedChildren(
  parentDom: Element,
  prevChildren: VNode[],
  nextChildren: VNode[],
): void {
  // Snapshot old DOM nodes by key before any mutation shifts childNodes.
  // A queue per key (not a single entry) so duplicate keys in `prevChildren`
  // are consumed in order instead of the last one silently shadowing earlier
  // duplicates, which would otherwise orphan them (never patched, never
  // removed).
  const prevByKey = new Map<unknown, Array<{ vnode: VNode; dom: Node }>>();
  prevChildren.forEach((child, i) => {
    const dom = parentDom.childNodes[i];
    if (dom !== undefined) {
      const key = child.props.key;
      const queue = prevByKey.get(key);
      if (queue !== undefined) {
        queue.push({ vnode: child, dom });
      } else {
        prevByKey.set(key, [{ vnode: child, dom }]);
      }
    }
  });

  // The DOM node placed for the previous next-child; the current child must
  // end up right after it (or first in the parent for the first child).
  let lastPlaced: Node | null = null;

  for (const nextChild of nextChildren) {
    const key = nextChild.props.key;
    const queue = prevByKey.get(key);
    const entry = queue?.shift();
    let dom: Node;
    if (entry !== undefined) {
      dom = patchExisting(parentDom, entry.dom, entry.vnode, nextChild);
    } else {
      dom = createDomNode(nextChild);
    }
    const refNode: Node | null =
      lastPlaced === null ? parentDom.firstChild : lastPlaced.nextSibling;
    if (dom !== refNode) {
      parentDom.insertBefore(dom, refNode);
    }
    lastPlaced = dom;
  }

  // Remove old nodes whose keys vanished (or whose duplicate copies were
  // never claimed) from the next list.
  for (const queue of prevByKey.values()) {
    for (const entry of queue) {
      if (entry.dom.parentNode === parentDom) {
        parentDom.removeChild(entry.dom);
      }
    }
  }
}

/**
 * Build a real DOM subtree (depth-first) for a single virtual node.
 * Mounting props is just a patch from the empty props bag.
 *
 * Internal: exported for `render.ts` (Stage 2 first paint) and used here for
 * mount/replace, so the node-creation logic exists exactly once.
 */
export function createDomNode(vnode: VNode): Node {
  if (typeof vnode.type === "function") {
    // Deliberate refusal (Stage 6 plan): function components live in the fiber
    // pipeline (`scheduleWork`); the synchronous Stage 2/3 path does not
    // duplicate their support. This also narrows `type` to `string` below.
    throw new Error(
      "Function components are not supported by the synchronous renderer; use scheduleWork",
    );
  }
  if (vnode.type === TEXT_ELEMENT) {
    return document.createTextNode(String(vnode.props.nodeValue));
  }

  const dom = document.createElement(vnode.type);
  patchProps(dom, EMPTY_PROPS, vnode.props);
  for (const child of vnode.props.children) {
    dom.appendChild(createDomNode(child));
  }
  return dom;
}

/**
 * The single implementation of props application/diffing in the project.
 * Walks the union of prev/next keys and adds / updates / removes accordingly;
 * a key whose value is unchanged (`===`) is not touched at all.
 *
 * Rules (carried over from Stage 2's mount, generalised to updates):
 * - `children` is not a DOM attribute, `key` is a reconciliation directive —
 *   both skipped;
 * - `on<Event>` props map to add/removeEventListener(event, handler) where the
 *   event name is the part after "on", fully lower-cased (`onClick` → "click").
 *   An updated handler is removed by its old reference (from `prevProps`)
 *   before the new one is attached. A non-function value throws `TypeError`;
 * - `style` is a camelCase CSS object (React-style), diffed per property:
 *   properties gone from the next style are reset to `""`, changed/new ones
 *   are assigned;
 * - everything else is a plain attribute via `setAttribute`; `false` (or the
 *   key disappearing) removes the attribute, `true` sets it as a boolean
 *   attribute (`""`), anything else is stringified.
 */
export function patchProps(dom: Element, prevProps: VProps, nextProps: VProps): void {
  const keys = new Set([...Object.keys(prevProps), ...Object.keys(nextProps)]);
  for (const key of keys) {
    if (key === "children" || key === "key") {
      continue;
    }
    const hasPrev = key in prevProps;
    const hasNext = key in nextProps;
    const prevValue = prevProps[key];
    const nextValue = nextProps[key];
    if (hasPrev && hasNext && prevValue === nextValue) {
      continue; // Unchanged — no DOM mutation at all.
    }

    if (EVENT_PROP_RE.test(key)) {
      if (hasNext && typeof nextValue !== "function") {
        throw new TypeError(`Expected a function for prop "${key}", got ${typeof nextValue}`);
      }
      const eventName = key.slice(2).toLowerCase();
      if (hasPrev) {
        dom.removeEventListener(eventName, prevValue as EventListener);
      }
      if (hasNext) {
        dom.addEventListener(eventName, nextValue as EventListener);
      }
    } else if (key === "style") {
      patchStyle(dom as HTMLElement, prevValue, nextValue);
    } else if (!hasNext || nextValue === false) {
      // Removed key or explicit `false`: drop the attribute entirely.
      dom.removeAttribute(key);
    } else if (nextValue === true) {
      dom.setAttribute(key, "");
    } else {
      dom.setAttribute(key, String(nextValue));
    }
  }
}

/**
 * Diff two camelCase style objects onto `dom.style`: reset properties that
 * disappeared, assign changed/new ones, leave the rest untouched.
 */
function patchStyle(dom: HTMLElement, prevValue: unknown, nextValue: unknown): void {
  const prevStyle = (prevValue ?? {}) as Record<string, unknown>;
  const nextStyle = (nextValue ?? {}) as Record<string, unknown>;
  const style = dom.style as unknown as Record<string, unknown>;
  for (const prop of Object.keys(prevStyle)) {
    if (!(prop in nextStyle)) {
      style[prop] = "";
    }
  }
  for (const [prop, value] of Object.entries(nextStyle)) {
    if (prevStyle[prop] !== value) {
      style[prop] = value;
    }
  }
}
