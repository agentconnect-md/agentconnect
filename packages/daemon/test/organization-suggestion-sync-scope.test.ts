import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'

// An install-wide (frame-mode) member serves several orgs, so the suggestion replay is org-scoped by
// nature: one frame per org, each naming it. A connection-mode daemon must keep sending what it did.
const AGENT_A = 'suggestion-agent-a'
const AGENT_B = 'suggestion-agent-b'
const ORG_A = '00000000-0000-4000-8000-00000000000a'
const ORG_B = '00000000-0000-4000-8000-00000000000b'

function agentJson(root: string, id: string): void {
  const dir = join(root, 'agents', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'agent.json'),
    JSON.stringify({
      id,
      name: id,
      status: 'active',
      runtime: 'test',
      workspace: { mode: 'from-scratch', path: join(dir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
}

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-suggestion-scope-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { test: { command: 'node', args: ['unused'] } }
    })
  )
  agentJson(root, AGENT_A)
  agentJson(root, AGENT_B)
  return root
}

function hostFactory() {
  return () => ({
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => 'session-1'),
    hasSession: vi.fn(() => true),
    modelOptions: vi.fn(() => ({ current: 'test-model', models: ['test-model'] })),
    prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => {})
  })
}

async function seedSuggestion(daemon: Daemon, agentId: string, candidateId: string): Promise<void> {
  const dreamId = `drm-${agentId}`
  const body = `{"kind":"knowledge","content":"body for ${agentId}"}`
  await (daemon as any).store.insertDream({
    dreamId,
    agentId,
    status: 'superseded',
    trigger: 'manual',
    sessionIds: ['session-1'],
    snapshotDigest: `sha256:${'b'.repeat(64)}`,
    organizationSuggestions: [
      {
        candidateId,
        kind: 'knowledge',
        operation: 'create',
        title: `Suggestion from ${agentId}`,
        digest: `sha256:${'a'.repeat(64)}`,
        contentBytes: Buffer.byteLength(body),
        state: 'proposed',
        sessionIds: ['session-1'],
        createdAt: '2026-08-01T00:00:00.000Z'
      }
    ],
    createdAt: '2026-08-01T00:00:00.000Z',
    endedAt: '2026-08-01T00:01:00.000Z'
  })
}

function fakeClient(scope?: 'connection' | 'frame') {
  const sync = vi.fn(async () => ({ decisions: [] }))
  return {
    sync,
    client: {
      supportsServerFeature: vi.fn(() => true),
      ...(scope ? { organizationScope: vi.fn(() => scope) } : {}),
      syncOrganizationSuggestions: sync,
      stop: vi.fn(async () => {})
    }
  }
}

describe('organization suggestion sync scope', () => {
  it('sends one org-scoped frame per org on an install-wide connection', async () => {
    const daemon = new Daemon({ root: scaffold(), hostFactory: hostFactory() as never })
    await daemon.start()
    await seedSuggestion(daemon, AGENT_A, '11111111-1111-4111-8111-111111111111')
    await seedSuggestion(daemon, AGENT_B, '22222222-2222-4222-8222-222222222222')
    const orgs = new Map([
      [AGENT_A, ORG_A],
      [AGENT_B, ORG_B]
    ])
    ;(daemon as any).cpAgents = {
      orgForAgent: (id: string) => orgs.get(id),
      organizationIds: () => [...new Set(orgs.values())]
    }
    const { sync, client } = fakeClient('frame')
    ;(daemon as any).cpClient = client

    await (daemon as any).syncOrganizationSuggestions()

    expect(sync).toHaveBeenCalledTimes(2)
    const byOrg = new Map(
      sync.mock.calls.map((call) => [
        (call as unknown as [{ suggestions: { sourceAgentId: string }[] }, string])[1],
        (call as unknown as [{ suggestions: { sourceAgentId: string }[] }, string])[0].suggestions.map(
          (s) => s.sourceAgentId
        )
      ])
    )
    // Two orgs, two frames — and neither frame carries the other org's suggestion.
    expect(byOrg.get(ORG_A)).toEqual([AGENT_A])
    expect(byOrg.get(ORG_B)).toEqual([AGENT_B])
    await daemon.stop()
  })

  it('sends nothing unscoped on an install-wide connection with no resolvable org', async () => {
    const daemon = new Daemon({ root: scaffold(), hostFactory: hostFactory() as never })
    await daemon.start()
    await seedSuggestion(daemon, AGENT_A, '11111111-1111-4111-8111-111111111111')
    ;(daemon as any).cpAgents = { orgForAgent: () => undefined, organizationIds: () => [] }
    const { sync, client } = fakeClient('frame')
    ;(daemon as any).cpClient = client

    await expect((daemon as any).syncOrganizationSuggestions()).resolves.toBeUndefined()

    // The CP would answer SCOPE_DENIED to an unscoped frame here, which is the whole failure (#968).
    expect(sync).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('keeps a single unscoped frame on a connection-scoped daemon', async () => {
    const daemon = new Daemon({ root: scaffold(), hostFactory: hostFactory() as never })
    await daemon.start()
    await seedSuggestion(daemon, AGENT_A, '11111111-1111-4111-8111-111111111111')
    await seedSuggestion(daemon, AGENT_B, '22222222-2222-4222-8222-222222222222')
    ;(daemon as any).cpAgents = { orgForAgent: () => undefined, organizationIds: () => [] }
    const { sync, client } = fakeClient('connection')
    ;(daemon as any).cpClient = client

    await (daemon as any).syncOrganizationSuggestions()

    expect(sync).toHaveBeenCalledOnce()
    expect(sync.mock.calls[0]).toHaveLength(1)
    const sent = (sync.mock.calls[0] as unknown as [{ suggestions: { sourceAgentId: string }[] }])[0]
    expect(sent.suggestions.map((s) => s.sourceAgentId).sort()).toEqual([AGENT_A, AGENT_B])
    await daemon.stop()
  })

  it('keeps every other org replaying when one org is refused', async () => {
    const daemon = new Daemon({ root: scaffold(), hostFactory: hostFactory() as never })
    await daemon.start()
    await seedSuggestion(daemon, AGENT_A, '11111111-1111-4111-8111-111111111111')
    await seedSuggestion(daemon, AGENT_B, '22222222-2222-4222-8222-222222222222')
    const orgs = new Map([
      [AGENT_A, ORG_A],
      [AGENT_B, ORG_B]
    ])
    ;(daemon as any).cpAgents = {
      orgForAgent: (id: string) => orgs.get(id),
      organizationIds: () => [...new Set(orgs.values())]
    }
    const sync = vi.fn(async (_payload: unknown, orgId?: string) => {
      if (orgId === ORG_A) throw new Error('SCOPE_DENIED')
      return { decisions: [] }
    })
    ;(daemon as any).cpClient = {
      supportsServerFeature: vi.fn(() => true),
      organizationScope: vi.fn(() => 'frame'),
      syncOrganizationSuggestions: sync,
      stop: vi.fn(async () => {})
    }

    await expect((daemon as any).syncOrganizationSuggestions()).resolves.toBeUndefined()

    expect(sync).toHaveBeenCalledTimes(2)
    expect(sync.mock.calls.map((call) => call[1]).sort()).toEqual([ORG_A, ORG_B])
    await daemon.stop()
  })
})
