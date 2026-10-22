// DingTalk's question card answered by quote, and the approval notice that keeps approvals in the Console (dingtalk-integration.md §4.6).
import { DatabaseSync } from 'node:sqlite'
import { describe, it, expect, vi } from 'vitest'
import type { CreateElicitationRequest, RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { Daemon } from '../src/daemon.js'
import { TerminalOutputFolder } from '../src/session/terminal-output-folder.js'
import { WorkBoundary } from '../src/messages/message-boundary.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { elicitForm, elicitOptionToken } from '../src/slack/render.js'
import { DINGTALK_MSG_PARAM_MAX_BYTES } from '../src/platforms/dingtalk/api.js'
import {
  DINGTALK_ELICIT_SURFACE,
  dingTalkElicitChoice,
  dingTalkElicitText
} from '../src/platforms/dingtalk/elicit-card.js'
import { applyDingTalkAction } from '../src/platforms/dingtalk/turn-output.js'
import { LocalStore } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'

function form(properties: Record<string, unknown>, required: string[] = []): CreateElicitationRequest {
  return {
    sessionId: 's1',
    mode: 'form',
    message: 'Which branch should I cut from?',
    requestedSchema: { type: 'object', properties, required }
  } as CreateElicitationRequest
}

const BRANCH = { branch: { type: 'string', enum: ['main', 'develop'], title: 'Base branch' } }
const CHANNEL = 'cid-example-group'
const CONVERSATION = `${CHANNEL}\u001fdingtalk:app-1`
const AGENT = '11111111-1111-4111-8111-111111111111'
const INT = '22222222-2222-4222-8222-222222222222'

function target() {
  return elicitForm(form(BRANCH, ['branch']), DINGTALK_ELICIT_SURFACE)![0]!
}

describe('the DingTalk card text and the replies it reads', () => {
  it('numbers every option and says to reply to it', () => {
    expect(dingTalkElicitText('Pick one', target())).toBe(
      '💬 Pick one\n1. main\n2. develop\n\nReply to this message with a number or an option.'
    )
  })

  it('keeps a long question inside one message once encoded', () => {
    const text = dingTalkElicitText('问"'.repeat(8000), target())!
    expect(Buffer.byteLength(JSON.stringify({ content: text }))).toBeLessThanOrEqual(DINGTALK_MSG_PARAM_MAX_BYTES)
    expect(text.endsWith('with a number or an option.')).toBe(true)
  })

  it('reads a number, a full-width number, or an option label, and nothing else', () => {
    expect(dingTalkElicitChoice(target(), ' 2 ')).toBe(1)
    expect(dingTalkElicitChoice(target(), '１')).toBe(0)
    expect(dingTalkElicitChoice(target(), 'Develop')).toBe(1)
    expect(dingTalkElicitChoice(target(), '3')).toBeNull()
    expect(dingTalkElicitChoice(target(), 'sure')).toBeNull()
  })
})

function dingTalkTurn() {
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
  daemon.store = {
    getSessionByAcpIdForAgent: () => ({ triggeredBy: 'user-1' }),
    getDisplayNames: () => new Map(),
    upsertElicit: vi.fn(async () => {})
  }
  const sent: { channel: string; text: string }[] = []
  const egress = {
    sendText: async (channel: string, text: string) => {
      sent.push({ channel, text })
      return `pqk-${sent.length}`
    }
  }
  daemon.pending.set(JSON.stringify(['agent-1', 's1']), {
    plan: {
      platform: 'dingtalk',
      agentId: 'agent-1',
      sessionKey: 'k1',
      channel: CHANNEL,
      transcriptChannel: CONVERSATION,
      statusThread: 'dt:msg-1',
      agentName: 'agent',
      isDm: false,
      approvalSurfaceSuppressed: false
    },
    entry: { msg: {} },
    hostKey: 'agent-1',
    outwardSessionId: 'sess-1',
    // DingTalk has no reply connection: the card rides the leased egress, as its output does.
    egress,
    turnState: { conn: egress, channel: CHANNEL },
    chrome: {},
    reply: { text: '', attemptText: '', attemptAnswerUpdates: [] },
    signals: { applyChain: Promise.resolve() },
    approval: { waitMs: 0, depth: 0 },
    builtinSystemToolCallIds: new Set<string>(),
    conv: { onUpdate: () => [], hasBuffered: () => false },
    rec: { onUpdate: () => [] },
    termOut: new TerminalOutputFolder(),
    workBoundary: new WorkBoundary()
  })
  const applied: any[] = []
  daemon.enqueueApply = (_p: any, action: any) => void applied.push(action)
  return { daemon, sent, notices: () => applied.filter((a) => a.kind === 'notice').map((a) => a.text) }
}

const reply = (text: string, replyTo?: string, conversation = CONVERSATION) => ({
  conversation,
  text,
  ...(replyTo !== undefined ? { replyTo } : {}),
  actor: { userId: 'user-0001' }
})

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

async function raise(h: ReturnType<typeof dingTalkTurn>, req: CreateElicitationRequest) {
  const result = h.daemon.permissions.onAcpElicit('agent-1', 's1', req)
  await vi.waitFor(() => expect(h.daemon.permissions.pendingElicits.size).toBe(1))
  const requestId = [...h.daemon.permissions.pendingElicits.keys()][0] as string
  // The card's handle is its send's process query key, the key a quote of it brings back.
  await vi.waitFor(() => expect(h.daemon.permissions.pendingElicits.get(requestId).ts).toBe('pqk-1'))
  return { requestId, result }
}

describe('a DingTalk turn collects an elicitation answer from a quote', () => {
  it('posts the card and accepts a quote of it, adding nothing beside the reply that answered', async () => {
    const h = dingTalkTurn()
    const { result } = await raise(h, form(BRANCH, ['branch']))
    expect(h.sent).toEqual([
      { channel: CHANNEL, text: dingTalkElicitText('Which branch should I cut from?', target()) }
    ])
    expect(await h.daemon.permissions.claimElicitReply(reply('2', 'pqk-1'))).toBe(true)
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'develop' } })
    await flush()
    expect(h.sent).toHaveLength(1)
  })

  it('settles with a new message when the answer came from elsewhere', async () => {
    const h = dingTalkTurn()
    const { requestId, result } = await raise(h, form(BRANCH, ['branch']))
    await h.daemon.permissions.handleElicitChoice({ requestId, value: elicitOptionToken(1) })
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'develop' } })
    await vi.waitFor(() => expect(h.sent.at(-1)).toEqual({ channel: CHANNEL, text: '✅ develop' }))
  })

  it('answers only a quote of this card, in this conversation', async () => {
    const h = dingTalkTurn()
    await raise(h, form(BRANCH, ['branch']))
    expect(await h.daemon.permissions.claimElicitReply(reply('2'))).toBe(false)
    expect(await h.daemon.permissions.claimElicitReply(reply('2', 'pqk-other'))).toBe(false)
    expect(await h.daemon.permissions.claimElicitReply(reply('2', 'pqk-1', `${CHANNEL}\u001fdingtalk:app-2`))).toBe(
      false
    )
    expect(h.daemon.permissions.pendingElicits.size).toBe(1)
  })

  it('keeps the card open and repeats the instruction when the quote names no option', async () => {
    const h = dingTalkTurn()
    await raise(h, form(BRANCH, ['branch']))
    expect(await h.daemon.permissions.claimElicitReply(reply('maybe', 'pqk-1'))).toBe(true)
    expect(h.daemon.permissions.pendingElicits.size).toBe(1)
    await vi.waitFor(() => expect(h.sent.at(-1)!.text).toBe('Reply to the question with a number from 1 to 2.'))
  })

  it('still declines a typed question it has no control for', async () => {
    const h = dingTalkTurn()
    const req = form({ note: { type: 'string', title: 'Note' } }, ['note'])
    await expect(h.daemon.permissions.onAcpElicit('agent-1', 's1', req)).resolves.toBeUndefined()
    expect(h.sent).toEqual([])
  })
})

describe('DingTalk approvals', () => {
  const permission = {
    sessionId: 's1',
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
    ],
    toolCall: { toolCallId: 'tc-1', title: 'Write example.txt' }
  } as unknown as RequestPermissionRequest

  it('stay in the Console, with a notice in the conversation', async () => {
    const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
    daemon.store = store
    expect(daemon.turnSurfaces.exact('dingtalk')?.approvalCards).toBeUndefined()
    daemon.agents.set(AGENT, {
      id: AGENT,
      name: 'Butler',
      chatActions: 'approve',
      integrations: [
        {
          id: INT,
          platform: 'dingtalk',
          core: {
            mode: 'direct',
            bindRules: [],
            mutedChannels: [],
            gated: false,
            sessionModes: [],
            externalChannels: [],
            decisions: { bindings: [], definitions: [] }
          }
        }
      ]
    })
    const applied: any[] = []
    daemon.enqueueApply = (_p: unknown, action: unknown) => void applied.push(action)
    daemon.pending.set(JSON.stringify([AGENT, 's1']), {
      plan: {
        platform: 'dingtalk',
        agentId: AGENT,
        agentName: 'Butler',
        integrationId: INT,
        sessionKey: `dingtalk:${CHANNEL}:dt:msg-1:${AGENT}`,
        requesterId: 'user-0001',
        channel: CHANNEL,
        thread: 'dt:msg-1',
        transcriptChannel: CHANNEL,
        statusThread: 'dt:msg-1',
        sessionThread: 'dt:msg-1',
        isDm: false,
        approvalSurfaceSuppressed: false,
        suppressReplyConn: false
      },
      entry: { msg: { source: 'user', text: 'please write it', sender: { id: 'user-0001', isBot: false } } },
      egress: { sendText: vi.fn(async () => 'pqk-1') },
      hostKey: AGENT,
      outwardSessionId: 'sid-1',
      chrome: {},
      signals: { applyChain: Promise.resolve() },
      approval: { waitMs: 0, depth: 0 },
      builtinSystemToolCallIds: new Set<string>(),
      conv: { onUpdate: () => [], hasBuffered: () => false }
    })
    void daemon.permissions.onAcpPermission(AGENT, 's1', permission)
    await vi.waitFor(() =>
      expect(applied.filter((a) => a.kind === 'notice').map((a) => a.text)).toEqual([
        expect.stringContaining('Ask an Agent editor')
      ])
    )
    await store.close()
  })

  it('post a core notice as plain text through the leased connection, unrecorded', async () => {
    const sendText = vi.fn(async () => 'pqk-1')
    const host = { appendTranscript: vi.fn(async () => {}), monotonicTs: () => '1' }
    const turn = { plan: { transcriptChannel: CONVERSATION, statusThread: 'dt:msg-1', agentId: 'a', sessionKey: 'k' } }
    await applyDingTalkAction(
      host,
      turn,
      { conn: { sendText } as never, channel: CHANNEL },
      {
        kind: 'notice',
        text: '🔒 Permission requested.'
      }
    )
    expect(sendText).toHaveBeenCalledWith(CHANNEL, '🔒 Permission requested.')
    expect(host.appendTranscript).not.toHaveBeenCalled()
  })
})
