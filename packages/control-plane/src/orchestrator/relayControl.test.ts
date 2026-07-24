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
