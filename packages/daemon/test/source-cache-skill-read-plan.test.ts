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
