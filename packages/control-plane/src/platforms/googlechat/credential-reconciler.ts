// Removes the deployment app's key from its rows at boot (google-chat-integration.md §10.10), whatever the deployment's Google Chat settings are now.
import { GOOGLE_CHAT_PLATFORM } from '@agentconnect.md/protocol'
import type { Clock } from '../../domain/clock.js'
import type { BotId } from '../../domain/ids.js'
import type { GoogleChatPlatformAppConfig } from '../../config/google-chat-platform.js'
import type { BotCredentialWriter, BotRepo, BotSecretStore } from '../../persistence/ports.js'
import {
  GOOGLE_CHAT_DEPLOYMENT_KEY_MARKER,
  GOOGLE_CHAT_DEPLOYMENT_OWNER,
  GOOGLE_CHAT_ROW_OWNER_KEY,
  googleChatDeploymentSecrets,
  isGoogleChatDeploymentRow
} from './deployment-app.js'

export interface GoogleChatCredentialReconcilerDeps {
  bots: Pick<BotRepo, 'listForPlatform' | 'mergeBotIdentity'>
  secrets: Pick<BotSecretStore, 'get'>
  credentials: Pick<BotCredentialWriter, 'install'>
  /** Re-push the row's daemon spec and relay assignment (the orchestrator's `syncBot`). */
  resync(botId: BotId): Promise<void>
  /** The configured deployment app, which also names a row by its project; absent, rows are still found by what they store. */
  readonly app?: Pick<GoogleChatPlatformAppConfig, 'projectNumber'>
  clock: Clock
  log?: { info(obj: unknown, msg?: string): void; error(obj: unknown, msg?: string): void }
}

export class GoogleChatCredentialReconciler {
  private started = false

  constructor(private readonly deps: GoogleChatCredentialReconcilerDeps) {}

  /** One pass on boot, the first time this build sees rows an older one stamped. */
  start(): void {
    if (this.started) return
    this.started = true
    void this.run()
  }

  stop(): void {}

  /** Mark every deployment app's row as such, replace any key it still stores with the marker, then re-sync it; returns how many moved. */
  async run(): Promise<number> {
    let moved = 0
    try {
      for (const bot of await this.deps.bots.listForPlatform(GOOGLE_CHAT_PLATFORM)) {
        try {
          // Compared and never logged; the marker an earlier pass stored is ownership too, so every row's slot is read.
          const stored = await this.deps.secrets.get(bot.orgId, bot.id)
          const held = stored?.botToken === GOOGLE_CHAT_DEPLOYMENT_KEY_MARKER
          if (!held && !isGoogleChatDeploymentRow(bot, this.deps.app)) continue
          const marked = bot.platformConfig?.[GOOGLE_CHAT_ROW_OWNER_KEY] === GOOGLE_CHAT_DEPLOYMENT_OWNER
          if (!marked)
            await this.deps.bots.mergeBotIdentity(bot.orgId, bot.id, () => ({
              platformConfig: { [GOOGLE_CHAT_ROW_OWNER_KEY]: GOOGLE_CHAT_DEPLOYMENT_OWNER }
            }))
          const stamped = !!stored && !held
          if (stamped)
            await this.deps.credentials.install(
              bot.orgId,
              bot.id,
              googleChatDeploymentSecrets(),
              new Date(this.deps.clock.now())
            )
          if (!marked || stamped) {
            moved += 1
            await this.deps.resync(bot.id)
          }
        } catch (err) {
          this.deps.log?.error({ err, botId: bot.id }, 'google chat: removing the deployment key from a row failed')
        }
      }
    } catch (err) {
      this.deps.log?.error({ err }, 'google chat: listing the deployment app rows failed')
    }
    if (moved > 0) this.deps.log?.info({ rows: moved }, 'google chat: removed the deployment key from its rows')
    return moved
  }
}
