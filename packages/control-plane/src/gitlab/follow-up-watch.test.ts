// GitLab's half of event wake (assistant-mode.md §5.14): a watch needs a serving binding and the agent's own access, and reads its object once.
import { describe, expect, it, vi } from 'vitest'
import type { FollowUpWatchTarget } from '@agentconnect.md/protocol'
import { AgentId, OrgId } from '../domain/ids.js'
import type { AgentRecord, FollowUpWatchRecord, GitlabProjectBindingRecord } from '../persistence/ports.js'
import { GitlabApiClient } from './api.js'
import { gitlabFollowUpWatchProvider } from './follow-up-watch.js'

const ORG = OrgId('example-org')
const PROJECT = 4455667n
const BINDING = {
  id: 'binding-1',
  orgId: ORG,
  projectId: PROJECT,
  projectPath: 'example-group/example-project',
  state: 'ready'
} as unknown as GitlabProjectBindingRecord
const target = (over: Partial<FollowUpWatchTarget> = {}): FollowUpWatchTarget => ({
  provider: 'gitlab',
  host: 'gitlab.example.test',
  repoPath: 'example-group/example-project',
  subject: 'pull',
  number: 3,
  ...over
})
const agent = (workspaceRepoId?: bigint): AgentRecord =>
  ({
    id: AgentId('11111111-1111-4111-8111-111111111111'),
    orgId: ORG,
    workspaceRepoId,
    workspace: { mode: 'git', credential: { provider: 'gitlab', access: 'read' } }
  }) as unknown as AgentRecord

function harness(opts: { status?: number; binding?: GitlabProjectBindingRecord | null; grant?: boolean } = {}) {
  const fetchImpl = vi.fn(async (_url: string) =>
    opts.status && opts.status !== 200
      ? new Response(JSON.stringify({ message: 'nope' }), { status: opts.status })
      : Response.json({ iid: 3 })
  )
  const binding = opts.binding === undefined ? BINDING : opts.binding
  const provider = gitlabFollowUpWatchProvider({
    api: new GitlabApiClient('https://gitlab.example.test', fetchImpl),
    bindings: { byProject: async () => binding, byProjectPath: async () => binding },
    repoAuths: {
      listForAgent: async () => (opts.grant ? [{ provider: 'gitlab', repoId: PROJECT, stale: null } as never] : [])
    },
    feedback: { readToken: async () => 'glpat-read' }
  })
  return { provider, fetchImpl }
}

describe('watching a GitLab merge request or issue', () => {
  it('resolves an object in the agent’s workspace project, reading it once', async () => {
    const { provider, fetchImpl } = harness()
    expect(await provider.resolve(agent(PROJECT), target())).toEqual({
      installationId: null,
      bindingId: 'binding-1',
      host: 'https://gitlab.example.test',
      repoId: PROJECT,
      repoPath: 'example-group/example-project',
      subject: 'pull',
      number: 3
    })
    expect(String(vi.mocked(fetchImpl).mock.calls[0]![0])).toContain(`/projects/${PROJECT}/merge_requests/3`)
  })

  it('accepts an explicit authorization in place of the workspace', async () => {
    const { provider } = harness({ grant: true })
    expect(await provider.resolve(agent(1n), target({ subject: 'issue' }))).toMatchObject({ subject: 'issue' })
  })

  it('refuses another instance, a project with no serving binding, no access, or no such object', async () => {
    expect(await harness().provider.resolve(agent(PROJECT), target({ host: 'gitlab.example.org' }))).toBe('unsupported')
    expect(await harness({ binding: null }).provider.resolve(agent(PROJECT), target())).toBe('unsupported')
    expect(
      await harness({ binding: { ...BINDING, state: 'cleanup_pending' } }).provider.resolve(agent(PROJECT), target())
    ).toBe('unsupported')
    expect(await harness().provider.resolve(agent(1n), target())).toBe('no_access')
    expect(await harness({ status: 404 }).provider.resolve(agent(PROJECT), target())).toBe('not_found')
  })

  it('checks coverage from the binding and the agent’s access alone', async () => {
    const watch = { repoId: PROJECT, bindingId: 'binding-1' } as FollowUpWatchRecord
    const { provider, fetchImpl } = harness()
    expect(await provider.covers(agent(PROJECT), watch)).toBe(true)
    expect(await provider.covers(agent(1n), watch)).toBe(false)
    expect(await provider.covers(agent(PROJECT), { ...watch, bindingId: 'binding-2' })).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
