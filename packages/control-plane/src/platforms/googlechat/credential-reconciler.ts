// Re-stamps a rotated deployment key on the claimed customer rows at boot (google-chat-integration.md §10.3); the key moves only across a restart.
import { GOOGLE_CHAT_PLATFORM } from '@agentconnect.md/protocol'
import type { Clock } from '../../domain/clock.js'
import type { BotId } from '../../domain/ids.js'
import type { GoogleChatPlatformAppConfig } from '../../config/google-chat-platform.js'
import type { BotCredentialWriter, BotRepo, BotSecretMaterial, BotSecretStore } from '../../persistence/ports.js'
import { buildGoogleChatInstall, googleChatRowKind } from './provider.js'

export interface GoogleChatCredentialReconcilerDeps {
  bots: Pick<BotRepo, 'listForPlatform'>
  secrets: Pick<BotSecretStore, 'get'>
  credentials: Pick<BotCredentialWriter, 'install'>
  /** Re-push the row's daemon spec and relay assignment (the orchestrator's `syncBot`). */
  resync(botId: BotId): Promise<void>
  /** The deployment app, read per pass; absent ⇒ nothing to stamp. */
  readonly app?: GoogleChatPlatformAppConfig
  clock: Clock
  log?: { info(obj: unknown, msg?: string): void; error(obj: unknown, msg?: string): void }
}

export class GoogleChatCredentialReconciler {
  private started = false

  constructor(private readonly deps: GoogleChatCredentialReconcilerDeps) {}

  /** One pass on boot, the only time the configured key can have changed. */
  start(): void {
    if (this.started) return
    this.started = true
    void this.run()
  }

  stop(): void {}

  /** Give every customer row of the deployment app whose stored key differs the configured one, then re-sync it; returns how many moved. */
  async run(): Promise<number> {
    const app = this.deps.app
    if (!app) return 0
    let current: BotSecretMaterial
    try {
      current = buildGoogleChatInstall(app).secrets
    } catch {
      this.deps.log?.error({}, 'google chat: the deployment key does not parse; no customer row was re-stamped')
      return 0
    }
    let restamped = 0
    try {
      for (const bot of await this.deps.bots.listForPlatform(GOOGLE_CHAT_PLATFORM)) {
        if (bot.externalAppId !== app.projectNumber || googleChatRowKind(bot) !== 'customer') continue
        try {
          // Both sides are canonical JSON, compared and never logged; a row without a secret has nothing to correct.
          const stored = await this.deps.secrets.get(bot.orgId, bot.id)
          if (!stored || stored.botToken === current.botToken) continue
          await this.deps.credentials.install(bot.orgId, bot.id, current, new Date(this.deps.clock.now()))
          restamped += 1
          await this.deps.resync(bot.id)
        } catch (err) {
          this.deps.log?.error({ err, botId: bot.id }, 'google chat: re-stamping a customer row failed')
        }
      }
    } catch (err) {
      this.deps.log?.error({ err }, 'google chat: listing the customer rows failed')
    }
    if (restamped > 0) this.deps.log?.info({ rows: restamped }, 'google chat: re-stamped the deployment key')
    return restamped
  }
}
