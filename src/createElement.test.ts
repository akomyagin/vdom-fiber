import { describe, expect, it } from "vitest";
import { createElement, createTextElement } from "./createElement.js";
import { TEXT_ELEMENT, type VNode } from "./types.js";

/** Shorthand for the expected shape of a text node in assertions. */
function text(value: string): VNode {
  return {
    type: TEXT_ELEMENT,
    props: { nodeValue: value, children: [] },
  };
}

describe("createElement", () => {
  it("builds a plain element with no props and no children", () => {
    expect(createElement("div")).toEqual({
      type: "div",
      props: { children: [] },
    });
  });

  it("builds an element with explicit null props", () => {
    expect(createElement("span", null)).toEqual({
      type: "span",
      props: { children: [] },
    });
  });

  it("preserves regular props alongside normalised children", () => {
    const node = createElement(
      "a",
      { href: "/docs", id: "docs-link", tabIndex: 0 },
      "Docs",
    );
    expect(node.type).toBe("a");
    expect(node.props.href).toBe("/docs");
    expect(node.props.id).toBe("docs-link");
    expect(node.props.tabIndex).toBe(0);
    expect(node.props.children).toEqual([text("Docs")]);
  });

  it("does not let a `children` key in props override normalised children", () => {
    const node = createElement("ul", { children: "bogus" }, createElement("li"));
    expect(node.props.children).toEqual([{ type: "li", props: { children: [] } }]);
  });

  it("wraps string and number children in TEXT_ELEMENT nodes", () => {
    const node = createElement("p", null, "count: ", 42, 0);
    expect(node.props.children).toEqual([text("count: "), text("42"), text("0")]);
  });

  it("drops null, undefined and boolean children", () => {
    const node = createElement(
      "div",
      null,
      null,
      undefined,
      true,
      false,
      createElement("span"),
    );
    expect(node.props.children).toEqual([
      { type: "span", props: { children: [] } },
    ]);
  });

  it("flattens nested child arrays, including deeply nested ones", () => {
    const items = ["a", "b"].map((label) => createElement("li", null, label));
    const node = createElement(
      "ul",
      null,
      items,
      [null, ["c", [false, 7]]],
      createElement("li", { key: "last" }),
    );
    expect(node.props.children).toEqual([
      { type: "li", props: { children: [text("a")] } },
      { type: "li", props: { children: [text("b")] } },
      text("c"),
      text("7"),
      { type: "li", props: { key: "last", children: [] } },
    ]);
  });

  it("builds a nested tree with the expected overall shape", () => {
    const tree = createElement(
      "div",
      { id: "app" },
      createElement(
        "h1",
        { class: "title" },
        "Hello, ",
        createElement("em", null, "world"),
      ),
      createElement("input", { type: "text", value: "" }),
    );
    expect(tree).toEqual({
      type: "div",
      props: {
        id: "app",
        children: [
          {
            type: "h1",
            props: {
              class: "title",
              children: [
                text("Hello, "),
                { type: "em", props: { children: [text("world")] } },
              ],
            },
          },
          {
            type: "input",
            props: { type: "text", value: "", children: [] },
          },
        ],
      },
    });
  });
});

describe("createTextElement", () => {
  it("wraps a string into a TEXT_ELEMENT node", () => {
    expect(createTextElement("hi")).toEqual(text("hi"));
  });

  it("stringifies numbers, including 0", () => {
    expect(createTextElement(42)).toEqual(text("42"));
    expect(createTextElement(0)).toEqual(text("0"));
  });
});
