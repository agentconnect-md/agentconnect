// Which one repository a GitHub GraphQL mutation touches, from the node IDs it names (github-app-git-credentials.md, Phase 2).

/** More ID candidates than this refuse the mutation instead of costing a large lookup. */
export const MAX_ID_CANDIDATES = 50

/** More lookup rounds than this refuse the mutation instead of trying every authorized repository. */
export const MAX_LOOKUP_ROUNDS = 10

/** Each node's type and repository; types that carry a repository without implementing `RepositoryNode` are named one by one. */
export const NODE_REPOSITORY_QUERY =
  'query($ids:[ID!]!){nodes(ids:$ids){__typename ' +
  '...on Repository{nameWithOwner} ' +
  '...on RepositoryNode{repository{nameWithOwner}} ' +
  '...on Label{repository{nameWithOwner}} ' +
  '...on Milestone{repository{nameWithOwner}} ' +
  '...on Ref{repository{nameWithOwner}} ' +
  '...on GitObject{repository{nameWithOwner}} ' +
  '...on PullRequestReviewThread{repository{nameWithOwner}}}}'

/** Node types that belong to no repository, which a mutation may name beside its target. */
const NO_REPOSITORY_TYPES: ReadonlySet<string> = new Set(['User', 'Bot', 'Team', 'Organization', 'Mannequin'])

/** What a node resolved to: a repository, nothing that has one, or a type the lookup does not map. */
export type NodeOwner = { repo: string } | { none: true } | { unmapped: string }

/** One lookup round: the owners of the IDs it resolved, a round to skip, or a failure that ends the attribution. */
export type LookupRound =
  { owners: Map<string, NodeOwner> } | { skip: true } | { fail: { status: number; reason: string } }

export type Attribution = { repo: string } | { refused: { status: number; reason: string } }

const ID_KEY = /^(?:id|.*Ids?)$/

/** The values at ID positions in a request's variables: under a key named `id` or ending in `Id` or `Ids`, at any depth. */
export function idCandidates(variables: unknown): string[] | 'too-many' {
  const found = new Set<string>()
  const visit = (value: unknown, key: string | undefined): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key)
      return
    }
    if (typeof value === 'string') {
      if (key !== undefined && ID_KEY.test(key)) found.add(value)
      return
    }
    if (typeof value === 'object' && value !== null)
      for (const [name, inner] of Object.entries(value as Record<string, unknown>)) visit(inner, name)
  }
  visit(variables, undefined)
  return found.size > MAX_ID_CANDIDATES ? 'too-many' : [...found]
}

/** Each requested ID's owner from a `nodes` answer, unresolved where GitHub answered null; undefined when the answer cannot be read. */
export function nodeOwners(answer: unknown, ids: readonly string[]): Map<string, NodeOwner> | undefined {
  if (typeof answer !== 'object' || answer === null) return undefined
  const { data, errors } = answer as { data?: { nodes?: unknown }; errors?: unknown }
  // An error that is not about one node, such as a rate limit, says nothing about where the nodes live.
  if (Array.isArray(errors) && errors.some((error) => !perNodeError(error))) return undefined
  const nodes = data?.nodes
  if (!Array.isArray(nodes) || nodes.length !== ids.length) return undefined
  const owners = new Map<string, NodeOwner>()
  nodes.forEach((node, index) => {
    if (typeof node !== 'object' || node === null) return
    const n = node as { __typename?: unknown; nameWithOwner?: unknown; repository?: { nameWithOwner?: unknown } }
    const repo = typeof n.nameWithOwner === 'string' ? n.nameWithOwner : n.repository?.nameWithOwner
    const typename = typeof n.__typename === 'string' ? n.__typename : ''
    owners.set(
      ids[index]!,
      typeof repo === 'string'
        ? { repo: repo.toLowerCase() }
        : NO_REPOSITORY_TYPES.has(typename)
          ? { none: true }
          : { unmapped: typename }
    )
  })
  return owners
}

function perNodeError(error: unknown): boolean {
  const path = (error as { path?: unknown } | null)?.path
  return Array.isArray(path) && path[0] === 'nodes' && typeof path[1] === 'number'
}

/** The one authorized repository every candidate's node belongs to, asking each authorized repository's read token in turn until all resolve. */
export async function attributeMutation(
  candidates: readonly string[],
  repositories: readonly string[],
  lookup: (repo: string, ids: readonly string[]) => Promise<LookupRound>
): Promise<Attribution> {
  const authorized = new Set(repositories.map((repo) => repo.toLowerCase()))
  const owners = new Map<string, NodeOwner>()
  let rounds = 0
  for (const repo of repositories) {
    const pending = candidates.filter((id) => !owners.has(id))
    if (pending.length === 0) break
    if (rounds === MAX_LOOKUP_ROUNDS)
      return {
        refused: {
          status: 403,
          reason: `this mutation's objects were not found in ${MAX_LOOKUP_ROUNDS} of this agent's repositories; use the REST API or the tools`
        }
      }
    rounds += 1
    const round = await lookup(repo, pending)
    if ('fail' in round) return { refused: round.fail }
    if ('skip' in round) continue
    for (const [id, owner] of round.owners) owners.set(id, owner)
  }
  const unresolved = candidates.filter((id) => !owners.has(id))
  if (unresolved.length > 0)
    return {
      refused: {
        status: 403,
        reason: `this mutation names ${unresolved.length === 1 ? 'an object' : 'objects'} outside this agent's authorized repositories`
      }
    }
  const repos = new Set<string>()
  for (const owner of owners.values()) {
    if ('unmapped' in owner)
      return {
        refused: {
          status: 403,
          reason: `this mutation names a ${owner.unmapped || 'node'} the proxy cannot place in a repository`
        }
      }
    if ('repo' in owner) {
      if (!authorized.has(owner.repo))
        return {
          refused: {
            status: 403,
            reason: `this mutation names an object in ${owner.repo}, which this agent is not authorized on`
          }
        }
      repos.add(owner.repo)
    }
  }
  if (repos.size === 0)
    return {
      refused: { status: 403, reason: 'this mutation names nothing in a repository this agent is authorized on' }
    }
  if (repos.size > 1)
    return {
      refused: {
        status: 403,
        reason: `this mutation spans ${[...repos].join(' and ')}; make each write through its own repository with the REST API or the githubPullRequest, githubIssue or githubComment tool`
      }
    }
  return { repo: [...repos][0]! }
}
