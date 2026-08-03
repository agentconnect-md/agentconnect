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
import { RoutingFixture } from './routing-fixture.js'

/** Mirrors the daemon's MAX_AGENT_CALL_HOPS (packages/daemon/src/daemon.ts). */
const MAX_AGENT_CALL_HOPS = 8

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
  // body" — for a dedicated Slack bot the body begins with <@U_TARGET>. The
  // current implementation posts the message body without the mention.
  it.fails(
    'renders the target agent mention into the visible root post [pending #503 §3.2]',
    async () => {
      fixture = await startCase1()
      const trigger = fixture.injectHuman(`<@${fixture.botUserId('agent1')}> WAKE ${fixture.agentId('agent2')}`, {
        mentions: [fixture.botUserId('agent1')]
      })
      await fixture.settle(trigger.handles)
      const roots = fixture.deliveredPosts().filter((post) => post.thread === undefined)
      expect(roots).toHaveLength(1)
      expect(roots[0]!.text).toContain(`<@${fixture.botUserId('agent2')}>`)
    },
    120_000
  )
})

describe('case 1b — sendMessage {sessionId: parent}: session-only parent resume', () => {
  // #503 §7: the parent session is resumed with headless: true — the injected
  // input and the resumed turn's ORDINARY output stay in the session; no IM
  // body, typing indicator, status chrome, or completion notification is
  // emitted for that turn. Under the CURRENT architecture the resumed parent
  // turn still owns an ordinary IM reply connection, so its reply posts
  // visibly — this test pins the target invariant and passes-as-failing until
  // the rework lands.
  it.fails(
    'parent resume produces ZERO new IM outbound while the parent still processes the reply [pending #503 §7]',
    async () => {
      fixture = await RoutingFixture.start({
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
            if (/RESULT R-42/.test(ctx.text)) {
              ctx.reply('thanks, result noted')
              return
            }
            ctx.reply('noted')
          },
          agent2: async (ctx) => {
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
      })
      const trigger = fixture.injectHuman(`<@${fixture.botUserId('agent1')}> WAKE ${fixture.agentId('agent2')}`, {
        mentions: [fixture.botUserId('agent1')]
      })
      await fixture.settle(trigger.handles)

      // The parent DID process the child's reply (this half holds today too).
      expect(fixture.activations('agent1')).toBe(2)
      const resumeInput = fixture.turnInputs('agent1')[1] ?? ''
      expect(resumeInput).toContain('RESULT R-42')

      // INVARIANT UNDER #503 §7: the resumed parent turn emits nothing to IM —
      // no ordinary reply body and no delivery chrome. (Today the resumed turn
      // posts 'thanks, result noted' into the origin thread, violating this.)
      const parentResumeOutput = fixture
        .deliveredEffects()
        .filter(
          (effect) => effect.agentId === fixture!.agentId('agent1') && effect.text.includes('thanks, result noted')
        )
      expect(parentResumeOutput).toHaveLength(0)
    },
    120_000
  )
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

  // #503 §2.3/§4.1/§6: a VERIFIED AgentConnect-authored platform message with
  // an explicit mention activates exactly the mentioned agent; every edge
  // increments the trusted hop depth and MAX_AGENT_CALL_HOPS terminates the
  // chain with a recorded hop_limit rejection instead of a dispatch. The
  // CURRENT architecture's first ingress gate drops every managed-bot-authored
  // message before routing, so nothing past the first reply ever activates.
  it.fails(
    'a finalized agent reply mentioning a peer activates it once, and the hop cap ends the chain [pending #503 §2.3/§4.1/§6]',
    async () => {
      fixture = await RoutingFixture.start({
        agents: ['agent1', 'agent2'],
        scripts: chainScripts(() => fixture!)
      })
      const trigger = fixture.injectHuman(`<@${fixture.botUserId('agent1')}> START CHAIN`, {
        mentions: [fixture.botUserId('agent1')]
      })
      await fixture.settle(trigger.handles)

      // The mentioned peer is activated exactly once per finalized reply edge.
      expect(fixture.activations('agent2')).toBeGreaterThanOrEqual(1)
      expect(fixture.turnInputs('agent2')[0]).toContain('your turn 1')
      // The counter-mention re-activates the original author.
      expect(fixture.activations('agent1')).toBeGreaterThanOrEqual(2)
      // The chain terminates at the shared cap: hop count increments once per
      // edge, so the total number of agent-authored activations across the chain
      // never exceeds MAX_AGENT_CALL_HOPS...
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
