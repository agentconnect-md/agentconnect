/**
 * Arena case: DELEGATE AND FORWARD — the async contract the caller is never told about.
 *
 * The observed production failure this file encodes (webchat, real model):
 *
 *   1. A human asks agent A: "send hello to agent b and forward reply".
 *   2. A calls `sendMessage {toAgent:{agentId:<B>,needsReply:true}, message:"hello"}`
 *      and gets back `{ok:true, wake:{delivered:true,targetSession:…}, childSessionId:…}`.
 *   3. IN THE SAME TURN A calls `viewSessionStatus {sessionId:<childSessionId>}` and
 *      reads `{status:"in-progress", state:"prompting"}`.
 *   4. A then tells the human "Agent B completed its turn but returned no message to
 *      forward" — a completion claim its own last observation contradicts.
 *
 * Nothing in step 4 is a routing bug: the wake was delivered, the child did run, and
 * the report-back directive was installed on the CHILD. What is missing is on the
 * PARENT side. `needsReply` is a two-sided contract and only one side is stated:
 *
 *   - the child is told (session-manager's `# Reporting back to your parent session`)
 *     that it must reply into the parent session;
 *   - the parent is told NOTHING. Its tool result is `{ok, wake, childSessionId}` —
 *     no statement that the call was asynchronous, that the reply will arrive as a
 *     later wake, or that the right move now is to end the turn.
 *
 * With a synchronous-sounding task ("…and forward reply"), an instant result, and
 * `viewSessionStatus` as the only tool that looks like progress, polling and then
 * inventing a terminal answer is the behavior the surface invites.
 *
 * LAYERS. This file is the credential-free half and runs in `pnpm eval:collab:contracts`.
 * It pins the SYSTEM-side affordances, which are fixable in the tool surface. The
 * model-behavior half is `delegate-and-forward-real.test.ts` (real ACP runtime,
 * on demand, reported as a rate over trials).
 *
 * RED/GREEN. Tests written as `it.fails(…)` are the ones the surface does not satisfy
 * today: they PASS while the affordance is still missing and start FAILING (flip them
 * to `it`) the moment it lands. Each names what has to change. The `it(…)` tests around
 * them are characterization pins: they record what the surface actually does now, so
 * the red tests are anchored in measured behavior rather than in a paraphrase.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { COLLABORATION_TOOLS, toolsForIntegrations } from '../../packages/daemon/src/mcp/tools.js'
import { RoutingFixture } from './routing-fixture.js'

let fixture: RoutingFixture | undefined

afterEach(async () => {
  await fixture?.stop()
  fixture = undefined
})

const sendMessageDescription = (): string => {
  const tool = toolsForIntegrations([]).find((entry) => entry.name === 'sendMessage')
  if (!tool) throw new Error('sendMessage descriptor is missing from the collaboration tool set')
  return tool.description
}

const viewSessionStatusDescription = (): string => {
  const tool = COLLABORATION_TOOLS.find((entry) => entry.name === 'viewSessionStatus')
  if (!tool) throw new Error('viewSessionStatus descriptor is missing from COLLABORATION_TOOLS')
  return tool.description
}

/** Every string anywhere in a tool result, so a prose assertion does not have to
 *  guess which field name a fix will choose. */
function stringsIn(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value)
  else if (Array.isArray(value)) for (const entry of value) stringsIn(entry, into)
  else if (value && typeof value === 'object') for (const entry of Object.values(value)) stringsIn(entry, into)
  return into
}

/** A status result stripped of everything that necessarily differs between two
 *  runs (the child's minted ids) or between two moments (the clock). */
function withoutRunIdentity(status: Record<string, unknown>): Record<string, unknown> {
  const { sessionId: _sessionId, agentId: _agentId, updatedAt: _updatedAt, ...rest } = status
  return rest
}

interface DelegationProbe {
  /** Raw `sendMessage` result of the `needsReply` peer wake. */
  wakeResult: Record<string, unknown>
  /** Raw `viewSessionStatus` result read in the SAME turn as the wake. */
  sameTurnStatus: Record<string, unknown>
}

/**
 * Reproduces the observed call sequence exactly, against the real daemon: A wakes
 * B with `needsReply` and then — still inside that turn — polls the returned
 * `childSessionId`, while B is provably mid-turn.
 *
 * The rendezvous is explicit rather than a sleep: B's script signals that its turn
 * has begun and then blocks until A has read the status. That makes "the poll
 * observed a running child" a fact of the test rather than a race.
 */
async function probeSameTurnPoll(): Promise<DelegationProbe> {
  let signalChildStarted: () => void = () => {}
  const childStarted = new Promise<void>((resolve) => {
    signalChildStarted = resolve
  })
  let releaseChild: () => void = () => {}
  const childReleased = new Promise<void>((resolve) => {
    releaseChild = resolve
  })
  const probe: Partial<DelegationProbe> = {}

  fixture = await RoutingFixture.start({
    agents: ['agent1', 'agent2'],
    scripts: {
      agent1: async (ctx) => {
        const wake = /DELEGATE ([0-9a-f-]{36})/.exec(ctx.text)
        if (!wake) {
          ctx.reply('noted')
          return
        }
        const sent = await ctx.callTool('sendMessage', {
          toAgent: { agentId: wake[1]!, needsReply: true },
          message: 'hello'
        })
        probe.wakeResult = (sent.result ?? {}) as Record<string, unknown>
        const childSessionId = probe.wakeResult.childSessionId
        expect(typeof childSessionId).toBe('string')
        // Wait for B to be genuinely mid-turn, then poll exactly as the trace did.
        await Promise.race([childStarted, new Promise((resolve) => setTimeout(resolve, 10_000))])
        const status = await ctx.callTool('viewSessionStatus', { sessionId: childSessionId })
        probe.sameTurnStatus = (status.result ?? {}) as Record<string, unknown>
        releaseChild()
        ctx.reply('delegated')
      },
      agent2: async (ctx) => {
        if (!/hello/.test(ctx.text)) {
          ctx.reply('agent2 heard you')
          return
        }
        signalChildStarted()
        await Promise.race([childReleased, new Promise((resolve) => setTimeout(resolve, 10_000))])
        ctx.reply('hi there')
      }
    }
  })
  const trigger = fixture.injectHuman(`<@${fixture.botUserId('agent1')}> DELEGATE ${fixture.agentId('agent2')}`, {
    mentions: [fixture.botUserId('agent1')]
  })
  await fixture.settle(trigger.handles)
  if (!probe.wakeResult || !probe.sameTurnStatus) throw new Error('the delegation probe did not complete')
  return probe as DelegationProbe
}

describe('delegate-and-forward — what the parent is told when it delegates', () => {
  // CHARACTERIZATION (green): the exact surface the observed trace saw. If this
  // ever changes, the red tests below are re-reading a different product.
  it('records the surface as it is today: an instant wake result, and a same-turn poll that reports the child still running', async () => {
    const probe = await probeSameTurnPoll()

    // The wake result. `wake.targetSession` and `childSessionId` are ids; nothing
    // else in it is prose addressed to the caller.
    expect(probe.wakeResult.ok).toBe(true)
    expect(probe.wakeResult).toMatchObject({ wake: { delivered: true } })
    expect(typeof probe.wakeResult.childSessionId).toBe('string')
    expect([...Object.keys(probe.wakeResult)].sort()).toEqual(['childSessionId', 'ok', 'wake'])

    // The same-turn poll — the tool the model reached for — answers that the
    // child is still working. This is the observation the fabricated completion
    // claim in the trace directly contradicted.
    expect(probe.sameTurnStatus).toMatchObject({ status: 'in-progress', state: 'prompting' })
  }, 120_000)

  // RED — what must change: `executeTool`'s `sendMessage` branch
  // (packages/daemon/src/mcp/ops.ts, the `toAgent` return around the
  // `childSessionId` assembly) must, for a `needsReply` wake, return prose stating
  // the asynchronous contract: the reply arrives later as a new turn in THIS
  // session, and the caller should end its turn rather than wait or poll. Only the
  // CHILD is told its half today (session-manager's `# Reporting back to your
  // parent session`); the parent's half is unstated, which is what leaves "forward
  // the reply" looking like a synchronous call that returned nothing.
  it.fails(
    'states the asynchronous contract in the needsReply wake result',
    async () => {
      const probe = await probeSameTurnPoll()
      const prose = stringsIn(probe.wakeResult).join(' \n ').toLowerCase()
      // (i) the reply comes back later, as a wake of this session…
      expect(prose).toMatch(/wake|woken|later turn|new turn|report back|when it (finishes|replies)/)
      // (ii) …so the right move now is to finish this turn.
      expect(prose).toMatch(/end (your|this) turn|finish (your|this) turn|do not wait|don’t wait|do not poll/)
    },
    120_000
  )

  // RED — what must change: the `viewSessionStatus` description in
  // packages/daemon/src/mcp/tools.ts currently closes with "Poll sparingly, and
  // prefer waiting for the child’s reply over a tight polling loop." Inside a turn
  // there is no way to wait: a turn either ends or blocks, and the model cannot
  // block. Advising an impossible action is what turns "wait" into "poll once and
  // then answer anyway".
  it.fails('does not advise the caller to wait — an action no turn can take', () => {
    expect(viewSessionStatusDescription().toLowerCase()).not.toMatch(/prefer waiting|wait for the child/)
  })

  // RED — same descriptor: having removed the impossible advice, it must say when
  // the tool IS the right call. The honest cases are (a) you are already awake for
  // some other reason and want a child's progress, and (b) the child you are
  // checking is NOT the one whose reply woke you. Neither is expressible today.
  it.fails(
    'says when checking a child IS appropriate (already awake; a child other than the one that woke you)',
    () => {
      const description = viewSessionStatusDescription().toLowerCase()
      expect(description).toMatch(/already (awake|running)|when you are awake|woken for another/)
    }
  )

  // RED — what must change: `SessionStatusResult`
  // (packages/daemon/src/mcp/ops.ts) collapses two different facts into `done`:
  // "the child's last turn ended" and "the child has reported back to you". A
  // caller that asked for `needsReply` cares only about the second, and today it
  // cannot tell them apart — the two situations are byte-identical apart from the
  // `updatedAt` clock. That is measured here rather than asserted as a field name,
  // so any shape that distinguishes them satisfies this test.
  it.fails(
    'distinguishes "the child ended its turn" from "the child reported back"',
    async () => {
      const silent = await statusAfterChildTurn({ reportToParent: false })
      await fixture?.stop()
      fixture = undefined
      const reported = await statusAfterChildTurn({ reportToParent: true })
      expect(silent).toMatchObject({ status: 'done' })
      expect(reported).toMatchObject({ status: 'done' })
      // Run-specific identity and the wall clock are not answers to the caller's
      // question, so they are removed before the comparison. Whatever remains is
      // everything the tool actually TELLS a caller, and today it is identical in
      // both situations.
      expect(withoutRunIdentity(reported)).not.toEqual(withoutRunIdentity(silent))
    },
    240_000
  )

  // RED — and this one is not a hypothetical: it is what the real-model runs
  // actually produced in 2 of 5 trials (collaboration-arena-baseline.md §5.5).
  //
  // A POSTLESS `toAgent` wake gives the child a HEADLESS session — nothing it says
  // as an ordinary turn reply is published anywhere. The report-back directive
  // therefore carries the child's ENTIRE output channel: a child that answers in
  // prose instead of calling `sendMessage {sessionId}` has its answer discarded
  // silently, and the parent, which was promised a report, waits forever with no
  // signal that anything went wrong. From the parent's seat that is literally "it
  // returned no message to forward".
  //
  // What must change (packages/daemon/src/daemon.ts, the turn-final path for a
  // session with `needsParentReply`): when a headless child with an outstanding
  // report-back obligation ends its turn without discharging it, the parent must
  // be told something — the child's own output forwarded, or an explicit
  // "finished without reporting" wake. Silently dropping the only thing the child
  // produced is the one outcome that cannot be recovered from.
  it.fails(
    'does not silently drop a headless child’s answer when it ends its turn without reporting back',
    async () => {
      let parentSawAnything = false
      fixture = await RoutingFixture.start({
        agents: ['agent1', 'agent2'],
        scripts: {
          agent1: async (ctx) => {
            const wake = /DELEGATE ([0-9a-f-]{36})/.exec(ctx.text)
            if (wake) {
              await ctx.callTool('sendMessage', {
                toAgent: { agentId: wake[1]!, needsReply: true },
                message: 'hello'
              })
              ctx.reply('delegated, waiting for the reply')
              return
            }
            // Any LATER turn is the parent being told something about the child.
            parentSawAnything = true
            ctx.reply('noted')
          },
          // The child does exactly what a real model did in trials 2 and 4: it
          // answers, in prose, and ends its turn. No tool call.
          agent2: (ctx) => {
            ctx.reply('hi there — TOKEN-HEADLESS-DROP')
          }
        }
      })
      const trigger = fixture.injectHuman(`<@${fixture.botUserId('agent1')}> DELEGATE ${fixture.agentId('agent2')}`, {
        mentions: [fixture.botUserId('agent1')]
      })
      await fixture.settle(trigger.handles)

      // The child did run and did produce an answer…
      expect(fixture.activations('agent2')).toBe(1)
      expect(fixture.turnTraces('agent2')[0]!.output).toContain('TOKEN-HEADLESS-DROP')
      // …and the answer exists nowhere: not as a platform effect (delivered or
      // even attempted), and not as anything the waiting parent was told.
      const anywhere = fixture.world.allEffects().filter((effect) => /TOKEN-HEADLESS-DROP/.test(effect.text ?? ''))
      expect(anywhere.length + (parentSawAnything ? 1 : 0)).toBeGreaterThan(0)
    },
    120_000
  )
})

/**
 * Drive one delegation to completion and read the child's status afterwards, with
 * the child either reporting back into the parent session or staying silent. The
 * read happens on a SECOND human turn injected into the SAME thread, because a
 * child's status is only readable from the session that started it.
 */
async function statusAfterChildTurn(options: { reportToParent: boolean }): Promise<Record<string, unknown>> {
  let childSessionId: string | undefined
  let observed: Record<string, unknown> | undefined
  let delegated = false
  fixture = await RoutingFixture.start({
    agents: ['agent1', 'agent2'],
    scripts: {
      agent1: async (ctx) => {
        // CHECK first, and DELEGATE only once: a later turn's prompt replays the
        // thread, so the original instruction is still visible in it.
        if (/CHECK/.test(ctx.text)) {
          if (childSessionId === undefined) throw new Error('CHECK turn ran before the delegation')
          const status = await ctx.callTool('viewSessionStatus', { sessionId: childSessionId })
          observed = (status.result ?? {}) as Record<string, unknown>
          ctx.reply('checked')
          return
        }
        const wake = /DELEGATE ([0-9a-f-]{36})/.exec(ctx.text)
        if (wake && !delegated) {
          delegated = true
          const sent = await ctx.callTool('sendMessage', {
            toAgent: { agentId: wake[1]!, needsReply: true },
            message: 'hello'
          })
          childSessionId = (sent.result as { childSessionId?: string } | undefined)?.childSessionId
          ctx.reply('delegated')
          return
        }
        // The child's report-back resumes this session; say nothing, so the
        // resumed turn cannot perturb what the CHECK turn later observes.
      },
      agent2: async (ctx) => {
        const parent = /Parent session: (\S+)/.exec(ctx.text)
        if (/hello/.test(ctx.text) && options.reportToParent && parent) {
          await ctx.callTool('sendMessage', { sessionId: parent[1]!, message: 'REPORT: hi there' })
        }
        ctx.reply('hi there')
      }
    }
  })
  const trigger = fixture.injectHuman(`<@${fixture.botUserId('agent1')}> DELEGATE ${fixture.agentId('agent2')}`, {
    mentions: [fixture.botUserId('agent1')]
  })
  await fixture.settle(trigger.handles)
  // Same thread ⇒ same logical session for agent1, which is what authorizes the
  // lineage read.
  const check = fixture.injectHuman(`<@${fixture.botUserId('agent1')}> CHECK`, {
    thread: trigger.messageId,
    mentions: [fixture.botUserId('agent1')]
  })
  await fixture.settle(check.handles)
  if (!observed) throw new Error('the status probe never ran viewSessionStatus')
  return observed
}

describe('delegate-and-forward — the standing guidance the two sides receive', () => {
  // CHARACTERIZATION (green): the sendMessage descriptor does tell the model to
  // set `needsReply`, and it does point at `viewSessionStatus` — but it never says
  // the call is asynchronous. Pinned because it is the exact asymmetry the red
  // tests above are about.
  it('tells the caller to set needsReply and to poll, but never that the call is asynchronous', () => {
    const description = sendMessageDescription()
    expect(description).toContain('needsReply')
    expect(description).toContain('viewSessionStatus')
    expect(description.toLowerCase()).not.toMatch(/asynchronous|end your turn|woken when|later turn/)
  })
})
