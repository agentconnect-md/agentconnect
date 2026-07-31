import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DreamInfo, MemoryDreamingPolicy } from '@agentconnect.md/protocol'
import { parse as parseYaml } from 'yaml'
import {
  DreamRunner,
  DreamStateError,
  type DreamExtractionResult,
  type DreamLifecycleEvent,
  type DreamStorePort
} from '../src/agents/dream-runner.js'
import { LocalStore } from '../src/store/local-store.js'
import { appendDistilledMemories } from '../src/agents/memory-distiller.js'
import {
  ensureMemory,
  readMemoryFile,
  writeMemoryFile,
  MEMORY_HISTORY_FILENAME,
  MEMORY_INDEX,
  MAX_MEMORY_FILE_BYTES,
  memoryDir,
  type MemoryHistoryRecord
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
  pendingSkillDreams(agentId: string, limit: number): DreamInfo[] {
    return [...this.dreams.values()]
      .filter((dream) => dream.agentId === agentId && dream.skills?.some((skill) => skill.state === 'proposed'))
      .slice(0, limit)
  }
  organizationSuggestionDreams(limit: number): DreamInfo[] {
    return [...this.dreams.values()]
      .filter((dream) => dream.organizationSuggestions?.some((suggestion) => suggestion.state === 'proposed'))
      .slice(0, limit)
  }
  openDreams(): DreamInfo[] {
    return [...this.dreams.values()].filter((d) => d.status === 'pending' || d.status === 'running')
  }
  completedDreams(agentId: string): DreamInfo[] {
    return [...this.dreams.values()].filter((d) => d.agentId === agentId && d.status === 'completed')
  }
  supersededDreams(): DreamInfo[] {
    return [...this.dreams.values()].filter((d) => d.status === 'superseded')
  }
  dreamSessionSources(): { sessionId: string; channel: string; thread: string }[] {
    return this.sources
  }
  /** Sessions excluded from agent-memory capture (session-visibility.md §5.1).
   *  Empty by default; a test adds an id to assert dreams skip private sources. */
  captureExcluded = new Set<string>()
  isCaptureExcluded(acpSessionId: string | undefined): boolean {
    return acpSessionId !== undefined && this.captureExcluded.has(acpSessionId)
  }
  toolRows: { sender: string; text: string; kind?: string }[] = []
  dreamTranscriptText(
    _c: string,
    _t: string,
    _a: string,
    _l: number,
    includeTools?: boolean
  ): { sender: string; text: string; kind?: string }[] {
    return includeTools ? [...this.rows, ...this.toolRows] : this.rows
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
  extractionResult?: DreamExtractionResult
  onEvent?: (event: DreamLifecycleEvent) => void
  findOrganizationKnowledge?: NonNullable<ConstructorParameters<typeof DreamRunner>[0]['findOrganizationKnowledge']>
  onOrganizationSuggestions?: () => void | Promise<void>
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
      if (opts.extractionResult) return opts.extractionResult
      const output = opts.extract ? await opts.extract(agentId, systemPrompt, prompt, signal) : PROPOSAL
      return { output }
    },
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    ...(opts.findOrganizationKnowledge ? { findOrganizationKnowledge: opts.findOrganizationKnowledge } : {}),
    ...(opts.onOrganizationSuggestions ? { onOrganizationSuggestions: opts.onOrganizationSuggestions } : {}),
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

  it('keeps extraction correlation, usage, and lifecycle events on the job', async () => {
    const events: DreamLifecycleEvent[] = []
    const { store, runner } = await setup({
      extractionResult: {
        output: PROPOSAL,
        sessionId: 'dream-session-1',
        runtime: 'codex',
        model: 'gpt-5.6',
        stopReason: 'end_turn',
        usage: {
          totalTokens: 120,
          inputTokens: 90,
          outputTokens: 30,
          costAmount: 0.012,
          costCurrency: 'USD'
        }
      },
      onEvent: (event) => events.push(event)
    })

    const started = await runner.start('a1', { trigger: 'manual' })
    const done = await settle(store, started.dreamId)

    expect(done).toMatchObject({
      status: 'completed',
      executionSessionId: 'dream-session-1',
      runtime: 'codex',
      model: 'gpt-5.6',
      stopReason: 'end_turn',
      usage: {
        totalTokens: 120,
        inputTokens: 90,
        outputTokens: 30,
        costAmount: 0.012,
        costCurrency: 'USD'
      }
    })
    expect(done.usage?.inputBytes).toBeGreaterThan(0)
    expect(done.usage?.outputBytes).toBeGreaterThan(0)
    expect(events.map((event) => event.type)).toEqual(['memory.dream.started', 'memory.dream.completed'])
    expect(events[1]?.dream.executionSessionId).toBe('dream-session-1')
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
      extract: async () => ({ output: PROPOSAL }),
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
      extract: async () => ({ output: PROPOSAL }),
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
    let markFirstExtractionReady!: () => void
    const firstExtractionReady = new Promise<void>((resolve) => {
      markFirstExtractionReady = resolve
    })
    const { store, runner } = await setup({
      cancelGraceMs: 20,
      extract: (_a, _s, _p, _signal) => {
        if (calls++ > 0) return Promise.resolve(PROPOSAL)
        markFirstExtractionReady()
        return new Promise<string>(() => {}) // never resolves, ignores abort
      }
    })
    const first = await runner.start('a1', { trigger: 'manual' })
    await firstExtractionReady
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

  it('records the exact add, update, and delete set with live before snapshots', async () => {
    const proposal = JSON.stringify({
      index: '# Memory\n- [prefs](prefs.md)\n- [fresh](fresh.md)',
      files: [
        { path: 'prefs.md', content: '- consolidated preference' },
        { path: 'fresh.md', content: '- newly learned fact' }
      ]
    })
    const { dir, store, runner } = await setup({ extract: async () => proposal })
    await writeMemoryFile(dir, 'obsolete.md', '- no longer relevant\n', undefined, 'tool')
    const started = await runner.start('a1', { trigger: 'manual' })
    await settle(store, started.dreamId)

    await runner.adopt('a1', started.dreamId, false)

    const history = (await readFile(join(memoryDir(dir), MEMORY_HISTORY_FILENAME), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as MemoryHistoryRecord)
    const adoption = history.filter((event) => event.source === 'dream')

    expect(adoption).toContainEqual(
      expect.objectContaining({
        path: 'prefs.md',
        event: 'update',
        before: '- uses tabs\n- uses tabs again\n',
        after: '- consolidated preference\n'
      })
    )
    expect(adoption).toContainEqual(
      expect.objectContaining({
        path: 'fresh.md',
        event: 'add',
        after: '- newly learned fact\n'
      })
    )
    expect(adoption.find((event) => event.path === 'fresh.md')).not.toHaveProperty('before')
    expect(adoption).toContainEqual(
      expect.objectContaining({
        path: 'obsolete.md',
        event: 'delete',
        before: '- no longer relevant\n',
        after: ''
      })
    )
  })

  it.each([
    ['a valid final row without a newline', false],
    ['a torn partial tail', true]
  ])('repairs %s before adding every dream history row', async (_description, torn) => {
    const { dir, store, runner } = await setup({})
    const started = await runner.start('a1', { trigger: 'manual' })
    await settle(store, started.dreamId)
    const legacy = {
      path: 'prefs.md',
      event: 'add',
      after: '- legacy preference',
      at: '2026-01-01T00:00:00.000Z',
      scope: 'agent',
      source: 'tool'
    }
    const historyPath = join(memoryDir(dir), MEMORY_HISTORY_FILENAME)
    await writeFile(historyPath, `${JSON.stringify(legacy)}${torn ? '\n{"path":' : ''}`, 'utf8')

    await runner.adopt('a1', started.dreamId, false)

    const history = (await readFile(historyPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { path: string; source: string; after: string })
    expect(
      history
        .filter((event) => event.source === 'dream')
        .map((event) => event.path)
        .sort()
    ).toEqual([MEMORY_INDEX, 'prefs.md'])
    expect(history).toContainEqual(expect.objectContaining({ source: 'tool', after: '- legacy preference' }))
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
    const history = (await readFile(join(memoryDir(dir), MEMORY_HISTORY_FILENAME), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as MemoryHistoryRecord)
    expect(history.filter((event) => event.source === 'dream' && event.path === 'prefs.md')).toContainEqual(
      expect.objectContaining({
        event: 'update',
        before: '- console edit after snapshot\n',
        after: '- Uses tabs, not spaces (2026-07-24).\n'
      })
    )
  })

  it('auto-adopts completed results without a runtime trust gate', async () => {
    const settleAdoption = async (store: FakeStore, dreamId: string) => {
      // Auto-adopt runs after the run promise settles (the reservation must be
      // free first), so poll past `completed` for the terminal state.
      for (let i = 0; i < 100; i++) {
        if (store.dreams.get(dreamId)?.status === 'adopted') break
        await new Promise((r) => setTimeout(r, 5))
      }
      return store.dreams.get(dreamId)!
    }

    const result = await setup({ policy: { enabled: true, autoAdopt: true } })
    const started = await result.runner.start('a1', { trigger: 'schedule' })
    await settle(result.store, started.dreamId)
    expect((await settleAdoption(result.store, started.dreamId)).status).toBe('adopted')
    // The live store really was replaced, unattended.
    expect(await readMemoryFile(result.dir, 'prefs.md')).toContain('Uses tabs, not spaces (2026-07-24).')
  })

  it('leaves the dream reviewable when auto-adopt hits an unrebasable fence', async () => {
    const { dir, store, runner } = await setup({
      policy: { enabled: true, autoAdopt: true },
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

  it('keeps a superseded proposal unadoptable after later distillation', async () => {
    // Adoption makes B explicitly superseded. A later distill write must not
    // make that stale proposal look rebaseable or restore it to review.
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

    expect(store.dreams.get(b.dreamId)?.status).toBe('superseded')
    await expect(runner.adopt('a1', b.dreamId, false)).rejects.toThrow(/superseded/)
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

  it('supersedes every competing completed proposal after an adoption', async () => {
    const { store, runner } = await setup({})
    const older = await runner.start('a1', { trigger: 'manual' })
    await settle(store, older.dreamId)
    const chosen = await runner.start('a1', { trigger: 'manual' })
    await settle(store, chosen.dreamId)

    await runner.adopt('a1', chosen.dreamId, false)

    expect(store.dreams.get(chosen.dreamId)?.status).toBe('adopted')
    expect(store.dreams.get(older.dreamId)).toMatchObject({
      status: 'superseded',
      endedAt: store.dreams.get(chosen.dreamId)?.endedAt
    })
    expect(await runner.stagedFiles('a1', older.dreamId)).toBeNull()
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

  it('sweeps reconciled superseded staging while preserving proposed skills', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-dream-reconcile-'))
    const base = join(dir, 'memory-dreams', 'drm-superseded')
    await mkdir(join(base, 'input'), { recursive: true })
    await mkdir(join(base, 'output'), { recursive: true })
    await mkdir(join(base, 'skills', 'keep-me'), { recursive: true })
    await writeFile(join(base, 'output', 'MEMORY.md'), '# stale')
    await writeFile(join(base, 'skills', 'keep-me', 'SKILL.md'), '# keep')
    const store = new FakeStore()
    store.insertDream({
      dreamId: 'drm-superseded',
      agentId: 'a1',
      status: 'superseded',
      trigger: 'manual',
      sessionIds: [],
      snapshotDigest: 'sha256:x',
      skills: [{ name: 'keep-me', description: 'Keep me', state: 'proposed' }],
      createdAt: '2026-07-24T00:00:00.000Z',
      endedAt: '2026-07-24T01:00:00.000Z'
    })

    new DreamRunner({
      agentDirByAgent: (agentId) => (agentId === 'a1' ? dir : undefined),
      dreamingPolicyFor: () => undefined,
      store,
      extract: async () => ({ output: '' }),
      log: silent
    })
    for (let i = 0; i < 20; i++) {
      if (!(await readdir(base)).includes('output')) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    expect(await readdir(base)).toEqual(['skills'])
    expect(await readFile(join(base, 'skills', 'keep-me', 'SKILL.md'), 'utf8')).toBe('# keep')
  })
})

describe('DreamRunner store persistence', () => {
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
      executionSessionId: 'dream-session-1',
      runtime: 'codex',
      model: 'gpt-5.6',
      stopReason: 'end_turn',
      snapshotWrites: { total: 7, nonDistill: 3 },
      usage: {
        inputBytes: 2048,
        outputBytes: 512,
        totalTokens: 120,
        costAmount: 0.012,
        costCurrency: 'USD'
      },
      createdAt: '2026-07-24T00:00:00.000Z'
    }
    store.insertDream(dream)
    expect(store.getDream('a1', 'drm-store-1')).toMatchObject({
      executionSessionId: 'dream-session-1',
      runtime: 'codex',
      model: 'gpt-5.6',
      stopReason: 'end_turn',
      snapshotWrites: { total: 7, nonDistill: 3 },
      usage: { inputBytes: 2048, outputBytes: 512, totalTokens: 120, costAmount: 0.012 }
    })

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
      extract: async () => ({ output: PROPOSAL }),
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

  it('does not let newer terminal rows crowd pending organization suggestions out of inventory', () => {
    const store = new LocalStore(join(mkdtempSync(join(tmpdir(), 'ac-dream-store-')), 'local.sqlite'))
    const candidate = (state: 'proposed' | 'accepted', candidateId: string) => ({
      candidateId,
      kind: 'knowledge' as const,
      operation: 'create' as const,
      title: `candidate-${candidateId}`,
      digest: `sha256:${'a'.repeat(64)}`,
      contentBytes: 1,
      state,
      sessionIds: ['s1'],
      createdAt: '2026-07-24T00:00:00.000Z'
    })
    store.insertDream({
      dreamId: 'older-pending',
      agentId: 'a1',
      status: 'completed',
      trigger: 'manual',
      sessionIds: ['s1'],
      snapshotDigest: 'sha256:pending',
      organizationSuggestions: [candidate('proposed', '11111111-1111-4111-8111-111111111111')],
      createdAt: '2026-07-24T00:00:00.000Z'
    })
    for (let index = 0; index < 4; index += 1) {
      store.insertDream({
        dreamId: `newer-terminal-${index}`,
        agentId: 'a1',
        status: 'completed',
        trigger: 'manual',
        sessionIds: ['s1'],
        snapshotDigest: `sha256:terminal-${index}`,
        organizationSuggestions: [candidate('accepted', `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`)],
        createdAt: `2026-07-24T00:0${index + 1}:00.000Z`
      })
    }

    expect(store.organizationSuggestionDreams(1).map((dream) => dream.dreamId)).toEqual(['older-pending'])
    store.close()
  })
})

describe('DreamRunner organization suggestions', () => {
  const output = JSON.stringify({
    agentMemory: { index: '# Memory', files: [] },
    agentSkills: [],
    organizationKnowledge: [
      {
        operation: 'create',
        title: 'Release policy',
        summary: 'Promotion requirements',
        tags: ['release'],
        content: '# Release\nRequire green checks before promotion.',
        sessionIds: ['sess-1']
      }
    ],
    organizationSkills: []
  })

  it('stages, chunks, inventories, and terminally reconciles a daemon-local body', async () => {
    let convergenceKicks = 0
    const { runner, store } = await setup({
      extract: async () => output,
      onOrganizationSuggestions: () => {
        convergenceKicks += 1
      }
    })
    const started = await runner.start('a1', { trigger: 'manual' })
    const completed = await settle(store, started.dreamId)
    const suggestion = completed.organizationSuggestions?.[0]
    expect(suggestion).toMatchObject({
      kind: 'knowledge',
      operation: 'create',
      title: 'Release policy',
      state: 'proposed',
      sessionIds: ['sess-1']
    })
    expect(runner.organizationSuggestionInventory()).toMatchObject([
      { sourceAgentId: 'a1', dreamId: started.dreamId, candidateId: suggestion!.candidateId }
    ])

    const pieces: Buffer[] = []
    let offset = 0
    let truncated = true
    while (truncated) {
      const chunk = await runner.organizationSuggestionRead({
        sourceAgentId: 'a1',
        dreamId: started.dreamId,
        candidateId: suggestion!.candidateId,
        kind: 'knowledge',
        offset,
        limit: 17
      })
      expect(chunk.exists).toBe(true)
      pieces.push(Buffer.from(chunk.data, 'base64'))
      offset = chunk.nextOffset
      truncated = chunk.truncated
    }
    expect(JSON.parse(Buffer.concat(pieces).toString('utf8'))).toEqual({
      kind: 'knowledge',
      content: '# Release\nRequire green checks before promotion.',
      summary: 'Promotion requirements',
      tags: ['release']
    })

    // Discard governs only the memory proposal; the unresolved organization
    // review remains locally readable and present in reconnect inventory.
    await runner.discard('a1', started.dreamId)
    expect(runner.organizationSuggestionInventory()).toHaveLength(1)
    expect(
      (
        await runner.organizationSuggestionRead({
          sourceAgentId: 'a1',
          dreamId: started.dreamId,
          candidateId: suggestion!.candidateId,
          kind: 'knowledge',
          offset: 0,
          limit: 17
        })
      ).exists
    ).toBe(true)

    await expect(
      runner.organizationSuggestionReview({
        sourceAgentId: 'a1',
        dreamId: started.dreamId,
        candidateId: suggestion!.candidateId,
        state: 'accepted'
      })
    ).resolves.toEqual({ ok: true })
    expect(store.getDream('a1', started.dreamId)?.organizationSuggestions?.[0]?.state).toBe('accepted')
    expect(runner.organizationSuggestionInventory()).toEqual([])
    expect(
      (
        await runner.organizationSuggestionRead({
          sourceAgentId: 'a1',
          dreamId: started.dreamId,
          candidateId: suggestion!.candidateId,
          kind: 'knowledge',
          offset: 0,
          limit: 17
        })
      ).exists
    ).toBe(false)
    expect(convergenceKicks).toBeGreaterThanOrEqual(2)
  })

  it('uses only CP-returned id/revision pairs as update authority and fails open without CP context', async () => {
    const targetId = '33333333-3333-4333-8333-333333333333'
    const updateOutput = JSON.stringify({
      agentMemory: { index: '# Memory', files: [] },
      agentSkills: [],
      organizationKnowledge: [
        {
          operation: 'update',
          targetId,
          targetRevision: 4,
          title: 'Release policy',
          content: '# Release\nRequire two approvals.',
          sessionIds: ['sess-1']
        }
      ],
      organizationSkills: []
    })
    const trusted = await setup({
      extract: async () => updateOutput,
      findOrganizationKnowledge: async () => [
        {
          id: targetId,
          title: 'Release policy',
          summary: null,
          tags: ['release'],
          revision: 4,
          updatedAt: '2026-07-24T00:00:00.000Z',
          content: '# Release',
          truncated: false
        }
      ]
    })
    const trustedStart = await trusted.runner.start('a1', { trigger: 'manual' })
    expect((await settle(trusted.store, trustedStart.dreamId)).organizationSuggestions?.[0]).toMatchObject({
      operation: 'update',
      targetId,
      targetRevision: 4
    })

    const offline = await setup({
      extract: async () => updateOutput,
      findOrganizationKnowledge: async () => {
        throw new Error('offline')
      }
    })
    const offlineStart = await offline.runner.start('a1', { trigger: 'manual' })
    expect((await settle(offline.store, offlineStart.dreamId)).organizationSuggestions).toBeUndefined()
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

describe('DreamRunner skill mining (D-3)', () => {
  const SKILL_PROPOSAL = JSON.stringify({
    index: '# Memory\n- [prefs](prefs.md)',
    files: [{ path: 'prefs.md', content: '- Uses tabs.' }],
    skills: [
      {
        name: 'deploy-staging',
        description: 'Deploy to staging',
        skill: '# Deploy\n1. build\n2. push',
        scripts: [{ path: 'deploy.sh', content: 'echo deploy' }],
        // FakeStore mines exactly one session, so a second citation is invented.
        sessionIds: ['sess-1', 'sess-1']
      }
    ]
  })

  /** A store that mines two sessions, so a candidate can actually be grounded. */
  class TwoSessionStore extends FakeStore {
    override sources = [
      { sessionId: 'sess-1', channel: 'C1', thread: 'T1' },
      { sessionId: 'sess-2', channel: 'C2', thread: 'T2' }
    ]
  }

  const grounded = JSON.stringify({
    index: '# Memory',
    files: [],
    skills: [
      {
        name: 'deploy-staging',
        description: 'Deploy to staging',
        skill: '# Deploy\n1. build\n2. push',
        scripts: [{ path: 'deploy.sh', content: 'echo deploy' }],
        sessionIds: ['sess-1', 'sess-2']
      }
    ]
  })

  async function mining(
    proposal: string,
    store = new TwoSessionStore(),
    onEvent?: (event: DreamLifecycleEvent) => void
  ) {
    const dir = await mkdtemp(join(tmpdir(), 'ac-dream-'))
    ensureMemory(dir, 'bot')
    const runner = new DreamRunner({
      agentDirByAgent: (id) => (id === 'a1' ? dir : undefined),
      dreamingPolicyFor: () => ({ enabled: true, mineSkills: true }),
      store,
      extract: async () => ({ output: proposal }),
      ...(onEvent ? { onEvent } : {}),
      log: silent
    })
    const started = await runner.start('a1', { trigger: 'manual' })
    const done = await settle(store, started.dreamId)
    return { dir, runner, store, dreamId: started.dreamId, done }
  }

  it('stages a grounded candidate as a real skill directory and lists it as proposed', async () => {
    const { dir, runner, dreamId, done } = await mining(grounded)
    expect(done.status).toBe('completed')
    expect(done.skills).toEqual([{ name: 'deploy-staging', description: 'Deploy to staging', state: 'proposed' }])

    // Staged as a standard skill dir, so accepting needs no conversion.
    const staged = await runner.stagedSkill('a1', dreamId, 'deploy-staging')
    expect(staged?.skill).toContain('name: deploy-staging')
    expect(staged?.skill).toContain('# Deploy')
    expect(staged?.scripts).toEqual([{ path: 'deploy.sh', content: 'echo deploy' }])
    // NOT installed — staging is not acceptance.
    await expect(readdir(join(dir, 'skills'))).rejects.toThrow()
  })

  it('does not mine when the agent did not ask for it', async () => {
    const store = new TwoSessionStore()
    const dir = await mkdtemp(join(tmpdir(), 'ac-dream-'))
    ensureMemory(dir, 'bot')
    const prompts: string[] = []
    const runner = new DreamRunner({
      agentDirByAgent: () => dir,
      dreamingPolicyFor: () => ({ enabled: true }), // mineSkills off
      store,
      extract: async (_a, systemPrompt) => {
        prompts.push(systemPrompt)
        return { output: grounded }
      },
      log: silent
    })
    const started = await runner.start('a1', { trigger: 'manual' })
    const done = await settle(store, started.dreamId)
    expect(prompts[0]).not.toContain('extract procedures')
    // Even though the model volunteered skills, none are grounded or recorded.
    expect(done.skills).toBeUndefined()
  })

  it('drops an ungrounded candidate: one real session is not a recurring procedure', async () => {
    const { done } = await mining(SKILL_PROPOSAL, new FakeStore()) // mines only sess-1
    expect(done.status).toBe('completed')
    expect(done.skills).toBeUndefined()
  })

  it('accept copies the skill into the agent-owned tree and marks it accepted', async () => {
    const events: DreamLifecycleEvent[] = []
    const { dir, runner, dreamId } = await mining(grounded, new TwoSessionStore(), (event) => events.push(event))
    const after = await runner.skillAccept('a1', dreamId, 'deploy-staging')
    expect(after.skills?.[0]).toMatchObject({ state: 'accepted' })
    expect(events.at(-1)).toMatchObject({
      type: 'memory.dream.skill_accepted',
      dream: { dreamId, skills: [{ name: 'deploy-staging', state: 'accepted' }] },
      skillName: 'deploy-staging'
    })

    // The canonical copy lands under the agent root — daemon-owned, outside the
    // workspace. Session prep materializes it into the runtime's skill root
    // under symlink containment (see dream-skill-install.test.ts).
    expect(await readFile(join(dir, 'skills', 'deploy-staging', 'SKILL.md'), 'utf8')).toContain('name: deploy-staging')
    // Idempotent — no duplicate lifecycle decision.
    await expect(runner.skillAccept('a1', dreamId, 'deploy-staging')).resolves.toMatchObject({})
    expect(events.filter((event) => event.type === 'memory.dream.skill_accepted')).toHaveLength(1)
  })

  it('an accepted skill survives discarding the dream it came from', async () => {
    // Acceptance COPIES rather than referencing the staging, so tidying up the
    // dream cannot silently uninstall a skill the user already took.
    const { dir, runner, dreamId } = await mining(grounded)
    await runner.skillAccept('a1', dreamId, 'deploy-staging')
    await runner.discard('a1', dreamId)
    expect(await readFile(join(dir, 'skills', 'deploy-staging', 'SKILL.md'), 'utf8')).toContain('name: deploy-staging')
  })

  it('dismiss drops the staging and blocks a later accept; both are idempotent', async () => {
    const { dir, runner, dreamId } = await mining(grounded)
    const after = await runner.skillDismiss('a1', dreamId, 'deploy-staging')
    expect(after.skills?.[0]).toMatchObject({ state: 'dismissed' })
    expect(await runner.stagedSkill('a1', dreamId, 'deploy-staging')).toBeNull()
    // Idempotent, and a dismissed candidate can't be resurrected into an install.
    await expect(runner.skillDismiss('a1', dreamId, 'deploy-staging')).resolves.toMatchObject({})
    await expect(runner.skillAccept('a1', dreamId, 'deploy-staging')).rejects.toThrow(DreamStateError)
  })

  it('rejects an unknown candidate name', async () => {
    const { runner, dreamId } = await mining(grounded)
    await expect(runner.skillAccept('a1', dreamId, 'no-such-skill')).rejects.toThrow(/unknown skill candidate/)
  })
})

describe('DreamRunner skill mining — review findings', () => {
  class TwoSession extends FakeStore {
    override sources = [
      { sessionId: 'sess-1', channel: 'C1', thread: 'T1' },
      { sessionId: 'sess-2', channel: 'C2', thread: 'T2' }
    ]
  }
  const candidate = (over: Record<string, unknown> = {}) => ({
    name: 'deploy-staging',
    description: 'Deploy to staging',
    skill: '# Deploy',
    scripts: [],
    sessionIds: ['sess-1', 'sess-2'],
    ...over
  })
  const proposalWith = (skills: unknown[]) => JSON.stringify({ index: '# Memory', files: [], skills })

  async function mine(opts: { store?: FakeStore; proposal?: string } = {}) {
    const store = opts.store ?? new TwoSession()
    const dir = await mkdtemp(join(tmpdir(), 'ac-dream-'))
    ensureMemory(dir, 'bot')
    const prompts: string[] = []
    const runner = new DreamRunner({
      agentDirByAgent: () => dir,
      dreamingPolicyFor: () => ({ enabled: true, mineSkills: true }),
      store,
      extract: async (_a, _s, prompt) => {
        prompts.push(prompt)
        return { output: opts.proposal ?? proposalWith([candidate()]) }
      },
      log: silent
    })
    const started = await runner.start('a1', { trigger: 'manual' })
    const done = await settle(store, started.dreamId)
    return { dir, runner, store, prompts, dreamId: started.dreamId, done }
  }

  it('feeds tool titles into the mining prompt, and never tool bodies', async () => {
    // A procedure expressed only through repeated commands is invisible in
    // conversational text — the miner must see the trajectory.
    const store = new TwoSession()
    store.rows = [{ sender: 'user-1', text: 'ship it' }]
    store.toolRows = [{ sender: 'agent', text: 'Bash(npm run deploy)', kind: 'tool' }]
    const { prompts } = await mine({ store })
    expect(prompts[0]).toContain('[tool] Bash(npm run deploy)')
    expect(prompts[0]).toContain('ship it')
  })

  it('does not read tool rows at all when mining is off', async () => {
    const store = new TwoSession()
    store.toolRows = [{ sender: 'agent', text: 'Bash(secret-y thing)', kind: 'tool' }]
    const dir = await mkdtemp(join(tmpdir(), 'ac-dream-'))
    ensureMemory(dir, 'bot')
    const prompts: string[] = []
    const runner = new DreamRunner({
      agentDirByAgent: () => dir,
      dreamingPolicyFor: () => ({ enabled: true }), // mining off
      store,
      extract: async (_a, _s, prompt) => {
        prompts.push(prompt)
        return { output: PROPOSAL }
      },
      log: silent
    })
    const started = await runner.start('a1', { trigger: 'manual' })
    await settle(store, started.dreamId)
    expect(prompts[0]).not.toContain('Bash(')
  })

  it('accepts the generated skill with its validated frontmatter intact', async () => {
    const { dir, runner, dreamId } = await mine()
    await runner.skillAccept('a1', dreamId, 'deploy-staging')
    const body = await readFile(join(dir, 'skills', 'deploy-staging', 'SKILL.md'), 'utf8')
    // Frontmatter is daemon-generated from the VALIDATED name/description, so
    // what ships is exactly what the reviewer saw.
    expect(parseYaml(body.split('---')[1] ?? '')).toMatchObject({ name: 'deploy-staging' })
  })

  it('keeps a still-proposed candidate reviewable after the store proposal is discarded', async () => {
    const { runner, dreamId } = await mine()
    await runner.discard('a1', dreamId)
    // The store staging is gone, but the unreviewed recommendation is not.
    expect(await runner.stagedFiles('a1', dreamId)).toBeNull()
    expect(await runner.stagedSkill('a1', dreamId, 'deploy-staging')).not.toBeNull()
    // It remains reviewable (dismissable) rather than being destroyed with the
    // store proposal — the independent lifecycle §7 requires.
    const after = await runner.skillDismiss('a1', dreamId, 'deploy-staging')
    expect(after.skills?.[0]).toMatchObject({ state: 'dismissed' })
    // Once nothing is left to review, the staging is finally swept.
    expect(await runner.stagedSkill('a1', dreamId, 'deploy-staging')).toBeNull()
  })

  it('keeps a still-proposed candidate reviewable when its store proposal is superseded', async () => {
    const first = await mine()
    const chosen = await first.runner.start('a1', { trigger: 'manual' })
    await settle(first.store, chosen.dreamId)

    await first.runner.adopt('a1', chosen.dreamId, false)

    expect(first.store.dreams.get(first.dreamId)?.status).toBe('superseded')
    expect(await first.runner.stagedFiles('a1', first.dreamId)).toBeNull()
    expect(await first.runner.stagedSkill('a1', first.dreamId, 'deploy-staging')).not.toBeNull()
    await first.runner.skillDismiss('a1', first.dreamId, 'deploy-staging')
    expect(await first.runner.stagedSkill('a1', first.dreamId, 'deploy-staging')).toBeNull()
  })

  it('encodes a punctuation-heavy description as a YAML scalar, not raw text', async () => {
    // `Deploy: staging` interpolated raw is invalid YAML; `[a]`/`{x: y}` would
    // parse as a different TYPE than the description the reviewer approved.
    const { runner, dreamId } = await mine({
      proposal: proposalWith([candidate({ description: 'Deploy: staging [fast] {mode: x} # note\nsecond line' })])
    })
    const staged = await runner.stagedSkill('a1', dreamId, 'deploy-staging')
    const frontmatter = staged!.skill.split('---')[1]!
    const parsed = parseYaml(frontmatter) as { name: string; description: string }
    expect(parsed.name).toBe('deploy-staging')
    expect(typeof parsed.description).toBe('string')
    expect(parsed.description).toBe('Deploy: staging [fast] {mode: x} # note second line')
  })

  it('tells the next dream not to re-propose a dismissed candidate', async () => {
    const store = new TwoSession()
    const first = await mine({ store })
    await first.runner.skillDismiss('a1', first.dreamId, 'deploy-staging')

    const second = await first.runner.start('a1', { trigger: 'manual' })
    await settle(store, second.dreamId)
    expect(first.prompts.at(-1)).toContain('Previously declined skills')
    expect(first.prompts.at(-1)).toContain('deploy-staging')
  })
})

describe('dreamTranscriptText tool rows (real LocalStore)', () => {
  const CH = 'C1'
  const TH = 'T1'
  const TS = '2026-07-26T00:00:00.000Z'

  function storeWithPeerToolRow() {
    const store = new LocalStore(join(mkdtempSync(join(tmpdir(), 'ac-tt-')), 'local.sqlite'))
    // A shared-thread message DELIVERED to our agent…
    store.appendTranscript({
      channel: CH,
      thread: TH,
      ts: TS,
      sender: 'user-1',
      kind: 'text',
      text: 'ship it',
      recipient: 'me'
    })
    // …and a PEER's private tool row that happens to share the same ts. Internal
    // rows are not deduped by ts, so this collision is ordinary, not contrived.
    store.insertToolCall({
      channel: CH,
      thread: TH,
      ts: TS,
      sender: 'peer-agent',
      toolCallId: 'tc-peer',
      title: 'Bash(peer-secret-command)',
      body: JSON.stringify({ rawInput: 'peer-secret-command --token hunter2', rawOutput: 'peer output' })
    })
    // Our own tool row.
    store.insertToolCall({
      channel: CH,
      thread: TH,
      ts: '2026-07-26T00:00:01.000Z',
      sender: 'me',
      toolCallId: 'tc-mine',
      title: 'Bash',
      body: JSON.stringify({ rawInput: 'npm run deploy --prod', rawOutput: 'lots of build output' })
    })
    return store
  }

  it('never returns a peer-private tool row via the shared delivery table', () => {
    const store = storeWithPeerToolRow()
    const rows = store.dreamTranscriptText(CH, TH, 'me', 100, true)
    const text = rows.map((r) => `${r.text} ${r.input ?? ''}`).join('\n')
    expect(text).not.toContain('peer-secret-command')
    expect(text).not.toContain('hunter2')
    // Our own rows are still there — the guard must not over-filter.
    expect(text).toContain('ship it')
    expect(text).toContain('npm run deploy --prod')
    store.close()
  })

  it('carries a bounded rawInput so a generic title still identifies the command', () => {
    const store = storeWithPeerToolRow()
    const mine = store.dreamTranscriptText(CH, TH, 'me', 100, true).find((r) => r.kind === 'tool')
    expect(mine?.text).toBe('Bash') // the title alone says nothing
    expect(mine?.input).toBe('npm run deploy --prod')
    // rawOutput is the bulk/secret-bearing half and never leaves the store.
    expect(JSON.stringify(mine)).not.toContain('build output')
    store.close()
  })

  it('omits tool rows entirely when mining is off', () => {
    const store = storeWithPeerToolRow()
    const rows = store.dreamTranscriptText(CH, TH, 'me', 100)
    expect(rows.every((r) => r.kind !== 'tool')).toBe(true)
    expect(rows.map((r) => r.text)).toContain('ship it')
    store.close()
  })
})
