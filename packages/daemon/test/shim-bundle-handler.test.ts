import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBundleHandler, type BundleHandlerDeps, type GitInvocation } from '../src/shim/bundle-handler.js'
import { prepareBundleStaging } from '../src/shim/bundle-staging.js'

// The shim's own `bundle` operations against real Git (source-cache.md §6.1, §9): the handle and file are the shim's, never the caller's.

const roots: string[] = []
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@e',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@e'
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function tmp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  roots.push(dir)
  return dir
}

// A workspace root holding an origin with two commits, a full clone and a blobless clone of it.
function fixture() {
  const root = tmp('ac-bundle-ws-')
  const seed = join(root, 'seed')
  execFileSync('git', ['init', '-q', '--initial-branch=main', seed])
  for (const n of [1, 2]) {
    writeFileSync(join(seed, `f${n}.txt`), `${n}\n`.repeat(100))
    execFileSync('git', ['add', '.'], { cwd: seed })
    execFileSync('git', ['commit', '-qm', `c${n}`], { cwd: seed, env: GIT_ENV })
  }
  const origin = join(root, 'origin.git')
  execFileSync('git', ['clone', '-q', '--bare', seed, origin])
  execFileSync('git', ['config', 'uploadpack.allowFilter', 'true'], { cwd: origin })
  const full = join(root, 'full')
  execFileSync('git', ['clone', '-q', `file://${origin}`, full])
  const blobless = join(root, 'blobless')
  execFileSync('git', ['clone', '-q', '--filter=blob:none', '--no-checkout', `file://${origin}`, blobless])
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: seed, encoding: 'utf8' }).trim()
  const staging = join(tmp('ac-bundle-rt-'), 'bundle-staging')
  prepareBundleStaging(staging)
  return { root, origin, full, blobless, commit, staging }
}

type Fixture = ReturnType<typeof fixture>

function handlerFor(f: Fixture, extra: Partial<BundleHandlerDeps> = {}) {
  return createBundleHandler({ workspaceRoot: f.root, stagingDir: f.staging, allowHttpUpload: true, ...extra })
}

const create = (f: Fixture, cwd: string, extra: Record<string, unknown> = {}) => ({
  op: 'create',
  cwd,
  ref: 'refs/heads/main',
  commit: f.commit,
  shape: 'full',
  maxBytes: 1024 * 1024,
  ...extra
})

// GIT_NO_LAZY_FETCH is honored from the 2024-05 security releases on.
function gitHonorsNoLazyFetch(): boolean {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8' }))
  if (!match) return false
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number]
  if (major !== 2) return major > 2
  if (minor >= 45) return minor > 45 || patch >= 1
  const fixed: Record<number, number> = { 39: 4, 40: 2, 41: 1, 42: 2, 43: 4, 44: 1 }
  return fixed[minor] !== undefined && patch >= fixed[minor]
}

interface Received {
  method?: string
  headers: IncomingHttpHeaders
  body: Buffer
}

async function uploadServer(status = 200, reply = ''): Promise<{ url: string; received: Received[]; close(): void }> {
  const received: Received[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      received.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks) })
      res.statusCode = status
      res.end(reply)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/bucket/src/o/anon/r/bundles/b.bundle?X-Amz-Signature=secret`,
    received,
    close: () => server.close()
  }
}

const signedHeaders = (staged: { bytes: number; sha256: string }) => ({
  'content-length': String(staged.bytes),
  'x-amz-checksum-sha256': staged.sha256,
  'x-amz-tagging': 'ac-cache=pending'
})

describe('shim bundle operations', () => {
  it('mints the handle and names the file itself, private, with the size and SHA-256 of the bytes', async () => {
    const f = fixture()
    const handler = handlerFor(f)
    const staged = (await handler(create(f, f.full))) as { handle: string; bytes: number; sha256: string }

    expect(staged.handle).toMatch(UUID_RE)
    expect(readdirSync(f.staging)).toEqual([`${staged.handle}.bundle`])
    const file = join(f.staging, `${staged.handle}.bundle`)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(staged.bytes).toBe(statSync(file).size)
    expect(staged.sha256).toBe(createHash('sha256').update(readFileSync(file)).digest('base64'))
    expect(execFileSync('git', ['bundle', 'list-heads', file], { cwd: f.full, encoding: 'utf8' }).trim()).toBe(
      `${f.commit} refs/heads/main`
    )
  })

  it.each([
    ['a caller-chosen file', { file: '/tmp/x.bundle' }],
    ['a caller-chosen path', { path: '/tmp/x.bundle' }],
    ['a relative cwd', { cwd: 'full' }],
    ['a HEAD ref', { ref: 'HEAD' }],
    ['a remote-tracking ref', { ref: 'refs/remotes/origin/main' }],
    ['an abbreviated commit', { commit: 'abc123' }],
    ['an unknown shape', { shape: 'tree' }]
  ])('refuses %s', async (_label, extra) => {
    const f = fixture()
    await expect(handlerFor(f)(create(f, f.full, extra))).rejects.toThrow()
    expect(readdirSync(f.staging)).toEqual([])
  })

  it('refuses an unknown op and a cwd outside the workspace root', async () => {
    const f = fixture()
    await expect(handlerFor(f)({ op: 'verify', handle: 'x' })).rejects.toThrow()
    await expect(handlerFor(f)(create(f, tmp('ac-bundle-outside-')))).rejects.toThrow(/escapes/)
  })

  it('runs Git with composed argv, the filter only for blobless, and GIT_NO_LAZY_FETCH=1 set last', async () => {
    const f = fixture()
    const seen: GitInvocation[] = []
    const handler = handlerFor(f, {
      shimEnv: { PATH: process.env.PATH, HOME: f.root, GIT_NO_LAZY_FETCH: '0', GIT_DIR: '/elsewhere' },
      runGit: async (invocation) => {
        seen.push(invocation)
        return {
          stdout: execFileSync('git', invocation.args, { cwd: invocation.cwd, env: invocation.env, encoding: 'utf8' })
        }
      }
    })
    await handler(create(f, f.blobless, { shape: 'blobless' }))
    await handler(create(f, f.full))
    const creates = seen.filter((call) => call.args[0] === 'bundle' && call.args[1] === 'create')
    expect(creates.map((call) => call.args.includes('--filter=blob:none'))).toEqual([true, false])
    for (const call of seen) {
      expect(call.env.GIT_NO_LAZY_FETCH).toBe('1')
      expect(Object.keys(call.env).at(-1)).toBe('GIT_NO_LAZY_FETCH')
      expect(call.env.GIT_DIR).toBeUndefined()
      expect(call.args.some((arg) => arg.startsWith('--upload') || arg.startsWith('-c'))).toBe(false)
    }
    expect(creates[0]!.args[3]!.startsWith(`${f.staging}/`)).toBe(true)
  })

  it.skipIf(!gitHonorsNoLazyFetch())(
    'fails an unfiltered create from a blobless clone instead of fetching',
    async () => {
      const f = fixture()
      await expect(handlerFor(f)(create(f, f.blobless, { shape: 'full' }))).rejects.toThrow()
      expect(readdirSync(f.staging)).toEqual([])
    }
  )

  it('refuses a ref that moved off the origin commit, a shallow checkout, and an over-cap bundle', async () => {
    const f = fixture()
    const handler = handlerFor(f)
    writeFileSync(join(f.full, 'local.txt'), 'agent\n')
    execFileSync('git', ['add', '.'], { cwd: f.full })
    execFileSync('git', ['commit', '-qm', 'local'], { cwd: f.full, env: GIT_ENV })
    await expect(handler(create(f, f.full))).rejects.toThrow(/moved/)

    const shallow = join(f.root, 'shallow')
    execFileSync('git', ['clone', '-q', '--depth=1', `file://${f.origin}`, shallow])
    await expect(handler(create(f, shallow))).rejects.toThrow(/shallow/)

    const fresh = fixture()
    await expect(handlerFor(fresh)(create(fresh, fresh.full, { maxBytes: 10 }))).rejects.toThrow(/too-large/)
    expect(readdirSync(fresh.staging)).toEqual([])
    expect(readdirSync(f.staging)).toEqual([])
  })

  it('kills Git and leaves nothing staged when the request is cancelled', async () => {
    const f = fixture()
    const abort = new AbortController()
    abort.abort()
    await expect(handlerFor(f)(create(f, f.full), abort.signal)).rejects.toThrow()
    expect(readdirSync(f.staging)).toEqual([])
  })

  it('uploads the staged bytes with exactly the signed headers', async () => {
    const f = fixture()
    const handler = handlerFor(f)
    const staged = (await handler(create(f, f.full))) as { handle: string; bytes: number; sha256: string }
    const server = await uploadServer()
    try {
      const result = await handler({
        op: 'upload',
        handle: staged.handle,
        url: server.url,
        headers: signedHeaders(staged)
      })
      expect(result).toEqual({ bytes: staged.bytes, sha256: staged.sha256 })
      expect(server.received).toHaveLength(1)
      const [got] = server.received
      expect(got!.method).toBe('PUT')
      const names = Object.keys(got!.headers).filter((name) => name !== 'host' && name !== 'connection')
      expect(names.sort()).toEqual(['content-length', 'x-amz-checksum-sha256', 'x-amz-tagging'])
      expect(got!.headers['x-amz-tagging']).toBe('ac-cache=pending')
      expect(got!.body.equals(readFileSync(join(f.staging, `${staged.handle}.bundle`)))).toBe(true)
    } finally {
      server.close()
    }
  })

  it('refuses a header set or value that does not describe the bundle before connecting', async () => {
    const f = fixture()
    const handler = handlerFor(f)
    const staged = (await handler(create(f, f.full))) as { handle: string; bytes: number; sha256: string }
    const server = await uploadServer()
    try {
      const good = signedHeaders(staged)
      for (const headers of [
        { ...good, 'x-amz-tagging': 'ac-cache=live' },
        { ...good, 'content-length': String(staged.bytes + 1) },
        { ...good, 'x-amz-checksum-sha256': createHash('sha256').update('x').digest('base64') },
        { 'content-length': good['content-length'], 'x-amz-checksum-sha256': good['x-amz-checksum-sha256'] },
        { ...good, 'x-amz-acl': 'public-read' }
      ]) {
        await expect(handler({ op: 'upload', handle: staged.handle, url: server.url, headers })).rejects.toThrow(
          /bad-headers/
        )
      }
      await expect(
        handler({ op: 'upload', handle: '00000000-0000-4000-8000-000000000000', url: server.url, headers: good })
      ).rejects.toThrow(/unknown-handle/)
      expect(server.received).toEqual([])
    } finally {
      server.close()
    }
  })

  it('reports a refused upload by status and S3 code, never the URL', async () => {
    const f = fixture()
    const handler = handlerFor(f)
    const staged = (await handler(create(f, f.full))) as { handle: string; bytes: number; sha256: string }
    const server = await uploadServer(403, '<Error><Code>SignatureDoesNotMatch</Code></Error>')
    try {
      const failure = await handler({
        op: 'upload',
        handle: staged.handle,
        url: server.url,
        headers: signedHeaders(staged)
      }).catch((err: Error) => err)
      expect((failure as Error).message).toMatch(/HTTP 403 SignatureDoesNotMatch/)
      expect((failure as Error).message).not.toMatch(/secret|127\.0\.0\.1/)
    } finally {
      server.close()
    }
  })

  it('admits only https upload URLs outside the test seam', async () => {
    const f = fixture()
    const handler = createBundleHandler({ workspaceRoot: f.root, stagingDir: f.staging })
    const staged = (await handler(create(f, f.full))) as { handle: string; bytes: number; sha256: string }
    for (const url of ['http://127.0.0.1:1/x', 'https://user:pw@h/x', 'file:///etc/passwd']) {
      await expect(
        handler({ op: 'upload', handle: staged.handle, url, headers: signedHeaders(staged) })
      ).rejects.toThrow(/bad-url/)
    }
  })

  it('discards idempotently and purges handles past their lifetime', async () => {
    const f = fixture()
    let now = 1_000
    const handler = handlerFor(f, { now: () => now, handleTtlMs: 1_000 })
    const first = (await handler(create(f, f.full))) as { handle: string }
    expect(await handler({ op: 'discard', handle: first.handle })).toEqual({ discarded: true })
    expect(await handler({ op: 'discard', handle: first.handle })).toEqual({ discarded: false })
    expect(existsSync(join(f.staging, `${first.handle}.bundle`))).toBe(false)

    const stale = (await handler(create(f, f.full))) as { handle: string }
    now += 2_000
    // Any later call purges first.
    expect(await handler({ op: 'discard', handle: '00000000-0000-4000-8000-000000000000' })).toEqual({
      discarded: false
    })
    expect(existsSync(join(f.staging, `${stale.handle}.bundle`))).toBe(false)
    expect(await handler({ op: 'discard', handle: stale.handle })).toEqual({ discarded: false })
  })

  describe('without a later request', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('reclaims a stale handle on its own timer, and stops when told', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      const f = fixture()
      let now = 1_000
      const handler = handlerFor(f, { now: () => now, handleTtlMs: 1_000, sweepIntervalMs: 60_000 })
      const stale = (await handler(create(f, f.full))) as { handle: string }
      const file = join(f.staging, `${stale.handle}.bundle`)
      now += 2_000
      expect(existsSync(file)).toBe(true)
      vi.advanceTimersByTime(60_000)
      expect(existsSync(file)).toBe(false)

      const kept = (await handler(create(f, f.full))) as { handle: string }
      handler.stop()
      now += 2_000
      vi.advanceTimersByTime(10 * 60_000)
      expect(existsSync(join(f.staging, `${kept.handle}.bundle`))).toBe(true)
    })
  })

  it('logs one warn line per refused op, naming the op and reason but never the URL', async () => {
    const f = fixture()
    const warnings: string[] = []
    const handler = handlerFor(f, { log: { warn: (m) => warnings.push(m) } })
    const staged = (await handler(create(f, f.full))) as { handle: string; bytes: number; sha256: string }
    await expect(
      handler({ op: 'upload', handle: staged.handle, url: 'https://secret.example/x?X-Amz-Signature=s', headers: {} })
    ).rejects.toThrow(/bad-headers/)
    await expect(handler(create(f, f.full, { commit: '0'.repeat(40) }))).rejects.toThrow(/moved/)
    expect(warnings).toEqual(['bundle upload refused: bad-headers', 'bundle create refused: moved'])
  })

  it('caps how many bundles are staged at once', async () => {
    const f = fixture()
    const handler = handlerFor(f, { maxHandles: 1 })
    await handler(create(f, f.full))
    await expect(handler(create(f, f.full))).rejects.toThrow(/busy/)
    expect(readdirSync(f.staging)).toHaveLength(1)
  })

  it('refuses to stage into a directory that is no longer private', async () => {
    const f = fixture()
    execFileSync('chmod', ['755', f.staging])
    await expect(handlerFor(f)(create(f, f.full))).rejects.toThrow(/mode 0700/)
  })
})
