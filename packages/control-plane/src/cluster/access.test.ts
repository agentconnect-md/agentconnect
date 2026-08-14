import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadClusterAccess } from './access.js'

// The pod-discovery loader itself is covered in @agentconnect.md/k8s-client;
// what matters here is the switch and that being outside a pod fails at boot
// rather than later, at the first write.
afterEach(() => vi.unstubAllEnvs())

describe('loadClusterAccess', () => {
  it('is off by default, so an existing deployment is untouched', () => {
    expect(loadClusterAccess({ CLUSTER_DAEMON_IDENTITY_ENABLED: false })).toBeUndefined()
    expect(
      loadClusterAccess({ CLUSTER_DAEMON_IDENTITY_ENABLED: false, CLUSTER_EXECUTION_ENABLED: false })
    ).toBeUndefined()
  })

  it('refuses to boot when the feature is on outside a pod', () => {
    // Stubbed rather than assumed: a runner that IS in Kubernetes would
    // otherwise get past this and read a real ServiceAccount.
    vi.stubEnv('KUBERNETES_SERVICE_HOST', '')
    expect(() => loadClusterAccess({ CLUSTER_DAEMON_IDENTITY_ENABLED: true })).toThrow(/KUBERNETES_SERVICE_HOST/)
  })

  // The rename must not turn a chart that still sets the old key into a control
  // plane that rejects every in-cluster daemon on the TokenReview.
  it('honors the deprecated alias alone, so the CP can roll before its chart', () => {
    vi.stubEnv('KUBERNETES_SERVICE_HOST', '')
    expect(() =>
      loadClusterAccess({ CLUSTER_DAEMON_IDENTITY_ENABLED: false, CLUSTER_EXECUTION_ENABLED: true })
    ).toThrow(/KUBERNETES_SERVICE_HOST/)
  })
})
