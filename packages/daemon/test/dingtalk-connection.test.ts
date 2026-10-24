import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DingTalkRobotMessage } from '@agentconnect.md/message'
import { DingTalkConnection } from '../src/platforms/dingtalk/connection.js'
import { DINGTALK_MSG_PARAM_MAX_BYTES, splitForMsgParam } from '../src/platforms/dingtalk/api.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { fakeSocketFactory } from './fakes/dingtalk-socket.js'
import { elicitOptionToken } from '../src/slack/render.js'
import { Daemon } from '../src/daemon.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

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

function fakeFetch(opts: { failSendAfter?: number; cardDelivered?: boolean } = {}) {
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
    if (path === '/v1.0/card/instances/createAndDeliver')
      return json(200, { success: true, result: { deliverResults: [{ success: opts.cardDelivered ?? true }] } })
    if (path === '/v1.0/card/instances') return json(200, { success: true, result: true })
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

function connect(
  fetchImpl: typeof fetch,
  onMessage: (msg: NormalizedMessage) => void = () => {},
  extra: Partial<ConstructorParameters<typeof DingTalkConnection>[1]> = {}
) {
  const sockets = fakeSocketFactory()
  const conn = new DingTalkConnection(
    { clientId: CLIENT_ID, clientSecret: 'client-secret-example', edition: 'mainland', integrations: [] },
    { log, onMessage, fetchImpl, origin: ORIGIN, createSocket: (url) => sockets.createSocket(url), ...extra }
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
        subscriptions: [
          { type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' },
          { type: 'CALLBACK', topic: '/v1.0/card/instances/callback' }
        ]
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

  it('reports the organization from the first message, again only hourly, and retries until the CP is told', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const reported: string[] = []
      let told = false
      const { conn } = connect(fakeFetch().fetchImpl, () => {}, {
        onTenant: (corpId) => (reported.push(corpId), told)
      })
      const message = (n: number, corpId = 'corp-example') =>
        conn.normalize({ ...groupMention, msgId: `msg-${n}`, chatbotCorpId: corpId })

      message(1)
      told = true
      message(2)
      message(3)
      expect(reported).toEqual(['corp-example', 'corp-example'])
      vi.setSystemTime(Date.now() + 60 * 60 * 1000)
      message(4)
      message(5, 'corp-other')
      expect(reported).toEqual(['corp-example', 'corp-example', 'corp-example', 'corp-other'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks a group external once someone outside the organization speaks there', () => {
    const external: [string, string][] = []
    const { conn } = connect(fakeFetch().fetchImpl, () => {}, {
      onPlaceExternal: (channel, reason) => void external.push([channel, reason])
    })
    const message = (n: number, extra: Partial<DingTalkRobotMessage>) =>
      conn.normalize({ ...groupMention, msgId: `msg-${n}`, chatbotCorpId: 'corp-example', ...extra })

    message(1, { senderCorpId: 'corp-example' })
    expect(external).toEqual([])
    // An outsider has no staff ID in the robot's organization, only the opaque sender id.
    message(2, { senderStaffId: undefined, senderId: '$:LWCP_v1:$outsider' })
    message(3, { senderStaffId: undefined, senderId: '$:LWCP_v1:$outsider' })
    message(4, { conversationId: 'cid-example-other', senderCorpId: 'corp-other' })
    expect(external).toEqual([
      ['cid-example-group', 'externalMember'],
      ['cid-example-other', 'externalMember']
    ])
  })

  it("is the send tool's gateway: it opens a member's DM and posts there, and refuses an outsider", async () => {
    const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const { calls, fetchImpl } = fakeFetch({ failSendAfter: 1 })
    const { conn } = connect(fetchImpl)
    daemon.dingTalkConnByIntegration.set('int-dt', conn)
    expect(daemon.gatewayForIntegration('int-dt')).toBe(conn)

    const dm = await conn.openDirectMessage('user-0001')
    expect(await conn.postMessage(dm, 'Review done.')).toBe('pqk-1')
    expect(calls.at(-1)).toMatchObject({ path: '/v1.0/robot/oToMessages/batchSend', body: { userIds: ['user-0001'] } })
    await expect(conn.openDirectMessage('$:LWCP_v1:$outsider')).rejects.toThrow("needs a member's staff ID")
    // A refused send surfaces to the tool rather than reading as posted.
    await expect(conn.postMessage('cid-example-group', 'Again.')).rejects.toThrow()
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

describe('DingTalk question cards', () => {
  const TEMPLATE = 'template-example.schema'
  const PARAMS = { layout: 'buttons', prompt: 'Pick one', opt0: 'main' }

  it('delivers to a group by its conversation and to a DM by the staff id, from the configured template', async () => {
    const { calls, fetchImpl } = fakeFetch()
    const { conn } = connect(fetchImpl, () => {}, { questionTemplate: TEMPLATE })
    expect(await conn.cards!.deliver('cid-example-group', 'acq-b-req-1', PARAMS)).toBe(true)
    expect(await conn.cards!.deliver('dm:user-0001', 'acq-b-req-2', PARAMS)).toBe(true)
    const delivered = calls.filter((call) => call.path === '/v1.0/card/instances/createAndDeliver')
    const common = {
      cardTemplateId: TEMPLATE,
      callbackType: 'STREAM',
      cardData: { cardParamMap: PARAMS },
      imGroupOpenSpaceModel: { supportForward: false },
      imRobotOpenSpaceModel: { supportForward: false }
    }
    expect(delivered.map((call) => call.body)).toEqual([
      {
        ...common,
        outTrackId: 'acq-b-req-1',
        openSpaceId: 'dtv1.card//IM_GROUP.cid-example-group',
        imGroupOpenDeliverModel: { robotCode: CLIENT_ID }
      },
      {
        ...common,
        outTrackId: 'acq-b-req-2',
        userIdType: 1,
        openSpaceId: 'dtv1.card//IM_ROBOT.user-0001',
        imRobotOpenDeliverModel: { spaceType: 'IM_ROBOT', robotCode: CLIENT_ID }
      }
    ])
    expect(delivered[0]!.headers['x-acs-dingtalk-access-token']).toBe('token-1')
  })

  it('reports a refused delivery with one warning, and updates a card by key', async () => {
    const { calls, fetchImpl } = fakeFetch({ cardDelivered: false })
    const warn = vi.fn()
    const { conn } = connect(fetchImpl, () => {}, { questionTemplate: TEMPLATE, log: { ...log, warn } })
    expect(await conn.cards!.deliver('cid-example-group', 'acq-b-req-1', PARAMS)).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    await conn.cards!.update('acq-b-req-1', { answer: '✅ main' })
    expect(calls.at(-1)).toMatchObject({
      path: '/v1.0/card/instances',
      body: {
        outTrackId: 'acq-b-req-1',
        cardData: { cardParamMap: { answer: '✅ main' } },
        cardUpdateOptions: { updateCardDataByKey: true }
      }
    })
  })

  it('has no card calls without a template', () => {
    const { fetchImpl } = fakeFetch()
    expect(connect(fetchImpl).conn.cards).toBeUndefined()
  })

  it('hands a tap on the card topic to core with the tapper, and ignores one on a card it did not send', async () => {
    const { fetchImpl } = fakeFetch()
    const taps: unknown[] = []
    const onElicitChoice = vi.fn(async (a: unknown) => void taps.push(a))
    const { conn, sockets } = connect(fetchImpl, () => {}, { questionTemplate: TEMPLATE, onElicitChoice })
    await conn.start()
    // The tapper's name is known once they have spoken to the bot.
    sockets[0]!.callback('cb-1', groupMention)
    const tap = (outTrackId: string) => ({
      outTrackId,
      userId: 'user-0001',
      spaceType: 'IM_GROUP',
      spaceId: 'cid-example-group',
      content: JSON.stringify({ cardPrivateData: { actionIds: ['choice'], params: { option: '1' } } })
    })
    sockets[0]!.callback('cb-2', tap('acq-b-req-1'), '/v1.0/card/instances/callback')
    sockets[0]!.callback('cb-3', tap('another-card'), '/v1.0/card/instances/callback')
    await vi.waitFor(() => expect(onElicitChoice).toHaveBeenCalledTimes(1))
    expect(taps).toEqual([
      {
        requestId: 'req-1',
        token: elicitOptionToken(1),
        ts: 'acq-b-req-1',
        actor: { userId: 'user-0001', name: 'Example User' }
      }
    ])
    // Every callback is acknowledged, whether or not it named a card.
    expect(sockets[0]!.sent.map((frame) => (frame.headers as { messageId: string }).messageId)).toEqual([
      'cb-1',
      'cb-2',
      'cb-3'
    ])
  })
})

describe('splitForMsgParam', () => {
  it('keeps a short body whole and splits at paragraph breaks under the encoded limit', () => {
    expect(splitForMsgParam('short', (text) => ({ title: 't', text }))).toEqual(['short'])
    const long = `${'a'.repeat(8000)}\n\n${'b'.repeat(8000)}`
    expect(splitForMsgParam(long, (text) => ({ title: 't', text }))).toEqual(['a'.repeat(8000), 'b'.repeat(8000)])
  })
})
