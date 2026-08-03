/**
 * `CpAgentRegistry` under the monotonic `configRevision` fence
 * (organization-secrets-and-variables.md §7).
 *
 * These are the end-to-end daemon-side guarantees the CP relies on when it emits
 * FULL resolved `env`/`secrets` maps: deliberately reordered delivery must not
 * reinstate a rotated or deleted value, an equal-revision digest mismatch must be
 * refused rather than resolved in either direction, and a stale snapshot must
 * never reach `writeAgentSpec` at all.
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSpec } from '@agentconnect.md/protocol'
import { CpAgentRegistry } from '../src/cp/cp-agent-registry.js'
import { archiveAgent, findAgentFileById } from '../src/agents/write-agent.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const deps = { knownRuntimes: ['claude'] }

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
  const registry = new CpAgentRegistry(dir, deps, onChange, warn)
  const envOnDisk = (): Record<string, string> => {
    const file = findAgentFileById(dir, AGENT)
    if (!file) return {}
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      runtimeOverrides?: { env?: Array<{ name: string; value: string }> }
    }
    return Object.fromEntries((raw.runtimeOverrides?.env ?? []).map((e) => [e.name, e.value]))
  }
  const secretsOnDisk = (): Record<string, string> => {
    const file = findAgentFileById(dir, AGENT)
    if (!file) return {}
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      runtimeOverrides?: { secrets?: Array<{ name: string; value: string }> }
    }
    return Object.fromEntries((raw.runtimeOverrides?.secrets ?? []).map((e) => [e.name, e.value]))
  }
  return {
    dir,
    registry,
    onChange,
    warn,
    envOnDisk,
    secretsOnDisk,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}

describe('CpAgentRegistry configRevision fence', () => {
  it('applies the first snapshot and every strictly greater one', () => {
    const f = fixture()
    try {
      expect(f.registry.upsert(AGENT, spec({ configRevision: '1', env: { REGION: 'eu' } }))).toBe('apply')
      expect(f.registry.upsert(AGENT, spec({ configRevision: '2', env: { REGION: 'us' } }))).toBe('apply')
      expect(f.envOnDisk()).toEqual({ REGION: 'us' })
    } finally {
      f.cleanup()
    }
  })

  it('IGNORES a stale snapshot rather than reinstating the value it removed', () => {
    const f = fixture()
    try {
      // Rotation: revision 2 replaces the secret. A revision-1 fan-out that
      // completes afterwards must not put the old credential back.
      f.registry.upsert(AGENT, spec({ configRevision: '1', secrets: { TOKEN: 'old' } }))
      f.registry.upsert(AGENT, spec({ configRevision: '2', secrets: { TOKEN: 'rotated' } }))
      expect(f.registry.upsert(AGENT, spec({ configRevision: '1', secrets: { TOKEN: 'old' } }))).toBe('stale')
      expect(f.secretsOnDisk()).toEqual({ TOKEN: 'rotated' })
    } finally {
      f.cleanup()
    }
  })

  it('IGNORES a stale snapshot that would resurrect a DELETED key', () => {
    const f = fixture()
    try {
      f.registry.upsert(AGENT, spec({ configRevision: '4', env: { REMOVED_ME: 'x' } }))
      f.registry.upsert(AGENT, spec({ configRevision: '5', env: {} }))
      expect(f.registry.upsert(AGENT, spec({ configRevision: '4', env: { REMOVED_ME: 'x' } }))).toBe('stale')
      expect(f.envOnDisk()).toEqual({})
    } finally {
      f.cleanup()
    }
  })

  it('treats a re-delivered identical snapshot as an idempotent no-op', () => {
    const f = fixture()
    try {
      const s = spec({ configRevision: '3', env: { A: '1' } })
      expect(f.registry.upsert(AGENT, s)).toBe('apply')
      expect(f.registry.upsert(AGENT, s)).toBe('idempotent')
      expect(f.envOnDisk()).toEqual({ A: '1' })
    } finally {
      f.cleanup()
    }
  })

  it('REFUSES an equal revision carrying different content', () => {
    const f = fixture()
    try {
      f.registry.upsert(AGENT, spec({ configRevision: '3', env: { A: '1' } }))
      expect(f.registry.upsert(AGENT, spec({ configRevision: '3', env: { A: '2' } }))).toBe('conflict')
      // Neither value wins by accident — the on-disk replica is untouched.
      expect(f.envOnDisk()).toEqual({ A: '1' })
      expect(f.warn).toHaveBeenCalled()
    } finally {
      f.cleanup()
    }
  })

  it('does not fire onChange (and so does not re-reconcile) for a no-op apply', () => {
    const f = fixture()
    try {
      f.registry.upsert(AGENT, spec({ configRevision: '1' }))
      f.onChange.mockClear()
      f.registry.upsert(AGENT, spec({ configRevision: '1' }))
      f.registry.upsert(AGENT, spec({ configRevision: '0' }))
      expect(f.onChange).not.toHaveBeenCalled()
    } finally {
      f.cleanup()
    }
  })

  it('applies an UNFENCED snapshot without clearing the greatest applied revision', () => {
    const f = fixture()
    try {
      f.registry.upsert(AGENT, spec({ configRevision: '9', env: { A: '9' } }))
      // An older CP omits the field entirely; it still applies.
      expect(f.registry.upsert(AGENT, spec({ env: { A: 'unfenced' } }))).toBe('apply')
      expect(f.envOnDisk()).toEqual({ A: 'unfenced' })
      // …and the marker still fences a stale fenced snapshot afterwards.
      expect(f.registry.upsert(AGENT, spec({ configRevision: '8', env: { A: 'stale' } }))).toBe('stale')
      expect(f.envOnDisk()).toEqual({ A: 'unfenced' })
    } finally {
      f.cleanup()
    }
  })

  it('refuses a stale snapshot for a COLD-MOVE ARCHIVED agent instead of un-archiving it', () => {
    const f = fixture()
    try {
      f.registry.upsert(AGENT, spec({ configRevision: '10', secrets: { TOKEN: 'current' } }))
      expect(archiveAgent(f.dir, AGENT)).toBe('archived')
      expect(findAgentFileById(f.dir, AGENT)).toBeUndefined()
      // A fan-out from before the move-away arriving now: writeAgentSpec would
      // restore the archive as a side effect, so the fence must see the ARCHIVED
      // marker and refuse both the downgrade and the resurrection.
      expect(f.registry.upsert(AGENT, spec({ configRevision: '9', secrets: { TOKEN: 'old' } }))).toBe('stale')
      expect(findAgentFileById(f.dir, AGENT)).toBeUndefined()
    } finally {
      f.cleanup()
    }
  })

  it('lets an authoritative NEWER bundle restore an archive on move-back', () => {
    const f = fixture()
    try {
      f.registry.upsert(AGENT, spec({ configRevision: '10', secrets: { TOKEN: 'a' } }))
      archiveAgent(f.dir, AGENT)
      expect(f.registry.upsert(AGENT, spec({ configRevision: '11', secrets: { TOKEN: 'b' } }))).toBe('apply')
      expect(findAgentFileById(f.dir, AGENT)).toBeDefined()
      expect(f.secretsOnDisk()).toEqual({ TOKEN: 'b' })
    } finally {
      f.cleanup()
    }
  })

  it('converge returns only the ids it actually rewrote, skipping stale roster entries', () => {
    const f = fixture()
    const OTHER = '22222222-2222-4222-8222-222222222222'
    try {
      f.registry.upsert(AGENT, spec({ configRevision: '5', env: { A: 'current' } }))
      const applied = f.registry.converge([
        // Stale for AGENT — a reconnect racing a just-committed edit.
        { agentId: AGENT, ...spec({ configRevision: '4', env: { A: 'stale' } }) },
        { agentId: OTHER, ...spec({ name: 'other-bot', configRevision: '1' }) }
      ])
      expect(applied).toEqual([OTHER])
      // One bad revision must not fail the handshake, and must not overwrite.
      expect(f.envOnDisk()).toEqual({ A: 'current' })
      expect(findAgentFileById(f.dir, OTHER)).toBeDefined()
    } finally {
      f.cleanup()
    }
  })

  it('keeps the marker beside agent.json, out of the discovery path', () => {
    const f = fixture()
    try {
      f.registry.upsert(AGENT, spec({ configRevision: '1' }))
      const file = findAgentFileById(f.dir, AGENT)!
      expect(existsSync(join(file, '..', '.cp-config-revision.json'))).toBe(true)
    } finally {
      f.cleanup()
    }
  })

  it('re-applies when the content landed but the marker write was lost (crash between)', () => {
    const f = fixture()
    try {
      f.registry.upsert(AGENT, spec({ configRevision: '2', env: { A: '1' } }))
      const file = findAgentFileById(f.dir, AGENT)!
      rmSync(join(file, '..', '.cp-config-revision.json'))
      // Unfenced-by-accident, so the retry applies rather than being dismissed as
      // already-done — the reason the marker is written AFTER the content.
      expect(f.registry.upsert(AGENT, spec({ configRevision: '2', env: { A: '2' } }))).toBe('apply')
      expect(f.envOnDisk()).toEqual({ A: '2' })
    } finally {
      f.cleanup()
    }
  })

  it('ignores a hand-authored agent root with no marker on first contact', () => {
    const f = fixture()
    try {
      // A local agent the CP has never written: no marker, so nothing to fence.
      mkdirSync(join(f.dir, 'local-bot'), { recursive: true })
      writeFileSync(
        join(f.dir, 'local-bot', 'agent.json'),
        JSON.stringify({ id: AGENT, name: 'local-bot', runtime: 'claude' })
      )
      expect(f.registry.upsert(AGENT, spec({ configRevision: '1', env: { A: '1' } }))).toBe('apply')
      expect(f.envOnDisk()).toEqual({ A: '1' })
    } finally {
      f.cleanup()
    }
  })
})
