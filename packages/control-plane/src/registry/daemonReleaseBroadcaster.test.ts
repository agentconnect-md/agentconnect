import { describe, it, expect, vi } from 'vitest'
import { DAEMON_AUTO_UPGRADE_FEATURE } from '@agentconnect.md/protocol'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { NoConnection } from '../orchestrator/outbound.js'
import { DaemonReleaseResolver } from './daemonRelease.js'
import { DaemonReleaseBroadcaster } from './daemonReleaseBroadcaster.js'
import type { LifecycleState } from '../ws/registry.js'

const caps = (features: string[]) => ({ platforms: [], runtimes: [], acp: true, features })

function conn(daemonId: string, state: LifecycleState, features: string[] | undefined) {
  return { daemonId, state, ...(features ? { capabilities: caps(features) } : {}) }
}

describe('DaemonReleaseBroadcaster', () => {
  it('pushes upgrade.latest only to READY daemons that advertise the auto-upgrade feature', () => {
    const pushes: { id: string; keys: Record<string, unknown> }[] = []
    const b = new DaemonReleaseBroadcaster({
      resolver: { onChange: () => () => {} },
      connections: {
        reachableDaemons: () => [
          conn('ready-eligible', 'READY', ['x', DAEMON_AUTO_UPGRADE_FEATURE]),
          conn('ready-old', 'READY', ['x']),
          conn('registering', 'REGISTERING', [DAEMON_AUTO_UPGRADE_FEATURE]),
          conn('draining', 'DRAINING', [DAEMON_AUTO_UPGRADE_FEATURE]),
          conn('no-caps', 'READY', undefined)
        ]
      },
      control: { configPush: (id, keys) => void pushes.push({ id, keys }) }
    })
    expect(b.broadcast({ channel: 'latest', version: '1.41.0' })).toBe(1)
    expect(pushes).toEqual([
      { id: 'ready-eligible', keys: { 'upgrade.latest': { channel: 'latest', version: '1.41.0' } } }
    ])
  })

  it('swallows a connection lost since the scan and keeps pushing to the rest', () => {
    const warn = vi.fn()
    const pushed: string[] = []
    const b = new DaemonReleaseBroadcaster({
      resolver: { onChange: () => () => {} },
      connections: {
        reachableDaemons: () => [
          conn('gone', 'READY', [DAEMON_AUTO_UPGRADE_FEATURE]),
          conn('live', 'READY', [DAEMON_AUTO_UPGRADE_FEATURE])
        ]
      },
      control: {
        configPush: (id) => {
          if (id === 'gone') throw new NoConnection(id)
          pushed.push(id)
        }
      },
      log: { warn }
    })
    expect(b.broadcast({ channel: 'rc', version: '1.41.0-rc.1' })).toBe(1)
    expect(pushed).toEqual(['live'])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('broadcasts each resolver change while started, and nothing after stop', async () => {
    const clock = new FakeClock(1000)
    let version = '1.40.0'
    const resolver = new DaemonReleaseResolver(
      'latest',
      clock,
      async () => ({ ok: true, json: async () => ({ latest: version }) }) as unknown as Response,
      60_000,
      60_000
    )
    const configPush = vi.fn()
    const b = new DaemonReleaseBroadcaster({
      resolver,
      connections: { reachableDaemons: () => [conn('d1', 'READY', [DAEMON_AUTO_UPGRADE_FEATURE])] },
      control: { configPush }
    })
    b.start()
    resolver.start()
    await vi.waitFor(() =>
      expect(configPush).toHaveBeenCalledWith('d1', { 'upgrade.latest': { channel: 'latest', version: '1.40.0' } })
    )

    version = '1.41.0'
    clock.advance(60_000)
    await vi.waitFor(() => expect(configPush).toHaveBeenCalledTimes(2))
    expect(configPush).toHaveBeenLastCalledWith('d1', { 'upgrade.latest': { channel: 'latest', version: '1.41.0' } })

    b.stop()
    version = '1.42.0'
    clock.advance(60_000)
    await vi.waitFor(() => expect(resolver.current()?.version).toBe('1.42.0'))
    expect(configPush).toHaveBeenCalledTimes(2)
    resolver.stop()
  })
})
