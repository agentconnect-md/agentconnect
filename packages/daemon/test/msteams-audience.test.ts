// Teams' audience as Slack's is judged (assistant-mode.md §5.3): a shared channel, a guest, another tenant, a full member.
import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import {
  msTeamsConversationMemberUrl,
  msTeamsPagedMembersUrl,
  msTeamsTeamChannelsUrl,
  msTeamsTeamUrl,
  msTeamsTokenEndpoint
} from '../src/platforms/msteams/api.js'
import { MsTeamsConnection, msTeamsConnKey } from '../src/platforms/msteams/connection.js'
import {
  msTeamsGraphChannelMembersUrl,
  msTeamsGraphMember,
  msTeamsGraphTeamUrl
} from '../src/platforms/msteams/graph.js'
import { msTeamsMemberJoins } from '../src/platforms/msteams/module.js'
import { msTeamsRelayIngress, type MsTeamsRelayIngressHost } from '../src/platforms/msteams/relay-ingress.js'
import { confirmsInternalAudience, membersAuthoritative } from '../src/platforms/read-ports.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const HOME = '00000000-0000-0000-0000-00000000000b'
const OTHER = '00000000-0000-0000-0000-0000000000ff'
const APP = '00000000-0000-0000-0000-00000000000a'
const SERVICE_URL = `https://smba.trafficmanager.net/amer/${HOME}/`
const TEAM = '19:example-team@thread.tacv2'
const STANDARD = '19:example-standard@thread.tacv2'
const PRIVATE = '19:example-private@thread.tacv2'
const SHARED = '19:example-shared@thread.tacv2'
const CHAT = '19:example-chat@thread.v2'
const ALICE = '11111111-1111-1111-1111-111111111111'
const GUEST = '22222222-2222-2222-2222-222222222222'
const OUTSIDER = '33333333-3333-3333-3333-333333333333'

const people: Record<string, Record<string, string>> = {
  [ALICE]: { id: '29:alice', aadObjectId: ALICE, name: 'Alice', userRole: 'user', tenantId: HOME },
  [GUEST]: { id: '29:guest', aadObjectId: GUEST, name: 'Guest', userRole: 'guest', tenantId: HOME },
  [OUTSIDER]: { id: '29:outsider', aadObjectId: OUTSIDER, name: 'Outsider', userRole: 'user', tenantId: OTHER }
}

type Answer = (url: string) => Response | undefined

function connection(answer: Answer = () => undefined) {
  const reads: string[] = []
  const fetchImpl = (async (input: unknown) => {
    const url = String(input)
    if (url === msTeamsTokenEndpoint(HOME)) return Response.json({ access_token: 'tok', expires_in: 3600 })
    reads.push(url)
    const own = answer(url)
    if (own) return own
    if (url === msTeamsTeamChannelsUrl(SERVICE_URL, TEAM))
      return Response.json({
        conversations: [
          { id: TEAM, type: 'standard' },
          { id: STANDARD, name: 'Design', type: 'standard' },
          { id: PRIVATE, name: 'Leads', type: 'private' },
          { id: SHARED, name: 'Partners', type: 'shared' }
        ]
      })
    for (const [aad, member] of Object.entries(people))
      for (const conversation of [TEAM, STANDARD, CHAT])
        if (url === msTeamsConversationMemberUrl(SERVICE_URL, conversation, aad)) return Response.json(member)
    return Response.json({ error: { code: 'MemberNotFoundInConversation' } }, { status: 404 })
  }) as typeof fetch
  const config = { appId: APP, tenantId: HOME, clientSecret: 'client-secret-example' }
  const conn = new MsTeamsConnection({
    group: { key: msTeamsConnKey(config), agentId: 'a', integrationId: 'i', config, integrations: [] },
    fetchImpl,
    sendIntervalMs: 0,
    sleep: async () => {}
  })
  return { conn, reads }
}

function post(channel: string, sender = ALICE): NormalizedMessage {
  const isChannel = channel.endsWith('@thread.tacv2')
  return {
    platform: 'msteams',
    channel,
    isDm: false,
    sender: { id: sender, isBot: false },
    adapterExt: {
      msteams: {
        serviceUrl: SERVICE_URL,
        conversationId: isChannel ? `${channel};messageid=1700000000000` : channel,
        ...(isChannel ? { teamId: TEAM } : {})
      }
    }
  } as unknown as NormalizedMessage
}

describe('Teams audience', () => {
  it('declares the audience ports Slack does', () => {
    expect(confirmsInternalAudience('msteams')).toBe(true)
    expect(membersAuthoritative('msteams')).toBe(true)
  })

  it('reports a shared channel as shared, every other channel and chat as unshared, and every one private', async () => {
    const { conn } = connection()
    for (const channel of [STANDARD, PRIVATE, SHARED, CHAT]) conn.noteMessage(post(channel))
    expect(await conn.getChannelInfo(SHARED)).toMatchObject({ isPrivate: true, externalReason: 'externallyShared' })
    expect(await conn.getChannelInfo(STANDARD)).toMatchObject({ isPrivate: true, externalReason: null })
    expect(await conn.getChannelInfo(PRIVATE)).toMatchObject({ isPrivate: true, externalReason: null })
    expect(await conn.getChannelInfo(CHAT)).toMatchObject({ isPrivate: true, externalReason: null })
    expect(await conn.sharedChannel(SHARED)).toBe(true)
    expect(await conn.sharedChannel(STANDARD)).toBe(false)
  })

  it('leaves a channel’s sharing unknown while its team’s list cannot be read', async () => {
    const { conn } = connection((url) =>
      url === msTeamsTeamChannelsUrl(SERVICE_URL, TEAM) ? new Response(null, { status: 503 }) : undefined
    )
    conn.noteMessage(post(SHARED))
    expect(await conn.getChannelInfo(SHARED)).not.toHaveProperty('externalReason')
  })

  it('finds a guest and another tenant’s member among the people a channel or chat gained', async () => {
    const { conn } = connection()
    const join = (conversationId: string, ids: string[]) => ({
      kind: 'members-added' as const,
      conversationId,
      serviceUrl: SERVICE_URL,
      teamId: TEAM,
      teamWide: false,
      members: ids.map((aad) => ({ id: people[aad]!.id!, aadObjectId: aad }))
    })
    expect(await conn.joinedMemberReasons(join(STANDARD, [ALICE]))).toEqual([])
    expect(await conn.joinedMemberReasons(join(STANDARD, [GUEST]))).toEqual([
      { channel: STANDARD, reason: 'guestMember' }
    ])
    expect(await conn.joinedMemberReasons(join(CHAT, [OUTSIDER]))).toEqual([
      { channel: CHAT, reason: 'externalMember' }
    ])
  })

  it('leaves a 1:1 chat a guest installed the bot in trusting its person', async () => {
    const { conn, reads } = connection()
    const reasons = await conn.joinedMemberReasons({
      kind: 'members-added',
      conversationId: 'a:example-personal',
      serviceUrl: SERVICE_URL,
      teamWide: false,
      members: [{ id: '29:guest', aadObjectId: GUEST }]
    })
    expect(reasons).toEqual([])
    expect(reads).toEqual([])
  })

  it('carries a guest who joined the team into every standard channel', async () => {
    const { conn } = connection()
    const reasons = await conn.joinedMemberReasons({
      kind: 'members-added',
      conversationId: TEAM,
      serviceUrl: SERVICE_URL,
      teamId: TEAM,
      teamWide: true,
      members: [{ id: '29:guest', aadObjectId: GUEST }]
    })
    expect(reasons.map((r) => r.channel).sort()).toEqual([STANDARD, TEAM].sort())
    expect(new Set(reasons.map((r) => r.reason))).toEqual(new Set(['guestMember']))
  })

  it('tells a full member from a guest and an outsider, and refuses to guess about a stranger', async () => {
    const { conn } = connection()
    conn.noteMessage(post(STANDARD, ALICE))
    conn.noteMessage(post(STANDARD, GUEST))
    conn.noteMessage(post(CHAT, OUTSIDER))
    expect(await conn.isFullMember(ALICE)).toBe(true)
    expect(await conn.isFullMember(GUEST)).toBe(false)
    expect(await conn.isFullMember(OUTSIDER)).toBe(false)
    await expect(conn.isFullMember('44444444-4444-4444-4444-444444444444')).rejects.toThrow(/standing/)
  })

  it('lists every member keyed as a sender, and refuses a listing it cannot finish or read', async () => {
    let pages = 0
    const { conn } = connection((url) => {
      if (url === msTeamsPagedMembersUrl(SERVICE_URL, STANDARD))
        return Response.json({ members: [people[ALICE], { id: '28:example-bot' }], continuationToken: 'next' })
      if (url === msTeamsPagedMembersUrl(SERVICE_URL, STANDARD, 'next')) {
        pages++
        return Response.json({ members: [people[GUEST]] })
      }
      if (url.startsWith(msTeamsPagedMembersUrl(SERVICE_URL, SHARED).split('?')[0]!))
        return Response.json({ error: { code: 'NotEnoughPermissions' } }, { status: 403 })
      return undefined
    })
    conn.noteMessage(post(STANDARD))
    conn.noteMessage(post(SHARED))
    expect(await conn.listMemberIds(STANDARD)).toEqual([ALICE, GUEST])
    expect(pages).toBe(1)
    expect(await conn.isFullMember(GUEST)).toBe(false)
    await expect(conn.listMemberIds(SHARED)).rejects.toThrow()
    await expect(conn.listMemberIds(CHAT)).rejects.toThrow(/unknown/)
  })

  it('flags a post in a shared channel before its turn, and leaves a standard channel’s alone', async () => {
    const { conn } = connection()
    const placeExternal = vi.fn()
    const host = {
      log: () => ({ trace() {}, debug() {}, info() {}, warn() {}, error() {} }),
      store: () => ({}) as never,
      now: () => 0,
      connection: () => conn,
      agent: () => undefined,
      noteMessage: () => {},
      observePlatformChat: async () => {},
      placeExternal
    } as unknown as MsTeamsRelayIngressHost
    const ingress = msTeamsRelayIngress(host)
    const shared = { ...post(SHARED), msgId: 'msteams:x:1' } as NormalizedMessage
    const standard = { ...post(STANDARD), msgId: 'msteams:x:2' } as NormalizedMessage
    for (const message of [shared, standard]) {
      // Core notes the delivery before any gate, then prepares it.
      ingress.observe?.({ integrationId: 'i' } as never, message)
      await ingress.prepare({ integrationId: 'i' } as never, message, { stage: '' })
    }
    expect(shared.externallyShared).toBe(true)
    expect(standard.externallyShared).toBeUndefined()
    expect(placeExternal).toHaveBeenCalledExactlyOnceWith(['i'], SHARED, 'externallyShared')
  })

  it('decodes only a member join, and looks it up through the integration’s connection', async () => {
    const { conn } = connection()
    const joins = msTeamsMemberJoins({ connection: () => conn } as unknown as MsTeamsRelayIngressHost)
    expect(joins.decode({ payload: { verb: 'approve' } } as never)).toBeNull()
    const join = joins.decode({
      integrationId: 'i',
      payload: {
        kind: 'members-added',
        conversationId: CHAT,
        serviceUrl: SERVICE_URL,
        teamWide: false,
        members: [{ id: '29:outsider', aadObjectId: OUTSIDER }]
      }
    } as never)
    expect(await join?.reasons()).toEqual([{ channel: CHAT, reason: 'externalMember' }])
  })

  it('detects a relayed member join for the agent’s integration, and refuses one for an integration it does not have', async () => {
    const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const { conn } = connection()
    const agentId = '55555555-5555-4555-8555-555555555555'
    const integrationId = '66666666-6666-4666-8666-666666666666'
    daemon.agents.set(agentId, {
      id: agentId,
      name: 'Butler',
      integrations: [{ id: integrationId, platform: 'msteams' }]
    })
    daemon.msTeamsConnByIntegration.set(integrationId, conn)
    vi.spyOn(daemon.placeTrust, 'watches').mockReturnValue(true)
    const detected = vi.spyOn(daemon.placeTrust, 'detected').mockImplementation(() => {})
    const relayed = (id: string) => ({
      source: 'platform_action',
      platformId: 'msteams',
      agentId,
      integrationId: id,
      sessionKey: `msteams-members:${CHAT}`,
      msgId: 'msteams-members:1',
      botId: '77777777-7777-4777-8777-777777777777',
      payload: {
        kind: 'members-added',
        conversationId: CHAT,
        serviceUrl: SERVICE_URL,
        teamWide: false,
        members: [{ id: '29:outsider', aadObjectId: OUTSIDER }]
      }
    })
    expect(await daemon.handleRelayPlatformAction(relayed(integrationId))).toMatchObject({ accepted: true })
    expect(detected).toHaveBeenCalledExactlyOnceWith([integrationId], CHAT, 'externalMember')
    const other = '88888888-8888-4888-8888-888888888888'
    expect(await daemon.handleRelayPlatformAction(relayed(other))).toMatchObject({ accepted: false })
  })
})

describe('Teams audience through Graph', () => {
  const GROUP = '00000000-0000-0000-0000-00000000000d'
  const graphMember = (aad: string, roles: string[] = []) => ({
    '@odata.type': '#microsoft.graph.aadUserConversationMember',
    userId: aad,
    displayName: people[aad]!.name,
    roles,
    tenantId: people[aad]!.tenantId
  })
  // The team's group, its visibility, and a shared channel's members as Graph answers them.
  const graph =
    (visibility: string, sharedMembers: unknown[]): Answer =>
    (url) => {
      if (url === msTeamsTeamUrl(SERVICE_URL, TEAM)) return Response.json({ id: TEAM, aadGroupId: GROUP })
      if (url === msTeamsGraphTeamUrl(GROUP)) return Response.json({ id: GROUP, visibility })
      if (url === msTeamsGraphChannelMembersUrl(GROUP, SHARED)) return Response.json({ value: sharedMembers })
      return undefined
    }

  it('keeps a shared channel used only inside the organization internal, and shares one with another tenant’s member', async () => {
    const inside = connection(graph('private', [graphMember(ALICE, ['owner'])])).conn
    inside.noteMessage(post(SHARED))
    expect(await inside.getChannelInfo(SHARED)).toMatchObject({ isPrivate: true, externalReason: null })
    expect(await inside.sharedChannel(SHARED)).toBe(false)
    const reaching = connection(graph('private', [graphMember(ALICE, ['owner']), graphMember(OUTSIDER)])).conn
    reaching.noteMessage(post(SHARED))
    expect(await reaching.getChannelInfo(SHARED)).toMatchObject({ externalReason: 'externallyShared' })
    expect(await reaching.sharedChannel(SHARED)).toBe(true)
  })

  it('reports a standard channel public only in a public team, and every other channel private', async () => {
    const open = connection(graph('public', [])).conn
    for (const channel of [STANDARD, PRIVATE]) open.noteMessage(post(channel))
    expect(await open.getChannelInfo(STANDARD)).toMatchObject({ isPrivate: false, externalReason: null })
    expect(await open.getChannelInfo(PRIVATE)).toMatchObject({ isPrivate: true })
    const closed = connection(graph('private', [])).conn
    closed.noteMessage(post(STANDARD))
    expect(await closed.getChannelInfo(STANDARD)).toMatchObject({ isPrivate: true })
  })

  it('lists a shared channel’s members through Graph, a guest by role', async () => {
    const { conn } = connection(graph('private', [graphMember(ALICE, ['owner']), graphMember(GUEST, ['guest'])]))
    conn.noteMessage(post(SHARED))
    expect(await conn.listMemberIds(SHARED)).toEqual([ALICE, GUEST])
    expect(await conn.isFullMember(GUEST)).toBe(false)
    expect(msTeamsGraphMember(graphMember(OUTSIDER))).toMatchObject({ id: OUTSIDER, userRole: 'user', tenantId: OTHER })
  })

  it('lists a person Graph repeats through the team share once, and a guest copy keeps them a guest', async () => {
    const twice = [
      graphMember(ALICE, ['owner']),
      graphMember(GUEST),
      { ...graphMember(ALICE), userId: ALICE.toUpperCase() },
      graphMember(GUEST, ['guest'])
    ]
    const { conn } = connection(graph('private', twice))
    conn.noteMessage(post(SHARED))
    expect(await conn.listMemberIds(SHARED)).toEqual([ALICE, GUEST])
    expect(await conn.isFullMember(GUEST)).toBe(false)
  })
})
