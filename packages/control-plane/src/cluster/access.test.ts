import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadClusterAccess } from './access.js'

// The pod-discovery loader itself is covered in @agentconnect.md/k8s-client;
// what matters here is that enabling the daemon pool is the switch, and that
// being outside a pod then fails at boot rather than later, at the first call.
afterEach(() => vi.unstubAllEnvs())

describe('loadClusterAccess', () => {
  it('is off when the daemon pool is not enabled, so an existing deployment is untouched', () => {
    expect(loadClusterAccess({})).toBeUndefined()
    expect(loadClusterAccess({ DAEMON_POOL_ENABLED: false })).toBeUndefined()
  })

  it('refuses to boot when the daemon pool is enabled outside a pod', () => {
    // Stubbed rather than assumed: a runner that IS in Kubernetes would
    // otherwise get past this and read a real ServiceAccount.
    vi.stubEnv('KUBERNETES_SERVICE_HOST', '')
    expect(() => loadClusterAccess({ DAEMON_POOL_ENABLED: true })).toThrow(/KUBERNETES_SERVICE_HOST/)
  })
})
