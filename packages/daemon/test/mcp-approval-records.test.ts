import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  APPROVAL_TTL_MS,
  APPROVAL_WAIT_MS,
  ApprovalRecords,
  argumentsDigest,
  canonicalJson
} from '../src/mcp/approval-records.js'

// The approval digest reads parsed values, so the bytes a runtime forwards and the value ACP showed agree (mcp-tool-permissions.md §7.4).

const AGENT = 'agent-1'
const base = { agentId: AGENT, provider: 'probe', tool: 'write_note', source: 'person' as const }

afterEach(() => {
  vi.useRealTimers()
})

describe('the canonical argument digest', () => {
  it('reads numbers as JSON.parse does', () => {
    const forwarded = JSON.parse('{"amount":2.50,"zero":-0.0,"exp":1e2,"big":12345678901234567890}') as unknown
    const shown = { amount: 2.5, zero: 0, exp: 100, big: 12345678901234567000 }
    expect(argumentsDigest(forwarded)).toBe(argumentsDigest(shown))
    expect(argumentsDigest({ amount: 2.5 })).not.toBe(argumentsDigest({ amount: 2.51 }))
    expect(argumentsDigest({ amount: 1 })).not.toBe(argumentsDigest({ amount: '1' }))
  })

  it('sorts keys at every depth and keeps array order', () => {
    const a = JSON.parse('{"b":{"y":[1,{"q":1,"p":2}],"x":null},"a":"first","10":1,"9":2}') as unknown
    const b = { 9: 2, 10: 1, a: 'first', b: { x: null, y: [1, { p: 2, q: 1 }] } }
    expect(argumentsDigest(a)).toBe(argumentsDigest(b))
    expect(canonicalJson(a)).toBe('{"10":1,"9":2,"a":"first","b":{"x":null,"y":[1,{"p":2,"q":1}]}}')
    expect(argumentsDigest({ list: [1, 2] })).not.toBe(argumentsDigest({ list: [2, 1] }))
    const deep = JSON.parse(`${'{"n":'.repeat(200)}1${'}'.repeat(200)}`) as unknown
    expect(argumentsDigest(deep)).toBe(argumentsDigest(JSON.parse(canonicalJson(deep))))
  })

  it('never normalizes Unicode, and escapes as JSON does', () => {
    const composed = { name: 'café', sep: ' ', zw: 'a​b', emoji: '\u{1f600}' }
    const decomposed = { ...composed, name: 'café' }
    expect(argumentsDigest(composed)).not.toBe(argumentsDigest(decomposed))
    expect(argumentsDigest(JSON.parse(JSON.stringify(composed)) as unknown)).toBe(argumentsDigest(composed))
    expect(argumentsDigest(JSON.parse('{"e":"\\ud83d\\ude00"}') as unknown)).toBe(argumentsDigest({ e: '\u{1f600}' }))
  })

  it('reads absent arguments as none', () => {
    expect(argumentsDigest(undefined)).toBe(argumentsDigest({}))
    expect(argumentsDigest(null)).toBe(argumentsDigest({}))
    expect(argumentsDigest({ a: undefined })).toBe(argumentsDigest({}))
  })
})

describe('approval records', () => {
  it('are used once, for their own agent and call', async () => {
    const records = new ApprovalRecords()
    records.put({ ...base, toolCallId: 'call-1', argsDigest: 'd1' })
    expect(await records.take('other-agent', 'call-1', () => true, 0)).toBeUndefined()
    expect(await records.take(AGENT, 'call-2', () => true, 0)).toBeUndefined()
    expect(await records.take(AGENT, 'call-1', (r) => r.argsDigest === 'd2', 0)).toBeUndefined()
    expect(await records.take(AGENT, 'call-1', (r) => r.argsDigest === 'd1', 0)).toMatchObject({ source: 'person' })
    expect(await records.take(AGENT, 'call-1', () => true, 0)).toBeUndefined()
  })

  it('expire after two minutes', async () => {
    let now = 1_000
    const records = new ApprovalRecords({ now: () => now })
    records.put({ ...base, toolCallId: 'call-1', argsDigest: 'd1' })
    now += APPROVAL_TTL_MS
    expect(records.get(AGENT, 'call-1')).toBeUndefined()
    expect(await records.take(AGENT, 'call-1', () => true, 0)).toBeUndefined()
  })

  it('hold a bounded number per agent, the oldest dropped first', () => {
    const records = new ApprovalRecords({ perAgent: 2 })
    for (const id of ['a', 'b', 'c']) records.put({ ...base, toolCallId: id, argsDigest: id })
    expect(records.get(AGENT, 'a')).toBeUndefined()
    expect(records.get(AGENT, 'c')).toMatchObject({ argsDigest: 'c' })
  })

  it('let a call wait up to two seconds for a record written after it, and then refuse', async () => {
    vi.useFakeTimers()
    const records = new ApprovalRecords()
    const early = records.take(AGENT, 'call-1', (r) => r.argsDigest === 'd1')
    await vi.advanceTimersByTimeAsync(APPROVAL_WAIT_MS - 100)
    records.put({ ...base, toolCallId: 'call-1', argsDigest: 'd1' })
    await expect(early).resolves.toMatchObject({ toolCallId: 'call-1' })
    const late = records.take(AGENT, 'call-2', () => true)
    await vi.advanceTimersByTimeAsync(APPROVAL_WAIT_MS)
    records.put({ ...base, toolCallId: 'call-2', argsDigest: 'd2' })
    await expect(late).resolves.toBeUndefined()
  })

  it('hand a refreshed digest to the waiting call, and one record to one of two calls', async () => {
    vi.useFakeTimers()
    const records = new ApprovalRecords()
    records.put({ ...base, toolCallId: 'call-1', argsDigest: 'partial' })
    const first = records.take(AGENT, 'call-1', (r) => r.argsDigest === 'final')
    const second = records.take(AGENT, 'call-1', (r) => r.argsDigest === 'final')
    expect(records.refresh(AGENT, 'call-1', 'final')).toBe(true)
    await expect(first).resolves.toMatchObject({ argsDigest: 'final' })
    await vi.advanceTimersByTimeAsync(APPROVAL_WAIT_MS)
    await expect(second).resolves.toBeUndefined()
    expect(records.refresh(AGENT, 'call-1', 'again')).toBe(false)
  })
})
