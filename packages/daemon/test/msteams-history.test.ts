import { describe, expect, it } from 'vitest'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { msTeamsTeamUrl, msTeamsTokenEndpoint } from '../src/platforms/msteams/api.js'
import { MsTeamsConnection, msTeamsConnKey } from '../src/platforms/msteams/connection.js'
import { msTeamsGraphMessagesUrl, msTeamsGraphMessageUrl, msTeamsHtmlText } from '../src/platforms/msteams/graph.js'
import { declaresPort } from '../src/platforms/read-ports.js'

const APP = '00000000-0000-0000-0000-00000000000a'
const TENANT = '00000000-0000-0000-0000-00000000000b'
const HOME = '00000000-0000-0000-0000-00000000000c'
const GROUP = '00000000-0000-0000-0000-00000000000d'
const PERSON = '00000000-0000-0000-0000-00000000000e'
const SERVICE_URL = `https://smba.trafficmanager.net/amer/${TENANT}/`
const TEAM = '19:example-team@thread.tacv2'
const DESIGN = '19:example-design@thread.tacv2'
const CHAT = '19:example-chat@thread.v2'
const CHANNEL = { kind: 'channel' as const, groupId: GROUP, channelId: DESIGN }

type Answer = (url: URL, scope?: string) => Response | undefined

function connection(answer: Answer, config: Record<string, string> = {}) {
  const calls: { url: string; scope?: string; auth?: string }[] = []
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.host === 'login.microsoftonline.com') {
      const scope = new URLSearchParams(String(init?.body)).get('scope') ?? undefined
      calls.push({ url: url.toString(), ...(scope ? { scope } : {}) })
      return Response.json({ access_token: scope?.includes('graph') ? 'graph-token' : 'bot-token', expires_in: 3600 })
    }
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization
    calls.push({ url: url.toString(), ...(auth ? { auth } : {}) })
    if (url.toString() === msTeamsTeamUrl(SERVICE_URL, TEAM)) return Response.json({ id: TEAM, aadGroupId: GROUP })
    return answer(url) ?? new Response(null, { status: 404 })
  }) as typeof fetch
  const cfg = { appId: APP, tenantId: TENANT, clientSecret: 'client-secret-example', ...config }
  const conn = new MsTeamsConnection({
    group: { key: msTeamsConnKey(cfg), agentId: 'a', integrationId: 'i', config: cfg, integrations: [] },
    fetchImpl,
    sendIntervalMs: 0,
    sleep: async () => {}
  })
  return { conn, calls, graphCalls: () => calls.filter((c) => c.url.startsWith('https://graph.microsoft.com/')) }
}

function seen(conn: MsTeamsConnection, channel: string, kind: 'channel' | 'chat' | 'personal'): void {
  conn.noteMessage({
    platform: 'msteams',
    channel,
    isDm: kind === 'personal',
    sender: { id: PERSON, isBot: false },
    adapterExt: {
      msteams: {
        serviceUrl: SERVICE_URL,
        conversationId: kind === 'channel' ? `${channel};messageid=1700000000000` : channel,
        ...(kind === 'channel' ? { teamId: TEAM } : {})
      }
    }
  } as unknown as NormalizedMessage)
}

function message(id: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: String(id),
    messageType: 'message',
    createdDateTime: new Date(id).toISOString(),
    from: { user: { id: PERSON, displayName: 'Example Person' } },
    body: { contentType: 'html', content: `<p>post ${id}</p>` },
    webUrl: `https://teams.microsoft.com/l/message/example/${id}`,
    ...extra
  }
}

function botMessage(id: number, appId: string, card = false): Record<string, unknown> {
  return message(id, {
    from: { application: { id: appId, displayName: 'Example Bot', applicationIdentityType: 'bot' } },
    body: { contentType: 'text', content: card ? '' : `bot ${id}` },
    attachments: card ? [{ contentType: 'application/vnd.microsoft.card.adaptive', content: '{}' }] : []
  })
}

describe('Teams history', () => {
  it('is declared for both history tools', () => {
    expect(declaresPort('msteams', 'channelHistory')).toBe(true)
    expect(declaresPort('msteams', 'threadHistory')).toBe(true)
  })

  it('reads a channel newest first through the team’s group, with a Graph token from the conversations’ tenant', async () => {
    const { conn, calls, graphCalls } = connection(
      (url) =>
        url.pathname.endsWith('/messages')
          ? Response.json({
              value: [
                message(1700000000300),
                {
                  id: '1700000000250',
                  messageType: 'unknownFutureValue',
                  createdDateTime: new Date(1700000000250).toISOString()
                },
                message(1700000000100, { deletedDateTime: new Date(1700000000400).toISOString() }),
                botMessage(1700000000200, APP)
              ],
              '@odata.nextLink': `https://graph.microsoft.com/v1.0/teams/${GROUP}/channels/x/messages?$top=2&$skiptoken=next-page`
            })
          : undefined,
      { tokenTenantId: HOME }
    )
    seen(conn, DESIGN, 'channel')
    const page = await conn.getChannelHistory(DESIGN, { limit: 2 })
    expect(page).toEqual({
      messages: [
        {
          sender: PERSON,
          ts: '1700000000300',
          text: 'post 1700000000300',
          isBot: false,
          threadTs: '1700000000300',
          link: 'https://teams.microsoft.com/l/message/example/1700000000300'
        },
        {
          sender: `28:${APP}`,
          ts: '1700000000200',
          text: 'bot 1700000000200',
          isBot: true,
          threadTs: '1700000000200',
          link: 'https://teams.microsoft.com/l/message/example/1700000000200'
        }
      ],
      hasMore: true,
      nextCursor: 'next-page'
    })
    expect(graphCalls().map((c) => c.url)).toEqual([msTeamsGraphMessagesUrl(CHANNEL, { top: 2 })])
    expect(graphCalls()[0]!.auth).toBe('Bearer graph-token')
    const graphToken = calls.find((c) => c.scope === 'https://graph.microsoft.com/.default')
    expect(graphToken?.url).toBe(msTeamsTokenEndpoint(TENANT))
  })

  it('continues from a cursor, caps a page at 50, and reads the team’s group once', async () => {
    const { conn, calls, graphCalls } = connection(() => Response.json({ value: [] }))
    seen(conn, DESIGN, 'channel')
    await conn.getChannelHistory(DESIGN, { limit: 200 })
    await conn.getChannelHistory(DESIGN, { cursor: 'next-page' })
    expect(graphCalls().map((c) => c.url)).toEqual([
      msTeamsGraphMessagesUrl(CHANNEL, { top: 50 }),
      msTeamsGraphMessagesUrl(CHANNEL, { top: 50, skiptoken: 'next-page' })
    ])
    expect(calls.filter((c) => c.url === msTeamsTeamUrl(SERVICE_URL, TEAM))).toHaveLength(1)
    await expect(conn.getChannelHistory(DESIGN, { cursor: 'a&$expand=x' })).rejects.toThrow(/cursor/)
  })

  it('keeps the inclusive bounds, and a chat stops paging past the oldest one', async () => {
    const { conn } = connection(() =>
      Response.json({
        value: [message(1700000000300), message(1700000000200), message(1700000000100)],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/x?$skiptoken=more'
      })
    )
    seen(conn, CHAT, 'chat')
    const page = await conn.getChannelHistory(CHAT, { oldest: '1700000000200', latest: '1700000000250' })
    expect(page.messages.map((m) => m.ts)).toEqual(['1700000000200'])
    expect(page.hasMore).toBe(false)
  })

  it('keeps a channel’s cursor past an old post whose thread is active, since channels list by thread activity', async () => {
    const { conn } = connection(() =>
      Response.json({
        value: [message(1690000000000)],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/x?$skiptoken=more'
      })
    )
    seen(conn, DESIGN, 'channel')
    expect(await conn.getChannelHistory(DESIGN, { limit: 1, oldest: '1700000000000' })).toEqual({
      messages: [],
      hasMore: true,
      nextCursor: 'more'
    })
  })

  it('asks a chat for creation order, and a channel for its default', () => {
    const chat = new URL(msTeamsGraphMessagesUrl({ kind: 'chat', chatId: CHAT }, { top: 5, skiptoken: 'more' }))
    expect(chat.searchParams.get('$orderby')).toBe('createdDateTime desc')
    expect(chat.searchParams.get('$skiptoken')).toBe('more')
    expect(new URL(msTeamsGraphMessagesUrl(CHANNEL, { top: 5 })).searchParams.has('$orderby')).toBe(false)
  })

  it('reads a group chat’s messages, which carry no threads', async () => {
    const { conn, graphCalls } = connection(() => Response.json({ value: [message(1700000000100)] }))
    seen(conn, CHAT, 'chat')
    const page = await conn.getChannelHistory(CHAT)
    expect(page.messages).toEqual([expect.not.objectContaining({ threadTs: expect.anything() as unknown })])
    expect(graphCalls().map((c) => c.url)).toEqual([
      msTeamsGraphMessagesUrl({ kind: 'chat', chatId: CHAT }, { top: 50 })
    ])
    await expect(conn.getThreadReplies(CHAT, '1700000000100', 10, { throwOnError: true })).rejects.toThrow(/no threads/)
  })

  it('refuses a missing consent clearly rather than answering empty history', async () => {
    const forbidden = () =>
      Response.json(
        { error: { code: 'Forbidden', message: 'Missing role permissions on the request.' } },
        { status: 403 }
      )
    const { conn } = connection(forbidden)
    seen(conn, DESIGN, 'channel')
    seen(conn, CHAT, 'chat')
    await expect(conn.getChannelHistory(DESIGN)).rejects.toThrow(/ChannelMessage\.Read\.Group/)
    await expect(conn.getChannelHistory(CHAT)).rejects.toThrow(/ChatMessage\.Read\.Chat/)
    await expect(conn.getThreadReplies(DESIGN, '1700000000100', 10, { throwOnError: true })).rejects.toMatchObject({
      kind: 'forbidden'
    })
  })

  it('refuses conversations it cannot read', async () => {
    const { conn, graphCalls } = connection(() => Response.json({ value: [] }))
    seen(conn, 'a:example-personal', 'personal')
    await expect(conn.getChannelHistory('a:example-personal')).rejects.toThrow(/1:1/)
    await expect(conn.getChannelHistory(DESIGN)).rejects.toThrow(/unknown/)
    expect(graphCalls()).toEqual([])
  })

  it('reads a thread’s root and its newest replies oldest first, marking its own cards as chrome', async () => {
    const replies = [
      botMessage(1700000000500, APP, true),
      botMessage(1700000000400, '00000000-0000-0000-0000-0000000000ff'),
      message(1700000000300),
      message(1700000000200)
    ]
    const { conn, graphCalls } = connection((url) => {
      if (url.pathname.endsWith('/replies')) {
        const second = url.searchParams.get('$skiptoken') === 'older'
        return Response.json({
          value: second ? replies.slice(2) : replies.slice(0, 2),
          ...(second ? {} : { '@odata.nextLink': 'https://graph.microsoft.com/v1.0/x?$skiptoken=older' })
        })
      }
      if (url.pathname.endsWith('/1700000000100')) return Response.json(message(1700000000100))
      return undefined
    })
    seen(conn, DESIGN, 'channel')
    const readState = { truncated: false }
    const thread = await conn.getThreadReplies(DESIGN, '1700000000100', 4, { readState })
    expect(thread.map((m) => [m.ts, m.isBot, m.chrome])).toEqual([
      ['1700000000100', false, false],
      ['1700000000300', false, false],
      ['1700000000400', true, false],
      ['1700000000500', true, true]
    ])
    expect(thread[2]).toMatchObject({ sender: '28:00000000-0000-0000-0000-0000000000ff', attachments: [] })
    expect(readState.truncated).toBe(true)
    expect(graphCalls().map((c) => c.url)).toEqual([
      msTeamsGraphMessageUrl(CHANNEL, '1700000000100'),
      msTeamsGraphMessagesUrl(CHANNEL, { rootId: '1700000000100', top: 50 }),
      msTeamsGraphMessagesUrl(CHANNEL, { rootId: '1700000000100', top: 50, skiptoken: 'older' })
    ])
  })

  it('keeps a thread’s replies inside the exclusive bounds and reads only the root for one message', async () => {
    const { conn, graphCalls } = connection((url) => {
      if (url.pathname.endsWith('/replies'))
        return Response.json({ value: [message(1700000000400), message(1700000000300), message(1700000000200)] })
      return Response.json(message(1700000000100))
    })
    seen(conn, DESIGN, 'channel')
    const bounded = await conn.getThreadReplies(DESIGN, '1700000000100', 10, {
      oldest: '1700000000200',
      latest: '1700000000400'
    })
    expect(bounded.map((m) => m.ts)).toEqual(['1700000000100', '1700000000300'])
    const before = graphCalls().length
    expect((await conn.getThreadReplies(DESIGN, '1700000000100', 1)).map((m) => m.ts)).toEqual(['1700000000100'])
    expect(graphCalls()).toHaveLength(before + 1)
  })

  it('reads on past an old reply edited after the oldest bound', async () => {
    const { conn } = connection((url) => {
      if (url.pathname.endsWith('/replies')) {
        const second = url.searchParams.get('$skiptoken') === 'older'
        return Response.json(
          second
            ? { value: [message(1700000000300), message(1700000000150)] }
            : {
                value: [message(1700000000110, { lastModifiedDateTime: new Date(1700000000500).toISOString() })],
                '@odata.nextLink': 'https://graph.microsoft.com/v1.0/x?$skiptoken=older'
              }
        )
      }
      return Response.json(message(1700000000100))
    })
    seen(conn, DESIGN, 'channel')
    const thread = await conn.getThreadReplies(DESIGN, '1700000000100', 10, { oldest: '1700000000200' })
    expect(thread.map((m) => m.ts)).toEqual(['1700000000100', '1700000000300'])
  })

  it('answers a failed best-effort thread read empty, and a strict one with its reason', async () => {
    const { conn } = connection(() => undefined)
    seen(conn, DESIGN, 'channel')
    expect(await conn.getThreadReplies(DESIGN, '1700000000100')).toEqual([])
    await expect(conn.getThreadReplies(DESIGN, '1700000000100', 10, { throwOnError: true })).rejects.toMatchObject({
      kind: 'not_found'
    })
    await expect(conn.getThreadReplies(DESIGN, 'msteams:1', 10, { throwOnError: true })).rejects.toThrow(/root/)
  })
})

describe('msTeamsHtmlText', () => {
  it('turns a message body into plain text', () => {
    expect(
      msTeamsHtmlText(
        '<p>Hi <at id="0">Example Bot</at>,</p><p>see&nbsp;&lt;this&gt; &amp; &#x1F600;</p><ul><li>one</li><li>two</li></ul><attachment id="1"></attachment>'
      )
    ).toBe('Hi Example Bot,\nsee <this> & 😀\n- one\n- two')
  })
})
