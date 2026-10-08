import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, createReadStream, rmSync, statSync } from 'node:fs'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { join } from 'node:path'
import { ExecRefusedError } from '../workspace/git-command-policy.js'
import {
  BUNDLE_PENDING_TAGGING,
  BUNDLE_UPLOAD_HEADERS,
  BundleCreateRequestSchema,
  BundleRequestSchema,
  type BundleCreateRequest,
  type BundleCreateResult,
  type BundleDiscardResult,
  type BundleUploadRequest,
  type BundleUploadResult
} from './bundle-protocol.js'
import { assertBundleStagingPrivate } from './bundle-staging.js'
import { resolveCwd } from './exec-handler.js'

// The shim-internal `bundle` operations (source-cache.md §6.1, §9): composed argv, shim-minted handles, upload from this process.

export const DEFAULT_BUNDLE_CREATE_TIMEOUT_MS = 10 * 60_000
export const DEFAULT_BUNDLE_UPLOAD_TIMEOUT_MS = 15 * 60_000
const DEFAULT_MAX_HANDLES = 4
const DEFAULT_HANDLE_TTL_MS = 2 * 60 * 60_000
// A skill-staged handle is uploaded right after its reconcile, so a lost one frees its slot sooner.
export const SKILL_STAGED_HANDLE_TTL_MS = 30 * 60_000
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60_000
const MAX_GIT_OUTPUT_BYTES = 64 * 1024
const MAX_ERROR_BODY_BYTES = 4096
const EMPTY_CONFIG = '/dev/null'
const SIGNED_HEADER_NAMES = [...BUNDLE_UPLOAD_HEADERS].sort().join('\n')

export interface GitInvocation {
  args: string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  abort?: AbortSignal
}

export type RunBundleGit = (invocation: GitInvocation) => Promise<{ stdout: string }>

type RequestFn = (url: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) => ClientRequest

export interface BundleHandlerDeps {
  workspaceRoot: string
  stagingDir: string
  /** Test seam: the shim's own environment; default `process.env`. */
  shimEnv?: Record<string, string | undefined>
  now?: () => number
  /** Test seam: how Git runs; default `execFile('git', …)`. */
  runGit?: RunBundleGit
  /** Test seam: the HTTP(S) request function. */
  request?: RequestFn
  /** Test only: admit a plain-http upload URL (a local fixture). */
  allowHttpUpload?: boolean
  maxHandles?: number
  handleTtlMs?: number
  /** How often stale handles are reclaimed without waiting for the next request. */
  sweepIntervalMs?: number
  log?: { warn: (m: string) => void }
}

/** A shim-internal repository to bundle into the handle registry; `repo` is a shim-owned path, never one the daemon sent. */
export interface BundleStageInput {
  repo: string
  ref: string
  commit: string
  shape: BundleCreateRequest['shape']
  maxBytes: number
  timeoutMs?: number
}

/** Stage a shim-owned clone under a fresh handle the daemon later uploads or discards (source-cache.md §9). */
export type BundleStage = (input: BundleStageInput, abort?: AbortSignal) => Promise<BundleCreateResult>

/** The `bundle` capability's request handler; `stop()` ends its stale-handle sweep, `stage` bundles a shim-owned clone. */
export type BundleHandler = ((payload: unknown, abort?: AbortSignal) => Promise<unknown>) & {
  stop(): void
  stage: BundleStage
  discard(handle: string): BundleDiscardResult
}

interface StagedBundle {
  file: string
  bytes: number
  sha256: string
  createdAt: number
  ttlMs: number
  busy: boolean
}

export class BundleRefusedError extends ExecRefusedError {
  constructor(
    readonly reason: string,
    detail: string
  ) {
    super(`bundle ${reason}: ${detail}`)
    this.name = 'BundleRefusedError'
  }
}

// Only what Git needs to run, plus the hardening every daemon-owned workspace Git carries; the no-lazy-fetch guard is set last.
export function bundleGitEnv(shimEnv: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) {
    const value = shimEnv[name]
    if (value !== undefined) env[name] = value
  }
  const pairs: Array<[string, string]> = [
    ['core.hooksPath', EMPTY_CONFIG],
    ['core.fsmonitor', 'false'],
    ['fetch.bundleURI', ''],
    ['transfer.bundleURI', 'false']
  ]
  pairs.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
  })
  return {
    ...env,
    GIT_CONFIG_COUNT: String(pairs.length),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: EMPTY_CONFIG,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1'
  }
}

const defaultRunGit: RunBundleGit = (invocation) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      invocation.args,
      {
        cwd: invocation.cwd,
        env: invocation.env,
        timeout: invocation.timeoutMs,
        killSignal: 'SIGTERM',
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        ...(invocation.abort ? { signal: invocation.abort } : {})
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout: String(stdout) })
        const detail = String(stderr).trim().split('\n').slice(-3).join(' ').slice(0, 300)
        reject(new Error(`git ${invocation.args[0]} failed${detail ? `: ${detail}` : ` (${error.message})`}`))
      }
    )
  })

function sha256Of(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('base64')))
      .on('error', reject)
  })
}

function unlinkStaged(file: string): void {
  rmSync(file, { force: true })
  rmSync(`${file}.lock`, { force: true })
}

/** Serve `bundle` requests: create → {handle, bytes, sha256}; upload → {bytes, sha256}; discard → {discarded}. */
export function createBundleHandler(deps: BundleHandlerDeps): BundleHandler {
  const now = deps.now ?? Date.now
  const runGit = deps.runGit ?? defaultRunGit
  const maxHandles = deps.maxHandles ?? DEFAULT_MAX_HANDLES
  const ttlMs = deps.handleTtlMs ?? DEFAULT_HANDLE_TTL_MS
  const handles = new Map<string, StagedBundle>()
  let creating = 0

  const purgeStale = (): void => {
    for (const [handle, staged] of handles) {
      if (staged.busy || staged.createdAt > now() - staged.ttlMs) continue
      handles.delete(handle)
      unlinkStaged(staged.file)
    }
  }

  // The one create primitive: the workspace `create` op and a shim-internal `stage` both land here.
  const createAt = async (
    cwd: string,
    request: Omit<BundleStageInput, 'repo'>,
    abort?: AbortSignal,
    staged: { ttlMs: number; slots: number } = { ttlMs, slots: maxHandles }
  ): Promise<BundleCreateResult> => {
    if (handles.size + creating >= staged.slots)
      throw new BundleRefusedError('busy', `${handles.size} bundles are staged`)
    assertBundleStagingPrivate(deps.stagingDir)
    const env = bundleGitEnv(deps.shimEnv ?? process.env)
    const timeoutMs = Math.min(request.timeoutMs ?? DEFAULT_BUNDLE_CREATE_TIMEOUT_MS, DEFAULT_BUNDLE_CREATE_TIMEOUT_MS)
    const git = async (args: string[]): Promise<string> =>
      (await runGit({ args, cwd, env, timeoutMs, ...(abort ? { abort } : {}) })).stdout.trim()
    const handle = randomUUID()
    const file = join(deps.stagingDir, `${handle}.bundle`)
    creating++
    try {
      // A shallow repository's bundle omits the boundary and can never seed a clone.
      if ((await git(['rev-parse', '--is-shallow-repository'])) !== 'false') {
        throw new BundleRefusedError('shallow', 'the checkout is shallow')
      }
      const head = await git(['rev-parse', '--verify', '--quiet', `${request.ref}^{commit}`]).catch(() => '')
      if (head !== request.commit)
        throw new BundleRefusedError('moved', `${request.ref} no longer names the origin commit`)
      const filter = request.shape === 'blobless' ? ['--filter=blob:none'] : []
      await git(['bundle', 'create', '-q', file, ...filter, request.ref])
      // The file must name exactly the one ref at the one commit, whatever Git decided to write.
      const heads = await git(['bundle', 'list-heads', file])
      if (heads !== `${request.commit} ${request.ref}`) {
        throw new BundleRefusedError('unexpected-heads', 'the bundle does not name exactly the requested ref')
      }
      const bytes = statSync(file).size
      if (bytes > request.maxBytes) throw new BundleRefusedError('too-large', `${bytes} bytes over ${request.maxBytes}`)
      chmodSync(file, 0o600)
      const sha256 = await sha256Of(file)
      if (abort?.aborted) throw new BundleRefusedError('aborted', 'the request was cancelled')
      handles.set(handle, { file, bytes, sha256, createdAt: now(), ttlMs: staged.ttlMs, busy: false })
      return { handle, bytes, sha256 }
    } catch (err) {
      unlinkStaged(file)
      throw err
    } finally {
      creating--
    }
  }

  const create = (request: BundleCreateRequest, abort?: AbortSignal): Promise<BundleCreateResult> =>
    createAt(resolveCwd(deps.workspaceRoot, request.cwd), request, abort)

  // The same request schema as `create`, so a shim-internal caller gets exactly the ref, commit and cap rules.
  const stage: BundleStage = async ({ repo, ...input }, abort) => {
    const parsed = BundleCreateRequestSchema.safeParse({ op: 'create', cwd: repo, ...input })
    if (!parsed.success) throw new BundleRefusedError('invalid', parsed.error.issues[0]?.message ?? 'invalid stage')
    // Skill staging leaves one slot free, so a workspace write-back is never refused for a skill's leftovers.
    return await createAt(repo, parsed.data, abort, {
      ttlMs: Math.min(ttlMs, SKILL_STAGED_HANDLE_TTL_MS),
      slots: Math.max(1, maxHandles - 1)
    })
  }

  const upload = async (request: BundleUploadRequest, abort?: AbortSignal): Promise<BundleUploadResult> => {
    const staged = handles.get(request.handle)
    if (!staged) throw new BundleRefusedError('unknown-handle', 'no such staged bundle')
    if (staged.busy) throw new BundleRefusedError('busy', 'the bundle is already uploading')
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      throw new BundleRefusedError('bad-url', 'the upload URL does not parse')
    }
    const allowed = url.protocol === 'https:' || (deps.allowHttpUpload === true && url.protocol === 'http:')
    if (!allowed || url.username || url.password || !url.hostname) {
      throw new BundleRefusedError('bad-url', 'the upload URL must be https with a host and no userinfo')
    }
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(request.headers)) headers[name.toLowerCase()] = value
    const names = Object.keys(headers).sort()
    if (names.join('\n') !== SIGNED_HEADER_NAMES) {
      throw new BundleRefusedError('bad-headers', `the upload must send exactly ${BUNDLE_UPLOAD_HEADERS.join(', ')}`)
    }
    if (
      headers['content-length'] !== String(staged.bytes) ||
      headers['x-amz-checksum-sha256'] !== staged.sha256 ||
      headers['x-amz-tagging'] !== BUNDLE_PENDING_TAGGING
    ) {
      throw new BundleRefusedError('bad-headers', 'the signed headers do not describe this bundle')
    }
    const timeoutMs = Math.min(request.timeoutMs ?? DEFAULT_BUNDLE_UPLOAD_TIMEOUT_MS, DEFAULT_BUNDLE_UPLOAD_TIMEOUT_MS)
    const send = deps.request ?? ((url.protocol === 'https:' ? httpsRequest : httpRequest) as RequestFn)
    staged.busy = true
    try {
      return await new Promise<BundleUploadResult>((resolve, reject) => {
        const stream = createReadStream(staged.file)
        const hash = createHash('sha256')
        let sent = 0
        let settled = false
        const finish = (error?: Error, result?: BundleUploadResult): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          abort?.removeEventListener('abort', onAbort)
          stream.destroy()
          if (error) {
            req.destroy()
            reject(error)
          } else resolve(result!)
        }
        const fail = (detail: string): void => finish(new BundleRefusedError('upload-failed', detail))
        const req = send(url, { method: 'PUT', headers }, (res) => {
          const chunks: Buffer[] = []
          let kept = 0
          res.on('data', (chunk: Buffer) => {
            if (kept < MAX_ERROR_BODY_BYTES) chunks.push(chunk)
            kept += chunk.length
          })
          res.on('error', (err) => fail(err.message))
          res.on('end', () => {
            if (res.statusCode === 200) {
              const sha256 = hash.digest('base64')
              if (sent !== staged.bytes || sha256 !== staged.sha256) {
                return finish(new BundleRefusedError('changed', 'the staged file changed during upload'))
              }
              return finish(undefined, { bytes: sent, sha256 })
            }
            const body = Buffer.concat(chunks).toString('utf8').slice(0, MAX_ERROR_BODY_BYTES)
            const code = /<Code>([A-Za-z0-9.]{1,64})<\/Code>/.exec(body)?.[1]
            finish(new BundleRefusedError('upload-refused', `HTTP ${res.statusCode ?? 0}${code ? ` ${code}` : ''}`))
          })
        })
        // Errors never echo the URL: only the errno code is kept.
        req.on('error', (err: NodeJS.ErrnoException) => fail(err.code ?? 'request error'))
        const timer = setTimeout(() => fail(`timed out after ${timeoutMs}ms`), timeoutMs)
        const onAbort = (): void => fail('cancelled')
        if (abort?.aborted) return onAbort()
        abort?.addEventListener('abort', onAbort, { once: true })
        stream.on('data', (chunk) => {
          const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
          sent += buffer.length
          hash.update(buffer)
          // Never send more than was signed; a grown file is cut off and the store refuses the short body.
          if (sent > staged.bytes) return fail('the staged file grew during upload')
          if (!req.write(buffer)) {
            stream.pause()
            req.once('drain', () => stream.resume())
          }
        })
        stream.on('error', (err) => fail(err.message))
        stream.on('end', () => {
          if (sent !== staged.bytes) return fail('the staged file shrank during upload')
          req.end()
        })
      })
    } finally {
      staged.busy = false
    }
  }

  const discard = (handle: string): BundleDiscardResult => {
    const staged = handles.get(handle)
    if (!staged) return { discarded: false }
    handles.delete(handle)
    unlinkStaged(staged.file)
    return { discarded: true }
  }

  const sweep = (): void => {
    try {
      purgeStale()
    } catch (err) {
      deps.log?.warn(`bundle sweep failed: ${err instanceof Error ? err.name : 'error'}`)
    }
  }
  // A daemon that dies mid-flight never discards, so staged bundles are reclaimed on a timer too.
  const timer = setInterval(sweep, deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS)
  timer.unref()

  const serve = async (payload: unknown, abort?: AbortSignal): Promise<unknown> => {
    sweep()
    const parsed = BundleRequestSchema.safeParse(payload)
    if (!parsed.success) {
      deps.log?.warn('bundle request refused: invalid')
      throw parsed.error
    }
    const request = parsed.data
    try {
      if (request.op === 'create') return await create(request, abort)
      if (request.op === 'upload') return await upload(request, abort)
      return discard(request.handle)
    } catch (err) {
      // Only the op and a reason are logged, never the URL or headers.
      const reason = err instanceof BundleRefusedError ? err.reason : err instanceof Error ? err.name : 'error'
      deps.log?.warn(`bundle ${request.op} ${err instanceof BundleRefusedError ? 'refused' : 'failed'}: ${reason}`)
      throw err
    }
  }
  return Object.assign(serve, { stop: () => clearInterval(timer), stage, discard })
}
