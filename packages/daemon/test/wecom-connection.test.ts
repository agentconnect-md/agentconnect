import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WeComInboundMessage } from '@agentconnect.md/message'
import {
  WECOM_KICK_COOLDOWN_BASE_MS,
  WECOM_KICK_COOLDOWN_MAX_MS,
  WECOM_MARKDOWN_MAX_BYTES,
  WeComConnection,
  consolidateWeCom,
  weComConnKey,
  weComSendTarget
} from '../src/platforms/wecom/connection.js'
import { WeComRequestError } from '../src/platforms/wecom/client.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import type { LoadedAgent } from '../src/agents/load-agents.js'
import { FakeWeComServer, quietLog } from './fakes/wecom-server.js'

const BOT = 'aibot-example'
const SECRET = 'secret-placeholder'
const GROUP = 'chat-example-group'
const USER = 'user-alice'

const dmText: WeComInboundMessage = {
  msgid: 'msg-dm-0001',
  aibotid: BOT,
  chattype: 'single',
  from: { userid: USER },
  create_time: 1700000000,
  msgtype: 'text',
  text: { content: 'hello' }
}

const groupMention: WeComInboundMessage = {
  msgid: 'msg-group-0001',
  aibotid: BOT,
  chatid: GROUP,
  chattype: 'group',
  from: { userid: USER },
  msgtype: 'text',
  text: { content: '@Example Bot summarize please' }
}

const dmImage: WeComInboundMessage = {
  msgid: 'msg-dm-0002',
  aibotid: BOT,
  chattype: 'single',
  from: { userid: USER },
  msgtype: 'mixed',
  mixed: {
    msg_item: [
      { msgtype: 'text', text: { content: 'what is in this picture?' } },
      { msgtype: 'image', image: { url: 'https://media.example.test/image-1', aeskey: 'aes-key-placeholder' } }
    ]
  }
}

const connections: WeComConnection[] = []
afterEach(async () => {
  for (const conn of connections.splice(0)) await conn.stop()
  vi.useRealTimers()
})

function setup(opts: { now?: () => number; log?: typeof quietLog; fetchImpl?: typeof fetch } = {}) {
  const server = new FakeWeComServer()
  const messages: NormalizedMessage[] = []
  const kicks: number[] = []
  const conn = new WeComConnection(
    { botId: BOT, secret: SECRET, integrations: [{ agentId: 'agent', integrationId: 'int-wecom' }] },
    {
      onMessage: (msg) => messages.push(msg),
      onKicked: (at) => kicks.push(at),
      log: opts.log ?? quietLog,
      createSocket: server.createSocket,
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {})
    }
  )
  connections.push(conn)
  return { server, conn, messages, kicks }
}

describe('WeCom connection', () => {
  it('keys one connection per BotID and Secret, so a changed Secret is a new connection', () => {
    const agent = (id: string, config: object) =>
      ({ id, integrations: [{ id: `int-${id}`, platform: 'wecom', config }] }) as unknown as LoadedAgent
    const groups = consolidateWeCom([
      agent('a', { botId: BOT, secret: SECRET }),
      agent('b', { botId: BOT, secret: SECRET }),
      agent('c', { botId: BOT, secret: 'secret-placeholder-2' }),
      agent('d', { botId: BOT })
    ])
    expect([...groups.values()].map((g) => g.integrations.map((i) => i.agentId))).toEqual([['a', 'b'], ['c']])
    expect(weComConnKey({ botId: BOT, secret: SECRET })).not.toBe(
      weComConnKey({ botId: BOT, secret: 'secret-placeholder-2' })
    )
    expect(weComConnKey({ botId: BOT, secret: SECRET })).not.toContain(SECRET)
  })

  it('hands each message on once, however often WeCom delivers it', async () => {
    const { server, conn, messages } = setup()
    await conn.start()
    server.last.message('req-1', dmText as Record<string, unknown>)
    server.last.message('req-2', dmText as Record<string, unknown>)
    server.last.message('req-3', groupMention as Record<string, unknown>)
    expect(messages.map((m) => [m.msgId, m.channel, m.isDm])).toEqual([
      [`wecom:${BOT}:msg-dm-0001`, `dm:${USER}`, true],
      [`wecom:${BOT}:msg-group-0001`, GROUP, false]
    ])
    expect(messages[1]!.mentionedBots).toEqual([BOT])
    expect(await conn.getChannelInfo(GROUP)).toMatchObject({ isIm: false })
    expect(await conn.getChannelInfo(`dm:${USER}`)).toMatchObject({ isIm: true })
    expect(await conn.listMembers(GROUP)).toEqual([{ id: USER, isBot: false }])
  })

  it('drops a message for another bot, and ignores events it does not serve yet', async () => {
    const { server, conn, messages } = setup()
    await conn.start()
    server.last.message('req-1', { ...dmText, aibotid: 'aibot-other' } as Record<string, unknown>)
    server.last.event('req-2', 'enter_chat')
    server.last.event('req-3', 'feedback_event')
    server.last.event('req-4', 'some_future_event')
    expect(messages).toEqual([])
    expect(conn.connected).toBe(true)
  })

  it('delivers a message with an attachment by its text whose download failed, never logging its material', async () => {
    const lines: string[] = []
    const log = { ...quietLog, warn: (line: string) => lines.push(line), info: (line: string) => lines.push(line) }
    const fetchImpl = vi.fn(async () => new Response('gone', { status: 404 })) as unknown as typeof fetch
    const { server, conn, messages } = setup({ log, fetchImpl })
    await conn.start()
    server.last.message('req-1', dmImage as Record<string, unknown>)
    await vi.waitFor(() => expect(messages).toHaveLength(1))
    const [msg] = messages
    expect(msg!.text).toBe('what is in this picture?')
    expect(msg!.attachments).toHaveLength(1)
    const ref = msg!.attachments![0]!.sourceUrl!
    expect(msg!.attachments![0]).toMatchObject({ readerToolName: 'readWeComFile' })
    expect(msg!.attachments![0]!.unavailableText).toMatch(/unavailable/)
    expect(JSON.stringify(msg)).not.toContain('aes-key-placeholder')
    expect(await conn.downloadFile(ref)).toBeNull()
    expect(lines.join('\n')).not.toMatch(/media\.example\.test|aes-key-placeholder|picture/)
  })

  it('lets a turn claim a callback once, inside the reply window', async () => {
    let now = 1_000_000
    const { server, conn } = setup({ now: () => now })
    await conn.start()
    server.last.message('req-1', dmText as Record<string, unknown>)
    server.last.message('req-2', groupMention as Record<string, unknown>)
    expect(conn.claimReply(`wecom:${BOT}:msg-dm-0001`)).toEqual({
      reqId: 'req-1',
      generation: 1,
      channel: `dm:${USER}`,
      receivedAt: 1_000_000
    })
    expect(conn.claimReply(`wecom:${BOT}:msg-dm-0001`)).toBeUndefined()
    now += 24 * 60 * 60_000
    expect(conn.claimReply(`wecom:${BOT}:msg-group-0001`)).toBeUndefined()
    expect(conn.claimReply('cron:example')).toBeUndefined()
  })

  it('stays down after a kick and doubles its redial cooldown up to the cap', async () => {
    let now = 0
    const { server, conn, kicks } = setup({ now: () => now })
    await conn.start()
    server.last.kick()
    expect(kicks).toEqual([WECOM_KICK_COOLDOWN_BASE_MS])
    expect(conn.redialDueAt()).toBe(WECOM_KICK_COOLDOWN_BASE_MS)
    // Before the cooldown a redial does nothing.
    await conn.redial()
    expect(server.sockets).toHaveLength(1)
    now = WECOM_KICK_COOLDOWN_BASE_MS
    await conn.redial()
    expect(server.sockets).toHaveLength(2)
    expect(conn.connected).toBe(true)
    expect(conn.redialDueAt()).toBeUndefined()
    server.last.kick()
    expect(kicks.at(-1)! - now).toBe(2 * WECOM_KICK_COOLDOWN_BASE_MS)
    for (let i = 0; i < 8; i++) {
      now = conn.redialDueAt()!
      await conn.redial()
      server.last.kick()
    }
    expect(kicks.at(-1)! - now).toBe(WECOM_KICK_COOLDOWN_MAX_MS)
  })

  it('counts a failed redial as another kick for the backoff', async () => {
    let now = 0
    const { server, conn, kicks } = setup({ now: () => now })
    await conn.start()
    server.last.kick()
    now = conn.redialDueAt()!
    server.answers.set('aibot_subscribe', 846601)
    await conn.redial()
    expect(conn.connected).toBe(false)
    expect(kicks.at(-1)! - now).toBe(2 * WECOM_KICK_COOLDOWN_BASE_MS)
    expect(conn.redialDueAt()).toBe(kicks.at(-1))
  })

  it('addresses a proactive send by userid in a direct chat and by chatid in a group', async () => {
    expect(weComSendTarget(`dm:${USER}`)).toEqual({ chatid: USER, chat_type: 1 })
    expect(weComSendTarget(GROUP)).toEqual({ chatid: GROUP, chat_type: 2 })
    const { server, conn } = setup()
    await conn.start()
    expect(await conn.sendText(GROUP, '**done**')).toBe(true)
    expect(server.last.frames('aibot_send_msg')[0]!.body).toEqual({
      chatid: GROUP,
      chat_type: 2,
      msgtype: 'markdown',
      markdown: { content: '**done**' }
    })
  })

  it('splits a long proactive answer within the byte cap and leaves the rest unsent after a refusal', async () => {
    const { server, conn } = setup()
    await conn.start()
    const paragraph = `${'界'.repeat(3000)}\n\n`
    const text = paragraph.repeat(6)
    server.answers.set('aibot_send_msg', 'silent')
    const pending = conn.sendMarkdown(`dm:${USER}`, text)
    await vi.waitFor(() => expect(server.last.frames('aibot_send_msg')).toHaveLength(1))
    const first = server.last.frames('aibot_send_msg')[0]!
    const content = (first.body!.markdown as { content: string }).content
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(WECOM_MARKDOWN_MAX_BYTES)
    server.last.reply({ headers: { req_id: first.headers.req_id }, errcode: 0, errmsg: 'ok' })
    await vi.waitFor(() => expect(server.last.frames('aibot_send_msg')).toHaveLength(2))
    const second = server.last.frames('aibot_send_msg')[1]!
    server.last.reply({ headers: { req_id: second.headers.req_id }, errcode: 45009, errmsg: 'api freq out of limit' })
    const parts = await pending
    expect(parts.length).toBeGreaterThan(2)
    expect(parts[0]!.error).toBeUndefined()
    expect(parts[1]!.error).toBeInstanceOf(WeComRequestError)
    expect(parts.slice(2).every((part) => part.error === parts[1]!.error)).toBe(true)
    expect(server.last.frames('aibot_send_msg')).toHaveLength(2)
  })
})
