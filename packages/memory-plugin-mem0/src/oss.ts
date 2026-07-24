import { createHash } from 'node:crypto'
import { z } from 'zod'
import type {
  CaptureReceipt,
  CanonicalMemoryRecord,
  MemoryPluginCaptureInput,
  MemoryPluginCreateInput,
  MemoryPluginDeleteInput,
  MemoryPluginGetInput,
  MemoryPluginHistoryInput,
  MemoryPluginListInput,
  MemoryPluginRecallInput
} from '@agentconnect.md/protocol'
import { defaultMem0Metrics, type Mem0Metrics, type Mem0Operation, type Mem0Outcome } from './metrics.js'

export const MEM0_OSS_DEFAULT_API = 'http://127.0.0.1:8888' as const
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_REQUEST_BYTES = 256 * 1024
const MAX_METADATA_BYTES = 4 * 1024
const MAX_RECORD_TEXT_BYTES = 16 * 1024
const MAX_LIST_WINDOW = 1_000
const MEM0_OSS_PLUGIN_ID = 'ai.mem0.memory.oss'

const BackendId = z.union([z.string(), z.number().finite()]).transform(String)
// Mem0 OSS returns `metadata: null` for a record created without metadata.
// Accept null (and absent) and normalize both to undefined, while still
// rejecting non-object values, so one metadata-less record cannot fail the
// whole list/get/recall/history response.
const OptionalMetadata = z
  .record(z.string(), z.unknown())
  .nullish()
  .transform((value) => value ?? undefined)
const MemoryResult = z
  .object({
    id: BackendId,
    memory: z.string(),
    // Mem0's ID-only get route serializes its unset model score as null.
    // Normalize that non-search value to absent while keeping real scores finite.
    score: z
      .number()
      .finite()
      .nullish()
      .transform((value) => value ?? undefined),
    metadata: OptionalMetadata,
    categories: z.array(z.string()).optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    agent_id: z.string().nullable().optional(),
    hash: z.string().optional()
  })
  .passthrough()
const ResultsResponse = z.object({ results: z.array(MemoryResult) }).passthrough()
const AddResult = z
  .object({
    id: BackendId.optional(),
    memory: z.string().optional(),
    event: z.string().optional()
  })
  .passthrough()
const AddResponse = z.object({ results: z.array(AddResult) }).passthrough()
const DeleteResponse = z.object({ message: z.string() }).passthrough()
const HistoryEntry = z
  .object({
    id: BackendId,
    memory_id: BackendId,
    old_memory: z.string().nullable().optional(),
    new_memory: z.string().nullable().optional(),
    event: z.string(),
    created_at: z.string(),
    updated_at: z.string().optional(),
    metadata: OptionalMetadata
  })
  .passthrough()
const HistoryResponse = z.array(HistoryEntry)

export class Mem0OssHttpError extends Error {
  constructor(
    readonly code: 'auth' | 'rate_limited' | 'upstream_5xx' | 'upstream_rejected',
    readonly status: number
  ) {
    super(`Mem0 OSS request failed (${code})`)
    this.name = 'Mem0OssHttpError'
  }
}

export class Mem0OssProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Mem0OssProtocolError'
  }
}

/** Deterministic local validation failure before fetch is invoked. */
class Mem0OssPreflightError extends Mem0OssProtocolError {
  constructor(message: string) {
    super(message)
    this.name = 'Mem0OssPreflightError'
  }
}

export class Mem0OssConflictError extends Error {
  constructor() {
    super('Mem0 OSS memory version changed before delete')
    this.name = 'Mem0OssConflictError'
  }
}

function authValue(apiKey: string): string {
  const value = apiKey.trim()
  if (!value) throw new Mem0OssPreflightError('Mem0 OSS API key is missing')
  return value
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

function sortedJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJsonValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortedJsonValue(item)])
  )
}

function versionFor(result: z.infer<typeof MemoryResult>): string {
  const backendHash = result.hash?.trim()
  if (backendHash) return backendHash.slice(0, 512)
  return `sha256:${createHash('sha256')
    .update(
      JSON.stringify(
        sortedJsonValue({
          id: result.id,
          memory: result.memory,
          metadata: result.metadata,
          updatedAt: result.updated_at ?? result.created_at
        })
      )
    )
    .digest('hex')}`
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

function boundedMetadata(
  supplied: Record<string, unknown> | undefined,
  reserved: Record<string, string>
): Record<string, unknown> {
  const metadata = { ...(supplied ?? {}), ...reserved }
  let encoded: string
  try {
    encoded = JSON.stringify(metadata)
  } catch {
    throw new Mem0OssProtocolError('Mem0 OSS metadata must be JSON-serializable')
  }
  if (Buffer.byteLength(encoded) > MAX_METADATA_BYTES) {
    throw new Mem0OssProtocolError('Mem0 OSS metadata exceeded the byte limit')
  }
  return metadata
}

function recordFromResult(
  result: z.infer<typeof MemoryResult>,
  scope: MemoryPluginRecallInput['context']['scope']
): CanonicalMemoryRecord | null {
  const id = result.id.trim()
  const text = truncateUtf8(result.memory.trim(), MAX_RECORD_TEXT_BYTES)
  if (!id || id.length > 512 || !text) return null
  // OSS single-record routes are ID-only. Require an exact backend entity on
  // every returned record so a guessed foreign id can never cross core scope.
  if (result.agent_id !== scope.key) {
    throw new Mem0OssProtocolError('Mem0 OSS returned a memory outside the trusted scope')
  }
  const createdAt = safeDate(result.created_at)
  const updatedAt = safeDate(result.updated_at)
  const metadata = safeMetadata(result)
  return {
    id,
    text,
    scope,
    ...(result.score !== undefined ? { score: result.score } : {}),
    ...(metadata ? { metadata } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    version: versionFor(result),
    provenance: { pluginId: MEM0_OSS_PLUGIN_ID, backendId: id }
  }
}

function pageOffset(cursor: string | undefined): number {
  if (!cursor) return 0
  if (!/^\d{1,4}$/.test(cursor)) throw new Mem0OssProtocolError('Mem0 OSS pagination cursor is invalid')
  const offset = Number(cursor)
  if (offset >= MAX_LIST_WINDOW) throw new Mem0OssProtocolError('Mem0 OSS pagination cursor is outside the window')
  return offset
}

function httpError(status: number): Mem0OssHttpError {
  if (status === 401 || status === 403) return new Mem0OssHttpError('auth', status)
  if (status === 429) return new Mem0OssHttpError('rate_limited', status)
  if (status >= 500) return new Mem0OssHttpError('upstream_5xx', status)
  return new Mem0OssHttpError('upstream_rejected', status)
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new Mem0OssProtocolError('Mem0 OSS response exceeded the byte limit')
  }
  if (!response.body) throw new Mem0OssProtocolError('Mem0 OSS returned an empty response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    bytes += chunk.value.byteLength
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Mem0OssProtocolError('Mem0 OSS response exceeded the byte limit')
    }
    chunks.push(chunk.value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'))
  } catch {
    throw new Mem0OssProtocolError('Mem0 OSS returned invalid JSON')
  }
}

export interface Mem0OssClientOptions {
  /** Operator/deployment-owned base URL. Tenant connection config is never read. */
  baseUrl?: string | URL
  fetch?: typeof fetch
  metrics?: Mem0Metrics
  now?: () => number
}

/** Strict current Mem0 OSS REST dialect; deliberately separate from Cloud V3. */
export class Mem0OssClient {
  private readonly baseUrl: URL
  private readonly fetch: typeof fetch
  private readonly metrics: Mem0Metrics
  private readonly now: () => number

  constructor(options: Mem0OssClientOptions = {}) {
    this.baseUrl = new URL(options.baseUrl ?? MEM0_OSS_DEFAULT_API)
    if (this.baseUrl.protocol !== 'https:' && this.baseUrl.protocol !== 'http:') {
      throw new Mem0OssProtocolError('Mem0 OSS base URL must use http or https')
    }
    if (this.baseUrl.username || this.baseUrl.password) {
      throw new Mem0OssProtocolError('Mem0 OSS base URL must not contain credentials')
    }
    this.baseUrl.pathname = `${this.baseUrl.pathname.replace(/\/+$/, '')}/`
    this.fetch = options.fetch ?? fetch
    this.metrics = options.metrics ?? defaultMem0Metrics
    this.now = options.now ?? Date.now
  }

  async recall(input: MemoryPluginRecallInput, apiKey: string, signal?: AbortSignal) {
    const raw = await this.request(
      'recall',
      'search',
      apiKey,
      {
        method: 'POST',
        body: JSON.stringify({
          query: input.query,
          filters: { agent_id: input.context.scope.key },
          top_k: input.topK
        })
      },
      signal
    )
    const response = ResultsResponse.parse(raw)
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

  async capture(input: MemoryPluginCaptureInput, apiKey: string, signal?: AbortSignal): Promise<CaptureReceipt> {
    const metadata = boundedMetadata(undefined, {
      ac_turn_id: input.turn.turnId,
      ...(input.turn.sessionId ? { ac_session_id: input.turn.sessionId } : {}),
      ac_connection_id: input.context.connection.id
    })
    try {
      const raw = await this.request(
        'capture',
        'memories',
        apiKey,
        {
          method: 'POST',
          body: JSON.stringify({
            messages: [
              { role: 'user', content: input.turn.input },
              { role: 'assistant', content: input.turn.output }
            ],
            agent_id: input.context.scope.key,
            metadata,
            infer: true
          })
        },
        signal
      )
      AddResponse.parse(raw)
      return { state: 'completed' }
    } catch (error) {
      return {
        state: error instanceof Mem0OssHttpError || error instanceof Mem0OssPreflightError ? 'failed' : 'ambiguous'
      }
    }
  }

  async list(input: MemoryPluginListInput, apiKey: string, signal?: AbortSignal) {
    const offset = pageOffset(input.cursor)
    const limit = Math.min(input.limit, 20)
    const topK = Math.min(MAX_LIST_WINDOW, offset + limit + 1)
    const query = new URLSearchParams({ agent_id: input.context.scope.key, top_k: String(topK) })
    const raw = await this.request('list', `memories?${query}`, apiKey, { method: 'GET' }, signal)
    const response = ResultsResponse.parse(raw)
    const page = response.results.slice(offset, offset + limit)
    const records = page.flatMap((item) => {
      const record = recordFromResult(item, input.context.scope)
      return record ? [record] : []
    })
    const hasMore = response.results.length > offset + limit
    return { records, ...(hasMore ? { nextCursor: String(offset + limit) } : {}) }
  }

  async get(input: MemoryPluginGetInput, apiKey: string, signal?: AbortSignal) {
    try {
      const raw = await this.request(
        'get',
        `memories/${encodeURIComponent(input.id)}`,
        apiKey,
        { method: 'GET' },
        signal
      )
      const result = MemoryResult.parse(raw)
      if (result.id !== input.id) throw new Mem0OssProtocolError('Mem0 OSS returned a mismatched memory id')
      return { record: recordFromResult(result, input.context.scope) }
    } catch (error) {
      if (error instanceof Mem0OssHttpError && error.status === 404) return { record: null }
      throw error
    }
  }

  async create(input: MemoryPluginCreateInput, apiKey: string, signal?: AbortSignal) {
    if (Buffer.byteLength(input.text) > MAX_RECORD_TEXT_BYTES) {
      throw new Mem0OssProtocolError('Mem0 OSS record text exceeded the byte limit')
    }
    const metadata = boundedMetadata(input.metadata, {
      ac_operation_id: input.operationId,
      ac_connection_id: input.context.connection.id
    })
    const raw = await this.request(
      'create',
      'memories',
      apiKey,
      {
        method: 'POST',
        body: JSON.stringify({
          messages: [{ role: 'user', content: input.text }],
          agent_id: input.context.scope.key,
          metadata,
          infer: false
        })
      },
      signal
    )
    const added = AddResponse.parse(raw).results.find((result) => result.id !== undefined)
    if (!added?.id) throw new Mem0OssProtocolError('Mem0 OSS create did not return a memory id')
    const created = await this.get({ context: input.context, id: added.id }, apiKey, signal)
    if (!created.record) throw new Mem0OssProtocolError('Mem0 OSS create result was not readable')
    return { record: created.record }
  }

  async delete(input: MemoryPluginDeleteInput, apiKey: string, signal?: AbortSignal) {
    const existing = await this.get({ context: input.context, id: input.id }, apiKey, signal)
    if (!existing.record) return { deleted: false }
    if (input.version && existing.record.version !== input.version) throw new Mem0OssConflictError()
    const raw = await this.request(
      'delete',
      `memories/${encodeURIComponent(input.id)}`,
      apiKey,
      { method: 'DELETE' },
      signal
    )
    DeleteResponse.parse(raw)
    return { deleted: true }
  }

  async history(input: MemoryPluginHistoryInput, apiKey: string, signal?: AbortSignal) {
    const existing = await this.get({ context: input.context, id: input.id }, apiKey, signal)
    if (!existing.record) return { events: [] }
    const raw = await this.request(
      'history',
      `memories/${encodeURIComponent(input.id)}/history`,
      apiKey,
      { method: 'GET' },
      signal
    )
    const all = HistoryResponse.parse(raw)
    const offset = pageOffset(input.cursor)
    const events = all.slice(offset, offset + Math.min(input.limit, 20)).map((entry) => {
      if (entry.memory_id !== input.id) throw new Mem0OssProtocolError('Mem0 OSS returned mismatched history')
      const at = safeDate(entry.updated_at) ?? safeDate(entry.created_at)
      if (!at) throw new Mem0OssProtocolError('Mem0 OSS returned invalid history time')
      const event = entry.event.toUpperCase()
      const canonicalEvent = ({ ADD: 'create', UPDATE: 'update', DELETE: 'delete' } as const)[
        event as 'ADD' | 'UPDATE' | 'DELETE'
      ]
      if (!canonicalEvent) throw new Mem0OssProtocolError('Mem0 OSS returned an invalid history event')
      const text = truncateUtf8((entry.new_memory ?? entry.old_memory ?? '').trim(), MAX_RECORD_TEXT_BYTES)
      const metadata = safeMetadata(entry)
      return {
        id: entry.id,
        event: canonicalEvent,
        at,
        ...(canonicalEvent !== 'delete' && text
          ? {
              record: {
                id: input.id,
                text,
                scope: input.context.scope,
                ...(metadata ? { metadata } : {}),
                updatedAt: at,
                provenance: { pluginId: MEM0_OSS_PLUGIN_ID, backendId: input.id }
              }
            }
          : {})
      }
    })
    const nextOffset = offset + events.length
    return { events, ...(nextOffset < all.length ? { nextCursor: String(nextOffset) } : {}) }
  }

  private async request(
    operation: Mem0Operation,
    path: string,
    apiKey: string,
    init: { method: 'GET' | 'POST' | 'DELETE'; body?: string },
    signal?: AbortSignal
  ): Promise<unknown> {
    const startedAt = this.now()
    try {
      if (init.body !== undefined && Buffer.byteLength(init.body) > MAX_REQUEST_BYTES) {
        throw new Mem0OssPreflightError('Mem0 OSS request exceeded the byte limit')
      }
      const response = await this.fetch(new URL(path, this.baseUrl), {
        method: init.method,
        redirect: 'error',
        headers: {
          'X-API-Key': authValue(apiKey),
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
      const body = await boundedJson(response)
      this.metrics.request({ operation, outcome: 'ok', durationMs: Math.max(0, this.now() - startedAt) })
      return body
    } catch (error) {
      let outcome: Mem0Outcome
      if (error instanceof Mem0OssHttpError) outcome = error.code
      else if (error instanceof Mem0OssProtocolError || error instanceof z.ZodError) outcome = 'protocol'
      else if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) outcome = 'cancelled'
      else outcome = 'network'
      this.metrics.request({ operation, outcome, durationMs: Math.max(0, this.now() - startedAt) })
      throw error
    }
  }
}
