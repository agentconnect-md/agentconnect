// QQ's elicitation card: a numbered text card on the turn's leased egress, answered by quoting it.
import { describe, it, expect, vi } from 'vitest'
import type { CreateElicitationRequest } from '@agentclientprotocol/sdk'
import { Daemon } from '../src/daemon.js'
import { TerminalOutputFolder } from '../src/session/terminal-output-folder.js'
import { WorkBoundary } from '../src/messages/message-boundary.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { elicitForm } from '../src/slack/render.js'
import { QQ_ELICIT_SURFACE, qqElicitChoice, qqElicitText } from '../src/platforms/qq/elicit-card.js'
import type { MemoryWriteAsk } from '../src/mcp/ops/memory.js'

function form(properties: Record<string, unknown>, required: string[] = []): CreateElicitationRequest {
  return {
    sessionId: 's1',
    mode: 'form',
    message: 'Which branch should I cut from?',
    requestedSchema: { type: 'object', properties, required }
  } as CreateElicitationRequest
}

const BRANCH = { branch: { type: 'string', enum: ['main', 'develop'], title: 'Base branch' } }
const CONVERSATION = 'dm:user-openid\u001fqq:app-1'
const ASK: MemoryWriteAsk = { tool: 'writeMemory', target: 'deploys.md', summary: 'Content: "- ship on Fridays"' }

function target() {
  return elicitForm(form(BRANCH, ['branch']), QQ_ELICIT_SURFACE)![0]!
}

describe('the QQ card text and the replies it reads', () => {
  it('numbers every option and says how to answer, naming the mention a group needs', () => {
    expect(qqElicitText('Pick one', target(), 'dm:u')).toBe(
      '💬 Pick one\n1. main\n2. develop\n\nReply to this message with a number.'
    )
    expect(qqElicitText('Pick one', target(), 'group:g')).toContain('mentioning the bot')
  })

  it('keeps a long question inside one QQ message', () => {
    const text = qqElicitText('问'.repeat(5000), target(), 'dm:u')!
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4000)
    expect(text.endsWith('Reply to this message with a number.')).toBe(true)
  })

  it('reads a number, a full-width number, or an option label, and nothing else', () => {
    expect(qqElicitChoice(target(), ' 2 ')).toBe(1)
    expect(qqElicitChoice(target(), '１')).toBe(0)
    expect(qqElicitChoice(target(), 'Develop')).toBe(1)
    expect(qqElicitChoice(target(), '3')).toBeNull()
    expect(qqElicitChoice(target(), '0')).toBeNull()
    expect(qqElicitChoice(target(), 'sure')).toBeNull()
  })
})

function qqTurn() {
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
  daemon.store = {
    getSessionByAcpIdForAgent: () => ({ triggeredBy: 'user-1' }),
    getDisplayNames: () => new Map(),
    upsertElicit: vi.fn(async () => {})
  }
  const cards: { channel: string; replyId: string; text: string }[] = []
  const follows: { channel: string; cardId: string; text: string }[] = []
  const egress = {
    sendCard: async (channel: string, replyId: string, text: string) => {
      cards.push({ channel, replyId, text })
      return `card-${cards.length}`
    },
    followCard: async (channel: string, cardId: string, text: string) => void follows.push({ channel, cardId, text })
  }
  daemon.pending.set(JSON.stringify(['agent-1', 's1']), {
    plan: {
      platform: 'qq',
      agentId: 'agent-1',
      sessionKey: 'k1',
      channel: 'dm:user-openid',
      transcriptChannel: CONVERSATION,
      statusThread: 'dm',
      agentName: 'agent',
      isDm: true,
      approvalSurfaceSuppressed: false
    },
    entry: { msg: {} },
    hostKey: 'agent-1',
    outwardSessionId: 'sess-1',
    // QQ has no reply connection: the card rides the leased egress, as its output does.
    egress,
    turnState: { conn: egress, channel: 'dm:user-openid', replyId: 'user-msg-1' },
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
  return { daemon, cards, follows, notices: () => applied.filter((a) => a.kind === 'notice').map((a) => a.text) }
}

const reply = (text: string, replyTo?: string, conversation = CONVERSATION) => ({
  conversation,
  text,
  ...(replyTo !== undefined ? { replyTo } : {}),
  actor: { userId: 'qq:user:app-1:user-openid' }
})

async function raise(h: ReturnType<typeof qqTurn>, req: CreateElicitationRequest) {
  const result = h.daemon.permissions.onAcpElicit('agent-1', 's1', req)
  await vi.waitFor(() => expect(h.daemon.permissions.pendingElicits.size).toBe(1))
  const requestId = [...h.daemon.permissions.pendingElicits.keys()][0] as string
  await vi.waitFor(() => expect(h.daemon.permissions.pendingElicits.get(requestId).ts).toBe('card-1'))
  return { requestId, result }
}

describe('a QQ turn collects an elicitation answer from a quoted reply', () => {
  it('posts the card as a passive reply and accepts the quoted number', async () => {
    const h = qqTurn()
    const { result } = await raise(h, form(BRANCH, ['branch']))
    expect(h.cards).toEqual([
      {
        channel: 'dm:user-openid',
        replyId: 'user-msg-1',
        text: qqElicitText('Which branch should I cut from?', target(), 'dm:u')
      }
    ])
    expect(await h.daemon.permissions.claimElicitReply(reply('2', 'card-1'))).toBe(true)
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'develop' } })
    expect(h.follows).toEqual([{ channel: 'dm:user-openid', cardId: 'card-1', text: '✅ develop' }])
  })

  it('answers only a quote of this card, in this conversation', async () => {
    const h = qqTurn()
    await raise(h, form(BRANCH, ['branch']))
    expect(await h.daemon.permissions.claimElicitReply(reply('2'))).toBe(false)
    expect(await h.daemon.permissions.claimElicitReply(reply('2', 'other-msg'))).toBe(false)
    expect(await h.daemon.permissions.claimElicitReply(reply('2', 'card-1', 'dm:user-openid\u001fqq:app-2'))).toBe(
      false
    )
    expect(h.daemon.permissions.pendingElicits.size).toBe(1)
  })

  it('keeps the card open and repeats the instruction when the quote names no option', async () => {
    const h = qqTurn()
    await raise(h, form(BRANCH, ['branch']))
    expect(await h.daemon.permissions.claimElicitReply(reply('maybe', 'card-1'))).toBe(true)
    expect(h.daemon.permissions.pendingElicits.size).toBe(1)
    expect(h.follows.map((f) => f.text)).toEqual(['Reply with a number from 1 to 2.'])
  })

  it('still declines a typed question it has no control for', async () => {
    const h = qqTurn()
    const req = form({ note: { type: 'string', title: 'Note' } }, ['note'])
    await expect(h.daemon.permissions.onAcpElicit('agent-1', 's1', req)).resolves.toBeUndefined()
    expect(h.cards).toEqual([])
  })

  it('lets a private chat grant a managed-memory write for the session without the console', async () => {
    const h = qqTurn()
    const outcome = h.daemon.permissions.askMemoryWriteApproval('agent-1', 's1', ASK)
    await vi.waitFor(() => expect(h.cards).toHaveLength(1))
    expect(h.cards[0]!.text).toContain('1. Allow once\n2. Allow for this session\n3. Deny')
    await vi.waitFor(() => expect([...h.daemon.permissions.pendingElicits.values()][0]?.ts).toBe('card-1'))
    expect(await h.daemon.permissions.claimElicitReply(reply('2', 'card-1'))).toBe(true)
    await expect(outcome).resolves.toBe('allow_session')
  })
})
