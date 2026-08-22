import { TEXT_ELEMENT, type VNode, type VProps } from "./types.js";

/**
 * Stage 2: synchronous first-paint mount.
 *
 * Recursively creates real DOM nodes from a {@link VNode} tree and appends them
 * to `container` in a single synchronous depth-first pass. No diffing here —
 * this is the "just draw it once" pass that Stage 3's reconciler will later
 * supersede for re-renders.
 */
export function render(vnode: VNode, container: Element): void {
  container.appendChild(createDomNode(vnode));
}

/** Build a real DOM subtree (depth-first) for a single virtual node. */
function createDomNode(vnode: VNode): Node {
  if (vnode.type === TEXT_ELEMENT) {
    return document.createTextNode(String(vnode.props.nodeValue));
  }

  const dom = document.createElement(vnode.type);
  applyProps(dom, vnode.props);
  for (const child of vnode.props.children) {
    dom.appendChild(createDomNode(child));
  }
  return dom;
}

/** Matches event-listener props such as `onClick` / `onMouseEnter`. */
const EVENT_PROP_RE = /^on[A-Z]/;

/**
 * Apply a props bag to a freshly created element.
 *
 * Internal for now; Stage 3's reconciler will reuse (a generalised form of)
 * this when it starts updating existing nodes.
 *
 * Rules:
 * - `children` is not a DOM attribute — skipped;
 * - `on<Event>` props become `addEventListener(event, handler)` where the event
 *   name is the part after "on", fully lower-cased (`onClick` → "click");
 * - `style` is a camelCase CSS object (React-style), merged into `dom.style`;
 * - everything else is a plain attribute via `setAttribute`; `false` removes
 *   the attribute entirely, `true` sets it as a boolean attribute (`""`).
 */
function applyProps(dom: Element, props: VProps): void {
  for (const [key, value] of Object.entries(props)) {
    if (key === "children") {
      continue;
    }
    if (EVENT_PROP_RE.test(key)) {
      if (typeof value !== "function") {
        throw new TypeError(`Expected a function for prop "${key}", got ${typeof value}`);
      }
      const eventName = key.slice(2).toLowerCase();
      dom.addEventListener(eventName, value as EventListener);
    } else if (key === "style") {
      Object.assign((dom as HTMLElement).style, value);
    } else if (value === false) {
      // Falsy boolean attribute: do not set at all (`disabled: false`).
    } else if (value === true) {
      dom.setAttribute(key, "");
    } else {
      dom.setAttribute(key, String(value));
    }
  }
}
