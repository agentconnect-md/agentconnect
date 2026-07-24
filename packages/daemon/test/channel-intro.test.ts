import { describe, it, expect } from 'vitest'
import { planChannelIntros, buildIntroMessage, introPrompt, INTRO_MAX_BURST } from '../src/agents/channel-intro.js'

const state = (seeded: boolean, introduced: string[] = []) => ({ seeded, introduced: new Set(introduced) })

describe('planChannelIntros', () => {
  it('seeds the first snapshot silently (no intros), adopting every channel as baseline', () => {
    const plan = planChannelIntros(state(false), ['C1', 'C2', 'C3'])
    expect(plan.markSeeded).toBe(true)
    expect(plan.introduce).toEqual([])
    expect(plan.adoptSilently).toEqual(['C1', 'C2', 'C3'])
  })

  it('introduces only channels that appear AFTER the baseline', () => {
    const plan = planChannelIntros(state(true, ['C1', 'C2']), ['C1', 'C2', 'C3'])
    expect(plan.markSeeded).toBe(false)
    expect(plan.introduce).toEqual(['C3'])
    expect(plan.adoptSilently).toEqual([])
  })

  it('is a no-op when nothing new appeared', () => {
    const plan = planChannelIntros(state(true, ['C1', 'C2']), ['C1', 'C2'])
    expect(plan).toEqual({ markSeeded: false, introduce: [], adoptSilently: [] })
  })

  it('treats a channel dropping out (bot removed) as a no-op, not an intro', () => {
    const plan = planChannelIntros(state(true, ['C1', 'C2']), ['C1'])
    expect(plan.introduce).toEqual([])
    expect(plan.adoptSilently).toEqual([])
  })

  it('adopts a burst larger than the threshold silently instead of storming peers', () => {
    const fresh = Array.from({ length: INTRO_MAX_BURST + 1 }, (_, i) => `N${i}`)
    const plan = planChannelIntros(state(true, ['C1']), ['C1', ...fresh])
    expect(plan.introduce).toEqual([])
    expect(plan.adoptSilently).toEqual(fresh)
  })

  it('introduces up to the burst threshold', () => {
    const fresh = Array.from({ length: INTRO_MAX_BURST }, (_, i) => `N${i}`)
    const plan = planChannelIntros(state(true, []), fresh)
    // seeded=true so this is a genuine batch of joins at exactly the threshold
    expect(plan.introduce).toEqual(fresh)
    expect(plan.adoptSilently).toEqual([])
  })

  it('dedupes duplicate channel ids in the snapshot', () => {
    const plan = planChannelIntros(state(true, []), ['C1', 'C1'])
    expect(plan.introduce).toEqual(['C1'])
  })
})

describe('buildIntroMessage', () => {
  it('builds a headless root turn keyed to the REAL channel so peer defaults resolve', () => {
    const msg = buildIntroMessage('bot-a', 'slack', 'C1', 'trace-1')
    expect(msg.headless).toBe(true)
    expect(msg.source).toBe('cron')
    expect(msg.platform).toBe('slack')
    // keyed to the REAL channel (headless ⇒ no channel output; ctx.channel drives
    // listChannelAgents/sendMessage defaults and gives peers a real channel to inherit)
    expect(msg.channel).toBe('C1')
    // a distinct synthetic thread === transcriptTs (root) so no thread-history backfill runs
    expect(msg.thread).toBe(msg.transcriptTs)
    expect(msg.thread).toBe('intro:C1:trace-1')
    expect(msg.text).toContain('bot-a')
    expect(msg.text).toContain('listChannelAgents')
    // Waking a peer is now a complete sendMessage agent-target call (a silent wake), not messageAgent.
    expect(msg.text).toContain('sendMessage')
    expect(msg.text).toContain('{"to":{"toAgent":"<their id>"},"message":"<short introduction>"}')
    expect(msg.text).not.toContain('messageAgent')
  })
})

describe('introPrompt', () => {
  it('bounds the turn to introducing only', () => {
    const p = introPrompt('C1', 'bot-a')
    expect(p).toContain('Introduce yourself ONLY')
    expect(p).toContain('do not post to the channel')
  })

  it('gives a complete sendMessage agent-target call (silent wake), not dotted pseudo-syntax', () => {
    const p = introPrompt('C1', 'bot-a')
    expect(p).toContain('sendMessage')
    expect(p).toContain('{"to":{"toAgent":"<their id>"},"message":"<short introduction>"}')
    expect(p).toContain('silent wake')
    expect(p).not.toContain('to.toAgent')
    expect(p).not.toContain('messageAgent')
  })
})
