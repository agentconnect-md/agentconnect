import type { MsTeamsBindingMutations, BotRecord, MsTeamsAgentBotRequestRecord } from '../../persistence/ports.js'
// A member's pending request for an agent's own Teams bot (teams-integration.md §8.6.6), against a scripted Microsoft and an in-memory store.
import { describe, expect, it, vi } from 'vitest'
import type { HttpDeps } from '../../http/deps.js'
import { AgentId, OrgId } from '../../domain/ids.js'
import { FakeClock } from '../../../test/fakes/fake-clock.js'
import { memoryMsTeamsAgentBotRequestStore } from '../../../test/fakes/msteams-agent-bot-request-store.js'
import {
  MSTEAMS_REQUEST_FIRST_CHECK_MS,
  MSTEAMS_REQUEST_MAX_CHECK_MS,
  MSTEAMS_REQUEST_TTL_MS,
  MsTeamsAgentBotRequests,
  MsTeamsRequestBusy,
  msTeamsRequestBackoffMs
} from './agent-bot-requests.js'
import { msTeamsAgentBotKey } from './agent-bots.js'
import { MSTEAMS_DEPLOYMENT_SECRET_MARKER } from './deployment-app.js'

const ORG = OrgId('11111111-1111-4111-8111-111111111111')
const AGENT = AgentId('22222222-2222-4222-8222-222222222222')
const TENANT = '33333333-3333-4333-8333-333333333333'
const IDENTITY = '44444444-4444-4444-8444-444444444444'
const APP = {
  appId: '55555555-5555-4555-8555-555555555555',
  tenantId: '66666666-6666-4666-8666-666666666666',
  clientSecret: 'synthetic-app-secret'
}
const AGENT_BOTS = {
  blueprintId: '77777777-7777-4777-8777-777777777777',
  clientSecret: 'synthetic-blueprint-secret',
  subscriptionId: '88888888-8888-4888-8888-888888888888',
  resourceGroup: 'example-bots'
}
const NOW = Date.parse('2026-12-01T00:00:00Z')

interface Script {
  /** Entra's answer to the refresh-token redemption. */
  refresh?: number
  /** The package's definitions as the member's token reads them; null ⇒ the app is gone. */
  definitions?: string[] | null
  /** Graph's status for an install into a team. */
  install?: Record<string, number>
  withdraw?: number
  /** Graph's status for adding the app for the member; 404 ⇒ the catalog no longer holds it. */
  personal?: number
  /** The organization that holds the tenant's app row; null ⇒ no organization does. */
  holder?: string | null
  unreachable?: boolean
}

function harness(script: Script = {}) {
  const clock = new FakeClock(NOW)
  const { rows, store } = memoryMsTeamsAgentBotRequestStore(() => clock.now())
  const calls: string[] = []
  // What a test runs in the middle of a Microsoft call, to interleave a second actor.
  const during: { install?: () => Promise<void>; read?: () => Promise<void> } = {}
  let refreshes = 0
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (script.unreachable) throw new Error('offline')
    if (url.endsWith('/oauth2/v2.0/token')) {
      const form = new URLSearchParams(String(init?.body))
      if (form.get('grant_type') === 'refresh_token') {
        calls.push(`refresh ${form.get('refresh_token')}`)
        if (script.refresh) return Response.json({ error: 'invalid_grant' }, { status: script.refresh })
        refreshes += 1
        return Response.json({ access_token: `access-${refreshes}`, refresh_token: `rotated-${refreshes}` })
      }
      return Response.json({ access_token: `own-${form.get('client_id')}`, expires_in: 3600 })
    }
    if (url.includes('/appDefinitions/')) {
      calls.push(`withdraw ${url.split('/appDefinitions/')[1]}`)
      return new Response(null, { status: script.withdraw ?? 204 })
    }
    if (url.includes('/appCatalogs/teamsApps/')) {
      await during.read?.()
      if (script.definitions === null) return new Response(null, { status: 404 })
      const states = script.definitions ?? ['submitted']
      return Response.json({ appDefinitions: states.map((state, i) => ({ id: `def-${i}`, publishingState: state })) })
    }
    if (/\/users\/[^/]+\/teamwork\/installedApps/.test(url)) {
      calls.push('personal')
      await during.install?.()
      return new Response(null, { status: script.personal ?? 201 })
    }
    const team = /\/teams\/([^/]+)\/installedApps/.exec(url)?.[1]
    if (team) {
      calls.push(`install ${team} ${init?.headers ? (init.headers as Record<string, string>).authorization : ''}`)
      await during.install?.()
      return new Response(null, { status: script.install?.[team] ?? 201 })
    }
    if (url.startsWith('https://management.azure.com/')) {
      calls.push(`${method} registration`)
      return new Response(null, { status: 200 })
    }
    if (url.includes('/servicePrincipals/')) {
      calls.push(`${method} identity`)
      return new Response(null, { status: 204 })
    }
    throw new Error(`unexpected request to ${url}`)
  }) as typeof fetch
  const create = vi.fn(async (input: Record<string, unknown>) => ({ ...input, agentIds: [] }) as unknown as BotRecord)
  const put = vi.fn(async () => {})
  const mergeBotIdentity = vi.fn(async () => true)
  const http = {
    clock,
    config: {},
    httpBot: { hasConnectedRelay: () => true, syncBot: vi.fn(async () => {}) },
    repos: {
      msTeamsAgentBotRequest: store,
      agent: { get: async () => ({ id: AGENT, orgId: ORG, name: 'helper', displayName: 'Helper', visibility: 'org' }) },
      bot: {
        create,
        mergeBotIdentity,
        getByExternalIdentity: async () => null,
        listForPlatform: async () =>
          script.holder === null
            ? []
            : [
                {
                  platform: 'msteams',
                  orgId: script.holder ?? ORG,
                  externalAppId: APP.appId,
                  externalTenantId: TENANT,
                  platformConfig: { appOwner: 'deployment' }
                }
              ]
      },
      botSecret: { put },
      integration: {
        create: vi.fn(async (input: Record<string, unknown>) => ({ ...input, status: 'active' })),
        listForBot: async () => []
      }
    }
  } as unknown as HttpDeps
  const requests = new MsTeamsAgentBotRequests({
    http,
    app: APP,
    agentBots: AGENT_BOTS,
    bindingMutations: { runExclusive: async (_tenant, action) => action() } as MsTeamsBindingMutations,
    fetch: fetchImpl,
    wait: async () => {},
    personalInstallWait: async () => {},
    log: { info: vi.fn(), warn: vi.fn() }
  })
  const open = async (over: Partial<MsTeamsAgentBotRequestRecord> = {}) =>
    store.create({
      id: 'request-1',
      orgId: ORG,
      agentId: AGENT,
      tenantId: TENANT,
      createdByUserId: 'user-1',
      sponsorId: '99999999-9999-4999-8999-999999999999',
      identity: IDENTITY,
      catalogAppId: 'catalog-1',
      teamIds: ['team-1', 'team-2'],
      appPackage: 'fingerprint-1',
      botName: 'Microsoft Teams · Example Org',
      refreshToken: 'stored-token',
      nextCheckAt: new Date(NOW),
      ...over
    } as never)
  return { clock, rows, store, calls, during, create, put, mergeBotIdentity, requests, open }
}

describe('the wait between checks', () => {
  it('starts at seconds, doubles, and stops at the cap', () => {
    expect(msTeamsRequestBackoffMs(0)).toBe(MSTEAMS_REQUEST_FIRST_CHECK_MS)
    expect(msTeamsRequestBackoffMs(1)).toBe(2 * MSTEAMS_REQUEST_FIRST_CHECK_MS)
    expect(msTeamsRequestBackoffMs(20)).toBe(MSTEAMS_REQUEST_MAX_CHECK_MS)
    expect(msTeamsRequestBackoffMs(1000)).toBe(MSTEAMS_REQUEST_MAX_CHECK_MS)
  })
})

describe('MsTeamsAgentBotRequests', () => {
  it('keeps waiting while the package is in review, and replaces the stored token with the one Entra issued', async () => {
    const h = harness()
    await h.open()
    expect(await h.requests.check(ORG, 'request-1')).toEqual({ outcome: 'pending' })
    const row = h.rows.get('request-1')!
    expect(row).toMatchObject({ status: 'pending', checks: 1, refreshToken: 'rotated-1' })
    expect(row.nextCheckAt.getTime()).toBe(NOW + MSTEAMS_REQUEST_FIRST_CHECK_MS)
    expect(h.calls).toEqual(['refresh stored-token'])
    // The next check redeems the token the first one stored.
    await h.requests.check(ORG, 'request-1')
    expect(h.calls.at(-1)).toBe('refresh rotated-1')
    expect(h.rows.get('request-1')!.nextCheckAt.getTime()).toBe(NOW + 2 * MSTEAMS_REQUEST_FIRST_CHECK_MS)
    expect(h.create).not.toHaveBeenCalled()
  })

  it('adds an approved package for the member, writes the row, and forgets the request', async () => {
    const h = harness({ definitions: ['published'] })
    await h.open()
    const checked = await h.requests.check(ORG, 'request-1')
    expect(checked.outcome).toBe('installed')
    // The app is added for the member only; the agent joins a team when someone mentions it there.
    expect(h.calls.filter((call) => call.startsWith('install'))).toEqual([])
    expect(h.calls).toContain('personal')
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG,
        prebuilt: true,
        name: 'Microsoft Teams · Example Org',
        externalAppId: IDENTITY,
        platformConfig: {
          tenantId: TENANT,
          tokenTenantId: TENANT,
          appOwner: 'deployment',
          agentBotBlueprintId: AGENT_BOTS.blueprintId,
          agentBotResourceName: `acbot-${msTeamsAgentBotKey(AGENT, TENANT)}`
        }
      })
    )
    expect(h.put).toHaveBeenCalledWith(ORG, expect.anything(), {
      botToken: MSTEAMS_DEPLOYMENT_SECRET_MARKER,
      appToken: null,
      signingSecret: null
    })
    expect(h.mergeBotIdentity).toHaveBeenCalledTimes(1)
    // The stored sign-in goes with the request.
    expect(h.rows.size).toBe(0)
    expect(await h.requests.check(ORG, 'request-1')).toEqual({ outcome: 'gone' })
  })

  it('stops for the member when Entra refuses the stored sign-in, and drops it', async () => {
    const h = harness({ refresh: 400 })
    await h.open()
    expect(await h.requests.check(ORG, 'request-1')).toEqual({ outcome: 'needs_sign_in' })
    expect(h.rows.get('request-1')).toMatchObject({
      status: 'needs_sign_in',
      reason: 'sign_in_expired',
      refreshToken: null
    })
    // A stopped request is not picked up again until a new sign-in resumes it.
    expect(await h.store.due(new Date(NOW + MSTEAMS_REQUEST_MAX_CHECK_MS), 10)).toEqual([])
    await h.store.resume(ORG, 'request-1', 'new-token', new Date(NOW))
    expect(await h.store.due(new Date(NOW), 10)).toEqual([{ orgId: ORG, id: 'request-1' }])
  })

  it('reads a package that was turned down or removed as rejected, and an unreachable Microsoft as still pending', async () => {
    for (const [definitions, reason] of [
      [['rejected'], 'package_rejected'],
      [null, 'package_removed']
    ] as const) {
      const h = harness({ definitions: definitions as string[] | null, personal: 404 })
      await h.open()
      expect(await h.requests.check(ORG, 'request-1')).toEqual({ outcome: 'rejected' })
      expect(h.rows.get('request-1')).toMatchObject({ status: 'rejected', reason })
    }
    const down = harness({ unreachable: true })
    await down.open()
    expect(await down.requests.check(ORG, 'request-1')).toEqual({ outcome: 'pending' })
    expect(down.rows.get('request-1')).toMatchObject({ status: 'pending', refreshToken: 'stored-token', checks: 1 })
  })

  it('takes a package its member can no longer read as approved when it can be added for them, and waits while that is undecided', async () => {
    // An approved package: the member's token reads no catalog app, but the app is added for them.
    const approved = harness({ definitions: null })
    await approved.open()
    expect(await approved.requests.check(ORG, 'request-1')).toMatchObject({ outcome: 'installed' })
    // Microsoft neither adds it nor says it is gone: the request keeps waiting.
    const undecided = harness({ definitions: null, personal: 403 })
    await undecided.open()
    expect(await undecided.requests.check(ORG, 'request-1')).toEqual({ outcome: 'pending' })
    expect(undecided.rows.get('request-1')).toMatchObject({ status: 'pending' })
  })

  it('lets one check hold a request at a time', async () => {
    const h = harness()
    await h.open()
    await h.store.claim(ORG, 'request-1', 'someone-else', new Date(NOW), new Date(NOW + 60_000))
    expect(await h.requests.check(ORG, 'request-1')).toEqual({ outcome: 'busy' })
    expect(h.calls).toEqual([])
  })

  it('lets only the latest claim finish once a claim ran out: a slow check writes no row after a cancel, and a slow cancel removes no connected bot', async () => {
    // The check is still reading the approved package when its claim runs out and a cancel takes the request.
    const slowCheck = harness({ definitions: ['published'] })
    await slowCheck.open({ teamIds: ['team-1'] })
    slowCheck.during.read = async () => {
      delete slowCheck.during.read
      slowCheck.clock.advance(3 * 60_000)
      expect(await slowCheck.requests.cancel(ORG, 'request-1')).toBe(true)
    }
    expect(await slowCheck.requests.check(ORG, 'request-1')).toEqual({ outcome: 'pending' })
    expect(slowCheck.create).not.toHaveBeenCalled()
    expect(slowCheck.rows.size).toBe(0)

    // The cancel is still reading the package when its claim runs out and a check installs the approved package.
    const slowCancel = harness({ definitions: ['published'] })
    await slowCancel.open({ teamIds: ['team-1'] })
    slowCancel.during.read = async () => {
      delete slowCancel.during.read
      slowCancel.clock.advance(3 * 60_000)
      expect(await slowCancel.requests.check(ORG, 'request-1')).toMatchObject({ outcome: 'installed' })
    }
    expect(await slowCancel.requests.cancel(ORG, 'request-1')).toBe(false)
    expect(slowCancel.create).toHaveBeenCalledTimes(1)
    expect(slowCancel.calls.filter((call) => call.startsWith('DELETE'))).toEqual([])
  })

  it('ends a request whose tenant another organization recovered: nothing is installed and the bot goes', async () => {
    for (const holder of ['99999999-9999-4999-8999-000000000000', null]) {
      const h = harness({ definitions: ['published'], holder })
      await h.open()
      expect(await h.requests.check(ORG, 'request-1')).toEqual({ outcome: 'gone' })
      expect(h.calls).toEqual(['DELETE identity', 'DELETE registration'])
      expect(h.create).not.toHaveBeenCalled()
      expect(h.rows.size).toBe(0)
    }
  })

  it('cancels by withdrawing the submission, deleting the registration and the identity, and forgetting the request', async () => {
    const h = harness()
    await h.open()
    expect(await h.requests.cancel(ORG, 'request-1')).toBe(true)
    expect(h.calls).toEqual(['refresh stored-token', 'withdraw def-0', 'DELETE identity', 'DELETE registration'])
    expect(h.rows.size).toBe(0)
    expect(await h.requests.cancel(ORG, 'request-1')).toBe(false)

    // A sign-in Entra refuses leaves the package to the administrator; the bot is removed all the same.
    const expired = harness({ refresh: 400 })
    await expired.open()
    await expired.requests.cancel(ORG, 'request-1')
    expect(expired.calls).toEqual(['refresh stored-token', 'DELETE identity', 'DELETE registration'])
    expect(expired.rows.size).toBe(0)

    // A check in flight holds the request: the cancel waits its turn and removes nothing.
    const held = harness()
    await held.open()
    await held.store.claim(ORG, 'request-1', 'a-check', new Date(NOW), new Date(NOW + 60_000))
    await expect(held.requests.cancel(ORG, 'request-1')).rejects.toBeInstanceOf(MsTeamsRequestBusy)
    expect(held.calls).toEqual([])
    expect(held.rows.size).toBe(1)

    // Microsoft unreachable: nothing is forgotten half-removed.
    const down = harness({ unreachable: true })
    await down.open()
    await expect(down.requests.cancel(ORG, 'request-1')).rejects.toBeTruthy()
    expect(down.rows.size).toBe(1)
  })

  it('checks what is due on a pass, and cancels a request nobody approved in thirty days', async () => {
    const h = harness()
    await h.open()
    // Another agent's request; one agent has one request per tenant.
    const other = AgentId('22222222-2222-4222-8222-2222222222aa')
    await h.open({ id: 'request-later', agentId: other, nextCheckAt: new Date(NOW + 60_000) } as never)
    await h.requests.tick()
    expect(h.rows.get('request-1')!.checks).toBe(1)
    expect(h.rows.get('request-later')!.checks).toBe(0)

    h.clock.advance(MSTEAMS_REQUEST_TTL_MS + 1)
    await h.requests.tick()
    expect(h.rows.size).toBe(0)
    expect(h.calls.filter((call) => call === 'DELETE registration')).toHaveLength(2)
  })
})
