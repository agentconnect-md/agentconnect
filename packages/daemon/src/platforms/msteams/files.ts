// Files in a 1:1 chat (teams-integration.md §4.8): Teams hands both directions short-lived, pre-authorized OneDrive links.

const TRANSFER_TIMEOUT_MS = 30_000
const MAX_REDIRECTS = 3
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

/** The link when it is https on SharePoint, the only host a 1:1 file's download or upload link names; else undefined. */
export function msTeamsFileUrl(source: string): URL | undefined {
  try {
    const url = new URL(source)
    const host = url.hostname.toLowerCase()
    return url.protocol === 'https:' && !url.username && !url.password && host.endsWith('.sharepoint.com')
      ? url
      : undefined
  } catch {
    return undefined
  }
}

/** The file's bytes within the cap, or null with the reason reported; redirects are followed only within SharePoint. */
export async function downloadMsTeamsFile(
  source: string,
  maxBytes = DEFAULT_MAX_BYTES,
  fetchImpl: typeof fetch = fetch,
  reportFailure?: (reason: string) => void
): Promise<Buffer | null> {
  const unavailable = (reason: string): null => {
    reportFailure?.(reason)
    return null
  }
  let url = msTeamsFileUrl(source)
  if (!url) return unavailable('invalid_url')
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return unavailable('invalid_size_limit')
  try {
    const signal = AbortSignal.timeout(TRANSFER_TIMEOUT_MS)
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const response = await fetchImpl(url, { redirect: 'manual', signal })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        url = location ? msTeamsFileUrl(new URL(location, url).href) : undefined
        if (!url) return unavailable('invalid_redirect')
        continue
      }
      if (!response.ok || Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel()
        return unavailable(response.ok ? 'size_limit' : `http_${response.status}`)
      }
      const reader = response.body?.getReader()
      if (!reader) return unavailable('empty_body')
      const chunks: Buffer[] = []
      let size = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > maxBytes) return unavailable('size_limit')
          chunks.push(Buffer.from(value))
        }
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      return Buffer.concat(chunks)
    }
    return unavailable('redirect_limit')
  } catch (error) {
    return unavailable(error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network_error')
  }
}

/** PUT the whole file to an accepted consent's OneDrive upload session in one range; true once OneDrive took it. */
export async function uploadMsTeamsFile(
  uploadUrl: string,
  bytes: Buffer,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const url = msTeamsFileUrl(uploadUrl)
  if (!url) return { ok: false, reason: 'invalid_url' }
  if (!bytes.length) return { ok: false, reason: 'empty_file' }
  try {
    const response = await fetchImpl(url, {
      method: 'PUT',
      redirect: 'error',
      signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
      headers: {
        'content-length': String(bytes.length),
        'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}`
      },
      body: new Uint8Array(bytes)
    })
    await response.body?.cancel()
    return response.status === 200 || response.status === 201
      ? { ok: true }
      : { ok: false, reason: `http_${response.status}` }
  } catch (error) {
    return { ok: false, reason: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network_error' }
  }
}
