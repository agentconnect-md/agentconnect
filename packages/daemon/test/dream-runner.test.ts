import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DreamInfo, MemoryDreamingPolicy } from '@agentconnect.md/protocol'
import { DreamRunner, DreamStateError, type DreamStorePort } from '../src/agents/dream-runner.js'
import { LocalStore } from '../src/store/local-store.js'
import { appendDistilledMemories } from '../src/agents/memory-distiller.js'
import {
  ensureMemory,
  readMemoryFile,
  writeMemoryFile,
  MEMORY_HISTORY_FILENAME,
  MEMORY_INDEX,
  MAX_MEMORY_FILE_BYTES,
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
  extract?: (agentId: string, systemPrompt: string, prompt: string, signal: AbortSignal) => Promise<string>
  policy?: MemoryDreamingPolicy
  cancelGraceMs?: number
  trustedExtraction?: boolean
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
    extract: async (agentId, systemPrompt, prompt, signal) => {
      prompts.push({ systemPrompt, prompt })
      const output = opts.extract ? await opts.extract(agentId, systemPrompt, prompt, signal) : PROPOSAL
      // The producing host's verdict rides WITH the output (a later host swap
      // must not be able to retro-authorize an untrusted proposal).
      return { output, trustedChannel: opts.trustedExtraction ?? false }
    },
    ...(opts.cancelGraceMs !== undefined ? { cancelGraceMs: opts.cancelGraceMs } : {}),
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
      extract: async () => ({ output: PROPOSAL, trustedChannel: false }),
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
    // that lands mid-staging. The post-stage recheck must honor it. The closure
    // reads `runner` only when invoked (after the const is initialized), so the
    // forward self-reference is safe.
    const dir = await mkdtemp(join(tmpdir(), 'ac-dream-'))
    ensureMemory(dir, 'bot')
    await writeMemoryFile(dir, 'prefs.md', '- seed\n', undefined, 'tool')
    const store = new FakeStore()
    const runner = new DreamRunner({
      agentDirByAgent: () => dir,
      dreamingPolicyFor: () => ({ enabled: true }),
      store,
      extract: async () => ({ output: PROPOSAL, trustedChannel: false }),
      onStaged: (agentId, dreamId) => {
        runner.cancel(agentId, dreamId) // cancel after staging, before completion
      },
      log: silent
    })
    const started = await runner.start('a1', { trigger: 'manual' })
    const done = await settle(store, started.dreamId)
    expect(done.status).toBe('canceled') // NOT overwritten to completed
    // The staging removal in run() runs a tick after the status flips settle()
    // observes; poll until it lands (stagedFiles tolerates the concurrent rm).
    let staged = await runner.stagedFiles('a1', started.dreamId)
    for (let i = 0; i < 50 && staged !== null; i++) {
      await new Promise((r) => setTimeout(r, 5))
      staged = await runner.stagedFiles('a1', started.dreamId)
    }
    expect(staged).toBeNull() // partial output dropped
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

  it('backstops a runtime that ignores cancel: abandons the extraction and frees the agent', async () => {
    // The extraction never settles and never honors the abort signal — models an
    // ACP runtime that drops session/cancel. The runner's grace window must still
    // release the reservation so a replacement dream can run.
    let calls = 0
    const { store, runner } = await setup({
      cancelGraceMs: 20,
      extract: (_a, _s, _p, _signal) => {
        if (calls++ > 0) return Promise.resolve(PROPOSAL)
        return new Promise<string>(() => {}) // never resolves, ignores abort
      }
    })
    const first = await runner.start('a1', { trigger: 'manual' })
    await new Promise((r) => setTimeout(r, 10))
    runner.cancel('a1', first.dreamId)
    const done = await settle(store, first.dreamId)
    expect(done.status).toBe('canceled')

    // Within the grace window the reservation frees even though extract hangs.
    let second: { dreamId: string } | undefined
    for (let i = 0; i < 100 && !second; i++) {
      try {
        second = await runner.start('a1', { trigger: 'manual' })
      } catch {
        await new Promise((r) => setTimeout(r, 5))
      }
    }
    expect(second).toBeDefined()
    await settle(store, second!.dreamId)
    expect(store.dreams.get(second!.dreamId)?.status).toBe('completed')
  })

  it('cancel aborts the extraction signal and releases the reservation for a replacement', async () => {
    // A "hung" extraction that only settles when its abort signal fires — models
    // the daemon driving host.cancel() on abort. Without the abort wiring this
    // never resolves and the one-in-flight reservation is pinned forever.
    let sawAbort = false
    let calls = 0
    let markFirstExtractionReady!: () => void
    const firstExtractionReady = new Promise<void>((resolve) => {
      markFirstExtractionReady = resolve
    })
    const { store, runner } = await setup({
      extract: (_a, _s, _p, signal) => {
        // First extraction hangs until aborted; the replacement completes normally.
        if (calls++ > 0) return Promise.resolve(PROPOSAL)
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            sawAbort = true
            reject(new Error('aborted'))
          })
          markFirstExtractionReady()
        })
      }
    })
    const first = await runner.start('a1', { trigger: 'manual' })
    await firstExtractionReady
    runner.cancel('a1', first.dreamId)
    const done = await settle(store, first.dreamId)
    expect(sawAbort).toBe(true)
    expect(done.status).toBe('canceled')

    // The reservation is released once the aborted extraction settles (the run
    // promise's finally), which lands a tick after the status flip — retry until
    // a replacement can start, proving the agent is no longer pinned.
    let second: { dreamId: string } | undefined
    for (let i = 0; i < 50 && !second; i++) {
      try {
        second = await runner.start('a1', { trigger: 'manual' })
      } catch {
        await new Promise((r) => setTimeout(r, 5))
      }
    }
    expect(second).toBeDefined()
    expect(second!.dreamId).not.toBe(first.dreamId)
    await settle(store, second!.dreamId)
    expect(store.dreams.get(second!.dreamId)?.status).toBe('completed')
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

  it('auto-adopts on a trusted runtime, but leaves an untrusted one for review', async () => {
    const settleAdoption = async (store: FakeStore, dreamId: string) => {
      // Auto-adopt runs after the run promise settles (the reservation must be
      // free first), so poll past `completed` for the terminal state.
      for (let i = 0; i < 100; i++) {
        if (store.dreams.get(dreamId)?.status === 'adopted') break
        await new Promise((r) => setTimeout(r, 5))
      }
      return store.dreams.get(dreamId)!
    }

    const trusted = await setup({ policy: { enabled: true, autoAdopt: true }, trustedExtraction: true })
    const a = await trusted.runner.start('a1', { trigger: 'schedule' })
    await settle(trusted.store, a.dreamId)
    expect((await settleAdoption(trusted.store, a.dreamId)).status).toBe('adopted')
    // The live store really was replaced, unattended.
    expect(await readMemoryFile(trusted.dir, 'prefs.md')).toContain('Uses tabs, not spaces (2026-07-24).')

    // Same policy, untrusted channel ⇒ gate holds; the dream stays reviewable.
    const untrusted = await setup({ policy: { enabled: true, autoAdopt: true }, trustedExtraction: false })
    const b = await untrusted.runner.start('a1', { trigger: 'schedule' })
    await settle(untrusted.store, b.dreamId)
    await new Promise((r) => setTimeout(r, 40))
    expect(untrusted.store.dreams.get(b.dreamId)?.status).toBe('completed')
    expect(await readMemoryFile(untrusted.dir, 'prefs.md')).toBe('- uses tabs\n- uses tabs again\n')
  })

  it('leaves the dream reviewable when auto-adopt hits an unrebasable fence', async () => {
    const { dir, store, runner } = await setup({
      policy: { enabled: true, autoAdopt: true },
      trustedExtraction: true,
      // Hold the extraction open so a console write lands inside the dream window.
      extract: async () => {
        await writeMemoryFile(dir, 'notes.md', '- human note mid-dream\n', undefined, 'console')
        return PROPOSAL
      }
    })
    const started = await runner.start('a1', { trigger: 'schedule' })
    await settle(store, started.dreamId)
    await new Promise((r) => setTimeout(r, 40))

    // Auto-adopt must not force past a console write — it stays completed.
    expect(store.dreams.get(started.dreamId)?.status).toBe('completed')
    expect(await readMemoryFile(dir, 'notes.md')).toContain('human note mid-dream')
  })

  it('refuses to rebase across a daemon restart (generation, not just counts)', async () => {
    // Set up a window whose COUNTS alone would authorize a rebase (only a distill
    // write since the snapshot), then stamp the snapshot with a foreign
    // generation. Numeric comparison cannot see a restart — the counters reset,
    // so a {0,0} snapshot never moves backwards and any older one is eventually
    // caught up — which is how a pre-restart human edit could be replayed as
    // post-restart distillation. Only the generation stamp catches it.
    const { dir, store, runner } = await setup({})
    const started = await runner.start('a1', { trigger: 'manual' })
    await settle(store, started.dreamId)
    await writeMemoryFile(dir, 'prefs.md', '- uses tabs\n- distilled after\n', undefined, 'distill')

    const dream = store.dreams.get(started.dreamId)!
    // Same counts (so the count checks still pass), different daemon process.
    store.dreams.set(started.dreamId, {
      ...dream,
      snapshotWrites: { ...dream.snapshotWrites!, generation: 'a-previous-daemon' }
    })

    await expect(runner.adopt('a1', started.dreamId, false)).rejects.toThrow(/changed since/)
  })

  it('fences a second dream staged from the same snapshot as an already-adopted one', async () => {
    // Adoption rewrites the store by rename, bypassing writeMemoryFile. Unless
    // that swap is counted, dream B (same snapshot as A) sees only the later
    // distill write, calls the drift distill-only, and rolls over A's adoption.
    const { dir, store, runner } = await setup({})
    const a = await runner.start('a1', { trigger: 'manual' })
    await settle(store, a.dreamId)
    // B snapshots the same live store, before A is adopted.
    const b = await runner.start('a1', { trigger: 'manual' })
    await settle(store, b.dreamId)

    await runner.adopt('a1', a.dreamId, false)
    await writeMemoryFile(
      dir,
      'prefs.md',
      '- Uses tabs, not spaces (2026-07-24).\n- later distilled\n',
      undefined,
      'distill'
    )

    await expect(runner.adopt('a1', b.dreamId, false)).rejects.toThrow(/changed since/)
  })

  it('refuses to rebase over a write whose history append was lost (ledger is authoritative)', async () => {
    // `.history` is best-effort: appendHistory swallows its errors. Simulate a
    // console write whose append was lost, then a distill write that logged
    // fine. A history-based window would look distill-only and roll over the
    // human edit; the write ledger counts it and must refuse.
    const { dir, store, runner } = await setup({})
    const started = await runner.start('a1', { trigger: 'manual' })
    await settle(store, started.dreamId)

    await writeMemoryFile(dir, 'notes.md', '- human note\n', undefined, 'console')
    // Erase the console row from the log, leaving only the distill one.
    const historyPath = join(memoryDir(dir), MEMORY_HISTORY_FILENAME)
    const kept = (await readFile(historyPath, 'utf8'))
      .split('\n')
      .filter((line) => !line.includes('"source":"console"'))
      .join('\n')
    await writeFile(historyPath, kept, 'utf8')
    await writeMemoryFile(dir, 'prefs.md', '- uses tabs\n- distilled later\n', undefined, 'distill')

    await expect(runner.adopt('a1', started.dreamId, false)).rejects.toThrow(/changed since/)
    expect(await readMemoryFile(dir, 'notes.md')).toContain('human note')
  })

  it('refuses a rebase that would push a staged file past its byte cap', async () => {
    // A proposal that is already at capacity plus one distilled line must not
    // adopt an over-limit store the ordinary write path could never produce.
    const atCap = '- ' + 'x'.repeat(MAX_MEMORY_FILE_BYTES - 4)
    const { dir, store, runner } = await setup({
      extract: async () =>
        JSON.stringify({ index: '# Memory\n- [prefs](prefs.md)', files: [{ path: 'prefs.md', content: atCap }] })
    })
    const started = await runner.start('a1', { trigger: 'manual' })
    await settle(store, started.dreamId)

    await writeMemoryFile(dir, 'prefs.md', '- uses tabs\n- one more distilled line\n', undefined, 'distill')
    await expect(runner.adopt('a1', started.dreamId, false)).rejects.toThrow(/changed since/)
  })

  it('rebases distill-only drift onto the staged store instead of refusing (§8)', async () => {
    const { dir, store, runner } = await setup({})
    const started = await runner.start('a1', { trigger: 'manual' })
    await settle(store, started.dreamId)

    // Per-turn capture landed a NEW fact while the dream ran. The digest now
    // differs, but every post-snapshot .history row is distill-sourced, so the
    // fence must rebase rather than refuse.
    await writeMemoryFile(dir, 'prefs.md', '- uses tabs\n- prefers pnpm over npm\n', undefined, 'distill')

    const adopted = await runner.adopt('a1', started.dreamId, false)
    expect(adopted.status).toBe('adopted')

    // The dream's consolidation AND the distilled addition are both present.
    const prefs = await readMemoryFile(dir, 'prefs.md')
    expect(prefs).toContain('Uses tabs, not spaces (2026-07-24).') // the dream's rewrite
    expect(prefs).toContain('prefers pnpm over npm') // the rebased distill line
  })

  it('still hard-fences when any post-snapshot write is not distill-sourced', async () => {
    const { dir, store, runner } = await setup({})
    const started = await runner.start('a1', { trigger: 'manual' })
    await settle(store, started.dreamId)

    // A distill write is rebasable, but the console write in the same window is
    // not — a mixed window must refuse rather than silently drop the edit.
    await writeMemoryFile(dir, 'prefs.md', '- uses tabs\n- distilled\n', undefined, 'distill')
    await writeMemoryFile(dir, 'notes.md', '- a human wrote this\n', undefined, 'console')

    await expect(runner.adopt('a1', started.dreamId, false)).rejects.toThrow(/changed since/)
    expect(await readMemoryFile(dir, 'notes.md')).toContain('a human wrote this')
  })

  it('does not re-add a distilled line the dream already folded in', async () => {
    const { dir, store, runner } = await setup({})
    const started = await runner.start('a1', { trigger: 'manual' })
    await settle(store, started.dreamId)

    // The distiller re-states, in its own words, the very fact the dream wrote.
    await writeMemoryFile(dir, 'prefs.md', '- uses tabs\n- Uses tabs, not spaces (2026-07-24).\n', undefined, 'distill')
    await runner.adopt('a1', started.dreamId, false)

    const prefs = await readMemoryFile(dir, 'prefs.md')
    expect(prefs.match(/Uses tabs, not spaces/g)).toHaveLength(1) // deduped, not doubled
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

describe('DreamRunner store + trust binding', () => {
  it('round-trips snapshotWrites through the real LocalStore (not just the fake)', async () => {
    // Regression: the runner wrote `snapshotWrites`, but if LocalStore's schema
    // and mappers omit it the value is dropped on insert and EVERY production
    // rebase silently fails closed — invisible to FakeStore-based tests.
    const store = new LocalStore(join(await mkdtemp(join(tmpdir(), 'ac-dream-store-')), 'local.sqlite'))
    const dream: DreamInfo = {
      dreamId: 'drm-store-1',
      agentId: 'a1',
      status: 'pending',
      trigger: 'manual',
      sessionIds: ['s1'],
      snapshotDigest: 'sha256:abc',
      snapshotWrites: { total: 7, nonDistill: 3 },
      createdAt: '2026-07-24T00:00:00.000Z'
    }
    store.insertDream(dream)
    expect(store.getDream('a1', 'drm-store-1')?.snapshotWrites).toEqual({ total: 7, nonDistill: 3 })

    // …and survives the status updates the pipeline makes on the way to adoption.
    store.updateDream({ ...dream, status: 'completed', endedAt: '2026-07-24T00:05:00.000Z' })
    expect(store.getDream('a1', 'drm-store-1')?.snapshotWrites).toEqual({ total: 7, nonDistill: 3 })
    expect(store.listDreams('a1', 10)[0]?.snapshotWrites).toEqual({ total: 7, nonDistill: 3 })
    store.close()
  })

  it('the real runner persists snapshotWrites end to end', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-dream-'))
    ensureMemory(dir, 'bot')
    await writeMemoryFile(dir, 'prefs.md', '- uses tabs\n', undefined, 'tool')
    const store = new LocalStore(join(await mkdtemp(join(tmpdir(), 'ac-dream-store-')), 'local.sqlite'))
    const runner = new DreamRunner({
      agentDirByAgent: () => dir,
      dreamingPolicyFor: () => ({ enabled: true }),
      store,
      extract: async () => ({ output: PROPOSAL, trustedChannel: false }),
      log: silent
    })
    const started = await runner.start('a1', { trigger: 'manual' })
    expect(store.getDream('a1', started.dreamId)?.snapshotWrites).toBeDefined()
    for (let i = 0; i < 200; i++) {
      const status = store.getDream('a1', started.dreamId)?.status
      if (status && status !== 'pending' && status !== 'running') break
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(store.getDream('a1', started.dreamId)?.snapshotWrites).toBeDefined()
    store.close()
  })

  it('binds auto-adopt to the extracting host, so a later trust flip cannot authorize it', async () => {
    // The untrusted host produced the proposal; the agent's host is replaced by a
    // trusted one while staging runs. Auto-adopt must honor the ORIGINAL verdict.
    const dir = await mkdtemp(join(tmpdir(), 'ac-dream-'))
    ensureMemory(dir, 'bot')
    await writeMemoryFile(dir, 'prefs.md', '- uses tabs\n', undefined, 'tool')
    const store = new FakeStore()
    let hostIsTrusted = false
    const runner = new DreamRunner({
      agentDirByAgent: () => dir,
      dreamingPolicyFor: () => ({ enabled: true, autoAdopt: true }),
      store,
      extract: async () => ({ output: PROPOSAL, trustedChannel: hostIsTrusted }),
      onStaged: () => {
        hostIsTrusted = true // host replaced mid-flight by a trusted one
      },
      log: silent
    })
    const started = await runner.start('a1', { trigger: 'manual' })
    await settle(store, started.dreamId)
    await new Promise((r) => setTimeout(r, 40))

    expect(store.dreams.get(started.dreamId)?.status).toBe('completed') // NOT adopted
    expect(await readMemoryFile(dir, 'prefs.md')).toBe('- uses tabs\n')
  })
})

describe('capture/adoption serialization', () => {
  it('a distillation batch and an adoption cannot interleave (stale index never wins)', async () => {
    // appendDistilledMemories reads the index once, then writes a topic and the
    // index. If those were separate critical sections, an adoption landing
    // between them would be clobbered by the batch's stale index. The batch now
    // holds the memory-dir lock end to end, so the two serialize either way
    // round — and the adopted index survives.
    const { dir, store, runner } = await setup({})
    const started = await runner.start('a1', { trigger: 'manual' })
    await settle(store, started.dreamId)

    // Fire capture and adoption concurrently at the same store.
    const [, adoptResult] = await Promise.allSettled([
      appendDistilledMemories(dir, [{ topic: 'captured.md', content: 'a captured fact' }]),
      runner.adopt('a1', started.dreamId, false)
    ])

    const index = await readMemoryFile(dir, MEMORY_INDEX)
    if (adoptResult.status === 'fulfilled') {
      // Adoption won the race: its rebuilt index must NOT have been overwritten
      // by the distiller's pre-dream copy.
      expect(index).toContain('[prefs](prefs.md)')
    } else {
      // Capture won: adoption fenced rather than adopting over it — also correct.
      expect(String(adoptResult.reason)).toMatch(/changed since/)
    }
    // Whichever order, the store is never left with a torn index.
    expect(index.trim().length).toBeGreaterThan(0)
  })
})
