import { describe, expect, it } from 'vitest'
import { AgentSchema, type Agent } from '../src/agents/agent-schema.js'
import type { CredentialedCacheReadDecision } from '../src/source-cache/authorize-read.js'
import {
  createSourceCacheReadPlanner,
  type SourceCacheReadOutcome,
  type WorkspaceBundleRequest
} from '../src/source-cache/index.js'
import {
  anonRepoId,
  bundleKey,
  parseSourceCacheObjectKey,
  pointerKey,
  type SourceCacheClass,
  type SourceCacheShape
} from '../src/source-cache/keys.js'
import type { SourceCacheObjectRow } from '../src/store/local-store.js'

const ORG = 'org-1'
const URL_HTTPS = 'https://github.com/acme/widgets.git'
const BUNDLE_ID = '0b5c3f8e-8d0a-4c4e-9a1e-0123456789ab'
const OTHER_ID = '1b5c3f8e-8d0a-4c4e-9a1e-0123456789ab'
const NOW = 1_700_000_000_000

function agent(workspace: Record<string, unknown> = {}): Agent {
  return AgentSchema.parse({
    id: 'agent-1',
    name: 'agent-1',
    status: 'active',
    runtime: 'claude',
    workspace: { path: '/tmp/ws', mode: 'git-repo', gitRepo: URL_HTTPS, gitBranch: 'main', ...workspace },
    integrations: [],
    output: { mode: 'low' }
  })
}

function row(key: string, extra: Partial<SourceCacheObjectRow> = {}): SourceCacheObjectRow {
  const parsed = parseSourceCacheObjectKey(key)!
  const pointer = parsed.kind === 'pointer'
  return {
    orgId: parsed.orgId,
    key,
    kind: parsed.kind,
    state: 'committed',
    bytes: pointer ? 0 : 1024,
    repoClass: parsed.repoClass,
    repoId: parsed.repoId,
    refHash: pointer ? parsed.refHash : '',
    shape: pointer ? parsed.shape : 'blobless',
    createdAt: 1,
    updatedAt: 1,
    expiresAt: null,
    lastReadAt: null,
    targetKey: null,
    unpointedAt: null,
    claimedBy: null,
    claimedAt: null,
    ...extra
  }
}

interface Seed {
  repoClass: SourceCacheClass
  repo: string
  shape?: SourceCacheShape
  branch?: string
}

function harness(
  opts: {
    decision?: CredentialedCacheReadDecision | Error
    org?: string | undefined
    presignUrl?: string
    presignError?: Error
    storeError?: Error
    touchError?: Error
  } = {}
) {
  const rows = new Map<string, SourceCacheObjectRow>()
  const reads: string[] = []
  const touches: Array<{ orgId: string; key: string; at: number }> = []
  const signed: string[] = []
  const authorized: Agent[] = []
  const outcomes: SourceCacheReadOutcome[] = []
  const warnings: string[] = []
  const store = {
    async getSourceCacheObject(orgId: string, key: string) {
      reads.push(key)
      if (opts.storeError) throw opts.storeError
      const found = rows.get(key)
      return found?.orgId === orgId ? found : undefined
    },
    async touchSourceCacheRead(input: { orgId: string; key: string; at: number }) {
      touches.push(input)
      if (opts.touchError) throw opts.touchError
      return true
    }
  }
  const planner = createSourceCacheReadPlanner({
    store: () => store,
    presigner: {
      async presignGet(key) {
        signed.push(key)
        if (opts.presignError) throw opts.presignError
        return {
          method: 'GET',
          url: opts.presignUrl ?? `https://cache.example/${key}?X-Amz-Signature=s`,
          headers: {},
          expiresAt: 0
        }
      }
    },
    authorize: async (a) => {
      authorized.push(a)
      const decision = opts.decision ?? { ok: false, reason: 'anonymous', detail: 'no_credential' }
      if (decision instanceof Error) throw decision
      return decision
    },
    orgForAgent: () => ('org' in opts ? opts.org : ORG),
    now: () => NOW,
    log: { debug: () => {}, warn: (m) => warnings.push(m) },
    onOutcome: (o) => outcomes.push(o)
  })
  /** A committed pointer naming a committed bundle of the same repository, ref and shape. */
  const seed = (
    s: Seed,
    pointerExtra: Partial<SourceCacheObjectRow> = {},
    bundleExtra: Partial<SourceCacheObjectRow> = {}
  ) => {
    const shape = s.shape ?? 'blobless'
    const latest = pointerKey({
      org: ORG,
      class: s.repoClass,
      repo: s.repo,
      ref: `refs/heads/${s.branch ?? 'main'}`,
      shape
    })
    const target = bundleKey({ org: ORG, class: s.repoClass, repo: s.repo, id: BUNDLE_ID })
    const pointer = row(latest, { targetKey: target, ...pointerExtra })
    rows.set(latest, pointer)
    rows.set(target, row(target, { shape, refHash: pointer.refHash, ...bundleExtra }))
    return { latest, target }
  }
  return { planner, rows, reads, touches, signed, authorized, outcomes, warnings, seed }
}

const request = (a: Agent, shape: SourceCacheShape = 'blobless', cloneUrl = URL_HTTPS): WorkspaceBundleRequest => ({
  agent: a,
  cloneUrl,
  branch: 'main',
  shape
})

const githubDecision: CredentialedCacheReadDecision = {
  ok: true,
  repository: { provider: 'github', externalId: '42' },
  credRepoId: 'github:42',
  ref: 'refs/heads/main',
  commit: 'e'.repeat(40),
  checkedAt: 1
}

describe('the Source Cache workspace read planner', () => {
  it('plans an anonymous workspace in the anon class by its canonical URL, without asking the authorizer', async () => {
    const h = harness()
    const { latest, target } = h.seed({ repoClass: 'anon', repo: anonRepoId(URL_HTTPS) })

    const plan = await h.planner.plan(request(agent()))

    expect(plan).toMatchObject({ bundleKey: target, pointerKey: latest, repoClass: 'anon', shape: 'blobless' })
    expect(plan!.url.startsWith('https://')).toBe(true)
    expect(h.authorized).toEqual([])
    expect(h.signed).toEqual([target])
    // One GET issuance stamps both rows at the planner's clock.
    expect(h.touches).toEqual([
      { orgId: ORG, key: latest, at: NOW },
      { orgId: ORG, key: target, at: NOW }
    ])
  })

  it('keys SSH and HTTPS spellings of one repository to the same pointer', async () => {
    const h = harness()
    h.seed({ repoClass: 'anon', repo: anonRepoId(URL_HTTPS) })
    const viaSsh = await h.planner.plan(request(agent(), 'blobless', 'git@github.com:acme/widgets.git'))
    expect(viaSsh?.bundleKey).toBeDefined()
  })

  it('plans a credentialed workspace in the cred class only after the authorizer succeeds', async () => {
    const h = harness({ decision: githubDecision })
    const { target } = h.seed({ repoClass: 'cred', repo: 'github:42', shape: 'full' })
    const a = agent({ gitCredential: 'github-app' })

    const plan = await h.planner.plan(request(a, 'full'))

    expect(h.authorized).toEqual([a])
    expect(plan).toMatchObject({ bundleKey: target, repoClass: 'cred', shape: 'full' })
  })

  it.each<[string, CredentialedCacheReadDecision | Error]>([
    ['anonymous', { ok: false, reason: 'anonymous', detail: 'no_credential' }],
    ['access_denied', { ok: false, reason: 'access_denied', detail: 'credential_denied_x' }],
    ['replaced', { ok: false, reason: 'replaced', detail: 'id_mismatch' }],
    ['unavailable', { ok: false, reason: 'unavailable', detail: 'identity_unknown' }],
    ['a throw', new Error('boom')],
    ['another ref', { ...githubDecision, ref: 'refs/heads/dev' }]
  ])('uses no cache when a credentialed read is refused (%s)', async (_label, decision) => {
    const h = harness({ decision })
    h.seed({ repoClass: 'cred', repo: 'github:42' })

    expect(await h.planner.plan(request(agent({ gitCredential: 'github-app' })))).toBeUndefined()
    expect(h.reads).toEqual([])
    expect(h.signed).toEqual([])
    expect(h.outcomes).toMatchObject([{ kind: 'miss' }])
  })

  it('never reads the anon entry for a credentialed workspace', async () => {
    const h = harness({ decision: { ok: false, reason: 'access_denied', detail: 'x' } })
    h.seed({ repoClass: 'anon', repo: anonRepoId(URL_HTTPS) })
    expect(await h.planner.plan(request(agent({ gitCredential: 'github-app' })))).toBeUndefined()
    expect(h.reads).toEqual([])
  })

  it('misses with no pointer, and signs and stamps nothing', async () => {
    const h = harness()
    expect(await h.planner.plan(request(agent()))).toBeUndefined()
    expect(h.signed).toEqual([])
    expect(h.touches).toEqual([])
    expect(h.outcomes).toMatchObject([{ kind: 'miss', reason: 'no-pointer' }])
  })

  it.each<[string, Partial<SourceCacheObjectRow>, Partial<SourceCacheObjectRow>]>([
    ['a pending bundle', {}, { state: 'pending' }],
    ['a claimed bundle', {}, { claimedBy: 'member-2' }],
    ['a bundle of the other shape', {}, { shape: 'full' }],
    ['a bundle of another repository', {}, { repoId: 'f'.repeat(64) }],
    ['a bundle of another class', {}, { repoClass: 'cred' }],
    ['a bundle of another ref', {}, { refHash: '0'.repeat(64) }],
    ['a claimed pointer', { claimedBy: 'member-2' }, {}],
    ['a pending pointer', { state: 'pending' }, {}],
    ['a pointer naming nothing', { targetKey: null }, {}]
  ])('misses on %s', async (_label, pointerExtra, bundleExtra) => {
    const h = harness()
    h.seed({ repoClass: 'anon', repo: anonRepoId(URL_HTTPS) }, pointerExtra, bundleExtra)
    expect(await h.planner.plan(request(agent()))).toBeUndefined()
    expect(h.signed).toEqual([])
    expect(h.touches).toEqual([])
  })

  it('misses when the bundle row is missing or the pointer names another repository', async () => {
    const h = harness()
    const { target } = h.seed({ repoClass: 'anon', repo: anonRepoId(URL_HTTPS) })
    h.rows.delete(target)
    expect(await h.planner.plan(request(agent()))).toBeUndefined()

    const other = harness()
    const { latest } = other.seed({ repoClass: 'anon', repo: anonRepoId(URL_HTTPS) })
    const foreign = bundleKey({ org: ORG, class: 'anon', repo: 'a'.repeat(64), id: OTHER_ID })
    other.rows.set(latest, { ...other.rows.get(latest)!, targetKey: foreign })
    other.rows.set(foreign, row(foreign, { refHash: other.rows.get(latest)!.refHash }))
    expect(await other.planner.plan(request(agent()))).toBeUndefined()
    expect(other.signed).toEqual([])
  })

  it('reads the pointer of the shape asked for', async () => {
    const h = harness()
    h.seed({ repoClass: 'anon', repo: anonRepoId(URL_HTTPS), shape: 'full' })
    expect(await h.planner.plan(request(agent(), 'blobless'))).toBeUndefined()
    expect(await h.planner.plan(request(agent(), 'full'))).toMatchObject({ shape: 'full' })
  })

  it('misses on a store error, and on a signer error without stamping a read', async () => {
    const broken = harness({ storeError: new Error('db down') })
    expect(await broken.planner.plan(request(agent()))).toBeUndefined()
    expect(broken.outcomes).toMatchObject([{ kind: 'miss', reason: 'error' }])

    const unsigned = harness({ presignError: new Error('no credentials') })
    unsigned.seed({ repoClass: 'anon', repo: anonRepoId(URL_HTTPS) })
    expect(await unsigned.planner.plan(request(agent()))).toBeUndefined()
    expect(unsigned.touches).toEqual([])
    expect(unsigned.warnings.join('\n')).toContain('no credentials')
  })

  it('refuses a URL that is not https, which the pod policy would refuse anyway', async () => {
    const h = harness({ presignUrl: 'http://cache.example/x' })
    h.seed({ repoClass: 'anon', repo: anonRepoId(URL_HTTPS) })
    expect(await h.planner.plan(request(agent()))).toBeUndefined()
    expect(h.touches).toEqual([])
  })

  it('keeps the URL when stamping the read fails', async () => {
    const h = harness({ touchError: new Error('write refused') })
    h.seed({ repoClass: 'anon', repo: anonRepoId(URL_HTTPS) })
    expect(await h.planner.plan(request(agent()))).toBeDefined()
    expect(h.warnings.join('\n')).toContain('write refused')
  })

  it('misses with no org for the agent, an unknown credential, or an unkeyable URL', async () => {
    expect(await harness({ org: undefined }).planner.plan(request(agent()))).toBeUndefined()
    const odd = agent()
    ;(odd.workspace as { gitCredential?: string }).gitCredential = 'mystery'
    const h = harness()
    expect(await h.planner.plan(request(odd))).toBeUndefined()
    expect(h.authorized).toEqual([])
    expect(await harness().planner.plan(request(agent(), 'blobless', '/srv/repo'))).toBeUndefined()
  })

  it('logs a fallback with its bundle key and reason, never the URL', () => {
    const h = harness()
    h.planner.record({ kind: 'fallback', bundleKey: 'k', shape: 'full', reason: 'download-warning', detail: 'd' })
    expect(h.warnings).toEqual([expect.stringContaining('bundle=k shape=full reason=download-warning')])
    expect(h.outcomes).toMatchObject([{ kind: 'fallback', reason: 'download-warning' }])
  })
})
