/**
 * The relay's **platform registry** — the static plugin list (§8/§12) plus the
 * **per-platform ingest pools + demux index store** (stage S3)
 * — the S2 registry precedent (#526) applied to the relay: a platform states
 * how its bots are keyed and built ONCE (the plugin), and the shared lifecycle
 * only ever works pools and indexes it cannot parse.
 *
 * WHAT THIS ABSORBS. Today's manager holds two platform-named instance maps
 * (`ingests` / `feishuIngests`) and three platform-named identity maps
 * (`feishuBotByAppId`/`feishuAppIdByBot`, plus the Slack `demuxByApiApp` /
 * `demuxByAppTeam`/`appTeamKeyByBot` trio). The pool replaces the instance
 * maps; the {@link DemuxIndex} replaces the identity maps with ONE structure
 * whose per-assignment scope is derived from the ingress identity (§5, as
 * amended by #560): a tenant-scoped assignment enters ONLY the composite
 * index (assign-derived, never learned, eagerly cleaned), an app-only
 * assignment enters the app index — which may also be LEARNED from a verified
 * delivery (bounded, lazily evicted), because a legacy bot's CP row may not
 * carry the app id at all.
 */
import type { RelayBotIngress, RelayPlatformIngressPlugin } from './contract.js'
import { slackIngressPlugin } from './slack/ingress-plugin.js'
import { feishuIngressPlugin } from './feishu/ingress-plugin.js'
import { linearIngressPlugin } from './linear/ingress-plugin.js'

/**
 * **The one place a relay platform id is written down.** Adding a platform is
 * one entry here plus its `platforms/<id>/` module directory; every core path
 * — assign, inbound demux, teardown, shutdown, route mounting — iterates this
 * list and names no platform (§12: "a platform name is never core knowledge").
 *
 * Entries are erased to the contract's default bound. Core never reads a
 * `TIngest`'s internals (§8) — it starts it, stops it, and hands it back to
 * the plugin that built it, and each plugin's pool holds only ingests that
 * plugin built, so the erasure is the contract's own guarantee rather than a
 * cast around it.
 *
 * ORDER IS INSERTION ORDER and is observable in exactly one place: teardown
 * asks each pool in turn. That is the order the two hand-named pools were
 * asked in before the registry drove it (audit F2/F4), so nothing moved.
 */
export const relayIngressPlugins: readonly RelayPlatformIngressPlugin[] = [
  slackIngressPlugin,
  feishuIngressPlugin,
  linearIngressPlugin
]

/** One platform's pool of live per-bot ingests. Purely keyed by botId — the
 *  identity questions live in {@link DemuxIndex}, not here. */
export class IngressPool<TIngest extends RelayBotIngress> {
  private readonly live = new Map<string, TIngest>()

  /** @param name Diagnostic label ("slack", "feishu"). Never parsed. */
  constructor(readonly name: string) {}

  get(botId: string): TIngest | undefined {
    return this.live.get(botId)
  }

  set(botId: string, ingest: TIngest): void {
    this.live.set(botId, ingest)
  }

  delete(botId: string): void {
    this.live.delete(botId)
  }

  entries(): IterableIterator<[string, TIngest]> {
    return this.live.entries()
  }

  values(): IterableIterator<TIngest> {
    return this.live.values()
  }
}

const MAX_LEARNED_ENTRIES = 10_000

/**
 * The demux identity index for ONE platform's pool: `appId → botId` plus the
 * composite `(appId, tenantId) → botId`. Core owns the STORAGE and the
 * eviction rules; what goes where is decided by the assignment's own identity
 * shape, so no caller branches on platform:
 *
 *  - `indexAssign` with a tenantId ⇒ composite only. A same-app sibling
 *    install shares the signing secret, so an app-only entry would serve every
 *    sibling's events to this one bot.
 *  - `indexAssign` with only an appId ⇒ the app index (assign-derived).
 *  - `learn` ⇒ the app index, bounded — and REFUSED for any bot the composite
 *    index knows, preserving the tenant-scope invariant against a learning
 *    call site that did not re-check.
 */
export class DemuxIndex {
  private readonly byApp = new Map<string, string>()
  private readonly byAppTenant = new Map<string, string>()
  private readonly compositeKeyByBot = new Map<string, string>()

  private key(appId: string, tenantId: string): string {
    return `${appId}\0${tenantId}`
  }

  /** Index one assignment's declared identity (idempotent; call after
   *  {@link forget} on re-assign). */
  indexAssign(botId: string, identity: { appId?: string; tenantId?: string }): void {
    const { appId, tenantId } = identity
    if (appId && tenantId) {
      const key = this.key(appId, tenantId)
      this.byAppTenant.set(key, botId)
      this.compositeKeyByBot.set(botId, key)
      // A re-assign that GAINED a tenant id must also evict any stale app-only
      // entry still pointing at this bot, or the fast path would keep serving
      // cross-tenant.
      if (this.byApp.get(appId) === botId) this.byApp.delete(appId)
      return
    }
    if (appId) this.byApp.set(appId, botId)
  }

  /** Learn an app-only mapping from a verified delivery. Bounded; refused for
   *  tenant-scoped bots (see the class doc). */
  learn(appId: string, botId: string): void {
    if (this.compositeKeyByBot.has(botId)) return
    if (this.byApp.size >= MAX_LEARNED_ENTRIES) this.byApp.clear()
    this.byApp.set(appId, botId)
  }

  /** Resolve demux hints to a candidate botId: composite first (exact), then
   *  the app index. A hit is a CANDIDATE — the plugin's verify still decides. */
  resolve(hints: { appId?: string; tenantId?: string }): string | undefined {
    if (hints.appId && hints.tenantId) {
      const hit = this.byAppTenant.get(this.key(hints.appId, hints.tenantId))
      if (hit) return hit
    }
    return hints.appId ? this.byApp.get(hints.appId) : undefined
  }

  /** Drop everything indexed for `botId` (unassign/revoke/re-assign). The
   *  composite entry is assign-derived and eagerly cleaned; learned app-only
   *  entries for OTHER bots lazily miss, exactly as before. */
  forget(botId: string): void {
    const key = this.compositeKeyByBot.get(botId)
    if (key) {
      this.byAppTenant.delete(key)
      this.compositeKeyByBot.delete(botId)
    }
    for (const [appId, owner] of this.byApp) if (owner === botId) this.byApp.delete(appId)
  }

  /** Test/inspection view (no secret material). */
  get indexes(): { byApp: ReadonlyMap<string, string>; byAppTenant: ReadonlyMap<string, string> } {
    return { byApp: this.byApp, byAppTenant: this.byAppTenant }
  }
}
