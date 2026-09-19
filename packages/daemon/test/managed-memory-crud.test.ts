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
    expect((await readonly.describe()).operations).toEqual(['list', 'get', 'search', 'history'])
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
  it('serves last-write-wins mutations on a native-writable filesystem through the compatibility writer', async () => {
    const f = await fixture()
    const local = new LocalMemoryFs(f.fs.root)
    const api = await createMemoryEntryService({
      provider: new ManagedMemoryProvider(() => localMemoryHome(local)),
      store: f.db,
      scope: { agentId: 'agent' },
      canRead: () => true,
      write: { source: 'console', canWrite: () => true }
    })
    // Not conditional: the check is the writer's own, strong against daemon-side writers, best-effort otherwise.
    expect(await api.describe()).toMatchObject({
      operations: ['list', 'get', 'search', 'create', 'update', 'delete', 'history'],
      writeConsistency: 'last-write-wins',
      exactCreate: true,
      exactEdit: true
    })
    const created = await api.create({ label: 'topic', text: '---\ndescription: deployment\n---\n\nOriginal' })
    expect(created.state).toBe('completed')
    const stored = (await local.readFile('memory/topic.md'))!.content
    expect(stored).toContain('name: topic')
    expect(stored).toContain('Original')
    expect((await local.readFile('memory/MEMORY.md'))!.content).toContain('[topic](topic.md) — deployment')
    expect((await api.get({ ref: created.entry!.ref }))!.entry.revision).toBe(created.entry!.revision)
    await expect(api.create({ label: 'topic', text: 'again' })).rejects.toMatchObject({ code: 'CONFLICT' })
    const updated = await api.update({
      ref: created.entry!.ref,
      revision: created.entry!.revision,
      edit: { oldText: 'Original', newText: 'Corrected' }
    })
    expect((await local.readFile('memory/topic.md'))!.content).toContain('Corrected')
    await expect(
      api.update({ ref: updated.entry!.ref, revision: created.entry!.revision, text: 'stale' })
    ).rejects.toMatchObject({ code: 'CONFLICT', currentRevision: updated.entry!.revision })
    // As advertised, a write without a revision simply lands.
    const blind = await api.update({ ref: updated.entry!.ref, text: 'Replaced without a revision' })
    expect((await local.readFile('memory/topic.md'))!.content).toContain('Replaced without a revision')
    // The sidecar carries every write; no transaction, so the log follows the write rather than joining it.
    const log = await api.history({ ref: blind.entry!.ref, limit: 5 })
    expect(log.events.map((event) => event.kind)).toEqual(['update', 'update', 'create'])
    expect(log.events[0]!.source).toBe('console')
    const removed = await api.delete({ ref: blind.entry!.ref, revision: blind.entry!.revision })
    expect(removed.deletedRef).toBe(blind.entry!.ref)
    expect(await local.readFile('memory/topic.md')).toBeNull()
    expect((await local.readFile('memory/MEMORY.md'))!.content).not.toContain('[topic]')
    await expect(api.update({ ref: blind.entry!.ref, text: 'revive' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(f.commits).toHaveLength(0)
  })

  it('refuses a filesystem write when the file changed under the lock, and never touches the index for it', async () => {
    const f = await fixture()
    const base = new LocalMemoryFs(f.fs.root)
    // An out-of-band editor lands right after every read of the topic while armed, so whichever read the writer takes
    // as its precondition is stale by the time it replaces or unlinks: the mtime guard must refuse.
    let intrude: (() => Promise<void>) | undefined
    const local: MemoryFs = {
      key: base.key,
      root: base.root,
      subdir: base.subdir.bind(base),
      readFile: async (rel, encoding) => {
        const file = await base.readFile(rel, encoding)
        if (intrude && rel === 'memory/topic.md') await intrude()
        return file
      },
      writeFile: base.writeFile.bind(base),
      readdir: base.readdir.bind(base),
      mkdir: base.mkdir.bind(base),
      rename: base.rename.bind(base),
      rm: base.rm.bind(base),
      rmIfMatch: base.rmIfMatch.bind(base),
      utimes: base.utimes.bind(base)
    }
    const api = await createMemoryEntryService({
      provider: new ManagedMemoryProvider(() => localMemoryHome(local)),
      store: f.db,
      scope: { agentId: 'agent' },
      canRead: () => true,
      write: { source: 'tool', canWrite: () => true }
    })
    const created = await api.create({ label: 'topic', text: 'first' })
    // Each intrusion leaves a distinct mtime, so a guard that compared against the previous intrusion would still miss.
    let intrusions = 0
    const replaceUnderneath = async () => {
      await base.writeFile('memory/topic.md', (await base.readFile('memory/topic.md'))!.content)
      await base.utimes('memory/topic.md', new Date(Date.UTC(2020, 0, 1, 0, 0, ++intrusions)).toISOString())
    }
    intrude = replaceUnderneath
    await expect(
      api.update({ ref: created.entry!.ref, revision: created.entry!.revision, text: 'second' })
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    intrude = undefined
    expect((await base.readFile('memory/topic.md'))!.content).not.toContain('second')
    // The same gap before a delete: the newer file stays, and the mutation is refused rather than reported complete.
    const fresh = (await api.get({ ref: created.entry!.ref }))!.entry
    intrude = replaceUnderneath
    await expect(api.delete({ ref: fresh.ref, revision: fresh.revision })).rejects.toMatchObject({ code: 'CONFLICT' })
    intrude = undefined
    expect((await base.readFile('memory/topic.md'))!.content).toContain('first')
  })

  it('reports a failure after dispatch as unconfirmed, and one the port refuses before publishing by its own code', async () => {
    const f = await fixture()
    const base = new LocalMemoryFs(f.fs.root)
    let lostReply = false
    let breakIndex = false
    const local: MemoryFs = {
      key: base.key,
      root: base.root,
      subdir: base.subdir.bind(base),
      readFile: base.readFile.bind(base),
      // A shim or older peer can apply the commit and lose the reply: the write lands, the caller sees an error.
      writeFile: async (rel, content, options) => {
        const stat = await base.writeFile(rel, content, options)
        if (lostReply && rel === 'memory/topic.md') throw new Error('channel closed before the reply')
        return stat
      },
      // The index regeneration lists the directory after the file already changed.
      readdir: async (rel) => {
        if (breakIndex) throw new Error('listing failed')
        return base.readdir(rel)
      },
      mkdir: base.mkdir.bind(base),
      rename: base.rename.bind(base),
      rm: base.rm.bind(base),
      rmIfMatch: base.rmIfMatch.bind(base),
      utimes: base.utimes.bind(base)
    }
    const api = await createMemoryEntryService({
      provider: new ManagedMemoryProvider(() => localMemoryHome(local)),
      store: f.db,
      scope: { agentId: 'agent' },
      canRead: () => true,
      write: { source: 'console', canWrite: () => true }
    })
    const created = await api.create({ label: 'topic', text: 'first' })
    lostReply = true
    await expect(api.update({ ref: created.entry!.ref, text: 'second' })).rejects.toMatchObject({
      code: 'AMBIGUOUS_WRITE'
    })
    lostReply = false
    expect((await base.readFile('memory/topic.md'))!.content).toContain('second')
    // The revision the caller held is stale now, so a replay with it is refused instead of clobbering the write.
    await expect(
      api.update({ ref: created.entry!.ref, revision: created.entry!.revision, text: 'replay' })
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    const fresh = (await api.get({ ref: created.entry!.ref }))!.entry
    breakIndex = true
    await expect(api.update({ ref: fresh.ref, revision: fresh.revision, text: 'third' })).rejects.toMatchObject({
      code: 'AMBIGUOUS_WRITE'
    })
    breakIndex = false
    expect((await base.readFile('memory/topic.md'))!.content).toContain('third')
    // A precondition the port itself refuses is proven unapplied, on either side of the dispatch.
    await expect(api.update({ ref: fresh.ref, revision: fresh.revision, text: 'stale' })).rejects.toMatchObject({
      code: 'CONFLICT'
    })
    await expect(api.create({ label: '../escape', text: 'x' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('advertises delete on a native-writable home only when it can verify the file before removing it', async () => {
    const f = await fixture()
    const base = new LocalMemoryFs(f.fs.root)
    // A home whose port cannot check the file before unlinking (a shim or an older peer): create and update, no delete.
    const unverified: MemoryFs = {
      key: base.key,
      root: base.root,
      subdir: base.subdir.bind(base),
      readFile: base.readFile.bind(base),
      writeFile: base.writeFile.bind(base),
      readdir: base.readdir.bind(base),
      mkdir: base.mkdir.bind(base),
      rename: base.rename.bind(base),
      rm: base.rm.bind(base),
      utimes: base.utimes.bind(base)
    }
    const api = await createMemoryEntryService({
      provider: new ManagedMemoryProvider(() => localMemoryHome(unverified)),
      store: f.db,
      scope: { agentId: 'agent' },
      canRead: () => true,
      write: { source: 'console', canWrite: () => true }
    })
    expect((await api.describe()).operations).toEqual(['list', 'get', 'search', 'create', 'update', 'history'])
    const created = await api.create({ label: 'topic', text: 'kept' })
    await expect(api.delete({ ref: created.entry!.ref, revision: created.entry!.revision })).rejects.toMatchObject({
      code: 'UNSUPPORTED'
    })
    expect((await base.readFile('memory/topic.md'))!.content).toContain('kept')
  })

  it('keeps channel overlay rules on a native-writable filesystem', async () => {
    const f = await fixture()
    const local = new LocalMemoryFs(f.fs.root)
    const provider = new ManagedMemoryProvider(() => localMemoryHome(local))
    const service = (channelKey?: string) =>
      createMemoryEntryService({
        provider,
        store: f.db,
        scope: { agentId: 'agent', channelKey },
        canRead: () => true,
        write: { source: 'tool', canWrite: () => true }
      })
    const base = await service()
    await base.create({ label: 'topic', text: 'base' })
    const channel = await service(memoryChannelKey('room'))
    const inherited = (await channel.list()).entries[0]!
    await expect(
      channel.update({ ref: inherited.ref, revision: inherited.revision, text: 'damage' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const override = await channel.create({ label: 'topic', text: 'channel' })
    expect((await local.readFile('memory/topic.md'))!.content).toContain('base')
    await channel.delete({ ref: override.entry!.ref, revision: override.entry!.revision })
    expect((await channel.list()).entries[0]!.origin).toBe('inherited')
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
  const targets: string[] = []
  const deps = {
    memory: f.provider,
    memoryEntryStore: f.db,
    memoryScope: () => ({ agentId: 'agent', sourceTurnId: f.sourceTurnId }),
    memoryAccessDecision: (_ctx: unknown, mode: string) => (mode === 'write' ? decision : 'allow'),
    requestMemoryWriteApproval: (_ctx: unknown, ask: { target: string }) => {
      targets.push(ask.target)
      approvals++
      return approve ? 'allowed' : 'denied'
    }
  } as unknown as import('../src/mcp/ops.js').OpsDeps
  const invoke = (name: string, args: Record<string, unknown>) => executeTool(ctx, name, args, deps)
  expect(await invoke('describeMemoryEntries', {})).toMatchObject({
    operations: ['list', 'get', 'search', 'create', 'update', 'delete', 'history']
  })
  const created = (await invoke('createMemoryEntry', {
    label: 'model',
    text: 'before'
  })) as import('@agentconnect.md/protocol').MemoryEntryMutationReceipt
  expect(f.commits[0]).toMatchObject({ source: 'tool', sourceTurnId: f.sourceTurnId })
  await expect(invoke('createMemoryEntry', { label: 'forged', text: 'x', source: 'distill' })).rejects.toThrow()
  decision = 'ask'
  await expect(
    executeTool(
      ctx,
      'deleteMemoryEntry',
      { ref: created.entry!.ref, revision: created.entry!.revision },
      {
        ...deps,
        memoryAccessDecision: (_ctx, mode) => (mode === 'read' ? 'deny' : 'ask')
      }
    )
  ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(approvals).toBe(0)
  const updated = (await invoke('updateMemoryEntry', {
    ref: created.entry!.ref,
    revision: created.entry!.revision,
    edit: { oldText: 'before', newText: '$& after' }
  })) as import('@agentconnect.md/protocol').MemoryEntryMutationReceipt
  expect(approvals).toBe(1)
  expect(targets).toEqual(['model'])
  await expect(
    invoke('deleteMemoryEntry', { ref: created.entry!.ref, revision: created.entry!.revision })
  ).rejects.toMatchObject({ code: 'CONFLICT' })
  expect(approvals).toBe(1)
  expect(await invoke('getMemoryEntry', { ref: updated.entry!.ref })).toMatchObject({
    text: expect.stringContaining('$& after')
  })
  approve = false
  await expect(
    invoke('deleteMemoryEntry', { ref: updated.entry!.ref, revision: updated.entry!.revision })
  ).rejects.toThrow('did not approve')
  expect(targets).toEqual(['model', 'model'])
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
      { ...ctx, memoryBinding: { source: 'distill', scope: { agentId: 'agent' } } },
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
    result: {
      operations: ['list', 'get', 'search', 'create', 'update', 'delete', 'history'],
      limits: { maxMutationRequestBytes: 196608 }
    }
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
