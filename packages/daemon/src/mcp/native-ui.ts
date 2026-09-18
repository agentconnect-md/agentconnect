import { MCP_APP_CARD_MAX_BYTES } from '@agentconnect.md/protocol'
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

/** A write tool's card rides beside its own full record, so one candidate is capped at the card's budget, not a line. */
const INTENT_TEXT_MAX_CHARS = MCP_APP_CARD_MAX_BYTES

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
  // Claude emits raw text/content blocks; Codex emits a CallToolResult envelope; dsh flattens both to `output`.
  const output = record(event.rawOutput) ?? { content: event.rawOutput }
  if (output.error) return undefined
  const result = record(output.result) ?? output
  if (result.isError === true) return undefined
  const structured = intentIn(result.structuredContent)
  if (structured) return structured
  // ACP SPECIFIES `content` and leaves `rawOutput` an unknown passthrough, so the specified channel is read first.
  const spoken = intentInBlocks(event.content)
  if (spoken) return spoken
  // Then the passthrough, in the spellings the adapters have shipped: a bare block list, or one flattened string.
  const flattened = typeof result.content === 'string' ? result.content : result.output
  return intentInBlocks(typeof flattened === 'string' ? [{ type: 'text', text: flattened }] : result.content)
}

/** The text of one block in either spelling: ACP's wrapped `ToolCallContent`, or a bare content block. */
function blockText(value: unknown): string | undefined {
  const block = record(value)
  const wrapped = block?.type === 'content' ? record(block.content) : undefined
  const text = wrapped?.type === 'text' ? wrapped.text : block?.type === 'text' ? block.text : undefined
  return typeof text === 'string' ? text : undefined
}

/** The first block whose text parses into an intent. Anything else is ordinary tool output. */
function intentInBlocks(blocks: unknown): NativeMcpUi | undefined {
  if (!Array.isArray(blocks)) return undefined
  for (const value of blocks) {
    const text = blockText(value)
    if (text === undefined || text.length > INTENT_TEXT_MAX_CHARS) continue
    try {
      const parsed = intentIn(JSON.parse(text))
      if (parsed) return parsed
    } catch {
      // Ordinary tool text is not a UI intent.
    }
  }
  return undefined
}

/** Every native surface's resource id shares this prefix, so one marker recognizes a payload that meant to carry one. */
const NATIVE_UI_URI_PREFIX = 'ui://agentconnect/'

/**
 * Did this result MEAN to open a surface? Read only to explain a miss: a payload that names a native
 * resource and still yields no intent is the one failure the projection would otherwise drop in silence.
 */
export function namesNativeUi(update: unknown): boolean {
  const event = record(update)
  if (!event) return false
  const output = record(event.rawOutput) ?? { content: event.rawOutput }
  const result = record(output.result) ?? output
  const structured = record(result.structuredContent)
  const declared = structured?.resourceUri ?? record(structured?.nativeUi)?.resourceUri
  if (typeof declared === 'string' && declared.startsWith(NATIVE_UI_URI_PREFIX)) return true
  // The same candidates the reader itself looks at — never a stringify of a result that can hold a whole file.
  const texts = [
    ...(Array.isArray(event.content) ? event.content.map(blockText) : []),
    ...(Array.isArray(result.content) ? result.content.map(blockText) : []),
    typeof result.content === 'string' ? result.content : undefined,
    typeof result.output === 'string' ? result.output : undefined
  ]
  return texts.some((text) => typeof text === 'string' && declaresSurface(text))
}

/**
 * Does this text DECLARE a surface, rather than merely mention one? A tool that read
 * `mcp-app.ts` or a design doc reports a `ui://` string through the very same candidates, and a
 * warning that fired on it would be noise. The substring is only the cheap gate on the parse.
 */
function declaresSurface(text: string): boolean {
  if (!text.includes(NATIVE_UI_URI_PREFIX)) return false
  try {
    const value = record(JSON.parse(text))
    const uri = value?.resourceUri ?? record(value?.nativeUi)?.resourceUri
    return typeof uri === 'string' && uri.startsWith(NATIVE_UI_URI_PREFIX)
  } catch {
    return false
  }
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
