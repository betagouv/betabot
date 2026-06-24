# affinate — Human-in-the-Loop Dataset Refinement TUI

## Purpose

`affinate.ts` is a terminal UI for reviewing eval failures, adding new fixtures, and tracking tool-routing quality over time. Run it with:

```sh
npm run affinate
```

## Architecture

```
affinate.ts                     # Entry point: main menu loop
src/tui/
  types.ts                      # Fixture, ToolCall, CaseResult, RunResult, AppState
  data.ts                       # loadFixtures, saveFixtures, loadRuns, computeToolStats, generateId
  screens/
    dashboard.ts                # Pass-rate trend + per-tool failure breakdown
    review-queue.ts             # Step through failures, fix/label/delete fixtures
    live-query.ts               # Run a question, see tool calls, save as fixture
    fixture-browser.ts          # Search/browse all fixtures with pass/fail status
    eval-runner.ts              # Spawn eval subprocess, stream progress
  ui/
    sparkline.ts                # Block-char sparkline + bar renderer
    colors.ts                   # Chalk color helpers
```

## Screens

### Dashboard
Loads all `evals/results/*.json`, renders:
- Pass-rate sparkline over last N runs
- Per-tool failure table sorted by pass rate ascending
- Summary of passing tools

### Review Queue
Iterates over failures from the latest eval run. For each failure, shows:
- The question, expected tools, actual tools called
- Confusion type: `no-tool-called` / `wrong-tool` / `partial-match` / `extra-tool`

Actions: fix expected tools (multiselect), mark as model_error/ambiguous, annotate, delete.
Every mutation calls `saveFixtures()` immediately.

### Live Query
Two modes:
- **Canned**: fast routing test using mock tool responses (same CANNED map as `evals/run.ts`)
- **Live**: real tool execution via `Orchestrator.handle()` with `onToolCall` callback

After seeing tool calls and response, user can save as a new fixture or discard.

### Fixture Browser
Text filter over fixtures. Shows pass/fail from latest run per fixture.
Supports editing question text and annotation notes; delete.

### Eval Runner
Spawns `node --env-file=.env --import tsx/esm evals/run.ts` as a child process,
streams stdout live, reloads state when done.

## Data Flow

- **Fixtures** are read from and written to `evals/fixtures.json` (preserves 2-space indent).
- **Run results** are read from `evals/results/*.json` (read-only; written by `evals/run.ts`).
- `AppState` is reloaded after every screen transition to stay current.

## Orchestrator integration

`src/orchestrator.ts` `handle()` accepts an optional `onToolCall` callback:
```typescript
onToolCall?: (name: string, args: Record<string, unknown>) => void
```
This is used by live-query mode to capture tool calls in order without modifying core logic.

## Fixture affination fields

The following optional fields are added to fixtures by the TUI (not used by `evals/run.ts`):

| Field | Values | Meaning |
|---|---|---|
| `annotation` | string | Human note explaining the case |
| `review_status` | `"ok"` / `"model_error"` / `"ambiguous"` | Outcome of human review |
| `reviewed_at` | ISO string | Timestamp of last review |
