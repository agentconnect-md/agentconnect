import { AgentSkillEntry } from '@agentconnect.md/protocol'
import { describe, expect, it } from 'vitest'
import { createSkillReadPlanner, type SourceCacheReadOutcome } from '../src/source-cache/read-plan.js'
import {
  anonRepoId,
  bundleKey,
  parseSourceCacheObjectKey,
  pointerKey,
  skillPointerKey,
  type SourceCacheClass
} from '../src/source-cache/keys.js'
import type { SkillRefPlan } from '../src/skills/skill-ref-resolution.js'
import { createSkillCachePlanner } from '../src/source-cache/skill-write-back.js'
import type { SourceCacheStagedWriteRequest, SourceCacheWriter } from '../src/source-cache/write-back.js'
import type { SourceCacheObjectRow } from '../src/store/local-store.js'

const ORG = 'org-1'
const BUNDLE_ID = '0b5c3f8e-8d0a-4c4e-9a1e-0123456789ab'
const COMMIT = 'a'.repeat(40)
const ANON = anonRepoId('https://github.com/acme/skills')

const entry = (extra: Record<string, unknown> = {}): AgentSkillEntry =>
  AgentSkillEntry.parse({ name: 'skills', source: 'acme/skills', githubRepoId: '42', skills: ['alpha'], ...extra })

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

function harness() {
  const rows = new Map<string, SourceCacheObjectRow>()
  const reads: string[] = []
  const signed: string[] = []
  const outcomes: SourceCacheReadOutcome[] = []
  const reader = createSkillReadPlanner({
    store: () => ({
      async getSourceCacheObject(orgId: string, key: string) {
        reads.push(key)
        const found = rows.get(key)
        return found?.orgId === orgId ? found : undefined
      },
      async touchSourceCacheRead() {
        return true
      }
    }),
    presigner: {
      async presignGet(key) {
        signed.push(key)
        return { method: 'GET', url: `https://cache.example/${key}?X-Amz-Signature=s`, headers: {}, expiresAt: 0 }
      }
    },
    orgForAgent: () => ORG,
    log: { debug: () => {}, warn: () => {} },
    onOutcome: (outcome) => outcomes.push(outcome)
  })
  // A committed pointer and its bundle under one class, repository and full ref.
  const seed = (repoClass: SourceCacheClass, repo: string, ref: string): string => {
    const latest = skillPointerKey({ org: ORG, class: repoClass, repo, ref })
    const bundle = bundleKey({ org: ORG, class: repoClass, repo, id: BUNDLE_ID })
    const pointer = row(latest, { targetKey: bundle })
    rows.set(latest, pointer)
    rows.set(bundle, row(bundle, { refHash: pointer.refHash }))
    return bundle
  }
  return { reader, reads, signed, outcomes, seed }
}

const resolved = (extra: Partial<Extract<SkillRefPlan, { ok: true }>> = {}): SkillRefPlan => ({
  ok: true,
  commit: COMMIT,
  ref: 'refs/heads/main',
  pinned: false,
  credentialed: false,
  ...extra
})

describe('skill read planner (source-cache.md §8)', () => {
  it('keys a skill pointer on its full branch or tag ref, blobless, beside the workspace layout', () => {
    expect(skillPointerKey({ org: ORG, class: 'anon', repo: ANON, ref: 'refs/heads/main' })).toBe(
      pointerKey({ org: ORG, class: 'anon', repo: ANON, ref: 'refs/heads/main', shape: 'blobless' })
    )
    expect(skillPointerKey({ org: ORG, class: 'cred', repo: 'github:42', ref: 'refs/tags/v1' })).toMatch(
      /^src\/org-1\/cred\/github:42\/refs\/[0-9a-f]{64}\/blobless\/latest$/
    )
    expect(() => skillPointerKey({ org: ORG, class: 'anon', repo: ANON, ref: 'main' })).toThrow()
    expect(() => skillPointerKey({ org: ORG, class: 'anon', repo: ANON, ref: 'refs/tags/../x' })).toThrow()
  })

  it('issues an anonymous Source a GET of its URL’s anon entry', async () => {
    const h = harness()
    const bundle = h.seed('anon', ANON, 'refs/heads/main')
    const url = await h.reader.getUrl({ agentId: 'a', entry: entry(), resolution: resolved() })
    expect(url).toBe(`https://cache.example/${bundle}?X-Amz-Signature=s`)
    expect(h.signed).toEqual([bundle])
  })

  it('issues a cred GET only after this agent’s own resolveRef succeeded', async () => {
    const h = harness()
    const bundle = h.seed('cred', 'github:42', 'refs/heads/main')
    const privateEntry = entry({ private: true })
    expect(await h.reader.getUrl({ agentId: 'a', entry: privateEntry, resolution: resolved() })).toBeUndefined()
    expect(await h.reader.getUrl({ agentId: 'a', entry: privateEntry, resolution: { ok: false } })).toBeUndefined()
    expect(h.signed).toEqual([])
    expect(h.outcomes.map((o) => o.kind === 'miss' && o.reason)).toEqual(['unauthorized', 'unauthorized'])
    const url = await h.reader.getUrl({
      agentId: 'a',
      entry: privateEntry,
      resolution: resolved({ credentialed: true })
    })
    expect(url).toContain(bundle)
  })

  it('never gives an anonymous declaration of a private URL the credentialed agent’s bundle', async () => {
    const h = harness()
    h.seed('cred', 'github:42', 'refs/heads/main')
    // The same repository declared without `private`, even with a resolution that came from a credential.
    const url = await h.reader.getUrl({ agentId: 'b', entry: entry(), resolution: resolved({ credentialed: true }) })
    expect(url).toBeUndefined()
    expect(h.reads.every((key) => key.includes('/anon/'))).toBe(true)
    expect(h.signed).toEqual([])
  })

  it('reads no pointer for a pinned SHA', async () => {
    const h = harness()
    h.seed('anon', ANON, 'refs/heads/main')
    const pinned = entry({ ref: COMMIT })
    const url = await h.reader.getUrl({
      agentId: 'a',
      entry: pinned,
      resolution: { ok: true, commit: COMMIT, pinned: true, credentialed: false }
    })
    expect(url).toBeUndefined()
    expect(h.reads).toEqual([])
  })

  it('keys a no-ref Source on the default branch its resolution named, and reads nothing without one', async () => {
    const h = harness()
    const bundle = h.seed('cred', 'github:42', 'refs/heads/trunk')
    const privateEntry = entry({ private: true })
    const url = await h.reader.getUrl({
      agentId: 'a',
      entry: privateEntry,
      resolution: resolved({ ref: 'refs/heads/trunk', credentialed: true })
    })
    expect(url).toContain(bundle)
    const unknown = { ok: true as const, commit: COMMIT, pinned: false, credentialed: false }
    expect(await h.reader.getUrl({ agentId: 'a', entry: entry(), resolution: unknown })).toBeUndefined()
    expect(h.reads).toHaveLength(2)
  })

  it('keys a tag Source on its tag', async () => {
    const h = harness()
    const bundle = h.seed('anon', ANON, 'refs/tags/v1')
    const tagged = entry({ ref: 'refs/tags/v1' })
    expect(
      await h.reader.getUrl({ agentId: 'a', entry: tagged, resolution: resolved({ ref: 'refs/tags/v1' }) })
    ).toContain(bundle)
  })
})

describe('skill write-back planning (source-cache.md §8, §9)', () => {
  const NOW = 1_700_000_000_000
  const DAY = 24 * 60 * 60_000
  function planner(options: { writer?: boolean } = {}) {
    const h = harness()
    const staged: SourceCacheStagedWriteRequest[] = []
    const writer: SourceCacheWriter = {
      consider: async () => ({ kind: 'skipped', reason: 'busy' }),
      considerStaged: async (request) => {
        staged.push(request)
        return { kind: 'written', trigger: request.trigger, bundleKey: 'k', bytes: request.staged.bytes }
      }
    }
    const plan = createSkillCachePlanner({
      reads: h.reader,
      ...(options.writer === false ? {} : { writer }),
      maxBytes: 4096,
      now: () => NOW
    })
    return { ...h, plan, staged }
  }
  const candidate = {
    sourceId: 'agent:0',
    branch: 'refs/heads/main',
    commit: COMMIT,
    handle: BUNDLE_ID,
    bytes: 100,
    sha256: Buffer.alloc(32, 1).toString('base64'),
    trigger: 'miss' as const
  }
  const stager = { upload: async () => ({ bytes: 100, sha256: '' }), discard: async () => {} }

  it('targets the Source’s own read key: anon for an anonymous Source, with no pointer yet', async () => {
    const p = planner()
    const plan = await p.plan({ agentId: 'a', entry: entry(), resolution: resolved() }, { writeBack: true })
    expect(plan.getUrl).toBeUndefined()
    expect(plan.writeBack).toMatchObject({ maxBytes: 4096, stale: false })
    await plan.writeBack!.write(candidate, stager)
    expect(p.staged).toHaveLength(1)
    expect(p.staged[0]).toMatchObject({
      target: {
        orgId: ORG,
        repoClass: 'anon',
        repoId: ANON,
        ref: 'refs/heads/main',
        shape: 'blobless',
        pointerKey: skillPointerKey({ org: ORG, class: 'anon', repo: ANON, ref: 'refs/heads/main' }),
        observedTargetKey: null
      },
      staged: { handle: BUNDLE_ID, bytes: 100, branch: 'refs/heads/main' },
      trigger: 'miss',
      credentialed: false
    })
  })

  it('targets cred only after this agent’s credentialed resolveRef, and the clone counts as credentialed', async () => {
    const p = planner()
    const privateEntry = entry({ private: true })
    const refused = await p.plan({ agentId: 'a', entry: privateEntry, resolution: resolved() }, { writeBack: true })
    expect(refused.writeBack).toBeUndefined()
    const plan = await p.plan(
      { agentId: 'a', entry: privateEntry, resolution: resolved({ credentialed: true }) },
      { writeBack: true }
    )
    await plan.writeBack!.write(candidate, stager)
    expect(p.staged[0]).toMatchObject({ target: { repoClass: 'cred', repoId: 'github:42' }, credentialed: true })
  })

  it('targets the URL’s anon entry for an anonymous declaration of a private URL, never cred', async () => {
    const p = planner()
    const plan = await p.plan(
      { agentId: 'b', entry: entry(), resolution: resolved({ credentialed: true }) },
      { writeBack: true }
    )
    await plan.writeBack!.write(candidate, stager)
    expect(p.staged[0]).toMatchObject({ target: { repoClass: 'anon', repoId: ANON }, credentialed: false })
  })

  it('marks a hit on a bundle past the write-back age stale, and a fresh one not', async () => {
    const p = planner()
    const bundle = p.seed('anon', ANON, 'refs/heads/main')
    const plan = await p.plan({ agentId: 'a', entry: entry(), resolution: resolved() }, { writeBack: true })
    expect(plan.getUrl).toContain(bundle)
    // The seeded bundle row was written at epoch 1, long before NOW.
    expect(plan.writeBack).toMatchObject({ stale: true })
    const fresh = createSkillCachePlanner({
      reads: p.reader,
      writer: {} as SourceCacheWriter,
      maxBytes: 1,
      now: () => 1 + DAY
    })
    expect(
      (await fresh({ agentId: 'a', entry: entry(), resolution: resolved() }, { writeBack: true })).writeBack
    ).toMatchObject({
      stale: false
    })
  })

  it('asks for nothing for a tag, a pinned SHA, a ref-less anonymous Source, without a writer, or when not allowed', async () => {
    const p = planner()
    const ask = (request: Parameters<typeof p.plan>[0], writeBack = true) => p.plan(request, { writeBack })
    const tagged = await ask({
      agentId: 'a',
      entry: entry({ ref: 'refs/tags/v1' }),
      resolution: resolved({ ref: 'refs/tags/v1' })
    })
    const pinned = await ask({
      agentId: 'a',
      entry: entry({ ref: COMMIT }),
      resolution: { ok: true, commit: COMMIT, pinned: true, credentialed: false }
    })
    const refless = await ask({
      agentId: 'a',
      entry: entry(),
      resolution: { ok: true, commit: COMMIT, pinned: false, credentialed: false }
    })
    const disallowed = await ask({ agentId: 'a', entry: entry(), resolution: resolved() }, false)
    const noWriter = await planner({ writer: false }).plan(
      { agentId: 'a', entry: entry(), resolution: resolved() },
      { writeBack: true }
    )
    for (const plan of [tagged, pinned, refless, disallowed, noWriter]) expect(plan.writeBack).toBeUndefined()
  })
})
