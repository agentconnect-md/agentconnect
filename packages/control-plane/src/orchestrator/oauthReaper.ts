// Deletes the embedded OAuth AS's dead rows (agent-assistant.md §7.4); same Clock-driven loop as CronRunReaper, armed only by startBackground().
import type { Clock, TimerHandle } from '../domain/clock.js'
import type { ApiKeyRepo, OAuthRepo } from '../persistence/ports.js'
import type { ReaperLog } from './cronRunReaper.js'

export const OAUTH_REAP_INTERVAL_MS = 10 * 60_000
// A row outlives its expiry, consumption or revocation by a week, so an audit entry's key id still resolves to its grant.
export const OAUTH_REAP_GRACE_MS = 7 * 86_400_000

export interface OAuthReaperConfig {
  intervalMs: number
  graceMs: number
}

export class OAuthReaper {
  private timer: TimerHandle | undefined
  private stopped = false

  constructor(
    private readonly oauth: Pick<OAuthRepo, 'reapExpired'>,
    private readonly apiKeys: Pick<ApiKeyRepo, 'reapOAuthAccessTokens'>,
    private readonly clock: Clock,
    private readonly cfg: OAuthReaperConfig,
    private readonly log?: ReaperLog
  ) {}

  start(): void {
    this.stopped = false
    this.arm()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private arm(): void {
    if (this.stopped) return
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = this.clock.setTimeout(() => void this.tick(), this.cfg.intervalMs)
  }

  // One sweep, then re-arm; a failed sweep is logged and retried on the next tick.
  async tick(): Promise<void> {
    this.timer = undefined
    try {
      const before = new Date(this.clock.now() - this.cfg.graceMs)
      const { codes, clients } = await this.oauth.reapExpired(before)
      const accessTokens = await this.apiKeys.reapOAuthAccessTokens(before)
      if (codes + clients + accessTokens > 0)
        this.log?.info(
          { codes, clients, accessTokens, before: before.toISOString() },
          'oauth-reaper: deleted dead OAuth rows'
        )
    } catch (err) {
      this.log?.error({ err }, 'oauth-reaper: sweep failed')
    } finally {
      this.arm()
    }
  }
}
