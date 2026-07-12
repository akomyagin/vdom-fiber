import { TEXT_ELEMENT, type VChild, type VNode } from "./types.js";

/**
 * Stage 1 (skeleton): build a virtual node tree.
 *
 * This is the single entry point the (future) JSX pragma compiles down to
 * (`h(type, props, ...children)`). For now it is a hand-called factory.
 *
 * TODO(Этап 1): implement full normalisation — flatten nested child arrays,
 * drop `null`/`undefined`/`boolean` children, and wrap raw strings/numbers in
 * TEXT_ELEMENT nodes. The stub below is enough for the Stage 0 smoke test.
 */
export function createElement(
  _type: string,
  _props?: Record<string, unknown> | null,
  ..._children: VChild[]
): VNode {
  // TODO(Этап 1): implement
  throw new Error("createElement is not implemented yet (Этап 1)");
}

/**
 * Wrap a primitive into a text virtual node.
 * TODO(Этап 1): used by createElement's child-normalisation.
 */
export function createTextElement(_value: string | number): VNode {
  // TODO(Этап 1): implement
  return {
    type: TEXT_ELEMENT,
    props: { nodeValue: String(_value), children: [] },
  };
}
