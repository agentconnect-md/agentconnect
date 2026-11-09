// The turn-start read of an Azure DevOps pull request (azure-devops-integration.md §11.4): the pull request, its newest iteration, and a comment's thread, bounded for the prompt.
import { azureDevOpsGet, type AzureDevOpsReadClient } from './api.js'

/** Bounds on what one read may carry into the model's context. */
export const MAX_DESCRIPTION_CHARS = 4000
export const MAX_THREAD_COMMENTS = 10
export const MAX_THREAD_COMMENT_CHARS = 2000
const MAX_TITLE_CHARS = 200

export interface AzureDevOpsLineRange {
  start: number
  end: number
}

/** A comment's thread: where it sits in the diff, and the comments before the one that fired the turn. */
export interface AzureDevOpsThreadContext {
  id: string
  filePath?: string
  /** Lines on the source side of the diff. */
  right?: AzureDevOpsLineRange
  /** Lines on the target side of the diff. */
  left?: AzureDevOpsLineRange
  comments: { id: string; author?: string; body: string }[]
  /** Earlier comments beyond the bound that were not read into the prompt. */
  omitted?: number
}

/** What the prompt shows of the pull request; every string is authored on Azure DevOps and untrusted. */
export interface AzureDevOpsPullSnapshot {
  title?: string
  status?: string
  isDraft?: boolean
  author?: string
  sourceBranch?: string
  targetBranch?: string
  description?: string
  descriptionTruncated?: boolean
  /** The newest iteration's source commit: the head fence. */
  headSha?: string
  iteration?: number
  thread?: AzureDevOpsThreadContext
}

export type AzureDevOpsTurnRead =
  { kind: 'read'; pull: AzureDevOpsPullSnapshot } | { kind: 'unavailable'; reason: string }

/** The read and the facts the update kinds are classified on. */
export interface AzureDevOpsPullRead {
  pull: AzureDevOpsPullSnapshot
  /** The connection identity is a reviewer with no vote that has not declined. */
  reviewRequested: boolean
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function idOf(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? value : undefined
}

function branch(value: unknown): string | undefined {
  const ref = text(value, 255)
  return ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}

function sha(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : undefined
}

function flat(value: unknown): string | undefined {
  const line = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return line ? line.slice(0, MAX_TITLE_CHARS) : undefined
}

function lines(start: unknown, end: unknown): AzureDevOpsLineRange | undefined {
  const from = positive(record(start).line)
  if (from === undefined) return undefined
  const to = positive(record(end).line) ?? from
  return { start: from, end: Math.max(from, to) }
}

/** The identity among the reviewers, still asked: no vote cast and not declined. */
function requests(reviewers: unknown, identityId: string): boolean {
  const wanted = identityId.toLowerCase()
  return (Array.isArray(reviewers) ? reviewers : []).some((raw) => {
    const reviewer = record(raw)
    return (
      typeof reviewer.id === 'string' &&
      reviewer.id.toLowerCase() === wanted &&
      reviewer.vote === 0 &&
      reviewer.hasDeclined !== true
    )
  })
}

/** The newest iteration (the highest id) and its source commit. */
export function newestIteration(raw: unknown): { id: number; headSha?: string } | undefined {
  let newest: { id: number; headSha?: string } | undefined
  for (const entry of Array.isArray(record(raw).value) ? (record(raw).value as unknown[]) : []) {
    const iteration = record(entry)
    const id = positive(iteration.id)
    if (id === undefined || (newest && newest.id >= id)) continue
    const head = sha(record(iteration.sourceRefCommit).commitId)
    newest = { id, ...(head ? { headSha: head } : {}) }
  }
  return newest
}

function threadContext(raw: unknown, threadId: string, commentId: string | undefined): AzureDevOpsThreadContext {
  const thread = record(raw)
  const context = record(thread.threadContext)
  const filePath = text(context.filePath, 500)
  const right = lines(context.rightFileStart, context.rightFileEnd)
  const left = lines(context.leftFileStart, context.leftFileEnd)
  const earlier = (Array.isArray(thread.comments) ? thread.comments : [])
    .map(record)
    .filter((comment) => comment.isDeleted !== true && comment.commentType !== 'system')
    .filter((comment) => commentId === undefined || idOf(comment.id) !== commentId)
    .filter((comment) => commentId === undefined || Number(idOf(comment.id) ?? 0) < Number(commentId))
  const kept = earlier.slice(-MAX_THREAD_COMMENTS)
  const omitted = earlier.length - kept.length
  return {
    id: threadId,
    ...(filePath ? { filePath } : {}),
    ...(right ? { right } : {}),
    ...(left ? { left } : {}),
    comments: kept.flatMap((comment) => {
      const id = idOf(comment.id)
      if (id === undefined) return []
      const author = flat(record(comment.author).displayName)
      return [{ id, ...(author ? { author } : {}), body: text(comment.content, MAX_THREAD_COMMENT_CHARS) ?? '' }]
    }),
    ...(omitted > 0 ? { omitted } : {})
  }
}

/** Read the pull request, its iterations, and the comment's thread when one fired the turn; throws on any failed read. */
export async function readAzureDevOpsPull(
  client: AzureDevOpsReadClient,
  request: { pullRequestId: number; identityId: string; threadId?: string; commentId?: string }
): Promise<AzureDevOpsPullRead> {
  const path = `/pullRequests/${request.pullRequestId}`
  const pull = record(await azureDevOpsGet(client, path))
  const iteration = newestIteration(await azureDevOpsGet(client, `${path}/iterations`))
  const thread =
    request.threadId !== undefined
      ? threadContext(
          await azureDevOpsGet(client, `${path}/threads/${request.threadId}`),
          request.threadId,
          request.commentId
        )
      : undefined
  const description = typeof pull.description === 'string' ? pull.description : undefined
  const headSha = iteration?.headSha ?? sha(record(pull.lastMergeSourceCommit).commitId)
  const title = flat(pull.title)
  const status = text(pull.status, 40)
  const author = flat(record(pull.createdBy).displayName)
  const sourceBranch = branch(pull.sourceRefName)
  const targetBranch = branch(pull.targetRefName)
  return {
    pull: {
      ...(title ? { title } : {}),
      ...(status ? { status } : {}),
      ...(typeof pull.isDraft === 'boolean' ? { isDraft: pull.isDraft } : {}),
      ...(author ? { author } : {}),
      ...(sourceBranch ? { sourceBranch } : {}),
      ...(targetBranch ? { targetBranch } : {}),
      ...(description
        ? {
            description: description.slice(0, MAX_DESCRIPTION_CHARS),
            ...(description.length > MAX_DESCRIPTION_CHARS ? { descriptionTruncated: true } : {})
          }
        : {}),
      ...(headSha ? { headSha } : {}),
      ...(iteration ? { iteration: iteration.id } : {}),
      ...(thread ? { thread } : {})
    },
    reviewRequested: requests(pull.reviewers, request.identityId)
  }
}
