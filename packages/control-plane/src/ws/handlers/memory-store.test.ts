import { describe, expect, it, vi } from 'vitest'
import type { AnyFrame } from '@agentconnect.md/protocol'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { PlacementResolver } from '../../orchestrator/placementResolver.js'
import { systemClock } from '../../domain/clock.js'
import type { DaemonId } from '../../domain/ids.js'
import { MemoryStoreTooLargeError } from '../../agent-memory/paths.js'
import { handleMemoryHistoryAppend, handleMemoryStore } from './memory-store.js'

const DAEMON = 'd0d0d0d0-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ORG = 'org-default'
const POOL_SET = '5e700000-0000-4000-8000-000000000001'

const readOp = { op: 'memory-read', root: 'memory', rel: 'MEMORY.md', offset: 0, limit: 1024 } as const

function frame(type: AnyFrame['type'], payload: Record<string, unknown>): AnyFrame {
  return { v: 1, id: crypto.randomUUID(), ts: '2026-09-08T00:00:00.000Z', type, orgId: ORG, payload } as AnyFrame
}

function conn() {
  return { daemonId: DAEMON, orgId: null, replyTo: vi.fn(), sendError: vi.fn() } as unknown as DaemonConnection & {
    replyTo: ReturnType<typeof vi.fn>
    sendError: ReturnType<typeof vi.fn>
  }
}

/** The live seam, keyed by who holds each agent's duty right now. */
function holderOf(holds: Record<string, string[]>): PlacementResolver {
  const of = async (agentId: string) => (holds[String(agentId)] ?? []) as DaemonId[]
  return new PlacementResolver({ duties: { holdersOf: of, confirmedHoldersOf: of }, clock: systemClock })
}

const cpHome = { provider: 'managed', home: 'control-plane' }

function deps(overrides: Partial<Record<keyof DaemonWsDeps, unknown>> = {}): DaemonWsDeps {
  return {
    log: { error: vi.fn() },
    agent: { get: async () => ({ id: AGENT, orgId: ORG, placementKind: 'daemon', daemonId: DAEMON, memory: cpHome }) },
    agentMemoryStore: { apply: vi.fn(async () => ({ ok: true, value: { exists: false } })) },
    agentMemoryHistory: { append: vi.fn(async () => undefined) },
    ...overrides
  } as unknown as DaemonWsDeps
}

describe('handleMemoryStore', () => {
  it('serves an op for an agent placed on the connection whose home is the Control Plane', async () => {
    const d = deps()
    const c = conn()
    await handleMemoryStore(frame('memory/store', { agentId: AGENT, op: readOp }), c, d)
    expect(c.replyTo).toHaveBeenCalledWith(expect.anything(), 'memory/store/ok', { ok: true, value: { exists: false } })
    expect((d.agentMemoryStore as { apply: ReturnType<typeof vi.fn> }).apply).toHaveBeenCalledWith(
      expect.objectContaining({ id: AGENT, orgId: ORG }),
      readOp
    )
  })

  it('refuses an agent this daemon does not serve — the fence that stops a member racing its successor', async () => {
    const c = conn()
    const pool = { id: AGENT, orgId: ORG, placementKind: 'set', daemonId: null, setId: POOL_SET, memory: cpHome }
    const d = deps({ agent: { get: async () => pool }, placementResolver: holderOf({ [AGENT]: ['other-daemon'] }) })
    await handleMemoryStore(frame('memory/store', { agentId: AGENT, op: readOp }), c, d)
    expect(c.sendError).toHaveBeenCalledWith(
      expect.any(String),
      'SCOPE_DENIED',
      'agent is not served by this daemon',
      false
    )
    expect(c.replyTo).not.toHaveBeenCalled()

    const served = deps({ agent: { get: async () => pool }, placementResolver: holderOf({ [AGENT]: [DAEMON] }) })
    const c2 = conn()
    await handleMemoryStore(frame('memory/store', { agentId: AGENT, op: readOp }), c2, served)
    expect(c2.replyTo).toHaveBeenCalledOnce()
  })

  it('refuses an agent whose home is not the Control Plane, an unbound one included', async () => {
    for (const memory of [
      null,
      { provider: 'managed' },
      { provider: 'managed', home: 'daemon' },
      { provider: 'native' }
    ]) {
      const c = conn()
      const d = deps({ agent: { get: async () => ({ id: AGENT, orgId: ORG, daemonId: DAEMON, memory }) } })
      await handleMemoryStore(frame('memory/store', { agentId: AGENT, op: readOp }), c, d)
      expect(c.sendError).toHaveBeenCalledWith(
        expect.any(String),
        'SCOPE_DENIED',
        'the agent memory home is not the Control Plane',
        false
      )
    }
  })

  it('refuses an agent outside the frame org', async () => {
    const c = conn()
    const d = deps({ agent: { get: async () => null } })
    await handleMemoryStore(frame('memory/store', { agentId: AGENT, op: readOp }), c, d)
    expect(c.sendError).toHaveBeenCalledWith(
      expect.any(String),
      'SCOPE_DENIED',
      'agent is not served by this daemon',
      false
    )
  })

  it('passes a typed refusal through as data, answers the file cap as BAD_PAYLOAD, and never throws', async () => {
    const refusal = { ok: false, refusal: { kind: 'conflict', message: 'changed' } }
    const c = conn()
    await handleMemoryStore(
      frame('memory/store', { agentId: AGENT, op: readOp }),
      c,
      deps({ agentMemoryStore: { apply: async () => refusal } })
    )
    expect(c.replyTo).toHaveBeenCalledWith(expect.anything(), 'memory/store/ok', refusal)

    const tooLarge = conn()
    await handleMemoryStore(
      frame('memory/store', { agentId: AGENT, op: readOp }),
      tooLarge,
      deps({
        agentMemoryStore: {
          apply: async () => {
            throw new MemoryStoreTooLargeError('memory file exceeds the 256000-byte limit')
          }
        }
      })
    )
    expect(tooLarge.sendError).toHaveBeenCalledWith(
      expect.any(String),
      'BAD_PAYLOAD',
      'memory file exceeds the 256000-byte limit',
      false
    )

    const failing = conn()
    const log = { error: vi.fn() }
    const d = deps({
      log,
      agentMemoryStore: {
        apply: async () => {
          throw new Error('db down')
        }
      }
    })
    await expect(
      handleMemoryStore(frame('memory/store', { agentId: AGENT, op: readOp }), failing, d)
    ).resolves.toBeUndefined()
    expect(failing.sendError).toHaveBeenCalledWith(
      expect.any(String),
      'INTERNAL',
      'memory store operation failed',
      true
    )
    expect(log.error).toHaveBeenCalledOnce()
  })

  it('answers INTERNAL when the home is not wired', async () => {
    const c = conn()
    await handleMemoryStore(
      frame('memory/store', { agentId: AGENT, op: readOp }),
      c,
      deps({ agentMemoryStore: undefined })
    )
    expect(c.sendError).toHaveBeenCalledWith(expect.any(String), 'INTERNAL', 'the memory home is unavailable', true)
  })
})

describe('handleMemoryHistoryAppend', () => {
  const record = {
    path: 'MEMORY.md',
    event: 'update',
    before: 'a',
    after: 'b',
    at: '2026-09-08T00:00:00.000Z',
    scope: 'agent',
    source: 'tool'
  }

  it('files the batch under the same fence, minting an id for a record without one', async () => {
    const d = deps()
    const c = conn()
    const withId = { ...record, id: '11111111-1111-4111-8111-111111111111' }
    await handleMemoryHistoryAppend(
      frame('memory/history/append', { agentId: AGENT, root: 'memory', records: [withId, record] }),
      c,
      d
    )
    const append = (d.agentMemoryHistory as { append: ReturnType<typeof vi.fn> }).append
    expect(append).toHaveBeenCalledOnce()
    const [agentId, orgId, root, rows, retention] = append.mock.calls[0]!
    expect([agentId, orgId, root]).toEqual([AGENT, ORG, 'memory'])
    expect(rows[0]).toMatchObject({ id: withId.id, path: 'MEMORY.md', event: 'update', before: 'a', after: 'b' })
    expect(rows[1].id).toMatch(/^[0-9a-f-]{36}$/)
    expect(rows[0].bytes).toBe(Buffer.byteLength(JSON.stringify(withId) + '\n'))
    expect(retention).toEqual({ maxVersionsPerFile: 100, maxBytesPerRoot: 2 * 1024 * 1024 })
    expect(c.replyTo).toHaveBeenCalledWith(expect.anything(), 'memory/history/append/ok', { accepted: true })
  })

  it('refuses under the same rules as the store', async () => {
    const c = conn()
    const d = deps({ agent: { get: async () => ({ id: AGENT, orgId: ORG, daemonId: DAEMON, memory: null }) } })
    await handleMemoryHistoryAppend(
      frame('memory/history/append', { agentId: AGENT, root: 'memory', records: [record] }),
      c,
      d
    )
    expect(c.sendError).toHaveBeenCalledWith(expect.any(String), 'SCOPE_DENIED', expect.any(String), false)
  })
})
