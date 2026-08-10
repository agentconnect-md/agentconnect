import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createInterface } from 'node:readline'
import type { InClusterConfig } from './config.js'

/** A Kubernetes API rejection, carrying the fields callers actually branch on. */
export class K8sApiError extends Error {
  constructor(
    readonly status: number,
    /** The `Status.reason` when the API server sent one (e.g. `Conflict`, `Expired`). */
    readonly reason: string | undefined,
    message: string
  ) {
    super(message)
    this.name = 'K8sApiError'
  }

  /** A write lost its optimistic-concurrency race; re-read and retry. */
  get isConflict(): boolean {
    return this.status === 409
  }

  /** The requested `resourceVersion` is too old to resume from — re-list. */
  get isExpired(): boolean {
    return this.status === 410 || this.reason === 'Expired'
  }

  get isNotFound(): boolean {
    return this.status === 404
  }

  /** The object already exists; idempotent create-if-absent treats this as success. */
  get isAlreadyExists(): boolean {
    return this.status === 409 && this.reason === 'AlreadyExists'
  }
}

export interface K8sRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT'
  /** Absolute API path, e.g. `/apis/agents.x-k8s.io/v1beta1/namespaces/x/sandboxes`. */
  path: string
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  /** Defaults to `application/json`; JSON Patch writes pass their own. */
  contentType?: string
  signal?: AbortSignal
}

function buildUrl(server: string, req: K8sRequest): URL {
  const url = new URL(req.path, server)
  for (const [key, value] of Object.entries(req.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return url
}

function statusFrom(status: number, raw: string): K8sApiError {
  let reason: string | undefined
  let message = raw.trim()
  try {
    const parsed = JSON.parse(raw) as { reason?: string; message?: string }
    reason = parsed.reason
    if (parsed.message) message = parsed.message
  } catch {
    /* not a Status body — keep the raw text */
  }
  return new K8sApiError(status, reason, `kubernetes ${status}${reason ? ` (${reason})` : ''}: ${message}`)
}

/**
 * The transport under the typed Kubernetes operations.
 *
 * Deliberately `node:http(s)` rather than `fetch`: the API server is presented
 * under its own CA, and pinning that CA per request is a plain option here while
 * `fetch` would need an undici dispatcher — a dependency this daemon does not
 * carry. It also hands us the raw response stream a watch needs.
 *
 * The bearer token is read from {@link InClusterConfig.token} on every request,
 * never captured: the kubelet rotates the projected token in place.
 */
export class K8sHttp {
  constructor(private cfg: InClusterConfig) {}

  private send(req: K8sRequest): Promise<{ status: number; message: IncomingMessage }> {
    const url = buildUrl(this.cfg.server, req)
    const payload = req.body === undefined ? undefined : Buffer.from(JSON.stringify(req.body))
    const send = url.protocol === 'http:' ? httpRequest : httpsRequest
    return new Promise((resolve, reject) => {
      const clientRequest = send(
        url,
        {
          method: req.method,
          headers: {
            authorization: `Bearer ${this.cfg.token()}`,
            accept: 'application/json',
            ...(payload
              ? { 'content-type': req.contentType ?? 'application/json', 'content-length': payload.length }
              : {})
          },
          ...(this.cfg.ca ? { ca: this.cfg.ca } : {}),
          ...(req.signal ? { signal: req.signal } : {})
        },
        (message) => resolve({ status: message.statusCode ?? 0, message })
      )
      clientRequest.on('error', reject)
      if (payload) clientRequest.write(payload)
      clientRequest.end()
    })
  }

  private static drain(message: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let text = ''
      message.setEncoding('utf8')
      message.on('data', (chunk: string) => (text += chunk))
      message.on('end', () => resolve(text))
      message.on('error', reject)
    })
  }

  /** One request/response, parsed as JSON. Non-2xx throws {@link K8sApiError}. */
  async json<T>(req: K8sRequest): Promise<T> {
    const { status, message } = await this.send(req)
    const text = await K8sHttp.drain(message)
    if (status < 200 || status >= 300) throw statusFrom(status, text)
    return (text ? JSON.parse(text) : {}) as T
  }

  /**
   * A streaming request yielding one decoded JSON object per line — the shape
   * `?watch=true` responds with. The iterator ends when the API server closes the
   * stream, which a watch loop treats as "reconnect", not as an error.
   */
  async *lines<T>(req: K8sRequest): AsyncGenerator<T> {
    const { status, message } = await this.send(req)
    if (status < 200 || status >= 300) {
      throw statusFrom(status, await K8sHttp.drain(message))
    }
    const reader = createInterface({ input: message, crlfDelay: Infinity })
    try {
      for await (const line of reader) {
        if (!line.trim()) continue
        yield JSON.parse(line) as T
      }
    } finally {
      reader.close()
      message.destroy()
    }
  }
}
