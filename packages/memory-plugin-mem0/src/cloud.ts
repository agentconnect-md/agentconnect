import { z } from 'zod'
import type {
  CaptureReceipt,
  CanonicalMemoryRecord,
  MemoryPluginCaptureInput,
  MemoryPluginDeleteInput,
  MemoryPluginGetInput,
  MemoryPluginHistoryInput,
  MemoryPluginListInput,
  MemoryPluginOperationStatusInput,
  MemoryPluginRecallInput
} from '@agentconnect.md/protocol'
import {
  defaultMem0CloudMetrics,
  type Mem0CloudMetrics,
  type Mem0CloudOperation,
  type Mem0CloudOutcome
} from './metrics.js'

export const MEM0_CLOUD_API = 'https://api.mem0.ai' as const
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_METADATA_BYTES = 4 * 1024
const MAX_RECORD_TEXT_BYTES = 16 * 1024
const MEM0_PLUGIN_ID = 'ai.mem0.memory'

const SearchResult = z
  .object({
    id: z.string(),
    memory: z.string(),
    score: z.number().finite().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    categories: z.array(z.string()).optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    agent_id: z.string().nullable().optional(),
    hash: z.string().optional()
  })
  .passthrough()
const SearchResponse = z.object({ results: z.array(SearchResult) }).passthrough()
const ListResponse = z
  .object({
    count: z.number().int().nonnegative(),
    next: z.string().url().nullable(),
    previous: z.string().url().nullable(),
    results: z.array(SearchResult)
  })
  .passthrough()
const GetResponse = SearchResult
const HistoryEntry = z
  .object({
    id: z.string().min(1),
    memory_id: z.string().min(1),
    new_memory: z.string(),
    event: z.enum(['ADD', 'UPDATE', 'DELETE']),
    created_at: z.string(),
    updated_at: z.string(),
    metadata: z.record(z.string(), z.unknown()).optional()
  })
  .passthrough()
const HistoryResponse = z.array(HistoryEntry)
const AddResponse = z.object({ event_id: z.string().min(1), status: z.string().optional() }).passthrough()
const EventResponse = z
  .object({ id: z.string().min(1), status: z.enum(['PENDING', 'RUNNING', 'FAILED', 'SUCCEEDED']) })
  .passthrough()

export class Mem0CloudHttpError extends Error {
  constructor(
    readonly code: 'auth' | 'rate_limited' | 'upstream_5xx' | 'upstream_rejected',
    readonly status: number
  ) {
    super(`Mem0 Cloud request failed (${code})`)
    this.name = 'Mem0CloudHttpError'
  }
}

export class Mem0CloudProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Mem0CloudProtocolError'
  }
}

export class Mem0CloudConflictError extends Error {
  constructor() {
    super('Mem0 Cloud memory version changed before delete')
    this.name = 'Mem0CloudConflictError'
  }
}

function authValue(apiKey: string): string {
  const value = apiKey.trim()
  if (!value) throw new Mem0CloudProtocolError('Mem0 Cloud API key is missing')
  return /^Token\s/i.test(value) ? value : `Token ${value}`
}

function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text)
  if (bytes.length <= maxBytes) return text
  return bytes
    .subarray(0, maxBytes)
    .toString('utf8')
    .replace(/\uFFFD+$/, '')
}

function safeDate(value: string | undefined): string | undefined {
  if (!value) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

function safeMetadata(result: {
  metadata?: Record<string, unknown>
  categories?: string[]
}): Record<string, unknown> | undefined {
  const metadata = {
    ...(result.metadata ?? {}),
    ...(result.categories?.length ? { categories: result.categories.slice(0, 64) } : {})
  }
  try {
    return Buffer.byteLength(JSON.stringify(metadata)) <= MAX_METADATA_BYTES ? metadata : undefined
  } catch {
    return undefined
  }
}

function recordFromResult(
  result: z.infer<typeof SearchResult>,
  scope: MemoryPluginRecallInput['context']['scope']
): CanonicalMemoryRecord | null {
  const id = result.id.trim()
  const text = truncateUtf8(result.memory.trim(), MAX_RECORD_TEXT_BYTES)
  if (!id || id.length > 512 || !text) return null
  if (result.agent_id !== undefined && result.agent_id !== null && result.agent_id !== scope.key) {
    throw new Mem0CloudProtocolError('Mem0 Cloud returned a memory outside the trusted scope')
  }
  const createdAt = safeDate(result.created_at)
  const updatedAt = safeDate(result.updated_at)
  const metadata = safeMetadata(result)
  const version = result.hash?.trim()
  return {
    id,
    text,
    scope,
    ...(result.score !== undefined ? { score: result.score } : {}),
    ...(metadata ? { metadata } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(version ? { version: version.slice(0, 512) } : {}),
    provenance: { pluginId: MEM0_PLUGIN_ID, backendId: id }
  }
}

function pageCursor(cursor: string | undefined): number {
  if (!cursor) return 1
  if (!/^[1-9]\d{0,8}$/.test(cursor)) throw new Mem0CloudProtocolError('Mem0 Cloud pagination cursor is invalid')
  return Number(cursor)
}

function httpError(status: number): Mem0CloudHttpError {
  if (status === 401 || status === 403) return new Mem0CloudHttpError('auth', status)
  if (status === 429) return new Mem0CloudHttpError('rate_limited', status)
  if (status >= 500) return new Mem0CloudHttpError('upstream_5xx', status)
  return new Mem0CloudHttpError('upstream_rejected', status)
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new Mem0CloudProtocolError('Mem0 Cloud response exceeded the byte limit')
  }
  if (!response.body) throw new Mem0CloudProtocolError('Mem0 Cloud returned an empty response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    bytes += chunk.value.byteLength
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Mem0CloudProtocolError('Mem0 Cloud response exceeded the byte limit')
    }
    chunks.push(chunk.value)
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
  try {
    return JSON.parse(body)
  } catch {
    throw new Mem0CloudProtocolError('Mem0 Cloud returned invalid JSON')
  }
}

export interface Mem0CloudClientOptions {
  baseUrl?: string | URL
  fetch?: typeof fetch
  metrics?: Mem0CloudMetrics
  now?: () => number
}

/** Strict Cloud V3 dialect adapter. It is deliberately separate from OSS. */
export class Mem0CloudClient {
  private readonly baseUrl: URL
  private readonly fetch: typeof fetch
  private readonly metrics: Mem0CloudMetrics
  private readonly now: () => number

  constructor(options: Mem0CloudClientOptions = {}) {
    this.baseUrl = new URL(options.baseUrl ?? MEM0_CLOUD_API)
    if (this.baseUrl.protocol !== 'https:' && this.baseUrl.protocol !== 'http:') {
      throw new Mem0CloudProtocolError('Mem0 Cloud base URL must use http or https')
    }
    if (this.baseUrl.username || this.baseUrl.password) {
      throw new Mem0CloudProtocolError('Mem0 Cloud base URL must not contain credentials')
    }
    this.fetch = options.fetch ?? fetch
    this.metrics = options.metrics ?? defaultMem0CloudMetrics
    this.now = options.now ?? Date.now
  }

  async recall(input: MemoryPluginRecallInput, apiKey: string, signal?: AbortSignal) {
    const raw = await this.request(
      'recall',
      '/v3/memories/search/',
      apiKey,
      {
        method: 'POST',
        body: JSON.stringify({
          query: input.query,
          filters: { agent_id: input.context.scope.key },
          top_k: input.topK,
          threshold: 0,
          rerank: false
        })
      },
      signal
    )
    const response = SearchResponse.parse(raw)
    const records: CanonicalMemoryRecord[] = []
    const ids = new Set<string>()
    let textBytes = 0
    for (const result of response.results) {
      if (records.length >= input.topK || records.length >= 20) break
      const record = recordFromResult(result, input.context.scope)
      if (!record || ids.has(record.id)) continue
      const bytes = Buffer.byteLength(record.text)
      if (textBytes + bytes > input.maxBytes) continue
      records.push(record)
      ids.add(record.id)
      textBytes += bytes
    }
    return { records }
  }

  /** Mem0 add is not documented idempotent. Any failure after fetch begins is
   * conservatively ambiguous unless Mem0 returned a definite non-2xx response. */
  async capture(input: MemoryPluginCaptureInput, apiKey: string, signal?: AbortSignal): Promise<CaptureReceipt> {
    try {
      const raw = await this.request(
        'capture',
        '/v3/memories/add/',
        apiKey,
        {
          method: 'POST',
          body: JSON.stringify({
            messages: [
              { role: 'user', content: input.turn.input },
              { role: 'assistant', content: input.turn.output }
            ],
            agent_id: input.context.scope.key,
            metadata: {
              ac_turn_id: input.turn.turnId,
              ...(input.turn.sessionId ? { ac_session_id: input.turn.sessionId } : {}),
              ac_connection_id: input.context.connection.id
            }
          })
        },
        signal
      )
      const response = AddResponse.parse(raw)
      return { state: 'accepted', backendOperationId: response.event_id }
    } catch (error) {
      return { state: error instanceof Mem0CloudHttpError ? 'failed' : 'ambiguous' }
    }
  }

  async operationStatus(
    input: MemoryPluginOperationStatusInput,
    apiKey: string,
    signal?: AbortSignal
  ): Promise<CaptureReceipt> {
    if (!input.backendOperationId) throw new Mem0CloudProtocolError('Mem0 Cloud event id is missing')
    try {
      const raw = await this.request(
        'status',
        `/v1/event/${encodeURIComponent(input.backendOperationId)}/`,
        apiKey,
        { method: 'GET' },
        signal
      )
      const event = EventResponse.parse(raw)
      if (event.id !== input.backendOperationId) {
        throw new Mem0CloudProtocolError('Mem0 Cloud returned a mismatched event id')
      }
      if (event.status === 'SUCCEEDED') return { state: 'completed', backendOperationId: event.id }
      if (event.status === 'FAILED') return { state: 'failed', backendOperationId: event.id }
      return { state: 'accepted', backendOperationId: event.id }
    } catch (error) {
      if (error instanceof Mem0CloudHttpError) return { state: 'failed', backendOperationId: input.backendOperationId }
      throw error
    }
  }

  async list(input: MemoryPluginListInput, apiKey: string, signal?: AbortSignal) {
    const page = pageCursor(input.cursor)
    const raw = await this.request(
      'list',
      `/v3/memories/?page=${page}&page_size=${input.limit}`,
      apiKey,
      {
        method: 'POST',
        body: JSON.stringify({ filters: { agent_id: input.context.scope.key } })
      },
      signal
    )
    const response = ListResponse.parse(raw)
    const records: CanonicalMemoryRecord[] = []
    const ids = new Set<string>()
    for (const item of response.results) {
      if (records.length >= input.limit || records.length >= 20) break
      const record = recordFromResult(item, input.context.scope)
      if (!record || ids.has(record.id)) continue
      ids.add(record.id)
      records.push(record)
    }
    const nextCursor = response.next ? String(page + 1) : undefined
    return { records, ...(nextCursor ? { nextCursor } : {}) }
  }

  async get(input: MemoryPluginGetInput, apiKey: string, signal?: AbortSignal) {
    try {
      const raw = await this.request(
        'get',
        `/v1/memories/${encodeURIComponent(input.id)}`,
        apiKey,
        { method: 'GET' },
        signal
      )
      const result = GetResponse.parse(raw)
      if (result.id !== input.id) throw new Mem0CloudProtocolError('Mem0 Cloud returned a mismatched memory id')
      if (result.agent_id !== input.context.scope.key) {
        throw new Mem0CloudProtocolError('Mem0 Cloud returned a memory outside the trusted scope')
      }
      return { record: recordFromResult(result, input.context.scope) }
    } catch (error) {
      if (error instanceof Mem0CloudHttpError && error.status === 404) return { record: null }
      throw error
    }
  }

  async delete(input: MemoryPluginDeleteInput, apiKey: string, signal?: AbortSignal) {
    // The single-record delete endpoint is ID-only. Resolve it first and verify
    // the backend's agent_id before performing the effect so a guessed foreign
    // id cannot cross the trusted canonical scope.
    const existing = await this.get({ context: input.context, id: input.id }, apiKey, signal)
    if (!existing.record) return { deleted: false }
    if (input.version && existing.record.version !== input.version) {
      throw new Mem0CloudConflictError()
    }
    await this.request(
      'delete',
      `/v1/memories/${encodeURIComponent(input.id)}`,
      apiKey,
      { method: 'DELETE', expectJson: false },
      signal
    )
    return { deleted: true }
  }

  async history(input: MemoryPluginHistoryInput, apiKey: string, signal?: AbortSignal) {
    const existing = await this.get({ context: input.context, id: input.id }, apiKey, signal)
    if (!existing.record) return { events: [] }
    const raw = await this.request(
      'history',
      `/v1/memories/${encodeURIComponent(input.id)}/history`,
      apiKey,
      { method: 'GET' },
      signal
    )
    const all = HistoryResponse.parse(raw)
    const offset = input.cursor ? pageCursor(input.cursor) - 1 : 0
    const events = all.slice(offset, offset + input.limit).map((entry) => {
      if (entry.memory_id !== input.id) throw new Mem0CloudProtocolError('Mem0 Cloud returned mismatched history')
      const at = safeDate(entry.updated_at) ?? safeDate(entry.created_at)
      if (!at) throw new Mem0CloudProtocolError('Mem0 Cloud returned invalid history time')
      const text = truncateUtf8(entry.new_memory.trim(), MAX_RECORD_TEXT_BYTES)
      const metadata = safeMetadata(entry)
      return {
        id: entry.id,
        event: ({ ADD: 'create', UPDATE: 'update', DELETE: 'delete' } as const)[entry.event],
        at,
        ...(text
          ? {
              record: {
                id: input.id,
                text,
                scope: input.context.scope,
                ...(metadata ? { metadata } : {}),
                updatedAt: at,
                provenance: { pluginId: MEM0_PLUGIN_ID, backendId: input.id }
              }
            }
          : {})
      }
    })
    const nextOffset = offset + events.length
    return { events, ...(nextOffset < all.length ? { nextCursor: String(nextOffset + 1) } : {}) }
  }

  private async request(
    operation: Mem0CloudOperation,
    path: string,
    apiKey: string,
    init: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: string; expectJson?: boolean },
    signal?: AbortSignal
  ): Promise<unknown> {
    const startedAt = this.now()
    try {
      const response = await this.fetch(new URL(path, this.baseUrl), {
        method: init.method,
        // Keep the declared second-hop egress boundary exact. A redirect must
        // never carry a credential or memory body to an unreviewed host.
        redirect: 'error',
        headers: {
          Authorization: authValue(apiKey),
          Accept: 'application/json',
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(signal ? { signal } : {})
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw httpError(response.status)
      }
      const body = init.expectJson === false || response.status === 204 ? undefined : await boundedJson(response)
      this.metrics.request({ operation, outcome: 'ok', durationMs: Math.max(0, this.now() - startedAt) })
      return body
    } catch (error) {
      let outcome: Mem0CloudOutcome
      if (error instanceof Mem0CloudHttpError) outcome = error.code
      else if (error instanceof Mem0CloudProtocolError) outcome = 'protocol'
      else if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) outcome = 'cancelled'
      else outcome = 'network'
      this.metrics.request({ operation, outcome, durationMs: Math.max(0, this.now() - startedAt) })
      throw error
    }
  }
}
