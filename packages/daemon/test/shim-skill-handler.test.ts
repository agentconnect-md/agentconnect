import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, symlink, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ShimRequester } from '../src/shim/channels.js'
import { ClusterSkillClient } from '../src/shim/skill-client.js'
import { ClusterSkillHandler } from '../src/shim/skill-handler.js'
import { MAX_CLUSTER_SKILL_CHUNK_BYTES } from '../src/shim/skill-protocol.js'

const sha256 = (value: Buffer): string => createHash('sha256').update(value).digest('hex')

async function fixture(content = Buffer.from('hello')) {
  const root = await mkdtemp(join(tmpdir(), 'ac-shim-skills-'))
  const operationId = randomUUID()
  const handler = new ClusterSkillHandler({ stagingRoot: join(root, 'staging'), inactiveMs: 1_000 })
  const begin = await handler.handle({
    op: 'begin',
    operationId,
    workspaceIncarnation: 'claim-1',
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
      workspaceIncarnation: 'claim',
      skillsAgentId: 'codex',
      files: [file]
    })
    await client.upload((calls[0] as { operationId: string }).operationId, handle, file, content)
    expect(calls).toHaveLength(3)
    expect(calls.at(-1)).toMatchObject({ offset: MAX_CLUSTER_SKILL_CHUNK_BYTES, final: true })
    const invalid = new ClusterSkillClient({ request: async () => ({ received: 1, complete: false, extra: true }) })
    await expect(invalid.upload(randomUUID(), handle, { ...file, size: 1 }, Buffer.from('x'))).rejects.toThrow()
  })
})
