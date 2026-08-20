import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { FRAME_SCHEMAS, type FrameType } from './frame.js'
import { decodeCpEnvelope, decodeEnvelope } from './codec.js'
import { isStrictObject, reachableSchemas, tolerantReader } from './tolerant.js'

/**
 * Direction-asymmetric strictness (protocol §1).
 *
 * The live case this pins: a `.strict()` object nested in `register/ok` — the
 * CP-authored reconcile baseline — turned one added optional field into a
 * permanent handshake failure on every daemon older than the CP. The CP's own
 * reader keeps refusing an unknown key on what a daemon sends it.
 */

const ID = '11111111-1111-4111-8111-111111111111'
const CONNECTION_ID = '44444444-4444-4444-8444-444444444444'
const TS = '2026-08-20T00:00:00.000Z'

function envelope(type: FrameType, payload: unknown) {
  return JSON.stringify({ v: 1, id: ID, ts: TS, type, payload })
}

/** Stands in for the next field a newer CP adds; `orgId` was the live one. */
const ADDED_LATER = 'addedByANewerControlPlane'

/** One `memoryConnections` entry, plus whatever a newer CP has started sending. */
function memoryConnection(extra: Record<string, unknown> = {}) {
  return {
    connectionId: CONNECTION_ID,
    revision: 1,
    config: { endpoint: 'https://memory.example.test' },
    secretKeys: [],
    pin: { pluginId: 'mem0', profileMajor: 1, secretHeaders: [] },
    transport: 'streamable-http',
    relayUrl: 'https://relay.example.test/mcp',
    grantKey: 'grant-1',
    ...extra
  }
}

function registerOk(extra: Record<string, unknown> = {}) {
  return {
    routingEpoch: 3,
    assignments: [],
    crons: [],
    leases: [],
    drop: { assignments: [], crons: [] },
    ...extra
  }
}

describe('CP-authored frames read tolerantly on the daemon', () => {
  it('accepts a register/ok whose memoryConnections entry carries a field this build predates', () => {
    const text = envelope(
      'register/ok',
      registerOk({ memoryConnections: [memoryConnection({ [ADDED_LATER]: 'org-1' })] })
    )

    // The strict reader is the whole incident: one unknown key fails the handshake, forever.
    const strict = decodeEnvelope(text)
    expect(strict.ok).toBe(false)
    if (!strict.ok) expect(strict.msg).toContain('unrecognized_keys')

    const tolerant = decodeCpEnvelope(text)
    expect(tolerant.ok).toBe(true)
    if (tolerant.ok && tolerant.frame.type === 'register/ok') {
      const connection = tolerant.frame.payload.memoryConnections[0]
      expect(connection?.connectionId).toBe(CONNECTION_ID)
      // Stripped, not carried: an unread field must not leak into daemon state.
      expect(connection && ADDED_LATER in connection).toBe(false)
    }
  })

  it('tolerates an added field at the top of a snapshot and inside a nested spec alike', () => {
    const text = envelope(
      'register/ok',
      registerOk({
        somethingNewer: { nested: true },
        memoryConnections: [memoryConnection({ pin: { pluginId: 'mem0', profileMajor: 1, tier: 'gold' } })]
      })
    )
    const decoded = decodeCpEnvelope(text)
    expect(decoded.ok).toBe(true)
    if (decoded.ok && decoded.frame.type === 'register/ok') {
      expect('somethingNewer' in decoded.frame.payload).toBe(false)
      expect(decoded.frame.payload.memoryConnections[0]?.pin.pluginId).toBe('mem0')
    }
  })

  it('keeps every check that is not about unknown keys', () => {
    // Wrong type on a known field — the reason the payload schema exists at all.
    expect(decodeCpEnvelope(envelope('register/ok', registerOk({ routingEpoch: 'not-a-number' }))).ok).toBe(false)
    // Missing required field.
    expect(decodeCpEnvelope(envelope('register/ok', { assignments: [], crons: [] })).ok).toBe(false)
    // A refinement inside a discriminated-union member: the lease must match `secretKeys`.
    const stdio = {
      ...memoryConnection(),
      transport: 'stdio',
      relayUrl: undefined,
      grantKey: undefined,
      commandRef: 'mem0-local',
      secretKeys: ['API_KEY'],
      secretLease: { values: { OTHER_KEY: 'v' } }
    }
    expect(decodeCpEnvelope(envelope('memoryconnection/upsert', stdio)).ok).toBe(false)
    const matched = { ...stdio, secretLease: { values: { API_KEY: 'v' } }, addedLater: true }
    const ok = decodeCpEnvelope(envelope('memoryconnection/upsert', matched))
    expect(ok.ok).toBe(true)
    if (ok.ok && ok.frame.type === 'memoryconnection/upsert') {
      expect('addedLater' in ok.frame.payload).toBe(false)
      expect(ok.frame.payload.transport).toBe('stdio')
    }
  })

  it('leaves the daemon→CP direction strict — the CP still refuses an unknown key it is sent', () => {
    const fact = {
      connectionId: CONNECTION_ID,
      revision: 1,
      pluginId: 'mem0',
      status: 'ready',
      unexpected: 'x'
    }
    const decoded = decodeEnvelope(envelope('facts/memory-connections', { connections: [fact] }))
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.msg).toContain('unrecognized_keys')
  })
})

describe('the rebuild reaches every strict object, so the next added field is inert too', () => {
  const strictReachable = (schema: z.ZodType) => [...reachableSchemas(schema)].filter(isStrictObject)

  it('finds strict objects under the strict map (the guard is testing something)', () => {
    const found = Object.values(FRAME_SCHEMAS).flatMap((schema) => strictReachable(schema))
    expect(found.length).toBeGreaterThan(0)
  })

  it('leaves none under the tolerant one', () => {
    const survivors = Object.entries(FRAME_SCHEMAS).filter(
      ([, schema]) => strictReachable(tolerantReader(schema)).length > 0
    )
    expect(survivors.map(([type]) => type)).toEqual([])
  })

  it('relaxes a strict object behind any container the wire can nest it in', () => {
    const strict = z.object({ a: z.string() }).strict()
    const nested = z.object({
      list: z.array(strict),
      maybe: strict.optional(),
      fallback: z.array(strict).default([]),
      bag: z.record(z.string(), strict),
      either: z.union([strict, z.string()]),
      pair: z.tuple([strict]),
      piped: strict.pipe(z.any()),
      later: z.lazy(() => strict)
    })
    const value = { a: 'x', b: 'unknown' }
    const parsed = tolerantReader(nested).parse({
      list: [value],
      maybe: value,
      bag: { k: value },
      either: value,
      pair: [value],
      piped: value,
      later: value
    })
    expect(parsed).toEqual({
      list: [{ a: 'x' }],
      maybe: { a: 'x' },
      fallback: [],
      bag: { k: { a: 'x' } },
      either: { a: 'x' },
      pair: [{ a: 'x' }],
      piped: { a: 'x' },
      later: { a: 'x' }
    })
  })

  it('keeps a declared catchall, which states a key policy rather than inheriting one', () => {
    const open = z.object({ a: z.string() }).catchall(z.unknown())
    expect(tolerantReader(open).parse({ a: 'x', b: 2 })).toEqual({ a: 'x', b: 2 })
  })

  it('returns one rebuilt instance per schema, so decoding does not rebuild per frame', () => {
    expect(tolerantReader(FRAME_SCHEMAS['register/ok'])).toBe(tolerantReader(FRAME_SCHEMAS['register/ok']))
  })
})
