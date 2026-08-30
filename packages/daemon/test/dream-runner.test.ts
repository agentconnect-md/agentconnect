import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { DreamInfo, MemoryDreamingPolicy } from '@agentconnect.md/protocol'
import { parse as parseYaml } from 'yaml'
import {
  DREAM_MODEL_READABLE_CREDENTIALS_REASON,
  DREAM_UNBOUND_STAGED_CONTENT_REASON,
  DreamRunner,
  DreamStateError,
  type DreamExtractionResult,
  type DreamLifecycleEvent,
  type DreamStorePort
} from '../src/dream/runner.js'
import { LocalStore } from '../src/store/local-store.js'
import {
  ensureMemory,
  readMemoryFile,
  writeMemoryFile,
  MEMORY_HISTORY_FILENAME,
  MEMORY_INDEX,
  MAX_MEMORY_FILE_BYTES,
  memoryDir,
  type MemoryHistoryRecord
} from '../src/memory/store.js'
import { LocalMemoryFs, MemorySandboxUnavailableError } from '../src/memory/fs.js'
import { acceptedDreamSkillSources } from '../src/skills/dream-skills.js'
import { storeDigest } from '../src/dream/dreamer.js'
import { inspectLocalSkillSource } from '../src/skills/skill-source-snapshot.js'
import type { MemoryFs } from '../src/memory/fs.js'
import { pod } from './fixtures/memory-fs-pod.js'

const local = (dir: string) => new LocalMemoryFs(dir)

const silent = { info() {}, warn() {} }

class FakeStore implements DreamStorePort {
  dreams = new Map<string, DreamInfo>()
  // `updatedAt` is optional in fixtures; dreamSessionSources defaults it to "now"
  // so a source without an explicit time reads as recent (newer than any dream
  // created earlier in a test). Auto-window tests set it explicitly.
  sources: { sessionId: string; channel: string; thread: string; updatedAt?: number }[] = [
    { sessionId: 'sess-1', channel: 'C1', thread: 'T1' }
  ]
  rows: { sender: string; text: string }[] = [{ sender: 'user-1', text: 'please use tabs' }]

  async insertDream(dream: DreamInfo): Promise<void> {
    this.dreams.set(dream.dreamId, dream)
  }
  async updateDream(dream: DreamInfo): Promise<void> {
    this.dreams.set(dream.dreamId, dream)
  }
  async failOpenDream(dream: DreamInfo): Promise<boolean> {
    const current = this.dreams.get(dream.dreamId)
    if (current?.status !== 'pending' && current?.status !== 'running') return false
    this.dreams.set(dream.dreamId, dream)
    return true
  }
  async getDream(_agentId: string, dreamId: string): Promise<DreamInfo | undefined> {
    return this.dreams.get(dreamId)
  }
  async listDreams(agentId: string, limit: number): Promise<DreamInfo[]> {
    return [...this.dreams.values()].filter((d) => d.agentId === agentId).slice(0, limit)
  }
  async pendingSkillDreams(agentId: string, limit: number): Promise<DreamInfo[]> {
    return [...this.dreams.values()]
      .filter((dream) => dream.agentId === agentId && dream.skills?.some((skill) => skill.state === 'proposed'))
      .slice(0, limit)
  }
  async organizationSuggestionDreams(limit: number): Promise<DreamInfo[]> {
    return [...this.dreams.values()]
      .filter((dream) => dream.organizationSuggestions?.some((suggestion) => suggestion.state === 'proposed'))
      .slice(0, limit)
  }
  /** dreamIds this incarnation started. A shared store hands back nothing else at boot. */
  owned?: Set<string>
  async openDreams(): Promise<DreamInfo[]> {
    return [...this.dreams.values()].filter(
      (d) => (d.status === 'pending' || d.status === 'running') && (!this.owned || this.owned.has(d.dreamId))
    )
  }
  async strandedDreams(agentIds: readonly string[]): Promise<DreamInfo[]> {
    return [...this.dreams.values()].filter(
      (d) => agentIds.includes(d.agentId) && (d.status === 'pending' || d.status === 'running')
    )
  }
  // A dream's durable records name their sessions outwardly (§1.1): the fake keeps the mapping
  // explicit so a regression that stores the runtime's id instead is visible in the assertions.
  async getSessionByAcpIdForAgent(_agentId: string, acpSessionId: string): Promise<{ key: string } | undefined> {
    return { key: `key-of-${acpSessionId}` }
  }
  async ensureOutwardSessionId(key: string): Promise<string> {
    return key.replace(/^key-of-/, 'sid-of-')
  }
  async completedDreams(agentId: string): Promise<DreamInfo[]> {
    return [...this.dreams.values()].filter((d) => d.agentId === agentId && d.status === 'completed')
  }
  async supersededDreams(): Promise<DreamInfo[]> {
    return [...this.dreams.values()].filter((d) => d.status === 'superseded')
  }
  async dreamSessionSources(
    _agentId: string,
    _limit: number
  ): Promise<{ sessionId: string; channel: string; thread: string; updatedAt: number }[]> {
    const now = Date.now()
    return this.sources.map((s) => ({ ...s, updatedAt: s.updatedAt ?? now }))
  }
  toolRows: { sender: string; text: string; kind?: string }[] = []
  async dreamTranscriptText(
    _c: string,
    _t: string,
    _a: string,
    _l: number,
    includeTools?: boolean
  ): Promise<{ sender: string; text: string; kind?: string }[]> {
    return includeTools ? [...this.rows, ...this.toolRows] : this.rows
  }
}

// The JSON reply now carries only review-queue proposals; the store itself is what
// the model WROTE through the memory tools, so a fake extraction has to write too.
const PROPOSAL = JSON.stringify({ agentSkills: [], organizationKnowledge: [], organizationSkills: [] })

/** Stand in for the model writing its rebuilt store through the bound memory tools.
 *  Returns the topics written, which is what the daemon reports as provenance. */
async function writeStagedProposal(
  stagedStore: {
    writeFile(path: string, content: string, opts?: unknown): Promise<unknown>
    mkdir(p: string): Promise<unknown>
  },
  files: { path: string; content: string }[] = [{ path: 'prefs.md', content: '- Uses tabs, not spaces (2026-07-24).' }]
): Promise<string[]> {
  await stagedStore.mkdir('memory')
  for (const file of files) {
    const content = file.content.endsWith('\n') ? file.content : `${file.content}\n`
    await stagedStore.writeFile(join('memory', file.path), content, {})
  }
  return files.map((file) => file.path)
}

async function setup(opts: {
  /** Files the fake model writes into the staged store; `null` writes nothing. */
  stagedFiles?: { path: string; content: string }[] | null
  /** Write the staged store exactly as the bound memory tools would, instead. */
  stagedWrite?: (stagedStore: MemoryFs) => Promise<string[]>
  extract?: (agentId: string, systemPrompt: string, prompt: string, signal: AbortSignal) => Promise<string>
  policy?: MemoryDreamingPolicy
  cancelGraceMs?: number
  extractionResult?: DreamExtractionResult
  onEvent?: (event: DreamLifecycleEvent) => void
  onOrganizationSuggestions?: () => void | Promise<void>
  withSkillAcceptance?: (agentId: string, publish: () => Promise<void>) => Promise<void>
  operationPolicy?: NonNullable<ConstructorParameters<typeof DreamRunner>[0]['operationPolicy']>
  now?: () => Date
  /** Put the agent's memory tree on a sandbox volume reached through the shim channel. */
  sandbox?: boolean
}) {
  const dir = await mkdtemp(join(tmpdir(), 'ac-dream-'))
  const sandbox = opts.sandbox ? pod() : undefined
  const root: MemoryFs = sandbox?.fs ?? local(dir)
  await ensureMemory(root, 'bot')
  await writeMemoryFile(root, 'prefs.md', '- uses tabs\n- uses tabs again\n', undefined, 'tool')
  const store = new FakeStore()
  const prompts: { systemPrompt: string; prompt: string; inputDir: string }[] = []
  const runner = new DreamRunner({
    agentDirByAgent: (id) => (id === 'a1' ? dir : undefined),
    memoryFsFor: (id) => (id === 'a1' ? root : undefined),
    dreamingPolicyFor: () => opts.policy ?? { enabled: true },
    operationPolicy: opts.operationPolicy ?? 'test-only',
    store,
    extract: async (agentId, systemPrompt, prompt, signal, context) => {
      prompts.push({ systemPrompt, prompt, inputDir: context.inputDir })
      const stage = async (): Promise<string[]> => {
        if (opts.stagedWrite) return opts.stagedWrite(context.stagedStore)
        if (opts.stagedFiles === null) return []
        return writeStagedProposal(context.stagedStore, opts.stagedFiles)
      }
      if (opts.extractionResult) {
        const memoryTopics = await stage()
        return { memoryTopics, ...opts.extractionResult }
      }
      const output = opts.extract ? await opts.extract(agentId, systemPrompt, prompt, signal) : PROPOSAL
      return { output, memoryTopics: await stage() }
    },
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    ...(opts.onOrganizationSuggestions ? { onOrganizationSuggestions: opts.onOrganizationSuggestions } : {}),
    ...(opts.withSkillAcceptance ? { withSkillAcceptance: opts.withSkillAcceptance } : {}),
    ...(opts.cancelGraceMs !== undefined ? { cancelGraceMs: opts.cancelGraceMs } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    log: silent
  })
  return { dir, store, runner, prompts, sandbox }
}

async function acceptedSkillBody(dir: string, name: string): Promise<string> {
  const source = (await acceptedDreamSkillSources({ dir })).find((entry) => entry.name === name)
  if (!source) throw new Error(`accepted skill ${name} is missing`)
  return readFile(join(source.sourceDir, 'SKILL.md'), 'utf8')
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
  it('auto window: only sessions active since the last successful dream count (else skip)', async () => {
    const { store, runner } = await setup({})
    const dreamAt = '2026-01-02T00:00:00.000Z'
    const cutoff = Date.parse(dreamAt)
    const dream = (status: DreamInfo['status'], sessionIds: string[], dreamId: string): DreamInfo => ({
      dreamId,
      agentId: 'a1',
      status,
      trigger: 'schedule',
      sessionIds,
      snapshotDigest: 'sha256:x',
      createdAt: dreamAt
    })

    // Never dreamed → the first scheduled run always proceeds (no baseline).
    store.sources = [{ sessionId: 'sess-1', channel: 'C1', thread: 'T1', updatedAt: cutoff - 1000 }]
    expect(await runner.hasNewSessionsSinceLastDream('a1')).toBe(true)

    // Last successful dream at `dreamAt`; the only session predates it → skip.
    await store.insertDream(dream('completed', ['sess-1'], 'd1'))
    expect(await runner.hasNewSessionsSinceLastDream('a1')).toBe(false)

    // Millisecond boundary: a session whose updatedAt EQUALS the baseline (e.g.
    // written in the same ms as the dream's createdAt, after the source query)
    // counts as new. The comparison is inclusive (>=) so this is re-mined once
    // rather than dropped forever — "duplicates possible, gaps never".
    store.sources = [{ sessionId: 'sess-1', channel: 'C1', thread: 'T1', updatedAt: cutoff }]
    expect(await runner.hasNewSessionsSinceLastDream('a1')).toBe(true)

    // A session with activity AFTER the last dream → run.
    store.sources = [
      { sessionId: 'sess-2', channel: 'C2', thread: 'T2', updatedAt: cutoff + 1000 },
      { sessionId: 'sess-1', channel: 'C1', thread: 'T1', updatedAt: cutoff - 1000 }
    ]
    expect(await runner.hasNewSessionsSinceLastDream('a1')).toBe(true)

    // Only a FAILED dream exists → no successful baseline → mine everything (run).
    store.dreams.clear()
    await store.insertDream(dream('failed', ['sess-1', 'sess-2'], 'd2'))
    store.sources = [{ sessionId: 'sess-1', channel: 'C1', thread: 'T1', updatedAt: cutoff - 5000 }]
    expect(await runner.hasNewSessionsSinceLastDream('a1')).toBe(true)
  })

  it('stamps the dream baseline before selecting sources (no cutoff-race drop)', async () => {
    // Regression: the dream's createdAt is the cutoff the NEXT automatic dream
    // filters on (updatedAt > cutoff). If it were stamped AFTER the source query,
    // a session that became active between the query and the stamp would be in
    // neither this dream (query already ran) nor any future one (its updatedAt <
    // the new baseline) — a permanent drop. Capturing it first keeps the baseline
    // <= the query time, so such a session is still selectable next time.
    let clock = 1_000
    let queriedAt: number | undefined
    const { store, runner } = await setup({ now: () => new Date(clock++) })
    const realQuery = store.dreamSessionSources.bind(store)
    store.dreamSessionSources = ((agentId: string, limit: number) => {
      queriedAt = clock // the monotonic clock value at the moment sources are read
      return realQuery(agentId, limit)
    }) as typeof store.dreamSessionSources

    const started = await runner.start('a1', { trigger: 'schedule' })
    expect(queriedAt).toBeDefined()
    expect(Date.parse(started.createdAt)).toBeLessThan(queriedAt!)
  })

  it('stages a validated proposal without touching the live store', async () => {
    const { dir, store, runner, prompts } = await setup({})
    const started = await runner.start('a1', { trigger: 'manual' })
    expect(started.status).toBe('pending')
    expect(started.sessionIds).toEqual(['sess-1'])

    const done = await settle(store, started.dreamId)
    expect(done.status).toBe('completed')
    expect(done.usage?.inputBytes).toBeGreaterThan(0)

    // Inputs are materialized as files the model explores with its own tools:
    // the transcript lands in sessions/<id>.md, the memory snapshot at the input
    // root, and the prompt points at them under the untrusted-data system policy.
    const inputDir = prompts[0]!.inputDir
    expect(await readFile(join(inputDir, 'sessions', 'sess-1.md'), 'utf8')).toContain('please use tabs')
    expect(await readFile(join(inputDir, 'prefs.md'), 'utf8')).toContain('uses tabs')
    expect(prompts[0]?.prompt).toContain('sess-1')
    expect(prompts[0]?.systemPrompt).toContain('memory dreamer')

    // Live store untouched; staged output holds the rebuilt store.
    expect(await readMemoryFile(local(dir), 'prefs.md')).toContain('uses tabs again')
    const staged = await runner.stagedFiles('a1', started.dreamId)
    expect(staged?.map((f) => f.name)).toEqual(['MEMORY.md', 'prefs.md'])
    const read = await runner.stagedRead('a1', started.dreamId, 'prefs.md')
    expect(read?.content).toContain('2026-07-24')
  })

  it('stages what the model wrote through the shared write path, indexed by its own headers', async () => {
    // The composed contract: a dream writes with the memory tools bound to its staged
    // store, so the same normalize/stamp/index-regen a turn gets applies there — and a
    // topic the model never rewrote is simply gone, because staging replaces the store.
    const { dir, store, runner } = await setup({
      stagedWrite: async (stagedStore) => {
        await writeMemoryFile(
          stagedStore,
          'deploys.md',
          '---\ndescription: how we ship\n---\n\n- ship from main\n',
          undefined,
          'dream'
        )
        return ['deploys.md']
      }
    })
    const started = await runner.start('a1', { trigger: 'manual' })
    await settle(store, started.dreamId)

    const staged = await runner.stagedFiles('a1', started.dreamId)
    expect(staged?.map((f) => f.name)).toEqual(['MEMORY.md', 'deploys.md'])
    const stagedIndex = await runner.stagedRead('a1', started.dreamId, MEMORY_INDEX)
    expect(stagedIndex?.content).toContain('- [deploys](deploys.md) — how we ship')

    await runner.adopt('a1', started.dreamId, false)
    const adopted = await readMemoryFile(local(dir), 'deploys.md')
    expect(adopted).toContain('name: deploys') // stamped on the way in, not at adoption
    expect(adopted).toMatch(/modified: \d{4}-/)
    expect(await readMemoryFile(local(dir), MEMORY_INDEX)).toBe(stagedIndex?.content)
    expect(await readMemoryFile(local(dir), 'prefs.md')).toBe('')
  })

  it('fails a dream that wrote no memory rather than staging a store that deletes every topic', async () => {
    // The store is what the model wrote, so a parseable reply with zero writes is not
    // an empty proposal — it is no proposal. Completing it would hand auto-adopt an
    // index-only store to install over the live one.
    const { dir, store, runner } = await setup({ stagedFiles: null })
    const started = await runner.start('a1', { trigger: 'manual' })
    const done = await settle(store, started.dreamId)
    expect(done.status).toBe('failed')
    expect(done.error?.type).toBe('empty_proposal')
    expect(await runner.stagedFiles('a1', started.dreamId)).toBeNull()
    expect(await readMemoryFile(local(dir), 'prefs.md')).toContain('uses tabs')
  })

  it('fails a dream whose staged files the memory tools never wrote (found in a live E2E)', async () => {
    // The runtime's own file tools can reach the staging directory — it is a sibling of
    // the dream's cwd, and a real claude run in plan mode wrote there when the MCP bridge
    // was down. Such a file skipped the name rule, the byte cap, and header stamping, so
    // the proposal is refused rather than reviewed.
    const { dir, store, runner } = await setup({
      stagedWrite: async (stagedStore) => {
        await writeMemoryFile(stagedStore, 'smuggled.md', 'written with the runtime file tool\n', undefined, 'dream')
        return [] // ...and reported by nobody: no bound tool call happened
      }
    })
    const started = await runner.start('a1', { trigger: 'manual' })
    const done = await settle(store, started.dreamId)
    expect(done.status).toBe('failed')
    expect(done.error?.type).toBe('untrusted_staging')
    expect(done.error?.message).toContain('smuggled.md')
    expect(await runner.stagedFiles('a1', started.dreamId)).toBeNull()
    expect(await readMemoryFile(local(dir), 'prefs.md')).toContain('uses tabs')
  })

  it('still completes an empty rebuild when the live store had nothing to lose', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-dream-'))
    const fs = local(dir)
    await ensureMemory(fs, 'bot')
    const store = new FakeStore()
    const runner = new DreamRunner({
      agentDirByAgent: (id) => (id === 'a1' ? dir : undefined),
      memoryFsFor: (id) => (id === 'a1' ? fs : undefined),
      dreamingPolicyFor: () => ({ enabled: true }),
      operationPolicy: 'test-only',
      store,
      extract: async () => ({ output: PROPOSAL }),
      log: silent
    })
    const started = await runner.start('a1', { trigger: 'manual' })
    expect((await settle(store, started.dreamId)).status).toBe('completed')
  })

  it('mines every session the agent participated in, without a capture-visibility filter (#36)', async () => {
    // A dream distills all of the agent's own sessions — including DM / webchat /
    // external (GitHub) / A2A ones that the per-turn capture gate marks private.
    // Peer isolation stays with the source (agentId-scoped + agent-scoped rows);
    // it is no longer a hard pre-filter here (session-visibility.md §5.1 follow-up).
    const { runner, store, prompts } = await setup({})
    store.sources = [
      { sessionId: 'sess-channel', channel: 'C1', thread: 'T1' },
      { sessionId: 'sess-dm', channel: 'C2', thread: 'T2' },
      { sessionId: 'sess-github', channel: 'C3', thread: 'T3' }
    ]
    const started = await runner.start('a1', { trigger: 'manual' })
    expect(started.sessionIds).toEqual(['sess-channel', 'sess-dm', 'sess-github'])
    await settle(store, started.dreamId)

    const inputDir = prompts[0]!.inputDir
    expect(await readdir(join(inputDir, 'sessions'))).toEqual(
      expect.arrayContaining(['sess-channel.md', 'sess-dm.md', 'sess-github.md'])
    )
    for (const id of ['sess-channel', 'sess-dm', 'sess-github']) expect(prompts[0]?.prompt).toContain(id)
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
      executionSessionId: 'sid-of-dream-session-1',
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
    expect(events[1]?.dream.executionSessionId).toBe('sid-of-dream-session-1')
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

  it('blocks production execution before agent lookup, policy, corpus, state, or extraction', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-dream-held-'))
    const store = new FakeStore()
    const agentDirByAgent = vi.fn(() => dir)
    const dreamingPolicyFor = vi.fn(() => ({ enabled: true }))
    const extract = vi.fn(async () => ({ output: PROPOSAL }))
    const sources = vi.spyOn(store, 'dreamSessionSources')
    const runner = new DreamRunner({
      agentDirByAgent,
      memoryFsFor: () => local(dir),
      dreamingPolicyFor,
      store,
      extract,
      log: silent
    })

    await expect(runner.start('a1', { trigger: 'manual' })).rejects.toThrow(DREAM_MODEL_READABLE_CREDENTIALS_REASON)

    expect(agentDirByAgent).not.toHaveBeenCalled()
    expect(dreamingPolicyFor).not.toHaveBeenCalled()
    expect(sources).not.toHaveBeenCalled()
    expect(extract).not.toHaveBeenCalled()
    expect(store.dreams.size).toBe(0)
    expect(await readdir(dir)).toEqual([])
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
    await ensureMemory(local(dir), 'bot')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'memory-dreams'), 'not a directory', 'utf8')
    const store = new FakeStore()
    const runner = new DreamRunner({
      agentDirByAgent: () => dir,
      memoryFsFor: () => local(dir),
      dreamingPolicyFor: () => ({ enabled: true }),
      operationPolicy: 'test-only',
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
    await ensureMemory(local(dir), 'bot')
    await writeMemoryFile(local(dir), 'prefs.md', '- seed\n', undefined, 'tool')
    const store = new FakeStore()
    const runner = new DreamRunner({
      agentDirByAgent: () => dir,
      memoryFsFor: () => local(dir),
      dreamingPolicyFor: () => ({ enabled: true }),
      operationPolicy: 'test-only',
      store,
      extract: async (_agentId, _systemPrompt, _prompt, _signal, context) => {
        const memoryTopics = await writeStagedProposal(context.stagedStore)
        return { output: PROPOSAL, memoryTopics }
      },
      onStaged: async (agentId, dreamId) => {
        await runner.cancel(agentId, dreamId) // cancel after staging, before completion
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
    const canceled = await runner.cancel('a1', started.dreamId)
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
    await runner.cancel('a1', first.dreamId)
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
    await runner.cancel('a1', first.dreamId)
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

    expect(await readMemoryFile(local(dir), 'prefs.md')).toBe('- Uses tabs, not spaces (2026-07-24).\n')
    expect(await readMemoryFile(local(dir), 'MEMORY.md')).toContain('[prefs](prefs.md)')

    // Backup holds the pre-dream store; .history carried over and extended.
    const backups = await readdir(join(dir, 'memory-backups'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(dir, 'memory-backups', backups[0]!, 'prefs.md'), 'utf8')).toContain('uses tabs again')
    const history = await readFile(join(memoryDir(dir), MEMORY_HISTORY_FILENAME), 'utf8')
    expect(history).toContain('"source":"dream"')
    expect(history).toContain('"source":"tool"') // pre-adoption rows preserved
  })

  it('a scheduled dream on a suspended pool agent wakes the sandbox, holds it for the run, and adopts on it', async () => {
    // Overnight the pod is suspended: the memory tree is unreachable until the sandbox is bound.
    // A dream is authorized work like a turn, so the runner wakes and holds the home itself.
    const dir = await mkdtemp(join(tmpdir(), 'ac-dream-'))
    const { fs, root } = pod()
    await ensureMemory(fs, 'bot')
    await writeMemoryFile(fs, 'prefs.md', '- uses tabs\n', undefined, 'tool')
    let bound = false
    let holds = 0
    let maxHolds = 0
    let heldDuringExtraction = 0
    const store = new FakeStore()
    const runner = new DreamRunner({
      agentDirByAgent: (id) => (id === 'a1' ? dir : undefined),
      memoryFsFor: (id) => {
        if (id !== 'a1') return undefined
        if (!bound) throw new MemorySandboxUnavailableError('agent "a1" has no running sandbox')
        return fs
      },
      // The daemon's seam: `ensureChannel` + `withSandbox` — bind, then count the hold the idle sweep reads.
      withMemoryHome: async (_agentId, work) => {
        bound = true
        holds += 1
        maxHolds = Math.max(maxHolds, holds)
        try {
          return await work()
        } finally {
          holds -= 1
        }
      },
      dreamingPolicyFor: () => ({ enabled: true, autoAdopt: true }),
      operationPolicy: 'test-only',
      store,
      extract: async (_agentId, _systemPrompt, _prompt, _signal, context) => {
        heldDuringExtraction = holds
        // The model writes its rebuilt store through the tools, on the pod's volume.
        const memoryTopics = await writeStagedProposal(context.stagedStore)
        return { output: PROPOSAL, memoryTopics }
      },
      log: silent
    })
    expect(bound).toBe(false)
    const started = await runner.start('a1', { trigger: 'schedule' })
    expect(bound).toBe(true)
    expect(runner.inFlight('a1')).toBe(true)
    const done = await settle(store, started.dreamId)
    expect(done.status).toBe('completed')
    // Held while the extraction ran (a running dream counts as activity), released once it settled.
    expect(heldDuringExtraction).toBeGreaterThan(0)
    expect(maxHolds).toBeGreaterThan(0)
    await vi.waitFor(() => expect(store.dreams.get(started.dreamId)?.status).toBe('adopted'))
    await vi.waitFor(() => expect(holds).toBe(0))
    expect(runner.inFlight('a1')).toBe(false)
    expect(await readMemoryFile(fs, 'prefs.md')).toBe('- Uses tabs, not spaces (2026-07-24).\n')
    expect(await readdir(join(root, 'memory-backups'))).toHaveLength(1)
    // Console/admin reads keep the refusal: nothing here made an unbound tree readable on its own.
    bound = false
    await expect(runner.stagedFiles('a1', started.dreamId)).rejects.toBeInstanceOf(MemorySandboxUnavailableError)
  })

  it('stays in flight through auto-adoption, so a shutdown drain sees the group busy until the swap is done', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-dream-'))
    const { fs, requester } = pod()
    await ensureMemory(fs, 'bot')
    const store = new FakeStore()
    const runner = new DreamRunner({
      agentDirByAgent: (id) => (id === 'a1' ? dir : undefined),
      memoryFsFor: (id) => (id === 'a1' ? fs : undefined),
      dreamingPolicyFor: () => ({ enabled: true, autoAdopt: true }),
      operationPolicy: 'test-only',
      store,
      extract: async () => ({ output: PROPOSAL }),
      log: silent
    })
    // Hold the sandbox channel once the run has completed: auto-adoption's first frame parks here.
    let gate: (() => void) | undefined
    let dreamId = ''
    const original = requester.request.bind(requester)
    requester.request = async (capability, payload, options) => {
      if (dreamId && store.dreams.get(dreamId)?.status === 'completed' && !gate) {
        await new Promise<void>((resolve) => {
          gate = resolve
        })
      }
      return original(capability, payload, options)
    }
    const started = await runner.start('a1', { trigger: 'schedule' })
    dreamId = started.dreamId
    await settle(store, started.dreamId)
    await vi.waitFor(() => expect(gate).toBeDefined())
    // The reservation is released (a manual adopt could run) but the JOB is not over.
    expect(runner.inFlight('a1')).toBe(true)
    gate!()
    await vi.waitFor(() => expect(store.dreams.get(started.dreamId)?.status).toBe('adopted'))
    await vi.waitFor(() => expect(runner.inFlight('a1')).toBe(false))
  })

  it('a shutdown abandon bounds a parked auto-adoption — the dream stays completed for review', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-dream-'))
    const { fs, requester } = pod()
    await ensureMemory(fs, 'bot')
    const store = new FakeStore()
    const runner = new DreamRunner({
      agentDirByAgent: (id) => (id === 'a1' ? dir : undefined),
      memoryFsFor: (id) => (id === 'a1' ? fs : undefined),
      dreamingPolicyFor: () => ({ enabled: true, autoAdopt: true }),
      operationPolicy: 'test-only',
      store,
      extract: async () => ({ output: PROPOSAL }),
      log: silent
    })
    let gate: (() => void) | undefined
    let dreamId = ''
    const original = requester.request.bind(requester)
    requester.request = async (capability, payload, options) => {
      if (dreamId && store.dreams.get(dreamId)?.status === 'completed' && !gate) {
        await new Promise<void>((resolve) => {
          gate = resolve
        })
      }
      return original(capability, payload, options)
    }
    const started = await runner.start('a1', { trigger: 'schedule' })
    dreamId = started.dreamId
    await settle(store, started.dreamId)
    await vi.waitFor(() => expect(gate).toBeDefined())
    expect(runner.inFlight('a1')).toBe(true)

    // The shutdown cutoff lands while adoption is parked on its first frame: cancel() has
    // nothing to cancel (the dream is completed), but the abandon flag bounds the phase.
    await runner.cancelInFlight('a1')
    gate!()
    // The parked frame resolves and the next checkpoint bails: no adoption, job over.
    await vi.waitFor(() => expect(runner.inFlight('a1')).toBe(false))
    expect(store.dreams.get(started.dreamId)?.status).toBe('completed')
  })

  it('leaves nothing registered when the home cannot be brought up before the run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-dream-'))
    await ensureMemory(local(dir), 'bot')
    let acquisitions = 0
    const store = new FakeStore()
    const runner = new DreamRunner({
      agentDirByAgent: (id) => (id === 'a1' ? dir : undefined),
      memoryFsFor: (id) => (id === 'a1' ? local(dir) : undefined),
      // The snapshot's acquisition succeeds; the run's rejects before its callback starts (a wake that failed).
      withMemoryHome: async (_agentId, work) => {
        acquisitions += 1
        if (acquisitions === 2) throw new Error('sandbox did not come up')
        return work()
      },
      dreamingPolicyFor: () => ({ enabled: true }),
      operationPolicy: 'test-only',
      store,
      extract: async () => ({ output: PROPOSAL }),
      log: silent
    })
    const started = await runner.start('a1', { trigger: 'schedule' })
    const done = await settle(store, started.dreamId)
    expect(done.status).toBe('failed')
    expect(done.error?.message).toContain('sandbox did not come up')
    await vi.waitFor(() => expect(runner.inFlight('a1')).toBe(false))
    // No stuck reservation or aborter: a new dream starts, and cancelling the dead one is a plain state answer.
    await expect(runner.cancel('a1', started.dreamId)).rejects.toThrow(DreamStateError)
    const again = await runner.start('a1', { trigger: 'manual' })
    expect((await settle(store, again.dreamId)).status).toBe('completed')
  })

  it('stages and adopts on a sandbox volume through the port, never on this disk', async () => {
    const { dir, store, runner, prompts, sandbox } = await setup({ sandbox: true })
    const { root, fs, requester } = sandbox!
    const started = await runner.start('a1', { trigger: 'manual' })
    await settle(store, started.dreamId)
    // The extraction's cwd is the input dir in the POD's coordinates — where the dream host runs.
    expect(prompts[0]!.inputDir).toBe(join(root, 'memory-dreams', started.dreamId, 'input'))
    expect(await readFile(join(root, 'memory-dreams', started.dreamId, 'input', 'prefs.md'), 'utf8')).toContain(
      'uses tabs'
    )
    expect(await runner.stagedFiles('a1', started.dreamId)).toEqual([
      expect.objectContaining({ name: MEMORY_INDEX }),
      expect.objectContaining({ name: 'prefs.md' })
    ])
    expect((await runner.stagedRead('a1', started.dreamId, 'prefs.md'))?.content).toContain('Uses tabs, not spaces')

    const adopted = await runner.adopt('a1', started.dreamId, false)
    expect(adopted.status).toBe('adopted')
    expect(await readMemoryFile(fs, 'prefs.md')).toBe('- Uses tabs, not spaces (2026-07-24).\n')
    expect(await readFile(join(root, 'memory', MEMORY_HISTORY_FILENAME), 'utf8')).toContain('"source":"dream"')
    expect(await readdir(join(root, 'memory-backups'))).toHaveLength(1)
    // Every touch crossed the shim channel; the member's own agent dir holds no memory at all.
    expect(requester.frames.length).toBeGreaterThan(0)
    expect(await readdir(dir)).toEqual([])
  })

  it('preserves the mtime of files the dream left unchanged, refreshing only changed ones', async () => {
    // A dream rebuilds the whole store and swaps it in, so without care every
    // file would show the adoption time. Only files whose content actually
    // changed should get a fresh updated-time.
    const { dir, store, runner } = await setup({
      stagedFiles: [
        { path: 'keep.md', content: 'unchanged body' },
        { path: 'prefs.md', content: 'changed by the dream' }
      ]
    })
    const started = await runner.start('a1', { trigger: 'manual' })
    await settle(store, started.dreamId)

    // Seed a live keep.md byte-identical to what the dream staged, and backdate
    // every current file so "fresh" is unambiguous. Adopt with force since this
    // live edit intentionally drifts from the dream's start snapshot.
    // A dream stages into a real memory store now, so its files live under `memory/`.
    const out = join(dir, 'memory-dreams', started.dreamId, 'memory')
    const stagedKeep = await readFile(join(out, 'keep.md'), 'utf8')
    await writeMemoryFile(local(dir), 'keep.md', stagedKeep, undefined, 'tool')
    const OLD = new Date('2020-01-01T00:00:00.000Z')
    for (const name of ['keep.md', 'prefs.md', MEMORY_INDEX]) {
      await utimes(join(memoryDir(dir), name), OLD, OLD).catch(() => {})
    }

    const adopted = await runner.adopt('a1', started.dreamId, true)
    expect(adopted.status).toBe('adopted')

    // keep.md was byte-identical → its old mtime survives; prefs.md changed → fresh.
    expect((await stat(join(memoryDir(dir), 'keep.md'))).mtime.getTime()).toBe(OLD.getTime())
    expect((await stat(join(memoryDir(dir), 'prefs.md'))).mtime.getTime()).toBeGreaterThan(OLD.getTime())
  })

  it('binds adoption to the reviewed staged bytes (same-bytes review fence)', async () => {
    const { dir, store, runner } = await setup({})
    const started = await runner.start('a1', { trigger: 'manual' })
    await settle(store, started.dreamId)

    // The review token is the digest of the exact staged output the user reviewed.
    // A dream stages into a real memory store now, so its files live under `memory/`.
    const out = join(dir, 'memory-dreams', started.dreamId, 'memory')
    const names = await readdir(out)
    const stagedFiles = await Promise.all(
      names.map(async (name) => ({ name, content: await readFile(join(out, name), 'utf8') }))
    )
    const token = storeDigest(stagedFiles)

    // A stale/incorrect token is refused before any mutation — the reviewed bytes
    // must match what is about to be adopted.
    await expect(runner.adopt('a1', started.dreamId, false, `sha256:${'0'.repeat(64)}`)).rejects.toThrow(/re-review/i)
    expect(store.dreams.get(started.dreamId)?.status).toBe('completed')

    // The exact reviewed digest adopts cleanly.
    const adopted = await runner.adopt('a1', started.dreamId, false, token)
    expect(adopted.status).toBe('adopted')
    expect(await readMemoryFile(local(dir), 'prefs.md')).toBe('- Uses tabs, not spaces (2026-07-24).\n')
  })

  it('stagedStoreReviewToken returns the token adopt accepts (review-read → adopt loop)', async () => {
    const { store, runner } = await setup({})
    const started = await runner.start('a1', { trigger: 'manual' })
    await settle(store, started.dreamId)

    // The review read hands the console this token; echoing it back must adopt.
    const token = await runner.stagedStoreReviewToken('a1', started.dreamId)
    expect(token).toMatch(/^sha256:[0-9a-f]{64}$/)
    const adopted = await runner.adopt('a1', started.dreamId, false, token!)
    expect(adopted.status).toBe('adopted')
  })

  it('records the exact add, update, and delete set with live before snapshots', async () => {
    const { dir, store, runner } = await setup({
      stagedFiles: [
        { path: 'prefs.md', content: '- consolidated preference' },
        { path: 'fresh.md', content: '- newly learned fact' }
      ]
    })
    await writeMemoryFile(local(dir), 'obsolete.md', '- no longer relevant\n', undefined, 'tool')
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
      writeMemoryFile(local(dir), 'marker.md', '- concurrent write\n', undefined, 'console')
    ])
    expect(await readMemoryFile(local(dir), 'marker.md')).toContain('concurrent write')
  })

  it('fences adoption against post-snapshot writes unless forced', async () => {
    const { dir, store, runner } = await setup({})
    const started = await runner.start('a1', { trigger: 'manual' })
    await settle(store, started.dreamId)

    await writeMemoryFile(local(dir), 'prefs.md', '- console edit after snapshot\n', undefined, 'console')
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
    expect(await readMemoryFile(local(result.dir), 'prefs.md')).toContain('Uses tabs, not spaces (2026-07-24).')
  })

  it('leaves the dream reviewable when auto-adopt hits an unrebasable fence', async () => {
    const { dir, store, runner } = await setup({
      policy: { enabled: true, autoAdopt: true },
      // Hold the extraction open so a console write lands inside the dream window.
      extract: async () => {
        await writeMemoryFile(local(dir), 'notes.md', '- human note mid-dream\n', undefined, 'console')
        return PROPOSAL
      }
    })
    const started = await runner.start('a1', { trigger: 'schedule' })
    await settle(store, started.dreamId)
    await new Promise((r) => setTimeout(r, 40))

    // Auto-adopt must not force past a console write — it stays completed.
    expect(store.dreams.get(started.dreamId)?.status).toBe('completed')
    expect(await readMemoryFile(local(dir), 'notes.md')).toContain('human note mid-dream')
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
    await writeMemoryFile(local(dir), 'prefs.md', '- uses tabs\n- distilled after\n', undefined, 'distill')

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
      local(dir),
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

    await writeMemoryFile(local(dir), 'notes.md', '- human note\n', undefined, 'console')
    // Erase the console row from the log, leaving only the distill one.
    const historyPath = join(memoryDir(dir), MEMORY_HISTORY_FILENAME)
    const kept = (await readFile(historyPath, 'utf8'))
      .split('\n')
      .filter((line) => !line.includes('"source":"console"'))
      .join('\n')
    await writeFile(historyPath, kept, 'utf8')
    await writeMemoryFile(local(dir), 'prefs.md', '- uses tabs\n- distilled later\n', undefined, 'distill')

    await expect(runner.adopt('a1', started.dreamId, false)).rejects.toThrow(/changed since/)
    expect(await readMemoryFile(local(dir), 'notes.md')).toContain('human note')
  })

  it('refuses a rebase that would push a staged file past its byte cap', async () => {
    // A proposal that is already at capacity plus one distilled line must not
    // adopt an over-limit store the ordinary write path could never produce.
    const atCap = '- ' + 'x'.repeat(MAX_MEMORY_FILE_BYTES - 4)
    const { dir, store, runner } = await setup({ stagedFiles: [{ path: 'prefs.md', content: atCap }] })
    const started = await runner.start('a1', { trigger: 'manual' })
    await settle(store, started.dreamId)

    await writeMemoryFile(local(dir), 'prefs.md', '- uses tabs\n- one more distilled line\n', undefined, 'distill')
    await expect(runner.adopt('a1', started.dreamId, false)).rejects.toThrow(/changed since/)
  })

  it('rebases distill-only drift onto the staged store instead of refusing (§8)', async () => {
    const { dir, store, runner } = await setup({})
    const started = await runner.start('a1', { trigger: 'manual' })
    await settle(store, started.dreamId)

    // Per-turn capture landed a NEW fact while the dream ran. The digest now
    // differs, but every post-snapshot .history row is distill-sourced, so the
    // fence must rebase rather than refuse.
    await writeMemoryFile(local(dir), 'prefs.md', '- uses tabs\n- prefers pnpm over npm\n', undefined, 'distill')

    const adopted = await runner.adopt('a1', started.dreamId, false)
    expect(adopted.status).toBe('adopted')

    // The dream's consolidation AND the distilled addition are both present.
    const prefs = await readMemoryFile(local(dir), 'prefs.md')
    expect(prefs).toContain('Uses tabs, not spaces (2026-07-24).') // the dream's rewrite
    expect(prefs).toContain('prefers pnpm over npm') // the rebased distill line
  })

  it('still hard-fences when any post-snapshot write is not distill-sourced', async () => {
    const { dir, store, runner } = await setup({})
    const started = await runner.start('a1', { trigger: 'manual' })
    await settle(store, started.dreamId)

    // A distill write is rebasable, but the console write in the same window is
    // not — a mixed window must refuse rather than silently drop the edit.
    await writeMemoryFile(local(dir), 'prefs.md', '- uses tabs\n- distilled\n', undefined, 'distill')
    await writeMemoryFile(local(dir), 'notes.md', '- a human wrote this\n', undefined, 'console')

    await expect(runner.adopt('a1', started.dreamId, false)).rejects.toThrow(/changed since/)
    expect(await readMemoryFile(local(dir), 'notes.md')).toContain('a human wrote this')
  })

  it('does not re-add a distilled line the dream already folded in', async () => {
    const { dir, store, runner } = await setup({})
    const started = await runner.start('a1', { trigger: 'manual' })
    await settle(store, started.dreamId)

    // The distiller re-states, in its own words, the very fact the dream wrote.
    await writeMemoryFile(
      local(dir),
      'prefs.md',
      '- uses tabs\n- Uses tabs, not spaces (2026-07-24).\n',
      undefined,
      'distill'
    )
    await runner.adopt('a1', started.dreamId, false)

    const prefs = await readMemoryFile(local(dir), 'prefs.md')
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
    await store.insertDream({
      dreamId: 'drm-stale',
      agentId: 'a1',
      status: 'running',
      trigger: 'manual',
      sessionIds: [],
      snapshotDigest: 'sha256:x',
      createdAt: new Date().toISOString()
    })
    await new DreamRunner({
      agentDirByAgent: () => undefined,
      memoryFsFor: () => undefined,
      dreamingPolicyFor: () => undefined,
      operationPolicy: 'test-only',
      store,
      extract: async () => ({ output: '' }),
      log: silent
    }).initialize()
    expect(store.dreams.get('drm-stale')).toMatchObject({
      status: 'failed',
      error: { type: 'daemon_restart' }
    })
  })

  it("fails a peer's dream on the duty grant, never because this member started", async () => {
    // On a pool the store is shared: boot sees only this incarnation's rows, and a peer's
    // running dream becomes recoverable only once the CP hands over the agent.
    const store = new FakeStore()
    store.owned = new Set()
    await store.insertDream({
      dreamId: 'drm-peer',
      agentId: 'a1',
      status: 'running',
      trigger: 'manual',
      sessionIds: [],
      snapshotDigest: 'sha256:x',
      createdAt: new Date().toISOString()
    })
    const failures: string[] = []
    const runner = new DreamRunner({
      agentDirByAgent: () => undefined,
      memoryFsFor: () => undefined,
      dreamingPolicyFor: () => undefined,
      operationPolicy: 'test-only',
      store,
      extract: async () => ({ output: '' }),
      onEvent: (event) => {
        if (event.type === 'memory.dream.failed') failures.push(event.dream.dreamId)
      },
      log: silent
    })
    await runner.initialize()
    expect(store.dreams.get('drm-peer')?.status).toBe('running')

    await runner.reclaimDreams(['a2'])
    expect(store.dreams.get('drm-peer')?.status).toBe('running')

    await runner.reclaimDreams(['a1'])
    expect(store.dreams.get('drm-peer')).toMatchObject({ status: 'failed', error: { type: 'daemon_restart' } })
    expect(failures).toEqual(['drm-peer'])

    // The CAS lost: a terminal row is neither rewritten nor re-announced.
    store.dreams.set('drm-peer', { ...store.dreams.get('drm-peer')!, status: 'completed' })
    await runner.reclaimDreams(['a1'])
    expect(store.dreams.get('drm-peer')?.status).toBe('completed')
    expect(failures).toEqual(['drm-peer'])
  })

  it('still reviews and adopts a dream staged under the legacy output/ layout', async () => {
    // Dreams staged before the store-shaped layout keep their files in `output/`.
    // They must stay reviewable and adoptable rather than reading as unstaged.
    const { dir, store, runner } = await setup({})
    const started = await runner.start('a1', { trigger: 'manual' })
    await settle(store, started.dreamId)

    // Rewrite this dream the old way: same bytes, legacy directory.
    const base = join(dir, 'memory-dreams', started.dreamId)
    const current = join(base, 'memory')
    const legacy = join(base, 'output')
    await mkdir(legacy, { recursive: true })
    for (const name of await readdir(current)) {
      await writeFile(join(legacy, name), await readFile(join(current, name), 'utf8'))
    }
    await rm(current, { recursive: true, force: true })

    const staged = await runner.stagedFiles('a1', started.dreamId)
    expect(staged?.some((f) => f.name === 'prefs.md')).toBe(true)
    expect((await runner.stagedRead('a1', started.dreamId, 'prefs.md'))?.content).toContain('2026-07-24')

    const adopted = await runner.adopt('a1', started.dreamId, false)
    expect(adopted.status).toBe('adopted')
    expect(await readMemoryFile(local(dir), 'prefs.md')).toContain('2026-07-24')
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
    await store.insertDream({
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

    await new DreamRunner({
      agentDirByAgent: (agentId) => (agentId === 'a1' ? dir : undefined),
      memoryFsFor: (agentId) => (agentId === 'a1' ? local(dir) : undefined),
      dreamingPolicyFor: () => undefined,
      operationPolicy: 'test-only',
      store,
      extract: async () => ({ output: '' }),
      log: silent
    }).initialize()
    for (let i = 0; i < 20; i++) {
      if (!(await readdir(base)).includes('output')) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    expect(await readdir(base)).toEqual(['skills'])
    expect(await readFile(join(base, 'skills', 'keep-me', 'SKILL.md'), 'utf8')).toBe('# keep')
  })
})

describe('DreamRunner production security hold', () => {
  it('blocks every staged-content operation without changing files or metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-dream-held-'))
    await ensureMemory(local(dir), 'bot')
    await writeMemoryFile(local(dir), 'prefs.md', '- live value\n', undefined, 'tool')

    const dreamId = 'drm-held'
    const candidateId = '11111111-1111-4111-8111-111111111111'
    const base = join(dir, 'memory-dreams', dreamId)
    await mkdir(join(base, 'output'), { recursive: true })
    await mkdir(join(base, 'skills', 'deploy-staging', 'scripts'), { recursive: true })
    await mkdir(join(base, 'organization'), { recursive: true })
    await writeFile(join(base, 'output', 'MEMORY.md'), '# Held memory\n')
    await writeFile(join(base, 'output', 'prefs.md'), '- staged value\n')
    await writeFile(join(base, 'skills', 'deploy-staging', 'SKILL.md'), '# Held skill\n')
    await writeFile(join(base, 'skills', 'deploy-staging', 'scripts', 'deploy.sh'), 'echo held\n')
    await writeFile(join(base, 'organization', `${candidateId}.json`), '{"kind":"knowledge","content":"held"}')

    const store = new FakeStore()
    const held: DreamInfo = {
      dreamId,
      agentId: 'a1',
      status: 'completed',
      trigger: 'manual',
      sessionIds: ['sess-1'],
      snapshotDigest: `sha256:${'b'.repeat(64)}`,
      skills: [{ name: 'deploy-staging', description: 'Deploy to staging', state: 'proposed' }],
      organizationSuggestions: [
        {
          candidateId,
          kind: 'knowledge',
          operation: 'create',
          title: 'Held knowledge',
          digest: `sha256:${'a'.repeat(64)}`,
          contentBytes: 36,
          state: 'proposed',
          sessionIds: ['sess-1'],
          createdAt: '2026-07-24T00:00:00.000Z'
        }
      ],
      createdAt: '2026-07-24T00:00:00.000Z',
      endedAt: '2026-07-24T00:01:00.000Z'
    }
    await store.insertDream(held)
    const before = JSON.stringify(await store.getDream('a1', dreamId))
    const runner = new DreamRunner({
      agentDirByAgent: (agentId) => (agentId === 'a1' ? dir : undefined),
      memoryFsFor: (agentId) => (agentId === 'a1' ? local(dir) : undefined),
      dreamingPolicyFor: () => ({ enabled: true }),
      operationPolicy: 'blocked',
      store,
      extract: async () => ({ output: PROPOSAL }),
      log: silent
    })

    const operations: Array<() => Promise<unknown>> = [
      () => runner.adopt('a1', dreamId, false),
      () => runner.discard('a1', dreamId),
      () => runner.stagedFiles('a1', dreamId),
      () => runner.stagedRead('a1', dreamId, 'prefs.md'),
      () => runner.stagedSkill('a1', dreamId, 'deploy-staging'),
      () => runner.skillAccept('a1', dreamId, 'deploy-staging'),
      () => runner.skillDismiss('a1', dreamId, 'deploy-staging'),
      () =>
        runner.organizationSuggestionRead({
          sourceAgentId: 'a1',
          dreamId,
          candidateId,
          kind: 'knowledge',
          offset: 0,
          limit: 64
        }),
      () =>
        runner.organizationSuggestionReview({
          sourceAgentId: 'a1',
          dreamId,
          candidateId,
          state: 'accepted'
        }),
      () =>
        runner.organizationSuggestionReview({
          sourceAgentId: 'a1',
          dreamId,
          candidateId,
          state: 'rejected'
        })
    ]
    for (const operation of operations) {
      await expect(operation()).rejects.toThrow(DREAM_UNBOUND_STAGED_CONTENT_REASON)
    }

    expect(JSON.stringify(await store.getDream('a1', dreamId))).toBe(before)
    expect(await readMemoryFile(local(dir), 'prefs.md')).toBe('- live value\n')
    expect(await readFile(join(base, 'output', 'MEMORY.md'), 'utf8')).toBe('# Held memory\n')
    expect(await readFile(join(base, 'output', 'prefs.md'), 'utf8')).toBe('- staged value\n')
    expect(await readFile(join(base, 'skills', 'deploy-staging', 'SKILL.md'), 'utf8')).toBe('# Held skill\n')
    expect(await readFile(join(base, 'skills', 'deploy-staging', 'scripts', 'deploy.sh'), 'utf8')).toBe('echo held\n')
    expect(await readFile(join(base, 'organization', `${candidateId}.json`), 'utf8')).toBe(
      '{"kind":"knowledge","content":"held"}'
    )
    await expect(readdir(join(dir, 'skills'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not sweep superseded staging, while metadata and cancel remain available', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-dream-held-'))
    const base = join(dir, 'memory-dreams', 'drm-superseded')
    await mkdir(join(base, 'output'), { recursive: true })
    await writeFile(join(base, 'output', 'MEMORY.md'), '# retained\n')
    const store = new FakeStore()
    await store.insertDream({
      dreamId: 'drm-superseded',
      agentId: 'a1',
      status: 'superseded',
      trigger: 'manual',
      sessionIds: [],
      snapshotDigest: `sha256:${'c'.repeat(64)}`,
      organizationSuggestions: [
        {
          candidateId: '22222222-2222-4222-8222-222222222222',
          kind: 'knowledge',
          operation: 'create',
          title: 'Metadata only',
          digest: `sha256:${'d'.repeat(64)}`,
          contentBytes: 1,
          state: 'proposed',
          sessionIds: ['sess-1'],
          createdAt: '2026-07-24T00:00:00.000Z'
        }
      ],
      createdAt: '2026-07-24T00:00:00.000Z',
      endedAt: '2026-07-24T00:01:00.000Z'
    })
    const supersededDreams = vi.spyOn(store, 'supersededDreams')
    const runner = new DreamRunner({
      agentDirByAgent: (agentId) => (agentId === 'a1' ? dir : undefined),
      memoryFsFor: (agentId) => (agentId === 'a1' ? local(dir) : undefined),
      dreamingPolicyFor: () => ({ enabled: true }),
      operationPolicy: 'blocked',
      store,
      extract: async () => ({ output: PROPOSAL }),
      log: silent
    })
    await runner.initialize()

    expect(supersededDreams).not.toHaveBeenCalled()
    expect(await readFile(join(base, 'output', 'MEMORY.md'), 'utf8')).toBe('# retained\n')
    expect((await runner.get('a1', 'drm-superseded')).status).toBe('superseded')
    expect((await runner.list('a1', 10)).map((dream) => dream.dreamId)).toContain('drm-superseded')
    expect(await runner.organizationSuggestionInventory()).toHaveLength(1)

    await store.insertDream({
      dreamId: 'drm-running',
      agentId: 'a1',
      status: 'running',
      trigger: 'manual',
      sessionIds: [],
      snapshotDigest: `sha256:${'e'.repeat(64)}`,
      createdAt: '2026-07-24T00:02:00.000Z'
    })
    expect((await runner.cancel('a1', 'drm-running')).status).toBe('canceled')
    expect((await runner.get('a1', 'drm-running')).status).toBe('canceled')
  })
})

describe('DreamRunner store persistence', () => {
  it('round-trips snapshotWrites through the real LocalStore (not just the fake)', async () => {
    // Regression: the runner wrote `snapshotWrites`, but if LocalStore's schema
    // and mappers omit it the value is dropped on insert and EVERY production
    // rebase silently fails closed — invisible to FakeStore-based tests.
    const store = await LocalStore.open(join(await mkdtemp(join(tmpdir(), 'ac-dream-store-')), 'local.sqlite'))
    const dream: DreamInfo = {
      dreamId: 'drm-store-1',
      agentId: 'a1',
      status: 'pending',
      trigger: 'manual',
      sessionIds: ['s1'],
      snapshotDigest: 'sha256:abc',
      executionSessionId: 'sid-of-dream-session-1',
      runtime: 'codex',
      model: 'gpt-5.6',
      stopReason: 'end_turn',
      snapshotWrites: { generation: 'gen-1', total: 7, nonDistill: 3 },
      usage: {
        inputBytes: 2048,
        outputBytes: 512,
        totalTokens: 120,
        costAmount: 0.012,
        costCurrency: 'USD'
      },
      createdAt: '2026-07-24T00:00:00.000Z'
    }
    await store.insertDream(dream)
    expect(await store.getDream('a1', 'drm-store-1')).toMatchObject({
      executionSessionId: 'sid-of-dream-session-1',
      runtime: 'codex',
      model: 'gpt-5.6',
      stopReason: 'end_turn',
      snapshotWrites: { total: 7, nonDistill: 3 },
      usage: { inputBytes: 2048, outputBytes: 512, totalTokens: 120, costAmount: 0.012 }
    })

    // …and survives the status updates the pipeline makes on the way to adoption.
    await store.updateDream({ ...dream, status: 'completed', endedAt: '2026-07-24T00:05:00.000Z' })
    expect((await store.getDream('a1', 'drm-store-1'))?.snapshotWrites).toEqual({
      generation: 'gen-1',
      total: 7,
      nonDistill: 3
    })
    expect((await store.listDreams('a1', 10))[0]?.snapshotWrites).toEqual({
      generation: 'gen-1',
      total: 7,
      nonDistill: 3
    })
    await store.close()
  })

  it('the real runner persists snapshotWrites end to end', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ac-dream-'))
    await ensureMemory(local(dir), 'bot')
    await writeMemoryFile(local(dir), 'prefs.md', '- uses tabs\n', undefined, 'tool')
    const store = await LocalStore.open(join(await mkdtemp(join(tmpdir(), 'ac-dream-store-')), 'local.sqlite'))
    const runner = new DreamRunner({
      agentDirByAgent: () => dir,
      memoryFsFor: () => local(dir),
      dreamingPolicyFor: () => ({ enabled: true }),
      operationPolicy: 'test-only',
      store,
      extract: async () => ({ output: PROPOSAL }),
      log: silent
    })
    const started = await runner.start('a1', { trigger: 'manual' })
    expect((await store.getDream('a1', started.dreamId))?.snapshotWrites).toBeDefined()
    for (let i = 0; i < 200; i++) {
      const status = (await store.getDream('a1', started.dreamId))?.status
      if (status && status !== 'pending' && status !== 'running') break
      await new Promise((r) => setTimeout(r, 5))
    }
    expect((await store.getDream('a1', started.dreamId))?.snapshotWrites).toBeDefined()
    await store.close()
  })

  it('does not let newer terminal rows crowd pending organization suggestions out of inventory', async () => {
    const store = await LocalStore.open(join(mkdtempSync(join(tmpdir(), 'ac-dream-store-')), 'local.sqlite'))
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
    await store.insertDream({
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
      await store.insertDream({
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

    expect((await store.organizationSuggestionDreams(1)).map((dream) => dream.dreamId)).toEqual(['older-pending'])
    await store.close()
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
    expect(await runner.organizationSuggestionInventory()).toMatchObject([
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
    expect(await runner.organizationSuggestionInventory()).toHaveLength(1)
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
    expect((await store.getDream('a1', started.dreamId))?.organizationSuggestions?.[0]?.state).toBe('accepted')
    expect(await runner.organizationSuggestionInventory()).toEqual([])
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

  it('stages a structurally-valid org-knowledge update; the CP is the authority on the target at accept', async () => {
    const output = (targetId: string) =>
      JSON.stringify({
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
    // A well-formed update is staged with no daemon-side allow-list — the dreamer
    // discovered the id through its tools, and the owner-accept path (CP) is the
    // authority on whether that id/revision actually exists.
    const ok = await setup({ extract: async () => output('33333333-3333-4333-8333-333333333333') })
    const okStart = await ok.runner.start('a1', { trigger: 'manual' })
    expect((await settle(ok.store, okStart.dreamId)).organizationSuggestions?.[0]).toMatchObject({
      operation: 'update',
      targetId: '33333333-3333-4333-8333-333333333333',
      targetRevision: 4
    })
    // A malformed target (not a UUID) is dropped by the structural check.
    const bad = await setup({ extract: async () => output('not-a-uuid') })
    const badStart = await bad.runner.start('a1', { trigger: 'manual' })
    expect((await settle(bad.store, badStart.dreamId)).organizationSuggestions).toBeUndefined()
  })

  it('stages a structurally-valid managed-skill update and points the model at the listOrgSkills tool', async () => {
    const targetId = '44444444-4444-4444-8444-444444444444'
    const updateOutput = JSON.stringify({
      agentMemory: { index: '# Memory', files: [] },
      agentSkills: [],
      organizationKnowledge: [],
      organizationSkills: [
        {
          operation: 'update',
          targetId,
          targetRevision: 2,
          name: 'release-service',
          files: [
            {
              path: 'SKILL.md',
              content:
                '---\nname: release-service\ndescription: Release with rollback validation\n---\n\n# Release v3\n'
            }
          ],
          sessionIds: ['sess-1', 'sess-2']
        }
      ]
    })
    const trusted = await setup({
      policy: { enabled: true, mineSkills: true },
      extract: async () => updateOutput
    })
    trusted.store.sources.push({ sessionId: 'sess-2', channel: 'C2', thread: 'T2' })
    const started = await trusted.runner.start('a1', { trigger: 'manual' })
    expect((await settle(trusted.store, started.dreamId)).organizationSuggestions?.[0]).toMatchObject({
      kind: 'skill',
      operation: 'update',
      targetId,
      targetRevision: 2,
      title: 'release-service'
    })
    // Existing skills are discovered via the tool, not pre-stuffed; the prompt
    // points the model at it.
    expect(trusted.prompts[0]?.prompt).toContain('listOrgSkills')
  })
})

describe('capture/adoption serialization', () => {
  it('a distillation batch and an adoption cannot interleave (stale index never wins)', async () => {
    // A distilled write and an adoption must serialize on the memory-dir lock, or an
    // adoption landing mid-write would be clobbered by a stale index. Distillation now
    // goes through the ordinary write path (the shared memory tool, tagged `distill`),
    // which regenerates the index INSIDE the same locked write — so the two can only
    // interleave as whole operations, and the adopted index survives either order.
    const { dir, store, runner } = await setup({})
    const started = await runner.start('a1', { trigger: 'manual' })
    await settle(store, started.dreamId)

    // Fire capture and adoption concurrently at the same store.
    const [, adoptResult] = await Promise.allSettled([
      writeMemoryFile(local(dir), 'captured.md', '- a captured fact\n', undefined, 'distill'),
      runner.adopt('a1', started.dreamId, false)
    ])

    const index = await readMemoryFile(local(dir), MEMORY_INDEX)
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
    onEvent?: (event: DreamLifecycleEvent) => void,
    withSkillAcceptance?: (agentId: string, publish: () => Promise<void>) => Promise<void>
  ) {
    const dir = await mkdtemp(join(tmpdir(), 'ac-dream-'))
    await ensureMemory(local(dir), 'bot')
    const runner = new DreamRunner({
      agentDirByAgent: (id) => (id === 'a1' ? dir : undefined),
      memoryFsFor: (id) => (id === 'a1' ? local(dir) : undefined),
      dreamingPolicyFor: () => ({ enabled: true, mineSkills: true }),
      operationPolicy: 'test-only',
      store,
      extract: async () => ({ output: proposal }),
      ...(onEvent ? { onEvent } : {}),
      ...(withSkillAcceptance ? { withSkillAcceptance } : {}),
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
    await ensureMemory(local(dir), 'bot')
    const prompts: string[] = []
    const runner = new DreamRunner({
      agentDirByAgent: () => dir,
      memoryFsFor: () => local(dir),
      dreamingPolicyFor: () => ({ enabled: true }), // mineSkills off
      operationPolicy: 'test-only',
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

  it('accept publishes the immutable source, evicts the warm host, and marks it accepted', async () => {
    const events: DreamLifecycleEvent[] = []
    const withSkillAcceptance = vi.fn(async (_agentId: string, publish: () => Promise<void>) => publish())
    const { dir, runner, dreamId } = await mining(
      grounded,
      new TwoSessionStore(),
      (event) => events.push(event),
      withSkillAcceptance
    )
    const after = await runner.skillAccept('a1', dreamId, 'deploy-staging')
    expect(after.skills?.[0]).toMatchObject({ state: 'accepted' })
    expect(withSkillAcceptance).toHaveBeenCalledOnce()
    expect(withSkillAcceptance.mock.calls[0]?.[0]).toBe('a1')
    expect(events.at(-1)).toMatchObject({
      type: 'memory.dream.skill_accepted',
      dream: { dreamId, skills: [{ name: 'deploy-staging', state: 'accepted' }] },
      skillName: 'deploy-staging'
    })

    // The canonical copy lands under the agent root — daemon-owned, outside the
    // workspace. Session prep materializes it into the runtime's skill root
    // through the unified isolated installer under symlink containment.
    expect(await acceptedSkillBody(dir, 'deploy-staging')).toContain('name: deploy-staging')
    // Idempotent — no duplicate lifecycle decision.
    await expect(runner.skillAccept('a1', dreamId, 'deploy-staging')).resolves.toMatchObject({})
    expect(events.filter((event) => event.type === 'memory.dream.skill_accepted')).toHaveLength(1)
    expect(withSkillAcceptance).toHaveBeenCalledOnce()
  })

  it('binds skill acceptance to the PUBLISHED bytes: wrong token or a post-review mutation is refused', async () => {
    const { dir, runner, dreamId } = await mining(grounded)
    const staged = join(dir, 'memory-dreams', dreamId, 'skills', 'deploy-staging')
    const skillMd = join(staged, 'SKILL.md')
    const token = (await inspectLocalSkillSource(staged)).sha256

    // A stale/incorrect token is refused.
    await expect(runner.skillAccept('a1', dreamId, 'deploy-staging', `sha256:${'0'.repeat(64)}`)).rejects.toThrow(
      /re-review/i
    )

    // A mutation AFTER the token was minted is caught at the publication snapshot
    // (the fence is verified against publish's own capture, not a preflight
    // inspection), so a concurrent swap of staged bytes can never publish
    // un-reviewed content.
    await writeFile(skillMd, `${await readFile(skillMd, 'utf8')}\n<!-- tampered -->\n`, 'utf8')
    await expect(runner.skillAccept('a1', dreamId, 'deploy-staging', token)).rejects.toThrow(/re-review/i)

    // Re-reviewing the current bytes (fresh token) accepts.
    const current = (await inspectLocalSkillSource(staged)).sha256
    const after = await runner.skillAccept('a1', dreamId, 'deploy-staging', current)
    expect(after.skills?.[0]).toMatchObject({ state: 'accepted' })
  })

  it('stagedSkillReviewToken returns the token skillAccept accepts (review-read → accept loop)', async () => {
    const { runner, dreamId } = await mining(grounded)
    const token = await runner.stagedSkillReviewToken('a1', dreamId, 'deploy-staging')
    expect(token).toMatch(/^sha256:[0-9a-f]{64}$/)
    const after = await runner.skillAccept('a1', dreamId, 'deploy-staging', token!)
    expect(after.skills?.[0]).toMatchObject({ state: 'accepted' })
  })

  it('an accepted skill survives discarding the dream it came from', async () => {
    // Acceptance COPIES rather than referencing the staging, so tidying up the
    // dream cannot silently uninstall a skill the user already took.
    const { dir, runner, dreamId } = await mining(grounded)
    await runner.skillAccept('a1', dreamId, 'deploy-staging')
    await runner.discard('a1', dreamId)
    expect(await acceptedSkillBody(dir, 'deploy-staging')).toContain('name: deploy-staging')
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
    await ensureMemory(local(dir), 'bot')
    const prompts: string[] = []
    let inputDir = ''
    const runner = new DreamRunner({
      agentDirByAgent: () => dir,
      memoryFsFor: () => local(dir),
      dreamingPolicyFor: () => ({ enabled: true, mineSkills: true }),
      operationPolicy: 'test-only',
      store,
      extract: async (_a, _s, prompt, _signal, context) => {
        prompts.push(prompt)
        inputDir = context.inputDir
        return { output: opts.proposal ?? proposalWith([candidate()]) }
      },
      log: silent
    })
    const started = await runner.start('a1', { trigger: 'manual' })
    const done = await settle(store, started.dreamId)
    return { dir, runner, store, prompts, inputDir, dreamId: started.dreamId, done }
  }

  it('feeds tool titles into the session files the miner reads, and never tool bodies', async () => {
    // A procedure expressed only through repeated commands is invisible in
    // conversational text — the miner must see the trajectory. Tool titles land
    // in the materialized session file the miner explores with its own tools.
    const store = new TwoSession()
    store.rows = [{ sender: 'user-1', text: 'ship it' }]
    store.toolRows = [{ sender: 'agent', text: 'Bash(npm run deploy)', kind: 'tool' }]
    const { inputDir } = await mine({ store })
    const session = await readFile(join(inputDir, 'sessions', 'sess-1.md'), 'utf8')
    expect(session).toContain('[tool] Bash(npm run deploy)')
    expect(session).toContain('ship it')
  })

  it('does not read tool rows at all when mining is off', async () => {
    const store = new TwoSession()
    store.toolRows = [{ sender: 'agent', text: 'Bash(secret-y thing)', kind: 'tool' }]
    const dir = await mkdtemp(join(tmpdir(), 'ac-dream-'))
    await ensureMemory(local(dir), 'bot')
    const prompts: string[] = []
    const runner = new DreamRunner({
      agentDirByAgent: () => dir,
      memoryFsFor: () => local(dir),
      dreamingPolicyFor: () => ({ enabled: true }), // mining off
      operationPolicy: 'test-only',
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
    const body = await acceptedSkillBody(dir, 'deploy-staging')
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

  async function storeWithPeerToolRow() {
    const store = await LocalStore.open(join(mkdtempSync(join(tmpdir(), 'ac-tt-')), 'local.sqlite'))
    // A shared-thread message DELIVERED to our agent…
    await store.appendTranscript({
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
    await store.insertToolCall({
      channel: CH,
      thread: TH,
      ts: TS,
      sender: 'peer-agent',
      toolCallId: 'tc-peer',
      title: 'Bash(peer-secret-command)',
      body: JSON.stringify({ rawInput: 'peer-secret-command --token hunter2', rawOutput: 'peer output' })
    })
    // Our own tool row.
    await store.insertToolCall({
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

  it('never returns a peer-private tool row via the shared delivery table', async () => {
    const store = await storeWithPeerToolRow()
    const rows = await store.dreamTranscriptText(CH, TH, 'me', 100, true)
    const text = rows.map((r) => `${r.text} ${r.input ?? ''}`).join('\n')
    expect(text).not.toContain('peer-secret-command')
    expect(text).not.toContain('hunter2')
    // Our own rows are still there — the guard must not over-filter.
    expect(text).toContain('ship it')
    expect(text).toContain('npm run deploy --prod')
    await store.close()
  })

  it('carries a bounded rawInput so a generic title still identifies the command', async () => {
    const store = await storeWithPeerToolRow()
    const mine = (await store.dreamTranscriptText(CH, TH, 'me', 100, true)).find((r) => r.kind === 'tool')
    expect(mine?.text).toBe('Bash') // the title alone says nothing
    expect(mine?.input).toBe('npm run deploy --prod')
    // rawOutput is the bulk/secret-bearing half and never leaves the store.
    expect(JSON.stringify(mine)).not.toContain('build output')
    await store.close()
  })

  it('omits tool rows entirely when mining is off', async () => {
    const store = await storeWithPeerToolRow()
    const rows = await store.dreamTranscriptText(CH, TH, 'me', 100)
    expect(rows.every((r) => r.kind !== 'tool')).toBe(true)
    expect(rows.map((r) => r.text)).toContain('ship it')
    await store.close()
  })
})
