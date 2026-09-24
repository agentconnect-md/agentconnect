import { describe, it, expect, vi } from 'vitest'
import { RelayControlSender } from './relayControl.js'
import { RelayRegistry, type RelayChannel } from '../ws/relay-registry.js'

function ch(relayId: string, send = vi.fn()): RelayChannel {
  return { relayId, send, close: vi.fn() }
}

describe('RelayControlSender.daemonRevoke', () => {
  it('fans rc/daemon-revoke to every connected relay', () => {
    const reg = new RelayRegistry()
    const s1 = vi.fn()
    const s2 = vi.fn()
    reg.add(ch('r1', s1))
    reg.add(ch('r2', s2))

    new RelayControlSender(reg).daemonRevoke('daemon-9')

    expect(s1).toHaveBeenCalledWith('rc/daemon-revoke', { daemonId: 'daemon-9' })
    expect(s2).toHaveBeenCalledWith('rc/daemon-revoke', { daemonId: 'daemon-9' })
  })

  it('isolates a dead relay socket — later relays still receive the revoke', () => {
    const reg = new RelayRegistry()
    const s2 = vi.fn()
    reg.add(
      ch(
        'r1',
        vi.fn(() => {
          throw new Error('dead socket')
        })
      )
    )
    reg.add(ch('r2', s2))

    expect(() => new RelayControlSender(reg).daemonRevoke('d')).not.toThrow()
    expect(s2).toHaveBeenCalledOnce()
  })

  it('no connected relays ⇒ no-op', () => {
    expect(() => new RelayControlSender(new RelayRegistry()).daemonRevoke('d')).not.toThrow()
  })
})

describe('RelayControlSender.hookAssign — Decision routing (code-host-decisions.md §3.3)', () => {
  const rule = {
    hookId: '11111111-1111-4111-8111-111111111111',
    kind: 'webhook',
    agentId: '22222222-2222-4222-8222-222222222222',
    daemonId: 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd',
    sessionMode: 'perDelivery',
    webhook: { urlToken: 'whk_example' }
  } as const

  it('assigns a routed rule only where the relay routes, and removes any stale copy elsewhere', () => {
    const reg = new RelayRegistry()
    const routingRelay = vi.fn()
    const olderRelay = vi.fn()
    reg.add({ relayId: 'new', features: ['hook-decision-routing-v1'], send: routingRelay, close: vi.fn() })
    reg.add({ relayId: 'old', features: [], send: olderRelay, close: vi.fn() })
    const routed = {
      ...rule,
      routing: {
        routingId: '55555555-5555-4555-8555-555555555555',
        decisionId: '44444444-4444-4444-8444-444444444444',
        evaluationAgentId: '22222222-2222-4222-8222-222222222222',
        evaluationDaemonId: 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
      }
    }

    new RelayControlSender(reg).hookAssign(routed as never)

    expect(routingRelay).toHaveBeenCalledWith('rc/hook-assign', routed)
    expect(olderRelay).toHaveBeenCalledWith('rc/hook-remove', { hookId: rule.hookId })
  })

  it('leaves an unrouted rule on every relay', () => {
    const reg = new RelayRegistry()
    const olderRelay = vi.fn()
    reg.add({ relayId: 'old', features: [], send: olderRelay, close: vi.fn() })
    new RelayControlSender(reg).hookAssign(rule as never)
    expect(olderRelay).toHaveBeenCalledWith('rc/hook-assign', rule)
  })
})
