import { describe, expect, it } from 'vitest'
import { parseSteeringOutcome, steeringRequestParams, steeringSupported } from '../src/acp/steering.js'
import {
  selectSteerTarget,
  steerEligibleEntry,
  steerPromptBlocks,
  steeredTranscriptText
} from '../src/daemon/steering-admission.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import type { Pending } from '../src/daemon/turn-types.js'

const msg = (over: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  msgId: 'slack:C1:100.2',
  traceId: '100.2',
  source: 'user',
  platform: 'slack',
  channel: 'C1',
  thread: 'T1',
  sender: { id: 'U1', isBot: false },
  text: 'use the staging database instead',
  mentionedBots: [],
  isDm: true,
  trigger: 'dm',
  ...over
})

describe('_session/steering wire helpers', () => {
  it('reads the capability only from an explicit `_meta.steering.supported: true`', () => {
    expect(steeringSupported({ steering: { supported: true } })).toBe(true)
    expect(steeringSupported({ steering: { supported: 'true' } })).toBe(false)
    expect(steeringSupported({ steering: {} })).toBe(false)
    expect(steeringSupported({})).toBe(false)
    expect(steeringSupported(undefined)).toBe(false)
    expect(steeringSupported(null)).toBe(false)
  })

  it('shapes the request with the prompt and the idle behaviour under `_meta.steering`', () => {
    const blocks = [{ type: 'text' as const, text: 'hi' }]
    expect(steeringRequestParams('s1', blocks, 'promptRequired')).toEqual({
      sessionId: 's1',
      prompt: blocks,
      _meta: { steering: { idleBehavior: 'promptRequired' } }
    })
    expect(steeringRequestParams('s1', blocks)).toEqual({ sessionId: 's1', prompt: blocks })
  })

  it('reads only the three known outcomes; anything else is a failed steer', () => {
    expect(parseSteeringOutcome({ outcome: 'injected' })).toBe('injected')
    expect(parseSteeringOutcome({ outcome: 'startedNewTurn' })).toBe('startedNewTurn')
    expect(parseSteeringOutcome({ outcome: 'failed' })).toBe('failed')
    expect(parseSteeringOutcome({ outcome: 'queued' })).toBe('failed')
    expect(parseSteeringOutcome({})).toBe('failed')
    expect(parseSteeringOutcome(null)).toBe('failed')
  })
})

describe('steer admission policy', () => {
  it('steers only an ordinary human chat message', () => {
    expect(steerEligibleEntry({ msg: msg() })).toBe(true)
    expect(steerEligibleEntry({ msg: msg(), isQueueCmd: true })).toBe(false)
    expect(steerEligibleEntry({ msg: msg({ source: 'cron' }) })).toBe(false)
    expect(steerEligibleEntry({ msg: msg({ source: 'agent' }) })).toBe(false)
    expect(steerEligibleEntry({ msg: msg(), hookContext: {} as never })).toBe(false)
    expect(steerEligibleEntry({ msg: msg(), callMeta: {} as never })).toBe(false)
    expect(steerEligibleEntry({ msg: msg(), admissionWait: Promise.resolve(true) })).toBe(false)
    expect(steerEligibleEntry({ msg: msg(), coordinationWait: Promise.resolve() })).toBe(false)
  })

  const pending = (over: Partial<Pending> = {}): Pending =>
    ({ plan: { sessionKey: 'slack:C1:T1:bot-a' }, promptInFlight: true, ...over }) as unknown as Pending

  it('targets the live prompt of the same key, and nothing else', () => {
    const live = pending()
    expect(selectSteerTarget([pending({ plan: { sessionKey: 'other' } as never }), live], 'slack:C1:T1:bot-a')).toBe(
      live
    )
    expect(selectSteerTarget([live], 'slack:C1:T1:bot-b')).toBeUndefined()
    // Between prompts (final fence, regeneration decision) there is nothing to steer into.
    expect(selectSteerTarget([pending({ promptInFlight: false })], 'slack:C1:T1:bot-a')).toBeUndefined()
    // A paused or loop-tripped turn takes no more input.
    expect(selectSteerTarget([pending({ outputSuppressed: 'pause' })], 'slack:C1:T1:bot-a')).toBeUndefined()
  })

  it('stops steering once the per-turn budget is spent', () => {
    expect(selectSteerTarget([pending({ steerCount: 2 })], 'slack:C1:T1:bot-a', 3)).toBeDefined()
    expect(selectSteerTarget([pending({ steerCount: 3 })], 'slack:C1:T1:bot-a', 3)).toBeUndefined()
  })

  it('prompts the running turn in the trigger shape and names attachments without sending them', () => {
    expect(steerPromptBlocks(msg())).toEqual([{ type: 'text', text: '[U1] use the staging database instead' }])
    const withFile = msg({
      attachments: [{ id: 'F1', name: 'plan.md', mimeType: 'text/markdown', size: 12, sourceUrl: 'https://x.test/f' }]
    })
    const [block] = steerPromptBlocks(withFile)
    expect(block).toMatchObject({ type: 'text' })
    expect((block as { text: string }).text.startsWith('[U1] use the staging database instead\n')).toBe(true)
    expect((block as { text: string }).text).toContain('plan.md')
    // The transcript row text is the same text the observed-inbound row carries.
    expect(steeredTranscriptText(msg())).toBe('use the staging database instead')
    expect(steeredTranscriptText(withFile)).toContain('plan.md')
  })
})
