/**
 * Slack-shaped leg of the cross-surface activation parity suite
 * (`evals/parity/spec.ts` — read its header for the governance rule).
 *
 * Reuses the arena routing fixture (`routing-fixture.ts`): a REAL daemon
 * against one mention-gated Slack-shaped room, scripted hosts, and platform
 * echo fidelity — every delivered agent post fans back as real platform
 * ingress under the author's managed bot identity, so whether an echo
 * activates anyone is the daemon's routing decision, never the fixture's.
 * Credential-free. Assertions read the daemon's own records: turn activations
 * (evaluation events), delivered/attempted outbound effects, and per-echo
 * admission outcomes.
 *
 * Every scenario the spec declares for this surface MUST have a driver here;
 * the coverage guard at the bottom fails otherwise.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_AGENT_CALL_HOPS } from '../../packages/protocol/src/consts.js'
import { AUTOMATIC_TURNS_PER_WINDOW, declaredOutcome, scenariosFor, type ParityScenario } from '../parity/spec.js'
import { RoutingFixture, type RoutingScriptContext } from './routing-fixture.js'

let fixture: RoutingFixture | undefined

afterEach(async () => {
  await fixture?.stop()
  fixture = undefined
})

/** Start the standard two-agent mention-gated room. Scripts default to
 *  SILENCE (an unmatched prompt posts nothing — the scripted stand-in for a
 *  production agent declining with the no-response sentinel). */
async function startRoom(scripts: {
  agent1?: (ctx: RoutingScriptContext) => Promise<void> | void
  agent2?: (ctx: RoutingScriptContext) => Promise<void> | void
}): Promise<RoutingFixture> {
  fixture = await RoutingFixture.start({
    agents: ['agent1', 'agent2'],
    scripts: {
      agent1: scripts.agent1 ?? (() => {}),
      agent2: scripts.agent2 ?? (() => {})
    }
  })
  return fixture
}

const drivers: Record<string, (scenario: ParityScenario) => Promise<void>> = {
  // (a) Mention-gated shared channel: a human kickoff activates exactly the
  // mentioned agent; the other channel member stays idle even after the
  // author's (unmentioning) reply echoes back. DECLARED divergence from the
  // webchat roster convention — see the spec entry.
  'human-kickoff-activation': async (scenario) => {
    // The spec is load-bearing: editing this scenario's declared outcome
    // fails this pin; changing the behavior fails the measured asserts below.
    expect(declaredOutcome(scenario.expect.slack!)).toEqual({ activates: 'mentioned-only' })
    const leg = await startRoom({
      agent1: (ctx) => {
        if (/HELLO ROOM/.test(ctx.text)) ctx.reply('hello back, no mentions here')
      }
    })
    const trigger = leg.injectHuman(`<@${leg.botUserId('agent1')}> HELLO ROOM`, {
      mentions: [leg.botUserId('agent1')]
    })
    await leg.settle(trigger.handles)
    expect(leg.activations('agent1')).toBe(1)
    expect(leg.activations('agent2')).toBe(0)
  },

  // (b) #549: a verified agent-authored reply naming NOBODY continues the
  // conversation — the thread's other participant is woken exactly once, the
  // author is excluded.
  'agent-continuation-minus-author': async (scenario) => {
    // The spec is load-bearing: editing this scenario's declared outcome
    // fails this pin; changing the behavior fails the measured asserts below.
    expect(declaredOutcome(scenario.expect.slack!)).toEqual({ activates: 'participants-minus-author' })
    const leg = await startRoom({
      agent1: (ctx) => {
        if (/START/.test(ctx.text)) ctx.reply(`<@${fixture!.botUserId('agent2')}> please review the rollout`)
        // Silence on the continuation wake ends the exchange.
      },
      agent2: (ctx) => {
        if (/please review/.test(ctx.text)) ctx.reply('reviewing now')
      }
    })
    const trigger = leg.injectHuman(`<@${leg.botUserId('agent1')}> START`, {
      mentions: [leg.botUserId('agent1')]
    })
    await leg.settle(trigger.handles)
    // agent2 joined by mention; its unmentioning reply continues the
    // conversation through the implicit ladder, waking the thread peer
    // (agent1) exactly once — participants minus author.
    expect(leg.activations('agent2')).toBe(1)
    expect(leg.activations('agent1')).toBe(2)
    expect(leg.turnInputs('agent1')[1]).toContain('reviewing now')
  },

  // (c) The author never self-activates, even with its own mention token in
  // the finalized reply.
  'author-never-self-activates': async (scenario) => {
    // The spec is load-bearing: editing this scenario's declared outcome
    // fails this pin; changing the behavior fails the measured asserts below.
    expect(declaredOutcome(scenario.expect.slack!)).toEqual({ activates: 'nobody' })
    const leg = await startRoom({
      agent1: (ctx) => {
        if (/SAY SELF/.test(ctx.text)) ctx.reply(`<@${fixture!.botUserId('agent1')}> note to self`)
      }
    })
    const trigger = leg.injectHuman(`<@${leg.botUserId('agent1')}> SAY SELF`, {
      mentions: [leg.botUserId('agent1')]
    })
    await leg.settle(trigger.handles)
    expect(leg.activations('agent1')).toBe(1)
    expect(leg.activations('agent2')).toBe(0)
  },

  // (d) Exactly one admission per (message, target). This surface's addressed
  // edge is the explicit mention: one finalized reply naming one peer, whose
  // streaming echo and finalized echo collapse to one admission.
  'delivery-exactly-once': async (scenario) => {
    // The spec is load-bearing: editing this scenario's declared outcome
    // fails this pin; changing the behavior fails the measured asserts below.
    expect(declaredOutcome(scenario.expect.slack!)).toEqual({ activates: 'target-exactly-once' })
    const leg = await startRoom({
      agent1: (ctx) => {
        if (/START/.test(ctx.text)) ctx.reply(`<@${fixture!.botUserId('agent2')}> please review the rollout`)
      }
      // agent2 stays silent — the named peer's wake is the scenario's endpoint.
    })
    const trigger = leg.injectHuman(`<@${leg.botUserId('agent1')}> START`, {
      mentions: [leg.botUserId('agent1')]
    })
    await leg.settle(trigger.handles)
    expect(leg.activations('agent2')).toBe(1)
    expect(leg.turnInputs('agent2')[0]).toContain('please review the rollout')
    const admissions = await leg.echoAdmissions()
    // The one routable event of a response is its `final` claim — carried on the
    // terminal post itself when the response closes at post time (§5.5), or on the
    // closing edit when one was needed.
    const finalized = admissions.filter((record) => record.deliveryState === 'final')
    expect(finalized.filter((record) => record.admission.admitted)).toHaveLength(1)
  },

  // (e) Streaming never routes: every streaming echo admission is refused —
  // even when the streaming section carries the mention — and only the
  // response-closing `final` event routes, once, on the recipients resolved
  // from the COMPLETE response (§5.2/§5.4).
  'streaming-never-routes': async (scenario) => {
    // The spec is load-bearing: editing this scenario's declared outcome
    // fails this pin; changing the behavior fails the measured asserts below.
    expect(declaredOutcome(scenario.expect.slack!)).toEqual({
      activates: 'target-exactly-once',
      streamingNeverRoutes: true
    })
    const leg = await startRoom({
      agent1: (ctx) => {
        if (!/START/.test(ctx.text)) return
        // Longer than one Slack markdown block, so the splitter cuts the answer:
        // the mention-carrying first section posts as a STREAMING copy, and only
        // the closing section carries the response's `final` claim (§5.5 rule 7).
        ctx.reply(
          `<@${fixture!.botUserId('agent2')}> please review the rollout\n\n` +
            'the staging soak finished clean. '.repeat(400)
        )
      }
    })
    const trigger = leg.injectHuman(`<@${leg.botUserId('agent1')}> START`, {
      mentions: [leg.botUserId('agent1')]
    })
    await leg.settle(trigger.handles)
    const admissions = await leg.echoAdmissions()
    const streaming = admissions.filter((record) => record.deliveryState !== 'final')
    const finalized = admissions.filter((record) => record.deliveryState === 'final')
    expect(streaming.length).toBeGreaterThan(0)
    expect(streaming.every((record) => record.admission.admitted === false)).toBe(true)
    expect(finalized.some((record) => record.admission.admitted === true)).toBe(true)
    expect(leg.activations('agent2')).toBe(1)
  },

  // (f) Each edge charges one hop, in strict alternation — and on THIS surface
  // the durable loop guard's automatic-turn budget binds before the hop cap
  // (declared divergence; collaboration-arena-baseline.md §6.1): 16 edges,
  // then a recorded `gated` refusal with hop budget to spare.
  'hop-transition-and-refusal': async (scenario) => {
    // The spec is load-bearing: editing this scenario's declared outcome
    // fails this pin; changing the behavior fails the measured asserts below.
    expect(declaredOutcome(scenario.expect.slack!)).toEqual({
      activates: 'participants-minus-author',
      refusal: { reason: 'automatic_turn_budget', afterEdges: AUTOMATIC_TURNS_PER_WINDOW * 2 }
    })
    const refusal = scenario.expect.slack!.refusal!
    const script = (self: 'agent1' | 'agent2') => (ctx: RoutingScriptContext) => {
      const other = self === 'agent1' ? 'agent2' : 'agent1'
      const numbers = [...ctx.text.matchAll(/your turn (\d+)/g)]
      const chain = numbers.length > 0 ? numbers[numbers.length - 1]! : undefined
      if (chain) {
        ctx.reply(`<@${fixture!.botUserId(other)}> your turn ${Number(chain[1]) + 1}`)
        return
      }
      if (/START CHAIN/.test(ctx.text)) ctx.reply(`<@${fixture!.botUserId(other)}> your turn 1`)
    }
    const leg = await startRoom({ agent1: script('agent1'), agent2: script('agent2') })
    const trigger = leg.injectHuman(`<@${leg.botUserId('agent1')}> START CHAIN`, {
      mentions: [leg.botUserId('agent1')]
    })
    await leg.settle(trigger.handles)
    // Exactly one dispatch per edge, alternating, until the budget refusal.
    const agentActivations = leg.activations('agent1') + leg.activations('agent2') - 1 // minus the human trigger
    expect(agentActivations).toBe(refusal.afterEdges)
    expect(leg.activations('agent2')).toBe(AUTOMATIC_TURNS_PER_WINDOW)
    // The hop cap is NOT what stopped it — the chain ends with budget to spare.
    expect(refusal.afterEdges).toBeLessThan(MAX_AGENT_CALL_HOPS)
    const finalizedAdmissions = (await leg.echoAdmissions()).filter((record) => record.deliveryState === 'final')
    expect(finalizedAdmissions.filter((record) => record.admission.admitted)).toHaveLength(refusal.afterEdges)
    // The refusal past the budget is the dispatch GATE's verdict (§7.1 `gated`
    // — the loop guard's bucket), recorded rather than silently dropped.
    expect(finalizedAdmissions.at(-1)!.admission).toMatchObject({ admitted: false, reason: 'gated' })
  },

  // (g) A silent decline absorbs the wake: the woken participant posts
  // nothing, and nothing further fans out from its silent turn.
  'silent-decline-absorbs-wake': async (scenario) => {
    // The spec is load-bearing: editing this scenario's declared outcome
    // fails this pin; changing the behavior fails the measured asserts below.
    expect(declaredOutcome(scenario.expect.slack!)).toEqual({
      activates: 'participants-minus-author',
      silentDeclinePostsNothing: true
    })
    const leg = await startRoom({
      agent1: (ctx) => {
        if (/START/.test(ctx.text)) ctx.reply(`<@${fixture!.botUserId('agent2')}> please review the rollout`)
        // The continuation wake lands here — and is declined silently.
      },
      agent2: (ctx) => {
        if (/please review/.test(ctx.text)) ctx.reply('reviewing now')
      }
    })
    const trigger = leg.injectHuman(`<@${leg.botUserId('agent1')}> START`, {
      mentions: [leg.botUserId('agent1')]
    })
    await leg.settle(trigger.handles)
    // agent1 was woken by agent2's reply (activation 2) and declined silently:
    // its only delivered post remains the initial mention.
    expect(leg.activations('agent1')).toBe(2)
    const agent1Posts = leg.deliveredPosts().filter((post) => leg.aliasOf(post.agentId!) === 'agent1')
    expect(agent1Posts).toHaveLength(1)
    // The silence terminated the exchange: no further wake for agent2.
    expect(leg.activations('agent2')).toBe(1)
  },

  // (h) needsReply round trip: the child's report wakes the parent session
  // exactly once, and the report body is never published anywhere.
  'needs-reply-round-trip': async (scenario) => {
    // The spec is load-bearing: editing this scenario's declared outcome
    // fails this pin; changing the behavior fails the measured asserts below.
    expect(declaredOutcome(scenario.expect.slack!)).toEqual({ activates: 'parent-exactly-once' })
    const leg = await startRoom({
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
        if (/RESULT R-42/.test(ctx.text)) ctx.reply('thanks, result noted')
      },
      agent2: async (ctx) => {
        const parent = /Parent session: (\S+)/.exec(ctx.text)
        if (parent && /task T-1/.test(ctx.text)) {
          const result = await ctx.callTool('sendMessage', {
            sessionId: parent[1]!,
            message: 'RESULT R-42: task complete'
          })
          ctx.reply(result.ok ? 'reported to parent' : `report failed: ${result.error ?? 'unknown'}`)
        }
      }
    })
    const trigger = leg.injectHuman(`<@${leg.botUserId('agent1')}> WAKE ${leg.agentId('agent2')}`, {
      mentions: [leg.botUserId('agent1')]
    })
    await leg.settle(trigger.handles)
    // The parent was resumed by the report EXACTLY once (kickoff + resume).
    expect(leg.activations('agent1')).toBe(2)
    expect(leg.turnInputs('agent1')[1]).toContain('RESULT R-42')
    // The report itself never became a platform message — nothing anyone
    // attempted, delivered or rejected, carries the injected text.
    const published = leg.world.allEffects().filter((effect) => /RESULT R-42/.test(effect.text ?? ''))
    expect(published).toEqual([])
  },

  // (i) Verification, not bot-ness, is the boundary: an UNVERIFIED third-party
  // bot message never activates through the implicit agent rungs (no thread
  // affinity, no fan-out) — while an explicit mention from it still activates
  // on Slack, whose manifest admits bot senders.
  'unverified-author-no-agent-rungs': async (scenario) => {
    // The spec is load-bearing: editing this scenario's declared outcome
    // fails this pin; changing the behavior fails the measured asserts below.
    expect(declaredOutcome(scenario.expect.slack!)).toEqual({ activates: 'nobody' })
    const leg = await startRoom({
      agent1: (ctx) => {
        if (/START/.test(ctx.text)) ctx.reply('anchored in this thread')
      }
    })
    // Anchor agent1's session in a thread.
    const trigger = leg.injectHuman(`<@${leg.botUserId('agent1')}> START`, {
      mentions: [leg.botUserId('agent1')]
    })
    await leg.settle(trigger.handles)
    expect(leg.activations('agent1')).toBe(1)

    // An UNMENTIONED third-party bot message in that live thread: no thread
    // affinity, no participant fan-out — bot traffic without a verified
    // author stops before every implicit rung.
    const chatter = leg.injectThirdPartyBot('external bot chatter, mentioning nobody', {
      thread: trigger.messageId
    })
    await leg.settle(chatter.handles)
    expect(leg.activations('agent1')).toBe(1)
    expect(leg.activations('agent2')).toBe(0)

    // An EXPLICIT mention from the same unverified bot still activates on
    // Slack — the platform's manifest admits bot senders at the mention rung.
    const addressed = leg.injectThirdPartyBot(`<@${leg.botUserId('agent2')}> ping from an external bot`, {
      mentions: [leg.botUserId('agent2')]
    })
    await leg.settle(addressed.handles)
    expect(leg.activations('agent2')).toBe(1)
    expect(leg.activations('agent1')).toBe(1)
  }
}

describe('activation parity — Slack-shaped leg', () => {
  const scenarios = scenariosFor('slack')

  it('covers every scenario the spec declares for this surface', () => {
    expect(new Set(scenarios.map((s) => s.id))).toEqual(new Set(Object.keys(drivers)))
  })

  for (const scenario of scenarios) {
    it(`${scenario.id} — ${scenario.title}`, async () => {
      const driver = drivers[scenario.id]
      expect(driver, `no Slack driver for spec scenario "${scenario.id}"`).toBeDefined()
      await driver!(scenario)
    }, 120_000)
  }
})
