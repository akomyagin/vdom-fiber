import { afterEach, describe, expect, it } from "vitest";
import { createElement as h } from "./createElement.js";
import { useEffect, useState } from "./hooks.js";
import { Priority, __setSchedulerDeps, scheduleWork } from "./scheduler.js";
import type { VNode, VProps } from "./types.js";

/**
 * Stage 6 tests: function components + `useState`, asserted on the final DOM.
 *
 * All renders here are short, so the scheduler's synchronicity contract makes
 * them commit inside `scheduleWork` (and inside the click handler for setState
 * re-renders): frozen clock + huge budget = never yields, fully deterministic.
 */
function installSyncDeps(): void {
  __setSchedulerDeps({
    now: () => 0,
    scheduleTick: () => {},
    frameBudgetMs: 1_000,
  });
}

/** Fresh container mounted with `vnode` through the full fiber pipeline. */
function mount(vnode: VNode): HTMLDivElement {
  const container = document.createElement("div");
  scheduleWork(container, vnode, Priority.Normal);
  return container;
}

describe("hooks / function components", () => {
  afterEach(() => {
    // Restore default deps AND wipe the scheduler's module-level state.
    __setSchedulerDeps({})();
  });

  // 1. Начальный рендер функционального компонента с useState.
  it("начальный рендер: DOM отражает начальное состояние useState", () => {
    installSyncDeps();
    function Counter(): VNode {
      const [count] = useState(42);
      return h("p", null, `count:${count}`);
    }

    const container = mount(h(Counter, null));

    expect(container.innerHTML).toBe("<p>count:42</p>");
  });

  it("компонент получает props (включая children)", () => {
    installSyncDeps();
    function Greeting(props: VProps): VNode {
      return h("p", { class: "hi" }, `hello, ${props.name as string}`, props.children);
    }

    const container = mount(h(Greeting, { name: "fiber" }, h("em", null, "!")));

    expect(container.innerHTML).toBe('<p class="hi">hello, fiber<em>!</em></p>');
  });

  it("компонент, вернувший null, ничего не рендерит", () => {
    installSyncDeps();
    function Nothing(): VNode | null {
      return null;
    }

    const container = mount(h("div", null, h(Nothing, null)));

    expect(container.innerHTML).toBe("<div></div>");
  });

  // 2. setState обновляет DOM.
  it("setState по клику обновляет DOM через собственный конвейер", () => {
    installSyncDeps();
    function Counter(): VNode {
      const [count, setCount] = useState(0);
      return h("button", { onClick: () => setCount(count + 1) }, `n:${count}`);
    }

    const container = mount(h(Counter, null));
    expect(container.innerHTML).toBe("<button>n:0</button>");

    container.querySelector("button")!.click();
    expect(container.innerHTML).toBe("<button>n:1</button>");
  });

  // 3. Несколько независимых состояний в одном компоненте.
  it("два useState в одном компоненте независимы, индексы не путаются", () => {
    installSyncDeps();
    function Form(): VNode {
      const [count, setCount] = useState(1);
      const [text, setText] = useState("x");
      return h(
        "div",
        null,
        h("button", { id: "a", onClick: () => setCount(count + 1) }, `a:${count}`),
        h("button", { id: "b", onClick: () => setText(`${text}!`) }, `b:${text}`),
      );
    }

    const container = mount(h(Form, null));
    expect(container.textContent).toBe("a:1b:x");

    (container.querySelector("#a") as HTMLButtonElement).click();
    expect(container.textContent).toBe("a:2b:x"); // b не затёрт

    (container.querySelector("#b") as HTMLButtonElement).click();
    expect(container.textContent).toBe("a:2b:x!"); // a не затёрт
  });

  // 4. Функциональный апдейтер setState(prev => next).
  it("два setState(c => c + 1) подряд дают +2: апдейтер видит актуальный prev", () => {
    installSyncDeps();
    function Counter(): VNode {
      const [count, setCount] = useState(0);
      return h(
        "button",
        {
          onClick: () => {
            setCount((c) => c + 1);
            setCount((c) => c + 1);
          },
        },
        String(count),
      );
    }

    const container = mount(h(Counter, null));
    container.querySelector("button")!.click();

    expect(container.innerHTML).toBe("<button>2</button>");
  });

  // 5. Функциональный компонент как корень дерева.
  it("компонент-корень прозрачен: host-узлы результата лежат прямо в контейнере", () => {
    installSyncDeps();
    function App(): VNode {
      return h("main", { id: "root" }, h("p", null, "content"));
    }

    const container = mount(h(App, null));

    // host-parent — сам контейнер; фибер компонента не даёт своего узла.
    expect(container.childNodes.length).toBe(1);
    expect(container.innerHTML).toBe('<main id="root"><p>content</p></main>');
  });

  // 6. Компонент, рендерящий другой компонент; хуки не пересекаются.
  it("вложенные компоненты: состояния Outer и Inner независимы", () => {
    installSyncDeps();
    function Inner(): VNode {
      const [n, setN] = useState(10);
      return h("button", { id: "inner", onClick: () => setN(n + 1) }, `inner:${n}`);
    }
    function Outer(): VNode {
      const [n, setN] = useState(0);
      return h(
        "div",
        null,
        h("button", { id: "outer", onClick: () => setN(n + 1) }, `outer:${n}`),
        h(Inner, null),
      );
    }

    const container = mount(h(Outer, null));
    expect(container.textContent).toBe("outer:0inner:10");

    (container.querySelector("#inner") as HTMLButtonElement).click();
    expect(container.textContent).toBe("outer:0inner:11");

    (container.querySelector("#outer") as HTMLButtonElement).click();
    expect(container.textContent).toBe("outer:1inner:11"); // inner пережил рендер Outer
  });

  // 7. Компонент среди host-детей: позиционирование в координатах host-родителя.
  it("компонент между host-соседями: его host-узлы встают ровно между ними", () => {
    installSyncDeps();
    const Widget = (): VNode => h("em", null, "w");
    const tree = h(
      "div",
      null,
      h("span", null, "a"),
      h(Widget, null),
      h("span", null, "b"),
    );

    const container = mount(tree);
    expect(container.innerHTML).toBe("<div><span>a</span><em>w</em><span>b</span></div>");

    // Повторный рендер того же дерева: порядок стабилен, узлы не пересозданы.
    const [spanA, spanB] = Array.from(container.querySelectorAll("span"));
    const em = container.querySelector("em")!;
    scheduleWork(container, tree, Priority.Normal);
    expect(container.innerHTML).toBe("<div><span>a</span><em>w</em><span>b</span></div>");
    const spans = Array.from(container.querySelectorAll("span"));
    expect(spans[0]).toBe(spanA);
    expect(spans[1]).toBe(spanB);
    expect(container.querySelector("em")).toBe(em);
  });

  // 8. Обновление внутри компонента сохраняет DOM-identity неизменённых узлов.
  it("setState меняет только текст: соседние host-узлы компонента не пересозданы", () => {
    installSyncDeps();
    function Counter(): VNode {
      const [count, setCount] = useState(0);
      return h(
        "div",
        null,
        h("span", { class: "static" }, "static"),
        h("button", { onClick: () => setCount(count + 1) }, String(count)),
      );
    }

    const container = mount(h(Counter, null));
    const div = container.querySelector("div")!;
    const span = container.querySelector("span")!;
    const button = container.querySelector("button")!;
    const textNode = button.firstChild!;

    button.click();

    expect(container.textContent).toBe("static1");
    expect(container.querySelector("div")).toBe(div);
    expect(container.querySelector("span")).toBe(span);
    expect(container.querySelector("button")).toBe(button);
    expect(button.firstChild).toBe(textNode); // текст обновлён in-place
  });

  // 9. DELETION компонентного поддерева.
  it("удаление компонента из дерева убирает все его host-узлы", () => {
    installSyncDeps();
    const Widget = (): VNode => h("p", { id: "w" }, "widget");
    const withWidget = h(
      "div",
      null,
      h("span", null, "a"),
      h(Widget, null),
      h("span", null, "b"),
    );
    const withoutWidget = h("div", null, h("span", null, "a"), h("span", null, "b"));

    const container = mount(withWidget);
    const widgetDom = container.querySelector("#w")!;
    const spanA = container.querySelector("span")!;

    scheduleWork(container, withoutWidget, Priority.Normal);

    expect(container.innerHTML).toBe("<div><span>a</span><span>b</span></div>");
    expect(container.contains(widgetDom)).toBe(false);
    expect(container.querySelector("span")).toBe(spanA); // сосед не пересоздан
  });

  it("cond && h(Comp) → false внутри компонента удаляет host-узлы ребёнка", () => {
    installSyncDeps();
    const Widget = (): VNode => h("p", { id: "w" }, "widget");
    function Toggle(): VNode {
      const [on, setOn] = useState(true);
      return h(
        "div",
        null,
        h("button", { onClick: () => setOn(false) }, "off"),
        on && h(Widget, null),
      );
    }

    const container = mount(h(Toggle, null));
    const widgetDom = container.querySelector("#w")!;
    expect(container.contains(widgetDom)).toBe(true);

    container.querySelector("button")!.click();

    expect(container.querySelector("#w")).toBeNull();
    expect(container.contains(widgetDom)).toBe(false);
    expect(container.innerHTML).toBe("<div><button>off</button></div>");
  });

  // 10. setState из первого рендера доносит обновления после нескольких рендеров.
  it("setState, захваченный в первом рендере, работает после многих обновлений", () => {
    installSyncDeps();
    let firstSetCount: ((action: number | ((prev: number) => number)) => void) | null =
      null;
    function Counter(): VNode {
      const [count, setCount] = useState(0);
      // Захватываем сеттер ИМЕННО первого рендера — identity очереди хука
      // должна пережить пересоздание fiber'ов (WIP ↔ alternate).
      firstSetCount ??= setCount;
      return h("p", null, String(count));
    }

    const container = mount(h(Counter, null));

    firstSetCount!((c) => c + 1);
    expect(container.innerHTML).toBe("<p>1</p>");
    firstSetCount!((c) => c + 1);
    expect(container.innerHTML).toBe("<p>2</p>");
    firstSetCount!(10);
    firstSetCount!((c) => c + 5);
    expect(container.innerHTML).toBe("<p>15</p>");
  });

  // 11. Демо-счётчик end-to-end (DoD этапа).
  it("демо-счётчик: клики по кнопке обновляют DOM через VDOM + Fiber + scheduler + hooks", () => {
    installSyncDeps();
    function CounterApp(): VNode {
      const [count, setCount] = useState(0);
      return h(
        "div",
        { class: "counter" },
        h("p", null, `Count: ${count}`),
        h("button", { onClick: () => setCount((c) => c + 1) }, "+1"),
      );
    }

    const container = mount(h(CounterApp, null));
    expect(container.querySelector("p")!.textContent).toBe("Count: 0");

    const button = container.querySelector("button")!;
    button.click();
    button.click();
    button.dispatchEvent(new Event("click"));

    expect(container.querySelector("p")!.textContent).toBe("Count: 3");
    expect(container.innerHTML).toBe(
      '<div class="counter"><p>Count: 3</p><button>+1</button></div>',
    );
  });

  // Регресс (2-й цикл ревью): render-фаза не должна мутировать Hook-объекты,
  // разделяемые по ссылке с закоммиченным current-деревом. До фикса useState
  // дренировал очередь хука прямо при рендере — отброшенный вытеснением WIP
  // оставлял след в current-дереве, нарушая инвариант Этапа 5 «прерванный /
  // непрокоммиченный render не оставляет следов, откат бесплатен и безопасен».
  it("вытесненный рендер не дренирует очередь хука закоммиченного дерева", () => {
    // Управляемые deps: шагающие часы (только когда stepping) растягивают
    // рендер на несколько тиков; замороженные — коммитят синхронно.
    let stepping = false;
    let clock = 0;
    const ticks: Array<() => void> = [];
    __setSchedulerDeps({
      now: () => (stepping ? clock++ : 0),
      scheduleTick: (cb) => ticks.push(cb),
      frameBudgetMs: 3,
    });

    // Каждый ВЫЗОВ апдейтера фиксирует увиденный prev: это прямой свидетель
    // того, в каком рендере обновление реально применялось из очереди.
    const seenPrev: number[] = [];
    let capturedSetCount:
      | ((action: number | ((prev: number) => number)) => void)
      | null = null;
    function Counter(): VNode {
      const [count, setCount] = useState(0);
      capturedSetCount ??= setCount;
      return h("p", { id: "c" }, `c:${count}`);
    }
    const Widget = (): VNode => h("em", { id: "w" }, "w");

    const spans = Array.from({ length: 8 }, (_, i) => h("span", null, `s${i}`));
    const treeA = h("div", null, h(Counter, null), h(Widget, null), ...spans);
    // Вытесняющее дерево меняет форму: Widget обёрнут в section — по индексному
    // матчингу старый Widget размонтируется и монтируется заново В ЭТОМ ЖЕ
    // обновлении (сценарий ревью), а Counter в слоте 0 переживает вытеснение
    // и несёт durable-хук с очередью.
    const treeB = h("div", null, h(Counter, null), h("section", null, h(Widget, null)));

    const container = document.createElement("div");
    scheduleWork(container, treeA, Priority.Normal); // часы заморожены → синхронно
    expect(container.querySelector("#c")!.textContent).toBe("c:0");
    const oldWidgetDom = container.querySelector("#w")!;

    // Длинный Normal-рендер от setState, растянутый на тики.
    stepping = true;
    capturedSetCount!((prev) => {
      seenPrev.push(prev);
      return prev + 1;
    });
    // Прокрутить тики ровно до точки, где WIP-рендер уже вычислил состояние
    // Counter (апдейтер вызван), но commit ещё не случился.
    while (seenPrev.length === 0) {
      expect(ticks.length).toBeGreaterThan(0);
      ticks.shift()!();
    }
    expect(seenPrev).toEqual([0]); // деривация прошла в WIP...
    expect(container.querySelector("#c")!.textContent).toBe("c:0"); // ...но НЕ в DOM

    // Вытеснение ДО commit: более приоритетное обновление того же контейнера
    // выбрасывает недостроенный WIP.
    stepping = false;
    scheduleWork(container, treeB, Priority.UserBlocking);

    // Доказательство фикса: обновление НЕ потеряно. Очередь durable-хука
    // пережила отброшенный рендер, и применил её именно ЗАКОММИЧЕННЫЙ
    // вытесняющий рендер — второй вызов апдейтера с тем же prev = 0. До фикса
    // drain происходил в отброшенном рендере прямо на хуке current-дерева:
    // seenPrev остался бы [0], т.е. ни один закоммиченный рендер обновление
    // из очереди не применял бы.
    expect(seenPrev).toEqual([0, 0]);
    expect(container.querySelector("#c")!.textContent).toBe("c:1");
    // Смена формы применена: Widget размонтирован и смонтирован заново.
    expect(container.querySelector("section")).not.toBeNull();
    expect(container.contains(oldWidgetDom)).toBe(false);
    expect(container.querySelector("#w")).not.toBeNull();
    expect(container.querySelectorAll("span").length).toBe(0);

    // Отставшие тики отброшенного рендера безвредны.
    while (ticks.length > 0) {
      ticks.shift()!();
    }
    expect(container.querySelector("#c")!.textContent).toBe("c:1");
    expect(seenPrev).toEqual([0, 0]);
  });

  // Регресс (2-й цикл ревью): снимок `applied` в commit-фазе. setState,
  // пришедший МЕЖДУ render и commit, должен остаться в очереди для следующего
  // рендера — не потеряться (commit срезает ровно applied элементов, не всю
  // очередь) и не задвоиться.
  it("setState между render и commit не теряется и не задваивается", () => {
    let stepping = false;
    let clock = 0;
    const ticks: Array<() => void> = [];
    __setSchedulerDeps({
      now: () => (stepping ? clock++ : 0),
      scheduleTick: (cb) => ticks.push(cb),
      frameBudgetMs: 3,
    });

    const seenPrev: number[] = [];
    let capturedSetCount:
      | ((action: number | ((prev: number) => number)) => void)
      | null = null;
    function Counter(): VNode {
      const [count, setCount] = useState(0);
      capturedSetCount ??= setCount;
      return h("p", { id: "c" }, `c:${count}`);
    }
    const spans = Array.from({ length: 8 }, (_, i) => h("span", null, `s${i}`));
    const tree = h("div", null, h(Counter, null), ...spans);

    const container = document.createElement("div");
    scheduleWork(container, tree, Priority.Normal); // синхронный mount
    expect(container.querySelector("#c")!.textContent).toBe("c:0");

    stepping = true;
    capturedSetCount!((prev) => {
      seenPrev.push(prev);
      return prev + 1;
    });
    // Докрутить до точки «Counter отрендерен в WIP, commit впереди»…
    while (seenPrev.length === 0) {
      expect(ticks.length).toBeGreaterThan(0);
      ticks.shift()!();
    }
    expect(container.querySelector("#c")!.textContent).toBe("c:0");
    // …и в этом окне поставить второе обновление: оно НЕ вошло в снимок
    // текущего WIP и обязано пережить его commit в очереди.
    capturedSetCount!((prev) => {
      seenPrev.push(prev);
      return prev + 10;
    });

    // Прокрутить конвейер до покоя: первый рендер коммитится (+1), затем
    // отложенный re-render применяет второе обновление (+10).
    while (ticks.length > 0) {
      ticks.shift()!();
    }

    expect(container.querySelector("#c")!.textContent).toBe("c:11");
    // Каждый апдейтер применён закоммиченным рендером ровно один раз:
    // первый видел prev=0, второй — prev=1 (итог первого коммита).
    expect(seenPrev).toEqual([0, 1]);
  });

  // Rules of hooks: вызов вне рендера компонента — явная ошибка.
  it("useState вне рендера компонента бросает понятную ошибку", () => {
    expect(() => useState(0)).toThrowError(/outside of a function component/);
  });
});

describe("useEffect (Post-MVP §1)", () => {
  afterEach(() => {
    __setSchedulerDeps({})();
  });

  type Setter<S> = (action: S | ((prev: S) => S)) => void;

  // 1. Эффект запускается ПОСЛЕ commit, не до: он видит уже обновлённый DOM.
  it("эффект запускается после commit и видит обновлённый DOM", () => {
    installSyncDeps();
    const log: Array<string | null | undefined> = [];
    const container = document.createElement("div");
    function App(): VNode {
      useEffect(() => {
        log.push(container.querySelector("p")?.textContent);
      });
      return h("p", null, "ready");
    }

    scheduleWork(container, h(App, null), Priority.Normal);

    // Ровно один запуск после единственного commit; DOM к моменту запуска
    // уже содержал результат рендера (эффект не выполнялся во время render).
    expect(log).toEqual(["ready"]);
  });

  // 2. deps === [] → эффект ровно один раз (mount only).
  it("deps=[]: эффект выполняется один раз, повторные рендеры его не перезапускают", () => {
    installSyncDeps();
    let runs = 0;
    function App(): VNode {
      const [n, setN] = useState(0);
      useEffect(() => {
        runs++;
      }, []);
      return h("button", { onClick: () => setN(n + 1) }, `n:${n}`);
    }

    const container = mount(h(App, null));
    expect(runs).toBe(1);

    container.querySelector("button")!.click();
    expect(container.innerHTML).toBe("<button>n:1</button>");
    expect(runs).toBe(1);
  });

  // 3. deps === undefined → эффект на каждый commit.
  it("без массива deps эффект запускается на каждый commit", () => {
    installSyncDeps();
    let runs = 0;
    function App(): VNode {
      const [n, setN] = useState(0);
      useEffect(() => {
        runs++;
      });
      return h("button", { onClick: () => setN(n + 1) }, `n:${n}`);
    }

    const container = mount(h(App, null));
    expect(runs).toBe(1);

    container.querySelector("button")!.click();
    expect(runs).toBe(2);
  });

  // 4. Изменившийся dep → cleanup предыдущего, затем новый запуск;
  //    неизменившийся — пропуск.
  it("смена deps: cleanup прежнего запуска перед новым; равные deps — пропуск", () => {
    installSyncDeps();
    const log: string[] = [];
    let setDep: Setter<number> | null = null;
    let setOther: Setter<number> | null = null;
    function App(): VNode {
      const [dep, sd] = useState(0);
      const [other, so] = useState(0);
      setDep = sd;
      setOther = so;
      useEffect(() => {
        log.push("run");
        return () => log.push("cleanup");
      }, [dep]);
      return h("p", null, `d:${dep},o:${other}`);
    }

    const container = mount(h(App, null));
    expect(log).toEqual(["run"]);

    setDep!(1); // рендер 2: dep изменился
    expect(container.querySelector("p")!.textContent).toBe("d:1,o:0");
    expect(log).toEqual(["run", "cleanup", "run"]);

    setOther!(1); // рендер 3: dep тот же — эффект не перезапускается
    expect(container.querySelector("p")!.textContent).toBe("d:1,o:1");
    expect(log).toEqual(["run", "cleanup", "run"]);
  });

  // 5. Unmount → cleanup вызывается, host-узлы удалены.
  it("удаление компонента из дерева вызывает cleanup его эффекта", () => {
    installSyncDeps();
    const log: string[] = [];
    const Widget = (): VNode => {
      useEffect(() => {
        log.push("mount");
        return () => log.push("cleanup");
      }, []);
      return h("p", { id: "w" }, "widget");
    };
    const withWidget = h("div", null, h("span", null, "s"), h(Widget, null));
    const withoutWidget = h("div", null, h("span", null, "s"));

    const container = mount(withWidget);
    expect(log).toEqual(["mount"]);
    const widgetDom = container.querySelector("#w")!;

    scheduleWork(container, withoutWidget, Priority.Normal);

    expect(log).toEqual(["mount", "cleanup"]);
    expect(container.querySelector("#w")).toBeNull();
    expect(container.contains(widgetDom)).toBe(false);
  });

  // 6. Вложенный unmount: cleanup и Inner, и Outer (обход DELETION-поддерева
  //    спускается сквозь компонентные уровни).
  it("удаление Outer вызывает cleanup и Inner, и самого Outer", () => {
    installSyncDeps();
    const log: string[] = [];
    function Inner(): VNode {
      useEffect(() => () => log.push("inner-cleanup"));
      return h("em", null, "i");
    }
    function Outer(): VNode {
      useEffect(() => () => log.push("outer-cleanup"));
      return h("div", null, h(Inner, null));
    }
    const withOuter = h("section", null, h("span", null, "s"), h(Outer, null));
    const withoutOuter = h("section", null, h("span", null, "s"));

    const container = mount(withOuter);
    scheduleWork(container, withoutOuter, Priority.Normal);

    expect(log).toContain("inner-cleanup");
    expect(log).toContain("outer-cleanup");
    expect(container.innerHTML).toBe("<section><span>s</span></section>");
  });

  // 7. Порядок между fiber'ами: эффекты детей раньше родителя (post-order).
  it("эффект Inner запускается раньше эффекта Outer", () => {
    installSyncDeps();
    const log: string[] = [];
    function Inner(): VNode {
      useEffect(() => {
        log.push("inner");
      });
      return h("em", null, "i");
    }
    function Outer(): VNode {
      useEffect(() => {
        log.push("outer");
      });
      return h("div", null, h(Inner, null));
    }

    mount(h(Outer, null));

    expect(log).toEqual(["inner", "outer"]);
  });

  // 8. state + effect + state вперемешку: единый hook-list по call-order,
  //    слоты не путаются.
  it("useState + useEffect + useState в одном компоненте не путают слоты", () => {
    installSyncDeps();
    const log: string[] = [];
    let setA: Setter<number> | null = null;
    let setB: Setter<string> | null = null;
    function App(): VNode {
      const [a, sa] = useState(1);
      setA = sa;
      useEffect(() => {
        log.push(`effect:${a}`);
      }, [a]);
      const [b, sb] = useState("x");
      setB = sb;
      return h("p", null, `a:${a},b:${b}`);
    }

    const container = mount(h(App, null));
    expect(container.querySelector("p")!.textContent).toBe("a:1,b:x");
    expect(log).toEqual(["effect:1"]);

    setA!(2); // первый state меняется: эффект перезапущен, b цел
    expect(container.querySelector("p")!.textContent).toBe("a:2,b:x");
    expect(log).toEqual(["effect:1", "effect:2"]);

    setB!("y"); // второй state меняется: a цел, эффект НЕ перезапущен
    expect(container.querySelector("p")!.textContent).toBe("a:2,b:y");
    expect(log).toEqual(["effect:1", "effect:2"]);
  });

  // 9а. setState внутри эффекта на ПЕРВОМ mount: реентрантный каскад коммитится,
  //     current* остаётся консистентным.
  it("setState внутри эффекта на первом mount доводит DOM и не портит current*", () => {
    installSyncDeps();
    let setCount: Setter<number> | null = null;
    function App(): VNode {
      const [count, sc] = useState(0);
      setCount = sc;
      useEffect(() => {
        sc((c) => c + 1);
      }, []);
      return h("p", null, `c:${count}`);
    }

    const container = mount(h(App, null));

    // Каскад: mount-commit → эффект → setState → вложенный синхронный
    // рендер+commit. currentContainer к моменту эффекта уже промотирован.
    expect(container.querySelector("p")!.textContent).toBe("c:1");

    // Консистентность current* после каскада: следующий независимый setState
    // диффит (identity узлов сохранена), а не уходит в «чистый remount».
    const p = container.querySelector("p")!;
    const textNode = p.firstChild!;
    setCount!((c) => c + 1);
    expect(container.querySelector("p")!.textContent).toBe("c:2");
    expect(container.querySelector("p")).toBe(p);
    expect(p.firstChild).toBe(textNode);
  });

  // 9б. setState внутри эффекта на ПОВТОРНОМ рендере.
  it("setState внутри эффекта на повторном рендере доводит DOM и не портит current*", () => {
    installSyncDeps();
    let setDep: Setter<number> | null = null;
    let setCount: Setter<number> | null = null;
    function App(): VNode {
      const [dep, sd] = useState(0);
      const [count, sc] = useState(0);
      setDep = sd;
      setCount = sc;
      useEffect(() => {
        if (dep === 1) {
          sc((c) => c + 10);
        }
      }, [dep]);
      return h("p", null, `d:${dep},c:${count}`);
    }

    const container = mount(h(App, null));
    expect(container.querySelector("p")!.textContent).toBe("d:0,c:0");

    // Второй рендер: dep изменился → эффект → setState → вложенный каскад.
    setDep!(1);
    expect(container.querySelector("p")!.textContent).toBe("d:1,c:10");

    // Консистентность current* после вложенных коммитов.
    const p = container.querySelector("p")!;
    setCount!((c) => c + 1);
    expect(container.querySelector("p")!.textContent).toBe("d:1,c:11");
    expect(container.querySelector("p")).toBe(p);
  });

  // 10. Регресс на preemption: эффект отброшенного рендера не запускается,
  //     durable deps/cleanup не испорчены отброшенным WIP.
  it("вытесненный рендер не запускает эффект и не портит durable deps/cleanup", () => {
    // Управляемые deps: шагающие часы растягивают рендер на тики,
    // замороженные — коммитят синхронно (как в useState-регрессе выше).
    let stepping = false;
    let clock = 0;
    const ticks: Array<() => void> = [];
    __setSchedulerDeps({
      now: () => (stepping ? clock++ : 0),
      scheduleTick: (cb) => ticks.push(cb),
      frameBudgetMs: 3,
    });

    const runs: number[] = [];
    const cleanups: number[] = [];
    const seenPrev: number[] = [];
    let renderCount = 0;
    let capturedSetCount: Setter<number> | null = null;
    function Counter(): VNode {
      renderCount++;
      const [count, setCount] = useState(0);
      capturedSetCount ??= setCount;
      useEffect(() => {
        runs.push(count);
        return () => cleanups.push(count);
      }, [count]);
      return h("p", { id: "c" }, `c:${count}`);
    }
    const spans = Array.from({ length: 8 }, (_, i) => h("span", null, `s${i}`));
    const treeA = h("div", null, h(Counter, null), ...spans);
    const treeB = h("div", null, h(Counter, null));

    const container = document.createElement("div");
    scheduleWork(container, treeA, Priority.Normal); // часы заморожены → синхронно
    expect(container.querySelector("#c")!.textContent).toBe("c:0");
    expect(runs).toEqual([0]);
    expect(cleanups).toEqual([]);

    // Длинный Normal-рендер от setState, растянутый на тики.
    stepping = true;
    capturedSetCount!((prev) => {
      seenPrev.push(prev);
      return prev + 1;
    });
    // Докрутить до точки «Counter отрендерен в WIP (снимок эффекта решил
    // shouldRun), commit впереди».
    while (seenPrev.length === 0) {
      expect(ticks.length).toBeGreaterThan(0);
      ticks.shift()!();
    }
    // (а) Эффект недокоммиченного рендера НЕ запустился.
    expect(runs).toEqual([0]);
    expect(container.querySelector("#c")!.textContent).toBe("c:0");

    // Вытеснение ДО commit.
    stepping = false;
    scheduleWork(container, treeB, Priority.UserBlocking);

    // (б) Durable deps/cleanup целы: вытесняющий ЗАКОММИЧЕННЫЙ рендер увидел
    // prevDeps=[0], count=1 → перезапуск (cleanup прежнего, затем новый).
    // Если бы отброшенный WIP записал deps=[1] в durable, перезапуска бы
    // не было — runs остался бы [0].
    expect(container.querySelector("#c")!.textContent).toBe("c:1");
    expect(runs).toEqual([0, 1]);
    expect(cleanups).toEqual([0]);

    // Свидетель: запусков эффекта — ровно по числу КОММИТОВ (2), а не
    // рендеров (3: mount, отброшенный WIP, вытесняющий).
    expect(renderCount).toBe(3);

    // Отставшие тики отброшенного рендера безвредны.
    while (ticks.length > 0) {
      ticks.shift()!();
    }
    expect(runs).toEqual([0, 1]);
    expect(cleanups).toEqual([0]);
    expect(container.querySelector("#c")!.textContent).toBe("c:1");
  });

  // Rules of hooks: вызов вне рендера компонента — явная ошибка (как useState).
  it("useEffect вне рендера компонента бросает понятную ошибку", () => {
    expect(() => useEffect(() => {})).toThrowError(/outside of a function component/);
  });

  // Регресс на находку независимого ревью: setState-в-эффекте инициирует
  // реентрантный `scheduleWork`/`workLoop` (см. commitWip → runPassiveEffects).
  // Если этот вложенный рендер НЕ укладывается в бюджет и уступает (tick
  // запланирован, nextUnitOfWork указывает на его WIP), а очередь обновлений
  // не пуста — безусловный `startNextPendingRender()` во ВНЕШНЕМ `workLoop`
  // (сразу после `commitWip()`) перезаписывал модульное состояние
  // (`wipRoot`/`wipContainer`/`wipVNode`) поверх приостановленного вложенного
  // рендера, осиротив его: его отложенный тик потом резюмировал уже чужое
  // состояние. Симптом — потерянный рендер одного контейнера и задвоенный
  // DOM-узел другого. Фикс — `workLoop` не зовёт `startNextPendingRender()`
  // повторно, если `nextUnitOfWork !== null` (вложенный рендер уже в полёте).
  it("реентрантный setState-в-эффекте не затирает приостановленный вложенный рендер", () => {
    // Stepping clock: заморожен (0) для синхронных коммитов, включается, чтобы
    // заставить вложенный реентрантный рендер уступить бюджет посреди работы.
    let stepping = false;
    let clock = 0;
    const ticks: Array<() => void> = [];
    __setSchedulerDeps({
      now: () => (stepping ? clock++ : 0),
      scheduleTick: (cb) => ticks.push(cb),
      frameBudgetMs: 3,
    });

    const containerA = document.createElement("div");
    const containerB = document.createElement("div");

    function AppB(): VNode {
      return h("p", { id: "b" }, "b:0");
    }
    function AppBUpdated(): VNode {
      return h("p", { id: "b" }, "b:1");
    }

    let renderLong = false;
    let did = false;
    function AppA(): VNode {
      const [n, setN] = useState(0);
      useEffect(() => {
        if (n === 0 && !did) {
          did = true;
          renderLong = true;
          stepping = true; // заставляет реентрантный ре-рендер выйти за бюджет
          setN(1); // вложенный рендер A запускается и УСТУПАЕТ (приостановлен)
          // Вложенный рендер A/n=1 приостановлен здесь (тик в очереди).
          // Планируем ДРУГОЙ контейнер тем же приоритетом: остаётся в pending.
          scheduleWork(containerB, h(AppBUpdated, null), Priority.Normal);
        }
      }, [n]);
      const count = renderLong ? 40 : 1;
      return h(
        "div",
        null,
        ...Array.from({ length: count }, (_, i) => h("span", null, `a${i}`)),
      );
    }

    // Mount B (замороженные часы → синхронный коммит).
    scheduleWork(containerB, h(AppB, null), Priority.Normal);
    expect(containerB.querySelector("#b")!.textContent).toBe("b:0");

    // Mount A: mount коммитится синхронно; passive-фаза запускает каскад.
    scheduleWork(containerA, h(AppA, null), Priority.Normal);

    // Прокрутить все тики в очереди (возобновить приостановленные рендеры).
    stepping = false;
    let guard = 0;
    while (ticks.length > 0 && guard++ < 100) {
      ticks.shift()!();
    }

    // Корректное поведение (нарушалось до фикса): рендер A с n=1 обязан в
    // итоге закоммититься (40 спанов), а не застрять осиротевшим на
    // mount-версии — это ровно то, что чинит guard `nextUnitOfWork === null`
    // в `workLoop`.
    expect(containerA.querySelectorAll("span").length).toBe(40);

    // Примечание: B здесь только чтобы после mount'а A в очереди `pending`
    // осталась запись (иначе внешний `startNextPendingRender()` после
    // `commitWip()` просто увидел бы пустую очередь, и клоббер было бы
    // нечем демонстрировать). Корректность ДИФФА B (а не просто того, что
    // его апдейт вообще выполнился) — отдельная, ДО-существующая находка вне
    // объёма этого плана: `scheduler.ts` хранит `currentContainer`/
    // `currentRoot`/`currentVNode` в ОДНОЙ глобальной тройке, а не per-контейнер,
    // так что апдейт контейнера, который не был "последним закоммиченным",
    // всегда идёт как чистый remount, а не diff (воспроизводится и на
    // `master`, без единого хука/эффекта — см. отчёт ревью). Эта правка её не
    // касается и не должна маскировать; проверяем только то, что апдейт B
    // реально произошёл (эффект от него виден), не форму итогового DOM.
    expect(containerB.textContent).toContain("b:1");
  });
});
