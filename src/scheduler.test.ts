import { afterEach, describe, expect, it } from "vitest";
import { createElement as h } from "./createElement.js";
import { reconcile } from "./reconciler.js";
import { render } from "./render.js";
import { Priority, __setSchedulerDeps, scheduleWork } from "./scheduler.js";
import type { VNode } from "./types.js";

/**
 * All tests drive the scheduler deterministically through injected deps
 * (`__setSchedulerDeps`): a stepping `now`, a manual tick queue instead of
 * MessageChannel, and a small frame budget. No real timers anywhere.
 */

/** Controlled deps: every `now()` call advances the clock by 1. */
function installSteppingDeps(frameBudgetMs = 3): {
  ticks: Array<() => void>;
  flush: (onTick?: () => void) => void;
  scheduledCount: () => number;
} {
  const ticks: Array<() => void> = [];
  let scheduled = 0;
  let clock = 0;
  __setSchedulerDeps({
    now: () => clock++,
    scheduleTick: (cb) => {
      scheduled++;
      ticks.push(cb);
    },
    frameBudgetMs,
  });
  return {
    ticks,
    flush: (onTick) => {
      // Callbacks may enqueue further ticks; drain until quiescent.
      while (ticks.length > 0) {
        ticks.shift()!();
        onTick?.();
      }
    },
    scheduledCount: () => scheduled,
  };
}

/** Frozen clock + huge budget: every render completes in one synchronous slice. */
function installSyncDeps(): Array<() => void> {
  const ticks: Array<() => void> = [];
  __setSchedulerDeps({
    now: () => 0,
    scheduleTick: (cb) => ticks.push(cb),
    frameBudgetMs: 1_000,
  });
  return ticks;
}

/** Reference HTML produced by the synchronous Stage 2 mount. */
function syncHtml(vnode: VNode): string {
  const ref = document.createElement("div");
  render(vnode, ref);
  return ref.innerHTML;
}

/** A tree long enough to span many units of work (2 fibers per list item). */
function bigList(marker: string, count = 10): VNode {
  return h(
    "ul",
    { "data-marker": marker },
    Array.from({ length: count }, (_, i) => h("li", null, `${marker}-${i}`)),
  );
}

describe("scheduler", () => {
  afterEach(() => {
    // Restore default deps AND wipe the scheduler's module-level state so
    // tests cannot leak into each other through it.
    __setSchedulerDeps({})();
  });

  // 1
  it("первый mount через scheduler даёт тот же DOM, что синхронный render", () => {
    const ticks = installSyncDeps();
    const container = document.createElement("div");
    const tree = h("div", { id: "app" }, h("h1", null, "hi"), h("p", null, "text"));

    scheduleWork(container, tree, Priority.Normal);

    // Fits in one budget → committed synchronously, no ticks needed.
    expect(ticks.length).toBe(0);
    expect(container.innerHTML).toBe(syncHtml(tree));
  });

  // 2
  it("повторный scheduleWork обновляет DOM, сохраняя идентичность неизменных узлов", () => {
    installSyncDeps();
    const container = document.createElement("div");
    scheduleWork(container, h("div", { id: "a" }, h("span", null, "one")));
    const div = container.firstChild!;
    const span = div.firstChild!;

    scheduleWork(container, h("div", { id: "b" }, h("span", null, "two")));

    // Same DOM objects → prev tree was taken from the scheduler's current state.
    expect(container.firstChild).toBe(div);
    expect(div.firstChild).toBe(span);
    expect((div as Element).getAttribute("id")).toBe("b");
    expect(span.textContent).toBe("two");
  });

  // 3
  it("scheduleWork(container, null) размонтирует корень", () => {
    installSyncDeps();
    const container = document.createElement("div");
    scheduleWork(container, h("p", null, "bye"));
    expect(container.innerHTML).toBe("<p>bye</p>");

    scheduleWork(container, null);

    expect(container.innerHTML).toBe("");
  });

  // 4
  it("длинный рендер разбивается минимум на два тика и завершается после flush", () => {
    const s = installSteppingDeps();
    const container = document.createElement("div");
    const tree = bigList("big");

    scheduleWork(container, tree, Priority.Normal);

    // The synchronous slice ran out of budget: work is parked on a tick and
    // nothing is committed yet.
    expect(s.ticks.length).toBe(1);
    expect(container.innerHTML).toBe("");

    s.flush();

    expect(s.scheduledCount()).toBeGreaterThanOrEqual(2);
    expect(container.innerHTML).toBe(syncHtml(tree));
  });

  // 5
  it("DOM не трогается до commit: прерванный рендер оставляет старое дерево", () => {
    const s = installSteppingDeps();
    const container = document.createElement("div");
    scheduleWork(container, h("p", null, "old"));
    s.flush();
    expect(container.innerHTML).toBe("<p>old</p>");

    scheduleWork(container, bigList("next"));

    // Mid-render (ticks not flushed): the DOM still shows exactly the old
    // committed tree — the render phase never mutates it.
    expect(s.ticks.length).toBeGreaterThanOrEqual(1);
    expect(container.innerHTML).toBe("<p>old</p>");

    s.flush();
    expect(container.innerHTML).toBe(syncHtml(bigList("next")));
  });

  // 6
  it("высокоприоритетное обновление коммитится раньше фонового", () => {
    const s = installSteppingDeps();
    const container = document.createElement("div");

    scheduleWork(container, bigList("bg"), Priority.Normal);
    expect(container.innerHTML).toBe(""); // background not committed yet

    scheduleWork(container, h("p", null), Priority.UserBlocking);

    // The urgent tree is in the DOM before the background one ever landed.
    expect(container.innerHTML).toBe("<p></p>");

    s.flush();
    expect(container.innerHTML).not.toContain("bg");
  });

  // 7
  it("вытеснение: Immediate замещает идущий Normal-рендер того же контейнера", () => {
    const s = installSteppingDeps();
    const container = document.createElement("div");

    scheduleWork(container, bigList("low"), Priority.Normal);
    expect(s.ticks.length).toBe(1); // long render parked mid-flight

    scheduleWork(container, h("p", { id: "hi" }), Priority.Immediate);

    // WIP discarded, urgent tree committed synchronously.
    expect(container.innerHTML).toBe('<p id="hi"></p>');

    // Replacement semantics (chosen per plan §5): the preempted same-container
    // update is dropped, not re-applied. Stale ticks must be harmless.
    s.flush();
    expect(container.innerHTML).toBe('<p id="hi"></p>');
    expect(container.innerHTML).not.toContain("low");
  });

  // 7b (фикс находки ревью: вытеснение не должно задевать другой контейнер)
  it("более приоритетное обновление ДРУГОГО контейнера не отбрасывает идущий рендер, а ждёт очереди", () => {
    const s = installSteppingDeps();
    const containerA = document.createElement("div");
    const containerB = document.createElement("div");
    const treeA = bigList("A");

    scheduleWork(containerA, treeA, Priority.Normal);
    expect(s.ticks.length).toBe(1); // A's long render parked mid-flight

    // A higher-priority update for an UNRELATED container must not discard A.
    scheduleWork(containerB, h("p", { id: "b" }), Priority.Immediate);

    s.flush();

    // B applied promptly; A's in-flight work survived and was applied too —
    // neither container silently lost its update.
    expect(containerB.innerHTML).toBe('<p id="b"></p>');
    expect(containerA.innerHTML).toBe(syncHtml(treeA));
  });

  // 8
  it("обновление с приоритетом не выше идущего ждёт и применяется после", () => {
    const s = installSteppingDeps();
    const container = document.createElement("div");
    const first = bigList("first");
    const second = bigList("second");

    scheduleWork(container, first, Priority.Normal);
    scheduleWork(container, second, Priority.Normal); // equal → no preemption
    expect(container.innerHTML).toBe(""); // in-flight render not disturbed

    const seen: string[] = [];
    s.flush(() => seen.push(container.innerHTML));

    // "first" fully committed at some point, then "second" replaced it.
    const firstIdx = seen.indexOf(syncHtml(first));
    const secondIdx = seen.indexOf(syncHtml(second));
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(container.innerHTML).toBe(syncHtml(second));
  });

  // 9
  it("равный приоритет обрабатывается в порядке FIFO", () => {
    const s = installSteppingDeps();
    const container = document.createElement("div");
    const b = bigList("b");
    const c = bigList("c");

    scheduleWork(container, bigList("a"), Priority.Normal); // in flight
    scheduleWork(container, b, Priority.Normal);
    scheduleWork(container, c, Priority.Normal);

    const seen: string[] = [];
    s.flush(() => seen.push(container.innerHTML));

    // b (queued first) committed before c; c is the final state.
    const bIdx = seen.indexOf(syncHtml(b));
    const cIdx = seen.indexOf(syncHtml(c));
    expect(bIdx).toBeGreaterThanOrEqual(0);
    expect(cIdx).toBeGreaterThan(bIdx);
    expect(container.innerHTML).toBe(syncHtml(c));
  });

  // 10
  it("stale-тик идемпотентен: повторный вызов после завершения безвреден", () => {
    const s = installSteppingDeps();
    const container = document.createElement("div");
    const tree = bigList("x");

    scheduleWork(container, tree, Priority.Normal);
    const staleCb = s.ticks[0]!; // keep a reference to an already-queued tick
    s.flush();
    const html = container.innerHTML;
    expect(html).toBe(syncHtml(tree));

    // Re-firing the consumed tick (even twice) must not throw or corrupt DOM.
    expect(() => {
      staleCb();
      staleCb();
    }).not.toThrow();
    expect(container.innerHTML).toBe(html);
  });

  // 11
  it("результат через scheduler с прерываниями идентичен синхронному reconcile", () => {
    const s = installSteppingDeps();
    const pairs: Array<[VNode, VNode | null]> = [
      // Indexed children: patch + shrink.
      [
        h("div", null, h("span", null, "a"), h("span", null, "b")),
        h("div", null, h("span", null, "b")),
      ],
      // Keyed reorder with a removal.
      [
        h(
          "ul",
          null,
          h("li", { key: "a" }, "a"),
          h("li", { key: "b" }, "b"),
          h("li", { key: "c" }, "c"),
        ),
        h("ul", null, h("li", { key: "c" }, "c"), h("li", { key: "a" }, "a")),
      ],
      // Props + text change on the same type.
      [h("p", { class: "x" }, "hi"), h("p", { class: "y" }, "bye")],
      // Root type change (full replacement).
      [h("div", null, "t"), h("section", null, h("em", null, "z"))],
      // Unmount.
      [h("div", null, "gone"), null],
    ];

    for (const [prev, next] of pairs) {
      const scheduled = document.createElement("div");
      scheduleWork(scheduled, prev, Priority.Normal);
      s.flush();
      scheduleWork(scheduled, next, Priority.Normal);
      s.flush();

      const synchronous = document.createElement("div");
      reconcile(synchronous, null, prev);
      reconcile(synchronous, prev, next);

      expect(scheduled.innerHTML).toBe(synchronous.innerHTML);
    }
  });
});
