import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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
        if (request.op === 'begin') return { handle: 'opaque-handle-1234' }
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
      client: new ClusterSkillClient(requester)
    })
    expect(ledger.roots).toHaveLength(3)
    expect(events[0]).toBe('begin-journal')
    expect(events.at(-1)).toBe('commit:3')
    expect(reconciledSourceIds).toEqual(sources.map((source) => source.sourceId))
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
})
