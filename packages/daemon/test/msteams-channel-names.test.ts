import { describe, expect, it } from 'vitest'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { msTeamsTokenEndpoint } from '../src/platforms/msteams/api.js'
import { MsTeamsConnection, msTeamsConnKey } from '../src/platforms/msteams/connection.js'

const ZERO = '00000000-0000-0000-0000-000000000000'
const SERVICE_URL = `https://smba.trafficmanager.net/amer/${ZERO}/`
const TEAM = '19:example-team@thread.tacv2'
const DESIGN = '19:example-design@thread.tacv2'

function connection(answer: () => Response) {
  const calls: string[] = []
  const fetchImpl = (async (url: unknown) => {
    calls.push(String(url))
    if (String(url) === msTeamsTokenEndpoint(ZERO)) return Response.json({ access_token: 'tok', expires_in: 3600 })
    return answer()
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
