import type { CodeHostEffectLease } from './turn-final.js'

// Fetch only the root PR description under the hook's existing repository grant.
export async function readPullDescription(
  lease: CodeHostEffectLease,
  path: string,
  field: 'body' | 'description',
  signal: AbortSignal,
  authorization = 'Bearer',
  fetchImpl: typeof fetch = fetch
): Promise<string | undefined> {
  const token = await lease.token()
  signal.throwIfAborted()
  const response = await fetchImpl(`${lease.apiBaseUrl()}${path}`, {
    headers: { authorization: `${authorization} ${token}`, accept: 'application/json' },
    signal,
    redirect: 'error'
  })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    return undefined
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 1024 * 1024) return undefined
      chunks.push(value)
    }
    const json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    const description = json[field]
    if (description === null) return ''
    return typeof description === 'string' ? description : undefined
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
