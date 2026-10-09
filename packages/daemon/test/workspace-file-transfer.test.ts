import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBundleHandler } from '../src/shim/bundle-handler.js'
import { prepareBundleStaging } from '../src/shim/bundle-staging.js'
import { stageWorkspaceFile } from '../src/shim/fd-workspace-files.js'
import { ShimWorkspaceFiles } from '../src/shim/workspace-files-channel.js'
import type { ShimRequester } from '../src/shim/channels.js'
import { localWorkspaceFiles, WorkspaceViolationError } from '../src/workspace/workspace-files.js'

// Console file transfer's snapshot-and-PUT half (source-cache-file-transfer.md): local, in the shim, and across the channel.

const closers: Array<() => void> = []
afterEach(() => closers.splice(0).forEach((close) => close()))

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-transfer-ws-'))
  mkdirSync(join(root, 'dist'))
  writeFileSync(join(root, 'dist', 'app.bin'), Buffer.from([0, 1, 2, 3, 255]))
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, '.git', 'config'), '[core]')
  return root
}

async function store(
  status = 200
): Promise<{ url: string; received: Array<{ headers: IncomingHttpHeaders; body: Buffer }> }> {
  const received: Array<{ headers: IncomingHttpHeaders; body: Buffer }> = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks) })
      res.statusCode = status
      res.end(status === 200 ? '' : '<Error><Code>AccessDenied</Code></Error>')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => server.close())
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/bucket/key?X-Amz-Signature=s`, received }
}

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('base64')

const signed = (url: string) => async (file: { bytes: number; sha256: string }) => ({
  url,
  headers: {
    'content-length': String(file.bytes),
    'x-amz-checksum-sha256': file.sha256,
    'x-amz-tagging': 'ac-cache=pending'
  }
})

describe('local workspace upload', () => {
  it('snapshots the file, signs for its exact length and digest, and PUTs those bytes', async () => {
    const root = workspace()
    const target = await store()
    const bytes = Buffer.from([0, 1, 2, 3, 255])
    const sent = await localWorkspaceFiles.upload!(
      root,
      { path: 'dist/app.bin', maxBytes: 1024, timeoutMs: 5000 },
      signed(target.url)
    )
    expect(sent).toEqual({ bytes: 5, sha256: sha(bytes) })
    expect(target.received[0]!.body.equals(bytes)).toBe(true)
    expect(target.received[0]!.headers['x-amz-checksum-sha256']).toBe(sha(bytes))
  })

  it('keeps the read’s refusals: missing, over the cap, .git, a symlink, and a refused PUT', async () => {
    const root = workspace()
    symlinkSync('/etc/hostname', join(root, 'link'))
    const target = await store()
    const upload = (path: string, maxBytes = 1024) =>
      localWorkspaceFiles.upload!(root, { path, maxBytes, timeoutMs: 5000 }, signed(target.url))
    await expect(upload('nope.bin')).rejects.toMatchObject({ reason: 'not-found' })
    await expect(upload('dist/app.bin', 4)).rejects.toMatchObject({ reason: 'too-large' })
    await expect(upload('.git/config')).rejects.toMatchObject({ reason: 'git-internals' })
    await expect(upload('link')).rejects.toMatchObject({ reason: 'not-a-file' })
    await expect(upload('../outside')).rejects.toBeInstanceOf(WorkspaceViolationError)
    expect(target.received).toHaveLength(0)

    const refusing = await store(403)
    await expect(
      localWorkspaceFiles.upload!(root, { path: 'dist/app.bin', maxBytes: 1024, timeoutMs: 5000 }, signed(refusing.url))
    ).rejects.toMatchObject({ reason: 'transfer-failed' })
  })
})

// The shim runs only in Linux sandbox pods; its staging dir needs POSIX modes.
describe.skipIf(process.platform === 'win32')('shim transfer staging', () => {
  it('stages through the fd-anchored descent into a bundle handle that the bundle upload sends', async () => {
    const anchor = workspace()
    const staging = join(mkdtempSync(join(tmpdir(), 'ac-transfer-stage-')), 'bundle-staging')
    prepareBundleStaging(staging)
    const handler = createBundleHandler({
      workspaceRoot: anchor,
      stagingDir: staging,
      allowHttpUpload: true,
      stageWorkspaceFile: (root, path, dest, maxBytes) => stageWorkspaceFile(anchor, root, path, dest, maxBytes)
    })
    closers.push(() => handler.stop())
    const staged = await handler.transfer({ op: 'stage-file', root: anchor, path: 'dist/app.bin', maxBytes: 1024 })
    expect(staged.bytes).toBe(5)
    expect(readdirSync(staging)).toEqual([`${staged.handle}.file`])

    const target = await store()
    await handler({
      op: 'upload',
      handle: staged.handle,
      url: target.url,
      headers: (await signed(target.url)(staged)).headers
    })
    expect(target.received[0]!.body.equals(Buffer.from([0, 1, 2, 3, 255]))).toBe(true)
    await handler({ op: 'discard', handle: staged.handle })
    expect(readdirSync(staging)).toEqual([])
  })

  it('names the refusal in the message the daemon reads back', async () => {
    const anchor = workspace()
    const staging = join(mkdtempSync(join(tmpdir(), 'ac-transfer-stage-')), 'bundle-staging')
    prepareBundleStaging(staging)
    const handler = createBundleHandler({
      workspaceRoot: anchor,
      stagingDir: staging,
      stageWorkspaceFile: (root, path, dest, maxBytes) => stageWorkspaceFile(anchor, root, path, dest, maxBytes)
    })
    closers.push(() => handler.stop())
    await expect(handler.transfer({ op: 'stage-file', root: anchor, path: 'gone', maxBytes: 9 })).rejects.toThrow(
      /^bundle not-found:/
    )
    await expect(
      handler.transfer({ op: 'stage-file', root: anchor, path: 'dist/app.bin', maxBytes: 4 })
    ).rejects.toThrow(/^bundle too-large:/)
    await expect(
      handler.transfer({ op: 'stage-file', root: anchor, path: '.git/config', maxBytes: 9 })
    ).rejects.toThrow(/^bundle git-internals:/)
    await expect(handler.transfer({ op: 'stage-file', root: '/elsewhere', path: 'x', maxBytes: 9 })).rejects.toThrow(
      /^bundle path-escape:/
    )
    expect(readdirSync(staging)).toEqual([])
  })
})

describe('ShimWorkspaceFiles upload', () => {
  const requester = (
    answer: (capability: string, payload: { op: string }) => unknown
  ): ShimRequester & { calls: string[] } => {
    const calls: string[] = []
    return {
      calls,
      request: async (capability, payload) => {
        calls.push(`${capability}:${(payload as { op: string }).op}`)
        return answer(capability, payload as { op: string })
      }
    }
  }
  const req = { path: 'a.bin', maxBytes: 10, timeoutMs: 1000 }
  const handle = '3f1c2a4e-9b7d-4e21-8c3a-0d5e6f7a8b9c'
  const digest = sha(Buffer.from('x'))

  it('refuses a binding without the transfer grant as an outdated sandbox', async () => {
    const files = new ShimWorkspaceFiles(requester(() => ({})))
    await expect(files.upload('/w', req, signed('https://store.example.test/k'))).rejects.toMatchObject({
      reason: 'sandbox-outdated'
    })
  })

  it('stages, uploads and always discards the handle', async () => {
    const shim = requester((capability, payload) =>
      capability === 'transfer'
        ? { handle, bytes: 1, sha256: digest }
        : payload.op === 'upload'
          ? { bytes: 1, sha256: digest }
          : { discarded: true }
    )
    const sent = await new ShimWorkspaceFiles(shim, undefined, true).upload(
      '/w',
      req,
      signed('https://store.example.test/k')
    )
    expect(sent).toEqual({ bytes: 1, sha256: digest })
    expect(shim.calls).toEqual(['transfer:stage-file', 'bundle:upload', 'bundle:discard'])
  })

  it('keeps a staged refusal’s reason and reads anything else as a failed transfer', async () => {
    const missing = requester(() => {
      throw new Error('bundle not-found: no such file')
    })
    await expect(
      new ShimWorkspaceFiles(missing, undefined, true).upload('/w', req, signed('https://x.example.test'))
    ).rejects.toMatchObject({
      reason: 'not-found'
    })
    const refused = requester((capability, payload) => {
      if (capability === 'transfer') return { handle, bytes: 1, sha256: digest }
      if (payload.op === 'upload') throw new Error('bundle upload-refused: HTTP 403 AccessDenied')
      return { discarded: true }
    })
    await expect(
      new ShimWorkspaceFiles(refused, undefined, true).upload('/w', req, signed('https://x.example.test'))
    ).rejects.toMatchObject({
      reason: 'transfer-failed'
    })
    expect(refused.calls.at(-1)).toBe('bundle:discard')
  })
})
