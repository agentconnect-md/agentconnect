// One Azure DevOps token per connection (azure-devops-integration.md §3.4): refreshed before the last twenty minutes of its issued life, single-flight, purged by epoch.
import type { AzureDevOpsAccessToken } from './api.js'

/** A gitcred lease ends this long before the token inside it. */
export const LEASE_MARGIN_MS = 5 * 60_000
/** The daemon hands a cached grant out only while more than this remains (daemon `HANDOUT_MIN_MS`). */
const DAEMON_HANDOUT_FLOOR_MS = 10 * 60_000
const REFRESH_SLACK_MS = 5 * 60_000
/** Refresh once less than this remains, so every lease outlives the daemon's handout floor with slack: 5 + 10 + 5 minutes. */
export const REFRESH_MARGIN_MS = LEASE_MARGIN_MS + DAEMON_HANDOUT_FLOOR_MS + REFRESH_SLACK_MS

export interface CachedAzureDevOpsToken {
  token: string
  /** Wall-clock expiry the issuer's `expires_in` implies. */
  expiresAtMs: number
}

interface Entry extends CachedAzureDevOpsToken {
  epoch: bigint
  refreshAtMs: number
}

export class AzureDevOpsTokenCache {
  private readonly entries = new Map<string, Entry>()
  private readonly inflight = new Map<string, { epoch: bigint; promise: Promise<CachedAzureDevOpsToken> }>()
  /** Bumped by every purge, so a mint that started before one is returned once and never kept. */
  private readonly generations = new Map<string, number>()

  constructor(private readonly now: () => number) {}

  /** The cached token for this connection at this epoch, or one fresh mint shared by every concurrent caller. */
  async get(
    connectionId: string,
    epoch: bigint,
    mint: () => Promise<AzureDevOpsAccessToken>
  ): Promise<CachedAzureDevOpsToken> {
    const cached = this.entries.get(connectionId)
    if (cached && cached.epoch === epoch && this.now() < cached.refreshAtMs) {
      return { token: cached.token, expiresAtMs: cached.expiresAtMs }
    }
    if (cached && cached.epoch !== epoch) this.entries.delete(connectionId)
    const running = this.inflight.get(connectionId)
    if (running && running.epoch === epoch) return running.promise
    const promise = this.mint(connectionId, epoch, mint)
    this.inflight.set(connectionId, { epoch, promise })
    try {
      return await promise
    } finally {
      if (this.inflight.get(connectionId)?.promise === promise) this.inflight.delete(connectionId)
    }
  }

  private async mint(
    connectionId: string,
    epoch: bigint,
    mint: () => Promise<AzureDevOpsAccessToken>
  ): Promise<CachedAzureDevOpsToken> {
    const generation = this.generations.get(connectionId) ?? 0
    const issuedAtMs = this.now()
    const issued = await mint()
    const lifetimeMs = issued.expiresInSec * 1000
    const expiresAtMs = issuedAtMs + lifetimeMs
    // A lifetime shorter than twice the margin still caches for half of it, never not at all.
    const refreshAtMs = expiresAtMs - Math.min(REFRESH_MARGIN_MS, lifetimeMs / 2)
    // A purge or a newer epoch that landed meanwhile wins: this token is returned once and not kept.
    const current = this.entries.get(connectionId)
    if ((this.generations.get(connectionId) ?? 0) === generation && (!current || current.epoch <= epoch)) {
      this.entries.set(connectionId, { token: issued.accessToken, expiresAtMs, refreshAtMs, epoch })
    }
    return { token: issued.accessToken, expiresAtMs }
  }

  /** Forget the connection's token, as a rejected answer or a changed secret requires. */
  purge(connectionId: string): void {
    this.entries.delete(connectionId)
    this.inflight.delete(connectionId)
    this.generations.set(connectionId, (this.generations.get(connectionId) ?? 0) + 1)
  }
}
