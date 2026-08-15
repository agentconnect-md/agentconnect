import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadClusterAccess } from './access.js'

// The pod-discovery loader itself is covered in @agentconnect.md/k8s-client;
// what matters here is that naming the pool namespace is the switch, and that
// being outside a pod then fails at boot rather than later, at the first call.
afterEach(() => vi.unstubAllEnvs())

describe('loadClusterAccess', () => {
  it('is off when no pool namespace is named, so an existing deployment is untouched', () => {
    expect(loadClusterAccess({})).toBeUndefined()
  })

  it('refuses to boot when a pool namespace is named outside a pod', () => {
    // Stubbed rather than assumed: a runner that IS in Kubernetes would
    // otherwise get past this and read a real ServiceAccount.
    vi.stubEnv('KUBERNETES_SERVICE_HOST', '')
    expect(() => loadClusterAccess({ POOL_NAMESPACE: 'agentconnect' })).toThrow(/KUBERNETES_SERVICE_HOST/)
  })
})
