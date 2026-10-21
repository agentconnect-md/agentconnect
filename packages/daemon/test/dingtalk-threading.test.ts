import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DingTalkRobotMessage } from '@agentconnect.md/message'
import { Daemon } from '../src/daemon.js'
import { DingTalkApi } from '../src/platforms/dingtalk/api.js'
import { DingTalkConnection } from '../src/platforms/dingtalk/connection.js'
import { canonicalizeDingTalkThread } from '../src/platforms/dingtalk/threading.js'
import { DINGTALK_CONTINUE_HINT } from '../src/platforms/dingtalk/turn-output.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'

const CLIENT_ID = 'client-id-example'
const GROUP = 'cid-example-group'

function robotMessage(
  msgId: string,
  opts: { quoteKey?: string; dm?: boolean; text?: string } = {}
): DingTalkRobotMessage {
  return {
    msgId,
    createAt: 1767225600000,
    conversationId: opts.dm ? 'cid-example-dm' : GROUP,
    conversationType: opts.dm ? '1' : '2',
    conversationTitle: opts.dm ? undefined : 'Example Group',
    senderStaffId: 'user-0001',
    senderId: 'sender-0001',
    senderNick: 'Example User',
    chatbotUserId: 'bot-example',
    robotCode: CLIENT_ID,
    isInAtList: !opts.dm,
    msgtype: 'text',
    text: {
      content: ` ${opts.text ?? `request ${msgId}`}`,
      ...(opts.quoteKey
        ? {
            isReplyMsg: true,
            repliedMsg: {
              msgId: `bot-${msgId}`,
              msgType: 'text',
              senderId: 'bot-example',
              content: { text: 'earlier' }
            }
          }
        : {})
    },
    ...(opts.quoteKey ? { originalProcessQueryKey: opts.quoteKey } : {})
  }
}

function message(fields: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    msgId: `dingtalk:${GROUP}:msg-1`,
    traceId: 't',
    source: 'user',
    platform: 'dingtalk',
    channel: GROUP,
    sender: { id: 'user-0001', isBot: false },
    text: 'hello',
    mentionedBots: [CLIENT_ID],
    isDm: false,
    ...fields
  } as NormalizedMessage
}

describe('canonicalizeDingTalkThread', () => {
  const host = (threads: Record<string, string>) => ({
    threadForMessage: vi.fn(async (_channel: string, id: string) => threads[id])
  })

  it('keys a DM as one session, a new mention as a session rooted at itself, and leaves other platforms alone', async () => {
    const dm = message({ isDm: true, channel: 'dm:user-0001' })
    await canonicalizeDingTalkThread(host({}), dm, 'transcript')
    expect(dm.thread).toBe('dm')
    const mention = message({})
    await canonicalizeDingTalkThread(host({}), mention, 'transcript')
    expect(mention.thread).toBe('dt:msg-1')
    const other = message({ platform: 'qq' })
    await canonicalizeDingTalkThread(host({}), other, 'transcript')
    expect(other.thread).toBeUndefined()
  })

  it('follows a quote to its recorded session and starts fresh when it maps to nothing or to an append coordinate', async () => {
    const lookup = host({ 'pqk-1': 'dt:msg-0', 'pqk-append': 'append:abc' })
    const mapped = message({ replyTo: 'pqk-1' })
    await canonicalizeDingTalkThread(lookup, mapped, 'transcript')
    expect(mapped.thread).toBe('dt:msg-0')
    expect(lookup.threadForMessage).toHaveBeenCalledWith('transcript', 'pqk-1')
    const unknown = message({ replyTo: 'pqk-unknown' })
    await canonicalizeDingTalkThread(lookup, unknown, 'transcript')
    expect(unknown.thread).toBe('dt:msg-1')
    const append = message({ replyTo: 'pqk-append' })
    await canonicalizeDingTalkThread(lookup, append, 'transcript')
    expect(append.thread).toBe('dt:msg-1')
  })
})

let daemon: Daemon | undefined
let root: string | undefined
afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  if (root) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('DingTalk reply chain through the daemon', () => {
  it('records each reply by its process query key, so quoting it with a mention continues that session', async () => {
    root = mkdtempSync(join(tmpdir(), 'ac-dingtalk-'))
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        version: 1,
        controlPlane: { enabled: false },
        runtimes: { opencode: { command: 'node', args: ['unused'] } }
      })
    )
    const dir = join(root, 'agents', 'dt-agent')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'agent.json'),
      JSON.stringify({
        id: 'dt-agent',
        name: 'DingTalk Agent',
        runtime: 'opencode',
        status: 'active',
        workspace: { mode: 'from-scratch', path: join(dir, 'workspace') },
        integrations: [
          {
            id: 'dt-install',
            platform: 'dingtalk',
            core: { mode: 'direct', bindRules: [{ match: { kind: 'mention' } }, { match: { kind: 'dm' } }] },
            config: { clientId: CLIENT_ID, clientSecret: 'client-secret-example' }
          }
        ],
        output: { mode: 'low' }
      })
    )
    vi.spyOn(DingTalkConnection.prototype, 'start').mockResolvedValue()
    let keys = 0
    const send = vi.spyOn(DingTalkApi.prototype, 'send').mockImplementation(async () => `pqk-${++keys}`)
    let sessions = 0
    const prompts: string[] = []
    daemon = new Daemon({
      root,
      hostFactory: (_agent, update) =>
        ({
          start: async () => {},
          stop: async () => {},
          cancel: async () => {},
          newSession: async () => `session-${++sessions}`,
          prompt: async (session: string) => {
            prompts.push(session)
            update(session, {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `answer ${prompts.length}` }
            })
            return 'end_turn'
          }
        }) as any
    })
    await daemon.start()
    await vi.waitFor(() => expect((daemon as any).dingTalkConnByIntegration.size).toBe(1))
    const conn = (daemon as any).dingTalkConnByIntegration.get('dt-install') as DingTalkConnection
    const deliver = async (payload: DingTalkRobotMessage) => {
      const msg = conn.normalize(payload)
      expect(msg).not.toBeNull()
      const outcome = await (daemon as any).onInboundOutcome(msg, ['dt-install'])
      if (outcome.kind === 'dispatched') await outcome.handle.completion
    }

    await deliver(robotMessage('msg-1'))
    await deliver(robotMessage('msg-2', { quoteKey: 'pqk-1' }))
    await deliver(robotMessage('msg-3', { quoteKey: 'pqk-unknown' }))
    await deliver(robotMessage('msg-4'))
    await deliver(robotMessage('msg-5', { dm: true }))
    await deliver(robotMessage('msg-6', { dm: true }))

    expect(prompts).toHaveLength(6)
    // The quote of the bot's first reply lands in the first session; everything else is its own, and a DM is one.
    expect(prompts[1]).toBe(prompts[0])
    expect(new Set([prompts[0], prompts[2], prompts[3], prompts[4]]).size).toBe(4)
    expect(prompts[5]).toBe(prompts[4])

    const calls = send.mock.calls.map(([target, msgKey, msgParam]) => ({
      target,
      msgKey,
      param: JSON.parse(msgParam) as { title: string; text: string }
    }))
    expect(calls).toHaveLength(6)
    expect(calls[0]).toEqual({
      target: { kind: 'group', openConversationId: GROUP },
      msgKey: 'sampleMarkdown',
      param: { title: 'answer 1', text: `answer 1\n\n${DINGTALK_CONTINUE_HINT}` }
    })
    // A DM is one session already, so its reply carries no hint.
    expect(calls[4]).toEqual({
      target: { kind: 'user', staffId: 'user-0001' },
      msgKey: 'sampleMarkdown',
      param: { title: 'answer 5', text: 'answer 5' }
    })

    // The bot's reply row carries the send's process query key as its platform message id, without the hint.
    const store = (daemon as any).store
    const rows = (
      await store.db.prepare(`SELECT ts, thread, text FROM transcript WHERE ts = 'pqk-1' AND kind = 'text'`).all()
    ).map((row: { ts: string; thread: string; text: string }) => ({ ts: row.ts, thread: row.thread, text: row.text }))
    expect(rows).toEqual([{ ts: 'pqk-1', thread: 'dt:msg-1', text: 'answer 1' }])
  })
})
