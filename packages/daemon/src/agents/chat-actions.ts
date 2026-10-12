import type { ChatActions } from '@agentconnect.md/protocol'
import type { Integration } from './agent-schema.js'
import { conversationAdmitted, conversationTrustLevel, integrationRouting } from '../router/routing-rule.js'

type ChatActionsHolder = { readonly chatActions?: ChatActions } | null | undefined

/** People in the conversation may answer the agent's tool-call approvals in chat (level 'approve' and above). */
export function chatApprovalsAllowed(agent: ChatActionsHolder): boolean {
  return agent?.chatActions === 'approve' || agent?.chatActions === 'settings'
}

/** People in the conversation may change the agent's runtime settings from chat (level 'settings'). */
export function chatSettingsAllowed(agent: ChatActionsHolder): boolean {
  return agent?.chatActions === 'settings'
}

/** How a chat approval card reads for everyone once approving in chat is turned off: still open, for an editor. */
export const CHAT_APPROVALS_OFF = 'Approving in chat was turned off. An Agent editor can answer it in the console.'

/** How a person's chat action is judged past the level and the conversation: anyone where permissions are not synced, else only an Agent editor by their linked identity. */
export type ChatActorVerdict = 'allowed' | 'not-editor' | 'unlinked' | 'unavailable'

/** What a refused settings change from a chat account linked to no console account is told as well. */
export const CHAT_LINK_HINT =
  'If you are an Agent editor, link this account under Sign-in methods in your console Profile and try again. Otherwise, ask an Agent editor.'

/** Why an approval answer was refused: the level or the conversation closed it, else who the person is where permissions are synced. */
export type ApprovalRefusal = Exclude<ChatActorVerdict, 'allowed'> | 'closed'

/** A synced platform's approval refusals carry no console link: the console shows that conversation only to the same people. */
const SYNCED_APPROVAL_REFUSALS: Record<Exclude<ApprovalRefusal, 'closed'>, string> = {
  'not-editor': 'Only an Agent editor can answer this request.',
  unlinked:
    'Only an Agent editor can answer this request, from a chat account linked to their console account. If that is you, link this account under Sign-in methods in your console Profile and try again.',
  unavailable: "Who you are can't be checked right now, so this request can't be answered here. Try again in a moment."
}

/** What only the person whose approval answer was refused is told, within `limit` characters; only a closed conversation points to the console. */
export function approvalRefusalText(why: ApprovalRefusal, consoleUrl?: string, limit?: number): string {
  if (why !== 'closed') return SYNCED_APPROVAL_REFUSALS[why]
  const where = (url?: string) => (url ? `in the console: ${url}` : 'in the console.')
  return fitRefusal((url) => `Only an Agent editor can answer this request. They can answer it ${where(url)}`, {
    consoleUrl,
    verdict: undefined,
    limit
  })
}

/** What only the person whose runtime-settings change was refused is told: who can change them, and where, within `limit` characters. */
export function settingsRefusalText(consoleUrl: string, verdict?: ChatActorVerdict, limit?: number): string {
  const where = (url?: string) => (url ? `in the console: ${url}` : 'in the console.')
  return fitRefusal((url) => `Only an Agent editor can change runtime settings. They can change them ${where(url)}`, {
    consoleUrl,
    verdict,
    limit
  })
}

/** A refusal within `limit`: the console link is dropped whole rather than cut, then the link hint; the hint goes on its own line. */
function fitRefusal(
  text: (consoleUrl?: string) => string,
  o: { consoleUrl: string | undefined; verdict: ChatActorVerdict | undefined; limit: number | undefined }
): string {
  const hint = (t: string) => (o.verdict === 'unlinked' ? `${t}\n${CHAT_LINK_HINT}` : t)
  const forms = [hint(text(o.consoleUrl)), hint(text()), text()]
  return forms.find((form) => o.limit === undefined || form.length <= o.limit) ?? text()
}

/** Whether a conversation takes chat-side answers and setting changes: `closed` keeps everyone out, `external` sends approvals to an internal member. */
export type ChatSurface = 'open' | 'closed' | 'external'

/** Closed when switched off, admitted per message by a Decision, routed, or unknown; external when shared with another organization. */
export function chatSurfaceOf(int: Integration | undefined, channel: string, externallyShared = false): ChatSurface {
  if (!int) return 'closed'
  const routing = integrationRouting(int)
  if (!conversationAdmitted(routing, channel) || routing.decisionBound(channel) || routing.routingFor(channel))
    return 'closed'
  return externallyShared || conversationTrustLevel(int, channel) === 'external' ? 'external' : 'open'
}
