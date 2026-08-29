/**
 * Routing acceptance suite for the sendMessage routing rework
 * (docs/designs/send-message-routing-rework.md, PR #503).
 *
 * Each case pins the PRODUCT INVARIANT — who gets activated, what is visible
 * in IM, exactly-once — never mechanism internals. Cases the current
 * architecture supports run green today; cases that need the #503 rework are
 * `it.fails(…)`: they PASS while the invariant is still violated and will
 * start failing (flip them to `it`) the moment the implementation lands.
 *
 * Conventions in this suite:
 *  - one mention-gated Slack-shaped room (production shared-channel routing);
 *  - scripted hosts issue REAL sendMessage tool calls over the daemon's MCP
 *    control socket mid-turn;
 *  - every delivered agent post is echoed back as real platform ingress under
 *    the author's managed bot identity (what production Slack does); whether
 *    an echo activates anyone is the daemon's decision — the thing under test.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { RoutingFixture, type RoutingScriptContext } from './routing-fixture.js'

// The one shared cap every enforcement point reads — imported rather than mirrored so
// this suite cannot pin a stale number after the budget is retuned.
import { MAX_AGENT_CALL_HOPS } from '../../packages/protocol/src/consts.js'

let fixture: RoutingFixture | undefined

afterEach(async () => {
  await fixture?.stop()
  fixture = undefined
})

describe('case 1 — sendMessage {toAgent, channel}: one visible root post, one activation', () => {
  async function startCase1(): Promise<RoutingFixture> {
    return RoutingFixture.start({
      agents: ['agent1', 'agent2'],
      scripts: {
        agent1: async (ctx) => {
          const wake = /WAKE ([0-9a-f-]{36})/.exec(ctx.text)
          if (wake) {
            const result = await ctx.callTool('sendMessage', {
              toAgent: { agentId: wake[1]!, needsReply: true },
              channel: fixture!.room.channel,
              message: 'please handle task T-1'
            })
            ctx.reply(result.ok ? 'delegated' : `delegation failed: ${result.error ?? 'unknown'}`)
            return
          }
          ctx.reply('noted')
        },
        agent2: (ctx) => {
          if (/task T-1/.test(ctx.text)) {
            ctx.reply('ack: working on T-1')
            return
          }
          ctx.reply('agent2 heard you')
        }
      }
    })
  }

  it('activates the target exactly once, anchored to the single root post; a thread reply reaches only the target', async () => {
    fixture = await startCase1()
    const trigger = fixture.injectHuman(`<@${fixture.botUserId('agent1')}> WAKE ${fixture.agentId('agent2')}`, {
      mentions: [fixture.botUserId('agent1')]
    })
    await fixture.settle(trigger.handles)

    // Exactly ONE visible channel-root post carrying the delegated task — the
    // internal wake and the platform echo are one logical delivery.
    const roots = fixture.deliveredPosts().filter((post) => post.thread === undefined)
    expect(roots).toHaveLength(1)
    expect(roots[0]!.text).toContain('please handle task T-1')
    expect(fixture.aliasOf(roots[0]!.agentId!)).toBe('agent1')
    const rootTs = roots[0]!.messageId!

    // agent2 activated exactly once (no double activation from the echo), and
    // its session is anchored to the root post: its reply lands in that thread.
    expect(fixture.activations('agent2')).toBe(1)
    expect(fixture.turnInputs('agent2')[0]).toContain('task T-1')
    const acks = fixture.deliveredPosts().filter((post) => fixture!.aliasOf(post.agentId!) === 'agent2')
    expect(acks).toHaveLength(1)
    expect(acks[0]!.thread).toBe(rootTs)

    // A HUMAN reply in the anchored thread reaches ONLY the target agent.
    const agent1Before = fixture.activations('agent1')
    const reply = fixture.injectHuman('how is it going?', { thread: rootTs })
    await fixture.settle(reply.handles)
    expect(fixture.activations('agent2')).toBe(2)
    expect(fixture.activations('agent1')).toBe(agent1Before)
    const followUps = fixture
      .deliveredPosts()
      .filter((post) => fixture!.aliasOf(post.agentId!) === 'agent2' && post.thread === rootTs)
    expect(followUps).toHaveLength(2)
  }, 120_000)

  // #503 §3.2: "Renders the target's platform-native mention into the visible
  // body" — for a dedicated Slack bot the body begins with <@U_TARGET>.
  // Flipped green when the rework landed (PR #503 merged).
  it('renders the target agent mention into the visible root post (#503 §3.2)', async () => {
    fixture = await startCase1()
    const trigger = fixture.injectHuman(`<@${fixture.botUserId('agent1')}> WAKE ${fixture.agentId('agent2')}`, {
      mentions: [fixture.botUserId('agent1')]
    })
    await fixture.settle(trigger.handles)
    const roots = fixture.deliveredPosts().filter((post) => post.thread === undefined)
    expect(roots).toHaveLength(1)
    expect(roots[0]!.text).toContain(`<@${fixture.botUserId('agent2')}>`)
  }, 120_000)
})

describe('case 1b — sendMessage {sessionId: parent}: the report is injected, the parent answers', () => {
  function case1bScripts(resume: (ctx: RoutingScriptContext) => Promise<void> | void) {
    return {
      agent1: async (ctx: RoutingScriptContext) => {
        const wake = /WAKE ([0-9a-f-]{36})/.exec(ctx.text)
        if (wake) {
          const result = await ctx.callTool('sendMessage', {
            toAgent: { agentId: wake[1]!, needsReply: true },
            channel: fixture!.room.channel,
            message: 'please handle task T-1'
          })
          ctx.reply(result.ok ? 'delegated' : `delegation failed: ${result.error ?? 'unknown'}`)
          return
        }
        if (/RESULT R-42/.test(ctx.text)) {
          await resume(ctx)
          return
        }
        ctx.reply('noted')
      },
      agent2: async (ctx: RoutingScriptContext) => {
        const parent = /Parent session: (\S+)/.exec(ctx.text)
        if (parent && /task T-1/.test(ctx.text)) {
          const result = await ctx.callTool('sendMessage', {
            sessionId: parent[1]!,
            message: 'RESULT R-42: task complete'
          })
          ctx.reply(result.ok ? 'reported to parent' : `report failed: ${result.error ?? 'unknown'}`)
          return
        }
        ctx.reply('agent2 heard you')
      }
    }
  }

  /** Every world outbound effect attributable to agent1's RESUMED turn: the
   *  parent's first turn ends with its 'delegated' reply, so anything agent1's
   *  integration attempts AFTER that sequence — body, chrome, typing, status,
   *  delivered or rejected — belongs to the resume. */
  function parentResumeEffects() {
    const agent1Effects = fixture!.effectsOf('agent1')
    const delegated = agent1Effects.find((effect) => effect.kind === 'reply' && /delegated/.test(effect.text))
    expect(delegated, "agent1's first turn should have posted its 'delegated' reply").toBeDefined()
    // Turn 1 ends by CLOSING its own response (the §5 finalize edit of the
    // 'delegated' message) — that belongs to the first turn, not the resume.
    const firstTurnClose = agent1Effects.find(
      (effect) => effect.kind === 'finalize' && effect.messageTs === delegated!.messageId
    )
    const boundary = Math.max(delegated!.sequence, firstTurnClose?.sequence ?? 0)
    return agent1Effects.filter((effect) => effect.sequence > boundary)
  }

  // §7: what stays invisible is the REPORT — no component publishes the injected
  // body — while the resumed parent runs an ORDINARY turn and may answer in its own
  // conversation. The earlier revision muted that turn, which silenced every
  // report-back whose child had answered elsewhere (its own channel-root thread) or
  // nowhere at all, leaving the humans who delegated the work with nothing.
  it('the child’s report is never published, and the resumed parent answers in its own thread (§7)', async () => {
    fixture = await RoutingFixture.start({
      agents: ['agent1', 'agent2'],
      scripts: case1bScripts((ctx) => {
        ctx.reply('thanks, result noted')
      })
    })
    const trigger = fixture.injectHuman(`<@${fixture.botUserId('agent1')}> WAKE ${fixture.agentId('agent2')}`, {
      mentions: [fixture.botUserId('agent1')]
    })
    await fixture.settle(trigger.handles)

    // The parent processed the child's reply.
    expect(fixture.activations('agent1')).toBe(2)
    const resumeInput = fixture.turnInputs('agent1')[1] ?? ''
    expect(resumeInput).toContain('RESULT R-42')

    // HALF ONE — the report itself never became a platform message. Not a body-string
    // probe of one integration: NOTHING anyone attempted, delivered or rejected, carries
    // the injected text. `replyToSession` makes no gateway call at all, so this is
    // structural rather than a flag, and it is the property the design actually promises.
    const published = fixture.world.allEffects().filter((effect) => /RESULT R-42/.test(effect.text ?? ''))
    expect(published.map((effect) => ({ kind: effect.kind, status: effect.status, text: effect.text }))).toEqual([])

    // HALF TWO — the resumed turn is ORDINARY: its own answer reaches the parent's
    // conversation, where the humans who delegated the work are waiting.
    const resumeReplies = parentResumeEffects().filter((effect) => effect.kind === 'reply')
    expect(resumeReplies.map((effect) => effect.status)).toContain('delivered')
    expect(resumeReplies.some((effect) => /thanks, result noted/.test(effect.text ?? ''))).toBe(true)
  }, 120_000)

  // §7: an explicit visible `sendMessage` from the resumed parent is an intentional
  // outbound action with its normal authorization and delivery semantics — it was never
  // gated by how the resumed turn's own reply sink was configured.
  it('an EXPLICIT visible sendMessage from the resumed parent is delivered', async () => {
    fixture = await RoutingFixture.start({
      agents: ['agent1', 'agent2'],
      scripts: case1bScripts(async (ctx) => {
        const result = await ctx.callTool('sendMessage', {
          channel: fixture!.room.channel,
          message: 'ESCALATION E-9: needs human review'
        })
        ctx.reply(result.ok ? 'escalated' : `escalation failed: ${result.error ?? 'unknown'}`)
      })
    })
    const trigger = fixture.injectHuman(`<@${fixture.botUserId('agent1')}> WAKE ${fixture.agentId('agent2')}`, {
      mentions: [fixture.botUserId('agent1')]
    })
    await fixture.settle(trigger.handles)
    expect(fixture.activations('agent1')).toBe(2)
    const escalations = fixture
      .deliveredPosts()
      .filter((post) => fixture!.aliasOf(post.agentId!) === 'agent1' && /ESCALATION E-9/.test(post.text))
    expect(escalations).toHaveLength(1)
    // The intentional outbound is a channel-root post per the §2.2 target table.
    expect(escalations[0]!.thread).toBeUndefined()
  }, 120_000)
})

describe('case 2 — sendMessage {channel}: bare root post, no activation; author owns the thread', () => {
  it('posts once with zero activations; a human thread reply reaches only the author', async () => {
    fixture = await RoutingFixture.start({
      agents: ['agent1', 'agent2'],
      scripts: {
        agent1: async (ctx) => {
          if (/POST UPDATE/.test(ctx.text)) {
            const result = await ctx.callTool('sendMessage', {
              channel: fixture!.room.channel,
              message: 'FYI update U-7: rollout at 80%'
            })
            ctx.reply(result.ok ? 'posted' : `post failed: ${result.error ?? 'unknown'}`)
            return
          }
          if (/any details/.test(ctx.text)) {
            ctx.reply('details: remaining 20% tomorrow')
            return
          }
          ctx.reply('noted')
        },
        agent2: (ctx) => {
          ctx.reply('agent2 should never speak here')
        }
      }
    })
    const trigger = fixture.injectHuman(`<@${fixture.botUserId('agent1')}> POST UPDATE`, {
      mentions: [fixture.botUserId('agent1')]
    })
    await fixture.settle(trigger.handles)

    // One visible root post, no recipient — nobody is activated by it.
    const roots = fixture.deliveredPosts().filter((post) => post.thread === undefined)
    expect(roots).toHaveLength(1)
    expect(roots[0]!.text).toContain('FYI update U-7')
    expect(fixture.activations('agent2')).toBe(0)
    expect(fixture.activations('agent1')).toBe(1)
    const rootTs = roots[0]!.messageId!

    // A human reply in that thread reaches the AUTHOR (thread owner) only.
    const reply = fixture.injectHuman('any details?', { thread: rootTs })
    await fixture.settle(reply.handles)
    expect(fixture.activations('agent1')).toBe(2)
    expect(fixture.activations('agent2')).toBe(0)
    const detail = fixture
      .deliveredPosts()
      .filter((post) => fixture!.aliasOf(post.agentId!) === 'agent1' && post.thread === rootTs)
    expect(detail).toHaveLength(1)
    expect(detail[0]!.text).toContain('remaining 20%')
  }, 120_000)
})

describe('case 3 — ordinary-reply mentions: agent-authored platform messages route', () => {
  function chainScripts(target: () => RoutingFixture) {
    const script = (self: 'agent1' | 'agent2') => (ctx: { text: string; reply: (value: string) => void }) => {
      const other = self === 'agent1' ? 'agent2' : 'agent1'
      // LAST turn number in the input, and tested BEFORE the start branch: a
      // woken peer's prompt can replay thread context that still contains the
      // original START CHAIN line, and re-matching that branch would restart the
      // numbering instead of advancing it.
      const numbers = [...ctx.text.matchAll(/your turn (\d+)/g)]
      const chain = numbers.length > 0 ? numbers[numbers.length - 1]! : undefined
      if (chain) {
        ctx.reply(`<@${target().botUserId(other)}> your turn ${Number(chain[1]) + 1}`)
        return
      }
      if (/START CHAIN/.test(ctx.text)) {
        ctx.reply(`<@${target().botUserId(other)}> your turn 1`)
        return
      }
      ctx.reply('nothing to do')
    }
    return { agent1: script('agent1'), agent2: script('agent2') }
  }

  /** Mirrors the daemon's private `MAX_AUTOMATIC_TURNS_PER_WINDOW`
   *  (packages/daemon/src/daemon.ts): automatic turns admitted per agent per
   *  `LOOP_GUARD_WINDOW_MS`. */
  const AUTOMATIC_TURNS_PER_WINDOW = 8
  /** Two participants, each spending its own automatic-turn budget on the chain. */
  const CHAIN_EDGES = AUTOMATIC_TURNS_PER_WINDOW * 2

  // Design test #16's TRANSPORT property — one hop per edge, exactly once, in
  // strict alternation — is green since #568 let a platform-observed agent
  // delivery bind the conversation audience (issue #583). Before that fix the
  // second edge admitted and then cancelled with `session_source_mismatch`.
  //
  // What STOPS the chain is no longer the hop cap. #628 raised
  // `MAX_AGENT_CALL_HOPS` to 20, and at that height the durable loop guard's
  // automatic-turn budget binds FIRST: each agent gets 8 automatic turns per
  // 60 s window, so two participants carry the chain exactly 16 edges and the
  // 17th is refused with 4 hops still unspent. Verified by construction —
  // raising only `MAX_AUTOMATIC_TURNS_PER_WINDOW` lets the identical chain run
  // to hop 20 and stop on the cap instead.
  //
  // So the design's "until the cap" is currently unreachable for a two-agent
  // room. That is a real interaction between two protections, not a defect, and
  // it is pinned here rather than left as a stale expected-fail.
  it('an A->B->A ordinary-mention chain advances one hop per edge, stopped by the automatic-turn budget before the hop cap (#503 design test #16)', async () => {
    fixture = await RoutingFixture.start({
      agents: ['agent1', 'agent2'],
      scripts: chainScripts(() => fixture!)
    })
    const trigger = fixture.injectHuman(`<@${fixture.botUserId('agent1')}> START CHAIN`, {
      mentions: [fixture.botUserId('agent1')]
    })
    await fixture.settle(trigger.handles)

    // EXACTLY-ONCE per finalized response, proven by the exact alternating
    // input sequence — a duplicated activation on any edge cannot hide under
    // the aggregate bound. The human trigger is depth 0, so agent2 receives the
    // odd edges and agent1 (after its human trigger) the even ones.
    const agent2Turns = fixture.turnInputs('agent2').map((input) => /your turn (\d+)/.exec(input)?.[1])
    const agent1ChainTurns = fixture
      .turnInputs('agent1')
      .slice(1) // drop the human START CHAIN trigger
      .map((input) => /your turn (\d+)/.exec(input)?.[1])
    const expectedAgent2: string[] = []
    const expectedAgent1: string[] = []
    for (let edge = 1; edge <= CHAIN_EDGES; edge++) {
      ;(edge % 2 === 1 ? expectedAgent2 : expectedAgent1).push(String(edge))
    }
    expect(agent2Turns).toEqual(expectedAgent2)
    expect(agent1ChainTurns).toEqual(expectedAgent1)
    // Every edge dispatched exactly once, and each agent spent exactly its own
    // automatic-turn budget.
    const agentActivations = fixture.activations('agent1') + fixture.activations('agent2') - 1 // minus the human trigger
    expect(agentActivations).toBe(CHAIN_EDGES)
    expect(fixture.activations('agent2')).toBe(AUTOMATIC_TURNS_PER_WINDOW)
    // The hop cap is NOT what stopped it — the chain ends with budget to spare.
    expect(CHAIN_EDGES).toBeLessThan(MAX_AGENT_CALL_HOPS)
    // No turn was lost to source binding — the #583 regression pin.
    expect(fixture.events().some((event) => JSON.stringify(event).includes('session_source_mismatch'))).toBe(false)
    // ...and the edge past the budget is REFUSED, with no dispatch behind it.
    // The routable event is the `final` claim — the terminal post itself when the
    // response closes at post time (§5.5), or the closing edit when one was needed.
    const finalizedAdmissions = (await fixture.echoAdmissions()).filter((record) => record.deliveryState === 'final')
    const admitted = finalizedAdmissions.filter((record) => record.admission.admitted)
    expect(admitted).toHaveLength(CHAIN_EDGES)
    // Cause-specific: the refusal must be the dispatch GATE, not some other
    // failure mode that happens to also stop the chain. `gated` is §7.1's
    // bucket for a gate verdict (`deliveryRejectionReason` maps anything that
    // is not a duplicate/queue-full/durability failure onto it), so this
    // excludes `suppressed`, `unrouted`, `deduplicated`, `queue_full` and
    // `error` — a routing regression can no longer satisfy this test.
    expect(finalizedAdmissions.at(-1)!.admission).toMatchObject({ admitted: false, reason: 'gated' })
  }, 120_000)

  // Landed with #503 (§2.3/§5): the ordinary reply's FINALIZED response event
  // — not the streaming post — activates exactly the mentioned peer, once.
  it('a finalized agent reply mentioning a peer activates it exactly once (#503 §2.3/§5)', async () => {
    fixture = await RoutingFixture.start({
      agents: ['agent1', 'agent2'],
      scripts: {
        agent1: (ctx) => {
          if (/START/.test(ctx.text)) {
            ctx.reply(`<@${fixture!.botUserId('agent2')}> please review the rollout`)
            return
          }
          // Silence ends the exchange: no post, no echo, nothing to route (§2.3).
        },
        agent2: (ctx) => {
          if (/please review/.test(ctx.text)) {
            ctx.reply('reviewing now')
            return
          }
          ctx.reply('nothing to do')
        }
      }
    })
    const trigger = fixture.injectHuman(`<@${fixture.botUserId('agent1')}> START`, {
      mentions: [fixture.botUserId('agent1')]
    })
    await fixture.settle(trigger.handles)
    // Exactly one activation from the finalized response; a streaming echo
    // never routes (a single-post reply closes at post time, so its one echo
    // already carries the `final` claim — §5.5).
    expect(fixture.activations('agent2')).toBe(1)
    expect(fixture.turnInputs('agent2')[0]).toContain('please review the rollout')
    const admissions = await fixture.echoAdmissions()
    const streaming = admissions.filter((record) => record.deliveryState !== 'final')
    const finalized = admissions.filter((record) => record.deliveryState === 'final')
    expect(streaming.every((record) => record.admission.admitted === false)).toBe(true)
    expect(finalized.some((record) => record.admission.admitted === true)).toBe(true)
    // agent2's unmentioning reply names nobody, so it continues the conversation
    // through the implicit ladder (§2.3, #549) — waking the thread peer exactly
    // once. agent1's silent turn then ends the exchange.
    expect(fixture.activations('agent1')).toBe(2)
    expect(fixture.turnInputs('agent1')[1]).toContain('reviewing now')
  }, 120_000)

  it('negative invariants that hold in BOTH architectures: unmentioned agent posts and self-mentions activate no one', async () => {
    fixture = await RoutingFixture.start({
      agents: ['agent1', 'agent2'],
      scripts: {
        agent1: (ctx) => {
          if (/SAY PLAIN/.test(ctx.text)) {
            ctx.reply('status: all good, no mentions here')
            return
          }
          if (/SAY SELF/.test(ctx.text)) {
            ctx.reply(`<@${fixture!.botUserId('agent1')}> note to self`)
            return
          }
          ctx.reply('noted')
        },
        agent2: (ctx) => {
          ctx.reply('agent2 should never speak here')
        }
      }
    })
    // An unmentioned agent-authored message never activates anyone (no thread
    // affinity, no auto, no default fallback — #503 keeps this too).
    const plain = fixture.injectHuman(`<@${fixture.botUserId('agent1')}> SAY PLAIN`, {
      mentions: [fixture.botUserId('agent1')]
    })
    await fixture.settle(plain.handles)
    expect(fixture.activations('agent1')).toBe(1)
    expect(fixture.activations('agent2')).toBe(0)

    // The author never self-activates, even with its own mention token in the
    // finalized reply.
    const selfie = fixture.injectHuman(`<@${fixture.botUserId('agent1')}> SAY SELF`, {
      mentions: [fixture.botUserId('agent1')]
    })
    await fixture.settle(selfie.handles)
    expect(fixture.activations('agent1')).toBe(2)
    expect(fixture.activations('agent2')).toBe(0)
  }, 120_000)
})
