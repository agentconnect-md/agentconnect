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
 * The rewrite and the broadcast are two steps, and only the first is durable, so the second is
 * retried from remembered state rather than re-derived: after a failed `resync` the row is already
 * correct, and the drift comparison alone would skip the bot forever while its relays kept
 * verifying with the old key. See {@link LinearCredentialReconciler.pendingResync}.
 *
 * It re-stamps only rows that are unambiguously the current app's live installs. Two lifecycle
 * edges are skipped, both because a re-stamp there would assert something this loop cannot know:
 * a bot carrying a PREVIOUS client id (a different app's install, whose grant and token row belong
 * to that app), and a REVOKED bot (whose un-revoke is the reconnect flow's alone). Each needs an
 * operator reconnect, which re-proves the grant; a rotation is not evidence of one.
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
  /**
   * Bots whose credential this loop rewrote but whose relays have not been told. The write and the
   * broadcast are two steps, and the drift comparison cannot recover a failed second one: it reads
   * the row this loop already fixed and would skip the bot forever while connected relays kept
   * verifying with the old key. So the retry is remembered here instead of re-derived.
   *
   * Only a THROWN `resync` leaves a mark. One that returns having broadcast nothing — no relay is
   * connected — is not a debt: the register replay fans every assignment out as each relay connects.
   *
   * Process-local on purpose, and for the same reason: a CP restart replays every assignment to each
   * relay as it registers, which is that same convergence by a different route. Persisting this
   * would add a table to re-implement a guarantee the register path already gives.
   */
  private readonly pendingResync = new Set<BotId>()

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
    let awaitingReconnect = 0
    const seen = new Set<BotId>()
    for (const bot of await this.deps.bots.listForPlatform('linear')) {
      seen.add(bot.id)
      try {
        // A row whose durable app half is not the CURRENT client id is a PREVIOUS deployment app's
        // install — the setup card permits changing the client id (§7.1). Its workspace authorized
        // that app and its `linear_token` row is keyed by it, so stamping today's secrets on would
        // fuse two identities into one row that neither app can serve. Only an operator reconnect
        // re-proves the grant. A NULL app half fails the same way, and should: an unattributed row
        // is not evidence that it is ours.
        if (bot.externalAppId !== app.clientId) {
          awaitingReconnect += 1
          this.pendingResync.delete(bot.id)
          continue
        }
        // `install` advances the generation through `bumpCredential`, which CLEARS `revokedAt`, and
        // the seam offers no no-unrevoke variant — so re-stamping here would let a secret rotation
        // silently resurrect a workspace that revoked or uninstalled the app. Un-revoking belongs
        // exclusively to the reconnect flow, which re-proves the grant first (§7.4).
        //
        // Dropping any pending retry with it: once a row leaves this loop's standing, publishing it
        // is the revoke and reconnect paths' business, not a debt this loop still owes.
        if (bot.revokedAt) {
          this.pendingResync.delete(bot.id)
          continue
        }
        const secret = await this.deps.secrets.get(bot.orgId, bot.id)
        // Both slots carry deployment material (§7.2): `botToken` the client secret, CP-only;
        // `signingSecret` the webhook secret, the only half the relay ever sees. No row at all means
        // nothing to correct: a bot mid-connect is finished by the tail, not by this loop.
        const drifted =
          secret !== null && !(secret.botToken === app.clientSecret && secret.signingSecret === app.signingSecret)
        if (secret && drifted) {
          const credentialRevision = await this.deps.credentials.install(
            bot.orgId,
            bot.id,
            { ...secret, botToken: app.clientSecret, signingSecret: app.signingSecret },
            new Date(this.deps.clock.now())
          )
          // Marked BEFORE the broadcast is attempted, so a throwing resync leaves the debt behind
          // rather than the silence the drift check can no longer detect.
          this.pendingResync.add(bot.id)
          this.deps.log?.info(
            { botId: bot.id, credentialRevision },
            'linear-credential: re-stamped the deployment app credentials'
          )
        }
        // The one broadcast per bot per pass: a bot that both drifted and owed a retry publishes
        // once. Never before the durable write, which would ship a secret nothing stored.
        if (!this.pendingResync.has(bot.id)) continue
        await this.deps.resync(bot.id)
        this.pendingResync.delete(bot.id)
      } catch (err) {
        this.deps.log?.warn({ err, botId: bot.id }, 'linear-credential: re-stamp failed')
      }
    }
    // A bot deleted between passes owes nothing; its assignment died with it.
    for (const botId of this.pendingResync) if (!seen.has(botId)) this.pendingResync.delete(botId)
    // Once per pass, not per row: this is a standing operator condition, not an event.
    if (awaitingReconnect > 0) {
      this.deps.log?.info(
        { workspaces: awaitingReconnect },
        'linear-credential: workspaces installed under a previous app await reconnect'
      )
    }
  }
}
