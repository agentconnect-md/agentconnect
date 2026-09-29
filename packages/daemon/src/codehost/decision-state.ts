import {
  codeHostHookMetadataOf,
  codeHostHookRevisionOf,
  codeHostSubjectBody,
  type HookContext,
  type RdMsgHook
} from '@agentconnect.md/protocol'
import {
  decisionEntryOf,
  decisionTextPrefix,
  decisionTextTrimmer,
  fitDecisionState,
  type DecisionStateBudget,
  type DecisionStateResult,
  type DecisionAgentContext
} from '../decisions/state.js'
import { hookDecisionFacts, type HookDecisionSubject } from '../messages/hook-message.js'
import type { ChannelRecordRef, ChannelTextRow, LocalStore } from '../store/local-store.js'
import { PULL_CONTEXT_TIMEOUT_MS, type PullRequestContext } from './pull-context.js'
import { PULL_CONTEXT_DIFF_MAX_BYTES, trimFileDiffs, type PullRequestFile } from './pull-files.js'

export type CodeHostDecisionSource = Pick<RdMsgHook, 'github' | 'gitlab' | 'gitea' | 'context' | 'event'>

export interface CodeHostDecisionContext {
  msg: CodeHostDecisionSource
  current: ChannelTextRow
  // Newest-first, the same thread's earlier observed rows.
  history: readonly ChannelTextRow[]
  full: boolean
  reasons?: string[]
  pullRequest?: PullRequestContext
  /** The one agent this evaluation decides for; hook routing among several has none. */
  agent?: DecisionAgentContext
}

// Freeze the event and observed history once; provider enrichment is bounded and optional.
export async function loadCodeHostDecisionContext(input: {
  msg: CodeHostDecisionSource
  store: LocalStore
  record?: ChannelRecordRef
  current?: ChannelTextRow
  pullRequest(signal: AbortSignal): Promise<PullRequestContext | undefined>
  signal: AbortSignal
}): Promise<CodeHostDecisionContext | undefined> {
  const msg = structuredClone(input.msg)
  const facts = hookDecisionFacts(msg)
  if (!facts) return undefined
  input.signal.throwIfAborted()
  const { record } = input
  const window = record
    ? await input.store.decisionWindow(record.orgId, record.transcriptChannel, record.seq, undefined, undefined, {
        thread: record.thread
      })
    : undefined
  const current = window?.current ?? input.current
  if (!current) return undefined
  const reasons = ['observed_history']
  if (!window?.current) reasons.push('history_unavailable')
  let pullRequest: PullRequestContext | undefined
  if (facts.subject.kind === 'pull_request' || facts.subject.kind === 'merge_request') {
    try {
      pullRequest = await input.pullRequest(
        AbortSignal.any([input.signal, AbortSignal.timeout(PULL_CONTEXT_TIMEOUT_MS)])
      )
    } catch {
      // An unavailable supplement leaves the webhook and recorded conversation usable.
    }
    if (!pullRequest) reasons.push('pull_request_unavailable')
  }
  input.signal.throwIfAborted()
  return { msg, current, history: window?.history ?? [], full: window?.full ?? false, reasons, pullRequest }
}

function eventOf(msg: CodeHostDecisionSource, c: HookContext | undefined): { name?: string; action?: string } {
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

// Keep the file inventory through patch, commit and body trimming; the shared fitter owns the request budget.
export function fitCodeHostDecisionState(
  state: Record<string, unknown>,
  decision: DecisionStateBudget
): DecisionStateResult {
  return fitDecisionState(state, decision, (copy) => {
    const pull = copy.pullRequest as Record<string, unknown> | undefined
    const subject = copy.subject as Record<string, unknown> | undefined
    const files = (pull?.files ?? []) as PullRequestFile[]
    return [
      [
        'diff_truncated',
        () => trimFileDiffs(files, Math.floor(files.reduce((sum, file) => sum + Buffer.byteLength(file.diff), 0) / 2))
      ],
      ['commits_truncated', decisionTextTrimmer(pull, 'commitMessages')],
      [
        'subject_body_trimmed',
        decisionTextTrimmer(subject, 'body', (text, bytes) => codeHostSubjectBody(text, bytes).body)
      ],
      [
        'files_truncated',
        () => {
          if (!pull || !files.length) return false
          files.pop()
          pull.filesTruncated = true
          return true
        }
      ]
    ]
  })
}

// Routing, runtime selection and repository selection share this state and request budget.
export function buildCodeHostDecisionState(
  input: CodeHostDecisionContext,
  decision: DecisionStateBudget
): DecisionStateResult {
  const facts = hookDecisionFacts(input.msg)
  if (!facts) return { unsupported: true }
  const c = facts.context
  const base = decisionEntryOf(input.current, false)
  const currentMessage = {
    ...base,
    sender: { ...base.sender, ...(c?.authorAssociation ? { association: c.authorAssociation } : {}) }
  }
  const reasons = [...(input.reasons ?? []), ...(input.pullRequest?.reasons ?? [])]
  if (input.full) reasons.push('history_limit')
  const cap = (text: string, bytes: number, reason: string) => {
    const prefix = decisionTextPrefix(text, bytes)
    if (prefix !== text) reasons.push(reason)
    return prefix
  }
  const description = c?.subject?.body ?? input.pullRequest?.description
  const body = description === undefined ? undefined : codeHostSubjectBody(description)
  if (body?.bodyTruncated || c?.subject?.bodyTruncated) reasons.push('subject_body_trimmed')
  const pull = input.pullRequest
  const files = structuredClone(pull?.files ?? [])
  if (trimFileDiffs(files, PULL_CONTEXT_DIFF_MAX_BYTES)) reasons.push('diff_truncated')
  const member = codeHostHookMetadataOf(input.msg)
  const revision = member && codeHostHookRevisionOf(member)
  const isPull = facts.subject.kind === 'pull_request' || facts.subject.kind === 'merge_request'
  return fitCodeHostDecisionState(
    {
      source: facts.provider,
      ...(input.agent ? { agent: input.agent } : {}),
      event: eventOf(input.msg, c),
      repository: facts.subject.repoPath ? { fullName: facts.subject.repoPath } : {},
      subject: subjectOf(c, facts.subject, body?.body),
      currentMessage,
      history: input.history.map((row) => decisionEntryOf(row, true)).reverse(),
      ...(isPull
        ? {
            pullRequest: {
              ...(revision ?? (pull?.headSha ? { baseSha: pull.baseSha, headSha: pull.headSha } : {})),
              commitMessages: cap(pull?.commitMessages.join('\n\n') ?? '', 4 * 1024, 'commits_truncated'),
              files,
              filesTruncated: pull?.filesTruncated ?? true
            }
          }
        : {}),
      context: {
        partial: reasons.length > 0,
        reasons: [...new Set(reasons)],
        omittedMessages: 0,
        snapshotSequence: input.current.seq,
        tokenCount: 'estimate'
      }
    },
    decision
  )
}
