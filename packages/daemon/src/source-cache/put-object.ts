import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

// Stream one staged file to a presigned PUT; shared by the shim's bundle upload and the daemon's own transfer upload.

const MAX_ERROR_BODY_BYTES = 4096

export type PutRequestFn = (
  url: URL,
  options: RequestOptions,
  callback: (res: IncomingMessage) => void
) => ClientRequest

export interface PutStagedFileInput {
  file: string
  /** The exact length and base64 SHA-256 the URL was signed for. */
  bytes: number
  sha256: string
  url: URL
  headers: Record<string, string>
  timeoutMs: number
  abort?: AbortSignal
  /** Test seam: the HTTP(S) request function. */
  request?: PutRequestFn
}

/** Why a PUT did not land; `reason` is a closed word and `detail` never echoes the URL. */
export class PutObjectError extends Error {
  constructor(
    readonly reason: 'upload-failed' | 'upload-refused' | 'changed',
    detail: string
  ) {
    super(detail)
    this.name = 'PutObjectError'
  }
}

/** Send `file` as the PUT body, refusing to send more or less than was signed; resolves with what was sent. */
export function putStagedFile(input: PutStagedFileInput): Promise<{ bytes: number; sha256: string }> {
  const { url, abort } = input
  const send = input.request ?? ((url.protocol === 'https:' ? httpsRequest : httpRequest) as PutRequestFn)
  return new Promise((resolve, reject) => {
    const stream = createReadStream(input.file)
    const hash = createHash('sha256')
    let sent = 0
    let settled = false
    const finish = (error?: Error, result?: { bytes: number; sha256: string }): void => {
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
    const fail = (detail: string): void => finish(new PutObjectError('upload-failed', detail))
    const req = send(url, { method: 'PUT', headers: input.headers }, (res) => {
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
          if (sent !== input.bytes || sha256 !== input.sha256) {
            return finish(new PutObjectError('changed', 'the staged file changed during upload'))
          }
          return finish(undefined, { bytes: sent, sha256 })
        }
        const body = Buffer.concat(chunks).toString('utf8').slice(0, MAX_ERROR_BODY_BYTES)
        const code = /<Code>([A-Za-z0-9.]{1,64})<\/Code>/.exec(body)?.[1]
        finish(new PutObjectError('upload-refused', `HTTP ${res.statusCode ?? 0}${code ? ` ${code}` : ''}`))
      })
    })
    // Errors never echo the URL: only the errno code is kept.
    req.on('error', (err: NodeJS.ErrnoException) => fail(err.code ?? 'request error'))
    const timer = setTimeout(() => fail(`timed out after ${input.timeoutMs}ms`), input.timeoutMs)
    const onAbort = (): void => fail('cancelled')
    if (abort?.aborted) return onAbort()
    abort?.addEventListener('abort', onAbort, { once: true })
    stream.on('data', (chunk) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      sent += buffer.length
      hash.update(buffer)
      // Never send more than was signed; a grown file is cut off and the store refuses the short body.
      if (sent > input.bytes) return fail('the staged file grew during upload')
      if (!req.write(buffer)) {
        stream.pause()
        req.once('drain', () => stream.resume())
      }
    })
    stream.on('error', (err) => fail(err.message))
    stream.on('end', () => {
      if (sent !== input.bytes) return fail('the staged file shrank during upload')
      req.end()
    })
  })
}
