import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHttpsServer, type Server } from 'node:https'
import type { AddressInfo, LookupFunction } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { generateCa } from '@anthropic-ai/sandbox-runtime'
import { createMitmCA } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-ca.js'
import { mintLeafCert } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-leaf.js'
import { CredentialProxy, type MintAsk } from '../src/credential-proxy/proxy.js'
import { loadPlaceholderKey } from '../src/credential-proxy/placeholder.js'
import { loadProxyCa } from '../src/credential-proxy/ca.js'
import { GITHUB_MANAGED_HOST } from '../src/gitcred/managed-hosts.js'
import {
  attributeMutation,
  idCandidates,
  MAX_ID_CANDIDATES,
  MAX_LOOKUP_ROUNDS,
  nodeOwners,
  type LookupRound,
  type NodeOwner
} from '../src/credential-proxy/graphql-attribution.js'

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('the node IDs a mutation names', () => {
  it('reads the values at ID positions only, at any depth, and never a body or a title', () => {
    expect(
      idCandidates({
        input: { subjectId: 'I_1', body: 'I_2', labelIds: ['L_1', 'L_2'], nested: { id: 'X_1' } },
        pullRequestId: 'PR_1',
        title: 'R_9',
        valid: 'not-an-id-key'
      })
    ).toEqual(['I_1', 'L_1', 'L_2', 'X_1', 'PR_1'])
    expect(idCandidates({ input: { subjectId: 'I_1' }, again: { issueId: 'I_1' } })).toEqual(['I_1'])
    expect(idCandidates({ ids: ['I_1', 'I_2'] })).toEqual(['I_1', 'I_2'])
    expect(idCandidates(undefined)).toEqual([])
    const many = Object.fromEntries(Array.from({ length: MAX_ID_CANDIDATES + 1 }, (_, i) => [`n${i}Id`, `I_${i}`]))
    expect(idCandidates(many)).toBe('too-many')
  })

  it('reads a variable by the argument it fills, whatever it is called', () => {
    const document =
      'mutation($l: ID!, $x: [ID!]!, $text: String!) { addLabelsToLabelable(input: { labelableId: $l, labelIds: $x }) { clientMutationId } addComment(input: { subjectId: "I_inline", body: $text }) { clientMutationId } }'
    expect(idCandidates({ l: 'I_1', x: ['L_1'], text: 'I_body' }, document)).toEqual(['I_1', 'L_1'])
    // A pair inside a string or a comment binds nothing.
    expect(
      idCandidates({ l: 'I_1' }, 'mutation($l: ID!) { a(input: { note: "labelableId: $l" }) { b } } # issueId: $l')
    ).toEqual([])
  })

  it('reads each node’s repository, a type without one, and a type it cannot place', () => {
    const owners = nodeOwners(
      {
        data: {
          nodes: [
            { __typename: 'Issue', repository: { nameWithOwner: 'O/R' } },
            { __typename: 'Repository', nameWithOwner: 'o/r' },
            { __typename: 'User' },
            { __typename: 'ProjectV2' },
            null
          ]
        },
        errors: [{ type: 'NOT_FOUND', path: ['nodes', 4] }]
      },
      ['a', 'b', 'c', 'd', 'e']
    )
    expect(owners && Object.fromEntries(owners)).toEqual({
      a: { repo: 'o/r' },
      b: { repo: 'o/r' },
      c: { none: true },
      d: { unmapped: 'ProjectV2' }
    })
    // An error about the request rather than one node says nothing about where the nodes live.
    expect(nodeOwners({ data: { nodes: [null] }, errors: [{ type: 'RATE_LIMITED' }] }, ['a'])).toBeUndefined()
    expect(nodeOwners({ data: { nodes: [] } }, ['a'])).toBeUndefined()
  })
})

describe('attributing a mutation to one repository', () => {
  const where: Record<string, NodeOwner> = {
    I_ws: { repo: 'o/ws' },
    L_ws: { repo: 'o/ws' },
    I_extra: { repo: 'o/extra' },
    R_public: { repo: 'cli/cli' },
    U_1: { none: true },
    P_1: { unmapped: 'ProjectV2' }
  }
  // As GitHub answers a token listing one repository: its own nodes, a public one, and a user; never another's.
  const lookup = vi.fn(async (repo: string, ids: readonly string[]): Promise<LookupRound> => {
    const owners = new Map<string, NodeOwner>()
    for (const id of ids) {
      const owner = where[id]
      if (!owner) continue
      if (!('repo' in owner) || owner.repo === repo || owner.repo === 'cli/cli') owners.set(id, owner)
    }
    return { owners }
  })
  const attribute = (ids: string[], repos = ['o/ws', 'o/extra']) => attributeMutation(ids, repos, lookup)

  it('places a workspace object in one round and another repository’s in the next', async () => {
    lookup.mockClear()
    expect(await attribute(['I_ws', 'L_ws', 'U_1'])).toEqual({ repo: 'o/ws' })
    expect(lookup).toHaveBeenCalledTimes(1)
    lookup.mockClear()
    expect(await attribute(['I_extra'])).toEqual({ repo: 'o/extra' })
    expect(lookup.mock.calls.map(([repo, ids]) => [repo, ids])).toEqual([
      ['o/ws', ['I_extra']],
      ['o/extra', ['I_extra']]
    ])
  })

  it('refuses what it cannot place in exactly one authorized repository', async () => {
    const reasons = async (ids: string[]) => {
      const result = await attribute(ids)
      expect(result).toHaveProperty('refused')
      return (result as { refused: { reason: string } }).refused.reason
    }
    expect(await reasons(['I_ws', 'I_extra'])).toContain('spans o/ws and o/extra')
    expect(await reasons(['I_ws', 'I_unknown'])).toContain('outside')
    expect(await reasons(['R_public'])).toContain('cli/cli, which this agent is not authorized on')
    expect(await reasons(['U_1'])).toContain('names nothing in a repository')
    expect(await reasons(['I_ws', 'P_1'])).toContain('ProjectV2')
  })

  it('skips a repository whose token it cannot get, and stops on a failure or past the round cap', async () => {
    const skipping = async (repo: string, ids: readonly string[]): Promise<LookupRound> =>
      repo === 'o/ws' ? { skip: true } : lookup(repo, ids)
    expect(await attributeMutation(['I_extra'], ['o/ws', 'o/extra'], skipping)).toEqual({ repo: 'o/extra' })
    const failing = async (): Promise<LookupRound> => ({ fail: { status: 429, reason: 'rate limited' } })
    expect(await attributeMutation(['I_ws'], ['o/ws'], failing)).toEqual({
      refused: { status: 429, reason: 'rate limited' }
    })
    const repos = Array.from({ length: MAX_LOOKUP_ROUNDS + 1 }, (_, i) => `o/r${i}`)
    const result = await attributeMutation(['I_far'], repos, async () => ({ owners: new Map() }))
    expect((result as { refused: { reason: string } }).refused.reason).toContain(`${MAX_LOOKUP_ROUNDS}`)
  })
})

// A GitHub GraphQL endpoint whose tokens each list one repository, as an installation token minted for it does.
const NODES: Record<string, { type: string; repo?: string; public?: true }> = {
  I_ws: { type: 'Issue', repo: 'o/ws' },
  I_extra: { type: 'Issue', repo: 'o/extra' },
  I_private: { type: 'Issue', repo: 'o/private' },
  R_public: { type: 'Repository', repo: 'cli/cli', public: true },
  U_1: { type: 'User' }
}

describe('the proxy forwarding a GitHub mutation', () => {
  let server: Server
  let port: number
  let dir: string
  let lookups: { repo: string; ids: string[] }[]
  let rateLimited = false

  beforeAll(async () => {
    const generated = generateCa({ cn: 'example GitHub CA' })
    const leaf = mintLeafCert(
      createMitmCA({ caCertPem: generated.certPem, caKeyPem: generated.keyPem }),
      'api.github.com'
    )
    server = createHttpsServer({ key: leaf.keyPem, cert: leaf.certPem }, (req, res) => {
      let text = ''
      req.on('data', (chunk: Buffer) => (text += chunk.toString()))
      req.on('end', () => {
        if (rateLimited) {
          res.writeHead(429, { 'retry-after': '30' }).end()
          return
        }
        const repo = /^Bearer tok:(.+):r$/.exec(req.headers.authorization ?? '')?.[1] ?? ''
        const ids = (JSON.parse(text) as { variables: { ids: string[] } }).variables.ids
        lookups.push({ repo, ids })
        const errors: unknown[] = []
        const nodes = ids.map((id, index) => {
          const node = NODES[id]
          if (!node || (node.repo && node.repo !== repo && !node.public)) {
            errors.push({ type: 'NOT_FOUND', path: ['nodes', index] })
            return null
          }
          if (node.type === 'Repository') return { __typename: node.type, nameWithOwner: node.repo }
          return node.repo
            ? { __typename: node.type, repository: { nameWithOwner: node.repo } }
            : { __typename: node.type }
        })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: { nodes }, ...(errors.length ? { errors } : {}) }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
    dir = mkdtempSync(join(tmpdir(), 'acgql-'))
    proxyCa = generated.certPem
  })
  let proxyCa = ''

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  })

  function setup(access: 'read' | 'comment' | 'write' = 'write') {
    lookups = []
    const toLoopback: LookupFunction = (_host, options, callback) => {
      if (options.all)
        (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [
          { address: '127.0.0.1', family: 4 }
        ])
      else callback(null, '127.0.0.1', 4)
    }
    const mint = vi.fn(async (_agentId: string, ask: MintAsk) => ({
      username: 'x-access-token',
      token: `tok:${ask.repo}:${ask.readOnly ? 'r' : 'w'}`,
      access: ask.readOnly ? ('read' as const) : access
    }))
    const proxy = new CredentialProxy({
      key: loadPlaceholderKey(join(dir, 'proxy.key')),
      ca: loadProxyCa(join(dir, 'ca')),
      mint,
      workspaceRepo: () => 'o/ws',
      instancesOf: () => [GITHUB_MANAGED_HOST],
      repositoriesOf: () => [{ repoId: '2', repoFullName: 'o/extra' }],
      runningAgents: () => [AGENT],
      knownAgent: () => true,
      log: { info: () => {}, warn: () => {} },
      upstream: { lookupFor: () => toLoopback, trustedCa: [proxyCa] }
    })
    const placeholder = proxy.placeholderFor(AGENT)
    const decide = (body: unknown) =>
      proxy.decide(
        new Request('https://api.github.com/graphql', {
          method: 'POST',
          headers: { authorization: `bearer ${placeholder}`, 'content-type': 'application/json' },
          body: JSON.stringify(body)
        }),
        { scheme: 'https', target: { host: 'api.github.com', port } }
      )
    return { mint, decide }
  }

  const comment = (subjectId: string) => ({
    query:
      'mutation CommentCreate($input: AddCommentInput!) { addComment(input: $input) { commentEdge { node { url } } } }',
    operationName: 'CommentCreate',
    variables: { input: { subjectId, body: 'I_extra is mentioned here' } }
  })

  it('forwards a comment on a workspace issue with the workspace token at the agent’s tier', async () => {
    const { mint, decide } = setup('comment')
    expect(await decide(comment('I_ws'))).toEqual({
      action: 'allow',
      setHeaders: [['authorization', 'Bearer tok:o/ws:w']]
    })
    expect(lookups).toEqual([{ repo: 'o/ws', ids: ['I_ws'] }])
    expect(mint).toHaveBeenLastCalledWith(AGENT, { provider: 'github', repo: 'o/ws', plane: 'api', readOnly: false })
  })

  it('finds another authorized repository’s issue in the next round', async () => {
    const { decide } = setup()
    expect(await decide(comment('I_extra'))).toMatchObject({
      action: 'allow',
      setHeaders: [['authorization', 'Bearer tok:o/extra:w']]
    })
    expect(lookups.map((round) => round.repo)).toEqual(['o/ws', 'o/extra'])
  })

  it('refuses an unauthorized or public object, a mutation with no node in its variables, and a rate limit', async () => {
    const { mint, decide } = setup()
    for (const id of ['I_private', 'R_public', 'U_1'])
      expect(await decide(comment(id))).toMatchObject({ action: 'deny', status: 403 })
    const inline = await decide({ query: 'mutation { closeIssue(input: { issueId: "I_ws" }) { issue { id } } }' })
    expect(inline).toMatchObject({ action: 'deny', status: 403 })
    expect((inline as { reason: string }).reason).toContain('variables')
    expect(mint).not.toHaveBeenCalledWith(AGENT, expect.objectContaining({ readOnly: false }))
    rateLimited = true
    try {
      expect(await decide(comment('I_ws'))).toMatchObject({ action: 'deny', status: 429 })
    } finally {
      rateLimited = false
    }
  })

  it('refuses a mutation whose variables, however named, span two repositories', async () => {
    const { decide } = setup()
    const refused = await decide({
      query:
        'mutation($l: ID!, $ids: [ID!]!) { addLabelsToLabelable(input: { labelableId: $l, labelIds: $ids }) { clientMutationId } }',
      variables: { l: 'I_ws', ids: ['I_extra'] }
    })
    expect(refused).toMatchObject({ action: 'deny', status: 403 })
    expect((refused as { reason: string }).reason).toContain('spans o/ws and o/extra')
  })

  it('reads the operation the request executes, and refuses a subscription', async () => {
    const { mint, decide } = setup()
    const both =
      'query Read($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } } mutation Write($id: ID!) { closeIssue(input: { issueId: $id }) { issue { id } } }'
    await decide({ query: both, operationName: 'Read', variables: { owner: 'o', name: 'extra', id: 'I_ws' } })
    expect(mint).toHaveBeenLastCalledWith(AGENT, { provider: 'github', repo: 'o/extra', plane: 'api', readOnly: true })
    expect(await decide({ query: both, operationName: 'Write', variables: { id: 'I_ws' } })).toMatchObject({
      action: 'allow'
    })
    expect(await decide({ query: both, variables: { id: 'I_ws' } })).toMatchObject({ action: 'deny', status: 400 })
    expect(await decide({ query: 'subscription { s }' })).toMatchObject({ action: 'deny', status: 403 })
  })
})
