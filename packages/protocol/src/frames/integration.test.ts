import { describe, expect, it } from 'vitest'
import { IntegrationCoreEnvelope } from './integration.js'

/**
 * The core envelope's `sessionModes` (channel-session-mode.md §4). What matters for
 * compatibility is that an envelope from a writer predating the field still parses, and
 * parses to no departures — so that fleet keeps `createNew`, which is the behavior it
 * already had. (The daemon's own ingest casts rather than parses, so this pins the
 * schema's contract for the peers that DO parse it, not that path.)
 */
describe('IntegrationCoreEnvelope sessionModes', () => {
  const base = { mode: 'direct' as const, bindRules: [], mutedChannels: [], gated: false }

  it('round-trips the sparse list', () => {
    const parsed = IntegrationCoreEnvelope.parse({
      ...base,
      sessionModes: [
        { channel: 'C1', mode: 'append' },
        { channel: 'C2', mode: 'createNew' }
      ]
    })
    expect(parsed.sessionModes).toEqual([
      { channel: 'C1', mode: 'append' },
      { channel: 'C2', mode: 'createNew' }
    ])
  })

  it('defaults to no departures when the field is absent', () => {
    expect(IntegrationCoreEnvelope.parse(base).sessionModes).toEqual([])
  })

  // An older CP sends no `sessionModes` and may carry fields this build does not know;
  // neither may cost the envelope the routing knobs it does carry.
  it('parses an older-shaped core, keeping the knobs it does carry', () => {
    const parsed = IntegrationCoreEnvelope.parse({
      mode: 'shared',
      bindRules: [{ match: { kind: 'mention' } }],
      mutedChannels: ['C9'],
      gated: true,
      someFutureKnob: 'ignored'
    })
    expect(parsed).toEqual({
      mode: 'shared',
      bindRules: [{ match: { kind: 'mention' } }],
      mutedChannels: ['C9'],
      gated: true,
      sessionModes: []
    })
  })

  it('rejects a mode outside the enum rather than silently defaulting it', () => {
    expect(() => IntegrationCoreEnvelope.parse({ ...base, sessionModes: [{ channel: 'C1', mode: 'auto' }] })).toThrow()
  })
})
