/**
 * The daemon's monotonic `configRevision` fence
 * (organization-secrets-and-variables.md §7). `AgentSpec.env`/`secrets` are FULL
 * maps, so this comparison is what stops a late-completing older snapshot from
 * reinstating a rotated or deleted value.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSpec } from '@agentconnect.md/protocol'
import {
  agentSpecDigest,
  compareConfigRevision,
  parseConfigRevision,
  readAppliedConfigRevision,
  writeAppliedConfigRevision
} from '../src/agents/config-revision.js'

function spec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    name: 'acme-bot',
    mcpServers: [],
    skills: [],
    managedSkills: [],
    allowedCallerAgentIds: [],
    env: {},
    secrets: {},
    ...overrides
  } as AgentSpec
}

describe('agentSpecDigest', () => {
  it('ignores configRevision so the digest describes the CONTENT alone', () => {
    expect(agentSpecDigest(spec({ configRevision: '1' }))).toBe(agentSpecDigest(spec({ configRevision: '99' })))
  })

  it('is insensitive to key order but sensitive to values', () => {
    const a = agentSpecDigest(spec({ env: { A: '1', B: '2' } }))
    const b = agentSpecDigest(spec({ env: { B: '2', A: '1' } }))
    expect(a).toBe(b)
    expect(agentSpecDigest(spec({ env: { A: '9', B: '2' } }))).not.toBe(a)
  })

  it('distinguishes a rotated secret even when every other field matches', () => {
    expect(agentSpecDigest(spec({ secrets: { K: 'old' } }))).not.toBe(agentSpecDigest(spec({ secrets: { K: 'new' } })))
  })

  it('distinguishes a REMOVED key from an empty-valued one', () => {
    expect(agentSpecDigest(spec({ env: {} }))).not.toBe(agentSpecDigest(spec({ env: { K: '' } })))
  })
})

describe('parseConfigRevision', () => {
  it('reads a decimal string past 2^53 without losing precision', () => {
    expect(parseConfigRevision(spec({ configRevision: '9007199254740993' }))).toBe(9007199254740993n)
  })

  it('treats an absent or malformed value as unfenced rather than throwing', () => {
    expect(parseConfigRevision(spec())).toBeUndefined()
    expect(parseConfigRevision(spec({ configRevision: '007' as string }))).toBeUndefined()
  })
})

describe('compareConfigRevision', () => {
  const applied = { revision: 5n, digest: 'sha256:' + 'a'.repeat(64) }

  it('applies a greater revision', () => {
    expect(compareConfigRevision(applied, { revision: 6n, digest: 'sha256:' + 'b'.repeat(64) })).toBe('apply')
  })

  it('treats an equal revision with the same digest as an idempotent retry', () => {
    expect(compareConfigRevision(applied, { revision: 5n, digest: applied.digest })).toBe('idempotent')
  })

  it('REFUSES an equal revision carrying different content', () => {
    expect(compareConfigRevision(applied, { revision: 5n, digest: 'sha256:' + 'c'.repeat(64) })).toBe('conflict')
  })

  it('treats a lower revision as a stale no-op', () => {
    expect(compareConfigRevision(applied, { revision: 4n, digest: 'sha256:' + 'd'.repeat(64) })).toBe('stale')
  })

  it('applies anything when no marker is persisted yet', () => {
    expect(compareConfigRevision(undefined, { revision: 1n, digest: applied.digest })).toBe('apply')
  })

  it('applies an UNFENCED snapshot rather than blocking on the marker', () => {
    // An older CP, or a hand-authored/partial spec. The rollout gate — not lenient
    // decoding — is what keeps a bound agent off such a CP/daemon pair.
    expect(compareConfigRevision(applied, { revision: undefined, digest: applied.digest })).toBe('apply')
  })
})

describe('the persisted marker', () => {
  let dir: string
  let agentFile: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ac-config-revision-'))
    mkdirSync(join(dir, 'acme-bot'), { recursive: true })
    agentFile = join(dir, 'acme-bot', 'agent.json')
    writeFileSync(agentFile, JSON.stringify({ id: 'a1', name: 'acme-bot' }))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('round-trips a revision past 2^53', () => {
    const digest = 'sha256:' + 'e'.repeat(64)
    writeAppliedConfigRevision(agentFile, 9007199254740993n, digest)
    expect(readAppliedConfigRevision(agentFile)).toEqual({ revision: 9007199254740993n, digest })
  })

  it('stores the revision as a STRING so no JSON reader rounds it', () => {
    writeAppliedConfigRevision(agentFile, 12n, 'sha256:' + 'f'.repeat(64))
    const raw = JSON.parse(readFileSync(join(dir, 'acme-bot', '.cp-config-revision.json'), 'utf8')) as {
      revision: unknown
    }
    expect(typeof raw.revision).toBe('string')
  })

  it('writes NOTHING for an unfenced snapshot, keeping the greatest applied revision', () => {
    const digest = 'sha256:' + '1'.repeat(64)
    writeAppliedConfigRevision(agentFile, 7n, digest)
    // Overwriting with "unknown" would reopen the window for a stale fenced snapshot.
    writeAppliedConfigRevision(agentFile, undefined, 'sha256:' + '2'.repeat(64))
    expect(readAppliedConfigRevision(agentFile)).toEqual({ revision: 7n, digest })
  })

  it('reads a missing marker as unfenced', () => {
    expect(readAppliedConfigRevision(agentFile)).toBeUndefined()
  })

  it('falls back to unfenced on a corrupt marker instead of wedging replication', () => {
    writeFileSync(join(dir, 'acme-bot', '.cp-config-revision.json'), '{ not json')
    expect(readAppliedConfigRevision(agentFile)).toBeUndefined()
  })

  it('rejects a marker whose fields are the wrong shape', () => {
    writeFileSync(
      join(dir, 'acme-bot', '.cp-config-revision.json'),
      JSON.stringify({ revision: 5, digest: 'not-a-digest' })
    )
    expect(readAppliedConfigRevision(agentFile)).toBeUndefined()
  })

  it('leaves no temp file behind', () => {
    writeAppliedConfigRevision(agentFile, 3n, 'sha256:' + '3'.repeat(64))
    expect(existsSync(join(dir, 'acme-bot', '.cp-config-revision.json.tmp'))).toBe(false)
  })
})
