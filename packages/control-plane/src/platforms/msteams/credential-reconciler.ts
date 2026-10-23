// Re-stamps a rotated deployment secret on the connected tenants' rows at boot (teams-integration.md §8.2); the secret moves only across a restart.
import { MSTEAMS_PLATFORM } from '@agentconnect.md/protocol'
import type { Clock } from '../../domain/clock.js'
import type { BotId } from '../../domain/ids.js'
import type { BotCredentialWriter, BotRepo, BotSecretStore } from '../../persistence/ports.js'
import { isMsTeamsCustomerRow, type MsTeamsPlatformApp } from './deployment-app.js'
import { msTeamsSecrets } from './provider.js'

export interface MsTeamsCredentialReconcilerDeps {
  bots: Pick<BotRepo, 'listForPlatform'>
  secrets: Pick<BotSecretStore, 'get'>
  credentials: Pick<BotCredentialWriter, 'install'>
  /** Re-push the row's daemon spec and relay assignment (the orchestrator's `syncBot`). */
  resync(botId: BotId): Promise<void>
  readonly app?: MsTeamsPlatformApp
  clock: Clock
  log?: { info(obj: unknown, msg?: string): void; error(obj: unknown, msg?: string): void }
}

export class MsTeamsCredentialReconciler {
  private started = false

  constructor(private readonly deps: MsTeamsCredentialReconcilerDeps) {}

  /** One pass on boot, the only time the configured secret can have changed. */
  start(): void {
    if (this.started) return
    this.started = true
    void this.run()
  }

  stop(): void {}

  /** Give every customer row whose stored secret differs the configured one, then re-sync it; returns how many moved. */
  async run(): Promise<number> {
    const app = this.deps.app
    if (!app) return 0
    const current = msTeamsSecrets(app.clientSecret)
    let restamped = 0
    try {
      for (const bot of await this.deps.bots.listForPlatform(MSTEAMS_PLATFORM)) {
        if (!isMsTeamsCustomerRow(bot, app)) continue
        try {
          // Compared and never logged; a row without a secret has nothing to correct.
          const stored = await this.deps.secrets.get(bot.orgId, bot.id)
          if (!stored || stored.botToken === current.botToken) continue
          await this.deps.credentials.install(bot.orgId, bot.id, current, new Date(this.deps.clock.now()))
          restamped += 1
          await this.deps.resync(bot.id)
        } catch (err) {
          this.deps.log?.error({ err, botId: bot.id }, 'msteams: re-stamping a customer row failed')
        }
      }
    } catch (err) {
      this.deps.log?.error({ err }, 'msteams: listing the customer rows failed')
    }
    if (restamped > 0) this.deps.log?.info({ rows: restamped }, 'msteams: re-stamped the deployment secret')
    return restamped
  }
}
