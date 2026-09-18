import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '../src/agents/agent-schema.js'
import { wireWorkspacePlane, type ExecutionPlane, type PlaneScope } from '../src/execution/plane.js'
import type { GitRunner } from '../src/workspace/git-runner.js'
import { LocalWorkspaceFs, localWorkspaceFs } from '../src/workspace/workspace-fs.js'
import { WorkspaceManager } from '../src/workspace/workspace-manager.js'
import { testPlane } from './workspace-plane-support.js'

describe('wireWorkspacePlane', () => {
  it("answers the workspace manager's git, filesystem and path-clearing questions from the plane", async () => {
    const runner = {} as GitRunner
    const fs = new LocalWorkspaceFs()
    const gitRunnerFor = vi.fn<ExecutionPlane['gitRunnerFor']>(() => runner)
    const workspaceFsFor = vi.fn<ExecutionPlane['workspaceFsFor']>(() => ({ fs, mount: '/agent' }))
    const clearPath = vi.fn<NonNullable<ExecutionPlane['clearPath']>>(async () => 'read-only volume')
    const workspaces = new WorkspaceManager()
    wireWorkspacePlane(workspaces, testPlane({ workspacesOffDisk: true, gitRunnerFor, workspaceFsFor, clearPath }))

    const abort = new AbortController().signal
    expect(workspaces.resolveGitRunner('agent-a', '/agent/checkout', abort)).toBe(runner)
    expect(gitRunnerFor).toHaveBeenCalledWith('agent-a', '/agent/checkout', abort)
    expect(workspaces.fsFor('agent-a')).toBe(fs)
    expect(workspaces.sandboxMountFor('agent-a')).toBe('/agent')
    expect(await workspaces.clearPath('agent-a', '/agent/checkout')).toBe('read-only volume')
    expect(clearPath).toHaveBeenCalledWith('agent-a', '/agent/checkout')
    expect(workspaces.offDisk({ agentId: 'agent-a' })).toBe(true)

    // An agent the plane does not place keeps this daemon's own runner and disk, yet still reads as off-disk: that is the plane's answer, not a bound channel's.
    gitRunnerFor.mockReturnValue(undefined)
    workspaceFsFor.mockReturnValue(undefined)
    expect(workspaces.resolveGitRunner('agent-b')).toBeUndefined()
    expect(workspaces.fsFor('agent-b')).toBe(localWorkspaceFs)
    expect(workspaces.sandboxMountFor('agent-b')).toBeUndefined()
    expect(workspaces.offDisk({ agentId: 'agent-b' })).toBe(true)
  })

  it('keeps a plane whose files are on this disk out of the off-disk answer, and clears nothing through it', async () => {
    const workspaces = new WorkspaceManager()
    wireWorkspacePlane(workspaces, testPlane({ gitRunnerFor: () => ({}) as GitRunner }))

    // Having a plane and living off this disk are two properties: a VM that mounts host directories has the first only.
    expect(workspaces.resolveGitRunner('agent-a', '/agents/a/workspace')).toBeDefined()
    expect(workspaces.offDisk({ agentId: 'agent-a', path: '/agents/a/workspace' })).toBe(false)
    expect(await workspaces.clearPath('agent-a', '/agents/a/workspace')).toBeUndefined()

    workspaces.setPlaneResolver(undefined)
    expect(workspaces.resolveGitRunner('agent-a', '/agents/a/workspace')).toBeUndefined()
    expect(workspaces.offDisk({ agentId: 'agent-a' })).toBe(false)
  })
})

describe('the plane resolver', () => {
  it('is asked with the narrowest scope each question holds, and may answer per scope', async () => {
    const asked: PlaneScope[] = []
    const remote = testPlane({ workspacesOffDisk: true, clearPath: async () => undefined })
    const workspaces = new WorkspaceManager()
    // Only one session is placed off this disk; the agent's other scopes stay local.
    workspaces.setPlaneResolver((scope) => {
      asked.push(scope)
      return scope.sessionKey === 'remote-session' ? remote : undefined
    })

    expect(workspaces.offDisk({ agentId: 'agent-a', sessionKey: 'remote-session' })).toBe(true)
    expect(workspaces.offDisk({ agentId: 'agent-a', sessionKey: 'local-session' })).toBe(false)
    expect(workspaces.offDisk({ agentId: 'agent-a' })).toBe(false)
    workspaces.resolveGitRunner('agent-a', '/agents/a/workspace')
    workspaces.fsFor('agent-a')
    await workspaces.clearPath('agent-a', '/agents/a/sessions/leaf')

    expect(asked).toEqual([
      { agentId: 'agent-a', sessionKey: 'remote-session' },
      { agentId: 'agent-a', sessionKey: 'local-session' },
      { agentId: 'agent-a' },
      { agentId: 'agent-a', path: '/agents/a/workspace' },
      { agentId: 'agent-a' },
      { agentId: 'agent-a', path: '/agents/a/sessions/leaf' }
    ])
  })
})

// Every plane answers alike for every scope of an agent today, so only this pins that a question keeps the narrowest locator its caller holds.
describe('the scope each workspace question carries', () => {
  const KEY = 'slack:C1:1700000000.000100'
  const CWD = '/agent/repo/services/api'
  const workspaceOf = (mode: 'git-repo' | 'from-scratch') => ({
    mode,
    path: '/daemon/agents/agent-a/workspace',
    gitRepo: 'https://github.com/acme/repo.git',
    gitBranch: 'main',
    agentDir: 'services/api'
  })
  const agent = { id: 'agent-a', dir: '/daemon/agents/agent-a', workspace: workspaceOf('git-repo') } as unknown as Agent
  const scratch = { ...agent, workspace: workspaceOf('from-scratch') } as unknown as Agent
  type Internals = {
    withLocalSkills(agent: Agent, cwd: string, opts: object): Promise<string>
    convergeSessionCloneOrigins(agent: Agent): Promise<string[]>
  }

  const session = { agentId: 'agent-a', sessionKey: KEY }
  const path = { agentId: 'agent-a', path: CWD }
  const whole = { agentId: 'agent-a' }
  // What each question asks FIRST: its own placement, before whatever it goes on to ask of the agent's mount or filesystem.
  const questions: Array<[string, PlaneScope[], (workspaces: WorkspaceManager) => unknown]> = [
    ['sessionDir', [session], (w) => w.sessionDir(agent, KEY)],
    ['confinedSessionDir', [session], (w) => w.confinedSessionDir(agent, KEY)],
    ['sessionTierOnDisk', [session], (w) => w.sessionTierOnDisk(agent, KEY)],
    [
      'consoleWorkspaceRoot',
      [session],
      (w) => w.consoleWorkspaceRoot(agent, '/x', '/agent', { isolation: 'session', sessionKey: KEY })
    ],
    // The runner is resolved first, on the same path the refusal is then asked about.
    ['consoleWorkspaceGitRunner', [path, path], (w) => w.consoleWorkspaceGitRunner('agent-a', CWD)],
    ['the installed-skills exclusion', [path], (w) => w.withSkills(agent, CWD, { installSkills: async () => [] })],
    ['the local skills step', [path], (w) => (w as unknown as Internals).withLocalSkills(agent, CWD, {})],
    ['the widened cwd root', [path], (w) => w.additionalWorkspaceDirectories(agent, CWD)],
    ['mayOwnSessionWorktrees', [whole], (w) => w.mayOwnSessionWorktrees(scratch)],
    ['session clone origins', [whole], (w) => (w as unknown as Internals).convergeSessionCloneOrigins(agent)],
    ['workspace activation', [whole], (w) => w.prepareWorkspaceForActivation(agent)]
  ]

  it.each(questions)('%s', async (_name, leading, ask) => {
    const asked: PlaneScope[] = []
    const workspaces = new WorkspaceManager()
    workspaces.setPlaneResolver((given) => {
      asked.push(given)
      return testPlane({ workspacesOffDisk: true })
    })
    await ask(workspaces)
    expect(asked.slice(0, leading.length)).toEqual(leading)
  })
})
