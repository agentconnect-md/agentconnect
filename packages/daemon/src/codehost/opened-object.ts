// What a task opened on a code host, where the daemon already sees it (assistant-mode.md §5.18 ④): a merge request it created, or the pull request the Control Plane names as its own.
import { followUpWatchLabel, parseFollowUpWatchUrl } from '@agentconnect.md/protocol'
import type { OpenedObject } from '../store/assistant-subsessions.js'

type Opened = Omit<OpenedObject, 'openedAt'>

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

const GITEA_PULL = /^\/(.+)\/pulls\/([1-9]\d{0,9})\/?$/

/** The object `createCodeHostMergeRequest` made, from its broker's result: a GitLab merge request or a Gitea pull request. */
export function createdObjectOf(result: unknown): Opened | undefined {
  const mergeRequest = record(record(result).mergeRequest)
  if (typeof mergeRequest.webUrl === 'string') {
    const parsed = parseFollowUpWatchUrl(mergeRequest.webUrl)
    if ('target' in parsed)
      return { kind: 'merge request', label: followUpWatchLabel(parsed.target), url: mergeRequest.webUrl }
  }
  const pull = record(record(result).pullRequest)
  if (typeof pull.htmlUrl === 'string') {
    const path = URL.canParse(pull.htmlUrl) ? new URL(pull.htmlUrl).pathname : ''
    const match = GITEA_PULL.exec(path)
    if (match) return { kind: 'pull request', label: `${match[1]}#${match[2]}`, url: pull.htmlUrl }
  }
  return undefined
}

/** The pull request a feedback continuation names as the session's own (codehost-pr-feedback.md). */
export function feedbackPullOf(req: {
  provider?: 'gitlab' | 'gitea'
  host?: string
  repoFullName: string
  pullNumber: number
}): Opened | undefined {
  const n = req.pullNumber
  if (!req.provider)
    return {
      kind: 'pull request',
      label: `${req.repoFullName}#${n}`,
      url: `https://github.com/${req.repoFullName}/pull/${n}`
    }
  const host = req.host?.replace(/\/+$/, '')
  if (!host) return undefined
  return req.provider === 'gitlab'
    ? {
        kind: 'merge request',
        label: `${req.repoFullName}!${n}`,
        url: `${host}/${req.repoFullName}/-/merge_requests/${n}`
      }
    : { kind: 'pull request', label: `${req.repoFullName}#${n}`, url: `${host}/${req.repoFullName}/pulls/${n}` }
}
