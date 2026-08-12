/**
 * Verifying an in-cluster daemon's projected ServiceAccount token. Every refusal answers
 * the same `null`, so these assert the checks individually — a token that is authentic but
 * carries the shim audience, names another ServiceAccount, or comes from a namespace this
 * org does not own must not authenticate as that org's daemon.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { CP_TOKEN_AUDIENCE, ENVELOPE_DAEMON_SA_NAME } from '@agentconnect.md/protocol'
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

const SETTINGS = { orgId: ORG_ID, enabled: true, resourceName: RESOURCE } as ClusterExecutionSettings

/** A TokenReview response as the API server writes it; `undefined` fields are omitted. */
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

/** Records what it was asked to bind, so the binding arguments themselves are assertable. */
function daemons(record: Partial<DaemonRecord> | null = { id: DaemonId(DAEMON_ID) }) {
  const seen: string[] = []
  const adopt: (string | undefined)[] = []
  return {
    seen,
    adopt,
    resolveClusterIdentity: async (_orgId: OrgId, identity: string, opts?: { adoptDaemonId?: string }) => {
      seen.push(identity)
      adopt.push(opts?.adoptDaemonId)
      return record as DaemonRecord | null
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
      PREFIX
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
    expect(await svc.verify('token')).toEqual({ daemonId: DAEMON_ID, orgId: ORG_ID })
    // The binding key is exactly the subject the API server reported.
    expect(store.seen).toEqual([`system:serviceaccount:${NAMESPACE}:${ENVELOPE_DAEMON_SA_NAME}`])
    expect(store.adopt).toEqual([undefined])
  })

  it('offers the key path’s pinned daemon for adoption, so an existing envelope keeps it', async () => {
    const { svc, store } = await service({
      review: reviewed({
        audiences: [CP_TOKEN_AUDIENCE],
        username: clusterIdentityOf(NAMESPACE, ENVELOPE_DAEMON_SA_NAME)
      }),
      settings: { ...SETTINGS, credentialDaemonId: DAEMON_ID }
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
      PREFIX
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
})
