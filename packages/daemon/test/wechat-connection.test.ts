import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { WeChatInboundMessage } from '@agentconnect.md/message'
import { parseWeChatJson, weChatClientVersion, WeChatApi, WeChatApiError } from '../src/platforms/wechat/api.js'
import {
  consolidateWeChat,
  WECHAT_SEND_STOPPED,
  WeChatConnection,
  type WeChatConnectionGroup
} from '../src/platforms/wechat/connection.js'
import { WECHAT_STALE_RETRY_MS, WeChatPoller } from '../src/platforms/wechat/poller.js'
import { resolveWeChatPartial, WECHAT_QUOTE_UNAVAILABLE } from '../src/platforms/wechat/quote.js'
import { memoryWeChatState } from '../src/platforms/wechat/state.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import type { LoadedAgent } from '../src/agents/load-agents.js'
import { API, CDN, encryptMedia, fakeIlink, type PollStep } from './fakes/ilink-server.js'

const BOT = '0123456789abcdef0123456789abcdef@im.bot'
const USER = 'o9cq800000example0000000000000@im.wechat'
const TOKEN = 'bot-token-placeholder'

const group: WeChatConnectionGroup = {
  botId: BOT,
  botToken: TOKEN,
  boundUserId: USER,
  apiUrl: API,
  cdnUrl: CDN,
  integrations: [{ agentId: 'agent', integrationId: 'integration' }]
}

function inbound(id: string, text: string, extra: Partial<WeChatInboundMessage> = {}): WeChatInboundMessage {
  return {
    message_id: id,
    from_user_id: USER,
    to_user_id: BOT,
    message_type: 1,
    message_state: 2,
    session_id: '',
    group_id: '',
    item_list: [{ type: 1, text_item: { text } }],
    context_token: `context-${id}`,
    ...extra
  }
}

function setup(opts: Parameters<typeof fakeIlink>[0] = {}) {
  const ilink = fakeIlink(opts)
  const state = memoryWeChatState()
  const messages: NormalizedMessage[] = []
  const warnings: string[] = []
  const sleeps: number[] = []
  const log = {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: (m: string) => void warnings.push(m),
    error: () => {}
  }
  const onTokenRejected = vi.fn()
  const conn = new WeChatConnection(group, {
    onMessage: (msg) => void messages.push(msg),
    onTokenRejected,
    state,
    log,
    fetchImpl: ilink.fetchImpl,
    version: '1.2.3',
    sleep: async (ms) => void sleeps.push(ms)
  })
  return { ilink, state, messages, warnings, sleeps, onTokenRejected, conn }
}

async function pollThrough(steps: PollStep[]) {
  const ctx = setup({ polls: steps })
  const drained = ctx.ilink.drained()
  await ctx.conn.start()
  await drained
  await ctx.conn.settled()
  return ctx
}

describe('the iLink client', () => {
  it('sends the plugin-shaped headers, a fresh uin and our own bot agent in base_info', async () => {
    const ilink = fakeIlink()
    const api = new WeChatApi({ botToken: TOKEN, apiUrl: API }, { fetchImpl: ilink.fetchImpl, version: '1.2.3' })
    await api.sendText(USER, 'client-1', 'hi')
    await api.sendText(USER, 'client-2', 'hi')
    const [first, second] = ilink.calls
    expect(first!.headers).toMatchObject({
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      Authorization: `Bearer ${TOKEN}`,
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': String((1 << 16) | (2 << 8) | 3)
    })
    expect(Buffer.from(first!.headers['X-WECHAT-UIN']!, 'base64').toString()).toMatch(/^\d+$/)
    expect(first!.headers['X-WECHAT-UIN']).not.toBe(second!.headers['X-WECHAT-UIN'])
    expect(first!.body.base_info).toEqual({ channel_version: '1.2.3', bot_agent: 'AgentConnect/1.2.3' })
    expect(weChatClientVersion('0.0.0-dev')).toBe('0')
  })

  it('keeps every digit of an id past 2^53 and leaves safe numbers alone', () => {
    expect(parseWeChatJson('{"message_id":7254917391048562001,"ret":0,"n":12}')).toEqual({
      message_id: '7254917391048562001',
      ret: 0,
      n: 12
    })
  })

  it('reads a refusal from ret or errcode and names -14 as a stale token', async () => {
    const ilink = fakeIlink({ sends: [{ ret: -14 }] })
    const api = new WeChatApi({ botToken: TOKEN, apiUrl: API }, { fetchImpl: ilink.fetchImpl })
    const error = await api.sendText(USER, 'client-1', 'hi').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(WeChatApiError)
    expect((error as WeChatApiError).staleToken).toBe(true)
  })
})

describe('the long poll', () => {
  it('delivers messages, saves the cursor only when the server sends one, and sends notifystart first', async () => {
    const { ilink, state, messages, conn } = await pollThrough([
      { msgs: [inbound('7254917391048562001', 'first')], get_updates_buf: 'cursor-1' },
      { msgs: [], get_updates_buf: '' },
      { msgs: [inbound('7254917391048562002', 'second')], get_updates_buf: 'cursor-2' }
    ])
    expect(ilink.calls[0]!.path).toBe('ilink/bot/msg/notifystart')
    expect(ilink.pollCalls().map((call) => call.body.get_updates_buf)).toEqual(['', 'cursor-1', 'cursor-1', 'cursor-2'])
    expect(messages.map((msg) => msg.text)).toEqual(['first', 'second'])
    expect(messages[0]!.msgId).toBe(`wechat:${BOT}:7254917391048562001`)
    expect(state.rows.get(BOT)?.cursor).toBe('cursor-2')
    await conn.stop()
    expect(ilink.calls.at(-1)!.path).toBe('ilink/bot/msg/notifystop')
  })

  it('resumes from the stored cursor after a restart', async () => {
    const ctx = setup({ polls: [] })
    await ctx.state.saveCursor(BOT, 'stored-cursor')
    const drained = ctx.ilink.drained()
    await ctx.conn.start()
    await drained
    expect(ctx.ilink.pollCalls()[0]!.body.get_updates_buf).toBe('stored-cursor')
    await ctx.conn.stop()
  })

  it('drops a message id it already delivered', async () => {
    const { messages, conn } = await pollThrough([
      { msgs: [inbound('101', 'once'), inbound('101', 'once')], get_updates_buf: 'c1' },
      { msgs: [inbound('101', 'once')], get_updates_buf: 'c2' }
    ])
    expect(messages.map((msg) => msg.text)).toEqual(['once'])
    await conn.stop()
  })

  it('backs off with jitter from one second, doubling to a minute, and resets on success', async () => {
    const failures: PollStep[] = Array.from({ length: 8 }, () => ({ throws: 'network' as const }))
    const { sleeps, conn } = await pollThrough([...failures, { status: 502 }, { msgs: [] }, { throws: 'network' }])
    const caps = [1, 2, 4, 8, 16, 32, 60, 60, 60].map((s) => s * 1000)
    expect(sleeps.slice(0, 9).every((ms, i) => ms >= caps[i]! / 2 && ms <= caps[i]!)).toBe(true)
    expect(sleeps[9]).toBeLessThanOrEqual(1000)
    await conn.stop()
  })

  it('stops on -14, reports it once, and retries hourly until the token works again', async () => {
    const { onTokenRejected, sleeps, messages, warnings, conn } = await pollThrough([
      { ret: -14 },
      { ret: -14 },
      { msgs: [inbound('201', 'back')], get_updates_buf: 'c1' }
    ])
    expect(onTokenRejected).toHaveBeenCalledTimes(1)
    expect(sleeps).toEqual([WECHAT_STALE_RETRY_MS, WECHAT_STALE_RETRY_MS])
    expect(messages.map((msg) => msg.text)).toEqual(['back'])
    expect(warnings.join('\n')).not.toContain(TOKEN)
    await conn.stop()
  })

  it('stops polling the moment it is stopped, so a lost duty leaves no second poller', async () => {
    const { ilink, conn } = await pollThrough([{ msgs: [], get_updates_buf: 'c1' }])
    const before = ilink.pollCalls().length
    await conn.stop()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(ilink.pollCalls().length).toBe(before)
  })
})

describe('the connection', () => {
  it('drops a sender the bot is not bound to and logs it once', async () => {
    const { messages, warnings, conn } = await pollThrough([
      {
        msgs: [
          inbound('301', 'intruder', { from_user_id: 'someone-else@im.wechat' }),
          inbound('302', 'intruder', { from_user_id: 'someone-else@im.wechat' }),
          inbound('303', 'mine')
        ]
      }
    ])
    expect(messages.map((msg) => msg.text)).toEqual(['mine'])
    expect(warnings.filter((w) => w.includes('not bound'))).toHaveLength(1)
    await conn.stop()
  })

  it('keeps the latest reply token, stores it, and attaches it to every send with a fresh client id', async () => {
    const { ilink, state, conn } = await pollThrough([
      { msgs: [inbound('401', 'one'), inbound('402', 'two')], get_updates_buf: 'c1' }
    ])
    expect(state.rows.get(BOT)?.contextToken).toBe('context-402')
    const parts = await conn.sendText(`dm:${USER}`, 'first paragraph\n\nsecond paragraph')
    expect(parts).toEqual([{ text: 'first paragraph\n\nsecond paragraph', messageId: '7254917391048562001' }])
    await conn.sendText(`dm:${USER}`, 'again')
    const sends = ilink.sendCalls().map((call) => call.body.msg as Record<string, unknown>)
    expect(sends.map((msg) => msg.context_token)).toEqual(['context-402', 'context-402'])
    expect(sends[0]).toMatchObject({ to_user_id: USER, message_type: 2, message_state: 2 })
    expect(new Set(sends.map((msg) => msg.client_id)).size).toBe(2)
    await conn.stop()
  })

  it('uses a stored reply token after a restart', async () => {
    const ctx = setup()
    await ctx.state.saveContextToken(BOT, 'stored-token')
    await ctx.conn.start()
    await ctx.conn.sendText(`dm:${USER}`, 'hi')
    expect((ctx.ilink.sendCalls()[0]!.body.msg as Record<string, unknown>).context_token).toBe('stored-token')
    await ctx.conn.stop()
  })

  it('sends a long answer as several messages in order, one at a time', async () => {
    const { ilink, conn } = setup()
    const long = Array.from({ length: 5 }, (_, i) => `${i}`.repeat(900)).join('\n\n')
    const [a, b] = await Promise.all([conn.sendText(`dm:${USER}`, long), conn.sendText(`dm:${USER}`, 'after')])
    expect(a.map((part) => part.text[0])).toEqual(['0', '2', '4'])
    expect(b.map((part) => part.text)).toEqual(['after'])
    const texts = ilink.sendCalls().map((call) => {
      const items = (call.body.msg as { item_list: { text_item: { text: string } }[] }).item_list
      return items[0]!.text_item.text
    })
    expect(texts.map((text) => text[0])).toEqual(['0', '2', '4', 'a'])
    expect(texts.every((text) => text.length <= 2000)).toBe(true)
  })

  it('never resends a timed-out message and leaves the rest of the answer unsent', async () => {
    const { ilink, conn, warnings } = setup({ sends: ['ok', 'timeout'] })
    const long = ['a', 'b', 'c'].map((c) => c.repeat(1500)).join('\n\n')
    const parts = await conn.sendText(`dm:${USER}`, long)
    expect(ilink.sendCalls()).toHaveLength(2)
    expect(parts.map((part) => [part.text[0], part.error === undefined])).toEqual([
      ['a', true],
      ['b', false],
      ['c', false]
    ])
    expect(warnings.some((w) => w.includes('not resent'))).toBe(true)
  })

  it('reports a stale token a send meets, and refuses any chat but the bound one', async () => {
    const { ilink, conn, onTokenRejected } = setup({ sends: [{ ret: -14 }] })
    expect((await conn.sendText(`dm:${USER}`, 'hi'))[0]!.error).toBeInstanceOf(WeChatApiError)
    expect(onTokenRejected).toHaveBeenCalledTimes(1)
    const elsewhere = await conn.sendText('dm:someone-else@im.wechat', 'hi')
    expect(elsewhere[0]!.error).toBeInstanceOf(Error)
    expect(ilink.sendCalls()).toHaveLength(1)
  })

  it('downloads and decrypts only media it received, with the key kept out of the message and the logs', async () => {
    const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
    const plain = Buffer.from('%PDF-1.7 example')
    const media = new Map([[`${CDN}/download?encrypted_query_param=file-ref`, encryptMedia(plain, key)]])
    const ctx = setup({ media, polls: [] })
    const aesKey = Buffer.from(key.toString('hex')).toString('base64')
    const msg = ctx.conn.normalize({
      ...inbound('501', 'see attached'),
      item_list: [
        { type: 4, file_item: { media: { encrypt_query_param: 'file-ref', aes_key: aesKey }, file_name: 'a.pdf' } }
      ]
    })!
    expect(JSON.stringify(msg)).not.toContain(aesKey)
    const [attachment] = msg.attachments!
    expect(attachment).toMatchObject({ sourceUrl: 'wechat-media:501:0', readerToolName: 'readWeChatFile' })
    expect(await ctx.conn.downloadFile(attachment!.sourceUrl!)).toEqual(plain)
    expect(await ctx.conn.downloadFile(`${CDN}/download?encrypted_query_param=file-ref`)).toBeNull()
    expect(await ctx.conn.downloadFile('wechat-media:999:0')).toBeNull()
    expect(ctx.warnings.join('\n')).not.toMatch(new RegExp(`${aesKey}|file-ref`))
  })
})

describe('durability and stops', () => {
  it('stores a batch cursor only after every message of the batch is handed on', async () => {
    const state = memoryWeChatState()
    let release!: () => void
    const handed = new Promise<void>((resolve) => (release = resolve))
    let calls = 0
    const api = {
      notify: async () => undefined,
      getUpdates: vi.fn(async (_cursor: string, _hold?: number, signal?: AbortSignal) => {
        if (++calls === 1) return { msgs: [inbound('901', 'x')], cursor: 'c-901' }
        return await new Promise<never>((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        )
      })
    }
    const log = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }
    const poller = new WeChatPoller({ api, state, botId: BOT, onMessage: () => handed, onStaleToken: () => {}, log })
    await poller.start()
    await vi.waitFor(() => expect(api.getUpdates).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(state.rows.get(BOT)?.cursor).toBeUndefined()
    release()
    await vi.waitFor(() => expect(state.rows.get(BOT)?.cursor).toBe('c-901'))
    await poller.stop()
  })

  it('leaves the rest of an answer unsent once its turn is stopped', async () => {
    const ctx = setup()
    const text = `${'a'.repeat(1500)}\n\n${'b'.repeat(1500)}`
    const parts = await ctx.conn.sendText(`dm:${USER}`, text, { stopped: () => ctx.ilink.sendCalls().length >= 1 })
    expect(ctx.ilink.sendCalls()).toHaveLength(1)
    expect(parts[0]).toMatchObject({ text: 'a'.repeat(1500) })
    expect(parts[1]).toEqual({ text: 'b'.repeat(1500), error: WECHAT_SEND_STOPPED })
  })
})

describe('quotes that name a message by id', () => {
  const quoting = (id: string, ref: Record<string, unknown>, text = 'explain this') =>
    inbound(id, text, { item_list: [{ type: 1, text_item: { text }, ref_msg: ref }] })

  it('resolves a quote of an earlier message in the same batch, in order', async () => {
    const { messages, conn } = await pollThrough([
      { msgs: [inbound('501', 'the original question'), quoting('502', { svr_id: '501' })] }
    ])
    expect(messages.map((msg) => msg.text)).toEqual(['the original question', 'explain this'])
    expect(messages[1]!.quoted).toEqual({ text: 'the original question', messageId: '501' })
    await conn.stop()
  })

  it('resolves a quote of the bot’s own reply by the id its send returned, and a selection within it', async () => {
    const selection = 'second sentence'
    const ctx = setup({
      polls: [
        {
          msgs: [
            quoting('601', { svr_id: '7254917391048562001' }),
            quoting('602', {
              svr_id: '7254917391048562001',
              partial_text: {
                start: 'second',
                end: 'sentence',
                startindex: 0,
                endindex: 1,
                quotemd5: createHash('md5').update(selection).digest('hex')
              }
            })
          ]
        }
      ]
    })
    const reply = 'First sentence. And the second sentence.'
    expect(await ctx.conn.sendText(`dm:${USER}`, reply)).toEqual([{ text: reply, messageId: '7254917391048562001' }])
    const drained = ctx.ilink.drained()
    await ctx.conn.start()
    await drained
    await ctx.conn.settled()
    expect(ctx.messages[0]!.quoted).toEqual({ text: reply, messageId: '7254917391048562001' })
    expect(ctx.messages[1]!.quoted).toEqual({ text: selection, messageId: '7254917391048562001', selection: true })
    await ctx.conn.stop()
  })

  it('says a quoted message aged out instead of guessing at it', async () => {
    const { messages, conn } = await pollThrough([{ msgs: [quoting('701', { svr_id: '9007199254740993123' })] }])
    expect(messages[0]!.quoted).toEqual({ text: WECHAT_QUOTE_UNAVAILABLE, messageId: '9007199254740993123' })
    await conn.stop()
  })
})

describe('partial quote selection', () => {
  const md5 = (s: string) => createHash('md5').update(s).digest('hex')

  it('counts the end edge from the top of the text or from the start match, whichever the MD5 confirms', () => {
    expect(
      resolveWeChatPartial('abcedfabcgh', { start: 'a', end: 'c', startindex: 1, endindex: 1, quotemd5: md5('abc') })
    ).toBe('abc')
    // Here only the count from the start match reaches an end after the start.
    expect(
      resolveWeChatPartial('cd ab cd', { start: 'ab', end: 'cd', startindex: 0, endindex: 0, quotemd5: md5('ab cd') })
    ).toBe('ab cd')
  })

  it('takes the first reading without an MD5 and nothing when the MD5 or the edges do not match', () => {
    expect(resolveWeChatPartial('one two three', { start: 'one', end: 'two', startindex: 0, endindex: 0 })).toBe(
      'one two'
    )
    expect(
      resolveWeChatPartial('one two three', {
        start: 'one',
        end: 'two',
        startindex: 0,
        endindex: 0,
        quotemd5: md5('nope')
      })
    ).toBeUndefined()
    expect(
      resolveWeChatPartial('one two three', { start: 'four', end: 'two', startindex: 0, endindex: 0 })
    ).toBeUndefined()
  })
})

describe('consolidation', () => {
  it('opens one connection per bot and lets the deployment override its endpoints', () => {
    const integration = (id: string) => ({
      id,
      platform: 'wechat',
      config: { botId: BOT, botToken: TOKEN, boundUserId: USER }
    })
    const agents = [
      { id: 'a', integrations: [integration('i1')] },
      { id: 'b', integrations: [integration('i2'), { id: 'bad', platform: 'wechat', config: { botId: BOT } }] }
    ] as unknown as LoadedAgent[]
    const groups = [...consolidateWeChat(agents, { apiUrl: API }).values()]
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      botId: BOT,
      apiUrl: API,
      integrations: [{ integrationId: 'i1' }, { integrationId: 'i2' }]
    })
    expect(groups[0]!.cdnUrl).toBeUndefined()
  })
})
