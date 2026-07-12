# CLAUDE.md

Гайд для Claude Code (claude.ai/code) по работе в репозитории `vdom-fiber`.

## О проекте

Учебная мини-реализация React на TypeScript: собственный Virtual DOM + Fiber-подобный
прерываемый планировщик рендеринга. Соло-разработчик, AI-ассистированная разработка.
Не бизнес-проект — цель в технической сложности и обучении. Экономика не оценивается.

Документация: [docs/PLAN.md](docs/PLAN.md), [docs/TECHNICAL_PLAN.md](docs/TECHNICAL_PLAN.md),
[docs/POST_MVP_PLAN.md](docs/POST_MVP_PLAN.md). Конвенции —
[.claude/skills/ts-vdom-fiber-dev/SKILL.md](.claude/skills/ts-vdom-fiber-dev/SKILL.md).

## Структура

| Путь | Содержимое |
|---|---|
| `src/` | исходники библиотеки (TypeScript, ESM) + тесты рядом (`*.test.ts`) |
| `docs/` | PLAN / TECHNICAL_PLAN / POST_MVP_PLAN |
| `.claude/skills/ts-vdom-fiber-dev/` | скилл с конвенциями проекта |

Ключевые модули: `createElement.ts` (Этап 1) → `render.ts` (2) → `reconciler.ts` (3)
→ `fiber.ts` (4) → `scheduler.ts` (5) → `hooks.ts` (6). `index.ts` — публичный ре-экспорт.

## Команды

```bash
npm install
npx tsc --noEmit       # проверка типов (== npm run typecheck / lint)
npm test               # Vitest run
npm run test:watch     # Vitest watch
npm run test:coverage  # покрытие (v8)
npm run build          # tsc-сборка в dist/
```

Docker Compose не нужен — библиотека без сервисного рантайма.

## Конвенции

- **Язык:** документация и subject коммитов — на **русском**; код, идентификаторы и
  комментарии в коде — на **английском**.
- **Коммиты:** conventional-commit с русским subject, напр.
  `feat(scheduler): реализовать прерываемый work loop через MessageChannel`.
  Завершать коммит trailer'ом `Co-Authored-By: Claude`.
- **Ветки:** отдельная ветка от `master` на каждый Этап (напр. `stage-3/reconciler`) → PR → merge в `master`.
- Перед коммитом: `npx tsc --noEmit` чисто и `npm test` зелёный. Новый код покрыт
  тестами на итоговое DOM-дерево (jsdom + Vitest).
- JSX в MVP не используется — hyperscript-API (`h`/`createElement`). Обоснование —
  в TECHNICAL_PLAN и SKILL.

## Пайплайн разработки этапа

Проверенный портфельный пайплайн (НЕ Fable-based):

1. **Opus 4.8** — планирование этапа + написание кода.
2. **Sonnet 5** (основной чат) — проверка тестового покрытия, написание/прогон тестов,
   проверка работоспособности.
3. **Opus** (Agent-тул, `model: opus`) — независимое ревью `/code-review` на diff ветки.
4. Цикл исправлений — до **3 итераций** между ревью и правками.
5. **Commit + push + PR** (conventional-commit, русский subject) в `master`; после
   зелёного ревью — merge.

Git-workflow: новая ветка от `master` на каждый Этап → PR → merge в `master`.
