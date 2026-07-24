import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DreamInfo, MemoryDreamingPolicy } from '@agentconnect.md/protocol'
import { DreamRunner, DreamStateError, type DreamStorePort } from '../src/agents/dream-runner.js'
import {
  ensureMemory,
  readMemoryFile,
  writeMemoryFile,
  MEMORY_HISTORY_FILENAME,
  memoryDir
} from '../src/agents/memory.js'

const silent = { info() {}, warn() {} }

class FakeStore implements DreamStorePort {
  dreams = new Map<string, DreamInfo>()
  sources: { sessionId: string; channel: string; thread: string }[] = [
    { sessionId: 'sess-1', channel: 'C1', thread: 'T1' }
  ]
  rows: { sender: string; text: string }[] = [{ sender: 'user-1', text: 'please use tabs' }]

  insertDream(dream: DreamInfo): void {
    this.dreams.set(dream.dreamId, dream)
  }
  updateDream(dream: DreamInfo): void {
    this.dreams.set(dream.dreamId, dream)
  }
  getDream(_agentId: string, dreamId: string): DreamInfo | undefined {
    return this.dreams.get(dreamId)
  }
  listDreams(agentId: string, limit: number): DreamInfo[] {
    return [...this.dreams.values()].filter((d) => d.agentId === agentId).slice(0, limit)
  }
  openDreams(): DreamInfo[] {
    return [...this.dreams.values()].filter((d) => d.status === 'pending' || d.status === 'running')
  }
  dreamSessionSources(): { sessionId: string; channel: string; thread: string }[] {
    return this.sources
  }
  dreamTranscriptText(): { sender: string; text: string }[] {
    return this.rows
  }
}

const PROPOSAL = JSON.stringify({
  index: '# Memory\n- [prefs](prefs.md)',
  files: [{ path: 'prefs.md', content: '- Uses tabs, not spaces (2026-07-24).' }]
})

async function setup(opts: {
  extract?: (agentId: string, systemPrompt: string, prompt: string) => Promise<string>
  policy?: MemoryDreamingPolicy
}) {
  const dir = await mkdtemp(join(tmpdir(), 'ac-dream-'))
  ensureMemory(dir, 'bot')
  await writeMemoryFile(dir, 'prefs.md', '- uses tabs\n- uses tabs again\n', undefined, 'tool')
  const store = new FakeStore()
  const prompts: { systemPrompt: string; prompt: string }[] = []
  const runner = new DreamRunner({
    agentDirByAgent: (id) => (id === 'a1' ? dir : undefined),
    dreamingPolicyFor: () => opts.policy ?? { enabled: true },
    store,
    extract: async (agentId, systemPrompt, prompt) => {
      prompts.push({ systemPrompt, prompt })
      return opts.extract ? opts.extract(agentId, systemPrompt, prompt) : PROPOSAL
    },
    log: silent
  })
  return { dir, store, runner, prompts }
}

async function settle(store: FakeStore, dreamId: string): Promise<DreamInfo> {
  for (let i = 0; i < 200; i++) {
    const dream = store.dreams.get(dreamId)
    if (dream && dream.status !== 'pending' && dream.status !== 'running') return dream
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('dream never settled')
}

describe('DreamRunner pipeline', () => {
  it('stages a validated proposal without touching the live store', async () => {
    const { dir, store, runner, prompts } = await setup({})
    const started = await runner.start('a1', { trigger: 'manual' })
    expect(started.status).toBe('pending')
    expect(started.sessionIds).toEqual(['sess-1'])

    const done = await settle(store, started.dreamId)
    expect(done.status).toBe('completed')
    expect(done.usage?.inputBytes).toBeGreaterThan(0)

    // Prompt carried the store and the transcript as untrusted data.
    expect(prompts[0]?.prompt).toContain('please use tabs')
    expect(prompts[0]?.systemPrompt).toContain('memory dreamer')

    // Live store untouched; staged output holds the rebuilt store.
    expect(await readMemoryFile(dir, 'prefs.md')).toContain('uses tabs again')
    const staged = await runner.stagedFiles('a1', started.dreamId)
    expect(staged?.map((f) => f.name)).toEqual(['MEMORY.md', 'prefs.md'])
    const read = await runner.stagedRead('a1', started.dreamId, 'prefs.md')
    expect(read?.content).toContain('2026-07-24')
  })

  it('rejects a second dream while one is in flight and when dreaming is disabled', async () => {
    const { runner: disabled } = await setup({ policy: { enabled: false } })
    await expect(disabled.start('a1', { trigger: 'manual' })).rejects.toThrow(DreamStateError)

    let release!: (v: string) => void
    const gate = new Promise<string>((r) => (release = r))
    const { store, runner } = await setup({ extract: () => gate })
    const first = await runner.start('a1', { trigger: 'manual' })
    await expect(runner.start('a1', { trigger: 'manual' })).rejects.toThrow(/already in flight/)
    release(PROPOSAL)
    await settle(store, first.dreamId)
  })

  it('serializes concurrent starts so exactly one dream is created', async () => {
    let release!: (v: string) => void
    const gate = new Promise<string>((r) => (release = r))
    const { store, runner } = await setup({ extract: () => gate })
    // Fire both without awaiting between them — the reservation must be taken
    // before the first snapshot await, or both would slip through.
    const results = await Promise.allSettled([
      runner.start('a1', { trigger: 'manual' }),
      runner.start('a1', { trigger: 'manual' })
    ])
    const ok = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(ok).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect([...store.dreams.values()]).toHaveLength(1)
    release(PROPOSAL)
    await settle(store, (ok[0] as PromiseFulfilledResult<{ dreamId: string }>).value.dreamId)
  })

  it('fails a dream terminally when the pre-extraction snapshot write fails', async () => {
    // agentDir points at a path we make un-writable by pointing memory-dreams at
    // a file: the input/ mkdir fails before the pending→running transition.
    const dir = await mkdtemp(join(tmpdir(), 'ac-dream-'))
    ensureMemory(dir, 'bot')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'memory-dreams'), 'not a directory', 'utf8')
    const store = new FakeStore()
    const runner = new DreamRunner({
      agentDirByAgent: () => dir,
      dreamingPolicyFor: () => ({ enabled: true }),
      store,
      extract: async () => PROPOSAL,
      log: silent
    })
    const started = await runner.start('a1', { trigger: 'manual' })
    const done = await settle(store, started.dreamId)
    expect(done.status).toBe('failed') // not stuck 'pending'
  })

  it('fails the dream when the reply carries no proposal, keeping the record', async () => {
    const { store, runner } = await setup({ extract: async () => 'sorry, no JSON here' })
    const started = await runner.start('a1', { trigger: 'manual' })
    const done = await settle(store, started.dreamId)
    expect(done.status).toBe('failed')
    expect(done.error?.type).toBe('unparseable_proposal')
  })

  it('cancel-wins when it lands during staging: no completed status, staging removed', async () => {
    // onStaged fires right after the staging writes, standing in for a cancel
    // that lands mid-staging. The post-stage recheck must honor it.
    let runner!: DreamRunner
    const dir = await mkdtemp(join(tmpdir(), 'ac-dream-'))
    ensureMemory(dir, 'bot')
    await writeMemoryFile(dir, 'prefs.md', '- seed\n', undefined, 'tool')
    const store = new FakeStore()
    let started: { dreamId: string } | undefined
    runner = new DreamRunner({
      agentDirByAgent: () => dir,
      dreamingPolicyFor: () => ({ enabled: true }),
      store,
      extract: async () => PROPOSAL,
      onStaged: (agentId, dreamId) => {
        runner.cancel(agentId, dreamId) // cancel after staging, before completion
      },
      log: silent
    })
    started = await runner.start('a1', { trigger: 'manual' })
    const done = await settle(store, started.dreamId)
    expect(done.status).toBe('canceled') // NOT overwritten to completed
    expect(await runner.stagedFiles('a1', started.dreamId)).toBeNull() // partial output dropped
  })

  it('cancel during extraction wins: the late output is never staged', async () => {
    let release!: (v: string) => void
    const gate = new Promise<string>((r) => (release = r))
    const { store, runner } = await setup({ extract: () => gate })
    const started = await runner.start('a1', { trigger: 'manual' })
    // allow the pending → running transition to land
    await new Promise((r) => setTimeout(r, 10))
    const canceled = runner.cancel('a1', started.dreamId)
    expect(canceled.status).toBe('canceled')
    release(PROPOSAL)
    await new Promise((r) => setTimeout(r, 20))
    expect(store.dreams.get(started.dreamId)?.status).toBe('canceled')
    expect(await runner.stagedFiles('a1', started.dreamId)).toBeNull()
  })
})

describe('DreamRunner adoption', () => {
  it('adopts atomically: backup, rebuilt store, dream-source history rows', async () => {
    const { dir, store, runner } = await setup({})
    const started = await runner.start('a1', { trigger: 'manual' })
    await settle(store, started.dreamId)

    const adopted = await runner.adopt('a1', started.dreamId, false)
    expect(adopted.status).toBe('adopted')

    expect(await readMemoryFile(dir, 'prefs.md')).toBe('- Uses tabs, not spaces (2026-07-24).\n')
    expect(await readMemoryFile(dir, 'MEMORY.md')).toContain('[prefs](prefs.md)')

    // Backup holds the pre-dream store; .history carried over and extended.
    const backups = await readdir(join(dir, 'memory-backups'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(dir, 'memory-backups', backups[0]!, 'prefs.md'), 'utf8')).toContain('uses tabs again')
    const history = await readFile(join(memoryDir(dir), MEMORY_HISTORY_FILENAME), 'utf8')
    expect(history).toContain('"source":"dream"')
    expect(history).toContain('"source":"tool"') // pre-adoption rows preserved
  })

  it('never loses a write racing adoption (shared memory-dir lock)', async () => {
    const { dir, store, runner } = await setup({})
    const started = await runner.start('a1', { trigger: 'manual' })
    await settle(store, started.dreamId)

    // Fire a live write and a non-forced adopt concurrently. They share
    // withMemoryDirLock, so whichever wins, the write survives: either it lands
    // first and the fence refuses, or adopt swaps first and the write applies to
    // the new store. The marker must be present in the final live store.
    await Promise.allSettled([
      runner.adopt('a1', started.dreamId, false),
      writeMemoryFile(dir, 'marker.md', '- concurrent write\n', undefined, 'console')
    ])
    expect(await readMemoryFile(dir, 'marker.md')).toContain('concurrent write')
  })

  it('fences adoption against post-snapshot writes unless forced', async () => {
    const { dir, store, runner } = await setup({})
    const started = await runner.start('a1', { trigger: 'manual' })
    await settle(store, started.dreamId)

    await writeMemoryFile(dir, 'prefs.md', '- console edit after snapshot\n', undefined, 'console')
    await expect(runner.adopt('a1', started.dreamId, false)).rejects.toThrow(/changed since/)

    const adopted = await runner.adopt('a1', started.dreamId, true)
    expect(adopted.status).toBe('adopted')
  })

  it('refuses to adopt or discard in the wrong lifecycle state', async () => {
    const { store, runner } = await setup({})
    const started = await runner.start('a1', { trigger: 'manual' })
    await settle(store, started.dreamId)
    await runner.adopt('a1', started.dreamId, false)
    await expect(runner.adopt('a1', started.dreamId, false)).rejects.toThrow(DreamStateError)
    await expect(runner.discard('a1', started.dreamId)).rejects.toThrow(DreamStateError)
  })

  it('discard removes the staging but keeps the job record', async () => {
    const { store, runner } = await setup({})
    const started = await runner.start('a1', { trigger: 'manual' })
    await settle(store, started.dreamId)
    const discarded = await runner.discard('a1', started.dreamId)
    expect(discarded.status).toBe('discarded')
    expect(await runner.stagedFiles('a1', started.dreamId)).toBeNull()
    expect(store.dreams.get(started.dreamId)?.status).toBe('discarded')
  })
})

describe('DreamRunner crash recovery', () => {
  it('fails interrupted dreams at boot', async () => {
    const store = new FakeStore()
    store.insertDream({
      dreamId: 'drm-stale',
      agentId: 'a1',
      status: 'running',
      trigger: 'manual',
      sessionIds: [],
      snapshotDigest: 'sha256:x',
      createdAt: new Date().toISOString()
    })
    new DreamRunner({
      agentDirByAgent: () => undefined,
      dreamingPolicyFor: () => undefined,
      store,
      extract: async () => '',
      log: silent
    })
    expect(store.dreams.get('drm-stale')).toMatchObject({
      status: 'failed',
      error: { type: 'daemon_restart' }
    })
  })
})
