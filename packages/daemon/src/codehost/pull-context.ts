import type { CodeHostEffectLease } from './turn-final.js'

export const PULL_CONTEXT_TIMEOUT_MS = 1_500
export const PULL_CONTEXT_COMMIT_LIMIT = 10
const DIFF_MAX_BYTES = 12 * 1024

export interface PullRequestContext {
  description: string
  commitMessages: string[]
  diff: string
  reasons: string[]
}

interface PullContextPaths {
  description: string
  descriptionField: 'body' | 'description'
  commits: string
  commitMessagePath: readonly string[]
  diff: string
  diffAccept?: string
  authorization?: string
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

// Read at most one page and one diff prefix; optional context never starts a checkout or retries.
export async function readPullRequestContext(
  lease: CodeHostEffectLease,
  paths: PullContextPaths,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<PullRequestContext | undefined> {
  signal.throwIfAborted()
  const token = await abortable(lease.token(), signal)
  signal.throwIfAborted()
  const root = lease.apiBaseUrl()
  const optional = new AbortController()
  const timer = setTimeout(() => optional.abort(), PULL_CONTEXT_TIMEOUT_MS)
  const extraSignal = AbortSignal.any([signal, optional.signal])
  const read = async (path: string, limit: number, readSignal: AbortSignal, accept = 'application/json') => {
    readSignal.throwIfAborted()
    const response = await fetchImpl(`${root}${path}`, {
      headers: { authorization: `${paths.authorization ?? 'Bearer'} ${token}`, accept },
      signal: readSignal,
      redirect: 'error'
    })
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
      return { text: truncated ? text.replace(/\uFFFD$/, '') : text, truncated }
    } finally {
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  try {
    const [description, commits, diff] = await Promise.allSettled([
      read(paths.description, 1024 * 1024, signal).then((body) =>
        body && !body.truncated ? field(JSON.parse(body.text), [paths.descriptionField]) : undefined
      ),
      read(paths.commits, 128 * 1024, extraSignal).then((body) =>
        body && !body.truncated ? (JSON.parse(body.text) as unknown) : undefined
      ),
      read(paths.diff, DIFF_MAX_BYTES, extraSignal, paths.diffAccept ?? 'text/plain')
    ])
    const text = description.status === 'fulfilled' ? description.value : undefined
    if (text !== null && typeof text !== 'string') return undefined
    const reasons: string[] = []
    const rows = commits.status === 'fulfilled' && Array.isArray(commits.value) ? commits.value : undefined
    const commitMessages: string[] = []
    if (!rows) reasons.push('commits_unavailable')
    else {
      if (rows.length >= PULL_CONTEXT_COMMIT_LIMIT) reasons.push('commit_limit')
      for (const row of rows.slice(0, PULL_CONTEXT_COMMIT_LIMIT)) {
        const message = field(row, paths.commitMessagePath)
        if (typeof message === 'string') commitMessages.push(message)
        else if (!reasons.includes('commits_unavailable')) reasons.push('commits_unavailable')
      }
    }
    const patch = diff.status === 'fulfilled' ? diff.value : undefined
    if (!patch) reasons.push('diff_unavailable')
    else if (patch.truncated) reasons.push('diff_truncated')
    return { description: text ?? '', commitMessages, diff: patch?.text ?? '', reasons }
  } finally {
    clearTimeout(timer)
    optional.abort()
  }
}
