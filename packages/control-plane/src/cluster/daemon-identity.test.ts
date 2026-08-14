/** Projected-token checks for org envelopes and install-wide cloud members. */
import { afterEach, describe, expect, it } from 'vitest'
import { CLOUD_DAEMON_SA_NAME, CP_TOKEN_AUDIENCE, ENVELOPE_DAEMON_SA_NAME } from '@agentconnect.md/protocol'
import { K8sHttp } from '@agentconnect.md/k8s-client'
import { closeFakeApiServers, fakeApiServer } from '@agentconnect.md/k8s-client/testing'
import { ClusterDaemonIdentityService, clusterIdentityOf, parseServiceAccountSubject } from './daemon-identity.js'
import type { OrgResourceApi } from './org-api.js'
import type { ClusterExecutionSettings, DaemonRecord, OrgClusterExecutionRepo } from '../persistence/ports.js'
import { DaemonId, OrgId } from '../domain/ids.js'

const PREFIX = 'ac-org-'
const RESOURCE = 'org-example'
const NAMESPACE = `${PREFIX}${RESOURCE}`
const ORG_ID = 'org_example'
const DAEMON_ID = '11111111-1111-4111-8111-111111111111'
const POD_UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
/** Where this install runs its cloud daemons — the control namespace, as in production. */
const CLOUD_NAMESPACE = 'agentconnect'

const SETTINGS = { orgId: ORG_ID, enabled: true, resourceName: RESOURCE } as ClusterExecutionSettings

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

function clusterRepo(settings: ClusterExecutionSettings | null): Pick<OrgClusterExecutionRepo, 'getByResourceName'> {
  return { getByResourceName: async (name: string) => (name === RESOURCE ? settings : null) }
}

function orgApi(publishedNamespace: string | undefined): OrgResourceApi {
  return {
    namespace: 'agentconnect',
    get: async () => (publishedNamespace ? { status: { namespace: publishedNamespace } } : {}),
    apply: async () => ({}),
    delete: async () => {}
  }
}

/** Records what it was asked to bind, so the binding arguments themselves are assertable.
 *  `bound` is what an already-existing record answers to a daemonId lookup (the relay hop). */
function daemons(record: Partial<DaemonRecord> | null = { id: DaemonId(DAEMON_ID) }) {
  const seen: string[] = []
  const seenOrgIds: OrgId[] = []
  const seenPodUids: string[] = []
  const adopt: (string | undefined)[] = []
  return {
    seen,
    seenOrgIds,
    seenPodUids,
    adopt,
    resolveClusterIdentity: async (_orgId: OrgId, identity: string, opts?: { adoptDaemonId?: string }) => {
      seenOrgIds.push(_orgId)
      seen.push(identity)
      adopt.push(opts?.adoptDaemonId)
      return record as DaemonRecord | null
    },
    resolveCloudClusterIdentity: async (identity: string, podUid: string) => {
      seen.push(identity)
      seenPodUids.push(podUid)
      return record as DaemonRecord
    }
  }
}

async function service(opts: {
  review: unknown
  settings?: ClusterExecutionSettings | null
  /** What the CR publishes on `status.namespace`; null ⇒ not published yet. */
  published?: string | null
  daemonStore?: ReturnType<typeof daemons>
}) {
  const server = await fakeApiServer(() => ({ json: opts.review }))
  const store = opts.daemonStore ?? daemons()
  const published = opts.published === undefined ? NAMESPACE : opts.published
  return {
    store,
    svc: new ClusterDaemonIdentityService(
      new K8sHttp(server.config),
      orgApi(published ?? undefined),
      clusterRepo(opts.settings === undefined ? SETTINGS : opts.settings),
      store,
      PREFIX,
      CLOUD_NAMESPACE
    )
  }
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
  it('binds a verified envelope daemon to its org', async () => {
    const { svc, store } = await service({
      review: reviewed({
        audiences: [CP_TOKEN_AUDIENCE],
        username: clusterIdentityOf(NAMESPACE, ENVELOPE_DAEMON_SA_NAME)
      })
    })
    expect(await svc.verify('token')).toEqual({ daemonId: DAEMON_ID, scope: 'org', orgId: ORG_ID })
    // The binding key is exactly the subject the API server reported.
    expect(store.seen).toEqual([`system:serviceaccount:${NAMESPACE}:${ENVELOPE_DAEMON_SA_NAME}`])
    expect(store.adopt).toEqual([undefined])
  })

  it('offers the retired key path’s pinned daemon for adoption, so an existing envelope keeps it', async () => {
    const { svc, store } = await service({
      review: reviewed({
        audiences: [CP_TOKEN_AUDIENCE],
        username: clusterIdentityOf(NAMESPACE, ENVELOPE_DAEMON_SA_NAME)
      }),
      settings: { ...SETTINGS, legacyKeyDaemonId: DAEMON_ID }
    })
    await svc.verify('token')
    expect(store.adopt).toEqual([DAEMON_ID])
  })

  it('sends the control-plane audience on the TokenReview', async () => {
    const seen: string[] = []
    const server = await fakeApiServer((req) => {
      seen.push(req.body)
      return {
        json: reviewed({
          audiences: [CP_TOKEN_AUDIENCE],
          username: clusterIdentityOf(NAMESPACE, ENVELOPE_DAEMON_SA_NAME)
        })
      }
    })
    const svc = new ClusterDaemonIdentityService(
      new K8sHttp(server.config),
      orgApi(NAMESPACE),
      clusterRepo(SETTINGS),
      daemons(),
      PREFIX,
      CLOUD_NAMESPACE
    )
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
        username: clusterIdentityOf(NAMESPACE, ENVELOPE_DAEMON_SA_NAME)
      })
    })
    expect(await svc.verify('token')).toBeNull()
  })

  it('refuses another ServiceAccount in the same namespace', async () => {
    const { svc } = await service({
      review: reviewed({ audiences: [CP_TOKEN_AUDIENCE], username: clusterIdentityOf(NAMESPACE, 'ac-runtime') })
    })
    expect(await svc.verify('token')).toBeNull()
  })

  it('refuses a namespace outside this install', async () => {
    const { svc } = await service({
      review: reviewed({
        audiences: [CP_TOKEN_AUDIENCE],
        username: clusterIdentityOf('kube-system', ENVELOPE_DAEMON_SA_NAME)
      })
    })
    expect(await svc.verify('token')).toBeNull()
  })

  it('refuses a namespace no enabled envelope owns', async () => {
    const { svc } = await service({
      review: reviewed({
        audiences: [CP_TOKEN_AUDIENCE],
        username: clusterIdentityOf(NAMESPACE, ENVELOPE_DAEMON_SA_NAME)
      }),
      settings: { ...SETTINGS, enabled: false }
    })
    expect(await svc.verify('token')).toBeNull()
  })

  it('refuses when the org publishes a different namespace than the token claims', async () => {
    const { svc } = await service({
      review: reviewed({
        audiences: [CP_TOKEN_AUDIENCE],
        username: clusterIdentityOf(NAMESPACE, ENVELOPE_DAEMON_SA_NAME)
      }),
      published: `${PREFIX}someone-else`
    })
    expect(await svc.verify('token')).toBeNull()
  })

  it('refuses while the operator has not published the namespace yet', async () => {
    const { svc } = await service({
      review: reviewed({
        audiences: [CP_TOKEN_AUDIENCE],
        username: clusterIdentityOf(NAMESPACE, ENVELOPE_DAEMON_SA_NAME)
      }),
      published: null
    })
    expect(await svc.verify('token')).toBeNull()
  })

  it('refuses an identity already bound to another org', async () => {
    const { svc } = await service({
      review: reviewed({
        audiences: [CP_TOKEN_AUDIENCE],
        username: clusterIdentityOf(NAMESPACE, ENVELOPE_DAEMON_SA_NAME)
      }),
      daemonStore: daemons(null)
    })
    expect(await svc.verify('token')).toBeNull()
  })

  it('refuses an envelope daemon claiming another daemon id', async () => {
    const { svc } = await service({
      review: reviewed({
        audiences: [CP_TOKEN_AUDIENCE],
        username: clusterIdentityOf(NAMESPACE, ENVELOPE_DAEMON_SA_NAME)
      })
    })
    expect(await svc.verify('token', { daemonId: '22222222-2222-4222-8222-222222222222' })).toBeNull()
  })
})

describe('ClusterDaemonIdentityService — cloud daemon', () => {
  const cloudReview = (namespace = CLOUD_NAMESPACE) =>
    reviewed({
      audiences: [CP_TOKEN_AUDIENCE],
      username: clusterIdentityOf(namespace, CLOUD_DAEMON_SA_NAME),
      extra: { 'authentication.kubernetes.io/pod-uid': [POD_UID] }
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
    expect(store.seenOrgIds).toEqual([])
    expect(store.adopt).toEqual([])
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
    const store = daemons({ id: DaemonId(DAEMON_ID) })
    const { svc } = await service({ review: cloudReview(), daemonStore: store })
    expect(await svc.verify('token', { daemonId: DAEMON_ID })).toEqual({ daemonId: DAEMON_ID, scope: 'install' })
  })

  it('refuses a claimed daemon id different from the reviewed Pod member', async () => {
    const store = daemons({ id: DaemonId(DAEMON_ID) })
    const { svc } = await service({ review: cloudReview(), daemonStore: store })
    expect(await svc.verify('token', { daemonId: '22222222-2222-4222-8222-222222222222' })).toBeNull()
  })
})
