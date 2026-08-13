/**
 * Verifying an in-cluster daemon's projected ServiceAccount token. Every refusal answers
 * the same `null`, so these assert the checks individually — a token that is authentic but
 * carries the shim audience, names another ServiceAccount, or comes from a namespace this
 * org does not own must not authenticate as that org's daemon.
 *
 * The cloud cases assert the one asymmetry between the two shapes: a cloud daemon serves
 * every org and so may name the one it is connecting for, while an envelope daemon's
 * namespace already named it and a disagreeing claim is refused.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { CLOUD_DAEMON_SA_NAME, CP_TOKEN_AUDIENCE, ENVELOPE_DAEMON_SA_NAME } from '@agentconnect.md/protocol'
import { K8sHttp } from '@agentconnect.md/k8s-client'
import { closeFakeApiServers, fakeApiServer } from '@agentconnect.md/k8s-client/testing'
import {
  ClusterDaemonIdentityService,
  cloudIdentityOf,
  clusterIdentityOf,
  parseServiceAccountSubject
} from './daemon-identity.js'
import type { OrgResourceApi } from './org-api.js'
import type { ClusterExecutionSettings, DaemonRecord, OrgClusterExecutionRepo, OrgRepo } from '../persistence/ports.js'
import { DaemonId, OrgId } from '../domain/ids.js'

const PREFIX = 'ac-org-'
const RESOURCE = 'org-example'
const NAMESPACE = `${PREFIX}${RESOURCE}`
const ORG_ID = 'org_example'
const OTHER_ORG_ID = 'org_other'
const DAEMON_ID = '11111111-1111-4111-8111-111111111111'
/** Where this install runs its cloud daemons — the control namespace, as in production. */
const CLOUD_NAMESPACE = 'agentconnect'

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

/** Records what it was asked to bind, so the binding arguments themselves are assertable.
 *  `bound` is what an already-existing record answers to a daemonId lookup (the relay hop). */
function daemons(
  record: Partial<DaemonRecord> | null = { id: DaemonId(DAEMON_ID) },
  bound: Record<string, { orgId: string; clusterIdentity: string }> = {}
) {
  const seen: string[] = []
  const adopt: (string | undefined)[] = []
  return {
    seen,
    adopt,
    resolveClusterIdentity: async (_orgId: OrgId, identity: string, opts?: { adoptDaemonId?: string }) => {
      seen.push(identity)
      adopt.push(opts?.adoptDaemonId)
      return record as DaemonRecord | null
    },
    findClusterIdentity: async (daemonId: DaemonId) => bound[daemonId] ?? null
  }
}

/** Only `slugById` is read, and only as an existence check. */
function orgs(known: string[] = [ORG_ID]): Pick<OrgRepo, 'slugById'> {
  return { slugById: async (orgId: string) => (known.includes(orgId) ? 'example' : null) }
}

async function service(opts: {
  review: unknown
  settings?: ClusterExecutionSettings | null
  /** What the CR publishes on `status.namespace`; null ⇒ not published yet. */
  published?: string | null
  daemonStore?: ReturnType<typeof daemons>
  knownOrgs?: string[]
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
      orgs(opts.knownOrgs),
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
    expect(await svc.verify('token')).toEqual({ daemonId: DAEMON_ID, orgId: ORG_ID })
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
      orgs(),
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

  it('refuses an envelope daemon claiming an org other than its namespace’s', async () => {
    const { svc } = await service({
      review: reviewed({
        audiences: [CP_TOKEN_AUDIENCE],
        username: clusterIdentityOf(NAMESPACE, ENVELOPE_DAEMON_SA_NAME)
      })
    })
    expect(await svc.verify('token', { orgId: OTHER_ORG_ID })).toBeNull()
  })
})

describe('ClusterDaemonIdentityService — cloud daemon', () => {
  const cloudReview = (namespace = CLOUD_NAMESPACE) =>
    reviewed({ audiences: [CP_TOKEN_AUDIENCE], username: clusterIdentityOf(namespace, CLOUD_DAEMON_SA_NAME) })

  it('binds to the org the connection names, one record per org', async () => {
    const { svc, store } = await service({ review: cloudReview(), knownOrgs: [ORG_ID, OTHER_ORG_ID] })
    expect(await svc.verify('token', { orgId: ORG_ID })).toEqual({ daemonId: DAEMON_ID, orgId: ORG_ID })
    expect(await svc.verify('token', { orgId: OTHER_ORG_ID })).toEqual({ daemonId: DAEMON_ID, orgId: OTHER_ORG_ID })
    // Distinct identity strings: `Daemon.clusterIdentity` is unique, so two orgs served by one
    // principal must key two rows rather than fight over one.
    expect(store.seen).toEqual([
      cloudIdentityOf(CLOUD_NAMESPACE, CLOUD_DAEMON_SA_NAME, ORG_ID),
      cloudIdentityOf(CLOUD_NAMESPACE, CLOUD_DAEMON_SA_NAME, OTHER_ORG_ID)
    ])
    expect(store.adopt).toEqual([undefined, undefined])
  })

  it('refuses a cloud identity from any other namespace', async () => {
    const { svc } = await service({ review: cloudReview('kube-system') })
    expect(await svc.verify('token', { orgId: ORG_ID })).toBeNull()
  })

  it('refuses a connection that names no org', async () => {
    const { svc } = await service({ review: cloudReview() })
    expect(await svc.verify('token')).toBeNull()
  })

  it('refuses an org that does not exist', async () => {
    const { svc } = await service({ review: cloudReview() })
    expect(await svc.verify('token', { orgId: 'org_gone' })).toBeNull()
  })

  it('resolves the relay hop’s claimed daemonId back to its own org', async () => {
    const store = daemons(
      { id: DaemonId(DAEMON_ID) },
      {
        [DAEMON_ID]: {
          orgId: ORG_ID,
          clusterIdentity: cloudIdentityOf(CLOUD_NAMESPACE, CLOUD_DAEMON_SA_NAME, ORG_ID)
        }
      }
    )
    const { svc } = await service({ review: cloudReview(), daemonStore: store })
    expect(await svc.verify('token', { daemonId: DAEMON_ID })).toEqual({ daemonId: DAEMON_ID, orgId: ORG_ID })
  })

  it('refuses a claimed daemonId this identity does not own', async () => {
    // An envelope's record, claimed by a cloud token: same daemon table, different principal.
    const store = daemons(
      { id: DaemonId(DAEMON_ID) },
      {
        [DAEMON_ID]: { orgId: ORG_ID, clusterIdentity: clusterIdentityOf(NAMESPACE, ENVELOPE_DAEMON_SA_NAME) }
      }
    )
    const { svc } = await service({ review: cloudReview(), daemonStore: store })
    expect(await svc.verify('token', { daemonId: DAEMON_ID })).toBeNull()
  })

  it('refuses a claimed daemonId that is unknown or key-bound', async () => {
    const { svc } = await service({ review: cloudReview() })
    expect(await svc.verify('token', { daemonId: DAEMON_ID })).toBeNull()
  })

  it('refuses when the org’s record is not the daemonId the connection echoed', async () => {
    const { svc } = await service({ review: cloudReview() })
    expect(await svc.verify('token', { orgId: ORG_ID, daemonId: '22222222-2222-4222-8222-222222222222' })).toBeNull()
  })
})
