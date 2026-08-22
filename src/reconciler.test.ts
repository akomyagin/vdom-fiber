import { describe, expect, it, vi } from "vitest";
import { createElement as h } from "./createElement.js";
import { reconcile } from "./reconciler.js";
import type { VNode } from "./types.js";

/** Mount `vnode` into a fresh container via reconcile(null → vnode). */
function mount(vnode: VNode): HTMLDivElement {
  const root = document.createElement("div");
  reconcile(root, null, vnode);
  return root;
}

describe("reconcile", () => {
  // 1
  it("обновляет текст узла на месте, не пересоздавая текстовый DOM-узел", () => {
    const prev = h("p", null, "a");
    const next = h("p", null, "b");
    const root = mount(prev);
    const p = root.firstElementChild!;
    const textNode = p.firstChild!;

    reconcile(root, prev, next);

    expect(root.innerHTML).toBe("<p>b</p>");
    expect(root.firstElementChild).toBe(p);
    expect(p.firstChild).toBe(textNode); // тот же текстовый узел, лишь data изменилась
  });

  // 2
  it("добавляет атрибут, которого не было", () => {
    const prev = h("p", null, "x");
    const next = h("p", { id: "para" }, "x");
    const root = mount(prev);

    reconcile(root, prev, next);

    expect(root.firstElementChild!.getAttribute("id")).toBe("para");
  });

  // 3
  it("удаляет атрибут, исчезнувший из props", () => {
    const prev = h("p", { id: "para" }, "x");
    const next = h("p", null, "x");
    const root = mount(prev);
    expect(root.firstElementChild!.getAttribute("id")).toBe("para");

    reconcile(root, prev, next);

    expect(root.firstElementChild!.getAttribute("id")).toBeNull();
  });

  // 4
  it("добавляет обработчик события: клик срабатывает после diff", () => {
    const onClick = vi.fn();
    const prev = h("button", null, "go");
    const next = h("button", { onClick }, "go");
    const root = mount(prev);
    const button = root.querySelector("button")!;
    button.click();
    expect(onClick).toHaveBeenCalledTimes(0);

    reconcile(root, prev, next);

    button.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  // 5
  it("удаляет обработчик события: старый больше не вызывается", () => {
    const onClick = vi.fn();
    const prev = h("button", { onClick }, "go");
    const next = h("button", null, "go");
    const root = mount(prev);
    const button = root.querySelector("button")!;
    button.click();
    expect(onClick).toHaveBeenCalledTimes(1);

    reconcile(root, prev, next);

    button.click();
    expect(onClick).toHaveBeenCalledTimes(1); // счётчик не вырос
  });

  // 6
  it("добавляет ребёнка в конец списка", () => {
    const prev = h("ul", null, h("li", null, "one"), h("li", null, "two"));
    const next = h("ul", null, h("li", null, "one"), h("li", null, "two"), h("li", null, "three"));
    const root = mount(prev);

    reconcile(root, prev, next);

    expect(root.innerHTML).toBe("<ul><li>one</li><li>two</li><li>three</li></ul>");
  });

  // 7
  it("удаляет детей из хвоста списка (в том числе нескольких)", () => {
    const prev = h("ul", null, h("li", null, "one"), h("li", null, "two"), h("li", null, "three"));
    const next = h("ul", null, h("li", null, "one"));
    const root = mount(prev);

    reconcile(root, prev, next);

    expect(root.innerHTML).toBe("<ul><li>one</li></ul>");
    expect(root.querySelector("ul")!.childNodes).toHaveLength(1);
  });

  // 8
  it("переупорядочивает детей (без ключей — через патч содержимого по индексу)", () => {
    const prev = h("ul", null, h("li", null, "one"), h("li", null, "two"));
    const next = h("ul", null, h("li", null, "two"), h("li", null, "one"));
    const root = mount(prev);

    reconcile(root, prev, next);

    expect(root.innerHTML).toBe("<ul><li>two</li><li>one</li></ul>");
  });

  // 9
  it("заменяет узел при смене типа: div → span и элемент ↔ текст", () => {
    const prev = h("div", { id: "keep-id?" }, "x");
    const next = h("span", null, "x");
    const root = mount(prev);
    const oldDiv = root.firstElementChild!;

    reconcile(root, prev, next);

    expect(root.innerHTML).toBe("<span>x</span>");
    expect(root.firstElementChild).not.toBe(oldDiv); // именно замена, не патч

    // элемент ↔ TEXT_ELEMENT в дочернем слоте
    const prev2 = h("p", null, h("b", null, "bold"));
    const next2 = h("p", null, "plain");
    const root2 = mount(prev2);
    reconcile(root2, prev2, next2);
    expect(root2.innerHTML).toBe("<p>plain</p>");
    expect(root2.querySelector("p")!.firstChild!.nodeType).toBe(Node.TEXT_NODE);
  });

  // 10
  it("сохраняет DOM-идентичность узла при патче props и детей", () => {
    const prev = h("div", { class: "a" }, h("p", null, "old"));
    const next = h("div", { class: "b" }, h("p", null, "new"));
    const root = mount(prev);
    const before = root.firstElementChild!;
    const beforeP = before.firstElementChild!;

    reconcile(root, prev, next);

    expect(root.firstElementChild).toBe(before); // === тот же объект Node
    expect(root.firstElementChild!.firstElementChild).toBe(beforeP);
    expect(root.innerHTML).toBe('<div class="b"><p>new</p></div>');
  });

  // 11
  it("обновляет обработчик: старый снят по ссылке из prev.props, новый работает", () => {
    const oldHandler = vi.fn();
    const newHandler = vi.fn();
    const prev = h("button", { onClick: oldHandler }, "go");
    const next = h("button", { onClick: newHandler }, "go");
    const root = mount(prev);
    const button = root.querySelector("button")!;

    reconcile(root, prev, next);

    button.click();
    expect(oldHandler).toHaveBeenCalledTimes(0);
    expect(newHandler).toHaveBeenCalledTimes(1);
  });

  // 12
  it("обновляет значение существующего атрибута", () => {
    const prev = h("a", { id: "old", class: "x" }, "link");
    const next = h("a", { id: "new", class: "x" }, "link");
    const root = mount(prev);

    reconcile(root, prev, next);

    const a = root.querySelector("a")!;
    expect(a.getAttribute("id")).toBe("new");
    expect(a.getAttribute("class")).toBe("x");
  });

  // 13
  it("диффит style: исчезнувшее свойство сброшено, изменившееся обновлено, неизменное на месте", () => {
    const prev = h("span", { style: { color: "red", fontSize: "12px", fontWeight: "bold" } }, "s");
    const next = h("span", { style: { color: "blue", fontWeight: "bold" } }, "s");
    const root = mount(prev);
    const span = root.querySelector("span")!;
    expect(span.style.fontSize).toBe("12px");

    reconcile(root, prev, next);

    expect(span.style.color).toBe("blue"); // изменилось
    expect(span.style.fontSize).toBe(""); // исчезло — сброшено
    expect(span.style.fontWeight).toBe("bold"); // неизменное сохранено

    // style целиком исчез из next → все ранее заданные свойства сброшены
    const next2 = h("span", null, "s");
    reconcile(root, next, next2);
    expect(span.style.color).toBe("");
    expect(span.style.fontWeight).toBe("");
  });

  // 14
  it("булевы атрибуты: true→false снимает, false→true ставит", () => {
    const prev = h("button", { disabled: true }, "go");
    const next = h("button", { disabled: false }, "go");
    const root = mount(prev);
    const button = root.querySelector("button")!;
    expect(button.hasAttribute("disabled")).toBe(true);

    reconcile(root, prev, next);
    expect(button.hasAttribute("disabled")).toBe(false);

    reconcile(root, next, prev); // обратный переход false → true
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("disabled")).toBe("");
  });

  // 15
  it("prev == null монтирует дерево, next == null удаляет корень из контейнера", () => {
    const root = document.createElement("div");
    const tree = h("div", { class: "app" }, h("p", null, "hello"));

    reconcile(root, null, tree); // mount — как render
    expect(root.innerHTML).toBe('<div class="app"><p>hello</p></div>');

    reconcile(root, tree, null); // полное удаление
    expect(root.innerHTML).toBe("");
    expect(root.childNodes).toHaveLength(0);
  });

  // 16
  it("keyed: переупорядочивание [a,b,c] → [c,a,b] сохраняет DOM-идентичность узлов", () => {
    const prev = h(
      "ul",
      null,
      h("li", { key: "a" }, "a"),
      h("li", { key: "b" }, "b"),
      h("li", { key: "c" }, "c"),
    );
    const next = h(
      "ul",
      null,
      h("li", { key: "c" }, "c"),
      h("li", { key: "a" }, "a"),
      h("li", { key: "b" }, "b"),
    );
    const root = mount(prev);
    const [liA, liB, liC] = Array.from(root.querySelectorAll("li"));

    reconcile(root, prev, next);

    expect(root.innerHTML).toBe("<ul><li>c</li><li>a</li><li>b</li></ul>");
    const after = Array.from(root.querySelectorAll("li"));
    expect(after[0]).toBe(liC); // не пересозданы — перемещены
    expect(after[1]).toBe(liA);
    expect(after[2]).toBe(liB);
  });

  // 17
  it("keyed: вставка и удаление в середине сохраняют идентичность уцелевших узлов", () => {
    const prev = h(
      "ul",
      null,
      h("li", { key: "a" }, "a"),
      h("li", { key: "b" }, "b"),
      h("li", { key: "c" }, "c"),
    );
    const inserted = h(
      "ul",
      null,
      h("li", { key: "a" }, "a"),
      h("li", { key: "x" }, "x"),
      h("li", { key: "b" }, "b"),
      h("li", { key: "c" }, "c"),
    );
    const root = mount(prev);
    const [liA, liB, liC] = Array.from(root.querySelectorAll("li"));

    reconcile(root, prev, inserted); // [a,b,c] → [a,x,b,c]
    expect(root.innerHTML).toBe("<ul><li>a</li><li>x</li><li>b</li><li>c</li></ul>");
    let after = Array.from(root.querySelectorAll("li"));
    expect(after[0]).toBe(liA);
    expect(after[2]).toBe(liB);
    expect(after[3]).toBe(liC);

    const removedMiddle = h("ul", null, h("li", { key: "a" }, "a"), h("li", { key: "c" }, "c"));
    reconcile(root, inserted, removedMiddle); // [a,x,b,c] → [a,c]
    expect(root.innerHTML).toBe("<ul><li>a</li><li>c</li></ul>");
    after = Array.from(root.querySelectorAll("li"));
    expect(after[0]).toBe(liA);
    expect(after[1]).toBe(liC);
  });

  // 17b (фикс находки ревью: дублирующиеся key в prev не теряют узел)
  it("keyed: дублирующийся key в prev не оставляет осиротевший DOM-узел", () => {
    const onClickDup = vi.fn();
    const prev = h(
      "ul",
      null,
      h("li", { key: "a", onClick: onClickDup }, "a1"),
      h("li", { key: "a", onClick: onClickDup }, "a2"),
      h("li", { key: "b" }, "b"),
    );
    const next = h("ul", null, h("li", { key: "a" }, "a1"), h("li", { key: "b" }, "b"));
    const root = mount(prev);

    reconcile(root, prev, next);

    // Второй дубль ("a2") должен быть удалён, а не остаться в DOM.
    expect(root.innerHTML).toBe("<ul><li>a1</li><li>b</li></ul>");
    expect(root.querySelectorAll("li")).toHaveLength(2);
  });

  // 18
  it("рекурсивный патч: изменение в глубине не пересоздаёт предков и сиблингов", () => {
    const prev = h(
      "div",
      null,
      h("header", null, "static"),
      h("ul", null, h("li", null, "one"), h("li", null, "two")),
    );
    const next = h(
      "div",
      null,
      h("header", null, "static"),
      h("ul", null, h("li", null, "one"), h("li", null, "TWO")),
    );
    const root = mount(prev);
    const div = root.firstElementChild!;
    const header = div.children[0]!;
    const ul = div.children[1]!;
    const liOne = ul.children[0]!;
    const liTwo = ul.children[1]!;

    reconcile(root, prev, next);

    expect(root.innerHTML).toBe(
      "<div><header>static</header><ul><li>one</li><li>TWO</li></ul></div>",
    );
    expect(root.firstElementChild).toBe(div);
    expect(div.children[0]).toBe(header);
    expect(div.children[1]).toBe(ul);
    expect(ul.children[0]).toBe(liOne);
    expect(ul.children[1]).toBe(liTwo); // сам li тоже сохранён, изменился только текст
  });

  // 19
  it("индексный режим без ключей: add/remove хвоста не пересоздаёт неизменные узлы", () => {
    const two = h("ul", null, h("li", null, "a"), h("li", null, "b"));
    const three = h("ul", null, h("li", null, "a"), h("li", null, "b"), h("li", null, "c"));
    const root = mount(two);
    const [liA, liB] = Array.from(root.querySelectorAll("li"));

    reconcile(root, two, three); // [a,b] → [a,b,c]
    expect(root.innerHTML).toBe("<ul><li>a</li><li>b</li><li>c</li></ul>");
    let after = Array.from(root.querySelectorAll("li"));
    expect(after[0]).toBe(liA);
    expect(after[1]).toBe(liB);

    reconcile(root, three, two); // [a,b,c] → [a,b]
    expect(root.innerHTML).toBe("<ul><li>a</li><li>b</li></ul>");
    after = Array.from(root.querySelectorAll("li"));
    expect(after[0]).toBe(liA);
    expect(after[1]).toBe(liB);
  });

  // 20
  it("смешанный список (часть с key, часть без) падает в индексный режим и даёт корректный DOM", () => {
    const prev = h("ul", null, h("li", { key: "a" }, "a"), h("li", null, "b"));
    const next = h("ul", null, h("li", null, "b"), h("li", { key: "a" }, "a"));
    const root = mount(prev);
    const [li0, li1] = Array.from(root.querySelectorAll("li"));

    reconcile(root, prev, next);

    // Индексный режим: узлы остались на своих позициях, содержимое перепатчено.
    expect(root.innerHTML).toBe("<ul><li>b</li><li>a</li></ul>");
    const after = Array.from(root.querySelectorAll("li"));
    expect(after[0]).toBe(li0);
    expect(after[1]).toBe(li1);
  });

  // Сохранение правила Этапа 2 в единой patchProps: не-функция под on* — TypeError.
  it("кидает TypeError при обновлении, если on-проп — не функция", () => {
    const prev = h("button", null, "go");
    const next = h("button", { onClick: "not a function" }, "go");
    const root = mount(prev);

    expect(() => reconcile(root, prev, next)).toThrow(TypeError);
  });
});
