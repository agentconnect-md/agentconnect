import { describe, it, expect, vi } from 'vitest'
import { McpOauthRefresher } from './refresher.js'
import { OrgId } from '../domain/ids.js'
import type { McpProviderOauthRepo, McpProviderOauthStateStore } from '../persistence/ports.js'
import type { McpProviderTokenService } from './token-service.js'

const ORG = OrgId('org-1')
const NOW = new Date('2026-09-14T12:00:00Z').getTime()

function harness(
  due: Array<{ orgId: OrgId; mcpProviderId: string; providerName: string }>,
  refresh: McpProviderTokenService['refresh']
) {
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

describe('McpOauthRefresher', () => {
  it('renews each due grant and re-pushes its relay binding', async () => {
    const { refresher, pushed } = harness(
      [
        { orgId: ORG, mcpProviderId: 'p1', providerName: 'linear' },
        { orgId: ORG, mcpProviderId: 'p2', providerName: 'notion' }
      ],
      rotated
    )
    expect(await refresher.refreshDueConnections()).toBe(2)
    expect(pushed).toEqual(['p1', 'p2'])
  })

  it('does not re-push when nothing actually rotated', async () => {
    const { refresher, pushed } = harness([{ orgId: ORG, mcpProviderId: 'p1', providerName: 'linear' }], async () => ({
      ok: true,
      accessToken: 'a1',
      expiresAt: new Date(NOW),
      rotated: false
    }))
    expect(await refresher.refreshDueConnections()).toBe(0)
    expect(pushed).toEqual([])
  })

  it.each([['unreachable'], ['reauth_required']] as const)('leaves the binding alone on %s', async (reason) => {
    const { refresher, pushed } = harness([{ orgId: ORG, mcpProviderId: 'p1', providerName: 'linear' }], async () => ({
      ok: false,
      reason
    }))
    expect(await refresher.refreshDueConnections()).toBe(0)
    expect(pushed).toEqual([])
  })

  it('keeps sweeping when one provider throws', async () => {
    let seen = 0
    const { refresher, pushed } = harness(
      [
        { orgId: ORG, mcpProviderId: 'bad', providerName: 'linear' },
        { orgId: ORG, mcpProviderId: 'good', providerName: 'notion' }
      ],
      async () => {
        if (seen++ === 0) throw new Error('upstream exploded')
        return { ok: true, accessToken: 'a2', expiresAt: new Date(NOW), rotated: true }
      }
    )
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
