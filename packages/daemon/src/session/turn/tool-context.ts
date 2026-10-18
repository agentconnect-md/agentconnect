import { createHash } from 'node:crypto'
import type { McpServer } from '@agentclientprotocol/sdk'
import type { ToolDescriptor } from '../../tool-schema/descriptor.js'

export interface SessionToolContext {
  fingerprint: string
  instructions?: string
  // Credentials and executable resolution happen only when attaching to a runtime.
  mcpServers: () => McpServer[]
}

// Compare model-visible content, never connection tokens, clocks, or daemon generations.
export function toolContextFingerprint(
  tools: readonly ToolDescriptor[],
  servers: readonly McpServer[],
  instructions?: string
): string {
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
  const content = { tools: [...tools].sort(byName), servers: [...servers].sort(byName), instructions }
  const serialized = JSON.stringify(content, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value
  )
  return createHash('sha256').update(serialized).digest('hex')
}
