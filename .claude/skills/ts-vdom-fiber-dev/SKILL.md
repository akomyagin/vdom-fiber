---
name: ts-vdom-fiber-dev
description: Конвенции и технические решения проекта vdom-fiber — учебный мини-React на TypeScript (Virtual DOM + Fiber-подобный прерываемый планировщик). Подход без JSX (hyperscript-API h/createElement), паттерн тестирования на итоговом DOM-дереве через jsdom + Vitest, поэтапная модель Этап 1→6 с Fiber-планировщиком как поздним этапом. Использовать при реализации любого этапа кодирования vdom-fiber.
---

# SKILL: ts-vdom-fiber-dev — конвенции проекта `vdom-fiber`

Проект — собственный рендер-движок в духе React: VDOM-диффинг + прерываемый
(interruptible) рендеринг по приоритетам. Ниже — принятые решения, чтобы код всех
этапов был единообразным.

## Стек

- TypeScript 5.7, `strict: true`, ESM (`"type": "module"`), `moduleResolution: bundler`.
- Vitest 2 + jsdom для тестов; `@vitest/coverage-v8` для покрытия.
- Никаких runtime-зависимостей: это библиотека без внешнего рантайма. Docker не нужен.
- Сборка — `tsc` (`tsconfig.build.json` → `dist/`). Импорты внутри `src/` пишем с
  расширением `.js` (ESM-резолвинг), напр. `import { render } from "./render.js"`.

## Решение по JSX — БЕЗ JSX в MVP

MVP использует **hyperscript-API**: `createElement(type, props, ...children)` с
алиасом `h`, вызываемый напрямую. НЕ вводить JSX/babel/`jsxImportSource` в Этапах 0–6.

Почему:
- убирает тулинг-конфигурацию JSX из критического пути ранних этапов;
- делает VNode-дерево явным и максимально тестируемым;
- JSX ничего не блокирует — добавляется позже отдельным слоем (см. POST_MVP §4).

Если возникает соблазн «просто добавить JSX» — не делать этого в рамках MVP-этапа;
это post-MVP работа.

## Модель VNode

- `VNode { type: string; props: VProps }`; `props.children` — **всегда** `VNode[]`.
- Текст — отдельный тип узла `TEXT_ELEMENT` с `props.nodeValue`.
- `createElement` нормализует детей: разворачивает вложенные массивы, отбрасывает
  `null`/`undefined`/`boolean`, оборачивает `string`/`number` в `TEXT_ELEMENT`.
  Downstream-код никогда не должен встречать «сырого» ребёнка-примитив.

## Паттерн тестирования

Основной ярус — **проверка итогового DOM-дерева**, а не внутренних вызовов:

- Рендерим в jsdom-контейнер (`const root = document.createElement("div")`) и
  утверждаем на результате: `root.innerHTML`, обход `childNodes`, атрибуты,
  сработавшие обработчики.
- Тест-файлы лежат рядом с исходником: `src/foo.ts` → `src/foo.test.ts`.
- Vitest globals включены (`globals: true`) — `describe/it/expect` без импорта из
  `vitest` не обязателен, но в шаблоне импортируем явно для наглядности.
- Для reconciler'а проверять **минимальность мутаций**: неизменённые DOM-узлы не
  должны пересоздаваться (сравнивать идентичность ноды до/после `reconcile`).
- **Планировщик (Этап 5) тестировать детерминированно:** время/дедлайн инъектировать
  (передавать `now()`/таймер), НЕ полагаться на реальные таймеры — иначе прерывания
  невоспроизводимы. Проверять: длинный рендер разбивается на несколько тиков;
  высокоприоритетный апдейт вытесняет фоновый; итоговый DOM идентичен синхронной версии.

Пример скелета теста:

```ts
import { describe, expect, it } from "vitest";
import { render } from "./render.js";
import { h } from "./createElement.js";

describe("render", () => {
  it("монтирует дерево в контейнер", () => {
    const root = document.createElement("div");
    render(h("p", null, "hi"), root);
    expect(root.innerHTML).toBe("<p>hi</p>");
  });
});
```

## Этапы (Fiber-планировщик — поздний, НЕ первый)

Этап 1 `createElement`+VNode → 2 синхронный mount → 3 VDOM-диффинг →
4 Fiber-структура (linked-list, прерываемый обход) → 5 планировщик
(time-slicing + приоритеты + `MessageChannel`) → 6 `useState` + демо-счётчик.

Сначала работающий синхронный VDOM (1–3), потом переход на прерываемую модель (4–5).
Не начинать с планировщика — это самая сложная часть. Детали — в `docs/TECHNICAL_PLAN.md`.

## Definition of Done этапа

`npx tsc --noEmit` чисто · `npm test` зелёный · новый код покрыт тестами на DOM-результат ·
публичный API отражён в `src/index.ts` · заглушечные `TODO(Этап N)` для реализованного
этапа сняты.

## Git / коммиты

Ветка от `master` на каждый этап (`stage-N/<topic>`) → PR → merge. Conventional-commit
с русским subject, trailer `Co-Authored-By: Claude`. Пайплайн ролей моделей — в `CLAUDE.md`.
