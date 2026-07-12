/**
 * Shared virtual-node types for the whole library.
 *
 * The design is intentionally close to React's internal shape so the later
 * stages (reconciler, fiber, scheduler) read naturally, but everything here is
 * hand-rolled — there is no React dependency anywhere in this project.
 */

/** A text node is represented by a special element type. */
export const TEXT_ELEMENT = "TEXT_ELEMENT" as const;

/**
 * The props bag every virtual node carries. `children` is always normalised to
 * an array of {@link VNode} by {@link createElement}, so downstream code never
 * has to deal with a bare string / number / nested-array child.
 */
export interface VProps {
  [key: string]: unknown;
  children: VNode[];
}

/**
 * A virtual DOM node. `type` is either an intrinsic tag name (`"div"`), the
 * special {@link TEXT_ELEMENT} marker, or — from Stage 6 onwards — a function
 * component. `nodeValue` only appears on text elements.
 */
export interface VNode {
  type: string;
  props: VProps;
}

/** Anything {@link createElement} accepts as a child before normalisation. */
export type VChild = VNode | string | number | boolean | null | undefined;
