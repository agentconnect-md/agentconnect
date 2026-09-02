import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import type { RdAck, RdChatEvent, RdMsgWebchat } from '@agentconnect.md/protocol'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

// Session-targeted webchat continuation (webchat-cross-integration-continuation.md
// §5.2/§6.4): a browser turn carrying `targetSessionId` dispatches onto the target
// session's own Slack coordinates — same logical session, no new row — with the
// attributed human mirror posted to the origin thread BEFORE dispatch, and the
// reply streamed to the webchat sink while turn output follows the platform rules.

const AGENT = 'bot-a'
const CONV = '99999999-9999-4999-8999-999999999999'
const TARGET_ACP = 'acp-target-1'
const KEY = `slack:C1:100.1:${AGENT}`

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-wc-sess-cont-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      features: { turnFinalContextRefresh: true },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const adir = join(root, 'agents', AGENT)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: AGENT,
      name: AGENT,
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [{ id: 'int-a', platform: 'slack' }],
      output: { mode: 'medium' }
    })
  )
  return root
}

function scriptedHost(reply: (prompt: string) => string) {
  const prompts: Array<{ agentId: string; sid: string; text: string }> = []
  let sessionSeq = 0
  const factory = (agent: { id: string }, onUpdate: (sid: string, u: unknown) => void) =>
    ({
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => `acp-fresh-${++sessionSeq}`),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async (sid: string, blocks: { text?: string }[]) => {
        const text = blocks.map((b) => b.text ?? '').join('\n')
        prompts.push({ agentId: agent.id, sid, text })
        onUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply(text) } })
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }) as never
  return { factory, prompts }
}

async function boot(reply: (prompt: string) => string = () => 'done') {
  const { factory, prompts } = scriptedHost(reply)
  const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold(), hostFactory: factory })
  await daemon.start()
  ;(daemon as never as { cpClient: unknown }).cpClient = {
    emitUsageReport: vi.fn(),
    emitSessionActivity: vi.fn(),
    // Org-scoped: this daemon owns its agents outright and is not duty-governed.
    organizationScope: () => 'connection' as const,
    stop: vi.fn(async () => {})
  }
  const d = daemon as never as {
    store: {
      upsertSession(rec: Record<string, unknown>): void
      setSessionClassification(key: string, c: Record<string, unknown>): void
      getSession(key: string): { acpSessionId: string | null } | undefined
      sessionsForAgent?(agentId: string): unknown[]
    }
    connByIntegration: Map<string, unknown>
    inflight: Set<string>
    handleRelayMsg(msg: RdMsgWebchat, chat: (e: RdChatEvent) => void): RdAck | Promise<RdAck>
  }
  await d.store.upsertSession({
    key: KEY,
    agentId: AGENT,
    platform: 'slack',
    channel: 'C1',
    thread: '100.1',
    acpSessionId: TARGET_ACP,
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: Date.now()
  })
  await d.store.setSessionClassification(KEY, {
    sourceBindingKind: 'external',
    externalProvider: 'slack',
    externalRealmKey: 'T1',
    externalResourceKind: 'conversation',
    externalResourceKey: 'C1',
    externalIntegrationId: 'int-a'
  })
  const postMessage = vi.fn(async () => '100.200000')
  d.connByIntegration.set('int-a', { postMessage, workspaceId: () => 'T1' })
  return { daemon, d, prompts, postMessage }
}

const PICTURE = 'https://cdn.example.test/avatars/user-1.png'

const turn = (text: string, over: Partial<RdMsgWebchat> = {}): RdMsgWebchat => ({
  source: 'webchat',
  agentId: AGENT,
  sessionKey: CONV,
  msgId: `m-${Math.random().toString(36).slice(2)}`,
  chatId: CONV,
  targetSessionId: TARGET_ACP,
  payload: { op: 'turn', text, user: 'owner' },
  ...over
})

describe('webchat session-targeted continuation', () => {
  it('mirrors the human turn first, dispatches onto the target session key, and streams the reply', async () => {
    const order: string[] = []
    const { daemon, d, prompts, postMessage } = await boot(() => {
      order.push('prompt')
      return 'continued!'
    })
    let releaseMirror!: () => void
    const mirror = new Promise<string>((resolve) => {
      releaseMirror = () => resolve('100.200000')
    })
    postMessage.mockImplementation(() => {
      order.push('mirror')
      return mirror
    })
    const events: RdChatEvent[] = []

    const ackPending = d.handleRelayMsg(turn('hello from console'), (e) => events.push(e))
    await vi.waitFor(() => expect(d.inflight.size).toBe(1), WAIT)
    expect(prompts).toHaveLength(0)
    releaseMirror()
    const ack = await ackPending
    expect(ack).toMatchObject({ accepted: true })

    await vi.waitFor(() => expect(events.some((e) => e.kind === 'done')).toBe(true), WAIT)
    // Mirror is attributed and lands on the origin thread BEFORE the model runs.
    expect(postMessage).toHaveBeenCalledWith(
      'C1',
      'hello from console',
      '100.1',
      expect.objectContaining({ agentAuthorId: AGENT, username: 'owner' })
    )
    expect(order[0]).toBe('mirror')
    expect(order).toContain('prompt')
    // The turn entered the TARGET session (same logical row, no webchat session).
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.text).toContain('hello from console')
    expect(await d.store.getSession(KEY)).toBeDefined()
    expect(await d.store.getSession(`webchat:${CONV}:webchat:${CONV}:${AGENT}`)).toBeUndefined()
    // The reply streamed to the browser sink.
    const outputs = events.filter((e) => e.kind === 'output')
    expect(outputs.length).toBeGreaterThan(0)
    await daemon.stop()
  })

  it('delivers the agent reply to the origin platform AND the browser sink (§5.2 dual sinks)', async () => {
    const order: string[] = []
    const { daemon, d, postMessage } = await boot(() => 'dual-sink reply!')
    postMessage.mockImplementation(async (...args: unknown[]) => {
      order.push(`slack:${args[1]}`)
      return '100.200000'
    })
    const events: RdChatEvent[] = []

    const ack = await d.handleRelayMsg(turn('to both'), (e) => {
      if (e.kind === 'done') order.push('done')
      events.push(e)
    })
    expect(ack).toMatchObject({ accepted: true })
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'done')).toBe(true), WAIT)
    // The reply streamed to the browser sink…
    expect(events.some((e) => e.kind === 'output')).toBe(true)
    // …AND posted to the origin Slack thread under the ordinary output rules
    // (the attributed human mirror is the other postMessage call).
    expect(order).toContain('slack:to both')
    expect(order).toContain('slack:dual-sink reply!')
    // The browser `done` settles only AFTER the platform flush — the console must not
    // unlock its composer (and mirror a next turn) ahead of this reply landing on Slack.
    expect(order.indexOf('slack:dual-sink reply!')).toBeLessThan(order.indexOf('done'))
    await daemon.stop()
  })

  it('refuses the turn when the platform mirror fails — the agent never consumes hidden input', async () => {
    const { daemon, d, prompts, postMessage } = await boot()
    postMessage.mockRejectedValue(new Error('channel_not_found'))

    const ack = await d.handleRelayMsg(turn('hidden?'), () => {})
    expect(ack).toMatchObject({ accepted: false, reason: 'integration_delivery_failed' })
    expect(prompts).toHaveLength(0)
    await vi.waitFor(() => expect(d.inflight.size).toBe(0), WAIT)
    await daemon.stop()
  })

  it('rejects a stale target, refuses runtime-set ops, and no-ops context for a targeted conversation', async () => {
    const { daemon, d, prompts } = await boot()

    const stale = await d.handleRelayMsg(turn('x', { targetSessionId: 'acp-vanished' }), () => {})
    expect(stale).toMatchObject({ accepted: false, reason: 'not_found' })

    const setModel = (await d.handleRelayMsg(
      turn('', { payload: { op: 'set_model', model: 'opus' } }),
      () => {}
    )) as RdAck
    expect(setModel).toMatchObject({ accepted: false })

    const context = (await d.handleRelayMsg(
      turn('', {
        payload: {
          op: 'context',
          post: {
            postId: '11111111-1111-4111-8111-111111111111',
            conversationId: CONV,
            text: 'ctx',
            at: 1,
            author: { kind: 'user', user: 'owner' }
          }
        }
      }),
      () => {}
    )) as RdAck
    expect(context).toMatchObject({ accepted: true })

    expect(prompts).toHaveLength(0)
    await daemon.stop()
  })

  it('refuses with integration_offline when the session platform has no live connection', async () => {
    const { daemon, d, prompts } = await boot()
    d.connByIntegration.delete('int-a')

    const ack = await d.handleRelayMsg(turn('offline'), () => {})
    expect(ack).toMatchObject({ accepted: false, reason: 'integration_offline' })
    expect(prompts).toHaveLength(0)
    await daemon.stop()
  })

  it('treats an undefined provider result as a failed mirror — delivery must be proven by a message id', async () => {
    const { daemon, d, prompts, postMessage } = await boot()
    // Discord/Feishu swallow send errors and resolve undefined; Slack can land nothing.
    postMessage.mockResolvedValue(undefined as never)

    const ack = await d.handleRelayMsg(turn('unproven'), () => {})
    expect(ack).toMatchObject({ accepted: false, reason: 'integration_delivery_failed' })
    expect(prompts).toHaveLength(0)
    await vi.waitFor(() => expect(d.inflight.size).toBe(0), WAIT)
    await daemon.stop()
  })
})

// ── mirror routing claim (§5.2) ──────────────────────────────────────────────
// The mirror takes the same two-step shape an ordinary agent reply does: an
// attributed body post, then a finalizing chat.update stamping the trusted
// routing claim — the `message_changed` event is the one shape every Slack
// ingress (same-app echo included) admits before own-echo suppression. Peer
// activation from a verified final is pinned by
// daemon-agent-mention-routing.test.ts; the target author is excluded there
// and gets the targeted dispatch instead.

describe('webchat session-targeted continuation — mirror identity', () => {
  it("posts the Slack mirror under the console author's own name and avatar, with no attribution prefix", async () => {
    const { daemon, d, postMessage } = await boot()
    const ack = await d.handleRelayMsg(
      turn('looks off?', {
        payload: { op: 'turn', text: 'looks off?', user: 'Ada', userId: 'user-1', userPicture: PICTURE }
      }),
      () => {}
    )
    expect(ack).toMatchObject({ accepted: true })
    expect(postMessage).toHaveBeenCalledWith('C1', 'looks off?', '100.1', {
      username: 'Ada',
      icon_url: PICTURE,
      agentAuthorId: AGENT
    })
    await daemon.stop()
  })

  it('keeps the `[<user> via console]` attribution once the workspace has proven it cannot customize identity', async () => {
    const { daemon, d, postMessage } = await boot()
    d.connByIntegration.set('int-a', {
      postMessage,
      workspaceId: () => 'T1',
      identityCustomizationSuppressed: () => true
    })
    const ack = await d.handleRelayMsg(
      turn('looks off?', { payload: { op: 'turn', text: 'looks off?', user: 'Ada', userPicture: PICTURE } }),
      () => {}
    )
    expect(ack).toMatchObject({ accepted: true })
    // The app identity is what Slack will render, so the body itself must name the human.
    expect(postMessage).toHaveBeenCalledWith('C1', '[Ada via console] looks off?', '100.1', { agentAuthorId: AGENT })
    await daemon.stop()
  })
})

describe('webchat session-targeted continuation — mirror routing claim', () => {
  it('posts the attributed mirror, then finalizes it with the target-authored routing claim', async () => {
    const { daemon, d, postMessage } = await boot()
    const finalizeResponse = vi.fn(async () => true)
    d.connByIntegration.set('int-a', { postMessage, workspaceId: () => 'T1', finalizeResponse })

    const ack = await d.handleRelayMsg(turn('hello everyone'), () => {})
    expect(ack).toMatchObject({ accepted: true })

    // Step 1: the visible body post carries authorship but no routable claim.
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage).toHaveBeenCalledWith('C1', 'hello everyone', '100.1', {
      username: 'owner',
      agentAuthorId: AGENT
    })
    // Step 2: the chat.update finalization carries the final routing claim.
    expect(finalizeResponse).toHaveBeenCalledTimes(1)
    const [channel, ts, , text, author, response] = finalizeResponse.mock.calls[0]! as unknown[]
    expect(channel).toBe('C1')
    expect(ts).toBe('100.200000')
    expect(text).toBe('hello everyone')
    expect(author).toBe(AGENT)
    expect(response).toMatchObject({ deliveryState: 'final', hopCount: 0, mentionedAgentIds: [] })
    expect((response as { responseId: string }).responseId).toMatch(/^webchat-cont:/)
    await daemon.stop()
  })
})
