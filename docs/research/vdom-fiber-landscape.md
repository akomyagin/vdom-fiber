# Конкурентный и технический ландшафт — vdom-fiber

Дата: 2026-09-04. Исследование проведено multi-agent deep-research харнессом (4 прохода,
адверсариальная верификация 2/3 голосов на каждое утверждение) + ручной точечной проверкой
(Svelte 5). Методология и ограничения — см. [«Как читать этот документ»](#как-читать-этот-документ)
в конце файла.

Цель документа — не «а как нам стать как React», а наоборот: показать, что архитектурные решения
`vdom-fiber` (см. [PLAN.md](../PLAN.md), [TECHNICAL_PLAN.md](../TECHNICAL_PLAN.md)) — это не
случайный учебный выбор, а точка в реальном, хорошо изученном дизайн-пространстве, и явно
зафиксировать, какие идеи из этого пространства стоит взять в [POST_MVP_PLAN.md](../POST_MVP_PLAN.md),
а какие осознанно не подходят учебному runtime-движку без компилятора и без JSX.

## Оглавление

1. [Категория 1 — production vdom-библиотеки](#1-production-vdom-библиотеки)
2. [Категория 2 — альтернативные парадигмы без vdom](#2-альтернативные-парадигмы-без-vdom)
3. [Категория 3 — учебные реализации «сделай свой React»](#3-учебные-реализации-сделай-свой-react)
4. [Таблица применимости к vdom-fiber](#4-таблица-применимости-к-vdom-fiber)
5. [Рекомендации для POST_MVP_PLAN](#5-рекомендации-для-post_mvp_plan)
6. [Официальные Claude/Anthropic skills для проекта](#6-официальные-claudeanthropic-skills-для-проекта)
7. [Полный список источников](#7-полный-список-источников)
8. [Как читать этот документ (методология и ограничения)](#как-читать-этот-документ)

---

## 1. Production vdom-библиотеки

### 1.1 React / React Fiber — главный архитектурный референс

`vdom-fiber` явно моделируется по React Fiber ([PLAN.md](../PLAN.md)), поэтому это не «конкурент
для сравнения», а первоисточник, по которому стоит сверять инварианты. Все утверждения ниже
проверены по исходному коду `facebook/react` (`packages/react-reconciler`) и официальным доке/блогу.

| Техника React Fiber | Подтверждено по | Соответствие в `vdom-fiber` |
|---|---|---|
| Fiber-узел — изменяемая запись со связями `child`/`sibling`/`return`, обход дерева итеративный, а не через рекурсию call stack | `ReactFiber.js`: `this.return = null; this.child = null; this.sibling = null;`; [acdlite/react-fiber-architecture](https://github.com/acdlite/react-fiber-architecture) — fiber «reimplements the stack, specialized for React components» | Уже реализовано, [src/fiber.ts](../../src/fiber.ts) (Этап 4) — прямое совпадение архитектур |
| Work loop: begin→descend-to-child, no-child→complete→sibling-or-return; состояние обхода — module-level указатель вне call stack, что и даёт прерываемость | `ReactFiberWorkLoop.js` (`performUnitOfWork`/`completeUnitOfWork`), `workLoopConcurrent` проверяет `shouldYield()` между единицами работы | Уже реализовано, `nextUnitOfWork` в [src/scheduler.ts](../../src/scheduler.ts) (Этап 5); у React — `shouldYield`, у vdom-fiber — yield-точки через `MessageChannel`, признано семантически эквивалентным механизмом |
| Разделение прерываемой render-фазы (реконсиляция, WIP-дерево) и синхронной неразрывной commit-фазы (мутации DOM) — DOM никогда не остаётся в промежуточном состоянии | [react.dev/learn/render-and-commit](https://react.dev/learn/render-and-commit); [Update on Async Rendering](https://legacy.reactjs.org/blog/2018/03/27/update-on-async-rendering.html) — render-lifecycle методы могут вызываться многократно/прерываться, commit-lifecycle — ровно один раз | Уже реализовано: reconciler строит эффекты, коммит применяет их атомарно |
| Double buffering: WIP-дерево строится, пока текущее (закоммиченное) остаётся видимым; alternate-fiber создаётся лениво и пулится между рендерами («double buffering pooling technique» — дословно из исходника) | `ReactFiber.js`, `createWorkInProgress` | Уже реализовано как `current*`/`wip*` пара в scheduler.ts. Техника **переиспользования** fiber-объектов между рендерами (alternate-пул) — применимо с адаптацией, не обязательно для учебных целей, см. §5 |
| Hook-состояние — не по имени переменной, а позиционный linked-list на fiber (`memoizedState`/`queue`/`next`), формируемый в порядке вызова хуков — отсюда «Rules of Hooks» | `ReactFiberHooks.js`: `Hook = {memoizedState, baseState, baseQueue, queue, next}` | Уже реализован тот же паттерн в [src/hooks.ts](../../src/hooks.ts) (Этап 6, POST_MVP §1). Напрямую релевантно будущим `useMemo`/`useCallback`/`useReducer` — та же позиционная линковка |
| Приоритеты как битовые маски «lanes» (31 lane, sync/input-continuous/default/transition/retry/idle/offscreen/deferred), позволяющие фибру иметь несколько ожидающих категорий приоритета одновременно | `ReactFiberLane.js` (React 19.x): `TotalLanes = 31` | **Неприменимо напрямую** — полная lanes-система (31 бит, битовые операции) избыточна для учебного масштаба. Концепция «несколько категорий приоритета → выбор подмножества для рендера» применима **с сильным упрощением**: 2-3 уровня приоритета как simple enum вместо битовой маски — это уже путь, которым идёт `Priority` enum в scheduler.ts, и рекомендуемое направление для §3 POST_MVP (`startTransition`) |

**Вывод по React:** архитектура `vdom-fiber` — не приближение, а прямое, верифицированное
соответствие каноническому дизайну на уровне структуры данных и work loop. Единственный
осознанно неперенятый кусок — lanes-битмаска (сложность ради продакшн-производительности,
не нужна для целей проекта).

### 1.2 Preact — тот же дизайн, без time-slicing

Production runtime vdom, архитектурно похожий на React, но заметно проще: **нет** WIP-дерева,
нет `shouldYield`, нет lanes — обновления батчатся через плоскую microtask-очередь
(`enqueueRender → queueMicrotask`), без прерывания.

- **Keyed-diff:** переменная `skew` (смещение) + двунаправленный (`findMatchingIndex`) поиск
  наружу от ожидаемого индекса как fallback — не полный O(n²) перебор.
  Подтверждено по исходнику: `src/diff/children.js`.
- **Известный баг (Preact 8.0, `innerDiffNode`):** индексация по «сырому» `childNodes` без
  пропуска внешне вставленных DOM-узлов приводила к удалению чужого узла (гаттер split.js).
  Подтверждено автором Preact в [issue #1250](https://github.com/preactjs/preact/issues/1250);
  позже исправлено в переписке Preact X. **Конкретный урок для vdom-fiber:** любой код,
  индексирующий по реальному `childNodes`/`firstChild`/`nextSibling` (в vdom-fiber это
  `adoptSubtreeDoms` в [src/fiber.ts:618](../../src/fiber.ts)), обязан быть устойчив к внешне
  вставленным узлам — стоит явный regression-тест на этот сценарий.

**Применимость:** текущий reconciler.ts у vdom-fiber уже не наивный O(n²) — keyed-диф идёт через
`Map`-очередь по ключу ([reconciler.ts:158-199](../../src/reconciler.ts)), то есть архитектурно
ближе к Preact, чем к учебным туториалам с линейным сканированием. Preact's `skew`-оптимизация —
применимо как точечное улучшение производительности при реордеринге, не структурная правка.

### 1.3 Snabbdom — прямой предок hyperscript-паттерна

Модульная vdom-библиотека на том же `h(selector, data, children)`, что уже использует vdom-fiber
(без JSX). Подтверждено по официальному README:

- Сигнатура `patch(oldVnode|element, newVnode) → newVnode` намеренно сделана в
  reduce/scan-стиле — для лёгкой интеграции с FRP-библиотеками и чтобы не выбрасывать прежнее
  vnode-дерево без необходимости.
- **Thunks** — явный механизм мемоизации: vnode-заглушка, несущая функцию рендера + args
  состояния; при неизменных args прежнее поддерево переиспользуется целиком, диф не выполняется
  вообще.
- Заявленная мотивация создания — недовольство прежними vdom-библиотеками (раздутые,
  медленные, OOP-ориентированные).

Утверждение «ядро snabbdom — всего ~200 строк» **опровергнуто** при верификации (1-2 голоса) —
не цитировать.

**Применимость:** thunk-паттерн (мемоизация поддерева по неизменным args) — применимо с
адаптацией, прямая параллель будущему `useMemo` (POST_MVP §5) на уровне не хука, а целого
поддерева.

### 1.4 virtual-dom (Matt-Esch) — классический эталон

Историческая референсная vdom-diff библиотека, от которой происходит snabbdom и множество
туториалов. `virtual-hyperscript` определяет канонический `h(selector, properties, children)`
DSL с CSS-селекторным парсингом (`h('div.foo#some-id')` разворачивает className/id).
Заявленное обоснование диффинга вместо полного пересоздания DOM — производительность.

Проверкой **опровергнуты** более специфичные утверждения (не цитировать как подтверждённые):
инвариант неизменяемости VTree, характеристика diff/patch как «той самой» техники, на которой
основан snabbdom, и тезис о заимствовании `h()` у virtual-dom snabbdom-ом.

**Применимость:** базовая модель diff/patch — это уже baseline самого vdom-fiber, ничего нового
не привносит; ценность источника — историческая, не техническая.

### 1.5 Vue 3 — compiler-driven оптимизация диффа

Официальная документация Vue прямо противопоставляет свой подход React: **«Compiler-Informed
Virtual DOM»** — шаблонный компилятор статически анализирует биндинги и аннотирует
сгенерированные vnode числовыми `PatchFlags` (напр. `CLASS = 2`, подтверждено по исходнику
`packages/shared/src/patchFlags.ts`), что позволяет рантайму пропускать полный обход пропсов
через битовые проверки. Дополнительно — **Tree Flattening**: каждый скомпилированный «block»
на этапе компиляции собирает все свои динамические потомки (не только прямых детей) в единый
плоский массив, так что при ре-рендере обходится только он, статические поддеревья пропускаются
целиком. Источники: [vuejs.org/guide/extras/rendering-mechanism](https://vuejs.org/guide/extras/rendering-mechanism)
(официальный гайд), `vuejs/core/packages/shared/src/patchFlags.ts`.

**Применимость: НЕ применимо без адаптации.** PatchFlags и Tree Flattening требуют компилятора
шаблонов — статический анализ на этапе сборки. У `vdom-fiber` `h()`-вызовы пишутся вручную,
статического шаблона для анализа нет. Внедрение потребовало бы отдельного слоя компиляции — это
прямо противоречит осознанному решению проекта («без JSX, без компилятора» — см.
[SKILL.md](../../.claude/skills/ts-vdom-fiber-dev/SKILL.md#решение-по-jsx--без-jsx-в-mvp)).
Ценность — как явный пример trade-off «runtime-only vs compiler-assisted», стоит зафиксировать
в документации как осознанное ограничение (см. §5).

### 1.6 Mithril.js — почти та же архитектура, что уже есть у vdom-fiber

Минималистичный (8.8 KiB gzip) фреймворк: vdom-диффинг, lifecycle-хуки, keyed-реконсиляция,
встроенные роутинг (`m.route`) и XHR (`m.request`) — в отличие от React, которому для этого
нужны внешние библиотеки. Ядро — «virtual DOM diffing engine with a modern search space
reduction algorithm and DOM recycling» (алгоритм Бориса Летохи, по credits Mithril).
Подтверждено по [mithril.js.org](https://mithril.js.org/) (docs: `vnodes.html`, `render.html`,
`hyperscript.html`, `route.html`, `framework-comparison.html`).

**Применимость:** архитектурно Mithril — почти то же самое, что уже есть у vdom-fiber
(hyperscript → vnode-объект → diff-old-vs-new → патч только изменённого DOM → keyed-реконсиляция).
Не источник новой техники, а референс-подтверждение, что выбранная архитектура — жизнеспособный,
проверенный практикой минималистичный дизайн. Единственная точечная идея — детали LIS-based
переупорядочивания keyed-списков (найдено в обсуждении на GitHub, не в официальных доках —
источник слабее остальных Mithril-утверждений) можно взять как референс при доработке
keyed-diff в reconciler.ts.

### 1.7 Inferno — bitwise-флаги формы VNode

Ускорение диффинга — за счёт мемоизации «формы» VNode через упакованные битовые флаги
(O(1) сравнение вместо обхода структуры объекта), плюс опциональные compile-time/JSX-флаги
(`$HasVNodeChildren`, `$HasKeyedChildren`, `$HasNonKeyedChildren`, `$HasTextChildren`),
позволяющие пропускать нормализацию детей целиком (ценой краша при рассинхроне вместо тихого
исправления). Подтверждено дословно по README `infernojs/inferno` и `infernojs/babel-plugin-inferno`.

**Применимость: применимо с адаптацией.** Идея «маленькое целочисленное поле shape на VNode/fiber,
вычисляемое один раз при создании» не требует компилятора — можно завести на `VNode`/`Fiber` в
vdom-fiber. JSX-уровневые заранее объявленные флаги **не переносимы** без компилятора — если
разработчик расставляет их вручную на каждый `h()`-вызов, теряется эргономика и появляется риск
тихого рассинхрона, от которого в Inferno защищает именно компилятор.

### 1.8 Ivi — bitwise-совместимость + компилятор шаблонов (текущая версия)

Актуальная (на дату исследования) архитектура `localvoid/ivi` строится на Rust/oxc-компиляторе
шаблонов, который на этапе сборки выносит статические атрибуты/обработчики и дедуплицирует
op-коды. Отдельно, на уровне рантайма — дешёвая O(1) bitwise-проверка совместимости
реконсиляции (`vNodeCanSync`: XOR флагов + тег/ключ), и предвычисленные `VNodeFlags`,
кодирующие форму vnode (элемент/компонент, единственный/массив детей, спецтипы вроде
input/button/svg), на которые реконсилятор ветвится напрямую вместо runtime-интроспекции типов.
Подтверждено по `github.com/localvoid/ivi` и исходнику `packages/ivi/src/vdom/implementation.ts`
(конкретный закреплённый коммит). *Оговорка верификации:* более старая характеристика ivi как
«просто runtime без компилятора» подтверждена только на устаревшем коммите — текущий ivi уже
сместился к компилятору, эта старая формулировка не описывает актуальную архитектуру.

**Применимость:** компилятор шаблонов — не переносим без принятия совершенно новой стадии сборки
(вне скоупа проекта). Bitwise-флаги совместимости реконсиляции — применимо с адаптацией, той же
природы, что и техника Inferno выше: дешёвая рантайм-проверка без компилятора.

### 1.9 Million.js — компилируемые «блоки»

Ядро оптимизации — `block()`, вручную вызываемый Higher-Order Component (в manual mode — не
автоматическая компиляторная трансформация), который Million называет «hyper-optimized for
rendering speed» ценой строгих ограничений на автора: один детерминированный `return`,
стабильная форма дерева, никаких условных рендеров, только plain DOM-элементы (без вложенных
компонентов), без dynamic spread props. Подтверждено дословно по
[old.million.dev/docs/manual-mode/block](https://old.million.dev/docs/manual-mode/block).
Более маркетинговые тезисы («React на 70% быстрее», «полный пропуск vdom-диффа», «константное
время обновлений») **опровергнуты** верификацией — не цитировать.

**Применимость: только с существенной адаптацией.** Выигрыш строится на гарантии (в идеале —
компиляторной) неизменности формы поддерева между рендерами. У vdom-fiber нет компилятора и
механизма принудительно проверить «один return / без условностей» на уровне `h()`-вызова —
идею можно приблизить только через новый opt-in тип fiber «статический блок», который
реконсилятор обрабатывает особым образом; это отдельная фича, а не готовая к переносу техника.

---

## 2. Альтернативные парадигмы без vdom

Все три подхода ниже решают задачу эффективных UI-обновлений **иначе**, чем vdom-диффинг —
поэтому ни один не «применим» к vdom-fiber в смысле техники для заимствования. Ценность —
контраст, зафиксированный явно, чтобы будущий читатель документации понимал, почему проект
сознательно остаётся в vdom-парадигме.

### 2.1 SolidJS — fine-grained реактивность через сигналы

Пары getter/setter; чтение геттера внутри реактивного контекста (`createEffect`/`createMemo`)
автоматически регистрирует контекст как подписчика через module-level переменную «текущий
отслеживаемый контекст» (в исходнике — `Listener`). Официальная документация прямо заявляет:
«no virtual DOM, no reconciliation pass, no diffing algorithm» — компоненты выполняются один раз
как фабрики и не перевыполняются. Подтверждено по [docs.solidjs.com/concepts/signals](https://docs.solidjs.com/concepts/signals)
и исходнику `packages/solid/src/reactive/signal.ts` (`let Listener: Computation<any> | null = null`).

**Применимость: неприменимо напрямую.** Архитектурно другая парадигма (компилируемая
fine-grained реактивность vs интерпретируемый vdom-диффинг). Полная замена подхода
противоречила бы цели проекта — учебной демонстрации именно vdom+fiber паттерна. Ценность —
только раздел для контраста в документации.

### 2.2 Svelte 5 (runes) — компилятор вместо диффинга

Runes (`$state`, `$derived`, `$effect`) — не обычные функции JavaScript, а «символы для
управления компилятором Svelte» — часть языка, не требуют импорта, невалидны как значения вне
специально разрешённых позиций (официальная документация,
[svelte.dev/docs/svelte/what-are-runes](https://svelte.dev/docs/svelte/what-are-runes)).
Компилятор превращает обращения к `$state`-переменной в вызовы `$.get()`/`$.set()`, работающие
через глубоко реактивный **Proxy** — «Proxies allow Svelte to run code when you read or write
properties» ([svelte.dev/docs/svelte/$state](https://svelte.dev/docs/svelte/$state), проверено
напрямую первичным запросом к документации). Ни virtual DOM, ни diffing-алгоритм в документации
не упоминаются — обновления идут гранулярно, напрямую в DOM.

**Применимость: неприменимо напрямую**, по тем же причинам, что и Solid — компилятор,
превращающий синтаксис в реактивный граф, обновляющий DOM напрямую, минуя vdom целиком.
Требует полноценной стадии компиляции, которой у проекта нет и не будет по дизайну.

### 2.3 Qwik — resumability (другая ось: не диффинг, а гидратация)

«Resumability» — архитектура, устраняющая сам шаг гидратации: выполнение сериализуется на
сервере и возобновляется на клиенте без повторного исполнения кода компонентов и
пересборки состояния приложения — в явном официальном противопоставлении гидратации во «всех
остальных фреймворках», которая на клиенте заново прогоняет всю логику приложения. Сериализуется
только граф реактивности, нужный для интерактивности (обработчики событий + их замыкания), а не
всё дерево компонентов — поэтому размер сериализованных данных растёт с интерактивностью, а не с
числом компонентов. Подтверждено дословными цитатами по официальным
[qwik.dev/docs/concepts/resumable](https://qwik.dev/docs/concepts/resumable/) и
[qwik.dev/docs/faq](https://qwik.dev/docs/faq/).

**Применимость: не применимо, другая ось задачи.** Resumability атакует стоимость
SSR/гидратации, а не стоимость client-side vdom-диффа. У `vdom-fiber` явно нет SSR/гидратации
в скоупе (см. POST_MVP_PLAN, «Явно вне скоупа») — сравнение полезно только чтобы явно
зафиксировать: это ортогональная проблема, а не альтернатива Fiber-планировщику.

### 2.4 Vue Vapor mode — компиляция без vdom вообще

Официально одобренный core-командой Vue вариант рендеринга, полностью убирающий Virtual DOM:
шаблоны компилируются напрямую в тонко-гранулированные реактивные DOM-обновления. Репозиторий
`vue-vapor` изначально был явным форком `vuejs/core` для «research and development of no virtual
dom mode» (сейчас архивирован, слит в ветку `vapor` основного репозитория, стабильно поставляется
с Vue 3.6). Подтверждено по [github.com/vuejs/vue-vapor](https://github.com/vuejs/vue-vapor)
(описание репозитория и README).

**Применимость: неприменимо без компилятора**, по той же причине, что и PatchFlags Vue 3
выше — Vapor мод требует полноценной стадии компиляции шаблонов.

---

## 3. Учебные реализации «сделай свой React»

### 3.1 Didact (Rodrigo Pombo, pomb.us/build-your-own-react)

Канонический туториал «построй свой React» — **единственный найденный прямой предшественник
vdom-fiber по цели и масштабу**: `createElement` → `render` → concurrent-mode-подобный
`workLoop` через `requestIdleCallback` → fiber-дерево (`child`/`sibling`/`parent` linked-list) →
раздельные render/commit фазы → реконсиляция через `effectTag` (`PLACEMENT`/`UPDATE`/`DELETION`)
→ function components → хуки (`useState` через очередь обновлений). Порядок стадий туториала
буквально совпадает с порядком этапов `vdom-fiber` (Fiber+scheduler до hooks). Подтверждено
напрямую по первоисточнику: [pomb.us/build-your-own-react](https://pomb.us/build-your-own-react/),
[github.com/pomber/didact](https://github.com/pomber/didact).

Важно: эпилог статьи Помбо явно перечисляет намеренные упрощения — пропуск неизменных поддеревьев
по эвристикам, переиспользование (recycling) fiber-объектов, приоритизация обновлений — и
формулирует приоритет «simple code than performant code». **Это прямая внешняя валидация
масштаба, выбранного `vdom-fiber`**: отказ от конкуренции с React по производительности —
стандартная, обоснованная практика жанра, а не срезание углов.

### 3.2 davidbarone/didact — TypeScript-форк с доп. хуками

Личный форк pomber/didact, опубликован в npm как `@dbarone/didact`. Поверх базовых
`useState`/`useEffect` добавляет **рабочие** (не заглушки) `useMemo`/`useCallback`/`useRef` —
подтверждено по дереву репозитория и содержимому `useMemo.ts` (сравнение deps через
`lodash.isEqual`). Единственный найденный реальный TypeScript-пример, где эти хуки (POST_MVP §5
у vdom-fiber) уже реализованы поверх той же fiber-архитектуры — полезный референс структуры
хука с deps-сравнением при доработке `hooks.ts`.

### 3.3 IMCurie/mini-react — нижняя граница жанра

Минимальный клон без сообщества (0 stars/forks/watchers, 11 коммитов), прямое следование
туториалу без изменений. Ценность — как маркер того, что происходит на нижней границе этого
жанра учебных проектов; не референс для заимствования техники.

---

## 4. Таблица применимости к vdom-fiber

| Техника | Источник | Применимость | Куда в POST_MVP |
|---|---|---|---|
| Lanes-приоритеты (упрощённо, без битовой маски) | React 19 `ReactFiberLane.js` | С сильным упрощением — 2-3 уровня enum | §3 (concurrent), уже частично есть как `Priority` |
| Fiber-пулинг (double buffering reuse) | React `createWorkInProgress` | С адаптацией, опционально | §5 техдолг/nice-to-have (перф, не обязательно) |
| Позиционный linked-list для hook state | React `ReactFiberHooks.js` | Уже реализовано (Этап 6/§1); паттерн продолжить | §5 (useMemo/useCallback/useRef/useReducer) |
| Skew + двунаправленный поиск в keyed-diff | Preact `src/diff/children.js` | Точечная оптимизация reconciler.ts | техдолг/перф, не блокирует POST_MVP |
| Устойчивость к внешне вставленным DOM-узлам | Preact issue #1250 (баг-кейс) | Regression-тест для `adoptSubtreeDoms` | тест-долг, независимо от роадмапа |
| Thunk-мемоизация поддерева по args | Snabbdom README | С адаптацией — идея для будущего `useMemo`-на-поддереве | §5 (useMemo) |
| PatchFlags / Tree Flattening (compiler-driven) | Vue 3 официальный гайд + исходник | Неприменимо без компилятора | Зафиксировать как осознанный trade-off в доках |
| Bitwise VNode-shape флаги (рантайм, без компилятора) | Inferno README, ivi `vNodeCanSync` | С адаптацией — дешёвая рантайм-оптимизация | техдолг/перф, опционально |
| Template-компилятор (Rust/oxc) | ivi текущая архитектура | Неприменимо — требует новой стадии сборки | вне скоупа |
| Block-vdom с жёсткими ограничениями формы | Million.js manual `block()` | Только тяжёлая адаптация — новый тип fiber | вне скоупа MVP, возможный будущий эксперимент |
| Fine-grained signals (без vdom) | SolidJS `docs.solidjs.com`, исходник | Неприменимо — другая парадигма | Контраст в документации, не техника |
| Compile-time runes (без vdom) | Svelte 5 официальные доки | Неприменимо — требует компилятора | Контраст в документации, не техника |
| Resumability (гидратация, не диффинг) | Qwik официальные доки | Неприменимо — другая задача (SSR), вне скоупа | Уже вне скоупа (см. POST_MVP «Явно вне скоупа») |
| Vapor mode (компиляция, без vdom) | Vue Vapor репозиторий | Неприменимо без компилятора | Контраст в документации |
| Fiber/workloop/render-commit split/double buffering | React (`facebook/react` исходник) | Уже реализовано | — |
| Didact-подобный масштаб упрощений (без perf-конкуренции) | pomb.us эпилог | Внешняя валидация выбранного масштаба | — |

---

## 5. Рекомендации для POST_MVP_PLAN

Ничего из найденного не даёт повода добавить новый крупный пункт в
[POST_MVP_PLAN.md](../POST_MVP_PLAN.md) — все значимые техники либо уже реализованы (fiber,
work loop, render/commit split, positional hooks), либо требуют компилятора (вне скоупа по
дизайну), либо являются точечными перф-оптимизациями, которые не блокируют ни один текущий
пункт roadmap. Конкретно:

1. **§3 (concurrent-фичи):** формулировка `Priority` уже идёт правильным путём (упрощённый enum
   вместо lanes-битмаски) — подтверждено внешним источником как разумное упрощение, менять
   направление не нужно.
2. **§5 (доп. хуки):** при реализации `useMemo`/`useCallback` стоит держать в уме два внешних
   референса — позиционный linked-list React (уже используется) и snabbdom-овские thunks
   (мемоизация целого поддерева, не только значения) как более амбициозное расширение идеи
   вне текущего скоупа §5.
3. **Явный trade-off для документации (не код):** стоит добавить в TECHNICAL_PLAN.md одну фразу
   о том, что `vdom-fiber` сознательно остаётся runtime-only (без PatchFlags/Vapor/runes-стиля
   compiler-driven оптимизаций) — это находка данного исследования, наглядно объясняющая читателю
   *почему* у библиотеки нет компилятора, а не просто «пока не сделали».
4. **Точечный техдолг (не блокирует roadmap):** regression-тест на устойчивость реконсиляции к
   внешне вставленным DOM-узлам (по мотивам Preact issue #1250) — актуально для
   `adoptSubtreeDoms` в `src/fiber.ts`.

Ни один из production-конкурентов не предлагает техники, ради которой стоило бы менять
приоритет уже согласованных §2–§5 в POST_MVP_PLAN.

---

## 6. Официальные Claude/Anthropic skills для проекта

Отдельным агентом проверены официальные источники — репозиторий примеров
[anthropics/skills](https://github.com/anthropics/skills) и официальный маркетплейс плагинов
Claude Code ([docs: discover-plugins](https://code.claude.com/docs/en/discover-plugins),
[claude-plugins-official/marketplace.json](https://github.com/anthropics/claude-plugins-official/blob/main/.claude-plugin/marketplace.json)).

**Единственная применимая находка — `typescript-lsp`** (раздел «Code intelligence» официального
маркетплейса, `/plugin install typescript-lsp@claude-plugins-official`, требует бинарь
`typescript-language-server` в `$PATH`). Даёт автоматическую диагностику типов сразу после
правки (без ручного `npx tsc --noEmit`) и навигацию (jump-to-definition, call hierarchy) — полезно
на связном ядре `reconciler → fiber → scheduler → hooks`. Независимо перепроверено по
официальной документации — подтверждено. **Оговорка:** в cloud-сессиях LSP-плагины не
запускаются, выигрыш только в локальном CLI.

Специализированного skill «под тесты Vitest/jsdom» или «под алгоритмическую сложность
диффинга/планировщика» в официальных источниках не существует — не выдумываем его ради
количества. Всё остальное, что звучало бы релевантно, уже покрыто установленным набором:

| Потребность | Уже покрыто |
|---|---|
| Ревью diff / баги / упрощение | `code-review`, `simplify` |
| Аудит документации против кода | `code-docs-audit` |
| Проверка, что фича реально работает | `verify`, `run` |
| Многоисточниковый ресёрч | `deep-research` |
| Git commit/push/PR | ручной пайплайн в `CLAUDE.md` (маркетплейсный `commit-commands` дублирует и конфликтует с требованием русского conventional-subject + trailer) |
| Справка по Claude API | `claude-api` |

Рассмотрены и отклонены: `webapp-testing` (Playwright/E2E для запущенных веб-приложений —
проект headless-библиотека на jsdom, не подходит), `security-guidance`/`claude-security`
(security-сканеры для прод-кода с внешним вводом — нерелевантно учебной библиотеке без
рантайма), все MCP-интеграции (github/linear/jira/БД/облака — не про разработку TS-библиотеки).

---

## 7. Полный список источников

**React / Fiber (первоисточники):**
- https://github.com/facebook/react — `packages/react-reconciler/src/ReactFiber.js`, `ReactFiberWorkLoop.js`, `ReactFiberHooks.js`, `ReactFiberLane.js`
- https://github.com/acdlite/react-fiber-architecture
- https://react.dev/learn/render-and-commit
- https://legacy.reactjs.org/blog/2018/03/27/update-on-async-rendering.html
- https://dev.to/congar97/the-role-of-fiber-in-react-rendering-part-1-the-tree-the-walk-the-loop-422o
- https://dev.to/congar97/the-role-of-fiber-in-react-rendering-part-2-buffers-hooks-lanes-and-the-commit-4jmd

**Preact:** https://github.com/preactjs/preact (`src/diff/index.js`, `src/diff/children.js`, `src/component.js`) · https://github.com/preactjs/preact/issues/1250 · https://deepwiki.com/preactjs/preact/2-core-architecture

**Snabbdom:** https://github.com/snabbdom/snabbdom

**virtual-dom:** https://github.com/Matt-Esch/virtual-dom · https://github.com/Matt-Esch/virtual-dom/blob/master/virtual-hyperscript/README.md

**Vue 3 / Vapor:** https://vuejs.org/guide/extras/rendering-mechanism · https://github.com/vuejs/core/blob/main/packages/shared/src/patchFlags.ts · https://github.com/vuejs/vue-vapor

**Mithril.js:** https://mithril.js.org/ · /vnodes.html · /render.html · /hyperscript.html · /route.html · /framework-comparison.html · /lifecycle-methods.html · /mount.html

**Inferno:** https://github.com/infernojs/inferno/blob/master/README.md · https://github.com/infernojs/babel-plugin-inferno

**ivi:** https://github.com/localvoid/ivi · `packages/ivi/src/vdom/implementation.ts` (закреплённый коммит)

**Million.js:** https://old.million.dev/docs/manual-mode/block · https://github.com/aidenybai/million

**SolidJS:** https://docs.solidjs.com/concepts/signals · `packages/solid/src/reactive/signal.ts` · https://jser.dev/react/2023/02/26/reactivity-in-solidjs/

**Svelte 5:** https://svelte.dev/docs/svelte/what-are-runes · https://svelte.dev/docs/svelte/$state

**Qwik:** https://qwik.dev/docs/concepts/resumable/ · https://qwik.dev/docs/faq/

**Учебные клоны:** https://pomb.us/build-your-own-react/ · https://github.com/pomber/didact · https://github.com/davidbarone/didact · https://github.com/IMCurie/mini-react

**Официальные skills:** https://github.com/anthropics/skills · https://code.claude.com/docs/en/discover-plugins · https://github.com/anthropics/claude-plugins-official

---

## Как читать этот документ

**Методология.** Материал собран четырьмя проходами multi-agent deep-research харнесса
(веерный поиск по нескольким «углам» → фетч источников → адверсариальная верификация каждого
утверждения тремя независимыми голосами, ≥2/3 «опровергнуто» убивает утверждение → синтез) плюс
одной точечной ручной проверкой (Svelte 5, после того как два прохода харнесса не смогли набрать
подтверждённый claim). Первый запуск харнесса полностью упал на rate-limiting со стороны
провайдера (0 источников) — перезапущен. Все утверждения в разделах 1–3 либо прошли
адверсариальную верификацию (отмечено как «подтверждено»), либо явно помечены как отклонённые
(«опровергнуто [голоса] — не цитировать») и намеренно оставлены в тексте, чтобы зафиксировать,
какие правдоподобно звучащие тезисы **не** выдержали проверку.

**Осознанные ограничения охвата:**
- Раздел о keyed-list переупорядочивании Mithril основан на обсуждении в GitHub issue
  (community-источник), а не на официальной документации — помечено как источник послабее
  остальных Mithril-утверждений.
- Характеристика ivi как «runtime без компилятора» подтверждена только для устаревшего
  закреплённого коммита; текущая (на дату исследования) архитектура ivi уже включает
  Rust/oxc-компилятор шаблонов — в тексте используется актуальная версия.
- Svelte 5 не подтверждён общим deep-research харнессом (два прохода без результата) —
  закрыт отдельным прямым запросом к `svelte.dev/docs` в этой же сессии.
- Раздел 4 (таблица применимости) — аналитический синтез поверх подтверждённых фактов, а не
  отдельно верифицированное утверждение; отмечен как «medium confidence» в исходных отчётах
  харнесса даже там, где лежащие в основе технические факты — «high confidence».
- Полные необработанные транскрипты всех четырёх прогонов (включая провалившийся первый) не
  входят в этот файл и не сохраняются в репозитории — они существуют только как временные
  артефакты сессии.
