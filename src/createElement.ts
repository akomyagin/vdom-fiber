import {
  TEXT_ELEMENT,
  type ComponentFunction,
  type VChild,
  type VNode,
} from "./types.js";

/**
 * A child argument as accepted by {@link createElement}: either a single
 * {@link VChild} or an arbitrarily nested array of them (e.g. the result of
 * `items.map(...)` passed straight in as one argument).
 */
type VChildInput = VChild | VChildInput[];

/**
 * Stage 1: build a virtual node tree.
 *
 * This is the single entry point the (future) JSX pragma compiles down to
 * (`h(type, props, ...children)`). For now it is a hand-called factory.
 *
 * Child normalisation guarantees `props.children` is always a flat `VNode[]`:
 * - nested arrays are flattened (any depth);
 * - `null` / `undefined` / `boolean` children are dropped (enables the
 *   `cond && h(...)` conditional-rendering idiom);
 * - raw strings and numbers are wrapped in {@link TEXT_ELEMENT} nodes.
 */
export function createElement(
  type: string | ComponentFunction,
  props?: Record<string, unknown> | null,
  ...children: VChildInput[]
): VNode {
  return {
    type,
    props: {
      ...props,
      children: normalizeChildren(children),
    },
  };
}

/**
 * Wrap a primitive into a text virtual node. Used by createElement's
 * child-normalisation; text nodes carry their content in `props.nodeValue`.
 */
export function createTextElement(value: string | number): VNode {
  return {
    type: TEXT_ELEMENT,
    props: { nodeValue: String(value), children: [] },
  };
}

/** Flatten, filter and wrap raw children into a proper `VNode[]`. */
function normalizeChildren(children: VChildInput[]): VNode[] {
  const result: VNode[] = [];
  for (const child of children) {
    if (Array.isArray(child)) {
      result.push(...normalizeChildren(child));
    } else if (child === null || child === undefined || typeof child === "boolean") {
      // Skipped on purpose: enables `cond && h(...)` conditional rendering.
    } else if (typeof child === "string" || typeof child === "number") {
      result.push(createTextElement(child));
    } else {
      result.push(child);
    }
  }
  return result;
}
