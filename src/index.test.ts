import { describe, expect, it } from "vitest";
import { VERSION, TEXT_ELEMENT } from "./index.js";

describe("vdom-fiber package skeleton", () => {
  it("exposes a version marker", () => {
    expect(VERSION).toBe("0.0.0");
  });

  it("re-exports the TEXT_ELEMENT marker", () => {
    expect(TEXT_ELEMENT).toBe("TEXT_ELEMENT");
  });

  it("has a working jsdom environment for later DOM assertions", () => {
    // Sanity check that the test environment provides a real `document`, which
    // Stage 2+ tests will rely on to assert on rendered DOM trees.
    const el = document.createElement("div");
    el.textContent = "hello";
    expect(el.textContent).toBe("hello");
  });
});
