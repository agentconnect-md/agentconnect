import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUuid } from './random-uuid'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('randomUuid', () => {
  it('uses the native implementation when available', () => {
    const native = '11111111-1111-4111-8111-111111111111'
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => native) })

    expect(randomUuid()).toBe(native)
  })

  it('generates a UUIDv4 with getRandomValues when randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(0xab)
        return bytes
      }
    })

    expect(randomUuid()).toBe('abababab-abab-4bab-abab-abababababab')
  })

  it('still generates a UUIDv4 when Web Crypto is unavailable', () => {
    vi.stubGlobal('crypto', undefined)
    vi.spyOn(Math, 'random').mockReturnValue(0)

    expect(randomUuid()).toMatch(UUID_V4)
  })
})
