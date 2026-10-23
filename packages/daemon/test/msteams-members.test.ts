import { describe, expect, it } from 'vitest'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { msTeamsPagedMembersUrl, msTeamsTokenEndpoint } from '../src/platforms/msteams/api.js'
import { MsTeamsConnection, msTeamsConnKey } from '../src/platforms/msteams/connection.js'

const ZERO = '00000000-0000-0000-0000-000000000000'
const SERVICE_URL = `https://smba.trafficmanager.net/amer/${ZERO}/`
const TEAM = '19:example-team@thread.tacv2'
const CHANNEL = '19:example-design@thread.tacv2'
const ALICE = '11111111-1111-1111-1111-111111111111'
const BOB = '22222222-2222-2222-2222-222222222222'

function connection(answer: (url: string) => Response) {
  const reads: string[] = []
  const fetchImpl = (async (url: unknown) => {
    if (String(url) === msTeamsTokenEndpoint(ZERO)) return Response.json({ access_token: 'tok', expires_in: 3600 })
    reads.push(String(url))
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
  return { conn, reads, advance: (ms: number) => (t += ms) }
}

/** A channel post from Alice, as the normalizer hands it on: the sender keyed by Entra object ID. */
function post(): NormalizedMessage {
  return {
    platform: 'msteams',
    channel: CHANNEL,
    isDm: false,
    sender: { id: ALICE, name: 'Alice', isBot: false },
    adapterExt: {
      msteams: { serviceUrl: SERVICE_URL, conversationId: `${CHANNEL};messageid=1700000000000`, teamId: TEAM }
    }
  } as unknown as NormalizedMessage
}

describe('Teams conversation members', () => {
  it('reads every page, keyed as a sender is, once per TTL', async () => {
    const { conn, reads } = connection((url) =>
      url.includes('continuationToken')
        ? Response.json({ members: [{ id: '28:example-bot', name: 'Bot' }] })
        : Response.json({
            members: [
              { id: '29:alice', aadObjectId: ALICE, name: 'Alice' },
              { id: '29:bob', aadObjectId: BOB, name: 'Bob' }
            ],
            continuationToken: 'next-page'
          })
    )
    conn.noteMessage(post())
    expect(await conn.listMembers(CHANNEL)).toEqual([
      { id: ALICE, name: 'Alice', isBot: false },
      { id: BOB, name: 'Bob', isBot: false },
      { id: '28:example-bot', name: 'Bot', isBot: true }
    ])
    await conn.listMembers(CHANNEL)
    expect(reads).toEqual([
      msTeamsPagedMembersUrl(SERVICE_URL, CHANNEL),
      msTeamsPagedMembersUrl(SERVICE_URL, CHANNEL, 'next-page')
    ])
    expect((await conn.getUserProfile(BOB)).name).toBe('Bob')
  })

  it('falls back to the people seen speaking when the read is refused, and asks again after the TTL', async () => {
    let answer = () => Response.json({ error: { code: 'NotEnoughPermissions' } }, { status: 403 })
    const { conn, reads, advance } = connection(() => answer())
    conn.noteMessage(post())
    expect(await conn.listMembers(CHANNEL)).toEqual([{ id: ALICE, name: 'Alice', isBot: false }])
    await conn.listMembers(CHANNEL)
    expect(reads).toHaveLength(1)
    answer = () => Response.json({ members: [{ id: '29:bob', aadObjectId: BOB, name: 'Bob' }] })
    advance(10 * 60_000 + 1)
    expect(await conn.listMembers(CHANNEL)).toEqual([{ id: BOB, name: 'Bob', isBot: false }])
  })

  it('reads nothing for a conversation the bot has not seen', async () => {
    const { conn, reads } = connection(() => Response.json({ members: [] }))
    expect(await conn.listMembers(CHANNEL)).toEqual([])
    expect(reads).toEqual([])
  })
})
