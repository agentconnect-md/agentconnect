import { describe, expect, it } from 'vitest'
import {
  AGENT_MEMORY_STORE_V1_FEATURE,
  FRAME_TYPES,
  MEMORY_HISTORY_APPEND_MAX_RECORDS,
  MemoryFsPayloadSchema,
  MemoryFsReplySchema,
  MemoryHistoryAppendOk,
  MemoryHistoryAppendReq,
  MemoryHomeMigratedOk,
  MemoryHomeMigratedReq,
  MemoryStoreReq,
  REPLY_BUDGET,
  buildEnvelope,
  decodeEnvelope,
  encode,
  isFrame,
  isInstallWideFrameType
} from '../index.js'

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const ROOT = 'memory'
const AT = '2026-09-08T00:00:00.000Z'

const OPS = [
  'memory-read',
  'memory-append',
  'memory-commit',
  'memory-create-commit',
  'memory-stat',
  'memory-readdir',
  'memory-mkdir',
  'memory-rmdir',
  'memory-rename',
  'memory-rm',
  'memory-utimes'
]

describe('memory store op set', () => {
  it('parses every op the pod already speaks, with a pod-absolute or a tree-relative root alike', () => {
    const payloads = [
      { op: 'memory-read', root: '/workspace/.agentconnect/memory', rel: 'MEMORY.md', offset: 0, limit: REPLY_BUDGET },
      { op: 'memory-read', root: ROOT, rel: 'MEMORY.md', offset: 4096, limit: 1024, encoding: 'base64' },
      { op: 'memory-append', root: ROOT, rel: '.tmp', content: 'hello', create: true },
      { op: 'memory-append', root: ROOT, rel: '.tmp', content: 'aGk=', encoding: 'base64', create: false, mode: 0o600 },
      { op: 'memory-commit', root: ROOT, rel: 'MEMORY.md', temp: '.tmp', ifMatchMtime: AT },
      { op: 'memory-create-commit', root: ROOT, rel: '.entry-lineage', temp: '.tmp' },
      { op: 'memory-stat', root: ROOT, rel: 'MEMORY.md' },
      { op: 'memory-readdir', root: ROOT, rel: '' },
      { op: 'memory-mkdir', root: ROOT, rel: 'topics' },
      { op: 'memory-rmdir', root: ROOT, rel: 'topics' },
      { op: 'memory-rename', root: ROOT, from: 'a.md', to: 'b.md' },
      { op: 'memory-rm', root: ROOT, rel: 'b.md' },
      { op: 'memory-utimes', root: ROOT, rel: 'MEMORY.md', mtime: AT }
    ]
    for (const payload of payloads) expect(MemoryFsPayloadSchema.parse(payload)).toEqual(payload)
    expect(new Set(payloads.map((payload) => payload.op))).toEqual(new Set(OPS))
    expect(MemoryFsPayloadSchema.options).toHaveLength(OPS.length)
  })

  it('caps a read slice at the reply budget and refuses an op or root it does not know', () => {
    const read = { op: 'memory-read', root: ROOT, rel: 'x', offset: 0 }
    expect(MemoryFsPayloadSchema.safeParse({ ...read, limit: REPLY_BUDGET + 1 }).success).toBe(false)
    expect(MemoryFsPayloadSchema.safeParse({ ...read, limit: 0 }).success).toBe(false)
    expect(MemoryFsPayloadSchema.safeParse({ op: 'memory-truncate', root: ROOT, rel: 'x' }).success).toBe(false)
    expect(MemoryFsPayloadSchema.safeParse({ op: 'memory-stat', root: '', rel: 'x' }).success).toBe(false)
  })

  it('carries the two typed refusals as data, not as an error', () => {
    expect(MemoryFsReplySchema.parse({ ok: true, value: null })).toEqual({ ok: true, value: null })
    const refusal = { ok: false, refusal: { kind: 'conflict', message: 'the file changed underneath the write' } }
    expect(MemoryFsReplySchema.parse(refusal)).toEqual(refusal)
    expect(MemoryFsReplySchema.safeParse({ ok: false, refusal: { kind: 'io', message: 'x' } }).success).toBe(false)
  })
})

describe('managed memory home frames', () => {
  it('names the agent on every store request and answers with the op reply', () => {
    const op = { op: 'memory-stat', root: ROOT, rel: 'MEMORY.md' } as const
    const req = buildEnvelope('memory/store', { agentId: AGENT_ID, op }, { orgId: 'org-a' })
    const decoded = decodeEnvelope(encode(req))
    if (!decoded.ok) throw new Error(decoded.msg)
    if (!isFrame('memory/store')(decoded.frame)) throw new Error(`decoded ${decoded.frame.type}`)
    expect(decoded.frame.payload).toEqual({ agentId: AGENT_ID, op })
    expect(decoded.frame.orgId).toBe('org-a')

    const rep = decodeEnvelope(encode(buildEnvelope('memory/store/ok', { ok: true, value: 'file' }, { corr: req.id })))
    if (!rep.ok) throw new Error(rep.msg)
    expect(isFrame('memory/store/ok')(rep.frame)).toBe(true)
    expect(rep.frame.payload).toEqual({ ok: true, value: 'file' })

    // The CP reads the daemon strictly: an unknown key or a non-uuid agent is BAD_PAYLOAD, not ignored.
    expect(MemoryStoreReq.safeParse({ agentId: AGENT_ID, op, extra: 1 }).success).toBe(false)
    expect(MemoryStoreReq.safeParse({ agentId: 'bot-a', op }).success).toBe(false)
    expect(decodeEnvelope(encode(buildEnvelope('memory/store', { agentId: AGENT_ID }))).ok).toBe(false)
  })

  it('appends a bounded provenance batch for one store', () => {
    const record = {
      path: 'MEMORY.md',
      event: 'update',
      before: 'a',
      after: 'b',
      at: AT,
      scope: 'agent',
      source: 'tool'
    }
    const batch = { agentId: AGENT_ID, root: ROOT, records: [record] }
    expect(MemoryHistoryAppendReq.parse(batch)).toEqual(batch)
    expect(MemoryHistoryAppendReq.safeParse({ ...batch, records: [] }).success).toBe(false)
    expect(
      MemoryHistoryAppendReq.safeParse({ ...batch, records: Array(MEMORY_HISTORY_APPEND_MAX_RECORDS + 1).fill(record) })
        .success
    ).toBe(false)
    expect(MemoryHistoryAppendReq.safeParse({ agentId: AGENT_ID, records: [record] }).success).toBe(false)

    // NUL escapes six-to-one, so eleven capped snapshots overflow the frame while the record count is well within its cap.
    const heavy = { ...record, before: '\u0000'.repeat(4001), after: '\u0000'.repeat(4001) }
    expect(MemoryHistoryAppendReq.safeParse({ ...batch, records: Array(11).fill(heavy) }).success).toBe(false)
    const packed = { ...batch, records: Array(MEMORY_HISTORY_APPEND_MAX_RECORDS).fill(record) }
    expect(MemoryHistoryAppendReq.parse(packed)).toEqual(packed)
    expect(Buffer.byteLength(encode(buildEnvelope('memory/history/append', packed)))).toBeLessThanOrEqual(REPLY_BUDGET)

    expect(MemoryHistoryAppendOk.parse({ accepted: true })).toEqual({ accepted: true })
    expect(MemoryHistoryAppendOk.safeParse({ accepted: false }).success).toBe(false)
  })

  it('reports home migration on a frame of its own, not as a store op', () => {
    expect(MemoryHomeMigratedReq.parse({ agentId: AGENT_ID })).toEqual({ agentId: AGENT_ID })
    expect(MemoryHomeMigratedReq.safeParse({ agentId: AGENT_ID, root: ROOT }).success).toBe(false)
    expect(MemoryFsPayloadSchema.safeParse({ op: 'memory-home-migrated', root: ROOT, rel: '' }).success).toBe(false)
    expect(MemoryHomeMigratedOk.parse({ accepted: true })).toEqual({ accepted: true })
    expect(FRAME_TYPES).toContain('memory/home/migrated')
    expect(FRAME_TYPES).toContain('memory/home/migrated/ok')
  })

  it('keeps the family org-scoped and behind its own server feature', () => {
    for (const type of ['memory/store', 'memory/history/append', 'memory/home/migrated']) {
      expect(isInstallWideFrameType(type)).toBe(false)
    }
    // The console's page request keeps its name; the daemon's batch is a different frame.
    expect(FRAME_TYPES).toContain('memory/history')
    expect(FRAME_TYPES).toContain('memory/history/append')
    expect(AGENT_MEMORY_STORE_V1_FEATURE).toBe('agent-memory-store-v1')
  })
})
