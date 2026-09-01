/**
 * Fans a rotated deployment Linear app out to every workspace bot (linear-integration.md §10.6).
 *
 * The deployment owns ONE Linear OAuth app (§4.3), but the relay never reads that config: it
 * verifies `Linear-Signature` with the copy the connect tail stamped into each workspace bot's
 * `BotSecret` row and shipped in the `rc/bot-assign` secrets bag (§7.2, `linearBotAssignBags`).
 * Rotating the deployment credentials therefore moves the source of truth and leaves every stamped
 * row behind — every delivery would fail verification until each row is rewritten. This loop is
 * that rewrite: compare each row against the current app, and where they differ re-install the
 * credential and re-broadcast the assignment.
 *
 * Writes through {@link BotCredentialWriter.install}, the same seam the connect tail uses, never
 * `BotSecretStore.put` + `bumpCredential` in sequence: the pair is atomic and advances
 * `credentialRevision`, so anything that observed the previous secret is stale by construction.
 *
 * A background loop rather than a boot-only pass, following the Slack bot-identity reconciler: the
 * credentials arrive through the environment and so can only move across a restart, which makes the
 * pass `start()` runs immediately the load-bearing one, while the interval is a cheap self-heal for
 * a bot whose re-stamp lost its transaction or whose relay was down when it landed.
 */
import type { Clock, TimerHandle } from '../../domain/clock.js'
import type { BotId } from '../../domain/ids.js'
import type { LinearPlatformAppConfig } from '../../config/linear-platform.js'
import type { BotCredentialWriter, BotRepo, BotSecretStore } from '../../persistence/ports.js'

export interface LinearCredentialReconcilerLog {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export interface LinearCredentialReconcilerDeps {
  bots: Pick<BotRepo, 'listForPlatform'>
  secrets: Pick<BotSecretStore, 'get'>
  credentials: Pick<BotCredentialWriter, 'install'>
  /** Re-broadcast `rc/bot-assign` for the bot whose row just moved (the orchestrator's `syncBot`). */
  resync(botId: BotId): Promise<void>
  /** The deployment app, read PER TICK and never captured — absent ⇒ the platform is disabled and
   *  there is nothing to stamp, so a pass finds no target rather than clearing live rows. */
  readonly app?: LinearPlatformAppConfig
  clock: Clock
  intervalMs: number
  log?: LinearCredentialReconcilerLog
}

export class LinearCredentialReconciler {
  private timer: TimerHandle | undefined
  private stopped = true
  private running = false

  constructor(private readonly deps: LinearCredentialReconcilerDeps) {}

  /** Run immediately on boot — the pass that catches a rotation — then re-arm. */
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
      this.deps.log?.error({ err }, 'linear-credential: reconciliation failed')
    } finally {
      this.running = false
      this.arm()
    }
  }

  /** Per-bot so one unreachable row cannot strand the rest of the fleet. */
  private async restamp(app: LinearPlatformAppConfig): Promise<void> {
    for (const bot of await this.deps.bots.listForPlatform('linear')) {
      try {
        const secret = await this.deps.secrets.get(bot.orgId, bot.id)
        // No row to correct: a bot mid-connect is finished by the tail, not by this loop.
        if (!secret) continue
        // Both slots carry deployment material (§7.2): `botToken` the client secret, CP-only;
        // `signingSecret` the webhook secret, the only half the relay ever sees.
        if (secret.botToken === app.clientSecret && secret.signingSecret === app.signingSecret) continue
        const credentialRevision = await this.deps.credentials.install(
          bot.orgId,
          bot.id,
          { ...secret, botToken: app.clientSecret, signingSecret: app.signingSecret },
          new Date(this.deps.clock.now())
        )
        // After the durable write, so a failed broadcast is retried by the next pass against a row
        // that is already correct — never the reverse, which would ship a secret nothing stored.
        await this.deps.resync(bot.id)
        this.deps.log?.info(
          { botId: bot.id, credentialRevision },
          'linear-credential: re-stamped the deployment app credentials'
        )
      } catch (err) {
        this.deps.log?.warn({ err, botId: bot.id }, 'linear-credential: re-stamp failed')
      }
    }
  }
}
