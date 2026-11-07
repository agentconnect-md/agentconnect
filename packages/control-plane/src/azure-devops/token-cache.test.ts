// The per-connection token cache (azure-devops-integration.md §3.4).
import { describe, expect, it, vi } from 'vitest'
import { AzureDevOpsTokenCache, REFRESH_MARGIN_MS } from './token-cache.js'

function minter(expiresInSec: number) {
  let issued = 0
  return vi.fn(async () => {
    issued += 1
    return { accessToken: `token-${issued}`, expiresInSec }
  })
}

describe('AzureDevOpsTokenCache', () => {
  it('keeps a token until fewer than twenty minutes of its issued life remain, then refreshes', async () => {
    // Every lease then outlives the daemon's ten-minute handout floor: 20 − 5 (lease margin) > 10.
    expect(REFRESH_MARGIN_MS).toBe(20 * 60_000)
    let now = 0
    const cache = new AzureDevOpsTokenCache(() => now)
    const mint = minter(3600)
    expect(await cache.get('c1', 1n, mint)).toEqual({ token: 'token-1', expiresAtMs: 3_600_000 })
    now = 3_600_000 - REFRESH_MARGIN_MS - 1
    expect((await cache.get('c1', 1n, mint)).token).toBe('token-1')
    now = 3_600_000 - REFRESH_MARGIN_MS
    expect((await cache.get('c1', 1n, mint)).token).toBe('token-2')
    expect(mint).toHaveBeenCalledTimes(2)
  })

  it('reads the lifetime from each answer and never assumes one', async () => {
    let now = 0
    const cache = new AzureDevOpsTokenCache(() => now)
    const mint = minter(5400)
    expect((await cache.get('c1', 1n, mint)).expiresAtMs).toBe(5_400_000)
    now = 4_000_000
    expect((await cache.get('c1', 1n, mint)).token).toBe('token-1')
    // A lifetime shorter than the margin still caches for half of it.
    const short = new AzureDevOpsTokenCache(() => now)
    const shortMint = minter(300)
    await short.get('c2', 1n, shortMint)
    now += 149_000
    await short.get('c2', 1n, shortMint)
    expect(shortMint).toHaveBeenCalledTimes(1)
    now += 2_000
    await short.get('c2', 1n, shortMint)
    expect(shortMint).toHaveBeenCalledTimes(2)
  })

  it('collapses concurrent callers onto one mint per connection', async () => {
    const cache = new AzureDevOpsTokenCache(() => 0)
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const mint = vi.fn(async () => {
      await gate
      return { accessToken: 'token-1', expiresInSec: 3600 }
    })
    const all = Promise.all([cache.get('c1', 1n, mint), cache.get('c1', 1n, mint), cache.get('c1', 1n, mint)])
    release()
    expect((await all).map((t) => t.token)).toEqual(['token-1', 'token-1', 'token-1'])
    expect(mint).toHaveBeenCalledTimes(1)
    // Another connection mints its own.
    await cache.get('c2', 1n, mint)
    expect(mint).toHaveBeenCalledTimes(2)
  })

  it('drops the token when the credential epoch changes or the connection is purged', async () => {
    const cache = new AzureDevOpsTokenCache(() => 0)
    const mint = minter(3600)
    await cache.get('c1', 1n, mint)
    expect((await cache.get('c1', 2n, mint)).token).toBe('token-2')
    cache.purge('c1')
    expect((await cache.get('c1', 2n, mint)).token).toBe('token-3')
  })

  it('never keeps a token whose mint a purge overtook', async () => {
    const cache = new AzureDevOpsTokenCache(() => 0)
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let calls = 0
    const mint = vi.fn(async () => {
      calls += 1
      if (calls === 1) await gate
      return { accessToken: `token-${calls}`, expiresInSec: 3600 }
    })
    const inflight = cache.get('c1', 1n, mint)
    cache.purge('c1')
    release()
    expect((await inflight).token).toBe('token-1')
    expect((await cache.get('c1', 1n, mint)).token).toBe('token-2')
  })
})
