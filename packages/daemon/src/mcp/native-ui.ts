import { NativeMcpUi } from '@agentconnect.md/protocol/mcp-app'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

// Interpret a completed tool result as presentation data, never as authorization or executable UI.
export function nativeUiFromToolUpdate(update: unknown): NativeMcpUi | undefined {
  const event = record(update)
  if (!event || !['tool_call', 'tool_call_update'].includes(String(event.sessionUpdate))) return undefined
  if (event.status !== 'completed') return undefined
  // Claude emits raw text/content blocks; Codex emits a CallToolResult envelope.
  const output = record(event.rawOutput) ?? { content: event.rawOutput }
  if (output.error) return undefined
  const result = record(output.result) ?? output
  if (result.isError === true) return undefined
  const structured = NativeMcpUi.safeParse(result.structuredContent)
  if (structured.success) return structured.data
  const content = typeof result.content === 'string' ? [{ type: 'text', text: result.content }] : result.content
  if (!Array.isArray(content)) return undefined
  for (const value of content) {
    const block = record(value)
    if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length > 4096) continue
    try {
      const parsed = NativeMcpUi.safeParse(JSON.parse(block.text))
      if (parsed.success) return parsed.data
    } catch {
      // Ordinary tool text is not a UI intent.
    }
  }
  return undefined
}
