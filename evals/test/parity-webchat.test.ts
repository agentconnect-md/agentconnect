/**
 * Webchat leg of the cross-surface activation parity suite
 * (`evals/parity/spec.ts` — read its header for the governance rule).
 *
 * Drives the SAME daemon seam PR #906's tests drive — `handleRelayMsg` fed the
 * relay's pre-addressed `turn` frames, with the §5.2 roster fan-out of
 * committed posts played by the leg (`webchat-continuation-fixture.ts`) — and
 * asserts each spec scenario's declared outcome from the daemon's own records:
 * scripted-host prompt logs, committed `rd/webchat-post` frames, the durable
 * activation rendezvous, and the shared conversation transcript.
 *
 * Every scenario the spec declares for this surface MUST have a driver here;
 * the coverage guard at the bottom fails otherwise.
 */
import { describe, expect, it, vi } from 'vitest'
import { MAX_AGENT_CALL_HOPS } from '../../packages/protocol/src/consts.js'
import { Daemon } from '../../packages/daemon/src/daemon.js'
import { transcriptChannelKey } from '../../packages/daemon/src/store/local-store.js'
import {
  NO_RESPONSE,
  agentPost,
  fakeCpClient,
  fakeRelay,
  rdFactory,
  rendezvousKey,
  scaffold,
  scriptedHosts,
  seedCallPolicy,
  settle,
  userPost
} from '../../packages/daemon/test/webchat-continuation-fixture.js'
import { selectTurnTargets } from '../../packages/relay/src/relay-browser-connection.js'
import { declaredOutcome, scenariosFor, type ParityScenario } from '../parity/spec.js'
import type { RdWebchatPost } from '../../packages/protocol/src/index.js'

const P1 = 'bot-a'
const P2 = 'bot-b'
const REF = 'bot-ref'
const CONV = '99999999-9999-4999-8999-999999999999'
const KICKOFF_TURN = '66666666-6666-4666-8666-666666666666'
const WAIT = { timeout: 10_000 }

const rd = rdFactory(CONV, P1)

interface WebchatLeg {
  daemon: Daemon
  prompts: Map<string, string[]>
  posts: RdWebchatPost[]
  fanOut: (p: RdWebchatPost) => void
  stop: () => Promise<void>
}

/** Boot one control-plane-less daemon hosting `agents`, with the leg playing
 *  the relay (`fanOut`) and an open call policy across the roster. */
async function startLeg(agents: string[], replies: Record<string, (prompt: string) => string | Promise<string>>) {
  const { factory, prompts } = scriptedHosts(replies)
  const daemon = new Daemon({ root: scaffold(agents), hostFactory: factory })
  await daemon.start()
  ;(daemon as any).cpClient = fakeCpClient()
  seedCallPolicy(daemon, agents)
  const holder = { current: daemon }
  const { posts, fanOut } = fakeRelay(holder, agents, CONV)
  ;(daemon as any).relays = { sendWebchatPost: fanOut, stop: async () => {} }
  const leg: WebchatLeg = { daemon, prompts, posts, fanOut, stop: () => daemon.stop() }
  return leg
}

/** One pre-addressed relay `turn` frame — how the relay activates ONE target
 *  of a user turn (webchat-multi-agents.md §4.3). */
function injectTurn(
  leg: WebchatLeg,
  agentId: string,
  text: string,
  options: { msgId: string; mentions?: string[]; postId?: string; at?: number; withPostSink?: boolean } = {
    msgId: 'turn-1'
  }
): Promise<unknown> {
  return (leg.daemon as any).handleRelayMsg(
    rd(
      {
        op: 'turn',
        text,
        user: 'owner',
        turnId: options.postId ?? KICKOFF_TURN,
        ...(options.mentions !== undefined ? { mentions: options.mentions } : {}),
        post: { postId: options.postId ?? KICKOFF_TURN, at: options.at ?? 1_000 }
      },
      { agentId, msgId: options.msgId }
    ),
    () => {},
    options.withPostSink === false ? undefined : leg.fanOut
  )
}

/**
 * Play the relay's §5.2 user-turn fan-out for a target set the PRODUCTION
 * choice (`selectTurnTargets`) computed: a pre-addressed `turn` frame per
 * target, and a transcript-only user `context` copy to every other roster
 * member — exactly what `RelayBrowserConnection.sendTurn` emits.
 */
async function playRelayUserTurn(
  leg: WebchatLeg,
  roster: readonly string[],
  targets: readonly string[],
  text: string,
  options: { mentions?: string[]; postId: string; at: number; msgPrefix: string }
): Promise<void> {
  for (const [index, agentId] of targets.entries()) {
    expect(
      await injectTurn(leg, agentId, text, {
        msgId: `${options.msgPrefix}-t${index}`,
        ...(options.mentions !== undefined ? { mentions: options.mentions } : {}),
        postId: options.postId,
        at: options.at
      })
    ).toMatchObject({ accepted: true })
  }
  for (const [index, peer] of roster.filter((agentId) => !targets.includes(agentId)).entries()) {
    await (leg.daemon as any).handleRelayMsg(
      rd(
        { op: 'context', post: userPost(CONV, text, options.at, options.postId) },
        { agentId: peer, msgId: `${options.msgPrefix}-c${index}` }
      ),
      () => {}
    )
  }
}

/** Reply rows a given sender committed into the shared conversation log. */
async function transcriptRowsBy(leg: WebchatLeg, sender: string): Promise<unknown[]> {
  const rows = await (leg.daemon as any).store.transcriptSince(
    transcriptChannelKey(CONV, undefined),
    `webchat:${CONV}`,
    null
  )
  return rows.filter((row: { sender: string }) => row.sender === sender)
}

const drivers: Record<string, (scenario: ParityScenario) => Promise<void>> = {
  // (a) Standing mention: an unnarrowed kickoff activates the WHOLE roster
  // (every participant gets a pre-addressed `turn` frame); mention-narrowing
  // reduces the set to the named participants, and a user post's `context`
  // copy to a non-target never activates.
  'human-kickoff-activation': async (scenario) => {
    // The spec is load-bearing: editing this scenario's declared outcome
    // fails this pin; changing the behavior fails the measured asserts below.
    expect(declaredOutcome(scenario.expect.webchat!)).toEqual({ activates: 'roster' })
    const leg = await startLeg([P1, P2, REF], {
      [P1]: () => NO_RESPONSE,
      [P2]: () => NO_RESPONSE,
      [REF]: () => NO_RESPONSE
    })
    const roster = [P1, P2, REF]
    try {
      // Unnarrowed kickoff: the PRODUCTION choice (relay `selectTurnTargets`)
      // picks the whole roster, so every member gets a `turn` frame.
      const unnarrowed = selectTurnTargets(roster, {})
      expect(unnarrowed).toEqual({ valid: roster, invalid: [] })
      await playRelayUserTurn(leg, roster, unnarrowed.valid, 'hello everyone', {
        postId: KICKOFF_TURN,
        at: 1_000,
        msgPrefix: 'kick'
      })
      await vi.waitFor(() => {
        expect(leg.prompts.get(P1)).toHaveLength(1)
        expect(leg.prompts.get(P2)).toHaveLength(1)
        expect(leg.prompts.get(REF)).toHaveLength(1)
      }, WAIT)

      // Mention-narrowed follow-up: the production choice reduces the set to
      // the named participant; the others get the user post as a `context`
      // copy, which never activates.
      const narrowed = selectTurnTargets(roster, { mentions: [P1] })
      expect(narrowed).toEqual({ valid: [P1], invalid: [] })
      const narrowedId = '11111111-0000-4000-8000-000000000001'
      await playRelayUserTurn(leg, roster, narrowed.valid, 'just you, player one', {
        mentions: [P1],
        postId: narrowedId,
        at: 2_000,
        msgPrefix: 'narrow'
      })
      await vi.waitFor(() => expect(leg.prompts.get(P1)).toHaveLength(2), WAIT)
      await settle()
      expect(leg.prompts.get(P2)).toHaveLength(1)
      expect(leg.prompts.get(REF)).toHaveLength(1)
    } finally {
      await leg.stop()
    }
  },

  // (b) A committed agent post wakes every other participant, never its author.
  'agent-continuation-minus-author': async (scenario) => {
    // The spec is load-bearing: editing this scenario's declared outcome
    // fails this pin; changing the behavior fails the measured asserts below.
    expect(declaredOutcome(scenario.expect.webchat!)).toEqual({ activates: 'participants-minus-author' })
    const leg = await startLeg([P1, P2, REF], {
      [P1]: (text) => (/kick off/.test(text) ? 'the one committed post' : NO_RESPONSE),
      [P2]: () => NO_RESPONSE,
      [REF]: () => NO_RESPONSE
    })
    try {
      expect(await injectTurn(leg, P1, 'kick off, please', { msgId: 't-1', mentions: [P1] })).toMatchObject({
        accepted: true
      })
      await vi.waitFor(() => expect(leg.posts.map((p) => p.post.text)).toEqual(['the one committed post']), WAIT)
      await vi.waitFor(() => {
        expect(leg.prompts.get(P2)).toHaveLength(1)
        expect(leg.prompts.get(REF)).toHaveLength(1)
      }, WAIT)
      await settle()
      // The author was activated by the human turn only — never by its own post.
      expect(leg.prompts.get(P1)).toHaveLength(1)
      const postId = leg.posts[0]!.post.postId
      expect(await (leg.daemon as any).store.getActivation(rendezvousKey(postId, P1))).toBeUndefined()
      // Each delivered edge is an admitted exactly-once record.
      for (const target of [P2, REF]) {
        expect((await (leg.daemon as any).store.getActivation(rendezvousKey(postId, target)))?.state).toBe('admitted')
      }
      // The woken peer's prompt names the author of the post that woke it.
      expect(leg.prompts.get(P2)![0]).toContain(`[${P1}] the one committed post`)
    } finally {
      await leg.stop()
    }
  },

  // (c) A context frame mis-addressed to the post's own author is dropped —
  // no prompt, no rendezvous record.
  'author-never-self-activates': async (scenario) => {
    // The spec is load-bearing: editing this scenario's declared outcome
    // fails this pin; changing the behavior fails the measured asserts below.
    expect(declaredOutcome(scenario.expect.webchat!)).toEqual({ activates: 'nobody' })
    const leg = await startLeg([P1], { [P1]: () => 'should never run' })
    try {
      const post = agentPost(CONV, P1, 'my own words', 2_000, '00000003-0000-4000-8000-000000000003', 0)
      await (leg.daemon as any).handleRelayMsg(rd({ op: 'context', post }, { agentId: P1, msgId: 'c-1' }), () => {})
      await settle()
      expect(leg.prompts.get(P1)).toHaveLength(0)
      expect(await (leg.daemon as any).store.getActivation(rendezvousKey(post.postId, P1))).toBeUndefined()
    } finally {
      await leg.stop()
    }
  },

  // (d) Exactly one admission per (message, target). This surface's addressed
  // edge is the relay's pre-addressed fan-out copy — webchat agent posts carry
  // no structured mentions — and a re-fanned identical copy under a fresh
  // relay msgId is absorbed by the durable rendezvous.
  'delivery-exactly-once': async (scenario) => {
    // The spec is load-bearing: editing this scenario's declared outcome
    // fails this pin; changing the behavior fails the measured asserts below.
    expect(declaredOutcome(scenario.expect.webchat!)).toEqual({ activates: 'target-exactly-once' })
    const leg = await startLeg([P1], { [P1]: () => NO_RESPONSE })
    try {
      seedCallPolicy(leg.daemon, [P1, P2]) // the author lives on another daemon — only the edge matters
      const post = agentPost(CONV, P2, 'peer says hi', 2_000, '00000001-0000-4000-8000-000000000001', 0)
      await (leg.daemon as any).handleRelayMsg(rd({ op: 'context', post }, { msgId: 'c-1' }), () => {})
      await (leg.daemon as any).handleRelayMsg(rd({ op: 'context', post }, { msgId: 'c-2' }), () => {})
      await vi.waitFor(() => expect(leg.prompts.get(P1)).toHaveLength(1), WAIT)
      await settle()
      expect(leg.prompts.get(P1)).toHaveLength(1)
    } finally {
      await leg.stop()
    }
  },

  // (e) Streaming never routes: while the author is still generating nothing
  // fans out and no peer wakes; the committed post is what activates.
  'streaming-never-routes': async (scenario) => {
    // The spec is load-bearing: editing this scenario's declared outcome
    // fails this pin; changing the behavior fails the measured asserts below.
    expect(declaredOutcome(scenario.expect.webchat!)).toEqual({
      activates: 'target-exactly-once',
      streamingNeverRoutes: true
    })
    let releaseP1!: () => void
    const p1Blocked = new Promise<void>((resolve) => (releaseP1 = resolve))
    const leg = await startLeg([P1, P2], {
      [P1]: async () => {
        await p1Blocked
        return 'the committed answer'
      },
      [P2]: () => NO_RESPONSE
    })
    try {
      await injectTurn(leg, P1, 'go', { msgId: 't-1', mentions: [P1] })
      await vi.waitFor(() => expect(leg.prompts.get(P1)).toHaveLength(1), WAIT)
      await settle()
      // Mid-generation: nothing committed, nothing fanned, peer untouched.
      expect(leg.posts).toHaveLength(0)
      expect(leg.prompts.get(P2)).toHaveLength(0)
      releaseP1()
      await vi.waitFor(() => expect(leg.prompts.get(P2)).toHaveLength(1), WAIT)
      expect(leg.posts.map((p) => p.post.text)).toEqual(['the committed answer'])
    } finally {
      await leg.stop()
    }
  },

  // (f) One +1 per edge against MAX_AGENT_CALL_HOPS; the edge that would run
  // at the cap is refused with a recorded hop_limit reason. (Declared
  // divergence: channels ALSO charge the loop guard, which binds first.)
  'hop-transition-and-refusal': async (scenario) => {
    // The spec is load-bearing: editing this scenario's declared outcome
    // fails this pin; changing the behavior fails the measured asserts below.
    expect(declaredOutcome(scenario.expect.webchat!)).toEqual({
      activates: 'participants-minus-author',
      refusal: { reason: 'hop_limit', afterEdges: MAX_AGENT_CALL_HOPS - 1 }
    })
    const refusal = scenario.expect.webchat!.refusal!
    let n = 0
    const always = () => String(++n)
    const leg = await startLeg([P1, P2], { [P1]: always, [P2]: always })
    try {
      const infoSpy = vi.spyOn((leg.daemon as any).log, 'info')
      await injectTurn(leg, P1, 'count forever, alternating', { msgId: 't-1' })
      // Kickoff post at depth 0, one continuation per admitted edge at depths
      // 1..cap-1 — afterEdges + 1 posts in total, then the recorded refusal.
      await vi.waitFor(() => expect(leg.posts).toHaveLength(refusal.afterEdges + 1), { timeout: 25_000 })
      await settle()
      expect(leg.posts).toHaveLength(refusal.afterEdges + 1)
      expect(leg.posts.map((p) => (p.post.author.kind === 'agent' ? p.post.author.hopCount : undefined))).toEqual(
        Array.from({ length: refusal.afterEdges + 1 }, (_, depth) => depth)
      )
      expect(infoSpy.mock.calls.map((c) => c[0])).toContainEqual(
        expect.stringContaining(`hop_limit: source depth ${MAX_AGENT_CALL_HOPS - 1} + 1 reaches ${MAX_AGENT_CALL_HOPS}`)
      )
    } finally {
      await leg.stop()
    }
  },

  // (g) A silent decline absorbs the wake: no post, no transcript reply row,
  // nothing further fans out.
  'silent-decline-absorbs-wake': async (scenario) => {
    // The spec is load-bearing: editing this scenario's declared outcome
    // fails this pin; changing the behavior fails the measured asserts below.
    expect(declaredOutcome(scenario.expect.webchat!)).toEqual({
      activates: 'participants-minus-author',
      silentDeclinePostsNothing: true
    })
    const leg = await startLeg([P1, REF], {
      [P1]: (text) => (/kick off/.test(text) ? 'observed post' : NO_RESPONSE),
      [REF]: () => NO_RESPONSE
    })
    try {
      injectTurn(leg, P1, 'kick off, please', { msgId: 't-1', mentions: [P1] })
      await vi.waitFor(() => expect(leg.prompts.get(REF)).toHaveLength(1), WAIT)
      await settle()
      // Woken, silent: no committed post by the decliner, no reply row, and
      // the exchange ends (nothing further woke the author).
      expect(leg.posts.map((p) => p.agentId)).toEqual([P1])
      expect(await transcriptRowsBy(leg, REF)).toEqual([])
      expect(leg.prompts.get(P1)).toHaveLength(1)
    } finally {
      await leg.stop()
    }
  },

  // (i) Fail closed on an unverifiable author: an agent post with no usable
  // depth stamp (pre-parity daemon, or a claim the relay could not bind and
  // therefore stripped — §5.2a) is transcript-only.
  'unverified-author-no-agent-rungs': async (scenario) => {
    // The spec is load-bearing: editing this scenario's declared outcome
    // fails this pin; changing the behavior fails the measured asserts below.
    expect(declaredOutcome(scenario.expect.webchat!)).toEqual({ activates: 'nobody' })
    const leg = await startLeg([P1], { [P1]: () => 'should never run' })
    try {
      seedCallPolicy(leg.daemon, [P1, P2])
      const post = agentPost(CONV, P2, 'legacy peer post', 2_000, '00000002-0000-4000-8000-000000000002')
      await (leg.daemon as any).handleRelayMsg(rd({ op: 'context', post }, { msgId: 'c-1' }), () => {})
      await settle()
      // Recorded for §8.5 catch-up…
      expect((await transcriptRowsBy(leg, P2)).map((row) => (row as { text: string }).text)).toEqual([
        'legacy peer post'
      ])
      // …but no activation.
      expect(leg.prompts.get(P1)).toHaveLength(0)
    } finally {
      await leg.stop()
    }
  }
}

describe('activation parity — webchat leg', () => {
  const scenarios = scenariosFor('webchat')

  it('covers every scenario the spec declares for this surface', () => {
    expect(new Set(scenarios.map((s) => s.id))).toEqual(new Set(Object.keys(drivers)))
  })

  for (const scenario of scenarios) {
    it(`${scenario.id} — ${scenario.title}`, async () => {
      const driver = drivers[scenario.id]
      expect(driver, `no webchat driver for spec scenario "${scenario.id}"`).toBeDefined()
      await driver!(scenario)
    }, 60_000)
  }
})
