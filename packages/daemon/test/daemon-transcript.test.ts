import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_AGENT_CALL_HOPS } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { sessionKey, transcriptChannelKey, type TranscriptEntry } from '../src/store/local-store.js'
import { stableTurnId } from '../src/messages/normalized.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import type { SlackPostOptions } from '../src/slack/connection.js'

// vi.waitFor defaults to a 1000ms budget — too tight on a loaded CI runner, where a
// cold session boot (workspace + host + session/new) can stall well past a second.
// Give every poll in this file the same generous budget instead.
const WAIT = { timeout: 10_000 }

const TRANSPORT_SCOPE = `slack:${createHash('sha256').update('slack\0p').digest('hex').slice(0, 24)}`
const TRANSCRIPT_CHANNEL = transcriptChannelKey('C1', TRANSPORT_SCOPE)

function scaffold(mode: 'minimal' | 'low' | 'medium' | 'high', agentExtra: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-tx-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      // Set so onFinal emits the done-footer (gated on a Web App URL) — lets the
      // footer test assert it's posted to Slack but never recorded in the transcript.
      webAppUrl: 'https://app.example.com',
      // This suite pins incremental-flush renderer behavior; staged delivery is
      // covered by turn-output-workflow.
      features: { turnFinalContextRefresh: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const adir = join(root, 'agents', 'bot-a')
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode },
      ...agentExtra
    })
  )
  return root
}

/** A fake host that replays a scripted list of session/update events during prompt. */
function streamingHost(updates: unknown[]) {
  let onUpdate!: (sid: string, u: unknown) => void
  const host = {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => 'acp-1'),
    prompt: vi.fn(async (sid: string) => {
      for (const u of updates) onUpdate(sid, u)
      return 'end_turn'
    }),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => {})
  }
  const factory = (_agent: unknown, cb: (sid: string, u: unknown) => void) => {
    onUpdate = cb
    return host as any
  }
  return { factory, host }
}

/** A fake host that streams one agent_message_chunk (the reply) during prompt. */
function replyingHost(reply: string) {
  return streamingHost([{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } }])
}

const text = (t: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } })
const thought = (t: string) => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: t } })
const tool = (toolCallId: string, title: string) => ({ sessionUpdate: 'tool_call', toolCallId, title })

function makeRoutable(daemon: Daemon) {
  const a = (daemon as any).agents.get('bot-a')
  a.integrations = [
    {
      id: 'int-a',
      platform: 'slack',
      core: { bindRules: [{ match: { kind: 'dm' } }] },
      config: { botToken: 'b', appToken: 'p' }
    }
  ]
  let n = 0
  const conn = {
    workspaceId: vi.fn(() => 'T1'),
    setStatus: vi.fn(async () => {}),
    // Hand back a distinct ts per post so transcript rows don't collide on PK.
    postMessage: vi.fn<PostMessageFake>(async () => `reply-${++n}`),
    postBlocks: vi.fn<PostBlocksFake>(async () => 'status-bar'),
    updateBlocks: vi.fn<UpdateBlocksFake>(async () => {})
  }
  ;(daemon as any).connByIntegration.set('int-a', conn)
  return conn
}

type PostMessageFake = (channel: string, text: string, threadTs?: string, options?: SlackPostOptions) => Promise<string>
type PostBlocksFake = (
  channel: string,
  blocks: unknown[],
  text: string,
  threadTs?: string,
  options?: SlackPostOptions
) => Promise<string>
type UpdateBlocksFake = (
  channel: string,
  ts: string,
  blocks: unknown[],
  text?: string,
  chrome?: boolean,
  agentAuthorId?: string,
  chromeOwnerAgentId?: string
) => Promise<void>

const dm = (ts: string, text: string) => ({
  msgId: `slack:C1:${ts}`,
  traceId: ts,
  source: 'user' as const,
  platform: 'slack' as const,
  channel: 'C1',
  thread: 'T1',
  transportScope: TRANSPORT_SCOPE,
  sender: { id: 'U1', isBot: false },
  text,
  mentionedBots: [] as string[],
  isDm: true,
  trigger: 'dm' as const
})

/** Same conversation, but a human-triggered Slack channel. It is bound to the
 * external Slack audience and therefore isolated from shared agent memory. */
const channelMsg = (ts: string, text: string) => ({ ...dm(ts, text), isDm: false, trigger: 'mention' as const })

/** A daemon-originated Slack turn used by trusted A2A inheritance tests. */
const agentMsg = (ts: string, text: string) => ({ ...channelMsg(ts, text), source: 'agent' as const })

async function transcript(daemon: Daemon): Promise<TranscriptEntry[]> {
  return await (daemon as any).store.transcriptSince(TRANSCRIPT_CHANNEL, 'T1', null)
}

/** Full activity log (all kinds), insertion order — what the Web UI reads. */
async function activity(daemon: Daemon): Promise<{ kind: string; sender: string; text: string }[]> {
  return (await (daemon as any).store.threadTranscript(TRANSCRIPT_CHANNEL, 'T1')).map((r: any) => ({
    kind: r.kind,
    sender: r.sender,
    text: r.text
  }))
}

// The footer deep-links the console, which knows the session by its OUTWARD id (§1.1) — a
// minted UUID, not the runtime's `acp-1`. Matched loosely on that segment alone: the exact value
// belongs to the store, and daemon-message-agent covers what it must be.
const SESSION_URL = /https:\/\/app\.example\.com\/sessions\/[0-9a-f-]{36}\?source=slack/

function classicFooter(botName = 'bot-a', runtime = 'claude', model = 'default') {
  return {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: expect.stringMatching(
          new RegExp(
            `^sent by <https://app\\.example\\.com/agents/bot-a\\|${botName}> \\(${runtime} · ${model}\\) · <${SESSION_URL.source}\\|open in session>$`
          )
        )
      }
    ]
  }
}

/**
 * send-message-routing-rework.md §5.4 — every agent-authored body post carries its turn's
 * STREAMING response block, so a peer can later tell a finished answer from a prefix. The
 * response id is minted per turn, so assert its shape rather than a fixed value; the
 * recipient set is empty until finalization resolves it from the complete response.
 */
function streamingResponse(hopCount = 0) {
  return { responseId: expect.any(String), deliveryState: 'streaming', hopCount, mentionedAgentIds: [] }
}

describe('Daemon transcript records the agent reply', () => {
  it('medium mode: the buffered reply (flushed at onFinal) lands as a bot-a row', async () => {
    const { factory } = replyingHost('here is my answer')
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold('medium'),
      hostFactory: factory
    })
    await daemon.start()
    makeRoutable(daemon)

    await (daemon as any).dispatch('bot-a', dm('100', 'question?'), 'int-a')

    const rows = (await transcript(daemon)).map((r) => ({ ts: r.ts, sender: r.sender, kind: r.kind, text: r.text }))
    // inbound user message + the agent's reply
    expect(rows).toEqual([
      { ts: '100', sender: 'U1', kind: 'text', text: 'question?' },
      { ts: 'reply-1', sender: 'bot-a', kind: 'text', text: 'here is my answer' }
    ])
    await daemon.stop()
  })

  it('records post-turn memory for a CP-published session only after the reply is delivered', async () => {
    const { factory } = replyingHost('here is my answer')
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold('medium'),
      hostFactory: factory
    })
    await daemon.start()
    const conn = makeRoutable(daemon)
    await (daemon as any).dispatch('bot-a', dm('100', 'private question'), 'int-a')
    expect(await (daemon as any).store.applyCpCaptureGate('bot-a', 'acp-1', false, 1)).toBe('applied')

    let releaseDelivery!: () => void
    const deliveryBlocked = new Promise<void>((resolve) => (releaseDelivery = resolve))
    conn.postMessage.mockClear()
    conn.postMessage.mockImplementation(async () => {
      await deliveryBlocked
      return 'reply-1'
    })
    const recordTurn = vi.fn(async () => {})
    ;(daemon as any).memory.recordTurnForBinding = recordTurn
    const capturedBinding = (daemon as any).agents.get('bot-a').memory

    const turn = (daemon as any).dispatch('bot-a', dm('200', 'shared follow-up'), 'int-a')
    await vi.waitFor(() => expect(conn.postMessage).toHaveBeenCalled(), WAIT)
    expect(recordTurn).not.toHaveBeenCalled()

    releaseDelivery()
    await turn
    await vi.waitFor(() => expect(recordTurn).toHaveBeenCalledOnce(), WAIT)
    expect(recordTurn).toHaveBeenCalledWith(
      { agentId: 'bot-a', sessionId: 'acp-1' },
      {
        turnId: stableTurnId('bot-a', dm('200', 'shared follow-up')),
        sessionId: 'acp-1',
        input: expect.stringContaining('shared follow-up'),
        output: 'here is my answer'
      },
      capturedBinding,
      undefined
    )
    await daemon.stop()
  })

  // A Slack/Feishu channel (external identity domain) is no longer memory-excluded
  // just for being external — it captures like any other channel. DMs stay private
  // (see the DM test below).
  it('captures post-turn memory from a Slack channel input', async () => {
    const { factory } = replyingHost('here is my answer')
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold('medium'),
      hostFactory: factory
    })
    await daemon.start()
    makeRoutable(daemon)
    const recordTurn = vi.fn(async () => {})
    ;(daemon as any).memory.recordTurnForBinding = recordTurn

    await (daemon as any).dispatch('bot-a', channelMsg('100', 'question?'), 'int-a')

    expect(await (daemon as any).store.isCaptureExcluded('bot-a', 'acp-1')).toBe(false)
    await vi.waitFor(() => expect(recordTurn).toHaveBeenCalledOnce(), WAIT)
    await daemon.stop()
  })

  it('rejects a Slack audience change on a session created from another source', async () => {
    const { factory, host } = replyingHost('here is my answer')
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold('medium'),
      hostFactory: factory
    })
    await daemon.start()

    // A headless Slack-shaped automation has no trusted external destination,
    // so this legacy-compatible first turn binds the session as local.
    await (daemon as any).dispatch('bot-a', agentMsg('100', 'scheduled context'))
    const conn = makeRoutable(daemon)
    await (daemon as any).dispatch('bot-a', channelMsg('200', 'human reply'), 'int-a')

    expect(host.prompt).toHaveBeenCalledOnce()
    expect(conn.postMessage).toHaveBeenLastCalledWith(
      'C1',
      'This thread already belongs to a session created from another source. Start a new Slack thread and mention the agent there.',
      'T1'
    )
    await daemon.stop()
  })

  it('reuses an external runtime only for the same inherited Slack source', async () => {
    const { factory, host } = replyingHost('here is my answer')
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold('medium'),
      hostFactory: factory
    })
    await daemon.start()
    const conn = makeRoutable(daemon)
    const callMeta = (resourceKey: string) => ({
      callFrom: 'caller-agent',
      hopCount: 1,
      deliveryId: `delivery-${resourceKey}`,
      externalOrigin: {
        provider: 'slack',
        realmKey: 'T1',
        resourceKind: 'conversation',
        resourceKey
      }
    })

    await (daemon as any).dispatch('bot-a', channelMsg('100', 'human context'), 'int-a')
    await (daemon as any).dispatch('bot-a', agentMsg('200', 'same audience'), 'int-a', undefined, callMeta('C1'))
    await (daemon as any).dispatch('bot-a', agentMsg('300', 'different audience'), 'int-a', undefined, callMeta('C2'))

    expect(host.prompt).toHaveBeenCalledTimes(2)
    expect(conn.postMessage).not.toHaveBeenCalledWith(
      'C1',
      expect.stringContaining('already belongs to a session created from another source'),
      'T1'
    )
    await daemon.stop()
  })

  // A cross-channel root post used to seed its new thread with the ORIGIN conversation's audience,
  // so the first human reply there rejected as a cross-source turn — and the session claimed the
  // readers of a channel it does not live in. The seed binds where the post LANDED.
  it('binds an agent root post in another channel to that channel, not the origin', async () => {
    const { factory, host } = replyingHost('here is my answer')
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold('medium'),
      hostFactory: factory
    })
    await daemon.start()
    const conn = makeRoutable(daemon)

    // The origin turn runs in C1 and binds that channel's audience.
    await (daemon as any).dispatch('bot-a', channelMsg('100', 'say hi in C2'), 'int-a')
    // …then the agent posts a channel ROOT into C2, which seeds C2's new thread.
    await (daemon as any).collab.spawnChannelRootSession({
      agentId: 'bot-a',
      platform: 'slack',
      integrationId: 'int-a',
      channel: 'C2',
      thread: '300.1',
      postTs: '300.1',
      text: 'Hi! 👋',
      originTransportScope: TRANSPORT_SCOPE,
      originChannel: 'C1',
      originThread: 'T1'
    })
    const seededKey = sessionKey('slack', 'C2', '300.1', 'bot-a', TRANSPORT_SCOPE)
    await vi.waitFor(async () => {
      expect(await (daemon as any).store.getSession(seededKey)).toBeTruthy()
    }, WAIT)
    expect(await (daemon as any).store.getSession(seededKey)).toMatchObject({
      sourceBindingKind: 'external',
      // Reported to the CP so the row is classified by THIS conversation instead of
      // inheriting the parent's audience (session-visibility.md §4.2).
      directDestination: 1,
      externalProvider: 'slack',
      externalRealmKey: 'T1',
      externalResourceKind: 'conversation',
      // Pre-fix: 'C1', inherited from the origin session — the reply below then rejected.
      externalResourceKey: 'C2'
    })

    const reply = { ...channelMsg('400', 'hello'), msgId: 'slack:C2:400', channel: 'C2', thread: '300.1' }
    await (daemon as any).dispatch('bot-a', reply, 'int-a')

    expect(conn.postMessage).not.toHaveBeenCalledWith(
      'C2',
      expect.stringContaining('already belongs to a session created from another source'),
      '300.1'
    )
    expect(host.prompt).toHaveBeenCalledTimes(2)
    await daemon.stop()
  })

  // session-visibility.md §5.1: managed memory is agent-scoped and shared across
  // users, so a private conversation must never be distilled into it. A DM is
  // private from its first turn, with no CP round-trip.
  it('never captures post-turn memory from a private DM session', async () => {
    const { factory } = replyingHost('here is my answer')
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold('medium'),
      hostFactory: factory
    })
    await daemon.start()
    makeRoutable(daemon)
    const recordTurn = vi.fn(async () => {})
    ;(daemon as any).memory.recordTurnForBinding = recordTurn

    await (daemon as any).dispatch('bot-a', dm('100', 'question?'), 'int-a')

    expect(await (daemon as any).store.isCaptureExcluded('bot-a', 'acp-1')).toBe(true)
    expect(recordTurn).not.toHaveBeenCalled()
    await daemon.stop()
  })

  // Reads are always allowed (#653): automatic recall runs even for a private DM
  // or an A2A child. Only WRITES (memory write tools + post-turn distillation) stay
  // gated for isolated sessions.
  it('runs automatic recall for a private DM (reads are always allowed, #653)', async () => {
    const { factory } = replyingHost('here is my answer')
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold('medium'),
      hostFactory: factory
    })
    await daemon.start()
    makeRoutable(daemon)
    const recallForTurn = vi.spyOn((daemon as any).memory, 'recallForTurn').mockResolvedValue([])

    await (daemon as any).dispatch('bot-a', dm('100', 'private question'), 'int-a')

    expect(recallForTurn).toHaveBeenCalledOnce()
    await daemon.stop()
  })

  it('runs automatic recall for an A2A child (reads are always allowed, #653)', async () => {
    const { factory } = replyingHost('here is my answer')
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold('medium'),
      hostFactory: factory
    })
    await daemon.start()
    makeRoutable(daemon)
    const recallForTurn = vi.spyOn((daemon as any).memory, 'recallForTurn').mockResolvedValue([])
    const callMeta = (deliveryId: string) => ({ callFrom: 'caller-agent', hopCount: 1, deliveryId })

    await (daemon as any).dispatch('bot-a', agentMsg('100', 'delegated task'), 'int-a', undefined, callMeta('d1'))

    expect(recallForTurn).toHaveBeenCalledOnce()
    await daemon.stop()
  })

  it('uses the stable bot name in linked attribution instead of the display name', async () => {
    const { factory, host } = replyingHost('the answer')
    ;(host as any).modelOptions = vi.fn(() => ({ current: 'claude-sonnet-4-5' }))
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold('medium'),
      hostFactory: factory
    })
    await daemon.start()
    ;(daemon as any).runtimeFacts.names.claude = 'Claude Code'
    ;(daemon as any).agents.get('bot-a').displayName = 'Repo Bot'
    const conn = makeRoutable(daemon)

    await (daemon as any).dispatch('bot-a', dm('100', 'q'), 'int-a')

    expect(conn.postMessage).toHaveBeenCalledWith('C1', 'the answer', 'T1', {
      username: 'Repo Bot',
      agentAuthorId: 'bot-a',
      response: streamingResponse(),
      trailingBlocks: [classicFooter('bot-a', 'Claude Code', 'claude-sonnet-4-5')]
    })
    expect(conn.updateBlocks.mock.calls.some((call) => call[1] === 'reply-1')).toBe(false)
    // Only the reply, never the footer chrome, is in the transcript.
    const botRows = (await transcript(daemon)).filter((r) => r.sender === 'bot-a')
    expect(botRows.map((r) => r.text)).toEqual(['the answer'])
    await daemon.stop()
  })

  it('marks the last admitted agent turn in the attached Slack footer', async () => {
    const { factory } = replyingHost('the final autonomous answer')
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold('medium'),
      hostFactory: factory
    })
    await daemon.start()
    const conn = makeRoutable(daemon)

    await (daemon as any).dispatch('bot-a', agentMsg('100', 'continue'), 'int-a', undefined, {
      callFrom: 'caller-agent',
      hopCount: MAX_AGENT_CALL_HOPS - 1,
      deliveryId: 'last-hop'
    })

    expect(conn.postMessage).toHaveBeenCalledWith('C1', 'the final autonomous answer', 'T1', {
      username: 'bot-a',
      agentAuthorId: 'bot-a',
      response: streamingResponse(MAX_AGENT_CALL_HOPS - 1),
      trailingBlocks: [
        expect.objectContaining({
          type: 'context',
          elements: [
            expect.objectContaining({
              text: expect.stringContaining(
                `Agent conversation stopped after reaching the ${MAX_AGENT_CALL_HOPS}-hop limit.`
              )
            })
          ]
        })
      ]
    })
    const separateNotice = conn.postMessage.mock.calls.find(
      (call) => call[1] === `Agent conversation stopped after reaching the ${MAX_AGENT_CALL_HOPS}-hop limit.`
    )
    expect(separateNotice).toBeUndefined()
    await daemon.stop()
  })

  it('uses session-scoped model metadata refreshed at turn completion', async () => {
    const { factory, host } = replyingHost('the answer')
    let model = 'model-before-prompt'
    ;(host as any).modelOptions = vi.fn(() => ({ current: model }))
    const prompt = host.prompt
    host.prompt = vi.fn(async (sid: string) => {
      const result = await prompt(sid)
      model = 'model-after-prompt'
      return result
    })
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold('medium'),
      hostFactory: factory
    })
    await daemon.start()
    const conn = makeRoutable(daemon)

    await (daemon as any).dispatch('bot-a', dm('100', 'q'), 'int-a')

    expect(conn.postMessage).toHaveBeenCalledWith('C1', 'the answer', 'T1', {
      username: 'bot-a',
      agentAuthorId: 'bot-a',
      response: streamingResponse(),
      trailingBlocks: [classicFooter('bot-a', 'claude', 'model-after-prompt')]
    })
    await daemon.stop()
  })

  it('never resends linked footer blocks when model metadata changes after an early flush', async () => {
    let onUpdate!: (sid: string, update: unknown) => void
    let model = 'model-before-prompt'
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-1'),
      modelOptions: vi.fn(() => ({ current: model })),
      prompt: vi.fn(async (sid: string) => {
        onUpdate(sid, text('early answer'))
        onUpdate(sid, tool('t1', 'Read file.ts'))
        await vi.waitFor(
          () => expect(conn.postMessage).toHaveBeenCalledWith('C1', 'early answer', 'T1', expect.anything()),
          WAIT
        )
        model = 'model-after-prompt'
        return 'end_turn'
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold('low'),
      hostFactory: (_agent, callback) => {
        onUpdate = callback
        return host as any
      }
    })
    await daemon.start()
    const conn = makeRoutable(daemon)

    await (daemon as any).dispatch('bot-a', dm('100', 'q'), 'int-a')

    expect(conn.postMessage).toHaveBeenCalledWith('C1', 'early answer', 'T1', {
      username: 'bot-a',
      agentAuthorId: 'bot-a',
      response: streamingResponse(),
      trailingBlocks: [classicFooter('bot-a', 'claude', 'model-before-prompt')]
    })
    const linkedReplyUpdates = conn.updateBlocks.mock.calls.filter(
      (call) => call[1] === 'reply-1' && JSON.stringify(call[2]).includes('open in session')
    )
    expect(linkedReplyUpdates).toEqual([])
    await daemon.stop()
  })

  it('minimal mode: includes the footer in the initial live-reply post', async () => {
    const { factory } = replyingHost('here is my answer')
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold('minimal'),
      hostFactory: factory
    })
    await daemon.start()
    const conn = makeRoutable(daemon)

    await (daemon as any).dispatch('bot-a', dm('100', 'q'), 'int-a')

    // The live reply is born with the footer instead of flashing body-only until finalization.
    expect(conn.postMessage).toHaveBeenCalledWith('C1', 'here is my answer', 'T1', {
      username: 'bot-a',
      agentAuthorId: 'bot-a',
      response: streamingResponse(),
      trailingBlocks: [classicFooter()]
    })
    expect(conn.updateBlocks.mock.calls.some((call) => call[1] === 'reply-1')).toBe(false)
    const separateFooter = conn.postBlocks.mock.calls.find((c) => JSON.stringify(c).includes('open in session'))
    expect(separateFooter).toBeUndefined()
    await daemon.stop()
  })

  it('minimal mode: delivers an over-limit final reply across messages and attaches the footer last', async () => {
    const reply = `${'a'.repeat(12_000)}\nsecond section`
    const { factory } = replyingHost(reply)
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold('minimal'),
      hostFactory: factory
    })
    await daemon.start()
    const conn = makeRoutable(daemon)

    await (daemon as any).dispatch('bot-a', dm('100', 'q'), 'int-a')

    const replyPosts = conn.postMessage.mock.calls.map((call) => call[1] as string)
    expect(replyPosts.length).toBeGreaterThan(1)
    expect(replyPosts.join('')).toBe(reply)
    const postOptions = conn.postMessage.mock.calls.map((call) => call[3])
    expect(postOptions.every((options) => JSON.stringify(options?.trailingBlocks).includes('open in session'))).toBe(
      true
    )
    expect(conn.updateBlocks).toHaveBeenCalledWith(
      'C1',
      'reply-1',
      [{ type: 'markdown', text: replyPosts[0] }],
      undefined,
      false,
      'bot-a'
    )
    expect(conn.updateBlocks.mock.calls.some((call) => call[1] === `reply-${replyPosts.length}`)).toBe(false)
    expect(
      (await transcript(daemon))
        .filter((row) => row.sender === 'bot-a')
        .map((row) => row.text)
        .join('')
    ).toBe(reply)
    await daemon.stop()
  })

  it('minimal mode: re-anchors the live reply below a card that needs human input', async () => {
    let onUpdate!: (sid: string, update: unknown) => void
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-1'),
      prompt: vi.fn(async (sid: string) => {
        // Segment 1 streams and settles into the single live reply (reply-1).
        onUpdate(sid, text('first part'))
        onUpdate(sid, tool('t1', 'Read one'))
        await vi.waitFor(
          () =>
            expect(conn.postMessage).toHaveBeenCalledWith('C1', expect.stringContaining('first part'), 'T1', {
              username: 'bot-a',
              agentAuthorId: 'bot-a',
              response: streamingResponse(),
              trailingBlocks: [classicFooter()]
            }),
          WAIT
        )
        // A permission / elicitation card is posted mid-turn (its handler calls this). The
        // live reply (reply-1) now sits ABOVE the card, so the next segment must start a
        // FRESH reply BELOW it — not edit reply-1 in place above the question.
        const p = [...(daemon as any).pending.values()][0]
        ;(daemon as any).reanchorInPlaceChrome(p)
        await p.signals.applyChain
        onUpdate(sid, text('second part'))
        onUpdate(sid, tool('t2', 'Read two'))
        await vi.waitFor(
          () =>
            expect(conn.postMessage).toHaveBeenCalledWith('C1', expect.stringContaining('second part'), 'T1', {
              username: 'bot-a',
              agentAuthorId: 'bot-a',
              response: streamingResponse(),
              trailingBlocks: [classicFooter()]
            }),
          WAIT
        )
        return 'end_turn'
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold('minimal'),
      hostFactory: (_agent, callback) => {
        onUpdate = callback
        return host as any
      }
    })
    await daemon.start()
    const conn = makeRoutable(daemon)
    ;(conn as any).updateMessage = vi.fn(async () => {})

    await (daemon as any).dispatch('bot-a', dm('100', 'q'), 'int-a')

    // Each segment is its OWN posted message — reply-1 above the card, reply-2 below it.
    const posts = conn.postMessage.mock.calls.map((c) => String(c[1]))
    expect(posts.some((t) => t.includes('first part'))).toBe(true)
    expect(posts.some((t) => t.includes('second part'))).toBe(true)
    expect(conn.updateBlocks).toHaveBeenCalledWith(
      'C1',
      'reply-1',
      [{ type: 'markdown', text: 'first part' }],
      undefined,
      false,
      'bot-a'
    )
    // reply-1 (above the card) is never edited to show the post-card segment.
    expect((conn as any).updateMessage).not.toHaveBeenCalledWith(
      'C1',
      'reply-1',
      expect.stringContaining('second part')
    )
    await daemon.stop()
  })

  it('serializes a human-input card behind chrome already queued on the apply chain', async () => {
    // The card must not race pre-card chrome: both funnel through the connection's send-queue
    // in call order, so a reply/status message whose applyChain step hasn't run yet would be
    // sent AFTER — and land BELOW — the card. Serializing the post on the chain keeps it above.
    const { factory } = replyingHost('x')
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold('minimal'),
      hostFactory: factory
    })
    await daemon.start()

    const order: string[] = []
    let releaseChrome!: () => void
    const chromeSent = new Promise<void>((r) => (releaseChrome = r))
    const conn = {
      postBlocks: vi.fn(async () => {
        order.push('card')
        return 'card-ts'
      })
    }
    // A pre-card chrome send is already queued on the chain but has not flushed yet.
    const p: any = { conn, chrome: {}, signals: { applyChain: chromeSent.then(() => void order.push('chrome')) } }

    const cardPromise = (daemon as any).postCardSerialized(p, (sc: any) => sc.postBlocks())
    // Give microtasks a chance: the card still must NOT post while the queued chrome is pending.
    await new Promise((r) => setTimeout(r, 10))
    expect(conn.postBlocks).not.toHaveBeenCalled()
    expect(order).toEqual([])

    releaseChrome()
    const ts = await cardPromise
    expect(ts).toBe('card-ts')
    expect(order).toEqual(['chrome', 'card']) // pre-card chrome above, card below
    await daemon.stop()
  })

  it('moves the attached footer to the latest body section across a flush boundary', async () => {
    const { factory } = streamingHost([text('first section'), tool('t1', 'Read file.ts'), text('last section')])
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold('low'), hostFactory: factory })
    await daemon.start()
    const conn = makeRoutable(daemon)

    await (daemon as any).dispatch('bot-a', dm('100', 'q'), 'int-a')

    expect(conn.postMessage.mock.calls.map((call) => call[1])).toEqual(['first section', 'last section'])
    expect(conn.postMessage.mock.calls.map((call) => call[3]?.trailingBlocks)).toEqual([
      [classicFooter()],
      [classicFooter()]
    ])
    expect(conn.updateBlocks).toHaveBeenCalledWith(
      'C1',
      'reply-1',
      [{ type: 'markdown', text: 'first section' }],
      undefined,
      false,
      'bot-a'
    )
    expect(conn.updateBlocks.mock.calls.some((call) => call[1] === 'reply-2')).toBe(false)
    await daemon.stop()
  })

  it('retries a failed stale-footer cleanup at finalization', async () => {
    const { factory } = streamingHost([text('first section'), tool('t1', 'Read file.ts'), text('last section')])
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold('low'), hostFactory: factory })
    await daemon.start()
    const conn = makeRoutable(daemon)
    ;(conn.updateBlocks as any).mockRejectedValueOnce(new Error('queue timeout')).mockResolvedValueOnce(true)

    await (daemon as any).dispatch('bot-a', dm('100', 'q'), 'int-a')

    expect(conn.updateBlocks.mock.calls.filter((call) => call[1] === 'reply-1')).toEqual([
      ['C1', 'reply-1', [{ type: 'markdown', text: 'first section' }], undefined, false, 'bot-a'],
      ['C1', 'reply-1', [{ type: 'markdown', text: 'first section' }], undefined, false, 'bot-a']
    ])
    await daemon.stop()
  })

  it('keeps the prior footer when a later body post returns no timestamp', async () => {
    const { factory } = streamingHost([text('first section'), tool('t1', 'Read file.ts'), text('last section')])
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold('low'), hostFactory: factory })
    await daemon.start()
    const conn = makeRoutable(daemon)
    ;(conn.postMessage as any).mockResolvedValueOnce('reply-1').mockResolvedValueOnce(undefined)

    await (daemon as any).dispatch('bot-a', dm('100', 'q'), 'int-a')

    expect(conn.postMessage.mock.calls.map((call) => call[1])).toEqual(['first section', 'last section'])
    expect(conn.updateBlocks.mock.calls.some((call) => call[1] === 'reply-1')).toBe(false)
    await daemon.stop()
  })

  it('does not create an orphan attribution message when the turn has no reply body', async () => {
    const { factory } = streamingHost([tool('t1', 'Read file.ts')])
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold('high'), hostFactory: factory })
    await daemon.start()
    const conn = makeRoutable(daemon)

    await (daemon as any).dispatch('bot-a', dm('100', 'q'), 'int-a')

    // High mode still posts tool-progress chrome, but that is not an agent reply body
    // and must not become the attribution target. It's marked `chrome` so the backfill skips
    // it, and carries the one identity policy (agent name on every surface, DMs included).
    expect(conn.postMessage).toHaveBeenCalledWith('C1', expect.stringContaining('Read file.ts'), 'T1', {
      chrome: true,
      username: 'bot-a'
    })
    expect(conn.postMessage.mock.calls.some((call) => call[3]?.trailingBlocks)).toBe(false)
    await daemon.stop()
  })

  it('does not attach agent attribution to a daemon-generated failure notice', async () => {
    const { factory, host } = streamingHost([])
    host.prompt = vi.fn(async () => {
      throw new Error('runtime exploded')
    })
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold('medium'),
      hostFactory: factory
    })
    await daemon.start()
    const conn = makeRoutable(daemon)

    await expect((daemon as any).dispatch('bot-a', dm('100', 'q'), 'int-a')).rejects.toThrow('runtime exploded')

    const failure = conn.postMessage.mock.calls.find((call) => String(call[1]).includes('Agent failed to respond'))
    expect(failure?.[3]?.trailingBlocks).toBeUndefined()
    await daemon.stop()
  })

  it('retries stale-footer cleanup when prompt failure bypasses normal attribution finalization', async () => {
    let onUpdate!: (sid: string, update: unknown) => void
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-1'),
      prompt: vi.fn(async (sid: string) => {
        onUpdate(sid, text('first section'))
        onUpdate(sid, tool('t1', 'Read one'))
        await vi.waitFor(
          () => expect(conn.postMessage).toHaveBeenCalledWith('C1', 'first section', 'T1', expect.anything()),
          WAIT
        )
        onUpdate(sid, text('second section'))
        onUpdate(sid, tool('t2', 'Read two'))
        await vi.waitFor(
          () => expect(conn.postMessage).toHaveBeenCalledWith('C1', 'second section', 'T1', expect.anything()),
          WAIT
        )
        throw new Error('runtime exploded')
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold('low'),
      hostFactory: (_agent, callback) => {
        onUpdate = callback
        return host as any
      }
    })
    await daemon.start()
    const conn = makeRoutable(daemon)
    ;(conn.updateBlocks as any).mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    await expect((daemon as any).dispatch('bot-a', dm('100', 'q'), 'int-a')).rejects.toThrow('runtime exploded')

    expect(conn.updateBlocks.mock.calls.filter((call) => call[1] === 'reply-1')).toEqual([
      ['C1', 'reply-1', [{ type: 'markdown', text: 'first section' }], undefined, false, 'bot-a'],
      ['C1', 'reply-1', [{ type: 'markdown', text: 'first section' }], undefined, false, 'bot-a']
    ])
    await daemon.stop()
  })

  it('a replayed reply is filtered out of its own author’s catch-up context', async () => {
    const { factory } = replyingHost('my first reply')
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold('medium'),
      hostFactory: factory
    })
    await daemon.start()
    makeRoutable(daemon)

    await (daemon as any).dispatch('bot-a', dm('100', 'first'), 'int-a')
    await (daemon as any).dispatch('bot-a', dm('200', 'second'), 'int-a')

    // The agent's own reply is in the transcript but must never be replayed back to it
    // as "context you may have missed" — only the human's intervening message would be.
    const sessionThread = (daemon as any).sessions
    const { blocks } = await sessionThread.handle('bot-a', dm('300', 'third'))
    const replayed = (blocks as { text: string }[]).map((b) => b.text).join('\n')
    expect(replayed).not.toContain('my first reply')
    expect(replayed).toContain('third')
    await daemon.stop()
  })
})

describe('Daemon transcript captures the full activity log (mode-independent)', () => {
  const turn = [
    thought('let me think about'),
    thought(' this problem'),
    tool('t1', 'Read file.ts'),
    text('here is the answer')
  ]

  // The agent's tool calls + reasoning must land in the transcript in EVERY output
  // mode — output mode only gates what reaches Slack, never what is recorded.
  for (const mode of ['low', 'medium', 'high'] as const) {
    it(`${mode} mode: tool + reasoning + text are all recorded with their kind`, async () => {
      const { factory } = streamingHost(turn)
      const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold(mode), hostFactory: factory })
      await daemon.start()
      makeRoutable(daemon)

      await (daemon as any).dispatch('bot-a', dm('100', 'go'), 'int-a')

      expect(await activity(daemon)).toEqual([
        { kind: 'text', sender: 'U1', text: 'go' },
        { kind: 'reasoning', sender: 'bot-a', text: 'let me think about this problem' },
        { kind: 'tool', sender: 'bot-a', text: 'Read file.ts' },
        { kind: 'text', sender: 'bot-a', text: 'here is the answer' }
      ])
      await daemon.stop()
    })
  }

  it('tool/reasoning rows are excluded from §8.5 catch-up replay', async () => {
    const { factory } = streamingHost(turn)
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold('low'), hostFactory: factory })
    await daemon.start()
    makeRoutable(daemon)

    await (daemon as any).dispatch('bot-a', dm('100', 'go'), 'int-a')

    // A *different* agent replaying the thread sees conversational text only — never
    // bot-a's tool calls or reasoning fed back as "context you may have missed".
    const gap = await (daemon as any).store.transcriptSince(TRANSCRIPT_CHANNEL, 'T1', null)
    expect(gap.every((r: TranscriptEntry) => r.kind === 'text')).toBe(true)
    expect(gap.map((r: TranscriptEntry) => r.text)).toEqual(['go', 'here is the answer'])
    await daemon.stop()
  })

  it('masks write-only secret values out of every recorded and delivered surface', async () => {
    // The agent echoes the secret in its reply text, tool title, rawInput, and
    // rawOutput (the classic `env | grep` case) — none of them may reach the
    // await transcript (console "View detail") or the Slack post in plaintext.
    const { factory } = streamingHost([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'env | grep TestSA',
        rawInput: { command: 'curl -H "Authorization: s3cret-value"' }
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        rawOutput: { output: 'TestSA=s3cret-value\n' }
      },
      thought('the secret is s3cret-value'),
      text('yes, TestSA is set to s3cret-value')
    ])
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold('medium', {
        runtimeOverrides: { secrets: [{ name: 'TestSA', value: 's3cret-value' }] }
      }),
      hostFactory: factory
    })
    await daemon.start()
    const conn = makeRoutable(daemon)

    await (daemon as any).dispatch('bot-a', dm('100', 'is TestSA in the env?'), 'int-a')

    const rows = await (daemon as any).store.threadTranscript(TRANSCRIPT_CHANNEL, 'T1')
    expect(JSON.stringify(rows)).not.toContain('s3cret-value')
    const reply = rows.find((r: any) => r.kind === 'text' && r.sender === 'bot-a')
    expect(reply.text).toBe('yes, TestSA is set to [secret:TestSA]')
    const toolRow = rows.find((r: any) => r.kind === 'tool')
    expect(toolRow.body).toContain('[secret:TestSA]')
    // nothing that went to Slack (reply, status bar, cards) carries the value either
    const posted = JSON.stringify([
      conn.postMessage.mock.calls,
      conn.postBlocks.mock.calls,
      conn.updateBlocks.mock.calls
    ])
    expect(posted).not.toContain('s3cret-value')
    expect(posted).toContain('[secret:TestSA]')
    await daemon.stop()
  })

  it('a burst of tool_call_update for one call collapses to a single tool row', async () => {
    const { factory } = streamingHost([
      tool('t1', 'Edit file.ts'),
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
      text('done')
    ])
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold('medium'),
      hostFactory: factory
    })
    await daemon.start()
    makeRoutable(daemon)

    await (daemon as any).dispatch('bot-a', dm('100', 'go'), 'int-a')

    const tools = (await activity(daemon)).filter((r) => r.kind === 'tool')
    expect(tools).toEqual([{ kind: 'tool', sender: 'bot-a', text: 'Edit file.ts' }])
    await daemon.stop()
  })
})
