import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ClusterSkillCoordinator,
  clusterSkillSupportRequired,
  type ClusterSkillJournalStore
} from '../src/skills/cluster-skill-coordinator.js'
import { ClusterSkillClient } from '../src/shim/skill-client.js'
import { GIT_SKILL_SOURCE_SNAPSHOT_LIMITS } from '../src/skills/skill-source-snapshot.js'

describe('cluster skill coordinator', () => {
  it.each([0, 1])(
    'uses a legacy receipt only before the first sandbox ledger commit (revision %i)',
    async (revision) => {
      const legacy = {
        path: '.agents/skills/old',
        sourceId: 'legacy:old',
        sourceKind: 'agent' as const,
        digest: createHash('sha256').update(JSON.stringify([])).digest('hex'),
        files: []
      }
      const store: ClusterSkillJournalStore = {
        beginClusterSkillReconcile: async () => ({
          ok: true,
          operationId: '11111111-1111-4111-8111-111111111111',
          replayKey: 'a'.repeat(64),
          priorRevision: revision,
          priorLedger: { roots: [] },
          resumed: false
        }),
        authorizeClusterSkillMutation: async () => true,
        commitClusterSkillReconcile: async () => ({ ok: true, revision: revision + 1 })
      }
      let priorRoots: unknown
      const client = new ClusterSkillClient({
        request: async (_capability, payload) => {
          const request = payload as { op: string; priorRoots?: unknown }
          if (request.op === 'begin') return { handle: 'opaque-handle-1234' }
          priorRoots = request.priorRoots
          return { roots: [], conflicts: [] }
        }
      })
      await new ClusterSkillCoordinator(store).reconcile({
        authority: { groupId: 'g', term: '1', daemonId: 'd', agentId: 'a', workspaceIncarnation: 'claim' },
        skillsAgentId: 'codex',
        shimGeneration: 1,
        sources: [],
        client,
        initialLedger: { roots: [legacy] }
      })
      expect(priorRoots).toEqual(revision === 0 ? [legacy] : [])
    }
  )

  it('requires a capable image for accepted Dream state and durable cleanup, but not an empty agent', () => {
    expect(
      clusterSkillSupportRequired({ configuredSources: 0, managedBindings: 0, acceptedDreamSources: 0, priorRoots: 0 })
    ).toBe(false)
    expect(
      clusterSkillSupportRequired({ configuredSources: 0, managedBindings: 0, acceptedDreamSources: 1, priorRoots: 0 })
    ).toBe(true)
    expect(
      clusterSkillSupportRequired({ configuredSources: 0, managedBindings: 0, acceptedDreamSources: 0, priorRoots: 1 })
    ).toBe(true)
  })
  it('journals, uploads all source kinds, and commits the strict receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-cluster-coordinator-'))
    const sources = await Promise.all(
      ['agent', 'managed', 'dream'].map(async (kind) => {
        const sourceDir = join(root, kind)
        await mkdir(sourceDir)
        await writeFile(join(sourceDir, 'SKILL.md'), `---\nname: ${kind}\ndescription: fixture\n---\n# ${kind}\n`)
        await writeFile(join(sourceDir, 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
        return {
          sourceId: `${kind === 'agent' ? 'z' : kind === 'managed' ? 'm' : 'a'}:${kind}`,
          sourceKind: kind as 'agent' | 'managed' | 'dream',
          sourceDir,
          selections: [kind === 'agent' ? 'Agent Display Name' : kind],
          expectedLeaves: [kind]
        }
      })
    )
    const events: string[] = []
    let reconciledSourceIds: string[] = []
    const store: ClusterSkillJournalStore = {
      async beginClusterSkillReconcile() {
        events.push('begin-journal')
        return {
          ok: true,
          operationId: '11111111-1111-4111-8111-111111111111',
          replayKey: 'a'.repeat(64),
          priorRevision: 0,
          priorLedger: { roots: [] },
          resumed: false
        }
      },
      async commitClusterSkillReconcile(input) {
        events.push(`commit:${input.ledger.roots.length}`)
        return { ok: true, revision: 1 }
      },
      async authorizeClusterSkillMutation() {
        events.push('authorize')
        return true
      }
    }
    const requester = {
      async request(_capability: unknown, payload: unknown) {
        const request = payload as Record<string, unknown>
        events.push(String(request.op))
        if (request.op === 'begin') {
          const files = request.files as Array<{ path: string; executable?: boolean }>
          if (process.platform !== 'win32') {
            expect(files.filter((file) => file.path === 'run.sh').every((file) => file.executable)).toBe(true)
            expect(files.filter((file) => file.path === 'SKILL.md').every((file) => !file.executable)).toBe(true)
          }
          return { handle: 'opaque-handle-1234' }
        }
        if (request.op === 'upload') {
          const data = Buffer.from(String(request.data), 'base64')
          return { received: Number(request.offset) + data.length, complete: request.final }
        }
        reconciledSourceIds = (request.sources as Array<{ sourceId: string }>).map((source) => source.sourceId)
        return {
          roots: sources.map((source) => ({
            path: `.agents/skills/${source.sourceKind}`,
            sourceId: source.sourceId,
            sourceKind: source.sourceKind,
            digest: createHash('sha256').update(JSON.stringify([])).digest('hex'),
            files: []
          })),
          conflicts: []
        }
      }
    }
    const coordinator = new ClusterSkillCoordinator(store)
    const ledger = await coordinator.reconcile({
      authority: { groupId: 'g', term: '1', daemonId: 'd', agentId: 'a', workspaceIncarnation: 'claim' },
      skillsAgentId: 'codex',
      shimGeneration: 7,
      sources,
      client: new ClusterSkillClient(requester, true, true)
    })
    expect(ledger.roots).toHaveLength(3)
    expect(events[0]).toBe('begin-journal')
    expect(events.at(-1)).toBe('commit:3')
    expect(reconciledSourceIds).toEqual(sources.map((source) => source.sourceId))
  })

  it('a source the shim skipped does not fail the run: it is reported, unresolved, and the rest commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-cluster-coordinator-skip-'))
    const commit = 'f'.repeat(40)
    const make = async (kind: 'agent' | 'managed', sourceId: string) => {
      const sourceDir = join(root, kind)
      await mkdir(sourceDir)
      await writeFile(join(sourceDir, 'SKILL.md'), `---\nname: ${kind}\ndescription: fixture\n---\n# ${kind}\n`)
      return { sourceId, sourceKind: kind, sourceDir, selections: [kind], expectedLeaves: [kind] }
    }
    const sources = [await make('agent', `agent:0:abc123:${commit}`), await make('managed', 'm:managed')]
    // The agent source was installed before at an earlier commit; the shim preserves that root
    // when it skips the new revision, and the coordinator must admit it under its OLD id.
    const previous = {
      path: '.agents/skills/agent',
      sourceId: `agent:0:abc123:${'e'.repeat(40)}`,
      sourceKind: 'agent' as const,
      digest: createHash('sha256').update(JSON.stringify([])).digest('hex'),
      files: []
    }
    const commits: number[] = []
    let committedResolutions: unknown
    const store: ClusterSkillJournalStore = {
      async beginClusterSkillReconcile() {
        return {
          ok: true,
          operationId: '11111111-1111-4111-8111-111111111111',
          replayKey: 'a'.repeat(64),
          priorRevision: 1,
          priorLedger: { roots: [previous] },
          resumed: false
        }
      },
      async commitClusterSkillReconcile(input) {
        commits.push(input.ledger.roots.length)
        committedResolutions = input.ledger.gitResolutions
        return { ok: true, revision: 1 }
      },
      async authorizeClusterSkillMutation() {
        return true
      }
    }
    const requester = {
      async request(_capability: unknown, payload: unknown) {
        const request = payload as Record<string, unknown>
        if (request.op === 'begin') return { handle: 'opaque-handle-1234' }
        if (request.op === 'upload') {
          const data = Buffer.from(String(request.data), 'base64')
          return { received: Number(request.offset) + data.length, complete: request.final }
        }
        // The shim built `managed` and refused `agent` (an oversized asset); its expected leaf is
        // therefore absent from the receipt, which is only acceptable BECAUSE it is named as skipped.
        return {
          roots: [
            previous,
            {
              path: '.agents/skills/managed',
              sourceId: 'm:managed',
              sourceKind: 'managed',
              digest: createHash('sha256').update(JSON.stringify([])).digest('hex'),
              files: []
            }
          ],
          conflicts: [],
          skipped: [{ sourceId: sources[0]!.sourceId, reason: 'skills CLI bundle "agent" contains an oversized file' }]
        }
      }
    }
    const ledger = await new ClusterSkillCoordinator(store).reconcile({
      authority: { groupId: 'g', term: '1', daemonId: 'd', agentId: 'a', workspaceIncarnation: 'claim' },
      skillsAgentId: 'codex',
      shimGeneration: 7,
      sources,
      gitResolutions: [{ definitionDigest: 'abc123', resolvedCommit: commit }],
      client: new ClusterSkillClient(requester, true, true)
    })
    expect(ledger.roots.map((r) => r.sourceId)).toEqual([previous.sourceId, 'm:managed'])
    expect(ledger.skipped).toEqual([{ sourceId: sources[0]!.sourceId, reason: expect.stringContaining('oversized') }])
    expect(commits).toEqual([2])
    // The skipped Git source keeps no resolution, so the next preparation acquires and retries it.
    expect(committedResolutions).toEqual([])
    await rm(root, { recursive: true, force: true })
  })

  it('still refuses a root under an unknown id when it was not in the prior ledger', async () => {
    const store: ClusterSkillJournalStore = {
      async beginClusterSkillReconcile() {
        return {
          ok: true,
          operationId: '11111111-1111-4111-8111-111111111111',
          replayKey: 'a'.repeat(64),
          priorRevision: 0,
          priorLedger: { roots: [] },
          resumed: false
        }
      },
      async commitClusterSkillReconcile() {
        return { ok: true, revision: 1 }
      },
      async authorizeClusterSkillMutation() {
        return true
      }
    }
    const root = await mkdtemp(join(tmpdir(), 'ac-cluster-coordinator-stranger-'))
    const sourceDir = join(root, 'managed')
    await mkdir(sourceDir)
    await writeFile(join(sourceDir, 'SKILL.md'), '---\nname: managed\ndescription: fixture\n---\n# m\n')
    const requester = {
      async request(_capability: unknown, payload: unknown) {
        const request = payload as Record<string, unknown>
        if (request.op === 'begin') return { handle: 'opaque-handle-1234' }
        if (request.op === 'upload') {
          const data = Buffer.from(String(request.data), 'base64')
          return { received: Number(request.offset) + data.length, complete: request.final }
        }
        return {
          roots: [
            {
              path: '.agents/skills/stranger',
              sourceId: 'agent:9:zzz:' + 'e'.repeat(40),
              sourceKind: 'agent',
              digest: createHash('sha256').update(JSON.stringify([])).digest('hex'),
              files: []
            }
          ],
          conflicts: [],
          skipped: [{ sourceId: 'm:managed', reason: 'oversized' }]
        }
      }
    }
    await expect(
      new ClusterSkillCoordinator(store).reconcile({
        authority: { groupId: 'g', term: '1', daemonId: 'd', agentId: 'a', workspaceIncarnation: 'claim' },
        skillsAgentId: 'codex',
        shimGeneration: 7,
        sources: [
          {
            sourceId: 'm:managed',
            sourceKind: 'managed',
            sourceDir,
            selections: ['managed'],
            expectedLeaves: ['managed']
          }
        ],
        client: new ClusterSkillClient(requester, true, true)
      })
    ).rejects.toThrow(/unexpected source receipt/)
    await rm(root, { recursive: true, force: true })
  })

  it('refuses a skipped source the run never asked for', async () => {
    const store: ClusterSkillJournalStore = {
      async beginClusterSkillReconcile() {
        return {
          ok: true,
          operationId: '11111111-1111-4111-8111-111111111111',
          replayKey: 'a'.repeat(64),
          priorRevision: 0,
          priorLedger: { roots: [] },
          resumed: false
        }
      },
      async commitClusterSkillReconcile() {
        return { ok: true, revision: 1 }
      },
      async authorizeClusterSkillMutation() {
        return true
      }
    }
    const requester = {
      async request(_capability: unknown, payload: unknown) {
        const request = payload as Record<string, unknown>
        if (request.op === 'begin') return { handle: 'opaque-handle-1234' }
        return { roots: [], conflicts: [], skipped: [{ sourceId: 'm:stranger', reason: 'oversized' }] }
      }
    }
    await expect(
      new ClusterSkillCoordinator(store).reconcile({
        authority: { groupId: 'g', term: '1', daemonId: 'd', agentId: 'a', workspaceIncarnation: 'claim' },
        skillsAgentId: 'codex',
        shimGeneration: 7,
        sources: [],
        client: new ClusterSkillClient(requester, true, true)
      })
    ).rejects.toThrow(/skipped an unexpected source/)
  })

  it('uploads a whole Git collection, which the single-bundle default profile would truncate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-cluster-collection-'))
    const sourceDir = join(root, 'collection')
    await mkdir(join(sourceDir, 'skills', 'brainstorming'), { recursive: true })
    await writeFile(
      join(sourceDir, 'skills', 'brainstorming', 'SKILL.md'),
      '---\nname: brainstorming\ndescription: fixture\n---\n# brainstorming\n'
    )
    // Over DEFAULT_SKILL_SOURCE_SNAPSHOT_LIMITS.maxFiles (64), as a real collection repo is.
    await mkdir(join(sourceDir, 'docs'))
    for (let index = 0; index < 128; index += 1) {
      await writeFile(join(sourceDir, 'docs', `note-${index}.md`), `note ${index}\n`)
    }
    const store: ClusterSkillJournalStore = {
      beginClusterSkillReconcile: async () => ({
        ok: true,
        operationId: '11111111-1111-4111-8111-111111111111',
        replayKey: 'a'.repeat(64),
        priorRevision: 0,
        priorLedger: { roots: [] },
        resumed: false
      }),
      authorizeClusterSkillMutation: async () => true,
      commitClusterSkillReconcile: async () => ({ ok: true, revision: 1 })
    }
    let manifest: Array<{ path: string }> = []
    const client = new ClusterSkillClient({
      async request(_capability, payload) {
        const request = payload as Record<string, unknown>
        if (request.op === 'begin') {
          manifest = request.files as Array<{ path: string }>
          return { handle: 'opaque-handle-1234' }
        }
        if (request.op === 'upload') {
          const data = Buffer.from(String(request.data), 'base64')
          return { received: Number(request.offset) + data.length, complete: request.final }
        }
        return {
          roots: [
            {
              path: '.agents/skills/brainstorming',
              sourceId: 'agent:0',
              sourceKind: 'agent',
              digest: createHash('sha256').update(JSON.stringify([])).digest('hex'),
              files: []
            }
          ],
          conflicts: []
        }
      }
    })
    const ledger = await new ClusterSkillCoordinator(store).reconcile({
      authority: { groupId: 'g', term: '1', daemonId: 'd', agentId: 'a', workspaceIncarnation: 'claim' },
      skillsAgentId: 'universal',
      shimGeneration: 1,
      sources: [
        {
          sourceId: 'agent:0',
          sourceKind: 'agent',
          sourceDir,
          selections: ['brainstorming'],
          expectedLeaves: ['brainstorming'],
          limits: GIT_SKILL_SOURCE_SNAPSHOT_LIMITS
        }
      ],
      client
    })
    expect(manifest).toHaveLength(129)
    expect(manifest.map((file) => file.path)).toContain('skills/brainstorming/SKILL.md')
    expect(ledger.roots).toHaveLength(1)

    // The same source on the default profile is what shipped an empty set instead.
    await expect(
      new ClusterSkillCoordinator(store).reconcile({
        authority: { groupId: 'g', term: '1', daemonId: 'd', agentId: 'a', workspaceIncarnation: 'claim' },
        skillsAgentId: 'universal',
        shimGeneration: 1,
        sources: [
          { sourceId: 'agent:0', sourceKind: 'agent', sourceDir, selections: ['brainstorming'], expectedLeaves: [] }
        ],
        client
      })
    ).rejects.toThrow(/too many files/)
  })

  it('fails closed when duty is lost before publication', async () => {
    const store = {
      beginClusterSkillReconcile: async () => ({ ok: false as const, reason: 'lost_authority' as const }),
      commitClusterSkillReconcile: async () => ({ ok: false as const, reason: 'lost_authority' as const }),
      authorizeClusterSkillMutation: async () => false
    }
    await expect(
      new ClusterSkillCoordinator(store).reconcile({
        authority: { groupId: 'g', term: '1', daemonId: 'd', agentId: 'a', workspaceIncarnation: 'claim' },
        skillsAgentId: 'codex',
        shimGeneration: 7,
        sources: [],
        client: new ClusterSkillClient({ request: async () => ({}) })
      })
    ).rejects.toThrow(/lost duty authority/)
  })

  it('does not ask the shim to mutate after the pre-publication fence is lost', async () => {
    const calls: string[] = []
    const store: ClusterSkillJournalStore = {
      beginClusterSkillReconcile: async () => ({
        ok: true,
        operationId: '11111111-1111-4111-8111-111111111111',
        replayKey: 'a'.repeat(64),
        priorRevision: 0,
        priorLedger: { roots: [] },
        resumed: false
      }),
      authorizeClusterSkillMutation: async () => false,
      commitClusterSkillReconcile: async () => ({ ok: false, reason: 'lost_authority' })
    }
    const client = new ClusterSkillClient({
      request: async (_capability, payload) => {
        calls.push((payload as { op: string }).op)
        return { handle: 'opaque-handle-1234' }
      }
    })
    await expect(
      new ClusterSkillCoordinator(store).reconcile({
        authority: { groupId: 'g', term: '1', daemonId: 'd', agentId: 'a', workspaceIncarnation: 'claim' },
        skillsAgentId: 'codex',
        shimGeneration: 1,
        sources: [],
        client
      })
    ).rejects.toThrow(/lost duty authority/)
    expect(calls).toEqual(['begin'])
  })

  it('rejects a post-response result when the durable commit fence is lost', async () => {
    const calls: string[] = []
    const store: ClusterSkillJournalStore = {
      beginClusterSkillReconcile: async () => ({
        ok: true,
        operationId: '11111111-1111-4111-8111-111111111111',
        replayKey: 'a'.repeat(64),
        priorRevision: 0,
        priorLedger: { roots: [] },
        resumed: true
      }),
      authorizeClusterSkillMutation: async () => true,
      commitClusterSkillReconcile: async () => ({ ok: false, reason: 'lost_authority' })
    }
    const client = new ClusterSkillClient({
      request: async (_capability, payload) => {
        const op = (payload as { op: string }).op
        calls.push(op)
        return op === 'begin' ? { handle: 'opaque-handle-1234' } : { roots: [], conflicts: [] }
      }
    })
    await expect(
      new ClusterSkillCoordinator(store).reconcile({
        authority: { groupId: 'g', term: '2', daemonId: 'd', agentId: 'a', workspaceIncarnation: 'claim' },
        skillsAgentId: 'codex',
        shimGeneration: 2,
        sources: [],
        client
      })
    ).rejects.toThrow(/lost duty authority/)
    expect(calls).toEqual(['begin', 'reconcile'])
  })

  describe('Git plan sources (source-cache.md §8)', () => {
    const COMMIT = 'c'.repeat(40)
    const DIGEST = 'd'.repeat(64)
    const sourceId = `agent:0:${DIGEST}:${COMMIT}`
    const plan = {
      sourceId,
      sourceKind: 'git' as const,
      url: 'https://github.com/acme/skills.git',
      ref: 'refs/heads/main',
      plannedCommit: COMMIT,
      subDir: 'skills',
      selections: ['alpha']
    }
    const receipt = (path: string, id = sourceId, kind: 'agent' | 'managed' = 'agent') => ({
      path,
      sourceId: id,
      sourceKind: kind,
      digest: createHash('sha256').update(JSON.stringify([])).digest('hex'),
      files: []
    })
    const resolution = { definitionDigest: DIGEST, resolvedCommit: COMMIT }

    function harness(reply: Record<string, unknown>) {
      const discarded: string[] = []
      const hashes: string[] = []
      const commits: Array<{ ledger: unknown }> = []
      const requests: Array<Record<string, unknown>> = []
      const store: ClusterSkillJournalStore = {
        beginClusterSkillReconcile: async (input) => {
          hashes.push(input.desiredHash)
          return {
            ok: true,
            operationId: '11111111-1111-4111-8111-111111111111',
            replayKey: 'a'.repeat(64),
            priorRevision: 0,
            priorLedger: { roots: [] },
            resumed: false
          }
        },
        authorizeClusterSkillMutation: async () => true,
        commitClusterSkillReconcile: async (input) => {
          commits.push({ ledger: input.ledger })
          return { ok: true, revision: 1 }
        }
      }
      const client = new ClusterSkillClient(
        {
          request: async (_capability, payload) => {
            requests.push(payload as Record<string, unknown>)
            return (payload as { op: string }).op === 'begin' ? { handle: 'opaque-handle-1234' } : reply
          }
        },
        true,
        true,
        true,
        true,
        {
          upload: async () => ({ bytes: 1, sha256: '' }),
          discard: async (handle) => {
            discarded.push(handle)
          }
        }
      )
      const reconcile = (extra: Record<string, unknown> = {}) =>
        new ClusterSkillCoordinator(store).reconcile({
          authority: { groupId: 'g', term: '1', daemonId: 'd', agentId: 'a', workspaceIncarnation: 'claim' },
          skillsAgentId: 'codex',
          shimGeneration: 1,
          sources: [plan],
          gitResolutions: [resolution],
          client,
          ...extra
        })
      return { hashes, commits, requests, reconcile, discarded }
    }

    it('sends the plan and window, uploads nothing, and maps the reply kind `agent` onto the plan', async () => {
      const h = harness({
        roots: [receipt('.agents/skills/alpha')],
        conflicts: [],
        gitSources: [{ sourceId, resolvedCommit: COMMIT, leaves: ['alpha'] }]
      })
      const ledger = await h.reconcile({ credentialWindow: { capability: 'w'.repeat(43) } })
      expect(h.requests.map((r) => r.op)).toEqual(['begin', 'reconcile'])
      expect(h.requests[0]!.files).toEqual([])
      expect(h.requests[1]).toMatchObject({ sources: [plan], credentialWindow: { capability: 'w'.repeat(43) } })
      expect(ledger).toEqual({ roots: [receipt('.agents/skills/alpha')], gitResolutions: [resolution] })
    })

    it('moves the desired hash with the planned commit, never with the GET URL', async () => {
      const h = harness({ roots: [], conflicts: [], skipped: [{ sourceId, reason: 'x', code: 'fetch_failed' }] })
      await h.reconcile()
      await h.reconcile({ sources: [{ ...plan, getUrl: 'https://cache.example/bundle?sig=1' }] })
      expect(h.hashes[1]).toBe(h.hashes[0])
      const moved = harness({
        roots: [],
        conflicts: [],
        skipped: [{ sourceId: `agent:0:${DIGEST}:${'e'.repeat(40)}`, reason: 'x', code: 'fetch_failed' }]
      })
      await moved.reconcile({
        sources: [{ ...plan, sourceId: `agent:0:${DIGEST}:${'e'.repeat(40)}`, plannedCommit: 'e'.repeat(40) }]
      })
      expect(moved.hashes[0]).not.toBe(h.hashes[0])
    })

    it('treats a reported commit other than the planned one as a skipped Source with no ledger resolution', async () => {
      const h = harness({
        roots: [receipt('.agents/skills/alpha')],
        conflicts: [],
        gitSources: [{ sourceId, resolvedCommit: 'f'.repeat(40), leaves: ['alpha'] }]
      })
      const ledger = await h.reconcile()
      expect(ledger.skipped).toEqual([{ sourceId, reason: expect.any(String), code: 'commit_unavailable' }])
      expect(ledger.gitResolutions).toEqual([])
      expect(JSON.stringify(h.commits)).not.toContain('f'.repeat(40))
    })

    it('reads a budget drop as a prune that keeps its resolution, and any other skip as a preserve that drops it', async () => {
      const pruned = harness({
        roots: [],
        conflicts: [],
        skipped: [{ sourceId, reason: 'it does not fit', code: 'limits_exceeded' }]
      })
      expect((await pruned.reconcile()).gitResolutions).toEqual([resolution])
      const failed = harness({ roots: [], conflicts: [], skipped: [{ sourceId, reason: 'x', code: 'fetch_failed' }] })
      expect((await failed.reconcile()).gitResolutions).toEqual([])
    })

    it('refuses a Git receipt whose leaves the pod did not report, or a Git result for another source', async () => {
      const missing = harness({ roots: [receipt('.agents/skills/alpha')], conflicts: [] })
      await expect(missing.reconcile()).rejects.toThrow(/incomplete Git source receipt/)
      const wrong = harness({
        roots: [receipt('.agents/skills/alpha')],
        conflicts: [],
        gitSources: [{ sourceId, resolvedCommit: COMMIT, leaves: ['beta'] }]
      })
      await expect(wrong.reconcile()).rejects.toThrow(/incomplete Git source receipt/)
      const foreign = harness({
        roots: [],
        conflicts: [],
        gitSources: [{ sourceId: `agent:1:${DIGEST}:${COMMIT}`, resolvedCommit: COMMIT, leaves: [] }]
      })
      await expect(foreign.reconcile()).rejects.toThrow(/unexpected Git source/)
    })

    describe('write-back candidates (source-cache.md §9)', () => {
      const HANDLE = '0b5c3f8e-8d0a-4c4e-9a1e-0123456789ab'
      const writeBackPlan = { ...plan, writeBack: { maxBytes: 1024 } }
      const candidate = (extra: Record<string, unknown> = {}) => ({
        sourceId,
        branch: 'refs/heads/main',
        commit: COMMIT,
        handle: HANDLE,
        bytes: 10,
        sha256: Buffer.alloc(32, 1).toString('base64'),
        trigger: 'miss',
        ...extra
      })
      const installedReply = (candidates: unknown[], extra: Record<string, unknown> = {}) => ({
        roots: [receipt('.agents/skills/alpha')],
        conflicts: [],
        gitSources: [{ sourceId, resolvedCommit: COMMIT, leaves: ['alpha'] }],
        writeBackCandidates: candidates,
        ...extra
      })

      it('hands a usable candidate on only after the ledger commits, leaving the ledger as it was', async () => {
        const h = harness(installedReply([candidate()]))
        const seen: Array<{ candidate: unknown; committed: number }> = []
        const ledger = await h.reconcile({
          sources: [writeBackPlan],
          onWriteBackCandidates: (c: unknown[]) =>
            seen.push(...c.map((one) => ({ candidate: one, committed: h.commits.length })))
        })
        expect(seen).toEqual([{ candidate: candidate(), committed: 1 }])
        expect(ledger).toEqual({ roots: [receipt('.agents/skills/alpha')], gitResolutions: [resolution] })
        expect(h.discarded).toEqual([])
      })

      it.each([
        ['its plan never asked', plan, candidate()],
        ['it names another branch', writeBackPlan, candidate({ branch: 'refs/heads/other' })],
        ['it names another commit', writeBackPlan, candidate({ commit: 'e'.repeat(40) })]
      ])('discards a candidate when %s', async (_label, sent, offered) => {
        const h = harness(installedReply([offered]))
        const seen: unknown[] = []
        await h.reconcile({ sources: [sent], onWriteBackCandidates: (c: unknown[]) => seen.push(...c) })
        expect(seen).toEqual([])
        expect(h.discarded).toEqual([HANDLE])
      })

      it('discards the candidate of a skipped Source and of one whose reported commit differs', async () => {
        const skipped = harness(
          installedReply([candidate()], {
            roots: [],
            gitSources: [],
            skipped: [{ sourceId, reason: 'x', code: 'cli_failed' }]
          })
        )
        const seen: unknown[] = []
        await skipped.reconcile({ sources: [writeBackPlan], onWriteBackCandidates: (c: unknown[]) => seen.push(...c) })
        const mismatched = harness(
          installedReply([candidate()], {
            gitSources: [{ sourceId, resolvedCommit: 'f'.repeat(40), leaves: ['alpha'] }]
          })
        )
        await mismatched.reconcile({
          sources: [writeBackPlan],
          onWriteBackCandidates: (c: unknown[]) => seen.push(...c)
        })
        expect(seen).toEqual([])
        expect([...skipped.discarded, ...mismatched.discarded]).toEqual([HANDLE, HANDLE])
      })

      it('discards every handle when the reconcile fails after the reply, so a fallback leaves none staged', async () => {
        const conflicted = harness(installedReply([candidate()], { conflicts: ['.agents/skills/alpha'] }))
        const seen: unknown[] = []
        await expect(
          conflicted.reconcile({ sources: [writeBackPlan], onWriteBackCandidates: (c: unknown[]) => seen.push(...c) })
        ).rejects.toThrow(/conflict/)
        const foreign = harness(installedReply([candidate({ sourceId: 'agent:9' })]))
        await expect(foreign.reconcile({ sources: [writeBackPlan] })).rejects.toThrow(/unexpected source/)
        expect(seen).toEqual([])
        expect([...conflicted.discarded, ...foreign.discarded]).toEqual([HANDLE, HANDLE])
      })

      it('discards the handles a refused reply names, before the refusal propagates', async () => {
        const refused = harness({ ...installedReply([candidate()]), roots: 'not a list' })
        await expect(refused.reconcile({ sources: [writeBackPlan] })).rejects.toThrow()
        expect(refused.discarded).toEqual([HANDLE])
      })

      it('discards without a consumer, and when the consumer throws the committed reconcile still stands', async () => {
        const unconsumed = harness(installedReply([candidate()]))
        await unconsumed.reconcile({ sources: [writeBackPlan] })
        expect(unconsumed.discarded).toEqual([HANDLE])
        const throwing = harness(installedReply([candidate()]))
        const ledger = await throwing.reconcile({
          sources: [writeBackPlan],
          onWriteBackCandidates: () => {
            throw new Error('consumer broke')
          }
        })
        expect(ledger.roots).toHaveLength(1)
        expect(throwing.discarded).toEqual([HANDLE])
      })

      it('never moves the desired hash with a write-back request', async () => {
        const h = harness(installedReply([]))
        await h.reconcile()
        await h.reconcile({ sources: [writeBackPlan] })
        await h.reconcile({ sources: [{ ...writeBackPlan, writeBack: { maxBytes: 1024, stale: true } }] })
        expect(new Set(h.hashes).size).toBe(1)
      })
    })

    it('journals a fallback under the failed run’s desired hash', async () => {
      const h = harness({ roots: [], conflicts: [], skipped: [{ sourceId, reason: 'x', code: 'fetch_failed' }] })
      const journaled: string[] = []
      await h.reconcile({ onJournaled: (hash: string) => journaled.push(hash) })
      const fallback = harness({ roots: [], conflicts: [] })
      await fallback.reconcile({ sources: [], journalAs: journaled[0] })
      expect(h.hashes).toEqual(journaled)
      expect(fallback.hashes).toEqual(journaled)
    })
  })
})
