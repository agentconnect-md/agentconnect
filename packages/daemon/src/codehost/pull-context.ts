import { codeHostHookMetadataOf, codeHostHookRevisionOf, type CodeHostHookMembers } from '@agentconnect.md/protocol'
import type { CodeHostEffectLease } from './turn-final.js'
import {
  attachRawFileDiffs,
  PULL_CONTEXT_DIFF_MAX_BYTES,
  PULL_CONTEXT_FILE_LIMIT,
  trimFileDiffs,
  type PullRequestFile
} from './pull-files.js'

export const PULL_CONTEXT_TIMEOUT_MS = 1_500
export const PULL_CONTEXT_COMMIT_LIMIT = 10
const RESPONSE_MAX_BYTES = 1024 * 1024

export interface PullRequestContext {
  description?: string
  baseSha?: string
  headSha?: string
  commitMessages: string[]
  files: PullRequestFile[]
  filesTruncated: boolean
  reasons: string[]
  /** Milliseconds since the read began when each step finished; a missing step never completed. */
  timings?: PullContextTimings
}

export interface PullContextTimings {
  tokenMs?: number
  metadataMs?: number
  filesMs?: number
  commitsMs?: number
}

export interface PullRevision {
  headSha: string
  baseSha?: string
}

/** The revision a delivery's trusted metadata names; undefined for an issue or a head-less event. */
export function webhookPullRevision(source: CodeHostHookMembers): PullRevision | undefined {
  const member = codeHostHookMetadataOf(source)
  return member && codeHostHookRevisionOf(member)
}

interface PullContextPaths {
  description: string
  descriptionField: 'body' | 'description'
  baseShaPath: readonly string[]
  headShaPaths: readonly (readonly string[])[]
  commits: string
  commitMessagePath: readonly string[]
  files: string
  fileCountPath: readonly string[]
  file(row: Record<string, unknown>): PullRequestFile | undefined
  rawDiff?: string
  authorization?: string
  /** The webhook's revision; when present the metadata read is skipped. */
  revision?: PullRevision
}

// The lease mint is not abortable, so stop waiting without starting a late provider request.
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function field(value: unknown, path: readonly string[]): unknown {
  for (const key of path) {
    if (!value || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

// One request at a time: metadata only without a webhook revision, then files, then commits; a read cut off by the budget keeps what arrived.
export async function readPullRequestContext(
  lease: CodeHostEffectLease,
  paths: PullContextPaths,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<PullRequestContext | undefined> {
  signal.throwIfAborted()
  const started = performance.now()
  const timings: PullContextTimings = {}
  const mark = (step: keyof PullContextTimings) => (timings[step] = Math.round(performance.now() - started))
  const optional = new AbortController()
  const timer = setTimeout(() => optional.abort(), PULL_CONTEXT_TIMEOUT_MS)
  const extraSignal = AbortSignal.any([signal, optional.signal])
  let token: string
  const read = async (path: string, limit: number, readSignal: AbortSignal, accept = 'application/json') => {
    readSignal.throwIfAborted()
    const response = await abortable(
      fetchImpl(`${lease.apiBaseUrl()}${path}`, {
        headers: { authorization: `${paths.authorization ?? 'Bearer'} ${token}`, accept },
        signal: readSignal,
        redirect: 'error'
      }),
      readSignal
    )
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => {})
      return undefined
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    let truncated = false
    try {
      for (;;) {
        const { done, value } = await abortable(reader.read(), readSignal)
        if (done) break
        chunks.push(value.subarray(0, Math.max(0, limit - size)))
        size += value.byteLength
        if (size >= limit) {
          truncated = true
          break
        }
      }
      const text = Buffer.concat(chunks).toString('utf8')
      return { text: truncated ? text.replace(/\uFFFD$/, '') : text, truncated, headers: response.headers }
    } finally {
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  const json = async (path: string, limit: number) => {
    const body = await read(path, limit, extraSignal).catch(() => undefined)
    if (!body || body.truncated) return undefined
    try {
      return { value: JSON.parse(body.text) as unknown, headers: body.headers }
    } catch {
      return undefined
    }
  }
  const revision = (value: unknown) => {
    const baseSha = field(value, paths.baseShaPath)
    const [headSha, ...otherHeads] = paths.headShaPaths.map((path) => field(value, path))
    return typeof baseSha === 'string' &&
      baseSha &&
      typeof headSha === 'string' &&
      headSha &&
      otherHeads.every((head) => head === headSha)
      ? { baseSha, headSha }
      : undefined
  }
  try {
    token = await abortable(lease.token(), extraSignal)
    mark('tokenMs')
    let known = paths.revision
    let description: string | undefined
    let fileCount: unknown
    if (!known) {
      const body = await read(paths.description, RESPONSE_MAX_BYTES, extraSignal)
      const metadata = body && !body.truncated ? (JSON.parse(body.text) as unknown) : undefined
      mark('metadataMs')
      const text = field(metadata, [paths.descriptionField])
      if (text !== null && typeof text !== 'string') return undefined
      description = text ?? ''
      fileCount = field(metadata, paths.fileCountPath)
      known = revision(metadata)
    }
    const context: PullRequestContext = {
      ...(description !== undefined ? { description } : {}),
      ...known,
      commitMessages: [],
      files: [],
      filesTruncated: true,
      reasons: [],
      timings
    }
    if (!known) return { ...context, reasons: ['revision_unverified'] }
    const { reasons, commitMessages } = context
    const page = await json(paths.files, RESPONSE_MAX_BYTES)
    const rawDiff =
      page && paths.rawDiff
        ? await read(paths.rawDiff, RESPONSE_MAX_BYTES, extraSignal, 'text/plain').catch(() => undefined)
        : undefined
    if (page) mark('filesMs')
    if (!page || !Array.isArray(page.value)) reasons.push('files_unavailable')
    else {
      for (const row of page.value.slice(0, PULL_CONTEXT_FILE_LIMIT)) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue
        const file = paths.file(row as Record<string, unknown>)
        if (file) context.files.push(file)
      }
      const count =
        typeof fileCount === 'number'
          ? fileCount
          : typeof fileCount === 'string' && /^\d+\+?$/.test(fileCount)
            ? Number.parseInt(fileCount, 10)
            : undefined
      context.filesTruncated =
        context.files.length !== page.value.length ||
        (count === undefined ? page.value.length >= PULL_CONTEXT_FILE_LIMIT : count > context.files.length) ||
        /rel="?next"?/.test(page.headers.get('link') ?? '') ||
        Number(page.headers.get('x-next-page')) > 1 ||
        page.headers.get('x-hasmore') === 'true'
      if (context.filesTruncated) reasons.push('files_truncated')
      if (rawDiff) attachRawFileDiffs(context.files, rawDiff)
      const trimmed = trimFileDiffs(context.files, PULL_CONTEXT_DIFF_MAX_BYTES)
      if (trimmed || rawDiff?.truncated || context.files.some((file) => file.diffTruncated))
        reasons.push('diff_truncated')
      if (context.files.some((file) => file.diffUnavailable)) reasons.push('diff_unavailable')
    }
    const commits = extraSignal.aborted ? undefined : await json(paths.commits, 128 * 1024)
    if (commits) mark('commitsMs')
    const rows = Array.isArray(commits?.value) ? commits.value : undefined
    if (!rows) reasons.push('commits_unavailable')
    else {
      if (rows.length >= PULL_CONTEXT_COMMIT_LIMIT) reasons.push('commit_limit')
      for (const row of rows.slice(0, PULL_CONTEXT_COMMIT_LIMIT)) {
        const message = field(row, paths.commitMessagePath)
        if (typeof message === 'string') commitMessages.push(message)
        else if (!reasons.includes('commits_unavailable')) reasons.push('commits_unavailable')
      }
    }
    return context
  } finally {
    clearTimeout(timer)
    optional.abort()
  }
}
