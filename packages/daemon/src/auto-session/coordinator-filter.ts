// The coordinator filter (auto-session-mode.md §4.7): a Decision model screens an unaddressed message before the coordinator reads it.
import type { DecisionEvaluation, DecisionQuestion } from '@agentconnect.md/protocol'
import type { NormalizedMessage } from '../messages/normalized.js'
import { inThread } from './coordinator-turns.js'

/** The fixed question the daemon asks; the agent picks only the provider and model. */
export const COORDINATOR_FILTER_QUESTION: DecisionQuestion = {
  type: 'boolean',
  instructions:
    'The agent described in `agent` watches this conversation and decides, for each message, whether to answer it, start work on it, or hand it to work already under way. Using the earlier messages for context, should the agent get involved with the latest message?',
  criteria: {
    true: 'The latest message asks for something the agent could do or answer, follows up on work or a question the agent took part in, asks about the status of that work, or reports something within the agent’s role, even when it does not name the agent.',
    false:
      'The latest message is chatter, a greeting, thanks or a reaction between people, is addressed to another person or bot, or needs no response from anyone.'
  }
}

/** Below this probability of Yes a message is skipped; anything less certain still reaches the coordinator. */
export const COORDINATOR_FILTER_SKIP_BELOW = 0.25

/** What the filter reads of a queued message to decide whether to screen it at all. */
export interface ScreenedEntry {
  msg: Pick<
    NormalizedMessage,
    'source' | 'platform' | 'trigger' | 'thread' | 'msgId' | 'transcriptTs' | 'transcriptPostId'
  >
  webchat?: unknown
  callMeta?: unknown
  hookContext?: unknown
}

/** Only an unaddressed channel-root message is screened: a mention, a report, an agent call, a webchat message and a reply in a thread always reach the coordinator. */
export function screensCoordinatorMessage(entry: ScreenedEntry): boolean {
  const { msg } = entry
  return (
    msg.source === 'user' &&
    msg.trigger !== 'mention' &&
    msg.platform !== 'webchat' &&
    entry.webchat === undefined &&
    entry.callMeta === undefined &&
    entry.hookContext === undefined &&
    !inThread(msg)
  )
}

/** Whether an evaluation lets the message through: an unavailable answer always does (decisions.md §5). */
export function coordinatorFilterAdmits(evaluation: DecisionEvaluation): boolean {
  if (evaluation.status !== 'answered' || evaluation.answer.type !== 'boolean') return true
  return evaluation.answer.probability >= COORDINATOR_FILTER_SKIP_BELOW
}
