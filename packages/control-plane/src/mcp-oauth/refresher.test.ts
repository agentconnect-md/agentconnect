import { describe, it, expect, vi } from 'vitest'
import { McpOauthRefresher } from './refresher.js'
import { OrgId } from '../domain/ids.js'
import type {
  McpOauthRefreshCandidate,
  McpProviderOauthRepo,
  McpProviderOauthStateStore
} from '../persistence/ports.js'
import type { McpProviderTokenService } from './token-service.js'

const ORG = OrgId('org-1')
const NOW = new Date('2026-09-14T12:00:00Z').getTime()

function harness(due: McpOauthRefreshCandidate[], refresh: McpProviderTokenService['refresh']) {
  const pushed: string[] = []
  const reaped: Date[] = []
  const oauth = { dueForRefresh: async () => due } as unknown as McpProviderOauthRepo
  const states: McpProviderOauthStateStore = {
    put: vi.fn(),
    bindBrowser: vi.fn(),
    consume: vi.fn(),
    reapExpired: async (now: Date) => {
      reaped.push(now)
      return 0
    }
  }
  const refresher = new McpOauthRefresher({
    providers: {} as never,
    oauth,
    grants: {} as never,
    states,
    tokens: { refresh } as unknown as McpProviderTokenService,
    pushBinding: async (_o, providerId) => {
      pushed.push(providerId)
    },
    clock: { now: () => NOW } as never
  })
  return { refresher, pushed, reaped }
}

const rotated = async () => ({ ok: true as const, accessToken: 'a2', expiresAt: new Date(NOW), rotated: true })

/** A candidate as the sweep reads it: expiry plus the instant the current pair was committed. */
const candidate = (id: string, expiresInMs: number, lifetimeMs = 3600_000) => ({
  orgId: ORG,
  mcpProviderId: id,
  providerName: id,
  accessExpiresAt: new Date(NOW + expiresInMs),
  updatedAt: new Date(NOW + expiresInMs - lifetimeMs)
})

describe('McpOauthRefresher', () => {
  it('renews each due grant and re-pushes its relay binding', async () => {
    const { refresher, pushed } = harness([candidate('p1', 60_000), candidate('p2', 60_000)], rotated)
    expect(await refresher.refreshDueConnections()).toBe(2)
    expect(pushed).toEqual(['p1', 'p2'])
  })

  it('renews BEFORE expiry, not after — a token inside its margin is due', async () => {
    // 30s left on a one-hour token: well inside the 30-minute margin, and the whole point is
    // that it is renewed now rather than after it has already started failing calls.
    const { refresher, pushed } = harness([candidate('p1', 30_000)], rotated)
    expect(await refresher.refreshDueConnections()).toBe(1)
    expect(pushed).toEqual(['p1'])
  })

  it('leaves a token that has not entered its margin alone', async () => {
    // 50 minutes left on a one-hour token — inside the candidate window, outside the margin.
    const { refresher, pushed } = harness([candidate('p1', 50 * 60_000)], rotated)
    expect(await refresher.refreshDueConnections()).toBe(0)
    expect(pushed).toEqual([])
  })

  it('never renews a grant whose server advertised no expiry', async () => {
    const { refresher, pushed } = harness([{ ...candidate('p1', 0), accessExpiresAt: null }], rotated)
    expect(await refresher.refreshDueConnections()).toBe(0)
    expect(pushed).toEqual([])
  })

  it('does not re-push when nothing actually rotated', async () => {
    const { refresher, pushed } = harness([candidate('p1', 60_000)], async () => ({
      ok: true,
      accessToken: 'a1',
      expiresAt: new Date(NOW),
      rotated: false
    }))
    expect(await refresher.refreshDueConnections()).toBe(0)
    expect(pushed).toEqual([])
  })

  it.each([['unreachable'], ['reauth_required']] as const)('leaves the binding alone on %s', async (reason) => {
    const { refresher, pushed } = harness([candidate('p1', 60_000)], async () => ({
      ok: false,
      reason
    }))
    expect(await refresher.refreshDueConnections()).toBe(0)
    expect(pushed).toEqual([])
  })

  it('keeps sweeping when one provider throws', async () => {
    let seen = 0
    const { refresher, pushed } = harness([candidate('bad', 60_000), candidate('good', 60_000)], async () => {
      if (seen++ === 0) throw new Error('upstream exploded')
      return { ok: true, accessToken: 'a2', expiresAt: new Date(NOW), rotated: true }
    })
    expect(await refresher.refreshDueConnections()).toBe(1)
    expect(pushed).toEqual(['good'])
  })

  it('is inert until armed, and stops cleanly', () => {
    const timers: Array<() => void> = []
    const clock = {
      now: () => NOW,
      setTimeout: (fn: () => void) => {
        timers.push(fn)
        return timers.length as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeout: vi.fn()
    }
    const refresher = new McpOauthRefresher({
      providers: {} as never,
      oauth: { dueForRefresh: async () => [] } as unknown as McpProviderOauthRepo,
      grants: {} as never,
      states: { reapExpired: async () => 0 } as unknown as McpProviderOauthStateStore,
      tokens: {} as unknown as McpProviderTokenService,
      pushBinding: async () => {},
      clock: clock as never
    })
    expect(timers).toHaveLength(0)
    refresher.start()
    expect(timers).toHaveLength(1)
    refresher.stop()
    expect(clock.clearTimeout).toHaveBeenCalled()
  })
})
