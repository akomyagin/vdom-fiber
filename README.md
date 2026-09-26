# vdom-fiber

Мини-React с нуля на TypeScript: собственный **Virtual DOM** + **Fiber-подобный
прерываемый планировщик рендеринга**.

Учебный проект. Смысл не в наивном VDOM-диффинге (это известный туториал-путь), а в
Fiber-планировщике: рендер можно **прервать** на середине дерева, вернуть управление
браузеру и **продолжить** с сохранённого состояния, приоритизируя обновления
(user-input важнее фонового рендера).

## Статус

MVP (Этапы 0–6) реализован и смержен в `master`: собственный VDOM + Fiber + прерываемый
планировщик + hooks (`useState`), демо-счётчик работает end-to-end. Из post-MVP-плана
реализован §1 — `useEffect` (passive-эффекты). Остальные расширения (Context API,
concurrent-фичи, полноценный JSX) — в [docs/POST_MVP_PLAN.md](docs/POST_MVP_PLAN.md).

## Установка и проверка

```bash
npm install
npx tsc --noEmit   # проверка типов
npm test           # Vitest + jsdom
```

Это библиотека без внешнего рантайма — Docker/сервисы не нужны.

## Использование

JSX в MVP не используется — узлы строятся hyperscript-API (`h` / `createElement`).
Функциональные компоненты и хуки работают только через планировщик (`scheduleWork`);
синхронный `render` предназначен для host-дерева без компонентов.

```ts
import { h, scheduleWork, useState, useEffect } from "vdom-fiber";

function Counter() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    document.title = `Count: ${count}`;
  }, [count]);
  return h(
    "div",
    { class: "counter" },
    h("p", null, `Count: ${count}`),
    h("button", { onClick: () => setCount((c) => c + 1) }, "+1"),
  );
}

const container = document.getElementById("root")!;
scheduleWork(container, h(Counter, null)); // приоритет по умолчанию — Priority.Normal
```

Синхронный mount host-дерева (без компонентов) — через `render`:

```ts
import { h, render } from "vdom-fiber";
render(h("p", null, "hello"), document.getElementById("root")!);
```

### Публичный API

| Экспорт | Назначение |
|---|---|
| `createElement` / `h` | фабрика VNode (hyperscript, Этап 1) |
| `render(vnode, container)` | синхронный mount host-дерева без диффинга (Этап 2) |
| `reconcile(container, prev, next)` | синхронный VDOM-диффинг одного корня (Этап 3) |
| `performUnitOfWork(fiber)` | один шаг прерываемого обхода fiber-дерева (Этап 4) |
| `scheduleWork(container, vnode, priority?)` | запланировать рендер через планировщик (Этап 5) |
| `Priority` | enum приоритетов: `Immediate` / `UserBlocking` / `Normal` / `Idle` |
| `useState(initial)` | хук состояния (Этап 6) |
| `useEffect(create, deps?)` | passive-эффект после commit (POST_MVP §1) |
| `TEXT_ELEMENT` | маркер текстового узла |
| `VERSION` | строковый маркер версии библиотеки |
| типы | `Fiber`, `VNode`, `VProps`, `VChild`, `ComponentFunction`, `EffectCallback`, `EffectCleanup` |

Известное ограничение: планировщик хранит **одну** глобальную «текущую тройку»
(`current*`) — сценарий с несколькими независимыми корнями (`scheduleWork` на разные
контейнеры вперемешку) даёт remount вместо диффа. Подробности — в докблоке
`scheduleRerender` (`src/scheduler.ts`) и в
[docs/POST_MVP_PLAN.md](docs/POST_MVP_PLAN.md).

## Документация

- [docs/PLAN.md](docs/PLAN.md) — видение, архитектура, список этапов.
- [docs/TECHNICAL_PLAN.md](docs/TECHNICAL_PLAN.md) — стек и детальная разбивка по этапам.
- [docs/POST_MVP_PLAN.md](docs/POST_MVP_PLAN.md) — расширения после MVP.
- [docs/research/vdom-fiber-landscape.md](docs/research/vdom-fiber-landscape.md) — конкурентный
  ландшафт (production vdom/fiber-библиотеки, альтернативные парадигмы, учебные клоны React) и
  оценка применимости их техник к этому проекту.
- [CLAUDE.md](CLAUDE.md) — рабочий пайплайн разработки и git-workflow.

## Этапы MVP

1. `createElement` + VNode-дерево (hyperscript-API, без JSX)
2. Синхронный mount в реальный DOM
3. VDOM-диффинг (reconciliation) для повторных рендеров
4. Fiber-структура (linked-list дерево, прерываемый обход)
5. Планировщик с приоритетами и прерыванием через `MessageChannel`
6. Hooks (`useState`) + демо-счётчик

Post-MVP §1 (`useEffect`) реализован сверх MVP.

## Лицензия

MIT — см. [LICENSE](LICENSE).
