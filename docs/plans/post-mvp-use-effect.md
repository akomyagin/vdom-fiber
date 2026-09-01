# План POST-MVP §1 — `useEffect` (passive effects)

Ветка: `post-mvp/use-effect` (уже создана от `master` @ `f7ed3d9`).
Файлы-исполнители: `src/hooks.ts` (+ `src/hooks.test.ts`), `src/fiber.ts`,
`src/index.ts`, и **`src/scheduler.ts` — минимальная механическая правка одной функции**
(`commitWip`: 3 строки, реордеринг промоушена и запуска эффектов — НЕ трогать `workLoop`,
`shouldYield`, модель приоритетов/preemption, `scheduleWork`/`scheduleRerender`;
обоснование — Развилка 4).
Первоисточник требований: `docs/POST_MVP_PLAN.md`, раздел «1. `useEffect`»:

- Хук с массивом зависимостей; эффекты запускаются **после** commit-фазы.
- Cleanup-функция вызывается перед повторным запуском эффекта и при размонтировании.
- Требует: список эффектов на fiber, сравнение deps, фаза «passive effects» после commit.

Этот план — прямое продолжение Этапа 6. Вся инфраструктура функциональных компонентов
(вызов `type(props)` в `reconcileChildren`, DOM-transparency компонентных fiber'ов в
commit, module-state `currentFiber`/`hookIndex` в `hooks.ts`, write-дисциплина
snapshot-in-render/finalize-in-commit) уже есть и переиспользуется. `useEffect` — это
**вторая durable-cell на fiber**, и handoff Этапа 6 (`docs/handoff/2026-08-23-etap6-hooks.md`,
раздел «Технический долг», второй пункт) прямо требует применить к ней ту же
write-дисциплину `HookSnapshot`/`commitFiberHooks`, а не полагаться на то, что «раз
`useState` починили, остальные хуки автоматически безопасны». Этот план это требование
исполняет явно (Развилка 2).

Одновременно закрывается один из двух зафиксированных на Этапе 6 дизайн-гэпов:
«удалённые (`deletions`) поддеревья не финализируются, их durable-хуки уходят в небытие»
(handoff, `finalizeHooks` в `fiber.ts`). Для `useState` это было корректно (потерять
состояние удалённого поддерева — правильно), для `useEffect` — **неверно**: cleanup
обязан вызваться при unmount (Развилка 6).

## Цель

1. Реализовать `useEffect(create, deps?)`: `create` — функция-эффект, возвращающая
   либо `void`, либо cleanup-функцию; `deps` — массив зависимостей или `undefined`.
2. Хранить эффект как durable-ячейку на fiber (переживает рендеры через `alternate`),
   с той же write-дисциплиной, что у `useState`: render только СНИМАЕТ (deps этого
   рендера, callback, решение «запускать ли»), commit — единственный писатель durable
   полей `deps`/`cleanup`.
3. Запускать эффекты в фазе «passive effects» **синхронно сразу после `commitRoot`**,
   в том же тике: cleanup предыдущего эффекта → затем новый эффект, для каждого
   fiber'а, у которого deps изменились (или отсутствуют).
4. Вызывать cleanup при размонтировании компонента (DELETION-поддеревья), чего
   `finalizeHooks` Этапа 6 сейчас не делает.
5. Покрыть тестами на наблюдаемом поведении (побочные эффекты в массив-логгер +
   итоговый DOM), включая регресс на preemption (аналог теста Этапа 6 для `useState`).

## Границы (что НЕ входит)

- **Отдельный async-scheduling passive-эффектов через `MessageChannel`/микрозадачу**
  (как настоящий React, где passive effects идут в отдельном тике после paint) — НЕ
  делать. Синхронный вызов сразу после commit достаточен и соответствует духу проекта
  (Развилка 4). Не трогать `workLoop`, `shouldYield`, `startNextPendingRender`, модель
  приоритетов/вытеснения, `scheduleWork`/`scheduleRerender` — единственная точка, которую
  правка задевает в `scheduler.ts`, это 3-строчный реордеринг в `commitWip` (Развилка 4).
- **`useLayoutEffect`** (эффекты ДО paint, синхронно внутри commit) — вне объёма. Строим
  только passive-`useEffect`.
- **Прочие хуки** (`useMemo`, `useCallback`, `useRef`, `useReducer`, `useContext`) — вне
  объёма (POST_MVP §5 / §2). Инфраструктуру не проектировать под них специально сверх
  того, что естественно.
- **Отлов исключений из эффекта/cleanup** (error boundary вокруг эффектов) — вне объёма.
  Если `create`/cleanup бросают — исключение всплывает наверх, как в текущем commit
  (никакого try/catch-глотания). Не усложнять.
- **Батчинг / дедупликация эффектов, планирование эффекта на будущий тик, отмена
  запланированного эффекта при быстром повторном рендере** — вне объёма. Каждый
  закоммиченный рендер прогоняет свои эффекты синхронно тут же.
- **Изменение поведения `useState`** — не трогать; `useEffect` встраивается рядом, в тот
  же per-fiber hook-list (Развилка 1).

## Что уже есть и переиспользуется (не дублировать)

- `Fiber.hooks?: Hook[]` / `Fiber.hookSnapshots?: HookSnapshot[]` (`fiber.ts`) — durable
  хук-список и render-снимки. `useEffect` кладётся в ТОТ ЖЕ список (Развилка 1).
- `beginHooks(fiber)` / `finishHooks()` (`hooks.ts`) — обёртки вокруг вызова компонента;
  `currentFiber`/`hookIndex` module-state. Переиспользуются как есть.
- `commitFiberHooks(fiber)` (`hooks.ts`) — commit-финализатор хуков одного fiber'а;
  расширяется, чтобы финализировать и эффекты (Развилка 2), и СОБИРАТЬ те, что надо
  запустить.
- `finalizeHooks(fiber)` (`fiber.ts`) — рекурсивный обход всего закоммиченного дерева из
  `commitRoot`, зовущий `commitFiberHooks` на каждом компонентном fiber'е. Расширяется,
  чтобы собрать список эффектов к запуску в `pending` (Развилка 4, 5) — сам их не
  запускает.
- `commitRoot(rootFiber)` (`fiber.ts`) — точка входа commit; синхронный неделимый проход.
  Меняет сигнатуру на `PendingEffect[]` и ВОЗВРАЩАЕТ собранные эффекты, не запуская их —
  запуск переносится в `scheduler.ts`/`commitWip`, строго после промоушена `current*`
  (Развилка 4 — реентрантность делает запуск внутри `commitRoot` небезопасным).
- `commitDeletions` / `collectHostDoms` (`fiber.ts`) — удаление host-DOM поддеревьев.
  Рядом добавляется обход удаляемого поддерева для сбора cleanup (Развилка 6).
- `isComponentFiber(fiber)` (`fiber.ts`) — предикат «fiber — компонент». Переиспользуется.

---

## Развилки — обязательные явные решения

### Развилка 1 — Хранение эффектов: единый hook-list с дискриминацией по типу

**Решение.** НЕ заводить второй параллельный список эффектов на `Fiber`. Эффекты и
`useState`-хуки живут в **одном** `fiber.hooks: Hook[]`, дискриминируемые по полю-тегу.
Аналогично — один `fiber.hookSnapshots: HookSnapshot[]`.

**Обоснование (это то, что план обязан обосновать).** И `useState`, и `useEffect`
сопоставляются с fiber'ом **по одному и тому же call-order-индексу** (`hookIndex++`), и в
одном компоненте могут идти вперемешку:

```
useState(0)   // index 0
useEffect(fn) // index 1
useState("")  // index 2
```

Если держать эффекты в отдельном списке со своим счётчиком, два счётчика разъедутся при
любом чередовании, и rules-of-hooks-инвариант «N-й вызов хука ↔ N-й слот» сломается.
Единый список с единым `hookIndex` — единственный способ сохранить порядок. Это ровно то,
как устроен React (единый связный список хуков с `memoizedState`, тип хука неявен по
позиции). Дискриминация делается явным полем `kind`, чтобы `commitFiberHooks` знал, какой
слот финализировать как state, а какой как effect.

**Конкретика типов (`src/hooks.ts`).** Превратить `Hook` в дискриминированное
объединение. Текущий `Hook` (интерфейс с `state`/`queue`) становится вариантом
`StateHook`; добавить `EffectHook`. `Fiber.hooks` остаётся `Hook[]`.

```ts
/** Discriminator so one hook list can mix state and effect slots by call order. */
export type HookKind = "state" | "effect";

/** A useState cell (Stage 6 Hook, unchanged fields; kind tag added). */
export interface StateHook {
  kind: "state";
  state: unknown;
  queue: unknown[];
}

/** A cleanup returned by an effect callback, or nothing. */
export type EffectCleanup = (() => void) | void;
/** The user's effect body: runs after commit, may return a cleanup. */
export type EffectCallback = () => EffectCleanup;

/**
 * One useEffect cell. DURABLE across renders (carried over from
 * `alternate.hooks` by index). Write discipline mirrors StateHook: the RENDER
 * phase NEVER mutates these fields — it only derives an EffectSnapshot. Both
 * `deps` and `cleanup` are written EXCLUSIVELY by the commit/passive phase
 * ({@link commitFiberHooks} + the passive runner), so a preempted render can
 * neither run an effect nor corrupt the durable prevDeps/cleanup.
 */
export interface EffectHook {
  kind: "effect";
  /** Deps of the LAST COMMITTED run; `undefined` means "no deps array". */
  deps: unknown[] | undefined;
  /** Cleanup returned by the last committed run of `create`; null if none. */
  cleanup: (() => void) | null;
}

export type Hook = StateHook | EffectHook;
```

**Render-снимок эффекта (`HookSnapshot`).** Сейчас `HookSnapshot` — плоский объект
`{ state, applied }` для state-хука. Сделать его тоже дискриминированным объединением,
параллельным `Hook` по индексу:

```ts
export interface StateHookSnapshot {
  kind: "state";
  state: unknown;
  applied: number;
}

/**
 * Render-phase decision for one effect slot. `shouldRun` is computed IN RENDER
 * by comparing `deps` against the durable EffectHook's committed `deps`, but it
 * is only ACTED ON at commit — the render never runs the effect nor touches the
 * durable cell. `create` is captured this render (closes over this render's
 * props/state). If the render is discarded, the snapshot dies with the WIP.
 */
export interface EffectHookSnapshot {
  kind: "effect";
  create: EffectCallback;
  deps: unknown[] | undefined;
  shouldRun: boolean;
}

export type HookSnapshot = StateHookSnapshot | EffectHookSnapshot;
```

`fiber.ts` импортирует `Hook`/`HookSnapshot` type-only (уже так) — граф импортов
остаётся ацикличным.

**Рамки.** Не вводить generic-dispatcher на произвольные хуки. Ровно два `kind`.
Существующие `useState`-тесты и внутренняя логика state-хука не меняются по поведению —
только добавляется поле `kind: "state"` (обновить создание StateHook в `useState`:
`{ kind: "state", state: initial, queue: [] }` и все места чтения).

### Развилка 2 — Write-дисциплина: snapshot-in-render / finalize-in-commit

**Решение.** Применить к `useEffect` тот же принцип, что handoff требует НЕ считать
самоочевидным для новых durable-хуков. Явно:

**Render-фаза (`useEffect` в `hooks.ts`) НЕ ДОЛЖНА:**
- запускать `create` или cleanup;
- писать в durable `EffectHook.deps` или `EffectHook.cleanup`;
- иначе оставлять след, видимый закоммиченному дереву до commit.

Render только:
- берёт `previous = fiber.alternate?.hooks?.[index]` (durable EffectHook прошлого
  закоммиченного рендера) или создаёт свежую durable-ячейку при первом рендере
  (`{ kind: "effect", deps: undefined, cleanup: null }` — но при первом рендере
  `shouldRun = true` всегда, независимо от начального `deps`);
- вычисляет `shouldRun = depsChanged(previous?.deps, nextDeps)` (Развилка 3), где для
  первого рендера (`previous === undefined`) `shouldRun = true`;
- кладёт durable-ячейку в `fiber.hooks[index]` (переиспользуя объект по ссылке из
  alternate — как `useState`, чтобы cleanup/deps переживали; при первом рендере — новый
  объект);
- кладёт `EffectHookSnapshot { kind: "effect", create, deps: nextDeps, shouldRun }` в
  `fiber.hookSnapshots[index]`.

**Важно про переиспользование durable-объекта по ссылке.** Как и `useState`, `useEffect`
переиспользует объект `EffectHook` из `alternate.hooks[index]` (не клонирует) — иначе
cleanup, накопленный в прошлом commit, потеряется. Но `deps`/`cleanup` этого объекта
**в render НЕ трогаются** — они читаются для сравнения и остаются нетронутыми до commit.
Это и есть защита от preemption: отброшенный WIP разделяет `EffectHook` по ссылке с
current-деревом (тот же механизм, что описан для `useState` в handoff «Находки ревью»),
поэтому мутировать его в render нельзя.

**Commit-фаза — единственный писатель.** Финализация эффекта происходит в
`commitFiberHooks` (расширенном) + passive-runner:
- `commitFiberHooks` для effect-слота, где `snapshot.shouldRun === true`, **регистрирует
  эффект к запуску** (собирает его в переданный аккумулятор — Развилка 4/5), но САМ
  `create` не вызывает (порядок и «после commit» — забота passive-фазы);
- запись durable `EffectHook.deps = snapshot.deps` делается в commit-фазе;
- запись `EffectHook.cleanup = <результат create>` делается passive-runner'ом ПОСЛЕ
  вызова `create` (см. Развилку 5 про порядок cleanup-prev/run-new).

Таким образом durable `deps`/`cleanup` пишутся исключительно для дерева, которое реально
стало `current` — preempted-рендер их не трогает. Это прямое исполнение требования
handoff.

### Развилка 3 — Сравнение deps

**Решение.** Хелпер `depsChanged(prev, next)` в `hooks.ts`:

```ts
/**
 * Whether an effect must re-run, comparing this render's deps to the last
 * committed run's deps. Semantics match React:
 *  - `next === undefined` (no deps array): ALWAYS run (return true).
 *  - `prev === undefined` (first commit): ALWAYS run (return true).
 *  - different length: run (best-effort; length change ⇒ deps changed).
 *  - otherwise: run iff any element differs by Object.is.
 */
function depsChanged(
  prev: unknown[] | undefined,
  next: unknown[] | undefined,
): boolean {
  if (next === undefined) return true;
  if (prev === undefined) return true;
  if (prev.length !== next.length) return true;
  for (let i = 0; i < next.length; i++) {
    if (!Object.is(prev[i], next[i])) return true;
  }
  return false;
}
```

**Обоснования частных случаев:**
- **`deps === undefined` (нет массива):** эффект запускается КАЖДЫЙ commit. Соответствует
  требованию POST_MVP и React.
- **`deps === []` (пустой массив):** запускается ОДИН раз (при первом commit `prev`
  undefined → true; далее длины совпадают, элементов нет → всегда false). «Once»
  получается автоматически, отдельной ветки не нужно.
- **Разная длина (баг пользователя — менял размер массива между рендерами):** трактовать
  как «изменились», перезапустить (best-effort). НЕ бросать ошибку. Обоснование: это
  учебный движок MVP-масштаба; rules-of-hooks (включая стабильную длину deps) в проекте
  документируются, но не энфорсятся рантаймом (см. докблок `hooks.ts`) — тот же принцип,
  что и «нельзя вызывать хуки условно, но рантайм не проверяет». Кидать на разную длину
  было бы строже, чем React (React лишь предупреждает в dev). Best-effort перезапуск
  безопаснее и проще.
- **Сравнение поэлементно `Object.is`** (не `===`): важно для `NaN` и `-0`, как в React.

### Развилка 4 — Фаза «passive effects после commit»: синхронно, сразу после `commitRoot`

**Решение (явная рекомендация с обоснованием).** Passive-эффекты запускаются
**синхронно, в том же тике, сразу после того, как `commitRoot` завершил DOM-эффекты и
финализацию хуков** — но, из-за реентрантности (см. ниже), НЕ внутри самого `commitRoot`.
`commitRoot` перестаёт вызывать `runPassiveEffects` сам — он СОБИРАЕТ `pending` и
**возвращает** его (`commitRoot(rootFiber): PendingEffect[]`). Запуск —
`runPassiveEffects(pending)` — переносится в `commitWip` (`scheduler.ts`), **строго
после** строк промоушена `current*`. Это единственная правка `scheduler.ts` во всём плане
— три строки в `commitWip`, механический реордеринг, БЕЗ изменения `workLoop`,
`shouldYield`, модели приоритетов/preemption, `scheduleWork`/`scheduleRerender`.

**Почему синхронно сразу после commit, а не отдельным async-тиком:**

1. **Соответствие духу проекта.** Commit в этом движке задокументирован как «синхронный,
   неделимый проход, без deadline-проверок» (`scheduler.ts` докблок; `fiber.ts`
   `commitRoot` докблок). Прерываемость — свойство ТОЛЬКО render-фазы (`workLoop` /
   `shouldYield`). Настоящий React выносит passive effects в отдельный планируемый тик
   после paint ради отзывчивости под большой нагрузкой — но это усложнение (двойная
   буферизация эффектов, отмена устаревших, флаш-перед-следующим-рендером), которое для
   учебного счётчика не даёт наблюдаемой пользы и противоречит принятой в проекте
   простоте «commit = один синхронный кусок».
2. **`scheduler.ts` трогается минимально и механически.** Отдельный async-тик потребовал
   бы новой очереди эффектов в планировщике, флаша перед следующим рендером, обработки
   preemption между commit и запуском эффектов — крупная правка ядра ради семантики,
   неотличимой в этом проекте. Единственная нужная правка — трёхстрочный реордеринг в
   `commitWip` (см. ниже, «Тонкость: setState ВНУТРИ эффекта») — не async-тик и не новая
   инфраструктура.
3. **Семантика «после commit» из POST_MVP соблюдена.** Требование — «эффекты запускаются
   ПОСЛЕ commit-фазы». Синхронный вызов сразу за `commitChildren`+`finalizeHooks`
   удовлетворяет ему буквально: к моменту запуска эффекта DOM УЖЕ обновлён (все
   DOM-мутации commit'а завершены), durable-хуки финализированы. Эффект видит актуальный
   DOM. «После commit» ≠ «в отдельном макротаске»; для этого проекта «после commit» =
   «после того как commit закончил трогать DOM, в том же синхронном проходе». Тесты будут
   утверждать именно это (эффект видит обновлённый DOM; эффект НЕ виден до commit).
4. **Тестируемость.** Синхронный запуск даёт детерминизм без прокрутки лишних тиков:
   короткий рендер + эффект коммитятся и прогоняют эффекты внутри `scheduleWork`, ровно
   как `useState`-тесты Этапа 6 (frozen clock + huge budget).

**Тонкость: setState ВНУТРИ эффекта — реентрантность, не просто «устаревший `current*`».**
Эффект может вызвать `setState`, что дёрнет `scheduleRerender` → `scheduleWork`. К этому
моменту `workLoop` уже вышел из рендер-цикла (`nextUnitOfWork === null`, иначе `commitWip`
не был бы вызван), так что `scheduleWork` видит «планировщик свободен» и **синхронно** —
в ТОЙ ЖЕ функции, реентрантно — запускает `startNextPendingRender(); workLoop();`. Если
этот вложенный рендер укладывается в бюджет (в тестах — huge budget), он тоже долетает до
`commitWip()`, вложенно, **пока внешний `commitWip` ещё не вернулся**.

Если бы `runPassiveEffects` вызывался ВНУТРИ `commitRoot` (как в первой версии этого
плана), это ломает не только первый mount, а **вообще любой** setState-из-эффекта:
вложенный `commitWip` корректно промотирует `current*` под СВОЙ (второй, более свежий)
рендер и возвращает управление; но внешний `commitWip` в этот момент ещё не выполнил свои
строки промоушена — он их выполняет ПОСЛЕ возврата из `commitRoot`, и они читают
`wipContainer`/`wipVNode` — модульные переменные, которые вложенный `commitWip` уже
сбросил в `null` в своём эпилоге. Внешний `commitWip` тогда затирает корректно
промотированные (вторым, вложенным коммитом) `currentContainer`/`currentVNode` обратно в
`null`, а `currentRoot` — своим локальным (первым, устаревшим) `root`. Результат:
`current*` после всего каскада описывает НИ первое, НИ второе дерево корректно — любое
последующее обновление того же контейнера продиффит против рассинхронизированного
`current*` (например, `currentContainer === null` ⇒ `hasPrev` ложно, следующий рендер
пойдёт по пути «чистый mount с нуля», хотя DOM уже заполнен вторым коммитом). Это баг
шире, чем «эффект на первом mount теряется» — это порча планировщика при ЛЮБОМ
синхронно завершающемся вложенном рендере, инициированном эффектом.

**Решение: `commitRoot` не запускает эффекты сам — он их СОБИРАЕТ и ВОЗВРАЩАЕТ; запуск
переносится в `commitWip`, СТРОГО после промоушена `current*`.**

```ts
// fiber.ts
export function commitRoot(rootFiber: Fiber): PendingEffect[] {
  commitChildren(rootFiber);                    // DOM mutations (Stage 4/6)
  const pending: PendingEffect[] = [];
  collectDeletionCleanups(rootFiber, pending);   // unmount cleanups (Развилка 6)
  finalizeHooks(rootFiber, pending);             // finalize state+effect hooks, gather runnable effects
  return pending;                                // NOT run here — see scheduler.ts commitWip
}
```

```ts
// scheduler.ts — commitWip, единственная правка во всём плане (3 строки):
function commitWip(): void {
  const root = wipRoot!;
  const pending = commitRoot(root);   // было: commitRoot(root); (void)
  currentContainer = wipContainer;
  currentRoot = root;
  currentVNode = wipVNode;
  wipRoot = null;
  wipVNode = null;
  wipContainer = null;
  runPassiveEffects(pending);         // НОВОЕ: после промоушена, не до
}
```

Почему это устраняет проблему полностью (не только для первого mount): после
`runPassiveEffects(pending)` в `commitWip` больше НЕТ кода, который трогает
`current*`/`wip*`. Сколько бы вложенных реентрантных `commitWip`-вызовов ни произошло
внутри `runPassiveEffects` (каждый — из-за `setState` очередного эффекта), каждый из них
самостоятельно и полностью проходит свой цикл «commit → промоушен → свои эффекты» и
корректно оставляет `current*` описывающим САМЫЙ СВЕЖИЙ коммит на момент своего возврата.
Внешнему вызову после этого нечем всё затереть — его собственная функция уже завершена.
Побочный эффект: **техдолг «setState на первом mount теряется» пропадает сам по себе** —
`currentContainer` к моменту запуска эффектов уже промотирован даже для самого первого
рендера, `scheduleRerender` найдёт контейнер и на первом mount тоже.

Тест-кейс 9 (ниже) поэтому проверяет setState-из-эффекта **и на первом mount, и на
повторном рендере** — оба случая теперь должны отрабатывать корректно, без оговорок.

**Побочные вызовы `commitRoot` вне scheduler (`fiber.test.ts`).** `commitRoot` теперь
возвращает `PendingEffect[]` вместо `void`. Прямые тесты `fiber.test.ts` (Этап 4,
`commitRoot(root)` без хуков/эффектов) не читают возвращаемое значение — их поведение не
меняется, `pending` там всегда пуст. Обновить только если `tsc --noEmit` пожалуется на
неиспользуемое значение (не должен — TS не требует использовать return value).

### Развилка 5 — Порядок выполнения эффектов и cleanup

**Решение по порядку между fiber'ами (обход дерева):** эффекты запускаются в порядке
обхода `finalizeHooks` — сейчас это **pre-order** (родитель, потом дети:
`commitFiberHooks(fiber)` вызывается ДО рекурсии в детей). React запускает passive
effects в порядке «дети раньше родителей» (post-order commit). **Решение: сменить обход
сбора эффектов на post-order** (сначала рекурсия в детей, потом текущий fiber), чтобы
эффект родителя видел, что эффекты детей уже отработали — ближе к React и интуитивнее
(родительский эффект — «внешний»). Cleanup при этом в React идёт в том же порядке, что и
эффекты. Для учебного объёма достаточно одного консистентного порядка; выбрать
**post-order (дети → родитель)** и зафиксировать комментарием + тестом на порядок.

Замечание: финализация STATE-хуков (`commitFiberHooks` для state-слотов) порядок-
нечувствительна (чистая запись `hook.state`), поэтому смена pre→post order её не ломает.
Убедиться, что перестановка не задевает существующие state-тесты (они не проверяют
порядок финализации между fiber'ами).

**Решение по порядку cleanup-prev vs run-new (для ОДНОГО эффекта при повторном рендере):**
строго **cleanup предыдущего → затем новый `create`** (как React). Конкретно в
`runPassiveEffects` для каждого запускаемого эффекта:
```
if (effect.cleanup !== null) effect.cleanup();   // cleanup of previous run
const newCleanup = effect.create();              // run new effect
effect.hook.cleanup = (typeof newCleanup === "function") ? newCleanup : null;
```
Запись `hook.cleanup` — здесь, в passive-runner (единственный писатель `cleanup`,
Развилка 2). `hook.deps` уже записан в `commitFiberHooks`.

**Порядок «все cleanup, потом все create»?** React в passive-фазе сначала прогоняет ВСЕ
cleanup'ы дерева, затем ВСЕ create'ы (два прохода), чтобы cleanup одного эффекта не видел
состояние после create другого. **Решение для MVP: НЕ разделять на два прохода** — для
каждого эффекта cleanup-then-create подряд. Обоснование: два прохода усложняют без
наблюдаемой пользы в учебном счётчике (эффекты независимы, между-эффектные зависимости
через DOM в скоупе тестов не возникают). Зафиксировать как осознанное упрощение в
комментарии. Если тест на межэффектный порядок понадобится — поднять до двух проходов, но
по умолчанию не усложнять.

**Cleanup при unmount** — Развилка 6.

### Развилка 6 — Cleanup при удалении (DELETION)

**Проблема.** `finalizeHooks` Этапа 6 обходит только ЗАКОММИЧЕННОЕ WIP-дерево (живые
`child`/`sibling`), а удаляемые поддеревья висят на `fiber.deletions` и в обход не
попадают — их durable-хуки «уходят в небытие» (handoff). Для `useEffect` это баг: cleanup
удаляемого компонента обязан вызваться.

**Решение.** Добавить обход удаляемых поддеревьев для сбора cleanup'ов. Каждый
DELETION-fiber (в `fiber.deletions` любого fiber'а закоммиченного дерева) может содержать
компонентные fiber'ы с durable `EffectHook.cleanup !== null`; их надо вызвать.

- Новая функция `collectDeletionCleanups(fiber, pending)` в `fiber.ts`: рекурсивно
  обходит ВСЁ закоммиченное дерево (как `finalizeHooks`), и для каждого fiber'а — его
  `fiber.deletions`; для каждого DELETION-fiber'а спускается по его поддереву (`child`/
  `sibling` — у DELETION-fiber'а `child` указывает на прошлый child-результат, см.
  `addDeletion` в `fiber.ts`, где `child: prev.fiber?.child`) и на каждом компонентном
  fiber'е внутри собирает cleanup'ы всех его effect-хуков в `pending` как «cleanup-only»
  записи (без нового `create`).
- Собирает через хелпер в `hooks.ts`, напр. `collectFiberCleanups(fiber, pending)`,
  который для компонентного fiber'а пробегает `fiber.hooks`, и для каждого
  `kind === "effect"` с `cleanup !== null` кладёт cleanup в `pending`.

**Порядок относительно физического удаления DOM.** `commitDeletions` (внутри
`commitChildren`/`placeChildren`) уже удаляет host-DOM во время `commitChildren`, то есть
ДО того, как в `commitRoot` дойдёт очередь до сбора/запуска эффектов. **Решение:** собрать
cleanup'ы DELETION в `pending` МОЖНО в любой момент (данные — durable-хуки, живут на
fiber'ах независимо от DOM), а ВЫЗВАТЬ их — в `runPassiveEffects`, то есть ПОСЛЕ
физического удаления DOM. Это приемлемо и проще: cleanup обычно освобождает подписки/
таймеры, а не читает удаляемый DOM; порядок «DOM удалён → cleanup вызван» безопасен для
учебного объёма. **Обоснование выбора «после удаления DOM»:** commit — единый синхронный
проход, DOM-мутации в нём идут первыми (это существующая архитектура Этапа 4/6, менять её
ради «cleanup до removeChild» — крупная перестройка `commitChildren` без наблюдаемой
пользы). Зафиксировать комментарием.

**Порядок unmount-cleanup относительно update-эффектов.** В `runPassiveEffects` сначала
прогнать unmount-cleanup'ы (от DELETION), затем update/mount-эффекты — или наоборот. React
делает cleanup'ы (включая unmount) в отдельном первом проходе. **Решение:** unmount-
cleanup'ы кладём в `pending` первыми (собираются `collectDeletionCleanups` до
`finalizeHooks`) и `runPassiveEffects` исполняет `pending` по порядку — значит unmount-
cleanup'ы идут раньше mount/update-create'ов. Приемлемо и предсказуемо.

**Важно:** DELETION-cleanup — это cleanup УЖЕ ЗАКОММИЧЕННОГО ранее эффекта (durable
`cleanup` на прошлом fiber'е), поэтому он всегда безопасен к вызову (не зависит от
preemption текущего рендера — прошлый эффект реально отработал в прошлом commit).

### Развилка 7 — Точки вызова и сигнатуры (`fiber.ts` / `hooks.ts`)

**`hooks.ts` — новое/изменённое:**

- `export function useEffect(create: EffectCallback, deps?: unknown[]): void`
  — читает `currentFiber`/`hookIndex` (как `useState`), кидает при вызове вне рендера
  (та же ошибка-гвард, что у `useState`); переиспользует durable EffectHook из
  `alternate`; вычисляет `shouldRun` через `depsChanged`; кладёт durable в
  `fiber.hooks[index]` и `EffectHookSnapshot` в `fiber.hookSnapshots[index]`. Ничего не
  запускает.
- Изменить `useState`: помечать создаваемый Hook `kind: "state"`; в `HookSnapshot`
  добавить `kind: "state"`. Логика деривации не меняется.
- Тип аккумулятора passive-эффектов (общий для `fiber.ts`), напр.:
  ```ts
  /** A unit of passive work gathered at commit, run after commit. */
  export interface PendingEffect {
    /** cleanup of the PREVIOUS committed run (or a DELETION's cleanup); null if none. */
    cleanup: (() => void) | null;
    /** the new effect body to run; null for a DELETION (cleanup-only). */
    create: EffectCallback | null;
    /** durable hook to write the new cleanup back into; null for DELETION-only. */
    hook: EffectHook | null;
  }
  ```
- Изменить `commitFiberHooks(fiber: Fiber, pending: PendingEffect[]): void` — добавить
  параметр-аккумулятор. Для state-слота — как раньше (записать `hook.state`, дренировать
  очередь на `applied`). Для effect-слота, где `snapshot.shouldRun`: записать durable
  `hook.deps = snapshot.deps`; если `snapshot.shouldRun`, положить в `pending`:
  `{ cleanup: hook.cleanup, create: snapshot.create, hook }`. (cleanup прошлого прогона
  берётся из durable до его перезаписи; сама перезапись `hook.cleanup` — позже, в
  runner'е.) Если `!shouldRun` — эффект пропускается (durable `deps` не переписывается на
  тот же — можно переписать безусловно, значения равны; для чистоты писать `deps` только
  когда `shouldRun`, чтобы не терять «дату последнего запуска» — на семантику не влияет,
  но писать безусловно проще и корректно, т.к. deps равны; выбрать: писать `deps`
  безусловно). Финализация также должна занулить `fiber.hookSnapshots` в конце (как
  сейчас).
- `export function collectFiberCleanups(fiber: Fiber, pending: PendingEffect[]): void`
  — для компонентного fiber'а: по каждому effect-хуку с `cleanup !== null` добавить
  `{ cleanup: hook.cleanup, create: null, hook: null }` в `pending`. Используется обоими:
  `collectDeletionCleanups` (unmount) — да; для update-эффектов cleanup идёт через
  `commitFiberHooks` (там есть новый create), так что этот хелпер — только для
  DELETION-поддеревьев.
- `export function runPassiveEffects(pending: PendingEffect[]): void` — по порядку: для
  каждой записи `if (cleanup) cleanup();` затем `if (create) { const c = create(); if
  (hook) hook.cleanup = typeof c === "function" ? c : null; }`. (Для DELETION-записи
  `create === null`, `hook === null` — только cleanup.)

**`fiber.ts` — изменённое:**

- `commitRoot(rootFiber): PendingEffect[]` (сигнатура меняется с `void`): собрать
  `const pending: PendingEffect[] = []`; вызвать
  `collectDeletionCleanups(rootFiber, pending)` → `finalizeHooks(rootFiber, pending)` →
  **вернуть** `pending` (НЕ вызывать `runPassiveEffects` здесь — см. Развилка 4,
  реентрантность). Порядок в теле: DOM (`commitChildren`) уже выполнен раньше; сбор
  DELETION-cleanup'ов и финализация хуков — после, возврат — последним шагом.
- `finalizeHooks(fiber, pending)`: сменить на **post-order** (сначала рекурсия в детей,
  потом `if (isComponentFiber(fiber)) commitFiberHooks(fiber, pending)`), передавать
  `pending` дальше.
- Новая `collectDeletionCleanups(fiber, pending)`: рекурсивный обход живого дерева; на
  каждом fiber'е — по его `fiber.deletions`, для каждого DELETION-fiber'а обойти его
  поддерево и на компонентных fiber'ах вызвать `collectFiberCleanups`. Рекурсия (не
  нерекурсивный walk) — commit-фаза, здесь рекурсия разрешена (как `finalizeHooks`).
- Импорты в `fiber.ts` из `hooks.ts`: добавить `commitFiberHooks` (уже есть),
  `collectFiberCleanups`, тип `PendingEffect` (`runPassiveEffects` в `fiber.ts` НЕ нужен —
  он вызывается из `scheduler.ts`, см. ниже). Значение-импорт `hooks.ts` в `fiber.ts` уже
  существует — цикла нет (`hooks.ts` импортирует `fiber.ts` только type-only).

**`scheduler.ts` — изменённое (единственная правка вне `hooks.ts`/`fiber.ts`):**

- Добавить импорт `runPassiveEffects` (и, если нужно для типа, `PendingEffect`) из
  `./hooks.js`.
- `commitWip()`: заменить `commitRoot(root);` на `const pending = commitRoot(root);`,
  переставить его результат — вызвать `runPassiveEffects(pending);` последней строкой
  функции, ПОСЛЕ `wipContainer = null;` (после всего эпилога промоушена/сброса). Никакие
  другие строки `commitWip`, и никакой другой код `scheduler.ts`, не меняются.

**Нерекурсивность render-walk сохраняется:** `useEffect` — обычный вызов в теле
компонента внутри одной единицы работы (как `useState`), DOM не трогает, только пишет
snapshot на WIP-fiber. Прерывание между единицами безопасно. Вся новая работа — в
синхронной commit-фазе (рекурсия там разрешена) плюс точечная правка `commitWip`.

**`src/index.ts`:** добавить `export { useEffect } from "./hooks.js";`. Внутренние
(`commitFiberHooks`, `runPassiveEffects`, `collectFiberCleanups`, `PendingEffect`,
`EffectHook` и пр.) — НЕ ре-экспортировать (внутренний контракт). Можно экспортировать
публичные типы `EffectCallback`/`EffectCleanup`, если полезно потребителям — по
усмотрению; минимально достаточно `useEffect`.

---

## Совместимость с инвариантами (не сломать)

- **`scheduler.ts` трогается только точечно** — `commitWip` (3 строки: захват возврата
  `commitRoot`, вызов `runPassiveEffects` после промоушена `current*`); `workLoop`,
  `shouldYield`, приоритеты/preemption, `scheduleWork`/`scheduleRerender` не меняются.
- **Нерекурсивность render-обхода** — `useEffect` не добавляет рекурсии в render.
- **Атомарность/синхронность commit** — DOM-мутации и финализация хуков остаются внутри
  `commitRoot`, синхронно, без deadline-проверок; passive-эффекты запускаются сразу следом
  в `commitWip`, тоже синхронно, тем же тиком (Развилка 4) — не отдельным async-шагом.
- **Write-дисциплина хуков** — durable `EffectHook.deps`/`cleanup` пишутся только в
  commit/passive-фазе; render только снимает (Развилка 2). Тот же инвариант, что у
  `useState`.
- **Существующие тесты** `hooks.test.ts` (93 кейса), `fiber.test.ts`,
  `scheduler.test.ts`, `reconciler.test.ts`, `render.test.ts`, `index.test.ts` — должны
  остаться зелёными без правки ожиданий. Если `useState`-тест приходится править из-за
  добавления `kind` — это допустимо только если тест лез во внутреннюю форму `Hook`
  (маловероятно — тесты на DOM); правка ожиданий на DOM-поведение = сигнал регрессии.

## Тест-кейсы (`src/hooks.test.ts`, jsdom + Vitest)

Паттерн: побочный эффект пишет в массив-логгер, объявленный в тесте; утверждаем на
логгере И на итоговом DOM. Короткие рендеры коммитятся синхронно внутри `scheduleWork`
(frozen clock + huge budget через `installSyncDeps`, как в существующих тестах).
Обязательные (закрывают требования POST_MVP + развилки):

1. **Эффект запускается ПОСЛЕ commit, не до.** Компонент с `useEffect(() =>
   { log.push(container.querySelector("p")?.textContent) })`. После mount: `log`
   содержит текст, который УЖЕ в DOM (эффект видел обновлённый DOM). Проверяет
   «после commit» и что DOM к моменту эффекта готов. Дополнительно: эффект НЕ выполнился
   во время render (можно косвенно — лог length 1 после одного commit).
2. **`deps === []` → эффект один раз (mount only).** Два рендера контейнера (mount +
   один `setState`, меняющий несвязанный state), `useEffect(fn, [])` — `fn` вызван
   ровно 1 раз.
3. **`deps` без массива (`undefined`) → каждый commit.** `useEffect(fn)` без deps; после
   mount + одного re-render `fn` вызван 2 раза.
4. **`deps` с изменившимся значением → cleanup затем повторный запуск.** `useEffect(() =>
   { log.push("run"); return () => log.push("cleanup"); }, [dep])`. Рендер 1: dep=0.
   Рендер 2: dep=1. Ожидаемый `log`: `["run", "cleanup", "run"]` — cleanup ПРЕДЫДУЩЕГО
   перед новым запуском (Развилка 5). Рендер 3 с dep=1 (не изменился) — эффект НЕ
   перезапускается (лог не растёт).
5. **Unmount → cleanup вызывается.** Компонент с `useEffect(() => () =>
   log.push("cleanup"))` внутри дерева; переход к дереву без компонента (или
   `cond && h(Comp)` → false). После commit удаления `log` содержит `"cleanup"`, host-
   узлы компонента удалены из DOM (Развилка 6).
6. **Вложенный unmount (компонент внутри компонента) → cleanup обоих.** `Outer`
   рендерит `Inner`, у обоих `useEffect` с cleanup; удаление `Outer` из дерева вызывает
   cleanup И `Inner`, И `Outer` (обход DELETION-поддерева спускается сквозь компонентные
   уровни).
7. **Порядок между fiber'ами: дети раньше родителя.** `Outer`(useEffect) →
   `Inner`(useEffect); при mount `log` показывает Inner-эффект РАНЬШЕ Outer-эффекта
   (post-order, Развилка 5).
8. **Несколько хуков вперемешку (state + effect + state) в одном компоненте.** Порядок
   слотов не путается: два `useState` и `useEffect` между ними; `setState` первого не
   мешает эффекту и второму state (Развилка 1 — единый hook-list по call-order).
9. **setState внутри эффекта инициирует ещё один рендер — на первом mount И на повторном
   рендере.** Два подкейса (Развилка 4, реордеринг `commitWip` чинит оба одинаково):
   (а) на ПЕРВОМ рендере компонента эффект зовёт `setState` — проверить, что реентрантный
   `scheduleWork` находит контейнер (`currentContainer` уже промотирован к этому моменту)
   и DOM после каскада отражает инкрементированное состояние; (б) то же на ВТОРОМ рендере
   (контейнер уже был смонтирован). Дополнительно проверить, что `currentRoot`/
   `currentVNode`/`currentContainer` после каскада синхронных вложенных коммитов
   консистентны — следующий независимый `setState` того же контейнера диффит корректно
   (не уходит в «чистый remount», что было бы симптомом реентрантной порчи `current*`).
10. **Регресс на preemption (аналог теста Этапа 6 для `useState`).** Тот же сценарий:
    многотиковый (растянутый на тики) рендер контейнера с компонентом, использующим
    `useEffect`, ПРЕРЫВАЕТСЯ более приоритетным `setState`/`scheduleWork` того же
    контейнера ДО commit. Проверить: (а) эффект отброшенного рендера **НЕ запустился**
    (лог не получил его запись); (б) durable `EffectHook.deps`/`cleanup` НЕ испорчены
    отброшенным рендером — вытесняющий закоммиченный рендер видит корректный prevDeps и
    принимает правильное решение о запуске. Использовать управляемые deps (`stepping`
    clock + `ticks`-очередь), как в существующем тесте «вытесненный рендер не дренирует
    очередь хука» (`hooks.test.ts:331`). Свидетель: счётчик запусков эффекта = ровно
    число КОММИТОВ, не рендеров; отброшенный WIP не инкрементирует.

Где рендер не умещается в бюджет (кейсы 9-10) — управляемые deps + прокрутка тиков, как в
`scheduler.test.ts`/существующих preemption-тестах `hooks.test.ts`.

## Определение готовности (DoD)

- `npx tsc --noEmit` — чисто (дискриминированные `Hook`/`HookSnapshot` без `any`;
  effect-типы строгие).
- `npm test` — зелёный; все новые кейсы (1-10) проходят; существующие 93 кейса и тесты
  Этапов 1-6 остаются зелёными без правки ожиданий на DOM-поведение.
- `useEffect` реализован; passive-фаза запускается синхронно после commit; cleanup
  вызывается при повторном запуске (deps изменились) и при unmount (включая вложенный).
- `scheduler.ts` изменён только в `commitWip` (реордеринг, 3 строки); `workLoop`,
  `shouldYield`, приоритеты/preemption, `scheduleWork`/`scheduleRerender` — без изменений.
- Публичный API: `useEffect` в `src/index.ts`; внутренние мосты не протекают.
- Дизайн-гэп Этапа 6 «удалённые поддеревья не финализируются» — закрыт для эффектов
  (cleanup при DELETION).
- `docs/POST_MVP_PLAN.md`: раздел «1. `useEffect`» отметить как готовый на шаге
  финального просмотра (после реализации, не в этом плане).

## Техдолг, фиксируемый сознательно (в код-комментарии + handoff)

- **Passive-эффекты синхронны (нет отдельного тика после paint)** — в отличие от React.
  Осознанное упрощение под учебный масштаб (Развилка 4). Триггер: мини-бенчмарк
  (POST_MVP §5) покажет, что синхронные эффекты блокируют отзывчивость.
- **Cleanup вызывается ПОСЛЕ физического удаления DOM** (Развилка 6) — cleanup не должен
  полагаться на присутствие удаляемого DOM. Приемлемо для учебного объёма.
- **Один проход cleanup-then-create на эффект** (не два раздельных прохода как React,
  Развилка 5) — межэффектные зависимости через DOM в скоуп не входят.
