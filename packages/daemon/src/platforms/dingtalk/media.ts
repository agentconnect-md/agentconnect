// DingTalk media (dingtalk-integration.md §4.5): inbound downloads by download code, outbound uploads sent as image or file messages.
import type { FileUploader, UploadOutcome } from '../../mcp/ops/context.js'
import { sniffImageMimeType } from '../../session/attachment-block.js'
import { DINGTALK_API_ORIGIN, DingTalkApiError } from './api.js'
import type { DingTalkTurnState } from './turn-output.js'

/** The legacy OpenAPI host, the only one serving the media upload. */
export const DINGTALK_OAPI_ORIGIN = 'https://oapi.dingtalk.com'
/** The media upload's cap for both images and files. */
export const DINGTALK_MEDIA_MAX_BYTES = 20 * 1024 * 1024

const DOWNLOAD_PATH = '/v1.0/robot/messageFiles/download'
const UPLOAD_PATH = '/media/upload'
const REQUEST_TIMEOUT_MS = 15_000
const UPLOAD_TIMEOUT_MS = 60_000
const MAX_REDIRECTS = 3
const DOWNLOAD_CODE_MAX_CHARS = 4096

export interface DingTalkMediaDeps {
  accessToken(): Promise<string>
  /** The app's Client ID, which the download API takes as `robotCode`. */
  robotCode: string
  signal: AbortSignal
  fetchImpl?: typeof fetch
  origin?: string
  oapiOrigin?: string
}

function httpUrl(raw: string, base?: string): URL | undefined {
  try {
    const url = new URL(raw, base)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url : undefined
  } catch {
    return undefined
  }
}

function failure(signal: AbortSignal, error: unknown): string {
  if (signal.aborted) return 'cancelled'
  if (error instanceof DingTalkApiError) return `api_${error.status}${error.code ? `_${error.code}` : ''}`
  return error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network_error'
}

// Exchange the download code for its short-lived URL; the code is opaque and never logged.
async function downloadUrlFor(deps: DingTalkMediaDeps, code: string, signal: AbortSignal): Promise<URL | undefined> {
  const token = await deps.accessToken()
  const response = await (deps.fetchImpl ?? fetch)(`${deps.origin ?? DINGTALK_API_ORIGIN}${DOWNLOAD_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
    body: JSON.stringify({ downloadCode: code, robotCode: deps.robotCode }),
    signal
  })
  const json = (await response.json().catch(() => undefined)) as { downloadUrl?: unknown; code?: unknown } | undefined
  if (!response.ok)
    throw new DingTalkApiError(DOWNLOAD_PATH, response.status, typeof json?.code === 'string' ? json.code : undefined)
  return typeof json?.downloadUrl === 'string' ? httpUrl(json.downloadUrl) : undefined
}

/** One inbound attachment's bytes within `maxBytes`, or null with a reason reported; never throws. */
export async function downloadDingTalkFile(
  deps: DingTalkMediaDeps,
  code: string,
  maxBytes: number,
  opts: { image?: boolean; reportFailure?: (reason: string) => void } = {}
): Promise<Buffer | null> {
  const unavailable = (reason: string): null => {
    opts.reportFailure?.(reason)
    return null
  }
  if (!code || code.length > DOWNLOAD_CODE_MAX_CHARS) return unavailable('invalid_code')
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return unavailable('invalid_size_limit')
  const signal = AbortSignal.any([deps.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
  try {
    let url = await downloadUrlFor(deps, code, signal)
    if (!url) return unavailable('no_download_url')
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const response = await (deps.fetchImpl ?? fetch)(url, { redirect: 'manual', signal })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        url = location ? httpUrl(location, url.href) : undefined
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
      const bytes = Buffer.concat(chunks)
      return !opts.image || sniffImageMimeType(bytes) ? bytes : unavailable('unsupported_format')
    }
    return unavailable('redirect_limit')
  } catch (error) {
    return unavailable(failure(deps.signal, error))
  }
}

/** Upload bytes as `type` media; returns the `media_id` a send names. */
export async function uploadDingTalkMedia(
  deps: DingTalkMediaDeps,
  file: { bytes: Buffer; name: string; mimeType: string },
  type: 'image' | 'file'
): Promise<string> {
  const token = await deps.accessToken()
  const form = new FormData()
  form.append('media', new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }), file.name)
  const query = new URLSearchParams({ access_token: token, type })
  const response = await (deps.fetchImpl ?? fetch)(
    `${deps.oapiOrigin ?? DINGTALK_OAPI_ORIGIN}${UPLOAD_PATH}?${query}`,
    {
      method: 'POST',
      body: form,
      redirect: 'error',
      signal: AbortSignal.any([deps.signal, AbortSignal.timeout(UPLOAD_TIMEOUT_MS)])
    }
  )
  const json = (await response.json().catch(() => undefined)) as { errcode?: unknown; media_id?: unknown } | undefined
  const errcode = json?.errcode
  if (!response.ok || (errcode !== undefined && errcode !== 0) || typeof json?.media_id !== 'string' || !json.media_id)
    throw new DingTalkApiError(UPLOAD_PATH, response.status, errcode !== undefined ? String(errcode) : undefined)
  return json.media_id
}

/** The robot message that shows uploaded media: an image by its media id, anything else as a file. */
export function dingTalkMediaMessage(
  mediaId: string,
  file: { name: string; mimeType: string }
): { msgKey: string; msgParam: string } {
  // `photoURL` takes a media id as well as a URL, as DingTalk documents and a live app shows (dingtalk-integration.md §4.5).
  if (file.mimeType.startsWith('image/'))
    return { msgKey: 'sampleImageMsg', msgParam: JSON.stringify({ photoURL: mediaId }) }
  const fileType = /\.([A-Za-z0-9]{1,10})$/.exec(file.name)?.[1]?.toLowerCase() ?? 'file'
  return { msgKey: 'sampleFile', msgParam: JSON.stringify({ mediaId, fileName: file.name, fileType }) }
}

/** The send half the uploader needs from the leased connection. */
export interface DingTalkMediaPort {
  sendMedia(
    channel: string,
    file: { bytes: Buffer; name: string; mimeType: string },
    caption?: string
  ): Promise<UploadOutcome>
}

/** The turn's image sender, bound to the connection it leased; absent for a headless turn. */
export function dingTalkFileUploader(state: DingTalkTurnState): FileUploader | undefined {
  const conn = state.conn as Partial<DingTalkMediaPort> | undefined
  if (typeof conn?.sendMedia !== 'function') return undefined
  return (file, caption) => conn.sendMedia!(state.channel, file, caption)
}
