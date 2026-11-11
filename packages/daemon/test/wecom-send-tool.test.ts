import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WeComInboundMessage } from '@agentconnect.md/message'
import { Daemon } from '../src/daemon.js'
import { settlePost } from '../src/mcp/ops/messaging.js'
import { canonicalizeWeComThread } from '../src/platforms/wecom/module.js'
import { threadKeyForPost } from '../src/platforms/thread-keys.js'
import { WECOM_MARKDOWN_MAX_BYTES, WeComConnection } from '../src/platforms/wecom/connection.js'
import { WECOM_PER_HOUR } from '../src/platforms/wecom/rate-limit.js'
import { sessionChannelOf, sessionThreadOf, type NormalizedMessage } from '../src/messages/normalized.js'
import { isAppendCoordinate } from '../src/session/append-coordinate.js'
import { sessionKey } from '../src/store/local-store.js'
import { FakeWeComServer, quietLog } from './fakes/wecom-server.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const BOT = 'aibot-example'
const USER = 'user-alice'
const GROUP = 'chat-example-group'
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('example image body')])

const groupMention: WeComInboundMessage = {
  msgid: 'msg-group-0001',
  aibotid: BOT,
  chatid: GROUP,
  chattype: 'group',
  from: { userid: USER },
  msgtype: 'text',
  text: { content: '@Example Bot summarize please' }
}

const dmText: WeComInboundMessage = {
  msgid: 'msg-dm-0001',
  aibotid: BOT,
  chattype: 'single',
  from: { userid: USER },
  msgtype: 'text',
  text: { content: 'hello' }
}

const connections: WeComConnection[] = []
afterEach(async () => {
  for (const conn of connections.splice(0)) await conn.stop()
})

function setup(opts: { requestTimeoutMs?: number } = {}) {
  const server = new FakeWeComServer()
  const messages: NormalizedMessage[] = []
  const conn = new WeComConnection(
    { botId: BOT, secret: 'secret-placeholder', integrations: [{ agentId: 'agent', integrationId: 'int-wecom' }] },
    {
      onMessage: (msg) => messages.push(msg),
      log: quietLog,
      createSocket: server.createSocket,
      ...(opts.requestTimeoutMs ? { timing: { requestTimeoutMs: opts.requestTimeoutMs } } : {})
    }
  )
  connections.push(conn)
  return { server, conn, messages }
}

const sends = (server: FakeWeComServer) => server.last.frames('aibot_send_msg')

describe('WeCom as the send tool gateway', () => {
  it('is the gateway the send tool resolves for a WeCom integration', () => {
    const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const { conn } = setup()
    daemon.weComConnByIntegration.set('int-wecom', conn)
    expect(daemon.gatewayForIntegration('int-wecom')).toBe(conn)
  })

  it('posts to a group by its chatid and to a member by userid, naming each post by its frame', async () => {
    const { server, conn } = setup()
    await conn.start()
    const groupPost = await conn.postMessage(GROUP, 'Build is green.')
    const dm = await conn.openDirectMessage(USER)
    expect(dm).toBe(`dm:${USER}`)
    // The Slack-style `<@id>` form names the same member.
    expect(await conn.openDirectMessage(`<@${USER}>`)).toBe(`dm:${USER}`)
    const dmPost = await conn.postMessage(dm, 'Review done.')
    expect(sends(server).map((f) => f.body)).toEqual([
      { chatid: GROUP, chat_type: 2, msgtype: 'markdown', markdown: { content: 'Build is green.' } },
      { chatid: USER, chat_type: 1, msgtype: 'markdown', markdown: { content: 'Review done.' } }
    ])
    expect([groupPost, dmPost]).toEqual(sends(server).map((f) => f.headers.req_id))
  })

  it('refuses a target that is not a WeCom conversation before any frame', async () => {
    const { server, conn } = setup()
    await conn.start()
    for (const channel of ['chat example group', 'dm:', 'dm:user:alice', ''])
      await expect(conn.postMessage(channel, 'hello')).rejects.toThrow('is not a WeCom conversation')
    for (const user of ['user alice', `dm:${USER}`])
      await expect(conn.openDirectMessage(user)).rejects.toThrow('is not a WeCom userid')
    expect(
      await conn.uploadFile('chat example group', { bytes: PNG, name: 'chart.png', mimeType: 'image/png' })
    ).toMatchObject({ ok: false, reason: 'not_found' })
    expect(server.last.sent.filter((f) => f.cmd !== 'aibot_subscribe')).toEqual([])
  })

  it('reports WeCom refusing a conversation nobody has messaged it in, once and without retrying', async () => {
    const { server, conn } = setup()
    await conn.start()
    server.answers.set('aibot_send_msg', 40001)
    const refused = conn.postMessage(`dm:user-bob`, 'Your report is ready.')
    await expect(refused).rejects.toThrow(
      'WeCom refused the message (errcode 40001: refused). WeCom lets a bot message a conversation only after someone there has messaged it'
    )
    await expect(refused).rejects.toThrow('Nothing was sent.')
    expect(sends(server)).toHaveLength(1)
  })

  it('says a send WeCom never answered MAY have landed', async () => {
    const { server, conn } = setup({ requestTimeoutMs: 20 })
    await conn.start()
    server.answers.set('aibot_send_msg', 'silent')
    await expect(conn.postMessage(GROUP, 'hello')).rejects.toThrow(
      'WeCom did not confirm the message, so it MAY have been delivered. Do NOT retry.'
    )
  })

  it("refuses a post once the conversation's hour is spent, before any frame", async () => {
    const { server, conn } = setup()
    await conn.start()
    const budget = (conn as unknown as { budget: { note(channel: string): void } }).budget
    for (let i = 0; i < WECOM_PER_HOUR; i++) budget.note(GROUP)
    await expect(conn.postMessage(GROUP, 'hello')).rejects.toThrow(
      'this conversation has used its 1,000 WeCom messages for this hour'
    )
    expect(sends(server)).toEqual([])
    // Another conversation keeps its own budget.
    await conn.postMessage(`dm:${USER}`, 'hello')
    expect(sends(server)).toHaveLength(1)
  })

  it('splits a long post under the byte cap, and names how far a refused part got', async () => {
    const { server, conn } = setup()
    await conn.start()
    const text = 'line of the weekly report\n'.repeat(1_000)
    const id = await conn.postMessage(GROUP, text)
    const parts = sends(server)
    expect(parts).toHaveLength(2)
    for (const part of parts) {
      const content = (part.body!.markdown as { content: string }).content
      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(WECOM_MARKDOWN_MAX_BYTES)
    }
    expect(id).toBe(parts[0]!.headers.req_id)

    server.answerBy = (frame) => (frame.cmd === 'aibot_send_msg' && sends(server).length === 4 ? 40001 : undefined)
    await expect(conn.postMessage(GROUP, text)).rejects.toThrow(
      /refused part 2 of 2 .* The part before it was delivered\. Do not send them again\./
    )
  })

  it('posts a file with its caption, and refuses a placement WeCom does not have', async () => {
    const { server, conn } = setup()
    await conn.start()
    const file = { bytes: PNG, name: 'chart.png', mimeType: 'image/png' }
    const outcome = await conn.uploadFile(GROUP, file, 'Q3', { thread: 'group' })
    expect(outcome).toEqual({ ok: true, messageId: sends(server)[0]!.headers.req_id })
    expect(sends(server).map((f) => f.body!.msgtype)).toEqual(['image', 'markdown'])
    for (const anchor of [{ thread: 'some-thread' }, { replyTo: 1 }])
      expect(await conn.uploadFile(GROUP, file, undefined, anchor)).toMatchObject({ ok: false })
    expect(sends(server)).toHaveLength(2)
  })
})

describe('a WeCom post and the reply to it share one session', () => {
  const origin = {
    agentId: 'agent',
    platform: 'wecom',
    channel: 'dm:user-carol',
    thread: 'dm',
    deliveryThread: 'dm'
  }

  async function postAndReply(channel: string, inbound: WeComInboundMessage) {
    const { server, conn, messages } = setup()
    await conn.start()
    const recorded: (string | undefined)[] = []
    const seeded: { thread: string; isDm?: boolean }[] = []
    const providerPostId = await conn.postMessage(channel, 'Standup in five minutes.')
    // Classified as a fresh connection would: nothing observed yet.
    await settlePost(
      origin,
      {
        recordOutbound: async (_origin, _channel, thread) => void recorded.push(thread),
        spawnChannelRootSession: async (req) => {
          seeded.push({ thread: req.thread, ...(req.isDm !== undefined ? { isDm: req.isDm } : {}) })
          return true
        }
      },
      conn,
      {
        platform: 'wecom',
        integrationId: 'int-wecom',
        channel,
        body: 'Standup in five minutes.',
        ...(providerPostId ? { providerPostId } : {}),
        ts: providerPostId!,
        directMessage: false,
        seed: true
      }
    )
    server.last.message('req-reply', inbound as Record<string, unknown>)
    const reply = messages.at(-1)!
    await canonicalizeWeComThread(undefined, reply)
    return { recorded, seeded, reply, providerPostId: providerPostId! }
  }

  it('keys a group post `group`, the thread a mention there continues', async () => {
    const { recorded, seeded, reply, providerPostId } = await postAndReply(GROUP, groupMention)
    expect(reply.thread).toBe('group')
    expect(seeded).toEqual([{ thread: 'group', isDm: false }])
    expect(recorded).toEqual(['group'])
    expect(threadKeyForPost('wecom', GROUP, providerPostId, false)).toBe(reply.thread)
  })

  it('keys a direct chat post `dm`, the thread a message there continues', async () => {
    const { recorded, seeded, reply } = await postAndReply(`dm:${USER}`, dmText)
    expect(reply.thread).toBe('dm')
    expect(seeded).toEqual([{ thread: 'dm', isDm: true }])
    expect(recorded).toEqual(['dm'])
  })
})

describe('a WeCom group post joins the session a mention there reaches', () => {
  // A Slack bot boots the daemon; the WeCom integration is added afterwards so nothing dials WeCom.
  async function boot() {
    const root = mkdtempSync(join(tmpdir(), 'ac-wecom-send-'))
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        version: 1,
        controlPlane: { enabled: false },
        runtimes: { claude: { command: 'node', args: ['unused'] } }
      })
    )
    const adir = join(root, 'agents', 'agent')
    mkdirSync(adir, { recursive: true })
    writeFileSync(
      join(adir, 'agent.json'),
      JSON.stringify({
        id: 'agent',
        name: 'agent',
        status: 'active',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
        integrations: [
          {
            id: 'int-slack',
            platform: 'slack',
            core: { bindRules: [] },
            config: { botToken: 'xoxb-example', appToken: 'xapp-example' }
          }
        ],
        output: { mode: 'low' }
      })
    )
    const daemon: any = new Daemon({
      root,
      slackAppFactory: fakeSlackAppFactory(),
      hostFactory: () =>
        ({
          __started: true,
          start: vi.fn(async () => {}),
          newSession: vi.fn(async () => 'acp-1'),
          prompt: vi.fn(async () => 'end_turn'),
          cancel: vi.fn(),
          stop: vi.fn()
        }) as never
    })
    await daemon.start()
    daemon.agents.get('agent').integrations.push({
      id: 'int-wecom',
      platform: 'wecom',
      core: { bindRules: [] },
      config: { botId: BOT, secret: 'secret-placeholder' }
    })
    const seeds: NormalizedMessage[] = []
    daemon.dispatch = vi.fn(async (_agentId: string, msg: NormalizedMessage) => void seeds.push(msg))
    return { daemon, seeds }
  }

  // A group in append mode is not covered: core keys a post's seed by its thread on every platform, not by the append coordinate.
  it('in the default session mode', async () => {
    const { daemon, seeds } = await boot()
    const { server, conn, messages } = setup()
    await conn.start()
    const postId = (await conn.postMessage(GROUP, 'Standup in five minutes.'))!
    const scope = daemon.transportScopeForIntegrationIds(['int-wecom'])
    // A post from the agent's direct chat with someone else seeds the group's session.
    expect(
      await daemon.collab.spawnChannelRootSession({
        agentId: 'agent',
        platform: 'wecom',
        integrationId: 'int-wecom',
        channel: GROUP,
        thread: threadKeyForPost('wecom', GROUP, postId, (await conn.getChannelInfo(GROUP)).isIm),
        postTs: postId,
        isDm: false,
        text: 'Standup in five minutes.',
        originPlatform: 'wecom',
        originChannel: 'dm:user-carol',
        originThread: 'dm'
      })
    ).toBe(true)
    server.last.message('req-reply', groupMention as Record<string, unknown>)
    const reply = messages.at(-1)!
    reply.transportScope = scope
    await canonicalizeWeComThread(undefined, reply)
    await daemon.keySession('agent', 'int-wecom', reply)

    const keyOf = (msg: NormalizedMessage) =>
      sessionKey('wecom', sessionChannelOf(msg), sessionThreadOf(msg), 'agent', scope)
    expect(seeds).toHaveLength(1)
    expect(keyOf(seeds[0]!)).toBe(keyOf(reply))
    expect(isAppendCoordinate(sessionThreadOf(reply))).toBe(false)
    expect(sessionThreadOf(reply)).toBe('group')
    await daemon.stop()
  })
})
