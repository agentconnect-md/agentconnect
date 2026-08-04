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
      const chain = /your turn (\d+)/.exec(ctx.text)
      if (/START CHAIN/.test(ctx.text)) {
        ctx.reply(`<@${target().botUserId(other)}> your turn 1`)
        return
      }
      if (chain) {
        ctx.reply(`<@${target().botUserId(other)}> your turn ${Number(chain[1]) + 1}`)
        return
      }
      ctx.reply('nothing to do')
    }
    return { agent1: script('agent1'), agent2: script('agent2') }
  }

  // #503 §2.3/§4.1/§6 landed the first edge (see the green single-edge test
  // below), but the FULL A -> B -> A chain of design test #16 still terminates
  // early: the verified-mention dispatch installs hop metadata yet carries no
  // external-origin lineage, so RE-ENTERING the human-bound thread session is
  // cancelled with `session_source_mismatch` at the audience binding — the
  // second edge admits and then never runs a turn. This stays expected-fail
  // until that lineage gap is closed; the expected sequence below encodes
  // exactly-once per finalized response for the full chain.
  it.fails(
    'an A->B->A ordinary-mention chain advances one hop per edge until the cap [pending #503 design test #16 — blocked on session_source_mismatch]',
    async () => {
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
      // the aggregate cap. The human trigger is depth 0, so edges 1..cap are
      // admitted and edge cap+1 is rejected: agent2 receives the odd turns,
      // agent1 (after its human trigger) the even ones.
      const agent2Turns = fixture.turnInputs('agent2').map((input) => /your turn (\d+)/.exec(input)?.[1])
      const agent1ChainTurns = fixture
        .turnInputs('agent1')
        .slice(1) // drop the human START CHAIN trigger
        .map((input) => /your turn (\d+)/.exec(input)?.[1])
      const expectedAgent2: string[] = []
      const expectedAgent1: string[] = []
      for (let edge = 1; edge <= MAX_AGENT_CALL_HOPS; edge++) {
        ;(edge % 2 === 1 ? expectedAgent2 : expectedAgent1).push(String(edge))
      }
      expect(agent2Turns).toEqual(expectedAgent2)
      expect(agent1ChainTurns).toEqual(expectedAgent1)
      // Aggregate bound stays as a belt-and-braces check on the same property.
      const agentActivations = fixture.activations('agent1') + fixture.activations('agent2') - 1 // minus the human trigger
      expect(agentActivations).toBeLessThanOrEqual(MAX_AGENT_CALL_HOPS)
      // ...and the terminating edge records a hop_limit rejection with no dispatch.
      const hopLimitRecorded =
        fixture.events().some((event) => JSON.stringify(event.data).includes('hop_limit')) ||
        fixture.world.events().some((event) => JSON.stringify(event).includes('hop_limit'))
      expect(hopLimitRecorded).toBe(true)
    },
    120_000
  )

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
    // Exactly one activation from the finalized response; the streaming echo
    // of the same message never routes.
    expect(fixture.activations('agent2')).toBe(1)
    expect(fixture.turnInputs('agent2')[0]).toContain('please review the rollout')
    const admissions = await fixture.echoAdmissions()
    const streaming = admissions.filter((record) => record.ingressEventTag === undefined)
    const finalized = admissions.filter((record) => record.ingressEventTag !== undefined)
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
