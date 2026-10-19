import { createHash } from 'node:crypto'
import type { McpServer } from '@agentclientprotocol/sdk'
import type { ToolDescriptor } from '../../tool-schema/descriptor.js'

export interface SessionToolContext {
  fingerprint: string
  instructions?: string
  // The daemon tools this context offers, as the bridge lists them.
  tools?: readonly ToolDescriptor[]
  // Credentials and executable resolution happen only when attaching to a runtime.
  mcpServers: () => McpServer[]
}

// JSON with object keys sorted, so equal content serializes equally.
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
      : inner
  )
}

// Compare model-visible content, never connection tokens, clocks, or daemon generations.
export function toolContextFingerprint(
  tools: readonly ToolDescriptor[],
  servers: readonly McpServer[],
  instructions?: string
): string {
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
  const content = { tools: [...tools].sort(byName), servers: [...servers].sort(byName), instructions }
  return createHash('sha256').update(canonicalJson(content)).digest('hex')
}

// One digest per tool over what its model reads, as a JSON object keyed by tool name.
export function toolDigests(tools: readonly ToolDescriptor[]): string {
  const digest = (tool: ToolDescriptor) =>
    createHash('sha256')
      .update(canonicalJson({ description: tool.description, inputSchema: tool.inputSchema }))
      .digest('hex')
      .slice(0, 16)
  return canonicalJson(Object.fromEntries(tools.map((tool) => [tool.name, digest(tool)])))
}

function parseDigests(json: string | null | undefined): Record<string, string> | undefined {
  if (!json) return undefined
  try {
    const parsed: unknown = JSON.parse(json)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : undefined
  } catch {
    return undefined
  }
}

// A runtime may keep the definitions a session started with across a reload, so the changed ones are restated in the conversation.
export function toolDefinitionsBlock(
  held: string | null | undefined,
  tools: readonly ToolDescriptor[]
): string | undefined {
  const before = parseDigests(held)
  const now = parseDigests(toolDigests(tools))!
  const changed = before ? tools.filter((tool) => before[tool.name] !== now[tool.name]) : [...tools]
  const removed = before ? Object.keys(before).filter((name) => !(name in now)) : []
  if (changed.length === 0 && removed.length === 0) return undefined
  const heading = before
    ? '[Tool definitions updated] Some of your AgentConnect tools changed since this session began. These current definitions replace the earlier ones you were given; where they differ, follow these.'
    : '[Tool definitions updated] This session may hold earlier definitions of your AgentConnect tools. These are the current ones and replace any given earlier; where they differ, follow these.'
  const lines = [heading]
  if (changed.length > 0) {
    const definitions = changed.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
    lines.push('', '```json', JSON.stringify(definitions), '```')
  }
  if (removed.length > 0) lines.push('', `No longer available: ${removed.join(', ')}.`)
  return lines.join('\n')
}
