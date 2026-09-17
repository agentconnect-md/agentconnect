import {
  AGENT_SETUP_URI,
  AGENT_TOOLS_URI,
  CODE_HOST_SETUP_URI,
  MCP_SETUP_URI,
  NativeMcpUi,
  SKILL_SETUP_URI,
  nativeUiTitle
} from '@agentconnect.md/protocol/mcp-app'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** An intent either IS the value or rides beside a write tool's own answer under `nativeUi`. */
function intentIn(value: unknown): NativeMcpUi | undefined {
  const direct = NativeMcpUi.safeParse(value)
  if (direct.success) return direct.data
  const beside = NativeMcpUi.safeParse(record(value)?.nativeUi)
  return beside.success ? beside.data : undefined
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
  const structured = intentIn(result.structuredContent)
  if (structured) return structured
  const content = typeof result.content === 'string' ? [{ type: 'text', text: result.content }] : result.content
  if (!Array.isArray(content)) return undefined
  for (const value of content) {
    const block = record(value)
    if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length > 4096) continue
    try {
      const parsed = intentIn(JSON.parse(block.text))
      if (parsed) return parsed
    } catch {
      // Ordinary tool text is not a UI intent.
    }
  }
  return undefined
}

/** Which tool an intent came from — the resource names the surface, so neither is guessed from arguments. */
function toolFor(nativeUi: NativeMcpUi): string {
  switch (nativeUi.resourceUri) {
    case CODE_HOST_SETUP_URI:
      return 'manageCodeHosts'
    case AGENT_SETUP_URI:
      return nativeUi.intent.created ? 'createAgent' : 'configureAgent'
    case SKILL_SETUP_URI:
      return 'installSkill'
    case MCP_SETUP_URI:
      return 'installMcpServer'
    case AGENT_TOOLS_URI:
      return 'manageAgentTools'
    default:
      return 'configureIntegration'
  }
}

/** The card chrome one intent earns; the heading is the shared one, so the Console card cannot word it differently. */
export function nativeUiChrome(nativeUi: NativeMcpUi): { title: string; toolName: string } {
  return { title: nativeUiTitle(nativeUi), toolName: toolFor(nativeUi) }
}
