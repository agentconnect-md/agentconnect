import { describe, it, expect } from 'vitest'
import { diffAgents } from '../src/reconciler/reconciler.js'
import type { Agent } from '../src/agents/agent-schema.js'

const a = (id: string): Agent =>
  ({
    id,
    name: id,
    status: 'active',
    runtime: 'claude',
    runInSandbox: false,
    workspace: { mode: 'from-scratch', path: '/tmp', gitBranch: 'main', pullOnNewSession: true, skills: [] },
    skills: [],
    managedSkills: [],
    integrations: [],
    output: { mode: 'medium' },
    permissions: { policy: 'ask', autoApprove: [] },
    crons: []
  }) as unknown as Agent

const slackInt = (id: string) => ({
  id,
  platform: 'slack' as const,
  core: { bindRules: [] },
  config: { botToken: 'xoxb', appToken: 'xapp' }
})

const actual = (...agents: Agent[]) => new Map(agents.map((g) => [g.id, g]))

describe('diffAgents', () => {
  it('computes start/stop sets from desired vs actual', () => {
    const { toStart, toStop, toChange } = diffAgents([a('x'), a('y')], actual(a('y'), a('z')))
    expect(toStart.map((g) => g.id)).toEqual(['x'])
    expect(toStop).toEqual(['z'])
    expect(toChange).toEqual([])
  })

  it('does not emit a change when the config is unchanged', () => {
    const { toStart, toStop, toChange } = diffAgents([a('x')], actual(a('x')))
    expect(toStart).toEqual([])
    expect(toStop).toEqual([])
    expect(toChange).toEqual([])
  })

  it('classifies a runtime edit as a host-spawn change (only)', () => {
    const after = { ...a('x'), runtime: 'codex' } as Agent
    const { toChange } = diffAgents([after], actual(a('x')))
    expect(toChange).toHaveLength(1)
    expect(toChange[0]).toMatchObject({ hostRespawn: true, workspace: false, integrations: false })
    expect(toChange[0]!.agent.id).toBe('x')
  })

  it('classifies enabling or disabling the OS sandbox as a host-spawn change', () => {
    const unsandboxed = a('x')
    const sandboxed = { ...unsandboxed, runInSandbox: true } as Agent

    expect(diffAgents([sandboxed], actual(unsandboxed)).toChange[0]).toMatchObject({
      hostRespawn: true,
      workspace: false,
      integrations: false
    })
    expect(diffAgents([unsandboxed], actual(sandboxed)).toChange[0]).toMatchObject({
      hostRespawn: true,
      workspace: false,
      integrations: false
    })
  })

  it('classifies runtime session preferences and child inputs as host-spawn changes', () => {
    const cases: Array<Partial<Agent>> = [
      { runtimeOverrides: { model: 'opus', env: [], secrets: [] } },
      { description: 'be terse' },
      { reasoningEffort: 'high' },
      { executionMode: 'yolo' },
      // fastMode is baked into the host's configPrefs at construction, so an edit
      // must evict the host (unlike output.mode, which is read live per dispatch).
      { fastMode: true },
      { permissionMode: 'agent-full-access' },
      { runtimeOverrides: { model: undefined as any, env: [{ name: 'FOO', value: 'bar' }], secrets: [] } },
      // Secrets are baked into the child env (and materialized as config files)
      // at spawn — a value rotation must evict the host or the child keeps the
      // stale value until the idle reap.
      { runtimeOverrides: { model: undefined as any, env: [], secrets: [{ name: 'KUBECONFIG_DATA', value: 'k' }] } }
    ]
    for (const patch of cases) {
      const after = { ...a('x'), ...patch } as Agent
      const { toChange } = diffAgents([after], actual(a('x')))
      expect(toChange[0], JSON.stringify(patch)).toMatchObject({
        hostRespawn: true,
        workspace: false,
        integrations: false
      })
    }
  })

  it('respawns the host when the enabled workspace skills change', () => {
    const before = {
      ...a('x'),
      skills: [{ name: 'kit', source: 'acme/skills', skills: ['review-pr', 'safe-deploy'] }]
    } as Agent
    const after = {
      ...before,
      skills: [{ name: 'kit', source: 'acme/skills', skills: ['safe-deploy'] }]
    } as Agent

    expect(diffAgents([after], actual(before)).toChange[0]).toMatchObject({
      hostRespawn: true,
      workspace: false,
      integrations: false
    })
  })

  it('classifies a workspace edit as a workspace change (only)', () => {
    const after = {
      ...a('x'),
      workspace: { mode: 'git-repo', path: '/tmp', gitRepo: 'r', gitBranch: 'main', pullOnNewSession: true, skills: [] }
    } as unknown as Agent
    const { toChange } = diffAgents([after], actual(a('x')))
    expect(toChange[0]).toMatchObject({
      hostRespawn: false,
      workspace: true,
      workspaceRepoRename: false,
      integrations: false
    })
  })

  it('respawns the host when either skill-definition collection changes', () => {
    const gitSkills = {
      ...a('x'),
      skills: [{ name: 'team-skills', source: 'acme/skills', githubRepoId: '42', skills: ['review'] }]
    } as Agent
    expect(diffAgents([gitSkills], actual(a('x'))).toChange[0]).toMatchObject({
      hostRespawn: true,
      workspace: false,
      integrations: false
    })

    const managedSkills = {
      ...a('x'),
      managedSkills: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          name: 'review',
          revision: 1,
          digest: `sha256:${'a'.repeat(64)}`
        }
      ]
    } as Agent
    expect(diffAgents([managedSkills], actual(a('x'))).toChange[0]).toMatchObject({
      hostRespawn: true,
      workspace: false,
      integrations: false
    })
  })

  it('classifies an App-backed URL-only rename as non-destructive origin convergence', () => {
    const before = {
      ...a('x'),
      workspace: {
        mode: 'git-repo',
        path: '/tmp',
        gitRepo: 'https://github.com/acme/old-name',
        gitBranch: 'main',
        gitCredential: 'github-app' as const,
        pullOnNewSession: true,
        skills: []
      }
    } as unknown as Agent
    const after = {
      ...before,
      workspace: { ...before.workspace, gitRepo: 'https://github.com/acme/new-name' }
    } as Agent

    expect(diffAgents([after], actual(before)).toChange[0]).toMatchObject({
      hostRespawn: false,
      workspace: false,
      workspaceRepoRename: true,
      integrations: false
    })

    const anonymous = {
      ...after,
      workspace: { ...after.workspace, gitCredential: undefined }
    } as Agent
    expect(diffAgents([anonymous], actual(before)).toChange[0]).toMatchObject({
      workspace: true,
      workspaceRepoRename: false
    })

    const wrongHost = {
      ...before,
      workspace: { ...before.workspace, gitRepo: 'https://other-host.example/acme/new-name' }
    } as Agent
    expect(diffAgents([after], actual(wrongHost)).toChange[0]).toMatchObject({
      workspace: true,
      workspaceRepoRename: false
    })

    const shorthand = {
      ...before,
      workspace: { ...before.workspace, gitRepo: 'acme/old-name' }
    } as Agent
    expect(diffAgents([after], actual(shorthand)).toChange[0]).toMatchObject({
      workspace: true,
      workspaceRepoRename: false
    })
  })

  it('respawns for an external connection switch but keeps policy-only edits hot', () => {
    const before = {
      ...a('x'),
      memory: {
        provider: 'external' as const,
        connectionId: '11111111-1111-4111-8111-111111111111',
        recall: { mode: 'auto' as const, topK: 5, maxBytes: 8192, timeoutMs: 1000 },
        capture: { mode: 'manual' as const }
      }
    } as Agent
    const switched = {
      ...before,
      memory: { ...before.memory!, connectionId: '22222222-2222-4222-8222-222222222222' }
    } as Agent
    expect(diffAgents([switched], actual(before)).toChange[0]).toMatchObject({ hostRespawn: true })

    const policyOnly = {
      ...before,
      memory: {
        ...before.memory!,
        recall: { mode: 'tool-only' as const, topK: 10, maxBytes: 4096, timeoutMs: 500 }
      }
    } as Agent
    expect(diffAgents([policyOnly], actual(before)).toChange[0]).toMatchObject({ hostRespawn: false })
  })

  it('classifies an integrations edit as an integration change (only)', () => {
    const after = { ...a('x'), integrations: [slackInt('int-1')] } as unknown as Agent
    const { toChange } = diffAgents([after], actual(a('x')))
    expect(toChange[0]).toMatchObject({ hostRespawn: false, workspace: false, integrations: true })
  })

  it('treats a replica ownership marker as soft-only so rolling upgrades do not flap sockets', () => {
    const before = { ...a('x'), integrations: [slackInt('int-1')] } as unknown as Agent
    const after = {
      ...before,
      origin: 'cp',
      integrations: [{ ...slackInt('int-1'), origin: 'cp' as const }]
    } as unknown as Agent
    const { toChange } = diffAgents([after], actual(before))
    expect(toChange).toHaveLength(1)
    expect(toChange[0]).toMatchObject({ hostRespawn: false, workspace: false, integrations: false })
  })

  it('classifies an output/permissions edit as a soft-only change (all dims false)', () => {
    const after = { ...a('x'), output: { mode: 'high' } } as Agent
    const { toChange } = diffAgents([after], actual(a('x')))
    expect(toChange).toHaveLength(1)
    expect(toChange[0]).toMatchObject({ hostRespawn: false, workspace: false, integrations: false })
  })

  it('classifies a pause flip as a soft-only change (all dims false) — no host respawn (#288)', () => {
    // Pausing cancels active turns at runtime, but must NOT evict the host or tear
    // down ACP sessions. It remains a soft-only reconcile change.
    const after = { ...a('x'), pause: true } as Agent
    const { toChange } = diffAgents([after], actual(a('x')))
    expect(toChange).toHaveLength(1)
    expect(toChange[0]).toMatchObject({ hostRespawn: false, workspace: false, integrations: false })
  })

  it('classifies a displayName edit as a soft-only change', () => {
    const after = { ...a('x'), displayName: 'Release Captain' } as Agent
    const { toChange } = diffAgents([after], actual(a('x')))
    expect(toChange).toHaveLength(1)
    expect(toChange[0]).toMatchObject({ hostRespawn: false, workspace: false, integrations: false })
  })

  it('flags multiple moved dimensions on one change entry', () => {
    const after = {
      ...a('x'),
      runtime: 'codex',
      integrations: [slackInt('int-1')]
    } as unknown as Agent
    const { toChange } = diffAgents([after], actual(a('x')))
    expect(toChange[0]).toMatchObject({ hostRespawn: true, workspace: false, integrations: true })
  })
})
