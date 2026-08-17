import { describe, expect, it } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { ChannelBinder } from '../src/k8s/channel-binder.js'
import { LaunchRegistry } from '../src/k8s/launch-registry.js'
import { SandboxLease } from '../src/k8s/sandbox-lease.js'
import { noopClusterMetrics } from '../src/metrics/cluster-metrics.js'
import { fakeGenerations } from './fake-generations.js'

const log = { info: () => {}, warn: () => {}, debug: () => {} }

function binder(registry: LaunchRegistry, clock: FakeClock) {
  const lease = new SandboxLease({ api: {} as never, warmPoolName: 'pool', log, metrics: noopClusterMetrics })
  return new ChannelBinder({
    registry,
    lease,
    clock,
    log,
    metrics: noopClusterMetrics,
    channelTimeoutMs: 1_000,
    awaitReady: async () => ({ podName: 'p', podIp: '10.0.0.8' }),
    connectChannel: async () => {
      throw new Error('the bind must not reach the pod')
    }
  })
}

describe('cluster channel binder', () => {
  it('refuses a launch the registry no longer holds, before waking its pod', async () => {
    // The release fence only catches a release that lands DURING the bind. One that landed while
    // the caller was still awaiting its launch is already in the snapshot, so both fence checks
    // pass — and a departed member would wake and bind a pod that is no longer its to serve.
    const clock = new FakeClock()
    const registry = new LaunchRegistry({ generations: fakeGenerations(), clock })
    const launch = registry.recordLaunch('agent-a', 'sb-1', 'sandbox-uid-1')
    registry.bumpRelease('agent-a')
    registry.forgetLaunch('agent-a')

    await expect(binder(registry, clock).bindChannel('agent-a', launch, undefined, ['acp'])).rejects.toThrow(
      /left this member before its sandbox channel was bound/
    )
  })
})
