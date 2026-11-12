// A member's pending request for an agent's own Teams bot (teams-integration.md §8.6.6): watched until the tenant's administrator approves its package, then installed as that member.
import { randomUUID } from 'node:crypto'
import { MSTEAMS_PLATFORM } from '@agentconnect.md/protocol'
import type { HttpDeps } from '../../http/deps.js'
import { installNewBot } from '../../http/install-bot.js'
import type { OrgId } from '../../domain/ids.js'
import type { MsTeamsAgentBotRequestRecord, MsTeamsBindingMutations } from '../../persistence/ports.js'
import { BotExternalIdentityTaken } from '../../persistence/errors.js'
import { msTeamsRecoveryRows } from './recovery.js'
import {
  MsTeamsAgentBotClient,
  msTeamsAgentBotKey,
  msTeamsAgentBotResourceName,
  msTeamsPrincipalAbsent
} from './agent-bots.js'
import { MSTEAMS_RSC_PERMISSIONS } from './app-package.js'
import {
  MsTeamsConnectError,
  installMsTeamsAppForUserEventually,
  probeMsTeamsPackageForUser,
  readMsTeamsPackageState,
  redeemMsTeamsRefreshToken,
  withdrawMsTeamsSubmission
} from './connect.js'
import {
  MSTEAMS_DEPLOYMENT_OWNER,
  MSTEAMS_ROW_OWNER_KEY,
  msTeamsAgentBotEntries,
  msTeamsDeploymentSecrets,
  type MsTeamsAgentBots,
  type MsTeamsPlatformApp
} from './deployment-app.js'

/** A request the administrator never approved is cancelled after this long (§8.6.6). */
export const MSTEAMS_REQUEST_TTL_MS = 30 * 24 * 60 * 60_000
/** The wait before the first check, doubled after each one up to the cap: seconds at first, minutes later. */
export const MSTEAMS_REQUEST_FIRST_CHECK_MS = 15_000
export const MSTEAMS_REQUEST_MAX_CHECK_MS = 15 * 60_000
const CLAIM_MS = 2 * 60_000
const TICK_MS = 15_000
const BATCH = 20

/** The wait before check number `checks + 1`. */
export function msTeamsRequestBackoffMs(checks: number): number {
  return Math.min(MSTEAMS_REQUEST_MAX_CHECK_MS, MSTEAMS_REQUEST_FIRST_CHECK_MS * 2 ** Math.min(checks, 10))
}

/** What one check found: installed and gone, still waiting, stopped for a reason, or held by another check. */
export type MsTeamsRequestCheck =
  | { outcome: 'installed'; integrationId: string }
  | { outcome: 'pending' | 'needs_sign_in' | 'rejected' | 'busy' | 'gone' }

export interface MsTeamsAgentBotRequestsDeps {
  http: HttpDeps
  app: MsTeamsPlatformApp
  agentBots: MsTeamsAgentBots
  /** The per-tenant lock connects and recovery write the tenant's rows under. */
  bindingMutations: MsTeamsBindingMutations
  fetch?: typeof fetch
  /** The wait between tries while a new identity settles; tests pass one that does not sleep. */
  wait?: (ms: number) => Promise<void>
  /** The wait between tries of adding a just-approved app for its member; tests pass one that does not sleep. */
  personalInstallWait?: (ms: number) => Promise<void>
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void }
}

/** A check or another cancel holds the request; the caller tries again once it is done. */
export class MsTeamsRequestBusy extends Error {
  constructor() {
    super('The request is being checked.')
    this.name = 'MsTeamsRequestBusy'
  }
}

export class MsTeamsAgentBotRequests {
  private readonly fetchImpl: typeof fetch
  readonly client: MsTeamsAgentBotClient
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false

  constructor(private readonly deps: MsTeamsAgentBotRequestsDeps) {
    this.fetchImpl = deps.fetch ?? fetch
    this.client = new MsTeamsAgentBotClient({
      app: deps.app,
      agentBots: deps.agentBots,
      fetch: this.fetchImpl,
      ...(deps.wait ? { wait: deps.wait } : {})
    })
  }

  private get store() {
    return this.deps.http.repos.msTeamsAgentBotRequest
  }

  private now(): Date {
    return new Date(this.deps.http.clock.now())
  }

  /** Reads the package's state with the member's token and, once it is published, installs it into the chosen teams and writes the agent's row. */
  async check(orgId: OrgId, id: string): Promise<MsTeamsRequestCheck> {
    const claim = randomUUID()
    const now = this.now()
    if (!(await this.store.claim(orgId, id, claim, now, new Date(now.getTime() + CLAIM_MS)))) {
      return { outcome: (await this.store.get(orgId, id)) ? 'busy' : 'gone' }
    }
    const request = await this.store.get(orgId, id)
    if (!request) return { outcome: 'gone' }
    const later = () => new Date(this.now().getTime() + msTeamsRequestBackoffMs(request.checks))
    // A tenant another organization recovered ends this one's requests: nothing is installed, and the bot goes (§8.7).
    if (!(await this.owned(request))) {
      await this.removeBot(request).catch((err: unknown) =>
        this.deps.log.warn({ err, requestId: id }, 'msteams: bot of an ended request left for the reaper')
      )
      await this.store.delete(orgId, id)
      return { outcome: 'gone' }
    }
    if (!request.refreshToken) {
      await this.store.release(orgId, id, claim, { nextCheckAt: later(), status: 'needs_sign_in' })
      return { outcome: 'needs_sign_in' }
    }
    let tokens: { accessToken: string; refreshToken: string }
    try {
      tokens = await redeemMsTeamsRefreshToken(
        {
          clientId: this.deps.app.appId,
          clientSecret: this.deps.app.clientSecret,
          tenantId: request.tenantId,
          refreshToken: request.refreshToken
        },
        this.fetchImpl
      )
    } catch (err) {
      // Entra refusing the token is the member's to mend; anything else is tried again.
      const refused = err instanceof MsTeamsConnectError && err.code === 'MSTEAMS_CONNECT_DENIED'
      await this.store.release(orgId, id, claim, {
        nextCheckAt: later(),
        ...(refused ? { status: 'needs_sign_in' as const, reason: 'sign_in_expired', refreshToken: null } : {})
      })
      return { outcome: refused ? 'needs_sign_in' : 'pending' }
    }
    try {
      let state = await readMsTeamsPackageState(this.fetchImpl, tokens.accessToken, request.catalogAppId)
      // A member's token reads only their pending submission, so an approved package answers as a removed one does: adding it for the member tells them apart.
      if (state === 'gone') {
        const probe = await probeMsTeamsPackageForUser(this.fetchImpl, tokens.accessToken, {
          userId: request.sponsorId,
          catalogAppId: request.catalogAppId,
          permissions: MSTEAMS_RSC_PERMISSIONS
        })
        if (probe.result === 'added') {
          this.deps.log.info({ requestId: id }, 'msteams: package read as gone was added for its member')
          state = 'published'
        } else if (probe.result === 'unknown') {
          // What Microsoft answered is the only way to tell why an approved package is not finished.
          this.deps.log.warn({ requestId: id, detail: probe.detail }, 'msteams: approved package not yet addable')
          state = 'submitted'
        }
      } else if (state === 'submitted' && request.checks > 0) {
        this.deps.log.info({ requestId: id, checks: request.checks }, 'msteams: package still reads as submitted')
      }
      if (state === 'submitted') {
        await this.store.release(orgId, id, claim, { nextCheckAt: later(), refreshToken: tokens.refreshToken })
        return { outcome: 'pending' }
      }
      if (state !== 'published') {
        await this.store.release(orgId, id, claim, {
          nextCheckAt: later(),
          refreshToken: tokens.refreshToken,
          status: 'rejected',
          reason: state === 'gone' ? 'package_removed' : 'package_rejected'
        })
        return { outcome: 'rejected' }
      }
      const integrationId = await this.install(request, tokens.accessToken, claim)
      await this.store.delete(orgId, id)
      this.deps.log.info({ requestId: id, integrationId }, 'msteams: approved agent bot installed')
      return { outcome: 'installed', integrationId }
    } catch (err) {
      // Microsoft unreachable, or anything unexpected: the rotated token is kept and the check comes round again.
      this.deps.log.warn({ err, requestId: id }, 'msteams: agent bot request check failed')
      await this.store.release(orgId, id, claim, { nextCheckAt: later(), refreshToken: tokens.refreshToken })
      return { outcome: 'pending' }
    }
  }

  // Whether the request's organization still holds the tenant, with the app's row or an agent bot's.
  private async owned(request: MsTeamsAgentBotRequestRecord): Promise<boolean> {
    const rows = msTeamsRecoveryRows(
      await this.deps.http.repos.bot.listForPlatform(MSTEAMS_PLATFORM),
      this.deps.app.appId,
      request.tenantId
    )
    return rows.length > 0 && rows.every((row) => row.orgId === request.orgId)
  }

  // Adds the app for the member and writes the row; the agent joins a team when someone mentions it there (§8.6.5).
  private async install(request: MsTeamsAgentBotRequestRecord, accessToken: string, claim: string): Promise<string> {
    const { http } = this.deps
    const agent = await http.repos.agent.get(request.orgId, request.agentId)
    if (!agent) throw new Error('the request’s agent is gone')
    // The member gets the agent's app themselves too; Microsoft refuses a just-approved app for some minutes, so the tries go on after the row is written.
    const { log } = this.deps
    void installMsTeamsAppForUserEventually(
      this.fetchImpl,
      accessToken,
      { userId: request.sponsorId, catalogAppId: request.catalogAppId, permissions: MSTEAMS_RSC_PERMISSIONS },
      this.deps.personalInstallWait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()))
    )
      .then((detail) => {
        if (detail)
          log.warn({ requestId: request.id, detail }, 'msteams: agent bot not added for the member who asked for it')
      })
      .catch((err: unknown) =>
        log.warn({ requestId: request.id, err }, 'msteams: adding the agent bot for its member failed')
      )
    const key = msTeamsAgentBotKey(request.agentId, request.tenantId)
    try {
      const made = await this.deps.bindingMutations.runExclusive(request.tenantId, async () => {
        // The tenant may have changed hands while the teams were being installed into.
        if (!(await this.owned(request))) throw new Error('the tenant changed hands')
        // A claim that ran out may have passed to a cancel, which removes the bot: only the latest claim writes the row.
        if (!(await this.store.holds(request.orgId, request.id, claim)))
          throw new Error('the request passed to another')
        const installed = await installNewBot(http, this.deps.log as never, {
          bot: {
            externalAppId: request.identity,
            platformConfig: {
              tenantId: request.tenantId,
              tokenTenantId: request.tenantId,
              [MSTEAMS_ROW_OWNER_KEY]: MSTEAMS_DEPLOYMENT_OWNER,
              ...msTeamsAgentBotEntries({
                blueprintId: this.deps.agentBots.blueprintId,
                resourceName: msTeamsAgentBotResourceName(key)
              })
            }
          },
          secrets: msTeamsDeploymentSecrets(),
          externalIdentity: {
            externalAppId: request.identity,
            externalTenantId: request.tenantId,
            conflictMessage: 'This Teams bot is already connected.'
          },
          orgId: request.orgId,
          agent,
          platform: MSTEAMS_PLATFORM,
          name: request.botName,
          transport: 'http',
          prebuilt: true,
          createdByUserId: request.createdByUserId
        })
        // The request ends with the row's write, under the same lock a cancel removes the bot under.
        await this.store.delete(request.orgId, request.id)
        return installed
      })
      // The package the administrator approved is the one in the teams, so the row records it as current (§5.1).
      await http.repos.bot.mergeBotIdentity(request.orgId, made.bot.id, () => ({
        platformConfig: { appPackage: request.appPackage }
      }))
      return made.integration.id
    } catch (err) {
      // The row was written by an earlier check that could not delete the request afterwards.
      if (!(err instanceof BotExternalIdentityTaken)) throw err
      const held = await http.repos.bot.getByExternalIdentity(MSTEAMS_PLATFORM, request.identity, request.tenantId)
      const integrations = held && held.orgId === request.orgId ? await http.repos.integration.listForBot(held.id) : []
      const mine = integrations.find((integration) => integration.agentId === request.agentId)
      if (!mine) throw err
      return mine.id
    }
  }

  /** Withdraws the submission where the member's token still works, removes the bot, and forgets the request; throws when Microsoft could not be reached, so nothing is forgotten half-removed. */
  async cancel(orgId: OrgId, id: string): Promise<boolean> {
    // A cancel holds the claim a check holds, so neither acts on a request the other is finishing.
    const claim = randomUUID()
    const now = this.now()
    if (!(await this.store.claim(orgId, id, claim, now, new Date(now.getTime() + CLAIM_MS)))) {
      if (await this.store.get(orgId, id)) throw new MsTeamsRequestBusy()
      return false
    }
    const request = await this.store.get(orgId, id)
    if (!request) return false
    try {
      await this.withdraw(request)
      // The bot goes under the lock a check writes its row under, and only while this cancel's claim is the latest.
      return await this.deps.bindingMutations.runExclusive(request.tenantId, async () => {
        if (!(await this.store.holds(orgId, id, claim))) return false
        await this.removeBot(request)
        await this.store.delete(orgId, id)
        return true
      })
    } catch (err) {
      await this.store.release(orgId, id, claim, { nextCheckAt: request.nextCheckAt })
      throw err
    }
  }

  // Withdraws the submission where the stored token still works.
  private async withdraw(request: MsTeamsAgentBotRequestRecord): Promise<void> {
    if (request.refreshToken) {
      try {
        const tokens = await redeemMsTeamsRefreshToken(
          {
            clientId: this.deps.app.appId,
            clientSecret: this.deps.app.clientSecret,
            tenantId: request.tenantId,
            refreshToken: request.refreshToken
          },
          this.fetchImpl
        )
        await withdrawMsTeamsSubmission(this.fetchImpl, tokens.accessToken, request.catalogAppId)
      } catch (err) {
        // A token Entra refuses leaves the pending package for the administrator to turn down; the bot is removed all the same.
        if (!(err instanceof MsTeamsConnectError) || err.code === 'MSTEAMS_CONNECT_UNAVAILABLE') throw err
      }
    }
  }

  // The registration and the identity of a request that will not be installed.
  private async removeBot(request: MsTeamsAgentBotRequestRecord): Promise<void> {
    // The identity goes first: the registration still points at it, so the reaper finds what a failed attempt left.
    try {
      await this.client.deleteIdentity(request.tenantId, request.identity)
    } catch (err) {
      // Only a tenant with no principal left has nothing to delete; any other refusal is tried again.
      if (!msTeamsPrincipalAbsent(err)) throw err
    }
    await this.client.deleteRegistration(msTeamsAgentBotKey(request.agentId, request.tenantId))
  }

  /** One pass: every due request is checked, and every request older than the limit is cancelled. */
  async tick(): Promise<void> {
    const now = this.now()
    for (const due of await this.store.due(now, BATCH)) {
      await this.check(due.orgId, due.id).catch((err: unknown) =>
        this.deps.log.warn({ err, requestId: due.id }, 'msteams: agent bot request check threw')
      )
    }
    const expired = await this.store.openedBefore(new Date(now.getTime() - MSTEAMS_REQUEST_TTL_MS), BATCH)
    for (const old of expired) {
      await this.cancel(old.orgId, old.id).catch((err: unknown) =>
        this.deps.log.warn({ err, requestId: old.id }, 'msteams: expired agent bot request not removed')
      )
    }
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      if (this.running) return
      this.running = true
      void this.tick()
        .catch((err: unknown) => this.deps.log.warn({ err }, 'msteams: agent bot request pass failed'))
        .finally(() => (this.running = false))
    }, TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}
