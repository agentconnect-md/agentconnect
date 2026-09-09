import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { MemoryTransactionCommit, MemoryTransactionResult } from '@agentconnect.md/protocol'
import { LocalMemoryFs, type MemoryFs } from '../src/memory/fs.js'
import { localMemoryHome } from '../src/memory/home.js'
import { ManagedMemoryProvider } from '../src/memory/providers/managed.js'
import { createMemoryEntryService } from '../src/memory/entries/factory.js'
import { memoryChannelKey } from '../src/memory/store.js'
import { openTestStore } from './store-support.js'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'memory-crud-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const db = await openTestStore(join(dir, 'state.sqlite'))
  cleanup.push(() => db.close())
  const commits: Omit<MemoryTransactionCommit, 'agentId'>[] = []
  let afterStage: (() => Promise<void>) | undefined
  // This fixture models the negotiated port; PostgreSQL tests prove the home transaction's atomicity.
  const home = (path: string): MemoryFs => {
    const base = new LocalMemoryFs(path)
    const snapshot = async (root: string) => {
      const rows = []
      for (const entry of await base.readdir(root))
        if (entry.kind === 'file' && !entry.name.endsWith('.tmp')) {
          const file = await base.readFile(`${root}/${entry.name}`)
          rows.push([entry.name, file?.content])
        }
      return hash(JSON.stringify(rows.sort()))
    }
    return {
      key: base.key,
      root: base.root,
      subdir: (rel) => home(join(path, rel)),
      readFile: base.readFile.bind(base),
      writeFile: base.writeFile.bind(base),
      readdir: base.readdir.bind(base),
      mkdir: base.mkdir.bind(base),
      rename: base.rename.bind(base),
      rm: base.rm.bind(base),
      utimes: base.utimes.bind(base),
      captureStatus: async () => ({ suppressed: false }),
      stageTransactionFile: async (root, content) => {
        const temp = `.agentconnect-memory-${randomUUID()}.tmp`
        await base.writeFile(`${root}/${temp}`, content)
        if (afterStage) {
          const run = afterStage
          afterStage = undefined
          await run()
        }
        return { temp, revision: hash(content) }
      },
      atomicTransaction: async (request): Promise<MemoryTransactionResult> => {
        if (request.operation === 'snapshot') return { operation: 'snapshot', revision: await snapshot(request.root) }
        if (request.operation !== 'commit') return { operation: 'capture-status', suppressed: false }
        if (request.expectedRevision !== (await snapshot(request.root)))
          return { operation: 'error', code: 'CONFLICT', message: 'tree changed' }
        for (const change of request.changes) {
          const current = await base.readFile(`${request.root}/${change.path}`)
          if ((current ? hash(current.content) : null) !== change.expectedRevision)
            throw new Error('bad target precondition')
        }
        const files = []
        for (const change of request.changes) {
          if (change.action === 'delete') {
            await base.rm(`${request.root}/${change.path}`)
            files.push({ path: change.path, revision: null, mtime: null })
          } else {
            const staged = await base.readFile(`${request.root}/${change.temp}`)
            if (!staged || hash(staged.content) !== change.stagedRevision) throw new Error('bad staging')
            const stat = await base.writeFile(`${request.root}/${change.path}`, staged.content)
            await base.rm(`${request.root}/${change.temp}`)
            files.push({ path: change.path, revision: change.stagedRevision, mtime: stat.mtime })
          }
        }
        commits.push(request)
        return {
          operation: 'commit',
          replayed: false,
          receipt: {
            operationId: request.operationId,
            committedAt: new Date().toISOString(),
            revision: await snapshot(request.root),
            files
          }
        }
      }
    }
  }
  const fs = home(join(dir, 'home'))
  let allowed = true
  const provider = new ManagedMemoryProvider(() => localMemoryHome(fs))
  const sourceTurnId = randomUUID()
  const service = (agentId = 'agent', channelKey?: string, writable = true) =>
    createMemoryEntryService({
      provider,
      store: db,
      scope: { agentId, channelKey, sourceTurnId },
      canRead: () => true,
      ...(writable ? { write: { source: 'tool' as const, canWrite: () => allowed } } : {})
    })
  return {
    fs,
    provider,
    db,
    commits,
    sourceTurnId,
    service,
    deny: () => {
      allowed = false
    },
    race: (fn: () => Promise<void>) => {
      afterStage = fn
    }
  }
}

describe('common managed entry mutations', () => {
  it('creates, gets, exactly edits and deletes through one topic/index transaction with trusted provenance', async () => {
    const f = await fixture()
    const api = await f.service()
    const created = await api.create({
      label: 'topic',
      text: '---\ndescription: deployment\nmetadata:\n  owner: me\n---\n\nOriginal [[other]]'
    })
    expect(created.state).toBe('completed')
    expect(created.entry!.ref).not.toBe('topic.md')
    expect(f.commits[0]).toMatchObject({ source: 'tool', sourceTurnId: f.sourceTurnId })
    expect(f.commits[0]!.changes.map((change) => change.path)).toEqual(['topic.md', 'MEMORY.md'])
    const read = await api.get({ ref: created.entry!.ref })
    expect(read!.entry.revision).toBe(created.entry!.revision)
    const updated = await api.update({
      ref: created.entry!.ref,
      revision: created.entry!.revision,
      edit: { oldText: 'Original', newText: '$& corrected' }
    })
    expect((await api.get({ ref: updated.entry!.ref }))!.text).toContain('$& corrected [[other]]')
    expect((await api.get({ ref: updated.entry!.ref }))!.text).toContain('metadata:\n  owner: me')
    await expect(
      api.update({ ref: updated.entry!.ref, revision: created.entry!.revision, text: 'stale' })
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    const removed = await api.delete({ ref: updated.entry!.ref, revision: updated.entry!.revision })
    expect(removed.deletedRef).toBe(updated.entry!.ref)
    expect(await api.get({ ref: removed.deletedRef })).toBeNull()
    expect((await f.fs.readFile('memory/MEMORY.md'))!.content).not.toContain('[topic]')
    expect(f.commits.at(-1)!.changes[0]!.action).toBe('delete')
  })

  it('never upserts on update and distinguishes empty content from deletion', async () => {
    const f = await fixture()
    const api = await f.service()
    const created = await api.create({ label: 'topic', text: '' })
    await expect(api.create({ label: 'topic', text: 'overwrite' })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await api.get({ ref: created.entry!.ref }))!.text).toBe('')
    await expect(api.update({ ref: created.entry!.ref, text: 'missing revision' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT'
    })
    await expect(
      api.update({
        ref: created.entry!.ref,
        revision: created.entry!.revision,
        text: 'both',
        edit: { oldText: 'x', newText: 'y' }
      })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await api.delete({ ref: created.entry!.ref, revision: created.entry!.revision })
    await expect(
      api.update({ ref: created.entry!.ref, revision: created.entry!.revision, text: 'revive' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('rechecks write permission and rejects foreign references without dispatching a mutation', async () => {
    const f = await fixture()
    const api = await f.service()
    const created = await api.create({ label: 'topic', text: 'secret' })
    const other = await f.service('other-agent')
    await expect(other.delete({ ref: created.entry!.ref, revision: created.entry!.revision })).rejects.toMatchObject({
      code: 'STALE_BINDING'
    })
    f.deny()
    await expect(api.delete({ ref: created.entry!.ref, revision: created.entry!.revision })).rejects.toMatchObject({
      code: 'FORBIDDEN'
    })
    expect(f.commits).toHaveLength(1)
    const readonly = await f.service('agent', undefined, false)
    expect((await readonly.describe()).operations).toEqual(['list', 'get'])
  })

  it('refuses inherited updates and reveals the base after deleting a channel override', async () => {
    const f = await fixture()
    const base = await f.service()
    await base.create({ label: 'topic', text: 'base' })
    const channel = await f.service('agent', memoryChannelKey('room'))
    const inherited = (await channel.list()).entries[0]!
    expect(inherited.origin).toBe('inherited')
    await expect(
      channel.update({ ref: inherited.ref, revision: inherited.revision, text: 'damage' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const override = await channel.create({ label: 'topic', text: 'channel' })
    await channel.delete({ ref: override.entry!.ref, revision: override.entry!.revision })
    expect((await channel.list()).entries[0]!.origin).toBe('inherited')
    expect((await base.list()).entries[0]!.revision).toBe(inherited.revision)
  })

  it('does not overwrite an intervening root change or silently discard separate metadata', async () => {
    const f = await fixture()
    const api = await f.service()
    f.race(async () => {
      await f.fs.writeFile('memory/other.md', 'concurrent')
    })
    await expect(api.create({ label: 'topic', text: 'new' })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await f.fs.readFile('memory/topic.md')).toBeNull()
    expect((await f.fs.readFile('memory/other.md'))!.content).toBe('concurrent')
    await expect(api.create({ label: 'topic', text: 'new', metadata: { owner: 'me' } })).rejects.toMatchObject({
      code: 'UNSUPPORTED'
    })
    await expect(api.create({ label: 'MEMORY.md', text: 'replace index' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT'
    })
    expect(f.commits).toHaveLength(0)
  })
  it('refuses ambiguous edits and UTF-8 overflow without publishing anything', async () => {
    const f = await fixture()
    const api = await f.service()
    const created = await api.create({ label: 'topic', text: 'repeat repeat' })
    await expect(
      api.update({
        ref: created.entry!.ref,
        revision: created.entry!.revision,
        edit: { oldText: 'repeat', newText: '' }
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(api.update({ ref: created.entry!.ref, revision: 'stale', text: 'replace' })).rejects.toMatchObject({
      code: 'CONFLICT',
      currentRevision: created.entry!.revision
    })
    await expect(
      api.update({ ref: created.entry!.ref, revision: created.entry!.revision, text: '界'.repeat(100000) })
    ).rejects.toMatchObject({ code: 'TOO_LARGE' })
    expect(f.commits).toHaveLength(1)
  })
  it('does not advertise conditional writes on a native-writable filesystem even for an authorized caller', async () => {
    const f = await fixture()
    const local = new LocalMemoryFs(f.fs.root)
    const api = await createMemoryEntryService({
      provider: new ManagedMemoryProvider(() => localMemoryHome(local)),
      store: f.db,
      scope: { agentId: 'agent' },
      canRead: () => true,
      write: { source: 'console', canWrite: () => true }
    })
    expect((await api.describe()).operations).toEqual(['list', 'get'])
    await expect(api.create({ label: 'topic', text: 'new' })).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    expect(await local.readFile('memory/topic.md')).toBeNull()
  })
})

it('executes conditional MCP writes with trusted scope, approvals and synthetic-session fences', async () => {
  const f = await fixture()
  const { executeTool } = await import('../src/mcp/ops.js')
  const { MEMORY_TOOLS } = await import('../src/memory/tools.js')
  const ctx = { agentId: 'agent', platform: 'slack', isDm: false, channel: 'C', thread: 'T', tools: MEMORY_TOOLS }
  let decision: 'allow' | 'ask' | 'deny' = 'allow'
  let approve = true
  let approvals = 0
  const deps = {
    memory: f.provider,
    memoryEntryStore: f.db,
    memoryScope: () => ({ agentId: 'agent', sourceTurnId: f.sourceTurnId }),
    memoryAccessDecision: (_ctx: unknown, mode: string) => (mode === 'write' ? decision : 'allow'),
    requestMemoryWriteApproval: () => {
      approvals++
      return approve ? 'allowed' : 'denied'
    }
  } as unknown as import('../src/mcp/ops.js').OpsDeps
  const invoke = (name: string, args: Record<string, unknown>) => executeTool(ctx, name, args, deps)
  expect(await invoke('describeMemoryEntries', {})).toMatchObject({
    operations: ['list', 'get', 'create', 'update', 'delete']
  })
  const created = (await invoke('createMemoryEntry', {
    label: 'model',
    text: 'before'
  })) as import('@agentconnect.md/protocol').MemoryEntryMutationReceipt
  expect(f.commits[0]).toMatchObject({ source: 'tool', sourceTurnId: f.sourceTurnId })
  await expect(invoke('createMemoryEntry', { label: 'forged', text: 'x', source: 'distill' })).rejects.toThrow()
  decision = 'ask'
  const updated = (await invoke('updateMemoryEntry', {
    ref: created.entry!.ref,
    revision: created.entry!.revision,
    edit: { oldText: 'before', newText: '$& after' }
  })) as import('@agentconnect.md/protocol').MemoryEntryMutationReceipt
  expect(approvals).toBe(1)
  expect(await invoke('getMemoryEntry', { ref: updated.entry!.ref })).toMatchObject({
    text: expect.stringContaining('$& after')
  })
  approve = false
  await expect(
    invoke('deleteMemoryEntry', { ref: updated.entry!.ref, revision: updated.entry!.revision })
  ).rejects.toThrow('did not approve')
  expect(f.commits).toHaveLength(2)
  decision = 'deny'
  await expect(
    invoke('deleteMemoryEntry', { ref: updated.entry!.ref, revision: updated.entry!.revision })
  ).rejects.toThrow()
  decision = 'ask'
  await expect(
    executeTool(
      ctx,
      'deleteMemoryEntry',
      { ref: updated.entry!.ref, revision: updated.entry!.revision },
      {
        ...deps,
        requestMemoryWriteApproval: async () => {
          decision = 'deny'
          return 'allowed'
        }
      }
    )
  ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(f.commits).toHaveLength(2)
  decision = 'allow'
  await expect(
    executeTool(
      { ...ctx, memoryBinding: { source: 'distill', scope: { agentId: 'agent' }, maxTopics: 0 } },
      'createMemoryEntry',
      { text: 'bypass' },
      deps
    )
  ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(
    invoke('updateMemoryEntry', { ref: created.entry!.ref, revision: created.entry!.revision, text: 'stale' })
  ).rejects.toMatchObject({ code: 'CONFLICT', currentRevision: updated.entry!.revision })
  expect(
    await invoke('deleteMemoryEntry', { ref: updated.entry!.ref, revision: updated.entry!.revision })
  ).toMatchObject({ state: 'completed' })
  expect(f.commits).toHaveLength(3)
})

it('admin mutations use console origin, reject lost ownership and expose conditional entries', async () => {
  const f = await fixture()
  const { createMemoryEntriesReader, createMemoryEntriesWriter } = await import('../src/cp/memory-entries.js')
  let owned = true
  const access = (id: string) => owned && id === 'agent'
  const write = createMemoryEntriesWriter(f.provider, f.db, access)
  const read = createMemoryEntriesReader(f.provider, f.db, access)
  const created = await write({ agentId: 'agent', operation: 'create', request: { label: 'admin', text: 'hello' } })
  expect(created.operation).toBe('completed')
  if (created.operation !== 'completed') throw new Error('create failed')
  expect(f.commits[0]).toMatchObject({ source: 'console' })
  expect(f.commits[0]!.sourceTurnId).toBeUndefined()
  expect(await read({ agentId: 'agent', operation: 'describe' })).toMatchObject({
    result: { operations: ['list', 'get', 'create', 'update', 'delete'], limits: { maxMutationRequestBytes: 196608 } }
  })
  const ref = created.result.entry!.ref
  const revision = created.result.entry!.revision
  expect(
    await write({ agentId: 'agent', operation: 'update', request: { ref, revision, text: 'changed' } })
  ).toMatchObject({ operation: 'completed' })
  expect(await write({ agentId: 'agent', operation: 'delete', request: { ref, revision } })).toMatchObject({
    code: 'CONFLICT',
    currentRevision: expect.any(String)
  })
  owned = false
  expect(await write({ agentId: 'agent', operation: 'create', request: { text: 'denied' } })).toMatchObject({
    code: 'FORBIDDEN'
  })
  owned = true
  expect(
    await write({ agentId: 'agent', operation: 'create', request: { text: '\u0000'.repeat(40000) } })
  ).toMatchObject({ code: 'TOO_LARGE' })
  expect(f.commits).toHaveLength(2)
})
