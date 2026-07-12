/**
 * Public entry point for vdom-fiber.
 *
 * Re-exports the pieces of the mini-React as each stage lands. Consumers import
 * from here; internal modules import each other directly.
 */
export { createElement, createElement as h } from "./createElement.js";
export { render } from "./render.js";
export { reconcile } from "./reconciler.js";
export { performUnitOfWork } from "./fiber.js";
export type { Fiber } from "./fiber.js";
export { scheduleWork, Priority } from "./scheduler.js";
export { useState } from "./hooks.js";
export { TEXT_ELEMENT } from "./types.js";
export type { VNode, VProps, VChild } from "./types.js";

/** Library version marker, handy for smoke tests and debugging. */
export const VERSION = "0.0.0";
