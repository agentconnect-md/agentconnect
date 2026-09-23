// In-conversation control commands: detected after the channel record is written, never fed to the agent as a prompt.

import { parseCommand, type AgentCommand } from '@agentconnect.md/activation-policy'

// The grammar lives in activation-policy so the relay parses commands exactly as the daemon does.
export { COMMAND_PREFIXES, parseCommand, type AgentCommand } from '@agentconnect.md/activation-policy'

/**
 * Commands that may only come from a real person: they are destructive or reset a durable
 * safety latch, so a bot echo or a wrapper that reports no actor must not be able to forge
 * them. Lives beside the parser because EVERY ingress path that parses a command has to ask
 * the same question — the gate drifting between direct and relay ingress is the failure this
 * exists to prevent.
 */
export function requiresTrustedActor(kind: AgentCommand['kind']): boolean {
  return kind === 'resume' || kind === 'new'
}

/** The prompt text of a recorded `!queue <text>` row: the row keeps the command as typed (that is
 *  what the channel shows), so the strip happens at prompt assembly (message-intake.md §5 step 2).
 *  Pure, so a replay rebuilds the identical prompt. A bare `!queue` is never admitted — it draws a
 *  usage reply — so it is left alone rather than blanked. */
export function queuePromptText(text: string): string {
  const parsed = parseCommand(text)
  return parsed?.kind === 'queue' && parsed.text !== '' ? parsed.text : text
}

/** Does this recorded row's text read as a control? Step 1 now records commands, but a command
 *  acted on the session instead of being said to it, so it is never session context
 *  (message-intake.md §5 step 2). `!queue <text>` is the exception — its row IS admitted, and
 *  {@link queuePromptText} strips the prefix. Pure, like the strip, so every reader agrees. */
export function isControlCommandText(text: string): boolean {
  const parsed = parseCommand(text)
  return parsed !== null && parsed.kind !== 'queue'
}
