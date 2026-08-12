import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MAX_AGENT_CALL_HOPS } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { transcriptChannelKey } from '../src/store/local-store.js'
import type { RdChatEvent, RdMsgWebchat, RdWebchatPost, WebchatPost } from '@agentconnect.md/protocol'

// #549 parity for multi-agent webchat (webchat-multi-agents.md §5.2a, issue #904):
// a peer agent's COMMITTED conversation post — delivered to this participant as a
// relay `context` frame — continues the conversation instead of staying
// transcript-only, with the platform ladder's protections: the hop transition
// against MAX_AGENT_CALL_HOPS, exactly-once per (post, target) through the durable
// activation rendezvous, final-events-only (structural), author exclusion, and the
// directional call policy. These tests drive the daemon exactly the way the relay
// does (handleRelayMsg) and play the relay's roster fan-out themselves.

const P1 = 'bot-a'
const P2 = 'bot-b'
const REF = 'bot-ref'
const CONV = '88888888-8888-4888-8888-888888888888'
const KICKOFF_TURN = '77777777-7777-4777-8777-777777777777'
const NO_RESPONSE = 'AC_NO_RESPONSE'
const WAIT = { timeout: 10_000 }

function scaffold(agentIds: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-wc-cont-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      features: { turnFinalContextRefresh: true },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  for (const id of agentIds) {
    const adir = join(root, 'agents', id)
    mkdirSync(adir, { recursive: true })
    writeFileSync(
      join(adir, 'agent.json'),
      JSON.stringify({
        id,
        name: id,
        status: 'active',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
        integrations: [],
        output: { mode: 'medium' }
      })
    )
  }
  return root
}

/** One scripted per-agent ACP host: every prompt resolves immediately with
 *  `reply(promptText)` streamed as a single message chunk. */
function scriptedHosts(replies: Record<string, (prompt: string) => string | Promise<string>>) {
  // Eagerly seeded so "was never prompted" asserts read an empty list, not undefined.
  const prompts = new Map<string, string[]>(Object.keys(replies).map((id) => [id, []]))
  let sessionSeq = 0
  const factory = (agent: { id: string }, onUpdate: (sid: string, u: unknown) => void) => {
    const agentId = agent.id
    if (!prompts.has(agentId)) prompts.set(agentId, [])
    return {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => `acp-cont-${agentId}-${++sessionSeq}`),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async (sid: string, blocks: { text?: string }[]) => {
        const text = blocks.map((b) => b.text ?? '').join('\n')
        prompts.get(agentId)!.push(text)
        const reply = await replies[agentId]!(text)
        onUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } })
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    } as any
  }
  return { factory, prompts }
}

function fakeCpClient() {
  return { emitUsageReport: vi.fn(), emitSessionActivity: vi.fn(), stop: vi.fn(async () => {}) }
}

const rd = (payload: RdMsgWebchat['payload'], over: Partial<RdMsgWebchat> = {}): RdMsgWebchat => ({
  source: 'webchat',
  agentId: P1,
  sessionKey: CONV,
  msgId: 'm-1',
  chatId: CONV,
  payload,
  ...over
})

/** Seed the flat org directory so `admits()` (checked per continuation edge, like the
 *  platform ladder) passes for every roster pair. */
function seedCallPolicy(daemon: Daemon, agentIds: string[], over: Record<string, object> = {}): void {
  ;(daemon as any).cpCollab.replace({
    generation: 1,
    channels: [],
    agents: agentIds.map((agentId) => ({
      agentId,
      orgId: 'org-1',
      callPolicy: 'all',
      allowedCallerAgentIds: [],
      outboundPolicy: 'all',
      allowedTargetAgentIds: [],
      ...(over[agentId] ?? {})
    }))
  })
}

/** Play the relay: deliver a committed post to the browser log (posts[]) and fan a
 *  pre-addressed `context` copy to every OTHER roster member — the §5.2 fan-out. */
function fakeRelay(daemonRef: { current?: Daemon }, roster: string[]) {
  const posts: RdWebchatPost[] = []
  let ctxSeq = 0
  const fanOut = (p: RdWebchatPost): void => {
    posts.push(p)
    for (const peer of roster) {
      if (peer === p.agentId) continue
      ;(daemonRef.current as any).handleRelayMsg(
        rd({ op: 'context', post: p.post }, { agentId: peer, msgId: `ctx-${ctxSeq++}` }),
        () => {}
      )
    }
  }
  return { posts, fanOut }
}

const userPost = (text: string, at: number, postId: string): WebchatPost => ({
  postId,
  conversationId: CONV,
  author: { kind: 'user', user: 'owner' },
  text,
  at
})

const agentPost = (agentId: string, text: string, at: number, postId: string, hopCount?: number): WebchatPost => ({
  postId,
  conversationId: CONV,
  author: { kind: 'agent', agentId, ...(hopCount !== undefined ? { hopCount } : {}) },
  text,
  at
})

const settle = () => new Promise((r) => setTimeout(r, 300))

// Mirrors daemon.ts `activationKey(platform, transportScope, platformMessageId, target)`.
const rendezvousKey = (postId: string, targetAgentId: string): string =>
  ['webchat', '', postId, targetAgentId].join('\u0000')

describe('webchat multi-agent continuation (#549 parity)', () => {
  it('runs the counting relay: kickoff activates, each committed post wakes roster-minus-author, the silent referee absorbs its wakes', async () => {
    // player-1 counts odds, player-2 evens; both decline past 6; the referee
    // always declines — the live regression's exact shape.
    const next: Record<string, number> = { [P1]: 1, [P2]: 2 }
    const count = (id: string) => () => {
      const n = next[id]!
      if (n > 6) return NO_RESPONSE
      next[id] = n + 2
      return String(n)
    }
    const { factory, prompts } = scriptedHosts({ [P1]: count(P1), [P2]: count(P2), [REF]: () => NO_RESPONSE })
    const daemon = new Daemon({ root: scaffold([P1, P2, REF]), hostFactory: factory })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()
    seedCallPolicy(daemon, [P1, P2, REF])
    const holder = { current: daemon }
    const { posts, fanOut } = fakeRelay(holder, [P1, P2, REF])
    ;(daemon as any).relays = { sendWebchatPost: fanOut, stop: async () => {} }

    // Human kickoff, mention-narrowed to player-1; the other participants get the
    // user post as context only (user context copies never activate — §5.2).
    const kickoffText = 'count to 6 together, alternating, one number per message; referee: observe silently'
    const ack = (daemon as any).handleRelayMsg(
      rd(
        {
          op: 'turn',
          text: kickoffText,
          user: 'owner',
          turnId: KICKOFF_TURN,
          post: { postId: KICKOFF_TURN, at: 1_000 }
        },
        { agentId: P1, msgId: 'turn-p1' }
      ),
      (_e: RdChatEvent) => {},
      fanOut
    )
    expect(ack).toMatchObject({ accepted: true })
    for (const [peer, msgId] of [
      [P2, 'uctx-p2'],
      [REF, 'uctx-ref']
    ] as const) {
      ;(daemon as any).handleRelayMsg(
        rd({ op: 'context', post: userPost(kickoffText, 1_000, KICKOFF_TURN) }, { agentId: peer, msgId }),
        () => {}
      )
    }

    // The full alternating chain completes with no further human input.
    await vi.waitFor(() => expect(posts.map((p) => p.post.text)).toEqual(['1', '2', '3', '4', '5', '6']), WAIT)
    await settle()
    expect(posts).toHaveLength(6) // the declines past 6 commit no post and fan nothing out

    // Alternating attribution, and every post carries its author turn's depth: the
    // kickoff turn is depth 0, each continuation charges exactly one transition.
    expect(posts.map((p) => p.agentId)).toEqual([P1, P2, P1, P2, P1, P2])
    expect(posts.map((p) => (p.post.author.kind === 'agent' ? p.post.author.hopCount : undefined))).toEqual([
      0, 1, 2, 3, 4, 5
    ])

    // Exact wake accounting for the players: P1 = kickoff + wakes on 2/4/6 (the last
    // declines), P2 = wakes on 1/3/5. The author is never woken by its own post.
    expect(prompts.get(P1)).toHaveLength(4)
    expect(prompts.get(P2)).toHaveLength(3)
    for (const p of posts) {
      expect((daemon as any).store.getActivation(rendezvousKey(p.post.postId, p.agentId))).toBeUndefined()
    }
    // …while the delivered edges are admitted exactly-once records.
    const firstWake = (daemon as any).store.getActivation(rendezvousKey(posts[0]!.post.postId, P2))
    expect(firstWake?.state).toBe('admitted')

    // The silent referee: woken (at least once; queued wakes may coalesce into a
    // regeneration), never a post, never a transcript reply row.
    expect(prompts.get(REF)!.length).toBeGreaterThanOrEqual(1)
    expect(posts.some((p) => p.agentId === REF)).toBe(false)
    const refRows = (daemon as any).store
      .transcriptSince(transcriptChannelKey(CONV, undefined), `webchat:${CONV}`, null)
      .filter((row: { sender: string }) => row.sender === REF)
    expect(refRows).toEqual([])

    // A woken player's prompt names the author of the post that woke it.
    expect(prompts.get(P2)![0]).toContain(`[${P1}] 1`)
    await daemon.stop()
  }, 30_000)

  it('activates the whole roster on an unnarrowed human kickoff (standing mention, unchanged)', async () => {
    const { factory, prompts } = scriptedHosts({ [P1]: () => 'a1', [P2]: () => 'a2' })
    const daemon = new Daemon({ root: scaffold([P1, P2]), hostFactory: factory })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()
    for (const [agentId, msgId] of [
      [P1, 'turn-a'],
      [P2, 'turn-b']
    ] as const) {
      const ack = (daemon as any).handleRelayMsg(
        rd(
          {
            op: 'turn',
            text: 'hello both',
            user: 'owner',
            turnId: KICKOFF_TURN,
            post: { postId: KICKOFF_TURN, at: 1_000 }
          },
          { agentId, msgId }
        ),
        () => {}
      )
      expect(ack).toMatchObject({ accepted: true })
    }
    await vi.waitFor(() => {
      expect(prompts.get(P1)).toHaveLength(1)
      expect(prompts.get(P2)).toHaveLength(1)
    }, WAIT)
    await daemon.stop()
  }, 15_000)

  it('a full alternating chain terminates at the hop cap with a recorded refusal', async () => {
    // Neither player ever declines — the loop protections are the only terminator,
    // exactly the post-#549 expectation. Chain depth: kickoff turn 0, then one
    // continuation per post until the +1 transition reaches MAX_AGENT_CALL_HOPS.
    let n = 0
    const always = () => String(++n)
    const { factory } = scriptedHosts({ [P1]: always, [P2]: always })
    const daemon = new Daemon({ root: scaffold([P1, P2]), hostFactory: factory })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()
    seedCallPolicy(daemon, [P1, P2])
    const infoSpy = vi.spyOn((daemon as any).log, 'info')
    const holder = { current: daemon }
    const { posts, fanOut } = fakeRelay(holder, [P1, P2])
    ;(daemon as any).relays = { sendWebchatPost: fanOut, stop: async () => {} }

    ;(daemon as any).handleRelayMsg(
      rd(
        {
          op: 'turn',
          text: 'count forever, alternating',
          user: 'owner',
          turnId: KICKOFF_TURN,
          post: { postId: KICKOFF_TURN, at: 1_000 }
        },
        { agentId: P1, msgId: 'turn-p1' }
      ),
      () => {},
      fanOut
    )

    // Posts at depths 0..MAX-1; the wake that would run at depth MAX is refused.
    await vi.waitFor(() => expect(posts).toHaveLength(MAX_AGENT_CALL_HOPS), { timeout: 25_000 })
    await settle()
    expect(posts).toHaveLength(MAX_AGENT_CALL_HOPS)
    const last = posts.at(-1)!
    expect(last.post.author.kind === 'agent' && last.post.author.hopCount).toBe(MAX_AGENT_CALL_HOPS - 1)
    expect(infoSpy.mock.calls.map((c) => c[0])).toContainEqual(
      expect.stringContaining(`hop_limit: source depth ${MAX_AGENT_CALL_HOPS - 1} + 1 reaches ${MAX_AGENT_CALL_HOPS}`)
    )
    await daemon.stop()
  }, 60_000)

  it('admits one wake per (post, target): a re-fanned copy under a fresh relay msgId does not double-wake', async () => {
    const { factory, prompts } = scriptedHosts({ [P1]: () => NO_RESPONSE })
    const daemon = new Daemon({ root: scaffold([P1]), hostFactory: factory })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()
    seedCallPolicy(daemon, [P1, P2]) // the author lives on another daemon — only the edge matters
    const post = agentPost(P2, 'peer says hi', 2_000, '00000001-0000-4000-8000-000000000001', 0)
    ;(daemon as any).handleRelayMsg(rd({ op: 'context', post }, { msgId: 'c-1' }), () => {})
    ;(daemon as any).handleRelayMsg(rd({ op: 'context', post }, { msgId: 'c-2' }), () => {})
    await vi.waitFor(() => expect(prompts.get(P1)).toHaveLength(1), WAIT)
    await settle()
    expect(prompts.get(P1)).toHaveLength(1)
    await daemon.stop()
  }, 15_000)

  it('an agent post with no depth stamp stays transcript-only (pre-parity daemon, fail closed)', async () => {
    const { factory, prompts } = scriptedHosts({ [P1]: () => 'should never run' })
    const daemon = new Daemon({ root: scaffold([P1]), hostFactory: factory })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()
    seedCallPolicy(daemon, [P1, P2])
    const post = agentPost(P2, 'legacy peer post', 2_000, '00000002-0000-4000-8000-000000000002')
    ;(daemon as any).handleRelayMsg(rd({ op: 'context', post }, { msgId: 'c-1' }), () => {})
    await settle()
    // Recorded for §8.5 catch-up…
    const rows = (daemon as any).store
      .transcriptSince(transcriptChannelKey(CONV, undefined), `webchat:${CONV}`, null)
      .map((row: { text: string }) => row.text)
    expect(rows).toEqual(['legacy peer post'])
    // …but no activation.
    expect(prompts.get(P1)).toHaveLength(0)
    await daemon.stop()
  }, 15_000)

  it('the author never self-activates: a context frame mis-addressed to the author is dropped', async () => {
    const { factory, prompts } = scriptedHosts({ [P1]: () => 'should never run' })
    const daemon = new Daemon({ root: scaffold([P1]), hostFactory: factory })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()
    seedCallPolicy(daemon, [P1])
    // A (buggy or malicious) relay addressing the author's own post back at it.
    const post = agentPost(P1, 'my own words', 2_000, '00000003-0000-4000-8000-000000000003', 0)
    ;(daemon as any).handleRelayMsg(rd({ op: 'context', post }, { agentId: P1, msgId: 'c-1' }), () => {})
    await settle()
    expect(prompts.get(P1)).toHaveLength(0)
    expect((daemon as any).store.getActivation(rendezvousKey(post.postId, P1))).toBeUndefined()
    await daemon.stop()
  }, 15_000)

  it('the directional call policy gates the continuation edge', async () => {
    const { factory, prompts } = scriptedHosts({ [P1]: () => 'should never run' })
    const daemon = new Daemon({ root: scaffold([P1]), hostFactory: factory })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()
    seedCallPolicy(daemon, [P1, P2], { [P1]: { callPolicy: 'selected', allowedCallerAgentIds: [] } })
    const post = agentPost(P2, 'not allowed to wake you', 2_000, '00000004-0000-4000-8000-000000000004', 0)
    ;(daemon as any).handleRelayMsg(rd({ op: 'context', post }, { msgId: 'c-1' }), () => {})
    await settle()
    expect(prompts.get(P1)).toHaveLength(0) // transcript-only; the row still records
    const rows = (daemon as any).store
      .transcriptSince(transcriptChannelKey(CONV, undefined), `webchat:${CONV}`, null)
      .map((row: { text: string }) => row.text)
    expect(rows).toEqual(['not allowed to wake you'])
    await daemon.stop()
  }, 15_000)

  it('streaming never activates: peers wake only on the committed post, not while the author is generating', async () => {
    let releaseP1!: () => void
    const p1Blocked = new Promise<void>((resolve) => (releaseP1 = resolve))
    const { factory, prompts } = scriptedHosts({
      [P1]: async () => {
        await p1Blocked
        return 'the committed answer'
      },
      [P2]: () => NO_RESPONSE
    })
    const daemon = new Daemon({ root: scaffold([P1, P2]), hostFactory: factory })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()
    seedCallPolicy(daemon, [P1, P2])
    const holder = { current: daemon }
    const { posts, fanOut } = fakeRelay(holder, [P1, P2])
    ;(daemon as any).relays = { sendWebchatPost: fanOut, stop: async () => {} }
    ;(daemon as any).handleRelayMsg(
      rd(
        { op: 'turn', text: 'go', user: 'owner', turnId: KICKOFF_TURN, post: { postId: KICKOFF_TURN, at: 1_000 } },
        { agentId: P1, msgId: 'turn-p1' }
      ),
      () => {},
      fanOut
    )
    await vi.waitFor(() => expect(prompts.get(P1)).toHaveLength(1), WAIT)
    await settle()
    // Mid-generation: nothing committed, nothing fanned, peer untouched.
    expect(posts).toHaveLength(0)
    expect(prompts.get(P2)).toHaveLength(0)
    releaseP1()
    await vi.waitFor(() => expect(prompts.get(P2)).toHaveLength(1), WAIT)
    expect(posts.map((p) => p.post.text)).toEqual(['the committed answer'])
    await daemon.stop()
  }, 15_000)
})
