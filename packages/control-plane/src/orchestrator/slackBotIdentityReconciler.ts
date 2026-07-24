/**
 * Repairs HTTP Slack bot rows created before their public Slack app id was
 * persisted. The id is resolved from the already-stored bot token and written
 * only when the column is still null, so an established identity is never
 * replaced by a delayed or stale lookup.
 *
 * This is a background convergence loop, not part of GET /bots: opening the
 * Settings page must not fan out to Slack or turn a metadata read into a write.
 */
import type { Clock, TimerHandle } from '../domain/clock.js'
import type { BotRepo, BotSecretStore } from '../persistence/ports.js'

export interface SlackBotIdentityReconcilerConfig {
  intervalMs: number
}

export interface SlackBotIdentityReconcilerLog {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export type ResolveSlackAppId = (botToken: string) => Promise<string | null>

const SLACK_APP_ID = /^A[A-Z0-9]+$/

export class SlackBotIdentityReconciler {
  private timer: TimerHandle | undefined
  private stopped = true
  private running = false

  constructor(
    private readonly bots: BotRepo,
    private readonly secrets: BotSecretStore,
    private readonly resolveAppId: ResolveSlackAppId,
    private readonly clock: Clock,
    private readonly cfg: SlackBotIdentityReconcilerConfig,
    private readonly log?: SlackBotIdentityReconcilerLog
  ) {}

  /** Run immediately on boot, then retry unresolved rows periodically. */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.tick()
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

  /** One best-effort pass. Exposed for deterministic unit tests. */
  async tick(): Promise<void> {
    if (this.running) return
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
    this.running = true
    try {
      for (const bot of await this.bots.listHttpMissingSlackAppId()) {
        try {
          const secret = await this.secrets.get(bot.id)
          if (!secret) continue
          const appId = await this.resolveAppId(secret.botToken)
          if (!appId || !SLACK_APP_ID.test(appId)) continue
          if (await this.bots.setSlackAppIdIfMissing(bot.id, appId)) {
            this.log?.info({ botId: bot.id, slackAppId: appId }, 'slack-bot-identity: backfilled app id')
          }
        } catch (err) {
          this.log?.warn({ err, botId: bot.id }, 'slack-bot-identity: bot lookup failed')
        }
      }
    } catch (err) {
      this.log?.error({ err }, 'slack-bot-identity: reconciliation failed')
    } finally {
      this.running = false
      this.arm()
    }
  }
}
