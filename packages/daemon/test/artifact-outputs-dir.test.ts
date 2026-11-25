// A fetched revision replaces one `outputs/<dir>/` whole, on the descriptor arm and the WorkspaceFs arm alike.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { replaceOutputsDir } from '../src/artifacts/outputs-dir.js'
import type { SaveAttachmentTarget } from '../src/mcp/ops/save-attachment.js'
import { canonicalWorkspacePath } from '../src/workspace/workspace-files.js'
import { localWorkspaceFs } from '../src/workspace/workspace-fs.js'
import { putObjectBytes, PutObjectError } from '../src/source-cache/put-object.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'artifact-outputs-')))
  roots.push(root)
  mkdirSync(join(root, 'files'), { recursive: true })
  return root
}

type Arm = [string, (root: string) => SaveAttachmentTarget]
const pinned: Arm = ['pinned', (root) => ({ kind: 'pinned', root, segments: ['files'] })]
const workspaceFs: Arm = [
  'workspace-fs',
  (root) => ({
    kind: 'workspace-fs',
    fs: localWorkspaceFs,
    root,
    segments: ['files'],
    canonicalDir: canonicalWorkspacePath
  })
]
const arms: Arm[] = process.platform === 'linux' ? [pinned, workspaceFs] : [workspaceFs]

describe.each(arms)('replaceOutputsDir (%s)', (_arm, targetFor) => {
  it('writes nested files and replaces an earlier fetch only once every file landed', async () => {
    const root = scratch()
    const first = await replaceOutputsDir(targetFor(root), 'report-0f8fad5b', async (put) => {
      await put('index.html', Buffer.from('v1'))
      await put('old.css', Buffer.from('gone later'))
    })
    expect(first).toEqual({
      ok: true,
      path: join(root, 'files', 'outputs', 'report-0f8fad5b'),
      name: 'files:outputs/report-0f8fad5b'
    })
    await replaceOutputsDir(targetFor(root), 'report-0f8fad5b', async (put) => {
      await put('index.html', Buffer.from('v2'))
      await put('img/deep/logo.svg', Buffer.from('<svg/>'))
    })
    const dir = join(root, 'files', 'outputs', 'report-0f8fad5b')
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe('v2')
    expect(readFileSync(join(dir, 'img', 'deep', 'logo.svg'), 'utf8')).toBe('<svg/>')
    expect(readdirSync(dir).sort()).toEqual(['img', 'index.html'])
    // No staging directory is left beside it.
    expect(readdirSync(join(root, 'files', 'outputs'))).toEqual(['report-0f8fad5b'])
  })

  it('keeps the earlier fetch when a file fails part-way', async () => {
    const root = scratch()
    await replaceOutputsDir(targetFor(root), 'r', async (put) => put('a.txt', Buffer.from('kept')))
    await expect(
      replaceOutputsDir(targetFor(root), 'r', async (put) => {
        await put('a.txt', Buffer.from('new'))
        throw new Error('checksum mismatch')
      })
    ).rejects.toThrow('checksum mismatch')
    expect(readFileSync(join(root, 'files', 'outputs', 'r', 'a.txt'), 'utf8')).toBe('kept')
    expect(readdirSync(join(root, 'files', 'outputs'))).toEqual(['r'])
  })

  it.skipIf(process.platform === 'win32')('refuses an outputs area that is a link out of the session', async () => {
    const root = scratch()
    const elsewhere = mkdtempSync(join(tmpdir(), 'artifact-elsewhere-'))
    roots.push(elsewhere)
    symlinkSync(elsewhere, join(root, 'files', 'outputs'))
    const result = await replaceOutputsDir(targetFor(root), 'r', async (put) => put('a.txt', Buffer.from('x')))
    expect(result).toEqual({ ok: false, reason: 'escape' })
    expect(readdirSync(elsewhere)).toEqual([])
  })
})

describe('putObjectBytes', () => {
  it('PUTs the body with exactly the signed headers and refuses a non-200 answer', async () => {
    const seen: { method?: string; headers: Record<string, unknown>; body: string }[] = []
    let status = 200
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        seen.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() })
        res.statusCode = status
        res.end(status === 200 ? '' : '<Error><Code>BadDigest</Code></Error>')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    try {
      const url = new URL(`http://127.0.0.1:${port}/bucket/key`)
      const headers = { 'content-length': '5', 'x-amz-checksum-sha256': 'abc=' }
      await putObjectBytes({ bytes: Buffer.from('hello'), url, headers, timeoutMs: 5000 })
      expect(seen[0]).toMatchObject({ method: 'PUT', body: 'hello', headers: { 'x-amz-checksum-sha256': 'abc=' } })
      status = 400
      const refused = putObjectBytes({ bytes: Buffer.from('hello'), url, headers, timeoutMs: 5000 })
      await expect(refused).rejects.toBeInstanceOf(PutObjectError)
      await expect(refused).rejects.toThrow('HTTP 400 BadDigest')
    } finally {
      server.close()
    }
  })
})
