import { describe, it, expect } from 'vitest'
import { TurnOutputRegistry, type TurnOutputSurface } from '../src/platforms/turn-output.js'

/**
 * The §7.3 seam's two invariants — the ones §16 says this refactor fails by
 * losing:
 *
 *  1. a surface is a TRIO (converger + applier + opaque per-turn state), so the
 *     streaming loop's platform state can never be stranded back in core, and
 *  2. lookup is TOTAL — every origin renders through some surface, with the core
 *     one covering the non-platform origins (webchat / hook / dream) exactly as
 *     the `platform === …` ternaries' default arm used to.
 */

type Turn = { applied: string[] }
type Action = { kind: string }
type Conv = { label: string }
type Msg = { platform: string }

const surface = (platform: string, seed: () => unknown): TurnOutputSurface<Turn, Action, Conv, Msg> => ({
  platform,
  createConverger: (ctx) => ({ label: `${platform}:${ctx.mode}` }),
  initialTurnState: seed,
  apply: async (turn, action) => {
    turn.applied.push(`${platform}:${action.kind}`)
  }
})

describe('turn-output seam (§7.3)', () => {
  const core = surface('slack', () => ({ staleReplyFooters: [] }))
  const registry = new TurnOutputRegistry<Turn, Action, Conv, Msg>(core)
  registry.register(surface('telegram', () => ({ replyTo: 42 })))
  registry.register(surface('feishu', () => ({ cardAttempted: false })))

  it('routes each platform to its own converger, applier, and state seed', async () => {
    const ctx = { mode: 'low', isDm: false, showFooter: true, message: { platform: 'telegram' } }
    const tg = registry.for('telegram')
    expect(tg.createConverger(ctx).label).toBe('telegram:low')
    expect(tg.initialTurnState(ctx)).toEqual({ replyTo: 42 })
    const turn: Turn = { applied: [] }
    await tg.apply(turn, { kind: 'post' })
    expect(turn.applied).toEqual(['telegram:post'])
  })

  it('gives every non-platform origin the CORE surface (the old default arm)', () => {
    // webchat / hook / dream are core surfaces, not platforms (§12) — they render
    // through the same converger and applier Slack does, which is what the
    // ternaries this replaced did by falling through.
    for (const origin of ['webchat', 'hook', 'dream', 'slack', 'teams-x']) {
      expect(registry.for(origin)).toBe(core)
    }
    // …while a registered platform is never shadowed by the core entry.
    expect(registry.for('feishu').platform).toBe('feishu')
  })

  it('keeps per-turn state OPAQUE: only the owning surface reads its shape', async () => {
    // The registry hands core an `unknown`; a platform casts it back to its own
    // shape inside `apply`. Core storing it verbatim is the entire contract.
    const fs = registry.for('feishu')
    const state = fs.initialTurnState({ mode: 'high', isDm: true, showFooter: false, message: { platform: 'feishu' } })
    expect(state).toEqual({ cardAttempted: false })
    // Two turns never share a state object — a card handle leaking across turns
    // would resurrect the bug the slot replaced.
    const second = fs.initialTurnState({ mode: 'high', isDm: true, showFooter: false, message: { platform: 'feishu' } })
    expect(second).not.toBe(state)
  })
})
