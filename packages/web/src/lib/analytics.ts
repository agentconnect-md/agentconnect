// PostHog product analytics for the console (opt-in, browser-side).
//
// This is the ONLY place the app collects analytics — the Control Plane no longer
// emits events. posthog-js autocaptures pageviews + clicks; the business events
// (agent_created, member_added, …) are captured explicitly at their call sites in
// lib/api.ts via `track()`, mirroring the events the CP used to send server-side.
//
// Config is read at RUNTIME from window.__AC_ENV (see lib/public-env), the same
// mechanism Logto/CP_URL use, so one prebuilt image works for any tenant. When
// POSTHOG_API_KEY is unset the SDK is never loaded and every call is a no-op.
//
// The SDK is imported LAZILY (dynamic import inside initAnalytics, after the
// browser + key guards) — a static top-level import would evaluate posthog-js's
// browser-dependent module code the moment anything imports this file (e.g.
// lib/auth or lib/api under SSR or Vitest), which crashes when there is no DOM.

// Type-only import — erased at compile time, so it does NOT load the SDK at runtime.
type PostHogClient = (typeof import('posthog-js'))['default']

let ph: PostHogClient | undefined
let starting = false
// The last identity action requested before the async SDK load finished (the
// auth gate runs on mount, racing initAnalytics). Replayed once the SDK is ready.
// A single slot with last-write-wins preserves ordering: an identify()→reset()
// during startup ends on 'reset' (so init's restored distinct id is cleared and
// a shared browser doesn't leak the prior user), and reset()→identify() ends on
// the new identify. Without this, a reset arriving mid-load would be dropped.
type PendingIdentity =
  { kind: 'identify'; distinctId: string; props?: { email?: string; name?: string } } | { kind: 'reset' }
let pending: PendingIdentity | null = null

/** Runtime config: window.__AC_ENV in the browser, NEXT_PUBLIC_* as a dev fallback. */
function readConfig(): { key?: string; host: string } {
  const src = typeof window === 'undefined' ? {} : (window.__AC_ENV ?? {})
  return {
    key: src.POSTHOG_API_KEY || process.env.NEXT_PUBLIC_POSTHOG_API_KEY,
    host: src.POSTHOG_HOST || process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com'
  }
}

/** Initialize posthog-js once, on the client, when a project key is configured. */
export async function initAnalytics(): Promise<void> {
  if (ph || starting || typeof window === 'undefined') return
  const { key, host } = readConfig()
  if (!key) return // opt-in: no key ⇒ SDK never loads, everything stays inert
  starting = true
  try {
    const { default: posthog } = await import('posthog-js')
    posthog.init(key, {
      api_host: host,
      // Next.js App Router navigates via the History API; 'history_change' captures
      // $pageview on the initial load AND on every client-side route change (plain
      // `true` under the legacy defaults only captures the first load).
      capture_pageview: 'history_change',
      capture_pageleave: true
    })
    ph = posthog
    // Replay the last identity action requested during the load (reset wins if it
    // was last — see `pending`). init() may have restored a persisted distinct id,
    // so a pending reset here is what clears it.
    if (pending?.kind === 'reset') posthog.reset()
    else if (pending?.kind === 'identify') posthog.identify(pending.distinctId, pending.props)
    pending = null
  } catch {
    // Analytics is optional: a chunk-load / init failure must not surface as an
    // unhandled rejection or wedge the subsystem. Clear `starting` so a later
    // initAnalytics() (e.g. a remount) can retry; `pending` is kept for it.
    starting = false
  }
}

/** Tie subsequent events to a signed-in user. Called on sign-in (lib/auth). */
export function identifyUser(distinctId: string, props?: { email?: string; name?: string }): void {
  if (ph) ph.identify(distinctId, props)
  // SDK still loading (or off) — remember it; initAnalytics replays it. When
  // analytics is off (no key) this is harmless: init returns before ph is set.
  else pending = { kind: 'identify', distinctId, props }
}

/** Drop the identified user on sign-out so the next session starts anonymous. */
export function resetAnalytics(): void {
  if (ph) ph.reset()
  // Loading: queue the reset so it isn't lost. It overrides any queued identify
  // and, once init() finishes, clears the distinct id init() may have restored.
  else pending = { kind: 'reset' }
}

/** Capture a business event. No-op until the SDK has loaded with a key. */
export function track(event: string, properties?: Record<string, unknown>): void {
  if (ph) ph.capture(event, properties)
}
