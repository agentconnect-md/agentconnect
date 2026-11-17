// Which of a pull request's head commits to recreate so GitHub signs them (github-app-git-credentials.md, Signed commits).
import { record } from '../codehost/broker.js'

/** The most commits one pull request action recreates. */
export const MAX_RECREATED_COMMITS = 100

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

/** One commit of a branch as GitHub's compare lists it. */
export interface BranchCommit {
  sha: string
  tree: string
  parents: string[]
  message: string
  authorEmail?: string
  verified: boolean
}

/** A full commit or tree sha, else undefined. */
export function shaOf(value: unknown): string | undefined {
  return typeof value === 'string' && SHA.test(value) ? value : undefined
}

/** Whether a branch's rules require verified signatures; a plan without rulesets answers null, which reads as no. */
export function requiresSignatures(rules: unknown): boolean {
  return Array.isArray(rules) && rules.some((rule) => record(rule).type === 'required_signatures')
}

/** The commits a compare lists, or why they cannot be read whole. */
export function branchCommits(compare: unknown): BranchCommit[] | { refused: string } {
  const answer = record(compare)
  if (!Array.isArray(answer.commits)) return { refused: 'GitHub listed no commits for the branch' }
  const total = answer.total_commits
  if (typeof total === 'number' && total > answer.commits.length)
    return { refused: `the branch has ${total} commits, more than GitHub lists at once` }
  const commits: BranchCommit[] = []
  for (const raw of answer.commits) {
    const entry = record(raw)
    const commit = record(entry.commit)
    const sha = shaOf(entry.sha)
    const tree = shaOf(record(commit.tree).sha)
    const parents = Array.isArray(entry.parents) ? entry.parents.map((parent) => shaOf(record(parent).sha)) : []
    const author = record(commit.author).email
    if (!sha || !tree || typeof commit.message !== 'string' || parents.length === 0 || parents.includes(undefined))
      return { refused: 'GitHub listed a commit without its tree, parents or message' }
    commits.push({
      sha,
      tree,
      parents: parents as string[],
      message: commit.message,
      ...(typeof author === 'string' ? { authorEmail: author } : {}),
      verified: record(commit.verification).verified === true
    })
  }
  return commits
}

/** The commits to recreate in parent order: every unsigned one and everything after it; or why the branch stays as it is. */
export function recreationPlan(commits: BranchCommit[], authorEmail: string): BranchCommit[] | { refused: string } {
  const listed = new Set(commits.map((commit) => commit.sha))
  const placed = new Set<string>()
  const order: BranchCommit[] = []
  let pending = commits
  while (pending.length > 0) {
    // A parent the compare does not list is already on the base branch.
    const ready = pending.filter((commit) => commit.parents.every((p) => !listed.has(p) || placed.has(p)))
    if (ready.length === 0) return { refused: 'the branch commits do not form a history' }
    for (const commit of ready) {
      order.push(commit)
      placed.add(commit.sha)
    }
    pending = pending.filter((commit) => !placed.has(commit.sha))
  }
  const recreated = new Set<string>()
  for (const commit of order) {
    if (!commit.verified || commit.parents.some((p) => recreated.has(p))) recreated.add(commit.sha)
  }
  const plan = order.filter((commit) => recreated.has(commit.sha))
  if (plan.length > MAX_RECREATED_COMMITS)
    return { refused: `${plan.length} commits would be recreated, more than ${MAX_RECREATED_COMMITS}` }
  const foreign = plan.find((commit) => commit.authorEmail?.toLowerCase() !== authorEmail.toLowerCase())
  if (foreign)
    return {
      refused: `commit ${foreign.sha.slice(0, 12)} is not authored by this agent's GitHub App, and recreating it would make the App its author`
    }
  return plan
}
