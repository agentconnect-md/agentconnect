// What a task opened on a code host, where the daemon already sees it (assistant-mode.md §5.18 ④): a merge request it created, or the pull request the Control Plane names as its own.
import { followUpWatchLabel, parseFollowUpWatchUrl } from '@agentconnect.md/protocol'
import type { OpenedObject } from '../store/assistant-subsessions.js'

type Opened = Omit<OpenedObject, 'openedAt'>

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

// Gitea's pull path is `/pulls/<n>`, GitHub's `/pull/<n>`; both label the object `owner/repo#<n>`.
const PULL_PATH = /^\/(.+)\/pulls?\/([1-9]\d{0,9})\/?$/
// Azure DevOps's is `/{organization}/{project}/_git/{repository}/pullrequest/<n>`, labelled `organization/project/repository!<n>`.
const AZURE_DEVOPS_PULL_PATH = /^\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/([1-9]\d{0,9})\/?$/

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** The change request a `create` of a host's pull or merge request tool made, from its broker's result. */
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
    const azure = AZURE_DEVOPS_PULL_PATH.exec(path)
    if (azure) {
      const repository = azure.slice(1, 4).map(decoded).join('/')
      return { kind: 'pull request', label: `${repository}!${azure[4]}`, url: pull.htmlUrl }
    }
    const match = PULL_PATH.exec(path)
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
