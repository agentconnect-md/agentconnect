import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  MEMORY_PLUGIN_PROFILE_MAJOR,
  MEMORY_PLUGIN_TOOL,
  MEMORY_PLUGIN_ERROR_TOKEN,
  MemoryPluginCaptureInput,
  MemoryPluginCaptureOutput,
  MemoryPluginCreateInput,
  MemoryPluginCreateOutput,
  MemoryPluginDeleteInput,
  MemoryPluginDeleteOutput,
  MemoryPluginGetInput,
  MemoryPluginGetOutput,
  MemoryPluginHealthInput,
  MemoryPluginHealthOutput,
  MemoryPluginHistoryInput,
  MemoryPluginHistoryOutput,
  MemoryPluginListInput,
  MemoryPluginListOutput,
  MemoryPluginManifest,
  MemoryPluginOperationStatusInput,
  MemoryPluginOperationStatusOutput,
  MemoryPluginRecallInput,
  MemoryPluginRecallOutput,
  MemoryPluginUpdateInput,
  MemoryPluginUpdateOutput,
  type CaptureReceipt,
  type CanonicalMemoryRecord as MemoryRecord,
  type MemoryPluginCallContext as CallContext,
  type MemoryPluginCaptureInput as CaptureInput,
  type MemoryPluginCreateInput as CreateInput,
  type MemoryPluginDeleteInput as DeleteInput,
  type MemoryPluginGetInput as GetInput,
  type MemoryPluginHealthInput as HealthInput,
  type MemoryPluginHistoryInput as HistoryInput,
  type MemoryPluginListInput as ListInput,
  type MemoryPluginManifest as Manifest,
  type MemoryPluginOperationStatusInput as OperationStatusInput,
  type MemoryPluginRecallInput as RecallInput,
  type MemoryPluginRecallOutput as RecallOutput,
  type MemoryPluginUpdateInput as UpdateInput
} from '@agentconnect.md/protocol'
import type { z } from 'zod'
import { CappedStdioClientTransport, MemoryPluginStdioProtocolError } from './stdio-transport.js'

const DEFAULT_CONNECT_TIMEOUT_MS = 3_000
const DEFAULT_CALL_TIMEOUT_MS = 3_000
// Capture is the one write that routinely does model-backed work (e.g. Mem0
// `infer: true` fact extraction), so it needs a budget well beyond the generic
// per-call default. Undersizing it misclassifies a healthy-but-slow write as an
// unknown delivery and degrades the connection even though the backend wrote.
const DEFAULT_CAPTURE_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024
const DEFAULT_MAX_CONCURRENT = 4
const MAX_TRANSPORT_TIMEOUT_MS = 60_000
const MAX_LIST_PAGES = 16
const MAX_LISTED_TOOLS = 128
const MAX_CONNECTION_CONFIG_BYTES = 64 * 1024
const MAX_CONNECTION_CONFIG_FIELDS = 128
// Keep one canonical record and any record collection safely below the daemon↔CP
// 256 KiB frame cap after envelope overhead. `JSON.stringify(record)` already
// includes string escaping, so these are encoded-byte limits, not character caps.
const MAX_CANONICAL_RECORD_BYTES = 128 * 1024
const MAX_CANONICAL_COLLECTION_BYTES = 192 * 1024
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const CONFIG_SCHEMA_TYPES = new Set(['object', 'string', 'integer', 'number', 'array', 'boolean', 'null'])
const CONFIG_SCHEMA_FORMATS = new Set(['hostname', 'uri', 'uuid'])
const RESERVED_INJECTED_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'accept',
  'content-type',
  'mcp-protocol-version',
  'mcp-session-id',
  'last-event-id'
])

type McpFetch = NonNullable<StreamableHTTPClientTransportOptions['fetch']>
type Tool = Awaited<ReturnType<Client['listTools']>>['tools'][number]

export class MemoryPluginProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryPluginProtocolError'
  }
}

export class MemoryPluginInputError extends MemoryPluginProtocolError {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryPluginInputError'
  }
}

export class MemoryPluginManifestMismatchError extends MemoryPluginProtocolError {
  constructor() {
    super('memory plugin manifest digest does not match the installation pin')
    this.name = 'MemoryPluginManifestMismatchError'
  }
}

export class MemoryPluginConflictError extends Error {
  constructor() {
    super('memory plugin reported a version conflict')
    this.name = 'MemoryPluginConflictError'
  }
}

interface MemoryPluginClientOptionsBase {
  expectedPluginId?: string
  expectedProfileMajor?: number
  expectedManifestDigest?: string
  connectTimeoutMs?: number
  callTimeoutMs?: number
  /** Budget for the capture write specifically; defaults above the generic call
   * timeout because capture may run model-backed extraction. */
  captureTimeoutMs?: number
  maxResponseBytes?: number
  maxConcurrent?: number
  /** Internal local-process lifecycle hook. Explicit close never invokes it. */
  onUnexpectedClose?: () => void
}

export type MemoryPluginClientOptions = MemoryPluginClientOptionsBase &
  (
    | {
        transport?: 'streamable-http'
        url: string | URL
        headers?: Array<{ name: string; value: string }>
        fetch?: McpFetch
      }
    | {
        transport: 'stdio'
        command: string
        args?: string[]
        env?: Record<string, string>
      }
  )

export interface MemoryPluginProbe {
  manifest: Manifest
  manifestDigest: string
  tools: ReadonlySet<string>
}

interface ConcurrencyWaiter {
  grant(): void
  reject(error: Error): void
}

const OPTIONAL_OPERATION_TO_TOOL = {
  list: MEMORY_PLUGIN_TOOL.list,
  get: MEMORY_PLUGIN_TOOL.get,
  create: MEMORY_PLUGIN_TOOL.create,
  update: MEMORY_PLUGIN_TOOL.update,
  delete: MEMORY_PLUGIN_TOOL.delete,
  history: MEMORY_PLUGIN_TOOL.history
} as const

type CanonicalJsonType = 'object' | 'string' | 'integer' | 'number' | 'array' | 'boolean' | 'null'
type CanonicalSchemaFields = Record<string, CanonicalJsonType | readonly CanonicalJsonType[]>

const REQUIRED_SCHEMA_KEYS: Record<string, { input: CanonicalSchemaFields; output: CanonicalSchemaFields }> = {
  [MEMORY_PLUGIN_TOOL.manifest]: {
    input: {},
    output: { profile: 'string', plugin: 'object', connection: 'object', capabilities: 'object', limits: 'object' }
  },
  [MEMORY_PLUGIN_TOOL.recall]: {
    input: { context: 'object', query: 'string', topK: 'integer', maxBytes: 'integer' },
    output: { records: 'array' }
  },
  [MEMORY_PLUGIN_TOOL.capture]: {
    input: { context: 'object', operationId: 'string', turn: 'object' },
    output: { state: 'string' }
  },
  [MEMORY_PLUGIN_TOOL.health]: { input: { context: 'object' }, output: { status: 'string' } },
  [MEMORY_PLUGIN_TOOL.operationStatus]: {
    input: { context: 'object', operationId: 'string' },
    output: { state: 'string' }
  },
  [MEMORY_PLUGIN_TOOL.list]: { input: { context: 'object' }, output: { records: 'array' } },
  [MEMORY_PLUGIN_TOOL.get]: {
    input: { context: 'object', id: 'string' },
    output: { record: ['object', 'null'] }
  },
  [MEMORY_PLUGIN_TOOL.create]: {
    input: { context: 'object', operationId: 'string', text: 'string' },
    output: { record: 'object' }
  },
  [MEMORY_PLUGIN_TOOL.update]: {
    input: { context: 'object', operationId: 'string', id: 'string', text: 'string' },
    output: { record: 'object' }
  },
  [MEMORY_PLUGIN_TOOL.delete]: {
    input: { context: 'object', operationId: 'string', id: 'string' },
    output: { deleted: 'boolean' }
  },
  [MEMORY_PLUGIN_TOOL.history]: { input: { context: 'object', id: 'string' }, output: { events: 'array' } }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function declaredJsonTypes(schema: unknown, depth = 0): Set<string> {
  if (depth > 8) return new Set()
  const node = asObject(schema)
  if (!node) return new Set()
  const result = new Set<string>()
  if (typeof node.type === 'string') result.add(node.type)
  if (Array.isArray(node.type)) {
    for (const type of node.type) if (typeof type === 'string') result.add(type)
  }
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    if (!Array.isArray(node[keyword])) continue
    for (const branch of node[keyword]) {
      for (const type of declaredJsonTypes(branch, depth + 1)) result.add(type)
    }
  }
  return result
}

function schemaDeclaresExactly(schema: unknown, expected: CanonicalJsonType | readonly CanonicalJsonType[]): boolean {
  const actual = declaredJsonTypes(schema)
  const required = new Set(Array.isArray(expected) ? expected : [expected])
  return actual.size === required.size && [...required].every((type) => actual.has(type))
}

function describeExpectedType(expected: CanonicalJsonType | readonly CanonicalJsonType[]): string {
  return (Array.isArray(expected) ? expected : [expected]).join('|')
}

function assertToolSchema(tool: Tool): void {
  const expected = REQUIRED_SCHEMA_KEYS[tool.name]
  if (!expected) return
  const input = asObject(tool.inputSchema)
  const output = asObject(tool.outputSchema)
  if (input?.type !== 'object') {
    throw new MemoryPluginProtocolError(`memory plugin tool ${tool.name} must declare an object inputSchema`)
  }
  if (output?.type !== 'object') {
    throw new MemoryPluginProtocolError(`memory plugin tool ${tool.name} must declare an object outputSchema`)
  }
  const inputRequired = new Set(
    Array.isArray(input.required) ? input.required.filter((x): x is string => typeof x === 'string') : []
  )
  const outputRequired = new Set(
    Array.isArray(output.required) ? output.required.filter((x): x is string => typeof x === 'string') : []
  )
  const inputProperties = asObject(input.properties)
  const outputProperties = asObject(output.properties)
  for (const [key, type] of Object.entries(expected.input)) {
    if (!inputRequired.has(key)) {
      throw new MemoryPluginProtocolError(`memory plugin tool ${tool.name} inputSchema must require ${key}`)
    }
    if (!schemaDeclaresExactly(inputProperties?.[key], type)) {
      throw new MemoryPluginProtocolError(
        `memory plugin tool ${tool.name} inputSchema ${key} must be ${describeExpectedType(type)}`
      )
    }
  }
  for (const [key, type] of Object.entries(expected.output)) {
    if (!outputRequired.has(key)) {
      throw new MemoryPluginProtocolError(`memory plugin tool ${tool.name} outputSchema must require ${key}`)
    }
    if (!schemaDeclaresExactly(outputProperties?.[key], type)) {
      throw new MemoryPluginProtocolError(
        `memory plugin tool ${tool.name} outputSchema ${key} must be ${describeExpectedType(type)}`
      )
    }
  }
}

/**
 * Validate the deliberately small JSON-Schema subset accepted for connection
 * configuration. It is data-only: no remote refs, executable UI, media payloads,
 * or unbounded recursive schema graphs.
 */
export function assertMemoryConnectionConfigSchema(schema: unknown): void {
  const root = asObject(schema)
  if (!root || root.type !== 'object' || !asObject(root.properties)) {
    throw new MemoryPluginProtocolError('memory plugin connection configSchema must be an object with properties')
  }
  const allowed = new Set([
    'type',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'const',
    'default',
    'title',
    'description',
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'format'
  ])
  let nodes = 0
  const visitLiteral = (value: unknown, depth: number): void => {
    nodes++
    if (nodes > 256 || depth > 8) {
      throw new MemoryPluginProtocolError('memory plugin connection configSchema is too complex')
    }
    if (typeof value === 'string') {
      if (value.length > 4_096 || /<\s*script|javascript\s*:/i.test(value)) {
        throw new MemoryPluginProtocolError('memory plugin connection configSchema contains unsafe text')
      }
      return
    }
    if (value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      if (value.length > 128) {
        throw new MemoryPluginProtocolError('memory plugin connection configSchema array is too large')
      }
      for (const item of value) visitLiteral(item, depth + 1)
      return
    }
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length > 128) {
      throw new MemoryPluginProtocolError('memory plugin connection configSchema literal is too large')
    }
    // const/default/enum values are JSON DATA. Their object keys are not schema
    // keywords and must not be interpreted as such.
    for (const item of Object.values(value as Record<string, unknown>)) visitLiteral(item, depth + 1)
  }
  const visit = (value: unknown, depth: number): void => {
    nodes++
    if (nodes > 256 || depth > 8) {
      throw new MemoryPluginProtocolError('memory plugin connection configSchema is too complex')
    }
    if (typeof value === 'string') {
      if (value.length > 4_096 || /<\s*script|javascript\s*:/i.test(value)) {
        throw new MemoryPluginProtocolError('memory plugin connection configSchema contains unsafe text')
      }
      return
    }
    if (value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      if (value.length > 128)
        throw new MemoryPluginProtocolError('memory plugin connection configSchema array is too large')
      for (const item of value) visit(item, depth + 1)
      return
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (!allowed.has(key)) {
        throw new MemoryPluginProtocolError(`memory plugin connection configSchema keyword ${key} is not supported`)
      }
      // `properties` is a map whose KEYS are tenant-defined field names; validate
      // each value as a schema node without interpreting the field name as a keyword.
      if (key === 'properties') {
        const properties = asObject(item)
        if (!properties || Object.keys(properties).length > 128) {
          throw new MemoryPluginProtocolError('memory plugin connection configSchema properties are invalid')
        }
        for (const propertySchema of Object.values(properties)) visit(propertySchema, depth + 1)
        continue
      }
      if (key === 'const' || key === 'default' || key === 'enum') {
        visitLiteral(item, depth + 1)
        continue
      }
      visit(item, depth + 1)
    }
  }
  visit(schema, 0)

  const assertNode = (value: unknown, path: string, depth: number): void => {
    if (depth > 8) throw new MemoryPluginProtocolError('memory plugin connection configSchema is too complex')
    const node = asObject(value)
    if (!node) throw new MemoryPluginProtocolError(`memory plugin connection configSchema ${path} is not an object`)
    const types = Array.isArray(node.type) ? node.type : [node.type]
    if (
      types.length === 0 ||
      types.length > CONFIG_SCHEMA_TYPES.size ||
      types.some((type) => typeof type !== 'string' || !CONFIG_SCHEMA_TYPES.has(type)) ||
      new Set(types).size !== types.length
    ) {
      throw new MemoryPluginProtocolError(`memory plugin connection configSchema ${path} has an invalid type`)
    }
    if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length === 0 || node.enum.length > 128)) {
      throw new MemoryPluginProtocolError(`memory plugin connection configSchema ${path} has an invalid enum`)
    }
    if (node.format !== undefined && (typeof node.format !== 'string' || !CONFIG_SCHEMA_FORMATS.has(node.format))) {
      throw new MemoryPluginProtocolError(`memory plugin connection configSchema ${path} uses an unsupported format`)
    }
    for (const keyword of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
      const item = node[keyword]
      if (item !== undefined && (typeof item !== 'number' || !Number.isFinite(item) || item < 0)) {
        throw new MemoryPluginProtocolError(`memory plugin connection configSchema ${path}.${keyword} is invalid`)
      }
    }
    for (const [min, max] of [
      ['minimum', 'maximum'],
      ['minLength', 'maxLength'],
      ['minItems', 'maxItems']
    ] as const) {
      if (typeof node[min] === 'number' && typeof node[max] === 'number' && node[min] > node[max]) {
        throw new MemoryPluginProtocolError(`memory plugin connection configSchema ${path} has inverted bounds`)
      }
    }
    const properties = node.properties === undefined ? undefined : asObject(node.properties)
    if (node.properties !== undefined && !properties) {
      throw new MemoryPluginProtocolError(`memory plugin connection configSchema ${path}.properties is invalid`)
    }
    if (node.required !== undefined) {
      if (
        !Array.isArray(node.required) ||
        node.required.some((name) => typeof name !== 'string') ||
        new Set(node.required).size !== node.required.length ||
        node.required.some((name) => !properties || !Object.hasOwn(properties, name))
      ) {
        throw new MemoryPluginProtocolError(`memory plugin connection configSchema ${path}.required is invalid`)
      }
    }
    if (
      node.additionalProperties !== undefined &&
      typeof node.additionalProperties !== 'boolean' &&
      !asObject(node.additionalProperties)
    ) {
      throw new MemoryPluginProtocolError(
        `memory plugin connection configSchema ${path}.additionalProperties is invalid`
      )
    }
    for (const [name, child] of Object.entries(properties ?? {})) assertNode(child, `${path}.${name}`, depth + 1)
    if (asObject(node.additionalProperties)) {
      assertNode(node.additionalProperties, `${path}.*`, depth + 1)
    }
    if (node.items !== undefined) assertNode(node.items, `${path}[]`, depth + 1)
  }
  assertNode(schema, '$', 0)
}

function configValueType(value: unknown): CanonicalJsonType {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  if (typeof value === 'object') return 'object'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'boolean') return 'boolean'
  throw new MemoryPluginProtocolError('memory plugin connection config is not JSON data')
}

function configJsonEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right)
}

/** Validate one connection's non-secret config against the reviewed manifest schema. */
export function assertMemoryConnectionConfig(config: Record<string, unknown>, schema: unknown): void {
  assertMemoryConnectionConfigSchema(schema)
  let nodes = 0
  const assertJson = (value: unknown, depth: number): void => {
    nodes++
    if (nodes > 2_048) throw new MemoryPluginProtocolError('memory plugin connection config has too many values')
    if (depth > 8) throw new MemoryPluginProtocolError('memory plugin connection config is too deeply nested')
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new MemoryPluginProtocolError('memory plugin connection config is invalid')
      return
    }
    if (typeof value !== 'object') {
      throw new MemoryPluginProtocolError('memory plugin connection config is not JSON data')
    }
    for (const item of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) {
      assertJson(item, depth + 1)
    }
  }
  assertJson(config, 0)
  let encoded: string
  try {
    encoded = JSON.stringify(config)
  } catch {
    throw new MemoryPluginProtocolError('memory plugin connection config is not JSON-serializable')
  }
  if (encoded === undefined || Buffer.byteLength(encoded) > MAX_CONNECTION_CONFIG_BYTES) {
    throw new MemoryPluginProtocolError('memory plugin connection config exceeds the byte limit')
  }
  if (Object.keys(config).length > MAX_CONNECTION_CONFIG_FIELDS) {
    throw new MemoryPluginProtocolError('memory plugin connection config has too many fields')
  }

  const validate = (value: unknown, schemaValue: unknown, path: string, depth: number): void => {
    if (depth > 8) throw new MemoryPluginProtocolError('memory plugin connection config is too deeply nested')
    const node = asObject(schemaValue)!
    const accepted = new Set(Array.isArray(node.type) ? node.type : [node.type])
    const actual = configValueType(value)
    if (!accepted.has(actual) && !(actual === 'integer' && accepted.has('number'))) {
      throw new MemoryPluginProtocolError(`memory plugin connection config ${path} has the wrong type`)
    }
    if (node.const !== undefined && !configJsonEqual(value, node.const)) {
      throw new MemoryPluginProtocolError(`memory plugin connection config ${path} does not match const`)
    }
    if (Array.isArray(node.enum) && !node.enum.some((item) => configJsonEqual(value, item))) {
      throw new MemoryPluginProtocolError(`memory plugin connection config ${path} is outside enum`)
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value))
        throw new MemoryPluginProtocolError(`memory plugin connection config ${path} is invalid`)
      if (typeof node.minimum === 'number' && value < node.minimum) {
        throw new MemoryPluginProtocolError(`memory plugin connection config ${path} is below minimum`)
      }
      if (typeof node.maximum === 'number' && value > node.maximum) {
        throw new MemoryPluginProtocolError(`memory plugin connection config ${path} exceeds maximum`)
      }
    }
    if (typeof value === 'string') {
      if (typeof node.minLength === 'number' && value.length < node.minLength) {
        throw new MemoryPluginProtocolError(`memory plugin connection config ${path} is too short`)
      }
      if (typeof node.maxLength === 'number' && value.length > node.maxLength) {
        throw new MemoryPluginProtocolError(`memory plugin connection config ${path} is too long`)
      }
      if (node.format === 'uri') {
        try {
          new URL(value)
        } catch {
          throw new MemoryPluginProtocolError(`memory plugin connection config ${path} is not a URI`)
        }
      }
      if (
        node.format === 'hostname' &&
        !/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(
          value
        )
      ) {
        throw new MemoryPluginProtocolError(`memory plugin connection config ${path} is not a hostname`)
      }
      if (
        node.format === 'uuid' &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
      ) {
        throw new MemoryPluginProtocolError(`memory plugin connection config ${path} is not a UUID`)
      }
    }
    if (Array.isArray(value)) {
      if (typeof node.minItems === 'number' && value.length < node.minItems) {
        throw new MemoryPluginProtocolError(`memory plugin connection config ${path} has too few items`)
      }
      if (typeof node.maxItems === 'number' && value.length > node.maxItems) {
        throw new MemoryPluginProtocolError(`memory plugin connection config ${path} has too many items`)
      }
      if (node.items !== undefined)
        value.forEach((item, index) => validate(item, node.items, `${path}[${index}]`, depth + 1))
    }
    const object = asObject(value)
    if (object) {
      const properties = asObject(node.properties) ?? {}
      for (const required of Array.isArray(node.required) ? node.required : []) {
        if (!Object.hasOwn(object, required as string)) {
          throw new MemoryPluginProtocolError(`memory plugin connection config ${path} is missing ${required}`)
        }
      }
      for (const [name, item] of Object.entries(object)) {
        if (Object.hasOwn(properties, name)) {
          validate(item, properties[name], `${path}.${name}`, depth + 1)
        } else if (node.additionalProperties === false) {
          throw new MemoryPluginProtocolError(`memory plugin connection config ${path} has unsupported field ${name}`)
        } else if (asObject(node.additionalProperties)) {
          validate(item, node.additionalProperties, `${path}.${name}`, depth + 1)
        }
      }
    }
  }
  validate(config, schema, '$', 0)
}

function assertSecretFieldContract(manifest: Manifest): void {
  const properties = asObject(manifest.connection.configSchema.properties) ?? {}
  const headers = new Set<string>()
  for (const field of manifest.connection.secretFields) {
    if (Object.hasOwn(properties, field.name)) {
      throw new MemoryPluginProtocolError(`memory plugin secret field ${field.name} also appears in non-secret config`)
    }
    if (!field.transportHeader) continue
    const header = field.transportHeader.toLowerCase()
    if (!HEADER_NAME.test(field.transportHeader) || RESERVED_INJECTED_HEADERS.has(header)) {
      throw new MemoryPluginProtocolError(`memory plugin secret field ${field.name} uses a reserved transport header`)
    }
    if (headers.has(header)) {
      throw new MemoryPluginProtocolError('memory plugin secret fields reuse a transport header')
    }
    headers.add(header)
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function memoryPluginManifestDigest(manifest: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(manifest)).digest('hex')}`
}

function assertRecordBoundary(
  record: MemoryRecord,
  context: CallContext,
  manifest: Manifest,
  expectedId?: string
): void {
  if (record.scope.kind !== context.scope.kind || record.scope.key !== context.scope.key) {
    throw new MemoryPluginProtocolError('memory plugin returned a record outside the trusted scope')
  }
  if (expectedId !== undefined && record.id !== expectedId) {
    throw new MemoryPluginProtocolError('memory plugin returned a record with the wrong id')
  }
  if (record.provenance && record.provenance.pluginId !== manifest.plugin.id) {
    throw new MemoryPluginProtocolError('memory plugin returned a record with forged provenance')
  }
  record.provenance ??= { pluginId: manifest.plugin.id }
  const bytes = Buffer.byteLength(JSON.stringify(record))
  if (bytes > manifest.limits.maxRecordBytes) {
    throw new MemoryPluginProtocolError('memory plugin returned an oversized record')
  }
  if (bytes > MAX_CANONICAL_RECORD_BYTES) {
    throw new MemoryPluginProtocolError('memory plugin record exceeds the core transport limit')
  }
}

function assertRecordCollection(
  records: MemoryRecord[],
  context: CallContext,
  manifest: Manifest,
  maxItems: number
): void {
  if (records.length > maxItems) {
    throw new MemoryPluginProtocolError('memory plugin returned too many records')
  }
  const ids = new Set<string>()
  for (const record of records) {
    assertRecordBoundary(record, context, manifest)
    if (ids.has(record.id)) throw new MemoryPluginProtocolError('memory plugin returned duplicate record ids')
    ids.add(record.id)
  }
  if (Buffer.byteLength(JSON.stringify(records)) > MAX_CANONICAL_COLLECTION_BYTES) {
    throw new MemoryPluginProtocolError('memory plugin record collection exceeds the core transport limit')
  }
}

function assertRecordWritePayload(
  input: { text: string; metadata?: Record<string, unknown> },
  manifest: Manifest
): void {
  const bytes = Buffer.byteLength(
    JSON.stringify({ text: input.text, ...(input.metadata === undefined ? {} : { metadata: input.metadata }) })
  )
  if (bytes > manifest.limits.maxRecordBytes) {
    throw new MemoryPluginInputError('memory record write exceeds the plugin manifest limit')
  }
  if (bytes > MAX_CANONICAL_RECORD_BYTES) {
    throw new MemoryPluginInputError('memory record write exceeds the core transport limit')
  }
}

function assertCaptureReceipt(receipt: CaptureReceipt, manifest: Manifest): void {
  if (receipt.state !== 'accepted') return
  if (!manifest.capabilities.asyncCapture) {
    throw new MemoryPluginProtocolError('memory plugin returned accepted without declaring async capture')
  }
  if (!receipt.backendOperationId) {
    throw new MemoryPluginProtocolError('memory plugin accepted capture without a backend operation id')
  }
}

function cappedFetch(base: McpFetch, maxBytes: number): McpFetch {
  return async (input, init) => {
    const response = await base(input, init)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel()
      throw new MemoryPluginProtocolError('memory plugin response exceeds the configured byte limit')
    }
    if (!response.body) return response
    let seen = 0
    const reader = response.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read()
          if (chunk.done) return controller.close()
          seen += chunk.value.byteLength
          if (seen > maxBytes) {
            await reader.cancel()
            return controller.error(
              new MemoryPluginProtocolError('memory plugin response exceeds the configured byte limit')
            )
          }
          controller.enqueue(chunk.value)
        } catch (error) {
          controller.error(error)
        }
      },
      cancel(reason) {
        return reader.cancel(reason)
      }
    })
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
  }
}

function structured(result: unknown, tool: string): unknown {
  const value = asObject(result)
  if (!value) throw new MemoryPluginProtocolError(`memory plugin tool ${tool} returned an invalid result`)
  if (value.isError === true) {
    const content = Array.isArray(value.content) ? value.content : []
    const item = content.length === 1 ? asObject(content[0]) : null
    if (item?.type === 'text' && item.text === MEMORY_PLUGIN_ERROR_TOKEN.conflict) {
      throw new MemoryPluginConflictError()
    }
    throw new MemoryPluginProtocolError(`memory plugin tool ${tool} returned an error result`)
  }
  if (!asObject(value.structuredContent)) {
    throw new MemoryPluginProtocolError(`memory plugin tool ${tool} must return structuredContent`)
  }
  return value.structuredContent
}

export class MemoryPluginClient {
  private readonly callTimeoutMs: number
  private readonly captureTimeoutMs: number
  private readonly maxConcurrent: number
  private active = 0
  private readonly waiters: ConcurrencyWaiter[] = []
  private closed = false
  private unexpectedCloseNotified = false
  private probeResult?: MemoryPluginProbe

  private constructor(
    private readonly client: Client,
    private readonly transport: Transport,
    private readonly options: MemoryPluginClientOptions
  ) {
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    this.captureTimeoutMs = options.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
    if (
      !Number.isFinite(this.callTimeoutMs) ||
      this.callTimeoutMs < 1 ||
      this.callTimeoutMs > MAX_TRANSPORT_TIMEOUT_MS
    ) {
      throw new MemoryPluginProtocolError('memory plugin callTimeoutMs is outside the supported range')
    }
    if (
      !Number.isFinite(this.captureTimeoutMs) ||
      this.captureTimeoutMs < 1 ||
      this.captureTimeoutMs > MAX_TRANSPORT_TIMEOUT_MS
    ) {
      throw new MemoryPluginProtocolError('memory plugin captureTimeoutMs is outside the supported range')
    }
    if (!Number.isInteger(this.maxConcurrent) || this.maxConcurrent < 1 || this.maxConcurrent > 64) {
      throw new MemoryPluginProtocolError('memory plugin maxConcurrent must be an integer between 1 and 64')
    }
  }

  static async connect(options: MemoryPluginClientOptions): Promise<MemoryPluginClient> {
    const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
    if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 16 * 1024 * 1024) {
      throw new MemoryPluginProtocolError('memory plugin maxResponseBytes is outside the supported range')
    }
    const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs < 1 || connectTimeoutMs > MAX_TRANSPORT_TIMEOUT_MS) {
      throw new MemoryPluginProtocolError('memory plugin connectTimeoutMs is outside the supported range')
    }
    let transport: Transport
    if (options.transport === 'stdio') {
      if (!options.command.trim()) throw new MemoryPluginProtocolError('stdio memory plugin command is empty')
      if ((options.args?.length ?? 0) > 128)
        throw new MemoryPluginProtocolError('stdio memory plugin has too many args')
      transport = new CappedStdioClientTransport({
        command: options.command,
        ...(options.args ? { args: options.args } : {}),
        ...(options.env ? { env: options.env } : {}),
        maxMessageBytes: maxResponseBytes
      })
    } else {
      const url = options.url instanceof URL ? options.url : new URL(options.url)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new MemoryPluginProtocolError('remote memory plugin URL must use http or https')
      }
      if (url.username || url.password) {
        throw new MemoryPluginProtocolError('remote memory plugin URL must not contain credentials')
      }
      const headers = new Headers()
      for (const header of options.headers ?? []) headers.set(header.name, header.value)
      const baseFetch = options.fetch ?? fetch
      transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers },
        fetch: cappedFetch(baseFetch, maxResponseBytes),
        reconnectionOptions: {
          initialReconnectionDelay: 100,
          maxReconnectionDelay: 1_000,
          reconnectionDelayGrowFactor: 2,
          maxRetries: 0
        }
      })
    }
    const client = new Client({ name: 'agentconnect-memory-core', version: '1.0.0' }, { capabilities: {} })
    const out = new MemoryPluginClient(client, transport, options)
    client.onclose = () => out.notifyUnexpectedClose()
    try {
      await client.connect(transport, { timeout: connectTimeoutMs })
      await out.probe()
      return out
    } catch (error) {
      await out.close().catch(() => undefined)
      const stdioProtocolError =
        error instanceof MemoryPluginStdioProtocolError
          ? error
          : transport instanceof CappedStdioClientTransport
            ? transport.protocolError
            : undefined
      if (stdioProtocolError) {
        throw new MemoryPluginProtocolError(stdioProtocolError.message)
      }
      throw error
    }
  }

  get manifest(): Manifest {
    if (!this.probeResult) throw new MemoryPluginProtocolError('memory plugin has not completed conformance probing')
    return this.probeResult.manifest
  }

  get manifestDigest(): string {
    if (!this.probeResult) throw new MemoryPluginProtocolError('memory plugin has not completed conformance probing')
    return this.probeResult.manifestDigest
  }

  hasTool(name: string): boolean {
    return this.probeResult?.tools.has(name) ?? false
  }

  async probe(): Promise<MemoryPluginProbe> {
    if (this.probeResult) return this.probeResult
    const deadline = Date.now() + this.callTimeoutMs
    const remainingMs = (): number => {
      const remaining = deadline - Date.now()
      if (remaining < 1) throw new MemoryPluginProtocolError('memory plugin conformance probe timed out')
      return remaining
    }
    const tools: Tool[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const timeout = remainingMs()
      const result = await this.client.listTools(cursor ? { cursor } : undefined, {
        timeout,
        maxTotalTimeout: timeout
      })
      tools.push(...result.tools)
      if (tools.length > MAX_LISTED_TOOLS) {
        throw new MemoryPluginProtocolError('memory plugin exposes too many MCP tools')
      }
      cursor = result.nextCursor
      if (!cursor) break
      if (page === MAX_LIST_PAGES - 1)
        throw new MemoryPluginProtocolError('memory plugin tools/list pagination did not converge')
    }
    const byName = new Map<string, Tool>()
    for (const tool of tools) {
      if (byName.has(tool.name)) throw new MemoryPluginProtocolError(`memory plugin lists duplicate tool ${tool.name}`)
      byName.set(tool.name, tool)
      if (REQUIRED_SCHEMA_KEYS[tool.name]) assertToolSchema(tool)
    }
    for (const required of [MEMORY_PLUGIN_TOOL.manifest, MEMORY_PLUGIN_TOOL.recall, MEMORY_PLUGIN_TOOL.capture]) {
      if (!byName.has(required))
        throw new MemoryPluginProtocolError(`memory plugin is missing required tool ${required}`)
    }

    let manifestResult: unknown
    try {
      const timeout = remainingMs()
      manifestResult = await this.client.callTool({ name: MEMORY_PLUGIN_TOOL.manifest, arguments: {} }, undefined, {
        timeout,
        maxTotalTimeout: timeout
      })
    } catch {
      // Do not surface a plugin-provided free-text error (it can contain an
      // upstream body/credential). The conformance failure itself is sufficient.
      throw new MemoryPluginProtocolError('memory plugin manifest failed structured output validation')
    }
    const rawManifest = structured(manifestResult, MEMORY_PLUGIN_TOOL.manifest)
    const manifest = MemoryPluginManifest.parse(rawManifest)
    if (manifest.limits.maxRecordBytes > MAX_CANONICAL_RECORD_BYTES) {
      throw new MemoryPluginProtocolError('memory plugin maxRecordBytes exceeds the core transport limit')
    }
    assertMemoryConnectionConfigSchema(manifest.connection.configSchema)
    assertSecretFieldContract(manifest)
    if (manifest.capabilities.scopes.length !== 1 || manifest.capabilities.scopes[0] !== 'agent') {
      throw new MemoryPluginProtocolError('memory plugin v1 supports only the agent scope')
    }
    for (const required of ['recall', 'capture'] as const) {
      if (!manifest.capabilities.operations.includes(required)) {
        throw new MemoryPluginProtocolError(`memory plugin manifest must declare ${required}`)
      }
    }
    for (const [operation, toolName] of Object.entries(OPTIONAL_OPERATION_TO_TOOL)) {
      const declared = manifest.capabilities.operations.includes(operation as keyof typeof OPTIONAL_OPERATION_TO_TOOL)
      if (declared !== byName.has(toolName)) {
        throw new MemoryPluginProtocolError(`memory plugin manifest/tool mismatch for ${operation}`)
      }
    }
    if (manifest.capabilities.asyncCapture !== byName.has(MEMORY_PLUGIN_TOOL.operationStatus)) {
      throw new MemoryPluginProtocolError('memory plugin asyncCapture/tool capability mismatch')
    }
    const expectedMajor = this.options.expectedProfileMajor ?? MEMORY_PLUGIN_PROFILE_MAJOR
    if (expectedMajor !== MEMORY_PLUGIN_PROFILE_MAJOR) {
      throw new MemoryPluginProtocolError(`memory plugin profile major ${expectedMajor} is unsupported`)
    }
    if (this.options.expectedPluginId && manifest.plugin.id !== this.options.expectedPluginId) {
      throw new MemoryPluginProtocolError('memory plugin id does not match the installation pin')
    }
    // Pin the complete wire manifest, including additive same-major fields this
    // core does not yet interpret. Stripping them before hashing would let an
    // installation's reviewed manifest change without invalidating its digest.
    const digest = memoryPluginManifestDigest(rawManifest)
    if (this.options.expectedManifestDigest && digest !== this.options.expectedManifestDigest) {
      throw new MemoryPluginManifestMismatchError()
    }
    this.probeResult = { manifest, manifestDigest: digest, tools: new Set(byName.keys()) }
    return this.probeResult
  }

  async recall(input: RecallInput, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<RecallOutput> {
    const req = MemoryPluginRecallInput.parse(input)
    const queryBytes = Buffer.byteLength(req.query)
    if (queryBytes > this.manifest.limits.maxQueryBytes) {
      throw new MemoryPluginInputError('memory recall query exceeds the plugin manifest limit')
    }
    const output = await this.callStructured(
      MEMORY_PLUGIN_TOOL.recall,
      req,
      MemoryPluginRecallOutput,
      options?.timeoutMs,
      options?.signal
    )
    const maxItems = Math.min(req.topK, this.manifest.limits.maxBatchItems)
    if (output.records.length > maxItems) {
      throw new MemoryPluginProtocolError('memory plugin recall returned too many records')
    }
    assertRecordCollection(output.records, req.context, this.manifest, maxItems)
    let textBytes = 0
    for (const record of output.records) {
      textBytes += Buffer.byteLength(record.text)
    }
    if (textBytes > req.maxBytes) {
      throw new MemoryPluginProtocolError('memory plugin recall exceeded the requested text budget')
    }
    return output
  }

  async capture(input: CaptureInput, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<CaptureReceipt> {
    const receipt = await this.callStructured(
      MEMORY_PLUGIN_TOOL.capture,
      MemoryPluginCaptureInput.parse(input),
      MemoryPluginCaptureOutput,
      options?.timeoutMs ?? this.captureTimeoutMs,
      options?.signal
    )
    assertCaptureReceipt(receipt, this.manifest)
    return receipt
  }

  health(input: HealthInput, options?: { timeoutMs?: number; signal?: AbortSignal }) {
    this.requireTool(MEMORY_PLUGIN_TOOL.health)
    return this.callStructured(
      MEMORY_PLUGIN_TOOL.health,
      MemoryPluginHealthInput.parse(input),
      MemoryPluginHealthOutput,
      options?.timeoutMs,
      options?.signal
    )
  }

  async operationStatus(input: OperationStatusInput, options?: { timeoutMs?: number; signal?: AbortSignal }) {
    this.requireTool(MEMORY_PLUGIN_TOOL.operationStatus)
    const receipt = await this.callStructured(
      MEMORY_PLUGIN_TOOL.operationStatus,
      MemoryPluginOperationStatusInput.parse(input),
      MemoryPluginOperationStatusOutput,
      options?.timeoutMs,
      options?.signal
    )
    assertCaptureReceipt(receipt, this.manifest)
    return receipt
  }

  async list(input: ListInput, options?: { timeoutMs?: number; signal?: AbortSignal }) {
    this.requireOperation('list')
    const req = MemoryPluginListInput.parse(input)
    const output = await this.callStructured(
      MEMORY_PLUGIN_TOOL.list,
      req,
      MemoryPluginListOutput,
      options?.timeoutMs,
      options?.signal
    )
    assertRecordCollection(
      output.records,
      req.context,
      this.manifest,
      Math.min(req.limit, this.manifest.limits.maxBatchItems)
    )
    return output
  }

  async get(input: GetInput, options?: { timeoutMs?: number; signal?: AbortSignal }) {
    this.requireOperation('get')
    const req = MemoryPluginGetInput.parse(input)
    const output = await this.callStructured(
      MEMORY_PLUGIN_TOOL.get,
      req,
      MemoryPluginGetOutput,
      options?.timeoutMs,
      options?.signal
    )
    if (output.record) assertRecordBoundary(output.record, req.context, this.manifest, req.id)
    return output
  }

  async create(input: CreateInput, options?: { timeoutMs?: number; signal?: AbortSignal }) {
    this.requireOperation('create')
    const req = MemoryPluginCreateInput.parse(input)
    assertRecordWritePayload(req, this.manifest)
    const output = await this.callStructured(
      MEMORY_PLUGIN_TOOL.create,
      req,
      MemoryPluginCreateOutput,
      options?.timeoutMs,
      options?.signal
    )
    assertRecordBoundary(output.record, req.context, this.manifest)
    return output
  }

  async update(input: UpdateInput, options?: { timeoutMs?: number; signal?: AbortSignal }) {
    this.requireOperation('update')
    const req = MemoryPluginUpdateInput.parse(input)
    assertRecordWritePayload(req, this.manifest)
    const output = await this.callStructured(
      MEMORY_PLUGIN_TOOL.update,
      req,
      MemoryPluginUpdateOutput,
      options?.timeoutMs,
      options?.signal
    )
    assertRecordBoundary(output.record, req.context, this.manifest, req.id)
    return output
  }

  delete(input: DeleteInput, options?: { timeoutMs?: number; signal?: AbortSignal }) {
    this.requireOperation('delete')
    return this.callStructured(
      MEMORY_PLUGIN_TOOL.delete,
      MemoryPluginDeleteInput.parse(input),
      MemoryPluginDeleteOutput,
      options?.timeoutMs,
      options?.signal
    )
  }

  async history(input: HistoryInput, options?: { timeoutMs?: number; signal?: AbortSignal }) {
    this.requireOperation('history')
    const req = MemoryPluginHistoryInput.parse(input)
    const output = await this.callStructured(
      MEMORY_PLUGIN_TOOL.history,
      req,
      MemoryPluginHistoryOutput,
      options?.timeoutMs,
      options?.signal
    )
    if (output.events.length > Math.min(req.limit, this.manifest.limits.maxBatchItems)) {
      throw new MemoryPluginProtocolError('memory plugin returned too many history events')
    }
    const eventIds = new Set<string>()
    for (const event of output.events) {
      if (eventIds.has(event.id))
        throw new MemoryPluginProtocolError('memory plugin returned duplicate history event ids')
      eventIds.add(event.id)
      if (event.record) assertRecordBoundary(event.record, req.context, this.manifest, req.id)
    }
    if (Buffer.byteLength(JSON.stringify(output.events)) > MAX_CANONICAL_COLLECTION_BYTES) {
      throw new MemoryPluginProtocolError('memory plugin history exceeds the core transport limit')
    }
    return output
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const error = new MemoryPluginProtocolError('memory plugin client is closed')
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
    await this.client.close()
  }

  private notifyUnexpectedClose(): void {
    if (this.closed || this.unexpectedCloseNotified) return
    this.unexpectedCloseNotified = true
    try {
      this.options.onUnexpectedClose?.()
    } catch {
      // Lifecycle notification must never turn a child exit into a daemon crash.
    }
  }

  private requireTool(name: string): void {
    if (!this.hasTool(name)) throw new MemoryPluginProtocolError(`memory plugin does not support ${name}`)
  }

  private requireOperation(operation: keyof typeof OPTIONAL_OPERATION_TO_TOOL): void {
    if (!this.manifest.capabilities.operations.includes(operation)) {
      throw new MemoryPluginProtocolError(`memory plugin does not support ${operation}`)
    }
  }

  private async callStructured<T extends z.ZodTypeAny>(
    tool: string,
    input: unknown,
    schema: T,
    timeoutMs = this.callTimeoutMs,
    signal?: AbortSignal
  ): Promise<z.output<T>> {
    this.requireTool(tool)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new MemoryPluginProtocolError('memory plugin call timeout must be positive')
    }
    const deadline = Date.now() + timeoutMs
    await this.acquire(signal, timeoutMs)
    try {
      const remainingMs = Math.max(1, deadline - Date.now())
      let result: unknown
      try {
        result = await this.client.callTool({ name: tool, arguments: input as Record<string, unknown> }, undefined, {
          timeout: remainingMs,
          maxTotalTimeout: remainingMs,
          ...(signal ? { signal } : {})
        })
      } catch (error) {
        if (error instanceof MemoryPluginProtocolError) throw error
        if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
          throw new MemoryPluginProtocolError(`memory plugin tool ${tool} was cancelled`)
        }
        // The MCP/remote error message is untrusted and may contain a record,
        // upstream response body, or credential. Never propagate it to logs/UI.
        throw new MemoryPluginProtocolError(`memory plugin tool ${tool} call failed`)
      }
      const payload = structured(result, tool)
      const parsed = schema.safeParse(payload)
      if (!parsed.success) {
        throw new MemoryPluginProtocolError(`memory plugin tool ${tool} failed structured output validation`)
      }
      return parsed.data
    } finally {
      this.release()
    }
  }

  private async acquire(signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
    if (this.closed) throw new MemoryPluginProtocolError('memory plugin client is closed')
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new MemoryPluginProtocolError('memory plugin call cancelled')
    }
    if (this.active < this.maxConcurrent) {
      this.active++
      return
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        waiter.reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new MemoryPluginProtocolError('memory plugin call cancelled')
        )
      }
      const cleanup = (): void => {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      let settled = false
      const waiter: ConcurrencyWaiter = {
        grant: () => {
          if (settled) return
          settled = true
          cleanup()
          // Reserve the released slot synchronously so a second caller cannot
          // bypass this queued operation before its promise continuation runs.
          this.active++
          resolve()
        },
        reject: (error) => {
          if (settled) return
          settled = true
          cleanup()
          reject(error)
        }
      }
      this.waiters.push(waiter)
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        waiter.reject(new MemoryPluginProtocolError('memory plugin call timed out before dispatch'))
      }, timeoutMs)
      timer.unref?.()
      signal?.addEventListener('abort', onAbort, { once: true })
      // Close the tiny race between the pre-enqueue check and listener install.
      if (signal?.aborted) onAbort()
    })
  }

  private release(): void {
    this.active--
    this.waiters.shift()?.grant()
  }
}
