import { describe, expect, it } from 'vitest'
import { IntegrationCoreEnvelope, IntegrationRevoked, IntegrationRevokedOk } from './integration.js'
import { buildEnvelope, decodeEnvelope, encode } from '../codec.js'
import { isInstallWideFrameType } from '../frame-scope.js'

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

// A daemon socket's explicit lifecycle report: the integration ids it serves, the reason, and the event time as its only fence.
describe('IntegrationRevoked', () => {
  const INTEGRATION = '0f0e0d0c-0b0a-4908-8706-050403020100'
  const report = { integrationIds: [INTEGRATION], reason: 'app_uninstalled', eventAtMs: 1_780_000_000_000 }

  it('round-trips a report and its verdict through the frame codec', () => {
    const decoded = decodeEnvelope(encode(buildEnvelope('integration/revoked', report, { orgId: 'org-a' })))
    if (!decoded.ok) throw new Error('expected ok')
    expect(decoded.frame).toMatchObject({ type: 'integration/revoked', orgId: 'org-a', payload: report })
    const verdict = decodeEnvelope(encode(buildEnvelope('integration/revoked/ok', { applied: false })))
    expect(verdict.ok && verdict.frame.payload).toEqual({ applied: false })
  })

  it('accepts a bot-token revocation', () => {
    expect(IntegrationRevoked.parse({ ...report, reason: 'tokens_revoked' }).reason).toBe('tokens_revoked')
  })

  it('refuses a report without the event-time fence, an empty or malformed id list, or another reason', () => {
    const { eventAtMs: _eventAtMs, ...unfenced } = report
    expect(IntegrationRevoked.safeParse(unfenced).success).toBe(false)
    expect(IntegrationRevoked.safeParse({ ...report, eventAtMs: -1 }).success).toBe(false)
    expect(IntegrationRevoked.safeParse({ ...report, integrationIds: [] }).success).toBe(false)
    expect(IntegrationRevoked.safeParse({ ...report, integrationIds: ['bot-1'] }).success).toBe(false)
    expect(IntegrationRevoked.safeParse({ ...report, reason: 'invalid_auth' }).success).toBe(false)
    expect(IntegrationRevokedOk.safeParse({}).success).toBe(false)
  })

  it('is org-scoped on the wire, so an install-wide connection must name the org', () => {
    expect(isInstallWideFrameType('integration/revoked')).toBe(false)
    expect(isInstallWideFrameType('integration/revoked/ok')).toBe(false)
  })
})
