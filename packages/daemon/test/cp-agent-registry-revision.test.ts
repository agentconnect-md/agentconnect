/** Monotonic configRevision fencing for the memory-only CP agent registry. */
import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSpec } from '@agentconnect.md/protocol'
import { CpAgentRegistry } from '../src/cp/cp-agent-registry.js'
import { findAgentFileById } from '../src/agents/write-agent.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

function spec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    name: 'acme-bot',
    runtime: 'claude',
    mcpServers: [],
    skills: [],
    managedSkills: [],
    allowedCallerAgentIds: [],
    env: {},
    secrets: {},
    ...overrides
  } as AgentSpec
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-cp-registry-'))
  const onChange = vi.fn()
  const warn = vi.fn()
  const registry = new CpAgentRegistry(dir, { knownRuntimes: ['claude'] }, onChange, warn)
  const values = (kind: 'env' | 'secrets'): Record<string, string> =>
    Object.fromEntries((registry.agents()[0]?.runtimeOverrides?.[kind] ?? []).map((entry) => [entry.name, entry.value]))
  return { dir, registry, onChange, warn, values, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('CpAgentRegistry configRevision fence', () => {
  it('applies the first snapshot and every strictly greater one in memory', () => {
    const f = fixture()
    try {
      expect(f.registry.upsert(AGENT, spec({ configRevision: '1', env: { REGION: 'eu' } }))).toBe('apply')
      expect(f.registry.upsert(AGENT, spec({ configRevision: '2', env: { REGION: 'us' } }))).toBe('apply')
      expect(f.values('env')).toEqual({ REGION: 'us' })
      expect(findAgentFileById(f.dir, AGENT)).toBeUndefined()
    } finally {
      f.cleanup()
    }
  })

  it('ignores stale snapshots that would rotate backwards or resurrect a deleted key', () => {
    const f = fixture()
    try {
      f.registry.upsert(AGENT, spec({ configRevision: '1', secrets: { TOKEN: 'old' }, env: { OLD: 'x' } }))
      f.registry.upsert(AGENT, spec({ configRevision: '2', secrets: { TOKEN: 'rotated' }, env: {} }))
      expect(
        f.registry.upsert(AGENT, spec({ configRevision: '1', secrets: { TOKEN: 'old' }, env: { OLD: 'x' } }))
      ).toBe('stale')
      expect(f.values('secrets')).toEqual({ TOKEN: 'rotated' })
      expect(f.values('env')).toEqual({})
    } finally {
      f.cleanup()
    }
  })

  it('treats an identical revision as idempotent and refuses equal-revision conflicts', () => {
    const f = fixture()
    try {
      const current = spec({ configRevision: '3', env: { A: '1' } })
      expect(f.registry.upsert(AGENT, current)).toBe('apply')
      f.onChange.mockClear()
      expect(f.registry.upsert(AGENT, current)).toBe('idempotent')
      expect(f.registry.upsert(AGENT, spec({ configRevision: '3', env: { A: '2' } }))).toBe('conflict')
      expect(f.values('env')).toEqual({ A: '1' })
      expect(f.onChange).not.toHaveBeenCalled()
      expect(f.warn).toHaveBeenCalled()
    } finally {
      f.cleanup()
    }
  })

  it('applies an unfenced snapshot without clearing the greatest revision', () => {
    const f = fixture()
    try {
      f.registry.upsert(AGENT, spec({ configRevision: '9', env: { A: '9' } }))
      expect(f.registry.upsert(AGENT, spec({ env: { A: 'unfenced' } }))).toBe('apply')
      expect(f.registry.upsert(AGENT, spec({ configRevision: '8', env: { A: 'stale' } }))).toBe('stale')
      expect(f.values('env')).toEqual({ A: 'unfenced' })
    } finally {
      f.cleanup()
    }
  })

  it('keeps a detached agent hidden from stale updates and restores it on a newer bundle', () => {
    const f = fixture()
    try {
      f.registry.upsert(AGENT, spec({ configRevision: '10', secrets: { TOKEN: 'a' } }))
      expect(f.registry.detach(AGENT)).toBe('archived')
      expect(f.registry.upsert(AGENT, spec({ configRevision: '9', secrets: { TOKEN: 'old' } }))).toBe('stale')
      expect(f.registry.agents()).toEqual([])
      expect(f.registry.upsert(AGENT, spec({ configRevision: '11', secrets: { TOKEN: 'b' } }))).toBe('apply')
      expect(f.values('secrets')).toEqual({ TOKEN: 'b' })
      expect(findAgentFileById(f.dir, AGENT)).toBeUndefined()
    } finally {
      f.cleanup()
    }
  })

  it('converge returns only ids actually applied while skipping stale entries', () => {
    const f = fixture()
    try {
      f.registry.upsert(AGENT, spec({ configRevision: '5', env: { A: 'current' } }))
      expect(
        f.registry.converge([
          { agentId: AGENT, ...spec({ configRevision: '4', env: { A: 'stale' } }) },
          { agentId: OTHER, ...spec({ name: 'other-bot', configRevision: '1' }) }
        ])
      ).toEqual([OTHER])
      expect(f.values('env')).toEqual({ A: 'current' })
      expect(
        f.registry
          .agents()
          .map((agent) => agent.id)
          .sort()
      ).toEqual([AGENT, OTHER])
    } finally {
      f.cleanup()
    }
  })

  it('persists only the secret-free root id marker', () => {
    const f = fixture()
    try {
      f.registry.upsert(AGENT, spec({ configRevision: '1', secrets: { TOKEN: 'never-on-disk' } }))
      const root = f.registry.agents()[0]!.dir
      expect(readFileSync(join(root, '.cp-agent-id'), 'utf8').trim()).toBe(AGENT)
      expect(existsSync(join(root, 'agent.json'))).toBe(false)
      expect(existsSync(join(root, '.cp-config-revision.json'))).toBe(false)
    } finally {
      f.cleanup()
    }
  })

  it('deletes a hand-authored same-id file on first contact instead of persisting into it', () => {
    const f = fixture()
    try {
      const root = join(f.dir, 'local-bot')
      mkdirSync(root, { recursive: true })
      writeFileSync(
        join(root, 'agent.json'),
        JSON.stringify({
          id: AGENT,
          name: 'local-bot',
          runtime: 'claude',
          workspace: { mode: 'from-scratch', path: './workspace' }
        })
      )
      expect(f.registry.upsert(AGENT, spec({ configRevision: '1', env: { A: '1' } }))).toBe('apply')
      expect(existsSync(join(root, 'agent.json'))).toBe(false)
      expect(f.values('env')).toEqual({ A: '1' })
    } finally {
      f.cleanup()
    }
  })
})
