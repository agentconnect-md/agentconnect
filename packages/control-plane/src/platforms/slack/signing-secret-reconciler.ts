// Fans a rotated deployment Slack app signing secret out to every bot installed through that app.
import type { Clock, TimerHandle } from '../../domain/clock.js'
import type { BotId } from '../../domain/ids.js'
import type { SlackPlatformAppConfig } from '../../config/slack-platform.js'
import type { BotCredentialWriter, BotRecord, BotRepo, BotSecretStore } from '../../persistence/ports.js'

export interface SlackSigningSecretReconcilerLog {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export interface SlackSigningSecretReconcilerDeps {
  bots: Pick<BotRepo, 'listForPlatform'>
  secrets: Pick<BotSecretStore, 'get'>
  credentials: Pick<BotCredentialWriter, 'restampSigningSecret'>
  /** Re-broadcast `rc/bot-assign` for the bot whose row just moved (the orchestrator's `syncBot`). */
  resync(botId: BotId): Promise<void>
  /** The deployment app, read per tick; absent ⇒ the shared app is disabled and nothing is stamped. */
  readonly app?: SlackPlatformAppConfig
  clock: Clock
  intervalMs: number
  log?: SlackSigningSecretReconcilerLog
}

/** True for a live bot installed through the deployment app; a workspace's own app keeps its own secret. */
function installedThrough(app: SlackPlatformAppConfig, bot: BotRecord): boolean {
  return bot.revokedAt === null && (bot.slackAppId === app.appId || bot.externalAppId === app.appId)
}

/**
 * The relay verifies Slack signatures with the copy each install stamped into the bot's secret row,
 * never with the deployment config, so a rotated signing secret reaches no installed bot on its own.
 * This loop rewrites each stale copy and re-broadcasts the assignment; the pass `start()` runs is the
 * one that catches a rotation, because the secret only moves across a restart.
 */
export class SlackSigningSecretReconciler {
  private timer: TimerHandle | undefined
  private stopped = true
  private running = false
  // Bots rewritten but not yet re-broadcast: the drift check reads the fixed row and cannot recover a failed broadcast.
  private readonly pendingResync = new Set<BotId>()

  constructor(private readonly deps: SlackSigningSecretReconcilerDeps) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) {
      this.deps.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private arm(): void {
    if (this.stopped) return
    if (this.timer !== undefined) this.deps.clock.clearTimeout(this.timer)
    this.timer = this.deps.clock.setTimeout(() => void this.tick(), this.deps.intervalMs)
  }

  /** One best-effort pass. Idempotent: a row that already matches is left untouched. */
  async tick(): Promise<void> {
    if (this.running) return
    if (this.timer !== undefined) {
      this.deps.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
    this.running = true
    try {
      const app = this.deps.app
      if (app) await this.restamp(app)
    } catch (err) {
      this.deps.log?.error({ err }, 'slack-signing-secret: reconciliation failed')
    } finally {
      this.running = false
      this.arm()
    }
  }

  /** Per-bot so one unreadable row cannot strand the rest of the fleet. */
  private async restamp(app: SlackPlatformAppConfig): Promise<void> {
    const seen = new Set<BotId>()
    for (const bot of await this.deps.bots.listForPlatform('slack')) {
      seen.add(bot.id)
      try {
        // A revoked bot is skipped because `install` clears the revocation, which only a reinstall may do.
        if (!installedThrough(app, bot)) {
          this.pendingResync.delete(bot.id)
          continue
        }
        const secret = await this.deps.secrets.get(bot.orgId, bot.id)
        // A null slot is a socket-mode bot or one mid-install; neither holds a copy to correct.
        if (secret && secret.signingSecret !== null && secret.signingSecret !== app.signingSecret) {
          // Fenced on the listed revision and writing one column, so a concurrent reinstall or revoke is never overwritten.
          const credentialRevision = await this.deps.credentials.restampSigningSecret(
            bot.orgId,
            bot.id,
            app.signingSecret,
            new Date(this.deps.clock.now()),
            { revision: bot.credentialRevision }
          )
          // Null ⇒ the bot moved under this pass; the next pass reads it fresh.
          if (credentialRevision === null) continue
          // Marked before the broadcast, so a throwing resync leaves a debt the next pass repays.
          this.pendingResync.add(bot.id)
          this.deps.log?.info(
            { botId: bot.id, credentialRevision },
            'slack-signing-secret: re-stamped the deployment app signing secret'
          )
        }
        if (!this.pendingResync.has(bot.id)) continue
        await this.deps.resync(bot.id)
        this.pendingResync.delete(bot.id)
      } catch (err) {
        this.deps.log?.warn({ err, botId: bot.id }, 'slack-signing-secret: re-stamp failed')
      }
    }
    // A bot deleted between passes owes nothing; its assignment died with it.
    for (const botId of this.pendingResync) if (!seen.has(botId)) this.pendingResync.delete(botId)
  }
}
