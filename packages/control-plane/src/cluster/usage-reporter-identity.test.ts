/** Projected-token checks for an install-level usage reporter. */
import { afterEach, describe, expect, it } from 'vitest'
import { USAGE_REPORTER_SA_NAME, CLOUD_DAEMON_SA_NAME, CP_TOKEN_AUDIENCE } from '@agentconnect.md/protocol'
import { K8sHttp } from '@agentconnect.md/k8s-client'
import { closeFakeApiServers, fakeApiServer } from '@agentconnect.md/k8s-client/testing'
import { ClusterUsageReporterIdentityService } from './usage-reporter-identity.js'

/** Where the install runs its reporter — the control plane's own namespace, as in production. */
const REPORTER_NS = 'agentconnect'

function reviewed(opts: { authenticated?: boolean; audiences?: string[]; username?: string }) {
  return {
    apiVersion: 'authentication.k8s.io/v1',
    kind: 'TokenReview',
    status: {
      authenticated: opts.authenticated ?? true,
      ...(opts.audiences ? { audiences: opts.audiences } : {}),
      ...(opts.username ? { user: { username: opts.username } } : {})
    }
  }
}

async function service(review: unknown) {
  const server = await fakeApiServer(() => ({ json: review }))
  return new ClusterUsageReporterIdentityService(new K8sHttp(server.config), REPORTER_NS)
}

afterEach(async () => {
  await closeFakeApiServers()
})

describe('ClusterUsageReporterIdentityService', () => {
  it('accepts the reporter ServiceAccount in the install namespace', async () => {
    const svc = await service(
      reviewed({
        audiences: [CP_TOKEN_AUDIENCE],
        username: `system:serviceaccount:${REPORTER_NS}:${USAGE_REPORTER_SA_NAME}`
      })
    )
    expect(await svc.verify('token')).toBe(true)
  })

  it('accepts without a Pod UID, unlike a pool member', async () => {
    // Stated as a test because the difference is deliberate: reporter replicas are
    // interchangeable writers, so pinning the Pod would make a rollout look unknown.
    const svc = await service(
      reviewed({
        audiences: [CP_TOKEN_AUDIENCE],
        username: `system:serviceaccount:${REPORTER_NS}:${USAGE_REPORTER_SA_NAME}`
      })
    )
    expect(await svc.verify('token')).toBe(true)
  })

  it('refuses the reporter name presented from another namespace', async () => {
    // "May report for every org" must not follow from a pod merely holding the name.
    const svc = await service(
      reviewed({ audiences: [CP_TOKEN_AUDIENCE], username: `system:serviceaccount:other-ns:${USAGE_REPORTER_SA_NAME}` })
    )
    expect(await svc.verify('token')).toBe(false)
  })

  it('refuses a pool member: the ServiceAccount name is the discriminator', async () => {
    const svc = await service(
      reviewed({
        audiences: [CP_TOKEN_AUDIENCE],
        username: `system:serviceaccount:${REPORTER_NS}:${CLOUD_DAEMON_SA_NAME}`
      })
    )
    expect(await svc.verify('token')).toBe(false)
  })

  it('refuses a token minted for another audience', async () => {
    const svc = await service(
      reviewed({
        audiences: ['ac-shim-bind'],
        username: `system:serviceaccount:${REPORTER_NS}:${USAGE_REPORTER_SA_NAME}`
      })
    )
    expect(await svc.verify('token')).toBe(false)
  })

  it('refuses when the API server reports the token unauthenticated', async () => {
    const svc = await service(reviewed({ authenticated: false, audiences: [CP_TOKEN_AUDIENCE] }))
    expect(await svc.verify('token')).toBe(false)
  })

  it('refuses a non-ServiceAccount principal', async () => {
    const svc = await service(reviewed({ audiences: [CP_TOKEN_AUDIENCE], username: 'kubernetes-admin' }))
    expect(await svc.verify('token')).toBe(false)
  })
})
