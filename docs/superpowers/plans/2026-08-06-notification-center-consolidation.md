# Notification Center Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the notification trigger with console chrome and replace Session/Usage access-degradation banners with deduplicated, actionable notification-center entries.

**Architecture:** Pure normalization converts authoritative Session and Usage access snapshots into notification descriptors. The notification provider atomically synchronizes each scope while persisting active-source tombstones separately from visible history. Shell owns the observer, while the panel and toast render serializable actions.

**Tech Stack:** TypeScript, React 19, Next.js 16, SWR, Tailwind 4, Vitest, Testing Library-compatible React DOM utilities.

---

### Task 1: Normalize Session and Usage access issues

**Files:**

- Create: `packages/web/src/lib/session-access-notifications.ts`
- Create: `packages/web/src/lib/session-access-notifications.test.ts`
- Delete after migration: `packages/web/src/components/console/SessionAccessNotice.tsx`
- Delete after migration: `packages/web/src/components/console/SessionAccessNotice.test.tsx`

- [ ] **Step 1: Write failing normalization tests**

Cover one notification per classified region/reason, canonical generic collapse, distinct Session/Usage keys, quota admin links, authorization Profile links, and impact-specific copy. Also prove `degraded: true` with no usable issue diagnostics emits `<surface>:generic:unavailable`, preserving the existing generic-banner behavior.

```ts
expect(sessionAccessNotifications('sessions', true, issues, (path) => `/acme${path}`)).toEqual([
  expect.objectContaining({
    sourceKey: 'sessions:feishu:lark:quota',
    title: 'Lark API quota exhausted',
    action: { label: 'Open Lark Admin', href: 'https://www.larksuite.com/admin', external: true }
  })
])
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @agentconnect.md/web test -- src/lib/session-access-notifications.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure normalizer**

Define a serializable descriptor and deterministic normalization:

```ts
export function sessionAccessNotifications(
  surface: 'sessions' | 'usage',
  degraded: boolean,
  issues: readonly SessionAccessIssue[],
  orgPath: (path: string) => string
): SessionAccessNotificationInput[]
```

Use `<surface>:generic:unavailable` for unsupported providers, unavailable reasons, missing/invalid Feishu regions, or a degraded snapshot with no otherwise normalized issue. A clean snapshot returns no items. Deduplicate by `sourceKey` and return deterministic order.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm --filter @agentconnect.md/web test -- src/lib/session-access-notifications.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/session-access-notifications.ts packages/web/src/lib/session-access-notifications.test.ts
git commit -m "feat(web): normalize session access notifications"
```

### Task 2: Add atomic notification-source synchronization

**Files:**

- Modify: `packages/web/src/lib/notifications.tsx`
- Create: `packages/web/src/lib/notifications.test.tsx`

- [ ] **Step 1: Write failing provider/state tests**

Exercise first observation, repeat update preserving read/timestamp, resolution, recurrence, per-scope isolation, and storage failure. Add explicit reload sequences for both clear and eviction: create an active source, clear or evict its visible row, persist, reload provider state, and prove the same active snapshot remains suppressed. Then synchronize a trustworthy empty snapshot and prove a later recurrence creates exactly one new item and toast.

```ts
const first = syncSourceSnapshot(emptyState, 'sessions-access', [item], now)
const repeated = syncSourceSnapshot(markRead(first.state), 'sessions-access', [{ ...item, message: 'updated' }], later)
expect(repeated.added).toEqual([])
expect(repeated.state.notifications[0]).toMatchObject({ read: true, timestamp: now, message: 'updated' })
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @agentconnect.md/web test -- src/lib/notifications.test.tsx`

Expected: FAIL because snapshot synchronization and access notification types are missing.

- [ ] **Step 3: Implement the minimal state contract**

Add `session_access`, `NotificationAction`, required `sourceKey` for access inputs/items, `resolvedAt`, and:

```ts
syncSourceSnapshot(scope: NotificationSourceScope, items: SessionAccessNotificationInput[]): void
```

Keep provider state as `{ notifications, activeSources }`; persist active keys separately by organization. `clearAll` clears visible history/toasts only. Snapshot synchronization updates active rows without changing `read`/`timestamp`, resolves absent keys for only that scope, and emits toasts only for newly active keys.

- [ ] **Step 4: Run focused and existing notification tests**

Run: `pnpm --filter @agentconnect.md/web test -- src/lib/notifications.test.tsx src/lib/daemon-notifications.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/notifications.tsx packages/web/src/lib/notifications.test.tsx
git commit -m "feat(web): synchronize notification sources"
```

### Task 3: Expose authoritative access snapshots and observe them in Shell

**Files:**

- Modify: `packages/web/src/lib/use-session-list.ts`
- Modify: `packages/web/src/lib/data-context.tsx`
- Create: `packages/web/src/lib/access-notification-snapshot.ts`
- Create: `packages/web/src/lib/access-notification-snapshot.test.ts`
- Create: `packages/web/src/lib/session-access-notifier.ts`
- Create: `packages/web/src/lib/session-access-notifier.test.tsx`
- Modify: `packages/web/src/components/console/Shell.tsx`

- [ ] **Step 1: Write failing observer tests**

First test an extracted pure snapshot gate. Prove initial load, active validation, any request error, partial page-chain refresh, filtered Session reads, and a settled response with absent optional access diagnostics return `null`; prove a settled unfiltered response with explicit `accessSyncDegraded: false` returns a trustworthy clean snapshot. Apply the same gate to Usage and prove a Usage SWR failure returns `null`.

Then verify ready snapshots synchronize both scopes, while null snapshots do nothing. Verify Session uses the unfiltered global list snapshot and Usage uses the existing `d1` global read.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @agentconnect.md/web test -- src/lib/access-notification-snapshot.test.ts src/lib/session-access-notifier.test.tsx`

Expected: FAIL because the observer does not exist.

- [ ] **Step 3: Expose trustworthy snapshots**

Create a pure `accessNotificationSnapshot` gate shared by Session and Usage. It accepts the response metadata plus `{ authoritative, isLoading, isValidating, error }` and returns a snapshot only when the source is authoritative, fully settled, and explicitly carries access diagnostics (`accessSyncDegraded` is present). This distinguishes a clean result from an older/partial response that omitted the optional fields. `useSessionList` exposes an access snapshot only when its filter set is empty and its entire request chain is successfully settled. `ConsoleData` exposes nullable `sessionAccessSnapshot` and `usageAccessSnapshot`; SWR loading, validating, error, or absent-diagnostic states expose `null` so they cannot resolve sources.

- [ ] **Step 4: Implement and mount the observer**

Create `useSessionAccessNotifier({ sessionAccessSnapshot, usageAccessSnapshot, orgPath })`. It normalizes each non-null snapshot and calls `syncSourceSnapshot` for `sessions-access` or `usage-access`. Mount it beside `useDaemonNotifier` under `NotificationProvider`.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
pnpm --filter @agentconnect.md/web test -- src/lib/access-notification-snapshot.test.ts src/lib/session-access-notifier.test.tsx
pnpm --filter @agentconnect.md/web typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/lib/use-session-list.ts packages/web/src/lib/data-context.tsx packages/web/src/lib/access-notification-snapshot.ts packages/web/src/lib/access-notification-snapshot.test.ts packages/web/src/lib/session-access-notifier.ts packages/web/src/lib/session-access-notifier.test.tsx packages/web/src/components/console/Shell.tsx
git commit -m "feat(web): observe session access notifications"
```

### Task 4: Render aligned triggers and actionable entries

**Files:**

- Modify: `packages/web/src/components/console/NotificationCenter.tsx`
- Create: `packages/web/src/components/console/NotificationCenter.test.tsx`
- Modify: `packages/web/src/components/console/Shell.tsx`
- Modify: `packages/web/src/components/console/views/SessionsView.tsx`
- Modify: `packages/web/src/components/console/views/UsageView.tsx`
- Delete: `packages/web/src/components/console/SessionAccessNotice.tsx`
- Delete: `packages/web/src/components/console/SessionAccessNotice.test.tsx`

- [ ] **Step 1: Write failing presentation tests**

Assert the rail variant uses `railiconbtn` without card background/border, the mobile variant uses `mappbtn`, both variants expose the same unread count in their accessible label, resolved rows hide actions, and live panel/toast actions are anchors with correct target/rel behavior.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @agentconnect.md/web test -- src/components/console/NotificationCenter.test.tsx`

Expected: FAIL against the current generic `iconbtn` implementation.

- [ ] **Step 3: Implement trigger variants and action UI**

Replace placement-only configuration with an explicit `variant: 'rail' | 'mobile'`, retaining placement as an internal mapping. Mark actions read; toast actions also dismiss their toast. Stop action clicks from bubbling to the row. Show `Resolved` and suppress actions when `resolvedAt` exists. Remove the forbidden local `duration-200 ease-out` motion utilities from toasts.

- [ ] **Step 4: Remove page banners**

Delete both `SessionAccessNotice` call sites/imports and delete the obsolete component/test. Do not alter other contextual notices.

Run `rg -n "SessionAccessNotice" packages/web/src/components/console/views/SessionsView.tsx packages/web/src/components/console/views/UsageView.tsx` and expect no matches (exit 1).

- [ ] **Step 5: Run focused tests, lint, and typecheck**

Run:

```bash
pnpm --filter @agentconnect.md/web test -- src/components/console/NotificationCenter.test.tsx src/lib/session-access-notifications.test.ts src/lib/notifications.test.tsx src/lib/session-access-notifier.test.tsx src/lib/daemon-notifications.test.tsx
pnpm exec eslint packages/web/src/components/console/NotificationCenter.tsx packages/web/src/components/console/Shell.tsx packages/web/src/components/console/views/SessionsView.tsx packages/web/src/components/console/views/UsageView.tsx packages/web/src/lib/notifications.tsx packages/web/src/lib/session-access-notifications.ts packages/web/src/lib/session-access-notifier.ts packages/web/src/lib/use-session-list.ts packages/web/src/lib/data-context.tsx
pnpm --filter @agentconnect.md/web typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src
git commit -m "fix(web): consolidate session access notifications"
```

### Task 5: Full verification

**Files:**

- Verify all changed files and the approved design contract.

- [ ] **Step 1: Run the full web test suite**

Run: `pnpm --filter @agentconnect.md/web test`

Expected: PASS with zero failures.

- [ ] **Step 2: Run web typecheck and repository lint on changed files**

Run:

```bash
pnpm --filter @agentconnect.md/web typecheck
pnpm exec eslint <all changed TypeScript/TSX files>
git diff --check main...HEAD
```

Expected: all commands exit 0.

- [ ] **Step 3: Inspect the final diff and visual states**

Check light/dark desktop rail expanded/collapsed and mobile app bar; open the panel with active, read, resolved, internal-action, and external-action entries.

- [ ] **Step 4: Commit any verification-only corrections**

Use a scoped commit message and repeat affected verification commands before reporting completion.
