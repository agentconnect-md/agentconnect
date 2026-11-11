// Keeps agent bots in step with their rows (teams-integration.md §8.6.5): a removed row takes its bot with it, a renamed agent renames its bot, and what no row names is deleted.

import { MSTEAMS_PLATFORM } from '@agentconnect.md/protocol'
import type { HttpDeps } from '../../http/deps.js'
import type { BotRecord } from '../../persistence/ports.js'
import {
  msTeamsAgentBotKey,
  msTeamsAgentBotKeyOfResource,
  msTeamsPrincipalAbsent,
  type MsTeamsAgentBotClient
} from './agent-bots.js'
import { msTeamsAgentBotOf, type MsTeamsAgentBots } from './deployment-app.js'

/** The row's record of the name its bot was last given. */
export const MSTEAMS_AGENT_BOT_NAME_KEY = 'agentBotName'
/** How often names are compared; the comparison reads only the database. */
export const MSTEAMS_KEEPER_INTERVAL_MS = 60_000
/** Every this many passes the registrations and identities are listed; an orphan is deleted on the second pass that sees it. */
export const MSTEAMS_KEEPER_SWEEP_EVERY = 60
const REQUEST_LIMIT = 1000

type Client = Pick<
  MsTeamsAgentBotClient,
  'rename' | 'deleteRegistration' | 'deleteIdentity' | 'listRegistrations' | 'listIdentities'
>

export interface MsTeamsAgentBotKeeperDeps {
  http: Pick<HttpDeps, 'repos' | 'clock'>
  client: Client
  agentBots: Pick<MsTeamsAgentBots, 'blueprintId'>
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void }
}

export class MsTeamsAgentBotKeeper {
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false
  private passes = 0
  // What the last sweep found unnamed; a connect in flight has its row by the next one.
  private suspects = new Set<string>()
  // Rows whose rename Microsoft refused, left alone until the next sweep.
  private readonly refused = new Set<string>()

  constructor(private readonly deps: MsTeamsAgentBotKeeperDeps) {}

  // The key of a row this deployment's blueprint made; undefined for any other row.
  private keyOf(bot: Pick<BotRecord, 'platformConfig'>): string | undefined {
    const entry = msTeamsAgentBotOf(bot)
    if (!entry || entry.blueprintId !== this.deps.agentBots.blueprintId) return undefined
    return msTeamsAgentBotKeyOfResource(entry.resourceName)
  }

  private async rows(): Promise<BotRecord[]> {
    return (await this.deps.http.repos.bot.listForPlatform(MSTEAMS_PLATFORM)).filter((bot) => !!this.keyOf(bot))
  }

  /** A deleted row's bot: its registration and its identity go, which needs no administrator of the tenant. */
  async remove(bot: BotRecord): Promise<void> {
    const key = this.keyOf(bot)
    if (key) await this.removeBot(key, bot.externalTenantId, bot.externalAppId)
  }

  // The identity goes first: the registration is what still points at it, so it stays until the identity is gone and a failed attempt is found again.
  private async removeBot(key: string, tenantId: string | null, identity: string | null): Promise<void> {
    if (tenantId && identity) {
      try {
        await this.deps.client.deleteIdentity(tenantId, identity)
      } catch (err) {
        // Only a tenant with no principal left has nothing to delete; any other refusal keeps the registration, so the next sweep tries again.
        if (!msTeamsPrincipalAbsent(err)) throw err
      }
    }
    await this.deps.client.deleteRegistration(key)
  }

  /** Gives each bot its agent's current name, where the row does not record that name yet. */
  async syncNames(): Promise<void> {
    for (const bot of await this.rows()) {
      const agentId = bot.agentIds[0]
      const key = this.keyOf(bot)
      if (!agentId || !key || !bot.externalAppId || !bot.externalTenantId || this.refused.has(bot.id)) continue
      const agent = await this.deps.http.repos.agent.get(bot.orgId, agentId)
      const name = agent ? (agent.displayName ?? agent.name) : undefined
      if (!name || bot.platformConfig?.[MSTEAMS_AGENT_BOT_NAME_KEY] === name) continue
      try {
        await this.deps.client.rename({
          key,
          tenantId: bot.externalTenantId,
          identity: bot.externalAppId,
          displayName: name
        })
        await this.deps.http.repos.bot.mergeBotIdentity(bot.orgId, bot.id, () => ({
          platformConfig: { [MSTEAMS_AGENT_BOT_NAME_KEY]: name }
        }))
      } catch (err) {
        this.refused.add(bot.id)
        this.deps.log.warn({ err, botId: bot.id }, 'msteams: agent bot not renamed')
      }
    }
  }

  /** Deletes the registrations and identities that neither a row nor a waiting request names, once two sweeps in a row found them so. */
  async sweep(): Promise<void> {
    this.refused.clear()
    const named = new Set<string>()
    const tenants = new Set<string>()
    for (const bot of await this.rows()) {
      named.add(this.keyOf(bot)!)
      if (bot.externalTenantId) tenants.add(bot.externalTenantId)
    }
    const requests = this.deps.http.repos.msTeamsAgentBotRequest
    const soon = new Date(this.deps.http.clock.now() + 1)
    for (const open of await requests.openedBefore(soon, REQUEST_LIMIT)) {
      const request = await requests.get(open.orgId, open.id)
      if (!request) continue
      named.add(msTeamsAgentBotKey(request.agentId, request.tenantId))
      tenants.add(request.tenantId)
    }
    const found = new Map<string, () => Promise<void>>()
    for (const registration of await this.deps.client.listRegistrations()) {
      if (named.has(registration.key)) continue
      // A tenant with no row left is reached only through the registration that still points into it.
      found.set(`registration ${registration.key}`, () =>
        this.removeBot(registration.key, registration.tenantId, registration.identity)
      )
    }
    for (const tenantId of tenants) {
      try {
        for (const { identity, key } of await this.deps.client.listIdentities(tenantId)) {
          // An identity without this module's tag is not this module's to delete.
          if (key && !named.has(key))
            found.set(`identity ${tenantId} ${identity}`, () => this.deps.client.deleteIdentity(tenantId, identity))
        }
      } catch (err) {
        this.deps.log.warn({ err, tenantId }, 'msteams: agent identities not listed')
      }
    }
    const suspects = new Set<string>()
    for (const [what, remove] of found) {
      if (!this.suspects.has(what)) {
        suspects.add(what)
        continue
      }
      try {
        await remove()
        this.deps.log.info({ what }, 'msteams: orphaned agent bot resource deleted')
      } catch (err) {
        suspects.add(what)
        this.deps.log.warn({ err, what }, 'msteams: orphaned agent bot resource not deleted')
      }
    }
    this.suspects = suspects
  }

  /** One pass: names every time, the orphan sweep every {@link MSTEAMS_KEEPER_SWEEP_EVERY} passes. */
  async tick(): Promise<void> {
    this.passes += 1
    if (this.passes % MSTEAMS_KEEPER_SWEEP_EVERY === 0) await this.sweep()
    await this.syncNames()
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      if (this.running) return
      this.running = true
      void this.tick()
        .catch((err: unknown) => this.deps.log.warn({ err }, 'msteams: agent bot upkeep pass failed'))
        .finally(() => {
          this.running = false
        })
    }, MSTEAMS_KEEPER_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}
