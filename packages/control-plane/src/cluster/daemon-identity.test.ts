/** Projected-token checks for install-wide cloud members. */
import { afterEach, describe, expect, it } from 'vitest'
import { CLOUD_DAEMON_SA_NAME, CP_TOKEN_AUDIENCE } from '@agentconnect.md/protocol'
import { K8sHttp } from '@agentconnect.md/k8s-client'
import { closeFakeApiServers, fakeApiServer } from '@agentconnect.md/k8s-client/testing'
import { ClusterDaemonIdentityService, clusterIdentityOf, parseServiceAccountSubject } from './daemon-identity.js'
import type { DaemonRecord } from '../persistence/ports.js'
import { DaemonId } from '../domain/ids.js'

const DAEMON_ID = '11111111-1111-4111-8111-111111111111'
const POD_UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
/** Where this install runs its cloud daemons — the control namespace, as in production. */
const CLOUD_NAMESPACE = 'agentconnect'

/** A TokenReview response as the API server writes it; `undefined` fields are omitted. */
function reviewed(opts: {
  authenticated?: boolean
  audiences?: string[]
  username?: string
  extra?: Record<string, string[]>
}) {
  return {
    apiVersion: 'authentication.k8s.io/v1',
    kind: 'TokenReview',
    status: {
      authenticated: opts.authenticated ?? true,
      ...(opts.audiences ? { audiences: opts.audiences } : {}),
      ...(opts.username ? { user: { username: opts.username, ...(opts.extra ? { extra: opts.extra } : {}) } } : {})
    }
  }
}

/** Records what it was asked to bind, so the binding arguments themselves are assertable. */
function daemons(record: Partial<DaemonRecord> = { id: DaemonId(DAEMON_ID) }) {
  const seen: string[] = []
  const seenPodUids: string[] = []
  return {
    seen,
    seenPodUids,
    resolveCloudClusterIdentity: async (identity: string, podUid: string) => {
      seen.push(identity)
      seenPodUids.push(podUid)
      return record as DaemonRecord
    }
  }
}

async function service(opts: { review: unknown; daemonStore?: ReturnType<typeof daemons> }) {
  const server = await fakeApiServer(() => ({ json: opts.review }))
  const store = opts.daemonStore ?? daemons()
  return { store, svc: new ClusterDaemonIdentityService(new K8sHttp(server.config), store, CLOUD_NAMESPACE) }
}

afterEach(async () => {
  await closeFakeApiServers()
})

describe('parseServiceAccountSubject', () => {
  it('reads namespace and name out of a ServiceAccount username', () => {
    expect(parseServiceAccountSubject('system:serviceaccount:ns:sa')).toEqual({
      namespace: 'ns',
      serviceAccount: 'sa'
    })
  })

  it('refuses any principal that is not a ServiceAccount', () => {
    expect(parseServiceAccountSubject('system:node:worker-1')).toBeNull()
    expect(parseServiceAccountSubject('alice@example.test')).toBeNull()
    expect(parseServiceAccountSubject('system:serviceaccount::sa')).toBeNull()
    expect(parseServiceAccountSubject(undefined)).toBeNull()
  })
})

describe('ClusterDaemonIdentityService', () => {
  const cloudReview = (namespace = CLOUD_NAMESPACE) =>
    reviewed({
      audiences: [CP_TOKEN_AUDIENCE],
      username: clusterIdentityOf(namespace, CLOUD_DAEMON_SA_NAME),
      extra: { 'authentication.kubernetes.io/pod-uid': [POD_UID] }
    })

  it('sends the control-plane audience on the TokenReview', async () => {
    const seen: string[] = []
    const server = await fakeApiServer((req) => {
      seen.push(req.body)
      return { json: cloudReview() }
    })
    const svc = new ClusterDaemonIdentityService(new K8sHttp(server.config), daemons(), CLOUD_NAMESPACE)
    await svc.verify('presented')
    expect(JSON.parse(seen[0]!).spec).toEqual({ token: 'presented', audiences: [CP_TOKEN_AUDIENCE] })
  })

  it('refuses a token the API server did not authenticate', async () => {
    const { svc } = await service({ review: reviewed({ authenticated: false }) })
    expect(await svc.verify('token')).toBeNull()
  })

  it('refuses a token scoped to another audience', async () => {
    const { svc } = await service({
      review: reviewed({
        audiences: ['ac-daemon-callback'],
        username: clusterIdentityOf(CLOUD_NAMESPACE, CLOUD_DAEMON_SA_NAME),
        extra: { 'authentication.kubernetes.io/pod-uid': [POD_UID] }
      })
    })
    expect(await svc.verify('token')).toBeNull()
  })

  it('refuses another ServiceAccount in the cloud namespace', async () => {
    const { svc } = await service({
      review: reviewed({
        audiences: [CP_TOKEN_AUDIENCE],
        username: clusterIdentityOf(CLOUD_NAMESPACE, 'ac-runtime')
      })
    })
    expect(await svc.verify('token')).toBeNull()
  })

  it('binds a reviewed cloud Pod to its org-less member record', async () => {
    const { svc, store } = await service({ review: cloudReview() })
    expect(await svc.verify('token')).toEqual({ daemonId: DAEMON_ID, scope: 'install' })
    expect(await svc.verify('token')).toEqual({ daemonId: DAEMON_ID, scope: 'install' })
    expect(store.seen).toEqual([
      clusterIdentityOf(CLOUD_NAMESPACE, CLOUD_DAEMON_SA_NAME),
      clusterIdentityOf(CLOUD_NAMESPACE, CLOUD_DAEMON_SA_NAME)
    ])
    expect(store.seenPodUids).toEqual([POD_UID, POD_UID])
  })

  it('refuses a cloud ServiceAccount token that is not Pod-bound', async () => {
    const { svc } = await service({
      review: reviewed({
        audiences: [CP_TOKEN_AUDIENCE],
        username: clusterIdentityOf(CLOUD_NAMESPACE, CLOUD_DAEMON_SA_NAME)
      })
    })
    expect(await svc.verify('token')).toBeNull()
  })

  it('refuses an ambiguous reviewed Pod UID', async () => {
    const { svc } = await service({
      review: reviewed({
        audiences: [CP_TOKEN_AUDIENCE],
        username: clusterIdentityOf(CLOUD_NAMESPACE, CLOUD_DAEMON_SA_NAME),
        extra: { 'authentication.kubernetes.io/pod-uid': [POD_UID, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] }
      })
    })
    expect(await svc.verify('token')).toBeNull()
  })

  it('refuses a cloud identity from any other namespace', async () => {
    const { svc } = await service({ review: cloudReview('kube-system') })
    expect(await svc.verify('token')).toBeNull()
  })

  it('accepts the member daemon id echoed by the relay hop', async () => {
    const { svc } = await service({ review: cloudReview(), daemonStore: daemons({ id: DaemonId(DAEMON_ID) }) })
    expect(await svc.verify('token', { daemonId: DAEMON_ID })).toEqual({ daemonId: DAEMON_ID, scope: 'install' })
  })

  it('refuses a claimed daemon id different from the reviewed Pod member', async () => {
    const { svc } = await service({ review: cloudReview(), daemonStore: daemons({ id: DaemonId(DAEMON_ID) }) })
    expect(await svc.verify('token', { daemonId: '22222222-2222-4222-8222-222222222222' })).toBeNull()
  })
})
