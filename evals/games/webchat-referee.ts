/**
 * The scripted-subject seam for webchat scenarios: a deterministic BRAIN acting
 * through the REAL tool surface.
 *
 * The point of the webchat leg (night-collection + webchat Werewolf) is that
 * the referee is an ordinary subject agent — its calls are `sendMessage`
 * (`toAgent`+`needsReply`, `sessionId` replies) through the daemon's MCP
 * control socket, never the trusted `deliverRefereeEvent` control path the
 * Slack-shaped games use. Eval composition == live composition, except the
 * referee's brain is deterministic.
 *
 * One brain drives BOTH subject kinds:
 *  - scripted CI: an in-process ACP host (`brainHostEntry`) wraps the brain;
 *  - real runs: the puppet ACP adapter (`puppet-acp-agent.mjs`) forwards each
 *    prompt to the driver (`puppet.ts`), which runs the same brain and makes
 *    the same control-socket calls.
 */
import { callDaemonTool, daemonMcpBinding, type DaemonMcpBinding } from './mcp-client.js'

/** One product tool call the brain wants executed from its CURRENT session. */
export interface BrainCall {
  tool: string
  args: Record<string, unknown>
}

export interface BrainCallOutcome extends BrainCall {
  ok: boolean
  /** The tool result (JSON text payload, parsed when possible). */
  result?: unknown
  error?: string
}

/** What one prompt produced: tool calls to execute (in order, awaited), then a
 *  single reply chunk. Reply `AC_NO_RESPONSE` to stay silent. */
export interface BrainTurn {
  calls: BrainCall[]
  reply: string
}

/** A deterministic scripted subject: pure decision over (prompt text, own
 *  state). Implementations keep their own state — one brain instance per run. */
export interface ScriptedBrain {
  onPrompt(text: string): BrainTurn
  /** Called with each executed call's outcome, in order. */
  onCallResult?(outcome: BrainCallOutcome): void
}

export type CallTool = (
  binding: DaemonMcpBinding,
  tool: string,
  args: Record<string, unknown>
) => Promise<{ ok: boolean; result?: unknown; error?: string }>

/** Execute one brain turn against a session's captured control-socket binding. */
export async function executeBrainTurn(
  brain: ScriptedBrain,
  binding: DaemonMcpBinding | undefined,
  text: string,
  callTool: CallTool = callDaemonTool
): Promise<{ reply: string; outcomes: BrainCallOutcome[] }> {
  const turn = brain.onPrompt(text)
  const outcomes: BrainCallOutcome[] = []
  for (const call of turn.calls) {
    if (!binding) {
      const outcome: BrainCallOutcome = { ...call, ok: false, error: 'session has no daemon tool binding' }
      outcomes.push(outcome)
      brain.onCallResult?.(outcome)
      continue
    }
    const result = await callTool(binding, call.tool, call.args)
    const outcome: BrainCallOutcome = {
      ...call,
      ok: result.ok,
      ...(result.result !== undefined ? { result: result.result } : {}),
      ...(result.error !== undefined ? { error: result.error } : {})
    }
    outcomes.push(outcome)
    brain.onCallResult?.(outcome)
  }
  return { reply: turn.reply, outcomes }
}

/** Parse the parent-session reply target out of a needsReply child's prompt
 *  (the standing report-back directive carries the exact JSON to send). */
export function parentSessionIdOf(text: string): string | undefined {
  const meta = /^- Parent session: (\S+)$/m.exec(text)
  if (meta) return meta[1]
  // The standing collaboration guidance carries a PLACEHOLDER example
  // (`{"sessionId":"<Parent session>", …}`); only the report-back directive
  // carries the real id. Skip placeholder-shaped values.
  for (const match of text.matchAll(/"sessionId":"([^"]+)"/g)) {
    if (!match[1]!.startsWith('<')) return match[1]
  }
  return undefined
}

/** Prompt log entry recorded by the in-process hosts: which agent, which ACP
 *  session, and the full prompt text of one `session/prompt` call (a turn may
 *  log several — one per regeneration). */
export interface PromptLogEntry {
  agentId: string
  sessionId: string
  text: string
}

export interface InProcessHost {
  factory: (agent: { id: string; name?: string }, onUpdate: (sessionId: string, update: unknown) => void) => unknown
}

export type ScriptedSessionHandler = (input: {
  agentId: string
  sessionId: string
  text: string
  binding: DaemonMcpBinding | undefined
  chunk: (text: string) => void
}) => Promise<string | undefined> | string | undefined

/**
 * Build a per-agent in-process ACP host from a session handler. The handler
 * returns the reply text (or undefined ⇒ AC_NO_RESPONSE) and may await real
 * control-socket calls; every prompt is appended to `log` first.
 */
export function scriptedWebchatHostFactory(
  handlers: Map<string, ScriptedSessionHandler>,
  log: PromptLogEntry[]
): NonNullable<InProcessHost['factory']> {
  return (agent, onUpdate) => {
    let sessions = 0
    const bindings = new Map<string, DaemonMcpBinding>()
    const handler = handlers.get(agent.id)
    return {
      start: async () => {},
      newSession: async (_cwd: string, mcpServers?: unknown) => {
        const sessionId = `scripted-${agent.id.slice(0, 8)}-${(sessions += 1)}`
        const binding = daemonMcpBinding(mcpServers)
        if (binding) bindings.set(sessionId, binding)
        return sessionId
      },
      hasSession: () => true,
      modelOptions: () => ({ current: 'scripted-webchat', models: ['scripted-webchat'] }),
      prompt: async (sessionId: string, blocks: { text?: string }[]) => {
        const text = blocks.map((block) => block.text ?? '').join('\n')
        log.push({ agentId: agent.id, sessionId, text })
        const chunk = (value: string) =>
          onUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } })
        let reply: string | undefined
        if (handler) {
          reply = await handler({ agentId: agent.id, sessionId, text, binding: bindings.get(sessionId), chunk })
        }
        chunk(reply ?? 'AC_NO_RESPONSE')
        return { stopReason: 'end_turn' }
      },
      cancel: async () => {},
      stop: async () => {}
    }
  }
}
