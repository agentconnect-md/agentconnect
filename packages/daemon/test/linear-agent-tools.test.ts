/**
 * Linear's agent-facing tools (linear-integration.md §13 P2 layer 2): the GraphQL each tool sends
 * through the connection, the names it resolves for the model, and the shape it hands back.
 * Driven through a scripted client, so every request the tools make is asserted verbatim.
 */
import { describe, it, expect } from 'vitest'
import { LINEAR_SESSION_TOOLS, LINEAR_TOOLS, type LinearToolClient } from '../src/platforms/linear/agent-tools.js'
import type { SessionContext } from '../src/mcp/ops/context.js'

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

const run = (name: string, args: Record<string, unknown>, c: LinearToolClient) =>
  LINEAR_SESSION_TOOLS.execute(name, ctx, args, c)

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
  it('advertise the ten issue-centric tools under the official MCP vocabulary', () => {
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
      'createIssueComment'
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
    expect(c.calls[0]!.variables).toEqual({
      filter: {
        team: { key: { eqIgnoreCase: 'eng' } },
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
    const c = client({ ListIssues: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } })
    await run('listIssues', {}, c.impl)
    expect(c.calls[0]!.variables).toEqual({ filter: null, first: 25, after: null })
    await run('listIssues', { team: TEAM_ID, assignee: 'Dana Example' }, c.impl)
    expect(c.calls[1]!.variables.filter).toEqual({
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
  it('posts on the resolved issue, threading under `parent` when given', async () => {
    const c = client({
      IssueRef: { issue: { id: ISSUE_ID, identifier: 'ENG-42', team: { id: TEAM_ID } } },
      CommentCreate: { commentCreate: { success: true, comment: { id: 'c-9', url: 'u9', createdAt: 't9' } } }
    })
    const res = await run('createIssueComment', { issue: 'ENG-42', body: 'Done — see PR', parent: 'c-1' }, c.impl)
    expect(c.calls.at(-1)).toEqual({
      op: 'CommentCreate',
      idempotent: true,
      variables: { input: { id: expect.any(String), issueId: ISSUE_ID, body: 'Done — see PR', parentId: 'c-1' } }
    })
    expect(res).toEqual({ posted: true, issue: 'ENG-42', commentId: 'c-9', url: 'u9', createdAt: 't9' })
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
