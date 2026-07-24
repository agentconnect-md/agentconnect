/**
 * Pure projection helpers for the external-memory connection data plane.
 * Remote upstream endpoint + secret values go only to the relay. Local stdio
 * specs carry only an operator allowlist key plus a daemon-private
 * secret lease; the control plane never accepts a command, path, or arguments.
 */
import type { MemoryConnectionSpec, RcMemoryConnectionAssign } from '@agentconnect.md/protocol'
import type {
  ExternalMemoryConnectionRecord,
  MemoryPluginInstallationRecord,
  MemoryPluginSecretHeader
} from '../persistence/ports.js'
import { grantKeyHash } from './mcpProvider.js'

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const MAX_SECRET_BYTES = 64 * 1024
const RESERVED_PROXY_HEADERS = new Set([
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

export function validateMemorySecretHeaders(headers: MemoryPluginSecretHeader[]): string | null {
  const names = new Set<string>()
  const transportHeaders = new Set<string>()
  for (const field of headers) {
    if (!field.name || field.name.length > 128) return 'secret field name is invalid'
    if (names.has(field.name)) return `duplicate secret field: ${field.name}`
    names.add(field.name)
    const header = field.header.toLowerCase()
    if (!HEADER_NAME.test(field.header) || RESERVED_PROXY_HEADERS.has(header)) {
      return `secret field ${field.name} uses an unsupported transport header`
    }
    if (transportHeaders.has(header)) return `duplicate secret transport header: ${field.header}`
    transportHeaders.add(header)
  }
  return null
}

export function validateMemorySecrets(
  headers: MemoryPluginSecretHeader[],
  values: Record<string, string>
): string | null {
  const known = new Set(headers.map((field) => field.name))
  const unknown = Object.keys(values).filter((name) => !known.has(name))
  if (unknown.length) return `unknown secret field(s): ${unknown.join(', ')}`
  const missing = headers.filter((field) => field.required && !values[field.name]).map((field) => field.name)
  if (missing.length) return `missing required secret field(s): ${missing.join(', ')}`
  const invalidHeaderValue = Object.entries(values).find(([, value]) => /[\u0000-\u001f\u007f]/.test(value))
  if (invalidHeaderValue) return `secret field ${invalidHeaderValue[0]} contains unsupported control characters`
  const secretBytes = Buffer.byteLength(JSON.stringify(values))
  if (secretBytes > MAX_SECRET_BYTES) return 'connection secret set exceeds 64 KiB'
  return null
}

export function memoryRcAssign(
  connection: ExternalMemoryConnectionRecord,
  installation: MemoryPluginInstallationRecord,
  secrets: Record<string, string>,
  grantKeys: string[]
): RcMemoryConnectionAssign {
  if (!installation.endpoint) throw new Error('remote memory plugin installation has no endpoint')
  const error = validateMemorySecrets(installation.secretHeaders, secrets)
  if (error) throw new Error(error)
  return {
    connectionId: connection.id,
    revision: connection.revision,
    upstreamUrl: installation.endpoint,
    headers: installation.secretHeaders.flatMap((field) => {
      const value = secrets[field.name]
      return value === undefined ? [] : [{ name: field.header, value }]
    }),
    grantKeyHashes: grantKeys.map(grantKeyHash)
  }
}

export function memoryRelayUrl(relayBaseUrl: string, connectionId: string): string {
  return `${relayBaseUrl.replace(/\/$/, '')}/memory/${connectionId}`
}

export function memoryConnectionSpec(
  connection: ExternalMemoryConnectionRecord,
  installation: MemoryPluginInstallationRecord,
  secretKeys: string[],
  grantKey: string,
  relayBaseUrl: string
): MemoryConnectionSpec {
  if (installation.transport !== 'streamable-http') {
    throw new Error('remote memory connection spec requires a Streamable HTTP installation')
  }
  return {
    connectionId: connection.id,
    revision: connection.revision,
    transport: 'streamable-http',
    relayUrl: memoryRelayUrl(relayBaseUrl, connection.id),
    grantKey,
    config: connection.config,
    secretKeys,
    pin: {
      pluginId: installation.pluginId,
      profileMajor: 1,
      ...(installation.expectedManifestDigest ? { manifestDigest: installation.expectedManifestDigest } : {}),
      secretHeaders: installation.secretHeaders
    }
  }
}

export function stdioMemoryConnectionSpec(
  connection: ExternalMemoryConnectionRecord,
  installation: MemoryPluginInstallationRecord,
  secrets: Record<string, string>
): MemoryConnectionSpec {
  if (installation.transport !== 'stdio' || !installation.commandRef) {
    throw new Error('stdio memory connection spec requires an operator command reference')
  }
  return {
    connectionId: connection.id,
    revision: connection.revision,
    transport: 'stdio',
    commandRef: installation.commandRef,
    config: connection.config,
    secretKeys: Object.keys(secrets).sort(),
    secretLease: { values: secrets },
    pin: {
      pluginId: installation.pluginId,
      profileMajor: 1,
      ...(installation.expectedManifestDigest ? { manifestDigest: installation.expectedManifestDigest } : {}),
      secretHeaders: installation.secretHeaders
    }
  }
}

export function boundedMemoryConfig(config: Record<string, unknown>): string | null {
  let nodes = 0
  const visit = (value: unknown, depth: number): string | null => {
    nodes++
    if (nodes > 2_048) return 'connection config has too many values'
    if (depth > 8) return 'connection config is too deeply nested'
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return null
    if (typeof value === 'number') return Number.isFinite(value) ? null : 'connection config contains an invalid number'
    if (typeof value !== 'object') return 'connection config must contain only JSON data'
    const values = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)
    for (const item of values) {
      const error = visit(item, depth + 1)
      if (error) return error
    }
    return null
  }
  const structureError = visit(config, 0)
  if (structureError) return structureError
  let encoded: string
  try {
    encoded = JSON.stringify(config)
  } catch {
    return 'connection config must be JSON-serializable'
  }
  if (encoded === undefined || Buffer.byteLength(encoded) > 64 * 1024) return 'connection config exceeds 64 KiB'
  if (Object.keys(config).length > 128) return 'connection config has too many fields'
  return null
}
