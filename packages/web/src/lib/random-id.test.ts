import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from './random-id'

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('randomUUID', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses the native implementation when available', () => {
    const native = vi.fn(() => '11111111-2222-4333-8444-555555555555')
    vi.stubGlobal('crypto', { randomUUID: native })
    expect(randomUUID()).toBe('11111111-2222-4333-8444-555555555555')
    expect(native).toHaveBeenCalledOnce()
  })

  it('builds a valid v4 UUID over HTTP, where only getRandomValues exists', () => {
    // Insecure contexts (HTTP on a LAN host) hide crypto.randomUUID but keep
    // getRandomValues — the frames' z.string().uuid() must still accept the id.
    const real = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) })
    const seen = new Set(Array.from({ length: 64 }, () => randomUUID()))
    for (const id of seen) expect(id).toMatch(V4)
    expect(seen.size).toBe(64)
  })

  it('still emits v4-shaped ids with no crypto object at all', () => {
    vi.stubGlobal('crypto', undefined)
    expect(randomUUID()).toMatch(V4)
  })
})
