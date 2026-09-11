/**
 * The provider-neutral half of the code-host effect broker (gitlab-com-integration.md §14.2,
 * gitea-integration.md §10.2): the operation vocabulary the structured tools speak, the trusted target
 * a call is scoped to, the capability clamp, the allowlisted call with its one auth retry, the
 * authored-comment ledger behind the single-writer rule, and the bounded shaping helpers. Each host
 * contributes its own allowlist and plans; the effect token never enters the agent environment and
 * the repository is never model input.
 */
import type { CodeHostProvider, GitCredGrant } from '@agentconnect.md/protocol'
import { parseCodeHostJson } from './json.js'

/** §13.1 authorization levels, ordered — an operation's class is checked against the CLAMPED grant. */
export type BrokerCapability = GitCredGrant['access']

const CAPABILITY_RANK: Record<BrokerCapability, number> = { read: 0, comment: 1, write: 2 }

/** One allowlisted endpoint: an exact method, an exact path template, and the capability it costs. */
export interface BrokerEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH'
  capability: BrokerCapability
  path: string
}

/** The product subject vocabulary the tools speak. */
export type BrokerSubject = 'issue' | 'merge_request'

/** Bounded pipeline states the inspect operation may filter on. */
export const BROKER_PIPELINE_STATUSES = [
  'created',
  'waiting_for_resource',
  'preparing',
  'pending',
  'running',
  'success',
  'failed',
  'canceled',
  'skipped',
  'manual',
  'scheduled'
] as const

/** The §14.2 operation set, exactly; every host resolves each member to its own allowlisted endpoint or refuses it. */
export type CodeHostBrokerOperation =
  | { kind: 'createComment'; subject: BrokerSubject; iid: number; body: string }
  | { kind: 'updateComment'; subject: BrokerSubject; iid: number; noteId: string; body: string }
  | { kind: 'readDiscussions'; subject: BrokerSubject; iid: number; discussionId?: string; limit?: number }
  | { kind: 'replyDiscussion'; subject: BrokerSubject; iid: number; discussionId: string; body: string }
  | {
      kind: 'createMergeRequest'
      sourceBranch: string
      targetBranch: string
      title: string
      description?: string
      draft?: boolean
    }
  | {
      kind: 'updateMergeRequest'
      iid: number
      title?: string
      description?: string
      targetBranch?: string
      draft?: boolean
    }
  | {
      kind: 'inspectPipelines'
      scope: 'pipelines' | 'pipeline' | 'pipeline_jobs' | 'job'
      pipelineId?: string
      jobId?: string
      ref?: string
      status?: (typeof BROKER_PIPELINE_STATUSES)[number]
      limit?: number
    }
  | {
      kind: 'controlPipeline'
      action: 'retry_pipeline' | 'cancel_pipeline' | 'retry_job' | 'cancel_job'
      pipelineId?: string
      jobId?: string
    }

/** The trusted target: agent, repository, and hook are daemon-held coordinates, never tool arguments. */
export interface CodeHostEffectTarget {
  agentId: string
  provider: CodeHostProvider
  /** The numeric project/repository id the lease is scoped to (decimal string). */
  repoId: string
  /** The current `owner/repo` for a host whose REST paths take the path rather than the id (Gitea). */
  repoPath?: string
  /** Present when a hook-dispatched turn authorizes the lease (§13.1). */
  hookId?: string
  /** Logical session key — the single-writer ledger for `updateComment` is scoped to it. */
  sessionKey: string
}

/** One registered host's broker, selected by the active turn's provider. */
export interface CodeHostEffectBroker {
  execute(target: CodeHostEffectTarget, op: CodeHostBrokerOperation): Promise<unknown>
}

export interface BrokerLease {
  token: string
  /** The clamp the CP echoed in the grant; every operation is refused above it. */
  access: BrokerCapability
}

/** Bounds on what one broker answer may carry back into the model's context. */
export const MAX_NOTE_BODY_CHARS = 4000
export const MAX_LIST_ITEMS = 20
const MAX_ERROR_CHARS = 200
/** Ledger bounds: a long-lived daemon must not accumulate comment ids for every session it ever ran. */
const MAX_LEDGER_SESSIONS = 500
const MAX_LEDGER_NOTES = 200

export const DECIMAL_ID = /^[1-9]\d*$/
/** A conservative branch shape — enough for real refs, never a traversal or a query injection. */
const BRANCH_NAME = /^[\w.\-/]{1,255}$/

/** A big-int-safe id as a decimal string; undefined when the value is not one. */
export function idOf(value: unknown): string | undefined {
  if (typeof value === 'string' && DECIMAL_ID.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  return undefined
}

export function str(value: unknown, max = 500): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined
}

export function int(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

export function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** Drop undefined members so a bounded result never carries empty keys into the model's context. */
export function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>
}

export function requireDecimal(value: string, label: string): string {
  if (!DECIMAL_ID.test(value)) throw new Error(`${label} must be a positive decimal id`)
  return value
}

export function limited(limit: number | undefined): string {
  return String(Math.min(Math.max(limit ?? MAX_LIST_ITEMS, 1), MAX_LIST_ITEMS))
}

export function branch(value: string, label: string): string {
  if (!BRANCH_NAME.test(value)) throw new Error(`${label} must be a branch name`)
  return value
}

export function requireArg(value: string | undefined, label: string, scope: string): string {
  if (value === undefined) throw new Error(`${label} is required for ${scope}`)
  return requireDecimal(value, label)
}

/** Fill an allowlisted template; an unresolved placeholder is a bug, never a passthrough path. */
export function renderPath(template: string, params: Record<string, string>): string {
  return template
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment
      const value = params[segment.slice(1)]
      if (value === undefined) throw new Error(`broker path parameter ${segment.slice(1)} is missing`)
      return encodeURIComponent(value)
    })
    .join('/')
}

/** A bounded, single-line hint from the host's error body — never the request or the token. */
export async function failureDetail(res: Response): Promise<string> {
  try {
    const raw = await res.text()
    const parsed = JSON.parse(raw) as { message?: unknown; error?: unknown }
    const message = typeof parsed.message === 'string' ? parsed.message : parsed.error
    if (typeof message !== 'string' || !message.trim()) return ''
    return `: ${message.replace(/\s+/g, ' ').slice(0, MAX_ERROR_CHARS)}`
  } catch {
    return ''
  }
}

/** §13.1: the clamp the CP echoed decides, not the tool the model happened to call. */
export function enforceCapability(lease: BrokerLease, endpoint: BrokerEndpoint, subject: string): void {
  if (CAPABILITY_RANK[lease.access] >= CAPABILITY_RANK[endpoint.capability]) return
  throw new Error(
    `this operation needs ${endpoint.capability} authority on the ${subject}, but the current authorization grants ${lease.access}`
  )
}

/** Comment ids one broker authored, by session key — `updateComment` may touch nothing else. */
export class AuthoredCommentLedger {
  private readonly authored = new Map<string, Set<string>>()

  has(sessionKey: string, id: string): boolean {
    return this.authored.get(sessionKey)?.has(id) === true
  }

  remember(sessionKey: string, id: string | undefined): void {
    if (!id) return
    let ids = this.authored.get(sessionKey)
    if (!ids) {
      if (this.authored.size >= MAX_LEDGER_SESSIONS) {
        const oldest = this.authored.keys().next().value
        if (oldest !== undefined) this.authored.delete(oldest)
      }
      ids = new Set<string>()
      this.authored.set(sessionKey, ids)
    }
    if (ids.size >= MAX_LEDGER_NOTES) {
      const oldest = ids.values().next().value
      if (oldest !== undefined) ids.delete(oldest)
    }
    ids.add(id)
  }
}

/** One allowlisted request as the host issues it: the rendered URL, the method, and the JSON body. */
export interface BrokerRequest {
  method: BrokerEndpoint['method']
  url: string
  body?: Record<string, unknown>
}

export interface BrokerCallDeps<L extends BrokerLease> {
  /** The host's auth header for one lease's token. */
  headers: (token: string) => Record<string, string>
  /** Re-mint after a definite auth rejection, so the single retry carries a fresh lease. */
  lease: () => Promise<L>
  invalidateLease?: (token: string) => void
  /** The clamp check, re-run on the re-minted lease. */
  enforce: (lease: L) => void
  /** The host's name for error text. */
  host: string
  fetchImpl?: typeof fetch
}

/** Issue one allowlisted request; retry once, and only after a definite auth rejection. */
export async function brokerCall<L extends BrokerLease>(
  deps: BrokerCallDeps<L>,
  lease: L,
  request: BrokerRequest
): Promise<unknown> {
  const doFetch = deps.fetchImpl ?? fetch
  let current = lease
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await doFetch(request.url, {
      method: request.method,
      headers: {
        ...deps.headers(current.token),
        ...(request.body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {})
    })
    if (res.ok) {
      const raw = await res.text()
      try {
        return parseCodeHostJson(raw)
      } catch {
        throw new Error(`${deps.host} returned an unreadable ${request.method} response`)
      }
    }
    const authRejected = res.status === 401 || res.status === 403
    const detail = await failureDetail(res)
    if (attempt === 1 || !authRejected || !deps.invalidateLease) {
      throw new Error(`${deps.host} ${request.method} failed with ${res.status}${detail}`)
    }
    deps.invalidateLease(current.token)
    current = await deps.lease()
    deps.enforce(current)
  }
  throw new Error(`${deps.host} ${request.method} failed`)
}
