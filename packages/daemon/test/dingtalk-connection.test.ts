import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DingTalkRobotMessage } from '@agentconnect.md/message'
import { DingTalkConnection } from '../src/platforms/dingtalk/connection.js'
import { DINGTALK_MSG_PARAM_MAX_BYTES, splitForMsgParam } from '../src/platforms/dingtalk/api.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { fakeSocketFactory } from './fakes/dingtalk-socket.js'

const log = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const ORIGIN = 'https://api.example.test'
const CLIENT_ID = 'client-id-example'

const groupMention: DingTalkRobotMessage = {
  msgId: 'msg-0001',
  createAt: 1767225600000,
  conversationId: 'cid-example-group',
  conversationType: '2',
  conversationTitle: 'Example Group',
  senderStaffId: 'user-0001',
  senderId: 'sender-0001',
  senderNick: 'Example User',
  chatbotUserId: 'bot-example',
  robotCode: CLIENT_ID,
  isInAtList: true,
  msgtype: 'text',
  text: { content: ' summarize please ' }
}

interface Call {
  path: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

function fakeFetch(opts: { failSendAfter?: number } = {}) {
  const calls: Call[] = []
  let sends = 0
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).slice(ORIGIN.length)
    calls.push({
      path,
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>
    })
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (path === '/v1.0/oauth2/accessToken') return json(200, { accessToken: 'token-1', expireIn: 7200 })
    if (path === '/v1.0/gateway/connections/open')
      return json(200, { endpoint: 'wss://stream.example.test/connect', ticket: 'ticket-1' })
    sends++
    if (opts.failSendAfter !== undefined && sends > opts.failSendAfter)
      return json(403, { code: 'Forbidden.AccessDenied.ApiCountLimitForOrg', message: 'quota' })
    return json(200, { processQueryKey: `pqk-${sends}` })
  })
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch }
}

const connections: DingTalkConnection[] = []
afterEach(async () => {
  for (const conn of connections.splice(0)) await conn.stop()
})

function connect(fetchImpl: typeof fetch, onMessage: (msg: NormalizedMessage) => void = () => {}) {
  const sockets = fakeSocketFactory()
  const conn = new DingTalkConnection(
    { clientId: CLIENT_ID, clientSecret: 'client-secret-example', integrations: [] },
    { log, onMessage, fetchImpl, origin: ORIGIN, createSocket: (url) => sockets.createSocket(url) }
  )
  connections.push(conn)
  return { conn, sockets: sockets.sockets }
}

describe('DingTalk connection', () => {
  it('opens the Stream with the app credentials and hands each robot message to the inbound path once', async () => {
    const { calls, fetchImpl } = fakeFetch()
    const inbound: NormalizedMessage[] = []
    const { conn, sockets } = connect(fetchImpl, (msg) => inbound.push(msg))
    await conn.start()
    expect(calls[0]).toMatchObject({
      path: '/v1.0/gateway/connections/open',
      body: {
        clientId: CLIENT_ID,
        clientSecret: 'client-secret-example',
        subscriptions: [{ type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' }]
      }
    })

    sockets[0]!.callback('cb-1', groupMention)
    // A second socket of the same daemon can deliver the same message during a handover.
    sockets[0]!.callback('cb-2', groupMention)
    sockets[0]!.callback('cb-3', { ...groupMention, robotCode: 'another-robot', msgId: 'msg-0002' })

    expect(inbound).toHaveLength(1)
    expect(inbound[0]).toMatchObject({
      msgId: 'dingtalk:cid-example-group:msg-0001',
      platform: 'dingtalk',
      channel: 'cid-example-group',
      text: 'summarize please',
      mentionedBots: [CLIENT_ID],
      isDm: false
    })
    expect(conn.botUserId).toBe(CLIENT_ID)
    expect(await conn.getChannelInfo('cid-example-group')).toEqual({
      id: 'cid-example-group',
      name: 'Example Group',
      isIm: false,
      isPrivate: true
    })
    expect(await conn.listMembers('cid-example-group')).toEqual([
      { id: 'user-0001', name: 'Example User', isBot: false }
    ])
    expect(await conn.getUserProfile('user-0001')).toEqual({ id: 'user-0001', name: 'Example User' })
    expect(await conn.listChannels()).toEqual([{ id: 'cid-example-group', name: 'Example Group', isPrivate: true }])
  })

  it('sends to a group by its conversation and to a DM by the staff id, with one cached token', async () => {
    const { calls, fetchImpl } = fakeFetch()
    const { conn } = connect(fetchImpl)
    expect(await conn.sendMarkdown('cid-example-group', '# Done\n\nAll good.')).toEqual([
      { text: '# Done\n\nAll good.', processQueryKey: 'pqk-1' }
    ])
    expect(await conn.sendText('dm:user-0001', 'Stopped.')).toBe('pqk-2')

    expect(calls.map((call) => call.path)).toEqual([
      '/v1.0/oauth2/accessToken',
      '/v1.0/robot/groupMessages/send',
      '/v1.0/robot/oToMessages/batchSend'
    ])
    expect(calls[0]!.body).toEqual({ appKey: CLIENT_ID, appSecret: 'client-secret-example' })
    expect(calls[1]!.headers['x-acs-dingtalk-access-token']).toBe('token-1')
    expect(calls[1]!.body).toEqual({
      robotCode: CLIENT_ID,
      openConversationId: 'cid-example-group',
      msgKey: 'sampleMarkdown',
      msgParam: JSON.stringify({ title: 'Done', text: '# Done\n\nAll good.' })
    })
    expect(calls[2]!.body).toEqual({
      robotCode: CLIENT_ID,
      userIds: ['user-0001'],
      msgKey: 'sampleText',
      msgParam: JSON.stringify({ content: 'Stopped.' })
    })
  })

  it('splits a long reply under the msgParam byte limit and returns each part with its own key', async () => {
    const { calls, fetchImpl } = fakeFetch()
    const { conn } = connect(fetchImpl)
    // Multi-byte text with quotes and newlines, which JSON escaping grows.
    const paragraph = `${'数据 "quoted" \\ line\n'.repeat(40)}\n`
    const text = paragraph.repeat(30)
    const parts = await conn.sendMarkdown('cid-example-group', text, { suffix: 'hint line' })

    expect(parts.length).toBeGreaterThan(1)
    expect(parts.map((part) => part.processQueryKey)).toEqual(parts.map((_, index) => `pqk-${index + 1}`))
    const sent = calls.filter((call) => call.path === '/v1.0/robot/groupMessages/send')
    for (const call of sent)
      expect(Buffer.byteLength(String(call.body.msgParam), 'utf8')).toBeLessThanOrEqual(DINGTALK_MSG_PARAM_MAX_BYTES)
    const bodies = sent.map((call) => (JSON.parse(String(call.body.msgParam)) as { text: string }).text)
    expect(bodies.at(-1)!.endsWith('\n\nhint line')).toBe(true)
    expect(bodies.slice(0, -1).some((body) => body.includes('hint line'))).toBe(false)
    // The returned text never carries the hint, and together the parts keep every line.
    expect(parts.map((part) => part.text).join('\n\n')).toBe(text.trimEnd())
  })

  it('stops a split reply at the first failed part and reports the rest unsent', async () => {
    const { fetchImpl } = fakeFetch({ failSendAfter: 1 })
    const { conn } = connect(fetchImpl)
    const text = `${'x'.repeat(9000)}\n\n${'y'.repeat(9000)}\n\n${'z'.repeat(9000)}`
    const parts = await conn.sendMarkdown('cid-example-group', text)
    expect(parts.map((part) => part.processQueryKey)).toEqual(['pqk-1', undefined, undefined])
  })
})

describe('splitForMsgParam', () => {
  it('keeps a short body whole and splits at paragraph breaks under the encoded limit', () => {
    expect(splitForMsgParam('short', (text) => ({ title: 't', text }))).toEqual(['short'])
    const long = `${'a'.repeat(8000)}\n\n${'b'.repeat(8000)}`
    expect(splitForMsgParam(long, (text) => ({ title: 't', text }))).toEqual(['a'.repeat(8000), 'b'.repeat(8000)])
  })
})
