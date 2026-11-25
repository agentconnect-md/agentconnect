// A restricted MCP grant's route through the proxy (mcp-tool-permissions.md §7.2): its origin, and the judgment of each POST, ported from the relay's §6.2 check.
import type { McpToolDecisions } from '@agentconnect.md/protocol'
import type { McpGrantRouteOutcome } from '../acp/spawn-driver.js'
import type { ApprovalSource } from '../mcp/approval-records.js'

/** The header that tells the relay who approved a gated call; the proxy drops any a client sent. */
export const TOOL_APPROVAL_HEADER = 'x-ac-tool-approval'

/** The largest POST the proxy judges, the relay's own limit. */
export const MCP_GRANT_BODY_LIMIT = 4 * 1024 * 1024

/** Concurrent GET streams one session may hold open on one grant. */
export const MCP_GRANT_STREAMS_PER_SESSION = 4

/** One `daemon`-custody grant an agent's sessions reach the relay with. Carries the key — never log. */
export interface McpGrantRoute {
  /** The definition's name, which the placeholder is sealed for. */
  provider: string
  /** The relay endpoint, `https://<relay>/mcp/<providerId>`. */
  url: string
  key: string
  decisions: McpToolDecisions
}

/** A grant route's host name, port and path; undefined for anything but HTTPS, whose placeholder could never be exchanged. */
export function mcpGrantOrigin(url: string): { hostname: string; port: number; path: string } | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:') return undefined
  return {
    hostname: parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1'),
    port: parsed.port ? Number(parsed.port) : 443,
    path: parsed.pathname
  }
}

/** The bearer key a CP definition presents to the relay; undefined when it carries none. */
export function grantKeyOf(headers: readonly { name: string; value: string }[]): string | undefined {
  const value = headers.find((header) => header.name.toLowerCase() === 'authorization')?.value.trim()
  const match = value?.match(/^bearer\s+(\S+)$/i)
  return match?.[1]
}

type Decision = 'allow' | 'approval' | 'ask' | 'block'

/** A tool's decision: a name in none of the lists is Blocked. */
export function toolDecision(decisions: McpToolDecisions, name: string): Decision {
  if (decisions.allow.includes(name)) return 'allow'
  if (decisions.ask.includes(name)) return 'ask'
  if (decisions.approval.includes(name)) return 'approval'
  return 'block'
}

/** What an approval-gated call is judged by: its id, name, arguments and decision. */
export interface GatedCall {
  toolCallId: string | undefined
  name: string
  arguments: unknown
  decision: 'approval' | 'ask'
}

/** What to do with one POST: forward the re-serialized message with an approval, or answer it here. */
export type McpGrantJudgment =
  | { kind: 'forward'; body: string; approval?: ApprovalSource; refused: [] }
  | { kind: 'respond'; status: number; json?: unknown; refused: string[] }

type Message = Record<string, unknown>
type Refusal = { name: string; reason: 'blocked' | 'unapproved' }

const isMessage = (value: unknown): value is Message =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasId = (message: Message): boolean => 'id' in message && message.id !== undefined

function rpcError(id: unknown, code: number, message: string): Message {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function refusalResult({ name, reason }: Refusal): Message {
  const text =
    reason === 'blocked'
      ? `The tool "${name}" is blocked for this agent.`
      : `The tool "${name}" requires approval, and this call was not approved.`
  return { content: [{ type: 'text', text }], isError: true }
}

/** The ACP tool call id a runtime puts in `params._meta`: Claude's `claudecode/toolUseId`, Codex's `callId`. */
export function callIdOf(params: Message): string | undefined {
  const meta = isMessage(params._meta) ? params._meta : undefined
  const id = meta?.['claudecode/toolUseId'] ?? meta?.callId
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** Judge one POST body: Blocked calls refused, a single gated call forwarded only with an approval, and the parse forwarded rather than the bytes. */
export async function judgeMcpGrantPost(
  body: string,
  decisions: McpToolDecisions,
  approve: (call: GatedCall) => Promise<ApprovalSource | undefined>
): Promise<McpGrantJudgment> {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { kind: 'respond', status: 400, json: rpcError(null, -32700, 'parse error'), refused: [] }
  }
  const batch = Array.isArray(parsed)
  const messages = batch ? (parsed as unknown[]) : [parsed]
  if (messages.length === 0 || !messages.every(isMessage)) {
    return { kind: 'respond', status: 400, json: rpcError(null, -32600, 'invalid request'), refused: [] }
  }
  let approval: ApprovalSource | undefined
  const refusals: (Refusal | undefined)[] = []
  for (const message of messages as Message[]) {
    if (message.method !== 'tools/call') {
      refusals.push(undefined)
      continue
    }
    const params = isMessage(message.params) ? message.params : {}
    const name = params.name
    if (typeof name !== 'string') {
      refusals.push({ name: '(unnamed)', reason: 'blocked' })
      continue
    }
    const decision = toolDecision(decisions, name)
    if (decision === 'allow') refusals.push(undefined)
    else if (decision === 'block') refusals.push({ name, reason: 'blocked' })
    // One approval header cannot vouch for several calls, so a batch member is judged as if none were recorded.
    else if (batch) refusals.push({ name, reason: 'unapproved' })
    else {
      approval = await approve({ toolCallId: callIdOf(params), name, arguments: params.arguments, decision })
      refusals.push(approval ? undefined : { name, reason: 'unapproved' })
    }
  }
  const refused = refusals.filter((r): r is Refusal => r !== undefined).map((r) => r.name)
  if (refused.length > 0) {
    const answers = (messages as Message[]).flatMap((message, i) => {
      if (!hasId(message)) return []
      const r = refusals[i]
      if (r !== undefined) return [{ jsonrpc: '2.0', id: message.id, result: refusalResult(r) }]
      return [rpcError(message.id, -32600, 'batch rejected: it contains a tool call refused for this agent')]
    })
    if (answers.length === 0) return { kind: 'respond', status: 202, refused }
    return { kind: 'respond', status: 200, json: batch ? answers : answers[0], refused }
  }
  return { kind: 'forward', body: JSON.stringify(parsed), ...(approval ? { approval } : {}), refused: [] }
}

/** Where a session's runtime runs, for the shim checks below. */
interface GrantSession {
  strategy: string
  k8s?: boolean
  placed?: { strategy: string; executorDaemonId: string }
}

/** The shim a session reaches the proxy's mcp-grant route through, as a warning names it; undefined for a host or srt session here, which reaches the proxy itself. */
export function mcpGrantShimOf(session: GrantSession): string | undefined {
  if (session.placed) return `the ${session.placed.strategy} shim of daemon ${session.placed.executorDaemonId}`
  if (session.k8s) return "its sandbox pod's shim"
  return session.strategy === 'microsandbox' ? "its VM's shim" : undefined
}

/** Why a session can never reach the mcp-grant route: an srt boundary on an executor routes only code hosts to its shim (§8); every other shim is asked at spawn. */
export function mcpGrantShimRefusal(session: GrantSession): string | undefined {
  if (!session.placed || ['host', 'microsandbox'].includes(session.placed.strategy)) return undefined
  return `${mcpGrantShimOf(session)} does not carry the mcp-grant route for a session there`
}

/** Why a shim-routed launch has no relay route once its shim answered; undefined when it has one (§8). */
export function mcpGrantRouteRefusal(shim: string, outcome: McpGrantRouteOutcome): string | undefined {
  if (outcome === 'routed') return undefined
  return outcome === 'unserved'
    ? `${shim} does not carry the mcp-grant route; upgrade that shim to use this provider`
    : `its runtime names its own HTTPS proxy, which would bypass ${shim}`
}

/** A definition's headers with the placeholder in place of its grant key; undefined when the key sits anywhere else. */
export function placeholderHeaders(
  headers: readonly { name: string; value: string }[],
  key: string,
  placeholder: string
): { name: string; value: string }[] | undefined {
  const swapped = headers.map((header) =>
    header.name.toLowerCase() === 'authorization' ? { name: header.name, value: `Bearer ${placeholder}` } : header
  )
  return swapped.some((header) => header.value.includes(key)) ? undefined : swapped
}
