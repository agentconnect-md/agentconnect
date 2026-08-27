import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ShimRequester } from '../src/shim/channels.js'
import { ClusterSkillClient } from '../src/shim/skill-client.js'
import { ClusterSkillHandler } from '../src/shim/skill-handler.js'
import { MAX_CLUSTER_SKILL_CHUNK_BYTES } from '../src/shim/skill-protocol.js'
import { inspectLocalSkillSource } from '../src/skills/skill-source-snapshot.js'
import { treeDigest } from '../src/skills/skill-install-ledger.js'

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
      files: [file]
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
      files: [file]
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
