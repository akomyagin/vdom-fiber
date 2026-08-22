import { describe, expect, it, vi } from "vitest";
import { createElement as h } from "./createElement.js";
import {
  commitRoot,
  createWorkInProgress,
  performUnitOfWork,
  type Fiber,
} from "./fiber.js";
import { reconcile } from "./reconciler.js";
import { render } from "./render.js";
import type { VNode } from "./types.js";

/**
 * Test driver emulating the Stage 5 scheduler loop: build the WIP root, crank
 * `performUnitOfWork` until it returns null, then commit in one pass.
 */
function drainAndCommit(
  container: Element,
  prev: VNode | null,
  next: VNode | null,
): void {
  const root = createWorkInProgress(container, prev, next);
  let unit: Fiber | null = root;
  while (unit !== null) {
    unit = performUnitOfWork(unit);
  }
  commitRoot(root);
}

/** Fresh jsdom container mounted with `vnode` through the fiber pipeline. */
function mount(vnode: VNode): HTMLDivElement {
  const container = document.createElement("div");
  drainAndCommit(container, null, vnode);
  return container;
}

describe("fiber", () => {
  // 1
  it("обходит fiber-дерево в DFS-порядке: родитель → child → его дети → sibling", () => {
    const tree = h(
      "div",
      null,
      h("a", null),
      h("b", null, h("c", null)),
      h("d", null),
    );
    const container = document.createElement("div");
    const root = createWorkInProgress(container, null, tree);

    const visited: Fiber[] = [];
    let unit: Fiber | null = root;
    while (unit !== null) {
      visited.push(unit);
      unit = performUnitOfWork(unit);
    }

    // Host root первым (без type), дальше — обход в глубину.
    expect(visited[0]).toBe(root);
    expect(visited.slice(1).map((f) => f.type)).toEqual(["div", "a", "b", "c", "d"]);

    // Проверка на структуре fiber'ов: связи child/sibling/parent.
    const div = root.child!;
    const a = div.child!;
    const b = a.sibling!;
    const c = b.child!;
    const d = b.sibling!;
    expect([div.type, a.type, b.type, c.type, d.type]).toEqual([
      "div",
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(div.parent).toBe(root);
    expect(a.parent).toBe(div);
    expect(c.parent).toBe(b);
    expect(d.parent).toBe(div);
    expect(c.sibling).toBeNull();
    expect(d.sibling).toBeNull();
    expect(div.effectTag).toBe("PLACEMENT");
  });

  // 2
  it("mount с нуля: commit после полной прокрутки даёт тот же DOM, что render Этапа 2", () => {
    const tree = h(
      "div",
      { id: "app", class: "box" },
      h("h1", null, "title"),
      h("ul", null, h("li", null, "one"), h("li", null, "two")),
      "tail",
    );

    const viaFiber = mount(tree);
    const viaRender = document.createElement("div");
    render(tree, viaRender);

    expect(viaFiber.innerHTML).toBe(viaRender.innerHTML);
    expect(viaFiber.innerHTML).toContain("<h1>title</h1>");
  });

  // 3
  it("прерываемость: пошаговая прокрутка с сохранением указателя == непрерывная", () => {
    const prev = h("ul", null, h("li", null, "one"), h("li", null, "two"));
    const next = h(
      "ul",
      { class: "list" },
      h("li", null, "uno"),
      h("li", null, "two"),
      h("li", null, "three"),
    );

    const continuous = mount(prev);
    drainAndCommit(continuous, prev, next);

    const stepped = mount(prev);
    const htmlBefore = stepped.innerHTML;
    const root = createWorkInProgress(stepped, prev, next);
    // «Yield» после каждого fiber'а: между шагами указатель живёт только в
    // локальной переменной — состояние не должно теряться.
    let saved: Fiber | null = root;
    let steps = 0;
    while (saved !== null) {
      const resumeFrom: Fiber = saved;
      saved = performUnitOfWork(resumeFrom);
      steps += 1;
    }
    // Render-фаза чиста по отношению к DOM: до commit ничего не изменилось.
    expect(stepped.innerHTML).toBe(htmlBefore);
    commitRoot(root);

    expect(steps).toBeGreaterThan(1);
    expect(stepped.innerHTML).toBe(continuous.innerHTML);
    expect(stepped.innerHTML).toBe(
      '<ul class="list"><li>uno</li><li>two</li><li>three</li></ul>',
    );
  });

  // 4
  it("PLACEMENT: новый ребёнок появляется на правильной позиции, соседи не пересозданы", () => {
    const prev = h("ul", null, h("li", null, "one"), h("li", null, "two"));
    const next = h(
      "ul",
      null,
      h("li", null, "one"),
      h("li", null, "two"),
      h("li", null, "three"),
    );
    const container = mount(prev);
    const [li1, li2] = Array.from(container.querySelectorAll("li"));

    drainAndCommit(container, prev, next);

    expect(container.innerHTML).toBe("<ul><li>one</li><li>two</li><li>three</li></ul>");
    const lis = Array.from(container.querySelectorAll("li"));
    expect(lis[0]).toBe(li1);
    expect(lis[1]).toBe(li2);
  });

  // 5
  it("DELETION: лишний узел удалён, остальные на месте и не пересозданы", () => {
    const prev = h(
      "ul",
      null,
      h("li", null, "one"),
      h("li", null, "two"),
      h("li", null, "three"),
    );
    const next = h("ul", null, h("li", null, "one"), h("li", null, "two"));
    const container = mount(prev);
    const [li1, li2] = Array.from(container.querySelectorAll("li"));

    drainAndCommit(container, prev, next);

    expect(container.innerHTML).toBe("<ul><li>one</li><li>two</li></ul>");
    const lis = Array.from(container.querySelectorAll("li"));
    expect(lis[0]).toBe(li1);
    expect(lis[1]).toBe(li2);
  });

  // 6
  it("UPDATE props: атрибут обновлён, старый обработчик снят, новый навешен", () => {
    const oldClick = vi.fn();
    const newClick = vi.fn();
    const prev = h("button", { id: "b1", onClick: oldClick }, "go");
    const next = h("button", { id: "b2", onClick: newClick }, "go");
    const container = mount(prev);
    const button = container.querySelector("button")!;

    drainAndCommit(container, prev, next);

    expect(container.querySelector("button")).toBe(button); // тот же узел
    expect(button.getAttribute("id")).toBe("b2");
    button.click();
    expect(oldClick).not.toHaveBeenCalled();
    expect(newClick).toHaveBeenCalledTimes(1);
  });

  // 7
  it("UPDATE текста: nodeValue обновлён, текстовый узел не пересоздан", () => {
    const prev = h("p", null, "a");
    const next = h("p", null, "b");
    const container = mount(prev);
    const p = container.firstElementChild!;
    const textNode = p.firstChild!;

    drainAndCommit(container, prev, next);

    expect(container.innerHTML).toBe("<p>b</p>");
    expect(container.firstElementChild).toBe(p);
    expect(p.firstChild).toBe(textNode);
  });

  // 8
  it("смена типа → DELETION + PLACEMENT: div → span и элемент ↔ текст", () => {
    const prev = h(
      "div",
      null,
      h("div", { id: "old" }, "in"),
      h("p", null, h("i", null, "el")),
    );
    const next = h(
      "div",
      null,
      h("span", { id: "new" }, "in"),
      h("p", null, "just text"),
    );
    const container = mount(prev);
    const oldInner = container.querySelector("#old")!;
    const oldItalic = container.querySelector("i")!;

    drainAndCommit(container, prev, next);

    expect(container.innerHTML).toBe(
      '<div><span id="new">in</span><p>just text</p></div>',
    );
    expect(oldInner.isConnected).toBe(false); // старое поддерево удалено целиком
    expect(oldItalic.isConnected).toBe(false);
  });

  // 9
  it("UPDATE сохраняет идентичность DOM-узла (===) между коммитами", () => {
    const prev = h("section", { class: "a" }, h("p", null, "x"));
    const next = h("section", { class: "b" }, h("p", null, "y"));
    const container = mount(prev);
    const sectionBefore = container.firstElementChild!;
    const pBefore = container.querySelector("p")!;

    drainAndCommit(container, prev, next);

    expect(container.firstElementChild).toBe(sectionBefore);
    expect(container.querySelector("p")).toBe(pBefore);
    expect(container.innerHTML).toBe('<section class="b"><p>y</p></section>');
  });

  // 10
  it("keyed-переупорядочивание: узлы сохраняют идентичность, порядок корректен", () => {
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
    const container = mount(prev);
    const [liA, liB, liC] = Array.from(container.querySelectorAll("li"));

    drainAndCommit(container, prev, next);

    expect(container.innerHTML).toBe("<ul><li>c</li><li>a</li><li>b</li></ul>");
    const lis = Array.from(container.querySelectorAll("li"));
    expect(lis[0]).toBe(liC); // не пересозданы, а переставлены
    expect(lis[1]).toBe(liA);
    expect(lis[2]).toBe(liB);
  });

  // 11
  it("keyed insert/remove в середину: уцелевшие узлы сохраняют идентичность", () => {
    const abc = h(
      "ul",
      null,
      h("li", { key: "a" }, "a"),
      h("li", { key: "b" }, "b"),
      h("li", { key: "c" }, "c"),
    );
    const axbc = h(
      "ul",
      null,
      h("li", { key: "a" }, "a"),
      h("li", { key: "x" }, "x"),
      h("li", { key: "b" }, "b"),
      h("li", { key: "c" }, "c"),
    );
    const ac = h("ul", null, h("li", { key: "a" }, "a"), h("li", { key: "c" }, "c"));

    const container = mount(abc);
    const [liA, liB, liC] = Array.from(container.querySelectorAll("li"));

    drainAndCommit(container, abc, axbc);
    expect(container.innerHTML).toBe(
      "<ul><li>a</li><li>x</li><li>b</li><li>c</li></ul>",
    );
    let lis = Array.from(container.querySelectorAll("li"));
    expect(lis[0]).toBe(liA);
    expect(lis[2]).toBe(liB);
    expect(lis[3]).toBe(liC);

    drainAndCommit(container, axbc, ac);
    expect(container.innerHTML).toBe("<ul><li>a</li><li>c</li></ul>");
    lis = Array.from(container.querySelectorAll("li"));
    expect(lis[0]).toBe(liA);
    expect(lis[1]).toBe(liC);
    expect(liB!.isConnected).toBe(false);
  });

  // 12
  it("индексный режим без ключей: add/remove хвоста, неизменные узлы не пересозданы", () => {
    const ab = h("ul", null, h("li", null, "a"), h("li", null, "b"));
    const abc = h(
      "ul",
      null,
      h("li", null, "a"),
      h("li", null, "b"),
      h("li", null, "c"),
    );

    const container = mount(ab);
    const [liA, liB] = Array.from(container.querySelectorAll("li"));

    drainAndCommit(container, ab, abc);
    expect(container.innerHTML).toBe("<ul><li>a</li><li>b</li><li>c</li></ul>");
    let lis = Array.from(container.querySelectorAll("li"));
    expect(lis[0]).toBe(liA);
    expect(lis[1]).toBe(liB);

    drainAndCommit(container, abc, ab);
    expect(container.innerHTML).toBe("<ul><li>a</li><li>b</li></ul>");
    lis = Array.from(container.querySelectorAll("li"));
    expect(lis[0]).toBe(liA);
    expect(lis[1]).toBe(liB);
  });

  // 13
  it("вложенный UPDATE: глубокое изменение не пересоздаёт неизменных предков и сиблингов", () => {
    const prev = h(
      "div",
      { id: "app" },
      h("header", null, "hdr"),
      h("main", null, h("section", null, h("p", null, "old"))),
    );
    const next = h(
      "div",
      { id: "app" },
      h("header", null, "hdr"),
      h("main", null, h("section", null, h("p", null, "new"))),
    );
    const container = mount(prev);
    const div = container.firstElementChild!;
    const header = container.querySelector("header")!;
    const main = container.querySelector("main")!;
    const section = container.querySelector("section")!;
    const p = container.querySelector("p")!;

    drainAndCommit(container, prev, next);

    expect(container.querySelector("p")!.textContent).toBe("new");
    expect(container.firstElementChild).toBe(div);
    expect(container.querySelector("header")).toBe(header);
    expect(container.querySelector("main")).toBe(main);
    expect(container.querySelector("section")).toBe(section);
    expect(container.querySelector("p")).toBe(p);
  });

  // 14
  it("кросс-проверка: тот же innerHTML, что у синхронного reconcile Этапа 3", () => {
    const cases: Array<[VNode | null, VNode | null]> = [
      // mount с нуля
      [null, h("div", { class: "x" }, h("p", null, "hi"), "txt")],
      // индексный режим: перестановка содержимого + рост списка
      [
        h("ul", null, h("li", null, "1"), h("li", null, "2")),
        h("ul", null, h("li", null, "2"), h("li", null, "1"), h("li", null, "3")),
      ],
      // смена типа во вложенном ребёнке
      [
        h("div", null, h("div", null, "a")),
        h("div", null, h("span", { title: "t" }, "a")),
      ],
      // keyed-переупорядочивание
      [
        h("ul", null, h("li", { key: "a" }, "a"), h("li", { key: "b" }, "b")),
        h("ul", null, h("li", { key: "b" }, "b"), h("li", { key: "a" }, "a")),
      ],
      // unmount корня
      [h("p", { id: "q" }, "x"), null],
    ];

    for (const [prev, next] of cases) {
      const viaFiber = document.createElement("div");
      drainAndCommit(viaFiber, null, prev);
      drainAndCommit(viaFiber, prev, next);

      const viaSync = document.createElement("div");
      reconcile(viaSync, null, prev);
      reconcile(viaSync, prev, next);

      expect(viaFiber.innerHTML).toBe(viaSync.innerHTML);
    }
  });
});
