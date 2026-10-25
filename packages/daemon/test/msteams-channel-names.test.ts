import { describe, expect, it } from 'vitest'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { msTeamsTeamChannelsUrl, msTeamsTeamUrl, msTeamsTokenEndpoint } from '../src/platforms/msteams/api.js'
import { MsTeamsConnection, msTeamsConnKey } from '../src/platforms/msteams/connection.js'

const ZERO = '00000000-0000-0000-0000-000000000000'
const SERVICE_URL = `https://smba.trafficmanager.net/amer/${ZERO}/`
const TEAM = '19:example-team@thread.tacv2'
const DESIGN = '19:example-design@thread.tacv2'

function connection(answer: (url: string) => Response) {
  const calls: string[] = []
  const fetchImpl = (async (url: unknown) => {
    calls.push(String(url))
    if (String(url) === msTeamsTokenEndpoint(ZERO)) return Response.json({ access_token: 'tok', expires_in: 3600 })
    return answer(String(url))
  }) as typeof fetch
  const config = { appId: ZERO, tenantId: ZERO, clientSecret: 'client-secret-example' }
  let t = 1_000_000
  const conn = new MsTeamsConnection({
    group: { key: msTeamsConnKey(config), agentId: 'a', integrationId: 'i', config, integrations: [] },
    fetchImpl,
    sendIntervalMs: 0,
    now: () => t
  })
  const reads = () => calls.filter((url) => url.includes('/v3/teams/'))
  return { conn, reads, advance: (ms: number) => (t += ms) }
}

/** A channel post in `channel` of the example team, as the normalizer hands it on. */
function post(channel: string): NormalizedMessage {
  return {
    platform: 'msteams',
    channel,
    isDm: false,
    sender: { id: '29:sender', isBot: false },
    adapterExt: {
      msteams: { serviceUrl: SERVICE_URL, conversationId: `${channel};messageid=1700000000000`, teamId: TEAM }
    }
  } as unknown as NormalizedMessage
}

describe('Teams channel names', () => {
  it('reads a team’s channels once, naming the unnamed default channel General', async () => {
    const { conn, reads } = connection(() =>
      Response.json({
        conversations: [
          { id: TEAM, name: null },
          { id: DESIGN, name: 'Design' }
        ]
      })
    )
    conn.noteMessage(post(TEAM))
    conn.noteMessage(post(DESIGN))
    expect(await conn.getChannelInfo(TEAM)).toMatchObject({ id: TEAM, name: 'General', isIm: false })
    expect(await conn.getChannelInfo(DESIGN)).toMatchObject({ name: 'Design' })
    expect(reads()).toEqual([`${SERVICE_URL}v3/teams/${encodeURIComponent(TEAM)}/conversations`])
    expect((await conn.listChannels()).map((c) => c.name)).toEqual(['General', 'Design'])
  })

  it('follows a rename after the TTL, keeping the last name while a refresh fails', async () => {
    let answer = () => Response.json({ conversations: [{ id: DESIGN, name: 'Design' }] })
    const { conn, advance } = connection(() => answer())
    conn.noteMessage(post(DESIGN))
    expect((await conn.getChannelInfo(DESIGN)).name).toBe('Design')
    answer = () => Response.json({ conversations: [{ id: DESIGN, name: 'Engineering' }] })
    expect((await conn.getChannelInfo(DESIGN)).name).toBe('Design')
    advance(10 * 60_000 + 1)
    expect((await conn.getChannelInfo(DESIGN)).name).toBe('Engineering')
    answer = () => new Response(null, { status: 503 })
    advance(10 * 60_000 + 1)
    expect((await conn.getChannelInfo(DESIGN)).name).toBe('Engineering')
  })

  it('names nothing when the read fails, and tries again only after a while', async () => {
    const { conn, reads, advance } = connection(() => new Response(null, { status: 403 }))
    conn.noteMessage(post(DESIGN))
    expect((await conn.getChannelInfo(DESIGN)).name).toBeUndefined()
    expect((await conn.getChannelInfo(DESIGN)).name).toBeUndefined()
    expect(reads()).toHaveLength(1)
    advance(10 * 60_000 + 1)
    await conn.getChannelInfo(DESIGN)
    expect(reads()).toHaveLength(2)
  })

  it('reads nothing for a conversation outside a team', async () => {
    const { conn, reads } = connection(() => Response.json({ conversations: [] }))
    conn.noteMessage({
      ...post('19:example-chat@thread.v2'),
      adapterExt: { msteams: { serviceUrl: SERVICE_URL, conversationId: '19:example-chat@thread.v2' } }
    } as unknown as NormalizedMessage)
    expect((await conn.getChannelInfo('19:example-chat@thread.v2')).name).toBeUndefined()
    expect(reads()).toEqual([])
  })
})

const PRIVATE = '19:example-private@thread.tacv2'
const SHARED = '19:example-shared@thread.tacv2'
const CHAT = '19:example-chat@thread.v2'

/** A team that answers its details and a channel list of every kind. */
function team(details: () => Response = () => Response.json({ id: TEAM, name: 'Example Team', aadGroupId: ZERO })) {
  return connection((url) => {
    if (url === msTeamsTeamUrl(SERVICE_URL, TEAM)) return details()
    if (url === msTeamsTeamChannelsUrl(SERVICE_URL, TEAM))
      return Response.json({
        conversations: [
          { id: TEAM, name: null, type: 'standard' },
          { id: DESIGN, name: 'Design', type: 'standard' },
          { id: PRIVATE, name: 'Private', type: 'private' },
          { id: SHARED, name: 'Shared', type: 'shared' }
        ]
      })
    return new Response(null, { status: 404 })
  })
}

describe('a Teams channel’s space', () => {
  it('is its team, named by the team’s details, read once per team and TTL', async () => {
    const { conn, reads, advance } = team()
    conn.noteMessage(post(TEAM))
    conn.noteMessage(post(DESIGN))
    expect(await conn.spaceOf(TEAM)).toEqual({ id: TEAM, name: 'Example Team' })
    expect(await conn.spaceOf(DESIGN)).toEqual({ id: TEAM, name: 'Example Team' })
    const details = () => reads().filter((url) => url === msTeamsTeamUrl(SERVICE_URL, TEAM))
    expect(details()).toHaveLength(1)
    advance(10 * 60_000 + 1)
    await conn.spaceOf(DESIGN)
    expect(details()).toHaveLength(2)
  })

  it('is unknown while the team’s name cannot be read, and for a chat or an unseen conversation', async () => {
    const { conn } = team(() => new Response(null, { status: 403 }))
    conn.noteMessage(post(DESIGN))
    expect(await conn.spaceOf(DESIGN)).toBeUndefined()
    conn.noteMessage({
      ...post(CHAT),
      adapterExt: { msteams: { serviceUrl: SERVICE_URL, conversationId: CHAT } }
    } as unknown as NormalizedMessage)
    expect(await conn.spaceOf(CHAT)).toBeUndefined()
    expect(await conn.spaceOf('19:example-unseen@thread.tacv2')).toBeUndefined()
  })
})

describe('a team-wide install’s places', () => {
  it('are the team’s standard channels, General included, with the team as their space', async () => {
    const { conn } = team()
    expect(await conn.teamInstallPlaces(SERVICE_URL, TEAM)).toEqual([
      { id: TEAM, name: 'General', spaceId: TEAM, space: 'Example Team' },
      { id: DESIGN, name: 'Design', spaceId: TEAM, space: 'Example Team' }
    ])
  })

  it('carry no space while the team’s name cannot be read', async () => {
    const { conn } = team(() => new Response(null, { status: 403 }))
    expect(await conn.teamInstallPlaces(SERVICE_URL, TEAM)).toEqual([
      { id: TEAM, name: 'General' },
      { id: DESIGN, name: 'Design' }
    ])
  })
})
