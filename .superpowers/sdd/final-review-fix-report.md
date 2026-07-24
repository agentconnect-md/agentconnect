# Final Review Fix Report — task-13-watch branch

## C1: Stop double-dispatching consolidated Slack messages

- `src/slack/connection.ts`: Changed `SlackDeps.onMessage` type from `(integrationId: string, msg: NormalizedMessage) => void` to `(msg: NormalizedMessage) => void`. Removed the `for (const {integrationId} of this.deps.group.integrations)` loop; now calls `this.deps.onMessage(msg)` exactly once per physical Slack event.
- `src/daemon.ts`: Changed `onInbound` signature from `(integrationId: string, msg: NormalizedMessage)` to `(msg: NormalizedMessage)`. Body now calls `this.dispatch(result.agentId, msg, result.integrationId)`. Updated `SlackConnection` construction's `onMessage` callback to `(msg) => this.onInbound(msg)`.

## I1: Reply on the ROUTED integration's connection

- `src/daemon.ts`: Added optional `integrationId?: string` param to `dispatch`. Updated `replyConnFor(agentId, integrationId?)` to resolve `intId = integrationId ?? this.agents.get(agentId)?.integrations[0]?.id` — explicit routed integration wins; fallback to `integrations[0]` for the cron path. `dispatch` passes `integrationId` through to `replyConnFor`.

## I2: Surface streaming post errors

- `src/daemon.ts`: Added `.catch((err) => console.error("slack post failed:", err))` to the fire-and-forget `void p.conn?.postMessage(...)` call in `onAcpUpdate`.

## Host-start race: Memoize start()

- `src/daemon.ts`: Added `private hostStarts = new Map<string, Promise<void>>()`. Replaced `__started` flag logic in `ensureHostAsync` with: get host via `ensureHost`, check/set `hostStarts` map, `await` the memoized promise. Added `this.hostStarts.delete(id)` in `reconcile()` so re-added agents restart cleanly.

## Tests

- Updated `onMessage` callback in `SlackConnection` construction (C1 — signature change propagated).
- Added C1 regression test `"C1 regression: single onInbound call dispatches exactly once (no double-dispatch)"` in `test/daemon-smoke.test.ts`. Spies on `dispatch` and asserts `onInbound` calls it at most once per message event.
- All 14 test files, 33 tests pass. Typecheck clean. Build clean.
