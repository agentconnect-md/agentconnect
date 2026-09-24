import type { DecisionQuestion, HookContext, RdMsgHook } from '@agentconnect.md/protocol'
import {
  decisionEntryOf,
  fitsDecisionBudget,
  type DecisionStateEntry,
  type DecisionStateResult
} from '../decisions/state.js'
import { hookDecisionFacts, type HookDecisionSubject } from '../messages/hook-message.js'
import type { ChannelTextRow } from '../store/local-store.js'

export interface CodeHostHookStateInput {
  msg: RdMsgHook
  current: ChannelTextRow
  /** Newest-first, the same thread's earlier rows. */
  history: readonly ChannelTextRow[]
  full: boolean
  question: DecisionQuestion
  model: string
}

/** The body is halved at most this many times before it is dropped outright. */
const SUBJECT_BODY_HALVINGS = 12

function eventOf(msg: RdMsgHook, c: HookContext | undefined): { name?: string; action?: string } {
  const [family, ...rest] = (msg.event ?? '').split(':')
  const name = c?.event ?? (family || undefined)
  const action = c?.action ?? (rest.length ? rest.join(':') : undefined)
  return { ...(name ? { name } : {}), ...(action ? { action } : {}) }
}

function subjectOf(
  c: HookContext | undefined,
  id: HookDecisionSubject,
  body: string | undefined
): Record<string, unknown> {
  const s = c?.subject
  const author = {
    ...(s?.authorLogin ? { login: s.authorLogin } : {}),
    ...(s?.authorType ? { type: s.authorType } : {}),
    ...(s?.authorAssociation ? { association: s.authorAssociation } : {})
  }
  return {
    ...(id.kind ? { kind: id.kind } : {}),
    ...(id.number !== undefined ? { number: id.number } : {}),
    ...(c?.title ? { title: c.title } : {}),
    ...(c?.htmlUrl ? { url: c.htmlUrl } : {}),
    ...(Object.keys(author).length ? { author } : {}),
    labels: [...(c?.labels ?? [])],
    ...(s?.state ? { state: s.state } : {}),
    ...(id.draft !== undefined ? { draft: id.draft } : {}),
    ...(body !== undefined ? { body } : {})
  }
}

/** Halve a string on a code-point boundary. */
function halve(text: string): string {
  const cps = Array.from(text)
  return cps.slice(0, Math.floor(cps.length / 2)).join('')
}

/** The code-host state Jev sees (code-host-decisions.md §5.1): chat field names, the subject beside them. */
export function buildCodeHostHookState(input: CodeHostHookStateInput): DecisionStateResult {
  const { msg } = input
  // Which host a delivery is, and its subject identity, come from its normalizer; a delivery of none is not judged.
  const facts = hookDecisionFacts(msg)
  if (!facts) return { unsupported: true }
  const c = facts.context
  const association = c?.authorAssociation
  const base = decisionEntryOf(input.current, false)
  const current = { ...base, sender: { ...base.sender, ...(association ? { association } : {}) } }
  const candidates = input.history.map((row) => decisionEntryOf(row, true))
  const repository = facts.subject.repoPath
  const compose = (included: DecisionStateEntry[], body: string | undefined, bodyTrimmed: boolean) => {
    const omitted = candidates.length - included.length
    const reasons: string[] = []
    if (input.full) reasons.push('history_limit')
    if (omitted > 0) reasons.push('budget_trimmed')
    if (bodyTrimmed) reasons.push('subject_body_trimmed')
    return {
      reasons,
      omitted,
      state: {
        source: facts.provider,
        event: eventOf(msg, c),
        repository: repository ? { fullName: repository } : {},
        subject: subjectOf(c, facts.subject, body),
        currentMessage: current,
        history: [...included].reverse(),
        context: {
          partial: reasons.length > 0,
          reasons,
          omittedMessages: omitted,
          snapshotSequence: input.current.seq,
          tokenCount: 'estimate'
        }
      } as Record<string, unknown>
    }
  }
  const fits = (state: Record<string, unknown>) => fitsDecisionBudget(state, input.question, input.model)
  let body = c?.subject?.body
  // Oldest history goes first: the kept set is the newest suffix that fits beside the full body.
  const included: DecisionStateEntry[] = []
  for (const entry of candidates) {
    if (!fits(compose([...included, entry], body, false).state)) break
    included.push(entry)
  }
  let built = compose(included, body, false)
  while (!fits(built.state) && included.length > 0) {
    included.pop()
    built = compose(included, body, false)
  }
  // Then the subject body, halved until it fits and dropped as a last resort; the current message is never cut.
  for (let i = 0; !fits(built.state) && body !== undefined && i <= SUBJECT_BODY_HALVINGS; i++) {
    body = i === SUBJECT_BODY_HALVINGS || body.length <= 1 ? undefined : halve(body)
    built = compose(included, body, true)
  }
  if (!fits(built.state)) return { unsupported: true }
  return { state: built.state, omittedMessages: built.omitted, reasons: built.reasons }
}
