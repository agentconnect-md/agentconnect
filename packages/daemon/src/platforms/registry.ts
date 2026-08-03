/**
 * The daemon's **connection registry** (integration-plugin-architecture.md §7.5,
 * stage S2).
 *
 * What it absorbs: five connection pools, the in-flight-connect guards, and — the
 * part that actually removes branching — the per-platform IDENTITY COMPARISON. Before this, every reconcile and every prune
 * pass compared credentials field by field, differently per platform:
 * `c.appToken === g.appToken && c.botToken === g.botToken` for a Slack socket,
 * `c.botToken === g.botToken` for Telegram/Discord, `c.appId === g.appId &&
 * c.region === g.region && c.mode === g.mode` for Feishu. Here a platform states
 * its identity ONCE as an opaque key, and the shared lifecycle only ever compares
 * keys — it cannot know, and never asks, what a key is made of.
 *
 * TWO MODES PER PLATFORM is first-class (§7.5): Slack runs a socket pool keyed by
 * app token beside a send-only pool keyed by bot token, because a shared bot has
 * no app token to key on. A pool is therefore per (platform, mode), and both of
 * Slack's feed the one binding map its integrations resolve through.
 *
 * TYPES ARE PRESERVED at read sites. A pool is generic in its connection type, so
 * callers still hold concrete connections (`SlackConnection.postBlocks`,
 * `FeishuConnection.startStreamingCard`, …). That is deliberate sequencing: only
 * the LIFECYCLE (open / find / prune / close) is generic today, which is what
 * §7.5 asks for. The per-integration BINDING maps stay typed per platform for the
 * same reason — they generalize once Layer 2 (the renderer seam) replaces the
 * direct method calls at the read sites, not before.
 *
 * EVAL IMMUNITY stays in the registry (§7.5): credential-less virtual connections
 * are injected by the Arena, take part in no consolidation, and must survive every
 * prune — so pruning takes an explicit immunity predicate rather than inferring it.
 */
import type { PlatformConnection } from './contract.js'

/** A connection's identity, opaque by construction: the registry compares these
 *  for equality and never parses them. Minted by the platform's own key function
 *  from whatever credentials actually identify one connection. */
export type ConnectionKey = string

/** One connection's worth of consolidated integrations — the platform-agnostic
 *  half of every `consolidate*()` result. */
export interface RegistryGroup {
  key: ConnectionKey
  integrations: { agentId: string; integrationId: string }[]
}

/** A per-(platform, mode) pool of live connections plus its in-flight guard. */
export class ConnectionPool<C extends PlatformConnection> {
  private readonly live = new Map<ConnectionKey, C>()
  private readonly connecting = new Set<ConnectionKey>()

  /**
   * @param name  Diagnostic label ("slack", "slack/shared", …). Never parsed.
   * @param identity The platform's own key function. It must agree with the key
   *   its `consolidate*()` emits: the whole point is that a live connection and
   *   the group that wants it hash to the same string.
   */
  constructor(
    readonly name: string,
    private readonly identity: (conn: C) => ConnectionKey
  ) {}

  /** The live connection for `key`, or undefined. Replaces the four bespoke
   *  `pool.find(c => <credential comparison>)` predicates. */
  find(key: ConnectionKey): C | undefined {
    return this.live.get(key)
  }

  keyOf(conn: C): ConnectionKey {
    return this.identity(conn)
  }

  add(conn: C): void {
    this.live.set(this.identity(conn), conn)
  }

  remove(conn: C): void {
    this.live.delete(this.identity(conn))
  }

  all(): C[] {
    return [...this.live.values()]
  }

  /** Claim the in-flight slot for `key`; false when a connect is already running
   *  for it (the caller skips, and the running connect binds the group when it
   *  resolves). Slack's socket pool historically had no such guard — it used a
   *  retry timer instead — so claiming is opt-in per call site, not implicit. */
  beginConnect(key: ConnectionKey): boolean {
    if (this.connecting.has(key)) return false
    this.connecting.add(key)
    return true
  }

  endConnect(key: ConnectionKey): void {
    this.connecting.delete(key)
  }

  isConnecting(key: ConnectionKey): boolean {
    return this.connecting.has(key)
  }
}
