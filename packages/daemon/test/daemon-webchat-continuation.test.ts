import { describe, expect, it, vi } from 'vitest'
import { MAX_AGENT_CALL_HOPS } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { transcriptChannelKey } from '../src/store/local-store.js'
import {
  NO_RESPONSE,
  agentPost as agentPostIn,
  fakeCpClient,
  fakeRelay as fakeRelayIn,
  rdFactory,
  rendezvousKey,
  scaffold,
  scriptedHosts,
  seedCallPolicy,
  settle,
  userPost as userPostIn
} from './webchat-continuation-fixture.js'
import type { RdChatEvent, WebchatPost } from '@agentconnect.md/protocol'

// #549 parity for multi-agent webchat (webchat-multi-agents.md §5.2a, issue #904):
// a peer agent's COMMITTED conversation post — delivered to this participant as a
// relay `context` frame — continues the conversation instead of staying
// transcript-only, with the platform ladder's protections: the hop transition
// against MAX_AGENT_CALL_HOPS, exactly-once per (post, target) through the durable
// activation rendezvous, final-events-only (structural), author exclusion, and the
// directional call policy. These tests drive the daemon exactly the way the relay
// does (handleRelayMsg) and play the relay's roster fan-out themselves.
//
// The setup helpers live in `webchat-continuation-fixture.ts`, shared with the
// cross-surface activation parity leg (`evals/test/parity-webchat.test.ts`).

const P1 = 'bot-a'
const P2 = 'bot-b'
const REF = 'bot-ref'
const CONV = '88888888-8888-4888-8888-888888888888'
const KICKOFF_TURN = '77777777-7777-4777-8777-777777777777'
const WAIT = { timeout: 10_000 }

const rd = rdFactory(CONV, P1)
const fakeRelay = (daemonRef: { current?: Daemon }, roster: string[]) => fakeRelayIn(daemonRef, roster, CONV)
const userPost = (text: string, at: number, postId: string): WebchatPost => userPostIn(CONV, text, at, postId)
const agentPost = (agentId: string, text: string, at: number, postId: string, hopCount?: number): WebchatPost =>
  agentPostIn(CONV, agentId, text, at, postId, hopCount)
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
    const ack = await (daemon as any).handleRelayMsg(
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
      await (daemon as any).handleRelayMsg(
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
      expect(await (daemon as any).store.getActivation(rendezvousKey(p.post.postId, p.agentId))).toBeUndefined()
    }
    // …while the delivered edges are admitted exactly-once records.
    const firstWake = await (daemon as any).store.getActivation(rendezvousKey(posts[0]!.post.postId, P2))
    expect(firstWake?.state).toBe('admitted')

    // The silent referee: woken (at least once; queued wakes may coalesce into a
    // regeneration), never a post, never a transcript reply row.
    expect(prompts.get(REF)!.length).toBeGreaterThanOrEqual(1)
    expect(posts.some((p) => p.agentId === REF)).toBe(false)
    const refRows = (
      await (daemon as any).store.transcriptSince(transcriptChannelKey(CONV, undefined), `webchat:${CONV}`, null)
    ).filter((row: { sender: string }) => row.sender === REF)
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
      const ack = await (daemon as any).handleRelayMsg(
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
  })

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

    await (daemon as any).handleRelayMsg(
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
    await (daemon as any).handleRelayMsg(rd({ op: 'context', post }, { msgId: 'c-1' }), () => {})
    await (daemon as any).handleRelayMsg(rd({ op: 'context', post }, { msgId: 'c-2' }), () => {})
    await vi.waitFor(() => expect(prompts.get(P1)).toHaveLength(1), WAIT)
    await settle()
    expect(prompts.get(P1)).toHaveLength(1)
    await daemon.stop()
  })

  it('an agent post with no depth stamp stays transcript-only (pre-parity daemon, fail closed)', async () => {
    const { factory, prompts } = scriptedHosts({ [P1]: () => 'should never run' })
    const daemon = new Daemon({ root: scaffold([P1]), hostFactory: factory })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()
    seedCallPolicy(daemon, [P1, P2])
    const post = agentPost(P2, 'legacy peer post', 2_000, '00000002-0000-4000-8000-000000000002')
    await (daemon as any).handleRelayMsg(rd({ op: 'context', post }, { msgId: 'c-1' }), () => {})
    await settle()
    // Recorded for §8.5 catch-up…
    const rows = (
      await (daemon as any).store.transcriptSince(transcriptChannelKey(CONV, undefined), `webchat:${CONV}`, null)
    ).map((row: { text: string }) => row.text)
    expect(rows).toEqual(['legacy peer post'])
    // …but no activation.
    expect(prompts.get(P1)).toHaveLength(0)
    await daemon.stop()
  })

  // The fan-out leg of the #912 regression: a user turn targeted at one participant
  // reaches the rest as a `context` post, and that copy wrote the author's DISPLAY NAME
  // as the transcript sender too. Both writers must agree on the stable principal, or a
  // peer's copy of one post identifies its author differently from the target's copy.
  it("records a user context post under the author's principal, and caches their handle", async () => {
    const { factory } = scriptedHosts({ [P1]: () => NO_RESPONSE })
    const daemon = new Daemon({ root: scaffold([P1]), hostFactory: factory })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()
    seedCallPolicy(daemon, [P1, P2])
    const post: WebchatPost = {
      ...userPost('a peer sees this', 2_000, '00000009-0000-4000-8000-000000000009'),
      author: { kind: 'user', user: 'Ada Lovelace', userId: 'user-1' }
    }
    await (daemon as any).handleRelayMsg(rd({ op: 'context', post }, { msgId: 'c-1' }), () => {})
    await settle()

    const rows = (await (daemon as any).store.transcriptSince(
      transcriptChannelKey(CONV, undefined),
      `webchat:${CONV}`,
      null
    )) as { sender: string; text: string }[]
    expect(rows.map((r) => r.text)).toEqual(['a peer sees this'])
    expect(rows[0]!.sender).toBe('user-1')
    expect((await (daemon as any).store.getDisplayNames(['user-1'])).get('user-1')).toBe('Ada Lovelace')
    await daemon.stop()
  })

  it('the author never self-activates: a context frame mis-addressed to the author is dropped', async () => {
    const { factory, prompts } = scriptedHosts({ [P1]: () => 'should never run' })
    const daemon = new Daemon({ root: scaffold([P1]), hostFactory: factory })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()
    seedCallPolicy(daemon, [P1])
    // A (buggy or malicious) relay addressing the author's own post back at it.
    const post = agentPost(P1, 'my own words', 2_000, '00000003-0000-4000-8000-000000000003', 0)
    await (daemon as any).handleRelayMsg(rd({ op: 'context', post }, { agentId: P1, msgId: 'c-1' }), () => {})
    await settle()
    expect(prompts.get(P1)).toHaveLength(0)
    expect(await (daemon as any).store.getActivation(rendezvousKey(post.postId, P1))).toBeUndefined()
    await daemon.stop()
  })

  it('the directional call policy gates the continuation edge', async () => {
    const { factory, prompts } = scriptedHosts({ [P1]: () => 'should never run' })
    const daemon = new Daemon({ root: scaffold([P1]), hostFactory: factory })
    await daemon.start()
    ;(daemon as any).cpClient = fakeCpClient()
    seedCallPolicy(daemon, [P1, P2], { [P1]: { callPolicy: 'selected', allowedCallerAgentIds: [] } })
    const post = agentPost(P2, 'not allowed to wake you', 2_000, '00000004-0000-4000-8000-000000000004', 0)
    await (daemon as any).handleRelayMsg(rd({ op: 'context', post }, { msgId: 'c-1' }), () => {})
    await settle()
    expect(prompts.get(P1)).toHaveLength(0) // transcript-only; the row still records
    const rows = (
      await (daemon as any).store.transcriptSince(transcriptChannelKey(CONV, undefined), `webchat:${CONV}`, null)
    ).map((row: { text: string }) => row.text)
    expect(rows).toEqual(['not allowed to wake you'])
    await daemon.stop()
  })

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
    await (daemon as any).handleRelayMsg(
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
  })
})
