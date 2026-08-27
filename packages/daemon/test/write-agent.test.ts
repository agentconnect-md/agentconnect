import { describe, it, expect, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { z } from 'zod'
import { AgentSpec as AgentSpecSchema, type AgentSpec, type CronUpsert } from '@agentconnect.md/protocol'
import {
  agentRemovalTombstones,
  archiveAgent,
  clearAgentRemoval,
  commitAgentMove,
  detachedAgentDir,
  findAgentFileById,
  markAgentRemoval,
  pruneMovedAgentDependents,
  removeAgent,
  readAgentMoveStage,
  restoreArchivedAgent,
  stageAgentMove,
  stagedAgentIds,
  writeAgentSpec
} from '../src/agents/write-agent.js'
import { writeCronDef } from '../src/agents/write-cron.js'

const deps = { knownRuntimes: ['claude', 'codex'] }

function seedAgent(dir: string, id: string, agent: Record<string, unknown>): string {
  const adir = join(dir, id)
  mkdirSync(adir, { recursive: true })
  const file = join(adir, 'agent.json')
  writeFileSync(file, JSON.stringify(agent))
  return file
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

// The wire (pre-parse) shape: a CP spec leaves defaulted fields absent, and so do these fixtures.
const baseSpec = (over: Partial<z.input<typeof AgentSpecSchema>> = {}): AgentSpec =>
  ({
    name: 'bot-a',
    runtime: 'claude',
    env: {},
    ...over
  }) as AgentSpec

describe('durable agent removal tombstones', () => {
  it('hashes arbitrary CP ids instead of using them as filesystem paths', () => {
    const parent = mkdtempSync(join(tmpdir(), 'ac-remove-marker-'))
    const agentsDir = join(parent, 'agents')
    const outside = join(parent, 'outside')
    mkdirSync(agentsDir, { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'sentinel'), 'keep')
    const hostileId = '../../outside'

    markAgentRemoval(agentsDir, hostileId)
    expect(agentRemovalTombstones(agentsDir)).toEqual(new Set([hostileId]))
    expect(readdirSync(join(agentsDir, '.removed'))).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)])

    clearAgentRemoval(agentsDir, hostileId)
    expect(agentRemovalTombstones(agentsDir)).toEqual(new Set())
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('keep')
  })

  it('mirrors the marker into daemon-root obligations and clears both stores', () => {
    const parent = mkdtempSync(join(tmpdir(), 'ac-remove-marker-'))
    const agentsDir = join(parent, 'agents')
    const obligationDir = join(parent, 'state', 'agent-removals')
    mkdirSync(agentsDir, { recursive: true })

    markAgentRemoval(agentsDir, 'bot-a', obligationDir)
    expect(agentRemovalTombstones(agentsDir, obligationDir)).toEqual(new Set(['bot-a']))
    expect(readdirSync(join(agentsDir, '.removed'))).toHaveLength(1)
    expect(readdirSync(obligationDir)).toHaveLength(1)

    clearAgentRemoval(agentsDir, 'bot-a', obligationDir)
    expect(agentRemovalTombstones(agentsDir, obligationDir)).toEqual(new Set())
    expect(readdirSync(join(agentsDir, '.removed'))).toEqual([])
    expect(readdirSync(obligationDir)).toEqual([])
  })

  it('fails startup when a marker store root is replaced by a symlink', () => {
    const parent = mkdtempSync(join(tmpdir(), 'ac-remove-marker-'))
    const agentsDir = join(parent, 'agents')
    const obligationDir = join(parent, 'state', 'agent-removals')
    mkdirSync(agentsDir, { recursive: true })
    markAgentRemoval(agentsDir, 'bot-a', obligationDir)

    const localStore = join(agentsDir, '.removed')
    const redirected = join(parent, 'redirected-markers')
    mkdirSync(redirected)
    rmSync(localStore, { recursive: true })
    symlinkSync(redirected, localStore, 'dir')

    expect(() => agentRemovalTombstones(agentsDir, obligationDir)).toThrow(
      'cannot enumerate durable agent removal tombstones'
    )
  })
})

describe('writeAgentSpec — merge (agent.json exists)', () => {
  it('merges displayName from the CP spec', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const file = seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      displayName: 'Old Bot',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: './workspace' }
    })

    writeAgentSpec(dir, 'bot-a', baseSpec({ displayName: 'Support Bot' }), deps)

    expect(readJson(file).displayName).toBe('Support Bot')
    expect(readJson(file).origin).toBe('cp')
  })

  it('leaves the on-disk displayName alone when the spec omits it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const file = seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      displayName: 'Hand-authored Bot',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: './workspace' }
    })

    writeAgentSpec(dir, 'bot-a', baseSpec(), deps)

    expect(readJson(file).displayName).toBe('Hand-authored Bot')
  })

  it('clears displayName when the CP spec sends null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const file = seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      displayName: 'Support Bot',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: './workspace' }
    })

    writeAgentSpec(dir, 'bot-a', baseSpec({ displayName: null }), deps)

    expect(readJson(file)).not.toHaveProperty('displayName')
  })

  it('merges description from the CP spec', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const file = seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      description: 'Old prompt',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: './workspace' }
    })

    writeAgentSpec(dir, 'bot-a', baseSpec({ description: 'You deploy things.' }), deps)

    expect(readJson(file).description).toBe('You deploy things.')
  })

  it('leaves the on-disk description alone when the spec omits it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const file = seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      description: 'Hand-authored prompt',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: './workspace' }
    })

    writeAgentSpec(dir, 'bot-a', baseSpec(), deps)

    expect(readJson(file).description).toBe('Hand-authored prompt')
  })

  it('clears description when the CP spec sends "" (cleared to empty text)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const file = seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      description: 'Old prompt',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: './workspace' }
    })

    writeAgentSpec(dir, 'bot-a', baseSpec({ description: '' }), deps)

    expect(readJson(file)).not.toHaveProperty('description')
  })

  it('switches the runtime when the CP spec changes it (regression: #370)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const file = seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: './workspace' }
    })

    writeAgentSpec(dir, 'bot-a', baseSpec({ runtime: 'codex' }), deps)

    expect(readJson(file).runtime).toBe('codex')
  })

  it('leaves the on-disk runtime alone when the spec omits it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const file = seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'codex',
      workspace: { mode: 'from-scratch', path: './workspace' }
    })

    writeAgentSpec(dir, 'bot-a', baseSpec({ runtime: undefined }), deps)

    expect(readJson(file).runtime).toBe('codex')
  })

  it('folds a pause change into raw.pause (#288)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const file = seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: './workspace' }
    })

    writeAgentSpec(dir, 'bot-a', baseSpec({ pause: true }), deps)

    expect(readJson(file).pause).toBe(true)
  })

  it('leaves an on-disk pause untouched when the spec omits it (#288)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const file = seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      pause: true,
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: './workspace' }
    })

    // Spec has no pause key ⇒ a hand-edited pause on disk must survive a CP upsert.
    writeAgentSpec(dir, 'bot-a', baseSpec({ pause: undefined }), deps)

    expect(readJson(file).pause).toBe(true)
  })

  it('folds an introduceOnJoin change into raw.introduceOnJoin (#536)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const file = seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: './workspace' }
    })

    writeAgentSpec(dir, 'bot-a', baseSpec({ introduceOnJoin: true }), deps)

    expect(readJson(file).introduceOnJoin).toBe(true)
  })

  it('leaves an on-disk introduceOnJoin untouched when the spec omits it (#536)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const file = seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      introduceOnJoin: true,
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: './workspace' }
    })

    writeAgentSpec(dir, 'bot-a', baseSpec({ introduceOnJoin: undefined }), deps)

    expect(readJson(file).introduceOnJoin).toBe(true)
  })

  it('folds the builtin preset marker into raw.builtin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const file = seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: './workspace' }
    })

    writeAgentSpec(dir, 'bot-a', baseSpec({ builtin: true }), deps)

    expect(readJson(file).builtin).toBe(true)
  })

  it('leaves an on-disk builtin marker untouched when the spec omits it (older CP)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const file = seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      builtin: true,
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: './workspace' }
    })

    writeAgentSpec(dir, 'bot-a', baseSpec({ builtin: undefined }), deps)

    expect(readJson(file).builtin).toBe(true)
  })

  it('folds a model change into runtimeOverrides.model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const file = seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: './workspace' }
    })

    writeAgentSpec(dir, 'bot-a', baseSpec({ model: 'opus' }), deps)

    const raw = readJson(file)
    expect((raw.runtimeOverrides as { model?: string }).model).toBe('opus')
  })

  it('folds spec.secrets (Record) into runtimeOverrides.secrets (array), like env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const file = seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: './workspace' }
    })

    writeAgentSpec(
      dir,
      'bot-a',
      baseSpec({ env: { PUBLIC_URL: 'https://x' }, secrets: { API_KEY: 'sk-1', DB_PASSWORD: 'p@ss' } }),
      deps
    )

    const ro = readJson(file).runtimeOverrides as { env?: unknown; secrets?: unknown }
    expect(ro.env).toEqual([{ name: 'PUBLIC_URL', value: 'https://x' }])
    expect(ro.secrets).toEqual([
      { name: 'API_KEY', value: 'sk-1' },
      { name: 'DB_PASSWORD', value: 'p@ss' }
    ])
  })

  it('clears a stale runtimeOverrides.model when the spec sends model: null (runtime switch → default)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const file = seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      // The previous runtime's model, left over on disk.
      runtimeOverrides: { model: 'opus', env: [{ name: 'FOO', value: 'bar' }] },
      reasoningEffort: 'high',
      permissionMode: 'plan',
      approvalsReviewer: 'auto_review',
      workspace: { mode: 'from-scratch', path: './workspace' }
    })

    // Switch runtime with model/effort/permissionMode reset to default (null ⇒ clear).
    // env still rides in the same runtimeOverrides bag (always shipped) and must survive.
    writeAgentSpec(
      dir,
      'bot-a',
      baseSpec({
        runtime: 'codex',
        model: null,
        reasoningEffort: null,
        permissionMode: null,
        approvalsReviewer: null,
        env: { FOO: 'bar' }
      }),
      deps
    )

    const raw = readJson(file)
    expect(raw.runtime).toBe('codex')
    // The stale model override is gone; env in the same bag survives.
    expect((raw.runtimeOverrides as { model?: string }).model).toBeUndefined()
    expect((raw.runtimeOverrides as { env?: unknown }).env).toEqual([{ name: 'FOO', value: 'bar' }])
    expect(raw.reasoningEffort).toBeUndefined()
    expect(raw.permissionMode).toBeUndefined()
    expect(raw.approvalsReviewer).toBeUndefined()
  })

  it('leaves runtimeOverrides.model alone when the spec omits model (absent ≠ clear)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const file = seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      runtimeOverrides: { model: 'opus' },
      workspace: { mode: 'from-scratch', path: './workspace' }
    })

    // model undefined (key absent) ⇒ hand-authored override survives a partial upsert.
    writeAgentSpec(dir, 'bot-a', baseSpec({ model: undefined, env: undefined }), deps)

    expect((readJson(file).runtimeOverrides as { model?: string }).model).toBe('opus')
  })

  it('preserves the relative workspace.path on update', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const file = seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: './workspace' }
    })

    writeAgentSpec(dir, 'bot-a', baseSpec({ runtime: 'codex' }), deps)

    expect((readJson(file).workspace as { path?: string }).path).toBe('./workspace')
  })

  it('persists explicit-repo GitHub credentials for a scratch workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const file = seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: './workspace' }
    })

    writeAgentSpec(dir, 'bot-a', baseSpec({ workspace: { mode: 'scratch', gitCredential: 'github-app' } }), deps)

    expect(readJson(file).workspace).toMatchObject({
      mode: 'from-scratch',
      path: './workspace',
      gitCredential: 'github-app'
    })
  })

  it('mirrors the CP additional-repository allowlist, including its removal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const file = seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: './workspace' }
    })
    const additionalRepos = [{ repoFullName: 'example-co/shared-library', repoId: '815' }]

    writeAgentSpec(dir, 'bot-a', baseSpec({ workspace: { mode: 'scratch', additionalRepos } }), deps)
    expect(readJson(file).workspace).toMatchObject({ additionalRepos })

    writeAgentSpec(dir, 'bot-a', baseSpec({ workspace: { mode: 'scratch', additionalRepos: [] } }), deps)
    expect(readJson(file).workspace).toMatchObject({ additionalRepos: [] })
  })

  it('persists and normalizes a GitHub working subdirectory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const file = seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'git-repo', path: './workspace', agentDir: 'old/path' }
    })

    writeAgentSpec(
      dir,
      'bot-a',
      baseSpec({
        workspace: {
          mode: 'github',
          gitRepo: 'https://github.com/acme/repo',
          branch: 'main',
          agentDir: './services/api'
        }
      }),
      deps
    )

    expect((readJson(file).workspace as { agentDir?: string }).agentDir).toBe('services/api')
  })

  it('sanitizes legacy clone credentials and refuses unsafe replicated transports', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const file = seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'git-repo', path: './workspace' }
    })

    writeAgentSpec(
      dir,
      'bot-a',
      baseSpec({
        workspace: {
          mode: 'github',
          gitRepo: 'https://legacy-user:legacy-token@example.com/repo?token=query-secret',
          branch: 'main'
        }
      }),
      deps
    )
    expect((readJson(file).workspace as { gitRepo: string }).gitRepo).toBe('https://example.com/repo')

    writeAgentSpec(
      dir,
      'bot-a',
      baseSpec({
        workspace: {
          mode: 'github',
          gitRepo: 'https://legacy-user:legacy-token@other-host.example/acme/repo?token=query-secret',
          branch: 'main',
          gitCredential: 'github-app'
        }
      }),
      deps
    )
    expect((readJson(file).workspace as { gitRepo: string }).gitRepo).toBe('https://github.com/acme/repo')

    expect(() =>
      writeAgentSpec(
        dir,
        'bot-a',
        baseSpec({ workspace: { mode: 'github', gitRepo: 'file:///tmp/repo', branch: 'main' } }),
        deps
      )
    ).toThrow('git clone url must use https or ssh')
  })

  it('clears a stale working subdirectory for repo-root and scratch specs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const file = seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'git-repo', path: './workspace', agentDir: 'old/path' }
    })

    writeAgentSpec(
      dir,
      'bot-a',
      baseSpec({ workspace: { mode: 'github', gitRepo: 'https://github.com/acme/repo', branch: 'main' } }),
      deps
    )
    expect(readJson(file).workspace).not.toHaveProperty('agentDir')

    const raw = readJson(file)
    ;(raw.workspace as Record<string, unknown>).agentDir = 'stale/path'
    writeFileSync(file, JSON.stringify(raw))
    writeAgentSpec(dir, 'bot-a', baseSpec({ workspace: { mode: 'scratch' } }), deps)
    expect(readJson(file).workspace).not.toHaveProperty('agentDir')
  })

  it('keeps a historical invalid working subdirectory during replication', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const file = seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'git-repo', path: './workspace' }
    })

    writeAgentSpec(
      dir,
      'bot-a',
      baseSpec({
        workspace: { mode: 'github', gitRepo: 'https://github.com/acme/repo', branch: 'main', agentDir: '../legacy' }
      }),
      deps
    )

    expect((readJson(file).workspace as { agentDir?: string }).agentDir).toBe('../legacy')
  })
})

describe('writeAgentSpec — create (no agent.json)', () => {
  it.skipIf(process.platform === 'win32')('creates the agent root and agent.json with owner-only modes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))

    writeAgentSpec(dir, 'bot-new', baseSpec({ name: 'bot-new' }), deps)

    const file = join(dir, 'bot-new', 'agent.json')
    expect(statSync(join(dir, 'bot-new')).mode & 0o777).toBe(0o700)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('persists displayName for a fresh agent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))

    writeAgentSpec(dir, 'bot-new', baseSpec({ name: 'bot-new', displayName: 'Deploy Bot' }), deps)

    const file = findAgentFileById(dir, 'bot-new')
    expect(file).toBeDefined()
    expect(readJson(file!).displayName).toBe('Deploy Bot')
    expect(readJson(file!).origin).toBe('cp')
  })

  it('uses the spec runtime for a fresh agent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))

    writeAgentSpec(dir, 'bot-new', baseSpec({ name: 'bot-new', runtime: 'codex' }), deps)

    const file = findAgentFileById(dir, 'bot-new')
    expect(file).toBeDefined()
    expect(readJson(file!).runtime).toBe('codex')
  })

  it('falls back to the first known runtime when the spec omits it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))

    writeAgentSpec(dir, 'bot-new', baseSpec({ name: 'bot-new', runtime: undefined }), deps)

    const file = findAgentFileById(dir, 'bot-new')
    expect(readJson(file!).runtime).toBe('claude')
  })

  it('never uses an arbitrary CP name as a filesystem path segment', () => {
    const parent = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const dir = join(parent, 'agents')
    const outside = join(parent, 'outside')
    const warn = vi.fn()
    mkdirSync(dir, { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'sentinel'), 'keep')

    writeAgentSpec(dir, 'bot-new', baseSpec({ name: '../outside' }), { ...deps, warn })

    const file = findAgentFileById(dir, 'bot-new')
    const sep = process.platform === 'win32' ? '\\\\' : '/'
    expect(file).toMatch(
      new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${sep}agent-[a-f0-9]{32}${sep}agent\\.json$`)
    )
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('keep')
    expect(warn).toHaveBeenCalledOnce()
  })

  it.skipIf(process.platform === 'win32')('repairs legacy modes when a dependent write rewrites agent.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const file = seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: './workspace' }
    })
    chmodSync(join(dir, 'bot-a'), 0o755)
    chmodSync(file, 0o644)

    // CP integrations stopped being disk state (#599); the cron write is the
    // remaining CP-dependent path that rewrites agent.json in place.
    expect(
      writeCronDef(
        dir,
        {
          cronId: 'cron-a',
          agentId: 'bot-a',
          schedule: '* * * * *',
          timezone: 'UTC',
          trigger: 'tick',
          enabled: true
        } as never,
        {}
      )
    ).toBe(true)
    expect(statSync(join(dir, 'bot-a')).mode & 0o777).toBe(0o755)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})

describe('cold-move archive', () => {
  it('archives the whole custom agent root and writeAgentSpec restores it before merging CP fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const agentDir = join(dir, 'teams', 'custom-name')
    mkdirSync(join(agentDir, 'workspace', 'nested'), { recursive: true })
    mkdirSync(join(agentDir, 'memory'), { recursive: true })
    writeFileSync(join(agentDir, 'local-note.txt'), 'agent-local-state')
    writeFileSync(join(agentDir, 'workspace', 'nested', 'keep.txt'), 'workspace-state')
    writeFileSync(join(agentDir, 'memory', 'keep.md'), 'memory-state')
    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify({
        id: 'bot-a',
        name: 'local-name',
        status: 'active',
        runtime: 'claude',
        integrations: [],
        crons: [],
        workspace: { mode: 'from-scratch', path: './workspace' }
      })
    )

    expect(archiveAgent(dir, 'bot-a')).toBe('archived')
    expect(findAgentFileById(dir, 'bot-a')).toBeUndefined()
    const archiveRoot = detachedAgentDir(dir, 'bot-a')
    expect(JSON.parse(readFileSync(join(archiveRoot, 'metadata.json'), 'utf8'))).toEqual({
      agentId: 'bot-a',
      relativePath: join('teams', 'custom-name')
    })
    expect(readFileSync(join(archiveRoot, 'agent', 'workspace', 'nested', 'keep.txt'), 'utf8')).toBe('workspace-state')

    writeAgentSpec(dir, 'bot-a', baseSpec({ name: 'cp-name', runtime: 'codex' }), deps)
    expect(findAgentFileById(dir, 'bot-a')).toBe(join(agentDir, 'agent.json'))
    expect(existsSync(archiveRoot)).toBe(false)
    expect(readFileSync(join(agentDir, 'workspace', 'nested', 'keep.txt'), 'utf8')).toBe('workspace-state')
    expect(readFileSync(join(agentDir, 'memory', 'keep.md'), 'utf8')).toBe('memory-state')
    expect(readFileSync(join(agentDir, 'local-note.txt'), 'utf8')).toBe('agent-local-state')
    expect(readJson(join(agentDir, 'agent.json'))).toMatchObject({ name: 'cp-name', runtime: 'codex' })
  })

  it('is idempotent while detached, restores the original path, and remove purges the archive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: './workspace' }
    })

    expect(archiveAgent(dir, 'bot-a')).toBe('archived')
    expect(archiveAgent(dir, 'bot-a')).toBe('already-detached')
    expect(restoreArchivedAgent(dir, 'bot-a')).toBe(true)
    expect(findAgentFileById(dir, 'bot-a')).toBe(join(dir, 'bot-a', 'agent.json'))

    expect(archiveAgent(dir, 'bot-a')).toBe('archived')
    stageAgentMove(dir, 'bot-a', '77777777-7777-4777-8777-777777777777', true)
    expect(stagedAgentIds(dir)).toEqual(['bot-a'])
    expect(readAgentMoveStage(dir, 'bot-a')).toEqual({
      moveId: '77777777-7777-4777-8777-777777777777',
      state: 'staging',
      requireEmptyWorkspace: true
    })
    commitAgentMove(dir, 'bot-a', '77777777-7777-4777-8777-777777777777')
    expect(stagedAgentIds(dir)).toEqual([])
    expect(readAgentMoveStage(dir, 'bot-a')).toEqual({
      moveId: '77777777-7777-4777-8777-777777777777',
      state: 'committed'
    })
    stageAgentMove(dir, 'bot-a', '88888888-8888-4888-8888-888888888888')
    expect(stagedAgentIds(dir)).toEqual(['bot-a'])
    removeAgent(dir, 'bot-a')
    expect(existsSync(detachedAgentDir(dir, 'bot-a'))).toBe(false)
    expect(stagedAgentIds(dir)).toEqual([])
    expect(findAgentFileById(dir, 'bot-a')).toBeUndefined()
  })

  it('exact-prunes stale restored dependents while preserving hand-authored crons', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const file = seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: './workspace' },
      integrations: [
        { id: 'int-current', platform: 'slack', config: { botToken: 'current', appToken: 'current' } },
        { id: 'int-stale', platform: 'slack', config: { botToken: 'stale', appToken: 'stale' } }
      ],
      crons: [
        { id: 'cron-current', schedule: '* * * * *', trigger: 'current', origin: 'cp' },
        { id: 'cron-stale', schedule: '* * * * *', trigger: 'stale', origin: 'cp' },
        { id: 'cron-local', schedule: '* * * * *', trigger: 'local' }
      ]
    })

    expect(
      pruneMovedAgentDependents(dir, 'bot-a', {
        integrationIds: ['int-current'],
        cronIds: ['cron-current']
      })
    ).toBe(true)
    const raw = readJson(file)
    expect((raw.integrations as Array<{ id: string }>).map((item) => item.id)).toEqual(['int-current'])
    expect((raw.crons as Array<{ id: string }>).map((item) => item.id)).toEqual(['cron-current', 'cron-local'])
  })

  it('detach scrubs credentials; activation re-writes crons and exact-sets disk integrations to none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    const file = seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: './workspace' },
      integrations: [
        {
          id: 'int-current',
          platform: 'slack',
          core: { mode: 'direct' },
          config: { botToken: 'old-secret', appToken: 'old-app' }
        },
        {
          id: 'int-stale',
          platform: 'slack',
          core: { mode: 'direct' },
          config: { botToken: 'stale', appToken: 'stale' }
        }
      ],
      crons: [
        { id: 'cron-current', schedule: '* * * * *', trigger: 'old-trigger', origin: 'cp' },
        { id: 'cron-stale', schedule: '* * * * *', trigger: 'stale-trigger', origin: 'cp' }
      ]
    })
    const cron = {
      cronId: 'cron-current',
      agentId: 'bot-a',
      schedule: '0 * * * *',
      timezone: 'UTC',
      trigger: 'new-trigger',
      enabled: true
    } as CronUpsert

    expect(archiveAgent(dir, 'bot-a')).toBe('archived')
    const archivedAgentFile = join(detachedAgentDir(dir, 'bot-a'), 'agent', 'agent.json')
    const archivedJson = readFileSync(archivedAgentFile, 'utf8')
    expect(archivedJson).not.toContain('old-secret')
    expect((JSON.parse(archivedJson) as { integrations: unknown[] }).integrations).toEqual([])
    expect((JSON.parse(archivedJson) as { crons: unknown[] }).crons).toEqual([])
    // Simulate an archive from an older/interrupted version and prove a repeated
    // detach security-converges it before returning already-detached.
    const legacy = JSON.parse(archivedJson) as Record<string, unknown>
    // Malformed/legacy shapes must not bypass detach's credential erasure.
    legacy.integrations = {
      id: 'legacy',
      platform: 'slack',
      core: { mode: 'direct' },
      config: { botToken: 'legacy-secret', appToken: 'legacy' }
    }
    legacy.crons = [
      { id: 'legacy-cp', schedule: '* * * * *', trigger: 'stale', origin: 'cp' },
      { id: 'legacy-local', schedule: '* * * * *', trigger: 'keep' }
    ]
    writeFileSync(archivedAgentFile, JSON.stringify(legacy))
    expect(archiveAgent(dir, 'bot-a')).toBe('already-detached')
    const rescrubbed = readFileSync(archivedAgentFile, 'utf8')
    expect(rescrubbed).not.toContain('legacy-secret')
    expect((JSON.parse(rescrubbed) as { crons: Array<{ id: string }> }).crons).toEqual([
      expect.objectContaining({ id: 'legacy-local' })
    ])
    // AgentActivate's bundle writes the agent spec first; this restores the old
    // archive while it is still hidden behind the daemon's staging gate. CP
    // integrations are memory-only (#599) — the move bundle re-upserts them into
    // the registry, so the disk exact-set is integration-free by construction.
    writeAgentSpec(dir, 'bot-a', baseSpec({ name: 'bot-a', runtime: 'claude' }), deps)
    expect(writeCronDef(dir, cron, {})).toBe(true)
    pruneMovedAgentDependents(dir, 'bot-a', {
      integrationIds: [],
      cronIds: [cron.cronId]
    })

    const raw = readJson(file)
    expect(raw.integrations).toEqual([])
    expect(raw.crons).toEqual([
      {
        id: 'legacy-local',
        schedule: '* * * * *',
        trigger: 'keep'
      },
      {
        id: 'cron-current',
        schedule: '0 * * * *',
        timezone: 'UTC',
        trigger: 'new-trigger',
        enabled: true,
        origin: 'cp'
      }
    ])
  })

  it('fails activation verification on a hand-authored cron id collision', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: './workspace' },
      crons: [{ id: 'cron-current', schedule: '* * * * *', trigger: 'local' }]
    })

    expect(() => pruneMovedAgentDependents(dir, 'bot-a', { integrationIds: [], cronIds: ['cron-current'] })).toThrow(
      'authoritative dependent bundle did not persist'
    )
  })

  it('self-heals a metadata-only archive residue when the active root still exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-write-agent-'))
    seedAgent(dir, 'bot-a', {
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: './workspace' }
    })
    const residue = detachedAgentDir(dir, 'bot-a')
    mkdirSync(residue, { recursive: true })
    writeFileSync(join(residue, 'metadata.json'), JSON.stringify({ agentId: 'bot-a', relativePath: 'bot-a' }))

    expect(archiveAgent(dir, 'bot-a')).toBe('archived')
    expect(existsSync(join(residue, 'agent', 'agent.json'))).toBe(true)
  })
})

describe('writeCronDef §6.8 open target platform', () => {
  const AGENT = '33333333-3333-4333-8333-333333333333'
  it('persists a non-Slack target with its REAL platform (no headless degradation)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-cron-open-'))
    seedAgent(dir, 'bot-a', {
      id: AGENT,
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: 'workspace' },
      integrations: []
    })
    writeCronDef(
      dir,
      {
        cronId: '77777777-7777-4777-8777-777777777777',
        agentId: AGENT,
        schedule: '0 9 * * *',
        timezone: 'UTC',
        target: { platform: 'telegram', channel: '-100123', integrationId: '66666666-6666-4666-8666-666666666666' },
        trigger: 'daily digest',
        enabled: true
      } as never,
      {}
    )
    const raw = readJson(join(dir, 'bot-a', 'agent.json'))
    expect((raw.crons as Record<string, unknown>[])[0]).toMatchObject({
      target: { platform: 'telegram', channel: '-100123' }
    })
  })
})
