// Removes the deployment app's secret from its rows at boot (teams-integration.md §8.5): the secret stays on the CP and relay, so a row holds only a marker.
import { MSTEAMS_PLATFORM } from '@agentconnect.md/protocol'
import type { Clock } from '../../domain/clock.js'
import type { BotId } from '../../domain/ids.js'
import type { BotCredentialWriter, BotRepo, BotSecretStore } from '../../persistence/ports.js'
import {
  MSTEAMS_DEPLOYMENT_SECRET_MARKER,
  msTeamsDeploymentSecrets,
  usesMsTeamsDeploymentApp,
  type MsTeamsPlatformApp
} from './deployment-app.js'

export interface MsTeamsCredentialReconcilerDeps {
  bots: Pick<BotRepo, 'listForPlatform'>
  secrets: Pick<BotSecretStore, 'get'>
  credentials: Pick<BotCredentialWriter, 'install'>
  /** Re-push the row's daemon spec and relay assignment (the orchestrator's `syncBot`). */
  resync(botId: BotId): Promise<void>
  readonly app?: Pick<MsTeamsPlatformApp, 'appId'>
  clock: Clock
  log?: { info(obj: unknown, msg?: string): void; error(obj: unknown, msg?: string): void }
}

export class MsTeamsCredentialReconciler {
  private started = false

  constructor(private readonly deps: MsTeamsCredentialReconcilerDeps) {}

  /** One pass on boot, the first time this build sees rows an older one stamped. */
  start(): void {
    if (this.started) return
    this.started = true
    void this.run()
  }

  stop(): void {}

  /** Replace any secret a deployment app's row still stores with the marker, then re-sync it; returns how many moved. */
  async run(): Promise<number> {
    const app = this.deps.app
    if (!app) return 0
    let purged = 0
    try {
      for (const bot of await this.deps.bots.listForPlatform(MSTEAMS_PLATFORM)) {
        if (!usesMsTeamsDeploymentApp(bot, app)) continue
        try {
          // Compared and never logged; a row without a secret row has nothing to remove.
          const stored = await this.deps.secrets.get(bot.orgId, bot.id)
          if (!stored || stored.botToken === MSTEAMS_DEPLOYMENT_SECRET_MARKER) continue
          await this.deps.credentials.install(
            bot.orgId,
            bot.id,
            msTeamsDeploymentSecrets(),
            new Date(this.deps.clock.now())
          )
          purged += 1
          await this.deps.resync(bot.id)
        } catch (err) {
          this.deps.log?.error({ err, botId: bot.id }, 'msteams: removing the deployment secret from a row failed')
        }
      }
    } catch (err) {
      this.deps.log?.error({ err }, 'msteams: listing the deployment app rows failed')
    }
    if (purged > 0) this.deps.log?.info({ rows: purged }, 'msteams: removed the deployment secret from its rows')
    return purged
  }
}
