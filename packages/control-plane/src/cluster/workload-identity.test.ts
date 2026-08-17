/** Projected-token checks for a non-daemon in-cluster workload (the usage collector). */
import { afterEach, describe, expect, it } from 'vitest'
import { CLOUD_DAEMON_SA_NAME, CP_TOKEN_AUDIENCE, USAGE_COLLECTOR_SA_NAME } from '@agentconnect.md/protocol'
import { K8sHttp } from '@agentconnect.md/k8s-client'
import { closeFakeApiServers, fakeApiServer } from '@agentconnect.md/k8s-client/testing'
import { ClusterWorkloadIdentityService } from './workload-identity.js'
import { clusterIdentityOf } from './daemon-identity.js'

const POD_UID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
/** The control plane's own namespace, as in production. */
const NS = 'agentconnect'

function reviewed(opts: { authenticated?: boolean; audiences?: string[]; username?: string; podUid?: string }) {
  return {
    apiVersion: 'authentication.k8s.io/v1',
    kind: 'TokenReview',
    status: {
      authenticated: opts.authenticated ?? true,
      ...(opts.audiences ? { audiences: opts.audiences } : {}),
      ...(opts.username
        ? {
            user: {
              username: opts.username,
              ...(opts.podUid ? { extra: { 'authentication.kubernetes.io/pod-uid': [opts.podUid] } } : {})
            }
          }
        : {})
    }
  }
}

async function service(review: unknown) {
  const server = await fakeApiServer(() => ({ json: review }))
  return new ClusterWorkloadIdentityService(new K8sHttp(server.config), NS)
}

const collectorReview = (namespace = NS, serviceAccount = USAGE_COLLECTOR_SA_NAME) =>
  reviewed({
    audiences: [CP_TOKEN_AUDIENCE],
    username: clusterIdentityOf(namespace, serviceAccount),
    podUid: POD_UID
  })

afterEach(async () => {
  await closeFakeApiServers()
})

describe('ClusterWorkloadIdentityService', () => {
  it('accepts the expected ServiceAccount in the control plane namespace and attests its Pod', async () => {
    const svc = await service(collectorReview())
    expect(await svc.verify('tok', USAGE_COLLECTOR_SA_NAME)).toEqual({ podUid: POD_UID })
  })

  it('refuses a token the API server did not authenticate', async () => {
    const svc = await service(reviewed({ authenticated: false }))
    expect(await svc.verify('tok', USAGE_COLLECTOR_SA_NAME)).toBeNull()
  })

  it('refuses a token scoped to another audience', async () => {
    const svc = await service(
      reviewed({
        audiences: ['some-other-service'],
        username: clusterIdentityOf(NS, USAGE_COLLECTOR_SA_NAME),
        podUid: POD_UID
      })
    )
    expect(await svc.verify('tok', USAGE_COLLECTOR_SA_NAME)).toBeNull()
  })

  it('refuses the DAEMON ServiceAccount — the shared audience is not the separator', async () => {
    // Both principals carry CP_TOKEN_AUDIENCE, so without this check a pool member's
    // token would be able to write usage for any org.
    const svc = await service(collectorReview(NS, CLOUD_DAEMON_SA_NAME))
    expect(await svc.verify('tok', USAGE_COLLECTOR_SA_NAME)).toBeNull()
  })

  it('refuses the right ServiceAccount from any other namespace', async () => {
    const svc = await service(collectorReview('someone-elses-namespace'))
    expect(await svc.verify('tok', USAGE_COLLECTOR_SA_NAME)).toBeNull()
  })

  it('refuses a token that is not Pod-bound', async () => {
    const svc = await service(
      reviewed({ audiences: [CP_TOKEN_AUDIENCE], username: clusterIdentityOf(NS, USAGE_COLLECTOR_SA_NAME) })
    )
    expect(await svc.verify('tok', USAGE_COLLECTOR_SA_NAME)).toBeNull()
  })

  it('refuses a principal that is not a ServiceAccount at all', async () => {
    const svc = await service(reviewed({ audiences: [CP_TOKEN_AUDIENCE], username: 'system:node:worker-1' }))
    expect(await svc.verify('tok', USAGE_COLLECTOR_SA_NAME)).toBeNull()
  })
})
