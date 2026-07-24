import { describe, it, expect, vi } from 'vitest'
import { FakeClock, type Transport } from '@agentconnect.md/connection'
import type { RdMsgWebchat } from '@agentconnect.md/protocol'
import { RelayManager } from '../../src/cp/relay-manager.js'
import type { Logger } from '../../src/log.js'

const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger

/** A transport that never opens (the dial hangs) — enough to observe start/stop without a handshake. */
function hangingConnect(): Promise<Transport> {
  return new Promise<Transport>(() => {})
}

function manager() {
  const connect = vi.fn(hangingConnect)
  const mgr = new RelayManager({
    apiKey: () => 'k',
    daemonId: () => 'daemon-1',
    clock: new FakeClock(),
    connect,
    log: silentLog,
    jitter: () => 0,
    onRelayMsg: (msg: RdMsgWebchat) => ({ msgId: msg.msgId, accepted: true })
  })
  return { mgr, connect }
}

const entry = (relayId: string, url: string) => ({ relayId, url })

describe('RelayManager.converge', () => {
  it('dials newly-listed relays', () => {
    const { mgr, connect } = manager()
    mgr.converge([entry('r1', 'wss://r1'), entry('r2', 'wss://r2')])
    expect(mgr.size()).toBe(2)
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('is idempotent — re-applying the same roster dials nothing new', () => {
    const { mgr, connect } = manager()
    const roster = [entry('r1', 'wss://r1')]
    mgr.converge(roster)
    mgr.converge(roster)
    expect(mgr.size()).toBe(1)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('prunes relays dropped from the roster', () => {
    const { mgr } = manager()
    mgr.converge([entry('r1', 'wss://r1'), entry('r2', 'wss://r2')])
    mgr.converge([entry('r1', 'wss://r1')]) // r2 gone
    expect(mgr.size()).toBe(1)
  })

  it('re-dials a relay whose url changed (relay moved instances)', () => {
    const { mgr, connect } = manager()
    mgr.converge([entry('r1', 'wss://r1-a')])
    mgr.converge([entry('r1', 'wss://r1-b')]) // same id, new url
    expect(mgr.size()).toBe(1)
    expect(connect).toHaveBeenCalledTimes(2) // stopped the old, dialed the new
  })

  it('converge([]) tears every relay down', async () => {
    const { mgr } = manager()
    mgr.converge([entry('r1', 'wss://r1'), entry('r2', 'wss://r2')])
    mgr.converge([])
    expect(mgr.size()).toBe(0)
  })

  it('stop() clears all clients', async () => {
    const { mgr } = manager()
    mgr.converge([entry('r1', 'wss://r1')])
    await mgr.stop()
    expect(mgr.size()).toBe(0)
  })
})
