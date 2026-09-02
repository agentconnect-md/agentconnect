/**
 * Linear's agent-facing tools (linear-integration.md §13 P2 layer 2): the GraphQL each tool sends
 * through the connection, the names it resolves for the model, and the shape it hands back.
 * Driven through a scripted client, so every request the tools make is asserted verbatim.
 */
import { describe, it, expect } from 'vitest'
import {
  LINEAR_SESSION_TOOLS,
  LINEAR_TOOLS,
  stripAgentSignature,
  type LinearToolClient
} from '../src/platforms/linear/agent-tools.js'
import type { SessionContext } from '../src/mcp/ops/context.js'
import type { PlatformSessionToolEnv } from '../src/platforms/read-ports.js'

const TEAM_ID = '11111111-1111-4111-8111-111111111111'
const ISSUE_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID = '33333333-3333-4333-8333-333333333333'

const ctx: SessionContext = {
  agentId: 'agent-1',
  platform: 'linear',
  integrationId: 'int-1',
  isDm: false,
  channel: 'org-uuid',
  thread: 'session-uuid',
  agentName: 'atlas',
  tools: []
}

interface Recorded {
  op: string
  variables: Record<string, unknown>
  idempotent?: boolean
}

/** Script value: the mutation's first attempt committed, and the retry was refused on the id. */
const DUPLICATE = Symbol('duplicate-key')

/** A client that answers each request from a script keyed by the operation name. */
function client(script: Record<string, unknown | ((vars: Record<string, unknown>) => unknown)>) {
  const calls: Recorded[] = []
  const impl: LinearToolClient = {
    request: async <T>(query: string, variables: Record<string, unknown>, opts?: { onDuplicateKey?: () => T }) => {
      const op = /^\s*(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? 'unknown'
      calls.push({ op, variables, ...(opts?.onDuplicateKey ? { idempotent: true } : {}) })
      const answer = script[op]
      if (answer === undefined) throw new Error(`unscripted operation `)
      // The sentinel plays the connection recognising a duplicate-key refusal on a RETRY.
      if (answer === DUPLICATE) return opts!.onDuplicateKey!()
      return (typeof answer === 'function' ? answer(variables) : answer) as T
    }
  }
  return { impl, calls }
}

const run = (
  name: string,
  args: Record<string, unknown>,
  c: LinearToolClient,
  env: Omit<PlatformSessionToolEnv, 'connection'> = {}
) => LINEAR_SESSION_TOOLS.execute(name, ctx, args, { connection: c, ...env })

/** The turn's footer identity, as `sessionToolAttributionFor` resolves it in `daemon.ts`. */
const attribution = {
  botName: 'atlas',
  botUrl: 'https://console.example.test/acme/agents/agent-1',
  runtime: 'Claude Code',
  model: 'opus-5',
  sessionUrl: 'https://console.example.test/acme/sessions/s-1'
}
const FOOTER =
  '\n\nsent by [atlas](https://console.example.test/acme/agents/agent-1) (Claude Code · opus-5) · ' +
  '[open in session](https://console.example.test/acme/sessions/s-1)'

const issueNode = (over: Record<string, unknown> = {}) => ({
  id: ISSUE_ID,
  identifier: 'ENG-42',
  title: 'Ship the thing',
  description: 'Long form',
  url: 'https://linear.example.test/issue/ENG-42',
  priority: 2,
  priorityLabel: 'High',
  estimate: 3,
  dueDate: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  branchName: 'eng-42-ship-the-thing',
  state: { id: 'st-1', name: 'In Progress', type: 'started' },
  team: { id: TEAM_ID, key: 'ENG', name: 'Engineering' },
  assignee: { id: USER_ID, name: 'Dana Example', displayName: 'dana' },
  creator: { id: 'u-2', name: 'Lee', displayName: 'lee' },
  labels: { nodes: [{ id: 'l-1', name: 'Bug' }] },
  project: { id: 'p-1', name: 'OSS' },
  cycle: { id: 'c-1', number: 7, name: null },
  parent: null,
  ...over
})

const teamStates = {
  team: {
    id: TEAM_ID,
    key: 'ENG',
    name: 'Engineering',
    states: {
      nodes: [
        { id: 'st-done', name: 'Done', type: 'completed', position: 3 },
        { id: 'st-prog', name: 'In Progress', type: 'started', position: 2 },
        { id: 'st-todo', name: 'Todo', type: 'unstarted', position: 1 },
        { id: 'st-back', name: 'Backlog', type: 'backlog', position: 0 }
      ]
    }
  }
}

describe('Linear session tools — descriptors', () => {
  it('advertise the eighteen tools under the official MCP vocabulary', () => {
    expect(LINEAR_TOOLS.map((t) => t.name)).toEqual([
      'getIssue',
      'listIssues',
      'listIssueComments',
      'listIssueStatuses',
      'listIssueLabels',
      'listTeams',
      'listUsers',
      'createIssue',
      'updateIssue',
      'createIssueComment',
      'listProjects',
      'getProject',
      'listCycles',
      'listDocuments',
      'getDocument',
      'listInitiatives',
      'getInitiative',
      'updateInitiative'
    ])
    for (const tool of LINEAR_TOOLS) expect(LINEAR_SESSION_TOOLS.argSchemas.has(tool.name), tool.name).toBe(true)
  })

  it('refuse a connection that is not the Linear client, and an unknown name', async () => {
    await expect(run('getIssue', { issue: 'ENG-1' }, {} as LinearToolClient)).rejects.toThrow(/cannot reach Linear/)
    await expect(run('nope', {}, client({}).impl)).rejects.toThrow(/unknown tool: nope/)
  })
})

describe('getIssue', () => {
  it('reads by identifier and projects the issue with its sub-issues', async () => {
    const c = client({
      GetIssue: {
        issue: issueNode({
          children: { nodes: [{ identifier: 'ENG-43', title: 'Part', state: { name: 'Todo' }, assignee: null }] }
        })
      }
    })
    const res = (await run('getIssue', { issue: ' ENG-42 ' }, c.impl)) as Record<string, unknown>
    expect(c.calls).toEqual([{ op: 'GetIssue', variables: { id: 'ENG-42' } }])
    expect(res).toMatchObject({
      identifier: 'ENG-42',
      state: { name: 'In Progress', type: 'started' },
      team: 'ENG',
      assignee: { id: USER_ID, name: 'dana' },
      priority: 'High',
      labels: ['Bug'],
      project: 'OSS',
      cycle: 'Cycle 7',
      parent: null,
      description: 'Long form',
      subIssues: [{ identifier: 'ENG-43', title: 'Part', state: 'Todo', assignee: null }]
    })
  })

  it('reports a missing issue as an error, not an empty object', async () => {
    const c = client({ GetIssue: { issue: null } })
    await expect(run('getIssue', { issue: 'ENG-404' }, c.impl)).rejects.toThrow(/no issue "ENG-404"/)
  })
})

describe('listIssues', () => {
  it('builds the filter from the named fields and pages newest-updated first', async () => {
    const c = client({
      TeamsByRef: { teams: { nodes: [{ id: TEAM_ID, key: 'ENG' }] } },
      ListIssues: {
        issues: {
          nodes: [issueNode({ description: 'x'.repeat(400) })],
          pageInfo: { hasNextPage: true, endCursor: 'cur-2' }
        }
      }
    })
    const res = (await run(
      'listIssues',
      {
        team: 'eng',
        state: 'In Progress',
        stateType: 'started',
        assignee: 'dana@example.test',
        label: 'Bug',
        project: 'OSS',
        query: 'flaky test',
        limit: 10
      },
      c.impl
    )) as { issues: { description: string }[]; nextCursor?: string }
    // The team reference resolves first (key, name or id), so the filter is always by id.
    expect(c.calls.map((x) => x.op)).toEqual(['TeamsByRef', 'ListIssues'])
    expect(c.calls[1]!.variables).toEqual({
      filter: {
        team: { id: { eq: TEAM_ID } },
        state: { name: { eqIgnoreCase: 'In Progress' }, type: { eq: 'started' } },
        assignee: { email: { eqIgnoreCase: 'dana@example.test' } },
        labels: { name: { eqIgnoreCase: 'Bug' } },
        project: { name: { eqIgnoreCase: 'OSS' } },
        searchableContent: { contains: 'flaky test' }
      },
      first: 10,
      after: null
    })
    expect(res.nextCursor).toBe('cur-2')
    // A list carries a snippet, not the whole description.
    expect(res.issues[0]!.description.length).toBe(301)
  })

  it('sends no filter when nothing narrows the list, and a UUID team by id', async () => {
    const c = client({
      ListIssues: { issues: { nodes: [], pageInfo: { hasNextPage: false } } },
      TeamById: { team: { id: TEAM_ID, key: 'ENG' } }
    })
    await run('listIssues', {}, c.impl)
    expect(c.calls[0]!.variables).toEqual({ filter: null, first: 25, after: null })
    await run('listIssues', { team: TEAM_ID, assignee: 'Dana Example' }, c.impl)
    expect(c.calls[1]!.op).toBe('TeamById')
    expect(c.calls[2]!.variables.filter).toEqual({
      team: { id: { eq: TEAM_ID } },
      assignee: { or: [{ displayName: { eqIgnoreCase: 'Dana Example' } }, { name: { eqIgnoreCase: 'Dana Example' } }] }
    })
  })
})

describe('listIssueStatuses / listIssueLabels / listTeams / listUsers / listIssueComments', () => {
  it('resolves a team by key and returns its states in board order', async () => {
    const c = client({
      TeamsByRef: { teams: { nodes: [{ id: TEAM_ID, key: 'ENG', name: 'Engineering' }] } },
      TeamStates: teamStates
    })
    const res = await run('listIssueStatuses', { team: 'ENG' }, c.impl)
    expect(c.calls.map((x) => x.op)).toEqual(['TeamsByRef', 'TeamStates'])
    expect(res).toEqual({
      team: 'ENG',
      states: [
        { name: 'Backlog', type: 'backlog' },
        { name: 'Todo', type: 'unstarted' },
        { name: 'In Progress', type: 'started' },
        { name: 'Done', type: 'completed' }
      ]
    })
  })

  it('names the teams when a key or name is ambiguous or unknown', async () => {
    const two = client({
      TeamsByRef: {
        teams: {
          nodes: [
            { id: 'a', key: 'ENG', name: 'Eng' },
            { id: 'b', key: 'ENG2', name: 'ENG' }
          ]
        }
      }
    })
    await expect(run('listIssueStatuses', { team: 'eng' }, two.impl)).rejects.toThrow(/pass the key: ENG, ENG2/)
    const none = client({ TeamsByRef: { teams: { nodes: [] } } })
    await expect(run('listIssueStatuses', { team: 'nope' }, none.impl)).rejects.toThrow(
      /no team with key or name "nope"/
    )
  })

  it('scopes labels to the workspace plus one team, and marks each label’s scope', async () => {
    const c = client({
      TeamsByRef: { teams: { nodes: [{ id: TEAM_ID, key: 'ENG' }] } },
      ListLabels: {
        issueLabels: {
          nodes: [
            { id: 'l-1', name: 'Bug', team: null, parent: null },
            { id: 'l-2', name: 'Backend', team: { id: TEAM_ID, key: 'ENG' }, parent: { name: 'Area' } }
          ],
          pageInfo: { hasNextPage: false }
        }
      }
    })
    const res = await run('listIssueLabels', { team: 'ENG' }, c.impl)
    expect(c.calls[1]!.variables).toEqual({
      filter: { or: [{ team: { null: true } }, { team: { id: { eq: TEAM_ID } } }] },
      first: 50,
      after: null
    })
    expect(res).toEqual({
      labels: [
        { name: 'Bug', scope: 'workspace' },
        { name: 'Backend', group: 'Area', scope: 'ENG' }
      ]
    })
  })

  it('lists teams, and active users matching a query on name or email', async () => {
    const c = client({
      ListTeams: { teams: { nodes: [{ id: TEAM_ID, key: 'ENG', name: 'Engineering', description: null }] } },
      ListUsers: { users: { nodes: [{ id: USER_ID, name: 'Dana Example', displayName: 'dana', email: 'd@x.test' }] } }
    })
    expect(await run('listTeams', {}, c.impl)).toEqual({ teams: [{ key: 'ENG', name: 'Engineering', id: TEAM_ID }] })
    const users = await run('listUsers', { query: 'dan' }, c.impl)
    expect(c.calls[1]!.variables).toEqual({
      filter: {
        active: { eq: true },
        or: [
          { name: { containsIgnoreCase: 'dan' } },
          { displayName: { containsIgnoreCase: 'dan' } },
          { email: { containsIgnoreCase: 'dan' } }
        ]
      },
      first: 25,
      after: null
    })
    expect(users).toEqual({ users: [{ id: USER_ID, name: 'Dana Example', displayName: 'dana', email: 'd@x.test' }] })
  })

  it('pages an issue’s comments with author, time and thread parent', async () => {
    const c = client({
      IssueComments: {
        issue: {
          id: ISSUE_ID,
          identifier: 'ENG-42',
          comments: {
            nodes: [
              {
                id: 'c-1',
                body: 'first',
                createdAt: 't1',
                url: 'u1',
                user: { id: 'u-2', displayName: 'lee' },
                parent: null
              },
              { id: 'c-2', body: 'reply', createdAt: 't2', url: 'u2', user: null, parent: { id: 'c-1' } }
            ],
            pageInfo: { hasNextPage: true, endCursor: 'c-cur' }
          }
        }
      }
    })
    const res = await run('listIssueComments', { issue: 'ENG-42', cursor: 'prev' }, c.impl)
    expect(c.calls[0]!.variables).toEqual({ id: 'ENG-42', first: 25, after: 'prev' })
    expect(res).toEqual({
      issue: 'ENG-42',
      comments: [
        { id: 'c-1', author: { id: 'u-2', name: 'lee' }, createdAt: 't1', url: 'u1', body: 'first' },
        { id: 'c-2', author: null, createdAt: 't2', url: 'u2', parentId: 'c-1', body: 'reply' }
      ],
      nextCursor: 'c-cur'
    })
  })
})

describe('createIssue', () => {
  it('resolves team, state, assignee, labels, project and parent to ids before the one mutation', async () => {
    const c = client({
      TeamsByRef: { teams: { nodes: [{ id: TEAM_ID, key: 'ENG', name: 'Engineering' }] } },
      TeamStates: teamStates,
      UsersByRef: { users: { nodes: [{ id: USER_ID, name: 'Dana Example', displayName: 'dana' }] } },
      LabelsByName: {
        issueLabels: {
          nodes: [
            { id: 'l-ws', name: 'Bug', team: null },
            { id: 'l-eng', name: 'Bug', team: { id: TEAM_ID } },
            { id: 'l-fe', name: 'Frontend', team: { id: 'other-team' } }
          ]
        }
      },
      ProjectsByName: { projects: { nodes: [{ id: 'p-1', name: 'OSS' }] } },
      IssueRef: { issue: { id: 'parent-id', identifier: 'ENG-1', team: { id: TEAM_ID } } },
      IssueCreate: { issueCreate: { success: true, issue: issueNode({ identifier: 'ENG-99' }) } }
    })
    const res = (await run(
      'createIssue',
      {
        team: 'ENG',
        title: 'New',
        description: 'Body',
        state: 'in progress',
        assignee: 'dana',
        labels: ['bug', 'Frontend'],
        priority: 'high',
        estimate: 2,
        dueDate: '2026-10-01',
        project: 'OSS',
        parent: 'ENG-1'
      },
      c.impl
    )) as { created: boolean; issue: { identifier: string } }
    expect(c.calls.at(-1)).toEqual({
      op: 'IssueCreate',
      idempotent: true,
      variables: {
        input: {
          id: expect.any(String),
          teamId: TEAM_ID,
          title: 'New',
          description: 'Body',
          stateId: 'st-prog',
          assigneeId: USER_ID,
          // The team's own "Bug" wins over the workspace-wide one; a label from another team still resolves.
          labelIds: ['l-eng', 'l-fe'],
          priority: 2,
          estimate: 2,
          dueDate: '2026-10-01',
          projectId: 'p-1',
          parentId: 'parent-id'
        }
      }
    })
    expect(res).toMatchObject({ created: true, issue: { identifier: 'ENG-99' } })
  })

  it('answers a state the team does not have with the names it does', async () => {
    const c = client({
      TeamsByRef: { teams: { nodes: [{ id: TEAM_ID, key: 'ENG' }] } },
      TeamStates: teamStates
    })
    await expect(run('createIssue', { team: 'ENG', title: 't', state: 'Doing' }, c.impl)).rejects.toThrow(
      /no workflow state named "Doing" on team ENG — valid: Done, In Progress, Todo, Backlog/
    )
  })

  it('rejects a priority outside the vocabulary before any mutation', async () => {
    const c = client({ TeamsByRef: { teams: { nodes: [{ id: TEAM_ID, key: 'ENG' }] } } })
    await expect(run('createIssue', { team: 'ENG', title: 't', priority: 9 }, c.impl)).rejects.toThrow(
      /priority must be/
    )
    await expect(run('createIssue', { team: 'ENG', title: 't', priority: 'asap' }, c.impl)).rejects.toThrow(
      /priority must be 0-4 or one of/
    )
    expect(c.calls.filter((x) => x.op === 'IssueCreate')).toEqual([])
  })
})

describe('updateIssue', () => {
  it('resolves names against the ISSUE’s team and sends only the fields named', async () => {
    const c = client({
      IssueRef: { issue: { id: ISSUE_ID, identifier: 'ENG-42', team: { id: TEAM_ID, key: 'ENG' } } },
      TeamStates: teamStates,
      IssueUpdate: { issueUpdate: { success: true, issue: issueNode({ state: { name: 'Done', type: 'completed' } }) } }
    })
    const res = (await run('updateIssue', { issue: 'ENG-42', state: 'Done', assignee: 'unassigned' }, c.impl)) as {
      updated: string[]
    }
    expect(c.calls.at(-1)).toEqual({
      op: 'IssueUpdate',
      variables: { id: ISSUE_ID, input: { stateId: 'st-done', assigneeId: null } }
    })
    expect(res.updated).toEqual(['stateId', 'assigneeId'])
  })

  it('refuses an update that changes nothing, and an ambiguous assignee', async () => {
    const c = client({
      IssueRef: { issue: { id: ISSUE_ID, identifier: 'ENG-42', team: { id: TEAM_ID } } },
      UsersByRef: {
        users: {
          nodes: [
            { id: 'u-a', name: 'Sam', email: 'a@x.test' },
            { id: 'u-b', name: 'Sam', email: 'b@x.test' }
          ]
        }
      }
    })
    await expect(run('updateIssue', { issue: 'ENG-42' }, c.impl)).rejects.toThrow(/at least one field/)
    await expect(run('updateIssue', { issue: 'ENG-42', assignee: 'Sam' }, c.impl)).rejects.toThrow(
      /matches several members — pass an email or id: a@x.test, b@x.test/
    )
  })

  it('surfaces a refused write as Linear reported it', async () => {
    const c = client({
      IssueRef: { issue: { id: ISSUE_ID, identifier: 'ENG-42', team: { id: TEAM_ID } } },
      IssueUpdate: () => {
        throw new Error('linear rejected the request: Entity not found')
      }
    })
    await expect(run('updateIssue', { issue: 'ENG-42', title: 'x' }, c.impl)).rejects.toThrow(/Entity not found/)
  })
})

describe('createIssueComment', () => {
  const commenting = () =>
    client({
      IssueRef: { issue: { id: ISSUE_ID, identifier: 'ENG-42', team: { id: TEAM_ID } } },
      CommentCreate: { commentCreate: { success: true, comment: { id: 'c-9', url: 'u9', createdAt: 't9' } } }
    })
  /** The body as it reached Linear. */
  const posted = (c: ReturnType<typeof commenting>) => (c.calls.at(-1)!.variables.input as { body: string }).body

  it('posts on the resolved issue, threading under `parent` when given', async () => {
    const c = commenting()
    const res = await run('createIssueComment', { issue: 'ENG-42', body: 'Done — see PR', parent: 'c-1' }, c.impl)
    expect(c.calls.at(-1)).toEqual({
      op: 'CommentCreate',
      idempotent: true,
      variables: { input: { id: expect.any(String), issueId: ISSUE_ID, body: 'Done — see PR', parentId: 'c-1' } }
    })
    expect(res).toEqual({ posted: true, issue: 'ENG-42', commentId: 'c-9', url: 'u9', createdAt: 't9' })
  })

  it('appends the turn’s standard footer — once, and only to what the model wrote', async () => {
    const c = commenting()
    await run('createIssueComment', { issue: 'ENG-42', body: 'Fixed the retry path.' }, c.impl, {
      attribution: async () => attribution
    })
    expect(posted(c)).toBe(`Fixed the retry path.${FOOTER}`)
    expect(posted(c).match(/sent by/g)).toHaveLength(1)
  })

  it('strips the signature the model wrote before appending the footer', async () => {
    for (const signature of ['— atlas', '-- atlas', '— atlas (Claude Code · opus-5)', '*— atlas*']) {
      const c = commenting()
      await run('createIssueComment', { issue: 'ENG-42', body: `Shipped it.\n\n${signature}` }, c.impl, {
        attribution: async () => attribution
      })
      expect(posted(c), signature).toBe(`Shipped it.${FOOTER}`)
    }
  })

  it('posts no footer when the agent’s footer chrome is off', async () => {
    const c = commenting()
    await run('createIssueComment', { issue: 'ENG-42', body: 'Shipped it.\n\n— atlas' }, c.impl, {
      attribution: async () => undefined
    })
    // The signature still goes: the model was told not to sign, footer or no footer.
    expect(posted(c)).toBe('Shipped it.')
  })

  it('posts no footer when the daemon wired no attribution at all', async () => {
    const c = commenting()
    await run('createIssueComment', { issue: 'ENG-42', body: 'Shipped it.' }, c.impl)
    expect(posted(c)).toBe('Shipped it.')
  })

  it('closes an unterminated code fence before the footer', async () => {
    const c = commenting()
    await run('createIssueComment', { issue: 'ENG-42', body: '```\nnot closed' }, c.impl, {
      attribution: async () => attribution
    })
    expect(posted(c)).toBe(`\`\`\`\nnot closed\n\`\`\`${FOOTER}`)
  })

  it('leaves an issue DESCRIPTION unsigned and unfootered — it is the ticket’s own text', async () => {
    const c = client({
      IssueRef: { issue: { id: ISSUE_ID, identifier: 'ENG-42', team: { id: TEAM_ID } } },
      IssueUpdate: { issueUpdate: { success: true, issue: issueNode() } }
    })
    await run('updateIssue', { issue: 'ENG-42', description: 'Scope: the retry path.' }, c.impl, {
      attribution: async () => attribution
    })
    expect((c.calls.at(-1)!.variables.input as { description: string }).description).toBe('Scope: the retry path.')
  })
})

describe('stripAgentSignature', () => {
  it('takes only a dash line naming the acting agent', () => {
    expect(stripAgentSignature('done\n\n— atlas', ['atlas'])).toBe('done')
    expect(stripAgentSignature('done\n\n— someone else', ['atlas'])).toBe('done\n\n— someone else')
    expect(stripAgentSignature('done\n\n— atlas', [undefined])).toBe('done\n\n— atlas')
  })

  it('never eats a list item or an em-dash sentence in the body', () => {
    expect(stripAgentSignature('done\n\n- atlas reviewed it', ['atlas'])).toBe('done\n\n- atlas reviewed it')
    expect(stripAgentSignature('— atlas asked for this\n\ndone', ['atlas'])).toBe('— atlas asked for this\n\ndone')
  })
})

describe('creates are idempotent across the connection’s retry', () => {
  it('mints the issue id itself, passes the duplicate-key hook, and reads the issue back on a committed retry', async () => {
    const c = client({
      TeamsByRef: { teams: { nodes: [{ id: TEAM_ID, key: 'ENG' }] } },
      IssueCreate: DUPLICATE,
      GetIssue: (vars: Record<string, unknown>) => ({ issue: issueNode({ id: vars.id, identifier: 'ENG-77' }) })
    })
    const res = (await run('createIssue', { team: 'ENG', title: 'Once' }, c.impl)) as { issue: { identifier: string } }
    const create = c.calls.find((x) => x.op === 'IssueCreate')!
    expect(create.idempotent).toBe(true)
    const minted = (create.variables.input as { id: string }).id
    expect(minted).toMatch(/^[0-9a-f-]{36}$/)
    // The read-back asks for exactly the id the create carried.
    expect(c.calls.at(-1)).toEqual({ op: 'GetIssue', variables: { id: minted } })
    expect(res.issue.identifier).toBe('ENG-77')
  })

  it('answers a committed comment retry with the id it minted, without a second post', async () => {
    const c = client({
      IssueRef: { issue: { id: ISSUE_ID, identifier: 'ENG-42', team: { id: TEAM_ID } } },
      CommentCreate: DUPLICATE
    })
    const res = (await run('createIssueComment', { issue: 'ENG-42', body: 'hi' }, c.impl)) as { commentId: string }
    const create = c.calls.find((x) => x.op === 'CommentCreate')!
    expect(create.idempotent).toBe(true)
    expect(res.commentId).toBe((create.variables.input as { id: string }).id)
    expect(c.calls.filter((x) => x.op === 'CommentCreate')).toHaveLength(1)
  })

  it('never gives an update or a read the duplicate-key hook — those retry plainly', async () => {
    const c = client({
      IssueRef: { issue: { id: ISSUE_ID, identifier: 'ENG-42', team: { id: TEAM_ID } } },
      IssueUpdate: { issueUpdate: { success: true, issue: issueNode() } },
      GetIssue: { issue: issueNode() }
    })
    await run('updateIssue', { issue: 'ENG-42', title: 'x' }, c.impl)
    await run('getIssue', { issue: 'ENG-42' }, c.impl)
    expect(c.calls.every((x) => !x.idempotent)).toBe(true)
  })
})

describe('projects, cycles and documents', () => {
  const projectNode = {
    id: 'p-1',
    name: 'OSS',
    description: 'Open the core',
    url: 'https://linear.example.test/project/oss',
    state: 'started',
    progress: 0.4,
    startDate: '2026-09-01',
    targetDate: null,
    updatedAt: 't',
    lead: { id: USER_ID, name: 'Dana Example', displayName: 'dana' },
    teams: { nodes: [{ key: 'ENG' }, { key: 'DOCS' }] }
  }

  it('lists projects filtered by team, state and name, newest-updated first', async () => {
    const c = client({
      TeamsByRef: { teams: { nodes: [{ id: TEAM_ID, key: 'ENG' }] } },
      ListProjects: { projects: { nodes: [projectNode], pageInfo: { hasNextPage: false } } }
    })
    const res = await run('listProjects', { team: 'Engineering', state: 'started', query: 'oss' }, c.impl)
    // A collection filter takes its predicate under `some`; the team name resolved to an id first.
    expect(c.calls[1]!.variables).toEqual({
      filter: {
        accessibleTeams: { some: { id: { eq: TEAM_ID } } },
        state: { eq: 'started' },
        name: { containsIgnoreCase: 'oss' }
      },
      first: 25,
      after: null
    })
    expect(res).toEqual({
      projects: [
        {
          id: 'p-1',
          name: 'OSS',
          url: 'https://linear.example.test/project/oss',
          state: 'started',
          progress: 0.4,
          startDate: '2026-09-01',
          targetDate: null,
          lead: { id: USER_ID, name: 'dana' },
          teams: ['ENG', 'DOCS'],
          updatedAt: 't',
          description: 'Open the core'
        }
      ]
    })
  })

  it('reads a project by name — resolving it first — with its write-up and milestones', async () => {
    const c = client({
      ProjectsByName: { projects: { nodes: [{ id: 'p-1', name: 'OSS' }] } },
      GetProject: {
        project: {
          ...projectNode,
          content: 'The plan',
          projectMilestones: {
            nodes: [
              { name: 'License', targetDate: '2026-10-01' },
              { name: 'Docs', targetDate: null }
            ]
          }
        }
      }
    })
    const res = (await run('getProject', { project: 'OSS' }, c.impl)) as Record<string, unknown>
    expect(c.calls.map((x) => x.op)).toEqual(['ProjectsByName', 'GetProject'])
    expect(c.calls[1]!.variables).toEqual({ id: 'p-1' })
    expect(res).toMatchObject({
      name: 'OSS',
      content: 'The plan',
      milestones: [
        { name: 'License', targetDate: '2026-10-01' },
        { name: 'Docs', targetDate: null }
      ]
    })
    // A UUID skips the name lookup and goes straight to the read.
    const gone = client({ GetProject: { project: null } })
    await expect(run('getProject', { project: TEAM_ID }, gone.impl)).rejects.toThrow(/no project/)
    expect(gone.calls.map((x) => x.op)).toEqual(['GetProject'])
  })

  it('lists a team’s cycles, narrowing to the active one on request', async () => {
    const c = client({
      TeamsByRef: { teams: { nodes: [{ id: TEAM_ID, key: 'ENG' }] } },
      ListCycles: {
        cycles: {
          nodes: [
            {
              id: 'c-7',
              number: 7,
              name: null,
              startsAt: 's',
              endsAt: 'e',
              completedAt: null,
              progress: 0.5,
              team: { key: 'ENG' }
            }
          ],
          pageInfo: { hasNextPage: false }
        }
      }
    })
    const res = await run('listCycles', { team: 'ENG', active: true }, c.impl)
    expect(c.calls[1]!.variables).toEqual({
      filter: { team: { id: { eq: TEAM_ID } }, isActive: { eq: true } },
      first: 25,
      after: null
    })
    expect(res).toEqual({
      cycles: [
        { id: 'c-7', number: 7, name: null, team: 'ENG', startsAt: 's', endsAt: 'e', completed: false, progress: 0.5 }
      ]
    })
  })

  it('lists documents within a project or by title, and reads one back in full', async () => {
    const c = client({
      ProjectsByName: { projects: { nodes: [{ id: 'p-1', name: 'OSS' }] } },
      ListDocuments: {
        documents: {
          nodes: [
            {
              id: 'd-1',
              slugId: 'plan-abc',
              title: 'Plan',
              url: 'u',
              updatedAt: 't',
              project: { name: 'OSS' },
              creator: { displayName: 'dana' }
            }
          ],
          pageInfo: { hasNextPage: false }
        }
      },
      GetDocument: {
        document: {
          id: 'd-1',
          slugId: 'plan-abc',
          title: 'Plan',
          url: 'u',
          content: '# Plan',
          updatedAt: 't',
          project: null,
          creator: null
        }
      }
    })
    const list = await run('listDocuments', { project: 'OSS', query: 'plan' }, c.impl)
    expect(c.calls[1]!.variables).toEqual({
      filter: { project: { id: { eq: 'p-1' } }, title: { containsIgnoreCase: 'plan' } },
      first: 25,
      after: null
    })
    expect(list).toEqual({
      documents: [
        {
          id: 'd-1',
          slug: 'plan-abc',
          title: 'Plan',
          url: 'u',
          project: 'OSS',
          author: { id: undefined, name: 'dana' },
          updatedAt: 't'
        }
      ]
    })
    const doc = await run('getDocument', { document: 'plan-abc' }, c.impl)
    expect(c.calls.at(-1)).toEqual({ op: 'GetDocument', variables: { id: 'plan-abc' } })
    expect(doc).toEqual({
      id: 'd-1',
      slug: 'plan-abc',
      title: 'Plan',
      url: 'u',
      project: null,
      author: null,
      updatedAt: 't',
      content: '# Plan'
    })
  })
})

describe('initiatives', () => {
  const INITIATIVE_ID = '44444444-4444-4444-8444-444444444444'
  const initiativeNode = {
    id: INITIATIVE_ID,
    name: 'Open the core',
    description: 'Ship the OSS story',
    url: 'https://linear.example.test/initiative/open-the-core',
    status: 'Active',
    health: 'onTrack',
    targetDate: '2026-12-31',
    startedAt: '2026-09-01T00:00:00.000Z',
    completedAt: null,
    updatedAt: 't',
    owner: { id: USER_ID, name: 'Dana Example', displayName: 'dana' },
    creator: { id: 'u-2', name: 'Lee', displayName: 'lee' }
  }
  const projected = {
    id: INITIATIVE_ID,
    name: 'Open the core',
    url: 'https://linear.example.test/initiative/open-the-core',
    status: 'Active',
    health: 'onTrack',
    owner: { id: USER_ID, name: 'dana' },
    targetDate: '2026-12-31',
    startedAt: '2026-09-01T00:00:00.000Z',
    completedAt: null,
    updatedAt: 't',
    description: 'Ship the OSS story'
  }

  it('lists initiatives filtered by status and name, newest-updated first', async () => {
    const c = client({
      ListInitiatives: { initiatives: { nodes: [initiativeNode], pageInfo: { hasNextPage: true, endCursor: 'c1' } } }
    })
    // The status is matched case-insensitively and sent back in Linear's own capitalization.
    const res = await run('listInitiatives', { status: 'active', query: 'core' }, c.impl)
    expect(c.calls[0]!.variables).toEqual({
      filter: { status: { eq: 'Active' }, name: { containsIgnoreCase: 'core' } },
      first: 25,
      after: null
    })
    expect(res).toEqual({ initiatives: [projected], nextCursor: 'c1' })
  })

  it('sends no filter when nothing narrows the list, and refuses a status Linear has no name for', async () => {
    const c = client({ ListInitiatives: { initiatives: { nodes: [], pageInfo: { hasNextPage: false } } } })
    expect(await run('listInitiatives', { limit: 5 }, c.impl)).toEqual({ initiatives: [] })
    expect(c.calls[0]!.variables).toEqual({ filter: null, first: 5, after: null })
    await expect(run('listInitiatives', { status: 'shipped' }, c.impl)).rejects.toThrow(
      /no initiative status "shipped" — valid: Planned, Proposed, Active, Completed, Canceled/
    )
    // The vocabulary is checked before anything is sent.
    expect(c.calls).toHaveLength(1)
  })

  it('reads an initiative by name — resolving it first — with its write-up and projects', async () => {
    const c = client({
      InitiativesByName: { initiatives: { nodes: [{ id: INITIATIVE_ID, name: 'Open the core' }] } },
      GetInitiative: {
        initiative: {
          ...initiativeNode,
          content: 'The plan',
          projects: { nodes: [{ id: 'p-1', name: 'OSS', state: 'started' }] }
        }
      }
    })
    const res = await run('getInitiative', { initiative: 'Open the core' }, c.impl)
    expect(c.calls.map((x) => x.op)).toEqual(['InitiativesByName', 'GetInitiative'])
    expect(c.calls[0]!.variables).toEqual({ name: 'Open the core' })
    expect(c.calls[1]!.variables).toEqual({ id: INITIATIVE_ID })
    expect(res).toEqual({ ...projected, content: 'The plan', projects: [{ id: 'p-1', name: 'OSS', state: 'started' }] })
    // A UUID skips the name lookup and goes straight to the read.
    const gone = client({ GetInitiative: { initiative: null } })
    await expect(run('getInitiative', { initiative: INITIATIVE_ID }, gone.impl)).rejects.toThrow(/no initiative/)
    expect(gone.calls.map((x) => x.op)).toEqual(['GetInitiative'])
  })

  it('names the initiatives when one name matches several, and says when none does', async () => {
    const many = client({
      InitiativesByName: {
        initiatives: {
          nodes: [
            { id: 'i-1', name: 'Core' },
            { id: 'i-2', name: 'Core' }
          ]
        }
      }
    })
    await expect(run('getInitiative', { initiative: 'Core' }, many.impl)).rejects.toThrow(/more than one initiative/)
    const none = client({ InitiativesByName: { initiatives: { nodes: [] } } })
    await expect(run('getInitiative', { initiative: 'Core' }, none.impl)).rejects.toThrow(
      /no initiative named "Core" — see listInitiatives/
    )
  })

  it('updates only the fields named, resolving the status and the owner to Linear’s own values', async () => {
    const c = client({
      UsersByRef: { users: { nodes: [{ id: USER_ID, displayName: 'dana', email: 'dana@example.test' }] } },
      InitiativeUpdate: { initiativeUpdate: { success: true, initiative: { ...initiativeNode, status: 'Completed' } } }
    })
    const res = await run(
      'updateInitiative',
      { initiative: INITIATIVE_ID, status: 'completed', targetDate: '2026-11-30', owner: 'dana', content: '# Plan' },
      c.impl
    )
    expect(c.calls.map((x) => x.op)).toEqual(['UsersByRef', 'InitiativeUpdate'])
    expect(c.calls[1]!.variables).toEqual({
      id: INITIATIVE_ID,
      input: { content: '# Plan', status: 'Completed', targetDate: '2026-11-30', ownerId: USER_ID }
    })
    expect(res).toEqual({
      updated: ['content', 'status', 'targetDate', 'ownerId'],
      initiative: { ...projected, status: 'Completed' }
    })
  })

  it('refuses an update that changes nothing, and surfaces a refused write as Linear reported it', async () => {
    const idle = client({})
    await expect(run('updateInitiative', { initiative: INITIATIVE_ID }, idle.impl)).rejects.toThrow(
      /pass at least one field to change/
    )
    expect(idle.calls).toHaveLength(0)
    const refused = client({ InitiativeUpdate: { initiativeUpdate: { success: false, initiative: null } } })
    await expect(run('updateInitiative', { initiative: INITIATIVE_ID, name: 'New' }, refused.impl)).rejects.toThrow(
      /Linear did not update initiative/
    )
  })

  it('answers a grant without the initiative scope with the reconnect instruction', async () => {
    const denied = client({
      ListInitiatives: () => {
        throw new Error('linear rejected the request: Access denied')
      }
    })
    await expect(run('listInitiatives', {}, denied.impl)).rejects.toThrow(
      /reconnect the Linear workspace to grant initiatives access. Linear said: linear rejected the request: Access denied/
    )
    // The name resolution a write starts with is refused the same way.
    const deniedName = client({
      InitiativesByName: () => {
        throw new Error('linear responded 401')
      }
    })
    await expect(run('updateInitiative', { initiative: 'Core', name: 'New' }, deniedName.impl)).rejects.toThrow(
      /reconnect the Linear workspace to grant initiatives access/
    )
    // Anything that is not a permission refusal is passed through untouched.
    const broke = client({
      ListInitiatives: () => {
        throw new Error('linear responded 500')
      }
    })
    await expect(run('listInitiatives', {}, broke.impl)).rejects.toThrow(/^linear responded 500$/)
  })
})
