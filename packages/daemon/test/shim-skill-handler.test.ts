import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ShimRequester } from '../src/shim/channels.js'
import { ClusterSkillClient } from '../src/shim/skill-client.js'
import { ClusterSkillHandler } from '../src/shim/skill-handler.js'
import {
  MAX_CLUSTER_SKILL_CHUNK_BYTES,
  MAX_CLUSTER_SKILL_CONTROL_BYTES,
  type ClusterSkillReconcile
} from '../src/shim/skill-protocol.js'
import {
  SkillGitAbortedError,
  runLocalSkillGit,
  type SkillGitInvocation,
  type SkillGitRunner
} from '../src/shim/skill-git-acquire.js'
import { skillGitCredentialFor } from '../src/shim/skill-git-plan.js'
import { inspectLocalSkillSource } from '../src/skills/skill-source-snapshot.js'
import { treeDigest } from '../src/skills/skill-install-ledger.js'
import { ClusterSkillCoordinator } from '../src/skills/cluster-skill-coordinator.js'
import { legacySandboxSkillLedger } from '../src/skills/sandbox-skill-ledger.js'
import { LocalStore } from '../src/store/local-store.js'
import { memoryStoreDatabase } from './store-support.js'

const sha256 = (value: Buffer): string => createHash('sha256').update(value).digest('hex')

async function fixture(content = Buffer.from('hello')) {
  const root = await mkdtemp(join(tmpdir(), 'ac-shim-skills-'))
  const operationId = randomUUID()
  const handler = new ClusterSkillHandler({ stagingRoot: join(root, 'staging'), inactiveMs: 1_000 })
  const begin = await handler.handle({
    op: 'begin',
    operationId,
    authority: {
      groupId: 'g',
      term: '1',
      daemonId: 'd',
      agentId: 'a',
      workspaceIncarnation: 'claim-1',
      shimGeneration: 1
    },
    skillsAgentId: 'codex',
    files: [{ sourceId: 'managed:a', path: 'nested/SKILL.md', size: content.length, sha256: sha256(content) }]
  })
  return { root, operationId, handler, handle: (begin as { handle: string }).handle, content }
}

describe('cluster skill shim staging', () => {
  it('skips a source whose selected skill set is oversized, publishing nothing for it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-skill-admission-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    try {
      const authority = {
        groupId: 'g',
        term: '1',
        daemonId: 'd',
        agentId: 'a',
        workspaceIncarnation: 'w',
        shimGeneration: 1
      }
      const handler = new ClusterSkillHandler({
        stagingRoot: join(root, 'staging'),
        workspaceRoot: workspace,
        stateRoot: join(root, 'state')
      })
      const client = new ClusterSkillClient({ request: (_cap, payload) => handler.handle(payload) }, true, true, true)
      const operationId = randomUUID()
      const bodies = Array.from({ length: 65 }, (_, index) =>
        Buffer.from(`---\nname: skill-${index}\ndescription: fixture\n---\n# Fixture\n`)
      )
      const files = bodies.map((body, index) => ({
        sourceId: 'source',
        path: `skill-${index}/SKILL.md`,
        size: body.length,
        sha256: sha256(body)
      }))
      const { handle } = await client.begin({ operationId, authority, skillsAgentId: 'codex', files })
      for (const [index, file] of files.entries()) await client.upload(operationId, handle, file, bodies[index]!)
      // 65 bundles exceed the cell's bundle cap. That is the SOURCE's problem, not the session's:
      // the reply names it under `skipped`, nothing of it is published, and the run still completes.
      const reply = await client.reconcile({
        operationId,
        handle,
        authority,
        priorRoots: [],
        replayKey: 'a'.repeat(64),
        allowDesiredAdoption: false,
        sources: [{ sourceId: 'source', sourceKind: 'managed', selections: [] }]
      })
      expect(reply.roots).toEqual([])
      expect(reply.skipped).toEqual([{ sourceId: 'source', reason: expect.stringContaining('too many bundles') }])
      expect(await readdir(workspace)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stages sources side by side: one failing its CLI stage is skipped, the other still publishes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-skill-parallel-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    try {
      const authority = {
        groupId: 'g',
        term: '1',
        daemonId: 'd',
        agentId: 'a',
        workspaceIncarnation: 'w',
        shimGeneration: 1
      }
      const handler = new ClusterSkillHandler({
        stagingRoot: join(root, 'staging'),
        workspaceRoot: workspace,
        stateRoot: join(root, 'state')
      })
      const client = new ClusterSkillClient({ request: (_cap, payload) => handler.handle(payload) }, true, true, true)
      const operationId = randomUUID()
      const skill = (name: string) => Buffer.from(`---\nname: ${name}\ndescription: fixture\n---\n# Fixture\n`)
      // `good` holds one skill; `bad` holds 65, past the cell's bundle cap.
      const bodies = new Map<string, Buffer>([['good\0good/SKILL.md', skill('good')]])
      for (let index = 0; index < 65; index++) bodies.set(`bad\0skill-${index}/SKILL.md`, skill(`skill-${index}`))
      const files = [...bodies].map(([key, body]) => {
        const [sourceId, path] = key.split('\0') as [string, string]
        return { sourceId, path, size: body.length, sha256: sha256(body) }
      })
      const { handle } = await client.begin({ operationId, authority, skillsAgentId: 'codex', files })
      for (const file of files) {
        await client.upload(operationId, handle, file, bodies.get(`${file.sourceId}\0${file.path}`)!)
      }
      const reply = await client.reconcile({
        operationId,
        handle,
        authority,
        priorRoots: [],
        replayKey: 'a'.repeat(64),
        allowDesiredAdoption: false,
        sources: [
          { sourceId: 'bad', sourceKind: 'managed', selections: [] },
          { sourceId: 'good', sourceKind: 'managed', selections: [] }
        ]
      })
      expect(reply.skipped).toEqual([{ sourceId: 'bad', reason: expect.stringContaining('too many bundles') }])
      // No Git plan, so the reply is the shape a daemon predating skill-git-in-pod-v1 parses strictly.
      expect(Object.keys(reply).sort()).toEqual(['conflicts', 'roots', 'skipped'])
      expect(Object.keys(reply.skipped![0]!).sort()).toEqual(['reason', 'sourceId'])
      expect(reply.roots.map((entry) => [entry.sourceId, entry.path.split('/').at(-1)])).toEqual([['good', 'good']])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses incomplete, out-of-order and superseded prior receipts before publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-skill-prior-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    try {
      const handler = new ClusterSkillHandler({
        stagingRoot: join(root, 'staging'),
        workspaceRoot: workspace,
        stateRoot: join(root, 'state')
      })
      const operationId = randomUUID()
      const authority = {
        groupId: 'g',
        term: '1',
        daemonId: 'd',
        agentId: 'a',
        workspaceIncarnation: 'w',
        shimGeneration: 1
      }
      const { handle } = await new ClusterSkillClient(
        { request: (_cap, payload) => handler.handle(payload) },
        true,
        true,
        true
      ).begin({ operationId, authority, skillsAgentId: 'codex', files: [] })
      const files = [{ path: 'SKILL.md', mode: 0o600, size: 0, sha256: sha256(Buffer.alloc(0)) }]
      const roots = [
        { path: '.agents/skills/one', sourceId: 'source', sourceKind: 'managed', digest: treeDigest(files), files }
      ]
      await expect(handler.handle({ op: 'prior', operationId, handle, offset: 1, roots })).rejects.toThrow(
        'unexpected prior skill receipt offset'
      )
      await expect(handler.handle({ op: 'prior', operationId, handle, offset: 0, roots })).resolves.toEqual({
        received: 1
      })
      await expect(
        handler.handle({
          op: 'reconcile',
          operationId,
          handle,
          authority,
          priorRoots: [],
          priorRootCount: 2,
          replayKey: 'a'.repeat(64),
          allowDesiredAdoption: false,
          sources: []
        })
      ).rejects.toThrow('cluster skill prior receipt is incomplete')
      await handler.handle({
        op: 'begin',
        operationId: randomUUID(),
        authority: { ...authority, term: '2' },
        skillsAgentId: 'codex',
        files: []
      })
      await expect(handler.handle({ op: 'prior', operationId, handle, offset: 1, roots })).rejects.toThrow(
        'lost duty authority'
      )
      expect(await readdir(workspace)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('commits, migrates, verifies and removes a receipt larger than one frame', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-skill-receipts-'))
    const workspace = join(root, 'workspace')
    const stateRoot = join(root, 'state')
    await mkdir(workspace)
    const store = await LocalStore.open({
      database: memoryStoreDatabase(),
      shared: true,
      ownerId: 'member-a',
      orgForAgent: () => 'org'
    })
    try {
      const authority = {
        groupId: 'g',
        term: '1',
        daemonId: 'member-a',
        agentId: 'a',
        workspaceIncarnation: 'workspace'
      }
      await store.projectDutyWriteFence({ groupId: 'g', term: '1', daemonId: 'member-a' })
      const sources = []
      const nested = ['a', 'b', 'c', 'd'].map((letter) => letter.repeat(180))
      for (let index = 0; index < 6; index++) {
        const name = `skill-${index}`
        const sourceDir = join(root, name)
        await mkdir(join(sourceDir, ...nested), { recursive: true })
        await writeFile(join(sourceDir, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n# Fixture\n`)
        for (let file = 1; file < 50; file++) await writeFile(join(sourceDir, ...nested, `file-${file}.txt`), 'fixture')
        sources.push({
          sourceId: name,
          sourceKind: 'managed' as const,
          sourceDir,
          selections: [name],
          expectedLeaves: [name]
        })
      }
      const handler = new ClusterSkillHandler({
        stagingRoot: join(root, 'staging'),
        workspaceRoot: workspace,
        stateRoot
      })
      const requests: string[] = []
      const client = new ClusterSkillClient(
        {
          request: async (_capability, payload) => {
            expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(MAX_CLUSTER_SKILL_CONTROL_BYTES)
            requests.push((payload as { op: string }).op)
            const reply = await handler.handle(payload)
            expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(MAX_CLUSTER_SKILL_CONTROL_BYTES)
            return reply
          }
        },
        true,
        true,
        true
      )
      const coordinator = new ClusterSkillCoordinator(store)
      const common = { authority, skillsAgentId: 'codex', shimGeneration: 1, client }
      const ledger = await coordinator.reconcile({ ...common, sources })
      expect(ledger.roots.flatMap((root) => root.files)).toHaveLength(300)
      expect(Buffer.byteLength(JSON.stringify(ledger))).toBeGreaterThan(MAX_CLUSTER_SKILL_CONTROL_BYTES)
      expect((await store.clusterSkillLedger('a', 'workspace'))?.ledger).toEqual(ledger)
      expect((await legacySandboxSkillLedger('cluster-shim', workspace, stateRoot))?.roots).toHaveLength(6)
      expect(await client.verify(ledger.roots)).toEqual({ intact: Array(6).fill(true) })
      expect(requests.filter((op) => op === 'verify').length).toBeGreaterThan(1)
      expect(requests).toContain('receipt')
      await expect(coordinator.reconcile({ ...common, sources: [] })).resolves.toMatchObject({ roots: [] })
      expect(requests.filter((op) => op === 'prior').length).toBeGreaterThan(1)
      expect(await readdir(join(workspace, '.agents/skills'))).toEqual([])
      expect((await store.clusterSkillLedger('a', 'workspace'))?.revision).toBe(2)
    } finally {
      await store.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('assembles a paged manifest and enforces the totals no single page can see', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-shim-paged-'))
    const handler = new ClusterSkillHandler({ stagingRoot: join(root, 'staging'), inactiveMs: 1_000 })
    const operationId = randomUUID()
    const authority = {
      groupId: 'g',
      term: '1',
      daemonId: 'd',
      agentId: 'a',
      workspaceIncarnation: 'claim-1',
      shimGeneration: 1
    }
    const body = Buffer.from('12345678')
    const files = Array.from({ length: 1_500 }, (_unused, index) => ({
      sourceId: 'agent:0',
      path: `docs/note-${index}.md`,
      size: body.length,
      sha256: sha256(body)
    }))
    const requester: ShimRequester = { request: (_capability, payload) => handler.handle(payload) }
    const reply = await new ClusterSkillClient(requester, true).begin({
      operationId,
      authority,
      skillsAgentId: 'universal',
      files
    })

    // Every file arrived across pages, and the assembled set — not any one page — is what upload sees.
    await expect(
      handler.handle({
        op: 'upload',
        operationId,
        handle: reply.handle,
        sourceId: 'agent:0',
        path: 'docs/note-1499.md',
        offset: 0,
        data: body.toString('base64'),
        final: true
      })
    ).resolves.toEqual({ received: 8, complete: true })

    // A page after the client declared the last one is refused.
    await expect(
      handler.handle({ op: 'manifest', operationId, handle: reply.handle, files: [files[0]!], moreFiles: false })
    ).rejects.toThrow(/manifest is already complete/)

    // A page repeating an EARLIER page's file, while the manifest is still open: only the
    // receiver holds the assembled set, so no per-page check could catch this one.
    const openId = randomUUID()
    const open = (await handler.handle({
      op: 'begin',
      operationId: openId,
      authority: { ...authority, term: '2' },
      skillsAgentId: 'universal',
      files: [files[0]!],
      moreFiles: true
    })) as { handle: string }
    await expect(
      handler.handle({
        op: 'manifest',
        operationId: openId,
        handle: open.handle,
        files: [files[0]!],
        moreFiles: false
      })
    ).rejects.toThrow(/duplicate cluster skill manifest file/)
  })

  it('mints a handle and accepts only ordered chunks through verified finalization', async () => {
    const f = await fixture()
    await expect(
      f.handler.handle({
        op: 'upload',
        operationId: f.operationId,
        handle: f.handle,
        sourceId: 'managed:a',
        path: 'nested/SKILL.md',
        offset: 2,
        data: Buffer.from('x').toString('base64'),
        final: false
      })
    ).rejects.toThrow(/offset/)
    expect(
      await f.handler.handle({
        op: 'upload',
        operationId: f.operationId,
        handle: f.handle,
        sourceId: 'managed:a',
        path: 'nested/SKILL.md',
        offset: 0,
        data: f.content.toString('base64'),
        final: true
      })
    ).toEqual({ received: 5, complete: true })
    expect(
      await f.handler.handle({
        op: 'upload',
        operationId: f.operationId,
        handle: f.handle,
        sourceId: 'managed:a',
        path: 'nested/SKILL.md',
        offset: 0,
        data: f.content.toString('base64'),
        final: true
      })
    ).toEqual({ received: 5, complete: true })
    expect(await readFile(f.handler.stagedFile(f.handle, 'managed:a', 'nested/SKILL.md'))).toEqual(f.content)
  })

  it('rejects size and digest mismatches and removes the operation', async () => {
    const f = await fixture()
    await expect(
      f.handler.handle({
        op: 'upload',
        operationId: f.operationId,
        handle: f.handle,
        sourceId: 'managed:a',
        path: 'nested/SKILL.md',
        offset: 0,
        data: Buffer.from('wrong').toString('base64'),
        final: true
      })
    ).rejects.toThrow(/digest/)
    await expect(lstat(join(f.root, 'staging', f.handle))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a symlink planted in the staging descent', async () => {
    const f = await fixture()
    const sourceRoot = join(f.root, 'staging', f.handle, sha256(Buffer.from('managed:a')))
    await mkdir(sourceRoot, { recursive: true })
    await symlink(tmpdir(), join(sourceRoot, 'nested'))
    await expect(
      f.handler.handle({
        op: 'upload',
        operationId: f.operationId,
        handle: f.handle,
        sourceId: 'managed:a',
        path: 'nested/SKILL.md',
        offset: 0,
        data: f.content.toString('base64'),
        final: true
      })
    ).rejects.toThrow(/symlink/)
  })

  it('cleans cancelled and inactive operations', async () => {
    const f = await fixture()
    const abort = new AbortController()
    abort.abort()
    await expect(
      f.handler.handle(
        {
          op: 'upload',
          operationId: f.operationId,
          handle: f.handle,
          sourceId: 'managed:a',
          path: 'nested/SKILL.md',
          offset: 0,
          data: 'aA==',
          final: false
        },
        abort.signal
      )
    ).rejects.toThrow(/aborted/)
    await expect(lstat(join(f.root, 'staging', f.handle))).rejects.toMatchObject({ code: 'ENOENT' })
    const old = await fixture()
    const date = new Date(Date.now() - 5_000)
    await utimes(join(old.root, 'staging', old.handle), date, date)
    expect(await old.handler.gcInactive()).toBe(1)
  })

  it('chunks daemon uploads and parses every shim response strictly', async () => {
    const content = Buffer.alloc(MAX_CLUSTER_SKILL_CHUNK_BYTES + 1, 7)
    const calls: unknown[] = []
    const requester: ShimRequester = {
      async request(_capability, payload) {
        calls.push(payload)
        const upload = payload as { op: string; offset?: number; data?: string }
        if (upload.op === 'begin') return { handle: 'opaque-handle-1234' }
        return { received: upload.offset! + Buffer.from(upload.data!, 'base64').length, complete: calls.length === 3 }
      }
    }
    const client = new ClusterSkillClient(requester)
    const file = { sourceId: 'managed:a', path: 'SKILL.md', size: content.length, sha256: sha256(content) }
    const { handle } = await client.begin({
      operationId: randomUUID(),
      authority: {
        groupId: 'g',
        term: '1',
        daemonId: 'd',
        agentId: 'a',
        workspaceIncarnation: 'claim',
        shimGeneration: 1
      },
      skillsAgentId: 'codex',
      files: [file]
    })
    await client.upload((calls[0] as { operationId: string }).operationId, handle, file, content)
    expect(calls).toHaveLength(3)
    expect(calls.at(-1)).toMatchObject({ offset: MAX_CLUSTER_SKILL_CHUNK_BYTES, final: true })
    const invalid = new ClusterSkillClient({ request: async () => ({ received: 1, complete: false, extra: true }) })
    await expect(invalid.upload(randomUUID(), handle, { ...file, size: 1 }, Buffer.from('x'))).rejects.toThrow()
  })

  it('runs the pinned CLI and publishes a verified receipt', async () => {
    const content = Buffer.from('---\nname: cluster-golden\ndescription: cluster fixture\n---\n# Cluster\n')
    const script = Buffer.from('#!/bin/sh\nprintf executable\n')
    const root = await mkdtemp(join(tmpdir(), 'ac-shim-skills-reconcile-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const operationId = randomUUID()
    const handler = new ClusterSkillHandler({
      stagingRoot: join(root, 'staging'),
      workspaceRoot: workspace,
      stateRoot: join(root, 'state')
    })
    const file = { sourceId: 'managed:a', path: 'SKILL.md', size: content.length, sha256: sha256(content) }
    const scriptFile = { ...file, path: 'run.sh', size: script.length, sha256: sha256(script), executable: true }
    const authority = {
      groupId: 'g',
      term: '1',
      daemonId: 'd',
      agentId: 'a',
      workspaceIncarnation: 'claim',
      shimGeneration: 1
    }
    const begin = (await handler.handle({
      op: 'begin',
      operationId,
      authority,
      skillsAgentId: 'codex',
      files: [file, scriptFile]
    })) as { handle: string }
    await handler.handle({
      op: 'upload',
      operationId,
      handle: begin.handle,
      sourceId: file.sourceId,
      path: file.path,
      offset: 0,
      data: content.toString('base64'),
      final: true
    })
    await handler.handle({
      op: 'upload',
      operationId,
      handle: begin.handle,
      sourceId: scriptFile.sourceId,
      path: scriptFile.path,
      offset: 0,
      data: script.toString('base64'),
      final: true
    })
    const reply = await handler.handle({
      op: 'reconcile',
      operationId,
      handle: begin.handle,
      authority,
      priorRoots: [],
      replayKey: 'a'.repeat(64),
      allowDesiredAdoption: false,
      sources: [{ sourceId: file.sourceId, sourceKind: 'managed', selections: ['cluster-golden'] }]
    })
    expect(reply).toMatchObject({
      roots: [{ path: '.agents/skills/cluster-golden', sourceKind: 'managed' }],
      conflicts: []
    })
    if (process.platform !== 'win32') {
      expect((await lstat(join(workspace, '.agents/skills/cluster-golden/run.sh'))).mode & 0o777).toBe(0o700)
      expect((await lstat(join(workspace, '.agents/skills/cluster-golden/SKILL.md'))).mode & 0o777).toBe(0o600)
    }
    const replay = new ClusterSkillHandler({
      stagingRoot: join(root, 'staging-replay'),
      workspaceRoot: workspace,
      stateRoot: join(root, 'state')
    })
    const replayBegin = (await replay.handle({
      op: 'begin',
      operationId,
      authority,
      skillsAgentId: 'codex',
      files: [file, scriptFile]
    })) as { handle: string }
    await replay.handle({
      op: 'upload',
      operationId,
      handle: replayBegin.handle,
      sourceId: file.sourceId,
      path: file.path,
      offset: 0,
      data: content.toString('base64'),
      final: true
    })
    await replay.handle({
      op: 'upload',
      operationId,
      handle: replayBegin.handle,
      sourceId: scriptFile.sourceId,
      path: scriptFile.path,
      offset: 0,
      data: script.toString('base64'),
      final: true
    })
    await expect(
      replay.handle({
        op: 'reconcile',
        operationId,
        handle: replayBegin.handle,
        authority,
        priorRoots: [],
        replayKey: 'a'.repeat(64),
        allowDesiredAdoption: false,
        sources: [{ sourceId: file.sourceId, sourceKind: 'managed', selections: ['cluster-golden'] }]
      })
    ).resolves.toMatchObject({ roots: [{ path: '.agents/skills/cluster-golden' }], conflicts: [] })
    expect(await readFile(join(workspace, '.agents/skills/cluster-golden/SKILL.md'), 'utf8')).toContain('# Cluster')
  }, 120_000)

  it('publishes a bundle carrying a multi-MiB asset end to end (cell, snapshot, ledger and mutation helper agree)', async () => {
    // Every validator on the path must admit what the first one admits: a 1 MiB asset was refused
    // by the old 512 KiB receipt checks even once staging let it through.
    const skill = Buffer.from('---\nname: with-asset\ndescription: fixture\n---\n# Asset\n')
    const asset = Buffer.alloc(1024 * 1024 + 7, 0x41)
    const root = await mkdtemp(join(tmpdir(), 'ac-shim-skills-asset-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const operationId = randomUUID()
    const handler = new ClusterSkillHandler({
      stagingRoot: join(root, 'staging'),
      workspaceRoot: workspace,
      stateRoot: join(root, 'state')
    })
    const client = new ClusterSkillClient({ request: (_cap, payload) => handler.handle(payload) }, true, true, true)
    const authority = {
      groupId: 'g',
      term: '1',
      daemonId: 'd',
      agentId: 'a',
      workspaceIncarnation: 'claim',
      shimGeneration: 1
    }
    const files = [
      { sourceId: 'managed:a', path: 'SKILL.md', size: skill.length, sha256: sha256(skill) },
      { sourceId: 'managed:a', path: 'assets/photo.bin', size: asset.length, sha256: sha256(asset) }
    ]
    const { handle } = await client.begin({ operationId, authority, skillsAgentId: 'codex', files })
    await client.upload(operationId, handle, files[0]!, skill)
    await client.upload(operationId, handle, files[1]!, asset)
    const reply = await client.reconcile({
      operationId,
      handle,
      authority,
      priorRoots: [],
      replayKey: 'd'.repeat(64),
      allowDesiredAdoption: false,
      sources: [{ sourceId: 'managed:a', sourceKind: 'managed', selections: ['with-asset'] }]
    })
    expect(reply.skipped).toBeUndefined()
    expect(reply.roots.map((r) => r.path)).toEqual(['.agents/skills/with-asset'])
    expect(reply.roots[0]!.files.find((f) => f.path === 'assets/photo.bin')?.size).toBe(asset.length)
    expect((await readFile(join(workspace, '.agents/skills/with-asset/assets/photo.bin'))).length).toBe(asset.length)
    await rm(root, { recursive: true, force: true })
  }, 120_000)

  it('keeps a skipped Git source’s PREVIOUS revision installed, even though its source id changed', async () => {
    // Revision A of `agent:0:dgst:<A>` installs; revision B of the same source (a different id,
    // since the id names the commit) fails staging with too many bundles. B is skipped and A's
    // bundle must stay — the run says nothing about intent — under A's own receipt.
    const A = 'a'.repeat(40)
    const B = 'b'.repeat(40)
    const body = Buffer.from('---\nname: keep-me\ndescription: fixture\n---\n# Keep\n')
    const root = await mkdtemp(join(tmpdir(), 'ac-shim-skills-revision-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const authority = {
      groupId: 'g',
      term: '1',
      daemonId: 'd',
      agentId: 'a',
      workspaceIncarnation: 'claim',
      shimGeneration: 1
    }
    const handler = new ClusterSkillHandler({
      stagingRoot: join(root, 'staging'),
      workspaceRoot: workspace,
      stateRoot: join(root, 'state')
    })
    const client = new ClusterSkillClient({ request: (_cap, payload) => handler.handle(payload) }, true, true, true)

    const firstId = `agent:0:dgst:${A}`
    const first = randomUUID()
    const firstFiles = [{ sourceId: firstId, path: 'keep-me/SKILL.md', size: body.length, sha256: sha256(body) }]
    const begunA = await client.begin({ operationId: first, authority, skillsAgentId: 'codex', files: firstFiles })
    await client.upload(first, begunA.handle, firstFiles[0]!, body)
    const installed = await client.reconcile({
      operationId: first,
      handle: begunA.handle,
      authority,
      priorRoots: [],
      replayKey: 'e'.repeat(64),
      allowDesiredAdoption: false,
      sources: [{ sourceId: firstId, sourceKind: 'agent', selections: ['keep-me'] }]
    })
    expect(installed.roots.map((r) => r.path)).toEqual(['.agents/skills/keep-me'])

    const secondId = `agent:0:dgst:${B}`
    const second = randomUUID()
    const bodies = Array.from({ length: 65 }, (_, i) =>
      Buffer.from(`---\nname: skill-${i}\ndescription: f\n---\n# ${i}\n`)
    )
    const secondFiles = bodies.map((b, i) => ({
      sourceId: secondId,
      path: `skill-${i}/SKILL.md`,
      size: b.length,
      sha256: sha256(b)
    }))
    const begunB = await client.begin({ operationId: second, authority, skillsAgentId: 'codex', files: secondFiles })
    for (const [i, file] of secondFiles.entries()) await client.upload(second, begunB.handle, file, bodies[i]!)
    const reply = await client.reconcile({
      operationId: second,
      handle: begunB.handle,
      authority,
      priorRoots: installed.roots,
      replayKey: 'f'.repeat(64),
      allowDesiredAdoption: false,
      sources: [{ sourceId: secondId, sourceKind: 'agent', selections: [] }]
    })
    expect(reply.skipped).toEqual([{ sourceId: secondId, reason: expect.stringContaining('too many bundles') }])
    // A's bundle survived, still owned under A's id and kind.
    expect(reply.roots).toEqual([
      expect.objectContaining({ path: '.agents/skills/keep-me', sourceId: firstId, sourceKind: 'agent' })
    ])
    expect(await readFile(join(workspace, '.agents/skills/keep-me/SKILL.md'), 'utf8')).toContain('# Keep')
    await rm(root, { recursive: true, force: true })
  }, 120_000)

  it('uses the durable receipt to remove an owned root after pod-local state is lost', async () => {
    const content = Buffer.from('---\nname: replacement\ndescription: fixture\n---\n# Replacement\n')
    const root = await mkdtemp(join(tmpdir(), 'ac-shim-skills-replacement-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const authority = {
      groupId: 'g',
      term: '2',
      daemonId: 'd',
      agentId: 'a',
      workspaceIncarnation: 'claim',
      shimGeneration: 2
    }
    const first = new ClusterSkillHandler({
      stagingRoot: join(root, 'staging-1'),
      workspaceRoot: workspace,
      stateRoot: join(root, 'state-1')
    })
    const operationId = randomUUID()
    const file = { sourceId: 'managed:a', path: 'SKILL.md', size: content.length, sha256: sha256(content) }
    const begin = (await first.handle({
      op: 'begin',
      operationId,
      authority,
      skillsAgentId: 'codex',
      files: [file]
    })) as {
      handle: string
    }
    await first.handle({
      op: 'upload',
      operationId,
      handle: begin.handle,
      sourceId: file.sourceId,
      path: file.path,
      offset: 0,
      data: content.toString('base64'),
      final: true
    })
    const applied = (await first.handle({
      op: 'reconcile',
      operationId,
      handle: begin.handle,
      authority,
      priorRoots: [],
      replayKey: 'b'.repeat(64),
      allowDesiredAdoption: false,
      sources: [{ sourceId: file.sourceId, sourceKind: 'managed', selections: ['replacement'] }]
    })) as { roots: Array<Record<string, unknown>> }

    const replacement = new ClusterSkillHandler({
      stagingRoot: join(root, 'staging-2'),
      workspaceRoot: workspace,
      stateRoot: join(root, 'state-2')
    })
    const removeId = randomUUID()
    const removeBegin = (await replacement.handle({
      op: 'begin',
      operationId: removeId,
      authority,
      skillsAgentId: 'codex',
      files: []
    })) as { handle: string }
    await replacement.handle({
      op: 'reconcile',
      operationId: removeId,
      handle: removeBegin.handle,
      authority,
      priorRoots: applied.roots,
      replayKey: 'c'.repeat(64),
      allowDesiredAdoption: false,
      sources: []
    })
    await expect(lstat(join(workspace, '.agents/skills/replacement'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 120_000)

  it('fences the bound agent, shim generation, and monotonically observed duty term', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-shim-skills-fence-'))
    const handler = new ClusterSkillHandler({ stagingRoot: join(root, 'staging') })
    const base = {
      groupId: 'g',
      term: '7',
      daemonId: 'd',
      agentId: 'a',
      workspaceIncarnation: 'claim',
      shimGeneration: 3
    }
    await expect(
      handler.handle(
        { op: 'begin', operationId: randomUUID(), authority: base, skillsAgentId: 'codex', files: [] },
        undefined,
        { agentId: 'a', generation: 2 }
      )
    ).rejects.toThrow(/generation/)
    await handler.handle(
      { op: 'begin', operationId: randomUUID(), authority: { ...base, term: '8' }, skillsAgentId: 'codex', files: [] },
      undefined,
      { agentId: 'a', generation: 3 }
    )
    await expect(
      handler.handle(
        { op: 'begin', operationId: randomUUID(), authority: base, skillsAgentId: 'codex', files: [] },
        undefined,
        { agentId: 'a', generation: 3 }
      )
    ).rejects.toThrow(/stale/)
  })

  it('verifies exact receipts including mode, binary bytes, and unexpected files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-shim-skills-verify-'))
    const workspace = join(root, 'workspace')
    const skill = join(workspace, '.agents/skills/binary')
    await mkdir(skill, { recursive: true })
    const body = Buffer.from([0, 1, 2, 255])
    await writeFile(join(skill, 'SKILL.md'), '---\nname: binary\ndescription: fixture\n---\n')
    await writeFile(join(skill, 'asset.bin'), body, { mode: 0o600 })
    const inspected = await inspectLocalSkillSource(skill)
    const receiptFiles = inspected.files.map((file) => ({
      path: file.path,
      mode: file.mode & 0o111 ? 0o700 : 0o600,
      size: file.size,
      sha256: file.sha256.replace(/^sha256:/, '')
    }))
    const receipt = {
      path: '.agents/skills/binary',
      sourceId: 'managed:binary',
      sourceKind: 'managed' as const,
      digest: treeDigest(receiptFiles),
      files: receiptFiles
    }
    const handler = new ClusterSkillHandler({ stagingRoot: join(root, 'staging'), workspaceRoot: workspace })
    await expect(handler.handle({ op: 'verify', roots: [receipt] })).resolves.toEqual({ intact: [true] })
    await chmod(join(skill, 'asset.bin'), 0o700)
    await expect(handler.handle({ op: 'verify', roots: [receipt] })).resolves.toEqual({ intact: [false] })
    await chmod(join(skill, 'asset.bin'), 0o600)
    await writeFile(join(skill, 'extra.txt'), 'extra')
    await expect(handler.handle({ op: 'verify', roots: [receipt] })).resolves.toEqual({ intact: [false] })
  })
})

describe.skipIf(process.platform === 'win32')('cluster skill shim Git plan sources (real Git)', () => {
  const HOST = 'https://github.com/acme/'
  const GIT_URL = `${HOST}skills.git`
  const HELPER = '/opt/agentconnect/bin/git-credential'
  const SOCKET = '/run/agentconnect/gitcred.sock'
  const authority = {
    groupId: 'g',
    term: '1',
    daemonId: 'd',
    agentId: 'a',
    workspaceIncarnation: 'w',
    shimGeneration: 1
  }
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@e',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@e',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null'
  }
  const ok = (cwd: string, args: string[]): string => {
    const result = spawnSync('git', args, { cwd, env: gitEnv })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
    return result.stdout.toString().trim()
  }
  const body = (name: string): string => `---\nname: ${name}\ndescription: fixture\n---\n# ${name}\n`
  const gitId = (commit: string): string => `agent:0:${'d'.repeat(64)}:${commit}`

  // A bare origin whose `skills/` holds alpha (2 files) and beta (1 file), and the private dirs a shim works in.
  async function world() {
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'ac-shim-skills-git-')))
    const origin = join(root, 'skills.git')
    const seed = join(root, 'seed')
    ok(root, ['init', '-q', '--bare', '--initial-branch=main', origin])
    ok(origin, ['config', 'uploadpack.allowFilter', 'true'])
    await mkdir(join(seed, 'skills', 'alpha'), { recursive: true })
    await mkdir(join(seed, 'skills', 'beta'), { recursive: true })
    ok(seed, ['init', '-q', '--initial-branch=main'])
    await writeFile(join(seed, 'skills', 'alpha', 'SKILL.md'), body('alpha'))
    await writeFile(join(seed, 'skills', 'alpha', 'notes.md'), 'alpha notes\n')
    await writeFile(join(seed, 'skills', 'beta', 'SKILL.md'), body('beta'))
    await writeFile(join(seed, 'README.md'), 'outside the subdirectory\n')
    ok(seed, ['add', '-A'])
    ok(seed, ['commit', '-qm', 'one'])
    ok(seed, ['remote', 'add', 'origin', origin])
    ok(seed, ['push', '-q', 'origin', 'main'])
    const tip = ok(seed, ['rev-parse', 'HEAD'])
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const staging = join(root, 'staging')
    await mkdir(staging, { mode: 0o700 })
    return { root, origin, tip, workspace, staging, state: join(root, 'state') }
  }
  type World = Awaited<ReturnType<typeof world>>

  // The real runner behind the test's github.com names: `<HOST><name>.git` is `<root>/<name>.git`.
  function runner(w: World, onSpawn?: (invocation: SkillGitInvocation) => void) {
    const calls: SkillGitInvocation[] = []
    const git: SkillGitRunner = async (invocation) => {
      calls.push(invocation)
      onSpawn?.(invocation)
      const args = invocation.args.map((arg) =>
        arg.startsWith(HOST) ? `file://${join(w.root, arg.slice(HOST.length))}` : arg
      )
      return await runLocalSkillGit({ ...invocation, args })
    }
    return { git, calls }
  }

  function handlerFor(
    w: World,
    git: SkillGitRunner,
    options: {
      logs?: string[]
      limits?: { maxFiles: number }
      manifestFiles?: number
      sourceTimeoutMs?: number
      deadlineMs?: number
    } = {}
  ): ClusterSkillHandler {
    return new ClusterSkillHandler({
      stagingRoot: w.staging,
      workspaceRoot: w.workspace,
      stateRoot: w.state,
      git: {
        git,
        allowFileProtocol: true,
        shimEnv: { PATH: process.env.PATH },
        credentialHelper: HELPER,
        credentialSocket: SOCKET,
        log: { warn: (message) => options.logs?.push(message) },
        ...(options.limits ? { limits: options.limits } : {}),
        ...(options.sourceTimeoutMs !== undefined ? { sourceTimeoutMs: options.sourceTimeoutMs } : {}),
        ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {})
      },
      ...(options.manifestFiles !== undefined
        ? { manifestLimits: { maxFiles: options.manifestFiles, maxTotalBytes: 1024 * 1024 } }
        : {})
    })
  }

  const plan = (w: World, overrides: Record<string, unknown> = {}) => ({
    sourceId: gitId(w.tip),
    sourceKind: 'git' as const,
    url: GIT_URL,
    ref: 'refs/heads/main',
    plannedCommit: w.tip,
    subDir: 'skills',
    selections: ['alpha'],
    ...overrides
  })

  // Uploads `files` per source id, then reconciles `sources` through the daemon's client.
  async function reconcile(
    handler: ClusterSkillHandler,
    input: {
      uploads?: Record<string, Record<string, string>>
      sources: ClusterSkillReconcile['sources']
      priorRoots?: ClusterSkillReconcile['priorRoots']
      credentialWindow?: { capability: string }
    }
  ) {
    const client = new ClusterSkillClient(
      { request: (_cap, payload) => handler.handle(payload) },
      true,
      true,
      true,
      true
    )
    const operationId = randomUUID()
    const contents = Object.entries(input.uploads ?? {}).flatMap(([sourceId, files]) =>
      Object.entries(files).map(([path, text]) => ({ sourceId, path, content: Buffer.from(text) }))
    )
    const files = contents.map(({ sourceId, path, content }) => ({
      sourceId,
      path,
      size: content.length,
      sha256: sha256(content)
    }))
    const { handle } = await client.begin({ operationId, authority, skillsAgentId: 'codex', files })
    for (const [index, file] of files.entries())
      await client.upload(operationId, handle, file, contents[index]!.content)
    return await client.reconcile({
      operationId,
      handle,
      authority,
      priorRoots: input.priorRoots ?? [],
      replayKey: randomBytes(32).toString('hex'),
      allowDesiredAdoption: false,
      sources: input.sources,
      ...(input.credentialWindow ? { credentialWindow: input.credentialWindow } : {})
    })
  }

  const managed = { 'managed:m': { 'mskill/SKILL.md': body('mskill'), 'mskill/extra.md': 'extra\n' } }
  const dream = { 'dream:d': { 'dskill/SKILL.md': body('dskill') } }
  const uploaded = [
    { sourceId: 'managed:m', sourceKind: 'managed' as const, selections: ['mskill'] },
    { sourceId: 'dream:d', sourceKind: 'dream' as const, selections: ['dskill'] }
  ]
  const leaves = (roots: Array<{ path: string }>): string[] => roots.map((root) => root.path.split('/').at(-1)!).sort()

  async function filesUnder(dir: string): Promise<string[]> {
    const found: string[] = []
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) found.push(path, ...(await filesUnder(path)))
      else found.push(path)
    }
    return found
  }

  it('merges Git plan, managed and Dream sources in source order and reports the Git result', async () => {
    const w = await world()
    try {
      const r = runner(w)
      const reply = await reconcile(handlerFor(w, r.git), {
        uploads: { ...managed, ...dream },
        sources: [plan(w), ...uploaded]
      })
      expect(reply.roots.map((root) => [root.sourceId, root.sourceKind, root.path.split('/').at(-1)])).toEqual([
        [gitId(w.tip), 'agent', 'alpha'],
        ['dream:d', 'dream', 'dskill'],
        ['managed:m', 'managed', 'mskill']
      ])
      expect(reply.gitSources).toEqual([{ sourceId: gitId(w.tip), resolvedCommit: w.tip, leaves: ['alpha'] }])
      expect(reply.skipped).toBeUndefined()
      expect(await readFile(join(w.workspace, '.agents/skills/alpha/notes.md'), 'utf8')).toBe('alpha notes\n')
      expect(existsSync(join(w.workspace, '.agents/skills/beta'))).toBe(false)
      expect(r.calls.every((call) => call.env.AC_GITCRED_CAPABILITY === undefined)).toBe(true)
      expect(await readdir(w.staging)).toEqual([])
    } finally {
      await rm(w.root, { recursive: true, force: true })
    }
  }, 120_000)

  it('gives a later source precedence over a Git plan Source on the same skill', async () => {
    const w = await world()
    try {
      const reply = await reconcile(handlerFor(w, runner(w).git), {
        uploads: { 'managed:m': { 'alpha/SKILL.md': body('alpha') } },
        sources: [plan(w), { sourceId: 'managed:m', sourceKind: 'managed', selections: ['alpha'] }]
      })
      expect(reply.roots.map((root) => [root.sourceId, root.path])).toEqual([['managed:m', '.agents/skills/alpha']])
      expect(existsSync(join(w.workspace, '.agents/skills/alpha/notes.md'))).toBe(false)
    } finally {
      await rm(w.root, { recursive: true, force: true })
    }
  }, 120_000)

  const budgetCases = [
    { order: 'git-first', manifestFiles: 6, git: 'installed', installed: ['alpha', 'dskill', 'mskill'], dropped: [] },
    { order: 'git-first', manifestFiles: 4, git: 'installed', installed: ['alpha', 'dskill'], dropped: ['managed:m'] },
    { order: 'git-last', manifestFiles: 4, git: 'installed', installed: ['alpha', 'dskill'], dropped: ['managed:m'] },
    { order: 'git-first', manifestFiles: 3, git: 'installed', installed: ['alpha'], dropped: ['managed:m', 'dream:d'] },
    { order: 'git-first', manifestFiles: 2, git: 'dropped', installed: ['mskill'], dropped: ['git', 'dream:d'] },
    { order: 'git-first', manifestFiles: 3, git: 'fetch_failed', installed: ['dskill', 'mskill'], dropped: [] }
  ] as const

  it.each(budgetCases)(
    'charges one budget Git first, then managed, then Dream: %j',
    async ({ order, manifestFiles, git, installed, dropped }) => {
      const w = await world()
      try {
        const source = git === 'fetch_failed' ? plan(w, { url: `${HOST}absent.git` }) : plan(w)
        const reply = await reconcile(handlerFor(w, runner(w).git, { manifestFiles }), {
          uploads: { ...managed, ...dream },
          sources: order === 'git-first' ? [source, ...uploaded] : [...uploaded, source]
        })
        expect(leaves(reply.roots)).toEqual(installed)
        const ids = dropped.map((id) => (id === 'git' ? source.sourceId : id))
        expect(new Set(reply.skipped ?? [])).toEqual(
          new Set([
            ...(git === 'fetch_failed'
              ? [expect.objectContaining({ sourceId: source.sourceId, code: 'fetch_failed' })]
              : []),
            ...ids.map((sourceId) => ({ sourceId, reason: expect.any(String), code: 'limits_exceeded' }))
          ])
        )
      } finally {
        await rm(w.root, { recursive: true, force: true })
      }
    },
    120_000
  )

  it('prunes a managed source the Git Source pushed out of the budget, as the daemon path does', async () => {
    const w = await world()
    try {
      const r = runner(w)
      const first = await reconcile(handlerFor(w, r.git), { uploads: managed, sources: [uploaded[0]!] })
      expect(leaves(first.roots)).toEqual(['mskill'])
      const second = await reconcile(handlerFor(w, r.git, { manifestFiles: 4 }), {
        uploads: managed,
        sources: [plan(w), uploaded[0]!],
        priorRoots: first.roots
      })
      expect(leaves(second.roots)).toEqual(['alpha'])
      expect(second.skipped).toEqual([expect.objectContaining({ sourceId: 'managed:m', code: 'limits_exceeded' })])
      expect(existsSync(join(w.workspace, '.agents/skills/mskill'))).toBe(false)
    } finally {
      await rm(w.root, { recursive: true, force: true })
    }
  }, 120_000)

  it.each([
    ['ref_moved', { plannedCommit: 'f'.repeat(40) }, {}],
    ['fetch_failed', { url: `${HOST}absent.git` }, {}],
    ['limits_exceeded', {}, { limits: { maxFiles: 1 } }]
  ] as const)(
    'a %s Source keeps its prior root and reports its code',
    async (code, change, options) => {
      const w = await world()
      try {
        const first = await reconcile(handlerFor(w, runner(w).git), { sources: [plan(w)] })
        expect(leaves(first.roots)).toEqual(['alpha'])
        const next = plan(w, { ...change, sourceId: gitId('e'.repeat(40)) })
        const reply = await reconcile(handlerFor(w, runner(w).git, options), {
          uploads: managed,
          sources: [next, uploaded[0]!],
          priorRoots: first.roots
        })
        expect(reply.skipped).toEqual([{ sourceId: next.sourceId, reason: expect.any(String), code }])
        expect(reply.roots.map((root) => [root.sourceId, root.path.split('/').at(-1)])).toEqual([
          [gitId(w.tip), 'alpha'],
          ['managed:m', 'mskill']
        ])
        expect(reply.gitSources).toBeUndefined()
        expect(await readFile(join(w.workspace, '.agents/skills/alpha/SKILL.md'), 'utf8')).toBe(body('alpha'))
        expect(await readdir(w.staging)).toEqual([])
      } finally {
        await rm(w.root, { recursive: true, force: true })
      }
    },
    120_000
  )

  it('keeps a keepInstalled Source’s roots without cloning it', async () => {
    const w = await world()
    try {
      const first = await reconcile(handlerFor(w, runner(w).git), { sources: [plan(w)] })
      const r = runner(w)
      const reply = await reconcile(handlerFor(w, r.git), {
        sources: [plan(w, { keepInstalled: true })],
        priorRoots: first.roots
      })
      expect(r.calls).toEqual([])
      expect(reply.roots).toEqual(first.roots)
      expect(reply.skipped).toBeUndefined()
      expect(reply.gitSources).toEqual([{ sourceId: gitId(w.tip), resolvedCommit: w.tip, leaves: ['alpha'] }])
    } finally {
      await rm(w.root, { recursive: true, force: true })
    }
  }, 120_000)

  it('answers a reconcile without Git entries in the pre-skill-git-in-pod-v1 shape, spawning no Git', async () => {
    const w = await world()
    try {
      const r = runner(w)
      const reply = await reconcile(handlerFor(w, r.git), { uploads: managed, sources: [uploaded[0]!] })
      expect(Object.keys(reply).sort()).toEqual(['conflicts', 'roots'])
      expect(r.calls).toEqual([])
    } finally {
      await rm(w.root, { recursive: true, force: true })
    }
  }, 120_000)

  it('hands the window capability only to the Git child env, never to disk or a log', async () => {
    const w = await world()
    try {
      const capability = randomBytes(32).toString('base64url')
      const logs: string[] = []
      const onDisk: string[] = []
      const scan = async (): Promise<void> => {
        for (const path of await filesUnder(w.root)) {
          if ((await lstat(path)).isFile() && (await readFile(path)).includes(capability)) onDisk.push(path)
        }
      }
      const spawned: Array<Promise<void>> = []
      const r = runner(w, () => spawned.push(scan()))
      const reply = await reconcile(handlerFor(w, r.git, { logs }), {
        sources: [plan(w), plan(w, { sourceId: 'agent:1', url: `${HOST}absent.git` })],
        credentialWindow: { capability }
      })
      await Promise.all(spawned)
      await scan()
      expect(leaves(reply.roots)).toEqual(['alpha'])
      expect(r.calls.length).toBeGreaterThan(0)
      for (const call of r.calls) {
        expect(call.env.AC_GITCRED_CAPABILITY).toBe(capability)
        expect(call.env.AC_GITCRED_AGENT).toBe('a')
        expect(call.env.AC_GITCRED_SOCKET).toBe(SOCKET)
        const config = Object.entries(call.env).filter(([key]) => key.startsWith('GIT_CONFIG_VALUE_'))
        expect(config.map(([, value]) => value)).toContain(`!sh '${HELPER}' 'a'`)
        expect(call.args.join(' ')).not.toContain(capability)
      }
      expect(logs.length).toBeGreaterThan(0)
      expect(logs.join('\n')).not.toContain(capability)
      expect(onDisk).toEqual([])
      expect(process.env.AC_GITCRED_CAPABILITY).not.toBe(capability)

      const after = runner(w)
      await reconcile(handlerFor(w, after.git), { sources: [plan(w)], priorRoots: reply.roots })
      expect(after.calls.length).toBeGreaterThan(0)
      expect(after.calls.every((call) => call.env.AC_GITCRED_CAPABILITY === undefined)).toBe(true)
    } finally {
      await rm(w.root, { recursive: true, force: true })
    }
  }, 120_000)

  it('removes a Git Source’s staging when the reconcile fails part-way', async () => {
    const w = await world()
    try {
      const abort = new AbortController()
      const r = runner(w, () => abort.abort())
      const handler = handlerFor(w, r.git)
      const operationId = randomUUID()
      const { handle } = (await handler.handle({
        op: 'begin',
        operationId,
        authority,
        skillsAgentId: 'codex',
        files: []
      })) as { handle: string }
      await expect(
        handler.handle(
          {
            op: 'reconcile',
            operationId,
            handle,
            authority,
            priorRoots: [],
            replayKey: 'a'.repeat(64),
            allowDesiredAdoption: false,
            sources: [plan(w)]
          },
          abort.signal
        )
      ).rejects.toThrow()
      expect(r.calls.length).toBeGreaterThan(0)
      expect((await filesUnder(w.staging)).filter((path) => path.includes('skill-git-'))).toEqual([])
      expect(existsSync(join(w.staging, handle, createHash('sha256').update(gitId(w.tip)).digest('hex')))).toBe(false)
      expect(await readdir(w.workspace)).toEqual([])
    } finally {
      await rm(w.root, { recursive: true, force: true })
    }
  }, 120_000)

  // A remote that accepts the connection and never answers: the spawn ends only when its signal fires.
  function stalling(w: World) {
    const real = runner(w)
    const stalled: SkillGitInvocation[] = []
    const git: SkillGitRunner = async (invocation) => {
      if (!invocation.args.some((arg) => arg.startsWith(`${HOST}stall`))) return await real.git(invocation)
      stalled.push(invocation)
      return await new Promise((_resolve, reject) => {
        const fail = () => reject(new SkillGitAbortedError('git was cancelled'))
        if (invocation.abort?.aborted) fail()
        else invocation.abort?.addEventListener('abort', fail, { once: true })
      })
    }
    return { git, stalled }
  }

  it('skips a stalled Source at its deadline and still installs the others', async () => {
    const w = await world()
    try {
      const r = stalling(w)
      const stall = plan(w, { sourceId: 'agent:stall', url: `${HOST}stall.git` })
      const reply = await reconcile(handlerFor(w, r.git, { sourceTimeoutMs: 200 }), {
        uploads: managed,
        sources: [stall, uploaded[0]!]
      })
      expect(r.stalled.length).toBeGreaterThan(0)
      expect(leaves(reply.roots)).toEqual(['mskill'])
      expect(reply.skipped).toEqual([
        { sourceId: 'agent:stall', reason: 'fetching the repository timed out', code: 'fetch_failed' }
      ])
      expect(reply.gitSources ?? []).toEqual([])
      expect(await readdir(w.staging)).toEqual([])
    } finally {
      await rm(w.root, { recursive: true, force: true })
    }
  }, 120_000)

  it('skips every Source the acquisition deadline reaches, started or not, without failing the reconcile', async () => {
    const w = await world()
    try {
      const r = stalling(w)
      const stalls = [1, 2, 3, 4, 5].map((n) => plan(w, { sourceId: `agent:stall${n}`, url: `${HOST}stall${n}.git` }))
      const reply = await reconcile(handlerFor(w, r.git, { deadlineMs: 200 }), { sources: stalls })
      expect(reply.roots).toEqual([])
      expect(reply.skipped?.map((entry) => [entry.sourceId, entry.code])).toEqual(
        stalls.map((entry) => [entry.sourceId, 'fetch_failed'])
      )
      expect(r.stalled.some((call) => call.args.includes(`${HOST}stall5.git`))).toBe(false)
      expect(await readdir(w.staging)).toEqual([])
    } finally {
      await rm(w.root, { recursive: true, force: true })
    }
  }, 120_000)

  it('skips a keepInstalled Source that has no installed root instead of claiming it', async () => {
    const w = await world()
    try {
      const r = runner(w)
      const reply = await reconcile(handlerFor(w, r.git), { sources: [plan(w, { keepInstalled: true })] })
      expect(r.calls).toEqual([])
      expect(reply.roots).toEqual([])
      expect(reply.gitSources ?? []).toEqual([])
      expect(reply.skipped).toEqual([
        { sourceId: gitId(w.tip), reason: 'no installed revision to keep', code: 'commit_unavailable' }
      ])
    } finally {
      await rm(w.root, { recursive: true, force: true })
    }
  }, 120_000)

  it('attaches the window credential only to a github.com Source', () => {
    const deps = { credentialHelper: HELPER, credentialSocket: SOCKET }
    const window = { capability: 'cap' }
    const gitlab = { ...plan({ tip: 'a'.repeat(40) } as World), url: 'https://gitlab.com/o/r.git' }
    expect(skillGitCredentialFor(gitlab, window, 'a', deps)).toBeUndefined()
    const github = { ...gitlab, url: 'https://github.com/o/r.git' }
    expect(skillGitCredentialFor(github, window, 'a', deps)?.env.AC_GITCRED_CAPABILITY).toBe('cap')
    expect(skillGitCredentialFor(github, undefined, 'a', deps)).toBeUndefined()
  })
})
