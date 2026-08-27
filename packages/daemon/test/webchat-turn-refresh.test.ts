import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { transcriptChannelKey } from '../src/store/local-store.js'
import type { RdChatEvent, RdMsgWebchat, RdWebchatPost } from '@agentconnect.md/protocol'

// Turn-final context refresh for multi-agent webchat (webchat-multi-agents.md §5.4):
// the browser stream stays live, so supersession is a stream EVENT and the fenced
// commit is the canonical post (transcript reply row + rd/webchat-post).

const AGENT_ID = 'bot-a'
const PEER_ID = 'agent-b'
const CONV = '88888888-8888-4888-8888-888888888888'
const TURN = '77777777-7777-4777-8777-777777777777'
const WAIT = { timeout: 10_000 }

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-wc-refresh-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      features: { turnFinalContextRefresh: true },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const adir = join(root, 'agents', AGENT_ID)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: AGENT_ID,
      name: AGENT_ID,
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return root
}

function fakeCpClient() {
  // Org-scoped: this daemon owns its agents outright and is not duty-governed.
  return {
    emitUsageReport: vi.fn(),
    emitSessionActivity: vi.fn(),
    organizationScope: () => 'connection' as const,
    stop: vi.fn(async () => {})
  }
}

const rd = (payload: RdMsgWebchat['payload'], over: Partial<RdMsgWebchat> = {}): RdMsgWebchat => ({
  source: 'webchat',
  agentId: AGENT_ID,
  sessionKey: CONV,
  msgId: 'm-1',
  chatId: CONV,
  payload,
  ...over
})

const peerPost = (n: number, at: number) => ({
  postId: `0000000${n}-0000-4000-8000-00000000000${n}`,
  conversationId: CONV,
  author: { kind: 'agent' as const, agentId: PEER_ID },
  text: `peer answer ${n}`,
  at
})

describe('webchat turn-final context refresh', () => {
  it('a peer context post discards the streamed candidate; only the replacement becomes the canonical post', async () => {
    let onUpdate!: (sid: string, u: unknown) => void
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => (releaseFirst = resolve))
    const prompts: string[] = []
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-wc-1'),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async (sid: string, blocks: { text?: string }[]) => {
        prompts.push(blocks.map((b) => b.text ?? '').join('\n'))
        if (prompts.length === 1) {
          onUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stale candidate' } })
          await firstBlocked
        } else {
          onUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fresh replacement' } })
        }
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({
      root: scaffold(),
      hostFactory: (_agent: unknown, cb: (sid: string, u: unknown) => void) => {
        onUpdate = cb
        return host as any
      }
    })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()

    const events: RdChatEvent[] = []
    const posts: RdWebchatPost[] = []
    // Completed posts use daemon-wide relay fan-out.
    ;(daemon as any).relays = { stop: vi.fn(async () => {}), sendWebchatPost: (p: RdWebchatPost) => posts.push(p) }
    const ack = await (daemon as any).handleRelayMsg(
      rd({ op: 'turn', text: 'original request', user: 'owner', turnId: TURN, post: { postId: TURN, at: 1_000 } }),
      (event: RdChatEvent) => events.push(event)
    )
    expect(ack).toMatchObject({ accepted: true, turnId: TURN })
    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(1), WAIT)

    // A peer participant's reply lands as a transcript-only context post while
    // this agent is still generating — it must invalidate the candidate.
    const ctxAck = await (daemon as any).handleRelayMsg(
      rd({ op: 'context', post: peerPost(1, 2_000) }, { msgId: 'ctx-1' }),
      () => {}
    )
    expect(ctxAck).toMatchObject({ accepted: true })
    releaseFirst()

    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(2), WAIT)
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'done')).toBe(true), WAIT)

    // The browser saw the supersession marker (same turnId, live stream), then
    // the replacement, then exactly one terminal done.
    const kinds = events.flatMap((e) => (e.kind === 'output' && e.output.event ? [e.output.event.kind] : []))
    expect(kinds).toContain('superseded')
    expect(events.filter((e) => e.kind === 'done')).toHaveLength(1)

    // The replacement prompt names the peer's message; the agent's OWN trigger
    // is not re-presented as a "new" thread message.
    expect(prompts[1]).toContain('AgentConnect context update')
    expect(prompts[1]).toContain(`[${PEER_ID}] peer answer 1`)
    expect(prompts[1]).not.toContain('original request')

    // Canonical commit: one rd/webchat-post and one transcript reply row, both
    // carrying only the accepted generation.
    expect(posts).toHaveLength(1)
    expect(posts[0]!.post.text).toBe('fresh replacement')
    const replies = (
      await (daemon as any).store.transcriptSince(transcriptChannelKey(CONV, undefined), `webchat:${CONV}`, null)
    )
      .filter((row: { sender: string }) => row.sender === AGENT_ID)
      .map((row: { text: string }) => row.text)
    expect(replies).toEqual(['fresh replacement'])

    // Canonical post identity (merged-conversation-view.md §6): every webchat
    // text row persists the origin-minted postId — the trigger carries the
    // relay-minted one, the peer's context copy the peer's, and the reply row
    // the SAME id its rd/webchat-post fan-out announced.
    const rows = (await (daemon as any).store.transcriptSince(
      transcriptChannelKey(CONV, undefined),
      `webchat:${CONV}`,
      null
    )) as { sender: string; text: string; postId?: string | null }[]
    expect(rows.find((r) => r.text === 'original request')?.postId).toBe(TURN)
    expect(rows.find((r) => r.text === 'peer answer 1')?.postId).toBe(peerPost(1, 0).postId)
    expect(rows.find((r) => r.text === 'fresh replacement')?.postId).toBe(posts[0]!.post.postId)
    await daemon.stop()
  }, 15_000)

  it('a busy same-agent follow-up is visible to the running generation and coalesces into it', async () => {
    let onUpdate!: (sid: string, u: unknown) => void
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => (releaseFirst = resolve))
    const prompts: string[] = []
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-wc-1'),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async (sid: string, blocks: { text?: string }[]) => {
        prompts.push(blocks.map((b) => b.text ?? '').join('\n'))
        if (prompts.length === 1) {
          onUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stale candidate' } })
          await firstBlocked
        } else {
          onUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'combined answer' } })
        }
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({
      root: scaffold(),
      hostFactory: (_agent: unknown, cb: (sid: string, u: unknown) => void) => {
        onUpdate = cb
        return host as any
      }
    })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()

    const first: RdChatEvent[] = []
    const second: RdChatEvent[] = []
    const posts: RdWebchatPost[] = []
    // Completed posts use daemon-wide relay fan-out.
    ;(daemon as any).relays = { stop: vi.fn(async () => {}), sendWebchatPost: (p: RdWebchatPost) => posts.push(p) }
    await (daemon as any).handleRelayMsg(
      rd({ op: 'turn', text: 'original request', user: 'owner', turnId: TURN, post: { postId: TURN, at: 1_000 } }),
      (event: RdChatEvent) => first.push(event)
    )
    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(1), WAIT)

    // A follow-up targeted at the SAME busy agent (e.g. from another tab): it is
    // observed at admission, so the running generation can see and absorb it.
    const secondTurn = '66666666-6666-4666-8666-666666666666'
    const ack2 = await (daemon as any).handleRelayMsg(
      rd(
        {
          op: 'turn',
          text: 'also compare memory usage',
          user: 'owner',
          turnId: secondTurn,
          post: { postId: secondTurn, at: 1_500 }
        },
        { msgId: 'm-2' }
      ),
      (event: RdChatEvent) => second.push(event)
    )
    expect(ack2).toMatchObject({ accepted: true, turnId: secondTurn })
    releaseFirst()

    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(2), WAIT)
    await vi.waitFor(() => expect(first.some((e) => e.kind === 'done')).toBe(true), WAIT)

    // The replacement prompt carries the follow-up; the queued activation is
    // coalesced — its browser turn closes explicitly instead of hanging.
    expect(prompts[1]).toContain('[owner] also compare memory usage')
    await vi.waitFor(() => expect(second.some((e) => e.kind === 'done')).toBe(true), WAIT)
    const secondDone = second.find((e) => e.kind === 'done')
    expect(secondDone && secondDone.kind === 'done' ? secondDone.done.stopReason : undefined).toBe(
      'coalesced_into_turn'
    )
    expect(posts).toHaveLength(1)
    expect(posts[0]!.post.text).toBe('combined answer')
    await daemon.stop()
  }, 15_000)

  it('coalesces a busy follow-up even when its canonical millisecond was collision-bumped', async () => {
    let onUpdate!: (sid: string, u: unknown) => void
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => (releaseFirst = resolve))
    const prompts: string[] = []
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-wc-1'),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async (sid: string, blocks: { text?: string }[]) => {
        prompts.push(blocks.map((b) => b.text ?? '').join('\n'))
        if (prompts.length === 1) {
          onUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stale candidate' } })
          await firstBlocked
        } else {
          onUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'combined answer' } })
        }
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({
      root: scaffold(),
      hostFactory: (_agent: unknown, cb: (sid: string, u: unknown) => void) => {
        onUpdate = cb
        return host as any
      }
    })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()

    const first: RdChatEvent[] = []
    const second: RdChatEvent[] = []
    const posts: RdWebchatPost[] = []
    // Completed posts use daemon-wide relay fan-out.
    ;(daemon as any).relays = { stop: vi.fn(async () => {}), sendWebchatPost: (p: RdWebchatPost) => posts.push(p) }
    await (daemon as any).handleRelayMsg(
      rd({ op: 'turn', text: 'original request', user: 'owner', turnId: TURN, post: { postId: TURN, at: 1_000 } }),
      (event: RdChatEvent) => first.push(event)
    )
    await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(1), WAIT)

    // A FOREIGN row (e.g. this agent's own earlier reply) already occupies the
    // follow-up's canonical millisecond, so its admission row lands one slot
    // later. The bumped ts must ride the queued message — otherwise the queue
    // match misses and the follow-up runs again as a third prompt.
    await (daemon as any).store.appendTranscript({
      channel: transcriptChannelKey(CONV, undefined),
      thread: `webchat:${CONV}`,
      ts: '1500',
      sender: AGENT_ID,
      kind: 'text',
      text: 'earlier self-authored row'
    })
    const secondTurn = '66666666-6666-4666-8666-666666666666'
    await (daemon as any).handleRelayMsg(
      rd(
        {
          op: 'turn',
          text: 'also compare memory usage',
          user: 'owner',
          turnId: secondTurn,
          post: { postId: secondTurn, at: 1_500 }
        },
        { msgId: 'm-2' }
      ),
      (event: RdChatEvent) => second.push(event)
    )
    releaseFirst()

    await vi.waitFor(() => expect(first.some((e) => e.kind === 'done')).toBe(true), WAIT)
    await vi.waitFor(() => expect(second.some((e) => e.kind === 'done')).toBe(true), WAIT)
    expect(host.prompt).toHaveBeenCalledTimes(2) // regeneration absorbed it — no third prompt
    expect(prompts[1]).toContain('[owner] also compare memory usage')
    const secondDone = second.find((e) => e.kind === 'done')
    expect(secondDone && secondDone.kind === 'done' ? secondDone.done.stopReason : undefined).toBe(
      'coalesced_into_turn'
    )
    expect(posts).toHaveLength(1)
    expect(posts[0]!.post.text).toBe('combined answer')
    await daemon.stop()
  }, 15_000)

  it('context-churn exhaustion closes the browser turn with stopReason context_churn and commits no post', async () => {
    let onUpdate!: (sid: string, u: unknown) => void
    let promptCount = 0
    const daemonHolder: { current?: Daemon } = {}
    const injectContext = async (n: number): Promise<void> => {
      await (daemonHolder.current as any).handleRelayMsg(
        rd({ op: 'context', post: peerPost(n, 2_000 + n) }, { msgId: `ctx-${n}` }),
        () => {}
      )
    }
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-wc-1'),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async (sid: string) => {
        promptCount += 1
        onUpdate(sid, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `candidate ${promptCount}` }
        })
        // A fresh peer post lands during EVERY generation, so the final refresh
        // never accepts and the retry budget (3 regenerations) runs dry.
        await injectContext(promptCount)
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({
      root: scaffold(),
      hostFactory: (_agent: unknown, cb: (sid: string, u: unknown) => void) => {
        onUpdate = cb
        return host as any
      }
    })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()
    daemonHolder.current = daemon

    const events: RdChatEvent[] = []
    const posts: RdWebchatPost[] = []
    // Completed posts use daemon-wide relay fan-out.
    ;(daemon as any).relays = { stop: vi.fn(async () => {}), sendWebchatPost: (p: RdWebchatPost) => posts.push(p) }
    await (daemon as any).handleRelayMsg(
      rd({ op: 'turn', text: 'original request', user: 'owner', turnId: TURN, post: { postId: TURN, at: 1_000 } }),
      (event: RdChatEvent) => events.push(event)
    )

    await vi.waitFor(() => expect(events.some((e) => e.kind === 'done')).toBe(true), WAIT)
    expect(host.prompt).toHaveBeenCalledTimes(4) // original + 3 budgeted regenerations
    const done = events.find((e) => e.kind === 'done')
    expect(done && done.kind === 'done' ? done.done.stopReason : undefined).toBe('context_churn')
    // A superseded marker promises a replacement generation — it fires once per
    // budgeted regeneration and NEVER on the exhausted discard (the browser must
    // not see "updating this answer…" right before the turn dies).
    const outputEvents = events.flatMap((e) => (e.kind === 'output' && e.output.event ? [e.output.event] : []))
    expect(outputEvents.filter((e) => e.kind === 'superseded')).toHaveLength(3)
    const lastSuperseded = outputEvents.map((e) => e.kind).lastIndexOf('superseded')
    const warning = outputEvents.findIndex((e) => e.kind === 'message' && e.text.startsWith('⚠️'))
    expect(warning).toBeGreaterThan(lastSuperseded)
    // The churned candidate is never committed: no canonical post, no reply row.
    expect(posts).toHaveLength(0)
    const replies = (
      await (daemon as any).store.transcriptSince(transcriptChannelKey(CONV, undefined), `webchat:${CONV}`, null)
    ).filter((row: { sender: string }) => row.sender === AGENT_ID)
    expect(replies).toEqual([])
    await daemon.stop()
  }, 15_000)
  it('distinct canonical posts sharing millisecond, sender, and text occupy separate slots', async () => {
    // The C2 dedupe prerequisite: `at` minting is connection-local, so two
    // tabs can mint distinct posts on the same millisecond — and a same-user
    // repeat ("ok" twice) also matches the legacy (sender, text) heuristic.
    // Only a matching canonical postId may reuse an occupied slot; a distinct
    // id must bump, or the second post is silently lost.
    const daemon = new Daemon({
      root: scaffold(),
      hostFactory: () => ({ start: vi.fn(async () => {}) }) as any
    })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()

    const dup = (n: number) => ({
      postId: `0000000${n}-1111-4000-8000-00000000000${n}`,
      conversationId: CONV,
      author: { kind: 'agent' as const, agentId: PEER_ID },
      text: 'ok',
      at: 7_000
    })
    expect(
      await (daemon as any).handleRelayMsg(rd({ op: 'context', post: dup(1) }, { msgId: 'c-1' }), () => {})
    ).toMatchObject({ accepted: true })
    expect(
      await (daemon as any).handleRelayMsg(rd({ op: 'context', post: dup(2) }, { msgId: 'c-2' }), () => {})
    ).toMatchObject({ accepted: true })
    // An identical re-fan of post 1 dedups in place (no third row).
    expect(
      await (daemon as any).handleRelayMsg(rd({ op: 'context', post: dup(1) }, { msgId: 'c-3' }), () => {})
    ).toMatchObject({ accepted: true })

    const rows = (await (daemon as any).store.transcriptSince(
      transcriptChannelKey(CONV, undefined),
      `webchat:${CONV}`,
      null
    )) as { ts: string; postId?: string | null }[]
    expect(rows.map((r) => [r.ts, r.postId])).toEqual([
      ['7000', dup(1).postId],
      ['7001', dup(2).postId]
    ])
    await daemon.stop()
  })
  it('turn ADMISSION writes carry the canonical id — distinct same-text turns bump, not merge', async () => {
    // The pre-queue observed-inbound write must be identity-aware too: two
    // tabs can mint distinct turn posts on one millisecond with the same user
    // and text. Without the id on the admission append, the second turn would
    // reuse the first row — no new revision, nothing for the in-flight
    // generation to coalesce, and a lost post if its queued activation never
    // runs.
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => (releaseFirst = resolve))
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-wc-1'),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async () => {
        await firstBlocked
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => host as any })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()

    const turnPost = (n: number) => ({ postId: `0000000${n}-2222-4000-8000-00000000000${n}`, at: 9_000 })
    const t1 = '11111111-aaaa-4aaa-8aaa-111111111111'
    const t2 = '22222222-bbbb-4bbb-8bbb-222222222222'
    expect(
      await (daemon as any).handleRelayMsg(
        rd({ op: 'turn', text: 'same words', user: 'owner', turnId: t1, post: turnPost(1) }),
        () => {}
      )
    ).toMatchObject({ accepted: true })
    expect(
      await (daemon as any).handleRelayMsg(
        rd({ op: 'turn', text: 'same words', user: 'owner', turnId: t2, post: turnPost(2) }, { msgId: 'm-2' }),
        () => {}
      )
    ).toMatchObject({ accepted: true })

    const rows = (await (daemon as any).store.transcriptSince(
      transcriptChannelKey(CONV, undefined),
      `webchat:${CONV}`,
      null
    )) as { ts: string; postId?: string | null; text: string }[]
    expect(rows.filter((r) => r.text === 'same words').map((r) => [r.ts, r.postId])).toEqual([
      ['9000', turnPost(1).postId],
      ['9001', turnPost(2).postId]
    ])
    releaseFirst()
    await daemon.stop()
  })
})
