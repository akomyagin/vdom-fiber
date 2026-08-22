import { describe, expect, it, vi } from "vitest";
import { createElement as h } from "./createElement.js";
import { render } from "./render.js";

describe("render", () => {
  it("монтирует одиночный элемент с текстом", () => {
    const root = document.createElement("div");
    render(h("p", null, "hi"), root);
    expect(root.innerHTML).toBe("<p>hi</p>");
  });

  it("монтирует вложенное дерево с несколькими уровнями и детьми", () => {
    const root = document.createElement("div");
    render(
      h(
        "ul",
        { class: "menu" },
        h("li", null, h("a", { href: "/home" }, "Home")),
        h("li", null, "About"),
        h("li", null, "Contact"),
      ),
      root,
    );
    expect(root.innerHTML).toBe(
      '<ul class="menu"><li><a href="/home">Home</a></li><li>About</li><li>Contact</li></ul>',
    );
  });

  it("ставит обычные строковые атрибуты", () => {
    const root = document.createElement("div");
    render(h("input", { type: "text", placeholder: "Name", id: "name" }), root);
    const input = root.querySelector("input")!;
    expect(input.getAttribute("type")).toBe("text");
    expect(input.getAttribute("placeholder")).toBe("Name");
    expect(input.getAttribute("id")).toBe("name");
  });

  it("приводит нестроковые значения атрибутов к строке", () => {
    const root = document.createElement("div");
    render(h("input", { tabindex: 3 }), root);
    expect(root.querySelector("input")!.getAttribute("tabindex")).toBe("3");
  });

  it("value === true даёт булевый атрибут с пустым значением", () => {
    const root = document.createElement("div");
    render(h("button", { disabled: true }, "Go"), root);
    const button = root.querySelector("button")!;
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("disabled")).toBe("");
  });

  it("value === false не ставит атрибут вовсе", () => {
    const root = document.createElement("div");
    render(h("button", { disabled: false }, "Go"), root);
    expect(root.querySelector("button")!.hasAttribute("disabled")).toBe(false);
  });

  it("применяет style-объект с camelCase-свойствами", () => {
    const root = document.createElement("div");
    render(h("span", { style: { color: "red", fontSize: "12px" } }, "styled"), root);
    const span = root.querySelector("span")!;
    expect(span.style.color).toBe("red");
    expect(span.style.fontSize).toBe("12px");
    expect(span.style.getPropertyValue("font-size")).toBe("12px");
  });

  it("обработчик onClick срабатывает при клике", () => {
    const root = document.createElement("div");
    const onClick = vi.fn();
    render(h("button", { onClick }, "Click me"), root);
    const button = root.querySelector("button")!;
    button.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    button.click();
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("многословное имя события приводится к нижнему регистру целиком (onMouseEnter → mouseenter)", () => {
    const root = document.createElement("div");
    const onMouseEnter = vi.fn();
    render(h("div", { onMouseEnter }, "hover me"), root);
    root.querySelector("div")!.dispatchEvent(new Event("mouseenter"));
    expect(onMouseEnter).toHaveBeenCalledTimes(1);
  });

  it("обработчик получает объект события", () => {
    const root = document.createElement("div");
    const onClick = vi.fn();
    render(h("button", { onClick }, "x"), root);
    root.querySelector("button")!.click();
    const event = onClick.mock.calls[0]![0] as Event;
    expect(event).toBeInstanceOf(Event);
    expect(event.type).toBe("click");
  });

  it("монтирует несколько детей разных типов вперемешку (элементы и текст)", () => {
    const root = document.createElement("div");
    render(h("p", null, "Hello, ", h("b", null, "world"), "!"), root);
    expect(root.innerHTML).toBe("<p>Hello, <b>world</b>!</p>");
    const p = root.querySelector("p")!;
    expect(p.childNodes).toHaveLength(3);
    expect(p.childNodes[0]!.nodeType).toBe(Node.TEXT_NODE);
    expect(p.childNodes[1]!.nodeType).toBe(Node.ELEMENT_NODE);
    expect(p.childNodes[2]!.nodeType).toBe(Node.TEXT_NODE);
  });

  it("монтирует элемент без детей", () => {
    const root = document.createElement("div");
    render(h("hr", null), root);
    expect(root.innerHTML).toBe("<hr>");
  });

  it("пустое дерево: условные дети (null/false) отброшены, контейнер получает пустой элемент", () => {
    const root = document.createElement("div");
    render(h("div", { class: "empty" }, null, false, undefined), root);
    expect(root.innerHTML).toBe('<div class="empty"></div>');
    expect(root.querySelector("div")!.childNodes).toHaveLength(0);
  });

  it("не затирает уже существующее содержимое контейнера (append, не replace)", () => {
    const root = document.createElement("div");
    root.innerHTML = "<span>old</span>";
    render(h("p", null, "new"), root);
    expect(root.innerHTML).toBe("<span>old</span><p>new</p>");
  });

  it("кидает TypeError, если on-проп — не функция", () => {
    const root = document.createElement("div");
    expect(() => render(h("button", { onClick: "not a function" }), root)).toThrow(TypeError);
  });
});
