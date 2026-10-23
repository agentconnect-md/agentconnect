import { describe, expect, it } from 'vitest'
import { Daemon } from '../src/daemon.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { msTeamsActivitiesUrl, msTeamsTokenEndpoint } from '../src/platforms/msteams/api.js'
import { MsTeamsConnection, msTeamsConnKey } from '../src/platforms/msteams/connection.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const ZERO = '00000000-0000-0000-0000-000000000000'
const SERVICE_URL = `https://smba.trafficmanager.net/amer/${ZERO}/`
const TEAM = '19:example-team@thread.tacv2'
const CHANNEL = '19:example-design@thread.tacv2'

function connection() {
  const posts: string[] = []
  const fetchImpl = (async (url: unknown) => {
    if (String(url) === msTeamsTokenEndpoint(ZERO)) return Response.json({ access_token: 'tok', expires_in: 3600 })
    posts.push(String(url))
    return Response.json({ id: `17000000000${posts.length}` })
  }) as typeof fetch
  const config = { appId: ZERO, tenantId: ZERO, clientSecret: 'client-secret-example' }
  const conn = new MsTeamsConnection({
    group: { key: msTeamsConnKey(config), agentId: 'a', integrationId: 'i', config, integrations: [] },
    fetchImpl,
    sendIntervalMs: 0
  })
  return { conn, posts }
}

function channelPost(): NormalizedMessage {
  return {
    platform: 'msteams',
    channel: CHANNEL,
    isDm: false,
    sender: { id: '29:sender', isBot: false },
    adapterExt: {
      msteams: { serviceUrl: SERVICE_URL, conversationId: `${CHANNEL};messageid=1600000000000`, teamId: TEAM }
    }
  } as unknown as NormalizedMessage
}

describe('Teams send tool', () => {
  it('is the gateway the session tools resolve for a Teams integration', () => {
    const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const { conn } = connection()
    daemon.msTeamsConnByIntegration.set('i', conn)
    expect(daemon.gatewayForIntegration('i')).toBe(conn)
  })

  it('opens a thread in a seen channel and keeps a long post’s later parts in it', async () => {
    const { conn, posts } = connection()
    conn.noteMessage(channelPost())
    const id = await conn.postMessage(CHANNEL, 'line\n'.repeat(20_000))
    expect(id).toBe('170000000001')
    expect(posts).toEqual([
      msTeamsActivitiesUrl(SERVICE_URL, CHANNEL),
      msTeamsActivitiesUrl(SERVICE_URL, `${CHANNEL};messageid=170000000001`)
    ])
  })

  it('posts into a given thread', async () => {
    const { conn, posts } = connection()
    conn.noteMessage(channelPost())
    await conn.postMessage(CHANNEL, 'hello', '1600000000000')
    expect(posts).toEqual([msTeamsActivitiesUrl(SERVICE_URL, `${CHANNEL};messageid=1600000000000`)])
  })

  it('refuses a conversation the bot has not seen', async () => {
    const { conn, posts } = connection()
    await expect(conn.postMessage(CHANNEL, 'hello')).rejects.toThrow(/unknown/)
    expect(posts).toEqual([])
  })
})
