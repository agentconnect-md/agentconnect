// Removes the deployment app's secret from its rows at boot (teams-integration.md §8.5), whatever the deployment's Teams settings are now.
import { MSTEAMS_PLATFORM } from '@agentconnect.md/protocol'
import type { Clock } from '../../domain/clock.js'
import type { BotId } from '../../domain/ids.js'
import type { BotCredentialWriter, BotRepo, BotSecretStore } from '../../persistence/ports.js'
import {
  MSTEAMS_DEPLOYMENT_OWNER,
  MSTEAMS_DEPLOYMENT_SECRET_MARKER,
  MSTEAMS_ROW_OWNER_KEY,
  isMsTeamsDeploymentRow,
  msTeamsDeploymentSecrets,
  type MsTeamsPlatformApp
} from './deployment-app.js'

export interface MsTeamsCredentialReconcilerDeps {
  bots: Pick<BotRepo, 'listForPlatform' | 'mergeBotIdentity'>
  secrets: Pick<BotSecretStore, 'get'>
  credentials: Pick<BotCredentialWriter, 'install'>
  /** Re-push the row's daemon spec and relay assignment (the orchestrator's `syncBot`). */
  resync(botId: BotId): Promise<void>
  /** The configured deployment app, which also names a row by its app ID; absent, rows are still found by what they store. */
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

  /** Mark every deployment app's row as such, replace any secret it still stores with the marker, then re-sync it; returns how many moved. */
  async run(): Promise<number> {
    let moved = 0
    try {
      for (const bot of await this.deps.bots.listForPlatform(MSTEAMS_PLATFORM)) {
        try {
          // Compared and never logged; the marker an earlier pass stored is ownership too, so every row's slot is read.
          const stored = await this.deps.secrets.get(bot.orgId, bot.id)
          const held = stored?.botToken === MSTEAMS_DEPLOYMENT_SECRET_MARKER
          if (!held && !isMsTeamsDeploymentRow(bot, this.deps.app)) continue
          const marked = bot.platformConfig?.[MSTEAMS_ROW_OWNER_KEY] === MSTEAMS_DEPLOYMENT_OWNER
          if (!marked)
            await this.deps.bots.mergeBotIdentity(bot.orgId, bot.id, () => ({
              platformConfig: { [MSTEAMS_ROW_OWNER_KEY]: MSTEAMS_DEPLOYMENT_OWNER }
            }))
          const stamped = !!stored && !held
          if (stamped)
            await this.deps.credentials.install(
              bot.orgId,
              bot.id,
              msTeamsDeploymentSecrets(),
              new Date(this.deps.clock.now())
            )
          if (!marked || stamped) {
            moved += 1
            await this.deps.resync(bot.id)
          }
        } catch (err) {
          this.deps.log?.error({ err, botId: bot.id }, 'msteams: removing the deployment secret from a row failed')
        }
      }
    } catch (err) {
      this.deps.log?.error({ err }, 'msteams: listing the deployment app rows failed')
    }
    if (moved > 0) this.deps.log?.info({ rows: moved }, 'msteams: removed the deployment secret from its rows')
    return moved
  }
}
