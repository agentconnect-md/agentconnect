import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { memberIdOn } from '../src/session/chat-continuation.js'
import { sessionKey, transcriptChannelKey } from '../src/store/local-store.js'
import { webchatAuthorOf } from '../src/webchat/transport.js'
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
  const prompts: Array<{ agentId: string; sid: string; text: string; types: string[] }> = []
  let sessionSeq = 0
  const factory = (agent: { id: string }, onUpdate: (sid: string, u: unknown) => void) =>
    ({
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => `acp-fresh-${++sessionSeq}`),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async (sid: string, blocks: { type?: string; text?: string }[]) => {
        const text = blocks.map((b) => b.text ?? '').join('\n')
        prompts.push({ agentId: agent.id, sid, text, types: blocks.map((b) => b.type ?? '') })
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
const IMAGE = { name: 'shot.png', mimeType: 'image/png' as const, data: Buffer.from('png').toString('base64') }
const UPLOAD = {
  uploadId: '00000000-0000-4000-8000-000000000001',
  name: 'notes.pdf',
  mimeType: 'application/pdf',
  size: 3,
  sha256: `${'A'.repeat(43)}=`
}

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
    expect(setModel).toMatchObject({ accepted: false, reason: 'runtime changes are disabled for a continued session' })

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

  it("continues a channel coordinator at the channel's top level, never under its coordinate as a thread", async () => {
    const { daemon, d, prompts, postMessage, postAsAuthor } = await boot(() => 'coordinator reply')
    const coordinate = 'append:coordinator-1700000000000'
    const coordKey = `slack:C1:${coordinate}:${AGENT}`
    await d.store.upsertSession({
      key: coordKey,
      agentId: AGENT,
      platform: 'slack',
      channel: 'C1',
      thread: coordinate,
      acpSessionId: 'acp-coordinator',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    await d.store.setSessionClassification(coordKey, {
      sourceBindingKind: 'external',
      externalProvider: 'slack',
      externalRealmKey: 'T1',
      externalResourceKind: 'conversation',
      externalResourceKey: 'C1',
      externalIntegrationId: 'int-a'
    })
    const events: RdChatEvent[] = []

    const ack = await d.handleRelayMsg(turn('from console', { targetSessionId: 'acp-coordinator' }), (e) =>
      events.push(e)
    )
    expect(ack).toMatchObject({ accepted: true })
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'done')).toBe(true), WAIT)
    expect(postAsAuthor).toHaveBeenCalledWith(
      'C1',
      undefined,
      { text: 'from console', attributedText: '[owner via console] from console' },
      { name: 'owner' },
      { agentAuthorId: AGENT }
    )
    expect(prompts).toHaveLength(1)
    // The turn ran as the conversation's coordinator, keyed on its coordinate.
    expect(prompts[0]!.text).toContain(`Thread: ${coordinate}`)
    expect(prompts[0]!.text).toContain('You are the coordinator')
    for (const call of postMessage.mock.calls as unknown[][]) expect(call[2]).not.toBe(coordinate)
    // The message is the copy in the channel, as channel ingress records it, so a task opened for it takes that thread.
    expect(prompts[0]!.text).toContain('msg-100.200000')
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

describe('webchat session-targeted continuation — control commands', () => {
  it('runs !resume as the command: the open loop guard resets and no turn runs', async () => {
    const { daemon, d, prompts, postMessage, postAsAuthor } = await boot()
    const store = (daemon as never as { store: Record<string, (...args: unknown[]) => Promise<unknown>> }).store
    await store.tripLoopGuard!('slack:C1:top-level', Date.now(), 'automatic_turn_burst')
    const events: RdChatEvent[] = []

    const ack = await d.handleRelayMsg(turn('!resume'), (e) => events.push(e))
    expect(ack).toMatchObject({ accepted: true })
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'done')).toBe(true), WAIT)
    expect(await store.isLoopGuardOpen!('slack:C1:top-level')).toBe(false)
    // The reply reaches the console; the platform sees neither the command nor a model turn.
    expect(JSON.stringify(events.filter((e) => e.kind === 'output'))).toContain('Resumed')
    expect(prompts).toHaveLength(0)
    expect(postAsAuthor).not.toHaveBeenCalled()
    expect(postMessage).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('acts on the session the console names, not the one the channel holds now', async () => {
    const { daemon, d } = await boot()
    // The channel has moved on to another session since this page was opened.
    const host = (daemon as never as { commands: { host: Record<string, unknown> } }).commands.host
    host.sessionCoordinateFor = async () => 'append:coordinator-rotated'
    const events: RdChatEvent[] = []

    await d.handleRelayMsg(turn('!stop'), (e) => events.push(e))
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'done')).toBe(true), WAIT)
    expect(JSON.stringify(events.filter((e) => e.kind === 'output'))).toContain('Muted in this thread')
    await daemon.stop()
  })

  it('keeps !new and the card-posting commands ordinary turns', async () => {
    for (const text of ['!new', '!status']) {
      const { daemon, d, prompts } = await boot()
      const events: RdChatEvent[] = []
      await d.handleRelayMsg(turn(text), (e) => events.push(e))
      await vi.waitFor(() => expect(events.some((e) => e.kind === 'done')).toBe(true), WAIT)
      expect(prompts).toHaveLength(1)
      await daemon.stop()
    }
  })
})

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

describe('webchat session-targeted continuation — author member id', () => {
  const local = { platform: 'slack', transportScope: 'T1' }

  it("picks the author's linked member in the session's own workspace", () => {
    const author = webchatAuthorOf({ user: 'Ada', userId: 'user-1', userIdentities: ['slack:T9:U9', 'slack:T1:U7'] })
    expect(memberIdOn(author, local)).toBe('U7')
  })

  it('names nobody without a linked member in that workspace or a recorded workspace', () => {
    expect(memberIdOn({ identities: ['slack:T9:U9', 'feishu:lark:on_1'] }, local)).toBeUndefined()
    expect(memberIdOn({}, local)).toBeUndefined()
    expect(memberIdOn({ identities: ['slack:T1:U7'] }, { platform: 'slack' })).toBeUndefined()
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

  it("lets a task's own thread change its runtime settings, which another continued session may not", async () => {
    const { daemon, d } = await boot()
    const key = await seedTask(d)
    const applied: Array<[string, string]> = []
    ;(
      d as never as { commands: { setModelByKey: (k: string, m: string) => Promise<boolean> } }
    ).commands.setModelByKey = async (k, m) => {
      applied.push([k, m])
      return true
    }
    const ack = (await d.handleRelayMsg(
      turn('', { targetSessionId: TASK_ACP, payload: { op: 'set_model', model: 'opus', callerRole: 'editor' } }),
      () => {}
    )) as RdAck
    expect(ack).toMatchObject({ accepted: true })
    expect(applied).toEqual([[key, 'opus']])
    await daemon.stop()
  })

  it('lets a threaded task in its own platform thread change its runtime settings while some session owns it', async () => {
    const { daemon, d } = await boot()
    const key = await seedTask(d, '1700000000.000300')
    const index = (d as never as { store: { assistantSubsessions: AssistantSubsessionIndexLike } }).store
      .assistantSubsessions
    const applied: Array<[string, string]> = []
    ;(
      d as never as { commands: { setModelByKey: (k: string, m: string) => Promise<boolean> } }
    ).commands.setModelByKey = async (k, m) => {
      applied.push([k, m])
      return true
    }
    const setModel = () =>
      d.handleRelayMsg(
        turn('', { targetSessionId: TASK_ACP, payload: { op: 'set_model', model: 'opus', callerRole: 'editor' } }),
        () => {}
      ) as Promise<RdAck>
    // Before any session owns it, a thread session is an ordinary continued one.
    expect(await setModel()).toMatchObject({
      accepted: false,
      reason: 'runtime changes are disabled for a continued session'
    })
    await index.open({
      agentId: AGENT,
      childSessionKey: key,
      parentSessionId: TARGET_ACP,
      parentSessionKey: PARENT_KEY,
      title: 'Notes'
    })
    expect(await setModel()).toMatchObject({ accepted: true })
    expect(applied).toEqual([[key, 'opus']])
    await daemon.stop()
  })

  it("hands a file sent on a threaded task's thread to the task, and refuses one on any other chat thread", async () => {
    const send = (d: Awaited<ReturnType<typeof boot>>['d'], text: string) =>
      d.handleRelayMsg(
        turn(text, { targetSessionId: TASK_ACP, payload: { op: 'turn', text, user: 'owner', files: [UPLOAD] } }),
        () => {}
      ) as Promise<RdAck>
    // Not a task: a chat thread mirrors images only, so a file is refused before anything posts.
    const plain = await boot()
    await seedTask(plain.d, '1700000000.000300')
    expect(await send(plain.d, 'plain')).toMatchObject({ accepted: false, reason: 'unsupported' })
    expect(plain.postAsAuthor).not.toHaveBeenCalled()
    expect(plain.prompts).toHaveLength(0)
    await plain.daemon.stop()
    // A threaded task some session owns takes the file.
    const owned = await boot()
    const key = await seedTask(owned.d, '1700000000.000300')
    const index = (owned.d as never as { store: { assistantSubsessions: AssistantSubsessionIndexLike } }).store
      .assistantSubsessions
    await index.open({
      agentId: AGENT,
      childSessionKey: key,
      parentSessionId: TARGET_ACP,
      parentSessionKey: PARENT_KEY,
      title: 'Notes'
    })
    await index.finish(AGENT, key, 'done')
    expect(await send(owned.d, 'owned')).toMatchObject({ accepted: true })
    await vi.waitFor(() => expect(owned.prompts).toHaveLength(1))
    expect(owned.prompts[0]!.text).toContain('notes.pdf')
    await owned.daemon.stop()
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

describe('webchat session-targeted continuation — a coordinator’s thread (webchat-threads.md §7)', () => {
  const COORDINATE = 'append:coordinator-1700000000000'
  const COORD_ACP = 'acp-coordinator'
  const ROOT = '100.300000'
  const SLACK_C1 = {
    sourceBindingKind: 'external',
    externalProvider: 'slack',
    externalRealmKey: 'T1',
    externalResourceKind: 'conversation',
    externalResourceKey: 'C1',
    externalIntegrationId: 'int-a'
  }
  const inThread = (text: string, thread = ROOT, targetSessionId = COORD_ACP) =>
    turn(text, { targetSessionId, payload: { op: 'turn', text, user: 'owner', thread } })

  // A channel coordinator on the workspace's transport scope that received one root.
  async function coordinator(daemon: Daemon, d: Awaited<ReturnType<typeof boot>>['d']) {
    const scope = (
      daemon as never as { transportScopeForIntegrationIds(ids: string[]): string }
    ).transportScopeForIntegrationIds(['int-a'])
    const key = sessionKey('slack', 'C1', COORDINATE, AGENT, scope)
    await d.store.upsertSession({
      key,
      agentId: AGENT,
      platform: 'slack',
      channel: 'C1',
      thread: COORDINATE,
      transportScope: scope,
      acpSessionId: COORD_ACP,
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    await d.store.setSessionClassification(key, SLACK_C1)
    const channel = transcriptChannelKey('C1', scope)
    await (d.store as never as { appendTranscript(e: Record<string, unknown>): Promise<void> }).appendTranscript({
      channel,
      thread: ROOT,
      ts: ROOT,
      sender: 'U1',
      kind: 'text',
      text: 'Why is the deploy slow?',
      admission: { agentId: AGENT, sessionKey: key }
    })
    return { scope, key, channel }
  }

  it('mirrors the message into the thread under the writer’s name, then hands it to the coordinator with the thread named', async () => {
    const { daemon, d, prompts, postAsAuthor } = await boot(() => 'looking')
    const { channel } = await coordinator(daemon, d)
    const events: RdChatEvent[] = []

    expect(await d.handleRelayMsg(inThread('and the cache?'), (e) => events.push(e))).toMatchObject({ accepted: true })
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'done')).toBe(true), WAIT)
    expect(postAsAuthor).toHaveBeenCalledWith(
      'C1',
      ROOT,
      { text: 'and the cache?', attributedText: '[owner via console] and the cache?' },
      { name: 'owner' },
      { agentAuthorId: AGENT }
    )
    expect(prompts).toHaveLength(1)
    // The coordinator's own session took it, named as a message in the root's thread.
    expect(prompts[0]!.sid).toBe(COORD_ACP)
    expect(prompts[0]!.text).toContain(`thread="msg-${ROOT}"`)
    // Recorded as the mirror, a reply in the thread.
    const page = await d.store.transcriptPage(channel, ROOT, null, 50, AGENT)
    expect(page.rows.map((r) => r.text)).toEqual(expect.arrayContaining(['Why is the deploy slow?', 'and the cache?']))
    await daemon.stop()
  })

  it('hands the message to a task that holds the thread by then, mirrored all the same', async () => {
    const { daemon, d, prompts, postAsAuthor } = await boot(() => 'warming it')
    const { scope, key } = await coordinator(daemon, d)
    const taskKey = sessionKey('slack', 'C1', ROOT, AGENT, scope)
    await d.store.upsertSession({
      key: taskKey,
      agentId: AGENT,
      platform: 'slack',
      channel: 'C1',
      thread: ROOT,
      transportScope: scope,
      acpSessionId: 'acp-thread-task',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    await d.store.setSessionClassification(taskKey, SLACK_C1)
    const index = (d as never as { store: { assistantSubsessions: AssistantSubsessionIndexLike } }).store
      .assistantSubsessions
    await index.open({
      agentId: AGENT,
      childSessionKey: taskKey,
      parentSessionId: COORD_ACP,
      parentSessionKey: key,
      title: 'Speed up the deploy'
    })
    await index.attachThread({
      agentId: AGENT,
      childSessionKey: taskKey,
      platform: 'slack',
      channel: 'C1',
      transportScope: scope,
      thread: ROOT,
      sinceRound: 1,
      now: Date.now()
    })

    expect(await d.handleRelayMsg(inThread('and the cache?'), () => {})).toMatchObject({ accepted: true })
    await vi.waitFor(() => expect(prompts).toHaveLength(1), WAIT)
    expect(postAsAuthor).toHaveBeenCalledWith('C1', ROOT, expect.anything(), expect.anything(), expect.anything())
    // The task's own session took it, as any reply in its thread.
    expect(prompts[0]!.sid).toBe('acp-thread-task')
    expect(prompts[0]!.text).toContain('and the cache?')
    expect(prompts[0]!.text).not.toContain(`thread="msg-${ROOT}"`)
    await vi.waitFor(() => expect(d.inflight.size).toBe(0), WAIT)
    await daemon.stop()
  })

  it('refuses a thread the coordinator never received, and any thread on a session that is no coordinator', async () => {
    const { daemon, d, prompts, postAsAuthor, postMessage } = await boot()
    await coordinator(daemon, d)
    for (const msg of [inThread('hello?', '100.999999'), inThread('hello?', ROOT, TARGET_ACP)])
      expect(await d.handleRelayMsg(msg, () => {})).toMatchObject({ accepted: false, reason: 'unknown_thread' })
    expect(postAsAuthor).not.toHaveBeenCalled()
    expect(postMessage).not.toHaveBeenCalled()
    expect(prompts).toHaveLength(0)
    await daemon.stop()
  })
})

interface AssistantSubsessionIndexLike {
  open(input: Record<string, unknown>): Promise<boolean>
  finish(agentId: string, key: string, state: 'done' | 'failed'): Promise<boolean>
  get(agentId: string, key: string): Promise<{ state: string; endReport?: string } | undefined>
  attachThread(input: Record<string, unknown>): Promise<boolean>
}

describe('webchat session-targeted continuation — attachments', () => {
  const withImage = (text: string, over: Partial<RdMsgWebchat> = {}) =>
    turn(text, { payload: { op: 'turn', text, user: 'owner', attachments: [IMAGE] }, ...over })

  it('mirrors an image into the origin thread after the text and before the turn runs, which receives it', async () => {
    const order: string[] = []
    const { daemon, d, prompts, postMessage, postAsAuthor } = await boot(() => {
      order.push('prompt')
      return 'nice screenshot'
    })
    postAsAuthor.mockImplementation(async (_c, _t, body) => {
      order.push('text')
      return { ts: '100.200000', text: body.text }
    })
    const uploadFile = vi.fn(async () => {
      order.push('image')
      return { ok: true as const }
    })
    d.connByIntegration.set('int-a', { postMessage, postAsAuthor, uploadFile, workspaceId: () => 'T1' })

    expect(await d.handleRelayMsg(withImage('see this'), () => {})).toMatchObject({ accepted: true })
    await vi.waitFor(() => expect(prompts).toHaveLength(1), WAIT)
    expect(order).toEqual(['text', 'image', 'prompt'])
    // Slack renders the console author on the share, so it carries no caption.
    expect(uploadFile).toHaveBeenCalledWith(
      'C1',
      { bytes: Buffer.from('png'), name: 'shot.png', mimeType: 'image/png' },
      undefined,
      { thread: '100.1' },
      { username: 'owner', agentAuthorId: AGENT }
    )
    // This runtime takes no image input, so the turn names the attachment rather than embedding it.
    expect(prompts[0]!.text).toContain('[attached: shot.png (image/png)]')
    await daemon.stop()
  })

  it('names the image in the mirrored line when the message is only an image', async () => {
    const { daemon, d, prompts, postMessage, postAsAuthor } = await boot()
    d.connByIntegration.set('int-a', {
      postMessage,
      postAsAuthor,
      uploadFile: vi.fn(async () => ({ ok: true as const })),
      workspaceId: () => 'T1'
    })
    expect(await d.handleRelayMsg(withImage(''), () => {})).toMatchObject({ accepted: true })
    await vi.waitFor(() => expect(prompts).toHaveLength(1), WAIT)
    expect(postAsAuthor.mock.calls[0]![2]).toEqual({ text: 'shot.png', attributedText: '[owner via console] shot.png' })
    await daemon.stop()
  })

  it('still runs the turn when the image share fails, and says so in the thread', async () => {
    const { daemon, d, prompts, postMessage, postAsAuthor } = await boot()
    const uploadFile = vi.fn(async () => ({ ok: false as const, reason: 'missing_scope' as const }))
    d.connByIntegration.set('int-a', { postMessage, postAsAuthor, uploadFile, workspaceId: () => 'T1' })
    expect(await d.handleRelayMsg(withImage('see this'), () => {})).toMatchObject({ accepted: true })
    await vi.waitFor(() => expect(prompts).toHaveLength(1), WAIT)
    expect(postMessage).toHaveBeenCalledWith('C1', '[owner via console] shot.png could not be shared here.', '100.1')
    expect(prompts[0]!.text).toContain('shot.png')
    await daemon.stop()
  })

  it('posts no failure note for a share that may still land', async () => {
    const { daemon, d, prompts, postMessage, postAsAuthor } = await boot()
    const uploadFile = vi.fn(async () => ({ ok: false as const, reason: 'indeterminate' as const }))
    d.connByIntegration.set('int-a', { postMessage, postAsAuthor, uploadFile, workspaceId: () => 'T1' })
    expect(await d.handleRelayMsg(withImage('see this'), () => {})).toMatchObject({ accepted: true })
    await vi.waitFor(() => expect(prompts).toHaveLength(1), WAIT)
    expect(postMessage).not.toHaveBeenCalledWith('C1', expect.stringContaining('could not be shared'), '100.1')
    await daemon.stop()
  })

  it('refuses a file on a chat thread before anything posts', async () => {
    const { daemon, d, prompts, postAsAuthor } = await boot()
    const ack = await d.handleRelayMsg(
      turn('the notes', { payload: { op: 'turn', text: 'the notes', user: 'owner', files: [UPLOAD] } }),
      () => {}
    )
    expect(ack).toMatchObject({ accepted: false, reason: 'unsupported' })
    expect(postAsAuthor).not.toHaveBeenCalled()
    expect(prompts).toHaveLength(0)
    await daemon.stop()
  })

  it('hands a hook session a file and an image, mirroring neither', async () => {
    const { daemon, d, prompts, postMessage } = await boot()
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
    const text = 'compare these'
    const ack = await d.handleRelayMsg(
      turn(text, {
        targetSessionId: HOOK_ACP,
        payload: { op: 'turn', text, user: 'owner', attachments: [IMAGE], files: [UPLOAD] }
      }),
      () => {}
    )
    expect(ack).toMatchObject({ accepted: true })
    await vi.waitFor(() => expect(prompts).toHaveLength(1), WAIT)
    expect(prompts[0]!.text).toContain('shot.png')
    expect(prompts[0]!.text).toContain('notes.pdf')
    expect(postMessage).not.toHaveBeenCalled()
    await daemon.stop()
  })
})
