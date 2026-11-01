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
      transcriptPage(
        channel: string,
        thread: string,
        beforeSeq: number | null,
        limit: number,
        agentId?: string
      ): Promise<{ rows: { text: string }[] }>
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
  // The Slack mirror boundary: resolves the ts and the body that landed (bare, or attributed on fallback).
  const postAsAuthor = vi.fn(
    async (_c: string, _t: string | undefined, body: { text: string; attributedText: string }) => ({
      ts: '100.200000',
      text: body.text
    })
  )
  d.connByIntegration.set('int-a', { postMessage, postAsAuthor, workspaceId: () => 'T1' })
  return { daemon, d, prompts, postMessage, postAsAuthor }
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
    const { daemon, d, prompts, postAsAuthor } = await boot(() => {
      order.push('prompt')
      return 'continued!'
    })
    let releaseMirror!: () => void
    const mirror = new Promise<{ ts: string; text: string }>((resolve) => {
      releaseMirror = () => resolve({ ts: '100.200000', text: 'hello from console' })
    })
    postAsAuthor.mockImplementation(() => {
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
    expect(postAsAuthor).toHaveBeenCalledWith(
      'C1',
      '100.1',
      { text: 'hello from console', attributedText: '[owner via console] hello from console' },
      { name: 'owner' },
      { agentAuthorId: AGENT }
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
    const { daemon, d, postMessage, postAsAuthor } = await boot(() => 'dual-sink reply!')
    postMessage.mockImplementation(async (...args: unknown[]) => {
      order.push(`slack:${args[1]}`)
      return '100.200000'
    })
    postAsAuthor.mockImplementation(async (_c, _t, body) => {
      order.push(`slack:${body.text}`)
      return { ts: '100.200000', text: body.text }
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
    const { daemon, d, prompts, postAsAuthor } = await boot()
    postAsAuthor.mockRejectedValue(new Error('channel_not_found'))

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
    const { daemon, d, prompts, postAsAuthor } = await boot()
    // Discord/Feishu swallow send errors and resolve undefined; Slack can land nothing.
    postAsAuthor.mockResolvedValue(undefined as never)

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
  it("hands Slack the bare body plus the console author's name and avatar, with the attributed fallback", async () => {
    const { daemon, d, postAsAuthor } = await boot()
    const ack = await d.handleRelayMsg(
      turn('looks off?', {
        payload: { op: 'turn', text: 'looks off?', user: 'Ada', userId: 'user-1', userPicture: PICTURE }
      }),
      () => {}
    )
    expect(ack).toMatchObject({ accepted: true })
    expect(postAsAuthor).toHaveBeenCalledWith(
      'C1',
      '100.1',
      { text: 'looks off?', attributedText: '[Ada via console] looks off?' },
      { name: 'Ada', iconUrl: PICTURE },
      { agentAuthorId: AGENT }
    )
    await daemon.stop()
  })

  it('finalizes with the body that actually landed when Slack fell back to the attributed text', async () => {
    const { daemon, d, postMessage, postAsAuthor } = await boot()
    const finalizeResponse = vi.fn(async () => true)
    d.connByIntegration.set('int-a', { postMessage, postAsAuthor, workspaceId: () => 'T1', finalizeResponse })
    // The send boundary proved the customize scope missing on this very post and landed the attribution.
    postAsAuthor.mockImplementation(async (_c, _t, body) => ({
      ts: '100.200000',
      text: body.attributedText
    }))
    const ack = await d.handleRelayMsg(
      turn('looks off?', { payload: { op: 'turn', text: 'looks off?', user: 'Ada', userPicture: PICTURE } }),
      () => {}
    )
    expect(ack).toMatchObject({ accepted: true })
    // The routing re-stamp must re-supply the attributed body, or chat.update would strip the attribution.
    const [, , blocks, text] = finalizeResponse.mock.calls[0]! as unknown[]
    expect(text).toBe('[Ada via console] looks off?')
    expect(blocks).toEqual([{ type: 'markdown', text: '[Ada via console] looks off?' }])
    await daemon.stop()
  })
})

describe('webchat session-targeted continuation — mirror routing claim', () => {
  it('posts the attributed mirror, then finalizes it with the target-authored routing claim', async () => {
    const { daemon, d, postMessage, postAsAuthor } = await boot()
    const finalizeResponse = vi.fn(async () => true)
    d.connByIntegration.set('int-a', { postMessage, postAsAuthor, workspaceId: () => 'T1', finalizeResponse })

    const ack = await d.handleRelayMsg(turn('hello everyone'), () => {})
    expect(ack).toMatchObject({ accepted: true })

    // Step 1: the visible body post carries authorship but no routable claim.
    expect(postAsAuthor).toHaveBeenCalledTimes(1)
    expect(postAsAuthor).toHaveBeenCalledWith(
      'C1',
      '100.1',
      { text: 'hello everyone', attributedText: '[owner via console] hello everyone' },
      { name: 'owner' },
      { agentAuthorId: AGENT }
    )
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

// ── hook-origin continuation (§9) ────────────────────────────────────────────
// A GitHub / GitLab / webhook session has no platform connection and nobody on the
// far side to read a human turn: the console is its only surface. The turn runs on
// the hook session's own coordinates with the browser stream as the whole output
// path — no mirror, no platform renderer.

const HOOK_ACP = 'acp-target-hook'
const HOOK_KEY = `hook:github:42:1552:${AGENT}`

describe('webchat session-targeted continuation — hook origin', () => {
  it('runs the turn on the hook session, mirrors nothing, and records the reply in its transcript', async () => {
    const { daemon, d, prompts, postMessage } = await boot(() => 'looked again — still fine')
    await d.store.upsertSession({
      key: HOOK_KEY,
      agentId: AGENT,
      platform: 'hook',
      channel: 'github:42',
      thread: '1552',
      acpSessionId: HOOK_ACP,
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    // The binding a real GitHub fire leaves behind. Nothing re-derives a hook audience without
    // the delivery's trusted metadata, so an unmarked continuation would read as a foreign
    // audience claiming this runtime and be rejected as a source mismatch.
    await d.store.setSessionClassification(HOOK_KEY, {
      sourceBindingKind: 'external',
      externalProvider: 'github',
      externalRealmKey: 'github.com',
      externalResourceKind: 'repository',
      externalResourceKey: '42'
    })
    const makeReply = vi.spyOn((daemon as any).githubReviews, 'makeCodeHostReply')
    const events: RdChatEvent[] = []

    const ack = await d.handleRelayMsg(turn('look at the diff again', { targetSessionId: HOOK_ACP }), (e) =>
      events.push(e)
    )
    expect(ack).toMatchObject({ accepted: true })
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'done')).toBe(true), WAIT)

    // The PR thread never sees the console turn — there is no mirror and no platform post.
    expect(postMessage).not.toHaveBeenCalled()
    expect(makeReply).not.toHaveBeenCalled()
    // The turn entered the hook session itself, not a fresh webchat sibling.
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.text).toContain('look at the diff again')
    expect(await d.store.getSession(HOOK_KEY)).toBeDefined()
    expect(await d.store.getSession(`webchat:${CONV}:webchat:${CONV}:${AGENT}`)).toBeUndefined()
    // The reply streamed to the browser AND landed once in the hook session's own transcript.
    expect(events.some((e) => e.kind === 'output')).toBe(true)
    const page = await d.store.transcriptPage('github:42', '1552', null, 50, AGENT)
    const texts = page.rows.map((r) => r.text)
    expect(texts).toContain('look at the diff again')
    expect(texts.filter((t) => t === 'looked again — still fine')).toHaveLength(1)
    await daemon.stop()
  })

  it('refuses a hook target that no longer resolves, without touching the platform', async () => {
    const { daemon, d, prompts, postMessage } = await boot()
    const ack = await d.handleRelayMsg(turn('x', { targetSessionId: HOOK_ACP }), () => {})
    expect(ack).toMatchObject({ accepted: false, reason: 'not_found' })
    expect(prompts).toHaveLength(0)
    expect(postMessage).not.toHaveBeenCalled()
    await daemon.stop()
  })

  // #2500: one console line sent to several members of a merged conversation is one post, so each member's copy carries the relay's shared id and time.
  it("records the human turn under the relay's shared post id and time", async () => {
    const { daemon, d } = await boot(() => 'ok')
    await d.store.upsertSession({
      key: HOOK_KEY,
      agentId: AGENT,
      platform: 'hook',
      channel: 'github:42',
      thread: '1552',
      acpSessionId: HOOK_ACP,
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    await d.store.setSessionClassification(HOOK_KEY, {
      sourceBindingKind: 'external',
      externalProvider: 'github',
      externalRealmKey: 'github.com',
      externalResourceKind: 'repository',
      externalResourceKey: '42'
    })
    const POST_ID = '12121212-1212-4212-8212-121212121212'
    const AT = 1_790_000_000_000
    const events: RdChatEvent[] = []
    const ack = await d.handleRelayMsg(
      turn('both of you, look again', {
        targetSessionId: HOOK_ACP,
        payload: { op: 'turn', text: 'both of you, look again', user: 'owner', post: { postId: POST_ID, at: AT } }
      }),
      (e) => events.push(e)
    )
    expect(ack).toMatchObject({ accepted: true })
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'done')).toBe(true), WAIT)
    const page = await d.store.transcriptPage('github:42', '1552', null, 50, AGENT)
    const human = (page.rows as Array<{ text: string; ts?: string; postId?: string }>).find(
      (r) => r.text === 'both of you, look again'
    )
    expect(human).toMatchObject({ ts: String(AT), postId: POST_ID })
    await daemon.stop()
  })
})

// A schedule with no target channel fires on a minted `cron:<id>` channel that exists on no platform: the console is its only surface.
const CRON_ACP = 'acp-target-cron'
const CRON_CHANNEL = 'cron:11111111-1111-4111-8111-111111111111'
const CRON_THREAD = `${CRON_CHANNEL}:22222222-2222-4222-8222-222222222222`
const CRON_KEY = `slack:${CRON_CHANNEL}:${CRON_THREAD}:${AGENT}`

describe('webchat session-targeted continuation — headless cron origin', () => {
  it('runs the turn on the cron session without mirroring into its minted channel', async () => {
    const { daemon, d, prompts, postMessage, postAsAuthor } = await boot(() => 'report rerun')
    await d.store.upsertSession({
      key: CRON_KEY,
      agentId: AGENT,
      platform: 'slack',
      channel: CRON_CHANNEL,
      thread: CRON_THREAD,
      acpSessionId: CRON_ACP,
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now(),
      triggeredBy: CRON_CHANNEL
    })
    await d.store.setSessionClassification(CRON_KEY, { sourceBindingKind: 'local' })
    const events: RdChatEvent[] = []

    const ack = await d.handleRelayMsg(turn('run it again', { targetSessionId: CRON_ACP }), (e) => events.push(e))
    expect(ack).toMatchObject({ accepted: true })
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'done')).toBe(true), WAIT)

    expect(postAsAuthor).not.toHaveBeenCalled()
    expect(postMessage).not.toHaveBeenCalled()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.text).toContain('run it again')
    expect(events.some((e) => e.kind === 'output')).toBe(true)
    const page = await d.store.transcriptPage(CRON_CHANNEL, CRON_THREAD, null, 50, AGENT)
    const texts = page.rows.map((r) => r.text)
    expect(texts).toContain('run it again')
    expect(texts.filter((t) => t === 'report rerun')).toHaveLength(1)
    await daemon.stop()
  })
})

// A delegated task's coordinate is no platform thread: its page is continued console-only (auto-session-mode.md §10).
const TASK_ACP = 'acp-target-task'
const TASK_THREAD = 'subsession:4242'
const TASK_KEY = `slack:C1:${TASK_THREAD}:${AGENT}`
const PARENT_KEY = `slack:C1:100.1:${AGENT}`

describe('webchat session-targeted continuation — a delegated task', () => {
  async function seedTask(d: Awaited<ReturnType<typeof boot>>['d'], thread = TASK_THREAD) {
    const key = `slack:C1:${thread}:${AGENT}`
    await d.store.upsertSession({
      key,
      agentId: AGENT,
      platform: 'slack',
      channel: 'C1',
      thread,
      acpSessionId: TASK_ACP,
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    await d.store.setSessionClassification(key, { sourceBindingKind: 'local' })
    return key
  }

  it("runs the turn on the task without a mirror, streams the answer to the page, and leaves a settled task's parent unreported", async () => {
    const { daemon, d, prompts, postMessage, postAsAuthor } = await boot(() => 'the retry now backs off')
    const key = await seedTask(d)
    const index = (d as never as { store: { assistantSubsessions: AssistantSubsessionIndexLike } }).store
      .assistantSubsessions
    await index.open({
      agentId: AGENT,
      childSessionKey: key,
      parentSessionId: TARGET_ACP,
      parentSessionKey: PARENT_KEY,
      title: 'Retry with backoff'
    })
    await index.finish(AGENT, key, 'done')
    const events: RdChatEvent[] = []

    const ack = await d.handleRelayMsg(turn('does it back off now?', { targetSessionId: TASK_ACP }), (e) =>
      events.push(e)
    )
    expect(ack).toMatchObject({ accepted: true })
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'done')).toBe(true), WAIT)

    // Nothing reaches Slack: the task's thread is no platform thread.
    expect(postAsAuthor).not.toHaveBeenCalled()
    expect(postMessage).not.toHaveBeenCalled()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.text).toContain('does it back off now?')
    expect(events.some((e) => e.kind === 'output')).toBe(true)
    const page = await d.store.transcriptPage('C1', TASK_THREAD, null, 50, AGENT)
    const texts = page.rows.map((r) => r.text)
    expect(texts).toContain('does it back off now?')
    expect(texts.filter((t) => t === 'the retry now backs off')).toHaveLength(1)
    // The person read the answer on the page, so a settled task's parent hears nothing of it.
    const row = await index.get(AGENT, key)
    expect(row).toMatchObject({ state: 'done' })
    expect(row?.endReport).toBeUndefined()
    await daemon.stop()
  })

  it("continues a webchat conversation's task by its target, never as that conversation's own session", async () => {
    const { daemon, d, prompts } = await boot(() => 'on it')
    const parentConv = '88888888-8888-4888-8888-888888888888'
    const key = `webchat:${parentConv}:${TASK_THREAD}:${AGENT}`
    await d.store.upsertSession({
      key,
      agentId: AGENT,
      platform: 'webchat',
      channel: parentConv,
      thread: TASK_THREAD,
      acpSessionId: TASK_ACP,
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    await d.store.setSessionClassification(key, { sourceBindingKind: 'local' })
    const events: RdChatEvent[] = []
    const ack = await d.handleRelayMsg(turn('one more case', { targetSessionId: TASK_ACP }), (e) => events.push(e))
    expect(ack).toMatchObject({ accepted: true })
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'done')).toBe(true), WAIT)
    expect(prompts).toHaveLength(1)
    const page = await d.store.transcriptPage(parentConv, TASK_THREAD, null, 50, AGENT)
    expect(page.rows.map((r) => r.text)).toEqual(expect.arrayContaining(['one more case', 'on it']))
    expect(await d.store.getSession(`webchat:${parentConv}:webchat:${parentConv}:${AGENT}`)).toBeUndefined()
    await daemon.stop()
  })

  it("refuses a follow-up's check, which stays read-only", async () => {
    const { daemon, d, prompts, postMessage } = await boot()
    await seedTask(d, 'subsession:check-7')
    const ack = await d.handleRelayMsg(turn('x', { targetSessionId: TASK_ACP }), () => {})
    expect(ack).toMatchObject({ accepted: false, reason: 'not_found' })
    expect(prompts).toHaveLength(0)
    expect(postMessage).not.toHaveBeenCalled()
    await daemon.stop()
  })
})

interface AssistantSubsessionIndexLike {
  open(input: Record<string, unknown>): Promise<boolean>
  finish(agentId: string, key: string, state: 'done' | 'failed'): Promise<boolean>
  get(agentId: string, key: string): Promise<{ state: string; endReport?: string } | undefined>
}
